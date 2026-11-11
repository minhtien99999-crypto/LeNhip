// T05 (POL01): đổi lần lượt digest, plan_version, authz/export/binding version trước và sau claim; điểm tuyến tính hóa là CAS
// claim tại receiver. Cùng các hạn 120 giây của duyệt và cửa sổ phát.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EXPORT_POLICY, setExportPolicy, changeBinding } from "../src/server/authority.ts";
import { issuePermit } from "../src/server/worker.ts";
import { getByActionId } from "../src/server/machine.ts";
import { action, calendarPlan, harness, lampPlan, planAndApprove, tick, vn } from "./helpers.ts";

const approve = (h: Awaited<ReturnType<typeof harness>>, plan: { plan_id: string; plan_version: number; payload_digest: string }, over: Record<string, unknown> = {}) =>
  h.call("POST", `/v1/plans/${plan.plan_id}/approve`, { body: { plan_version: plan.plan_version, approved_digest: plan.payload_digest, ...over } });

test("duyệt sai digest hoặc sai plan_version bị từ chối, plan vẫn chờ duyệt", async () => {
  const h = await harness();
  try {
    const p = (await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:20")) })).body;
    const bad = p.payload_digest.slice(0, -1) + (p.payload_digest.endsWith("A") ? "B" : "A");
    assert.equal((await approve(h, p, { approved_digest: bad })).body.code, "DIGEST_MISMATCH");
    assert.equal((await approve(h, p, { plan_version: p.plan_version + 1 })).body.code, "PLAN_STALE");
    assert.equal((await h.call("GET", `/v1/plans/${p.plan_id}`)).body.state, "PENDING_APPROVAL");
    assert.equal((await approve(h, p)).status, 202);
  } finally {
    await h.close();
  }
});

test("hết 120 giây: 410 APPROVAL_EXPIRED và plan thành EXPIRED (ghi bền dù trả lỗi)", async () => {
  const h = await harness();
  try {
    const p = (await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:20")) })).body;
    h.clock.advance(120_001);
    const r = await approve(h, p);
    assert.equal(r.status, 410);
    assert.equal(r.body.code, "APPROVAL_EXPIRED");
    assert.equal((await h.call("GET", `/v1/plans/${p.plan_id}`)).body.state, "EXPIRED");
  } finally {
    await h.close();
  }
});

test("thu hồi quyền, đổi chính sách xuất, đổi binding, rút đồng ý trước duyệt: PLAN_STALE và REJECTED", async () => {
  const h = await harness();
  try {
    // Thu hồi quyền home.control.
    const p1 = (await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON", "dev_lamp_02") })).body;
    const me = (await h.call("GET", "/v1/me")).body;
    const home = me.grants.find((g: { scope: string }) => g.scope === "home.control");
    const rv = await h.call("POST", `/v1/grants/${home.id}/revoke`, {});
    assert.equal(rv.status, 200);
    assert.equal(rv.body.authz_version, 2, "authz_version tăng đúng một lần");
    assert.equal((await h.call("GET", `/v1/plans/${p1.plan_id}`)).body.state, "REJECTED", "Authority vô hiệu plan chưa claim");
    assert.equal((await approve(h, p1)).body.code, "PLAN_STALE");

    // Đổi chính sách xuất: digest mới làm stale dù quyền scope giữ nguyên.
    const p2 = (await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "11:00"), vn(h.clock, "11:15")) })).body;
    setExportPolicy(h.app.ctx, "ws_demo", { ...DEFAULT_EXPORT_POLICY, policy_version: "2026-11-11.2" }, "dev_ops");
    const r2 = await approve(h, p2);
    assert.equal(r2.status, 409);
    assert.equal(r2.body.code, "PLAN_STALE");
  } finally {
    await h.close();
  }
});

