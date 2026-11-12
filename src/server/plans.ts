// Plan và phê duyệt (SRS mục 14, 15, 19). POST /plans tạo và submit nguyên tử; preview ActionPayload là nội dung duy nhất được
// băm (payload_digest = SHA-256 JCS). Approval gắn plan_version, digest, authz_version, export_policy_digest và
// target_binding_version tại plan; mọi thứ đổi trước điểm claim làm plan stale.
import { ApiError } from "../core/errors.ts";
import { digestJcs, supportCode, uuid } from "../core/crypto.ts";
import { parseInstant } from "../../web/shared/zone.js";
import { type Ctx, nowIso } from "./context.ts";
import { activeGrant, calendarLink, consentGranted, device, exportPolicy, kindRule, moduleKind, requireMember, snapshotFor } from "./authority.ts";
import { apply, getByActionId, getRow, type ActionRow, TERMINAL } from "./machine.ts";
import type { KindInput, Resolved } from "./modules.ts";
import { all, audit, one, run, tx } from "./store.ts";

export type PlanInput =
  | { kind: "calendar.block"; schema_version: 1; workspace_ref: string; args: { calendar_ref: "primary"; start: string; end: string; zone: string; title_code: "PERSONAL_TIME"; visibility: "private" } }
  | { kind: "device.set_power"; schema_version: 1; workspace_ref: string; args: { site: string; device_ref: string; command: "SET_ON" | "SET_OFF" } }
  | { kind: "robot.simulate"; schema_version: 1; workspace_ref: string; args: { scenario: "DELIVER_DOCUMENT" } };

const iso = (ms: number) => new Date(ms).toISOString();

/** Tác vụ tương đương trên cùng tài nguyên bị khóa từ lúc UNKNOWN tới khi có bằng chứng (SRS mục 13; LNH-T02). */
export function lockedBy(ctx: Ctx, resourceKey: string, window: [string, string] | null): ActionRow | undefined {
  const rows = all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE resource_key = ? AND state = 'UNKNOWN'", resourceKey);
  return rows.find((r) => !window || !r.window_start || !r.window_end || (r.window_start < window[1] && window[0] < r.window_end));
}

function resolve(ctx: Ctx, ws: string, actor: string, input: PlanInput): Resolved {
  const now = ctx.clock.now();
  if (input.kind === "calendar.block") {
    const a = input.args;
    const link = calendarLink(ctx, ws, actor);
    if (!link || link.status !== "ACTIVE") throw new ApiError(422, "CALENDAR_NOT_LINKED");
    const s = parseInstant(a.start);
    const e = parseInstant(a.end);
    const policy = exportPolicy(ctx, ws).doc.kinds["calendar.block"];
    if (!(e > s)) throw new ApiError(400, "SCHEMA_INVALID", { detail: "Giờ kết thúc phải sau giờ bắt đầu." });
    if (e - s > policy.max_minutes * 60_000) throw new ApiError(422, "UNSUPPORTED", { detail: `Khung giờ dài tối đa ${policy.max_minutes} phút.` });
    if (s < now + ctx.config.calendar.minLeadMs) throw new ApiError(422, "UNSUPPORTED", { detail: "Khung giờ phải bắt đầu sau thời điểm hiện tại." });
    if (e > now + policy.horizon_days * 86_400_000) throw new ApiError(422, "UNSUPPORTED", { detail: `Chỉ đặt trong ${policy.horizon_days} ngày tới.` });
    const window: [string, string] = [iso(s), iso(e)];
    return {
      payload: {
        kind: "calendar.block", schema_version: 1, workspace_id: ws,
        target: { type: "calendar", calendar_ref: "primary", account: link.id },
        start: window[0], end: window[1], zone: a.zone, title_code: "PERSONAL_TIME", visibility: "private", show_as: "busy",
        target_binding_version: link.binding_version,
      },
      target_ref: link.id, site_id: null, resource_key: `calendar:${link.id}`, window, binding: link.binding_version,
    };
  }
  if (input.kind === "device.set_power") {
    const a = input.args;
    const site = one<{ id: string; workspace_id: string; managed: number }>(ctx.db, "SELECT * FROM sites WHERE id = ?", a.site);
    const d = device(ctx, a.device_ref);
    // Sai workspace, site hay thiết bị đều trả cùng một lỗi (SRS mục 12).
    if (!site || site.workspace_id !== ws || !site.managed || !d || d.workspace_id !== ws || d.site_id !== a.site || d.status !== "ACTIVE") throw new ApiError(404, "NOT_FOUND");
    if (!(JSON.parse(d.capabilities) as string[]).includes("SET_POWER")) throw new ApiError(422, "UNSUPPORTED");
    if (!ctx.control.siteOn(a.site)) throw new ApiError(503, "MODULE_DISABLED");
    return {
      payload: { kind: "device.set_power", schema_version: 1, workspace_id: ws, target: { type: "device", site: a.site, device_ref: d.device_ref }, command: a.command, target_binding_version: d.binding_version },
      target_ref: d.device_ref, site_id: a.site, resource_key: `device:${d.device_ref}`, window: null, binding: d.binding_version,
    };
  }
  return {
    payload: { kind: "robot.simulate", schema_version: 1, workspace_id: ws, target: { type: "robot-sim", namespace: "sim" }, scenario: input.args.scenario, target_binding_version: 1 },
    target_ref: "robot-sim", site_id: null, resource_key: `robot:${ws}:${actor}`, window: null, binding: 1,
  };
}

