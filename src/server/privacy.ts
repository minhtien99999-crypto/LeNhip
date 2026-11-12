// Quyền của chủ thể dữ liệu (SRS mục 09, PRIV02, RET01, T19). Hạn nội bộ là mục tiêu phục vụ, không thay hạn luật: tiếp nhận 2 ngày
// làm việc; xem/sửa/cung cấp ≤7 ngày trong trần 10; rút lại/hạn chế ≤7 trong trần 15; xóa ≤10 trong trần 20; export là liên kết
// một lần hết hạn 24 giờ. Ngày nghỉ lễ chưa có trong lịch làm việc (LNH-Q05). Xóa giữ phần tối thiểu cần đối soát/chống lặp theo
// cơ sở CLO duyệt (LNH-Q04) và ghi tombstone vào kho độc lập để không phục sinh khi restore.
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../core/errors.ts";
import { uuid } from "../core/crypto.ts";
import { addDays, weekdayOf, zonedToInstant, localDate } from "../../web/shared/zone.js";
import { type Ctx, nowIso } from "./context.ts";
import { bumpAuthz, consentView, consentWithdrawn, requireMember, type ConsentRow, type Purpose } from "./authority.ts";
import { all, audit, one, run, tx } from "./store.ts";

export type PrivacyType = "ACCESS" | "CORRECT" | "RESTRICT" | "WITHDRAW" | "DELETE" | "EXPORT";

const DAYS: Record<PrivacyType, { target: number; legal: number }> = {
  ACCESS: { target: 7, legal: 10 }, CORRECT: { target: 7, legal: 10 }, EXPORT: { target: 7, legal: 10 },
  RESTRICT: { target: 7, legal: 15 }, WITHDRAW: { target: 7, legal: 15 }, DELETE: { target: 10, legal: 20 },
};
const OPS_ZONE = "Asia/Ho_Chi_Minh";

/** Cộng n ngày làm việc (thứ Hai–thứ Sáu, giờ Việt Nam), hạn là cuối ngày làm việc đó. */
export function addWorkingDays(ms: number, n: number) {
  let date = localDate(ms, OPS_ZONE);
  let left = n;
  while (left > 0) {
    date = addDays(date, 1);
    const wd = weekdayOf(date);
    if (wd !== 0 && wd !== 6) left--;
  }
  return zonedToInstant(date, "17:00", OPS_ZONE);
}

const iso = (ms: number) => new Date(ms).toISOString();

interface RequestRow {
  id: string;
  workspace_id: string;
  user_id: string;
  type: PrivacyType;
  status: string;
  received_at: string;
  ack_due_at: string;
  target_due_at: string;
  legal_due_at: string;
}

function view(r: RequestRow, exportLink: { path: string; expires_at: string } | null = null) {
  return { request_id: r.id, type: r.type, status: r.status, received_at: r.received_at, ack_due_at: r.ack_due_at, target_due_at: r.target_due_at, legal_due_at: r.legal_due_at, export: exportLink };
}

export function createPrivacyRequest(ctx: Ctx, ws: string, user: string, body: { type: PrivacyType; note?: string }, authTime: number | null, requestId: string | null) {
  requireMember(ctx, ws, user);
  const now = ctx.clock.now();
  if ((body.type === "EXPORT" || body.type === "DELETE") && (authTime === null || now / 1000 - authTime > ctx.config.reauthMaxAgeS)) {
    throw new ApiError(401, "REAUTH_REQUIRED");
  }
  return tx(ctx.db, () => {
    const id = `pr_${uuid()}`;
    const d = DAYS[body.type];
    run(ctx.db, "INSERT INTO privacy_requests (id, workspace_id, user_id, type, status, note, received_at, ack_due_at, target_due_at, legal_due_at) VALUES (?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?, ?)",
      id, ws, user, body.type, body.note ?? null, iso(now), iso(addWorkingDays(now, 2)), iso(now + d.target * 86_400_000), iso(now + d.legal * 86_400_000));
    audit(ctx.db, iso(now), { workspace_id: ws, actor: user, action: `privacy.${body.type.toLowerCase()}`, target: id, request_id: requestId });
    let link: { path: string; expires_at: string } | null = null;
    if (body.type === "EXPORT") link = makeExport(ctx, ws, user, id);
    if (body.type === "RESTRICT" || body.type === "WITHDRAW") restrict(ctx, ws, user);
    if (body.type === "DELETE") deleteUserData(ctx, ws, user);
    const status = body.type === "EXPORT" || body.type === "DELETE" ? "COMPLETED" : body.type === "RESTRICT" || body.type === "WITHDRAW" ? "IN_PROGRESS" : "RECEIVED";
    run(ctx.db, "UPDATE privacy_requests SET status = ?, completed_at = ? WHERE id = ?", status, status === "COMPLETED" ? iso(now) : null, id);
    return view(one<RequestRow>(ctx.db, "SELECT * FROM privacy_requests WHERE id = ?", id) as RequestRow, link);
  });
}

