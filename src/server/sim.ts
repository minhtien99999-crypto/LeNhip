// Cổng mô phỏng Le‑ORION (SRS V2.0 mục 09 và 12, N20‑SIM, LNH-T68, ca X10). Phạm vi của V2.0 cho người dùng là MÔ PHỎNG: robot
// thật là cổng G3 theo đề án riêng của LeHR, không có ở đây.
//
// - Danh tính lab (thiết kế nhỏ nhất còn trung thực): workspace đã đăng ký làm tenant lab (sim_labs) VÀ người gọi có quyền
//   `sim.run` trong workspace đó. Không có thông tin đăng nhập lab riêng; ở chế độ dev, workspace mẫu được đăng ký làm lab bằng
//   dữ liệu mẫu. Môi trường thật cần một workspace lab tách riêng (tenant, khóa, danh tính, adapter riêng); chưa có quy trình đăng ký.
// - POST /v2/sim/runs nhận đúng { skill_ref, scene_version, request_ref }: kỹ năng phải có trong danh mục đăng ký, scene có manifest
//   theo phiên bản. Không có trường nào cho ảnh camera hay phép đo sức khỏe: dữ liệu đó không bao giờ là đầu vào mặc định.
// - Lệnh chỉ vào hàng đợi mô phỏng (sim_runs), không bao giờ vào actions, evidence hay một adapter thiết bị. Trình mô phỏng tham
//   chiếu chạy ở onTick và chỉ ghi một kết quả tổng hợp. Mọi chi tiết, thông báo và nhật ký mang nhãn SIMULATED.
// - Biên nhận { action_id, run_id, scene_version, at, status: "SIMULATED" } được ký HMAC bằng khóa riêng của cổng mô phỏng (không
//   dùng chung với permit), audience `lab:<lab_ref>`. Biên nhận không nâng mức xác minh của sự kiện vật lý nào; đưa nó tới một
//   audience hay danh tính ngoài lab bị từ chối (X10). Khóa ở bộ nhớ của app: khởi động lại thì biên nhận cũ không kiểm được nữa
//   (trả SIM_RECEIPT_INVALID, không bao giờ «hợp lệ»); môi trường thật dùng KMS.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SECOND } from "../core/clock.ts";
import { b64url, digestJcs, fromB64urlStrict, uuid } from "../core/crypto.ts";
import { canonicalize } from "../../web/shared/jcs.js";
import { ApiError } from "../core/errors.ts";
import type { Call, Route } from "./api.ts";
import { activeGrant, isActiveMember, requireModuleGate } from "./authority.ts";
import { type Ctx, nowIso } from "./context.ts";
import type { Stored } from "./idempotency.ts";
import { indexTransitions, transitionsFor } from "./machine.ts";
import type { ServerModule } from "./modules.ts";
import { DEMO_WS } from "./seed.ts";
import { all, audit, one, run, tx } from "./store.ts";

const GATE = { module: "sim", scope: "sim.run", purpose: null } as const;
export const SIM_LABEL = "SIMULATED";
export const SIM_LIMITS = { queuedPerWorkspace: 20, runsListed: 100, minRunMs: 2 * SECOND } as const;
export const DEV_LAB_REF = "lab_orion_dev";

/** Manifest scene theo phiên bản (dữ liệu tổng hợp). Mã băm manifest nằm trong biên nhận gián tiếp qua scene_version. */
const SCENE_MANIFESTS = [
  { scene_id: "scn_kitchen", version: "1.0.0", objects: ["table", "cup", "shelf"], physics: "rigid-v1" },
  { scene_id: "scn_kitchen", version: "1.1.0", objects: ["table", "cup", "shelf", "tray"], physics: "rigid-v1" },
  { scene_id: "scn_living_room", version: "1.0.0", objects: ["sofa", "rug", "door"], physics: "rigid-v1" },
  { scene_id: "scn_laundry", version: "0.9.0", objects: ["basket", "towel"], physics: "cloth-v0" },
] as const;

