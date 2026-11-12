// Phục hồi từ bản cũ (SRS mục 21, DR01, T10). Năm bước: (1) Incident Lead khóa phát toàn hệ và tăng recovery_epoch ở control
// store riêng; (2) Ops restore DB tách biệt rồi nạp tombstone/thu hồi từ kho độc lập trước dữ liệu phục vụ; (3) reconciler quét
// barrier từ checkpoint đáng tin cậy tới hiện tại, nhập action thiếu thành UNKNOWN chưa có quyền I/O; (4) verifier đọc chứng cứ;
// (5) Lead và Ops ký báo cáo coverage, chạy T10, mở receiver theo allowlist. "Không có bản ghi" không bao giờ là "chưa thực hiện".
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { uuid } from "../core/crypto.ts";
import { type Ctx, nowIso } from "./context.ts";
import { apply, getByActionId, type ActionRow } from "./machine.ts";
import { openTicket } from "./evidence.ts";
import { all, audit, backupTo, one, run, tx } from "./store.ts";

/** Sao lưu sổ và ghi checkpoint vào barrier: mọi bản ghi barrier sau checkpoint mới hơn bản sao lưu. */
export function backupLedger(ctx: Ctx, path: string) {
  const at = nowIso(ctx);
  const backupId = `bk_${uuid()}`;
  if (existsSync(path)) rmSync(path);
  backupTo(ctx.db, path);
  const cp = ctx.barrier.append("checkpoint", at, { backup_id: backupId });
  return { backup_id: backupId, at, checkpoint_seq: cp.seq };
}

/** Bước 1. */
export function beginRecovery(ctx: Ctx, lead: string, reason: string) {
  const at = nowIso(ctx);
  const epoch = ctx.control.beginRecovery(at, lead, reason);
  return { recovery_epoch: epoch, at };
}

/** Bước 2a: thay tệp sổ bằng bản sao lưu (tiến trình phục vụ đã dừng; DB cũ được giữ lại để điều tra). */
export function restoreLedgerFile(backupPath: string, ledgerPath: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(ledgerPath + suffix)) copyFileSync(ledgerPath + suffix, `${ledgerPath}${suffix}.before-restore`);
    if (suffix && existsSync(ledgerPath + suffix)) rmSync(ledgerPath + suffix);
  }
  copyFileSync(backupPath, ledgerPath);
}

/** Loại dòng của sổ thu hồi mà lõi tự nạp lại. Loại khác phải có mô-đun khai trong ServerModule.revocations. */
export const CORE_REVOCATIONS: readonly string[] = ["grant_revoked", "consent_withdrawn", "binding_changed", "member_deleted"];

/**
 * Mô-đun ghi một dòng vào sổ thu hồi (mất một quyền, gỡ một thiết bị, chặn…) để restore không làm sống lại thứ đã thu hồi.
 * Chỉ nhận loại dòng đã có bên nạp lại: một dòng không ai nạp lại được là một thu hồi sẽ mất sau restore.
 */
export function journalRevocation(ctx: Ctx, type: string, at: string, data: Record<string, unknown>) {
  if (!CORE_REVOCATIONS.includes(type) && !ctx.modules.some((m) => m.revocations && Object.hasOwn(m.revocations, type))) {
    throw new Error(`sổ thu hồi: loại ${type} chưa có bên nạp lại (ServerModule.revocations)`);
  }
  return ctx.revocations.append(type, at, data);
}

