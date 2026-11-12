// Đồng bộ bản nháp và phiên trên các thiết bị (SRS V2.0 mục 03, 12; N20‑SYNC; LNH-T63, LNH-T64; ca X01, X02).
//
// - Bản nháp: draft_id (thiết bị tự tạo hoặc máy chủ tạo, theo không gian tên của chủ), mục đích, revision, snapshot tối thiểu theo schema đóng
//   của từng mục đích. Không có số liệu sức khỏe: ba schema không có trường nào cho nó (LNH-F35). Ghi theo base_revision: sửa trên
//   bản cũ trả 409 REVISION_CONFLICT kèm revision và snapshot hiện hành, không bao giờ ghi đè âm thầm (X01). Bản nháp không đổi
//   gì ngoài LeNhip; xác nhận một tác vụ thật vẫn đi chuỗi plan → xem lại → 120 giây của lõi, trực tuyến.
// - Phản hồi POST chỉ có tham chiếu (mã, revision, trạng thái), không có snapshot: sổ chống lặp không giữ nội dung nháp.
// - Phiên thiết bị: mỗi trình duyệt tự đăng ký một phiên với loại máy người dùng chọn (không tên máy, không user agent), cần đăng
//   nhập mới trong 300 giây. Thiết bị tự tạo bí mật 32 byte và chỉ gửi mã băm SHA-256; mọi yêu cầu sau mang `mã.bí_mật`. Máy chủ
//   chỉ giữ mã băm. Lần thấy gần nhất chỉ theo ngày (UTC).
// - Thu hồi một phiên: mọi yêu cầu /v2 mang phiên đó nhận 403 DEVICE_REVOKED; dòng thu hồi vào sổ thu hồi độc lập để bản restore
//   cũ không làm phiên sống lại (X02, X12). Đồng hồ (WATCH) không đọc được bản nháp: nó chỉ nhận lời nhắc chung.
// - Cổng: thành viên (404) → cờ `sync` (503) → phiên thiết bị (403). Mô-đun không có quyền hay mục đích đồng ý riêng: nó chỉ giữ
//   lại thứ chính người dùng gõ, cho chính người đó.
//
// Giới hạn đã biết (nói rõ): Call của api.ts chưa mang header, nên phiên đọc từ tham số truy vấn `device` (thiết bị gửi cả header
// X-LeNhip-Device lẫn tham số). Token đăng nhập của bản chạy thử dùng chung cho mọi thẻ của một trình duyệt và không gắn với phiên:
// thu hồi phiên chặn các route /v2 của mô-đun này, chưa chặn route /v1 của lõi (cần IAM cấp token theo phiên).
import { DAY } from "../core/clock.ts";
import { fromB64urlStrict, randomKey, sha256b64, uuid } from "../core/crypto.ts";
import { ApiError } from "../core/errors.ts";
import type { Call, Route } from "./api.ts";
import { isActiveMember, requireMember } from "./authority.ts";
import { type Ctx, nowIso } from "./context.ts";
import type { Stored } from "./idempotency.ts";
import { indexTransitions, transitionsFor } from "./machine.ts";
import type { ServerModule } from "./modules.ts";
import { journalRevocation } from "./recovery.ts";
import { all, audit, one, run, tx } from "./store.ts";

export const SYNC_LIMITS = {
  openDraftsPerOwner: 50,
  devicesPerOwner: 10,
  discardedRetentionMs: 30 * DAY,
  revokedRetentionMs: 30 * DAY,
  calendarMaxMs: 12 * 3600_000,
} as const;

export const SYNC_PURPOSES = ["calendar_block", "inbox_reply", "personal_task"] as const;
export const DEVICE_KINDS = ["PHONE", "TABLET", "LAPTOP", "DESKTOP", "WATCH", "OTHER"] as const;
type Purpose = (typeof SYNC_PURPOSES)[number];
type DraftState = "SYNCDRAFT_OPEN" | "SYNCDRAFT_DISCARDED";
type DeviceState = "SYNCDEV_ACTIVE" | "SYNCDEV_REVOKED";