export const SIM_SCENES = SCENE_MANIFESTS.map((m) => ({ scene_version: `${m.scene_id}@${m.version}`, scene_id: m.scene_id, version: m.version, manifest_digest: digestJcs(m) }));

/** Kỹ năng đã đăng ký: chỉ những skill_ref này được chạy, mỗi kỹ năng chỉ trên các scene đã cho phép, có giới hạn bước. */
export const SIM_SKILLS = [
  { skill_ref: "skl_pick_place", version: "1.0.0", scenes: ["scn_kitchen"], max_steps: 120 },
  { skill_ref: "skl_navigate_room", version: "1.2.0", scenes: ["scn_kitchen", "scn_living_room"], max_steps: 300 },
  { skill_ref: "skl_fold_towel", version: "0.3.0", scenes: ["scn_laundry"], max_steps: 200 },
] as const;

interface RunRow {
  run_ref: string;
  workspace_id: string;
  lab_ref: string;
  actor: string;
  action_id: string;
  request_ref: string;
  skill_ref: string;
  scene_version: string;
  state: "SIMRUN_QUEUED" | "SIMRUN_COMPLETED";
  queued_at: string;
  completed_at: string | null;
  result: string | null;
}

const findRun = indexTransitions(transitionsFor("SIMRUN_"));

/** Khóa ký biên nhận của cổng mô phỏng, theo từng app. */
const KEYS = new WeakMap<Ctx, Buffer>();
const keyOf = (ctx: Ctx) => {
  let k = KEYS.get(ctx);
  if (!k) KEYS.set(ctx, (k = randomBytes(32)));
  return k;
};

const labOf = (ctx: Ctx, ws: string) => one<{ lab_ref: string; status: string }>(ctx.db, "SELECT lab_ref, status FROM sim_labs WHERE workspace_id = ?", ws);

/** Danh tính lab: thành viên (404) → cờ sim (503) → quyền sim.run (403) → workspace là tenant lab đang mở (403 SIM_LAB_REQUIRED). */
function labGate(c: Call) {
  requireModuleGate(c.d.ctx, c.ws, c.p.sub, GATE);
  const lab = labOf(c.d.ctx, c.ws);
  if (!lab || lab.status !== "ACTIVE") throw new ApiError(403, "SIM_LAB_REQUIRED");
  return lab.lab_ref;
}

const isLabIdentity = (ctx: Ctx, ws: string, user: string) =>
  ctx.control.moduleOn(GATE.module) && isActiveMember(ctx, ws, user) && !!activeGrant(ctx, ws, user, GATE.scope, null) && labOf(ctx, ws)?.status === "ACTIVE";

const receiptOf = (r: RunRow) => ({ action_id: r.action_id, run_id: r.run_ref, scene_version: r.scene_version, at: r.queued_at, status: SIM_LABEL });

function sign(ctx: Ctx, r: RunRow) {
  const claims = { typ: "lnh-sim-receipt", iss: "lenhip-sim", aud: `lab:${r.lab_ref}`, ...receiptOf(r), skill_ref: r.skill_ref };
  const body = b64url(Buffer.from(canonicalize(claims), "utf8"));
  return `lnhsim1.${body}.${b64url(createHmac("sha256", keyOf(ctx)).update(`lnhsim1.${body}`).digest())}`;
}

