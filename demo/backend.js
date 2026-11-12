// Bản trình diễn LeNhip 1.0.1 chạy hoàn toàn trong trình duyệt: một bản giả của API /dev, /v1, /v2 cài trước khi app.js nạp, bằng
// cách bọc window.fetch cho các đường cùng gốc. KHÔNG có máy chủ, KHÔNG có thiết bị, lịch, hub hay máy đo thật: mọi kết quả là mô
// phỏng và bằng chứng luôn hạng SIMULATED. Máy chủ thật không bao giờ phục vụ tệp này (nó chỉ phục vụ web/).
//
// Hợp đồng: mọi phản hồi khớp schema OpenAPI đã ghép (contracts/openapi.json + contracts/openapi/*.json), kiểm ở
// tests/demo-backend.test.ts. Mã lỗi giống máy chủ thật cho các ca giao diện xử lý (409 REVISION_CONFLICT, 404, 403
// CONSENT_REQUIRED, 503 MODULE_DISABLED…). POST nào cũng cần Idempotency-Key; gửi lại cùng khóa và cùng thân thì phát lại nguyên
// phản hồi cũ, khác thân thì 409 IDEMPOTENCY_CONFLICT.
//
// Trạng thái nằm trong bộ nhớ và được chép xuống localStorage của trình duyệt này (bọc try/catch: không ghi được thì chỉ còn trong
// bộ nhớ). Không gì rời khỏi trình duyệt.
//
// Đường import viết theo bố cục của repo (../web/shared/…); scripts/build-demo.mjs đổi thành ../shared/… khi chép vào dist-demo/.
import { canonicalize, base64url } from "../web/shared/jcs.js";
import { localDate, zonedToInstant, addDays, parseInstant } from "../web/shared/zone.js";
import { scanLele, leleBlock, normalizeLele } from "../web/shared/lele-lexicon.js";
import { userText, checkedLink, linkSummary } from "../web/shared/inbox-text.js";
import { importKeyPair, keySetDigest, sealMessage } from "../web/shared/msg-crypto.js";

export const DEMO_VERSION = "1.0.1-demo";
export const STORE_KEY = "lenhip.demo.v1";
const WS = "ws_demo";
const SITE = "site_lab01";
const ZONE_VN = "Asia/Ho_Chi_Minh";
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 86_400_000;

/** Ba tài khoản thử, như chế độ dev của máy chủ tham chiếu (src/server/seed.ts). Không có người thật. */
export const DEMO_USERS = [
  { sub: "dev_a", name: "Thử nghiệm A", roles: ["MEMBER"] },
  { sub: "dev_b", name: "Thử nghiệm B", roles: ["MEMBER"] },
  { sub: "dev_ops", name: "Vận hành LeDB (thử)", roles: ["MEMBER", "LEDB_OPERATOR", "SITE_OPERATOR", "INCIDENT_LEAD", "WORKSPACE_ADMIN"] },
];
const GRANTS = {
  dev_a: [["calendar.block", null], ["home.control", SITE], ["robot.simulate", null], ["messaging.use", null], ["inbox.connect", null], ["home.hub", null], ["measurements.record", null], ["sim.run", null]],
  dev_b: [["calendar.block", null], ["messaging.use", null], ["inbox.connect", null], ["home.hub", null], ["measurements.record", null]],
  dev_ops: [["calendar.block", null], ["home.control", SITE], ["messaging.use", null]],
};
const LAMPS = [
  { device_ref: "dev_lamp_01", name: "Đèn bàn", on: true },
  { device_ref: "dev_lamp_02", name: "Đèn trần", on: false },
];
export const PURPOSES = ["calendar_link", "home_control", "beta_telemetry", "messaging", "social_post", "inbox_mail", "home_hub", "measurements"];
/** Bản trình diễn bật mọi cờ (máy chủ thật: ba cờ của 1.0.0 và năm cờ của 1.0.1 tắt khi chưa đặt rõ). */
const MODULES = { calendar: true, home: true, robot: true, lele: true, messaging: true, social: true, trackers: true, inbox: true, sync: true, home_hub: true, measurements: true, sim: true };
const KIND_RULE = {
  "calendar.block": { scope: "calendar.block", purpose: "calendar_link", module: "calendar" },
  "device.set_power": { scope: "home.control", purpose: "home_control", module: "home" },
  "robot.simulate": { scope: "robot.simulate", purpose: null, module: "robot" },
};
/** Chính sách xuất của workspace mẫu: chỉ cần digest ổn định để ghi vào phiên bản của plan. */
const EXPORT_POLICY = { policy_version: "demo-2026-11-12", kinds: ["calendar.block", "device.set_power", "robot.simulate"] };

const MESSAGES = {
  SCHEMA_INVALID: "Yêu cầu không đúng hợp đồng.",
  UNAUTHENTICATED: "Cần đăng nhập lại.",
  REAUTH_REQUIRED: "Cần xác thực lại trước thao tác này.",
  FORBIDDEN: "Không có quyền với thao tác này.",
  NOT_FOUND: "Không tìm thấy.",
  PLAN_STALE: "Quyền hoặc chính sách đã thay đổi; cần lập kế hoạch mới.",
  DIGEST_MISMATCH: "Nội dung xác nhận khác nội dung đã chuẩn hóa.",
  IDEMPOTENCY_CONFLICT: "Khóa chống lặp đã dùng cho nội dung khác.",
  IDEMPOTENCY_KEY_REQUIRED: "Thiếu Idempotency-Key.",
  IDEMPOTENCY_KEY_INVALID: "Idempotency-Key không hợp lệ.",
  APPROVAL_EXPIRED: "Bản duyệt đã hết hạn.",
  ACTION_FINAL: "Tác vụ đã có kết quả cuối.",
  INVALID_TRANSITION: "Trạng thái hiện tại không cho thao tác này.",
  CONSENT_REQUIRED: "Chưa có đồng ý cho mục đích này.",
  HEALTH_LOCAL_ONLY: "Dữ liệu sức khỏe chỉ xử lý trên điện thoại.",
  CALENDAR_NOT_LINKED: "Chưa liên kết tài khoản Microsoft 365.",
  UNSUPPORTED: "Chưa hỗ trợ.",
  MODULE_DISABLED: "Mô-đun đang tắt.",
  INTERNAL: "Lỗi của bản trình diễn.",
};

/** Lỗi API cùng dạng với máy chủ: { code, message, request_id, retryable, …extra }. */
export class DemoError extends Error {
  /** @param {number} status @param {string} code @param {Record<string, unknown>} [extra] */
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const fail = (status, code, extra) => {
  throw new DemoError(status, code, extra);
};

// ── tiện ích ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const te = new TextEncoder();
const iso = (ms) => new Date(ms).toISOString();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const uuid = () => crypto.randomUUID();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof bytes === "string" ? te.encode(bytes) : bytes));
}
/** SHA-256 base64url của JCS, như digestJcs của máy chủ. */
export async function digestJcs(value) {
  return base64url(await sha256(canonicalize(value)));
}
const SUPPORT = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const supportCode = () => {
  const b = rand(8);
  const c = [...b].map((x) => SUPPORT[x % SUPPORT.length]).join("");
  return `LNH-${c.slice(0, 4)}-${c.slice(4)}`;
};
const KEY_RE = /^[A-Za-z0-9_-]{22,128}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Dữ liệu ban đầu của bản trình diễn: đồng ý trống (Thông báo đầu tiên mở như lần đầu), đèn, lịch. */
function freshState(now) {
  return { v: 1, created_at: iso(now), seq: 0, consents: [], plans: {}, idem: {}, privacy: {}, exports: {}, mod: {} };
}

/**
 * Dựng bản giả của API. `opts.now` là đồng hồ (mili giây), `opts.load`/`opts.save` đọc và ghi trạng thái (mặc định: không lưu).
 * Trả `{ handle(req), reset(), state(), modules }`; `req = { method, path, search, headers, body }`, `headers` khóa viết thường,
 * `body` là chuỗi hoặc undefined. Kết quả `{ status, headers, body }`.
 */
