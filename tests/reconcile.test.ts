// T11 (CAL01), T12 (EDGE01, ST01), T17 (EDGE01, SEC01) phần chạy được với adapter giả lập, và SLA của UNKNOWN (REC01).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../src/server/app.ts";
import { all } from "../src/server/store.ts";
import { GATEWAY_CLIENT, ONOFF_CLUSTER } from "../src/adapters/matter-mock.ts";
import { action, calendarPlan, harness, lampPlan, planAndApprove, tick, vn } from "./helpers.ts";

test("T11: client thứ hai chèn cuộc hẹn giữa kiểm và tạo → CONFLICT với event_created=true", async () => {
  const h = await harness();
  try {
    const start = vn(h.clock, "15:00");
    const end = vn(h.clock, "15:30");
    h.app.graph.faults.beforeCreate = (acct) => {
      h.app.graph.addMeeting(acct, start, end, "Họp chen ngang");
      h.app.graph.faults.beforeCreate = null;
    };
    const { action_id } = await planAndApprove(h, calendarPlan(start, end));
    await tick(h);
    const act = await action(h, action_id);
    assert.equal(act.status, "CONFLICT");
    assert.equal(act.outcome, "OVERLAP_AFTER_CREATE");
    assert.equal(act.event_created, true);
    assert.equal(act.evidence_grade, "PROVIDER_READBACK");
  } finally {
    await h.close();
  }
});

test("T11: mất phản hồi sau khi Graph đã tạo event → UNKNOWN sau 30 giây, đọc lại theo transactionId → VERIFIED, không POST lại", async () => {
  const h = await harness();
  try {
    h.app.graph.faults.post = "lose_response";
    h.app.receivers.get("calendar.block")!.realAckWaitMs = 10;
    const { action_id } = await planAndApprove(h, calendarPlan(vn(h.clock, "16:00"), vn(h.clock, "16:30")));
    await h.app.dispatcher.tick();
    // Sau khi POST đã đi: Graph không đọc được (429) nên chưa xác định được kết quả.
    h.app.graph.faults.throttleReads = 100;
    await h.app.reconciler.tick();
    let act = await action(h, action_id);
    assert.equal(act.status, "DISPATCHING");
    h.clock.advance(30_000);
    await h.app.reconciler.tick();
    act = await action(h, action_id);
    assert.equal(act.status, "UNKNOWN");
    assert.ok(act.support_code?.startsWith("LNH-"));
    assert.equal(act.locked_resource, true, "khóa tác vụ tương đương từ lúc UNKNOWN (LNH-T02)");
    // Tác vụ tương đương trên cùng khung giờ bị khóa; khung giờ khác vẫn tạo được.
    const same = await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "16:10"), vn(h.clock, "16:20")) });
    assert.equal(same.status, 409);
    assert.equal(same.body.code, "RESOURCE_LOCKED");
    assert.equal((await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "17:00"), vn(h.clock, "17:10")) })).status, 201);
    h.app.graph.faults.throttleReads = 0;
    h.clock.advance(5_000);
    await h.app.reconciler.tick();
    act = await action(h, action_id);
    assert.equal(act.status, "VERIFIED");
    assert.equal(act.outcome, "EVENT_CREATED");
    assert.equal(h.app.graph.calls.createEvent, 1, "không tự POST lại sau kết quả mơ hồ");
    h.app.graph.release();
  } finally {
    await h.close();
  }
});

test("T11: event bị người dùng sửa giờ trước khi đọc lại → CONFLICT EVENT_CHANGED", async () => {
  const h = await harness();
  try {
    h.app.graph.faults.post = "hang";
    h.app.receivers.get("calendar.block")!.realAckWaitMs = 10;
    const { action_id } = await planAndApprove(h, calendarPlan(vn(h.clock, "16:00"), vn(h.clock, "16:30")));
    await h.app.dispatcher.tick();
    const ev = h.app.graph.events("cal_dev_a").find((e) => e.createdBy === "lenhip")!;
    ev.end = vn(h.clock, "17:00");
    h.app.graph.release();
    await new Promise((r) => setTimeout(r, 20));
    await h.app.reconciler.tick();
    const act = await action(h, action_id);
    assert.equal(act.status, "CONFLICT");
    assert.equal(act.outcome, "EVENT_CHANGED");
  } finally {
    await h.close();
  }
});

