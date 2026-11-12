// Le‑NodeHome và dịch vụ HaaS (V1.0.1, SRS V2.0 mục 06–07, N20‑HOME, N20‑HAAS, LNH-T66). Mã tham chiếu: hub, camera và vận hành
// LeLS đều là dữ liệu tổng hợp; danh tính hub là danh tính MÔ PHỎNG chỉ có ở chế độ dev.
//
// - Đăng ký HaaS đi theo các cạnh HAAS_* của contracts/state_transitions.csv: REQUESTED → SURVEYED → ACCEPTED → INSTALLED → ACTIVE,
//   cùng SUSPENDED, TERMINATED, RETURNED. Mỗi cạnh có người làm: chủ hộ (OWNER), vận hành LeLS (LELS), hệ thống (SYSTEM).
//   Vận hành LeLS dùng vai SITE_OPERATOR sẵn có (lõi chưa có vai riêng của LeLS) và không làm bước nào trên đăng ký của chính mình.
// - Quyền truy cập tính từ trạng thái ở máy chủ, không theo điều thiết bị hiển thị: hub chỉ gửi được sự kiện khi đăng ký INSTALLED
//   hoặc ACTIVE; chủ hộ chỉ đọc sự kiện khi INSTALLED, ACTIVE, SUSPENDED; mọi bước đổi trạng thái kiểm `revision` (409 khi cũ).
// - Cổng của chủ hộ: thành viên (404) → cờ `home_hub` (503) → quyền `home.hub` (403) → đồng ý `home_hub` (403).
// - Sự kiện hub (POST /v2/home/hubs/{hub_id}/events) chỉ nhận danh tính hub: bearer có sub `hub:<hub_id>` do đường dev phát, CỘNG
//   chữ ký HMAC-SHA256 trên mã băm JCS của phong bì bằng khóa riêng của hub giữ ở máy chủ. Token người dùng bị từ chối. Danh tính hub
//   thật (chứng thư thiết bị, mTLS, kết nối ra ngoài có xác thực) CHƯA CÓ (LNH-D23): ngoài chế độ dev route này trả 503.
// - Phong bì tối thiểu: không ảnh, video, âm thanh, khuôn mặt, danh tính người; clip_ref là định danh mờ, không phải URL. Chống trùng
//   theo (hub, camera, epoch, event_id) (X05); sự kiện trễ giữ observed_at và gắn cờ đến trễ; đổi hub thu hồi danh tính cũ, tăng
//   binding_version và từ chối binding cũ (X07).
// - LeLS thấy trạng thái vận hành (serial, firmware, lần liên lạc cuối, camera trực tuyến) nhưng không thấy sự kiện, trừ khi chủ hộ
//   cấp quyền xem tạm thời có hạn (mỗi lần dùng được đếm và ghi nhật ký). Xem clip từ xa CHƯA CÀI: chỉ mở sau nghiệm thu (X06 một phần).
// - LeLe không có đường nào tới đây: tệp này không nạp lele.ts.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DAY, MINUTE } from "../core/clock.ts";
import { digestJcs, uuid } from "../core/crypto.ts";
import { ApiError } from "../core/errors.ts";
import type { Call, Route } from "./api.ts";
import { activeGrant, consentGranted, isActiveMember, member, requireMember, requireModuleGate, requireRole, roles } from "./authority.ts";
import type { Ctx } from "./context.ts";
import type { Stored } from "./idempotency.ts";
import { indexTransitions, transitionsFor } from "./machine.ts";
import type { DevRoute, ServerModule } from "./modules.ts";
import { journalRevocation } from "./recovery.ts";
import { DEMO_WS, DEV_USERS } from "./seed.ts";
import { all, audit, one, run, tx } from "./store.ts";

const GATE = { module: "home_hub", scope: "home.hub", purpose: "home_hub" } as const;
/** Vai của vận hành LeLS: dùng vai SITE_OPERATOR sẵn có của lõi (chưa có vai riêng của LeLS). */
export const LELS_ROLE = "SITE_OPERATOR";

/** Hằng số của mô-đun. Thời hạn lưu sự kiện là đề xuất cho tới quyết định G0 (LNH-Q20). */
export const HOME_LIMITS = {
  termsVersion: "haas-terms-v1-2026-11",
  packages: ["HOME_PILOT"],
  eventRetentionMs: 30 * DAY,
  lateAfterMs: 2 * MINUTE,
  futureSkewMs: 2 * MINUTE,
  eventsPage: 100,
  viewGrantMinutes: [15, 240] as const,
  hubTokenTtlS: 900,
  maxCameras: 4,
} as const;

export type HaasState = "HAAS_REQUESTED" | "HAAS_SURVEYED" | "HAAS_ACCEPTED" | "HAAS_INSTALLED" | "HAAS_ACTIVE" | "HAAS_SUSPENDED" | "HAAS_TERMINATED" | "HAAS_RETURNED";
export type HaasActor = "OWNER" | "LELS" | "SYSTEM";
const find = indexTransitions(transitionsFor("HAAS_") as { from: HaasState; event: string; actor: HaasActor; to: HaasState; guard: string; ref: string }[]);

const ENDED: readonly HaasState[] = ["HAAS_TERMINATED", "HAAS_RETURNED"];
const HAS_HUB: readonly HaasState[] = ["HAAS_INSTALLED", "HAAS_ACTIVE", "HAAS_SUSPENDED"];
const ACCEPTING: readonly HaasState[] = ["HAAS_INSTALLED", "HAAS_ACTIVE"];

interface SubRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  site_ref: string;
  package_code: string;
  contact_grant: string;
  terms_version: string;
  state: HaasState;
  camera_count: number | null;
  quote_vnd: number | null;
  quote_accepted_at: string | null;
  binding_version: number;
  hub_id: string | null;
  reason_code: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface HubRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  serial: string;
  firmware: string;
  cameras: string;
  hmac_key: string;
  binding_version: number;
  status: "ACTIVE" | "REVOKED";
  last_seen_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

