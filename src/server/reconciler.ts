// Đối soát kết quả (SRS mục 19–20, REC01). Reconciler đọc lại theo lịch, chuyển DISPATCHING/ACKED quá hạn sang UNKNOWN, đọc
// UNKNOWN tại t = 0, 5, 15, 30, 60 giây rồi mỗi 60 giây có jitter, mở ticket sau 5 phút, escalate sau 1 giờ, MANUAL_REQUIRED sau
// 24 giờ. Không bao giờ tự chuyển FAILED để giải phóng hàng đợi; FAILED chỉ đến từ nguồn authoritative xác nhận không tác động.
import { createHash } from "node:crypto";
import { uuid } from "../core/crypto.ts";
import { type Ctx, nowIso } from "./context.ts";
import type { Kind } from "./authority.ts";
import { apply, getRow, type ActionRow, TERMINAL } from "./machine.ts";
import { expireDue } from "./plans.ts";
import type { DispatchAdapter } from "./receiver.ts";
import { openTicket, recordEvidence, resolveWithEvidence, type Evidence, type Readback } from "./evidence.ts";
import { all, audit, one, run, tx } from "./store.ts";

const iso = (ms: number) => new Date(ms).toISOString();

function setCheck(ctx: Ctx, planId: string, next: number | null, note: string) {
  run(ctx.db, `INSERT INTO checks (plan_id, next_at, attempts, last_at, last_note) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(plan_id) DO UPDATE SET next_at = excluded.next_at, attempts = attempts + 1, last_at = excluded.last_at, last_note = excluded.last_note`,
    planId, next === null ? null : iso(next), nowIso(ctx), note.slice(0, 200));
}

function scheduleOnly(ctx: Ctx, planId: string, next: number) {
  run(ctx.db, `INSERT INTO checks (plan_id, next_at, attempts) VALUES (?, ?, 0) ON CONFLICT(plan_id) DO UPDATE SET next_at = excluded.next_at`, planId, iso(next));
}

/** Lịch đọc UNKNOWN: 0, 5, 15, 30, 60 giây sau khi vào UNKNOWN, rồi mỗi 60 giây, jitter dương tối đa 10 % (xác định theo action). */
export function nextUnknownRead(ctx: Ctx, row: ActionRow, attempts: number, now: number) {
  const since = Date.parse(row.unknown_since as string);
  const u = ctx.config.unknown;
  let at = attempts < u.readsAtMs.length ? since + u.readsAtMs[attempts] : since + u.readsAtMs[u.readsAtMs.length - 1] + (attempts - u.readsAtMs.length + 1) * u.everyMs;
  if (attempts >= u.readsAtMs.length) {
    const h = createHash("sha256").update(`${row.id}:${attempts}`).digest();
    at += Math.floor((h.readUInt16BE(0) / 65535) * u.jitter * u.everyMs);
  }
  return Math.max(at, now);
}

export class Reconciler {
  private readonly ctx: Ctx;
  private readonly adapters: Map<Kind, DispatchAdapter>;
  stats = { reads: 0, resolved: 0, unknown: 0, tickets: 0, escalated: 0, manual: 0 };

  constructor(ctx: Ctx, adapters: Map<Kind, DispatchAdapter>) {
    this.ctx = ctx;
    this.adapters = adapters;
  }

  private barrierHas(actionId: string) {
    return this.ctx.barrier.readAll().entries.some((e) => e.type === "dispatch" && e.action_id === actionId);
  }

  private async read(row: ActionRow, adapter: DispatchAdapter): Promise<Readback> {
    this.stats.reads++;
    try {
      return await adapter.readback(row);
    } catch (e) {
      return { result: "UNDETERMINED", note: `lỗi đọc: ${(e as Error).message}`.slice(0, 120) };
    }
  }

