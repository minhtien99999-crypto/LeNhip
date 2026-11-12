// Hộp tổng hợp (SRS V2.0 mục 04, 11, 12, 13, 14; N20‑INB, cổng G1‑I; LNH-T60, LNH-T61, LNH-T65). Gom hai loại mục của một người:
//   - SHARED: phần người dùng tự chọn (dán, chia sẻ vào LeNhip). Chỉ lưu đúng chuỗi người dùng đã xem trước: tối đa 280 điểm mã văn
//     bản thuần và một liên kết https đã kiểm. Cổng: thành viên (404) → cờ `inbox` (503).
//   - OUTLOOK_MAIL: thư đọc qua nguồn Microsoft 365 chỉ đọc, quyền delegated Mail.ReadBasic. Ở bản này nguồn là GIẢ LẬP
//     (src/adapters/outlook-mock.ts, nhãn «mô phỏng / Microsoft 365 giả lập») và chỉ nối được ở chế độ dev. Chỉ có tiêu đề, người gửi,
//     thời điểm nhận và liên kết đã kiểm; không có thân thư, đoạn xem trước hay tệp đính kèm ở bất kỳ đâu. Cổng: thành viên → cờ
//     `inbox` → quyền `inbox.connect` (403) → đồng ý `inbox_mail` (403 CONSENT_REQUIRED). Token chỉ ở trong bộ nhớ của bộ nối (WeakMap
//     theo app), không vào sổ, phản hồi hay trình duyệt.
//
// Quyền đọc một mục phụ thuộc quyền nguồn còn hiệu lực (SRS mục 11): danh sách và mọi thao tác chỉ thấy mục Outlook khi kết nối của
// nó đang CONNECTED và người đó còn cờ, quyền, đồng ý. Token bị thu hồi hoặc hết hạn giữa lúc phân trang (X03): dừng đọc ngay, ghi
// trạng thái nguồn, mục của kết nối đó đi cạnh source_revoked → INBOX_HIDDEN và biến khỏi danh sách; kết nối lại trong 7 ngày thì thư
// cũ hiện lại ở «Mới» (source_restored), quá hạn thì bị xóa. Người dùng ngắt kết nối, rút đồng ý `inbox_mail`, mất quyền, RESTRICT hay
// DELETE: mục dẫn xuất từ Outlook bị xóa ngay.
//
// Tiêu đề thư và nội dung được chia sẻ là dữ liệu không tin cậy (X04): chỉ được lưu và trả ra như chuỗi; không gì ở đây phân tích,
// làm theo, mở quyền hay gửi đi. LeLe không có đường nào tới đây: tệp này không nạp lele.ts và lele.ts không nạp tệp này.
// «Tạo việc cá nhân» và «Soạn phản hồi» không có route ở đây: trang tạo bản nháp qua API bản nháp của track đồng bộ (/v2/sync/drafts);
// không gì được gửi ra ngoài LeNhip.
// Trạng thái mục theo các cạnh INBOX_* của contracts/state_transitions.csv; không cạnh nào chỉ nằm trong mã.
import { DAY, MINUTE } from "../core/clock.ts";
import { b64url, digestJcs, sha256b64, uuid } from "../core/crypto.ts";
import { ApiError } from "../core/errors.ts";
import { parseInstant } from "../../web/shared/zone.js";
import { checkedLink, linkSummary, OUTLOOK_LINK_HOSTS, sourceText, userText, INBOX_TEXT_LIMITS } from "../../web/shared/inbox-text.js";
import { MockOutlook, type ReadBasicMessage } from "../adapters/outlook-mock.ts";
import type { Call, Route } from "./api.ts";
import { activeGrant, consentGranted, isActiveMember, requireMember } from "./authority.ts";
import { type Ctx, nowIso } from "./context.ts";
import type { Stored } from "./idempotency.ts";
import type { JournalEntry } from "./journal.ts";
import { indexTransitions, transitionsFor } from "./machine.ts";
import type { DevRoute, ServerModule } from "./modules.ts";
import { journalRevocation } from "./recovery.ts";
import { DEMO_WS, DEV_USERS } from "./seed.ts";
import { all, audit, one, run, tx } from "./store.ts";

const MODULE = "inbox" as const;
const SCOPE = "inbox.connect" as const;
const PURPOSE = "inbox_mail" as const;

/** Giới hạn của mô-đun. Thời hạn giữ là đề xuất cho quyết định G0 (SRS mục 11). */
export const INBOX_LIMITS = {
  summaryChars: INBOX_TEXT_LIMITS.summary,
  senderChars: INBOX_TEXT_LIMITS.sender,
  linkChars: INBOX_TEXT_LIMITS.link,
  pageDefault: 20,
  pageMax: 50,
  importsPerDay: 200,
  itemsPerOwner: 2000,
  syncPageSize: 10,
  syncPagesPerTick: 3,
  snoozeMinMs: MINUTE,
  snoozeMaxMs: 30 * DAY,
  hiddenRetentionMs: 7 * DAY,
  doneRetentionMs: 30 * DAY,
} as const;

type ItemState = "INBOX_NEW" | "INBOX_SAVED" | "INBOX_SNOOZED" | "INBOX_DONE" | "INBOX_HIDDEN";
type ItemActor = "OWNER" | "CLOCK" | "AUTHORITY" | "SOURCE";
type SourceStatus = "CONNECTED" | "REVOKED" | "EXPIRED" | "DISCONNECTED";