interface EventRow {
  id: string;
  subscription_id: string;
  hub_id: string;
  camera_ref: string;
  epoch: number;
  event_id: string;
  type: string;
  observed_at: string;
  received_at: string;
  late: number;
  binding_version: number;
  clip_ref: string | null;
}

interface GrantRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  granted_by: string;
  ticket_ref: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  uses: number;
  last_used_at: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const notFound = () => new ApiError(404, "NOT_FOUND");
const hubRefused = () => new ApiError(401, "HOME_HUB_IDENTITY_INVALID");

// ── Cổng ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ownerGate = (c: Call) => requireModuleGate(c.d.ctx, c.ws, c.p.sub, GATE);
const entitled = (ctx: Ctx, ws: string, user: string) =>
  isActiveMember(ctx, ws, user) && !!activeGrant(ctx, ws, user, GATE.scope, null) && consentGranted(ctx, ws, user, GATE.purpose);
const usable = (c: Call) => c.d.ctx.control.moduleOn(GATE.module) && entitled(c.d.ctx, c.ws, c.p.sub);

/** Vận hành LeLS: thành viên (404) → cờ (503) → vai SITE_OPERATOR (403). Không cần quyền home.hub hay đồng ý của chủ hộ. */
function opsGate(c: Call) {
  const m = requireMember(c.d.ctx, c.ws, c.p.sub);
  if (!c.d.ctx.control.moduleOn(GATE.module)) throw new ApiError(503, "MODULE_DISABLED");
  requireRole(m, LELS_ROLE);
  return m;
}
const isOps = (c: Call) => {
  const m = member(c.d.ctx, c.ws, c.p.sub);
  return !!m && m.status === "ACTIVE" && roles(m).includes(LELS_ROLE) && c.d.ctx.control.moduleOn(GATE.module);
};

// ── Đăng ký và máy trạng thái HAAS_ ───────────────────────────────────────────────────────────────────────────────────────────

const subscription = (ctx: Ctx, id: string) => one<SubRow>(ctx.db, "SELECT * FROM home_subscriptions WHERE id = ?", id);
const hubRow = (ctx: Ctx, id: string | null) => (id ? one<HubRow>(ctx.db, "SELECT * FROM home_hubs WHERE id = ?", id) : undefined);

/** Đăng ký của chính người gọi; của người khác hoặc workspace khác đều là 404. */
function ownSub(c: Call): SubRow {
  const s = subscription(c.d.ctx, c.params.subscription_id);
  if (!s || s.workspace_id !== c.ws || s.owner_id !== c.p.sub) throw notFound();
  return s;
}

/** Đăng ký trong workspace của vận hành viên; vận hành viên không làm bước nào trên đăng ký của chính mình. */
function opsSub(c: Call): SubRow {
  const s = subscription(c.d.ctx, c.params.subscription_id);
  if (!s || s.workspace_id !== c.ws) throw notFound();
  if (s.owner_id === c.p.sub) throw new ApiError(403, "FORBIDDEN");
  return s;
}

function checkRevision(s: SubRow, revision: number) {
  if (revision !== s.revision) throw new ApiError(409, "HOME_REVISION_CONFLICT", { extra: { revision: s.revision, state: s.state } });
}

/** Đi một cạnh của bảng HAAS_; không có cạnh thì 409 INVALID_TRANSITION. Ghi bước vào lịch sử và nhật ký. */
function step(ctx: Ctx, s: SubRow, event: string, actor: HaasActor, by: string, at: string, set: Record<string, string | number | null> = {}): SubRow {
  const t = find(s.state, event, actor);
  if (!t) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: s.state } });
  const cols = Object.keys(set);
  run(ctx.db, `UPDATE home_subscriptions SET state = ?, revision = revision + 1, updated_at = ?${cols.map((k) => `, ${k} = ?`).join("")} WHERE id = ?`, t.to, at, ...cols.map((k) => set[k]), s.id);
  const seq = (one<{ n: number }>(ctx.db, "SELECT COALESCE(MAX(seq), 0) AS n FROM home_steps WHERE subscription_id = ?", s.id) as { n: number }).n + 1;
  run(ctx.db, "INSERT INTO home_steps (subscription_id, seq, from_state, event, actor_kind, to_state, at) VALUES (?, ?, ?, ?, ?, ?, ?)", s.id, seq, s.state, event, actor, t.to, at);
  audit(ctx.db, at, { workspace_id: s.workspace_id, actor: by, action: `home.${event}`, target: s.id, data: { from: s.state, to: t.to, actor_kind: actor } });
  return subscription(ctx, s.id) as SubRow;
}

/** Thu hồi một danh tính hub. Trả true nếu có đổi. `journal` false khi đang nạp lại sổ thu hồi (không được ghi thêm). */
function revokeHub(ctx: Ctx, hubId: string, at: string, journal: boolean): boolean {
  const h = hubRow(ctx, hubId);
  const r = run(ctx.db, "UPDATE home_hubs SET status = 'REVOKED', revoked_at = ? WHERE id = ? AND status = 'ACTIVE'", at, hubId);
  if (Number(r.changes) > 0 && journal && h) journalRevocation(ctx, "home_hub_revoked", at, { workspace_id: h.workspace_id, hub_id: hubId });
  return Number(r.changes) > 0;
}

/**
 * Phần chung của mọi đường kết thúc: thu hồi hub và quyền xem, xóa sự kiện ở máy chủ (camera và đầu ghi tiếp tục theo cấu hình
 * bàn giao của chủ hộ). Chưa từng lắp hub thì hệ thống đóng luôn (TERMINATED → RETURNED): không có thiết bị nào phải thu hồi.
 */