/** Bước 2b: nạp lại thu hồi và tombstone từ kho độc lập. Không ghi thêm vào kho đó (lặp lại an toàn). */
export function applyRevocations(ctx: Ctx) {
  const { entries } = ctx.revocations.readAll();
  let applied = 0;
  tx(ctx.db, () => {
    for (const e of entries) {
      // Phần của mô-đun chạy sau phần của lõi cho cùng dòng (cuối vòng lặp), theo đúng thứ tự của sổ.
      if (e.type === "grant_revoked") {
        const r = run(ctx.db, "UPDATE grants SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, 'recovery') WHERE id = ? AND status = 'ACTIVE'", e.at, e.grant as string);
        if (Number(r.changes)) {
          run(ctx.db, "UPDATE members SET authz_version = authz_version + 1 WHERE workspace_id = ? AND user_id = ?", e.workspace_id as string, e.user_id as string);
          applied++;
        }
      } else if (e.type === "consent_withdrawn") {
        const c = one<{ id: string; choice: string; withdrawn_at: string | null; at: string }>(ctx.db,
          "SELECT id, choice, withdrawn_at, at FROM consents WHERE workspace_id = ? AND user_id = ? AND purpose_id = ? ORDER BY at DESC, rowid DESC LIMIT 1",
          e.workspace_id as string, e.user_id as string, e.purpose_id as string);
        if (c && c.choice === "GRANTED" && !c.withdrawn_at && c.at <= e.at) {
          run(ctx.db, "UPDATE consents SET withdrawn_at = ? WHERE id = ?", e.at, c.id);
          run(ctx.db, "UPDATE members SET authz_version = authz_version + 1 WHERE workspace_id = ? AND user_id = ?", e.workspace_id as string, e.user_id as string);
          applied++;
        }
      } else if (e.type === "binding_changed") {
        const r = run(ctx.db, "UPDATE devices SET binding_version = ?, status = ? WHERE device_ref = ? AND binding_version < ?",
          e.binding_version as number, e.status as string, e.device_ref as string, e.binding_version as number);
        if (Number(r.changes)) applied++;
      } else if (e.type === "member_deleted") {
        const r = run(ctx.db, "UPDATE members SET status = 'LEFT', display_name = '(đã xóa)', authz_version = authz_version + 1 WHERE workspace_id = ? AND user_id = ? AND status <> 'LEFT'",
          e.workspace_id as string, e.user_id as string);
        run(ctx.db, "UPDATE grants SET status = 'REVOKED', revoked_at = COALESCE(revoked_at, ?) WHERE workspace_id = ? AND user_id = ?", e.at, e.workspace_id as string, e.user_id as string);
        run(ctx.db, "UPDATE calendar_links SET status = 'UNLINKED', tenant_id = '-', object_id = '-' WHERE workspace_id = ? AND user_id = ?", e.workspace_id as string, e.user_id as string);
        if (Number(r.changes)) applied++;
      }
      for (const m of ctx.modules) {
        const replay = m.revocations && Object.hasOwn(m.revocations, e.type) ? m.revocations[e.type] : undefined;
        if (replay?.(ctx, e)) applied++;
      }
    }
    // Plan/action chưa claim của chủ thể bị thu hồi trở thành stale ở lần duyệt hoặc cấp permit kế tiếp (snapshot).
    if (ctx.revocations.readAll().entries.length !== entries.length) throw new Error("nạp lại sổ thu hồi không được ghi thêm vào sổ đó");
  });
  return { entries: entries.length, applied };
}

export interface ScanReport {
  checkpoint: string;
  from_seq: number;
  to_seq: number;
  scanned: number;
  imported: string[];
  reopened: string[];
  partial_tail: boolean;
  chain_broken: boolean;
}

