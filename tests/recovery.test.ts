// T08 (crash points) và T10 (DR01, RET01): crash sau claim trước barrier, sau barrier trước I/O, sau I/O trước receipt; restore
// DB về trước khi phát làm mất action đã barrier/đã phát, mất thu hồi, mất jti, mất tombstone xóa; quét barrier độc lập và giữ khóa
// phát tới khi đủ coverage, hai người ký.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { getByActionId } from "../src/server/machine.ts";
import { issuePermit } from "../src/server/worker.ts";
import { applyRevocations, backupLedger, beginRecovery, recoveryReport, releaseGate, restoreLedgerFile, scanBarrier } from "../src/server/recovery.ts";
import { PermitError } from "../src/server/permit.ts";
import { action, calendarPlan, harness, lampPlan, planAndApprove, vn } from "./helpers.ts";

test("crash sau claim, trước barrier: chắc chắn chưa I/O → FAILED (không tác động), không phát lại", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    h.app.receivers.get("device.set_power")!.crashAt = "after_claim";
    await assert.rejects(h.app.dispatcher.tick(), /after_claim/);
    await h.restart();
    h.clock.advance(11_000);
    await h.app.reconciler.tick();
    const act = await action(h, action_id);
    assert.equal(act.status, "FAILED");
    assert.equal(act.reason, "NO_BARRIER_NO_IO");
    assert.equal(h.app.hubs.get("site_lab01")!.commands.length, 0);
  } finally {
    await h.close();
  }
});

test("crash sau barrier, trước I/O: không chứng minh được chưa phát → UNKNOWN, đọc lại; sau I/O trước receipt → đọc lại thấy tác động → VERIFIED", async () => {
  const h = await harness();
  try {
    const a1 = await planAndApprove(h, lampPlan("SET_ON", "dev_lamp_02"));
    h.app.receivers.get("device.set_power")!.crashAt = "after_barrier";
    await assert.rejects(h.app.dispatcher.tick(), /after_barrier/);
    await h.restart();
    h.clock.advance(11_000);
    await h.app.reconciler.tick();
    let act = await action(h, a1.action_id);
    assert.equal(act.status, "UNKNOWN", "đèn vẫn tắt vì lệnh chưa đi, nhưng không có bằng chứng authoritative");
    assert.equal(h.app.hubs.get("site_lab01")!.commands.length, 0);

    const a2 = await planAndApprove(h, lampPlan("SET_OFF"));
    h.app.receivers.get("device.set_power")!.crashAt = "after_io";
    await assert.rejects(h.app.dispatcher.tick(), /after_io/);
    await h.restart();
    h.clock.advance(1_100);
    await h.app.reconciler.tick();
    act = await action(h, a2.action_id);
    assert.equal(act.status, "VERIFIED");
    assert.equal(h.app.hubs.get("site_lab01")!.commands.length, 1, "không phát lại");
  } finally {
    await h.close();
  }
});

