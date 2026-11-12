// API /v1 (SRS mục 15) và phục vụ giao diện web. JSON UTF-8; mọi POST có Idempotency-Key; thân yêu cầu kiểm bằng schema trong
// contracts/openapi.json (additionalProperties=false, khóa trùng → 400); lỗi chuẩn {code, message, request_id, retryable}.
// Không log thân yêu cầu, token, query hay dữ liệu sức khỏe (SRS mục 24): log chỉ có route mẫu, status và thời gian.
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ApiError, MESSAGES } from "../core/errors.ts";
import { JsonError, parseStrictJson } from "../core/strict-json.ts";
import type { SchemaSet } from "../core/schema.ts";
import { parseInstant } from "../../web/shared/zone.js";
import { type Ctx, nowIso } from "./context.ts";
import {
  PURPOSES, activeGrant, calendarLink, consentGranted, consentView, grantsOf, isActiveMember, latestConsent, member, moduleKind, recordConsent, requireMember, requireRole,
  revokeGrant, roles, withdrawConsent, changeBinding, type ConsentRow, type Purpose,
} from "./authority.ts";
import { approvePlan, cancelAction, closePlan, createPlan, getAction, getPlan, listActions, actionView, type PlanInput } from "./plans.ts";
import { getByActionId, getRow, type ActionRow } from "./machine.ts";
import { Idempotency, type Stored } from "./idempotency.ts";
import { createPrivacyRequest, downloadExport, getPrivacyRequest } from "./privacy.ts";
import { resolveWithEvidence, type Readback } from "./evidence.ts";
import type { ModelGateway } from "./lele.ts";
import type { OidcVerifier, DevIssuer, Principal } from "./auth.ts";
import type { CalendarAdapter } from "../adapters/calendar.ts";
import type { ModuleName } from "./control.ts";
import { MODULES, type ServerModule } from "./modules.ts";
import { all, audit, one, run, tx } from "./store.ts";

export interface Metrics {
  requests: number;
  recent: { at: number; status: number }[];
  policyDenials: number;
}

export interface ApiDeps {
  ctx: Ctx;
  schemas: SchemaSet;
  idem: Idempotency;
  verifier: OidcVerifier;
  dev: DevIssuer | null;
  devUsers: { sub: string; name: string }[];
  gateway: ModelGateway;
  calendar: CalendarAdapter;
  metrics: Metrics;
  dispatched: () => number;
  webRoot: URL;
  /** Mô-đun của app này: route và đường dev của chúng được phục vụ cùng route lõi. */
  modules: readonly ServerModule[];
}

/** Một lời gọi /v1 đã qua xác thực, kiểm workspace, giới hạn tốc độ và (với POST) schema thân. */
export interface Call {
  d: ApiDeps;
  p: Principal;
  ws: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  requestId: string;
}

/**
 * Một thao tác /v1, của lõi hay của mô-đun (ServerModule.routes). Mọi route đi cùng một đường: so khớp → xác thực → workspace →
 * giới hạn tốc độ theo người dùng → (POST) đọc thân, kiểm schema, idempotency → handler. Route nào cũng phải có trong OpenAPI.
 */
export interface Route {
  method: "GET" | "POST";
  /** Bắt đầu bằng /v1/, hoặc /v2/ cho hợp đồng mở rộng của SRS V2.0 mục 12; tham số dạng {ten_tham_so}, chỉ khớp [A-Za-z0-9_-]{1,128}. Route khai trước thắng khi hai mẫu cùng khớp. */
  path: string;
  /** POST: tên schema thân trong OpenAPI (components.schemas). Thân rỗng dùng "Empty" cùng optionalBody. */
  schema?: string;
  optionalBody?: boolean;
  /** POST: handler có await. Khi đó nó chạy ngoài giao dịch và bản ghi khóa idempotency chỉ được ghi sau khi nó xong. */
  async?: boolean;
  handler: (c: Call) => Stored | Promise<Stored>;
  /** POST: quyền đọc hiện hành của người gọi với tài nguyên đã trả; phát lại idempotent chỉ trả bản cũ khi hàm này cho phép. */
  readable?: (c: Call, r: { type: string; id: string } | null) => boolean;
}

const OPERATOR = ["LEDB_OPERATOR"];
const SITE_OPERATOR = ["SITE_OPERATOR"];