interface ItemRow {
  id: string;
  workspace_id: string;
  owner: string;
  source_kind: "SHARED" | "OUTLOOK_MAIL";
  source_ref: string;
  connection_id: string | null;
  purpose: "REFERENCE" | "FOLLOW_UP" | null;
  observed_at: string;
  display_summary: string;
  sender: string | null;
  source_link: string | null;
  state: ItemState;
  snooze_until: string | null;
  hidden_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SourceRow {
  id: string;
  workspace_id: string;
  owner: string;
  kind: "OUTLOOK_MAIL";
  simulated: number;
  status: SourceStatus;
  cursor: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  connected_at: string;
  ended_at: string | null;
}

/** Trạng thái hiển thị trong danh sách; INBOX_HIDDEN không bao giờ ra khỏi máy chủ. */
const LISTED: readonly ItemState[] = ["INBOX_NEW", "INBOX_SAVED", "INBOX_SNOOZED", "INBOX_DONE"];
const FILTERS: Record<string, readonly ItemState[]> = {
  ACTIVE: ["INBOX_NEW", "INBOX_SAVED", "INBOX_SNOOZED"],
  NEW: ["INBOX_NEW"],
  SAVED: ["INBOX_SAVED"],
  SNOOZED: ["INBOX_SNOOZED"],
  DONE: ["INBOX_DONE"],
};

const iso = (ms: number) => new Date(ms).toISOString();
const notFound = () => new ApiError(404, "NOT_FOUND");

// ── Bộ nối Outlook giả lập: một đối tượng và bảng token trong bộ nhớ cho mỗi app ───────────────────────────────────────────────

interface Runtime {
  outlook: MockOutlook;
  /** source_id → token. Mất khi khởi động lại: kết nối khi đó thành EXPIRED ở lượt đồng bộ kế tiếp. */
  tokens: Map<string, string>;
}
const RUNTIME = new WeakMap<Ctx, Runtime>();
/** Bộ nối Outlook giả lập của app (kiểm thử dùng để đặt lỗi có chủ đích). */
export function outlookFor(ctx: Ctx): Runtime {
  let r = RUNTIME.get(ctx);
  if (!r) RUNTIME.set(ctx, (r = { outlook: new MockOutlook(), tokens: new Map() }));
  return r;
}
/** Tài khoản giả lập của một người: mã băm, không mang mã người dùng hay workspace. */
export const outlookAccount = (ws: string, user: string) => `acct-${sha256b64(`${ws}\n${user}`).slice(0, 16)}`;

// ── Cổng ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Thành viên (404) rồi cờ `inbox` (503). Đủ cho phần người dùng tự chia sẻ. */
function gate(c: Call) {
  requireMember(c.d.ctx, c.ws, c.p.sub);
  if (!c.d.ctx.control.moduleOn(MODULE)) throw new ApiError(503, "MODULE_DISABLED");
}

/** Người này còn đọc được nguồn Outlook: cờ, thành viên, quyền `inbox.connect`, đồng ý `inbox_mail`. */
const outlookEntitled = (ctx: Ctx, ws: string, user: string) =>
  ctx.control.moduleOn(MODULE) && isActiveMember(ctx, ws, user) && !!activeGrant(ctx, ws, user, SCOPE, null) && consentGranted(ctx, ws, user, PURPOSE);

const liveSource = (ctx: Ctx, ws: string, user: string) =>
  one<SourceRow>(ctx.db, "SELECT * FROM inbox_sources WHERE workspace_id = ? AND owner = ? AND kind = 'OUTLOOK_MAIL' AND status = 'CONNECTED'", ws, user);
const latestSource = (ctx: Ctx, ws: string, user: string) =>
  one<SourceRow>(ctx.db, "SELECT * FROM inbox_sources WHERE workspace_id = ? AND owner = ? AND kind = 'OUTLOOK_MAIL' ORDER BY connected_at DESC, rowid DESC LIMIT 1", ws, user);

/** Mục còn đọc được lúc này: của chính người gọi, không bị chặn, và (với Outlook) nguồn của nó còn quyền. */
function readable(ctx: Ctx, row: ItemRow | undefined, ws: string, user: string): row is ItemRow {
  if (!row || row.workspace_id !== ws || row.owner !== user || !LISTED.includes(row.state)) return false;
  if (row.source_kind === "SHARED") return ctx.control.moduleOn(MODULE);
  if (!outlookEntitled(ctx, ws, user)) return false;
  return one<{ status: string }>(ctx.db, "SELECT status FROM inbox_sources WHERE id = ?", row.connection_id ?? "")?.status === "CONNECTED";
}

const itemOf = (ctx: Ctx, id: string) => one<ItemRow>(ctx.db, "SELECT * FROM inbox_items WHERE id = ?", id);

function ownItem(c: Call): ItemRow {
  const row = itemOf(c.d.ctx, c.params.item_ref);
  // Của người khác, workspace khác, đã ẩn vì mất quyền nguồn hay không có: cùng một 404.
  if (!readable(c.d.ctx, row, c.ws, c.p.sub)) throw notFound();
  return row;
}

const itemView = (r: ItemRow) => ({
  item_ref: r.id,
  source_kind: r.source_kind,
  observed_at: r.observed_at,
  display_summary: r.display_summary,
  sender: r.sender,
  source_link: r.source_link,
  state: r.state.slice("INBOX_".length) as "NEW" | "SAVED" | "SNOOZED" | "DONE",
  snooze_until: r.snooze_until,
  purpose: r.purpose,
  updated_at: r.updated_at,
});

// ── Máy trạng thái INBOX_ ─────────────────────────────────────────────────────────────────────────────────────────────────────

const findEdge = indexTransitions(transitionsFor("INBOX_"));

/** Áp một cạnh INBOX_; không có cạnh thì null. CAS theo revision, mỗi cạnh tăng revision đúng một lần. */
function step(ctx: Ctx, r: ItemRow, name: string, actor: ItemActor, at: string, set: { snooze_until?: string | null; hidden_at?: string | null; connection_id?: string | null } = {}): ItemRow | null {
  const edge = findEdge(r.state, name, actor);
  if (!edge) return null;
  const snooze = edge.to === "INBOX_SNOOZED" ? (set.snooze_until ?? r.snooze_until) : null;
  const hidden = edge.to === "INBOX_HIDDEN" ? (set.hidden_at ?? at) : null;
  const conn = set.connection_id !== undefined ? set.connection_id : r.connection_id;
  const res = run(ctx.db, "UPDATE inbox_items SET state = ?, snooze_until = ?, hidden_at = ?, connection_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
    edge.to, snooze, hidden, conn, at, r.id, r.revision);
  if (Number(res.changes) !== 1) throw new ApiError(409, "INVALID_TRANSITION", { retryable: true });
  return itemOf(ctx, r.id) as ItemRow;
}

function act(c: Call, name: "save" | "snooze" | "done"): Stored {
  const { ctx } = c.d;
  gate(c);
  const row = ownItem(c);
  const at = nowIso(ctx);
  let until: string | null = null;
  if (name === "snooze") {
    const raw = (c.body as { until: string }).until;
    const ms = parseInstant(raw);
    const now = ctx.clock.now();
    if (Number.isNaN(ms) || ms < now + INBOX_LIMITS.snoozeMinMs || ms > now + INBOX_LIMITS.snoozeMaxMs) {
      throw new ApiError(422, "INBOX_SNOOZE_INVALID", { extra: { limit: INBOX_LIMITS.snoozeMaxMs / DAY } });
    }
    until = iso(ms);
  }
  const next = step(ctx, row, name, "OWNER", at, { snooze_until: until });
  if (!next) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: itemView(row).state } });
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: `inbox.item.${name}`, target: row.id, request_id: c.requestId });
  return { status: 200, body: itemView(next), resource: { type: "inbox_item", id: row.id } };
}