export function createBackend(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const save = opts.save ?? (() => {});
  /** @type {ReturnType<typeof freshState>} */
  let S = (() => {
    try {
      const v = opts.load?.();
      if (v && v.v === 1) return v;
    } catch {
      /* trạng thái hỏng: bắt đầu lại */
    }
    return freshState(now());
  })();
  const persist = () => {
    try {
      save(S);
    } catch {
      /* không ghi được (trình duyệt chặn bộ nhớ): chỉ giữ trong bộ nhớ */
    }
  };

  // ── danh tính ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const userOf = (sub) => DEMO_USERS.find((u) => u.sub === sub);
  const memberDeleted = (sub) => !!S.mod.deleted?.[sub];
  function auth(headers) {
    const raw = headers.authorization ?? "";
    // Token của hub giả lập (Le‑NodeHome): sub `hub:<hub_id>`, chỉ dùng được cho đường sự kiện của hub.
    const hub = /^Bearer demohub\.(hub_[A-Za-z0-9_-]{8,40})\.(\d+)$/.exec(raw);
    if (hub) return { sub: `hub:${hub[1]}`, auth_time: Math.floor(Number(hub[2]) / 1000) };
    const m = /^Bearer demo\.([a-z_]+)\.(\d+)$/.exec(raw);
    if (!m || !userOf(m[1])) fail(401, "UNAUTHENTICATED");
    return { sub: m[1], auth_time: Math.floor(Number(m[2]) / 1000) };
  }
  function requireMember(sub) {
    if (!userOf(sub)) fail(403, "FORBIDDEN");
    if (memberDeleted(sub)) fail(403, "FORBIDDEN");
    return userOf(sub);
  }
  const grantsOf = (sub) => (GRANTS[sub] ?? []).map(([scope, resource]) => ({ id: `gr_${sub}_${scope.replace(".", "_")}`, scope, resource, status: "ACTIVE" }));
  const hasGrant = (sub, scope, resource = null) => (GRANTS[sub] ?? []).some(([s, r]) => s === scope && (resource === null ? r === null : r === resource));
  const latestConsent = (sub, purpose) => {
    for (let i = S.consents.length - 1; i >= 0; i--) if (S.consents[i].user === sub && S.consents[i].purpose_id === purpose) return S.consents[i];
    return null;
  };
  const consentGranted = (sub, purpose) => {
    const c = latestConsent(sub, purpose);
    return !!c && c.choice === "GRANTED" && !c.withdrawn_at;
  };
  const consentView = (c) => ({ id: c.id, purpose_id: c.purpose_id, text_version: c.text_version, text_hash: c.text_hash, choice: c.choice, at: c.at, withdrawn_at: c.withdrawn_at });
  const moduleOn = (name) => MODULES[name] === true && !S.mod.flagsOff?.[name];
  /** Cổng của mô-đun theo đúng thứ tự máy chủ (requireModuleGate): thành viên 404 → cờ 503 → quyền 403 → đồng ý 403. */
  function gate(sub, g) {
    if (!userOf(sub) || memberDeleted(sub)) fail(404, "NOT_FOUND");
    if (!moduleOn(g.module)) fail(503, "MODULE_DISABLED");
    if (!hasGrant(sub, g.scope)) fail(403, "FORBIDDEN");
    if (g.purpose && !consentGranted(sub, g.purpose)) fail(403, "CONSENT_REQUIRED");
  }
  /** Mô-đun đọc hook khi một đồng ý mất hiệu lực (như privacy.onConsentWithdrawn). */
  const withdrawHooks = [];

  // ── lịch giả lập ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  function meetings(t) {
    const today = localDate(t, ZONE_VN);
    const out = [];
    for (let i = -1; i < 15; i++) {
      const day = addDays(today, i);
      const wd = new Date(day + "T00:00:00Z").getUTCDay();
      if (wd === 0 || wd === 6) continue;
      for (const [s, e] of [["09:00", "09:30"], ["14:00", "14:30"]]) out.push([zonedToInstant(day, s, ZONE_VN), zonedToInstant(day, e, ZONE_VN)]);
    }
    return out;
  }

  // ── máy trạng thái tác vụ (mô phỏng theo thời gian, tính khi đọc) ─────────────────────────────────────────────────────────────
  // AUTHORIZED → DISPATCHING (0,6 s) → ACKED (1,2 s) → VERIFIED (2,5 s), đúng các cạnh của contracts/state_transitions.csv.
  const STEP = { claim: 600, ack: 1200, verify: 2500 };
  const UNKNOWN_AFTER = { "calendar.block": 30 * SEC, "device.set_power": 10 * SEC, "robot.simulate": 15 * SEC };
  function stateAt(r, t) {
    if (!r.authorized_at) return { status: r.state, revision: r.revision };
    if (r.final_state) return { status: r.final_state, revision: r.final_revision };
    const e = t - Date.parse(r.authorized_at);
    if (e < STEP.claim) return { status: "AUTHORIZED", revision: 3 };
    if (e < STEP.ack) return { status: "DISPATCHING", revision: 4 };
    if (e < STEP.verify) return { status: "ACKED", revision: 5 };
    return { status: "VERIFIED", revision: 6 };
  }
  const TERMINAL = new Set(["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"]);
  function lampOn(ref, t) {
    let on = LAMPS.find((l) => l.device_ref === ref)?.on ?? false;
    let at = -1;
    for (const r of Object.values(S.plans)) {
      if (r.kind !== "device.set_power" || r.payload.target.device_ref !== ref || !r.authorized_at) continue;
      if (stateAt(r, t).status !== "VERIFIED") continue;
      const done = Date.parse(r.authorized_at) + STEP.verify;
      if (done > at) {
        at = done;
        on = r.payload.command === "SET_ON";
      }
    }
    return on;
  }
  function planView(r, t) {
    const st = stateAt(r, t);
    return {
      plan_id: r.id, kind: r.kind, state: st.status, plan_version: r.plan_version, payload_digest: r.digest, preview: r.payload,
      approval_deadline: r.approval_deadline, versions: { authz_version: 1, export_policy_digest: r.policy_digest, target_binding_version: 1 },
      action_id: r.action_id, reason: r.reason,
    };
  }
  function actionView(r, t) {
    const st = stateAt(r, t);
    const a0 = Date.parse(r.authorized_at);
    const claimed = !r.final_state && t - a0 >= STEP.claim;
    const sent = claimed && t - a0 >= STEP.claim + 100;
    const verified = st.status === "VERIFIED";
    const outcome = verified ? (r.kind === "calendar.block" ? "EVENT_CREATED" : r.kind === "robot.simulate" ? "SIMULATED" : r.already ? "ALREADY_IN_STATE" : "APPLIED") : null;
    return {
      action_id: r.action_id, plan_id: r.id, kind: r.kind, status: st.status, revision: st.revision, outcome, evidence_grade: verified ? "SIMULATED" : null,
      dispatch_state: st.status === "AUTHORIZED" || st.status === "CANCELED" ? "NOT_CLAIMED" : st.status === "DISPATCHING" ? "CLAIMED" : "SENT",
      reconciliation_status: null, cancel_requested: !!r.cancel_requested, reason: r.reason, event_created: null, support_code: r.support_code,
      deadlines: { approval: r.approval_deadline, dispatch: r.dispatch_deadline, unknown_after: claimed ? iso(a0 + STEP.claim + UNKNOWN_AFTER[r.kind]) : null, next_check: null },
      times: {
        authorized_at: r.authorized_at, dispatch_claimed_at: claimed ? iso(a0 + STEP.claim) : null, first_io_at: sent ? iso(a0 + STEP.claim + 100) : null,
        last_observed_at: verified ? iso(a0 + STEP.verify) : null, last_check_at: null, unknown_since: null,
        terminal_at: verified ? iso(a0 + STEP.verify) : r.final_state ? r.terminal_at : null,
      },
      preview: r.payload, locked_resource: false,
    };
  }
  const ownPlan = (sub, id) => {
    const r = S.plans[id];
    if (!r || r.actor !== sub) fail(404, "NOT_FOUND");
    return r;
  };
  const ownAction = (sub, id) => {
    const r = Object.values(S.plans).find((p) => p.action_id === id);
    if (!r || r.actor !== sub) fail(404, "NOT_FOUND");
    return r;
  };

  async function resolve(sub, input, t) {
    const a = input.args ?? {};
    if (input.kind === "calendar.block") {
      const s = parseInstant(a.start);
      const e = parseInstant(a.end);
      if (!(e > s)) fail(400, "SCHEMA_INVALID", { detail_code: "END_BEFORE_START" });
      if (e - s > 240 * MIN) fail(422, "UNSUPPORTED", { detail_code: "BLOCK_TOO_LONG", limit: 240 });
      if (s < t + MIN) fail(422, "UNSUPPORTED", { detail_code: "START_IN_PAST" });
      if (e > t + 14 * DAY) fail(422, "UNSUPPORTED", { detail_code: "BEYOND_HORIZON", limit: 14 });
      return {
        kind: "calendar.block", schema_version: 1, workspace_id: WS, target: { type: "calendar", calendar_ref: "primary", account: `cal_${sub}` },
        start: iso(s), end: iso(e), zone: a.zone, title_code: "PERSONAL_TIME", visibility: "private", show_as: "busy", target_binding_version: 1,
      };
    }
    if (input.kind === "device.set_power") {
      const lamp = LAMPS.find((l) => l.device_ref === a.device_ref);
      if (a.site !== SITE || !lamp) fail(404, "NOT_FOUND");
      return { kind: "device.set_power", schema_version: 1, workspace_id: WS, target: { type: "device", site: SITE, device_ref: lamp.device_ref }, command: a.command, target_binding_version: 1 };
    }
    return { kind: "robot.simulate", schema_version: 1, workspace_id: WS, target: { type: "robot-sim", namespace: "sim" }, scenario: a.scenario, target_binding_version: 1 };
  }

  // ── LeLe: bộ quy tắc cục bộ, cùng bảng từ với thiết bị (web/shared/lele-lexicon.js) ─────────────────────────────────────────
  const ANSWERS = {
    HELP: "LeLe có thể soạn đề xuất dành thời gian cá nhân trong lịch công việc (ví dụ \"dành 30 phút lúc 15:00\") hoặc bật/tắt đèn đã đăng ký (\"bật đèn bàn\"). Bạn xem lại và xác nhận trước khi LeNhip làm.",
    PICK_LAMP: "Chọn đèn trong Ngôi nhà rồi xác nhận.",
    DURATION_RANGE: "Khung giờ cần dài 5–240 phút.",
    TOO_LONG: "Nội dung quá dài.",
    HEALTH_LOCAL: "Câu hỏi về sức khỏe được xử lý trên điện thoại, không gửi tới LeLe trong miền công việc.",
    PII_BLOCKED: "Nội dung có thông tin cá nhân; hãy dùng form thay vì gửi cho LeLe.",
  };
  const ENGINE = "local-rules";
  const form = (fallback, code) => ({ type: "FORM", engine: ENGINE, ai_generated: false, proposal: null, answer: ANSWERS[code], fallback, answer_code: code });
  function lele(sub, b, t) {
    if (te.encode(b.text).length > 16 * 1024) return form("NONE", "TOO_LONG");
    const scan = scanLele(b.text);
    const blocked = leleBlock(scan);
    if (blocked === "HEALTH") return form("NONE", "HEALTH_LOCAL");
    if (blocked === "PII") return form("NONE", "PII_BLOCKED");
    const intent = scan.intent;
    const devices = b.context === "home" && hasGrant(sub, "home.control", SITE) ? LAMPS : [];
    if (intent?.kind === "device.set_power") {
      const named = devices.find((d) => scan.norm.includes(normalizeLele(d.name))) ?? (devices.length === 1 ? devices[0] : undefined);
      if (!named) return form("device.set_power", "PICK_LAMP");
      const summary = `${intent.command === "SET_ON" ? "Bật" : "Tắt"} ${named.name}`;
      return { type: "PROPOSAL", engine: ENGINE, ai_generated: false, proposal: { kind: "device.set_power", args: { site: SITE, device_ref: named.device_ref, command: intent.command }, summary }, answer: summary, fallback: null, answer_code: null };
    }
    if (intent?.kind === "calendar.block") {
      const { minutes, tomorrow } = intent;
      if (minutes < 5 || minutes > 240) return form("calendar.block", "DURATION_RANGE");
      const at = `${String(intent.hour).padStart(2, "0")}:${String(intent.minute).padStart(2, "0")}`;
      const day = tomorrow ? addDays(localDate(t, b.zone), 1) : localDate(t, b.zone);
      const start = zonedToInstant(day, at, b.zone);
      const summary = `Dành ${minutes} phút thời gian cá nhân lúc ${at}${tomorrow ? " ngày mai" : ""}`;
      return {
        type: "PROPOSAL", engine: ENGINE, ai_generated: false,
        proposal: { kind: "calendar.block", args: { calendar_ref: "primary", start: iso(start), end: iso(start + minutes * MIN), zone: b.zone, title_code: "PERSONAL_TIME", visibility: "private" }, summary },
        answer: summary, fallback: null, answer_code: null,
      };
    }
    return { type: "ANSWER", engine: ENGINE, ai_generated: false, proposal: null, answer: ANSWERS.HELP, fallback: null, answer_code: "HELP" };
  }

  // ── bảng route ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  /** @type {{ method: string, path: string, re: RegExp, keys: string[], handler: (c: any) => any, resource?: (c: any) => boolean }[]} */
  const routes = [];
  /** Khai một route; handler trả `{ status, body }` (có thể async). */
  function route(method, path, handler) {
    const keys = [];
    const re = new RegExp("^" + path.replace(/\{([a-z_]+)\}/g, (_, k) => (keys.push(k), "([A-Za-z0-9_-]{1,128})")) + "$");
    routes.push({ method, path, re, keys, handler });
  }
  const ok = (body, status = 200) => ({ status, body });

  route("GET", "/v1/me", (c) => {
    const u = requireMember(c.sub);
    return ok({
      user: { id: u.sub, name: u.name }, workspace: { id: WS, name: "LeDB · Dogfood (dữ liệu tổng hợp · bản trình diễn)" }, roles: u.roles, grants: grantsOf(u.sub),
      consents: PURPOSES.map((p) => latestConsent(u.sub, p)).filter(Boolean).map(consentView),
      calendar: { linked: true, account: `cal_${u.sub}` }, sites: hasGrant(u.sub, "home.control", SITE) ? [{ id: SITE, name: "Phòng thử nghiệm LeDB (mô phỏng)" }] : [],
      modules: Object.fromEntries(Object.keys(MODULES).map((k) => [k, moduleOn(k)])), dispatch_open: true,
    });
  });

  route("GET", "/v1/calendar/availability", (c) => {
    requireMember(c.sub);
    const start = c.query.get("start") ?? "";
    const end = c.query.get("end") ?? "";
    const s = parseInstant(start);
    const e = parseInstant(end);
    if (!start.endsWith("Z") || !end.endsWith("Z") || Number.isNaN(s) || Number.isNaN(e) || e <= s) fail(400, "SCHEMA_INVALID");
    if (e - s > 14 * DAY) fail(400, "SCHEMA_INVALID", { detail_code: "WINDOW_TOO_LONG", limit: 14 });
    if (!hasGrant(c.sub, "calendar.block")) fail(403, "FORBIDDEN");
    if (!consentGranted(c.sub, "calendar_link")) fail(403, "CONSENT_REQUIRED");
    const mine = Object.values(S.plans).filter((r) => r.actor === c.sub && r.kind === "calendar.block" && r.action_id);
    const live = mine.filter((r) => !["REJECTED", "EXPIRED", "CANCELED", "FAILED"].includes(stateAt(r, c.now).status));
    const busy = [...meetings(c.now), ...live.filter((r) => stateAt(r, c.now).status === "VERIFIED").map((r) => [Date.parse(r.payload.start), Date.parse(r.payload.end)])]
      .filter(([a, b]) => a < e && s < b).map(([a, b]) => [Math.max(a, s), Math.min(b, e)]).sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const b of busy) {
      const last = merged[merged.length - 1];
      if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1]);
      else merged.push([...b]);
    }
    const free = [];
    let cur = s;
    for (const [a, b] of merged) {
      if (a > cur) free.push([cur, a]);
      cur = Math.max(cur, b);
    }
    if (cur < e) free.push([cur, e]);
    const span = ([a, b]) => ({ start: iso(a), end: iso(b) });
    return ok({
      calendar_ref: "primary", window: { start: iso(s), end: iso(e) }, busy: merged.map(span), free: free.map(span),
      lenhip_blocks: live.filter((r) => Date.parse(r.payload.start) < e && s < Date.parse(r.payload.end)).map((r) => ({ start: r.payload.start, end: r.payload.end, action_id: r.action_id, status: stateAt(r, c.now).status })),
    });
  });

  route("GET", "/v1/devices", (c) => {
    requireMember(c.sub);
    if (c.query.get("site") !== SITE) fail(404, "NOT_FOUND");
    if (!hasGrant(c.sub, "home.control", SITE)) fail(403, "FORBIDDEN");
    const observed = Math.floor(c.now / 1000) * 1000;
    return ok({
      site: SITE,
      devices: LAMPS.map((l) => ({
        device_ref: l.device_ref, name: l.name, site: SITE, binding_version: 1, capabilities: ["SET_POWER"], status: "ACTIVE",
        state: { power: lampOn(l.device_ref, c.now) ? "ON" : "OFF", observed_at: iso(observed), age_ms: c.now - observed, stale: false }, locked: false,
      })),
    });
  });

  route("POST", "/v1/plans", async (c) => {
    requireMember(c.sub);
    const input = c.body;
    if (input.workspace_ref !== WS) fail(404, "NOT_FOUND");
    const rule = KIND_RULE[input.kind];
    if (!rule) fail(422, "UNSUPPORTED");
    if (!moduleOn(rule.module)) fail(503, "MODULE_DISABLED");
    if (!hasGrant(c.sub, rule.scope, input.kind === "device.set_power" ? input.args?.site : null)) fail(403, "FORBIDDEN");
    if (rule.purpose && !consentGranted(c.sub, rule.purpose)) fail(403, "CONSENT_REQUIRED");
    const payload = await resolve(c.sub, input, c.now);
    const id = `pl_${uuid()}`;
    S.plans[id] = {
      id, actor: c.sub, kind: input.kind, state: "PENDING_APPROVAL", revision: 2, plan_version: 2, payload, digest: await digestJcs(payload),
      policy_digest: await digestJcs(EXPORT_POLICY), approval_deadline: iso(c.now + 120 * SEC), created_at: iso(c.now), action_id: null, reason: null,
    };
    return ok(planView(S.plans[id], c.now), 201);
  });
  route("GET", "/v1/plans/{plan_id}", (c) => ok(planView(expire(ownPlan(c.sub, c.params.plan_id), c.now), c.now)));
  /** Hạn 120 giây: plan chưa duyệt quá hạn thành EXPIRED khi được đọc hoặc duyệt. */
  function expire(r, t) {
    if (r.state === "PENDING_APPROVAL" && t > Date.parse(r.approval_deadline)) Object.assign(r, { state: "EXPIRED", revision: 3, reason: "APPROVAL_TIMEOUT" });
    return r;
  }
  route("POST", "/v1/plans/{plan_id}/approve", (c) => {
    requireMember(c.sub);
    const r = expire(ownPlan(c.sub, c.params.plan_id), c.now);
    if (r.state === "EXPIRED") return { status: 410, error: "APPROVAL_EXPIRED", extra: { state: "EXPIRED" } };
    if (r.state !== "PENDING_APPROVAL" || r.authorized_at) fail(409, "PLAN_STALE", { state: stateAt(r, c.now).status });
    if (c.body.plan_version !== r.plan_version) fail(409, "PLAN_STALE", { state: r.state });
    if (c.body.approved_digest !== r.digest) fail(409, "DIGEST_MISMATCH");
    const rule = KIND_RULE[r.kind];
    if (rule.purpose && !consentGranted(c.sub, rule.purpose)) {
      Object.assign(r, { state: "REJECTED", revision: 3, reason: "CONSENT_REVOKED" });
      return { status: 409, error: "PLAN_STALE", extra: { state: "REJECTED" } };
    }
    if (r.kind === "device.set_power") r.already = lampOn(r.payload.target.device_ref, c.now) === (r.payload.command === "SET_ON");
    Object.assign(r, { state: "AUTHORIZED", revision: 3, action_id: uuid(), authorized_at: iso(c.now), dispatch_deadline: iso(c.now + 120 * SEC), support_code: supportCode(), cancel_requested: false });
    return ok({ action_id: r.action_id, plan_id: r.id, state: "AUTHORIZED", dispatch_deadline: r.dispatch_deadline }, 202);
  });
  for (const how of ["deny", "cancel"]) {
    route("POST", `/v1/plans/{plan_id}/${how}`, (c) => {
      requireMember(c.sub);
      const r = expire(ownPlan(c.sub, c.params.plan_id), c.now);
      if (r.state !== "PENDING_APPROVAL") fail(409, "INVALID_TRANSITION", { state: stateAt(r, c.now).status });
      Object.assign(r, { state: how === "deny" ? "REJECTED" : "CANCELED", revision: 3, reason: how === "deny" ? "USER_DENIED" : "USER_CANCELED" });
      return ok(planView(r, c.now));
    });
  }
  route("GET", "/v1/actions", (c) => {
    requireMember(c.sub);
    const rows = Object.values(S.plans).filter((r) => r.actor === c.sub && r.action_id).sort((a, b) => (a.authorized_at < b.authorized_at ? 1 : -1)).slice(0, 50);
    return ok({ items: rows.map((r) => actionView(r, c.now)) });
  });
  route("GET", "/v1/actions/{action_id}", (c) => (requireMember(c.sub), ok(actionView(ownAction(c.sub, c.params.action_id), c.now))));
  route("POST", "/v1/actions/{action_id}/cancel", (c) => {
    requireMember(c.sub);
    const r = ownAction(c.sub, c.params.action_id);
    const st = stateAt(r, c.now);
    if (st.status === "AUTHORIZED") {
      Object.assign(r, { final_state: "CANCELED", final_revision: 4, reason: "USER_CANCELED", terminal_at: iso(c.now) });
    } else if (TERMINAL.has(st.status)) {
      fail(409, "ACTION_FINAL", { state: st.status });
    } else r.cancel_requested = true;
    return ok(actionView(r, c.now));
  });

  route("GET", "/v1/consents", (c) => (requireMember(c.sub), ok({ items: S.consents.filter((x) => x.user === c.sub).slice().reverse().map(consentView) })));
  route("POST", "/v1/consents", (c) => {
    requireMember(c.sub);
    const b = c.body;
    if (b.purpose_id === "health_local") fail(422, "HEALTH_LOCAL_ONLY");
    const prev = latestConsent(c.sub, b.purpose_id);
    const row = { id: `cs_${uuid()}`, user: c.sub, purpose_id: b.purpose_id, text_version: b.text_version, text_hash: b.text_hash, choice: b.choice, at: iso(c.now), withdrawn_at: null };
    S.consents.push(row);
    if (prev && prev.choice === "GRANTED" && !prev.withdrawn_at && b.choice === "DECLINED") for (const h of withdrawHooks) h(c.sub, b.purpose_id, c.now);
    return ok(consentView(row), 201);
  });
  route("POST", "/v1/consents/{purpose_id}/withdraw", (c) => {
    requireMember(c.sub);
    if (!PURPOSES.includes(c.params.purpose_id)) fail(404, "NOT_FOUND");
    const row = latestConsent(c.sub, c.params.purpose_id);
    if (!row) fail(404, "NOT_FOUND");
    if (row.choice === "GRANTED" && !row.withdrawn_at) {
      row.withdrawn_at = iso(c.now);
      for (const h of withdrawHooks) h(c.sub, row.purpose_id, c.now);
    }
    return ok(consentView(row));
  });

  route("POST", "/v1/lele/proposals", (c) => {
    requireMember(c.sub);
    if (!moduleOn("lele")) fail(503, "MODULE_DISABLED");
    return ok(lele(c.sub, c.body, c.now));
  });

  /** Phần của mô-đun trong tệp xuất (như privacy.exportFor): tên mô-đun → hàm. */
  const exporters = {};
  route("POST", "/v1/privacy/requests", (c) => {
    requireMember(c.sub);
    const type = c.body.type;
    if ((type === "EXPORT" || type === "DELETE") && c.now / 1000 - c.auth_time > 300) fail(401, "REAUTH_REQUIRED");
    const id = `pr_${uuid()}`;
    const status = type === "EXPORT" || type === "DELETE" ? "COMPLETED" : type === "RESTRICT" || type === "WITHDRAW" ? "IN_PROGRESS" : "RECEIVED";
    const row = { request_id: id, user: c.sub, type, status, received_at: iso(c.now), ack_due_at: iso(c.now + 2 * DAY), target_due_at: iso(c.now + 15 * DAY), legal_due_at: iso(c.now + 30 * DAY), export: null };
    if (type === "EXPORT") {
      const token = base64url(rand(24));
      S.exports[token] = { user: c.sub, expires_at: iso(c.now + DAY), data: exportFor(c.sub, c.now) };
      row.export = { path: `/v1/privacy/exports/${token}`, expires_at: S.exports[token].expires_at };
    }
    if (type === "RESTRICT" || type === "WITHDRAW") {
      for (const x of S.consents) if (x.user === c.sub && x.choice === "GRANTED" && !x.withdrawn_at) {
        x.withdrawn_at = iso(c.now);
        for (const h of withdrawHooks) h(c.sub, x.purpose_id, c.now);
      }
    }
    if (type === "DELETE") (S.mod.deleted ??= {})[c.sub] = iso(c.now);
    S.privacy[id] = row;
    const { user: _u, ...view } = row;
    return ok(view, 202);
  });
  route("GET", "/v1/privacy/requests/{request_id}", (c) => {
    const r = S.privacy[c.params.request_id];
    if (!r || r.user !== c.sub) fail(404, "NOT_FOUND");
    const { user: _u, ...view } = r;
    return ok({ ...view, export: null });
  });
  route("GET", "/v1/privacy/exports/{token}", (c) => {
    const x = S.exports[c.params.token];
    if (!x || x.user !== c.sub) fail(404, "NOT_FOUND");
    if (c.now > Date.parse(x.expires_at)) fail(410, "LINK_EXPIRED");
    return ok(x.data);
  });
  function exportFor(sub, t) {
    const u = userOf(sub);
    const modules = {};
    for (const [name, fn] of Object.entries(exporters)) modules[name] = fn(sub, t);
    return {
      format: "LeNhip export (bản trình diễn)", simulated: true, note: "Bản trình diễn chạy trong trình duyệt: mọi dữ liệu ở đây là mô phỏng.", generated_at: iso(t),
      workspace: { id: WS }, member: { id: u.sub, name: u.name, roles: u.roles }, grants: grantsOf(sub),
      consents: S.consents.filter((x) => x.user === sub).map(consentView),
      actions: Object.values(S.plans).filter((r) => r.actor === sub && r.action_id).map((r) => actionView(r, t)),
      modules,
    };
  }

  // ── bộ xử lý chung: xác thực → workspace → POST: idempotency → handler ────────────────────────────────────────────────────────
  const devHandlers = [];
  const controls = {};
  /** Phần chỉ nằm trong bộ nhớ của trang (không chép xuống localStorage): phép đo huyết áp tổng hợp của Le‑NodeHealth. */
  const M = {};
  const ctxApi = {
    S: () => S, M, fail, ok, route, gate, hasGrant, consentGranted, requireMember, userOf, withdrawHooks, exporters, moduleOn, uuid, iso, rand, hex, digestJcs, sha256,
    persist, DEMO_USERS, WS, SITE, MESSAGES, controls, devRoute: (path, handler) => devHandlers.push({ path, handler }), now,
  };
  for (const install of opts.modules ?? DEFAULT_MODULES) install(ctxApi);

  let reqSeq = 0;
  const requestId = () => `req_demo_${(++reqSeq).toString(36)}_${hex(rand(3))}`;
  const errorBody = (code, extra = {}) => ({ code, message: MESSAGES[code] ?? code, request_id: requestId(), retryable: false, ...extra });
  const json = (status, body, headers = {}) => ({ status, body, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Date: new Date(now()).toUTCString(), ...headers } });
  /** Nhiều thẻ của cùng trình duyệt dùng chung một «máy chủ»: đọc lại bản đã lưu trước mỗi yêu cầu. */
  const reload = () => {
    try {
      const v = opts.load?.();
      if (v && v.v === 1) S = v;
    } catch {
      /* không đọc được: giữ bản trong bộ nhớ */
    }
  };

  async function handle(req) {
    reload();
    const t = now();
    const method = (req.method ?? "GET").toUpperCase();
    const path = req.path;
    const query = new URLSearchParams(req.search ?? "");
    const headers = req.headers ?? {};
    try {
      if (path === "/dev/users" && method === "GET") return json(200, { users: DEMO_USERS.map((u) => ({ sub: u.sub, name: u.name })) });
      if (path === "/dev/token" && method === "POST") {
        const b = safeParse(req.body);
        if (!userOf(b?.sub)) fail(404, "NOT_FOUND");
        return json(200, { token: `demo.${b.sub}.${t}`, expires_in: 900 });
      }
      if (path.startsWith("/dev/")) {
        const d = method === "GET" && devHandlers.find((x) => x.path === path);
        if (!d) fail(404, "NOT_FOUND");
        const out = await d.handler({ query, now: t });
        persist();
        return json(200, out);
      }
      const r = routes.find((x) => x.method === method && x.re.test(path));
      if (!r) fail(routes.some((x) => x.re.test(path)) ? 405 : 404, routes.some((x) => x.re.test(path)) ? "UNSUPPORTED" : "NOT_FOUND");
      const m = r.re.exec(path);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const p = auth(headers);
      const ws = headers["x-lenhip-workspace"] ?? "";
      if (!/^ws_[a-z0-9_]{1,40}$/.test(ws)) fail(400, "SCHEMA_INVALID", { detail_code: "WORKSPACE_HEADER" });
      if (ws !== WS) fail(404, "NOT_FOUND");
      const c = { sub: p.sub, auth_time: p.auth_time, params, query, now: t, body: undefined, headers };
      if (method !== "POST") {
        const out = await r.handler(c);
        persist();
        return json(out.status, out.body);
      }
      const key = headers["idempotency-key"];
      if (!key) fail(400, "IDEMPOTENCY_KEY_REQUIRED");
      if (!KEY_RE.test(key)) fail(400, "IDEMPOTENCY_KEY_INVALID");
      c.body = req.body ? safeParse(req.body) : {};
      if (c.body === undefined || c.body === null || typeof c.body !== "object" || Array.isArray(c.body)) fail(400, "SCHEMA_INVALID");
      const slot = JSON.stringify([p.sub, path, key]);
      const digest = await digestJcs({ method, route: path, workspace_id: ws, body: c.body });
      const prior = S.idem[slot];
      if (prior) {
        if (prior.digest !== digest) fail(409, "IDEMPOTENCY_CONFLICT");
        return json(prior.status, prior.body, { "Idempotent-Replayed": "true" });
      }
      const out = await r.handler(c);
      // Lỗi mang thay đổi trạng thái hợp lệ (như EXPIRED khi duyệt quá hạn): ghi trạng thái rồi trả lỗi, không giữ khóa.
      if (out.error) {
        persist();
        return json(out.status, errorBody(out.error, out.extra));
      }
      S.idem[slot] = { digest, status: out.status, body: out.body, at: t };
      pruneIdem(t);
      persist();
      return json(out.status, out.body);
    } catch (e) {
      if (e instanceof DemoError) {
        persist();
        return json(e.status, errorBody(e.code, e.extra), e.status === 409 && e.code === "REQUEST_IN_PROGRESS" ? { "Retry-After": "1" } : {});
      }
      console.warn("[LeNhip demo] lỗi của bản trình diễn", e);
      return json(500, errorBody("INTERNAL"));
    }
  }
  /** Giữ tối đa 400 khóa chống lặp mới nhất để localStorage không phình (máy chủ thật giữ 90 ngày). */
  function pruneIdem() {
    const keys = Object.keys(S.idem);
    if (keys.length <= 400) return;
    keys.sort((a, b) => S.idem[a].at - S.idem[b].at);
    for (const k of keys.slice(0, keys.length - 400)) delete S.idem[k];
  }

  return {
    handle,
    reset() {
      S = freshState(now());
      for (const k of Object.keys(M)) delete M[k];
      persist();
    },
    state: () => S,
    /** Điều khiển chỉ có ở bản trình diễn (ví dụ bước LeLS của Le‑NodeHome); mô-đun thêm vào đây. Mỗi hàm async, trả mã kết quả. */
    controls: Object.fromEntries(Object.entries(controls).map(([k, fn]) => [k, async (...a) => {
      reload();
      const r = await fn(...a);
      persist();
      return r;
    }])),
    routes: () => routes.map((r) => `${r.method} ${r.path}`),
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ══ Mô-đun /v2 của bản trình diễn ══════════════════════════════════════════════════════════════════════════════════════════════
// Mỗi hàm nhận API nội bộ (route, gate, S…) và khai route của mình, như ServerModule của máy chủ tham chiếu. Quy tắc theo đúng
// src/server/<mô-đun>.ts ở những điểm giao diện thấy được; chỗ nào máy chủ cần thiết bị, nguồn hay đối tác thật thì ở đây là mô phỏng.

const DAY_MS = 86_400_000;
const isoOf = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => isoOf(ms).slice(0, 10);

/** Đồng bộ bản nháp và phiên thiết bị (src/server/sync.ts): bí mật phiên chỉ ở trình duyệt, «máy chủ» giữ mã băm. */
function syncModule(x) {
  const { fail, ok, route, requireMember, moduleOn, sha256 } = x;
  const LIMITS = { drafts: 50, devices: 10, calendarMaxMs: 12 * 3600_000 };
  const T = () => (x.S().mod.sync ??= { devices: {}, drafts: {} });
  Object.assign(x.MESSAGES, {
    REVISION_CONFLICT: "Bản nháp đã được sửa ở nơi khác; hãy xem bản mới nhất rồi chọn.",
    DRAFT_DISCARDED: "Bản nháp này đã được bỏ.",
    DRAFT_INVALID: "Nội dung bản nháp không hợp lệ.",
    DRAFT_LIMIT: "Đã đủ số bản nháp đang mở; hãy bỏ bớt một bản.",
    DEVICE_REQUIRED: "Thiết bị này chưa có phiên đồng bộ.",
    DEVICE_REVOKED: "Phiên này đã bị thu hồi.",
    DEVICE_NOT_ALLOWED: "Loại thiết bị này không đọc được bản nháp.",
    DEVICE_LIMIT: "Đã đủ số phiên thiết bị; hãy thu hồi một phiên trước khi thêm.",
  });
  const gate = (c) => {
    if (!x.userOf(c.sub)) fail(404, "NOT_FOUND");
    requireMember(c.sub);
    if (!moduleOn("sync")) fail(503, "MODULE_DISABLED");
  };
  const b64 = (bytes) => base64url(bytes);
  async function sessionOf(c) {
    const raw = c.headers["x-lenhip-device"] ?? c.query.get("device") ?? "";
    const m = /^(dvs_[A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/.exec(raw);
    if (!m) return null;
    const d = T().devices[m[1]];
    if (!d || d.user !== c.sub) return null;
    let secret;
    try {
      secret = Uint8Array.from(atob(m[2].replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) => ch.charCodeAt(0));
    } catch {
      return null;
    }
    return secret.length === 32 && b64(await sha256(secret)) === d.secret_hash ? d : null;
  }
  async function requireSession(c, drafts) {
    gate(c);
    const d = await sessionOf(c);
    if (!d) fail(403, "DEVICE_REQUIRED");
    if (d.state !== "ACTIVE") fail(403, "DEVICE_REVOKED");
    d.last_seen_day = dayOf(c.now);
    if (drafts && d.kind === "WATCH") fail(403, "DEVICE_NOT_ALLOWED");
    return d;
  }
  const deviceView = (d, current) => ({ device_id: d.device_id, kind: d.kind, state: d.state, created_day: d.created_at.slice(0, 10), last_seen_day: d.last_seen_day, revoked_day: d.revoked_at ? d.revoked_at.slice(0, 10) : null, current: d.device_id === current });
  const draftView = (d) => ({ draft_id: d.draft_id, purpose: d.purpose, state: d.state, revision: d.revision, snapshot: d.snapshot, created_at: d.created_at, updated_at: d.updated_at, discarded_at: d.discarded_at });
  const draftRef = (d) => ({ draft_id: d.draft_id, purpose: d.purpose, state: d.state, revision: d.revision, updated_at: d.updated_at });
  const mine = (c) => Object.values(T().drafts).filter((d) => d.owner === c.sub);
  const draftOf = (c, id) => {
    const d = T().drafts[`${c.sub}|${id}`];
    if (!d) fail(404, "NOT_FOUND");
    return d;
  };
  const checkSnapshot = (purpose, snap) => {
    if (purpose !== "calendar_block") return;
    const s = Date.parse(snap.start);
    const e = Date.parse(snap.end);
    if (!(e > s) || e - s > LIMITS.calendarMaxMs) fail(422, "DRAFT_INVALID", { detail_code: "WINDOW", limit: LIMITS.calendarMaxMs / 60_000 });
  };
  const conflict = (d) => fail(409, "REVISION_CONFLICT", { current: draftView(d) });

  route("GET", "/v2/devices", async (c) => {
    gate(c);
    const s = await sessionOf(c);
    if (s && s.state !== "ACTIVE") fail(403, "DEVICE_REVOKED");
    const rows = Object.values(T().devices).filter((d) => d.user === c.sub).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return ok({ devices: rows.map((d) => deviceView(d, s?.device_id ?? null)), limit: LIMITS.devices });
  });
  route("POST", "/v2/devices", (c) => {
    gate(c);
    if (c.now / 1000 - c.auth_time > 300) fail(401, "REAUTH_REQUIRED");
    if (Object.values(T().devices).some((d) => d.secret_hash === c.body.secret_hash)) fail(409, "INVALID_TRANSITION");
    if (Object.values(T().devices).filter((d) => d.user === c.sub && d.state === "ACTIVE").length >= LIMITS.devices) fail(422, "DEVICE_LIMIT", { limit: LIMITS.devices });
    const id = `dvs_${x.uuid().replaceAll("-", "")}`;
    const d = { device_id: id, user: c.sub, kind: c.body.kind, secret_hash: c.body.secret_hash, state: "ACTIVE", created_at: isoOf(c.now), last_seen_day: dayOf(c.now), revoked_at: null };
    T().devices[id] = d;
    return ok(deviceView(d, id), 201);
  });
  route("POST", "/v2/devices/{device_id}/revoke", async (c) => {
    const me = await requireSession(c, false);
    const d = T().devices[c.params.device_id];
    if (!d || d.user !== c.sub) fail(404, "NOT_FOUND");
    if (d.state === "ACTIVE") Object.assign(d, { state: "REVOKED", revoked_at: isoOf(c.now) });
    return ok(deviceView(d, me.device_id));
  });
  route("GET", "/v2/sync/drafts", async (c) => {
    await requireSession(c, true);
    const rows = mine(c).filter((d) => d.state === "OPEN").sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return ok({ drafts: rows.map(draftView), limit: LIMITS.drafts });
  });
  route("GET", "/v2/sync/drafts/{draft_id}", async (c) => (await requireSession(c, true), ok(draftView(draftOf(c, c.params.draft_id)))));
  route("POST", "/v2/sync/drafts", async (c) => {
    await requireSession(c, true);
    const id = c.body.draft_id ?? `drf_${base64url(x.rand(16))}`;
    checkSnapshot(c.body.purpose, c.body.snapshot);
    const existing = T().drafts[`${c.sub}|${id}`];
    if (existing) conflict(existing);
    if (mine(c).filter((d) => d.state === "OPEN").length >= LIMITS.drafts) fail(422, "DRAFT_LIMIT", { limit: LIMITS.drafts });
    const at = isoOf(c.now);
    const d = { owner: c.sub, draft_id: id, purpose: c.body.purpose, state: "OPEN", revision: 1, snapshot: c.body.snapshot, created_at: at, updated_at: at, discarded_at: null };
    T().drafts[`${c.sub}|${id}`] = d;
    return ok(draftRef(d), 201);
  });
  route("POST", "/v2/sync/drafts/{draft_id}/revisions", async (c) => {
    await requireSession(c, true);
    const d = draftOf(c, c.params.draft_id);
    if (d.purpose !== c.body.purpose) fail(422, "DRAFT_INVALID", { detail_code: "PURPOSE" });
    checkSnapshot(c.body.purpose, c.body.snapshot);
    if (d.state !== "OPEN") fail(409, "DRAFT_DISCARDED");
    if (c.body.base_revision !== d.revision) conflict(d);
    Object.assign(d, { revision: d.revision + 1, snapshot: c.body.snapshot, updated_at: isoOf(c.now) });
    return ok(draftRef(d));
  });
  route("POST", "/v2/sync/drafts/{draft_id}/discard", async (c) => {
    await requireSession(c, true);
    const d = draftOf(c, c.params.draft_id);
    if (d.state !== "OPEN") fail(409, "DRAFT_DISCARDED");
    if (c.body.base_revision !== d.revision) conflict(d);
    const at = isoOf(c.now);
    Object.assign(d, { revision: d.revision + 1, state: "DISCARDED", snapshot: null, updated_at: at, discarded_at: at });
    return ok(draftRef(d));
  });
  x.exporters.sync = (sub) => ({
    scope: "Phiên thiết bị và bản nháp đồng bộ của chính người này (bản trình diễn, mô phỏng).",
    devices: Object.values(T().devices).filter((d) => d.user === sub).map((d) => ({ device_id: d.device_id, kind: d.kind, state: d.state, created_day: d.created_at.slice(0, 10), last_seen_day: d.last_seen_day, revoked_day: d.revoked_at?.slice(0, 10) ?? null })),
    drafts: Object.values(T().drafts).filter((d) => d.owner === sub).map(draftView),
  });
}

/** Hộp tổng hợp (src/server/inbox.ts) với nguồn Outlook GIẢ LẬP: thư tổng hợp, không thân thư, không liên kết ra ngoài. */
function inboxModule(x) {
  const { fail, ok, route, requireMember, moduleOn, hasGrant, consentGranted } = x;
  const T = () => (x.S().mod.inbox ??= { items: {}, sources: [] });
  Object.assign(x.MESSAGES, {
    INBOX_CONTENT_INVALID: "Nội dung không hợp lệ hoặc quá dài.",
    INBOX_LINK_INVALID: "Liên kết không hợp lệ: chỉ nhận https.",
    INBOX_SNOOZE_INVALID: "Thời điểm tạm hoãn nằm ngoài khoảng cho phép.",
    INBOX_LIMIT: "Đã tới giới hạn của Hộp tổng hợp.",
    INBOX_SOURCE_UNAVAILABLE: "Nguồn này chưa dùng được.",
  });
  const FILTERS = { ACTIVE: ["NEW", "SAVED", "SNOOZED"], NEW: ["NEW"], SAVED: ["SAVED"], SNOOZED: ["SNOOZED"], DONE: ["DONE"] };
  const SENDERS = ["Phòng Hành chính (thử) <hanh-chinh@vi-du.example>", "Nhóm Dự án Lá Chắn (thử) <du-an@vi-du.example>", "Lịch học nội bộ (thử) <dao-tao@vi-du.example>", "Hệ thống phê duyệt (thử) <khong-tra-loi@vi-du.example>"];
  const SUBJECTS = [
    "Nhắc: nộp báo cáo tuần trước 17:00 thứ Sáu", "Lịch họp kế hoạch quý đã cập nhật", "Mời tham gia buổi chia sẻ kiến thức", "Đề nghị xem lại tài liệu thiết kế",
    "Phiếu đăng ký phòng họp đã được duyệt", "Cập nhật quy trình gửi hồ sơ", "Câu hỏi về mốc bàn giao", "Thông báo bảo trì hệ thống cuối tuần",
  ];
  const gate = (c) => {
    if (!x.userOf(c.sub)) fail(404, "NOT_FOUND");
    requireMember(c.sub);
    if (!moduleOn("inbox")) fail(503, "MODULE_DISABLED");
  };
  const entitled = (sub) => moduleOn("inbox") && hasGrant(sub, "inbox.connect") && consentGranted(sub, "inbox_mail");
  const latest = (sub) => T().sources.filter((s) => s.owner === sub).slice(-1)[0] ?? null;
  const live = (sub) => T().sources.find((s) => s.owner === sub && s.status === "CONNECTED") ?? null;
  /** «Đồng bộ» lần đầu một giây sau khi nối, như vòng đồng bộ theo con trỏ của máy chủ: 22 thư tổng hợp. */
  function syncSource(sub, t) {
    const s = live(sub);
    if (!s || s.last_sync_at || t - Date.parse(s.connected_at) < 1000) return;
    const base = Date.parse(s.connected_at);
    for (let i = 0; i < 22; i++) {
      const id = `inb_${x.uuid()}`;
      T().items[id] = {
        id, owner: sub, source_kind: "OUTLOOK_MAIL", connection_id: s.id, purpose: null, observed_at: isoOf(base - (i + 3) * 3 * 3600_000), display_summary: SUBJECTS[(21 - i) % SUBJECTS.length],
        sender: SENDERS[(21 - i) % SENDERS.length], source_link: null, state: "NEW", snooze_until: null, updated_at: isoOf(t), dedupe: null,
      };
    }
    s.last_sync_at = isoOf(t);
  }
  const visible = (it) => it.source_kind === "SHARED" || (entitled(it.owner) && T().sources.find((s) => s.id === it.connection_id)?.status === "CONNECTED");
  const itemView = (r) => ({ item_ref: r.id, source_kind: r.source_kind, observed_at: r.observed_at, display_summary: r.display_summary, sender: r.sender, source_link: r.source_link, state: r.state, snooze_until: r.snooze_until, purpose: r.purpose, updated_at: r.updated_at });
  const sourceView = (sub) => {
    const s = latest(sub);
    return {
      kind: "OUTLOOK_MAIL", simulated: true, available: true, permission: !hasGrant(sub, "inbox.connect") ? "FORBIDDEN" : !consentGranted(sub, "inbox_mail") ? "CONSENT_REQUIRED" : "OK",
      status: s ? s.status : "NOT_CONNECTED", connected_at: s?.connected_at ?? null, last_sync_at: s?.last_sync_at ?? null, ended_at: s?.ended_at ?? null, last_error: s?.last_error ?? null,
    };
  };
  /** Thư hết hạn tạm hoãn quay về «Mới». */
  const wake = (t) => {
    for (const it of Object.values(T().items)) if (it.state === "SNOOZED" && Date.parse(it.snooze_until) <= t) Object.assign(it, { state: "NEW", snooze_until: null, updated_at: isoOf(t) });
  };
  const purgeOutlook = (sub, t) => {
    for (const s of T().sources) if (s.owner === sub && s.status === "CONNECTED") Object.assign(s, { status: "DISCONNECTED", ended_at: isoOf(t) });
    for (const [id, it] of Object.entries(T().items)) if (it.owner === sub && it.source_kind === "OUTLOOK_MAIL") delete T().items[id];
  };
  x.withdrawHooks.push((sub, purpose, t) => {
    if (purpose === "inbox_mail") purgeOutlook(sub, t);
  });
  const enc = (v) => base64url(new TextEncoder().encode(JSON.stringify(v)));
  route("GET", "/v2/inbox/items", (c) => {
    gate(c);
    syncSource(c.sub, c.now);
    wake(c.now);
    const filter = c.query.get("state") ?? "ACTIVE";
    const states = FILTERS[filter];
    const limitRaw = c.query.get("limit");
    const limit = limitRaw === null ? 20 : Number(limitRaw);
    if (!states || !Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, "SCHEMA_INVALID");
    let after = null;
    const cur = c.query.get("cursor");
    if (cur !== null) {
      try {
        const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cur.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0))));
        if (!Array.isArray(v) || v[0] !== "i1" || v[1] !== filter) throw new Error();
        after = { at: v[2], id: v[3] };
      } catch {
        fail(400, "SCHEMA_INVALID", { issues: [{ path: "cursor", message: "cursor không hợp lệ" }] });
      }
    }
    const rows = Object.values(T().items).filter((it) => it.owner === c.sub && states.includes(it.state) && visible(it))
      .sort((a, b) => (a.observed_at === b.observed_at ? (a.id < b.id ? 1 : -1) : a.observed_at < b.observed_at ? 1 : -1))
      .filter((it) => !after || it.observed_at < after.at || (it.observed_at === after.at && it.id < after.id));
    const page = rows.slice(0, limit);
    return ok({
      items: page.map(itemView), next_cursor: rows.length > limit ? enc(["i1", filter, page[page.length - 1].observed_at, page[page.length - 1].id]) : null,
      sources: [{ kind: "SHARED", status: "AVAILABLE" }, sourceView(c.sub)], server_time: isoOf(c.now),
    });
  });
  route("POST", "/v2/inbox/imports", async (c) => {
    gate(c);
    const b = c.body;
    let text = null;
    if (b.text !== undefined) {
      const r = userText(b.text);
      if (!r.ok) fail(422, "INBOX_CONTENT_INVALID", { limit: 280 });
      text = r.text;
    }
    let link = null;
    if (b.url !== undefined) {
      link = checkedLink(b.url);
      if (!link) fail(422, "INBOX_LINK_INVALID");
    }
    if (b.kind === "TEXT" && text === null) fail(422, "INBOX_CONTENT_INVALID", { limit: 280 });
    if (b.kind === "URL" && link === null) fail(422, "INBOX_LINK_INVALID");
    const dedupe = await x.digestJcs({ kind: b.kind, text, url: link });
    const dup = Object.values(T().items).find((it) => it.owner === c.sub && it.dedupe === dedupe);
    if (dup) return ok({ item_ref: dup.id, result: "DUPLICATE", stored_in: "WORKSPACE", item: itemView(dup) });
    const id = `inb_${x.uuid()}`;
    const at = isoOf(c.now);
    const it = { id, owner: c.sub, source_kind: "SHARED", connection_id: null, purpose: b.purpose, observed_at: at, display_summary: text ?? linkSummary(link), sender: null, source_link: link, state: "NEW", snooze_until: null, updated_at: at, dedupe };
    T().items[id] = it;
    return ok({ item_ref: id, result: "STORED", stored_in: "WORKSPACE", item: itemView(it) }, 201);
  });
  const EDGES = { save: ["NEW", "SNOOZED"], snooze: ["NEW", "SAVED"], done: ["NEW", "SAVED", "SNOOZED"] };
  for (const op of ["save", "snooze", "done"]) {
    route("POST", `/v2/inbox/items/{item_ref}/${op}`, (c) => {
      gate(c);
      const it = T().items[c.params.item_ref];
      if (!it || it.owner !== c.sub || !visible(it)) fail(404, "NOT_FOUND");
      let until = null;
      if (op === "snooze") {
        const ms = Date.parse(c.body.until);
        if (Number.isNaN(ms) || ms < c.now + 60_000 || ms > c.now + 30 * DAY_MS) fail(422, "INBOX_SNOOZE_INVALID", { limit: 30 });
        until = isoOf(ms);
      }
      if (!EDGES[op].includes(it.state)) fail(409, "INVALID_TRANSITION", { state: it.state });
      Object.assign(it, { state: op === "save" ? "SAVED" : op === "snooze" ? "SNOOZED" : "DONE", snooze_until: until, updated_at: isoOf(c.now) });
      return ok(itemView(it));
    });
  }
  route("POST", "/v2/inbox/sources/outlook/connect", (c) => {
    gate(c);
    if (!hasGrant(c.sub, "inbox.connect")) fail(403, "FORBIDDEN");
    if (!consentGranted(c.sub, "inbox_mail")) fail(403, "CONSENT_REQUIRED");
    if (c.now / 1000 - c.auth_time > 300) fail(401, "REAUTH_REQUIRED");
    if (live(c.sub)) return ok(sourceView(c.sub));
    T().sources.push({ id: `isrc_${x.uuid()}`, owner: c.sub, status: "CONNECTED", connected_at: isoOf(c.now), last_sync_at: null, ended_at: null, last_error: null });
    return ok(sourceView(c.sub), 201);
  });
  route("POST", "/v2/inbox/sources/outlook/disconnect", (c) => {
    gate(c);
    purgeOutlook(c.sub, c.now);
    return ok(sourceView(c.sub));
  });
  x.exporters.inbox = (sub) => ({ scope: "Mục Hộp tổng hợp của chính người này (bản trình diễn; thư là thư tổng hợp).", items: Object.values(T().items).filter((it) => it.owner === sub).map(itemView) });
}

