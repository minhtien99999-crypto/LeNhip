// Nhắn tin 1:1 và «Thiết bị của tôi» (LNH-T30..T36). Máy chủ là hộp thư, không phải kho (LNH-T32): nó chỉ giữ bản mã LNH-MSG-1
// (web/shared/msg-crypto.js) cho tới khi thiết bị nhận xác nhận đã lưu, muộn nhất 30 ngày. Nó không có bản rõ, không có khóa nội
// dung, không có khóa riêng, không lưu tên máy hay user agent, và không ghi audit cho từng tin.
//
// - Cổng của mọi route: thành viên (404) → cờ `messaging` (503) → quyền `messaging.use` (403) → đồng ý `messaging` (403).
// - Điểm nhận tin (endpoint) là một trình duyệt đã đăng ký khóa công khai; danh sách điểm nhận tin của một người cũng là sổ
//   «Thiết bị của tôi» (LNH-T30). Tối đa 5; đăng ký cần đăng nhập mới trong 300 giây.
// - Hội thoại đi theo 10 cạnh THREAD_* của contracts/state_transitions.csv (LNH-T33); không cạnh nào chỉ nằm trong mã.
// - Gửi tin không phải một kế hoạch (LNH-T34): không gì ngoài LeNhip thay đổi. Chống gửi trùng bằng Idempotency-Key và
//   UNIQUE(sender_endpoint, client_ref); máy chủ không bao giờ tự gửi lại hay tự tạo tin.
// - Biên nhận theo bằng chứng (LNH-T35): «đã tới thiết bị» chỉ khi một thiết bị của người nhận xác nhận đã lưu; «đã xem» chỉ khi
//   người đọc bật chia sẻ, và không bao giờ vượt quá mốc «đã tới thiết bị».
// - LeLe không có đường nào tới đây (LNH-T36): tệp này không nạp lele.ts và lele.ts không nạp tệp này (kiểm ở tests/messaging.test.ts).
//
// Điều chưa che được, nói rõ: người bị chặn thấy hội thoại «đã đóng» như khi người kia rời đi, nhưng nếu chủ động thử chặn lại
// thì nhận INVALID_TRANSITION và suy ra được mình đang bị chặn (bảng 10 cạnh không có chặn hai chiều).
import { createPublicKey } from "node:crypto";
import { DAY, MINUTE } from "../core/clock.ts";
import { b64url, digestJcs, fromB64urlStrict, sha256b64, uuid } from "../core/crypto.ts";
import { ApiError } from "../core/errors.ts";
import type { Call, Route } from "./api.ts";
import { activeGrant, consentGranted, isActiveMember, member, requireMember, requireModuleGate, requireRole } from "./authority.ts";
import { type Ctx, nowIso } from "./context.ts";
import type { Stored } from "./idempotency.ts";
import type { JournalEntry } from "./journal.ts";
import { indexTransitions, transitionsFor } from "./machine.ts";
import type { ServerModule } from "./modules.ts";
import { journalRevocation } from "./recovery.ts";
import { DEMO_WS, DEV_USERS } from "./seed.ts";
import { all, audit, one, run, tx } from "./store.ts";

const GATE = { module: "messaging", scope: "messaging.use", purpose: "messaging" } as const;

/** Tên lược đồ mã hóa; phải trùng MSG_SCHEME của web/shared/msg-crypto.js vì nó nằm trong mã băm key_set. */
const SCHEME = "LNH-MSG-1";

/** Giới hạn của mô-đun. Cỡ bản mã theo MSG_LIMITS của web/shared/msg-crypto.js. */
export const MESSAGING_LIMITS = {
  endpointsPerMember: 5, // LNH-T30
  openRequests: 10, // lời mời đang chờ trả lời của một người
  sendsPerMinute: 30,
  sendsPerDay: 500,
  reportsPerDay: 20,
  retentionMs: 30 * DAY, // LNH-T32
  inboxPage: 50,
  opsReports: 200,
  ivBytes: 12,
  blockBytes: 256,
  tagBytes: 16,
  maxPaddedBytes: 12032,
  publicKeyBytes: 65,
  wrappedBytes: 48,
} as const;

type ThreadState = "THREAD_REQUESTED" | "THREAD_ACTIVE" | "THREAD_CLOSED" | "THREAD_BLOCKED";
type ThreadActor = "REQUESTER" | "ADDRESSEE" | "MEMBER" | "BLOCKER" | "AUTHORITY";

interface EndpointRow {
  id: string;
  workspace_id: string;
  user_id: string;
  kind: "PHONE" | "TABLET" | "LAPTOP" | "DESKTOP" | "OTHER";
  public_key: string;
  key_id: string;
  status: "ACTIVE" | "REVOKED";
  created_at: string;
  revoked_at: string | null;
}

interface ThreadRow {
  id: string;
  workspace_id: string;
  user_lo: string;
  user_hi: string;
  state: ThreadState;
  requested_by: string;
  blocked_by: string | null;
  reopen_by: string | null;
  last_seq: number;
  revision: number;
  journal_seq: number;
  created_at: string;
  updated_at: string;
}

interface MarkRow {
  delivered_seq: number;
  read_seq: number;
  read_shared_seq: number;
}

interface MessageRow {
  id: string;
  workspace_id: string;
  thread_id: string;
  seq: number;
  sender_user: string;
  sender_endpoint: string;
  client_ref: string;
  iv: string | null;
  ct: string | null;
  sent_at: string;
  delivered_at: string | null;
}

interface SendBody {
  client_ref: string;
  sender_endpoint: string;
  key_set: string;
  iv: string;
  ct: string;
  envelopes: { endpoint_id: string; enc: string; wrapped: string }[];
}

const ENDPOINT_RE = /^mep_[A-Za-z0-9_-]{6,64}$/;
const DIGEST_RE = /^[A-Za-z0-9_-]{43}$/;
const iso = (ms: number) => new Date(ms).toISOString();
const notFound = () => new ApiError(404, "NOT_FOUND");
const invalid = () => new ApiError(400, "SCHEMA_INVALID");
/** Một câu trả lời cho mọi lý do không gửi được tới người kia: bị chặn, người kia rút đồng ý, rời đi hoặc không còn thiết bị. */
const unavailable = () => new ApiError(409, "RECIPIENT_UNAVAILABLE");

// ── Cổng ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const gate = (c: Call) => requireModuleGate(c.d.ctx, c.ws, c.p.sub, GATE);

/** Người này còn dùng được nhắn tin theo Authority: thành viên ACTIVE, có quyền, còn đồng ý. Cờ mô-đun không tính ở đây. */
const entitled = (ctx: Ctx, ws: string, user: string) =>
  isActiveMember(ctx, ws, user) && !!activeGrant(ctx, ws, user, GATE.scope, null) && consentGranted(ctx, ws, user, GATE.purpose);