function endService(ctx: Ctx, s: SubRow, at: string, journal: boolean): SubRow {
  for (const h of all<{ id: string }>(ctx.db, "SELECT id FROM home_hubs WHERE subscription_id = ? AND status = 'ACTIVE'", s.id)) revokeHub(ctx, h.id, at, journal);
  run(ctx.db, "UPDATE home_view_grants SET revoked_at = ? WHERE subscription_id = ? AND revoked_at IS NULL", at, s.id);
  run(ctx.db, "DELETE FROM home_events WHERE subscription_id = ?", s.id);
  if (journal) journalRevocation(ctx, "home_subscription_ended", at, { workspace_id: s.workspace_id, subscription_id: s.id });
  const now = subscription(ctx, s.id) as SubRow;
  return now.binding_version === 0 ? step(ctx, now, "close", "SYSTEM", "system", at) : now;
}

/** Hệ thống chấm dứt đăng ký khi chủ hộ mất tư cách, quyền home.hub hoặc đồng ý home_hub. Lặp lại an toàn. */
function systemRevoke(ctx: Ctx, s: SubRow, at: string, journal: boolean): boolean {
  if (ENDED.includes(s.state)) return false;
  const next = step(ctx, s, "revoke", "SYSTEM", "system", at, { reason_code: "AUTHORITY" });
  endService(ctx, next, at, journal);
  return true;
}

const liveSubsOf = (ctx: Ctx, ws: string, user: string) =>
  all<SubRow>(ctx.db, "SELECT * FROM home_subscriptions WHERE workspace_id = ? AND owner_id = ? AND state NOT IN ('HAAS_TERMINATED','HAAS_RETURNED')", ws, user);

const enforce = (ctx: Ctx, ws: string, user: string, at: string, journal = false) => {
  if (entitled(ctx, ws, user)) return false;
  let changed = false;
  for (const s of liveSubsOf(ctx, ws, user)) changed = systemRevoke(ctx, s, at, journal) || changed;
  return changed;
};

// ── Hình thức trả về ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const camerasOf = (ctx: Ctx, hubId: string) =>
  all<{ camera_ref: string; online: number; observed_at: string | null }>(ctx.db, "SELECT camera_ref, online, observed_at FROM home_cameras WHERE hub_id = ? ORDER BY camera_ref", hubId)
    .map((x) => ({ camera_ref: x.camera_ref, online: x.online === 1, observed_at: x.observed_at }));

const hubView = (ctx: Ctx, h: HubRow | undefined) =>
  h ? { hub_id: h.id, serial: h.serial, firmware: h.firmware, binding_version: h.binding_version, status: h.status, last_seen_at: h.last_seen_at, cameras: camerasOf(ctx, h.id) } : null;

const grantView = (g: GrantRow, now: number) => ({
  grant_id: g.id, ticket_ref: g.ticket_ref, created_at: g.created_at, expires_at: g.expires_at, revoked_at: g.revoked_at, uses: g.uses, last_used_at: g.last_used_at,
  active: !g.revoked_at && Date.parse(g.expires_at) > now,
});

const grantsFor = (ctx: Ctx, subId: string) => all<GrantRow>(ctx.db, "SELECT * FROM home_view_grants WHERE subscription_id = ? ORDER BY created_at DESC, id", subId);
const activeGrantFor = (ctx: Ctx, subId: string, now: number) => grantsFor(ctx, subId).find((g) => !g.revoked_at && Date.parse(g.expires_at) > now);

function access(s: SubRow) {
  return { events_visible: HAS_HUB.includes(s.state), hub_accepting: ACCEPTING.includes(s.state), clip_view: "UNAVAILABLE" as const };
}

function subView(ctx: Ctx, s: SubRow) {
  const now = ctx.clock.now();
  return {
    subscription_ref: s.id, state: s.state, site_ref: s.site_ref, package_code: s.package_code, contact_grant: s.contact_grant, terms_version: s.terms_version,
    camera_count: s.camera_count, quote_vnd: s.quote_vnd, quote_accepted_at: s.quote_accepted_at, binding_version: s.binding_version, reason_code: s.reason_code,
    revision: s.revision, created_at: s.created_at, updated_at: s.updated_at,
    steps: all<{ seq: number; from_state: string | null; event: string; actor_kind: string; to_state: string; at: string }>(ctx.db,
      "SELECT seq, from_state, event, actor_kind, to_state, at FROM home_steps WHERE subscription_id = ? ORDER BY seq", s.id),
    hub: hubView(ctx, hubRow(ctx, s.hub_id)),
    access: access(s),
    view_grants: grantsFor(ctx, s.id).map((g) => grantView(g, now)),
  };
}

/** Phần LeLS thấy: trạng thái dịch vụ và vận hành, không sự kiện, không clip. */
function opsView(ctx: Ctx, s: SubRow) {
  const now = ctx.clock.now();
  const h = hubRow(ctx, s.hub_id);
  const g = activeGrantFor(ctx, s.id, now);
  return {
    subscription_ref: s.id, owner_id: s.owner_id, state: s.state, site_ref: s.site_ref, package_code: s.package_code, contact_grant: s.contact_grant,
    camera_count: s.camera_count, quote_vnd: s.quote_vnd, quote_accepted: !!s.quote_accepted_at, binding_version: s.binding_version, reason_code: s.reason_code,
    revision: s.revision, updated_at: s.updated_at,
    hub: h ? { hub_id: h.id, serial: h.serial, firmware: h.firmware, status: h.status, last_seen_at: h.last_seen_at, cameras_online: camerasOf(ctx, h.id).filter((x) => x.online).length, cameras: JSON.parse(h.cameras).length } : null,
    view_grant: g ? { grant_id: g.id, ticket_ref: g.ticket_ref, expires_at: g.expires_at } : null,
  };
}

const eventView = (e: EventRow) => ({
  event_ref: e.id, type: e.type, camera_ref: e.camera_ref, observed_at: e.observed_at, received_at: e.received_at, late: e.late === 1,
  binding_version: e.binding_version, clip_ref: e.clip_ref, verified: false,
});

