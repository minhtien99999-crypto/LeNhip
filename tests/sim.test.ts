// Cổng mô phỏng Le‑ORION (N20‑SIM, LNH-T68, ca X10) qua API thật: danh tính lab, danh mục kỹ năng và scene có phiên bản, hàng đợi
// mô phỏng tách khỏi đường thực thi vật lý, nhãn SIMULATED ở chi tiết và nhật ký, biên nhận lab bị từ chối ở mọi đích ngoài lab.
// Không có robot hay thiết bị thật nào; trình mô phỏng là hàm tham chiếu trong tiến trình.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../src/server/app.ts";
import { MESSAGES } from "../src/core/errors.ts";
import { SIM_ADAPTERS } from "../src/server/measurements.ts";
import { MODULES } from "../src/server/modules.ts";
import { DEV_LAB_REF, SIM_LIMITS, SIM_SCENES, SIM_SKILLS, sim } from "../src/server/sim.ts";
import { all, one, run } from "../src/server/store.ts";
import { harness, key, type Harness } from "./helpers.ts";

const valid = (schema: string, body: unknown) => assert.deepEqual(SCHEMAS.validate(schema, body), [], `${schema}: ${JSON.stringify(body)}`);
const count = (h: Harness, table: string, where = "1 = 1") => (one<{ n: number }>(h.app.ctx.db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`) as { n: number }).n;
let n = 0;
const body = (o: Partial<{ skill_ref: string; scene_version: string; request_ref: string }> = {}) => ({
  skill_ref: o.skill_ref ?? "skl_pick_place", scene_version: o.scene_version ?? "scn_kitchen@1.1.0", request_ref: o.request_ref ?? `req_${String(++n).padStart(6, "0")}`,
});
const create = (h: Harness, b: unknown, sub = "dev_a", k?: string) => h.call("POST", "/v2/sim/runs", { sub, body: b, key: k });
const verify = (h: Harness, token: string, audience: string, sub = "dev_a") => h.call("POST", "/v2/sim/receipts/verify", { sub, body: { receipt_token: token, audience } });

test("mô-đun đã đăng ký; dữ liệu mẫu đăng ký workspace mẫu làm tenant lab và chỉ cấp sim.run cho dev_a; danh mục có phiên bản; mã lỗi có câu tiếng Việt", async () => {
  assert.ok(MODULES.includes(sim));
  const h = await harness();
  try {
    assert.equal(one<{ lab_ref: string }>(h.app.ctx.db, "SELECT lab_ref FROM sim_labs WHERE workspace_id = 'ws_demo'")?.lab_ref, DEV_LAB_REF);
    assert.deepEqual(all<{ user_id: string }>(h.app.ctx.db, "SELECT user_id FROM grants WHERE scope = 'sim.run'").map((g) => g.user_id), ["dev_a"]);
    await h.restart();
    assert.equal(count(h, "grants", "scope = 'sim.run'") + count(h, "sim_labs"), 2, "seed không nhân đôi");
    const c = await h.call("GET", "/v2/sim/catalog");
    assert.equal(c.status, 200);
    valid("SimCatalog", c.body);
    assert.equal(c.body.label, "SIMULATED");
    assert.equal(c.body.limits.physical_robot, "OUT_OF_SCOPE_G3");
    assert.equal(c.body.limits.inputs, "NO_CAMERA_NO_MEASUREMENTS");
    assert.equal(new Set(SIM_SCENES.map((s) => s.manifest_digest)).size, SIM_SCENES.length, "mỗi phiên bản scene có manifest riêng");
    for (const s of SIM_SKILLS) for (const id of s.scenes) assert.ok(SIM_SCENES.some((x) => x.scene_id === id), `${s.skill_ref} → ${id}`);
    for (const code of Object.keys(sim.errors ?? {})) assert.match(MESSAGES[code] ?? "", /[à-ỹ]/i, code);
  } finally {
    await h.close();
  }
});

test("chỉ danh tính lab: thành viên (404) → cờ sim (503) → quyền sim.run (403) → tenant lab (403 SIM_LAB_REQUIRED) trên mọi route", async () => {
  const h = await harness();
  try {
    const calls = [() => h.call("GET", "/v2/sim/catalog"), () => h.call("GET", "/v2/sim/runs"), () => create(h, body())];
    const as = (sub: string, ws?: string) => [h.call("GET", "/v2/sim/catalog", { sub, ws }), h.call("GET", "/v2/sim/runs", { sub, ws }), h.call("POST", "/v2/sim/runs", { sub, ws, body: body() })];
    for (const c of calls) assert.ok([200, 201].includes((await c()).status));
    for (const r of await Promise.all(as("dev_a", "ws_other"))) assert.equal(r.status, 404);
    for (const r of await Promise.all(as("stranger"))) assert.equal(r.status, 404);
    for (const r of await Promise.all(as("dev_b"))) assert.deepEqual([r.status, r.body.code], [403, "FORBIDDEN"]);
    for (const r of await Promise.all(as(SIM_ADAPTERS[0].principal_sub))) assert.equal(r.status, 404, "adapter phép đo không phải danh tính lab");
    run(h.app.ctx.db, "UPDATE sim_labs SET status = 'CLOSED'");
    for (const c of calls) assert.equal((await c()).body.code, "SIM_LAB_REQUIRED");
    run(h.app.ctx.db, "UPDATE sim_labs SET status = 'ACTIVE'");
    assert.equal((await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "sim", enabled: false, reason: "kiểm cổng mô phỏng" } })).status, 200);
    for (const c of calls) assert.equal((await c()).body.code, "MODULE_DISABLED");
  } finally {
    await h.close();
  }
});

test("POST /v2/sim/runs: đúng ba trường, kỹ năng và scene đã đăng ký, receipt SIMULATED; không camera hay phép đo làm đầu vào; request_ref và Idempotency-Key không xếp hàng hai lần", async () => {
  const h = await harness();
  try {
    const b = body();
    const k = key();
    const r = await create(h, b, "dev_a", k);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    valid("SimRun", r.body);
    assert.equal(r.body.label, "SIMULATED");
    assert.equal(r.body.queue, "SIMULATION");
    assert.deepEqual(Object.keys(r.body.receipt).sort(), ["action_id", "at", "run_id", "scene_version", "status"]);
    assert.deepEqual([r.body.receipt.status, r.body.receipt.run_id, r.body.receipt.scene_version], ["SIMULATED", r.body.run_ref, b.scene_version]);
    const replay = await create(h, b, "dev_a", k);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(replay.body, r.body);
    assert.equal((await create(h, { ...b, skill_ref: "skl_navigate_room" }, "dev_a", k)).status, 409, "cùng khóa khác nội dung");
    const again = await create(h, b);
    assert.deepEqual([again.status, again.body.run_ref], [200, r.body.run_ref], "cùng request_ref: đúng lượt đã có");
    assert.equal((await create(h, { ...b, skill_ref: "skl_navigate_room" })).body.code, "SIM_REQUEST_REUSED");
    assert.equal((await create(h, body({ skill_ref: "skl_weld_metal" }))).body.code, "SIM_SKILL_UNKNOWN");
    assert.equal((await create(h, body({ scene_version: "scn_kitchen@9.9.9" }))).body.code, "SIM_SCENE_UNKNOWN");
    assert.equal((await create(h, body({ skill_ref: "skl_fold_towel", scene_version: "scn_kitchen@1.0.0" }))).body.code, "SIM_SCENE_UNKNOWN", "kỹ năng chỉ chạy trên scene đã cho phép");
    for (const extra of [{ camera_ref: "cam_1" }, { inputs: { systolic: 120 } }, { device_ref: "dev_lamp_01" }, { target: "robot_real" }]) {
      assert.equal((await create(h, { ...body(), ...extra })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await create(h, { skill_ref: "skl_pick_place", scene_version: "kitchen" , request_ref: "req_badscene" })).status, 400);
    for (let i = count(h, "sim_runs", "state = 'SIMRUN_QUEUED'"); i < SIM_LIMITS.queuedPerWorkspace; i++) assert.equal((await create(h, body())).status, 201);
    const full = await create(h, body());
    assert.deepEqual([full.status, full.body.code], [429, "SIM_QUEUE_FULL"]);
  } finally {
    await h.close();
  }
});

test("lệnh chỉ vào hàng đợi mô phỏng: không action, evidence hay outbox nào; trình mô phỏng hoàn tất sau 2 giây; chi tiết, danh sách và nhật ký đều SIMULATED", async () => {
  const h = await harness();
  try {
    const before = ["actions", "evidence", "outbox", "receipts", "action_events"].map((t) => count(h, t));
    const r = await create(h, body());
    await h.app.tick();
    assert.equal((await h.call("GET", "/v2/sim/runs")).body.runs[0].state, "SIMRUN_QUEUED", "chưa đủ 2 giây");
    h.clock.advance(SIM_LIMITS.minRunMs + 100);
    await h.app.tick();
    const list = await h.call("GET", "/v2/sim/runs");
    valid("SimRunList", list.body);
    const run1 = list.body.runs.find((x: { run_ref: string }) => x.run_ref === r.body.run_ref);
    assert.equal(run1.state, "SIMRUN_COMPLETED");
    assert.equal(run1.label, "SIMULATED");
    assert.equal(run1.result.label, "SIMULATED");
    assert.match(run1.result.outcome, /^SIM_/);
    assert.deepEqual(["actions", "evidence", "outbox", "receipts", "action_events"].map((t) => count(h, t)), before, "không gì vào đường thực thi vật lý");
    const logs = all<{ action: string; data: string }>(h.app.ctx.db, "SELECT action, data FROM audit WHERE action LIKE 'sim.%'");
    assert.deepEqual(logs.map((l) => l.action), ["sim.run.queue", "sim.run.complete"]);
    for (const l of logs) assert.equal(JSON.parse(l.data).label, "SIMULATED");
    assert.deepEqual((await h.call("GET", "/v2/sim/runs", { sub: "dev_ops" })).status, 403);
  } finally {
    await h.close();
  }
});

test("X10: biên nhận lab chỉ hợp lệ trong đúng lab; audience hay danh tính ngoài lab bị từ chối trước khi kiểm chữ ký; sửa byte hay khởi động lại thì không bao giờ «hợp lệ»; hợp lệ cũng chỉ là SIMULATED", async () => {
  const h = await harness();
  try {
    const r = await create(h, body());
    const token = r.body.receipt_token as string;
    const ok = await verify(h, token, `lab:${DEV_LAB_REF}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    valid("SimReceiptVerdict", ok.body);
    assert.deepEqual([ok.body.valid, ok.body.label, ok.body.physical_verification], [true, "SIMULATED", "NONE"]);
    for (const aud of ["adapter:measurements", "home:hub_01", "device:dev_lamp_01", "lab:lab_other"]) {
      const x = await verify(h, token, aud);
      assert.deepEqual([x.status, x.body.code], [403, "SIM_AUDIENCE_REFUSED"], aud);
    }
    for (const sub of [SIM_ADAPTERS[0].principal_sub, "dev_b", "dev_ops", "stranger"]) {
      assert.deepEqual((await verify(h, token, `lab:${DEV_LAB_REF}`, sub)).body.code, "SIM_AUDIENCE_REFUSED", sub);
    }
    assert.equal((await h.call("POST", "/v2/sim/receipts/verify", { ws: "ws_other", body: { receipt_token: token, audience: `lab:${DEV_LAB_REF}` } })).status, 403);
    const [p, b, s] = token.split(".");
    const tampered = `${p}.${b.slice(0, -2)}${b.endsWith("A") ? "B" : "A"}${b.slice(-1)}.${s}`;
    assert.equal((await verify(h, tampered, `lab:${DEV_LAB_REF}`)).body.code, "SIM_RECEIPT_INVALID");
    assert.equal((await verify(h, "not-a-receipt", `lab:${DEV_LAB_REF}`)).body.code, "SIM_RECEIPT_INVALID");
    // Đưa biên nhận lab tới adapter ngoài lab: adapter phép đo nhận đúng schema của nó, không có chỗ cho biên nhận.
    const intoMeas = await h.call("POST", "/v2/health/observations/import", { sub: SIM_ADAPTERS[0].principal_sub, body: { observations: [], receipt_token: token } });
    assert.equal(intoMeas.status, 400);
    const asEvidence = await h.call("POST", "/v1/plans", { body: { kind: "robot.simulate", schema_version: 1, workspace_ref: "ws_demo", args: { scenario: "x" }, receipt_token: token } });
    assert.equal(asEvidence.status, 400, "đường kế hoạch vật lý không nhận biên nhận mô phỏng");
    // Khóa của cổng ở bộ nhớ: khởi động lại thì biên nhận cũ không kiểm được, không bao giờ hợp lệ.
    await h.restart();
    assert.equal((await verify(h, token, `lab:${DEV_LAB_REF}`)).body.code, "SIM_RECEIPT_INVALID");
    const refused = all<{ data: string }>(h.app.ctx.db, "SELECT data FROM audit WHERE action = 'sim.receipt.refused'");
    assert.ok(refused.length >= 8 && refused.every((x) => JSON.parse(x.data).label === "SIMULATED"), "nhật ký từ chối vẫn mang nhãn SIMULATED");
  } finally {
    await h.close();
  }
});

test("xuất và xóa: lượt mô phỏng của chính người đó, nhãn SIMULATED; DELETE xóa hết", async () => {
  const h = await harness();
  try {
    await create(h, body());
    const part = sim.privacy?.exportFor?.(h.app.ctx, "ws_demo", "dev_a") as { label: string; runs: unknown[] };
    assert.equal(part.label, "SIMULATED");
    assert.equal(part.runs.length, 1);
    assert.equal(sim.privacy?.exportFor?.(h.app.ctx, "ws_demo", "dev_b"), undefined);
    assert.equal((await h.call("POST", "/v1/privacy/requests", { body: { type: "DELETE" } })).status, 202);
    assert.equal(count(h, "sim_runs"), 0);
  } finally {
    await h.close();
  }
});