// ── Danh sách ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Con trỏ mờ: vị trí cuối trang trước, gắn với bộ lọc của nó. Không mang quyền gì: truy vấn luôn lọc theo chủ từ phiên. */
const encodeCursor = (filter: string, r: ItemRow) => b64url(JSON.stringify(["i1", filter, r.observed_at, r.id]));
function decodeCursor(raw: string, filter: string): { at: string; id: string } {
  try {
    if (!/^[A-Za-z0-9_-]{8,400}$/.test(raw)) throw new Error();
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 4 || v[0] !== "i1" || v[1] !== filter || typeof v[2] !== "string" || typeof v[3] !== "string") throw new Error();
    return { at: v[2], id: v[3] };
  } catch {
    throw new ApiError(400, "SCHEMA_INVALID", { extra: { issues: [{ path: "cursor", message: "cursor không hợp lệ" }] } });
  }
}

/** Trạng thái của nguồn Outlook như người gọi được thấy. Không có token, không có con trỏ của nguồn. */
function sourceView(c: Call) {
  const { ctx } = c.d;
  const s = latestSource(ctx, c.ws, c.p.sub);
  const permission = !activeGrant(ctx, c.ws, c.p.sub, SCOPE, null) ? "FORBIDDEN" : !consentGranted(ctx, c.ws, c.p.sub, PURPOSE) ? "CONSENT_REQUIRED" : "OK";
  return {
    kind: "OUTLOOK_MAIL" as const,
    simulated: true,
    available: c.d.dev !== null,
    permission,
    status: s ? s.status : ("NOT_CONNECTED" as const),
    connected_at: s?.connected_at ?? null,
    last_sync_at: s?.last_sync_at ?? null,
    ended_at: s?.ended_at ?? null,
    last_error: s?.last_error ?? null,
  };
}

