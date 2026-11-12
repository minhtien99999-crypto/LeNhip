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
    // V1.0.0: icon PNG, màn hình trong views/ và manifest của bản cài được, đúng kiểu nội dung, vẫn kèm header bảo mật.
    for (const [p, type] of [
      ["/icons/icon-192.png", "image/png"],
      ["/icons/icon-512.png", "image/png"],
      ["/icons/apple-touch-icon.png", "image/png"],
      ["/icons/favicon-32.png", "image/png"],
      ["/icon.svg", "image/svg+xml"],
      ["/manifest.json", "application/manifest+json"],
      ["/views/index.js", "text/javascript; charset=utf-8"],
      ["/views/messages.js", "text/javascript; charset=utf-8"],
      ["/views/messages.css", "text/css; charset=utf-8"],
      ["/shared/i18n.js", "text/javascript; charset=utf-8"],
      ["/shared/i18n-vi.js", "text/javascript; charset=utf-8"],
    ]) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers.get("content-type"), type, p);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", p);
      assert.equal(r.headers.get("referrer-policy"), "no-referrer", p);
      assert.equal(r.headers.get("cache-control"), "no-cache", p);
      assert.equal(r.headers.get("content-security-policy"), null, `${p}: CSP chỉ gắn vào trang HTML`);
      await r.arrayBuffer();
    }
    const png = Buffer.from(await (await fetch(h.base + "/icons/icon-192.png")).arrayBuffer());
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    const manifest = (await (await fetch(h.base + "/manifest.json")).json()) as { display: string; icons: { src: string }[] };
    assert.equal(manifest.display, "standalone");
    for (const icon of manifest.icons) assert.equal((await fetch(new URL(icon.src, h.base + "/manifest.json"))).status, 200, icon.src);
    // Tên ngoài mẫu (chữ hoa, gạch dưới, đuôi khác, thư mục con, thoát thư mục) không được phục vụ.
    for (const p of [
      "/icons/Icon-192.png", "/icons/icon_192.png", "/icons/icon-192.svg", "/icons/icon-192.png/", "/icons/sub/icon-192.png", "/icons/.png", "/icons/",
      "/icons/..%2fapp.js", "/icons/%2e%2e/package.json", "/icons/..%2f..%2fpackage.json", "/icons/icon-192.png%00.js",
      "/views/index.ts", "/views/Index.js", "/views/index.mjs", "/views/a/index.js", "/views/", "/views/..%2f..%2fpackage.json", "/views/%2e%2e%2f%2e%2e%2fsrc%2fmain.ts",
      "/manifest.webmanifest", "/manifest.json/", "/sw.js", "/favicon.ico", "/icons/missing.png", "/views/missing.js",
    ]) {
      const r = await fetch(h.base + p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      await r.arrayBuffer();
    }
    for (const p of ["/icons/../app.js", "/views/../app.js"]) {
      const r = await fetch(h.base + p);
      assert.ok(r.status === 404 || r.url.endsWith("/app.js"), `${p} → ${r.status}`);
      await r.arrayBuffer();
    }
    assert.equal((await fetch(h.base + "/healthz")).status, 200);
  } finally {
    await h.close();
  }
});

