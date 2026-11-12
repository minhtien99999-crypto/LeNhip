// Authority của miền đích (SRS mục 14, 15): thành viên, quyền, đồng ý, chính sách xuất, binding của đích và snapshot phiên bản.
// Mọi thay đổi quyền hoặc policy phân quyền tăng authz_version của chủ thể bị ảnh hưởng (LNH-T04: theo thành viên, không theo
// cả workspace) và vô hiệu các plan PENDING/AUTHORIZED liên quan trước điểm claim.
import { ApiError } from "../core/errors.ts";
import { digestJcs, uuid } from "../core/crypto.ts";
import { type Ctx, nowIso } from "./context.ts";
import { apply, type ActionRow } from "./machine.ts";
import { all, audit, one, run, tx } from "./store.ts";
import type { ModuleName } from "./control.ts";
import type { KindSpec } from "./modules.ts";

/** Ba loại tác vụ của lõi. Loại do mô-đun khai (KindSpec trong modules.ts) là chuỗi khác, tra bằng kindRule(). */
export type Kind = "calendar.block" | "device.set_power" | "robot.simulate";
/** Mục đích đồng ý có xử lý phía máy chủ. Hai mục cuối thêm ở V1.0.0 (LNH-T36, LNH-T45), bảng consents nhận chúng từ migration 0002. */
export type Purpose = "calendar_link" | "home_control" | "beta_telemetry" | "messaging" | "social_post";
/** Phạm vi quyền. Hai mục cuối thêm ở V1.0.0 (LNH-T36, LNH-T45), bảng grants nhận chúng từ migration 0002. */
export type GrantScope = "calendar.block" | "home.control" | "robot.simulate" | "messaging.use" | "social.post";

export const KINDS: Kind[] = ["calendar.block", "device.set_power", "robot.simulate"];
export const PURPOSES: readonly Purpose[] = ["calendar_link", "home_control", "beta_telemetry", "messaging", "social_post"];
export const GRANT_SCOPES: readonly GrantScope[] = ["calendar.block", "home.control", "robot.simulate", "messaging.use", "social.post"];
export const SCOPE_FOR: Record<Kind, GrantScope> = { "calendar.block": "calendar.block", "device.set_power": "home.control", "robot.simulate": "robot.simulate" };
export const PURPOSE_FOR: Record<Kind, Purpose | null> = { "calendar.block": "calendar_link", "device.set_power": "home_control", "robot.simulate": null };
export const MODULE_FOR: Record<Kind, ModuleName> = { "calendar.block": "calendar", "device.set_power": "home", "robot.simulate": "robot" };

/** Loại tác vụ do một mô-đun khai, nếu có. */
export function moduleKind(ctx: Ctx, kind: string): KindSpec | undefined {
  for (const m of ctx.modules) for (const k of m.kinds ?? []) if (k.kind === kind) return k;
  return undefined;
}

/** Quyền, mục đích đồng ý và cờ mô-đun của một loại tác vụ, lõi hay mô-đun. Loại không ai khai trả undefined: bên gọi phải từ chối. */
export function kindRule(ctx: Ctx, kind: string): { scope: GrantScope; purpose: Purpose | null; module: ModuleName } | undefined {
  if (Object.hasOwn(SCOPE_FOR, kind)) {
    const k = kind as Kind;
    return { scope: SCOPE_FOR[k], purpose: PURPOSE_FOR[k], module: MODULE_FOR[k] };
  }
  return moduleKind(ctx, kind);
}

export const DEFAULT_EXPORT_POLICY = {
  policy_version: "2026-11-11.1",
  kinds: {
    "calendar.block": {
      purpose: "calendar_link",
      fields: ["calendar_ref", "start", "end", "zone", "title_code", "visibility"],
      max_minutes: 240,
      horizon_days: 14,
      residual_inference: "Lịch công việc thấy thời điểm và độ dài khung giờ riêng; tiêu đề cố định PERSONAL_TIME, không mang lý do hay nguồn sức khỏe.",
    },
    "device.set_power": {
      purpose: "home_control",
      fields: ["site", "device_ref", "command"],
      residual_inference: "Site thấy thời điểm bật/tắt đèn của người dùng.",
    },
    "robot.simulate": { purpose: null, fields: ["scenario"], residual_inference: "Không có: kịch bản mô phỏng, không có thiết bị thật." },
  },
};