interface DraftRow {
  workspace_id: string;
  owner: string;
  draft_id: string;
  purpose: Purpose;
  state: DraftState;
  revision: number;
  snapshot: string | null;
  created_at: string;
  updated_at: string;
  discarded_at: string | null;
}

interface DeviceRow {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: (typeof DEVICE_KINDS)[number];
  secret_hash: string;
  state: DeviceState;
  created_at: string;
  last_seen_day: string;
  revoked_at: string | null;
}

const findDraftEdge = indexTransitions(transitionsFor("SYNCDRAFT_"));
const findDeviceEdge = indexTransitions(transitionsFor("SYNCDEV_"));
const notFound = () => new ApiError(404, "NOT_FOUND");
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const CREDENTIAL_RE = /^(dvs_[A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{43})$/;

// ── Cổng và phiên ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Thành viên (404) → cờ sync (503). Mô-đun không có quyền hay mục đích riêng (requireModuleGate của lõi đòi một quyền). */
function gate(c: Call) {
  requireMember(c.d.ctx, c.ws, c.p.sub);
  if (!c.d.ctx.control.moduleOn("sync")) throw new ApiError(503, "MODULE_DISABLED");
}

/** Phiên do thiết bị gửi: header X-LeNhip-Device khi Call có header, nếu không thì tham số truy vấn `device`. */
function credentialOf(c: Call): string | null {
  const headers = (c as Call & { headers?: Record<string, string | string[] | undefined> }).headers;
  const h = headers?.["x-lenhip-device"];
  const v = typeof h === "string" ? h : c.query.get("device");
  return v && v.length <= 200 ? v : null;
}

/**
 * Phiên của người gọi theo bằng chứng thiết bị gửi. Không có, sai dạng, của người khác, hoặc sai bí mật: null (một kết quả cho mọi
 * trường hợp, không lộ phiên nào tồn tại). Phiên đúng bí mật nhưng đã thu hồi được trả về để báo DEVICE_REVOKED.
 */
function sessionOf(c: Call): DeviceRow | null {
  const m = CREDENTIAL_RE.exec(credentialOf(c) ?? "");
  if (!m) return null;
  const raw = fromB64urlStrict(m[2]);
  if (!raw || raw.length !== 32) return null;
  const d = one<DeviceRow>(c.d.ctx.db, "SELECT * FROM sync_devices WHERE id = ? AND workspace_id = ? AND user_id = ?", m[1], c.ws, c.p.sub);
  return d && d.secret_hash === sha256b64(raw) ? d : null;
}

/** Cổng đủ của route cần phiên: phiên đang dùng; ghi lần thấy theo ngày. */
function requireSession(c: Call): DeviceRow {
  gate(c);
  const d = sessionOf(c);
  if (!d) throw new ApiError(403, "DEVICE_REQUIRED");
  if (d.state !== "SYNCDEV_ACTIVE") throw new ApiError(403, "DEVICE_REVOKED");
  const today = day(c.d.ctx.clock.now());
  if (d.last_seen_day !== today) run(c.d.ctx.db, "UPDATE sync_devices SET last_seen_day = ? WHERE id = ?", today, d.id);
  return d;
}

/** Cổng của route bản nháp: phiên đang dùng và không phải đồng hồ (đồng hồ chỉ nhận lời nhắc chung, không có nội dung). */
function requireDraftSession(c: Call): DeviceRow {
  const d = requireSession(c);
  if (d.kind === "WATCH") throw new ApiError(403, "DEVICE_NOT_ALLOWED");
  return d;
}

/** Phát lại idempotent: chỉ khi người gọi vẫn qua cổng với một phiên đang dùng (không ném lỗi). */
function usable(c: Call, drafts: boolean) {
  if (!isActiveMember(c.d.ctx, c.ws, c.p.sub) || !c.d.ctx.control.moduleOn("sync")) return false;
  const d = sessionOf(c);
  return !!d && d.state === "SYNCDEV_ACTIVE" && (!drafts || d.kind !== "WATCH");
}

// ── Phiên thiết bị ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const devicesOf = (ctx: Ctx, ws: string, user: string) =>
  all<DeviceRow>(ctx.db, "SELECT * FROM sync_devices WHERE workspace_id = ? AND user_id = ? ORDER BY created_at, id", ws, user);

/** Phiên như chủ của nó thấy: loại máy, trạng thái, ngày tạo, ngày thấy gần nhất. Không mã băm, không giờ chính xác. */
const deviceView = (d: DeviceRow, current: string | null) => ({
  device_id: d.id,
  kind: d.kind,
  state: d.state === "SYNCDEV_ACTIVE" ? "ACTIVE" : "REVOKED",
  created_day: d.created_at.slice(0, 10),
  last_seen_day: d.last_seen_day,
  revoked_day: d.revoked_at ? d.revoked_at.slice(0, 10) : null,
  current: d.id === current,
});

function listDevices(c: Call): Stored {
  gate(c);
  // Liệt kê không cần phiên (trình duyệt chưa đăng ký vẫn xem được để đăng ký), nhưng phiên đã thu hồi thì bị chặn như mọi route /v2.
  const s = sessionOf(c);
  if (s && s.state !== "SYNCDEV_ACTIVE") throw new ApiError(403, "DEVICE_REVOKED");
  if (s) requireSession(c);
  const rows = devicesOf(c.d.ctx, c.ws, c.p.sub);
  return { status: 200, body: { devices: rows.map((d) => deviceView(d, s?.id ?? null)), limit: SYNC_LIMITS.devicesPerOwner } };
}

function registerDevice(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const now = ctx.clock.now();
  // Thêm một máy là thêm một nơi đọc được bản nháp: cần đăng nhập mới, như điểm nhận tin của nhắn tin (LNH-T15, LNH-T64).
  if (c.p.auth_time === null || now / 1000 - c.p.auth_time > ctx.config.reauthMaxAgeS) throw new ApiError(401, "REAUTH_REQUIRED");
  const b = c.body as { kind: DeviceRow["kind"]; secret_hash: string };
  if (one(ctx.db, "SELECT 1 FROM sync_devices WHERE secret_hash = ?", b.secret_hash)) throw new ApiError(409, "INVALID_TRANSITION");
  const active = devicesOf(ctx, c.ws, c.p.sub).filter((d) => d.state === "SYNCDEV_ACTIVE").length;
  if (active >= SYNC_LIMITS.devicesPerOwner) throw new ApiError(422, "DEVICE_LIMIT", { extra: { limit: SYNC_LIMITS.devicesPerOwner } });
  const id = `dvs_${uuid().replaceAll("-", "")}`;
  const at = new Date(now).toISOString();
  run(ctx.db, "INSERT INTO sync_devices (id, workspace_id, user_id, kind, secret_hash, state, created_at, last_seen_day) VALUES (?, ?, ?, ?, ?, 'SYNCDEV_ACTIVE', ?, ?)",
    id, c.ws, c.p.sub, b.kind, b.secret_hash, at, day(now));
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "sync.device.register", target: id, request_id: c.requestId, data: { kind: b.kind } });
  const row = one<DeviceRow>(ctx.db, "SELECT * FROM sync_devices WHERE id = ?", id) as DeviceRow;
  return { status: 201, body: deviceView(row, id), resource: { type: "sync_device", id } };
}