test("Graph từ chối (400) là bằng chứng chưa tác động: FAILED, không phải UNKNOWN", async () => {
  const h = await harness();
  try {
    h.app.graph.faults.post = "reject_400";
    const { action_id } = await planAndApprove(h, calendarPlan(vn(h.clock, "16:00"), vn(h.clock, "16:30")));
    await tick(h);
    const act = await action(h, action_id);
    assert.equal(act.status, "FAILED");
    assert.equal(act.outcome, "NO_EFFECT");
  } finally {
    await h.close();
  }
});

test("SLA UNKNOWN: đọc lại theo lịch, ticket sau 5 phút, escalate và thông báo chung sau 1 giờ, MANUAL_REQUIRED sau 24 giờ, không tự FAILED", async () => {
  const h = await harness();
  try {
    const hub = h.app.hubs.get("site_lab01")!;
    hub.faults.dropAck = true;
    hub.faults.applyCommands = false;
    h.app.receivers.get("device.set_power")!.realAckWaitMs = 10;
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    await tick(h);
    h.clock.advance(10_000);
    await h.app.reconciler.tick();
    let act = await action(h, action_id);
    assert.equal(act.status, "UNKNOWN");
    assert.equal(act.reconciliation_status, "AUTO");
    const readsBefore = h.app.reconciler.stats.reads;
    for (const step of [5_000, 10_000, 15_000, 30_000]) {
      h.clock.advance(step);
      await h.app.reconciler.tick();
    }
    assert.ok(h.app.reconciler.stats.reads - readsBefore >= 4, "đọc tại 0/5/15/30/60 giây");
    h.clock.advance(5 * 60_000);
    await h.app.reconciler.tick();
    act = await action(h, action_id);
    assert.equal(act.reconciliation_status, "TICKET_OPEN");
    const ops = await h.call("GET", "/v1/ops/unknown", { sub: "dev_ops" });
    assert.equal(ops.status, 200);
    assert.deepEqual(SCHEMAS.validate("UnknownList", ops.body), []);
    assert.equal(ops.body.items[0].ticket.status, "OPEN");
    assert.equal((await h.call("GET", "/v1/ops/unknown", { sub: "dev_a" })).status, 403, "chỉ vai vận hành");
    h.clock.advance(60 * 60_000);
    await h.app.reconciler.tick();
    act = await action(h, action_id);
    assert.equal(act.reconciliation_status, "ESCALATED");
    const notes = all<{ payload: string }>(h.app.ctx.db, "SELECT payload FROM outbox WHERE topic = 'notify.user'");
    assert.equal(notes.length, 1);
    assert.ok(!notes[0].payload.includes("dev_lamp") && !notes[0].payload.includes("Đèn"), "nội dung chung, không lộ thiết bị");
    h.clock.advance(24 * 3600_000);
    await h.app.reconciler.tick();
    act = await action(h, action_id);
    assert.equal(act.status, "UNKNOWN", "thời gian trôi qua không đủ để kết luận FAILED");
    assert.equal(act.reconciliation_status, "MANUAL_REQUIRED");
    // Operator kiểm tại site thấy đèn đã tắt và ghi bằng chứng đủ tiêu chuẩn → VERIFIED, ticket đóng.
    hub.setPower("0x0000000000000A01", false);
    const r = await h.call("POST", `/v1/ops/actions/${action_id}/evidence`, {
      sub: "dev_ops",
      body: { grade: "DEVICE_REPORTED", result: "MATCH", source: "Home Assistant Green tại site_lab01", observed_at: new Date(h.clock.now()).toISOString(), note: "Đọc trực tiếp OnOff = OFF tại hub" },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "VERIFIED");
    assert.equal(r.body.reconciliation_status, "RESOLVED");
  } finally {
    await h.close();
  }
});

test("T12: trạng thái đọc từ cache cũ hơn max-age 2 giây không được dùng làm bằng chứng", async () => {
  const h = await harness();
  try {
    const hub = h.app.hubs.get("site_lab01")!;
    hub.faults.staleReadAgeMs = 5_000;
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    await tick(h, 2);
    let act = await action(h, action_id);
    assert.notEqual(act.status, "VERIFIED");
    hub.faults.staleReadAgeMs = 0;
    h.clock.advance(3000);
    await h.app.reconciler.tick();
    act = await action(h, action_id);
    assert.equal(act.status, "VERIFIED");
  } finally {
    await h.close();
  }
});

test("T12/T17: reset trong hàng chờ, recommission, bypass gateway, rời site", async () => {
  const h = await harness();
  try {
    const hub = h.app.hubs.get("site_lab01")!;
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF", "dev_lamp_02"));
    // Reset thiết bị trước khi worker phát: binding tăng, action đang chờ bị vô hiệu, không có I/O.
    hub.factoryReset("0x0000000000000A02", "0x0000000000000B02");
    const reset = await h.call("POST", "/v1/ops/devices/dev_lamp_02/reset", { sub: "dev_ops", body: { reason: "factory reset phát hiện tại site" } });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.status, "QUARANTINED");
    assert.equal(reset.body.binding_version, 2);
    await tick(h);
    assert.equal((await action(h, action_id)).status, "REJECTED");
    assert.equal(hub.commands.length, 0);
    assert.equal((await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON", "dev_lamp_02") })).status, 404, "thiết bị quarantine không nhận plan");
    assert.equal((await h.call("POST", "/v1/ops/devices/dev_lamp_02/reset", { sub: "dev_a", body: { reason: "thử vai sai" } })).status, 403);
    // Gọi thẳng hub bằng danh tính khác gateway: ACL chặn.
    const direct = await hub.invoke("ha-dashboard-user", "0x0000000000000A01", 1, ONOFF_CLUSTER, 0x01);
    assert.equal(direct.status, "ACCESS_DENIED");
    const viaGateway = await hub.invoke(GATEWAY_CLIENT, "0x0000000000000A01", 1, ONOFF_CLUSTER, 0x01);
    assert.equal(viaGateway.status, "SUCCESS");
    // Rời site: đọc và lệnh đều bị chặn.
    const gone = await h.call("POST", "/v1/ops/devices/dev_lamp_01/decommission", { sub: "dev_ops", body: { reason: "trả thiết bị" } });
    assert.equal(gone.body.status, "DECOMMISSIONED");
    hub.removeFabric("0x0000000000000A01");
    assert.equal((await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON", "dev_lamp_01") })).status, 404);
    const list = await h.call("GET", "/v1/devices?site=site_lab01");
    assert.ok(!list.body.devices.some((d: { device_ref: string }) => d.device_ref === "dev_lamp_01"));
  } finally {
    await h.close();
  }
});

test("chặn barrier: kho độc lập không ghi được thì không có I/O, action FAILED và đóng phát toàn hệ", async () => {
  const h = await harness();
  try {
    h.app.ctx.barrier.unavailable = true;
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    await tick(h);
    const act = await action(h, action_id);
    assert.equal(act.status, "FAILED");
    assert.equal(act.reason, "BARRIER_UNAVAILABLE");
    assert.equal(act.dispatch_state, "NOT_SENT");
    assert.equal(h.app.hubs.get("site_lab01")!.commands.length, 0);
    assert.equal(h.app.ctx.control.dispatchOpen(), false);
  } finally {
    await h.close();
  }
});