/** Le‑NodeHome và gói thuê HaaS (src/server/homehub.ts). Bước của LeLS chạy bằng điều khiển riêng của bản trình diễn. */
function homeModule(x) {
  const { fail, ok, route, gate } = x;
  const GATE = { module: "home_hub", scope: "home.hub", purpose: "home_hub" };
  const TERMS = "haas-terms-v1-2026-11";
  const T = () => (x.S().mod.home ??= { subs: {}, hubs: {}, events: [], grants: {} });
  Object.assign(x.MESSAGES, {
    HOME_REVISION_CONFLICT: "Đăng ký đã thay đổi ở nơi khác; hãy xem lại trạng thái mới trước khi làm tiếp.",
    HOME_TERMS_OUTDATED: "Điều khoản dịch vụ đã có phiên bản mới; hãy đọc lại trước khi gửi yêu cầu.",
    HOME_OPEN_LIMIT: "Bạn đã có một đăng ký đang mở.",
    HOME_SERIAL_MISMATCH: "Số serial không khớp với hub đã lắp cho nhà bạn.",
    HOME_VIEW_GRANT_ACTIVE: "Đang có một quyền xem tạm thời còn hiệu lực.",
    HOME_HUB_IDENTITY_INVALID: "Danh tính hub không hợp lệ.",
    HOME_BINDING_STALE: "Sự kiện thuộc liên kết hub cũ và không được nhận.",
    HOME_NOT_ACCEPTING: "Đăng ký hiện không nhận sự kiện từ hub.",
    HOME_UNKNOWN_CAMERA: "Camera này không thuộc hub đã lắp.",
    HOME_EVENT_TIME: "Thời điểm quan sát nằm ngoài khoảng được nhận.",
  });
  const ENDED = ["HAAS_TERMINATED", "HAAS_RETURNED"];
  const HAS_HUB = ["HAAS_INSTALLED", "HAAS_ACTIVE", "HAAS_SUSPENDED"];
  const ACCEPTING = ["HAAS_INSTALLED", "HAAS_ACTIVE"];
  /** Các cạnh HAAS_ của contracts/state_transitions.csv mà bản trình diễn dùng: [từ, sự kiện, bên làm] → tới. */
  const EDGES = {
    "HAAS_REQUESTED|survey|LELS": "HAAS_SURVEYED", "HAAS_REQUESTED|cancel|OWNER": "HAAS_TERMINATED", "HAAS_SURVEYED|accept_quote|OWNER": "HAAS_ACCEPTED", "HAAS_SURVEYED|cancel|OWNER": "HAAS_TERMINATED",
    "HAAS_ACCEPTED|install|LELS": "HAAS_INSTALLED", "HAAS_ACCEPTED|cancel|OWNER": "HAAS_TERMINATED", "HAAS_INSTALLED|confirm_install|OWNER": "HAAS_ACTIVE", "HAAS_INSTALLED|terminate|OWNER": "HAAS_TERMINATED",
    "HAAS_ACTIVE|suspend|LELS": "HAAS_SUSPENDED", "HAAS_SUSPENDED|resume|LELS": "HAAS_ACTIVE", "HAAS_ACTIVE|terminate|OWNER": "HAAS_TERMINATED", "HAAS_SUSPENDED|terminate|OWNER": "HAAS_TERMINATED",
    "HAAS_TERMINATED|return_hub|LELS": "HAAS_RETURNED", "HAAS_TERMINATED|close|SYSTEM": "HAAS_RETURNED",
    "HAAS_REQUESTED|revoke|SYSTEM": "HAAS_TERMINATED", "HAAS_SURVEYED|revoke|SYSTEM": "HAAS_TERMINATED", "HAAS_ACCEPTED|revoke|SYSTEM": "HAAS_TERMINATED",
    "HAAS_INSTALLED|revoke|SYSTEM": "HAAS_TERMINATED", "HAAS_ACTIVE|revoke|SYSTEM": "HAAS_TERMINATED", "HAAS_SUSPENDED|revoke|SYSTEM": "HAAS_TERMINATED",
  };
  function step(s, event, actor, t, set = {}) {
    const to = EDGES[`${s.state}|${event}|${actor}`];
    if (!to) fail(409, "INVALID_TRANSITION", { state: s.state });
    const at = isoOf(t);
    s.steps.push({ seq: s.steps.length + 1, from_state: s.state, event, actor_kind: actor, to_state: to, at });
    Object.assign(s, set, { state: to, revision: s.revision + 1, updated_at: at });
    return s;
  }
  /** Kết thúc dịch vụ: thu hồi hub và quyền xem, xóa sự kiện; chưa từng lắp hub thì đóng luôn. */
  function endService(s, t) {
    const h = T().hubs[s.hub_id];
    if (h) h.status = "REVOKED";
    for (const g of Object.values(T().grants)) if (g.sub === s.id && !g.revoked_at) g.revoked_at = isoOf(t);
    T().events = T().events.filter((e) => e.sub !== s.id);
    return s.binding_version === 0 ? step(s, "close", "SYSTEM", t) : s;
  }
  const own = (c) => {
    const s = T().subs[c.params.subscription_id];
    if (!s || s.owner !== c.sub) fail(404, "NOT_FOUND");
    return s;
  };
  const hubView = (h) => (h ? { hub_id: h.id, serial: h.serial, firmware: h.firmware, binding_version: h.binding_version, status: h.status, last_seen_at: h.last_seen_at, cameras: h.cameras.map((cam) => ({ ...cam })) } : null);
  const grantView = (g, t) => ({ grant_id: g.id, ticket_ref: g.ticket_ref, created_at: g.created_at, expires_at: g.expires_at, revoked_at: g.revoked_at, uses: g.uses, last_used_at: g.last_used_at, active: !g.revoked_at && Date.parse(g.expires_at) > t });
  const grantsOf = (s) => Object.values(T().grants).filter((g) => g.sub === s.id).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const access = (s) => ({ events_visible: HAS_HUB.includes(s.state), hub_accepting: ACCEPTING.includes(s.state), clip_view: "UNAVAILABLE" });
  const subView = (s, t) => ({
    subscription_ref: s.id, state: s.state, site_ref: s.site_ref, package_code: s.package_code, contact_grant: s.contact_grant, terms_version: s.terms_version,
    camera_count: s.camera_count, quote_vnd: s.quote_vnd, quote_accepted_at: s.quote_accepted_at, binding_version: s.binding_version, reason_code: s.reason_code,
    revision: s.revision, created_at: s.created_at, updated_at: s.updated_at, steps: s.steps.map((x2) => ({ ...x2 })), hub: hubView(T().hubs[s.hub_id]), access: access(s),
    view_grants: grantsOf(s).map((g) => grantView(g, t)),
  });
  const eventView = (e) => ({ event_ref: e.id, type: e.type, camera_ref: e.camera_ref, observed_at: e.observed_at, received_at: e.received_at, late: e.late, binding_version: e.binding_version, clip_ref: e.clip_ref, verified: false });
  const liveOf = (sub) => Object.values(T().subs).filter((s) => s.owner === sub && !ENDED.includes(s.state));
  x.withdrawHooks.push((sub, purpose, t) => {
    if (purpose !== "home_hub") return;
    for (const s of liveOf(sub)) endService(step(s, "revoke", "SYSTEM", t, { reason_code: "AUTHORITY" }), t);
  });

  route("GET", "/v2/home/subscriptions", (c) => {
    gate(c.sub, GATE);
    const rows = Object.values(T().subs).filter((s) => s.owner === c.sub).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return ok({ subscriptions: rows.map((s) => subView(s, c.now)), terms_version: TERMS, packages: ["HOME_PILOT"] });
  });
  route("POST", "/v2/home/subscriptions", (c) => {
    gate(c.sub, GATE);
    if (c.body.terms_version !== TERMS) fail(422, "HOME_TERMS_OUTDATED", { terms_version: TERMS });
    if (liveOf(c.sub).length) fail(409, "HOME_OPEN_LIMIT");
    const id = `hsub_${x.uuid()}`;
    const at = isoOf(c.now);
    T().subs[id] = {
      id, owner: c.sub, site_ref: c.body.site_ref, package_code: c.body.package_code, contact_grant: c.body.contact_grant, terms_version: c.body.terms_version, state: "HAAS_REQUESTED",
      camera_count: null, quote_vnd: null, quote_accepted_at: null, binding_version: 0, reason_code: null, revision: 1, created_at: at, updated_at: at, hub_id: null,
      steps: [{ seq: 1, from_state: null, event: "request", actor_kind: "OWNER", to_state: "HAAS_REQUESTED", at }],
    };
    return ok(subView(T().subs[id], c.now), 201);
  });
  for (const [op, event] of [["accept-quote", "accept_quote"], ["confirm-install", "confirm_install"], ["cancel", "cancel"], ["terminate", "terminate"]]) {
    route("POST", `/v2/home/subscriptions/{subscription_id}/${op}`, (c) => {
      gate(c.sub, GATE);
      const s = own(c);
      if (c.body.revision !== s.revision) fail(409, "HOME_REVISION_CONFLICT", { revision: s.revision, state: s.state });
      if (event === "confirm_install") {
        const h = T().hubs[s.hub_id];
        if (!EDGES[`${s.state}|confirm_install|OWNER`]) fail(409, "INVALID_TRANSITION", { state: s.state });
        if (!h || h.status !== "ACTIVE" || c.body.serial !== h.serial) fail(422, "HOME_SERIAL_MISMATCH");
        step(s, event, "OWNER", c.now);
      } else if (event === "terminate") {
        if (c.now / 1000 - c.auth_time > 300) fail(401, "REAUTH_REQUIRED");
        endService(step(s, event, "OWNER", c.now, { reason_code: "CUSTOMER_REQUEST" }), c.now);
      } else if (event === "cancel") {
        endService(step(s, event, "OWNER", c.now, { reason_code: "CUSTOMER_REQUEST" }), c.now);
      } else step(s, event, "OWNER", c.now, { quote_accepted_at: isoOf(c.now) });
      return ok(subView(s, c.now));
    });
  }
  route("GET", "/v2/home/subscriptions/{subscription_id}/events", (c) => {
    gate(c.sub, GATE);
    const s = own(c);
    const rows = access(s).events_visible ? T().events.filter((e) => e.sub === s.id).sort((a, b) => (a.observed_at < b.observed_at ? 1 : -1)).slice(0, 100) : [];
    return ok({ subscription_ref: s.id, state: s.state, events: rows.map(eventView), retention_days: 30, clip_view: "UNAVAILABLE" });
  });
  route("GET", "/v2/home/subscriptions/{subscription_id}/export", (c) => {
    gate(c.sub, GATE);
    const s = own(c);
    return ok({ scope: "Dữ liệu Le‑NodeHome của đăng ký này trong bản trình diễn (mô phỏng): các bước, hub, quyền xem và sự kiện tối thiểu. Không có hình, video hay âm thanh.", subscription: { ...subView(s, c.now), events: T().events.filter((e) => e.sub === s.id).map(eventView) } });
  });
  route("POST", "/v2/home/subscriptions/{subscription_id}/view-grants", (c) => {
    gate(c.sub, GATE);
    const s = own(c);
    if (!HAS_HUB.includes(s.state)) fail(409, "INVALID_TRANSITION", { state: s.state });
    if (grantsOf(s).some((g) => grantView(g, c.now).active)) fail(409, "HOME_VIEW_GRANT_ACTIVE");
    const id = `hvg_${x.uuid()}`;
    T().grants[id] = { id, sub: s.id, ticket_ref: c.body.ticket_ref, created_at: isoOf(c.now), expires_at: isoOf(c.now + c.body.minutes * 60_000), revoked_at: null, uses: 0, last_used_at: null };
    return ok(grantView(T().grants[id], c.now), 201);
  });
  route("POST", "/v2/home/view-grants/{grant_id}/revoke", (c) => {
    gate(c.sub, GATE);
    const g = T().grants[c.params.grant_id];
    const s = g && T().subs[g.sub];
    if (!g || !s || s.owner !== c.sub) fail(404, "NOT_FOUND");
    if (!g.revoked_at) g.revoked_at = isoOf(c.now);
    return ok(grantView(g, c.now));
  });
  /** Phong bì của hub giả lập: HMAC-SHA256 trên mã băm JCS (mọi trường trừ proof), như web/views/services-home.js và homehub.ts. */
  async function proofOf(key, env) {
    const { proof: _p, ...rest } = env;
    const raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) => ch.charCodeAt(0));
    const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(await x.digestJcs(rest)))));
  }
  route("POST", "/v2/home/hubs/{hub_id}/events", async (c) => {
    if (!x.moduleOn("home_hub")) fail(503, "MODULE_DISABLED");
    const h = T().hubs[c.params.hub_id];
    if (c.sub !== `hub:${c.params.hub_id}` || !h || h.status !== "ACTIVE") fail(401, "HOME_HUB_IDENTITY_INVALID");
    const b = c.body;
    if (typeof b.proof !== "string" || (await proofOf(h.key, b)) !== b.proof) fail(401, "HOME_HUB_IDENTITY_INVALID");
    const s = T().subs[h.sub];
    if (b.binding_version !== s.binding_version || b.binding_version !== h.binding_version) fail(409, "HOME_BINDING_STALE", { binding_version: s.binding_version });
    if (!ACCEPTING.includes(s.state)) fail(409, "HOME_NOT_ACCEPTING", { state: s.state });
    const cam = h.cameras.find((x2) => x2.camera_ref === b.camera_ref);
    if (!cam) fail(422, "HOME_UNKNOWN_CAMERA");
    if (b.clip_ref !== undefined && b.type !== "PERSON_IN_ZONE") fail(400, "SCHEMA_INVALID");
    const observed = Date.parse(b.observed_at);
    if (!(observed <= c.now + 120_000) || c.now - observed > 30 * DAY_MS) fail(422, "HOME_EVENT_TIME");
    h.last_seen_at = isoOf(c.now);
    const dup = T().events.find((e) => e.hub === h.id && e.camera_ref === b.camera_ref && e.epoch === b.epoch && e.event_id === b.event_id);
    // Bản trùng: 200 với biên nhận cũ (duplicate=true), như máy chủ tham chiếu và hợp đồng.
    if (dup) return ok({ event_ref: dup.id, duplicate: true, late: dup.late, received_at: dup.received_at }, 200);
    const e = { id: `hev_${x.uuid()}`, sub: s.id, hub: h.id, camera_ref: b.camera_ref, epoch: b.epoch, event_id: b.event_id, type: b.type, observed_at: isoOf(observed), received_at: isoOf(c.now), late: c.now - observed > 120_000, binding_version: b.binding_version, clip_ref: b.clip_ref ?? null };
    T().events.push(e);
    if ((b.type === "CAMERA_OFFLINE" || b.type === "CAMERA_ONLINE") && (!cam.observed_at || cam.observed_at <= e.observed_at)) Object.assign(cam, { online: b.type === "CAMERA_ONLINE", observed_at: e.observed_at });
    return ok({ event_ref: e.id, duplicate: false, late: e.late, received_at: e.received_at }, 201);
  });
  x.devRoute("/dev/home/hub-credential", ({ query, now: t }) => {
    const h = T().hubs[query.get("hub_id") ?? ""];
    if (!h || h.status !== "ACTIVE") fail(404, "NOT_FOUND");
    return { simulated: true, hub_id: h.id, workspace_id: x.WS, binding_version: h.binding_version, cameras: h.cameras.map((cam) => cam.camera_ref), key: h.key, token: `demohub.${h.id}.${t}`, expires_in: 900 };
  });
  /**
   * Điều khiển chỉ có ở bản trình diễn: làm bước kế tiếp của LeLS cho đăng ký đang mở của một người (khảo sát và báo giá, lắp hub,
   * tạm ngừng, mở lại, thu hub về). Ở hệ thật bước này do vận hành LeLS làm qua /v2/ops/home/*. Trả mã bước đã làm hoặc null.
   */
  x.controls.homeNext = (sub = "dev_a") => {
    const t = x.now();
    const s = Object.values(T().subs).filter((s2) => s2.owner === sub && s2.state !== "HAAS_RETURNED").sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (!s) return null;
    if (s.state === "HAAS_REQUESTED") return step(s, "survey", "LELS", t, { camera_count: 2, quote_vnd: 690000 }), { event: "survey" };
    if (s.state === "HAAS_ACCEPTED") {
      const id = `hub_${base64url(x.rand(12))}`;
      const serial = `LNH-HUB-${x.hex(x.rand(2)).toUpperCase()}`;
      const at = isoOf(t);
      T().hubs[id] = { id, sub: s.id, serial, firmware: "1.0.0", binding_version: s.binding_version + 1, status: "ACTIVE", last_seen_at: null, key: base64url(x.rand(32)), created_at: at, cameras: [{ camera_ref: "cam_front", online: false, observed_at: null }, { camera_ref: "cam_yard", online: false, observed_at: null }] };
      step(s, "install", "LELS", t, { hub_id: id, binding_version: s.binding_version + 1 });
      return { event: "install", serial };
    }
    if (s.state === "HAAS_ACTIVE") return step(s, "suspend", "LELS", t, { reason_code: "MAINTENANCE" }), { event: "suspend" };
    if (s.state === "HAAS_SUSPENDED") return step(s, "resume", "LELS", t, { reason_code: null }), { event: "resume" };
    if (s.state === "HAAS_TERMINATED") return step(s, "return_hub", "LELS", t), { event: "return_hub" };
    return null;
  };
  /** Bước LeLS kế tiếp có làm được không (để giao diện của bản trình diễn bật hoặc tắt nút). */
  x.controls.homeNextLabel = (sub = "dev_a") => {
    const s = Object.values(T().subs).filter((s2) => s2.owner === sub && s2.state !== "HAAS_RETURNED").sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    const map = { HAAS_REQUESTED: "survey", HAAS_ACCEPTED: "install", HAAS_ACTIVE: "suspend", HAAS_SUSPENDED: "resume", HAAS_TERMINATED: "return_hub" };
    return s ? map[s.state] ?? null : null;
  };
  x.exporters.home_hub = (sub) => ({ scope: "Đăng ký Le‑NodeHome của chính người này (bản trình diễn, mô phỏng).", subscriptions: Object.values(T().subs).filter((s) => s.owner === sub).map((s) => subView(s, x.now())) });
}

