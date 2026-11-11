// T02 (ARC01, API01), T14 (hợp đồng lỗi), T19 (PRIV02, RET01), T13 (MG01) và T04 (X01, PRIV01) phần chạy được ở máy chủ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../src/server/app.ts";
import { DevIssuer } from "../src/server/auth.ts";
import { all } from "../src/server/store.ts";
import { action, calendarPlan, harness, key, lampPlan, planAndApprove, tick, vn } from "./helpers.ts";

const errShape = (b: unknown) => assert.deepEqual(SCHEMAS.validate("Error", b), [], JSON.stringify(b));

test("lỗi chuẩn: 400 khóa trùng/schema/thiếu workspace, 401 token, 404 ngoài miền, 405, 413, 415; luôn có code, message, request_id, retryable", async () => {
  const h = await harness();
  try {
    const dup = await h.call("POST", "/v1/plans", { raw: '{"kind":"calendar.block","kind":"device.set_power"}' });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.code, "DUPLICATE_KEY");
    errShape(dup.body);
    const extra = await h.call("POST", "/v1/plans", { body: { ...lampPlan("SET_ON"), reason_from_health: "ngủ kém" } });
    assert.equal(extra.status, 400, "additionalProperties=false: không lọt nguyên nhân sức khỏe vào miền đích");
    assert.equal(extra.body.code, "SCHEMA_INVALID");
    errShape(extra.body);
    const noWs = await h.call("GET", "/v1/me", { headers: { "X-LeNhip-Workspace": "bad" } });
    assert.equal(noWs.status, 400);
    const noAuth = await fetch(h.base + "/v1/me", { headers: { "X-LeNhip-Workspace": "ws_demo" } });
    assert.equal(noAuth.status, 401);
    errShape(await noAuth.json());
    const otherIssuer = new DevIssuer("https://evil.test", "lenhip-api");
    const forged = await fetch(h.base + "/v1/me", { headers: { "X-LeNhip-Workspace": "ws_demo", Authorization: `Bearer ${otherIssuer.mint("dev_a", "x", h.clock.now())}` } });
    assert.equal(forged.status, 401, "issuer lạ");
    const wrongAud = await fetch(h.base + "/v1/me", { headers: { "X-LeNhip-Workspace": "ws_demo", Authorization: `Bearer ${h.app.dev!.mint("dev_a", "x", h.clock.now(), { audience: "other-api" })}` } });
    assert.equal(wrongAud.status, 401, "sai audience");
    const expired = h.app.dev!.mint("dev_a", "x", h.clock.now() - 3600_000, { ttlS: 60 });
    assert.equal((await fetch(h.base + "/v1/me", { headers: { "X-LeNhip-Workspace": "ws_demo", Authorization: `Bearer ${expired}` } })).status, 401);
    assert.equal((await h.call("GET", "/v1/me", { ws: "ws_other" })).status, 404, "workspace không là thành viên");
    assert.equal((await h.call("GET", "/v1/plans")).status, 405);
    const big = await h.call("POST", "/v1/plans", { raw: JSON.stringify({ x: "a".repeat(70_000) }) });
    assert.equal(big.status, 413);
    const ct = await fetch(h.base + "/v1/plans", { method: "POST", headers: { "X-LeNhip-Workspace": "ws_demo", Authorization: `Bearer ${h.token("dev_a")}`, "Idempotency-Key": key(), "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(ct.status, 415);
  } finally {
    await h.close();
  }
});

test("ma trận truy cập: người khác workspace/người khác không đọc được plan/action của nhau (404 đồng nhất)", async () => {
  const h = await harness();
  try {
    const { plan, action_id } = await planAndApprove(h, calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")));
    assert.equal((await h.call("GET", `/v1/actions/${action_id}`, { sub: "dev_b" })).status, 404);
    assert.equal((await h.call("GET", `/v1/plans/${plan.plan_id}`, { sub: "dev_b" })).status, 404);
    assert.equal((await h.call("POST", `/v1/actions/${action_id}/cancel`, { sub: "dev_b" })).status, 404);
    assert.equal((await h.call("GET", `/v1/actions/${action_id}`, { sub: "dev_ops" })).status, 404, "vận hành không đọc action người khác qua API người dùng");
    assert.equal((await h.call("GET", "/v1/devices?site=site_lab01", { sub: "dev_b" })).status, 403);
    assert.equal((await h.call("GET", "/v1/devices?site=site_nope", { sub: "dev_a" })).status, 404);
    const me = await h.call("GET", "/v1/me");
    assert.equal(me.status, 200);
    assert.deepEqual(SCHEMAS.validate("Me", me.body), []);
    const list = await h.call("GET", "/v1/actions");
    assert.deepEqual(SCHEMAS.validate("ActionList", list.body), []);
    assert.equal(list.body.items.length, 1);
    assert.equal((await h.call("GET", "/v1/actions", { sub: "dev_b" })).body.items.length, 0);
  } finally {
    await h.close();
  }
});

test("đồng ý: health_local không lên máy chủ; ghi và rút đồng ý chặn phát mới, hủy plan chờ", async () => {
  const h = await harness({ consents: false });
  try {
    const health = await h.call("POST", "/v1/consents", { body: { purpose_id: "health_local", text_version: "v1", text_hash: "A".repeat(43), choice: "GRANTED" } });
    assert.equal(health.status, 422);
    assert.equal(health.body.code, "HEALTH_LOCAL_ONLY");
    assert.equal((await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON") })).body.code, "CONSENT_REQUIRED");
    const c = await h.call("POST", "/v1/consents", { body: { purpose_id: "home_control", text_version: "v1", text_hash: "A".repeat(43), choice: "GRANTED" } });
    assert.equal(c.status, 201);
    assert.deepEqual(SCHEMAS.validate("ConsentReceipt", c.body), []);
    const p = await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON", "dev_lamp_02") });
    assert.equal(p.status, 201);
    const w = await h.call("POST", "/v1/consents/home_control/withdraw", {});
    assert.equal(w.status, 200);
    assert.ok(w.body.withdrawn_at);
    assert.equal((await h.call("GET", `/v1/plans/${p.body.plan_id}`)).body.state, "REJECTED");
    const list = await h.call("GET", "/v1/consents");
    assert.deepEqual(SCHEMAS.validate("ConsentList", list.body), []);
  } finally {
    await h.close();
  }
});

test("quyền chủ thể: hạn theo loại, EXPORT/DELETE cần xác thực lại, export một lần trong 24 giờ, xóa có giữ tối thiểu và tombstone", async () => {
  const h = await harness();
  try {
    const access = await h.call("POST", "/v1/privacy/requests", { body: { type: "ACCESS" } });
    assert.equal(access.status, 202);
    assert.deepEqual(SCHEMAS.validate("PrivacyRequest", access.body), []);
    const rec = Date.parse(access.body.received_at);
    assert.equal(Date.parse(access.body.target_due_at) - rec, 7 * 86_400_000);
    assert.equal(Date.parse(access.body.legal_due_at) - rec, 10 * 86_400_000);
    assert.ok(Date.parse(access.body.ack_due_at) > rec);
    // Token cũ (auth_time 1 giờ trước): cần xác thực lại.
    const stale = await fetch(h.base + "/v1/privacy/requests", {
      method: "POST",
      headers: { "X-LeNhip-Workspace": "ws_demo", Authorization: `Bearer ${h.token("dev_a", { authTime: Math.floor(h.clock.now() / 1000) - 3600 })}`, "Idempotency-Key": key(), "Content-Type": "application/json" },
      body: JSON.stringify({ type: "EXPORT" }),
    });
    assert.equal(stale.status, 401);
    assert.equal((await stale.json()).code, "REAUTH_REQUIRED");
    await planAndApprove(h, calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")));
    const ex = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
    assert.equal(ex.status, 202);
    assert.equal(ex.body.status, "COMPLETED");
    const path = ex.body.export.path as string;
    const dl = await h.call("GET", path);
    assert.equal(dl.status, 200);
    assert.equal(dl.body.actions.length, 1);
    assert.match(dl.body.scope, /điện thoại/);
    assert.equal((await h.call("GET", path)).status, 410, "liên kết dùng một lần");
    assert.equal((await h.call("GET", path, { sub: "dev_b" })).status, 404);
    const restrict = await h.call("POST", "/v1/privacy/requests", { body: { type: "RESTRICT" } });
    assert.equal(restrict.body.status, "IN_PROGRESS");
    assert.equal((await h.call("POST", "/v1/plans", { body: lampPlan("SET_ON") })).body.code, "CONSENT_REQUIRED", "chặn tác vụ mới ngay khi ghi nhận");
    const del = await h.call("POST", "/v1/privacy/requests", { sub: "dev_b", body: { type: "DELETE" } });
    assert.equal(del.status, 202);
    assert.equal(Date.parse(del.body.target_due_at) - Date.parse(del.body.received_at), 10 * 86_400_000);
    assert.equal((await h.call("GET", "/v1/me", { sub: "dev_b" })).status, 404);
    const tomb = h.app.ctx.revocations.readAll().entries.filter((e) => e.type === "member_deleted");
    assert.equal(tomb.length, 1);
    const get = await h.call("GET", `/v1/privacy/requests/${access.body.request_id}`);
    assert.equal(get.status, 200);
  } finally {
    await h.close();
  }
});

test("thu hồi quyền: trả authz_version mới, retry cùng khóa không tăng lần nữa, khóa mới báo đã thu hồi", async () => {
  const h = await harness();
  try {
    const me = (await h.call("GET", "/v1/me")).body;
    const g = me.grants.find((x: { scope: string }) => x.scope === "robot.simulate");
    const k = key();
    const r1 = await h.call("POST", `/v1/grants/${g.id}/revoke`, { key: k });
    const r2 = await h.call("POST", `/v1/grants/${g.id}/revoke`, { key: k });
    assert.deepEqual(SCHEMAS.validate("GrantRevoked", r1.body), []);
    assert.deepEqual(r1.body, r2.body);
    const r3 = await h.call("POST", `/v1/grants/${g.id}/revoke`, {});
    assert.equal(r3.body.already_revoked, true);
    assert.equal(r3.body.authz_version, r1.body.authz_version);
    const events = all<{ n: number }>(h.app.ctx.db, "SELECT COUNT(*) AS n FROM control_events WHERE kind = 'GRANT_REVOKED'")[0].n;
    assert.equal(events, 1);
    assert.equal((await h.call("POST", `/v1/grants/${g.id}/revoke`, { sub: "dev_b" })).status, 404, "không phải của mình, không phải quản trị");
  } finally {
    await h.close();
  }
});

test("LeLe: đề xuất có kiểu cần xác nhận qua plan; chặn sức khỏe/dữ liệu cá nhân; sai schema sửa một lần rồi form; quá giờ thì form", async () => {
  const h = await harness();
  try {
    const p = await h.call("POST", "/v1/lele/proposals", { body: { text: "Dành 30 phút tập trung lúc 15:30", context: "work", zone: "Asia/Ho_Chi_Minh" } });
    assert.equal(p.status, 200);
    assert.deepEqual(SCHEMAS.validate("LeLeResult", p.body), []);
    assert.equal(p.body.type, "PROPOSAL");
    assert.equal(p.body.ai_generated, false);
    assert.equal(p.body.proposal.kind, "calendar.block");
    // Đề xuất không tự chạy: phải lập plan và duyệt như form.
    assert.equal(all<{ n: number }>(h.app.ctx.db, "SELECT COUNT(*) AS n FROM actions")[0].n, 0);
    const plan = await h.call("POST", "/v1/plans", { body: { kind: p.body.proposal.kind, schema_version: 1, workspace_ref: "ws_demo", args: p.body.proposal.args } });
    assert.equal(plan.status, 201);
    const lamp = await h.call("POST", "/v1/lele/proposals", { body: { text: "tắt đèn trần giúp tôi", context: "home", zone: "Asia/Ho_Chi_Minh" } });
    assert.equal(lamp.body.proposal.args.device_ref, "dev_lamp_02");
    const health = await h.call("POST", "/v1/lele/proposals", { body: { text: "tối qua tôi ngủ ít, xếp lịch nghỉ", context: "work", zone: "Asia/Ho_Chi_Minh" } });
    assert.equal(health.body.type, "FORM");
    const pii = await h.call("POST", "/v1/lele/proposals", { body: { text: "gọi 0912345678 rồi đặt 30 phút lúc 15:00", context: "work", zone: "Asia/Ho_Chi_Minh" } });
    assert.equal(pii.body.type, "FORM");
  } finally {
    await h.close();
  }
  // Nhà cung cấp trả sai schema rồi sửa đúng; nhà cung cấp sai hai lần; nhà cung cấp quá giờ.
  let calls = 0;
  const flaky = {
    id: "flaky", external: false,
    propose: async () => JSON.stringify({ type: "PROPOSAL", proposal: { kind: "device.set_power", args: { site: "site_lab01" }, summary: "x" } }),
    repair: async () => (calls++, JSON.stringify({ type: "PROPOSAL", proposal: { kind: "device.set_power", args: { site: "site_lab01", device_ref: "dev_lamp_01", command: "SET_ON" }, summary: "Bật đèn bàn" } })),
  };
  const h2 = await harness({ provider: flaky });
  try {
    const r = await h2.call("POST", "/v1/lele/proposals", { body: { text: "bật đèn", context: "home", zone: "Asia/Ho_Chi_Minh" } });
    assert.equal(r.body.type, "PROPOSAL");
    assert.equal(calls, 1);
  } finally {
    await h2.close();
  }
  const bad = { id: "bad", external: false, propose: async () => '{"type":"PROPOSAL","proposal":{"kind":"robot.dance"}}', repair: async () => "{not json" };
  const h3 = await harness({ provider: bad });
  try {
    const r = await h3.call("POST", "/v1/lele/proposals", { body: { text: "bật đèn", context: "home", zone: "Asia/Ho_Chi_Minh" } });
    assert.equal(r.body.type, "FORM");
  } finally {
    await h3.close();
  }
  const slow = { id: "slow", external: false, propose: () => new Promise<string>(() => undefined) };
  const h4 = await harness({ provider: slow, config: { rateLimit: { perSecond: 1000, burst: 100000 }, leleTimeoutMs: 30 } as never });
  try {
    const r = await h4.call("POST", "/v1/lele/proposals", { body: { text: "bật đèn", context: "home", zone: "Asia/Ho_Chi_Minh" } });
    assert.equal(r.body.type, "FORM");
  } finally {
    await h4.close();
  }
  await assert.rejects(harness({ provider: { id: "openai-x", external: true, propose: async () => "{}" } }), /VendorProfile/);
});

test("vận hành: cờ mô-đun là kill switch; metrics không gắn user/action ID; giới hạn tốc độ 429", async () => {
  const h = await harness();
  try {
    const off = await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "calendar", enabled: false, reason: "kiểm kill switch" } });
    assert.equal(off.status, 200);
    assert.deepEqual(SCHEMAS.validate("Flags", off.body), []);
    const r = await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")) });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "MODULE_DISABLED");
    assert.equal((await h.call("POST", "/v1/ops/flags", { sub: "dev_a", body: { module: "calendar", enabled: true, reason: "thử" } })).status, 403);
    await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "calendar", enabled: true, reason: "mở lại" } });
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    await tick(h);
    assert.equal((await action(h, action_id)).status, "VERIFIED");
    const m = await h.call("GET", "/v1/ops/metrics", { sub: "dev_ops" });
    assert.deepEqual(SCHEMAS.validate("Metrics", m.body), []);
    const text = JSON.stringify(m.body);
    assert.ok(!text.includes("dev_a") && !text.includes(action_id), "metrics không có user/action ID");
  } finally {
    await h.close();
  }
  const h2 = await harness({ config: { rateLimit: { perSecond: 0.001, burst: 3 } } as never });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await h2.call("GET", "/v1/me")).status);
    assert.deepEqual(codes.slice(3), [429, 429]);
  } finally {
    await h2.close();
  }
});

test("phục vụ giao diện: chỉ tệp trong danh sách, có CSP; không lộ tệp ngoài web/", async () => {
  const h = await harness();
  try {
    const index = await fetch(h.base + "/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal((await fetch(h.base + "/shared/sleep.js")).status, 200);
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/contracts/openapi.json", "/src/main.ts", "/shared/../app.js"]) {
      const r = await fetch(h.base + p);
      assert.ok(r.status === 404 || r.url.endsWith("/app.js"), `${p} → ${r.status}`);
    }
    assert.equal((await fetch(h.base + "/healthz")).status, 200);
  } finally {
    await h.close();
  }
});