/** Quyền đọc hiện hành cho phát lại idempotent: cùng điều kiện với cổng, không ném lỗi. */
const usable = (c: Call) => c.d.ctx.control.moduleOn(GATE.module) && entitled(c.d.ctx, c.ws, c.p.sub);

// ── Điểm nhận tin («Thiết bị của tôi») ────────────────────────────────────────────────────────────────────────────────────────

const endpointsOf = (ctx: Ctx, ws: string, user: string) =>
  all<EndpointRow>(ctx.db, "SELECT * FROM msg_endpoints WHERE workspace_id = ? AND user_id = ? ORDER BY created_at, id", ws, user);
const activeEndpoints = (ctx: Ctx, ws: string, user: string) => endpointsOf(ctx, ws, user).filter((e) => e.status === "ACTIVE");

/** Người khác có thể mời hoặc gửi tới người này: còn dùng được nhắn tin và có ít nhất một thiết bị. */
const reachable = (ctx: Ctx, ws: string, user: string) => entitled(ctx, ws, user) && activeEndpoints(ctx, ws, user).length > 0;

/** Điểm nhận tin đang dùng của chính người gọi; của người khác, đã gỡ hoặc không có đều là 404. */
function ownEndpoint(ctx: Ctx, ws: string, user: string, id: string): EndpointRow {
  const e = one<EndpointRow>(ctx.db, "SELECT * FROM msg_endpoints WHERE id = ? AND workspace_id = ? AND user_id = ?", id, ws, user);
  if (!e || e.status !== "ACTIVE") throw notFound();
  return e;
}

const endpointView = (e: EndpointRow) => ({ endpoint_id: e.id, kind: e.kind, key_id: e.key_id, status: e.status, created_at: e.created_at, revoked_at: e.revoked_at });

/** Bỏ bản mã của những tin không còn phong bì nào chờ giao: không thiết bị nào còn lấy được nó từ máy chủ. */
function scrub(ctx: Ctx, messageIds: Iterable<string>) {
  for (const id of messageIds) {
    run(ctx.db, "UPDATE msg_messages SET iv = NULL, ct = NULL WHERE id = ? AND ct IS NOT NULL AND NOT EXISTS (SELECT 1 FROM msg_envelopes e WHERE e.message_id = msg_messages.id)", id);
  }
}

/** Gỡ một điểm nhận tin và xóa các phong bì đang chờ của nó (LNH-T30). Trả true nếu có đổi. Không ghi sổ thu hồi. */
function revokeEndpointRow(ctx: Ctx, id: string, at: string): boolean {
  const r = run(ctx.db, "UPDATE msg_endpoints SET status = 'REVOKED', revoked_at = ? WHERE id = ? AND status = 'ACTIVE'", at, id);
  const pending = all<{ message_id: string }>(ctx.db, "SELECT message_id FROM msg_envelopes WHERE endpoint_id = ?", id).map((x) => x.message_id);
  if (pending.length) {
    run(ctx.db, "DELETE FROM msg_envelopes WHERE endpoint_id = ?", id);
    scrub(ctx, pending);
  }
  return Number(r.changes) > 0 || pending.length > 0;
}

function registerEndpoint(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const now = ctx.clock.now();
  // Thêm một thiết bị là thêm một nơi đọc được tin: cần đăng nhập mới, như EXPORT và DELETE (LNH-T15, LNH-T30).
  if (c.p.auth_time === null || now / 1000 - c.p.auth_time > ctx.config.reauthMaxAgeS) throw new ApiError(401, "REAUTH_REQUIRED");
  const b = c.body as { public_key: string; kind: EndpointRow["kind"] };
  const raw = fromB64urlStrict(b.public_key);
  if (!raw || raw.length !== MESSAGING_LIMITS.publicKeyBytes || raw[0] !== 4) throw invalid();
  try {
    // Điểm phải nằm trên P-256: một khóa hỏng sẽ làm mọi người gửi tới thiết bị này thất bại.
    createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) }, format: "jwk" });
  } catch {
    throw invalid();
  }
  const keyId = sha256b64(raw);
  const existing = one<EndpointRow>(ctx.db, "SELECT * FROM msg_endpoints WHERE workspace_id = ? AND key_id = ?", c.ws, keyId);
  if (existing) {
    // Cùng trình duyệt đăng ký lại đúng khóa đang dùng: trả điểm nhận tin đã có, không tốn thêm một chỗ. Khóa đã gỡ, hoặc khóa của
    // người khác, không đăng ký lại được: thiết bị phải tạo khóa mới.
    if (existing.user_id === c.p.sub && existing.status === "ACTIVE") return { status: 200, body: endpointView(existing), resource: { type: "msg_endpoint", id: existing.id } };
    throw new ApiError(409, "INVALID_TRANSITION");
  }
  if (activeEndpoints(ctx, c.ws, c.p.sub).length >= MESSAGING_LIMITS.endpointsPerMember) throw new ApiError(422, "ENDPOINT_LIMIT");
  const id = `mep_${uuid()}`;
  const at = iso(now);
  run(ctx.db, "INSERT INTO msg_endpoints (id, workspace_id, user_id, kind, public_key, key_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)", id, c.ws, c.p.sub, b.kind, b.public_key, keyId, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "messaging.endpoint.register", target: id, request_id: c.requestId, data: { kind: b.kind } });
  return { status: 201, body: endpointView(one<EndpointRow>(ctx.db, "SELECT * FROM msg_endpoints WHERE id = ?", id) as EndpointRow), resource: { type: "msg_endpoint", id } };
}

function revokeEndpoint(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const e = one<EndpointRow>(ctx.db, "SELECT * FROM msg_endpoints WHERE id = ? AND workspace_id = ? AND user_id = ?", c.params.endpoint_id, c.ws, c.p.sub);
  if (!e) throw notFound();
  if (e.status === "ACTIVE") {
    const at = nowIso(ctx);
    revokeEndpointRow(ctx, e.id, at);
    // Vào sổ thu hồi độc lập: một bản restore cũ không được làm thiết bị đã gỡ nhận tin trở lại.
    journalRevocation(ctx, "endpoint_revoked", at, { workspace_id: c.ws, endpoint_id: e.id });
    audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "messaging.endpoint.revoke", target: e.id, request_id: c.requestId });
  }
  return { status: 200, body: endpointView(one<EndpointRow>(ctx.db, "SELECT * FROM msg_endpoints WHERE id = ?", e.id) as EndpointRow), resource: { type: "msg_endpoint", id: e.id } };
}

// ── Hội thoại ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const findEdge = indexTransitions(transitionsFor("THREAD_"));

const thread = (ctx: Ctx, id: string) => one<ThreadRow>(ctx.db, "SELECT * FROM msg_threads WHERE id = ?", id);
const threadsOf = (ctx: Ctx, ws: string, user: string) =>
  all<ThreadRow>(ctx.db, "SELECT * FROM msg_threads WHERE workspace_id = ? AND (user_lo = ? OR user_hi = ?) ORDER BY created_at, id", ws, user, user);
