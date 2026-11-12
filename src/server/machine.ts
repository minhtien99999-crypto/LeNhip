// Máy trạng thái theo sự kiện (SRS mục 18–19). Bảng cạnh đọc thẳng từ contracts/state_transitions.csv: hợp đồng là nguồn duy
// nhất. Mỗi mutation CAS theo revision, tăng revision đúng một lần, gắn event_id duy nhất; sự kiện lặp lại (cùng event_id) trả
// bản đã biết. Mọi cạnh không có trong bảng bị từ chối.
// Tệp CSV chứa nhiều máy: máy tác vụ là các hàng có `from` thuộc 12 trạng thái tác vụ; mỗi máy khác dùng một tiền tố trạng thái
// riêng (ví dụ THREAD_ của hội thoại, LNH-T33) và được nạp bằng transitionsFor(tiền tố). Máy khác không đi qua apply() ở đây.
import { readFileSync } from "node:fs";
import { ApiError } from "../core/errors.ts";
import { uuid } from "../core/crypto.ts";
import { type Db, one, run, tx } from "./store.ts";

export type State =
  | "DRAFT" | "PENDING_APPROVAL" | "AUTHORIZED" | "DISPATCHING" | "ACKED" | "UNKNOWN"
  | "VERIFIED" | "FAILED" | "CONFLICT" | "REJECTED" | "EXPIRED" | "CANCELED";
export type ActorKind = "API" | "USER" | "AUTHORITY" | "SCHEDULER" | "RECEIVER" | "ADAPTER" | "VERIFIER" | "RECONCILER";

export const ACTION_STATES: readonly State[] = [
  "DRAFT", "PENDING_APPROVAL", "AUTHORIZED", "DISPATCHING", "ACKED", "UNKNOWN", "VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED",
];
export const TERMINAL: ReadonlySet<State> = new Set(["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"]);

/** Một cạnh của bảng hợp đồng. Máy tác vụ dùng State và ActorKind; máy khác (theo tiền tố) dùng chuỗi của riêng nó. */
export interface Transition<S extends string = State, A extends string = ActorKind> {
  from: S;
  event: string;
  actor: A;
  to: S;
  guard: string;
  /** Cột ref: mục SRS hoặc mã LNH-T quyết định cạnh này. */
  ref: string;
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

const CSV_URL = new URL("../../contracts/state_transitions.csv", import.meta.url);

/** Mọi hàng của bảng hợp đồng, chưa chia theo máy. `text` chỉ truyền khi kiểm thử. */
export function parseTransitions(text: string = readFileSync(CSV_URL, "utf8")): Transition<string, string>[] {
  const [head, ...body] = parseCsv(text);
  const idx = (k: string) => {
    const i = head.indexOf(k);
    if (i < 0) throw new Error(`state_transitions.csv thiếu cột ${k}`);
    return i;
  };
  const cols = { from: idx("from"), event: idx("event"), actor: idx("actor"), to: idx("to"), guard: idx("guard"), ref: idx("ref") };
  return body.map((r) => ({ from: r[cols.from], event: r[cols.event], actor: r[cols.actor], to: r[cols.to], guard: r[cols.guard], ref: r[cols.ref] ?? "" }));
}

const isActionState = (s: string) => (ACTION_STATES as readonly string[]).includes(s);

/** Tên máy của một trạng thái: "" cho máy tác vụ, còn lại là tiền tố tới hết dấu gạch dưới đầu tiên (THREAD_ACTIVE → THREAD_). */
export function machineOf(state: string): string {
  if (isActionState(state)) return "";
  const i = state.indexOf("_");
  if (i < 1) throw new Error(`trạng thái ${state} không thuộc máy nào (thiếu tiền tố)`);
  return state.slice(0, i + 1);
}

/** Máy tác vụ: các hàng có `from` là trạng thái tác vụ. Hàng của máy khác (có tiền tố riêng) không lọt vào đây. */
export function loadTransitions(text?: string): Transition[] {
  return parseTransitions(text).filter((t) => isActionState(t.from)) as Transition[];
}

/**
 * Bảng cạnh của một máy khác, nhận diện bằng tiền tố trạng thái, ví dụ transitionsFor("THREAD_"). Tiền tố có dạng CHỮ_HOA_ và
 * không được trùng đầu tên một trạng thái tác vụ; cạnh đi ra ngoài tiền tố bị từ chối ngay khi nạp. Trả mảng rỗng nếu chưa có hàng.
 */
export function transitionsFor(prefix: string, text?: string): Transition<string, string>[] {
  if (!/^[A-Z][A-Z0-9]*_$/.test(prefix)) throw new Error(`tiền tố máy trạng thái không hợp lệ: ${prefix}`);
  if (ACTION_STATES.some((s) => s.startsWith(prefix))) throw new Error(`tiền tố ${prefix} trùng trạng thái của máy tác vụ`);
  const rows = parseTransitions(text).filter((t) => t.from.startsWith(prefix));
  for (const t of rows) if (!t.to.startsWith(prefix)) throw new Error(`cạnh ${t.from} → ${t.to} ra ngoài máy ${prefix}`);
  return rows;
}

/** Tra cạnh theo (trạng thái, sự kiện, actor). Hai hàng cùng khóa là lỗi của bảng hợp đồng. */
export function indexTransitions<S extends string, A extends string>(rows: Transition<S, A>[]) {
  const table = new Map<string, Transition<S, A>>();
  for (const t of rows) {
    const k = `${t.from}|${t.event}|${t.actor}`;
    if (table.has(k)) throw new Error(`state_transitions.csv có hai hàng cho ${k}`);
    table.set(k, t);
  }
  return (from: S, event: string, actor: A): Transition<S, A> | undefined => table.get(`${from}|${event}|${actor}`);
}

export const TRANSITIONS = loadTransitions();
const actionLookup = indexTransitions(TRANSITIONS);

export function lookup(from: State, event: string, actor: ActorKind): Transition | undefined {
  return actionLookup(from, event, actor);
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