export function getPrivacyRequest(ctx: Ctx, ws: string, user: string, id: string) {
  const r = one<RequestRow>(ctx.db, "SELECT * FROM privacy_requests WHERE id = ? AND workspace_id = ? AND user_id = ?", id, ws, user);
  if (!r) throw new ApiError(404, "NOT_FOUND");
  return view(r);
}

/** Chặn tác vụ mới ngay khi ghi nhận hợp lệ: rút mọi đồng ý phía máy chủ, vô hiệu plan chưa claim. */
function restrict(ctx: Ctx, ws: string, user: string) {
  const at = nowIso(ctx);
  const active = all<ConsentRow>(ctx.db, "SELECT * FROM consents WHERE workspace_id = ? AND user_id = ? AND choice = 'GRANTED' AND withdrawn_at IS NULL", ws, user);
  for (const c of active) {
    run(ctx.db, "UPDATE consents SET withdrawn_at = ? WHERE id = ?", at, c.id);
    ctx.revocations.append("consent_withdrawn", at, { workspace_id: ws, user_id: user, purpose_id: c.purpose_id });
  }
  bumpAuthz(ctx, ws, user, "PRIVACY_RESTRICT", user, { purposes: active.map((c) => c.purpose_id as Purpose) });
  // Mô-đun: từng đồng ý vừa bị rút, rồi việc hạn chế nói chung (kể cả khi người đó không có đồng ý nào đang hiệu lực).
  for (const c of active) consentWithdrawn(ctx, ws, user, c.purpose_id, at);
  for (const m of ctx.modules) m.privacy?.onRestrict?.(ctx, ws, user, at);
}