const isParty = (t: ThreadRow, user: string) => t.user_lo === user || t.user_hi === user;
const peerOf = (t: ThreadRow, user: string) => (t.user_lo === user ? t.user_hi : t.user_lo);
const pairOf = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

/** Hội thoại của người gọi; hội thoại của người khác, của workspace khác hoặc không có đều là 404 (SRS mục 12, 15). */
function threadFor(ctx: Ctx, ws: string, id: string, user: string): ThreadRow {
  const t = thread(ctx, id);
  if (!t || t.workspace_id !== ws || !isParty(t, user)) throw notFound();
  return t;
}

/** Trạng thái người gọi được thấy: người bị chặn thấy hội thoại đã đóng, như khi người kia không còn dùng nhắn tin. */
const visibleState = (t: ThreadRow, user: string): ThreadState => (t.state === "THREAD_BLOCKED" && t.blocked_by !== user ? "THREAD_CLOSED" : t.state);

const markOf = (ctx: Ctx, threadId: string, user: string): MarkRow =>
  one<MarkRow>(ctx.db, "SELECT delivered_seq, read_seq, read_shared_seq FROM msg_marks WHERE thread_id = ? AND user_id = ?", threadId, user) ?? { delivered_seq: 0, read_seq: 0, read_shared_seq: 0 };

function setMark(ctx: Ctx, threadId: string, user: string, m: MarkRow) {
  run(ctx.db, `INSERT INTO msg_marks (thread_id, user_id, delivered_seq, read_seq, read_shared_seq) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, user_id) DO UPDATE SET delivered_seq = excluded.delivered_seq, read_seq = excluded.read_seq, read_shared_seq = excluded.read_shared_seq`,
    threadId, user, m.delivered_seq, m.read_seq, m.read_shared_seq);
}

/** Tập khóa của một hội thoại: mọi điểm nhận tin đang dùng của cả hai người, cùng mã băm mà thiết bị tự tính lại (keySetDigest). */
function keySet(ctx: Ctx, t: ThreadRow) {
  const endpoints = all<{ id: string; user_id: string; public_key: string }>(ctx.db,
    "SELECT id, user_id, public_key FROM msg_endpoints WHERE workspace_id = ? AND user_id IN (?, ?) AND status = 'ACTIVE'", t.workspace_id, t.user_lo, t.user_hi)
    .map((e) => ({ endpoint_id: e.id, public_key: e.public_key, user_id: e.user_id }))
    .sort((a, b) => (a.endpoint_id < b.endpoint_id ? -1 : 1));
  return { endpoints, key_set: digestJcs({ endpoints, thread_id: t.id, v: SCHEME }) };
}

/** Tập khóa nếu `me` gửi được tới người kia ngay lúc này: hội thoại đang mở, người kia còn dùng được nhắn tin và còn thiết bị. */
function deliverable(ctx: Ctx, t: ThreadRow, me: string) {
  const peer = peerOf(t, me);
  if (t.state !== "THREAD_ACTIVE" || !entitled(ctx, t.workspace_id, peer)) return null;
  const ks = keySet(ctx, t);
  return ks.endpoints.some((e) => e.user_id === peer) ? ks : null;
}

/** Hội thoại như người gọi được thấy. Không có trường nào để người bị chặn phân biệt «bị chặn» với «người kia không còn dùng». */
function threadView(ctx: Ctx, t: ThreadRow, user: string) {
  const peer = peerOf(t, user);
  const state = visibleState(t, user);
  const mine = markOf(ctx, t.id, user);
  const theirs = markOf(ctx, t.id, peer);
  return {
    thread_id: t.id,
    state,
    peer: { user_id: peer, name: member(ctx, t.workspace_id, peer)?.display_name ?? peer },
    role: t.requested_by === user ? "REQUESTER" : "ADDRESSEE",
    // Người gọi có được gửi lời mời mới hay không (cạnh THREAD_CLOSED --request--> THREAD_REQUESTED).
    can_request: t.state === "THREAD_CLOSED" && (t.reopen_by === null || t.reopen_by === user) && reachable(ctx, t.workspace_id, peer),
    // Mã băm tập khóa hiện hành khi gửi được ngay lúc này, ngược lại null. Thiết bị thấy giá trị này đổi trong lần thăm dò thường
    // (etag đổi theo) thì lấy lại khóa, tự tính lại mã băm và báo «danh sách thiết bị đã đổi»; nó không tin giá trị này để niêm phong.
    key_set: deliverable(ctx, t, user)?.key_set ?? null,
    last_seq: t.last_seq,
    delivered_seq: mine.delivered_seq,
    read_seq: mine.read_seq,
    // Bằng chứng về phía người kia: một thiết bị của họ đã lưu tới đâu, và họ đã đọc tới đâu nếu họ bật chia sẻ (LNH-T35).
    peer_delivered_seq: theirs.delivered_seq,
    peer_read_seq: theirs.read_shared_seq,
    created_at: t.created_at,
  };
}

/**
 * Áp một cạnh của máy THREAD_ (contracts/state_transitions.csv). Thử lần lượt các vai của bên gọi; không có cạnh thì trả null và
 * không đổi gì. CAS theo revision, mỗi cạnh tăng revision đúng một lần.
 */
function step(ctx: Ctx, t: ThreadRow, name: string, actors: readonly ThreadActor[], at: string, set: Partial<Pick<ThreadRow, "requested_by" | "blocked_by" | "reopen_by">> = {}): ThreadRow | null {
  const edge = actors.map((a) => findEdge(t.state, name, a)).find((e) => e !== undefined);
  if (!edge) return null;
  const next = { requested_by: t.requested_by, blocked_by: t.blocked_by, reopen_by: t.reopen_by, ...set };
  const r = run(ctx.db, "UPDATE msg_threads SET state = ?, requested_by = ?, blocked_by = ?, reopen_by = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
    edge.to, next.requested_by, next.blocked_by, next.reopen_by, at, t.id, t.revision);
  if (Number(r.changes) !== 1) throw new ApiError(409, "INVALID_TRANSITION", { retryable: true });
  return thread(ctx, t.id) as ThreadRow;
}

/** Xóa các phong bì còn chờ giao tới `user` của những tin do người kia gửi trong hội thoại này (khi `user` chặn). */
function dropPendingTo(ctx: Ctx, t: ThreadRow, user: string) {
  const rows = all<{ message_id: string; endpoint_id: string }>(ctx.db,
    `SELECT e.message_id, e.endpoint_id FROM msg_envelopes e JOIN msg_messages m ON m.id = e.message_id JOIN msg_endpoints p ON p.id = e.endpoint_id
     WHERE m.thread_id = ? AND m.sender_user <> ? AND p.user_id = ?`, t.id, user, user);
  for (const r of rows) run(ctx.db, "DELETE FROM msg_envelopes WHERE message_id = ? AND endpoint_id = ?", r.message_id, r.endpoint_id);
  scrub(ctx, new Set(rows.map((r) => r.message_id)));
}