export function planView(r: ActionRow) {
  return {
    plan_id: r.id,
    kind: r.kind,
    state: r.state,
    plan_version: r.plan_version,
    payload_digest: r.payload_digest,
    preview: JSON.parse(r.payload),
    approval_deadline: r.approval_deadline as string,
    versions: { authz_version: r.authz_version, export_policy_digest: r.export_policy_digest, target_binding_version: r.target_binding_version },
    action_id: r.action_id,
    reason: r.reason,
  };
}

export function actionView(ctx: Ctx, r: ActionRow) {
  const locked = !!one<{ n: number }>(ctx.db, "SELECT 1 AS n FROM actions WHERE resource_key = ? AND state = 'UNKNOWN' LIMIT 1", r.resource_key);
  const check = TERMINAL.has(r.state) ? undefined : one<{ next_at: string | null; last_at: string | null }>(ctx.db, "SELECT next_at, last_at FROM checks WHERE plan_id = ?", r.id);
  return {
    action_id: r.action_id as string,
    plan_id: r.id,
    kind: r.kind,
    status: r.state,
    revision: r.revision,
    outcome: r.outcome,
    evidence_grade: r.evidence_grade,
    dispatch_state: r.dispatch_state,
    reconciliation_status: r.reconciliation_status,
    cancel_requested: !!r.cancel_requested,
    reason: r.reason,
    event_created: r.event_created === null ? null : !!r.event_created,
    support_code: r.support_code,
    deadlines: { approval: r.approval_deadline, dispatch: r.dispatch_deadline, unknown_after: r.unknown_after, next_check: check?.next_at ?? null },
    times: {
      authorized_at: r.authorized_at, dispatch_claimed_at: r.dispatch_claimed_at, first_io_at: r.first_io_at,
      last_observed_at: r.last_observed_at, last_check_at: check?.last_at ?? null, unknown_since: r.unknown_since, terminal_at: r.terminal_at,
    },
    preview: JSON.parse(r.payload),
    locked_resource: locked,
  };
}