function me(c: Call) {
  const { ctx } = c.d;
  const m = requireMember(ctx, c.ws, c.p.sub);
  const w = one<{ id: string; name: string }>(ctx.db, "SELECT id, name FROM workspaces WHERE id = ?", c.ws) as { id: string; name: string };
  const consents = PURPOSES.map((pp) => latestConsent(ctx, c.ws, c.p.sub, pp)).filter((x): x is ConsentRow => !!x).map(consentView);
  const link = calendarLink(ctx, c.ws, c.p.sub);
  const sites = all<{ id: string; name: string }>(ctx.db,
    "SELECT s.id, s.name FROM sites s JOIN grants g ON g.resource = s.id AND g.scope = 'home.control' AND g.status = 'ACTIVE' WHERE g.workspace_id = ? AND g.user_id = ? ORDER BY s.id", c.ws, c.p.sub);
  return {
    user: { id: m.user_id, name: m.display_name },
    workspace: w,
    roles: roles(m),
    grants: grantsOf(ctx, c.ws, c.p.sub),
    consents,
    calendar: { linked: !!link && link.status === "ACTIVE", account: link && link.status === "ACTIVE" ? link.id : null },
    sites,
    modules: ctx.control.modules(),
    dispatch_open: ctx.control.dispatchOpen(),
  };
}

async function availability(c: Call): Promise<Stored> {
  const { ctx } = c.d;
  requireMember(ctx, c.ws, c.p.sub);
  const start = c.query.get("start") ?? "";
  const end = c.query.get("end") ?? "";
  const s = parseInstant(start);
  const e = parseInstant(end);
  if (!start.endsWith("Z") || !end.endsWith("Z") || Number.isNaN(s) || Number.isNaN(e) || e <= s) throw new ApiError(400, "SCHEMA_INVALID");
  if (e - s > ctx.config.calendar.horizonDays * 86_400_000) throw new ApiError(400, "SCHEMA_INVALID", { detail: "Cửa sổ tối đa 14 ngày.", extra: { detail_code: "WINDOW_TOO_LONG", limit: ctx.config.calendar.horizonDays } });
  if (!activeGrant(ctx, c.ws, c.p.sub, "calendar.block", null)) throw new ApiError(403, "FORBIDDEN");
  if (!consentGranted(ctx, c.ws, c.p.sub, "calendar_link")) throw new ApiError(403, "CONSENT_REQUIRED");
  if (!ctx.control.moduleOn("calendar")) throw new ApiError(503, "MODULE_DISABLED");
  const link = calendarLink(ctx, c.ws, c.p.sub);
  if (!link || link.status !== "ACTIVE") throw new ApiError(422, "CALENDAR_NOT_LINKED");
  const r = await c.d.calendar.availability(link.id, new Date(s).toISOString(), new Date(e).toISOString());
  if ("throttled" in r) throw new ApiError(429, "RATE_LIMITED", { retryable: true, headers: { "Retry-After": String(Math.ceil(r.retryAfterMs / 1000)) } });
  const blocks = all<ActionRow>(ctx.db,
    "SELECT * FROM actions WHERE workspace_id = ? AND actor = ? AND kind = 'calendar.block' AND action_id IS NOT NULL AND window_start < ? AND ? < window_end AND state NOT IN ('REJECTED','EXPIRED','CANCELED','FAILED')",
    c.ws, c.p.sub, new Date(e).toISOString(), new Date(s).toISOString());
  return {
    status: 200,
    body: {
      calendar_ref: "primary", window: { start: new Date(s).toISOString(), end: new Date(e).toISOString() }, busy: r.busy, free: r.free,
      lenhip_blocks: blocks.map((b) => ({ start: b.window_start as string, end: b.window_end as string, action_id: b.action_id as string, status: b.state })),
    },
  };
}

function devices(c: Call): Stored {
  const { ctx } = c.d;
  requireMember(ctx, c.ws, c.p.sub);
  const site = c.query.get("site") ?? "";
  const s = one<{ id: string; workspace_id: string }>(ctx.db, "SELECT id, workspace_id FROM sites WHERE id = ?", site);
  if (!s || s.workspace_id !== c.ws) throw new ApiError(404, "NOT_FOUND");
  if (!activeGrant(ctx, c.ws, c.p.sub, "home.control", site)) throw new ApiError(403, "FORBIDDEN");
  const now = ctx.clock.now();
  const rows = all<{ device_ref: string; name: string; site_id: string; binding_version: number; capabilities: string; status: string; power: string | null; observed_at: string | null }>(ctx.db,
    "SELECT d.device_ref, d.name, d.site_id, d.binding_version, d.capabilities, d.status, s.power, s.observed_at FROM devices d LEFT JOIN device_status s ON s.device_ref = d.device_ref WHERE d.site_id = ? AND d.status <> 'DECOMMISSIONED' ORDER BY d.name",
    site);
  return {
    status: 200,
    body: {
      site,
      devices: rows.map((d) => {
        const age = d.observed_at ? Math.max(0, now - Date.parse(d.observed_at)) : null;
        return {
          device_ref: d.device_ref, name: d.name, site: d.site_id, binding_version: d.binding_version, capabilities: JSON.parse(d.capabilities), status: d.status,
          state: d.power && d.observed_at && age !== null ? { power: d.power, observed_at: d.observed_at, age_ms: age, stale: age > ctx.config.edge.maxAgeMs } : null,
          locked: !!one(ctx.db, "SELECT 1 FROM actions WHERE resource_key = ? AND state = 'UNKNOWN'", `device:${d.device_ref}`),
        };
      }),
    },
  };
}