/** Le‑NodeHealth phép đo (src/server/measurements.ts): máy đo giả lập, ánh xạ, cách ly, chia sẻ. Chỉ giữ trong bộ nhớ của trang. */
function measModule(x) {
  const { fail, ok, route, gate } = x;
  const GATE = { module: "measurements", scope: "measurements.record", purpose: "measurements" };
  const SOURCES = [{ adapter_id: "mad_sim_cloud", channel: "PARTNER_CLOUD", trust: "SIMULATED", status: "APPROVED" }, { adapter_id: "mad_sim_phone", channel: "PHONE_GATEWAY", trust: "SIMULATED", status: "APPROVED" }];
  Object.assign(x.MESSAGES, { MEAS_SHARE_LIMIT: "Đã đủ số grant chia sẻ đang hiệu lực.", MEAS_ADAPTER_MISSING: "Chưa có adapter mô phỏng cho kênh này." });
  const T = () => (x.M.meas ??= { obs: [], quarantine: [], mappings: [], shares: [], access: [], keys: {}, tomb: new Set(), last: {}, lastAt: {} });
  const entitled = (sub) => x.moduleOn("measurements") && x.hasGrant(sub, GATE.scope) && x.consentGranted(sub, GATE.purpose);
  const memberGate = (c) => {
    if (!x.userOf(c.sub)) fail(404, "NOT_FOUND");
    x.requireMember(c.sub);
    if (!x.moduleOn("measurements")) fail(503, "MODULE_DISABLED");
  };
  const log = (owner, actor, action, ref, t) => T().access.unshift({ owner, actor, action, ref, at: isoOf(t) });
  const obsView = (o) => ({ observation_id: o.id, subject_ref: o.subject, source: o.adapter_id, device_ref: o.device_ref, measured_at: o.measured_at, received_at: o.received_at, systolic: o.systolic, diastolic: o.diastolic, unit: "mmHg", quality_status: "VALID" });
  const mapView = (m) => ({ mapping_id: m.id, device_ref: m.device_ref, user_slot: m.user_slot, state: m.state, proposed_by: m.proposed_by, created_at: m.created_at, decided_at: m.decided_at, pending_records: T().quarantine.filter((q) => q.mapping_id === m.id && q.state === "MEAS_QUARANTINED").length });
  const qView = (r, user) => ({
    record_id: r.id, state: r.state, reason: r.reason, source: r.adapter_id, device_ref: r.device_ref, user_slot: r.user_slot, measured_at: r.measured_at, received_at: r.received_at,
    mapping_id: r.mapping_id, my_answer: r.answers[user] ?? null, candidates: r.candidates.length, answered: r.candidates.filter((u) => r.answers[u]).length,
  });
  const shareView = (s) => ({ share_id: s.id, owner: s.owner, grantee: s.grantee, purpose: s.purpose, scope: { kind: "blood_pressure", from_date: s.from, received_until: s.until }, expires_at: s.expires_at, state: s.state, created_at: s.created_at, ended_at: s.ended_at });
  const usable = (s, t) => s.state === "MEASSHARE_ACTIVE" && Date.parse(s.expires_at) > t && entitled(s.owner);
  const routeOf = (device, slot) => {
    const rel = T().mappings.filter((m) => m.device_ref === device && m.state === "MEASMAP_CONFIRMED" && (slot === null || m.user_slot === slot || m.user_slot === 0));
    const subjects = [...new Set(rel.map((m) => m.subject))];
    if (!subjects.length) return { assign: null, candidates: [], reason: null };
    if (subjects.length === 1 && (slot !== null || rel.every((m) => m.user_slot === 0))) return { assign: subjects[0], candidates: subjects, reason: null };
    return { assign: null, candidates: subjects, reason: slot === null ? "AMBIGUOUS_USER" : "PROFILE_CONFLICT" };
  };
  const toObs = (r, subject, t) => {
    const o = { id: `mob_${x.uuid()}`, subject, adapter_id: r.adapter_id, device_ref: r.device_ref, measured_at: r.measured_at, instant: r.instant, received_at: r.received_at, systolic: r.systolic, diastolic: r.diastolic, dedupe: r.dedupe, created_at: isoOf(t) };
    T().obs.push(o);
    return o;
  };
  /** Một phép đo đi đúng đường nhập của adapter: chống trùng hai tầng, ánh xạ đã xác nhận, cách ly khi chưa rõ người. */
  function ingest(adapter, item, t) {
    const sk = item.source_key;
    const dedupe = JSON.stringify([item.device_ref, item.user_slot, item.instant]);
    const content = JSON.stringify([dedupe, item.systolic, item.diastolic]);
    const seen = T().keys[`${adapter}|${sk}`];
    if (seen) return seen.content === content ? { source_key: sk, result: "DUPLICATE", record_ref: seen.ref } : { source_key: sk, result: "REJECTED", detail_code: "SOURCE_KEY_REUSED" };
    const remember = (ref) => (T().keys[`${adapter}|${sk}`] = { content, ref });
    if (T().tomb.has(dedupe)) return { source_key: sk, result: "DUPLICATE", record_ref: null };
    const base = { adapter_id: adapter, device_ref: item.device_ref, user_slot: item.user_slot, measured_at: item.measured_at, instant: item.instant, received_at: isoOf(t), systolic: item.systolic, diastolic: item.diastolic, dedupe };
    const quarantine = (reason, candidates, mappingId) => {
      const r = { ...base, id: `mqr_${x.uuid()}`, reason, candidates, mapping_id: mappingId, answers: {}, state: "MEAS_QUARANTINED", created_at: isoOf(t) };
      T().quarantine.push(r);
      remember(r.id);
      return { source_key: sk, result: "QUARANTINED", record_ref: r.id, reason };
    };
    const same = T().obs.find((o) => o.dedupe === dedupe) ?? T().quarantine.find((q) => q.dedupe === dedupe && q.state === "MEAS_QUARANTINED");
    if (same) {
      if (same.systolic === item.systolic && same.diastolic === item.diastolic) return remember(same.id), { source_key: sk, result: "DUPLICATE", record_ref: same.id };
      return quarantine("SOURCE_CONFLICT", same.subject ? [same.subject] : same.candidates, null);
    }
    const r = routeOf(item.device_ref, item.user_slot);
    if (r.assign) {
      if (!entitled(r.assign)) return { source_key: sk, result: "REJECTED", detail_code: "SUBJECT_UNAVAILABLE" };
      const o = toObs(base, r.assign, t);
      remember(o.id);
      return { source_key: sk, result: "ACCEPTED", record_ref: o.id };
    }
    if (r.reason) return quarantine(r.reason, r.candidates, null);
    const hint = item.subject_hint;
    if (hint && entitled(hint)) {
      const slot = item.user_slot ?? 0;
      const existing = T().mappings.filter((m) => m.device_ref === item.device_ref && m.user_slot === slot && m.subject === hint);
      if (existing.some((m) => m.state === "MEASMAP_REJECTED")) return quarantine("SUBJECT_MISSING", [], null);
      let m = existing.find((m2) => m2.state === "MEASMAP_PROPOSED");
      if (!m) T().mappings.unshift((m = { id: `mmp_${x.uuid()}`, device_ref: item.device_ref, user_slot: slot, subject: hint, state: "MEASMAP_PROPOSED", proposed_by: adapter, created_at: isoOf(t), decided_at: null }));
      return quarantine("MAPPING_UNCONFIRMED", [hint], m.id);
    }
    return quarantine("SUBJECT_MISSING", [], null);
  }
  const vnStamp = (ms) => {
    const d = new Date(ms + 7 * 3600_000).toISOString().slice(0, 19);
    return `${d}+07:00`;
  };
  route("POST", "/v2/health/sim-device/readings", (c) => {
    memberGate(c);
    const b = c.body;
    const channels = b.channel === "BOTH" ? ["PHONE_GATEWAY", "PARTNER_CLOUD"] : [b.channel];
    const key = c.sub;
    let batch = b.repeat_last ? T().last[key] : null;
    if (!batch) {
      const devKey = b.device === "SHARED" ? "shared" : c.sub;
      const at = Math.max(Math.floor((c.now - 60_000) / 1000) * 1000, (T().lastAt[devKey] ?? 0) + 1000);
      T().lastAt[devKey] = at;
      const r = x.rand(2);
      const item = { device_ref: b.device === "SHARED" ? "sim_cuff_shared" : `sim_cuff_${c.sub}`, user_slot: b.user_slot === 0 ? null : b.user_slot, subject_hint: b.hint_self ? c.sub : null, measured_at: vnStamp(at), instant: isoOf(at), systolic: 108 + (r[0] % 27), diastolic: 66 + (r[1] % 17) };
      batch = channels.map((channel) => ({ channel, item: { ...item, source_key: `sim-${x.uuid()}` } }));
    }
    T().last[key] = batch;
    const results = batch.map(({ channel, item }) => {
      const a = SOURCES.find((s) => s.channel === channel);
      return { adapter_id: a.adapter_id, channel, label: "SIMULATED", ...ingest(a.adapter_id, item, c.now) };
    });
    return ok({ label: "SIMULATED", results });
  });
  route("GET", "/v2/health/observations", (c) => {
    gate(c.sub, GATE);
    return ok({ observations: T().obs.filter((o) => o.subject === c.sub).sort((a, b) => (a.instant < b.instant ? 1 : -1)).map(obsView), sources: SOURCES.map((s) => ({ ...s })), disclaimer_code: "NOT_A_DIAGNOSTIC_DEVICE" });
  });
  route("GET", "/v2/health/mappings", (c) => (gate(c.sub, GATE), ok({ mappings: T().mappings.filter((m) => m.subject === c.sub).map(mapView) })));
  const ownMap = (c) => {
    const m = T().mappings.find((m2) => m2.id === c.params.mapping_id && m2.subject === c.sub);
    if (!m) fail(404, "NOT_FOUND");
    return m;
  };
  route("POST", "/v2/health/mappings/{mapping_id}/confirm", (c) => {
    gate(c.sub, GATE);
    const m = ownMap(c);
    if (m.state !== "MEASMAP_PROPOSED") fail(409, "INVALID_TRANSITION");
    Object.assign(m, { state: "MEASMAP_CONFIRMED", decided_at: isoOf(c.now) });
    let assigned = 0;
    let conflicted = 0;
    for (const r of T().quarantine.filter((q) => q.mapping_id === m.id && q.state === "MEAS_QUARANTINED" && q.reason === "MAPPING_UNCONFIRMED")) {
      const rt = routeOf(r.device_ref, r.user_slot);
      if (rt.assign === c.sub) {
        const o = toObs(r, c.sub, c.now);
        Object.assign(r, { state: "MEAS_ASSIGNED", observation_id: o.id });
        assigned++;
      } else {
        Object.assign(r, { candidates: [...new Set([...r.candidates, ...rt.candidates])], reason: rt.reason ?? "PROFILE_CONFLICT" });
        conflicted++;
      }
    }
    log(c.sub, c.sub, "MAPPING_CONFIRMED", m.id, c.now);
    return ok({ ...mapView(m), assigned, conflicted });
  });
  route("POST", "/v2/health/mappings/{mapping_id}/reject", (c) => {
    gate(c.sub, GATE);
    const m = ownMap(c);
    if (!["MEASMAP_PROPOSED", "MEASMAP_CONFIRMED"].includes(m.state)) fail(409, "INVALID_TRANSITION");
    Object.assign(m, { state: m.state === "MEASMAP_CONFIRMED" ? "MEASMAP_REVOKED" : "MEASMAP_REJECTED", decided_at: isoOf(c.now) });
    let discarded = 0;
    for (const r of T().quarantine.filter((q) => q.mapping_id === m.id && q.state === "MEAS_QUARANTINED" && q.reason === "MAPPING_UNCONFIRMED" && q.candidates.length === 1)) {
      r.state = "MEAS_DISCARDED";
      discarded++;
    }
    log(c.sub, c.sub, "MAPPING_REJECTED", m.id, c.now);
    return ok({ ...mapView(m), discarded });
  });
  route("GET", "/v2/health/quarantine", (c) => (gate(c.sub, GATE), ok({ records: T().quarantine.filter((q) => q.state === "MEAS_QUARANTINED" && q.candidates.includes(c.sub)).map((q) => qView(q, c.sub)), retention_days: 30 })));
  route("POST", "/v2/health/quarantine/{record_id}/resolve", (c) => {
    gate(c.sub, GATE);
    const r = T().quarantine.find((q) => q.id === c.params.record_id);
    if (!r || !r.candidates.includes(c.sub)) fail(404, "NOT_FOUND");
    if (r.state !== "MEAS_QUARANTINED") fail(409, "INVALID_TRANSITION");
    r.answers[c.sub] = c.body.answer;
    let outcome = "WAITING";
    if (r.candidates.every((u) => r.answers[u])) {
      const mine = r.candidates.filter((u) => r.answers[u] === "MINE");
      if (!mine.length) {
        r.state = "MEAS_DISCARDED";
        outcome = "DISCARDED";
      } else if (mine.length === 1 && entitled(mine[0])) {
        const o = toObs(r, mine[0], c.now);
        Object.assign(r, { state: "MEAS_ASSIGNED", observation_id: o.id });
        outcome = "ASSIGNED";
      } else outcome = "CONTESTED";
    }
    return ok({ ...qView(r, c.sub), outcome: outcome === "ASSIGNED" && r.answers[c.sub] !== "MINE" ? "RESOLVED" : outcome });
  });
  route("GET", "/v2/health/shares", (c) => {
    memberGate(c);
    const granted = T().shares.filter((s) => s.owner === c.sub).map(shareView);
    const received = T().shares.filter((s) => s.grantee === c.sub && usable(s, c.now)).map((s) => ({ ...shareView(s), owner_name: x.userOf(s.owner)?.name ?? s.owner }));
    const people = entitled(c.sub) ? x.DEMO_USERS.filter((u) => u.sub !== c.sub).map((u) => ({ user_id: u.sub, name: u.name })).sort((a, b) => a.name.localeCompare(b.name)) : [];
    return ok({ granted, received, people, access_log: T().access.filter((a) => a.owner === c.sub).slice(0, 100).map(({ owner: _o, ...a }) => a) });
  });
  route("POST", "/v2/health/shares", (c) => {
    gate(c.sub, GATE);
    const b = c.body;
    if (b.grantee_user === c.sub || !x.userOf(b.grantee_user)) fail(404, "NOT_FOUND");
    if (Number.isNaN(Date.parse(b.from_date + "T00:00:00Z"))) fail(400, "SCHEMA_INVALID");
    if (T().shares.filter((s) => s.owner === c.sub && s.state === "MEASSHARE_ACTIVE").length >= 10) fail(422, "MEAS_SHARE_LIMIT");
    const s = { id: `msh_${x.uuid()}`, owner: c.sub, grantee: b.grantee_user, purpose: b.purpose, from: b.from_date, until: isoOf(c.now), expires_at: isoOf(c.now + b.expires_in_days * DAY_MS), state: "MEASSHARE_ACTIVE", created_at: isoOf(c.now), ended_at: null };
    T().shares.unshift(s);
    log(c.sub, c.sub, "SHARE_CREATED", s.id, c.now);
    return ok(shareView(s), 201);
  });
  route("POST", "/v2/health/shares/{share_id}/revoke", (c) => {
    memberGate(c);
    const s = T().shares.find((s2) => s2.id === c.params.share_id && s2.owner === c.sub);
    if (!s) fail(404, "NOT_FOUND");
    if (s.state !== "MEASSHARE_ACTIVE") fail(409, "INVALID_TRANSITION");
    Object.assign(s, { state: "MEASSHARE_REVOKED", ended_at: isoOf(c.now) });
    log(c.sub, c.sub, "SHARE_REVOKED", s.id, c.now);
    return ok(shareView(s));
  });
  route("GET", "/v2/health/shares/{share_id}/observations", (c) => {
    memberGate(c);
    const s = T().shares.find((s2) => s2.id === c.params.share_id && s2.grantee === c.sub);
    if (!s || !usable(s, c.now)) fail(404, "NOT_FOUND");
    const rows = T().obs.filter((o) => o.subject === s.owner && o.measured_at.slice(0, 10) >= s.from && o.received_at <= s.until).sort((a, b) => (a.instant < b.instant ? 1 : -1));
    log(s.owner, c.sub, "SHARE_VIEWED", s.id, c.now);
    return ok({ share: shareView(s), owner_name: x.userOf(s.owner)?.name ?? s.owner, observations: rows.map(obsView), disclaimer_code: "NOT_A_DIAGNOSTIC_DEVICE" });
  });
  const exportOf = (sub) => ({
    format: "LNH-MEAS-EXPORT-1", scope: "Phép đo huyết áp TỔNG HỢP của bản trình diễn (mô phỏng, không phải hồ sơ y tế, không phải thiết bị y tế chẩn đoán).",
    observations: T().obs.filter((o) => o.subject === sub).map((o) => ({ ...obsView(o), zone: null, user_slot: null })),
    mappings: T().mappings.filter((m) => m.subject === sub).map((m) => ({ mapping_id: m.id, device_ref: m.device_ref, user_slot: m.user_slot, state: m.state, created_at: m.created_at, decided_at: m.decided_at })),
    shares: T().shares.filter((s) => s.owner === sub).map(shareView), access_log: T().access.filter((a) => a.owner === sub).map(({ owner: _o, ...a }) => a),
  });
  route("GET", "/v2/health/observations/export", (c) => {
    memberGate(c);
    log(c.sub, c.sub, "EXPORTED", null, c.now);
    return ok({ ...exportOf(c.sub), exported_at: isoOf(c.now) });
  });
  route("POST", "/v2/health/observations/{observation_id}/delete", (c) => {
    memberGate(c);
    const i = T().obs.findIndex((o) => o.id === c.params.observation_id && o.subject === c.sub);
    if (i < 0) fail(404, "NOT_FOUND");
    T().tomb.add(T().obs[i].dedupe);
    T().obs.splice(i, 1);
    log(c.sub, c.sub, "DELETED", c.params.observation_id, c.now);
    return ok({ observation_id: c.params.observation_id, deleted: true });
  });
  /** Rút đồng ý, xóa: bỏ người này khỏi ánh xạ, grant và danh sách ứng viên. */
  const withdrawPerson = (sub, t) => {
    for (const m of T().mappings) if (m.subject === sub && ["MEASMAP_PROPOSED", "MEASMAP_CONFIRMED"].includes(m.state)) Object.assign(m, { state: "MEASMAP_REVOKED", decided_at: isoOf(t) });
    for (const s of T().shares) if ((s.owner === sub || s.grantee === sub) && s.state === "MEASSHARE_ACTIVE") Object.assign(s, { state: "MEASSHARE_REVOKED", ended_at: isoOf(t) });
    for (const q of T().quarantine) if (q.state === "MEAS_QUARANTINED" && q.candidates.includes(sub)) {
      q.candidates = q.candidates.filter((u) => u !== sub);
      delete q.answers[sub];
    }
  };
  route("POST", "/v2/health/erase", (c) => {
    memberGate(c);
    if (c.now / 1000 - c.auth_time > 300) fail(401, "REAUTH_REQUIRED");
    const mine = T().obs.filter((o) => o.subject === c.sub);
    for (const o of mine) T().tomb.add(o.dedupe);
    T().obs = T().obs.filter((o) => o.subject !== c.sub);
    withdrawPerson(c.sub, c.now);
    log(c.sub, c.sub, "DELETED", null, c.now);
    return ok({ deleted: mine.length });
  });
  x.withdrawHooks.push((sub, purpose, t) => {
    if (purpose === "measurements") withdrawPerson(sub, t);
  });
  x.exporters.measurements = (sub) => exportOf(sub);
}