// ── Chủ hộ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function listOwn(c: Call): Stored {
  ownerGate(c);
  const rows = all<SubRow>(c.d.ctx.db, "SELECT * FROM home_subscriptions WHERE workspace_id = ? AND owner_id = ? ORDER BY created_at DESC, id", c.ws, c.p.sub);
  return { status: 200, body: { subscriptions: rows.map((s) => subView(c.d.ctx, s)), terms_version: HOME_LIMITS.termsVersion, packages: [...HOME_LIMITS.packages] } };
}

function createSub(c: Call): Stored {
  const { ctx } = c.d;
  ownerGate(c);
  const b = c.body as { site_ref: string; package_code: string; contact_grant: string; terms_version: string };
  if (b.terms_version !== HOME_LIMITS.termsVersion) throw new ApiError(422, "HOME_TERMS_OUTDATED", { extra: { terms_version: HOME_LIMITS.termsVersion } });
  if (liveSubsOf(ctx, c.ws, c.p.sub).length) throw new ApiError(409, "HOME_OPEN_LIMIT");
  const id = `hsub_${uuid()}`;
  const at = iso(ctx.clock.now());
  run(ctx.db, "INSERT INTO home_subscriptions (id, workspace_id, owner_id, site_ref, package_code, contact_grant, terms_version, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'HAAS_REQUESTED', ?, ?)",
    id, c.ws, c.p.sub, b.site_ref, b.package_code, b.contact_grant, b.terms_version, at, at);
  run(ctx.db, "INSERT INTO home_steps (subscription_id, seq, from_state, event, actor_kind, to_state, at) VALUES (?, 1, NULL, 'request', 'OWNER', 'HAAS_REQUESTED', ?)", id, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "home.request", target: id, request_id: c.requestId, data: { package_code: b.package_code } });
  return { status: 201, body: subView(ctx, subscription(ctx, id) as SubRow), resource: { type: "home_subscription", id } };
}

const OWNER_OPS = {
  "accept-quote": "accept_quote",
  "confirm-install": "confirm_install",
  cancel: "cancel",
  terminate: "terminate",
} as const;

function ownerOp(c: Call, op: keyof typeof OWNER_OPS): Stored {
  const { ctx } = c.d;
  ownerGate(c);
  const s = ownSub(c);
  const b = c.body as { revision: number; serial?: string };
  checkRevision(s, b.revision);
  const now = ctx.clock.now();
  const at = iso(now);
  let next: SubRow;
  if (op === "confirm-install") {
    // Chủ hộ xác nhận đúng hub đang ở nhà mình: serial trên thiết bị phải khớp serial LeLS đã liên kết với hộ.
    const h = hubRow(ctx, s.hub_id);
    if (!find(s.state, "confirm_install", "OWNER")) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: s.state } });
    if (!h || h.status !== "ACTIVE" || b.serial !== h.serial) throw new ApiError(422, "HOME_SERIAL_MISMATCH");
    next = step(ctx, s, "confirm_install", "OWNER", c.p.sub, at);
  } else if (op === "terminate") {
    // Chấm dứt xóa sự kiện ở máy chủ: cần đăng nhập mới như EXPORT và DELETE (LNH-T15). Bản xuất lấy trước ở .../export.
    if (c.p.auth_time === null || now / 1000 - c.p.auth_time > ctx.config.reauthMaxAgeS) throw new ApiError(401, "REAUTH_REQUIRED");
    next = endService(ctx, step(ctx, s, "terminate", "OWNER", c.p.sub, at, { reason_code: "CUSTOMER_REQUEST" }), at, true);
  } else if (op === "cancel") {
    next = endService(ctx, step(ctx, s, "cancel", "OWNER", c.p.sub, at, { reason_code: "CUSTOMER_REQUEST" }), at, true);
  } else {
    next = step(ctx, s, "accept_quote", "OWNER", c.p.sub, at, { quote_accepted_at: at });
  }
  return { status: 200, body: subView(ctx, next), resource: { type: "home_subscription", id: s.id } };
}

function ownEvents(c: Call): Stored {
  const { ctx } = c.d;
  ownerGate(c);
  const s = ownSub(c);
  const rows = access(s).events_visible
    ? all<EventRow>(ctx.db, "SELECT * FROM home_events WHERE subscription_id = ? ORDER BY observed_at DESC, id LIMIT ?", s.id, HOME_LIMITS.eventsPage)
    : [];
  return { status: 200, body: { subscription_ref: s.id, state: s.state, events: rows.map(eventView), retention_days: HOME_LIMITS.eventRetentionMs / DAY, clip_view: "UNAVAILABLE" } };
}

function exportSub(ctx: Ctx, s: SubRow) {
  return {
    ...subView(ctx, s),
    events: all<EventRow>(ctx.db, "SELECT * FROM home_events WHERE subscription_id = ? ORDER BY observed_at, id", s.id).map(eventView),
  };
}

function ownExport(c: Call): Stored {
  ownerGate(c);
  const s = ownSub(c);
  audit(c.d.ctx.db, iso(c.d.ctx.clock.now()), { workspace_id: c.ws, actor: c.p.sub, action: "home.export", target: s.id, request_id: c.requestId });
  return { status: 200, body: { scope: "Dữ liệu Le‑NodeHome phía máy chủ của đăng ký này: các bước, hub, quyền xem và sự kiện tối thiểu. Không có hình, video hay âm thanh: chúng nằm tại nhà.", subscription: exportSub(c.d.ctx, s) } };
}