/** Áp cạnh revoke của máy SYNCDEV_ (CSV). Trả true nếu có đổi. Không ghi sổ thu hồi (bên nạp lại cũng dùng hàm này). */
function revokeRow(ctx: Ctx, id: string, actor: "OWNER" | "AUTHORITY", at: string): boolean {
  const d = one<DeviceRow>(ctx.db, "SELECT * FROM sync_devices WHERE id = ?", id);
  if (!d) return false;
  const edge = findDeviceEdge(d.state, "revoke", actor);
  if (!edge) return false;
  return Number(run(ctx.db, "UPDATE sync_devices SET state = ?, revoked_at = ? WHERE id = ? AND state = ?", edge.to, at, id, d.state).changes) === 1;
}

function revokeDevice(c: Call): Stored {
  const { ctx } = c.d;
  const me = requireSession(c);
  const d = one<DeviceRow>(ctx.db, "SELECT * FROM sync_devices WHERE id = ? AND workspace_id = ? AND user_id = ?", c.params.device_id, c.ws, c.p.sub);
  if (!d) throw notFound();
  const at = nowIso(ctx);
  if (revokeRow(ctx, d.id, "OWNER", at)) {
    // Sổ thu hồi độc lập: một bản restore cũ không được làm phiên đã thu hồi đọc lại bản nháp (X02, X12).
    journalRevocation(ctx, "sync_device_revoked", at, { workspace_id: c.ws, device_id: d.id });
    audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "sync.device.revoke", target: d.id, request_id: c.requestId, data: { self: d.id === me.id } });
  }
  const row = one<DeviceRow>(ctx.db, "SELECT * FROM sync_devices WHERE id = ?", d.id) as DeviceRow;
  return { status: 200, body: deviceView(row, me.id), resource: { type: "sync_device", id: d.id } };
}