/** Cổng mô phỏng Le‑ORION (src/server/sim.ts): danh mục có phiên bản, hàng đợi mô phỏng, biên nhận ký HMAC, nhãn SIMULATED. */
function simModule(x) {
  const { fail, ok, route, gate } = x;
  const GATE = { module: "sim", scope: "sim.run", purpose: null };
  const LAB = "lab_orion_dev";
  Object.assign(x.MESSAGES, {
    SIM_SKILL_UNKNOWN: "Kỹ năng chưa có trong danh mục đã đăng ký.", SIM_SCENE_UNKNOWN: "Phiên bản scene chưa đăng ký cho kỹ năng này.",
    SIM_REQUEST_REUSED: "request_ref đã dùng cho một lượt mô phỏng khác.", SIM_QUEUE_FULL: "Hàng đợi mô phỏng đã đầy; hãy thử lại sau.",
  });
  const MANIFESTS = [
    { scene_id: "scn_kitchen", version: "1.0.0", objects: ["table", "cup", "shelf"], physics: "rigid-v1" },
    { scene_id: "scn_kitchen", version: "1.1.0", objects: ["table", "cup", "shelf", "tray"], physics: "rigid-v1" },
    { scene_id: "scn_living_room", version: "1.0.0", objects: ["sofa", "rug", "door"], physics: "rigid-v1" },
    { scene_id: "scn_laundry", version: "0.9.0", objects: ["basket", "towel"], physics: "cloth-v0" },
  ];
  const SKILLS = [
    { skill_ref: "skl_pick_place", version: "1.0.0", scenes: ["scn_kitchen"], max_steps: 120 },
    { skill_ref: "skl_navigate_room", version: "1.2.0", scenes: ["scn_kitchen", "scn_living_room"], max_steps: 300 },
    { skill_ref: "skl_fold_towel", version: "0.3.0", scenes: ["scn_laundry"], max_steps: 200 },
  ];
  let scenes = null;
  const sceneList = async () => (scenes ??= await Promise.all(MANIFESTS.map(async (m) => ({ scene_version: `${m.scene_id}@${m.version}`, scene_id: m.scene_id, version: m.version, manifest_digest: await x.digestJcs(m) }))));
  const T = () => (x.S().mod.sim ??= { runs: [], key: base64url(x.rand(32)) });
  const receiptOf = (r) => ({ action_id: r.action_id, run_id: r.run_ref, scene_version: r.scene_version, at: r.queued_at, status: "SIMULATED" });
  /** Trình mô phỏng tham chiếu: lượt đã chờ ít nhất 2 giây thì có kết quả tổng hợp (tính khi đọc). */
  const settle = (t) => {
    for (const r of T().runs) {
      if (r.state !== "SIMRUN_QUEUED" || t - Date.parse(r.queued_at) < 2000) continue;
      const max = SKILLS.find((s) => s.skill_ref === r.skill_ref)?.max_steps ?? 100;
      const h = r.seed;
      const steps = 20 + (h % Math.max(1, max - 20));
      const limit = h % 5 === 0;
      Object.assign(r, { state: "SIMRUN_COMPLETED", completed_at: isoOf(Date.parse(r.queued_at) + 2000), result: { label: "SIMULATED", outcome: limit ? "SIM_STEP_LIMIT" : "SIM_GOAL_REACHED", steps: limit ? max : steps, sim_seconds: Math.round(steps * 0.5) } });
    }
  };
  const runView = (r) => ({ run_ref: r.run_ref, label: "SIMULATED", skill_ref: r.skill_ref, scene_version: r.scene_version, state: r.state, queue: "SIMULATION", receipt: receiptOf(r), queued_at: r.queued_at, completed_at: r.completed_at, result: r.result });
  async function sign(r) {
    const claims = { typ: "lnh-sim-receipt", iss: "lenhip-sim", aud: `lab:${LAB}`, ...receiptOf(r), skill_ref: r.skill_ref };
    const body = base64url(new TextEncoder().encode(canonicalize(claims)));
    const raw = Uint8Array.from(atob(T().key.replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) => ch.charCodeAt(0));
    const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `lnhsim1.${body}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`lnhsim1.${body}`))))}`;
  }
  route("GET", "/v2/sim/catalog", async (c) => {
    gate(c.sub, GATE);
    return ok({ label: "SIMULATED", lab_ref: LAB, skills: SKILLS.map((s) => ({ ...s, scenes: [...s.scenes] })), scenes: await sceneList(), limits: { queued_per_workspace: 20, inputs: "NO_CAMERA_NO_MEASUREMENTS", physical_robot: "OUT_OF_SCOPE_G3" } });
  });
  route("GET", "/v2/sim/runs", (c) => {
    gate(c.sub, GATE);
    settle(c.now);
    return ok({ label: "SIMULATED", runs: T().runs.filter((r) => r.actor === c.sub).slice().reverse().slice(0, 100).map(runView) });
  });
  route("POST", "/v2/sim/runs", async (c) => {
    gate(c.sub, GATE);
    settle(c.now);
    const b = c.body;
    const skill = SKILLS.find((s) => s.skill_ref === b.skill_ref);
    if (!skill) fail(422, "SIM_SKILL_UNKNOWN");
    const scene = (await sceneList()).find((s) => s.scene_version === b.scene_version);
    if (!scene || !skill.scenes.includes(scene.scene_id)) fail(422, "SIM_SCENE_UNKNOWN");
    const existing = T().runs.find((r) => r.actor === c.sub && r.request_ref === b.request_ref);
    if (existing) {
      if (existing.skill_ref !== b.skill_ref || existing.scene_version !== b.scene_version) fail(409, "SIM_REQUEST_REUSED");
      return ok({ ...runView(existing), receipt_token: await sign(existing) });
    }
    if (T().runs.filter((r) => r.state === "SIMRUN_QUEUED").length >= 20) fail(429, "SIM_QUEUE_FULL");
    const r = { run_ref: `simr_${x.uuid()}`, actor: c.sub, action_id: `sima_${x.uuid()}`, request_ref: b.request_ref, skill_ref: b.skill_ref, scene_version: b.scene_version, state: "SIMRUN_QUEUED", queued_at: isoOf(c.now), completed_at: null, result: null, seed: x.rand(2)[0] * 256 + x.rand(1)[0] };
    T().runs.push(r);
    return ok({ ...runView(r), receipt_token: await sign(r) }, 201);
  });
}