function deviceView(c: Call, ref: string) {
  const r = devices({ ...c, query: new URLSearchParams({ site: (one<{ site_id: string }>(c.d.ctx.db, "SELECT site_id FROM devices WHERE device_ref = ?", ref) as { site_id: string }).site_id }) });
  const list = (r.body as { devices: { device_ref: string }[] }).devices;
  const found = list.find((x) => x.device_ref === ref);
  if (found) return found;
  const d = one<{ device_ref: string; name: string; site_id: string; binding_version: number; capabilities: string; status: string }>(c.d.ctx.db, "SELECT * FROM devices WHERE device_ref = ?", ref);
  if (!d) throw new ApiError(404, "NOT_FOUND");
  return { device_ref: d.device_ref, name: d.name, site: d.site_id, binding_version: d.binding_version, capabilities: JSON.parse(d.capabilities), status: d.status, state: null, locked: false };
}

function opsMember(c: Call, need: string[]) {
  const m = requireMember(c.d.ctx, c.ws, c.p.sub);
  requireRole(m, ...need);
  return m;
}

function ticketView(t: Record<string, unknown>, actionId: string) {
  return {
    id: t.id, action_id: actionId, kind: t.kind, status: t.status, support_code: t.support_code, opened_at: t.opened_at, ack_due_at: t.ack_due_at,
    acknowledged_at: t.acknowledged_at, escalated_at: t.escalated_at, manual_required_at: t.manual_required_at, closed_at: t.closed_at,
  };
}

function unknownList(c: Call): Stored {
  opsMember(c, OPERATOR);
  const { ctx } = c.d;
  const now = ctx.clock.now();
  const rows = all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE workspace_id = ? AND state = 'UNKNOWN' ORDER BY unknown_since", c.ws);
  return {
    status: 200,
    body: {
      items: rows.map((r) => {
        const t = one<Record<string, unknown>>(ctx.db, "SELECT * FROM tickets WHERE plan_id = ? AND status <> 'CLOSED' ORDER BY opened_at DESC LIMIT 1", r.id);
        const check = one<{ next_at: string | null }>(ctx.db, "SELECT next_at FROM checks WHERE plan_id = ?", r.id);
        return {
          action_id: r.action_id as string, kind: r.kind, status: r.state, age_seconds: Math.max(0, Math.floor((now - Date.parse(r.unknown_since as string)) / 1000)),
          reconciliation_status: r.reconciliation_status, support_code: r.support_code, ticket: t ? ticketView(t, r.action_id as string) : null,
          last_observed_at: r.last_observed_at, next_check: check?.next_at ?? null,
        };
      }),
    },
  };
}

function flagsView(c: Call) {
  const s = c.d.ctx.control.get();
  return { modules: c.d.ctx.control.modules(), sites: { ...s.sites }, dispatch: { open: !s.dispatch.locked, locked_reason: s.dispatch.reason, recovery_epoch: s.recovery_epoch } };
}

function metricsView(c: Call) {
  const { ctx, metrics } = c.d;
  const now = ctx.clock.now();
  const recent = metrics.recent.filter((r) => now - r.at < 5 * 60_000);
  const oldest = one<{ created_at: string }>(ctx.db, "SELECT created_at FROM outbox WHERE delivered_at IS NULL ORDER BY seq LIMIT 1");
  const unk = one<{ since: string | null; n: number }>(ctx.db, "SELECT MIN(unknown_since) AS since, COUNT(*) AS n FROM actions WHERE state = 'UNKNOWN'") as { since: string | null; n: number };
  const readback: Record<string, { match: number; other: number }> = {};
  for (const r of all<{ kind: string; result: string; n: number }>(ctx.db,
    "SELECT a.kind, e.result, COUNT(*) AS n FROM evidence e JOIN actions a ON a.id = e.plan_id WHERE e.grade <> 'SIMULATED' GROUP BY a.kind, e.result")) {
    const k = (readback[r.kind] ??= { match: 0, other: 0 });
    if (r.result === "MATCH") k.match += r.n;
    else k.other += r.n;
  }
  return {
    requests: metrics.requests,
    errors_5m: { total: recent.length, "4xx": recent.filter((r) => r.status >= 400 && r.status < 500).length, "5xx": recent.filter((r) => r.status >= 500).length },
    dispatch_count: c.d.dispatched(),
    oldest_outbox_seconds: oldest ? Math.max(0, Math.floor((now - Date.parse(oldest.created_at)) / 1000)) : 0,
    unknown_max_age_seconds: unk.since ? Math.max(0, Math.floor((now - Date.parse(unk.since)) / 1000)) : 0,
    unknown_open: unk.n,
    policy_denials: metrics.policyDenials,
    readback,
    dispatch_open: ctx.control.dispatchOpen(),
  };
}