function people(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const blocked = new Set(threadsOf(ctx, c.ws, me).filter((t) => t.state === "THREAD_BLOCKED").map((t) => peerOf(t, me)));
  const rows = all<{ user_id: string; display_name: string }>(ctx.db, "SELECT user_id, display_name FROM members WHERE workspace_id = ? AND status = 'ACTIVE' AND user_id <> ? ORDER BY display_name, user_id", c.ws, me);
  // Danh bạ duy nhất là thành viên của chính workspace (IAM); chỉ hiện người đã tự bật nhắn tin và có thiết bị, không chặn hai chiều.
  return { status: 200, body: { people: rows.filter((r) => !blocked.has(r.user_id) && reachable(ctx, c.ws, r.user_id)).map((r) => ({ user_id: r.user_id, name: r.display_name })) } };
}

function createThread(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const peer = (c.body as { peer: string }).peer;
  // Ai nằm ngoài danh sách người gọi nhìn thấy được đều là 404: người lạ, workspace khác, người chưa bật nhắn tin, người đã chặn.
  if (peer === me || !reachable(ctx, c.ws, peer)) throw notFound();
  const [lo, hi] = pairOf(me, peer);
  const t = one<ThreadRow>(ctx.db, "SELECT * FROM msg_threads WHERE workspace_id = ? AND user_lo = ? AND user_hi = ?", c.ws, lo, hi);
  if (t?.state === "THREAD_BLOCKED") throw notFound();
  if (t && t.state !== "THREAD_CLOSED") throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: t.state, resource_id: t.id } });
  if (t && t.reopen_by !== null && t.reopen_by !== me) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: t.state, resource_id: t.id } });
  const open = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM msg_threads WHERE workspace_id = ? AND requested_by = ? AND state = 'THREAD_REQUESTED'", c.ws, me) as { n: number };
  if (open.n >= MESSAGING_LIMITS.openRequests) throw new ApiError(429, "RATE_LIMITED");
  const at = nowIso(ctx);
  if (t) {
    const next = step(ctx, t, "request", ["MEMBER"], at, { requested_by: me, reopen_by: null });
    if (!next) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: t.state, resource_id: t.id } });
    return { status: 201, body: threadView(ctx, next, me), resource: { type: "msg_thread", id: t.id } };
  }
  // Hội thoại mới được chèn ở THREAD_REQUESTED, như plan được chèn ở DRAFT. Lời mời không mang chữ nào.
  const id = `th_${uuid()}`;
  run(ctx.db, "INSERT INTO msg_threads (id, workspace_id, user_lo, user_hi, state, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'THREAD_REQUESTED', ?, ?, ?)", id, c.ws, lo, hi, me, at, at);
  return { status: 201, body: threadView(ctx, thread(ctx, id) as ThreadRow, me), resource: { type: "msg_thread", id } };
}

const THREAD_OPS = ["accept", "decline", "withdraw", "block", "unblock"] as const;

function threadOp(c: Call, op: (typeof THREAD_OPS)[number]): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const t = threadFor(ctx, c.ws, c.params.thread_id, me);
  const peer = peerOf(t, me);
  const actors: ThreadActor[] = [t.requested_by === me ? "REQUESTER" : "ADDRESSEE", "MEMBER", ...(t.blocked_by === me ? (["BLOCKER"] as const) : [])];
  const at = nowIso(ctx);
  // Guard của cạnh accept: cả hai còn dùng được nhắn tin (người gọi đã qua cổng).
  if (op === "accept" && t.state === "THREAD_REQUESTED" && t.requested_by !== me && !entitled(ctx, c.ws, peer)) throw unavailable();
  const set = op === "decline" ? { reopen_by: me } : op === "withdraw" ? { reopen_by: null } : op === "block" ? { blocked_by: me, reopen_by: null } : op === "unblock" ? { blocked_by: null, reopen_by: me } : {};
  const next = step(ctx, t, op, actors, at, set);
  if (!next) throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: visibleState(t, me) } });
  if (op === "block" || op === "unblock") {
    if (op === "block") dropPendingTo(ctx, next, me);
    // Chặn và bỏ chặn vào sổ thu hồi độc lập; hàng hội thoại nhớ số thứ tự của dòng đó để việc nạp lại sau restore đúng thứ tự.
    const entry = journalRevocation(ctx, op === "block" ? "thread_blocked" : "thread_unblocked", at, { workspace_id: c.ws, thread_id: t.id, by: me, peer });
    run(ctx.db, "UPDATE msg_threads SET journal_seq = ? WHERE id = ?", entry.seq, t.id);
  }
  return { status: 200, body: threadView(ctx, thread(ctx, t.id) as ThreadRow, me), resource: { type: "msg_thread", id: t.id } };
}

/** Điều kiện để gửi tới người kia ngay lúc này; mọi lý do không đạt đều ra cùng một lỗi. */
function requireDeliverable(ctx: Ctx, t: ThreadRow, me: string) {
  const ks = deliverable(ctx, t, me);
  if (!ks) throw unavailable();
  return ks;
}

function threadKeys(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const t = threadFor(ctx, c.ws, c.params.thread_id, c.p.sub);
  const ks = requireDeliverable(ctx, t, c.p.sub);
  return { status: 200, body: { thread_id: t.id, endpoints: ks.endpoints, key_set: ks.key_set } };
}

// ── Gửi, hộp thư, xác nhận, mốc đã đọc ────────────────────────────────────────────────────────────────────────────────────────

/** 30 tin một phút và 500 tin một ngày cho mỗi người, đếm trên các tin máy chủ còn giữ (30 ngày) theo đồng hồ của app. */
function sendLimit(ctx: Ctx, ws: string, user: string) {
  const now = ctx.clock.now();
  const windows: [number, number][] = [[MINUTE, MESSAGING_LIMITS.sendsPerMinute], [DAY, MESSAGING_LIMITS.sendsPerDay]];
  for (const [span, max] of windows) {
    // Tin thứ `max` tính từ mới nhất trong cửa sổ: khi nó ra khỏi cửa sổ thì gửi tiếp được.
    const edge = one<{ sent_at: string }>(ctx.db, "SELECT sent_at FROM msg_messages WHERE workspace_id = ? AND sender_user = ? AND sent_at > ? ORDER BY sent_at DESC LIMIT 1 OFFSET ?", ws, user, iso(now - span), max - 1);
    if (edge) throw new ApiError(429, "RATE_LIMITED", { retryable: true, headers: { "Retry-After": String(Math.max(1, Math.ceil((Date.parse(edge.sent_at) + span - now) / 1000))) } });
  }
}