/**
 * Nhắn tin 1:1 (src/server/messaging.ts) với một người nhận MÔ PHỎNG: «Thử nghiệm B» có một điểm nhận tin do bản trình diễn giữ.
 * «Máy chủ» chỉ giữ bản mã như máy chủ thật. Thiết bị mô phỏng của B nhận lời mời sau chừng 1,5 giây, xác nhận đã lưu và đã đọc
 * tin của bạn (nó không mở tin), rồi trả lời một câu soạn sẵn được niêm phong bằng đúng LNH-MSG-1 (web/shared/msg-crypto.js) cho
 * mọi thiết bị của cả hai người. Không ai thật đọc hay trả lời.
 */
function msgModule(x) {
  const { fail, ok, route, gate } = x;
  const GATE = { module: "messaging", scope: "messaging.use", purpose: "messaging" };
  const BOT = "dev_b";
  const REPLY = "Chào bạn, đây là trả lời tự động của Thử nghiệm B trong bản trình diễn (mô phỏng, không có người thật).";
  Object.assign(x.MESSAGES, {
    RECIPIENT_UNAVAILABLE: "Người nhận hiện không nhận được tin.", KEYS_CHANGED: "Danh sách thiết bị của hội thoại đã đổi.", DUPLICATE_MESSAGE: "Tin này đã được lưu.",
    ENDPOINT_LIMIT: "Đã đủ số thiết bị nhận tin.",
  });
  const T = () => (x.S().mod.msg ??= { endpoints: [], threads: [], messages: [], envelopes: [], marks: {}, reports: [], bot: null });
  const entitled = (sub) => x.moduleOn("messaging") && x.hasGrant(sub, GATE.scope) && (x.consentGranted(sub, GATE.purpose) || (sub === BOT && !!T().bot));
  const active = (sub) => T().endpoints.filter((e) => e.user === sub && e.status === "ACTIVE");
  const reachable = (sub) => entitled(sub) && active(sub).length > 0;
  const epView = (e) => ({ endpoint_id: e.id, kind: e.kind, key_id: e.key_id, status: e.status, created_at: e.created_at, revoked_at: e.revoked_at });
  const peerOf = (t, me) => (t.lo === me ? t.hi : t.lo);
  const isParty = (t, me) => t.lo === me || t.hi === me;
  const markOf = (t, u) => T().marks[`${t.id}|${u}`] ?? { delivered_seq: 0, read_seq: 0, read_shared_seq: 0 };
  const setMark = (t, u, m) => (T().marks[`${t.id}|${u}`] = m);
  const visibleState = (t, u) => (t.state === "THREAD_BLOCKED" && t.blocked_by !== u ? "THREAD_CLOSED" : t.state);
  async function keySet(t) {
    const endpoints = T().endpoints.filter((e) => (e.user === t.lo || e.user === t.hi) && e.status === "ACTIVE")
      .map((e) => ({ endpoint_id: e.id, public_key: e.public_key, user_id: e.user })).sort((a, b) => (a.endpoint_id < b.endpoint_id ? -1 : 1));
    return { endpoints, key_set: await keySetDigest(t.id, endpoints) };
  }
  async function deliverable(t, me) {
    const peer = peerOf(t, me);
    if (t.state !== "THREAD_ACTIVE" || !entitled(peer)) return null;
    const ks = await keySet(t);
    return ks.endpoints.some((e) => e.user_id === peer) ? ks : null;
  }
  async function threadView(t, u) {
    const peer = peerOf(t, u);
    const mine = markOf(t, u);
    const theirs = markOf(t, peer);
    return {
      thread_id: t.id, state: visibleState(t, u), peer: { user_id: peer, name: x.userOf(peer)?.name ?? peer }, role: t.requested_by === u ? "REQUESTER" : "ADDRESSEE",
      can_request: t.state === "THREAD_CLOSED" && (t.reopen_by === null || t.reopen_by === u) && reachable(peer), key_set: (await deliverable(t, u))?.key_set ?? null,
      last_seq: t.last_seq, delivered_seq: mine.delivered_seq, read_seq: mine.read_seq, peer_delivered_seq: theirs.delivered_seq, peer_read_seq: theirs.read_shared_seq, created_at: t.created_at,
    };
  }
  const own = (c, id) => {
    const t = T().threads.find((t2) => t2.id === id);
    if (!t || !isParty(t, c.sub)) fail(404, "NOT_FOUND");
    return t;
  };
  const ownEp = (c, id) => {
    const e = T().endpoints.find((e2) => e2.id === id && e2.user === c.sub && e2.status === "ACTIVE");
    if (!e) fail(404, "NOT_FOUND");
    return e;
  };
  /** Các cạnh THREAD_ của contracts/state_transitions.csv mà giao diện dùng. */
  const EDGES = {
    "THREAD_REQUESTED|accept|ADDRESSEE": "THREAD_ACTIVE", "THREAD_REQUESTED|decline|ADDRESSEE": "THREAD_CLOSED", "THREAD_REQUESTED|withdraw|REQUESTER": "THREAD_CLOSED",
    "THREAD_CLOSED|request|MEMBER": "THREAD_REQUESTED", "THREAD_REQUESTED|block|ADDRESSEE": "THREAD_BLOCKED", "THREAD_ACTIVE|block|MEMBER": "THREAD_BLOCKED",
    "THREAD_CLOSED|block|MEMBER": "THREAD_BLOCKED", "THREAD_BLOCKED|unblock|BLOCKER": "THREAD_CLOSED",
  };
  const step = (t, op, actors, t0, set = {}) => {
    const to = actors.map((a) => EDGES[`${t.state}|${op}|${a}`]).find(Boolean);
    if (!to) return null;
    Object.assign(t, set, { state: to, updated_at: isoOf(t0) });
    return t;
  };

  /** Thiết bị mô phỏng của B: khóa P-256 tạo một lần, giữ trong trạng thái của bản trình diễn để còn sau khi nạp lại trang. */
  async function ensureBot(t0) {
    if (T().bot) return T().bot;
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const pub = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    const id = `mep_${x.uuid()}`;
    T().endpoints.push({ id, user: BOT, kind: "PHONE", public_key: pub, key_id: base64url(await x.sha256(Uint8Array.from(atob(pub.replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) => ch.charCodeAt(0)))), status: "ACTIVE", created_at: isoOf(t0), revoked_at: null });
    T().bot = { endpoint_id: id, public_key: pub, d: jwk.d, replied: {} };
    return T().bot;
  }
  /** Một nhịp của thiết bị mô phỏng (chạy khi có yêu cầu nhắn tin): nhận lời mời, xác nhận đã lưu và đã đọc, trả lời một lần. */
  async function botTick(t0) {
    const bot = await ensureBot(t0);
    for (const t of T().threads) {
      if (!isParty(t, BOT)) continue;
      if (t.state === "THREAD_REQUESTED" && t.requested_by !== BOT && t0 - Date.parse(t.updated_at) >= 1500) step(t, "accept", ["ADDRESSEE"], t0);
      if (t.state !== "THREAD_ACTIVE") continue;
      const incoming = T().messages.filter((m) => m.thread === t.id && m.sender !== BOT);
      for (const m of incoming) {
        const env = T().envelopes.findIndex((e) => e.message === m.id && e.endpoint === bot.endpoint_id);
        if (env >= 0) {
          T().envelopes.splice(env, 1);
          m.delivered_at ??= isoOf(t0);
        }
      }
      const top = Math.max(0, ...incoming.filter((m) => m.delivered_at).map((m) => m.seq));
      if (top) setMark(t, BOT, { delivered_seq: top, read_seq: top, read_shared_seq: top });
      const last = incoming[incoming.length - 1];
      if (!last || bot.replied[last.id] || t0 - Date.parse(last.sent_at) < 2000 || Object.keys(bot.replied).length >= 50) continue;
      const ks = await deliverable(t, BOT);
      if (!ks) continue;
      bot.replied[last.id] = true;
      const raw = Uint8Array.from(atob(bot.d.replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) => ch.charCodeAt(0));
      const sender = { endpoint_id: bot.endpoint_id, ...(await importKeyPair(raw, bot.public_key)) };
      const body = await sealMessage({ text: REPLY, thread_id: t.id, client_ref: base64url(x.rand(18)), key_set: ks.key_set, sender, recipients: ks.endpoints.map((e) => ({ endpoint_id: e.endpoint_id, public_key: e.public_key })) });
      store(t, BOT, body, t0);
      // Thiết bị của B tự lưu bản của chính nó ngay.
      const own2 = T().envelopes.findIndex((e) => e.endpoint === bot.endpoint_id && e.message === T().messages[T().messages.length - 1].id);
      if (own2 >= 0) T().envelopes.splice(own2, 1);
    }
  }
  function store(t, sender, b, t0) {
    const id = `msg_${x.uuid()}`;
    t.last_seq += 1;
    T().messages.push({ id, thread: t.id, seq: t.last_seq, sender, sender_endpoint: b.sender_endpoint, client_ref: b.client_ref, iv: b.iv, ct: b.ct, sent_at: isoOf(t0), delivered_at: null });
    for (const e of b.envelopes) T().envelopes.push({ message: id, endpoint: e.endpoint_id, enc: e.enc, wrapped: e.wrapped });
    return { message_id: id, seq: t.last_seq, sent_at: isoOf(t0) };
  }
  const prep = async (c) => {
    gate(c.sub, GATE);
    await botTick(c.now);
  };

  route("GET", "/v1/messages/people", async (c) => {
    await prep(c);
    const blocked = new Set(T().threads.filter((t) => isParty(t, c.sub) && t.state === "THREAD_BLOCKED").map((t) => peerOf(t, c.sub)));
    return ok({ people: x.DEMO_USERS.filter((u) => u.sub !== c.sub && !blocked.has(u.sub) && reachable(u.sub)).map((u) => ({ user_id: u.sub, name: u.name })) });
  });
  route("GET", "/v1/messages/endpoints", async (c) => (await prep(c), ok({ endpoints: T().endpoints.filter((e) => e.user === c.sub).map(epView), limit: 5 })));
  route("POST", "/v1/messages/endpoints", async (c) => {
    await prep(c);
    if (c.now / 1000 - c.auth_time > 300) fail(401, "REAUTH_REQUIRED");
    const raw = Uint8Array.from(atob(c.body.public_key.replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) => ch.charCodeAt(0));
    if (raw.length !== 65 || raw[0] !== 4) fail(400, "SCHEMA_INVALID");
    const keyId = base64url(await x.sha256(raw));
    const existing = T().endpoints.find((e) => e.key_id === keyId);
    if (existing) {
      if (existing.user === c.sub && existing.status === "ACTIVE") return ok(epView(existing));
      fail(409, "INVALID_TRANSITION");
    }
    if (active(c.sub).length >= 5) fail(422, "ENDPOINT_LIMIT");
    const e = { id: `mep_${x.uuid()}`, user: c.sub, kind: c.body.kind, public_key: c.body.public_key, key_id: keyId, status: "ACTIVE", created_at: isoOf(c.now), revoked_at: null };
    T().endpoints.push(e);
    return ok(epView(e), 201);
  });
  route("POST", "/v1/messages/endpoints/{endpoint_id}/revoke", async (c) => {
    await prep(c);
    const e = T().endpoints.find((e2) => e2.id === c.params.endpoint_id && e2.user === c.sub);
    if (!e) fail(404, "NOT_FOUND");
    if (e.status === "ACTIVE") Object.assign(e, { status: "REVOKED", revoked_at: isoOf(c.now) });
    T().envelopes = T().envelopes.filter((v) => v.endpoint !== e.id);
    return ok(epView(e));
  });
  route("POST", "/v1/messages/threads", async (c) => {
    await prep(c);
    const peer = c.body.peer;
    if (peer === c.sub || !reachable(peer)) fail(404, "NOT_FOUND");
    const [lo, hi] = c.sub < peer ? [c.sub, peer] : [peer, c.sub];
    const t = T().threads.find((t2) => t2.lo === lo && t2.hi === hi);
    if (t?.state === "THREAD_BLOCKED") fail(404, "NOT_FOUND");
    if (t && (t.state !== "THREAD_CLOSED" || (t.reopen_by !== null && t.reopen_by !== c.sub))) fail(409, "INVALID_TRANSITION", { state: t.state, resource_id: t.id });
    if (t) {
      step(t, "request", ["MEMBER"], c.now, { requested_by: c.sub, reopen_by: null });
      return ok(await threadView(t, c.sub), 201);
    }
    const n = { id: `th_${x.uuid()}`, lo, hi, state: "THREAD_REQUESTED", requested_by: c.sub, blocked_by: null, reopen_by: null, last_seq: 0, created_at: isoOf(c.now), updated_at: isoOf(c.now) };
    T().threads.push(n);
    return ok(await threadView(n, c.sub), 201);
  });
  for (const op of ["accept", "decline", "withdraw", "block", "unblock"]) {
    route("POST", `/v1/messages/threads/{thread_id}/${op}`, async (c) => {
      await prep(c);
      const t = own(c, c.params.thread_id);
      const actors = [t.requested_by === c.sub ? "REQUESTER" : "ADDRESSEE", "MEMBER", ...(t.blocked_by === c.sub ? ["BLOCKER"] : [])];
      if (op === "accept" && t.state === "THREAD_REQUESTED" && t.requested_by !== c.sub && !entitled(peerOf(t, c.sub))) fail(409, "RECIPIENT_UNAVAILABLE");
      const set = op === "decline" ? { reopen_by: c.sub } : op === "withdraw" ? { reopen_by: null } : op === "block" ? { blocked_by: c.sub, reopen_by: null } : op === "unblock" ? { blocked_by: null, reopen_by: c.sub } : {};
      if (!step(t, op, actors, c.now, set)) fail(409, "INVALID_TRANSITION", { state: visibleState(t, c.sub) });
      return ok(await threadView(t, c.sub));
    });
  }
  route("GET", "/v1/messages/threads/{thread_id}/keys", async (c) => {
    await prep(c);
    const t = own(c, c.params.thread_id);
    const ks = await deliverable(t, c.sub);
    if (!ks) fail(409, "RECIPIENT_UNAVAILABLE");
    return ok({ thread_id: t.id, endpoints: ks.endpoints, key_set: ks.key_set });
  });
  route("POST", "/v1/messages/threads/{thread_id}/messages", async (c) => {
    await prep(c);
    const t = own(c, c.params.thread_id);
    const b = c.body;
    const ep = ownEp(c, b.sender_endpoint);
    const dup = T().messages.find((m) => m.sender_endpoint === ep.id && m.client_ref === b.client_ref);
    if (dup) fail(409, "DUPLICATE_MESSAGE", { resource_id: dup.id });
    const ks = await deliverable(t, c.sub);
    if (!ks) fail(409, "RECIPIENT_UNAVAILABLE");
    if (b.key_set !== ks.key_set) fail(409, "KEYS_CHANGED");
    const ids = b.envelopes.map((e) => e.endpoint_id);
    if (ids.length !== ks.endpoints.length || new Set(ids).size !== ids.length || ks.endpoints.some((e) => !ids.includes(e.endpoint_id))) fail(400, "SCHEMA_INVALID");
    return ok(store(t, c.sub, b, c.now), 201);
  });
  route("POST", "/v1/messages/threads/{thread_id}/read", async (c) => {
    await prep(c);
    const t = own(c, c.params.thread_id);
    if (c.body.through_seq > t.last_seq) fail(400, "SCHEMA_INVALID");
    const m = markOf(t, c.sub);
    setMark(t, c.sub, { delivered_seq: m.delivered_seq, read_seq: Math.max(m.read_seq, c.body.through_seq), read_shared_seq: c.body.share ? Math.max(m.read_shared_seq, Math.min(c.body.through_seq, m.delivered_seq)) : m.read_shared_seq });
    return ok(await threadView(t, c.sub));
  });
  route("GET", "/v1/messages/inbox", async (c) => {
    await prep(c);
    const endpoint = c.query.get("endpoint") ?? "";
    const etag = c.query.get("etag");
    if (!/^mep_[A-Za-z0-9_-]{6,64}$/.test(endpoint) || (etag !== null && !/^[A-Za-z0-9_-]{43}$/.test(etag))) fail(400, "SCHEMA_INVALID");
    const ep = ownEp(c, endpoint);
    const threads = await Promise.all(T().threads.filter((t) => isParty(t, c.sub)).map((t) => threadView(t, c.sub)));
    const endpoints = T().endpoints.filter((e) => e.user === c.sub).map(epView);
    const rows = T().envelopes.filter((e) => e.endpoint === ep.id).map((e) => ({ e, m: T().messages.find((m) => m.id === e.message) })).filter((r) => r.m);
    const more = rows.length > 50;
    const messages = rows.slice(0, 50).map(({ e, m }) => ({ message_id: m.id, thread_id: m.thread, seq: m.seq, sender_user: m.sender, sender_endpoint: m.sender_endpoint, client_ref: m.client_ref, iv: m.iv, ct: m.ct, enc: e.enc, wrapped: e.wrapped, sent_at: m.sent_at }));
    const tag = await x.digestJcs({ endpoints, messages: messages.map((m) => m.message_id), more, threads });
    if (etag === tag) return ok({ etag: tag, changed: false });
    return ok({ etag: tag, changed: true, threads, endpoints, messages, more });
  });
  route("POST", "/v1/messages/ack", async (c) => {
    await prep(c);
    const ep = ownEp(c, c.body.endpoint_id);
    let acked = 0;
    for (const id of new Set(c.body.message_ids)) {
      const i = T().envelopes.findIndex((e) => e.message === id && e.endpoint === ep.id);
      if (i < 0) continue;
      T().envelopes.splice(i, 1);
      acked++;
      const m = T().messages.find((m2) => m2.id === id);
      if (m && m.sender !== c.sub && !m.delivered_at) {
        m.delivered_at = isoOf(c.now);
        const t = T().threads.find((t2) => t2.id === m.thread);
        const top = Math.max(0, ...T().messages.filter((m2) => m2.thread === t.id && m2.sender !== c.sub && m2.delivered_at).map((m2) => m2.seq));
        const mk = markOf(t, c.sub);
        if (top > mk.delivered_seq) setMark(t, c.sub, { ...mk, delivered_seq: top });
      }
    }
    // Bản mã không còn phong bì nào chờ giao thì bỏ khỏi «máy chủ».
    for (const m of T().messages) if (!T().envelopes.some((e) => e.message === m.id)) m.iv = m.ct = "";
    return ok({ acked });
  });
  route("POST", "/v1/messages/reports", async (c) => {
    await prep(c);
    const t = own(c, c.body.thread_id);
    const id = `rp_${x.uuid()}`;
    T().reports.push({ id, reporter: c.sub, reported: peerOf(t, c.sub), thread: t.id, reason: c.body.reason, at: isoOf(c.now) });
    return ok({ report_id: id }, 201);
  });
  x.exporters.messaging = (sub) => ({
    scope: "Thiết bị nhận tin và hội thoại của chính người này (bản trình diễn). Không có nội dung tin: «máy chủ» chỉ giữ bản mã.",
    endpoints: T().endpoints.filter((e) => e.user === sub).map(epView),
    threads: T().threads.filter((t) => isParty(t, sub)).map((t) => ({ thread_id: t.id, state: visibleState(t, sub), peer: peerOf(t, sub), created_at: t.created_at })),
  });
}