function makeExport(ctx: Ctx, ws: string, user: string, requestId: string) {
  const now = ctx.clock.now();
  const token = randomBytes(32).toString("base64url");
  const actions = all<Record<string, unknown>>(ctx.db,
    "SELECT action_id, id AS plan_id, kind, state, outcome, evidence_grade, created_at, authorized_at, terminal_at FROM actions WHERE workspace_id = ? AND actor = ? ORDER BY created_at", ws, user);
  const consents = all<ConsentRow>(ctx.db, "SELECT * FROM consents WHERE workspace_id = ? AND user_id = ? ORDER BY at", ws, user).map(consentView);
  // Phần của từng mô-đun (ServerModule.privacy.exportFor), theo tên mô-đun. Chưa mô-đun nào có dữ liệu thì không có khóa `modules`.
  const modules: Record<string, unknown> = {};
  for (const m of ctx.modules) if (m.privacy?.exportFor) modules[m.name] = m.privacy.exportFor(ctx, ws, user);
  const body = {
    generated_at: iso(now), workspace_id: ws, subject: user,
    scope: "Dữ liệu phía máy chủ LeNhip. Dữ liệu sức khỏe nằm trên điện thoại: xuất bằng chức năng exportLocalData() của app.",
    actions, consents,
    grants: all(ctx.db, "SELECT id, scope, resource, status, created_at, revoked_at FROM grants WHERE workspace_id = ? AND user_id = ?", ws, user),
    privacy_requests: all(ctx.db, "SELECT id, type, status, received_at FROM privacy_requests WHERE workspace_id = ? AND user_id = ?", ws, user),
    ...(Object.keys(modules).length ? { modules } : {}),
  };
  run(ctx.db, "INSERT INTO exports (token_hash, request_id, workspace_id, user_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    createHash("sha256").update(token).digest("hex"), requestId, ws, user, JSON.stringify(body), iso(now), iso(now + ctx.config.exportLinkMs));
  return { path: `/v1/privacy/exports/${token}`, expires_at: iso(now + ctx.config.exportLinkMs) };
}

/** Tải export một lần: tệp bị xóa sau khi tải hoặc khi hết hạn. */
export function downloadExport(ctx: Ctx, ws: string, user: string, token: string) {
  return tx(ctx.db, () => {
    const h = createHash("sha256").update(token).digest("hex");
    const e = one<{ user_id: string; workspace_id: string; body: string | null; expires_at: string; used_at: string | null }>(ctx.db, "SELECT * FROM exports WHERE token_hash = ?", h);
    if (!e || e.user_id !== user || e.workspace_id !== ws) throw new ApiError(404, "NOT_FOUND");
    if (e.used_at || !e.body || nowIso(ctx) > e.expires_at) throw new ApiError(410, "LINK_EXPIRED");
    run(ctx.db, "UPDATE exports SET used_at = ?, body = NULL WHERE token_hash = ?", nowIso(ctx), h);
    return JSON.parse(e.body);
  });
}

/** Xóa tệp export quá hạn (SRS mục 09: xóa file xuất sau 24 giờ). */
export function purgeExports(ctx: Ctx) {
  return Number(run(ctx.db, "UPDATE exports SET body = NULL WHERE body IS NOT NULL AND expires_at < ?", nowIso(ctx)).changes);
}

/**
 * Xóa dữ liệu phía máy chủ của một người. Giữ có giới hạn: action chưa có kết quả cuối (đối soát), action đã kết thúc trong 90 ngày
 * ở dạng tối thiểu (digest, trạng thái, thời điểm) để chống lặp, biên nhận đồng ý (bằng chứng). Danh tính được thay bằng mã
 * không liên kết được trong bản giữ lại. Ghi tombstone vào kho độc lập.
 */
export function deleteUserData(ctx: Ctx, ws: string, user: string) {
  const at = nowIso(ctx);
  const cutoff = iso(ctx.clock.now() - 90 * 86_400_000);
  tx(ctx.db, () => {
    run(ctx.db, "UPDATE grants SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, 'privacy.delete') WHERE workspace_id = ? AND user_id = ?", at, ws, user);
    run(ctx.db, "UPDATE consents SET withdrawn_at = COALESCE(withdrawn_at, ?) WHERE workspace_id = ? AND user_id = ?", at, ws, user);
    run(ctx.db, "UPDATE calendar_links SET status = 'UNLINKED', tenant_id = '-', object_id = '-' WHERE workspace_id = ? AND user_id = ?", ws, user);
    bumpAuthz(ctx, ws, user, "MEMBER_DELETED", "privacy.delete", {});
    run(ctx.db, "UPDATE members SET status = 'LEFT', display_name = '(đã xóa)' WHERE workspace_id = ? AND user_id = ?", ws, user);
    // Action đã kết thúc quá 90 ngày: xóa hẳn. Còn lại: bỏ đầu vào, giữ payload tối thiểu đã băm để đối soát và chống lặp.
    const old = all<{ id: string }>(ctx.db, "SELECT id FROM actions WHERE workspace_id = ? AND actor = ? AND terminal_at IS NOT NULL AND terminal_at < ?", ws, user, cutoff);
    for (const r of old) {
      for (const t of ["action_events", "evidence", "receipts", "tickets", "checks", "outbox"]) run(ctx.db, `DELETE FROM ${t} WHERE plan_id = ?`, r.id);
      run(ctx.db, "DELETE FROM actions WHERE id = ?", r.id);
    }
    run(ctx.db, "UPDATE actions SET input = '{}' WHERE workspace_id = ? AND actor = ?", ws, user);
    run(ctx.db, "UPDATE idem_keys SET body = NULL, status = NULL, tombstone = 1 WHERE workspace_id = ? AND actor = ?", ws, user);
    run(ctx.db, "UPDATE exports SET body = NULL WHERE workspace_id = ? AND user_id = ?", ws, user);
    // Mô-đun xóa phần của mình trong cùng giao dịch, trước tombstone: lỗi ở đây thì không có gì được coi là đã xóa.
    for (const m of ctx.modules) m.privacy?.deleteFor?.(ctx, ws, user, at);
    ctx.revocations.append("member_deleted", at, { workspace_id: ws, user_id: user });
    audit(ctx.db, at, { workspace_id: ws, actor: "privacy.delete", action: "member.delete", target: createHash("sha256").update(`${ws}:${user}`).digest("hex").slice(0, 16) });
  });
}