// ── Bản nháp ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const draftOf = (ctx: Ctx, ws: string, owner: string, id: string) =>
  one<DraftRow>(ctx.db, "SELECT * FROM sync_drafts WHERE workspace_id = ? AND owner = ? AND draft_id = ?", ws, owner, id);

/** Bản nháp đầy đủ (GET, và trong 409 cho chính chủ của nó). */
const draftView = (d: DraftRow) => ({
  draft_id: d.draft_id,
  purpose: d.purpose,
  state: d.state === "SYNCDRAFT_OPEN" ? "OPEN" : "DISCARDED",
  revision: d.revision,
  snapshot: d.snapshot === null ? null : (JSON.parse(d.snapshot) as Record<string, unknown>),
  created_at: d.created_at,
  updated_at: d.updated_at,
  discarded_at: d.discarded_at,
});

/** Tham chiếu trả cho POST: không có snapshot, để sổ chống lặp không giữ nội dung nháp. */
const draftRef = (d: DraftRow) => ({ draft_id: d.draft_id, purpose: d.purpose, state: draftView(d).state, revision: d.revision, updated_at: d.updated_at });

/** Kiểm phần schema không diễn đạt được: khung giờ có thứ tự và không quá 12 giờ. */
function checkSnapshot(purpose: Purpose, s: Record<string, unknown>) {
  if (purpose !== "calendar_block") return;
  const start = Date.parse(s.start as string);
  const end = Date.parse(s.end as string);
  if (!(end > start) || end - start > SYNC_LIMITS.calendarMaxMs) throw new ApiError(422, "DRAFT_INVALID", { extra: { detail_code: "WINDOW", limit: SYNC_LIMITS.calendarMaxMs / 60_000 } });
}

const conflict = (d: DraftRow) => new ApiError(409, "REVISION_CONFLICT", { extra: { current: draftView(d) } });

function listDrafts(c: Call): Stored {
  requireDraftSession(c);
  const rows = all<DraftRow>(c.d.ctx.db, "SELECT * FROM sync_drafts WHERE workspace_id = ? AND owner = ? AND state = 'SYNCDRAFT_OPEN' ORDER BY updated_at DESC, draft_id", c.ws, c.p.sub);
  return { status: 200, body: { drafts: rows.map(draftView), limit: SYNC_LIMITS.openDraftsPerOwner } };
}

