// Máy trạng thái theo sự kiện (SRS mục 18–19). Bảng cạnh đọc thẳng từ contracts/state_transitions.csv: hợp đồng là nguồn duy
// nhất. Mỗi mutation CAS theo revision, tăng revision đúng một lần, gắn event_id duy nhất; sự kiện lặp lại (cùng event_id) trả
// bản đã biết. Mọi cạnh không có trong bảng bị từ chối.
import { readFileSync } from "node:fs";
import { ApiError } from "../core/errors.ts";
import { uuid } from "../core/crypto.ts";
import { type Db, one, run, tx } from "./store.ts";

export type State =
  | "DRAFT" | "PENDING_APPROVAL" | "AUTHORIZED" | "DISPATCHING" | "ACKED" | "UNKNOWN"
  | "VERIFIED" | "FAILED" | "CONFLICT" | "REJECTED" | "EXPIRED" | "CANCELED";
export type ActorKind = "API" | "USER" | "AUTHORITY" | "SCHEDULER" | "RECEIVER" | "ADAPTER" | "VERIFIER" | "RECONCILER";

export const TERMINAL: ReadonlySet<State> = new Set(["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"]);

export interface Transition {
  from: State;
  event: string;
  actor: ActorKind;
  to: State;
  guard: string;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") cells.push(cur), (cur = "");
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

export function loadTransitions(): Transition[] {
  const rows = parseCsv(readFileSync(new URL("../../contracts/state_transitions.csv", import.meta.url), "utf8"));
  const [head, ...body] = rows;
  const idx = (k: string) => head.indexOf(k);
  return body.map((r) => ({ from: r[idx("from")] as State, event: r[idx("event")], actor: r[idx("actor")] as ActorKind, to: r[idx("to")] as State, guard: r[idx("guard")] }));
}

export const TRANSITIONS = loadTransitions();
const TABLE = new Map(TRANSITIONS.map((t) => [`${t.from}|${t.event}|${t.actor}`, t]));

export function lookup(from: State, event: string, actor: ActorKind): Transition | undefined {
  return TABLE.get(`${from}|${event}|${actor}`);
}

/** Các cột được phép đổi cùng một sự kiện (tránh ghi tùy ý vào sổ). */
const MUTABLE = new Set([
  "action_id", "plan_version", "outcome", "evidence_grade", "dispatch_state", "reconciliation_status", "reason", "cancel_requested",
  "event_created", "provider_ref", "transaction_id", "support_code", "submitted_at", "approval_deadline", "authorized_at",
  "dispatch_deadline", "dispatch_claimed_at", "claimed_revision", "first_io_at", "acked_at", "unknown_after", "unknown_since",
  "last_observed_at",
]);

export interface ActionRow {
  id: string;
  action_id: string | null;
  workspace_id: string;
  actor: string;
  kind: string;
  schema_version: number;
  input: string;
  payload: string;
  payload_digest: string;
  resource_key: string;
  window_start: string | null;
  window_end: string | null;
  site_id: string | null;
  target_ref: string;
  authz_version: number;
  export_policy_digest: string;
  target_binding_version: number;
  state: State;
  revision: number;
  plan_version: number;
  outcome: string | null;
  evidence_grade: string | null;
  dispatch_state: string;
  reconciliation_status: string | null;
  reason: string | null;
  cancel_requested: number;
  event_created: number | null;
  provider_ref: string | null;
  transaction_id: string | null;
  support_code: string | null;
  imported: number;
  created_at: string;
  submitted_at: string | null;
  approval_deadline: string | null;
  authorized_at: string | null;
  dispatch_deadline: string | null;
  dispatch_claimed_at: string | null;
  claimed_revision: number | null;
  first_io_at: string | null;
  acked_at: string | null;
  unknown_after: string | null;
  unknown_since: string | null;
  last_observed_at: string | null;
  terminal_at: string | null;
  updated_at: string;
}

export const getRow = (db: Db, planId: string) => one<ActionRow>(db, "SELECT * FROM actions WHERE id = ?", planId);
export const getByActionId = (db: Db, actionId: string) => one<ActionRow>(db, "SELECT * FROM actions WHERE action_id = ?", actionId);

export interface EventInput {
  planId: string;
  event: string;
  actorKind: ActorKind;
  actor?: string | null;
  at: string;
  /** event_id do bên phát sinh đặt (ví dụ ack:<receipt>) để sự kiện lặp lại không tạo revision mới. */
  eventId?: string;
  /** CAS: revision bên gọi đã thấy; khác thì từ chối. */
  expectRevision?: number;
  set?: Record<string, string | number | null>;
  data?: Record<string, unknown>;
}

export interface Applied {
  row: ActionRow;
  replayed: boolean;
}

export class TransitionError extends ApiError {
  constructor(code: "INVALID_TRANSITION" | "ACTION_FINAL" | "STALE_REVISION", state: State) {
    super(409, code === "STALE_REVISION" ? "INVALID_TRANSITION" : code, { extra: { state } });
  }
}

/** Áp một sự kiện. Chạy trong giao dịch của bên gọi nếu có. */
export function apply(db: Db, e: EventInput): Applied {
  return tx(db, () => {
    if (e.eventId) {
      const seen = one<{ plan_id: string }>(db, "SELECT plan_id FROM action_events WHERE event_id = ?", e.eventId);
      if (seen) {
        const row = getRow(db, seen.plan_id);
        if (!row || seen.plan_id !== e.planId) throw new Error("event_id đã dùng cho tác vụ khác");
        return { row, replayed: true };
      }
    }
    const row = getRow(db, e.planId);
    if (!row) throw new ApiError(404, "NOT_FOUND");
    if (e.expectRevision !== undefined && row.revision !== e.expectRevision) throw new TransitionError("STALE_REVISION", row.state);
    const t = lookup(row.state, e.event, e.actorKind);
    if (!t) throw new TransitionError(TERMINAL.has(row.state) ? "ACTION_FINAL" : "INVALID_TRANSITION", row.state);
    const sets: string[] = ["state = ?", "revision = revision + 1", "updated_at = ?"];
    const args: (string | number | null)[] = [t.to, e.at];
    for (const [k, v] of Object.entries(e.set ?? {})) {
      if (!MUTABLE.has(k)) throw new Error(`cột không được đổi: ${k}`);
      sets.push(`${k} = ?`);
      args.push(v);
    }
    if (TERMINAL.has(t.to) && !TERMINAL.has(row.state)) {
      sets.push("terminal_at = ?");
      args.push(e.at);
    }
    const res = run(db, `UPDATE actions SET ${sets.join(", ")} WHERE id = ? AND revision = ?`, ...args, row.id, row.revision);
    if (Number(res.changes) !== 1) throw new TransitionError("STALE_REVISION", row.state);
    run(db, "INSERT INTO action_events (event_id, plan_id, seq, from_state, event, actor_kind, actor, to_state, data, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      e.eventId ?? uuid(), row.id, row.revision + 1, row.state, e.event, e.actorKind, e.actor ?? null, t.to, JSON.stringify(e.data ?? {}), e.at);
    return { row: getRow(db, row.id) as ActionRow, replayed: false };
  });
}