export interface MemberRow {
  workspace_id: string;
  user_id: string;
  display_name: string;
  roles: string;
  status: string;
  authz_version: number;
}

export interface DeviceRow {
  device_ref: string;
  workspace_id: string;
  site_id: string;
  name: string;
  fabric_id: string;
  node_id: string;
  endpoint: number;
  clusters: string;
  capabilities: string;
  vendor_id: string;
  product_id: string;
  firmware: string;
  certificate_id: string;
  binding_version: number;
  status: "ACTIVE" | "QUARANTINED" | "DECOMMISSIONED";
  commissioned_by: string;
  commissioned_at: string;
  updated_at: string;
}

export interface CalendarLinkRow {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: string;
  tenant_id: string;
  object_id: string;
  calendar_ref: string;
  scope: string;
  binding_version: number;
  status: "ACTIVE" | "UNLINKED";
  linked_at: string;
}

/** Chính sách xuất của một workspace: ba loại của lõi cùng mục của các loại do mô-đun khai. */
export type ExportPolicyDoc = typeof DEFAULT_EXPORT_POLICY & { kinds: Record<string, { purpose: string | null; fields: string[]; residual_inference: string }> };

/** Mục chính sách xuất của một loại do mô-đun khai, cùng dạng với ba mục của lõi. */
export const policyEntry = (k: KindSpec) => ({ purpose: k.purpose, fields: k.exportPolicy.fields, residual_inference: k.exportPolicy.residual_inference });

/** Chính sách xuất cho workspace mới: mặc định của lõi cộng mục của mọi loại tác vụ đã đăng ký. */
export function defaultExportPolicy(ctx: Ctx): ExportPolicyDoc {
  const kinds: ExportPolicyDoc["kinds"] = { ...DEFAULT_EXPORT_POLICY.kinds };
  for (const m of ctx.modules) for (const k of m.kinds ?? []) kinds[k.kind] = policyEntry(k);
  return { ...DEFAULT_EXPORT_POLICY, kinds };
}

export const member = (ctx: Ctx, ws: string, user: string) => one<MemberRow>(ctx.db, "SELECT * FROM members WHERE workspace_id = ? AND user_id = ?", ws, user);
/** Thành viên còn ACTIVE; dùng cho `readable` của route (phát lại idempotent vẫn qua quyền đọc hiện hành). */
export const isActiveMember = (ctx: Ctx, ws: string, user: string) => member(ctx, ws, user)?.status === "ACTIVE";
export const roles = (m: MemberRow) => JSON.parse(m.roles) as string[];

/** Thành viên ACTIVE của workspace; người ngoài miền nhận 404 đồng nhất (SRS mục 12: sai workspace/device trả lỗi đồng nhất). */
export function requireMember(ctx: Ctx, ws: string, user: string): MemberRow {
  const m = member(ctx, ws, user);
  if (!m || m.status !== "ACTIVE") throw new ApiError(404, "NOT_FOUND");
  return m;
}

export function requireRole(m: MemberRow, ...need: string[]) {
  const r = roles(m);
  if (!need.some((x) => r.includes(x))) throw new ApiError(403, "FORBIDDEN");
}

export const activeGrant = (ctx: Ctx, ws: string, user: string, scope: string, resource: string | null) =>
  one<{ id: string }>(ctx.db, "SELECT id FROM grants WHERE workspace_id = ? AND user_id = ? AND scope = ? AND status = 'ACTIVE' AND (resource IS ? OR resource = ?)",
    ws, user, scope, resource, resource ?? "") ?? null;

export interface ConsentRow {
  id: string;
  workspace_id: string;
  user_id: string;
  purpose_id: Purpose;
  text_version: string;
  text_hash: string;
  choice: "GRANTED" | "DECLINED";
  at: string;
  withdrawn_at: string | null;
}

