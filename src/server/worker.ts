// Worker phát lệnh (SRS mục 14 bước 5): đọc outbox action.authorized, xin dispatch lease (permit) từ Authority gắn mọi phiên bản,
// trình permit cho receiver qua mTLS. Outbox có thể giao lại; receiver chỉ tiêu thụ một lần (CAS claim + jti).
import { certThumbprint } from "../core/crypto.ts";
import { type Ctx, nowIso } from "./context.ts";
import { kindRule, snapshotFor } from "./authority.ts";
import { apply, getRow, type ActionRow } from "./machine.ts";
import { PermitError, type PermitIssuer } from "./permit.ts";
import type { Receiver } from "./receiver.ts";
import { all, run } from "./store.ts";

export interface WorkerIdentity {
  /** Chứng chỉ DER của mTLS client của worker; thumbprint của nó nằm trong cnf của permit. */
  certDer: Uint8Array;
}

/** Authority cấp permit cho một action AUTHORIZED: kiểm lại snapshot, cửa sổ phát và trạng thái phát toàn hệ. */
export function issuePermit(ctx: Ctx, issuer: PermitIssuer, receiver: Receiver, row: ActionRow, identity: WorkerIdentity) {
  const now = ctx.clock.now();
  if (row.state !== "AUTHORIZED") throw new PermitError("PERMIT_REVISION", row.state);
  if (now > Date.parse(row.dispatch_deadline as string)) throw new PermitError("PERMIT_EXPIRED", "dispatch window");
  const rule = kindRule(ctx, row.kind);
  if (!ctx.control.dispatchOpen() || !rule || !ctx.control.moduleOn(rule.module)) throw new PermitError("DISPATCH_CLOSED");
  if (row.site_id && !ctx.control.siteOn(row.site_id)) throw new PermitError("DISPATCH_CLOSED", "site");
  const snap = snapshotFor(ctx, row);
  if (snap.stale) throw new PermitError("PERMIT_STALE", snap.stale);
  return issuer.issue({
    aud: receiver.adapter.audience(row),
    action_id: row.action_id as string,
    action_revision: row.revision,
    workspace_id: row.workspace_id,
    site: row.site_id,
    target: row.target_ref,
    target_binding_version: row.target_binding_version,
    payload_digest: row.payload_digest,
    authz_version: snap.authz_version,
    export_policy_digest: snap.export_policy_digest,
    recovery_epoch: ctx.control.get().recovery_epoch,
    cnf: { "x5t#S256": certThumbprint(identity.certDer) },
  }, now, ctx.config.permitLifetimeS);
}

export class Dispatcher {
  private readonly ctx: Ctx;
  private readonly issuers: Map<string, PermitIssuer>;
  private readonly receivers: Map<string, Receiver>;
  private readonly identity: WorkerIdentity;
  lastErrors: { plan_id: string; code: string }[] = [];
  dispatched = 0;

  constructor(ctx: Ctx, issuers: Map<string, PermitIssuer>, receivers: Map<string, Receiver>, identity: WorkerIdentity) {
    this.ctx = ctx;
    this.issuers = issuers;
    this.receivers = receivers;
    this.identity = identity;
  }

  async tick(): Promise<number> {
    const ctx = this.ctx;
    if (!ctx.control.dispatchOpen()) return 0;
    const items = all<{ seq: number; plan_id: string }>(ctx.db, "SELECT seq, plan_id FROM outbox WHERE topic = 'action.authorized' AND delivered_at IS NULL ORDER BY seq LIMIT 20");
    let n = 0;
    for (const it of items) {
      const row = getRow(ctx.db, it.plan_id);
      const done = () => run(ctx.db, "UPDATE outbox SET delivered_at = ?, attempts = attempts + 1 WHERE seq = ?", nowIso(ctx), it.seq);
      if (!row || row.state !== "AUTHORIZED") {
        done();
        continue;
      }
      const receiver = this.receivers.get(row.kind);
      const issuer = this.issuers.get(row.kind);
      if (!receiver || !issuer) continue;
      try {
        const { token } = issuePermit(ctx, issuer, receiver, row, this.identity);
        await receiver.accept(token, this.identity.certDer);
        this.dispatched++;
        n++;
        done();
      } catch (e) {
        const code = e instanceof PermitError ? e.code : (e as Error).name === "Crash" ? "CRASH" : "ERROR";
        this.lastErrors.push({ plan_id: it.plan_id, code });
        if (this.lastErrors.length > 50) this.lastErrors.shift();
        if (code === "CRASH") throw e;
        if (code === "PERMIT_STALE") {
          const cur = getRow(ctx.db, it.plan_id);
          if (cur?.state === "AUTHORIZED") {
            const snap = snapshotFor(ctx, cur);
            apply(ctx.db, { planId: cur.id, event: "invalidate", actorKind: "AUTHORITY", at: nowIso(ctx), set: { reason: snap.stale ?? "AUTHZ_CHANGED" } });
          }
          done();
        } else if (code !== "DISPATCH_CLOSED") done();
      }
    }
    return n;
  }
}