function list(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const filter = c.query.get("state") ?? "ACTIVE";
  const states = FILTERS[filter];
  const limitRaw = c.query.get("limit");
  const limit = limitRaw === null ? INBOX_LIMITS.pageDefault : Number(limitRaw);
  if (!states || !Number.isInteger(limit) || limit < 1 || limit > INBOX_LIMITS.pageMax || (limitRaw !== null && !/^\d{1,2}$/.test(limitRaw))) throw new ApiError(400, "SCHEMA_INVALID");
  const cursorRaw = c.query.get("cursor");
  const after = cursorRaw === null ? null : decodeCursor(cursorRaw, filter);
  const outlook = outlookEntitled(ctx, c.ws, c.p.sub) ? 1 : 0;
  const args: (string | number)[] = [c.ws, c.p.sub, ...states, outlook];
  let where = "";
  if (after) {
    where = " AND (i.observed_at < ? OR (i.observed_at = ? AND i.id < ?))";
    args.push(after.at, after.at, after.id);
  }
  // Mục Outlook chỉ hiện khi kết nối của nó còn CONNECTED và người gọi còn quyền đọc nguồn ngay lúc này (X03).
  const rows = all<ItemRow>(ctx.db,
    `SELECT i.* FROM inbox_items i LEFT JOIN inbox_sources s ON s.id = i.connection_id
     WHERE i.workspace_id = ? AND i.owner = ? AND i.state IN (${states.map(() => "?").join(",")})
       AND (i.source_kind = 'SHARED' OR (? = 1 AND s.status = 'CONNECTED'))${where}
     ORDER BY i.observed_at DESC, i.id DESC LIMIT ?`, ...args, limit + 1);
  const page = rows.slice(0, limit);
  return {
    status: 200,
    body: {
      items: page.map(itemView),
      next_cursor: rows.length > limit ? encodeCursor(filter, page[page.length - 1]) : null,
      sources: [{ kind: "SHARED" as const, status: "AVAILABLE" as const }, sourceView(c)],
      server_time: nowIso(ctx),
    },
  };
}

// ── Nhập phần người dùng chọn ─────────────────────────────────────────────────────────────────────────────────────────────────

interface ImportBody {
  kind: "TEXT" | "URL";
  text?: string;
  url?: string;
  purpose: "REFERENCE" | "FOLLOW_UP";
  storage: "WORKSPACE";
}

function importItem(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const b = c.body as ImportBody;
  const content = new ApiError(422, "INBOX_CONTENT_INVALID", { extra: { limit: INBOX_LIMITS.summaryChars } });
  let text: string | null = null;
  if (b.text !== undefined) {
    const r = userText(b.text);
    if (!r.ok) throw content;
    text = r.text;
  }
  let link: string | null = null;
  if (b.url !== undefined) {
    link = checkedLink(b.url);
    if (!link) throw new ApiError(422, "INBOX_LINK_INVALID");
  }
  if (b.kind === "TEXT" && text === null) throw content;
  if (b.kind === "URL" && link === null) throw new ApiError(422, "INBOX_LINK_INVALID");
  const summary = text ?? linkSummary(link as string);
  // Chống trùng theo nguồn: cùng loại, cùng chuỗi đã chuẩn hóa, cùng liên kết là một mục.
  const ref = digestJcs({ kind: b.kind, text, url: link });
  const dup = one<ItemRow>(ctx.db, "SELECT * FROM inbox_items WHERE workspace_id = ? AND owner = ? AND source_kind = 'SHARED' AND source_ref = ?", c.ws, c.p.sub, ref);
  if (dup) return { status: 200, body: { item_ref: dup.id, result: "DUPLICATE", stored_in: "WORKSPACE", item: itemView(dup) }, resource: { type: "inbox_item", id: dup.id } };
  const now = ctx.clock.now();
  const today = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM inbox_items WHERE workspace_id = ? AND owner = ? AND source_kind = 'SHARED' AND created_at > ?", c.ws, c.p.sub, iso(now - DAY))?.n ?? 0;
  if (today >= INBOX_LIMITS.importsPerDay) throw new ApiError(429, "INBOX_LIMIT", { extra: { limit: INBOX_LIMITS.importsPerDay } });
  if (countOf(ctx, c.ws, c.p.sub) >= INBOX_LIMITS.itemsPerOwner) throw new ApiError(429, "INBOX_LIMIT", { extra: { limit: INBOX_LIMITS.itemsPerOwner } });
  const id = `inb_${uuid()}`;
  const at = iso(now);
  run(ctx.db, `INSERT INTO inbox_items (id, workspace_id, owner, source_kind, source_ref, connection_id, purpose, observed_at, display_summary, sender, source_link, state, created_at, updated_at)
    VALUES (?, ?, ?, 'SHARED', ?, NULL, ?, ?, ?, NULL, ?, 'INBOX_NEW', ?, ?)`, id, c.ws, c.p.sub, ref, b.purpose, at, summary, link, at, at);
  // Nhật ký không có nội dung: chỉ loại và mục đích.
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "inbox.import", target: id, request_id: c.requestId, data: { kind: b.kind, purpose: b.purpose } });
  const row = itemOf(ctx, id) as ItemRow;
  return { status: 201, body: { item_ref: id, result: "STORED", stored_in: "WORKSPACE", item: itemView(row) }, resource: { type: "inbox_item", id } };
}

const countOf = (ctx: Ctx, ws: string, user: string) =>
  one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM inbox_items WHERE workspace_id = ? AND owner = ?", ws, user)?.n ?? 0;

// ── Kết nối nguồn Outlook giả lập ─────────────────────────────────────────────────────────────────────────────────────────────