const ownPlan = (c: Call, r: { type: string; id: string } | null) => {
  if (!r) return false;
  const row = r.type === "plan" ? getRow(c.d.ctx.db, r.id) : getByActionId(c.d.ctx.db, r.id);
  const m = member(c.d.ctx, c.ws, c.p.sub);
  return !!row && row.workspace_id === c.ws && row.actor === c.p.sub && !!m && m.status === "ACTIVE";
};
const isMember = (c: Call) => isActiveMember(c.d.ctx, c.ws, c.p.sub);

/** Route của lõi. Mô-đun không thêm vào đây: nó khai `routes` của mình trong tệp riêng và đăng ký ở modules.ts. */
export const CORE_ROUTES: Route[] = [
  { method: "GET", path: "/v1/me", handler: (c) => ({ status: 200, body: me(c) }) },
  {
    method: "POST", path: "/v1/plans", schema: "PlanInput", readable: ownPlan,
    handler: (c) => {
      const plan = createPlan(c.d.ctx, c.p.sub, c.ws, c.body as PlanInput, c.requestId);
      return { status: 201, body: plan, resource: { type: "plan", id: plan.plan_id } };
    },
  },
  { method: "GET", path: "/v1/plans/{plan_id}", handler: (c) => ({ status: 200, body: getPlan(c.d.ctx, c.p.sub, c.ws, c.params.plan_id) }) },
  {
    method: "POST", path: "/v1/plans/{plan_id}/approve", schema: "ApproveRequest", readable: ownPlan,
    handler: (c) => ({ status: 202, body: approvePlan(c.d.ctx, c.p.sub, c.ws, c.params.plan_id, c.body as { plan_version: number; approved_digest: string }, c.requestId), resource: { type: "plan", id: c.params.plan_id } }),
  },
  {
    method: "POST", path: "/v1/plans/{plan_id}/deny", schema: "Empty", optionalBody: true, readable: ownPlan,
    handler: (c) => ({ status: 200, body: closePlan(c.d.ctx, c.p.sub, c.ws, c.params.plan_id, "deny", c.requestId), resource: { type: "plan", id: c.params.plan_id } }),
  },
  {
    method: "POST", path: "/v1/plans/{plan_id}/cancel", schema: "Empty", optionalBody: true, readable: ownPlan,
    handler: (c) => ({ status: 200, body: closePlan(c.d.ctx, c.p.sub, c.ws, c.params.plan_id, "cancel", c.requestId), resource: { type: "plan", id: c.params.plan_id } }),
  },
  { method: "GET", path: "/v1/actions", handler: (c) => ({ status: 200, body: listActions(c.d.ctx, c.p.sub, c.ws) }) },
  { method: "GET", path: "/v1/actions/{action_id}", handler: (c) => ({ status: 200, body: getAction(c.d.ctx, c.p.sub, c.ws, c.params.action_id) }) },
  {
    method: "POST", path: "/v1/actions/{action_id}/cancel", schema: "Empty", optionalBody: true, readable: ownPlan,
    handler: (c) => ({ status: 200, body: cancelAction(c.d.ctx, c.p.sub, c.ws, c.params.action_id, c.requestId), resource: { type: "action", id: c.params.action_id } }),
  },
  { method: "GET", path: "/v1/calendar/availability", async: true, handler: availability },
  { method: "GET", path: "/v1/devices", handler: devices },
  {
    method: "POST", path: "/v1/grants/{grant_id}/revoke", schema: "Empty", optionalBody: true, readable: (c) => isMember(c),
    handler: (c) => {
      requireMember(c.d.ctx, c.ws, c.p.sub);
      return { status: 200, body: revokeGrant(c.d.ctx, c.ws, c.params.grant_id, c.p.sub, c.requestId), resource: { type: "grant", id: c.params.grant_id } };
    },
  },
  {
    method: "GET", path: "/v1/consents",
    handler: (c) => {
      requireMember(c.d.ctx, c.ws, c.p.sub);
      return { status: 200, body: { items: all<ConsentRow>(c.d.ctx.db, "SELECT * FROM consents WHERE workspace_id = ? AND user_id = ? ORDER BY at DESC", c.ws, c.p.sub).map(consentView) } };
    },
  },
  {
    method: "POST", path: "/v1/consents", schema: "ConsentCreate", readable: (c) => isMember(c),
    handler: (c) => {
      requireMember(c.d.ctx, c.ws, c.p.sub);
      const r = recordConsent(c.d.ctx, c.ws, c.p.sub, c.body as { purpose_id: string; text_version: string; text_hash: string; choice: "GRANTED" | "DECLINED" }, c.requestId);
      return { status: 201, body: r, resource: { type: "consent", id: r.id } };
    },
  },
  {
    method: "POST", path: "/v1/consents/{purpose_id}/withdraw", schema: "Empty", optionalBody: true, readable: (c) => isMember(c),
    handler: (c) => {
      requireMember(c.d.ctx, c.ws, c.p.sub);
      const purpose = c.params.purpose_id as Purpose;
      if (!PURPOSES.includes(purpose)) throw new ApiError(404, "NOT_FOUND");
      const r = withdrawConsent(c.d.ctx, c.ws, c.p.sub, purpose, c.requestId);
      return { status: 200, body: r, resource: { type: "consent", id: r.id } };
    },
  },
  {
    method: "POST", path: "/v1/privacy/requests", schema: "PrivacyRequestCreate", readable: (c) => isMember(c),
    handler: (c) => {
      const r = createPrivacyRequest(c.d.ctx, c.ws, c.p.sub, c.body as { type: "ACCESS" }, c.p.auth_time, c.requestId);
      return { status: 202, body: r, resource: { type: "privacy", id: r.request_id } };
    },
  },
  { method: "GET", path: "/v1/privacy/requests/{request_id}", handler: (c) => ({ status: 200, body: getPrivacyRequest(c.d.ctx, c.ws, c.p.sub, c.params.request_id) }) },
  { method: "GET", path: "/v1/privacy/exports/{token}", handler: (c) => ({ status: 200, body: downloadExport(c.d.ctx, c.ws, c.p.sub, c.params.token) }) },
  {
    method: "POST", path: "/v1/lele/proposals", schema: "LeLeRequest", async: true, readable: (c) => isMember(c),
    handler: async (c) => {
      const { ctx } = c.d;
      requireMember(ctx, c.ws, c.p.sub);
      if (!ctx.control.moduleOn("lele")) throw new ApiError(503, "MODULE_DISABLED");
      const b = c.body as { text: string; context: "work" | "home"; zone: string };
      // Phép chặn dùng chung với thiết bị chạy trước mọi tra cứu (LNH-T24): câu có từ sức khỏe hoặc dữ liệu cá nhân của bất kỳ
      // ngôn ngữ nào được trả lời bằng mã ngay tại đây. Câu chữ không được ghi vào sổ, log hay bảng nào: nhật ký chỉ giữ
      // {type, engine}, bảng idem_keys giữ mã băm của yêu cầu và phản hồi (phản hồi không chứa câu của người dùng).
      const screened = c.d.gateway.screen(b.text);
      if (screened) {
        audit(ctx.db, nowIso(ctx), { workspace_id: c.ws, actor: c.p.sub, action: "lele.propose", request_id: c.requestId, data: { type: screened.type, engine: screened.engine } });
        return { status: 200, body: screened, resource: { type: "lele", id: c.requestId } };
      }
      const devs = all<{ site: string; device_ref: string; name: string }>(ctx.db,
        "SELECT d.site_id AS site, d.device_ref, d.name FROM devices d JOIN grants g ON g.resource = d.site_id AND g.scope = 'home.control' AND g.status = 'ACTIVE' WHERE g.workspace_id = ? AND g.user_id = ? AND d.status = 'ACTIVE'",
        c.ws, c.p.sub);
      const r = await c.d.gateway.propose({ text: b.text, context: b.context, zone: b.zone, now: nowIso(ctx), workspace_ref: c.ws, devices: b.context === "home" ? devs : [] });
      audit(ctx.db, nowIso(ctx), { workspace_id: c.ws, actor: c.p.sub, action: "lele.propose", request_id: c.requestId, data: { type: r.type, engine: r.engine } });
      return { status: 200, body: r, resource: { type: "lele", id: c.requestId } };
    },
  },
  { method: "GET", path: "/v1/ops/unknown", handler: unknownList },
  {
    method: "POST", path: "/v1/ops/tickets/{ticket_id}/ack", schema: "Empty", optionalBody: true, readable: (c) => isMember(c),
    handler: (c) => {
      opsMember(c, OPERATOR);
      const { ctx } = c.d;
      return tx(ctx.db, () => {
        const t = one<Record<string, unknown>>(ctx.db, "SELECT t.*, a.action_id AS aid, a.workspace_id AS ws FROM tickets t JOIN actions a ON a.id = t.plan_id WHERE t.id = ?", c.params.ticket_id);
        if (!t || t.ws !== c.ws) throw new ApiError(404, "NOT_FOUND");
        if (t.status === "OPEN") run(ctx.db, "UPDATE tickets SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ? WHERE id = ?", nowIso(ctx), c.p.sub, c.params.ticket_id);
        const after = one<Record<string, unknown>>(ctx.db, "SELECT * FROM tickets WHERE id = ?", c.params.ticket_id) as Record<string, unknown>;
        audit(ctx.db, nowIso(ctx), { workspace_id: c.ws, actor: c.p.sub, action: "ticket.ack", target: c.params.ticket_id, request_id: c.requestId });
        return { status: 200, body: ticketView(after, t.aid as string), resource: { type: "ticket", id: c.params.ticket_id } };
      });
    },
  },
  {
    method: "POST", path: "/v1/ops/actions/{action_id}/evidence", schema: "EvidenceCreate", readable: (c) => isMember(c),
    handler: (c) => {
      opsMember(c, OPERATOR);
      const { ctx } = c.d;
      const row = getByActionId(ctx.db, c.params.action_id);
      if (!row || row.workspace_id !== c.ws) throw new ApiError(404, "NOT_FOUND");
      if (row.state === "DISPATCHING" || row.state === "AUTHORIZED") throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: row.state } });
      const b = c.body as { grade: "PROVIDER_READBACK" | "DEVICE_REPORTED" | "PHYSICAL_OBSERVED"; result: "MATCH" | "CONFLICT" | "NO_EFFECT"; source: string; observed_at: string; note: string };
      if (b.result === "NO_EFFECT" && row.state === "ACKED") throw new ApiError(409, "INVALID_TRANSITION", { extra: { state: row.state } });
      const evidence = { grade: b.grade, source: `operator:${b.source}`, observed_at: b.observed_at, data: { note: b.note, operator: c.p.sub } };
      const outcomes = moduleKind(ctx, row.kind)?.outcomes;
      const outcome = row.kind === "calendar.block" ? "EVENT_CREATED" : row.kind === "robot.simulate" ? "SIMULATED" : outcomes?.match ?? "APPLIED";
      const rb: Readback = b.result === "MATCH" ? { result: "MATCH", evidence, outcome } : b.result === "CONFLICT" ? { result: "CONFLICT", evidence, event_created: row.kind === "calendar.block", outcome: row.kind === "calendar.block" ? "EVENT_CHANGED" : outcomes?.conflict ?? "NO_EFFECT" } : { result: "NO_EFFECT", evidence };
      const next = resolveWithEvidence(ctx, row.id, rb, `operator:${c.p.sub}`) as ActionRow;
      audit(ctx.db, nowIso(ctx), { workspace_id: c.ws, actor: c.p.sub, action: "ops.evidence", target: c.params.action_id, request_id: c.requestId, data: { grade: b.grade, result: b.result } });
      return { status: 200, body: actionView(ctx, next), resource: { type: "action", id: c.params.action_id } };
    },
  },
  { method: "GET", path: "/v1/ops/flags", handler: (c) => (opsMember(c, ["LEDB_OPERATOR", "INCIDENT_LEAD"]), { status: 200, body: flagsView(c) }) },
  {
    method: "POST", path: "/v1/ops/flags", schema: "FlagUpdate", readable: (c) => isMember(c),
    handler: (c) => {
      opsMember(c, ["LEDB_OPERATOR", "INCIDENT_LEAD"]);
      const b = c.body as { module: ModuleName; site?: string; enabled: boolean; reason: string };
      const at = nowIso(c.d.ctx);
      if (b.site) {
        if (b.module !== "home") throw new ApiError(400, "SCHEMA_INVALID");
        c.d.ctx.control.setSite(at, c.p.sub, b.site, b.enabled, b.reason);
      } else c.d.ctx.control.setModule(at, c.p.sub, b.module, b.enabled, b.reason);
      audit(c.d.ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "ops.flag", target: b.site ?? b.module, request_id: c.requestId, data: { enabled: b.enabled } });
      return { status: 200, body: flagsView(c), resource: { type: "flag", id: b.site ?? b.module } };
    },
  },
  { method: "GET", path: "/v1/ops/metrics", handler: (c) => (opsMember(c, OPERATOR), { status: 200, body: metricsView(c) }) },
  ...(["reset", "recommission", "decommission"] as const).map((op): Route => ({
    method: "POST", path: `/v1/ops/devices/{device_ref}/${op}`, schema: "DeviceOp", readable: (c) => isMember(c),
    handler: (c) => {
      opsMember(c, SITE_OPERATOR);
      const d = one<{ workspace_id: string }>(c.d.ctx.db, "SELECT workspace_id FROM devices WHERE device_ref = ?", c.params.device_ref);
      if (!d || d.workspace_id !== c.ws) throw new ApiError(404, "NOT_FOUND");
      const b = c.body as { reason: string; firmware?: string };
      const next = op === "reset" ? "QUARANTINED" : op === "recommission" ? "ACTIVE" : "DECOMMISSIONED";
      changeBinding(c.d.ctx, c.params.device_ref, next, b.reason, c.p.sub, b.firmware);
      return { status: 200, body: deviceView(c, c.params.device_ref), resource: { type: "device", id: c.params.device_ref } };
    },
  })),
];

