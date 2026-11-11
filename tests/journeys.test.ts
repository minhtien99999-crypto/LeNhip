// Ba hành trình tích hợp (SRS mục 32) chạy đầu-cuối trên máy chủ thật, adapter giả lập: lịch Microsoft 365 và đèn tại site.
// Hành trình sức khỏe chạy trên điện thoại (tests/sleep.test.ts); máy chủ không nhận dữ liệu sức khỏe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../src/server/app.ts";
import { action, calendarPlan, harness, lampPlan, planAndApprove, tick, vn } from "./helpers.ts";

test("lịch: plan → preview → duyệt → claim → tạo event private/busy → đọc lại → VERIFIED", async () => {
  const h = await harness();
  try {
    const p = await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")) });
    assert.equal(p.status, 201);
    assert.deepEqual(SCHEMAS.validate("Plan", p.body), []);
    assert.equal(p.body.state, "PENDING_APPROVAL");
    assert.equal(p.body.preview.title_code, "PERSONAL_TIME");
    assert.equal(p.body.preview.visibility, "private");
    assert.equal(p.body.preview.show_as, "busy");
    assert.equal(Date.parse(p.body.approval_deadline) - h.clock.now(), 120_000);
    const a = await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { body: { plan_version: p.body.plan_version, approved_digest: p.body.payload_digest } });
    assert.equal(a.status, 202);
    assert.deepEqual(SCHEMAS.validate("ApproveAccepted", a.body), []);
    await tick(h);
    const act = await action(h, a.body.action_id);
    assert.deepEqual(SCHEMAS.validate("Action", act), []);
    assert.equal(act.status, "VERIFIED");
    assert.equal(act.outcome, "EVENT_CREATED");
    assert.equal(act.evidence_grade, "PROVIDER_READBACK");
    assert.equal(act.dispatch_state, "SENT");
    const events = h.app.graph.events("cal_dev_a").filter((e) => e.createdBy === "lenhip");
    assert.equal(events.length, 1);
    assert.equal(events[0].sensitivity, "private");
    assert.equal(events[0].showAs, "busy");
    assert.equal(events[0].subject, "Thời gian cá nhân");
    assert.equal(events[0].transactionId, a.body.action_id);
    const av = await h.call("GET", `/v1/calendar/availability?start=${encodeURIComponent(vn(h.clock, "08:00"))}&end=${encodeURIComponent(vn(h.clock, "18:00"))}`);
    assert.equal(av.status, 200);
    assert.deepEqual(SCHEMAS.validate("Availability", av.body), []);
    assert.ok(!JSON.stringify(av.body).includes("Cuộc họp"), "availability không trả tiêu đề cuộc họp");
    assert.equal(av.body.lenhip_blocks.length, 1);
  } finally {
    await h.close();
  }
});

test("lịch: khung giờ đã bận khi kiểm ngay trước ghi → CONFLICT, không tạo event (LNH-T01)", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, calendarPlan(vn(h.clock, "14:00"), vn(h.clock, "14:15")));
    await tick(h);
    const act = await action(h, action_id);
    assert.equal(act.status, "CONFLICT");
    assert.equal(act.outcome, "BUSY_BEFORE_CREATE");
    assert.equal(act.event_created, false);
    assert.equal(act.dispatch_state, "NOT_SENT");
    assert.equal(h.app.graph.calls.createEvent, 0);
  } finally {
    await h.close();
  }
});

test("đèn: duyệt → đọc mới → lệnh OnOff 0x0006 → DEVICE_REPORTED → VERIFIED; thẻ trạng thái tách khỏi lịch sử action", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    await tick(h);
    let act = await action(h, action_id);
    assert.equal(act.status, "VERIFIED");
    assert.equal(act.outcome, "APPLIED");
    assert.equal(act.evidence_grade, "DEVICE_REPORTED");
    const hub = h.app.hubs.get("site_lab01")!;
    assert.equal(hub.commands.length, 1);
    assert.equal(hub.commands[0].command, 0x00);
    // Người dùng bật tay lúc sau: thẻ thiết bị đổi, kết quả action giữ nguyên (SRS mục 13, 18).
    hub.manualToggle("0x0000000000000A01");
    const dl = await h.call("GET", "/v1/devices?site=site_lab01");
    assert.equal(dl.status, 200);
    assert.deepEqual(SCHEMAS.validate("DeviceList", dl.body), []);
    const next = await planAndApprove(h, lampPlan("SET_ON"));
    await tick(h);
    act = await action(h, action_id);
    assert.equal(act.status, "VERIFIED");
    assert.equal(act.outcome, "APPLIED");
    const second = await action(h, next.action_id);
    assert.equal(second.status, "VERIFIED");
    assert.equal(second.outcome, "ALREADY_IN_STATE", "đèn đã bật tay trước lệnh: không gửi I/O");
    assert.equal(second.dispatch_state, "NOT_SENT");
    assert.equal(hub.commands.length, 1);
  } finally {
    await h.close();
  }
});

test("robot: mô phỏng qua trust root riêng, bằng chứng SIMULATED", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, { kind: "robot.simulate", schema_version: 1, workspace_ref: "ws_demo", args: { scenario: "DELIVER_DOCUMENT" } });
    await tick(h);
    const act = await action(h, action_id);
    assert.equal(act.status, "VERIFIED");
    assert.equal(act.evidence_grade, "SIMULATED");
    assert.equal(act.outcome, "SIMULATED");
  } finally {
    await h.close();
  }
});

test("người không có quyền site, không có đồng ý, không phải thành viên: lỗi đúng loại", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("POST", "/v1/plans", { sub: "dev_b", body: lampPlan("SET_ON") })).status, 403, "dev_b không có home.control");
    assert.equal((await h.call("POST", "/v1/plans", { sub: "stranger", body: lampPlan("SET_ON") })).status, 404, "ngoài miền");
    const other = await h.call("POST", "/v1/plans", { sub: "dev_a", body: { ...lampPlan("SET_ON"), workspace_ref: "ws_other" } });
    assert.equal(other.status, 404, "workspace trong thân khác header");
    await h.call("POST", "/v1/consents/home_control/withdraw", { sub: "dev_a" });
    const r = await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON") });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "CONSENT_REQUIRED");
  } finally {
    await h.close();
  }
});