function connect(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  if (!activeGrant(ctx, c.ws, c.p.sub, SCOPE, null)) throw new ApiError(403, "FORBIDDEN");
  if (!consentGranted(ctx, c.ws, c.p.sub, PURPOSE)) throw new ApiError(403, "CONSENT_REQUIRED");
  // Nguồn giả lập chỉ có ở chế độ dev; nguồn thật cần tenant đã duyệt (cổng G1‑I), chưa có ở bản này.
  if (!c.d.dev) throw new ApiError(503, "INBOX_SOURCE_UNAVAILABLE");
  const now = ctx.clock.now();
  // Thêm một nguồn đọc thư là thao tác nhạy cảm (SRS V2.0 mục 03): cần đăng nhập mới trong 300 giây.
  if (c.p.auth_time === null || now / 1000 - c.p.auth_time > ctx.config.reauthMaxAgeS) throw new ApiError(401, "REAUTH_REQUIRED");
  const existing = liveSource(ctx, c.ws, c.p.sub);
  const rt = outlookFor(ctx);
  if (existing && rt.tokens.has(existing.id)) return { status: 200, body: sourceView(c), resource: { type: "inbox_source", id: existing.id } };
  const at = iso(now);
  if (existing) endSource(ctx, existing, "EXPIRED", "TOKEN_MISSING", at);
  const id = `isrc_${uuid()}`;
  run(ctx.db, "INSERT INTO inbox_sources (id, workspace_id, owner, kind, simulated, status, connected_at) VALUES (?, ?, ?, 'OUTLOOK_MAIL', 1, 'CONNECTED', ?)", id, c.ws, c.p.sub, at);
  rt.tokens.set(id, rt.outlook.issueToken(outlookAccount(c.ws, c.p.sub), now));
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "inbox.source.connect", target: id, request_id: c.requestId, data: { kind: "OUTLOOK_MAIL", simulated: true } });
  return { status: 201, body: sourceView(c), resource: { type: "inbox_source", id } };
}

function disconnect(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const s = liveSource(ctx, c.ws, c.p.sub);
  const at = nowIso(ctx);
  if (s) {
    purgeOutlook(ctx, c.ws, c.p.sub, at);
    // Vào sổ thu hồi: một bản restore cũ không được làm thư của kết nối đã ngắt hiện lại.
    journalRevocation(ctx, "inbox_source_disconnected", at, { workspace_id: c.ws, user_id: c.p.sub, source_id: s.id });
    audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "inbox.source.disconnect", target: s.id, request_id: c.requestId });
  }
  const latest = latestSource(ctx, c.ws, c.p.sub);
  return { status: 200, body: sourceView(c), resource: latest ? { type: "inbox_source", id: latest.id } : undefined };
}

/** Kết thúc một kết nối: trạng thái nguồn, quên token, và (khi mất quyền ở phía nguồn) ẩn mọi mục của kết nối đó (X03). */
function endSource(ctx: Ctx, s: SourceRow, status: Exclude<SourceStatus, "CONNECTED">, error: string | null, at: string) {
  const rt = outlookFor(ctx);
  const token = rt.tokens.get(s.id);
  if (token) rt.outlook.revoke(token);
  rt.tokens.delete(s.id);
  run(ctx.db, "UPDATE inbox_sources SET status = ?, last_error = ?, cursor = NULL, ended_at = ? WHERE id = ? AND status = 'CONNECTED'", status, error, at, s.id);
  for (const r of all<ItemRow>(ctx.db, "SELECT * FROM inbox_items WHERE connection_id = ? AND state <> 'INBOX_HIDDEN'", s.id)) step(ctx, r, "source_revoked", "AUTHORITY", at);
}

/** Xóa mọi mục dẫn xuất từ Outlook của một người và dấu chống lặp của chúng, ngắt kết nối đang có. Trả số hàng đã đổi. */
function purgeOutlook(ctx: Ctx, ws: string, user: string, at: string): number {
  let n = 0;
  for (const s of all<SourceRow>(ctx.db, "SELECT * FROM inbox_sources WHERE workspace_id = ? AND owner = ? AND status = 'CONNECTED'", ws, user)) {
    endSource(ctx, s, "DISCONNECTED", null, at);
    n++;
  }
  const ids = all<{ id: string }>(ctx.db, "SELECT id FROM inbox_items WHERE workspace_id = ? AND owner = ? AND source_kind = 'OUTLOOK_MAIL'", ws, user).map((r) => r.id);
  for (const id of ids) n += dropItem(ctx, ws, id);
  return n;
}

/** Xóa một mục và mọi bản ghi chống lặp nhắc tới nó (phản hồi đã lưu của chúng có tiêu đề hoặc nội dung). */
function dropItem(ctx: Ctx, ws: string, id: string): number {
  const prefix = `/v2/inbox/items/${id}/`;
  run(ctx.db, "DELETE FROM idem_keys WHERE workspace_id = ? AND ((resource_type = 'inbox_item' AND resource_id = ?) OR substr(route, 1, ?) = ?)", ws, id, prefix.length, prefix);
  return Number(run(ctx.db, "DELETE FROM inbox_items WHERE id = ?", id).changes);
}

/** Mất cờ, quyền hay đồng ý: xóa phần Outlook. Còn đủ thì không đổi gì. */
const enforce = (ctx: Ctx, ws: string, user: string, at: string) => (outlookEntitled(ctx, ws, user) ? false : purgeOutlook(ctx, ws, user, at) > 0);