/** Kiểm chữ ký và đọc claims; null khi sai dạng, sai chữ ký hoặc khóa đã đổi (khởi động lại). */
function readReceipt(ctx: Ctx, token: string): Record<string, unknown> | null {
  const m = /^lnhsim1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const want = createHmac("sha256", keyOf(ctx)).update(`lnhsim1.${m[1]}`).digest();
  const got = fromB64urlStrict(m[2]);
  if (!got || got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse((fromB64urlStrict(m[1]) as Buffer).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const runView = (r: RunRow) => ({
  run_ref: r.run_ref, label: SIM_LABEL, skill_ref: r.skill_ref, scene_version: r.scene_version, state: r.state, queue: "SIMULATION", receipt: receiptOf(r),
  queued_at: r.queued_at, completed_at: r.completed_at, result: r.result ? (JSON.parse(r.result) as Record<string, unknown>) : null,
});

function catalog(c: Call): Stored {
  const lab = labGate(c);
  return {
    status: 200,
    body: {
      label: SIM_LABEL, lab_ref: lab, skills: SIM_SKILLS.map((s) => ({ ...s, scenes: [...s.scenes] })), scenes: SIM_SCENES,
      limits: { queued_per_workspace: SIM_LIMITS.queuedPerWorkspace, inputs: "NO_CAMERA_NO_MEASUREMENTS", physical_robot: "OUT_OF_SCOPE_G3" },
    },
  };
}

function createRun(c: Call): Stored {
  const { ctx } = c.d;
  const lab = labGate(c);
  const b = c.body as { skill_ref: string; scene_version: string; request_ref: string };
  const skill = SIM_SKILLS.find((s) => s.skill_ref === b.skill_ref);
  if (!skill) throw new ApiError(422, "SIM_SKILL_UNKNOWN");
  const scene = SIM_SCENES.find((s) => s.scene_version === b.scene_version);
  if (!scene || !(skill.scenes as readonly string[]).includes(scene.scene_id)) throw new ApiError(422, "SIM_SCENE_UNKNOWN");
  const existing = one<RunRow>(ctx.db, "SELECT * FROM sim_runs WHERE workspace_id = ? AND actor = ? AND request_ref = ?", c.ws, c.p.sub, b.request_ref);
  if (existing) {
    // Cùng request_ref với khóa chống lặp khác: trả đúng lượt đã có nếu cùng nội dung, không bao giờ xếp hàng lần thứ hai.
    if (existing.skill_ref !== b.skill_ref || existing.scene_version !== b.scene_version) throw new ApiError(409, "SIM_REQUEST_REUSED");
    return { status: 200, body: { ...runView(existing), receipt_token: sign(ctx, existing) }, resource: { type: "sim_run", id: existing.run_ref } };
  }
  const queued = (one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM sim_runs WHERE workspace_id = ? AND state = 'SIMRUN_QUEUED'", c.ws) as { n: number }).n;
  if (queued >= SIM_LIMITS.queuedPerWorkspace) throw new ApiError(429, "SIM_QUEUE_FULL", { retryable: true });
  const at = nowIso(ctx);
  const runRef = `simr_${uuid()}`;
  run(ctx.db, "INSERT INTO sim_runs (run_ref, workspace_id, lab_ref, actor, action_id, request_ref, skill_ref, scene_version, state, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SIMRUN_QUEUED', ?)",
    runRef, c.ws, lab, c.p.sub, `sima_${uuid()}`, b.request_ref, b.skill_ref, b.scene_version, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "sim.run.queue", target: runRef, request_id: c.requestId, data: { label: SIM_LABEL, skill_ref: b.skill_ref, scene_version: b.scene_version } });
  const r = one<RunRow>(ctx.db, "SELECT * FROM sim_runs WHERE run_ref = ?", runRef) as RunRow;
  return { status: 201, body: { ...runView(r), receipt_token: sign(ctx, r) }, resource: { type: "sim_run", id: runRef } };
}

function listRuns(c: Call): Stored {
  labGate(c);
  const rows = all<RunRow>(c.d.ctx.db, "SELECT * FROM sim_runs WHERE workspace_id = ? AND actor = ? ORDER BY queued_at DESC, run_ref LIMIT ?", c.ws, c.p.sub, SIM_LIMITS.runsListed);
  return { status: 200, body: { label: SIM_LABEL, runs: rows.map(runView) } };
}

/**
 * Một bên đưa biên nhận lab tới để kiểm. Chỉ danh tính lab của đúng lab đó, với đúng audience `lab:<lab_ref>`, nhận được câu trả
 * lời «hợp lệ»; mọi audience hay danh tính khác bị từ chối trước khi kiểm chữ ký (X10), nên không ai ngoài lab dùng được route này
 * để dò biên nhận. Kể cả khi hợp lệ, kết quả chỉ là SIMULATED và physical_verification = NONE.
 */
function verifyReceipt(c: Call): Stored {
  const { ctx } = c.d;
  if (!ctx.control.moduleOn(GATE.module)) throw new ApiError(503, "MODULE_DISABLED");
  const b = c.body as { receipt_token: string; audience: string };
  const lab = labOf(ctx, c.ws);
  if (!lab || !isLabIdentity(ctx, c.ws, c.p.sub) || b.audience !== `lab:${lab.lab_ref}`) {
    audit(ctx.db, nowIso(ctx), { workspace_id: c.ws, actor: c.p.sub, action: "sim.receipt.refused", target: null, request_id: c.requestId, data: { label: SIM_LABEL, reason: "AUDIENCE" } });
    throw new ApiError(403, "SIM_AUDIENCE_REFUSED", { commit: true }); // nhật ký từ chối được giữ (X10)
  }
  const claims = readReceipt(ctx, b.receipt_token);
  if (!claims || claims.aud !== b.audience || claims.status !== SIM_LABEL || claims.iss !== "lenhip-sim") throw new ApiError(422, "SIM_RECEIPT_INVALID");
  const r = one<RunRow>(ctx.db, "SELECT * FROM sim_runs WHERE run_ref = ? AND workspace_id = ?", claims.run_id as string, c.ws);
  if (!r || r.action_id !== claims.action_id) throw new ApiError(422, "SIM_RECEIPT_INVALID");
  return { status: 200, body: { valid: true, label: SIM_LABEL, run_ref: r.run_ref, receipt: receiptOf(r), physical_verification: "NONE" }, resource: { type: "sim_run", id: r.run_ref } };
}

/** Trình mô phỏng tham chiếu: lấy lượt đã chờ đủ lâu ra khỏi hàng đợi, ghi một kết quả tổng hợp. Không chạm thiết bị nào. */
function simulate(ctx: Ctx, now: number) {
  const before = new Date(now - SIM_LIMITS.minRunMs).toISOString();
  const at = new Date(now).toISOString();
  tx(ctx.db, () => {
    for (const r of all<RunRow>(ctx.db, "SELECT * FROM sim_runs WHERE state = 'SIMRUN_QUEUED' AND queued_at <= ? ORDER BY queued_at LIMIT 50", before)) {
      const t = findRun(r.state, "simulate", "SIMULATOR");
      if (!t) continue;
      const skill = SIM_SKILLS.find((s) => s.skill_ref === r.skill_ref);
      const h = Number.parseInt(digestJcs({ run: r.run_ref, scene: r.scene_version }).replace(/[^A-Za-z0-9]/g, "").slice(0, 6), 36);
      const max = skill?.max_steps ?? 100;
      const steps = 20 + (h % Math.max(1, max - 20));
      const result = { label: SIM_LABEL, outcome: h % 5 === 0 ? "SIM_STEP_LIMIT" : "SIM_GOAL_REACHED", steps: h % 5 === 0 ? max : steps, sim_seconds: Math.round(steps * 0.5) };
      run(ctx.db, "UPDATE sim_runs SET state = ?, completed_at = ?, result = ? WHERE run_ref = ?", t.to, at, JSON.stringify(result), r.run_ref);
      audit(ctx.db, at, { workspace_id: r.workspace_id, actor: "simulator", action: "sim.run.complete", target: r.run_ref, data: { label: SIM_LABEL, outcome: result.outcome } });
    }
  });
}

const ROUTES: Route[] = [
  { method: "GET", path: "/v2/sim/catalog", handler: catalog },
  { method: "POST", path: "/v2/sim/runs", schema: "SimRunCreate", handler: createRun, readable: (c, r) => !!r && isLabIdentity(c.d.ctx, c.ws, c.p.sub) && !!one(c.d.ctx.db, "SELECT 1 FROM sim_runs WHERE run_ref = ? AND workspace_id = ? AND actor = ?", r.id, c.ws, c.p.sub) },
  { method: "GET", path: "/v2/sim/runs", handler: listRuns },
  { method: "POST", path: "/v2/sim/receipts/verify", schema: "SimReceiptVerify", handler: verifyReceipt, readable: (c) => isLabIdentity(c.d.ctx, c.ws, c.p.sub) },
];

export const sim: ServerModule = {
  name: "sim",
  routes: ROUTES,
  errors: {
    SIM_LAB_REQUIRED: "Chỉ danh tính lab mô phỏng gọi được thao tác này.",
    SIM_SKILL_UNKNOWN: "Kỹ năng chưa có trong danh mục đã đăng ký.",
    SIM_SCENE_UNKNOWN: "Phiên bản scene chưa đăng ký cho kỹ năng này.",
    SIM_REQUEST_REUSED: "request_ref đã dùng cho một lượt mô phỏng khác.",
    SIM_QUEUE_FULL: "Hàng đợi mô phỏng đã đầy; hãy thử lại sau.",
    SIM_AUDIENCE_REFUSED: "Biên nhận mô phỏng chỉ dùng được trong lab đã cấp nó.",
    SIM_RECEIPT_INVALID: "Biên nhận mô phỏng không kiểm được.",
  },
  /** Dữ liệu mẫu: workspace mẫu là tenant lab của chế độ dev; chỉ dev_a có quyền sim.run. */
  seed(ctx) {
    if (!one(ctx.db, "SELECT 1 FROM workspaces WHERE id = ?", DEMO_WS)) return;
    const at = nowIso(ctx);
    if (!labOf(ctx, DEMO_WS)) run(ctx.db, "INSERT INTO sim_labs (workspace_id, lab_ref, status, registered_by, created_at) VALUES (?, ?, 'ACTIVE', 'dev-seed', ?)", DEMO_WS, DEV_LAB_REF, at);
    if (isActiveMember(ctx, DEMO_WS, "dev_a") && !one(ctx.db, "SELECT 1 FROM grants WHERE workspace_id = ? AND user_id = 'dev_a' AND scope = ?", DEMO_WS, GATE.scope)) {
      run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, 'dev_a', ?, NULL, 'ACTIVE', ?)", `gr_${uuid()}`, DEMO_WS, GATE.scope, at);
    }
  },
  onTick: (ctx, now) => simulate(ctx, now),
  privacy: {
    exportFor(ctx, ws, user) {
      const runs = all<RunRow>(ctx.db, "SELECT * FROM sim_runs WHERE workspace_id = ? AND actor = ? ORDER BY queued_at, run_ref", ws, user).map(runView);
      return runs.length ? { label: SIM_LABEL, scope: "Lượt mô phỏng Le‑ORION của bạn (SIMULATED). Không có thiết bị hay robot thật.", runs } : undefined;
    },
    deleteFor(ctx, ws, user) {
      run(ctx.db, "DELETE FROM sim_runs WHERE workspace_id = ? AND actor = ?", ws, user);
      run(ctx.db, "DELETE FROM idem_keys WHERE workspace_id = ? AND actor = ? AND substr(route, 1, 8) = '/v2/sim/'", ws, user);
    },
  },
  revocations: {
    member_deleted: (ctx, e) => Number(run(ctx.db, "DELETE FROM sim_runs WHERE workspace_id = ? AND actor = ?", e.workspace_id as string, e.user_id as string).changes) > 0,
  },
};