const routesOf = (modules: readonly ServerModule[]) => [...CORE_ROUTES, ...modules.flatMap((m) => m.routes ?? [])];

/** Mọi route của bản đang phát hành (lõi + MODULES): đối chiếu với OpenAPI trong scripts/check-contracts.ts. */
export const ROUTES: Route[] = routesOf(MODULES);

const compile = (routes: Route[]) => routes.map((r) => {
  const keys: string[] = [];
  const re = new RegExp("^" + r.path.replace(/\{([a-z_]+)\}/g, (_, k) => (keys.push(k), "([A-Za-z0-9_-]{1,128})")) + "$");
  return { ...r, re, keys };
});

// Tệp giao diện được phục vụ: tên khớp đúng mẫu, không có ".." hay "/" trong phần tên nên không thoát khỏi web/.
// V1.0.0 thêm icons/<tên>.png (icon ứng dụng), views/<tên>.js và views/<tên>.css (màn hình của sổ đăng ký), manifest.json (PWA).
const WEB_FILE = /^\/(?:(?:index\.html|styles\.css|app\.js|model\.js|api\.js|lele\.js|health\.js|icon\.svg|manifest\.json)|shared\/[a-z0-9-]+\.js|views\/[a-z0-9-]+\.(?:js|css)|icons\/[a-z0-9-]+\.png)$/;
// Tệp .json tĩnh duy nhất trong danh sách là manifest.json nên kiểu của "json" là kiểu manifest; JSON của API đi qua send().
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml", json: "application/manifest+json", png: "image/png" };

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
};
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, "BODY_TOO_LARGE");
    chunks.push(chunk as Buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ApiError(400, "SCHEMA_INVALID");
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(text);
}