function send(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const t = threadFor(ctx, c.ws, c.params.thread_id, me);
  const b = c.body as SendBody;
  const ep = ownEndpoint(ctx, c.ws, me, b.sender_endpoint);
  // Bằng chứng trước mọi lời từ chối: nếu client_ref này đã được lưu thì nói vậy, kể cả khi hội thoại vừa đóng. Thiết bị đang ở
  // «chưa rõ đã gửi hay chưa» nhờ đó biết chắc tin đã tới, thay vì bị báo sai là chưa gửi.
  const dup = one<{ id: string }>(ctx.db, "SELECT id FROM msg_messages WHERE sender_endpoint = ? AND client_ref = ?", ep.id, b.client_ref);
  if (dup) throw new ApiError(409, "DUPLICATE_MESSAGE", { extra: { resource_id: dup.id } });
  const ks = requireDeliverable(ctx, t, me);
  sendLimit(ctx, c.ws, me);
  // Tập khóa đã đổi (thêm hoặc gỡ thiết bị): từ chối dứt khoát, không lưu gì. Thiết bị lấy lại khóa và niêm phong lại.
  if (b.key_set !== ks.key_set) throw new ApiError(409, "KEYS_CHANGED");
  const iv = fromB64urlStrict(b.iv);
  const ct = fromB64urlStrict(b.ct);
  const padded = ct ? ct.length - MESSAGING_LIMITS.tagBytes : 0;
  if (!iv || iv.length !== MESSAGING_LIMITS.ivBytes || !ct || padded < MESSAGING_LIMITS.blockBytes || padded > MESSAGING_LIMITS.maxPaddedBytes || padded % MESSAGING_LIMITS.blockBytes !== 0) throw invalid();
  // Đúng một phong bì cho mỗi điểm nhận tin đang dùng của cả hai người, kể cả thiết bị đang gửi.
  const ids = b.envelopes.map((e) => e.endpoint_id);
  if (ids.length !== ks.endpoints.length || new Set(ids).size !== ids.length || ks.endpoints.some((e) => !ids.includes(e.endpoint_id))) throw invalid();
  for (const e of b.envelopes) {
    const enc = fromB64urlStrict(e.enc);
    const wrapped = fromB64urlStrict(e.wrapped);
    if (!enc || enc.length !== MESSAGING_LIMITS.publicKeyBytes || enc[0] !== 4 || !wrapped || wrapped.length !== MESSAGING_LIMITS.wrappedBytes) throw invalid();
  }
  const at = nowIso(ctx);
  const id = `msg_${uuid()}`;
  const seq = t.last_seq + 1;
  if (Number(run(ctx.db, "UPDATE msg_threads SET last_seq = ? WHERE id = ? AND last_seq = ?", seq, t.id, t.last_seq).changes) !== 1) throw new ApiError(409, "REQUEST_IN_PROGRESS", { retryable: true, headers: { "Retry-After": "1" } });
  run(ctx.db, "INSERT INTO msg_messages (id, workspace_id, thread_id, seq, sender_user, sender_endpoint, client_ref, iv, ct, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", id, c.ws, t.id, seq, me, ep.id, b.client_ref, b.iv, b.ct, at);
  for (const e of b.envelopes) run(ctx.db, "INSERT INTO msg_envelopes (message_id, endpoint_id, enc, wrapped) VALUES (?, ?, ?, ?)", id, e.endpoint_id, e.enc, e.wrapped);
  // Phản hồi chỉ có mã và thời điểm (bản ghi idempotency giữ nó lâu hơn nội dung); không có audit cho từng tin.
  return { status: 201, body: { message_id: id, seq, sent_at: at }, resource: { type: "msg_message", id } };
}

function inbox(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const endpointId = c.query.get("endpoint") ?? "";
  const etag = c.query.get("etag");
  if (!ENDPOINT_RE.test(endpointId) || (etag !== null && !DIGEST_RE.test(etag))) throw invalid();
  const ep = ownEndpoint(ctx, c.ws, me, endpointId);
  const threads = threadsOf(ctx, c.ws, me).map((t) => threadView(ctx, t, me));
  const endpoints = endpointsOf(ctx, c.ws, me).map(endpointView);
  const rows = all<MessageRow & { enc: string; wrapped: string }>(ctx.db,
    "SELECT m.*, e.enc, e.wrapped FROM msg_envelopes e JOIN msg_messages m ON m.id = e.message_id WHERE e.endpoint_id = ? ORDER BY m.sent_at, m.thread_id, m.seq LIMIT ?", ep.id, MESSAGING_LIMITS.inboxPage + 1);
  const more = rows.length > MESSAGING_LIMITS.inboxPage;
  const messages = rows.slice(0, MESSAGING_LIMITS.inboxPage).map((m) => ({
    message_id: m.id, thread_id: m.thread_id, seq: m.seq, sender_user: m.sender_user, sender_endpoint: m.sender_endpoint, client_ref: m.client_ref,
    iv: m.iv as string, ct: m.ct as string, enc: m.enc, wrapped: m.wrapped, sent_at: m.sent_at,
  }));
  // Thăm dò bằng GET thường (LNH-T35): thiết bị gửi lại etag lần trước; không có gì đổi thì chỉ nhận lại đúng etag đó.
  const tag = digestJcs({ endpoints, messages: messages.map((m) => m.message_id), more, threads });
  if (etag === tag) return { status: 200, body: { etag: tag, changed: false } };
  return { status: 200, body: { etag: tag, changed: true, threads, endpoints, messages, more } };
}

/** Mốc «đã tới thiết bị» của `user` trong một hội thoại: tin mới nhất của người kia đã được lưu mà trước nó không còn tin nào chưa lưu. */
function raiseDelivered(ctx: Ctx, threadId: string, user: string) {
  const gap = one<{ seq: number | null }>(ctx.db, "SELECT MIN(seq) AS seq FROM msg_messages WHERE thread_id = ? AND sender_user <> ? AND delivered_at IS NULL", threadId, user)?.seq ?? null;
  const top = (gap === null
    ? one<{ seq: number | null }>(ctx.db, "SELECT MAX(seq) AS seq FROM msg_messages WHERE thread_id = ? AND sender_user <> ? AND delivered_at IS NOT NULL", threadId, user)
    : one<{ seq: number | null }>(ctx.db, "SELECT MAX(seq) AS seq FROM msg_messages WHERE thread_id = ? AND sender_user <> ? AND delivered_at IS NOT NULL AND seq < ?", threadId, user, gap))?.seq ?? 0;
  const m = markOf(ctx, threadId, user);
  if (top > m.delivered_seq) setMark(ctx, threadId, user, { ...m, delivered_seq: top });
}