// ---------------------------------------------------------------- V1.0.0, LNH-T23: mã thay cho câu chữ, máy chủ không biết ngôn ngữ
test("LNH-T23: lỗi mang detail_code và limit, message tiếng Việt giữ cho client cũ; máy chủ bỏ qua Accept-Language và không lưu ngôn ngữ", async () => {
  const h = await harness();
  try {
    const plan = (start: string, end: string, headers?: Record<string, string>) => h.call("POST", "/v1/plans", { body: calendarPlan(start, end), headers });
    const day = 86_400_000;
    const cases: [string, () => Promise<{ status: number; body: any; headers: Headers }>, number, string, string, number | undefined, string][] = [
      ["END_BEFORE_START", () => plan(vn(h.clock, "10:30"), vn(h.clock, "10:00")), 400, "SCHEMA_INVALID", "END_BEFORE_START", undefined, "Giờ kết thúc phải sau giờ bắt đầu."],
      ["BLOCK_TOO_LONG", () => plan(vn(h.clock, "10:00"), vn(h.clock, "15:00")), 422, "UNSUPPORTED", "BLOCK_TOO_LONG", 240, "Khung giờ dài tối đa 240 phút."],
      ["START_IN_PAST", () => plan(vn(h.clock, "08:00"), vn(h.clock, "08:30")), 422, "UNSUPPORTED", "START_IN_PAST", undefined, "Khung giờ phải bắt đầu sau thời điểm hiện tại."],
      ["BEYOND_HORIZON", () => plan(vn(h.clock, "10:00", 20), vn(h.clock, "10:30", 20)), 422, "UNSUPPORTED", "BEYOND_HORIZON", 14, "Chỉ đặt trong 14 ngày tới."],
      ["WINDOW_TOO_LONG", () => h.call("GET", `/v1/calendar/availability?start=${encodeURIComponent(new Date(h.clock.now()).toISOString())}&end=${encodeURIComponent(new Date(h.clock.now() + 20 * day).toISOString())}`), 400, "SCHEMA_INVALID", "WINDOW_TOO_LONG", 14, "Cửa sổ tối đa 14 ngày."],
      ["WORKSPACE_HEADER", () => h.call("GET", "/v1/me", { headers: { "X-LeNhip-Workspace": "bad" } }), 400, "SCHEMA_INVALID", "WORKSPACE_HEADER", undefined, "Thiếu hoặc sai X-LeNhip-Workspace."],
    ];
    const api = JSON.parse((await import("node:fs")).readFileSync(new URL("../contracts/openapi.json", import.meta.url), "utf8")) as { components: { schemas: { Error: { properties: { detail_code: { enum: string[] }; limit: { type: string } } } } } };
    assert.deepEqual(api.components.schemas.Error.properties.detail_code.enum.slice().sort(), cases.map((c) => c[0]).sort(), "enum detail_code của hợp đồng trùng các mã máy chủ gửi");
    assert.equal(api.components.schemas.Error.properties.limit.type, "integer");
    for (const [name, send, status, code, detail, limit, message] of cases) {
      const r = await send();
      assert.deepEqual([r.status, r.body.code, r.body.detail_code, r.body.limit, r.body.message, r.body.retryable], [status, code, detail, limit, message, false], name);
      errShape(r.body);
    }
    // Lỗi không có chi tiết thì không có hai trường này.
    const plain = await h.call("GET", "/v1/actions/act_khong_co");
    assert.deepEqual([plain.status, plain.body.code, "detail_code" in plain.body, "limit" in plain.body], [404, "NOT_FOUND", false, false]);

    // Cùng một yêu cầu với Accept-Language khác nhau cho cùng một phản hồi: máy chủ không đọc ngôn ngữ (LNH-T23).
    const same = (b: Record<string, unknown>) => JSON.stringify({ ...b, request_id: null });
    const langs = [undefined, "vi-VN,vi;q=0.9", "en-US,en;q=0.9", "ja", "fr-FR, de;q=0.5", "xx-invalid;;"];
    const errors = [];
    const answers = [];
    const mes = [];
    for (const lang of langs) {
      const headers = lang === undefined ? undefined : { "Accept-Language": lang, "Content-Language": lang };
      const e = await plan(vn(h.clock, "10:00"), vn(h.clock, "15:00"), headers);
      errors.push(same(e.body));
      const a = await h.call("POST", "/v1/lele/proposals", { body: { text: "xin chào", context: "work", zone: "Asia/Ho_Chi_Minh" }, headers });
      answers.push(same(a.body));
      const me = await h.call("GET", "/v1/me", { headers });
      mes.push(same(me.body));
      for (const r of [e, a, me]) assert.deepEqual([r.headers.get("content-language"), /accept-language/i.test(r.headers.get("vary") ?? "")], [null, false], "phản hồi không khai ngôn ngữ, không Vary theo ngôn ngữ");
    }
    for (const list of [errors, answers, mes]) assert.equal(new Set(list).size, 1, "Accept-Language không đổi phản hồi");
    assert.match(errors[0], /Khung giờ dài tối đa 240 phút/);
    assert.match(answers[0], /"answer_code":"HELP"/);
    // Không bảng nào có cột ngôn ngữ; không tệp nào của máy chủ đọc header hay trường ngôn ngữ.
    const ddl = all<{ sql: string | null }>(h.app.ctx.db, "SELECT sql FROM sqlite_master").map((r) => r.sql ?? "").join("\n");
    assert.doesNotMatch(ddl, /\b(?:locale|language|lang)\b/i);
    const fs = await import("node:fs");
    const src = new URL("../src/", import.meta.url);
    for (const file of fs.readdirSync(src, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts")) continue;
      const code = fs.readFileSync(new URL(file, src), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      assert.doesNotMatch(code, /accept-language|content-language|navigator\.language|\blocale\s*[:=]/i, `src/${file}: máy chủ không đọc và không lưu ngôn ngữ của người dùng`);
    }
  } finally {
    await h.close();
  }
});

test("LNH-T23: LeLe trả answer_code cho mọi câu trả lời không phải đề xuất; thông báo UNKNOWN trong outbox mang mã ACTION_UNVERIFIED", async () => {
  const h = await harness();
  try {
    const ask = async (text: string, context = "work") => {
      const r = await h.call("POST", "/v1/lele/proposals", { body: { text, context, zone: "Asia/Ho_Chi_Minh" } });
      assert.equal(r.status, 200, text);
      assert.deepEqual(SCHEMAS.validate("LeLeResult", r.body), [], text);
      return [r.body.type, r.body.answer_code, r.body.fallback];
    };
    assert.deepEqual(await ask("xin chào"), ["ANSWER", "HELP", null]);
    assert.deepEqual(await ask("bật đèn", "home"), ["FORM", "PICK_LAMP", "device.set_power"], "hai đèn, không gọi tên: chọn trong Ngôi nhà");
    assert.deepEqual(await ask("mở đèn bàn", "home"), ["PROPOSAL", null, null], "«mở» được nhận ra");
    assert.deepEqual(await ask("dành 300 phút lúc 15:00"), ["FORM", "DURATION_RANGE", "calendar.block"]);
    assert.deepEqual(await ask("tối qua tôi ngủ ít, xếp lịch nghỉ"), ["FORM", "HEALTH_LOCAL", "NONE"]);
    assert.deepEqual(await ask("gọi 0912345678 rồi đặt 30 phút lúc 15:00"), ["FORM", "PII_BLOCKED", "NONE"]);
    assert.deepEqual(await ask("Dành 30 phút tập trung lúc 15:30"), ["PROPOSAL", null, null]);

    // Tác vụ chưa xác minh được sau một giờ: thông báo chung trong outbox có mã để thiết bị dựng câu theo ngôn ngữ của mình.
    const hub = h.app.hubs.get("site_lab01")!;
    hub.faults.dropAck = true;
    hub.faults.applyCommands = false;
    h.app.receivers.get("device.set_power")!.realAckWaitMs = 10;
    await planAndApprove(h, lampPlan("SET_OFF"));
    await tick(h);
    for (const step of [10_000, 5 * 60_000, 60 * 60_000]) {
      h.clock.advance(step);
      await h.app.reconciler.tick();
    }
    const notes = all<{ payload: string }>(h.app.ctx.db, "SELECT payload FROM outbox WHERE topic = 'notify.user'").map((r) => JSON.parse(r.payload) as Record<string, string>);
    assert.deepEqual(notes, [{ to: "dev_a", code: "ACTION_UNVERIFIED", text: "Một thao tác của bạn chưa xác minh được kết quả. Mở LeNhip để xem." }]);
  } finally {
    await h.close();
  }
});