export const latestConsent = (ctx: Ctx, ws: string, user: string, purpose: Purpose) =>
  one<ConsentRow>(ctx.db, "SELECT * FROM consents WHERE workspace_id = ? AND user_id = ? AND purpose_id = ? ORDER BY at DESC, rowid DESC LIMIT 1", ws, user, purpose);

export const consentGranted = (ctx: Ctx, ws: string, user: string, purpose: Purpose) => {
  const c = latestConsent(ctx, ws, user, purpose);
  return !!c && c.choice === "GRANTED" && !c.withdrawn_at;
};

export const calendarLink = (ctx: Ctx, ws: string, user: string) =>
  one<CalendarLinkRow>(ctx.db, "SELECT * FROM calendar_links WHERE workspace_id = ? AND user_id = ?", ws, user);
export const device = (ctx: Ctx, ref: string) => one<DeviceRow>(ctx.db, "SELECT * FROM devices WHERE device_ref = ?", ref);

export function exportPolicy(ctx: Ctx, ws: string) {
  const w = one<{ export_policy: string; export_policy_digest: string }>(ctx.db, "SELECT export_policy, export_policy_digest FROM workspaces WHERE id = ?", ws);
  if (!w) throw new ApiError(404, "NOT_FOUND");
  return { doc: JSON.parse(w.export_policy) as ExportPolicyDoc, digest: w.export_policy_digest };
}

export interface Snapshot {
  authz_version: number;
  export_policy_digest: string;
  target_binding_version: number | null;
  stale: string | null;
}

/**
 * Cổng của một mô-đun cho route không đi qua createPlan, theo đúng thứ tự của createPlan: thành viên (404) → cờ mô-đun (503) →
 * quyền (403) → đồng ý (403). Handler của mô-đun gọi hàm này thay cho requireMember.
 */
export function requireModuleGate(ctx: Ctx, ws: string, user: string, gate: { module: ModuleName; scope: GrantScope; purpose: Purpose | null }): MemberRow {
  const m = requireMember(ctx, ws, user);
  if (!ctx.control.moduleOn(gate.module)) throw new ApiError(503, "MODULE_DISABLED");
  if (!activeGrant(ctx, ws, user, gate.scope, null)) throw new ApiError(403, "FORBIDDEN");
  if (gate.purpose && !consentGranted(ctx, ws, user, gate.purpose)) throw new ApiError(403, "CONSENT_REQUIRED");
  return m;
}

/** Snapshot hiện hành của Authority cho một plan/action: dùng khi duyệt, khi cấp permit và tại receiver trước claim. */
export function snapshotFor(ctx: Ctx, r: Pick<ActionRow, "workspace_id" | "actor" | "kind" | "target_ref" | "site_id" | "authz_version" | "export_policy_digest" | "target_binding_version">): Snapshot {
  const kind = r.kind;
  const rule = kindRule(ctx, kind);
  const m = member(ctx, r.workspace_id, r.actor);
  const policy = exportPolicy(ctx, r.workspace_id);
  let binding: number | null = null;
  let stale: string | null = null;
  if (!m || m.status !== "ACTIVE") stale = "MEMBER_INACTIVE";
  // Loại không còn ai khai (mô-đun đã gỡ): không có quyền nào để đối chiếu, coi như đích không dùng được.
  else if (!rule) stale = "TARGET_UNAVAILABLE";
  else if (!activeGrant(ctx, r.workspace_id, r.actor, rule.scope, kind === "device.set_power" ? r.site_id : null)) stale = "GRANT_REVOKED";
  else if (rule.purpose && !consentGranted(ctx, r.workspace_id, r.actor, rule.purpose)) stale = "CONSENT_REVOKED";
  if (kind === "calendar.block") {
    const link = calendarLink(ctx, r.workspace_id, r.actor);
    binding = link && link.status === "ACTIVE" && link.id === r.target_ref ? link.binding_version : null;
  } else if (kind === "device.set_power") {
    const d = device(ctx, r.target_ref);
    binding = d && d.status === "ACTIVE" && d.workspace_id === r.workspace_id && d.site_id === r.site_id ? d.binding_version : null;
  } else if (kind === "robot.simulate") binding = 1;
  else binding = moduleKind(ctx, kind)?.binding(ctx, r) ?? null;
  if (!stale && binding === null) stale = "TARGET_UNAVAILABLE";
  if (!stale && m && m.authz_version !== r.authz_version) stale = "AUTHZ_CHANGED";
  if (!stale && policy.digest !== r.export_policy_digest) stale = "POLICY_CHANGED";
  if (!stale && binding !== r.target_binding_version) stale = "BINDING_CHANGED";
  return { authz_version: m?.authz_version ?? 0, export_policy_digest: policy.digest, target_binding_version: binding, stale };
}