/** `input` là PlanInput của lõi, hoặc KindInput của một loại do mô-đun khai (KindSpec trong modules.ts). */
export function createPlan(ctx: Ctx, actor: string, ws: string, input: PlanInput | KindInput, requestId: string | null) {
  const m = requireMember(ctx, ws, actor);
  if (input.workspace_ref !== ws) throw new ApiError(404, "NOT_FOUND");
  const kind: string = input.kind;
  const rule = kindRule(ctx, kind);
  if (!rule) throw new ApiError(422, "UNSUPPORTED");
  if (!ctx.control.moduleOn(rule.module)) throw new ApiError(503, "MODULE_DISABLED");
  const policy = exportPolicy(ctx, ws);
  if (!Object.hasOwn(policy.doc.kinds, kind)) throw new ApiError(422, "UNSUPPORTED");
  const resource = kind === "device.set_power" ? (input.args as { site: string }).site : null;
  if (!activeGrant(ctx, ws, actor, rule.scope, resource)) throw new ApiError(403, "FORBIDDEN");
  if (rule.purpose && !consentGranted(ctx, ws, actor, rule.purpose)) throw new ApiError(403, "CONSENT_REQUIRED");
  return tx(ctx.db, () => {
    const spec = moduleKind(ctx, kind);
    const r = spec ? spec.resolve(ctx, ws, actor, input as KindInput) : resolve(ctx, ws, actor, input as PlanInput);
    const lock = lockedBy(ctx, r.resource_key, r.window);
    if (lock) throw new ApiError(409, "RESOURCE_LOCKED", { extra: { resource_id: lock.action_id ?? lock.id } });
    const now = ctx.clock.now();
    const at = iso(now);
    const id = `pl_${uuid()}`;
    run(ctx.db, `INSERT INTO actions (id, workspace_id, actor, kind, schema_version, input, payload, payload_digest, resource_key, window_start, window_end,
      site_id, target_ref, authz_version, export_policy_digest, target_binding_version, state, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?, ?)`,
      id, ws, actor, kind, JSON.stringify(input), JSON.stringify(r.payload), digestJcs(r.payload), r.resource_key, r.window?.[0] ?? null, r.window?.[1] ?? null,
      r.site_id, r.target_ref, m.authz_version, policy.digest, r.binding, at, at);
    run(ctx.db, "INSERT INTO action_events (event_id, plan_id, seq, from_state, event, actor_kind, actor, to_state, data, at) VALUES (?, ?, 1, NULL, 'create', 'API', ?, 'DRAFT', '{}', ?)",
      uuid(), id, actor, at);
    const { row } = apply(ctx.db, {
      planId: id, event: "submit", actorKind: "API", actor, at, expectRevision: 1,
      set: { submitted_at: at, approval_deadline: iso(now + ctx.config.approvalWindowMs), plan_version: 2 },
    });
    audit(ctx.db, at, { workspace_id: ws, actor, action: "plan.create", target: id, request_id: requestId, data: { kind, digest: row.payload_digest } });
    return planView(row);
  });
}

function ownPlan(ctx: Ctx, actor: string, ws: string, planId: string) {
  const r = getRow(ctx.db, planId);
  if (!r || r.workspace_id !== ws || r.actor !== actor) throw new ApiError(404, "NOT_FOUND");
  return r;
}

export function getPlan(ctx: Ctx, actor: string, ws: string, planId: string) {
  requireMember(ctx, ws, actor);
  return planView(ownPlan(ctx, actor, ws, planId));
}

export function approvePlan(ctx: Ctx, actor: string, ws: string, planId: string, body: { plan_version: number; approved_digest: string }, requestId: string | null) {
  requireMember(ctx, ws, actor);
  return tx(ctx.db, () => {
    let r = ownPlan(ctx, actor, ws, planId);
    const now = ctx.clock.now();
    const at = iso(now);
    if (r.state === "PENDING_APPROVAL" && now > Date.parse(r.approval_deadline as string)) {
      r = apply(ctx.db, { planId, event: "deadline", actorKind: "SCHEDULER", at, set: { reason: "APPROVAL_TIMEOUT" } }).row;
    }
    if (r.state === "EXPIRED") throw new ApiError(410, "APPROVAL_EXPIRED", { extra: { state: r.state }, commit: true });
    if (r.state !== "PENDING_APPROVAL") throw new ApiError(409, "PLAN_STALE", { extra: { state: r.state } });
    if (body.plan_version !== r.plan_version || r.revision !== r.plan_version) throw new ApiError(409, "PLAN_STALE", { extra: { state: r.state } });
    if (body.approved_digest !== r.payload_digest) throw new ApiError(409, "DIGEST_MISMATCH");
    if (!ctx.control.dispatchOpen()) throw new ApiError(503, "DISPATCH_CLOSED", { retryable: true });
    const rule = kindRule(ctx, r.kind);
    if (!rule || !ctx.control.moduleOn(rule.module)) throw new ApiError(503, "MODULE_DISABLED");
    const snap = snapshotFor(ctx, r);
    if (snap.stale) {
      apply(ctx.db, { planId, event: "invalidate", actorKind: "AUTHORITY", at, set: { reason: snap.stale }, data: { reason: snap.stale } });
      throw new ApiError(409, "PLAN_STALE", { extra: { state: "REJECTED" }, commit: true });
    }
    const actionId = uuid();
    const deadline = iso(now + ctx.config.dispatchWindowMs);
    const { row } = apply(ctx.db, {
      planId, event: "approve", actorKind: "API", actor, at, expectRevision: r.revision,
      set: { action_id: actionId, authorized_at: at, dispatch_deadline: deadline, dispatch_state: "NOT_CLAIMED", transaction_id: actionId, support_code: supportCode() },
    });
    run(ctx.db, "INSERT INTO outbox (id, topic, plan_id, payload, created_at) VALUES (?, 'action.authorized', ?, '{}', ?)", uuid(), planId, at);
    audit(ctx.db, at, { workspace_id: ws, actor, action: "plan.approve", target: planId, request_id: requestId, data: { action_id: actionId, digest: row.payload_digest } });
    return { action_id: actionId, plan_id: planId, state: "AUTHORIZED" as const, dispatch_deadline: deadline };
  });
}