function ack(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const b = c.body as { endpoint_id: string; message_ids: string[] };
  const ep = ownEndpoint(ctx, c.ws, me, b.endpoint_id);
  const at = nowIso(ctx);
  const touched = new Set<string>();
  let acked = 0;
  for (const id of new Set(b.message_ids)) {
    // Chỉ phong bì của chính thiết bị này: mã lạ, mã của người khác hay mã đã xác nhận đều bị bỏ qua, không lộ gì.
    const m = one<MessageRow>(ctx.db, "SELECT m.* FROM msg_messages m JOIN msg_envelopes e ON e.message_id = m.id WHERE m.id = ? AND e.endpoint_id = ?", id, ep.id);
    if (!m) continue;
    run(ctx.db, "DELETE FROM msg_envelopes WHERE message_id = ? AND endpoint_id = ?", m.id, ep.id);
    acked++;
    if (m.sender_user !== me && !m.delivered_at) {
      run(ctx.db, "UPDATE msg_messages SET delivered_at = ? WHERE id = ?", at, m.id);
      touched.add(m.thread_id);
    }
    scrub(ctx, [m.id]);
  }
  for (const threadId of touched) raiseDelivered(ctx, threadId, me);
  return { status: 200, body: { acked }, resource: { type: "msg_endpoint", id: ep.id } };
}

function markRead(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const t = threadFor(ctx, c.ws, c.params.thread_id, me);
  const b = c.body as { through_seq: number; share: boolean };
  if (b.through_seq > t.last_seq) throw invalid();
  const m = markOf(ctx, t.id, me);
  setMark(ctx, t.id, me, {
    delivered_seq: m.delivered_seq,
    read_seq: Math.max(m.read_seq, b.through_seq),
    // Chỉ khi người đọc bật chia sẻ, và không vượt quá những gì một thiết bị của họ đã xác nhận lưu.
    read_shared_seq: b.share ? Math.max(m.read_shared_seq, Math.min(b.through_seq, m.delivered_seq)) : m.read_shared_seq,
  });
  return { status: 200, body: threadView(ctx, t, me), resource: { type: "msg_thread", id: t.id } };
}

// ── Báo cáo không kèm nội dung ────────────────────────────────────────────────────────────────────────────────────────────────

