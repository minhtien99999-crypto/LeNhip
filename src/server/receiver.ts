// Receiver tại điểm ra I/O (SRS mục 12: "Điểm kiểm quyền thật nằm trên tuyến ra I/O"; mục 17, 19, 21). Thứ tự: khóa đồng hồ →
// permit (cú pháp, trust, thời gian, danh tính) → digest/target → phiên bản hiện hành và epoch → CAS claim + tiêu thụ jti trong
// một giao dịch (điểm tuyến tính hóa) → đọc trước I/O → ghi barrier độc lập → I/O. Mọi timeout sau claim giữ khả năng tác động
// chưa rõ; không bao giờ tự phát lại.
import { ApiError } from "../core/errors.ts";
import { digestJcs, uuid } from "../core/crypto.ts";
import { type Ctx } from "./context.ts";
import { snapshotFor, type Kind } from "./authority.ts";
import { apply, getByActionId, getRow, type ActionRow } from "./machine.ts";
import { JournalUnavailable } from "./journal.ts";
import { PermitError, verifyPermit, type PermitClaims, type TrustStore } from "./permit.ts";
import { audit, one, run, tx } from "./store.ts";
import { lateResult, recordEvidence, type Evidence, type Readback } from "./evidence.ts";

export type { Evidence, Grade, Readback } from "./evidence.ts";

export type Precheck =
  | { result: "CLEAR" }
  | { result: "ALREADY_IN_STATE" | "BUSY"; evidence: Evidence }
  /** Không đọc được trước I/O: chưa phát gì, kết thúc FAILED (không tác động). */
  | { result: "UNAVAILABLE"; reason: string; evidence: Evidence };
export type ExecResult =
  | { result: "ACK"; provider_ref: string | null; evidence?: Evidence }
  | { result: "NO_EFFECT"; reason: string; evidence: Evidence };
/** Adapter của một loại đích. Credential của nhà cung cấp chỉ nằm trong adapter (SRS mục 12: worker giữ credential adapter). */
export interface DispatchAdapter {
  readonly kind: Kind;
  audience(row: ActionRow): string;
  /** Receiver chỉ nhận permit có audience thuộc họ của mình (lịch: một audience; đèn: lenhip:site:<site>). */
  servesAudience(aud: string): boolean;
  readonly ackTimeoutMs: number;
  readonly unknownAfterMs: number;
  /** Lịch đọc lại sau I/O, mili giây tính từ first_io. */
  readonly readsAtMs: number[];
  precheck(row: ActionRow): Promise<Precheck>;
  execute(row: ActionRow): Promise<ExecResult>;
  readback(row: ActionRow): Promise<Readback>;
}

export class Crash extends Error {
  override name = "Crash";
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ done: false }), ms);
    p.then((value) => (clearTimeout(t), resolve({ done: true, value })), (e) => (clearTimeout(t), reject(e)));
  });

export class Receiver {
  private readonly ctx: Ctx;
  readonly adapter: DispatchAdapter;
  private readonly trust: TrustStore;
  private readonly issuer: string;
  /** Độ lệch đồng hồ đo được so với nguồn thời gian của Authority; > 2 giây thì khóa phát. */
  clockOffsetMs = 0;
  /** Kiểm thử T08/T10: dừng giữa chừng như tiến trình chết. */
  crashAt: null | "after_claim" | "after_barrier" | "after_io" = null;
  /** Kiểm thử: đồng hồ thật cho chờ ACK; mặc định theo cấu hình adapter. */
  realAckWaitMs: number | null = null;

  constructor(ctx: Ctx, adapter: DispatchAdapter, trust: TrustStore, issuer: string) {
    this.ctx = ctx;
    this.adapter = adapter;
    this.trust = trust;
    this.issuer = issuer;
  }

  private at() {
    return new Date(this.ctx.clock.now()).toISOString();
  }