function createViewGrant(c: Call): Stored {
  const { ctx } = c.d;
  ownerGate(c);
  const s = ownSub(c);
  if (!HAS_HUB.includes(s.state)) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: s.state } });
  const now = ctx.clock.now();
  if (activeGrantFor(ctx, s.id, now)) throw new ApiError(409, "HOME_VIEW_GRANT_ACTIVE");
  const b = c.body as { ticket_ref: string; minutes: number };
  const id = `hvg_${uuid()}`;
  const at = iso(now);
  run(ctx.db, "INSERT INTO home_view_grants (id, workspace_id, subscription_id, granted_by, ticket_ref, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, c.ws, s.id, c.p.sub, b.ticket_ref, at, iso(now + b.minutes * MINUTE));
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "home.view_grant.create", target: id, request_id: c.requestId, data: { minutes: b.minutes } });
  return { status: 201, body: grantView(one<GrantRow>(ctx.db, "SELECT * FROM home_view_grants WHERE id = ?", id) as GrantRow, now), resource: { type: "home_view_grant", id } };
}

function revokeViewGrant(c: Call): Stored {
  const { ctx } = c.d;
  ownerGate(c);
  const g = one<GrantRow>(ctx.db, "SELECT * FROM home_view_grants WHERE id = ?", c.params.grant_id);
  const s = g ? subscription(ctx, g.subscription_id) : undefined;
  if (!g || !s || s.workspace_id !== c.ws || s.owner_id !== c.p.sub) throw notFound();
  const at = iso(ctx.clock.now());
  if (!g.revoked_at) {
    run(ctx.db, "UPDATE home_view_grants SET revoked_at = ? WHERE id = ?", at, g.id);
    journalRevocation(ctx, "home_view_grant_revoked", at, { workspace_id: c.ws, grant_id: g.id });
    audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "home.view_grant.revoke", target: g.id, request_id: c.requestId });
  }
  return { status: 200, body: grantView(one<GrantRow>(ctx.db, "SELECT * FROM home_view_grants WHERE id = ?", g.id) as GrantRow, ctx.clock.now()), resource: { type: "home_view_grant", id: g.id } };
}

// ── Vận hành LeLS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

function opsList(c: Call): Stored {
  opsGate(c);
  const rows = all<SubRow>(c.d.ctx.db, "SELECT * FROM home_subscriptions WHERE workspace_id = ? ORDER BY updated_at DESC, id", c.ws);
  return { status: 200, body: { subscriptions: rows.map((s) => opsView(c.d.ctx, s)) } };
}

/** Lắp hoặc đổi hub: danh tính hub mới, khóa HMAC mới giữ ở máy chủ, binding_version tăng. */
function newHub(ctx: Ctx, s: SubRow, b: { serial: string; firmware: string; camera_refs: string[] }, at: string) {
  if (new Set(b.camera_refs).size !== b.camera_refs.length || b.camera_refs.length > (s.camera_count ?? HOME_LIMITS.maxCameras)) throw new ApiError(422, "HOME_CAMERA_LIST");
  if (one(ctx.db, "SELECT 1 FROM home_hubs WHERE serial = ? AND status = 'ACTIVE'", b.serial)) throw new ApiError(409, "HOME_SERIAL_IN_USE");
  const id = `hub_${randomBytes(12).toString("base64url")}`;
  const binding = s.binding_version + 1;
  run(ctx.db, "INSERT INTO home_hubs (id, workspace_id, subscription_id, serial, firmware, cameras, hmac_key, binding_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)",
    id, s.workspace_id, s.id, b.serial, b.firmware, JSON.stringify(b.camera_refs), randomBytes(32).toString("base64url"), binding, at);
  for (const cam of b.camera_refs) run(ctx.db, "INSERT INTO home_cameras (hub_id, camera_ref, online, observed_at) VALUES (?, ?, 0, NULL)", id, cam);
  return { hub_id: id, binding_version: binding };
}

const OPS_OPS = ["survey", "reject", "install", "replace-hub", "suspend", "resume", "terminate", "return"] as const;
type OpsOp = (typeof OPS_OPS)[number];
const OPS_SCHEMA: Record<OpsOp, string> = {
  survey: "HomeSurvey", reject: "HomeOpsStep", install: "HomeInstall", "replace-hub": "HomeInstall", suspend: "HomeOpsStep", resume: "HomeOpsStep", terminate: "HomeOpsStep", return: "HomeReturn",
};

function opsOp(c: Call, op: OpsOp): Stored {
  const { ctx } = c.d;
  opsGate(c);
  const s = opsSub(c);
  const b = c.body as { revision: number; camera_count?: number; quote_vnd?: number; serial?: string; firmware?: string; camera_refs?: string[]; reason_code?: string };
  checkRevision(s, b.revision);
  const at = iso(ctx.clock.now());
  const me = c.p.sub;
  let next: SubRow;
  switch (op) {
    case "survey":
      next = step(ctx, s, "survey", "LELS", me, at, { camera_count: b.camera_count as number, quote_vnd: b.quote_vnd as number });
      break;
    case "install": {
      if (!find(s.state, "install", "LELS")) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: s.state } });
      const hub = newHub(ctx, s, b as { serial: string; firmware: string; camera_refs: string[] }, at);
      next = step(ctx, s, "install", "LELS", me, at, { hub_id: hub.hub_id, binding_version: hub.binding_version });
      break;
    }
    case "replace-hub": {
      // X07: thu hồi danh tính hub cũ trước, rồi mới liên kết hub mới với binding_version mới; chủ hộ xác nhận lại trong app.
      if (!find(s.state, "replace_hub", "LELS")) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: s.state } });
      if (s.hub_id) revokeHub(ctx, s.hub_id, at, true);
      const hub = newHub(ctx, s, b as { serial: string; firmware: string; camera_refs: string[] }, at);
      next = step(ctx, s, "replace_hub", "LELS", me, at, { hub_id: hub.hub_id, binding_version: hub.binding_version });
      break;
    }
    case "return":
      // Hub đã thu về và đã xóa dữ liệu tại hub (hub_wiped = true trong thân): biên bản thu hồi hoàn tất.
      next = step(ctx, s, "return_hub", "LELS", me, at);
      break;
    case "reject":
    case "terminate":
      next = endService(ctx, step(ctx, s, op, "LELS", me, at, { reason_code: b.reason_code as string }), at, true);
      break;
    default:
      next = step(ctx, s, op, "LELS", me, at, { reason_code: b.reason_code as string });
  }
  return { status: 200, body: opsView(ctx, next), resource: { type: "home_subscription", id: s.id } };
}