function report(c: Call): Stored {
  const { ctx } = c.d;
  gate(c);
  const me = c.p.sub;
  const b = c.body as { thread_id: string; reason: "SPAM" | "HARASSMENT" | "OTHER"; message_id?: string };
  const t = threadFor(ctx, c.ws, b.thread_id, me);
  const peer = peerOf(t, me);
  if (b.message_id !== undefined && !one(ctx.db, "SELECT 1 FROM msg_messages WHERE id = ? AND thread_id = ? AND sender_user = ?", b.message_id, t.id, peer)) throw notFound();
  const now = ctx.clock.now();
  const today = one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM msg_reports WHERE workspace_id = ? AND reporter = ? AND at > ?", c.ws, me, iso(now - DAY)) as { n: number };
  if (today.n >= MESSAGING_LIMITS.reportsPerDay) throw new ApiError(429, "RATE_LIMITED");
  const id = `rp_${uuid()}`;
  const at = iso(now);
  // Không có chữ nào của tin: máy chủ không đọc được tin, và người báo cáo không gửi kèm nội dung.
  run(ctx.db, "INSERT INTO msg_reports (id, workspace_id, reporter, reported, thread_id, message_id, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, c.ws, me, peer, t.id, b.message_id ?? null, b.reason, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: me, action: "messaging.report", target: id, request_id: c.requestId, data: { reason: b.reason } });
  return { status: 201, body: { report_id: id }, resource: { type: "msg_report", id } };
}

function opsReports(c: Call): Stored {
  const { ctx } = c.d;
  // Quản trị workspace xem báo cáo cả khi cờ mô-đun đang tắt. Tạm ngừng một người là thu hồi quyền messaging.use của họ bằng
  // POST /v1/grants/{grant_id}/revoke có sẵn (đã an toàn với restore).
  requireRole(requireMember(ctx, c.ws, c.p.sub), "WORKSPACE_ADMIN");
  const reports = all<{ id: string; reporter: string; reported: string; thread_id: string; message_id: string | null; reason: string; at: string }>(ctx.db,
    "SELECT id, reporter, reported, thread_id, message_id, reason, at FROM msg_reports WHERE workspace_id = ? ORDER BY at DESC, id LIMIT ?", c.ws, MESSAGING_LIMITS.opsReports);
  const counts = all<{ user_id: string; count: number }>(ctx.db, "SELECT reported AS user_id, COUNT(*) AS count FROM msg_reports WHERE workspace_id = ? GROUP BY reported ORDER BY count DESC, reported", c.ws);
  return {
    status: 200,
    body: {
      reports: reports.map((r) => ({ report_id: r.id, reporter: r.reporter, reported: r.reported, thread_id: r.thread_id, message_id: r.message_id, reason: r.reason, at: r.at })),
      reported: counts.map((r) => ({ user_id: r.user_id, count: r.count, grant_id: activeGrant(ctx, c.ws, r.user_id, GATE.scope, null)?.id ?? null })),
    },
  };
}

// ── Mất quyền dùng, xóa dữ liệu, dọn theo hạn ─────────────────────────────────────────────────────────────────────────────────

/**
 * Người này không còn dùng được nhắn tin (mất tư cách thành viên, quyền hoặc đồng ý): gỡ mọi điểm nhận tin của họ, xóa phong bì
 * đang chờ giao tới họ, đóng các hội thoại đang mời hoặc đang mở (cạnh revoke của AUTHORITY). Tin họ đã gửi trước đó vẫn được
 * giao. Lặp lại an toàn; không ghi sổ thu hồi vì nguyên nhân đã có dòng của lõi.
 */
function closeOut(ctx: Ctx, ws: string, user: string, at: string): boolean {
  let changed = false;
  for (const e of activeEndpoints(ctx, ws, user)) changed = revokeEndpointRow(ctx, e.id, at) || changed;
  for (const t of threadsOf(ctx, ws, user)) if (step(ctx, t, "revoke", ["AUTHORITY"], at, { reopen_by: null })) changed = true;
  return changed;
}

const enforce = (ctx: Ctx, ws: string, user: string, at: string) => (entitled(ctx, ws, user) ? false : closeOut(ctx, ws, user, at));

/** Xóa mọi thứ máy chủ còn giữ từ hoặc tới một người: hội thoại, tin, phong bì, mốc, điểm nhận tin, báo cáo, dấu chống lặp. */
function purgeMember(ctx: Ctx, ws: string, user: string): number {
  let n = 0;
  const del = (sql: string, ...args: (string | number | null)[]) => (n += Number(run(ctx.db, sql, ...args).changes));
  for (const t of threadsOf(ctx, ws, user)) {
    del("DELETE FROM msg_envelopes WHERE message_id IN (SELECT id FROM msg_messages WHERE thread_id = ?)", t.id);
    del("DELETE FROM msg_messages WHERE thread_id = ?", t.id);
    del("DELETE FROM msg_marks WHERE thread_id = ?", t.id);
    del("DELETE FROM msg_threads WHERE id = ?", t.id);
    // Dấu chống lặp của cả hai người cho hội thoại này: phản hồi đã lưu của chúng còn mã tin, thời điểm và tên người kia. Dòng
    // tạo hội thoại nằm ở route /v1/messages/threads (không mang mã hội thoại) nên tìm theo tài nguyên đã ghi.
    const prefix = `/v1/messages/threads/${t.id}/`;
    del("DELETE FROM idem_keys WHERE workspace_id = ? AND (substr(route, 1, ?) = ? OR (resource_type = 'msg_thread' AND resource_id = ?))", ws, prefix.length, prefix, t.id);
  }
  del("DELETE FROM msg_envelopes WHERE endpoint_id IN (SELECT id FROM msg_endpoints WHERE workspace_id = ? AND user_id = ?)", ws, user);
  del("DELETE FROM msg_endpoints WHERE workspace_id = ? AND user_id = ?", ws, user);
  del("DELETE FROM msg_reports WHERE workspace_id = ? AND (reporter = ? OR reported = ?)", ws, user, user);
  del("DELETE FROM idem_keys WHERE workspace_id = ? AND actor = ? AND substr(route, 1, 13) = '/v1/messages/'", ws, user);
  return n;
}

/** Dọn theo hạn 30 ngày (LNH-T32) và đóng phần của những người đã mất quyền dùng. `now` từ đồng hồ tiêm được. */
function sweep(ctx: Ctx, now: number) {
  const cutoff = iso(now - MESSAGING_LIMITS.retentionMs);
  const at = iso(now);
  tx(ctx.db, () => {
    run(ctx.db, "DELETE FROM msg_envelopes WHERE message_id IN (SELECT id FROM msg_messages WHERE sent_at < ?)", cutoff);
    run(ctx.db, "DELETE FROM msg_messages WHERE sent_at < ?", cutoff);
    // Dấu chống lặp của /v1/messages/* đi cùng tin ở 30 ngày, sớm hơn 90 ngày của lõi: sau hạn này máy chủ không còn nhận ra
    // một lần gửi lại, nên hộp gửi trên thiết bị không cho thử lại quá 7 ngày (web/shared/msg-outbox.js).
    run(ctx.db, "DELETE FROM idem_keys WHERE substr(route, 1, 13) = '/v1/messages/' AND received_at < ?", cutoff);
    run(ctx.db, "DELETE FROM msg_endpoints WHERE status = 'REVOKED' AND revoked_at < ?", cutoff);
    run(ctx.db, "DELETE FROM msg_reports WHERE at < ?", cutoff);
    // Thu hồi quyền messaging.use không có hook riêng: quét ở đây. (Cổng của mọi route đã chặn người đó ngay từ lúc thu hồi.)
    const users = all<{ workspace_id: string; user_id: string }>(ctx.db, `SELECT workspace_id, user_id FROM msg_endpoints WHERE status = 'ACTIVE'
      UNION SELECT workspace_id, user_lo FROM msg_threads WHERE state IN ('THREAD_REQUESTED','THREAD_ACTIVE')
      UNION SELECT workspace_id, user_hi FROM msg_threads WHERE state IN ('THREAD_REQUESTED','THREAD_ACTIVE')`);
    for (const u of users) enforce(ctx, u.workspace_id, u.user_id, at);
  });
}

/**
 * Phần nhắn tin trong tệp xuất dữ liệu của một người: chỉ siêu dữ liệu. Không có bản mã, không có khóa, không có nội dung (máy
 * chủ không đọc được tin; lịch sử nằm trên từng thiết bị và được xuất ở đó). Trả undefined khi người đó chưa từng dùng nhắn tin.
 */
export function exportMessagingFor(ctx: Ctx, ws: string, user: string) {
  const endpoints = endpointsOf(ctx, ws, user).map((e) => ({ endpoint_id: e.id, kind: e.kind, status: e.status, created_at: e.created_at, revoked_at: e.revoked_at }));
  const mine = threadsOf(ctx, ws, user);
  const threads = mine.map((t) => ({ thread_id: t.id, state: visibleState(t, user), peer_user_id: peerOf(t, user), role: t.requested_by === user ? "REQUESTER" : "ADDRESSEE", created_at: t.created_at }));
  const messages = mine.flatMap((t) => all<{ id: string; seq: number; sender_user: string; sent_at: string }>(ctx.db, "SELECT id, seq, sender_user, sent_at FROM msg_messages WHERE thread_id = ? ORDER BY seq", t.id)
    .map((m) => ({ message_id: m.id, thread_id: t.id, seq: m.seq, direction: m.sender_user === user ? "SENT" : "RECEIVED", sent_at: m.sent_at })));
  const reports = all<{ id: string; thread_id: string; reason: string; at: string }>(ctx.db, "SELECT id, thread_id, reason, at FROM msg_reports WHERE workspace_id = ? AND reporter = ? ORDER BY at, id", ws, user)
    .map((r) => ({ report_id: r.id, thread_id: r.thread_id, reason: r.reason, at: r.at }));
  if (!endpoints.length && !threads.length && !reports.length) return undefined;
  return {
    scope: "Siêu dữ liệu nhắn tin phía máy chủ. Nội dung tin được mã hóa đầu cuối (LNH-MSG-1): máy chủ không đọc được và không xuất được; lịch sử nằm trên từng thiết bị, tối đa 30 ngày.",
    endpoints, threads, messages, reports,
  };
}

// ── Nạp lại sổ thu hồi sau restore ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Nạp lại một dòng chặn hoặc bỏ chặn lên bản restore, chỉ bằng các cạnh của bảng THREAD_. Dòng đã áp (journal_seq của hàng không
 * nhỏ hơn số thứ tự của dòng) bị bỏ qua, nên lặp lại an toàn và một hội thoại được mở lại sau khi bỏ chặn không bị đóng oan.
 */