test("T10: restore về trước khi phát → nhập action thiếu thành UNKNOWN, thu hồi được nạp lại, permit cũ bị chặn, mở phát cần coverage và hai người", async () => {
  const h = await harness();
  try {
    const backupPath = join(h.dir, "backup.db");
    const bk = backupLedger(h.app.ctx, backupPath);
    // Sau backup: một lệnh đèn đã phát, một lịch đã phát, một lệnh lịch đã duyệt có permit đang bay, và một lần rút đồng ý.
    const lamp = await planAndApprove(h, lampPlan("SET_OFF"));
    const cal = await planAndApprove(h, calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")));
    await h.app.dispatcher.tick();
    h.clock.advance(1_100);
    await h.app.reconciler.tick();
    assert.equal((await action(h, lamp.action_id)).status, "VERIFIED");
    assert.equal((await action(h, cal.action_id)).status, "VERIFIED");
    const flying = await planAndApprove(h, calendarPlan(vn(h.clock, "11:00"), vn(h.clock, "11:30")));
    const row = getByActionId(h.app.ctx.db, flying.action_id)!;
    const oldPermit = issuePermit(h.app.ctx, h.app.issuer, h.app.receivers.get("calendar.block")!, row, h.app.identity);
    await h.call("POST", "/v1/consents/home_control/withdraw", {});

    // Bước 1: Incident Lead khóa phát và tăng epoch ở control store riêng.
    const startedAt = new Date(h.clock.now()).toISOString();
    beginRecovery(h.app.ctx, "lead_1", "mất primary và standby, restore từ backup");
    // Bước 2: restore DB tách biệt (sổ cũ mất mọi thứ sau backup), nạp thu hồi từ kho độc lập.
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    assert.equal(getByActionId(h.app.ctx.db, lamp.action_id), undefined, "DB đã restore không còn action sau backup");
    const rev = applyRevocations(h.app.ctx);
    assert.ok(rev.applied >= 1, "rút đồng ý home_control được nạp lại");
    // Bước 3: quét barrier từ checkpoint, nhập action đã phát thành UNKNOWN chưa có quyền I/O.
    const scan = scanBarrier(h.app.ctx, bk.backup_id);
    assert.deepEqual(scan.imported.sort(), [lamp.action_id, cal.action_id].sort());
    assert.equal(scan.partial_tail, false);
    assert.equal((await action(h, lamp.action_id)).status, "UNKNOWN");
    // Permit cũ (epoch trước) bị chặn ở receiver kể cả khi đã mở lại.
    await assert.rejects(h.app.receivers.get("calendar.block")!.accept(oldPermit.token, h.app.identity.certDer), (e: PermitError) => e.code === "DISPATCH_CLOSED" || e.code === "PERMIT_EPOCH" || e.code === "PERMIT_TARGET");
    // Bước 4: verifier đọc chứng cứ cho phần đã nhập (đèn đã tắt, event đã có).
    await h.app.reconciler.tick();
    assert.equal((await action(h, lamp.action_id)).status, "VERIFIED");
    assert.equal((await action(h, cal.action_id)).status, "VERIFIED");
    // Bước 5: mở cổng: cần T10, coverage, qua cửa sổ permit cũ, và hai người khác nhau.
    const report = recoveryReport(h.app.ctx, scan);
    assert.equal(report.coverage_complete, true);
    assert.throws(() => releaseGate(h.app.ctx, { lead: "lead_1", ops: "ops_1", t10Passed: true, report, allowlist: ["lenhip:calendar-adapter"], recoveryStartedAt: startedAt }), /cửa sổ permit/);
    h.clock.advance(32_001);
    assert.throws(() => releaseGate(h.app.ctx, { lead: "lead_1", ops: "lead_1", t10Passed: true, report, allowlist: ["lenhip:calendar-adapter"], recoveryStartedAt: startedAt }), /hai người/);
    assert.throws(() => releaseGate(h.app.ctx, { lead: "lead_1", ops: "ops_1", t10Passed: false, report, allowlist: [], recoveryStartedAt: startedAt }), /T10/);
    releaseGate(h.app.ctx, { lead: "lead_1", ops: "ops_1", t10Passed: true, report, allowlist: ["lenhip:calendar-adapter"], recoveryStartedAt: startedAt });
    assert.equal(h.app.ctx.control.dispatchOpen(), true);
    assert.equal(h.app.ctx.control.receiverAllowed("lenhip:site:site_lab01"), false, "receiver ngoài allowlist vẫn khóa");
    // Đồng ý home_control đã rút trước sự cố vẫn có hiệu lực sau restore.
    const r = await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON") });
    assert.equal(r.body.code, "CONSENT_REQUIRED");
  } finally {
    await h.close();
  }
});

test("T10: dòng barrier ghi dở (crash giữa lúc ghi) làm coverage chưa đủ, giữ khóa phát", async () => {
  const h = await harness();
  try {
    const bk = backupLedger(h.app.ctx, join(h.dir, "b.db"));
    const { appendFileSync } = await import("node:fs");
    appendFileSync(h.app.ctx.barrier.path, '{"seq":99,"type":"dispatch","action_id":"');
    beginRecovery(h.app.ctx, "lead_1", "diễn tập");
    const scan = scanBarrier(h.app.ctx, bk.backup_id);
    const report = recoveryReport(h.app.ctx, scan);
    assert.equal(report.coverage_complete, false);
    h.clock.advance(40_000);
    assert.throws(() => releaseGate(h.app.ctx, { lead: "a", ops: "b", t10Passed: true, report, allowlist: [], recoveryStartedAt: new Date(0).toISOString() }), /coverage/);
    assert.equal(h.app.ctx.control.dispatchOpen(), false);
  } finally {
    await h.close();
  }
});