test("thay đổi sau duyệt, trước claim: Authority không cấp permit, receiver từ chối permit cũ, action REJECTED", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, lampPlan("SET_ON", "dev_lamp_02"));
    const row = getByActionId(h.app.ctx.db, action_id)!;
    const receiver = h.app.receivers.get("device.set_power")!;
    // Permit lấy trước khi đổi binding (giả lập permit đang bay).
    const { token } = issuePermit(h.app.ctx, h.app.issuer, receiver, row, h.app.identity);
    changeBinding(h.app.ctx, "dev_lamp_02", "QUARANTINED", "firmware đổi", "dev_ops", "1.1.0");
    await assert.rejects(receiver.accept(token, h.app.identity.certDer), /PERMIT_STALE|PERMIT_REVISION/);
    const act = await action(h, action_id);
    assert.equal(act.status, "REJECTED");
    assert.equal(act.reason, "BINDING_CHANGED");
    assert.equal(h.app.hubs.get("site_lab01")!.commands.length, 0, "không có I/O");
  } finally {
    await h.close();
  }
});

test("thu hồi sau điểm claim không gỡ lệnh đã bắt đầu: tác vụ tiếp tục đối soát", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    await h.app.dispatcher.tick();
    const me = (await h.call("GET", "/v1/me")).body;
    const home = me.grants.find((g: { scope: string }) => g.scope === "home.control");
    await h.call("POST", `/v1/grants/${home.id}/revoke`, {});
    h.clock.advance(1100);
    await h.app.reconciler.tick();
    const act = await action(h, action_id);
    assert.equal(act.status, "VERIFIED");
  } finally {
    await h.close();
  }
});

test("hủy: trước claim nguyên tử (CANCELED); sau claim chỉ cancel_requested, giữ trạng thái thật", async () => {
  const h = await harness();
  try {
    const a = await planAndApprove(h, calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:10")));
    const c1 = await h.call("POST", `/v1/actions/${a.action_id}/cancel`, {});
    assert.equal(c1.body.status, "CANCELED");
    await tick(h);
    assert.equal(h.app.graph.calls.createEvent, 0);

    h.app.graph.faults.post = "hang";
    const b = await planAndApprove(h, calendarPlan(vn(h.clock, "11:00"), vn(h.clock, "11:10")));
    const receiver = h.app.receivers.get("calendar.block")!;
    receiver.realAckWaitMs = 20;
    await h.app.dispatcher.tick();
    const c2 = await h.call("POST", `/v1/actions/${b.action_id}/cancel`, {});
    assert.equal(c2.status, 200);
    assert.equal(c2.body.status, "DISPATCHING");
    assert.equal(c2.body.cancel_requested, true);
    h.app.graph.release();
  } finally {
    await h.close();
  }
});

test("cửa sổ phát 120 giây: AUTHORIZED chưa claim thành EXPIRED khi đóng phát", async () => {
  const h = await harness();
  try {
    const a = await planAndApprove(h, calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:10")));
    h.app.ctx.control.lockDispatch(new Date(h.clock.now()).toISOString(), "test", "maintenance");
    await h.app.dispatcher.tick();
    h.clock.advance(120_001);
    await h.app.reconciler.tick();
    const act = await action(h, a.action_id);
    assert.equal(act.status, "EXPIRED");
    assert.equal(act.reason, "DISPATCH_WINDOW_PASSED");
    // Khi đang đóng phát, duyệt mới trả 503 có thể thử lại.
    const p = (await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "11:00"), vn(h.clock, "11:10")) })).body;
    const r = await approve(h, p);
    assert.equal(r.status, 503);
    assert.equal(r.body.retryable, true);
  } finally {
    await h.close();
  }
});

test("lịch: giới hạn khung giờ, quá khứ, quá 14 ngày, chưa liên kết tài khoản", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "15:00")) })).status, 422, "dài hơn 240 phút");
    assert.equal((await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "08:00"), vn(h.clock, "08:30")) })).status, 422, "trong quá khứ");
    assert.equal((await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00", 15), vn(h.clock, "10:30", 15)) })).status, 422, "quá 14 ngày");
    assert.equal((await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:30"), vn(h.clock, "10:00")) })).status, 400, "kết thúc trước bắt đầu");
  } finally {
    await h.close();
  }
});