/** Bước 3: quét barrier sau checkpoint của bản restore, kể cả action không còn trong DB. */
export function scanBarrier(ctx: Ctx, backupId: string): ScanReport {
  const { entries, broken, partial } = ctx.barrier.readAll();
  const cp = entries.find((e) => e.type === "checkpoint" && e.backup_id === backupId);
  if (!cp) throw new Error(`không có checkpoint ${backupId} trong barrier`);
  const at = nowIso(ctx);
  const report: ScanReport = { checkpoint: backupId, from_seq: cp.seq + 1, to_seq: entries.length ? entries[entries.length - 1].seq : cp.seq, scanned: 0, imported: [], reopened: [], partial_tail: !!partial, chain_broken: broken !== null };
  tx(ctx.db, () => {
    for (const e of entries.filter((x) => x.seq > cp.seq && x.type === "dispatch")) {
      report.scanned++;
      const actionId = e.action_id as string;
      const row = getByActionId(ctx.db, actionId);
      if (!row) {
        const id = (e.plan_id as string) ?? `pl_${uuid()}`;
        run(ctx.db, `INSERT INTO actions (id, action_id, workspace_id, actor, kind, schema_version, input, payload, payload_digest, resource_key, window_start, window_end, site_id, target_ref,
          authz_version, export_policy_digest, target_binding_version, state, revision, plan_version, dispatch_state, reconciliation_status, reason, imported, support_code, transaction_id,
          created_at, dispatch_claimed_at, unknown_after, unknown_since, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNKNOWN', 1, 0, 'CLAIMED', 'AUTO', 'RECOVERY_IMPORT', 1, ?, ?, ?, ?, ?, ?, ?)`,
          id, actionId, e.workspace_id as string, e.actor as string, e.kind as string, JSON.stringify(e.payload), e.payload_digest as string, e.resource_key as string,
          (e.window_start as string) ?? null, (e.window_end as string) ?? null, (e.site as string) ?? null, e.target as string, e.authz_version as number,
          e.export_policy_digest as string, e.target_binding_version as number, (e.support_code as string) ?? null, (e.transaction_id as string) ?? actionId,
          e.at, e.at, e.at, at, at);
        run(ctx.db, "INSERT INTO action_events (event_id, plan_id, seq, from_state, event, actor_kind, actor, to_state, data, at) VALUES (?, ?, 1, NULL, 'recovery_import', 'RECONCILER', 'recovery', 'UNKNOWN', ?, ?)",
          uuid(), id, JSON.stringify({ barrier_seq: e.seq }), at);
        run(ctx.db, "INSERT INTO checks (plan_id, next_at, attempts) VALUES (?, ?, 0) ON CONFLICT(plan_id) DO UPDATE SET next_at = excluded.next_at", id, at);
        openTicket(ctx, getByActionId(ctx.db, actionId) as ActionRow, "RECOVERY");
        report.imported.push(actionId);
      } else if (row.state === "PENDING_APPROVAL" || row.state === "AUTHORIZED") {
        apply(ctx.db, { planId: row.id, event: "recovery_import", actorKind: "RECONCILER", actor: "recovery", at, set: { reason: "RECOVERY_IMPORT", unknown_since: at, reconciliation_status: "AUTO", dispatch_state: "CLAIMED" }, data: { barrier_seq: e.seq } });
        run(ctx.db, "UPDATE actions SET imported = 1 WHERE id = ?", row.id);
        run(ctx.db, "INSERT INTO checks (plan_id, next_at, attempts) VALUES (?, ?, 0) ON CONFLICT(plan_id) DO UPDATE SET next_at = excluded.next_at", row.id, at);
        openTicket(ctx, getByActionId(ctx.db, actionId) as ActionRow, "RECOVERY");
        report.reopened.push(actionId);
      }
    }
    audit(ctx.db, at, { actor: "recovery", action: "recovery.scan", data: { ...report } });
  });
  return report;
}

/** Bước 5: báo cáo coverage. Phần chưa chứng minh coverage tiếp tục khóa. */
export function recoveryReport(ctx: Ctx, scan: ScanReport) {
  const unresolved = all<ActionRow>(ctx.db, "SELECT * FROM actions WHERE imported = 1 AND state = 'UNKNOWN'").map((r) => r.action_id);
  return {
    recovery_epoch: ctx.control.get().recovery_epoch,
    scan,
    unresolved,
    coverage_complete: !scan.partial_tail && !scan.chain_broken,
  };
}

/** Mở cổng phát sau khôi phục: hai người khác nhau, T10 đã chạy, coverage đầy đủ, đã qua cửa sổ permit 30 giây + skew. */
export function releaseGate(ctx: Ctx, o: { lead: string; ops: string; t10Passed: boolean; report: ReturnType<typeof recoveryReport>; allowlist: string[]; recoveryStartedAt: string }) {
  if (!o.t10Passed) throw new Error("chưa chạy T10");
  if (!o.report.coverage_complete) throw new Error("coverage chưa đầy đủ: giữ khóa và điều tra theo site");
  const waitMs = ctx.config.permitLifetimeS * 1000 + ctx.config.skewMs;
  if (ctx.clock.now() < Date.parse(o.recoveryStartedAt) + waitMs) throw new Error("chưa qua hết cửa sổ permit cũ");
  ctx.control.unlockDispatch(nowIso(ctx), [o.lead, o.ops], o.allowlist);
  audit(ctx.db, nowIso(ctx), { actor: `${o.lead}+${o.ops}`, action: "recovery.release", data: { allowlist: o.allowlist, unresolved: o.report.unresolved.length } });
}