function replayBlock(ctx: Ctx, e: JournalEntry, block: boolean): boolean {
  const ws = e.workspace_id as string;
  const by = e.by as string;
  const peer = e.peer as string;
  // Tìm theo mã, rồi theo cặp người (hội thoại lập lại sau restore có mã khác).
  let t = thread(ctx, e.thread_id as string) ?? one<ThreadRow>(ctx.db, "SELECT * FROM msg_threads WHERE workspace_id = ? AND user_lo = ? AND user_hi = ?", ws, ...pairOf(by, peer));
  if (!t) {
    // Hội thoại được lập sau bản sao lưu: bỏ chặn thì không còn gì để làm; chặn thì dựng lại hàng để lệnh chặn không mất.
    if (!block) return false;
    run(ctx.db, "INSERT INTO msg_threads (id, workspace_id, user_lo, user_hi, state, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'THREAD_REQUESTED', ?, ?, ?)", e.thread_id as string, ws, ...pairOf(by, peer), peer, e.at, e.at);
    t = thread(ctx, e.thread_id as string) as ThreadRow;
  }
  if (t.workspace_id !== ws || !isParty(t, by) || t.journal_seq >= e.seq) return false;
  if (block) {
    // Lời mời do chính người chặn gửi không có cạnh chặn trực tiếp: Authority đóng nó trước, rồi người đó chặn.
    if (t.state === "THREAD_REQUESTED" && t.requested_by === by) t = step(ctx, t, "revoke", ["AUTHORITY"], e.at, { reopen_by: null }) as ThreadRow;
    const next = step(ctx, t, "block", [t.requested_by === by ? "REQUESTER" : "ADDRESSEE", "MEMBER"], e.at, { blocked_by: by, reopen_by: null });
    if (next) dropPendingTo(ctx, next, by);
  } else if (t.blocked_by === by) step(ctx, t, "unblock", ["BLOCKER"], e.at, { blocked_by: null, reopen_by: by });
  run(ctx.db, "UPDATE msg_threads SET journal_seq = ? WHERE id = ?", e.seq, t.id);
  return true;
}

// ── Route ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Phát lại idempotent của một thao tác trên hội thoại hay tin: người gọi còn qua cổng và vẫn là một bên của hội thoại đó. */
const readableThread = (c: Call, r: { type: string; id: string } | null) => {
  if (!r || !usable(c)) return false;
  const threadId = r.type === "msg_message" ? one<{ thread_id: string }>(c.d.ctx.db, "SELECT thread_id FROM msg_messages WHERE id = ?", r.id)?.thread_id : r.id;
  const t = threadId ? thread(c.d.ctx, threadId) : undefined;
  return !!t && t.workspace_id === c.ws && isParty(t, c.p.sub);
};
const readableEndpoint = (c: Call, r: { type: string; id: string } | null) =>
  !!r && usable(c) && !!one(c.d.ctx.db, "SELECT 1 FROM msg_endpoints WHERE id = ? AND workspace_id = ? AND user_id = ?", r.id, c.ws, c.p.sub);
const readableReport = (c: Call, r: { type: string; id: string } | null) =>
  !!r && usable(c) && !!one(c.d.ctx.db, "SELECT 1 FROM msg_reports WHERE id = ? AND workspace_id = ? AND reporter = ?", r.id, c.ws, c.p.sub);

const ROUTES: Route[] = [
  { method: "GET", path: "/v1/messages/people", handler: people },
  { method: "GET", path: "/v1/messages/endpoints", handler: (c) => (gate(c), { status: 200, body: { endpoints: endpointsOf(c.d.ctx, c.ws, c.p.sub).map(endpointView), limit: MESSAGING_LIMITS.endpointsPerMember } }) },
  { method: "POST", path: "/v1/messages/endpoints", schema: "MsgEndpointCreate", readable: readableEndpoint, handler: registerEndpoint },
  { method: "POST", path: "/v1/messages/endpoints/{endpoint_id}/revoke", schema: "Empty", optionalBody: true, readable: readableEndpoint, handler: revokeEndpoint },
  { method: "POST", path: "/v1/messages/threads", schema: "MsgThreadCreate", readable: readableThread, handler: createThread },
  ...THREAD_OPS.map((op): Route => ({
    method: "POST", path: `/v1/messages/threads/{thread_id}/${op}`, schema: "Empty", optionalBody: true, readable: readableThread, handler: (c) => threadOp(c, op),
  })),
  { method: "GET", path: "/v1/messages/threads/{thread_id}/keys", handler: threadKeys },
  { method: "POST", path: "/v1/messages/threads/{thread_id}/messages", schema: "MsgSend", readable: readableThread, handler: send },
  { method: "POST", path: "/v1/messages/threads/{thread_id}/read", schema: "MsgRead", readable: readableThread, handler: markRead },
  { method: "GET", path: "/v1/messages/inbox", handler: inbox },
  { method: "POST", path: "/v1/messages/ack", schema: "MsgAck", readable: readableEndpoint, handler: ack },
  { method: "POST", path: "/v1/messages/reports", schema: "MsgReportCreate", readable: readableReport, handler: report },
  { method: "GET", path: "/v1/ops/messages/reports", handler: opsReports },
];

export const messaging: ServerModule = {
  name: "messaging",
  routes: ROUTES,
  errors: {
    KEYS_CHANGED: "Danh sách thiết bị của hội thoại đã thay đổi; cần lấy lại khóa trước khi gửi.",
    DUPLICATE_MESSAGE: "Tin nhắn này đã được máy chủ nhận từ trước.",
    RECIPIENT_UNAVAILABLE: "Hiện không gửi được tới người này.",
    ENDPOINT_LIMIT: "Đã đủ 5 thiết bị; hãy gỡ một thiết bị trước khi thêm.",
  },
  /** Dữ liệu mẫu: ba tài khoản thử có quyền messaging.use. Đồng ý KHÔNG được cấp sẵn: người dùng tự bật ở lần mở đầu tiên. */
  seed(ctx) {
    for (const u of DEV_USERS) {
      if (!isActiveMember(ctx, DEMO_WS, u.sub)) continue;
      if (one(ctx.db, "SELECT 1 FROM grants WHERE workspace_id = ? AND user_id = ? AND scope = ?", DEMO_WS, u.sub, GATE.scope)) continue;
      run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, ?, ?, NULL, 'ACTIVE', ?)", `gr_${uuid()}`, DEMO_WS, u.sub, GATE.scope, nowIso(ctx));
    }
  },
  onTick: (ctx, now) => sweep(ctx, now),
  privacy: {
    exportFor: exportMessagingFor,
    deleteFor: (ctx, ws, user) => void purgeMember(ctx, ws, user),
    onConsentWithdrawn(ctx, ws, user, purpose, at) {
      if (purpose === GATE.purpose) closeOut(ctx, ws, user, at);
    },
    onRestrict: (ctx, ws, user, at) => void enforce(ctx, ws, user, at),
  },
  revocations: {
    endpoint_revoked: (ctx, e) => revokeEndpointRow(ctx, e.endpoint_id as string, e.at),
    thread_blocked: (ctx, e) => replayBlock(ctx, e, true),
    thread_unblocked: (ctx, e) => replayBlock(ctx, e, false),
    // Dòng của lõi, chạy sau phần của lõi: nếu sau khi nạp lại người đó không còn dùng được nhắn tin thì đóng phần của họ.
    consent_withdrawn: (ctx, e) => e.purpose_id === GATE.purpose && enforce(ctx, e.workspace_id as string, e.user_id as string, e.at),
    grant_revoked: (ctx, e) => enforce(ctx, e.workspace_id as string, e.user_id as string, e.at),
    member_deleted: (ctx, e) => purgeMember(ctx, e.workspace_id as string, e.user_id as string) > 0,
  },
};
