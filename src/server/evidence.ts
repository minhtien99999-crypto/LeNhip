// Bằng chứng, receipt và ticket của đối soát (SRS mục 19–20). Bằng chứng chỉ được thêm, không sửa; kết quả đã chốt không ghi
// lùi, bằng chứng muộn mâu thuẫn mở ticket DISCREPANCY.
import { uuid } from "../core/crypto.ts";
import { type Ctx, nowIso } from "./context.ts";
import { apply, getRow, type ActionRow, TERMINAL } from "./machine.ts";
import { audit, one, run, tx } from "./store.ts";

const iso = (ms: number) => new Date(ms).toISOString();

export type Grade = "PROVIDER_READBACK" | "DEVICE_REPORTED" | "PHYSICAL_OBSERVED" | "SIMULATED";

export interface Evidence {
  grade: Grade;
  source: string;
  observed_at: string;
  data: Record<string, unknown>;
}

export type Readback =
  | { result: "MATCH"; evidence: Evidence; provider_ref?: string | null; outcome: string }
  | { result: "CONFLICT"; evidence: Evidence; event_created: boolean; outcome: string }
  | { result: "NO_EFFECT"; evidence: Evidence }
  | { result: "UNDETERMINED"; retryAfterMs?: number; note: string };

export function recordEvidence(ctx: Ctx, planId: string, ev: Evidence, result: string, by: string, late = false) {
  run(ctx.db, "INSERT INTO evidence (id, plan_id, grade, result, source, observed_at, recorded_at, recorded_by, late, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    `ev_${uuid()}`, planId, ev.grade, result, ev.source, ev.observed_at, new Date(ctx.clock.now()).toISOString(), by, late ? 1 : 0, JSON.stringify(ev.data));
}

/** Đóng ticket của action đã có kết quả. */
export function closeTickets(ctx: Ctx, planId: string) {
  run(ctx.db, "UPDATE tickets SET status = 'CLOSED', closed_at = ? WHERE plan_id = ? AND status <> 'CLOSED' AND kind = 'UNKNOWN_SLA'", nowIso(ctx), planId);
}

/** Áp kết quả đọc lại hoặc bằng chứng của operator. Trả hàng mới, hoặc null nếu chưa kết luận. */
export function resolveWithEvidence(ctx: Ctx, planId: string, rb: Readback, by: string): ActionRow | null {
  return tx(ctx.db, () => {
    let row = getRow(ctx.db, planId) as ActionRow;
    const at = nowIso(ctx);
    if (rb.result === "UNDETERMINED") return null;
    const result = rb.result === "MATCH" ? "MATCH" : rb.result === "CONFLICT" ? "CONFLICT" : "NO_EFFECT";
    if (TERMINAL.has(row.state)) {
      // Bằng chứng muộn: chỉ thêm vào hồ sơ, mở discrepancy nếu mâu thuẫn, không ghi lùi kết quả đã chốt.
      recordEvidence(ctx, planId, rb.evidence, result, by, true);
      const agrees = (row.state === "VERIFIED" && result === "MATCH") || (row.state === "CONFLICT" && result === "CONFLICT") || (row.state === "FAILED" && result === "NO_EFFECT");
      apply(ctx.db, { planId, event: "late_evidence", actorKind: "VERIFIER", actor: by, at, data: { result, agrees } });
      if (!agrees) openTicket(ctx, row, "DISCREPANCY");
      return getRow(ctx.db, planId) as ActionRow;
    }
    recordEvidence(ctx, planId, rb.evidence, result, by);
    if (row.state === "DISPATCHING" && rb.result !== "NO_EFFECT") {
      // Đọc lại thấy tác động khi ACK đã mất: ghi receipt từ bản đọc rồi mới xác minh.
      const ref = rb.result === "MATCH" ? rb.provider_ref ?? null : null;
      run(ctx.db, "INSERT INTO receipts (id, plan_id, receiver, provider_ref, digest, at) VALUES (?, ?, ?, ?, ?, ?)", `rc_${uuid()}`, planId, `readback:${by}`, ref, row.payload_digest, at);
      row = apply(ctx.db, { planId, event: "ack", actorKind: "ADAPTER", actor: by, at, eventId: `ack:${planId}`, set: { acked_at: at, provider_ref: ref ?? row.provider_ref, dispatch_state: "SENT" } }).row;
    }
    const base = { evidence_grade: rb.evidence.grade, last_observed_at: rb.evidence.observed_at, reconciliation_status: row.state === "UNKNOWN" ? "RESOLVED" : row.reconciliation_status };
    let next: ActionRow;
    if (rb.result === "MATCH") {
      next = apply(ctx.db, { planId, event: "verified", actorKind: "VERIFIER", actor: by, at, set: { ...base, outcome: rb.outcome, provider_ref: rb.provider_ref ?? row.provider_ref } }).row;
    } else if (rb.result === "CONFLICT") {
      next = apply(ctx.db, { planId, event: "confirmed_conflict", actorKind: "VERIFIER", actor: by, at, set: { ...base, outcome: rb.outcome, event_created: rb.event_created ? 1 : 0 } }).row;
    } else {
      const event = row.state === "DISPATCHING" ? "no_effect_failure" : "confirmed_no_effect";
      next = apply(ctx.db, { planId, event, actorKind: "VERIFIER", actor: by, at, set: { ...base, outcome: "NO_EFFECT", reason: "CONFIRMED_NO_EFFECT" } }).row;
    }
    closeTickets(ctx, planId);
    run(ctx.db, "UPDATE checks SET next_at = NULL WHERE plan_id = ?", planId);
    return next;
  });
}

export function openTicket(ctx: Ctx, row: ActionRow, kind: "UNKNOWN_SLA" | "DISCREPANCY" | "RECOVERY") {
  const existing = one<{ id: string }>(ctx.db, "SELECT id FROM tickets WHERE plan_id = ? AND kind = ? AND status <> 'CLOSED'", row.id, kind);
  if (existing) return existing.id;
  const id = `tk_${uuid()}`;
  const now = ctx.clock.now();
  run(ctx.db, "INSERT INTO tickets (id, plan_id, kind, status, support_code, opened_at, ack_due_at) VALUES (?, ?, ?, 'OPEN', ?, ?, ?)",
    id, row.id, kind, row.support_code ?? "LNH-0000-0000", iso(now), iso(now + ctx.config.unknown.ackDueMs));
  audit(ctx.db, iso(now), { workspace_id: row.workspace_id, actor: "reconciler", action: `ticket.open.${kind.toLowerCase()}`, target: id, data: { action_id: row.action_id } });
  return id;
}


/**
 * Kết quả I/O về sau khi action đã rời DISPATCHING (ACK trễ, phản hồi sau khi đã UNKNOWN hoặc đã kết thúc): luôn ghi receipt hoặc
 * bằng chứng; với action đã kết thúc, thêm late_evidence và mở DISCREPANCY nếu mâu thuẫn. Không đổi kết quả đã chốt.
 */
export function lateResult(ctx: Ctx, planId: string, r: { result: "ACK"; provider_ref: string | null } | { result: "NO_EFFECT"; reason: string; evidence: Evidence }, receiver: string) {
  tx(ctx.db, () => {
    const row = getRow(ctx.db, planId) as ActionRow;
    const at = nowIso(ctx);
    if (r.result === "ACK") {
      run(ctx.db, "INSERT INTO receipts (id, plan_id, receiver, provider_ref, digest, at) VALUES (?, ?, ?, ?, ?, ?)", `rc_${uuid()}`, planId, `${receiver}:late`, r.provider_ref, row.payload_digest, at);
    } else {
      recordEvidence(ctx, planId, r.evidence, "NO_EFFECT", `${receiver}:late`, true);
    }
    if (TERMINAL.has(row.state)) {
      const contradicts = r.result === "ACK" ? !["VERIFIED", "CONFLICT"].includes(row.state) : row.state === "VERIFIED";
      apply(ctx.db, { planId, event: "late_evidence", actorKind: "VERIFIER", actor: receiver, at, data: { late: r.result, contradicts } });
      if (contradicts) openTicket(ctx, row, "DISCREPANCY");
    }
  });
}