/** Mô-đun của bản trình diễn: mỗi hàm nhận API nội bộ (route, gate, S…) và khai route của mình. */
export const DEFAULT_MODULES = [msgModule, syncModule, inboxModule, homeModule, measModule, simModule];

// ══ Cài vào trình duyệt ═════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Bộ lưu của trình duyệt cho trạng thái «máy chủ»: mọi lần đọc và ghi bọc try/catch (trang vẫn chạy khi bộ nhớ bị chặn). */
export function browserStore(key = STORE_KEY) {
  return {
    load() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(state));
      } catch {
        /* bộ nhớ bị chặn hoặc đầy: trạng thái chỉ còn trong trang */
      }
    },
  };
}

const DEMO_PATH = /^\/(dev|v1|v2)\//;

/**
 * Bọc window.fetch: yêu cầu cùng gốc tới /dev/, /v1/, /v2/ được bản giả trả lời ngay trong trang; mọi yêu cầu khác đi như cũ.
 * Trả backend đã cài. Gọi trước khi app.js nạp.
 */
export function installDemo(win = globalThis) {
  const store = browserStore();
  const backend = createBackend({ load: store.load, save: store.save });
  const realFetch = win.fetch.bind(win);
  win.fetch = async (input, init = {}) => {
    const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const url = new URL(req ? req.url : String(input), win.location.href);
    if (url.origin !== win.location.origin || !DEMO_PATH.test(url.pathname)) return realFetch(input, init);
    const headers = {};
    new Headers(init.headers ?? req?.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const method = (init.method ?? req?.method ?? "GET").toUpperCase();
    let body = init.body;
    if (body === undefined && req && method !== "GET") body = await req.text();
    if (body !== undefined && body !== null && typeof body !== "string") body = await new Response(body).text();
    const out = await backend.handle({ method, path: url.pathname, search: url.search, headers, body: body ?? undefined });
    // Một chút trễ như mạng thật, để giao diện đi qua đúng các trạng thái đang tải.
    await new Promise((r) => setTimeout(r, 25));
    return new Response(JSON.stringify(out.body), { status: out.status, headers: out.headers });
  };
  return backend;
}