export function closePlan(ctx: Ctx, actor: string, ws: string, planId: string, how: "deny" | "cancel", requestId: string | null) {
  requireMember(ctx, ws, actor);
  return tx(ctx.db, () => {
    const r = ownPlan(ctx, actor, ws, planId);
    const at = nowIso(ctx);
    const { row } = apply(ctx.db, { planId, event: how, actorKind: "USER", actor, at, expectRevision: r.revision, set: { reason: how === "deny" ? "USER_DENIED" : "USER_CANCELED" } });
    audit(ctx.db, at, { workspace_id: ws, actor, action: `plan.${how}`, target: planId, request_id: requestId });
    return planView(row);
  });
}

function ownAction(ctx: Ctx, actor: string, ws: string, actionId: string) {
  const r = getByActionId(ctx.db, actionId);
  if (!r || r.workspace_id !== ws || r.actor !== actor) throw new ApiError(404, "NOT_FOUND");
  return r;
}

export function getAction(ctx: Ctx, actor: string, ws: string, actionId: string) {
  requireMember(ctx, ws, actor);
  return actionView(ctx, ownAction(ctx, actor, ws, actionId));
}

export function listActions(ctx: Ctx, actor: string, ws: string) {
  requireMember(ctx, ws, actor);
  const rows = all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE workspace_id = ? AND actor = ? AND action_id IS NOT NULL ORDER BY authorized_at DESC LIMIT 50", ws, actor);
  return { items: rows.map((r) => actionView(ctx, r)) };
}

/** Hủy: trước claim là nguyên tử (CANCELED); sau claim chỉ đánh dấu cancel_requested và tiếp tục đối soát (SRS mục 15, 19). */
export function cancelAction(ctx: Ctx, actor: string, ws: string, actionId: string, requestId: string | null) {
  requireMember(ctx, ws, actor);
  return tx(ctx.db, () => {
    const r = ownAction(ctx, actor, ws, actionId);
    const at = nowIso(ctx);
    if (r.state === "AUTHORIZED") {
      const { row } = apply(ctx.db, { planId: r.id, event: "cancel", actorKind: "API", actor, at, expectRevision: r.revision, set: { reason: "USER_CANCELED" } });
      audit(ctx.db, at, { workspace_id: ws, actor, action: "action.cancel", target: actionId, request_id: requestId });
      return actionView(ctx, row);
    }
    if (TERMINAL.has(r.state)) throw new ApiError(409, "ACTION_FINAL", { extra: { state: r.state } });
    if (r.cancel_requested) return actionView(ctx, r);
    const { row } = apply(ctx.db, { planId: r.id, event: "cancel_request", actorKind: "API", actor, at, expectRevision: r.revision, set: { cancel_requested: 1 } });
    audit(ctx.db, at, { workspace_id: ws, actor, action: "action.cancel_request", target: actionId, request_id: requestId });
    return actionView(ctx, row);
  });
}

/** Scheduler: hết approval window → EXPIRED; AUTHORIZED chưa claim khi hết dispatch window → EXPIRED. */
export function expireDue(ctx: Ctx) {
  const at = nowIso(ctx);
  let n = 0;
  for (const r of all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE state = 'PENDING_APPROVAL' AND approval_deadline < ?", at)) {
    apply(ctx.db, { planId: r.id, event: "deadline", actorKind: "SCHEDULER", at, expectRevision: r.revision, set: { reason: "APPROVAL_TIMEOUT" } });
    n++;
  }
  for (const r of all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE state = 'AUTHORIZED' AND dispatch_deadline < ?", at)) {
    apply(ctx.db, { planId: r.id, event: "lease_deadline", actorKind: "SCHEDULER", at, expectRevision: r.revision, set: { reason: "DISPATCH_WINDOW_PASSED" } });
    n++;
  }
  return n;
}