  async tick() {
    const ctx = this.ctx;
    expireDue(ctx);
    const now = ctx.clock.now();
    // 1. Đang phát hoặc đã ACK: đọc theo lịch của adapter, quá hạn thì UNKNOWN.
    for (const row of all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE state IN ('DISPATCHING','ACKED') ORDER BY dispatch_claimed_at")) {
      const adapter = this.adapters.get(row.kind as Kind);
      if (!adapter) continue;
      const deadline = Date.parse(row.unknown_after as string);
      const check = one<{ next_at: string | null; attempts: number }>(ctx.db, "SELECT next_at, attempts FROM checks WHERE plan_id = ?", row.id);
      if (row.state === "DISPATCHING" && row.dispatch_state === "CLAIMED" && now >= deadline && row.action_id && !this.barrierHas(row.action_id)) {
        // Đã claim nhưng không có barrier: theo bất biến "barrier trước mọi I/O", chắc chắn chưa phát (crash trước barrier).
        tx(ctx.db, () => {
          const ev: Evidence = { grade: "PROVIDER_READBACK", source: "barrier-journal", observed_at: iso(now), data: { barrier: "absent", io: false } };
          recordEvidence(ctx, row.id, ev, "NO_EFFECT", "reconciler");
          apply(ctx.db, { planId: row.id, event: "no_effect_failure", actorKind: "VERIFIER", actor: "reconciler", at: iso(now), set: { reason: "NO_BARRIER_NO_IO", outcome: "NO_EFFECT", dispatch_state: "NOT_SENT" } });
        });
        continue;
      }
      const first = row.first_io_at ? Date.parse(row.first_io_at) : Date.parse(row.dispatch_claimed_at as string);
      const due = check?.next_at ? Date.parse(check.next_at) : first + (adapter.readsAtMs[0] ?? 0);
      if (now >= due && (row.state === "ACKED" || this.barrierHas(row.action_id as string))) {
        const rb = await this.read(row, adapter);
        const done = resolveWithEvidence(ctx, row.id, rb, `reconciler:${row.kind}`);
        if (done) {
          this.stats.resolved++;
          continue;
        }
        const nextOffset = adapter.readsAtMs.find((ms) => first + ms > now);
        const retry = rb.result === "UNDETERMINED" && rb.retryAfterMs ? now + rb.retryAfterMs : null;
        const next = Math.max(nextOffset !== undefined ? first + nextOffset : deadline, retry ?? 0);
        setCheck(ctx, row.id, next, rb.result === "UNDETERMINED" ? rb.note : rb.result);
      }
      const cur = getRow(ctx.db, row.id) as ActionRow;
      if ((cur.state === "DISPATCHING" || cur.state === "ACKED") && now >= deadline) {
        tx(ctx.db, () => {
          apply(ctx.db, {
            planId: row.id, event: "timeout", actorKind: "RECONCILER", at: iso(now),
            set: { unknown_since: iso(now), reconciliation_status: "AUTO", first_io_at: cur.first_io_at ?? barrierTime(ctx, cur.action_id as string) },
          });
          scheduleOnly(ctx, row.id, now);
          run(ctx.db, "UPDATE checks SET attempts = 0 WHERE plan_id = ?", row.id);
        });
        this.stats.unknown++;
      }
    }
    // 2. UNKNOWN: đọc theo lịch SLA, không phát lại.
    for (const row of all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE state = 'UNKNOWN'")) {
      const adapter = this.adapters.get(row.kind as Kind);
      const check = one<{ next_at: string | null; attempts: number }>(ctx.db, "SELECT next_at, attempts FROM checks WHERE plan_id = ?", row.id);
      const due = check?.next_at ? Date.parse(check.next_at) : now;
      if (adapter && now >= due && !row.imported) {
        const rb = await this.read(row, adapter);
        const done = resolveWithEvidence(ctx, row.id, rb, `reconciler:${row.kind}`);
        if (done) {
          this.stats.resolved++;
          continue;
        }
        const attempts = (check?.attempts ?? 0) + 1;
        let next = nextUnknownRead(ctx, row, attempts, now);
        if (rb.result === "UNDETERMINED" && rb.retryAfterMs) next = Math.max(next, now + rb.retryAfterMs);
        setCheck(ctx, row.id, next, rb.result === "UNDETERMINED" ? rb.note : rb.result);
      } else if (adapter && now >= due && row.imported) {
        // Action nhập từ barrier sau khôi phục: đọc chứng cứ nhưng chưa có quyền I/O.
        const rb = await this.read(row, adapter);
        if (!resolveWithEvidence(ctx, row.id, rb, "recovery-verifier")) setCheck(ctx, row.id, nextUnknownRead(ctx, row, (check?.attempts ?? 0) + 1, now), rb.result === "UNDETERMINED" ? rb.note : rb.result);
      }
    }
    // 3. SLA của UNKNOWN.
    for (const row of all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE state = 'UNKNOWN'")) this.sla(row, now);
    return this.stats;
  }

  private sla(row: ActionRow, now: number) {
    const ctx = this.ctx;
    const u = ctx.config.unknown;
    const age = now - Date.parse(row.unknown_since as string);
    const status = row.reconciliation_status ?? "AUTO";
    let next: string | null = null;
    if (age >= u.manualAfterMs && status !== "MANUAL_REQUIRED") next = "MANUAL_REQUIRED";
    else if (age >= u.escalateAfterMs && age < u.manualAfterMs && (status === "AUTO" || status === "TICKET_OPEN")) next = "ESCALATED";
    else if (age >= u.ticketAfterMs && age < u.escalateAfterMs && status === "AUTO") next = "TICKET_OPEN";
    if (!next) return;
    tx(ctx.db, () => {
      const at = iso(now);
      const ticket = openTicket(ctx, row, "UNKNOWN_SLA");
      if (next === "TICKET_OPEN") this.stats.tickets++;
      if (next === "ESCALATED") {
        run(ctx.db, "UPDATE tickets SET status = 'ESCALATED', escalated_at = ? WHERE id = ?", at, ticket);
        // Thông báo người dùng bằng nội dung chung (không lộ chi tiết trên màn hình khóa).
        run(ctx.db, "INSERT INTO outbox (id, topic, plan_id, payload, created_at) VALUES (?, 'notify.user', ?, ?, ?)", uuid(), row.id,
          JSON.stringify({ to: row.actor, text: "Một thao tác của bạn chưa xác minh được kết quả. Mở LeNhip để xem." }), at);
        this.stats.escalated++;
      }
      if (next === "MANUAL_REQUIRED") {
        run(ctx.db, "UPDATE tickets SET status = 'MANUAL_REQUIRED', manual_required_at = ? WHERE id = ?", at, ticket);
        this.stats.manual++;
      }
      apply(ctx.db, { planId: row.id, event: "sla", actorKind: "RECONCILER", at, set: { reconciliation_status: next }, data: { age_seconds: Math.floor(age / 1000) } });
    });
  }
}

function barrierTime(ctx: Ctx, actionId: string): string | null {
  const e = ctx.barrier.readAll().entries.find((x) => x.type === "dispatch" && x.action_id === actionId);
  return e ? e.at : null;
}