export function createHandler(d: ApiDeps) {
  const compiled = compile(routesOf(d.modules));
  const devRoutes = new Map(d.modules.flatMap((m) => m.devRoutes ?? []).map((r) => [r.path, r]));
  const buckets = new Map<string, { tokens: number; at: number }>();
  function rateLimit(key: string, now: number) {
    const { perSecond, burst } = d.ctx.config.rateLimit;
    const b = buckets.get(key) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + (Math.max(0, now - b.at) / 1000) * perSecond);
    b.at = now;
    if (b.tokens < 1) {
      buckets.set(key, b);
      throw new ApiError(429, "RATE_LIMITED", { retryable: true, headers: { "Retry-After": "1" } });
    }
    b.tokens -= 1;
    buckets.set(key, b);
  }
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const requestId = `req_${randomBytes(9).toString("base64url")}`;
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    let status = 500;
    let routeName = "static";
    try {
      if (url.pathname === "/healthz") {
        status = 200;
        return send(res, 200, { ok: true, dispatch_open: d.ctx.control.dispatchOpen() });
      }
      if (url.pathname.startsWith("/dev/")) {
        routeName = url.pathname;
        if (!d.dev) throw new ApiError(404, "NOT_FOUND");
        if (method === "GET" && url.pathname === "/dev/users") return send(res, (status = 200), { users: d.devUsers });
        if (method === "POST" && url.pathname === "/dev/token") {
          rateLimit(`dev:${req.socket.remoteAddress}`, d.ctx.clock.now());
          const b = parseStrictJson(await readBody(req, 1024), 4) as { sub?: string };
          const u = d.devUsers.find((x) => x.sub === b?.sub);
          if (!u) throw new ApiError(404, "NOT_FOUND");
          return send(res, (status = 200), { token: d.dev.mint(u.sub, u.name, d.ctx.clock.now()), expires_in: 900 });
        }
        // Đường dev của mô-đun (ServerModule.devRoutes): chỉ GET, chỉ khi có issuer phát triển; chuyển hướng chỉ trong cùng gốc.
        const devRoute = method === "GET" ? devRoutes.get(url.pathname) : undefined;
        if (devRoute) {
          rateLimit(`dev:${req.socket.remoteAddress}`, d.ctx.clock.now());
          const out = devRoute.handler(d, url.searchParams);
          if (out.status === 200) return send(res, (status = 200), out.body);
          if (!/^\/(?![/\\])[\x21-\x7e]*$/.test(out.location)) throw new Error("đường dev chỉ được chuyển hướng trong cùng gốc");
          res.writeHead((status = 302), { ...SECURITY_HEADERS, Location: out.location, "Cache-Control": "no-store" });
          return res.end();
        }
        throw new ApiError(404, "NOT_FOUND");
      }
      if (!url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v2/")) {
        if (method !== "GET") throw new ApiError(404, "NOT_FOUND");
        const path = url.pathname === "/" ? "/index.html" : url.pathname;
        if (!WEB_FILE.test(path)) throw new ApiError(404, "NOT_FOUND");
        const file = new URL("." + path, d.webRoot);
        if (!existsSync(file)) throw new ApiError(404, "NOT_FOUND");
        const ext = path.slice(path.lastIndexOf(".") + 1);
        res.writeHead((status = 200), { ...SECURITY_HEADERS, "Content-Type": TYPES[ext], "Cache-Control": "no-cache", ...(ext === "html" ? { "Content-Security-Policy": CSP } : {}) });
        return res.end(readFileSync(file));
      }
      const route = compiled.find((r) => r.method === method && r.re.test(url.pathname));
      if (!route) throw new ApiError(compiled.some((r) => r.re.test(url.pathname)) ? 405 : 404, compiled.some((r) => r.re.test(url.pathname)) ? "UNSUPPORTED" : "NOT_FOUND");
      routeName = route.path;
      const m = route.re.exec(url.pathname) as RegExpExecArray;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, m[i + 1]]));
      const p = d.verifier.verify(req.headers.authorization, d.ctx.clock.now());
      const ws = String(req.headers["x-lenhip-workspace"] ?? "");
      if (!/^ws_[a-z0-9_]{1,40}$/.test(ws)) throw new ApiError(400, "SCHEMA_INVALID", { detail: "Thiếu hoặc sai X-LeNhip-Workspace.", extra: { detail_code: "WORKSPACE_HEADER" } });
      rateLimit(`u:${p.sub}`, d.ctx.clock.now());
      let body: unknown = undefined;
      if (method === "POST") {
        const text = await readBody(req, d.ctx.config.maxBodyBytes);
        if (text.length === 0) {
          if (!route.optionalBody) throw new ApiError(400, "SCHEMA_INVALID");
          body = {};
        } else {
          if (!/^application\/json(;\s*charset=utf-8)?$/i.test(String(req.headers["content-type"] ?? ""))) throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE");
          try {
            body = parseStrictJson(text);
          } catch (e) {
            if (e instanceof JsonError) throw new ApiError(400, e.code);
            throw e;
          }
        }
        const issues = d.schemas.validate(route.schema as string, body);
        if (issues.length) throw new ApiError(400, "SCHEMA_INVALID", { extra: { issues: issues.slice(0, 10).map((x) => ({ path: x.path, rule: x.rule })) } });
      }
      const call: Call = { d, p, ws, params, query: url.searchParams, body, requestId };
      let out: Stored & { replayed?: boolean };
      if (method === "POST") {
        const o = { ws, actor: p.sub, method, route: url.pathname, key: req.headers["idempotency-key"] as string | undefined, body, readable: (r: { type: string; id: string } | null) => (route.readable ? route.readable(call, r) : true) };
        out = route.async ? await d.idem.run(o, async () => route.handler(call)) : d.idem.runSync(o, () => route.handler(call) as Stored);
      } else {
        out = await route.handler(call);
      }
      status = out.status;
      return send(res, out.status, out.body, { "X-Request-Id": requestId, ...(out.replayed ? { "Idempotent-Replayed": "true" } : {}) });
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, "INTERNAL");
      if (!(e instanceof ApiError)) console.error(JSON.stringify({ at: new Date().toISOString(), level: "error", request_id: requestId, route: routeName, error: (e as Error).name }));
      status = err.status;
      if (err.status === 403 || err.code === "PLAN_STALE" || err.code === "CONSENT_REQUIRED") d.metrics.policyDenials++;
      return send(res, err.status, { code: err.code, message: MESSAGES[err.code] ? err.message : err.message, request_id: requestId, retryable: err.retryable, ...err.extra }, { "X-Request-Id": requestId, ...err.headers });
    } finally {
      d.metrics.requests++;
      d.metrics.recent.push({ at: d.ctx.clock.now(), status });
      if (d.metrics.recent.length > 5000) d.metrics.recent.splice(0, d.metrics.recent.length - 5000);
      if (process.env.LENHIP_LOG === "1") console.log(JSON.stringify({ at: new Date().toISOString(), request_id: requestId, method, route: routeName, status, ms: Date.now() - started }));
    }
  };
}