/** Vô hiệu các plan/action chưa claim khớp điều kiện (Authority, cạnh invalidate → REJECTED). */
function invalidate(ctx: Ctx, where: string, args: (string | number | null)[], reason: string) {
  const at = nowIso(ctx);
  const rows = all<{ id: string }>(ctx.db, `SELECT id FROM actions WHERE state IN ('PENDING_APPROVAL','AUTHORIZED') AND ${where}`, ...args);
  for (const r of rows) apply(ctx.db, { planId: r.id, event: "invalidate", actorKind: "AUTHORITY", at, set: { reason }, data: { reason } });
  return rows.length;
}

function controlEvent(ctx: Ctx, ws: string, kind: string, actor: string, subject: string | null, authz: number | null, data: Record<string, unknown>) {
  run(ctx.db, "INSERT INTO control_events (id, workspace_id, kind, actor, subject, authz_version, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    uuid(), ws, kind, actor, subject, authz, JSON.stringify(data), nowIso(ctx));
}

/** Tăng authz_version của một thành viên, ghi control event bền và vô hiệu plan chưa claim của người đó. */
export function bumpAuthz(ctx: Ctx, ws: string, user: string, kind: string, actor: string, data: Record<string, unknown>, invalidateWhere?: { sql: string; args: (string | number | null)[] }) {
  return tx(ctx.db, () => {
    run(ctx.db, "UPDATE members SET authz_version = authz_version + 1 WHERE workspace_id = ? AND user_id = ?", ws, user);
    const v = (member(ctx, ws, user) as MemberRow).authz_version;
    controlEvent(ctx, ws, kind, actor, user, v, data);
    const extra = invalidateWhere ? ` AND ${invalidateWhere.sql}` : "";
    invalidate(ctx, `workspace_id = ? AND actor = ?${extra}`, [ws, user, ...(invalidateWhere?.args ?? [])], "AUTHZ_CHANGED");
    return v;
  });
}

export function revokeGrant(ctx: Ctx, ws: string, grantId: string, by: string, requestId: string | null) {
  return tx(ctx.db, () => {
    const g = one<{ id: string; user_id: string; status: string; scope: string; revoked_at: string | null }>(ctx.db, "SELECT * FROM grants WHERE id = ? AND workspace_id = ?", grantId, ws);
    if (!g) throw new ApiError(404, "NOT_FOUND");
    const self = g.user_id === by;
    const admin = (() => {
      const m = member(ctx, ws, by);
      return !!m && m.status === "ACTIVE" && roles(m).includes("WORKSPACE_ADMIN");
    })();
    if (!self && !admin) throw new ApiError(404, "NOT_FOUND");
    if (g.status === "REVOKED") {
      return { grant_id: g.id, status: "REVOKED" as const, authz_version: (member(ctx, ws, g.user_id) as MemberRow).authz_version, effective_at: g.revoked_at as string, already_revoked: true };
    }
    const at = nowIso(ctx);
    run(ctx.db, "UPDATE grants SET status = 'REVOKED', revoked_at = ?, revoked_by = ? WHERE id = ?", at, by, g.id);
    const v = bumpAuthz(ctx, ws, g.user_id, "GRANT_REVOKED", by, { grant: g.id, scope: g.scope });
    ctx.revocations.append("grant_revoked", at, { workspace_id: ws, user_id: g.user_id, grant: g.id });
    audit(ctx.db, at, { workspace_id: ws, actor: by, action: "grant.revoke", target: g.id, request_id: requestId, data: { authz_version: v } });
    return { grant_id: g.id, status: "REVOKED" as const, authz_version: v, effective_at: at, already_revoked: false };
  });
}

export const consentView = (c: ConsentRow) => ({ id: c.id, purpose_id: c.purpose_id, text_version: c.text_version, text_hash: c.text_hash, choice: c.choice, at: c.at, withdrawn_at: c.withdrawn_at });

export function recordConsent(ctx: Ctx, ws: string, user: string, b: { purpose_id: string; text_version: string; text_hash: string; choice: "GRANTED" | "DECLINED" }, requestId: string | null) {
  if (b.purpose_id === "health_local") throw new ApiError(422, "HEALTH_LOCAL_ONLY");
  return tx(ctx.db, () => {
    const at = nowIso(ctx);
    const id = `cs_${uuid()}`;
    const prev = latestConsent(ctx, ws, user, b.purpose_id as Purpose);
    run(ctx.db, "INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, ws, user, b.purpose_id, b.text_version, b.text_hash, b.choice, at);
    // Đổi từ đồng ý sang từ chối là một thay đổi quyền như rút lại.
    const revoked = !!prev && prev.choice === "GRANTED" && !prev.withdrawn_at && b.choice === "DECLINED";
    if (revoked) {
      bumpAuthz(ctx, ws, user, "CONSENT_REVOKED", user, { purpose: b.purpose_id });
      ctx.revocations.append("consent_withdrawn", at, { workspace_id: ws, user_id: user, purpose_id: b.purpose_id });
    }
    audit(ctx.db, at, { workspace_id: ws, actor: user, action: "consent.record", target: b.purpose_id, request_id: requestId, data: { choice: b.choice, text_version: b.text_version } });
    if (revoked) consentWithdrawn(ctx, ws, user, b.purpose_id as Purpose, at);
    return consentView(one<ConsentRow>(ctx.db, "SELECT * FROM consents WHERE id = ?", id) as ConsentRow);
  });
}

/** Báo cho các mô-đun một đồng ý vừa mất hiệu lực. Gọi trong giao dịch của thao tác, sau khi lõi đã ghi xong phần của mình. */
export function consentWithdrawn(ctx: Ctx, ws: string, user: string, purpose: Purpose, at: string) {
  for (const m of ctx.modules) m.privacy?.onConsentWithdrawn?.(ctx, ws, user, purpose, at);
}

export function withdrawConsent(ctx: Ctx, ws: string, user: string, purpose: Purpose, requestId: string | null) {
  return tx(ctx.db, () => {
    const c = latestConsent(ctx, ws, user, purpose);
    if (!c) throw new ApiError(404, "NOT_FOUND");
    if (c.choice === "GRANTED" && !c.withdrawn_at) {
      const at = nowIso(ctx);
      run(ctx.db, "UPDATE consents SET withdrawn_at = ? WHERE id = ?", at, c.id);
      const kinds: string[] = (Object.entries(PURPOSE_FOR) as [Kind, Purpose | null][]).filter(([, p]) => p === purpose).map(([k]) => k);
      for (const m of ctx.modules) for (const k of m.kinds ?? []) if (k.purpose === purpose) kinds.push(k.kind);
      bumpAuthz(ctx, ws, user, "CONSENT_REVOKED", user, { purpose }, kinds.length ? { sql: `kind IN (${kinds.map(() => "?").join(",")})`, args: kinds } : undefined);
      ctx.revocations.append("consent_withdrawn", at, { workspace_id: ws, user_id: user, purpose_id: purpose });
      audit(ctx.db, at, { workspace_id: ws, actor: user, action: "consent.withdraw", target: purpose, request_id: requestId });
      consentWithdrawn(ctx, ws, user, purpose, at);
    }
    return consentView(one<ConsentRow>(ctx.db, "SELECT * FROM consents WHERE id = ?", c.id) as ConsentRow);
  });
}

/** Đổi chính sách xuất của workspace: digest mới làm mọi approval cũ stale dù quyền scope giữ nguyên (SRS mục 14). */
export function setExportPolicy(ctx: Ctx, ws: string, doc: ExportPolicyDoc, by: string) {
  return tx(ctx.db, () => {
    const digest = digestJcs(doc);
    run(ctx.db, "UPDATE workspaces SET export_policy = ?, export_policy_digest = ? WHERE id = ?", JSON.stringify(doc), digest, ws);
    controlEvent(ctx, ws, "POLICY_CHANGED", by, null, null, { digest });
    const n = invalidate(ctx, "workspace_id = ?", [ws], "POLICY_CHANGED");
    audit(ctx.db, nowIso(ctx), { workspace_id: ws, actor: by, action: "policy.export.change", data: { digest, invalidated: n } });
    return digest;
  });
}

/**
 * Thêm vào chính sách xuất của các workspace đã có mục của những loại tác vụ mới đăng ký (khi khởi động). Một loại mới là một
 * miền xuất mới (SRS mục 14): digest đổi, nên mọi plan chưa claim của workspace đó bị vô hiệu như mọi lần đổi chính sách.
 * Workspace đã đủ mục thì không đổi gì.
 */
export function ensureKindPolicies(ctx: Ctx) {
  const specs = ctx.modules.flatMap((m) => m.kinds ?? []);
  if (!specs.length) return 0;
  let changed = 0;
  for (const w of all<{ id: string }>(ctx.db, "SELECT id FROM workspaces ORDER BY id")) {
    const { doc } = exportPolicy(ctx, w.id);
    const missing = specs.filter((k) => !Object.hasOwn(doc.kinds, k.kind));
    if (!missing.length) continue;
    const kinds = { ...doc.kinds };
    for (const k of missing) kinds[k.kind] = policyEntry(k);
    setExportPolicy(ctx, w.id, { ...doc, kinds }, "system:modules");
    changed++;
  }
  return changed;
}

/**
 * Đổi binding của thiết bị (SRS mục 23): reset/firmware đổi → QUARANTINED; recommission → ACTIVE với binding mới; rời site →
 * DECOMMISSIONED. Binding cũ giữ tombstone; mọi plan/permit cũ bị chặn kể cả device_ref cùng tên.
 */
export function changeBinding(ctx: Ctx, ref: string, next: "QUARANTINED" | "ACTIVE" | "DECOMMISSIONED", reason: string, by: string, firmware?: string) {
  return tx(ctx.db, () => {
    const d = device(ctx, ref);
    if (!d) throw new ApiError(404, "NOT_FOUND");
    if (d.status === "DECOMMISSIONED") throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: d.status } });
    if (next === "ACTIVE" && d.status !== "QUARANTINED") throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: d.status } });
    const at = nowIso(ctx);
    run(ctx.db, "INSERT OR IGNORE INTO binding_tombstones (device_ref, binding_version, reason, at) VALUES (?, ?, ?, ?)", ref, d.binding_version, reason, at);
    run(ctx.db, "UPDATE devices SET status = ?, binding_version = binding_version + 1, firmware = COALESCE(?, firmware), updated_at = ? WHERE device_ref = ?", next, firmware ?? null, at, ref);
    if (next !== "ACTIVE") run(ctx.db, "DELETE FROM device_status WHERE device_ref = ?", ref);
    const nd = device(ctx, ref) as DeviceRow;
    controlEvent(ctx, d.workspace_id, "BINDING_CHANGED", by, ref, null, { status: next, binding_version: nd.binding_version, reason });
    invalidate(ctx, "kind = 'device.set_power' AND target_ref = ?", [ref], "BINDING_CHANGED");
    ctx.revocations.append("binding_changed", at, { device_ref: ref, binding_version: nd.binding_version, status: next });
    audit(ctx.db, at, { workspace_id: d.workspace_id, actor: by, action: `device.${next.toLowerCase()}`, target: ref, data: { binding_version: nd.binding_version, reason } });
    return nd;
  });
}

export const grantsOf = (ctx: Ctx, ws: string, user: string) =>
  all<{ id: string; scope: string; resource: string | null; status: "ACTIVE" | "REVOKED" }>(ctx.db, "SELECT id, scope, resource, status FROM grants WHERE workspace_id = ? AND user_id = ? ORDER BY created_at", ws, user);