/** Sự kiện cho LeLS chỉ khi chủ hộ đang cấp quyền xem tạm thời; mỗi lần dùng được đếm và ghi nhật ký. Không clip_ref. */
function opsEvents(c: Call): Stored {
  const { ctx } = c.d;
  opsGate(c);
  const s = opsSub(c);
  const now = ctx.clock.now();
  const g = activeGrantFor(ctx, s.id, now);
  if (!g || !access(s).events_visible) throw new ApiError(403, "HOME_VIEW_GRANT_REQUIRED");
  const at = iso(now);
  run(ctx.db, "UPDATE home_view_grants SET uses = uses + 1, last_used_at = ? WHERE id = ?", at, g.id);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "home.view_grant.use", target: g.id, request_id: c.requestId });
  const rows = all<EventRow>(ctx.db, "SELECT * FROM home_events WHERE subscription_id = ? ORDER BY observed_at DESC, id LIMIT ?", s.id, HOME_LIMITS.eventsPage);
  return {
    status: 200,
    body: { subscription_ref: s.id, grant: { grant_id: g.id, expires_at: g.expires_at }, events: rows.map((e) => ({ event_ref: e.id, type: e.type, camera_ref: e.camera_ref, observed_at: e.observed_at, late: e.late === 1 })), clip_view: "UNAVAILABLE" },
  };
}

// ── Hub (danh tính mô phỏng) ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Chữ ký của hub: HMAC-SHA256 trên mã băm JCS của phong bì (mọi trường trừ proof), base64url. Giống web/views/services-home.js. */
export function hubProof(key: string, envelope: Record<string, unknown>) {
  const { proof: _drop, ...rest } = envelope;
  return createHmac("sha256", Buffer.from(key, "base64url")).update(digestJcs(rest), "ascii").digest("base64url");
}

/** Danh tính hub của lời gọi: sub `hub:<hub_id>` khớp đường dẫn, hub ACTIVE, đúng workspace, chữ ký đúng; sai một điều là 401 đồng nhất. */
function identifyHub(c: Call): HubRow {
  if (c.p.sub !== `hub:${c.params.hub_id}`) throw hubRefused();
  const h = hubRow(c.d.ctx, c.params.hub_id);
  if (!h || h.status !== "ACTIVE" || h.workspace_id !== c.ws) throw hubRefused();
  return h;
}