/** Xóa mọi thứ của Hộp tổng hợp thuộc một người (DELETE). */
function purgeMember(ctx: Ctx, ws: string, user: string): number {
  const rt = outlookFor(ctx);
  let n = 0;
  for (const s of all<SourceRow>(ctx.db, "SELECT * FROM inbox_sources WHERE workspace_id = ? AND owner = ?", ws, user)) {
    const token = rt.tokens.get(s.id);
    if (token) rt.outlook.revoke(token);
    rt.tokens.delete(s.id);
  }
  for (const r of all<{ id: string }>(ctx.db, "SELECT id FROM inbox_items WHERE workspace_id = ? AND owner = ?", ws, user)) n += dropItem(ctx, ws, r.id);
  n += Number(run(ctx.db, "DELETE FROM inbox_sources WHERE workspace_id = ? AND owner = ?", ws, user).changes);
  n += Number(run(ctx.db, "DELETE FROM idem_keys WHERE workspace_id = ? AND actor = ? AND substr(route, 1, 10) = '/v2/inbox/'", ws, user).changes);
  return n;
}

// ── Đồng bộ theo con trỏ ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Một thư Mail.ReadBasic → mục. Chỉ bốn trường được phép; tiêu đề giữ nguyên văn như dữ liệu (X04). */
function ingest(ctx: Ctx, s: SourceRow, m: ReadBasicMessage, at: string): "NEW" | "DUPLICATE" | "RESTORED" | "LIMIT" | "SKIPPED" {
  const received = parseInstant(String(m.receivedDateTime));
  if (typeof m.id !== "string" || !m.id || Number.isNaN(received)) return "SKIPPED";
  const ref = sha256b64(`outlook\n${m.id}`);
  const summary = sourceText(m.subject) || "—";
  const name = sourceText(m.sender?.emailAddress?.name, INBOX_LIMITS.senderChars);
  const address = sourceText(m.sender?.emailAddress?.address, INBOX_LIMITS.senderChars);
  const sender = (name && address ? sourceText(`${name} <${address}>`, INBOX_LIMITS.senderChars) : name || address) || null;
  const link = checkedLink(m.webLink, OUTLOOK_LINK_HOSTS);
  const prev = one<ItemRow>(ctx.db, "SELECT * FROM inbox_items WHERE workspace_id = ? AND owner = ? AND source_kind = 'OUTLOOK_MAIL' AND source_ref = ?", s.workspace_id, s.owner, ref);
  if (prev) {
    if (prev.state !== "INBOX_HIDDEN") {
      if (prev.connection_id !== s.id) run(ctx.db, "UPDATE inbox_items SET connection_id = ? WHERE id = ?", s.id, prev.id);
      return "DUPLICATE";
    }
    run(ctx.db, "UPDATE inbox_items SET display_summary = ?, sender = ?, source_link = ? WHERE id = ?", summary, sender, link, prev.id);
    step(ctx, itemOf(ctx, prev.id) as ItemRow, "source_restored", "SOURCE", at, { connection_id: s.id });
    return "RESTORED";
  }
  if (countOf(ctx, s.workspace_id, s.owner) >= INBOX_LIMITS.itemsPerOwner) return "LIMIT";
  run(ctx.db, `INSERT INTO inbox_items (id, workspace_id, owner, source_kind, source_ref, connection_id, purpose, observed_at, display_summary, sender, source_link, state, created_at, updated_at)
    VALUES (?, ?, ?, 'OUTLOOK_MAIL', ?, ?, NULL, ?, ?, ?, ?, 'INBOX_NEW', ?, ?)`, `inb_${uuid()}`, s.workspace_id, s.owner, ref, s.id, iso(received), summary, sender, link, at, at);
  return "NEW";
}

const stillLive = (ctx: Ctx, s: SourceRow) =>
  one<{ status: string }>(ctx.db, "SELECT status FROM inbox_sources WHERE id = ?", s.id)?.status === "CONNECTED" && outlookEntitled(ctx, s.workspace_id, s.owner);

/** Đồng bộ một kết nối: tối đa vài trang mỗi lượt, kiểm quyền trước mỗi lần đọc và trước khi ghi kết quả của lần đọc đó. */
export async function syncSource(ctx: Ctx, sourceId: string): Promise<{ pages: number; ingested: number; stopped: string | null }> {
  const s = one<SourceRow>(ctx.db, "SELECT * FROM inbox_sources WHERE id = ? AND status = 'CONNECTED'", sourceId);
  const out = { pages: 0, ingested: 0, stopped: null as string | null };
  if (!s) return out;
  const rt = outlookFor(ctx);
  let cursor = s.cursor;
  for (let i = 0; i < INBOX_LIMITS.syncPagesPerTick; i++) {
    if (!stillLive(ctx, s)) {
      tx(ctx.db, () => enforce(ctx, s.workspace_id, s.owner, nowIso(ctx)));
      out.stopped = "PERMISSION";
      return out;
    }
    const token = rt.tokens.get(s.id);
    if (!token) {
      tx(ctx.db, () => endSource(ctx, s, "EXPIRED", "TOKEN_MISSING", nowIso(ctx)));
      out.stopped = "TOKEN_MISSING";
      return out;
    }
    const page = await rt.outlook.listMessages(token, cursor, INBOX_LIMITS.syncPageSize, ctx.clock.now());
    if (!page.ok) {
      const at = nowIso(ctx);
      if (page.error === "INVALID_CURSOR") run(ctx.db, "UPDATE inbox_sources SET cursor = NULL, last_error = ? WHERE id = ?", page.error, s.id);
      // X03: dừng đọc ngay; không ghi gì của trang này; mục của kết nối biến khỏi danh sách.
      else tx(ctx.db, () => endSource(ctx, s, page.error === "TOKEN_EXPIRED" ? "EXPIRED" : "REVOKED", page.error, at));
      out.stopped = page.error;
      return out;
    }
    let stop = false;
    tx(ctx.db, () => {
      // Quyền có thể đã mất trong lúc chờ nguồn trả lời: kiểm lại trước khi ghi.
      if (!stillLive(ctx, s)) {
        stop = true;
        return;
      }
      const at = nowIso(ctx);
      let limited = false;
      for (const m of page.value) {
        const r = ingest(ctx, s, m, at);
        if (r === "NEW" || r === "RESTORED") out.ingested++;
        if (r === "LIMIT") limited = true;
      }
      cursor = page.next ?? page.delta;
      run(ctx.db, "UPDATE inbox_sources SET cursor = ?, last_sync_at = ?, last_error = ? WHERE id = ?", cursor, at, limited ? "INBOX_LIMIT" : null, s.id);
    });
    if (stop) {
      tx(ctx.db, () => enforce(ctx, s.workspace_id, s.owner, nowIso(ctx)));
      out.stopped = "PERMISSION";
      return out;
    }
    out.pages++;
    if (page.next === null) break;
  }
  return out;
}