  /** Trình permit qua mTLS (peerCertDer là chứng chỉ client đã bắt tay). Trả hàng action sau bước cuối đã làm được. */
  async accept(token: string, peerCertDer: Uint8Array): Promise<ActionRow> {
    const ctx = this.ctx;
    const now = ctx.clock.now();
    const at = this.at();
    if (Math.abs(this.clockOffsetMs) > ctx.config.skewMs) {
      ctx.control.lockDispatch(at, "receiver", "CLOCK_SKEW");
      throw new PermitError("CLOCK_SKEW");
    }
    if (!ctx.control.dispatchOpen()) throw new PermitError("DISPATCH_CLOSED");
    const c = verifyPermit(token, {
      trust: this.trust, issuer: this.issuer, audience: (aud) => this.adapter.servesAudience(aud), nowMs: now, skewMs: ctx.config.skewMs,
      maxLifetimeS: ctx.config.permitLifetimeS, peerCertDer,
    });
    if (!ctx.control.receiverAllowed(c.aud)) throw new PermitError("DISPATCH_CLOSED", "receiver chưa được mở lại");
    const row = getByActionId(ctx.db, c.action_id);
    if (!row || row.kind !== this.adapter.kind) throw new PermitError("PERMIT_TARGET");
    if (c.aud !== this.adapter.audience(row)) throw new PermitError("PERMIT_AUDIENCE");
    // Digest khớp đúng byte mà adapter sẽ diễn giải; workspace/site/target khớp tài nguyên đăng ký.
    const digest = digestJcs(JSON.parse(row.payload));
    if (digest !== row.payload_digest || c.payload_digest !== digest) throw new PermitError("PERMIT_DIGEST");
    if (c.workspace_id !== row.workspace_id || c.target !== row.target_ref || c.site !== row.site_id) throw new PermitError("PERMIT_TARGET");
    if (c.target_binding_version !== row.target_binding_version) throw new PermitError("PERMIT_STALE", "binding");
    // Phiên bản hiện hành lấy qua kênh Authority; bất khả dụng hoặc khác thì từ chối phát.
    const snap = snapshotFor(ctx, row);
    if (snap.stale || c.authz_version !== snap.authz_version || c.export_policy_digest !== snap.export_policy_digest || c.target_binding_version !== snap.target_binding_version) {
      if (row.state === "AUTHORIZED") {
        apply(ctx.db, { planId: row.id, event: "invalidate", actorKind: "AUTHORITY", at, set: { reason: snap.stale ?? "AUTHZ_CHANGED" }, data: { at_receiver: true } });
      }
      throw new PermitError("PERMIT_STALE", snap.stale ?? "version");
    }
    if (c.recovery_epoch !== ctx.control.get().recovery_epoch) throw new PermitError("PERMIT_EPOCH");
    const claimed = this.claim(row, c);
    if (this.crashAt === "after_claim") throw new Crash("after_claim");
    return this.dispatch(claimed);
  }