function hubEvent(c: Call): Stored {
  const { ctx } = c.d;
  // Danh tính hub thật (chứng thư thiết bị, mTLS) chưa có: ngoài chế độ dev không hub nào gửi được.
  if (!c.d.dev) throw new ApiError(503, "HOME_HUB_IDENTITY_UNAVAILABLE");
  if (!ctx.control.moduleOn(GATE.module)) throw new ApiError(503, "MODULE_DISABLED");
  const h = identifyHub(c);
  const b = c.body as { event_id: string; observed_at: string; type: string; camera_ref: string; binding_version: number; schema_version: number; epoch: number; clip_ref?: string; proof: string };
  const want = Buffer.from(hubProof(h.hmac_key, b as unknown as Record<string, unknown>));
  const got = Buffer.from(b.proof);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw hubRefused();
  const s = subscription(ctx, h.subscription_id) as SubRow;
  if (s.hub_id !== h.id) throw hubRefused();
  // X07: binding cũ (hàng đợi của hub trước khi đổi) không bao giờ được nhận.
  if (b.binding_version !== s.binding_version || b.binding_version !== h.binding_version) throw new ApiError(409, "HOME_BINDING_STALE", { extra: { binding_version: s.binding_version } });
  if (!ACCEPTING.includes(s.state)) throw new ApiError(409, "HOME_NOT_ACCEPTING", { extra: { state: s.state } });
  if (!(JSON.parse(h.cameras) as string[]).includes(b.camera_ref)) throw new ApiError(422, "HOME_UNKNOWN_CAMERA");
  if (b.clip_ref !== undefined && b.type !== "PERSON_IN_ZONE") throw new ApiError(400, "SCHEMA_INVALID");
  const now = ctx.clock.now();
  const observed = Date.parse(b.observed_at);
  if (observed > now + HOME_LIMITS.futureSkewMs || now - observed > HOME_LIMITS.eventRetentionMs) throw new ApiError(422, "HOME_EVENT_TIME");
  const at = iso(now);
  run(ctx.db, "UPDATE home_hubs SET last_seen_at = ? WHERE id = ?", at, h.id);
  // X05: cùng (hub, camera, epoch, event_id) là cùng một sự kiện, dù khóa idempotency khác: trả bản đã có, không nhân đôi.
  const dup = one<EventRow>(ctx.db, "SELECT * FROM home_events WHERE hub_id = ? AND camera_ref = ? AND epoch = ? AND event_id = ?", h.id, b.camera_ref, b.epoch, b.event_id);
  if (dup) return { status: 200, body: { event_ref: dup.id, duplicate: true, late: dup.late === 1, received_at: dup.received_at }, resource: { type: "home_event", id: dup.id } };
  const id = `hev_${uuid()}`;
  const late = now - observed > HOME_LIMITS.lateAfterMs ? 1 : 0;
  run(ctx.db, `INSERT INTO home_events (id, workspace_id, subscription_id, hub_id, camera_ref, epoch, event_id, type, observed_at, received_at, late, binding_version, schema_version, clip_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, s.workspace_id, s.id, h.id, b.camera_ref, b.epoch, b.event_id, b.type, iso(observed), at, late, b.binding_version, b.schema_version, b.clip_ref ?? null);
  if (b.type === "CAMERA_OFFLINE" || b.type === "CAMERA_ONLINE") {
    // Sự kiện trễ không ghi đè trạng thái mới hơn.
    run(ctx.db, "UPDATE home_cameras SET online = ?, observed_at = ? WHERE hub_id = ? AND camera_ref = ? AND (observed_at IS NULL OR observed_at <= ?)", b.type === "CAMERA_ONLINE" ? 1 : 0, iso(observed), h.id, b.camera_ref, iso(observed));
  }
  return { status: 201, body: { event_ref: id, duplicate: false, late: late === 1, received_at: at }, resource: { type: "home_event", id } };
}

const DEV_ROUTES: DevRoute[] = [
  {
    // Hub giả lập của chế độ dev: phát token danh tính hub (sub hub:<id>) và trao khóa HMAC cho trình giả lập. Chỉ khi LENHIP_DEV.
    path: "/dev/home/hub-credential",
    handler(d, query) {
      const h = hubRow(d.ctx, query.get("hub_id") ?? "");
      if (!d.dev || !h || h.status !== "ACTIVE") throw new ApiError(404, "NOT_FOUND");
      return {
        status: 200,
        body: {
          simulated: true, hub_id: h.id, workspace_id: h.workspace_id, binding_version: h.binding_version, cameras: JSON.parse(h.cameras), key: h.hmac_key,
          token: d.dev.mint(`hub:${h.id}`, "hub", d.ctx.clock.now(), { ttlS: HOME_LIMITS.hubTokenTtlS }), expires_in: HOME_LIMITS.hubTokenTtlS,
        },
      };
    },
  },
];

// ── Xóa, xuất, dọn theo hạn, nạp lại sổ thu hồi ───────────────────────────────────────────────────────────────────────────────

function purgeOwner(ctx: Ctx, ws: string, user: string): number {
  let n = 0;
  const del = (sql: string, ...args: (string | number | null)[]) => (n += Number(run(ctx.db, sql, ...args).changes));
  for (const s of all<{ id: string }>(ctx.db, "SELECT id FROM home_subscriptions WHERE workspace_id = ? AND owner_id = ?", ws, user)) {
    for (const h of all<{ id: string }>(ctx.db, "SELECT id FROM home_hubs WHERE subscription_id = ?", s.id)) {
      del("DELETE FROM home_cameras WHERE hub_id = ?", h.id);
      const prefix = `/v2/home/hubs/${h.id}/`;
      del("DELETE FROM idem_keys WHERE substr(route, 1, ?) = ?", prefix.length, prefix);
    }
    del("DELETE FROM home_hubs WHERE subscription_id = ?", s.id);
    del("DELETE FROM home_events WHERE subscription_id = ?", s.id);
    del("DELETE FROM home_view_grants WHERE subscription_id = ?", s.id);
    del("DELETE FROM home_steps WHERE subscription_id = ?", s.id);
    const ops = `/v2/ops/home/subscriptions/${s.id}/`;
    del("DELETE FROM idem_keys WHERE workspace_id = ? AND substr(route, 1, ?) = ?", ws, ops.length, ops);
    del("DELETE FROM home_subscriptions WHERE id = ?", s.id);
  }
  del("DELETE FROM idem_keys WHERE workspace_id = ? AND actor = ? AND substr(route, 1, 9) = '/v2/home/'", ws, user);
  return n;
}

export function exportHomeFor(ctx: Ctx, ws: string, user: string) {
  const subs = all<SubRow>(ctx.db, "SELECT * FROM home_subscriptions WHERE workspace_id = ? AND owner_id = ? ORDER BY created_at, id", ws, user);
  if (!subs.length) return undefined;
  return { scope: "Dữ liệu Le‑NodeHome phía máy chủ: đăng ký HaaS, các bước, hub, quyền xem và sự kiện tối thiểu. Không có hình, video hay âm thanh.", subscriptions: subs.map((s) => exportSub(ctx, s)) };
}

/** Dọn theo hạn: sự kiện quá hạn lưu, quyền xem đã hết hạn quá hạn lưu, dấu chống lặp của hub; chấm dứt phần của chủ hộ đã mất quyền. */
function sweep(ctx: Ctx, now: number) {
  const cutoff = iso(now - HOME_LIMITS.eventRetentionMs);
  const at = iso(now);
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM home_events WHERE received_at < ?", cutoff);
    run(ctx.db, "DELETE FROM home_view_grants WHERE expires_at < ? AND (revoked_at IS NULL OR revoked_at < ?)", cutoff, cutoff);
    run(ctx.db, "DELETE FROM idem_keys WHERE substr(route, 1, 14) = '/v2/home/hubs/' AND received_at < ?", cutoff);
    const owners = all<{ workspace_id: string; owner_id: string }>(ctx.db, "SELECT DISTINCT workspace_id, owner_id FROM home_subscriptions WHERE state NOT IN ('HAAS_TERMINATED','HAAS_RETURNED')");
    for (const o of owners) enforce(ctx, o.workspace_id, o.owner_id, at, true);
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const readableOwn = (c: Call, r: { type: string; id: string } | null) => {
  if (!r || !usable(c)) return false;
  const subId = r.type === "home_view_grant" ? one<{ subscription_id: string }>(c.d.ctx.db, "SELECT subscription_id FROM home_view_grants WHERE id = ?", r.id)?.subscription_id : r.id;
  const s = subId ? subscription(c.d.ctx, subId) : undefined;
  return !!s && s.workspace_id === c.ws && s.owner_id === c.p.sub;
};
const readableOps = (c: Call, r: { type: string; id: string } | null) => !!r && isOps(c) && subscription(c.d.ctx, r.id)?.workspace_id === c.ws;
const readableHub = (c: Call, r: { type: string; id: string } | null) => {
  if (!r || c.p.sub !== `hub:${c.params.hub_id}`) return false;
  const h = hubRow(c.d.ctx, c.params.hub_id);
  return !!h && h.status === "ACTIVE" && h.workspace_id === c.ws;
};

const ROUTES: Route[] = [
  { method: "GET", path: "/v2/home/subscriptions", handler: listOwn },
  { method: "POST", path: "/v2/home/subscriptions", schema: "HomeSubscriptionCreate", readable: readableOwn, handler: createSub },
  ...(Object.keys(OWNER_OPS) as (keyof typeof OWNER_OPS)[]).map((op): Route => ({
    method: "POST", path: `/v2/home/subscriptions/{subscription_id}/${op}`, schema: op === "confirm-install" ? "HomeInstallConfirm" : "HomeOwnerStep", readable: readableOwn, handler: (c) => ownerOp(c, op),
  })),
  { method: "GET", path: "/v2/home/subscriptions/{subscription_id}/events", handler: ownEvents },
  { method: "GET", path: "/v2/home/subscriptions/{subscription_id}/export", handler: ownExport },
  { method: "POST", path: "/v2/home/subscriptions/{subscription_id}/view-grants", schema: "HomeViewGrantCreate", readable: readableOwn, handler: createViewGrant },
  { method: "POST", path: "/v2/home/view-grants/{grant_id}/revoke", schema: "Empty", optionalBody: true, readable: readableOwn, handler: revokeViewGrant },
  { method: "POST", path: "/v2/home/hubs/{hub_id}/events", schema: "HomeHubEvent", readable: readableHub, handler: hubEvent },
  { method: "GET", path: "/v2/ops/home/subscriptions", handler: opsList },
  ...OPS_OPS.map((op): Route => ({ method: "POST", path: `/v2/ops/home/subscriptions/{subscription_id}/${op}`, schema: OPS_SCHEMA[op], readable: readableOps, handler: (c) => opsOp(c, op) })),
  { method: "GET", path: "/v2/ops/home/subscriptions/{subscription_id}/events", handler: opsEvents },
];

export const homehub: ServerModule = {
  name: "homehub",
  routes: ROUTES,
  devRoutes: DEV_ROUTES,
  errors: {
    HOME_REVISION_CONFLICT: "Đăng ký đã thay đổi ở nơi khác; hãy xem lại trạng thái mới trước khi làm tiếp.",
    HOME_TERMS_OUTDATED: "Điều khoản dịch vụ đã có phiên bản mới; hãy đọc lại trước khi gửi yêu cầu.",
    HOME_OPEN_LIMIT: "Bạn đã có một đăng ký đang mở.",
    HOME_SERIAL_MISMATCH: "Số serial không khớp với hub đã lắp cho nhà bạn.",
    HOME_SERIAL_IN_USE: "Hub có số serial này đang được dùng ở nơi khác.",
    HOME_CAMERA_LIST: "Danh sách camera không hợp lệ cho gói này.",
    HOME_VIEW_GRANT_ACTIVE: "Đang có một quyền xem tạm thời còn hiệu lực.",
    HOME_VIEW_GRANT_REQUIRED: "Cần chủ hộ cấp quyền xem tạm thời còn hiệu lực.",
    HOME_HUB_IDENTITY_INVALID: "Danh tính hub không hợp lệ.",
    HOME_HUB_IDENTITY_UNAVAILABLE: "Danh tính hub thật chưa có trong bản này.",
    HOME_BINDING_STALE: "Sự kiện thuộc liên kết hub cũ và không được nhận.",
    HOME_NOT_ACCEPTING: "Đăng ký hiện không nhận sự kiện từ hub.",
    HOME_UNKNOWN_CAMERA: "Camera này không thuộc hub đã lắp.",
    HOME_EVENT_TIME: "Thời điểm quan sát nằm ngoài khoảng được nhận.",
  },
  /** Dữ liệu mẫu: hai tài khoản thử dev_a, dev_b có quyền home.hub. Đồng ý KHÔNG cấp sẵn; không tạo sẵn đăng ký hay hub. */
  seed(ctx) {
    for (const u of DEV_USERS.filter((x) => x.sub !== "dev_ops")) {
      if (!isActiveMember(ctx, DEMO_WS, u.sub)) continue;
      if (one(ctx.db, "SELECT 1 FROM grants WHERE workspace_id = ? AND user_id = ? AND scope = ?", DEMO_WS, u.sub, GATE.scope)) continue;
      run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, ?, ?, NULL, 'ACTIVE', ?)", `gr_${uuid()}`, DEMO_WS, u.sub, GATE.scope, iso(ctx.clock.now()));
    }
  },
  onTick: (ctx, now) => sweep(ctx, now),
  privacy: {
    exportFor: exportHomeFor,
    deleteFor: (ctx, ws, user) => void purgeOwner(ctx, ws, user),
    onConsentWithdrawn(ctx, ws, user, purpose, at) {
      if (purpose === GATE.purpose) for (const s of liveSubsOf(ctx, ws, user)) systemRevoke(ctx, s, at, false);
    },
    onRestrict: (ctx, ws, user, at) => void enforce(ctx, ws, user, at),
  },
  revocations: {
    home_hub_revoked: (ctx, e) => revokeHub(ctx, e.hub_id as string, e.at, false),
    home_view_grant_revoked: (ctx, e) => Number(run(ctx.db, "UPDATE home_view_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", e.at, e.grant_id as string).changes) > 0,
    home_subscription_ended: (ctx, e) => {
      const s = subscription(ctx, e.subscription_id as string);
      return !!s && systemRevoke(ctx, s, e.at, false);
    },
    consent_withdrawn: (ctx, e) => e.purpose_id === GATE.purpose && enforce(ctx, e.workspace_id as string, e.user_id as string, e.at),
    grant_revoked: (ctx, e) => enforce(ctx, e.workspace_id as string, e.user_id as string, e.at),
    member_deleted: (ctx, e) => purgeOwner(ctx, e.workspace_id as string, e.user_id as string) > 0,
  },
};