/** Việc định kỳ: đánh thức mục để sau, dọn mục đã ẩn hay đã xong quá hạn, đồng bộ các kết nối. `now` từ đồng hồ tiêm được. */
async function onTick(ctx: Ctx, now: number) {
  const at = iso(now);
  tx(ctx.db, () => {
    for (const r of all<ItemRow>(ctx.db, "SELECT * FROM inbox_items WHERE state = 'INBOX_SNOOZED' AND snooze_until <= ?", at)) step(ctx, r, "wake", "CLOCK", at);
    for (const r of all<ItemRow>(ctx.db, "SELECT * FROM inbox_items WHERE (state = 'INBOX_HIDDEN' AND hidden_at < ?) OR (state = 'INBOX_DONE' AND updated_at < ?)",
      iso(now - INBOX_LIMITS.hiddenRetentionMs), iso(now - INBOX_LIMITS.doneRetentionMs))) dropItem(ctx, r.workspace_id, r.id);
  });
  for (const s of all<{ id: string }>(ctx.db, "SELECT id FROM inbox_sources WHERE status = 'CONNECTED' ORDER BY connected_at, id")) await syncSource(ctx, s.id);
}

// ── Quyền của chủ thể dữ liệu ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Phần Hộp tổng hợp trong tệp xuất: chỉ siêu dữ liệu, không tóm tắt, không người gửi, không liên kết, không token. */
export function exportInboxFor(ctx: Ctx, ws: string, user: string) {
  const items = all<ItemRow>(ctx.db, "SELECT * FROM inbox_items WHERE workspace_id = ? AND owner = ? AND state <> 'INBOX_HIDDEN' ORDER BY created_at, id", ws, user)
    .map((r) => ({ item_ref: r.id, source_kind: r.source_kind, state: itemView(r).state, purpose: r.purpose, observed_at: r.observed_at, created_at: r.created_at, has_link: r.source_link !== null }));
  const sources = all<SourceRow>(ctx.db, "SELECT * FROM inbox_sources WHERE workspace_id = ? AND owner = ? ORDER BY connected_at, id", ws, user)
    .map((s) => ({ kind: s.kind, simulated: s.simulated === 1, status: s.status, connected_at: s.connected_at, ended_at: s.ended_at }));
  if (!items.length && !sources.length) return undefined;
  return {
    scope: "Siêu dữ liệu của Hộp tổng hợp: loại nguồn, trạng thái, thời điểm. Không có tóm tắt, tiêu đề thư, người gửi hay liên kết; không có token. Nguồn Outlook ở bản này là nguồn giả lập.",
    items,
    sources,
  };
}

/** Nạp lại một lần ngắt kết nối sau restore: mục Outlook của kết nối đó và kết nối cũ hơn bị xóa, kết nối bị đóng. Lặp lại an toàn. */
function replayDisconnect(ctx: Ctx, e: JournalEntry): boolean {
  const ws = e.workspace_id as string;
  const user = e.user_id as string;
  let changed = false;
  for (const s of all<SourceRow>(ctx.db, "SELECT * FROM inbox_sources WHERE workspace_id = ? AND owner = ? AND status = 'CONNECTED' AND connected_at <= ?", ws, user, e.at)) {
    endSource(ctx, s, "DISCONNECTED", null, e.at);
    changed = true;
  }
  for (const r of all<{ id: string }>(ctx.db, "SELECT i.id FROM inbox_items i JOIN inbox_sources s ON s.id = i.connection_id WHERE i.workspace_id = ? AND i.owner = ? AND s.connected_at <= ?", ws, user, e.at)) {
    changed = dropItem(ctx, ws, r.id) > 0 || changed;
  }
  return changed;
}

// ── Route ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Phát lại idempotent: chỉ trả bản cũ khi người gọi còn đọc được tài nguyên đó ngay lúc này. */
const readableItem = (c: Call, r: { type: string; id: string } | null) => !!r && r.type === "inbox_item" && readable(c.d.ctx, itemOf(c.d.ctx, r.id), c.ws, c.p.sub);
const readableSource = (c: Call, r: { type: string; id: string } | null) =>
  isActiveMember(c.d.ctx, c.ws, c.p.sub) && c.d.ctx.control.moduleOn(MODULE) &&
  (r === null || (r.type === "inbox_source" && !!one(c.d.ctx.db, "SELECT 1 FROM inbox_sources WHERE id = ? AND workspace_id = ? AND owner = ?", r.id, c.ws, c.p.sub)));