  /** CAS claim AUTHORIZED → DISPATCHING và tiêu thụ jti bền trong cùng giao dịch. */
  private claim(row: ActionRow, c: PermitClaims): ActionRow {
    const ctx = this.ctx;
    return tx(ctx.db, () => {
      if (one(ctx.db, "SELECT 1 FROM permit_jti WHERE jti = ?", c.jti)) throw new PermitError("PERMIT_REPLAY");
      const at = this.at();
      let applied;
      try {
        applied = apply(ctx.db, {
          planId: row.id, event: "claim", actorKind: "RECEIVER", actor: c.aud, at, expectRevision: c.action_revision,
          set: { dispatch_claimed_at: at, claimed_revision: c.action_revision, dispatch_state: "CLAIMED", unknown_after: new Date(ctx.clock.now() + this.adapter.unknownAfterMs).toISOString() },
        });
      } catch (e) {
        if (e instanceof ApiError) throw new PermitError("PERMIT_REVISION", (e.extra.state as string) ?? "");
        throw e;
      }
      run(ctx.db, "INSERT INTO permit_jti (jti, receiver, action_id, payload_digest, identity, action_revision, exp, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        c.jti, c.aud, c.action_id, c.payload_digest, c.cnf["x5t#S256"], c.action_revision, c.exp, at);
      return applied.row;
    });
  }

  private async dispatch(row: ActionRow): Promise<ActionRow> {
    const ctx = this.ctx;
    let pre: Precheck;
    try {
      pre = await this.adapter.precheck(row);
    } catch (e) {
      pre = { result: "UNAVAILABLE", reason: "PRECHECK_ERROR", evidence: { grade: "PROVIDER_READBACK", source: `adapter:${this.adapter.kind}`, observed_at: this.at(), data: { error: String((e as Error).message).slice(0, 120) } } };
    }
    if (pre.result !== "CLEAR") {
      const p = pre;
      return tx(ctx.db, () => {
        const at = this.at();
        if (p.result === "UNAVAILABLE") {
          recordEvidence(ctx, row.id, p.evidence, "NO_EFFECT", `adapter:${this.adapter.kind}`);
          return apply(ctx.db, { planId: row.id, event: "no_effect_failure", actorKind: "VERIFIER", at, expectRevision: row.revision, set: { reason: p.reason, outcome: "NO_EFFECT", dispatch_state: "NOT_SENT" } }).row;
        }
        recordEvidence(ctx, row.id, p.evidence, p.result === "BUSY" ? "CONFLICT" : "MATCH", `adapter:${this.adapter.kind}`);
        const ev: { event: string; set: Record<string, string | number | null> } = p.result === "BUSY"
          ? { event: "precheck_conflict", set: { outcome: "BUSY_BEFORE_CREATE", event_created: 0 } }
          : { event: "already_in_state", set: { outcome: "ALREADY_IN_STATE" } };
        return apply(ctx.db, {
          planId: row.id, event: ev.event, actorKind: "VERIFIER", at, expectRevision: row.revision,
          set: { ...ev.set, evidence_grade: p.evidence.grade, dispatch_state: "NOT_SENT", last_observed_at: p.evidence.observed_at },
        }).row;
      });
    }
    // Barrier bền ở kho độc lập trước I/O. Ghi không được thì chưa có I/O: kết thúc FAILED và đóng phát (SRS mục 21, 24).
    let barrierAt: string;
    try {
      const entry = ctx.barrier.append("dispatch", this.at(), {
        plan_id: row.id, action_id: row.action_id, kind: row.kind, workspace_id: row.workspace_id, actor: row.actor, target: row.target_ref, site: row.site_id,
        resource_key: row.resource_key, window_start: row.window_start, window_end: row.window_end, payload: JSON.parse(row.payload), payload_digest: row.payload_digest,
        authz_version: row.authz_version, export_policy_digest: row.export_policy_digest, target_binding_version: row.target_binding_version,
        recovery_epoch: ctx.control.get().recovery_epoch, claimed_revision: row.claimed_revision, transaction_id: row.transaction_id, support_code: row.support_code,
      });
      barrierAt = entry.at;
    } catch (e) {
      if (!(e instanceof JournalUnavailable)) throw e;
      const at = this.at();
      ctx.control.lockDispatch(at, "receiver", "BARRIER_UNAVAILABLE");
      return tx(ctx.db, () => {
        recordEvidence(ctx, row.id, { grade: "PROVIDER_READBACK", source: "receiver:barrier", observed_at: at, data: { io: false } }, "NO_EFFECT", "receiver");
        audit(ctx.db, at, { workspace_id: row.workspace_id, actor: "receiver", action: "dispatch.barrier_unavailable", target: row.action_id });
        return apply(ctx.db, { planId: row.id, event: "no_effect_failure", actorKind: "VERIFIER", at, expectRevision: row.revision, set: { reason: "BARRIER_UNAVAILABLE", outcome: "NO_EFFECT", dispatch_state: "NOT_SENT" } }).row;
      });
    }
    if (this.crashAt === "after_barrier") throw new Crash("after_barrier");
    const io = this.adapter.execute(row);
    let waited: { done: true; value: ExecResult } | { done: false };
    try {
      waited = await withTimeout(io, this.realAckWaitMs ?? this.adapter.ackTimeoutMs);
    } catch {
      // Lỗi mạng sau khi đã gửi: không biết nhà cung cấp đã nhận hay chưa. Giữ DISPATCHING để reconciler đọc lại.
      waited = { done: false };
    }
    if (this.crashAt === "after_io") throw new Crash("after_io");
    if (!waited.done) {
      // ACK trễ vẫn được ghi làm receipt; kết quả do reconciler đọc lại, không phát lại.
      io.then((late) => this.onResult(row.id, late, barrierAt)).catch(() => undefined);
      return getRow(ctx.db, row.id) as ActionRow;
    }
    return this.onResult(row.id, waited.value, barrierAt);
  }

  private onResult(planId: string, r: ExecResult, barrierAt: string): ActionRow {
    const ctx = this.ctx;
    const row = getRow(ctx.db, planId) as ActionRow;
    if (row.state !== "DISPATCHING") {
      lateResult(ctx, planId, r, `adapter:${this.adapter.kind}`);
      return getRow(ctx.db, planId) as ActionRow;
    }
    const at = this.at();
    return tx(ctx.db, () => {
      if (r.result === "NO_EFFECT") {
        recordEvidence(ctx, planId, r.evidence, "NO_EFFECT", `adapter:${this.adapter.kind}`);
        return apply(ctx.db, { planId, event: "no_effect_failure", actorKind: "VERIFIER", at, set: { reason: r.reason, outcome: "NO_EFFECT", dispatch_state: "SENT", first_io_at: barrierAt } }).row;
      }
      run(ctx.db, "INSERT INTO receipts (id, plan_id, receiver, provider_ref, digest, at) VALUES (?, ?, ?, ?, ?, ?)", `rc_${uuid()}`, planId, this.adapter.kind, r.provider_ref, row.payload_digest, at);
      return apply(ctx.db, {
        planId, event: "ack", actorKind: "ADAPTER", actor: this.adapter.kind, at, eventId: `ack:${planId}`,
        set: { acked_at: at, provider_ref: r.provider_ref, dispatch_state: "SENT", first_io_at: barrierAt },
      }).row;
    });
  }
}