function getDraft(c: Call): Stored {
  requireDraftSession(c);
  const d = draftOf(c.d.ctx, c.ws, c.p.sub, c.params.draft_id);
  if (!d) throw notFound();
  return { status: 200, body: draftView(d) };
}

function createDraft(c: Call): Stored {
  const { ctx } = c.d;
  requireDraftSession(c);
  const body = c.body as { draft_id?: string; purpose: Purpose; snapshot: Record<string, unknown> };
  // Mã do thiết bị tạo (hàng đợi ngoại tuyến gửi lại không nhân đôi); trang không có hàng đợi (Hộp tổng hợp) để máy chủ tạo,
  // Idempotency-Key vẫn chống tạo hai lần.
  const b = { ...body, draft_id: body.draft_id ?? `drf_${randomKey(16)}` };
  checkSnapshot(b.purpose, b.snapshot);
  // Cùng mã đã có (thiết bị tạo hai lần với hai khóa khác nhau): không ghi đè, trả bản hiện hành để thiết bị đối chiếu.
  const existing = draftOf(ctx, c.ws, c.p.sub, b.draft_id);
  if (existing) throw conflict(existing);
  const open = Number(one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM sync_drafts WHERE workspace_id = ? AND owner = ? AND state = 'SYNCDRAFT_OPEN'", c.ws, c.p.sub)?.n ?? 0);
  if (open >= SYNC_LIMITS.openDraftsPerOwner) throw new ApiError(422, "DRAFT_LIMIT", { extra: { limit: SYNC_LIMITS.openDraftsPerOwner } });
  const at = nowIso(ctx);
  run(ctx.db, "INSERT INTO sync_drafts (workspace_id, owner, draft_id, purpose, state, revision, snapshot, created_at, updated_at) VALUES (?, ?, ?, ?, 'SYNCDRAFT_OPEN', 1, ?, ?, ?)",
    c.ws, c.p.sub, b.draft_id, b.purpose, JSON.stringify(b.snapshot), at, at);
  return { status: 201, body: draftRef(draftOf(ctx, c.ws, c.p.sub, b.draft_id) as DraftRow), resource: { type: "sync_draft", id: b.draft_id } };
}

/** Một cạnh của máy SYNCDRAFT_ với CAS theo revision. Sai revision → 409 kèm bản hiện hành; đã bỏ → 409 DRAFT_DISCARDED. */
function step(c: Call, event: "revise" | "discard", base: number, snapshot: Record<string, unknown> | null): DraftRow {
  const { ctx } = c.d;
  const d = draftOf(ctx, c.ws, c.p.sub, c.params.draft_id);
  if (!d) throw notFound();
  const edge = findDraftEdge(d.state, event, "OWNER");
  if (!edge) throw new ApiError(409, "DRAFT_DISCARDED");
  if (base !== d.revision) throw conflict(d);
  const at = nowIso(ctx);
  const r = run(ctx.db, "UPDATE sync_drafts SET state = ?, revision = revision + 1, snapshot = ?, updated_at = ?, discarded_at = ? WHERE workspace_id = ? AND owner = ? AND draft_id = ? AND revision = ?",
    edge.to, snapshot === null ? null : JSON.stringify(snapshot), at, edge.to === "SYNCDRAFT_DISCARDED" ? at : null, c.ws, c.p.sub, d.draft_id, d.revision);
  if (Number(r.changes) !== 1) throw conflict(draftOf(ctx, c.ws, c.p.sub, d.draft_id) as DraftRow);
  return draftOf(ctx, c.ws, c.p.sub, d.draft_id) as DraftRow;
}

function reviseDraft(c: Call): Stored {
  requireDraftSession(c);
  const b = c.body as { purpose: Purpose; base_revision: number; snapshot: Record<string, unknown> };
  const d = draftOf(c.d.ctx, c.ws, c.p.sub, c.params.draft_id);
  if (!d) throw notFound();
  if (d.purpose !== b.purpose) throw new ApiError(422, "DRAFT_INVALID", { extra: { detail_code: "PURPOSE" } });
  checkSnapshot(b.purpose, b.snapshot);
  const next = step(c, "revise", b.base_revision, b.snapshot);
  return { status: 200, body: draftRef(next), resource: { type: "sync_draft", id: next.draft_id } };
}

function discardDraft(c: Call): Stored {
  requireDraftSession(c);
  const b = c.body as { base_revision: number };
  const next = step(c, "discard", b.base_revision, null);
  // Nội dung rời máy chủ ngay khi bỏ (snapshot NULL); hàng chỉ còn siêu dữ liệu tới khi dọn sau 30 ngày.
  return { status: 200, body: draftRef(next), resource: { type: "sync_draft", id: next.draft_id } };
}

// ── Dọn dẹp, xuất, xóa ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Dấu chống lặp của các route bản nháp và phiên của một người. Phản hồi đã lưu không có nội dung, nhưng có mã nháp và thời điểm. */
const IDEM_PREFIXES = ["/v2/sync/", "/v2/devices"];

function sweep(ctx: Ctx, now: number) {
  const draftCutoff = new Date(now - SYNC_LIMITS.discardedRetentionMs).toISOString();
  const deviceCutoff = new Date(now - SYNC_LIMITS.revokedRetentionMs).toISOString();
  tx(ctx.db, () => {
    const gone = all<{ workspace_id: string; owner: string; draft_id: string }>(ctx.db, "SELECT workspace_id, owner, draft_id FROM sync_drafts WHERE state = 'SYNCDRAFT_DISCARDED' AND discarded_at < ?", draftCutoff);
    for (const g of gone) {
      const prefix = `/v2/sync/drafts/${g.draft_id}/`;
      run(ctx.db, "DELETE FROM idem_keys WHERE workspace_id = ? AND actor = ? AND (substr(route, 1, ?) = ? OR (resource_type = 'sync_draft' AND resource_id = ?))", g.workspace_id, g.owner, prefix.length, prefix, g.draft_id);
      run(ctx.db, "DELETE FROM sync_drafts WHERE workspace_id = ? AND owner = ? AND draft_id = ?", g.workspace_id, g.owner, g.draft_id);
    }
    run(ctx.db, "DELETE FROM sync_devices WHERE state = 'SYNCDEV_REVOKED' AND revoked_at < ?", deviceCutoff);
  });
}

/** Phần đồng bộ trong tệp xuất: siêu dữ liệu phiên và bản nháp, kèm snapshot của bản nháp đang mở (chính người đó đã gõ). */
function exportFor(ctx: Ctx, ws: string, user: string) {
  const devices = devicesOf(ctx, ws, user).map((d) => ({ device_id: d.id, kind: d.kind, state: deviceView(d, null).state, created_day: d.created_at.slice(0, 10), last_seen_day: d.last_seen_day, revoked_day: d.revoked_at?.slice(0, 10) ?? null }));
  const drafts = all<DraftRow>(ctx.db, "SELECT * FROM sync_drafts WHERE workspace_id = ? AND owner = ? ORDER BY created_at, draft_id", ws, user).map(draftView);
  if (!devices.length && !drafts.length) return undefined;
  return { scope: "Phiên thiết bị (loại máy, ngày) và bản nháp đồng bộ của chính người này. Không có số liệu sức khỏe, tên máy hay user agent.", devices, drafts };
}

function deleteFor(ctx: Ctx, ws: string, user: string) {
  run(ctx.db, "DELETE FROM sync_drafts WHERE workspace_id = ? AND owner = ?", ws, user);
  run(ctx.db, "DELETE FROM sync_devices WHERE workspace_id = ? AND user_id = ?", ws, user);
  for (const p of IDEM_PREFIXES) run(ctx.db, "DELETE FROM idem_keys WHERE workspace_id = ? AND actor = ? AND substr(route, 1, ?) = ?", ws, user, p.length, p);
}

// ── Route ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const readableDraft = (c: Call, r: { type: string; id: string } | null) => !!r && usable(c, true) && !!draftOf(c.d.ctx, c.ws, c.p.sub, r.id);
const readableDevice = (c: Call, r: { type: string; id: string } | null) =>
  !!r && usable(c, false) && !!one(c.d.ctx.db, "SELECT 1 FROM sync_devices WHERE id = ? AND workspace_id = ? AND user_id = ?", r.id, c.ws, c.p.sub);
/** Đăng ký phát lại: thiết bị gửi lại đúng yêu cầu (mất phản hồi) nhận lại phiên của nó nếu phiên còn dùng. */
const readableRegistered = (c: Call, r: { type: string; id: string } | null) =>
  !!r && isActiveMember(c.d.ctx, c.ws, c.p.sub) && c.d.ctx.control.moduleOn("sync") &&
  one<{ state: string }>(c.d.ctx.db, "SELECT state FROM sync_devices WHERE id = ? AND workspace_id = ? AND user_id = ?", r.id, c.ws, c.p.sub)?.state === "SYNCDEV_ACTIVE";

const ROUTES: Route[] = [
  { method: "GET", path: "/v2/devices", handler: listDevices },
  { method: "POST", path: "/v2/devices", schema: "SyncDeviceCreate", readable: readableRegistered, handler: registerDevice },
  { method: "POST", path: "/v2/devices/{device_id}/revoke", schema: "Empty", optionalBody: true, readable: readableDevice, handler: revokeDevice },
  { method: "GET", path: "/v2/sync/drafts", handler: listDrafts },
  { method: "POST", path: "/v2/sync/drafts", schema: "SyncDraftCreate", readable: readableDraft, handler: createDraft },
  { method: "GET", path: "/v2/sync/drafts/{draft_id}", handler: getDraft },
  { method: "POST", path: "/v2/sync/drafts/{draft_id}/revisions", schema: "SyncDraftRevision", readable: readableDraft, handler: reviseDraft },
  { method: "POST", path: "/v2/sync/drafts/{draft_id}/discard", schema: "SyncDraftDiscard", readable: readableDraft, handler: discardDraft },
];

export const sync: ServerModule = {
  name: "sync",
  routes: ROUTES,
  errors: {
    REVISION_CONFLICT: "Bản nháp đã được sửa ở nơi khác; hãy xem bản mới nhất rồi chọn.",
    DRAFT_DISCARDED: "Bản nháp này đã được bỏ.",
    DRAFT_INVALID: "Nội dung bản nháp không hợp lệ.",
    DRAFT_LIMIT: "Đã đủ số bản nháp đang mở; hãy bỏ bớt một bản.",
    DEVICE_REQUIRED: "Thiết bị này chưa có phiên đồng bộ.",
    DEVICE_REVOKED: "Phiên này đã bị thu hồi.",
    DEVICE_NOT_ALLOWED: "Loại thiết bị này không đọc được bản nháp.",
    DEVICE_LIMIT: "Đã đủ số phiên thiết bị; hãy thu hồi một phiên trước khi thêm.",
  },
  onTick: (ctx, now) => sweep(ctx, now),
  privacy: { exportFor, deleteFor },
  revocations: {
    sync_device_revoked: (ctx, e) => revokeRow(ctx, e.device_id as string, "AUTHORITY", e.at),
    member_deleted: (ctx, e) => {
      const n = Number(one<{ n: number }>(ctx.db, "SELECT (SELECT COUNT(*) FROM sync_drafts WHERE workspace_id = ? AND owner = ?) + (SELECT COUNT(*) FROM sync_devices WHERE workspace_id = ? AND user_id = ?) AS n",
        e.workspace_id as string, e.user_id as string, e.workspace_id as string, e.user_id as string)?.n ?? 0);
      if (n) deleteFor(ctx, e.workspace_id as string, e.user_id as string);
      return n > 0;
    },
  },
};