const ROUTES: Route[] = [
  { method: "GET", path: "/v2/inbox/items", handler: list },
  { method: "POST", path: "/v2/inbox/imports", schema: "InboxImport", readable: readableItem, handler: importItem },
  { method: "POST", path: "/v2/inbox/items/{item_ref}/save", schema: "Empty", optionalBody: true, readable: readableItem, handler: (c) => act(c, "save") },
  { method: "POST", path: "/v2/inbox/items/{item_ref}/snooze", schema: "InboxSnooze", readable: readableItem, handler: (c) => act(c, "snooze") },
  { method: "POST", path: "/v2/inbox/items/{item_ref}/done", schema: "Empty", optionalBody: true, readable: readableItem, handler: (c) => act(c, "done") },
  { method: "POST", path: "/v2/inbox/sources/outlook/connect", schema: "Empty", optionalBody: true, readable: readableSource, handler: connect },
  { method: "POST", path: "/v2/inbox/sources/outlook/disconnect", schema: "Empty", optionalBody: true, readable: readableSource, handler: disconnect },
];

/**
 * Lỗi có chủ đích của nguồn giả lập cho kiểm trình duyệt (chỉ chế độ dev, không token): `fault` = revoke_after_pages (với `pages`,
 * cho lần nối kế tiếp), expire, revoke (cho token đang dùng) của tài khoản giả lập của `user` trong `ws`.
 */
const DEV_ROUTES: DevRoute[] = [{
  path: "/dev/inbox/outlook-fault",
  handler(d, q) {
    const ws = q.get("ws") ?? DEMO_WS;
    const user = q.get("user") ?? "";
    const fault = q.get("fault") ?? "";
    const pages = Number(q.get("pages") ?? "0");
    if (!DEV_USERS.some((u) => u.sub === user) || !["revoke_after_pages", "expire", "revoke"].includes(fault) || !Number.isInteger(pages) || pages < 0 || pages > 20) throw new ApiError(400, "SCHEMA_INVALID");
    // revoke_after_pages áp cho token cấp ở lần nối kế tiếp, để thu hồi rơi đúng giữa lượt phân trang đầu tiên (X03).
    outlookFor(d.ctx).outlook.fault(outlookAccount(ws, user), fault === "revoke_after_pages" ? { revokeAfterPages: pages, nextToken: true } : fault === "expire" ? { expireNow: true } : { revokeNow: true }, d.ctx.clock.now());
    return { status: 200, body: { ok: true, simulated: true } };
  },
}];

export const inbox: ServerModule = {
  name: "inbox",
  routes: ROUTES,
  devRoutes: DEV_ROUTES,
  errors: {
    INBOX_CONTENT_INVALID: "Nội dung cần là văn bản thuần, từ 1 đến 280 ký tự, không có ký tự điều khiển.",
    INBOX_LINK_INVALID: "Liên kết phải là https và không chứa tên người dùng hay mật khẩu.",
    INBOX_LIMIT: "Đã tới giới hạn số mục của Hộp tổng hợp.",
    INBOX_SNOOZE_INVALID: "Giờ nhắc phải ở tương lai và không quá 30 ngày.",
    INBOX_SOURCE_UNAVAILABLE: "Nguồn này chưa dùng được ở máy chủ này.",
  },
  /** Dữ liệu mẫu: hai tài khoản thử có quyền inbox.connect. Đồng ý inbox_mail KHÔNG được cấp sẵn: người dùng tự bật. */
  seed(ctx) {
    for (const u of DEV_USERS.filter((x) => x.sub === "dev_a" || x.sub === "dev_b")) {
      if (!isActiveMember(ctx, DEMO_WS, u.sub)) continue;
      if (one(ctx.db, "SELECT 1 FROM grants WHERE workspace_id = ? AND user_id = ? AND scope = ?", DEMO_WS, u.sub, SCOPE)) continue;
      run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, ?, ?, NULL, 'ACTIVE', ?)", `gr_${uuid()}`, DEMO_WS, u.sub, SCOPE, nowIso(ctx));
    }
  },
  onTick,
  privacy: {
    exportFor: exportInboxFor,
    deleteFor: (ctx, ws, user) => void purgeMember(ctx, ws, user),
    // Rút đồng ý inbox_mail: dừng đọc và xóa mục dẫn xuất từ Outlook (SRS mục 11).
    onConsentWithdrawn(ctx, ws, user, purpose, at) {
      if (purpose === PURPOSE) purgeOutlook(ctx, ws, user, at);
    },
    onRestrict: (ctx, ws, user, at) => void enforce(ctx, ws, user, at),
  },
  revocations: {
    inbox_source_disconnected: replayDisconnect,
    consent_withdrawn: (ctx, e) => e.purpose_id === PURPOSE && enforce(ctx, e.workspace_id as string, e.user_id as string, e.at),
    grant_revoked: (ctx, e) => enforce(ctx, e.workspace_id as string, e.user_id as string, e.at),
    member_deleted: (ctx, e) => purgeMember(ctx, e.workspace_id as string, e.user_id as string) > 0,
  },
};
