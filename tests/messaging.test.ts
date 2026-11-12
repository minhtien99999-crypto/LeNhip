// Nhắn tin và «Thiết bị của tôi» (LNH-T30..T36) qua API thật: ma trận cổng trên mọi route, đăng ký thiết bị, bảng THREAD_ đi
// qua mọi trạng thái × sự kiện × người gọi, hai người mỗi người hai thiết bị với mật mã thật, phát lại, KEYS_CHANGED, giới hạn
// trên đồng hồ tay, báo cáo. Người dùng là ba tài khoản thử tổng hợp; «thiết bị» là cặp khóa tạo trong tiến trình kiểm thử.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../src/server/app.ts";
import { MESSAGES } from "../src/core/errors.ts";
import { uuid } from "../src/core/crypto.ts";
import { indexTransitions, transitionsFor } from "../src/server/machine.ts";
import { MESSAGING_LIMITS, messaging } from "../src/server/messaging.ts";
import { MODULES } from "../src/server/modules.ts";
import { all, one, run } from "../src/server/store.ts";
import { generateEndpointKey, publicKeyBytes, toBase64url } from "../web/shared/msg-crypto.js";
import { harness, key, WS, type Harness } from "./helpers.ts";
import { ack, addMember, clientRef, consent, count, device, inbox, keysOf, open, openThread, pair, pending, post, seal, sendText, threadRow, type Device } from "./helpers-messaging.ts";

const valid = (schema: string, body: unknown) => assert.deepEqual(SCHEMAS.validate(schema, body), [], `${schema}: ${JSON.stringify(body)}`);
const flag = (h: Harness, enabled: boolean) => h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "messaging", enabled, reason: "kiểm cổng nhắn tin" } });
const grantOf = (h: Harness, sub: string) => one<{ id: string; status: string }>(h.app.ctx.db, "SELECT id, status FROM grants WHERE workspace_id = ? AND user_id = ? AND scope = 'messaging.use'", WS, sub);
const setGrant = (h: Harness, sub: string, status: "ACTIVE" | "REVOKED") => run(h.app.ctx.db, "UPDATE grants SET status = ? WHERE workspace_id = ? AND user_id = ? AND scope = 'messaging.use'", status, WS, sub);
const viewOf = async (h: Harness, d: Device, thread: string) => ((await inbox(h, d)).body.threads as { thread_id: string }[]).find((t) => t.thread_id === thread) as Record<string, unknown>;

test("mô-đun đã đăng ký; dữ liệu mẫu cấp quyền messaging.use cho ba tài khoản thử nhưng KHÔNG cấp sẵn đồng ý; bốn mã lỗi mới có câu tiếng Việt", async () => {
  assert.ok(MODULES.includes(messaging));
  assert.equal(messaging.name, "messaging");
  const h = await harness();
  try {
    for (const sub of ["dev_a", "dev_b", "dev_ops"]) {
      const me = (await h.call("GET", "/v1/me", { sub })).body;
      assert.equal(me.modules.messaging, true);
      assert.equal(me.grants.filter((g: { scope: string; status: string }) => g.scope === "messaging.use" && g.status === "ACTIVE").length, 1, sub);
      assert.equal(me.consents.some((c: { purpose_id: string }) => c.purpose_id === "messaging"), false, "đồng ý không được cấp sẵn");
      const first = await h.call("GET", "/v1/messages/people", { sub });
      assert.equal(first.status, 403);
      assert.equal(first.body.code, "CONSENT_REQUIRED", "lần mở đầu tiên: người dùng phải tự bật");
    }
    assert.equal(count(h, "msg_endpoints") + count(h, "msg_threads") + count(h, "msg_messages"), 0, "dữ liệu mẫu không tạo sẵn thiết bị, hội thoại hay tin");
    // Seed chạy ở mỗi lần khởi động và tự kiểm đã có: không nhân đôi, và không cấp lại quyền đã bị thu hồi.
    await h.restart();
    assert.equal(count(h, "grants", "scope = 'messaging.use'"), 3);
    assert.equal((await h.call("POST", `/v1/grants/${grantOf(h, "dev_b")!.id}/revoke`, { sub: "dev_ops" })).status, 200);
    await h.restart();
    assert.equal(count(h, "grants", "scope = 'messaging.use'"), 3);
    assert.equal(grantOf(h, "dev_b")!.status, "REVOKED");
    for (const code of ["KEYS_CHANGED", "DUPLICATE_MESSAGE", "RECIPIENT_UNAVAILABLE", "ENDPOINT_LIMIT"]) {
      assert.match(MESSAGES[code] ?? "", /[à-ỹ]/i, `${code} có câu tiếng Việt`);
      assert.equal(messaging.errors?.[code], MESSAGES[code]);
    }
  } finally {
    await h.close();
  }
});

test("cổng trên MỌI route: thành viên (404) → cờ messaging (503) → quyền (403) → đồng ý (403); workspace khác và người ngoài hội thoại 404; trường lạ 400; POST thiếu khóa 400", async () => {
  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread } = await pair(h);
    const sent = await sendText(h, a1, thread, "tin để có mã tin thật");
    assert.equal(sent.res.status, 201);
    const body = await seal(h, a1, thread, "thân hợp lệ cho ma trận");
    const fresh = await generateEndpointKey();
    type Case = { method: "GET" | "POST"; path: string; body?: Record<string, unknown>; partyOnly?: boolean };
    const cases: Record<string, Case> = {
      "GET /v1/messages/people": { method: "GET", path: "/v1/messages/people" },
      "GET /v1/messages/endpoints": { method: "GET", path: "/v1/messages/endpoints" },
      "POST /v1/messages/endpoints": { method: "POST", path: "/v1/messages/endpoints", body: { public_key: fresh.public_key, kind: "PHONE" } },
      "POST /v1/messages/endpoints/{endpoint_id}/revoke": { method: "POST", path: `/v1/messages/endpoints/${a1.endpoint_id}/revoke`, body: {}, partyOnly: true },
      "POST /v1/messages/threads": { method: "POST", path: "/v1/messages/threads", body: { peer: "dev_b" } },
      "POST /v1/messages/threads/{thread_id}/accept": { method: "POST", path: `/v1/messages/threads/${thread}/accept`, body: {}, partyOnly: true },
      "POST /v1/messages/threads/{thread_id}/decline": { method: "POST", path: `/v1/messages/threads/${thread}/decline`, body: {}, partyOnly: true },
      "POST /v1/messages/threads/{thread_id}/withdraw": { method: "POST", path: `/v1/messages/threads/${thread}/withdraw`, body: {}, partyOnly: true },
      "POST /v1/messages/threads/{thread_id}/block": { method: "POST", path: `/v1/messages/threads/${thread}/block`, body: {}, partyOnly: true },
      "POST /v1/messages/threads/{thread_id}/unblock": { method: "POST", path: `/v1/messages/threads/${thread}/unblock`, body: {}, partyOnly: true },
      "GET /v1/messages/threads/{thread_id}/keys": { method: "GET", path: `/v1/messages/threads/${thread}/keys`, partyOnly: true },
      "POST /v1/messages/threads/{thread_id}/messages": { method: "POST", path: `/v1/messages/threads/${thread}/messages`, body: { ...body }, partyOnly: true },
      "POST /v1/messages/threads/{thread_id}/read": { method: "POST", path: `/v1/messages/threads/${thread}/read`, body: { through_seq: 1, share: false }, partyOnly: true },
      "GET /v1/messages/inbox": { method: "GET", path: `/v1/messages/inbox?endpoint=${a1.endpoint_id}`, partyOnly: true },
      "POST /v1/messages/ack": { method: "POST", path: "/v1/messages/ack", body: { endpoint_id: a1.endpoint_id, message_ids: [sent.res.body.message_id] }, partyOnly: true },
      "POST /v1/messages/reports": { method: "POST", path: "/v1/messages/reports", body: { thread_id: thread, reason: "SPAM" }, partyOnly: true },
    };
    const OPS = "GET /v1/ops/messages/reports";
    assert.deepEqual([...Object.keys(cases), OPS].sort(), (messaging.routes ?? []).map((r) => `${r.method} ${r.path}`).sort(), "ma trận phải phủ mọi route của mô-đun");
    const call = (c: Case, o: { sub?: string; ws?: string; key?: string | null; body?: unknown } = {}) =>
      h.call(c.method, c.path, { sub: o.sub ?? "dev_a", ws: o.ws, key: o.key, body: c.method === "POST" ? (o.body ?? c.body) : undefined });
    const expectAll = async (o: Parameters<typeof call>[1], status: number, code: string, why: string) => {
      for (const [name, c] of Object.entries(cases)) {
        const r = await call(c, o);
        assert.equal(r.status, status, `${why}: ${name} → ${JSON.stringify(r.body)}`);
        assert.equal(r.body.code, code, `${why}: ${name}`);
        valid("Error", r.body);
      }
    };
    const before = { endpoints: count(h, "msg_endpoints"), threads: count(h, "msg_threads"), messages: count(h, "msg_messages"), envelopes: count(h, "msg_envelopes"), reports: count(h, "msg_reports") };

    await expectAll({ sub: "stranger" }, 404, "NOT_FOUND", "người ngoài workspace");
    await expectAll({ ws: "ws_other" }, 404, "NOT_FOUND", "workspace khác");
    // dev_ops có quyền nhưng chưa đồng ý: bị chặn ở cổng trước khi máy chủ nhìn tới hội thoại hay thiết bị của người khác.
    await expectAll({ sub: "dev_ops" }, 403, "CONSENT_REQUIRED", "chưa đồng ý");
    setGrant(h, "dev_ops", "REVOKED");
    await expectAll({ sub: "dev_ops" }, 403, "FORBIDDEN", "không quyền, chưa đồng ý: quyền được xét trước đồng ý");
    setGrant(h, "dev_a", "REVOKED");
    await expectAll({}, 403, "FORBIDDEN", "có đồng ý nhưng mất quyền");
    await flag(h, false);
    await expectAll({}, 503, "MODULE_DISABLED", "cờ tắt được xét trước quyền");
    setGrant(h, "dev_a", "ACTIVE");
    await expectAll({}, 503, "MODULE_DISABLED", "cờ tắt");
    await expectAll({ sub: "stranger" }, 404, "NOT_FOUND", "người ngoài không biết mô-đun bật hay tắt");
    await flag(h, true);
    setGrant(h, "dev_ops", "ACTIVE");

    for (const [name, c] of Object.entries(cases).filter(([, x]) => x.method === "POST")) {
      const noKey = await call(c, { key: null });
      assert.equal(noKey.body.code, "IDEMPOTENCY_KEY_REQUIRED", name);
      const extra = await call(c, { body: { ...c.body, reason_from_health: "ngủ kém" } });
      assert.equal(extra.status, 400, `${name}: schema đóng`);
      assert.equal(extra.body.code, "SCHEMA_INVALID", name);
    }
    for (const bad of [{ ...body, text: "chữ đọc được" }, { ...body, envelopes: [{ ...body.envelopes[0], device_name: "máy của A" }] }, { text: "chỉ có chữ" }]) {
      assert.equal((await post(h, a1, thread, bad)).status, 400, "không trường nào mang chữ đọc được lọt qua schema MsgSend");
    }
    assert.equal((await h.call("POST", "/v1/messages/endpoints", { body: { public_key: fresh.public_key, kind: "PHONE", name: "Máy của A", user_agent: "Mozilla/5.0" } })).status, 400, "không nhận tên máy hay user agent");
    assert.equal((await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b", text: "chào" } })).status, 400, "lời mời không kèm chữ");
    assert.equal((await h.call("POST", "/v1/messages/reports", { body: { thread_id: thread, reason: "SPAM", note: "nội dung tin" } })).status, 400, "báo cáo không kèm nội dung");

    // Người đã qua cổng nhưng không phải một bên: hội thoại, thiết bị và hộp thư của người khác đều là 404.
    await consent(h, "dev_ops");
    const ops1 = await device(h, "dev_ops");
    for (const [name, c] of Object.entries(cases).filter(([, x]) => x.partyOnly)) {
      const r = await call(c, { sub: "dev_ops" });
      assert.equal(r.status, 404, `${name} với người ngoài hội thoại → ${JSON.stringify(r.body)}`);
    }
    assert.equal((await h.call("POST", "/v1/messages/ack", { sub: "dev_ops", body: { endpoint_id: ops1.endpoint_id, message_ids: [sent.res.body.message_id] } })).body.acked, 0, "mã tin của người khác bị bỏ qua");
    assert.equal((await h.call("POST", "/v1/messages/reports", { sub: "dev_ops", body: { thread_id: thread, reason: "OTHER" } })).status, 404);
    assert.equal((await h.call("GET", `/v1/messages/inbox?endpoint=${b1.endpoint_id}`, { sub: "dev_a" })).status, 404, "hộp thư của thiết bị người khác");
    assert.equal((await h.call("GET", "/v1/messages/inbox", { sub: "dev_a" })).status, 400);
    assert.equal((await h.call("GET", `/v1/messages/inbox?endpoint=${a1.endpoint_id}&etag=x`, { sub: "dev_a" })).status, 400);
    assert.deepEqual({ endpoints: count(h, "msg_endpoints") - 1, threads: count(h, "msg_threads"), messages: count(h, "msg_messages"), envelopes: count(h, "msg_envelopes"), reports: count(h, "msg_reports") }, before, "mọi lời từ chối ở trên không ghi gì");

    // Route vận hành có cổng riêng: thành viên → vai WORKSPACE_ADMIN; xem được cả khi cờ mô-đun tắt.
    assert.equal((await h.call("GET", "/v1/ops/messages/reports", { sub: "stranger" })).status, 404);
    assert.equal((await h.call("GET", "/v1/ops/messages/reports", { sub: "dev_a" })).status, 403);
    await flag(h, false);
    assert.equal((await h.call("GET", "/v1/ops/messages/reports", { sub: "dev_ops" })).status, 200);
  } finally {
    await h.close();
  }
});

test("«Thiết bị của tôi»: đăng ký cần đăng nhập mới trong 300 giây, khóa P-256 hợp lệ, tối đa 5; không lưu tên máy hay user agent; gỡ một máy và không đăng ký lại được khóa đã gỡ", async () => {
  const h = await harness();
  try {
    await consent(h, "dev_a");
    await consent(h, "dev_b");
    const k1 = await generateEndpointKey();
    const body = { public_key: k1.public_key, kind: "PHONE" };
    const authAt = (secondsAgo: number) => ({ Authorization: `Bearer ${h.token("dev_a", { authTime: Math.floor(h.clock.now() / 1000) - secondsAgo })}` });
    const stale = await h.call("POST", "/v1/messages/endpoints", { headers: authAt(301), body });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.code, "REAUTH_REQUIRED");
    assert.equal(count(h, "msg_endpoints"), 0);
    const k = key();
    const made = await h.call("POST", "/v1/messages/endpoints", { headers: authAt(300), body, key: k });
    assert.equal(made.status, 201);
    valid("MsgEndpoint", made.body);
    assert.deepEqual({ kind: made.body.kind, status: made.body.status, revoked_at: made.body.revoked_at }, { kind: "PHONE", status: "ACTIVE", revoked_at: null });
    assert.match(made.body.endpoint_id, /^mep_/);
    // Phát lại cùng khóa idempotency: bản cũ, kể cả với token đã cũ (không có tác động mới).
    h.clock.advance(400_000);
    const replay = await h.call("POST", "/v1/messages/endpoints", { headers: authAt(700), body, key: k });
    assert.deepEqual(replay.body, made.body);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    // Cùng trình duyệt đăng ký lại đúng khóa đang dùng (khóa idempotency mới): trả điểm đã có, không tốn thêm chỗ.
    const same = await h.call("POST", "/v1/messages/endpoints", { body: { ...body, kind: "TABLET" } });
    assert.equal(same.status, 200);
    assert.equal(same.body.endpoint_id, made.body.endpoint_id);
    assert.equal(same.body.kind, "PHONE");
    assert.equal(count(h, "msg_endpoints"), 1);
    // Khóa của người khác không đăng ký được dưới tên mình.
    assert.equal((await h.call("POST", "/v1/messages/endpoints", { sub: "dev_b", body })).status, 409);

    // Khóa sai dạng: sai độ dài, dạng nén, điểm ngoài đường cong, base64 thường.
    const raw = publicKeyBytes(k1.public_key);
    const off = new Uint8Array(raw);
    off[64] ^= 1;
    const compressed = new Uint8Array(65);
    compressed[0] = 2;
    for (const bad of [toBase64url(off), toBase64url(compressed), k1.public_key.slice(0, -1), k1.public_key.replace(/[-_]/g, "+") + "=", "A".repeat(87)]) {
      const r = await h.call("POST", "/v1/messages/endpoints", { body: { public_key: bad, kind: "PHONE" } });
      assert.equal(r.status, 400, bad.slice(0, 12));
    }
    assert.equal((await h.call("POST", "/v1/messages/endpoints", { body: { public_key: (await generateEndpointKey()).public_key, kind: "WATCH" } })).status, 400, "loại máy ngoài năm giá trị");

    // Sổ chỉ có đúng các cột này: không tên máy, không user agent, không địa chỉ.
    assert.deepEqual((h.app.ctx.db.prepare("PRAGMA table_info(msg_endpoints)").all() as { name: string }[]).map((c) => c.name), ["id", "workspace_id", "user_id", "kind", "public_key", "key_id", "status", "created_at", "revoked_at"]);

    const devices: Device[] = [];
    for (const kind of ["TABLET", "LAPTOP", "DESKTOP", "OTHER"]) devices.push(await device(h, "dev_a", kind));
    const list = await h.call("GET", "/v1/messages/endpoints");
    valid("MsgEndpointList", list.body);
    assert.equal(list.body.limit, 5);
    assert.deepEqual(list.body.endpoints.map((e: { kind: string }) => e.kind).sort(), ["DESKTOP", "LAPTOP", "OTHER", "PHONE", "TABLET"]);
    assert.equal(list.body.endpoints[0].endpoint_id, made.body.endpoint_id, "cũ trước");
    assert.equal((await h.call("GET", "/v1/messages/endpoints", { sub: "dev_b" })).body.endpoints.length, 0, "chỉ thấy thiết bị của chính mình");
    const sixth = await h.call("POST", "/v1/messages/endpoints", { body: { public_key: (await generateEndpointKey()).public_key, kind: "PHONE" } });
    assert.equal(sixth.status, 422);
    assert.equal(sixth.body.code, "ENDPOINT_LIMIT");
    assert.equal(sixth.body.message, MESSAGES.ENDPOINT_LIMIT);

    // Gỡ: chỉ của mình; gỡ lần hai trả lại đúng trạng thái; chỗ trống dùng lại được; khóa đã gỡ không quay lại.
    assert.equal((await h.call("POST", `/v1/messages/endpoints/${devices[0].endpoint_id}/revoke`, { sub: "dev_b" })).status, 404);
    const gone = await h.call("POST", `/v1/messages/endpoints/${devices[0].endpoint_id}/revoke`, {});
    assert.equal(gone.status, 200);
    valid("MsgEndpoint", gone.body);
    assert.equal(gone.body.status, "REVOKED");
    assert.ok(gone.body.revoked_at);
    assert.deepEqual((await h.call("POST", `/v1/messages/endpoints/${devices[0].endpoint_id}/revoke`, {})).body, gone.body);
    assert.equal((await h.call("POST", "/v1/messages/endpoints", { body: { public_key: devices[0].public_key, kind: "TABLET" } })).status, 409, "khóa đã gỡ");
    assert.equal((await h.call("GET", `/v1/messages/inbox?endpoint=${devices[0].endpoint_id}`)).status, 404, "thiết bị đã gỡ không còn hộp thư");
    await device(h, "dev_a", "PHONE");
    assert.equal((await h.call("GET", "/v1/messages/endpoints")).body.endpoints.filter((e: { status: string }) => e.status === "ACTIVE").length, 5);

    assert.deepEqual(h.app.ctx.revocations.readAll().entries.map((e) => e.type), ["endpoint_revoked"], "gỡ thiết bị vào sổ thu hồi độc lập, đúng một dòng");
    const audits = all<{ action: string; data: string }>(h.app.ctx.db, "SELECT action, data FROM audit WHERE action LIKE 'messaging.%' ORDER BY seq");
    assert.deepEqual([...new Set(audits.map((x) => x.action))].sort(), ["messaging.endpoint.register", "messaging.endpoint.revoke"]);
    assert.ok(audits.every((x) => !x.data.includes(k1.public_key)), "audit không chứa khóa");
  } finally {
    await h.close();
  }
});

test("máy THREAD_: 10 cạnh của bảng hợp đồng; mọi tổ hợp (trạng thái, sự kiện, người gọi) qua API đi đúng bảng, ngoài bảng thì 409 và không đổi gì; cạnh revoke chỉ Authority đi được", async () => {
  const EDGES = transitionsFor("THREAD_");
  const find = indexTransitions(EDGES);
  const STATES = ["THREAD_REQUESTED", "THREAD_ACTIVE", "THREAD_CLOSED", "THREAD_BLOCKED"];
  const EVENTS = [...new Set(EDGES.map((e) => e.event))].sort();
  assert.equal(EDGES.length, 10, "LNH-T33: đúng 10 cạnh");
  assert.ok(EDGES.every((e) => e.ref === "LNH-T33" && STATES.includes(e.from) && STATES.includes(e.to)));
  assert.deepEqual(EVENTS, ["accept", "block", "decline", "request", "revoke", "unblock", "withdraw"]);
  assert.deepEqual([...new Set(EDGES.map((e) => e.actor))].sort(), ["ADDRESSEE", "AUTHORITY", "BLOCKER", "MEMBER", "REQUESTER"]);

  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread } = await pair(h);
    const devices: Record<string, Device> = { dev_a: a1, dev_b: b1 };
    type Config = { state: string; requested_by: string; blocked_by: string | null; reopen_by: string | null };
    const configs: Config[] = [
      { state: "THREAD_REQUESTED", requested_by: "dev_a", blocked_by: null, reopen_by: null },
      { state: "THREAD_REQUESTED", requested_by: "dev_b", blocked_by: null, reopen_by: null },
      { state: "THREAD_ACTIVE", requested_by: "dev_a", blocked_by: null, reopen_by: null },
      { state: "THREAD_CLOSED", requested_by: "dev_a", blocked_by: null, reopen_by: null },
      { state: "THREAD_CLOSED", requested_by: "dev_a", blocked_by: null, reopen_by: "dev_a" },
      { state: "THREAD_CLOSED", requested_by: "dev_a", blocked_by: null, reopen_by: "dev_b" },
      { state: "THREAD_BLOCKED", requested_by: "dev_a", blocked_by: "dev_a", reopen_by: null },
      { state: "THREAD_BLOCKED", requested_by: "dev_a", blocked_by: "dev_b", reopen_by: null },
    ];
    const put = (c: Config) => run(h.app.ctx.db, "UPDATE msg_threads SET state = ?, requested_by = ?, blocked_by = ?, reopen_by = ? WHERE id = ?", c.state, c.requested_by, c.blocked_by, c.reopen_by, thread);
    const rolesOf = (c: Config, user: string) => [c.requested_by === user ? "REQUESTER" : "ADDRESSEE", "MEMBER", ...(c.blocked_by === user ? ["BLOCKER"] : [])];
    const visible = (c: Config, user: string) => (c.state === "THREAD_BLOCKED" && c.blocked_by !== user ? "THREAD_CLOSED" : c.state);
    const walked = new Set<string>();
    let accepted = 0;
    let refused = 0;

    for (const c of configs) {
      for (const user of ["dev_a", "dev_b"]) {
        const peer = user === "dev_a" ? "dev_b" : "dev_a";
        for (const ev of EVENTS) {
          put(c);
          const before = threadRow(h, thread)!;
          const where = `${c.state} (mời: ${c.requested_by}, chặn: ${c.blocked_by}, mời lại: ${c.reopen_by}) · ${ev} · ${user}`;
          const edge = rolesOf(c, user).map((r) => find(c.state, ev, r)).find((e) => e !== undefined);
          const unchanged = () => assert.deepEqual(threadRow(h, thread), before, `${where}: bị từ chối thì không đổi gì`);
          if (ev === "revoke") {
            // Sự kiện của AUTHORITY: người dùng không có route nào phát ra nó.
            assert.equal(edge, undefined, where);
            assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/revoke`, { sub: user })).status, 404, where);
            unchanged();
            refused++;
            continue;
          }
          if (ev === "request") {
            const r = await h.call("POST", "/v1/messages/threads", { sub: user, body: { peer } });
            if (c.state === "THREAD_BLOCKED") {
              assert.equal(r.status, 404, `${where}: người kia nằm ngoài danh sách của người gọi`);
              unchanged();
              refused++;
            } else if (edge && (c.reopen_by === null || c.reopen_by === user)) {
              assert.equal(r.status, 201, where);
              valid("MsgThread", r.body);
              const now = threadRow(h, thread)!;
              assert.deepEqual([now.state, now.requested_by, now.reopen_by, now.revision], [edge.to, user, null, before.revision + 1], where);
              assert.equal(r.body.role, "REQUESTER");
              walked.add(`${edge.from}|${edge.event}|${edge.actor}`);
              accepted++;
            } else {
              assert.equal(r.status, 409, where);
              assert.equal(r.body.code, "INVALID_TRANSITION");
              assert.equal(r.body.resource_id, thread, "kèm mã hội thoại đã có");
              unchanged();
              refused++;
            }
            continue;
          }
          const r = await h.call("POST", `/v1/messages/threads/${thread}/${ev}`, { sub: user });
          if (!edge) {
            assert.equal(r.status, 409, where);
            assert.equal(r.body.code, "INVALID_TRANSITION", where);
            assert.equal(r.body.state, visible(c, user), `${where}: lỗi chỉ nói trạng thái người gọi được thấy`);
            unchanged();
            refused++;
            continue;
          }
          assert.equal(r.status, 200, `${where} → ${JSON.stringify(r.body)}`);
          valid("MsgThread", r.body);
          const now = threadRow(h, thread)!;
          assert.equal(now.state, edge.to, where);
          assert.equal(now.revision, before.revision + 1, `${where}: tăng revision đúng một lần`);
          assert.equal(r.body.state, edge.to, "người vừa thao tác thấy trạng thái thật");
          if (ev === "decline") assert.equal(now.reopen_by, user);
          if (ev === "withdraw") assert.equal(now.reopen_by, null);
          if (ev === "block") assert.deepEqual([now.blocked_by, now.reopen_by], [user, null]);
          if (ev === "unblock") assert.deepEqual([now.blocked_by, now.reopen_by], [null, user]);
          if (ev === "block" || ev === "unblock") assert.ok(now.journal_seq > before.journal_seq, "chặn và bỏ chặn ghi sổ thu hồi");
          // Người kia không bao giờ thấy THREAD_BLOCKED do người này đặt.
          assert.equal((await viewOf(h, devices[peer], thread)).state, edge.to === "THREAD_BLOCKED" ? "THREAD_CLOSED" : edge.to, where);
          walked.add(`${edge.from}|${edge.event}|${edge.actor}`);
          accepted++;
        }
      }
    }
    assert.equal(accepted + refused, configs.length * 2 * EVENTS.length);

    // AUTHORITY: một bên mất quyền thì vòng tick đóng hội thoại đang mời hoặc đang mở; hội thoại đã đóng hoặc đang chặn giữ nguyên.
    for (const c of configs) {
      for (const loser of ["dev_a", "dev_b"]) {
        put(c);
        const before = threadRow(h, thread)!;
        setGrant(h, loser, "REVOKED");
        await h.app.tick();
        const edge = find(c.state, "revoke", "AUTHORITY");
        const now = threadRow(h, thread)!;
        assert.equal(now.state, edge ? edge.to : c.state, `${c.state} · revoke · AUTHORITY (${loser})`);
        assert.equal(now.revision, before.revision + (edge ? 1 : 0));
        if (edge) {
          assert.equal(now.reopen_by, null);
          walked.add(`${edge.from}|${edge.event}|${edge.actor}`);
        }
        assert.equal(count(h, "msg_endpoints", "user_id = ? AND status = 'ACTIVE'", loser), 0, "thiết bị của người mất quyền bị gỡ");
        setGrant(h, loser, "ACTIVE");
        run(h.app.ctx.db, "UPDATE msg_endpoints SET status = 'ACTIVE', revoked_at = NULL");
      }
    }
    assert.deepEqual([...walked].sort(), EDGES.map((e) => `${e.from}|${e.event}|${e.actor}`).sort(), "mọi cạnh của bảng đều đã được đi qua API, và không cạnh nào khác");
    // Sổ thu hồi chỉ có dòng chặn và bỏ chặn của người dùng; việc Authority đóng hội thoại không ghi thêm dòng nào.
    assert.deepEqual([...new Set(h.app.ctx.revocations.readAll().entries.map((e) => e.type))].sort(), ["thread_blocked", "thread_unblocked"]);
  } finally {
    await h.close();
  }
});

test("hai người, mỗi người hai thiết bị: gửi, bốn hộp thư, mở bằng khóa của từng thiết bị, xác nhận đã lưu, mốc đã tới và đã xem theo bằng chứng", async () => {
  const h = await harness();
  try {
    const { a: [a1, a2], b: [b1, b2], thread } = await pair(h, 2);
    const all4 = [a1, a2, b1, b2];
    const TEXT = "Hẹn 15:00 ở cổng B nhé 👋";
    const ks = await keysOf(h, a1, thread);
    valid("MsgThreadKeys", ks);
    assert.deepEqual(ks.endpoints.map((e) => e.endpoint_id), all4.map((d) => d.endpoint_id).sort());
    assert.deepEqual(Object.keys(ks.endpoints[0]).sort(), ["endpoint_id", "public_key", "user_id"], "không lộ loại máy hay ngày tạo của thiết bị người kia");

    // Hội thoại đang mở mang sẵn mã băm tập khóa hiện hành: thiết bị thấy nó đổi trong lần thăm dò thường thì lấy lại khóa.
    assert.equal((await viewOf(h, a1, thread)).key_set, ks.key_set);
    assert.equal((await viewOf(h, b2, thread)).key_set, ks.key_set);

    const s1 = await sendText(h, a1, thread, TEXT);
    assert.equal(s1.res.status, 201);
    valid("MsgSent", s1.res.body);
    assert.deepEqual(Object.keys(s1.res.body).sort(), ["message_id", "sent_at", "seq"], "phản hồi chỉ có mã, số thứ tự và thời điểm");
    assert.equal(s1.res.body.seq, 1);
    const id1 = s1.res.body.message_id as string;
    assert.equal(count(h, "msg_envelopes", "message_id = ?", id1), 4);

    const wraps = new Set<string>();
    for (const d of all4) {
      const box = await inbox(h, d);
      assert.equal(box.status, 200);
      valid("MsgInbox", box.body);
      assert.equal(box.body.changed, true);
      assert.equal(box.body.more, false);
      assert.equal(box.body.messages.length, 1);
      const m = box.body.messages[0];
      assert.deepEqual([m.message_id, m.thread_id, m.seq, m.sender_user, m.sender_endpoint, m.client_ref], [id1, thread, 1, "dev_a", a1.endpoint_id, s1.body.client_ref]);
      assert.equal(await open(d, m, a1), TEXT, `thiết bị ${d.endpoint_id} mở được bằng khóa của nó`);
      wraps.add(m.wrapped);
      // Phong bì của thiết bị này không mở được bằng khóa của thiết bị khác.
      const other = all4.find((x) => x !== d) as Device;
      await assert.rejects(open(other, m, a1));
      assert.deepEqual(box.body.endpoints.map((e: { endpoint_id: string }) => e.endpoint_id).sort(), all4.filter((x) => x.sub === d.sub).map((x) => x.endpoint_id).sort(), "hộp thư kèm danh sách thiết bị của chính mình");
    }
    assert.equal(wraps.size, 4, "mỗi thiết bị một phong bì riêng");

    // Thăm dò: đọc hộp thư không đổi gì; etag không đổi thì chỉ nhận lại etag.
    const first = await inbox(h, b1);
    const again = await inbox(h, b1, first.body.etag);
    assert.deepEqual(again.body, { etag: first.body.etag, changed: false });
    valid("MsgInbox", again.body);
    assert.equal((await pending(h, b1)).length, 1, "đọc không phải là xác nhận");
    assert.equal((await viewOf(h, a1, thread)).peer_delivered_seq, 0, "chưa thiết bị nào của B xác nhận: chưa có «đã tới thiết bị»");

    // B1 xác nhận đã lưu: phong bì của B1 rời máy chủ, của B2 còn; A thấy bằng chứng đã tới thiết bị.
    const aEtag = (await inbox(h, a1)).body.etag;
    const acked = await ack(h, b1, [id1]);
    assert.equal(acked.status, 200);
    valid("MsgAcked", acked.body);
    assert.equal(acked.body.acked, 1);
    assert.equal((await pending(h, b1)).length, 0);
    assert.equal((await pending(h, b2)).length, 1);
    assert.equal((await ack(h, b1, [id1])).body.acked, 0, "xác nhận lần hai không còn gì để xóa");
    assert.equal((await h.call("POST", "/v1/messages/ack", { sub: "dev_a", body: { endpoint_id: b2.endpoint_id, message_ids: [id1] } })).status, 404, "không xác nhận hộ thiết bị của người khác");
    const aView = await inbox(h, a1, aEtag);
    assert.equal(aView.body.changed, true, "mốc mới làm etag của người gửi đổi");
    assert.equal((await viewOf(h, a1, thread)).peer_delivered_seq, 1);
    assert.equal((await viewOf(h, b2, thread)).delivered_seq, 1);
    // Thiết bị gửi xác nhận bản của chính nó không tạo ra «đã tới thiết bị».
    await ack(h, a1, [id1]);
    await ack(h, a2, [id1]);
    assert.ok(one<{ ct: string | null }>(h.app.ctx.db, "SELECT ct FROM msg_messages WHERE id = ?", id1)?.ct, "còn phong bì của B2 nên bản mã còn");
    await ack(h, b2, [id1]);
    const row = one<{ ct: string | null; iv: string | null; delivered_at: string | null }>(h.app.ctx.db, "SELECT ct, iv, delivered_at FROM msg_messages WHERE id = ?", id1)!;
    assert.deepEqual([row.ct, row.iv], [null, null], "không còn phong bì nào: máy chủ bỏ luôn bản mã (hộp thư, không phải kho)");
    assert.ok(row.delivered_at);
    assert.equal(count(h, "msg_envelopes"), 0);

    // «Đã xem» chỉ khi người đọc bật chia sẻ.
    const r0 = await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_b", body: { through_seq: 1, share: false } });
    assert.equal(r0.status, 200);
    valid("MsgThread", r0.body);
    assert.equal(r0.body.read_seq, 1);
    assert.equal((await viewOf(h, a1, thread)).peer_read_seq, 0, "không chia sẻ thì người gửi không thấy");
    await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_b", body: { through_seq: 1, share: true } });
    assert.equal((await viewOf(h, a1, thread)).peer_read_seq, 1);
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_b", body: { through_seq: 2, share: true } })).status, 400, "không đọc được tin chưa có");

    // B trả lời từ B2; rồi hai tin nữa của B: mốc đã tới của A chỉ tăng liên tục, không nhảy qua tin chưa thiết bị nào của A lưu.
    const s2 = await sendText(h, b2, thread, "Ok, 15:00.");
    const s3 = await sendText(h, b1, thread, "Mình mang ô.");
    const s4 = await sendText(h, b2, thread, "Tới nơi nhắn nhé.");
    assert.deepEqual([s2.res.body.seq, s3.res.body.seq, s4.res.body.seq], [2, 3, 4]);
    const inA2 = await pending(h, a2);
    assert.deepEqual(inA2.map((m) => m.seq), [2, 3, 4], "cũ trước");
    assert.equal(await open(a2, inA2[0], b2), "Ok, 15:00.");
    assert.equal(await open(a2, inA2[1], b1), "Mình mang ô.");
    await ack(h, a2, [s2.res.body.message_id, s4.res.body.message_id]);
    assert.equal((await viewOf(h, b1, thread)).peer_delivered_seq, 2, "tin 3 chưa tới thiết bị nào của A nên mốc dừng ở 2 dù tin 4 đã tới");
    // A đánh dấu đã đọc tới 4 và bật chia sẻ: B chỉ thấy «đã xem» tới mốc đã tới thiết bị.
    const shared = await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_a", body: { through_seq: 4, share: true } });
    assert.equal(shared.body.read_seq, 4);
    assert.equal((await viewOf(h, b1, thread)).peer_read_seq, 2);
    await ack(h, a1, [s3.res.body.message_id]);
    assert.equal((await viewOf(h, b1, thread)).peer_delivered_seq, 4);
    // Mốc chỉ tăng.
    await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_a", body: { through_seq: 1, share: true } });
    const final = await viewOf(h, a1, thread);
    assert.deepEqual([final.read_seq, final.delivered_seq, final.last_seq], [4, 4, 4]);
    assert.equal((await viewOf(h, b1, thread)).peer_read_seq, 2, "mốc chia sẻ không tự nhảy lên khi không có yêu cầu mới vượt nó");
    await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_a", body: { through_seq: 4, share: true } });
    assert.equal((await viewOf(h, b1, thread)).peer_read_seq, 4);
    assert.equal(count(h, "audit", "action LIKE 'messaging.%' AND action NOT LIKE 'messaging.endpoint.%'"), 0, "không có audit cho từng tin, lời mời hay mốc");
  } finally {
    await h.close();
  }
});

test("phát lại và chống trùng: cùng khóa cùng byte trả bản cũ; cùng khóa khác byte 409; khóa mới cùng client_ref → DUPLICATE_MESSAGE; tập khóa đổi → KEYS_CHANGED, không lưu gì", async () => {
  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread } = await pair(h);
    const s1 = await sendText(h, a1, thread, "tin thứ nhất");
    assert.equal(s1.res.status, 201);
    const replay = await post(h, a1, thread, s1.body, s1.key);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, s1.res.body);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(count(h, "msg_messages"), 1, "phát lại không lưu lần hai");
    const other = await seal(h, a1, thread, "nội dung khác");
    assert.equal((await post(h, a1, thread, other, s1.key)).body.code, "IDEMPOTENCY_CONFLICT");
    // Khóa mới, vẫn tin cũ: lớp chống trùng thứ hai trả lời bằng bằng chứng, kèm mã tin đã lưu.
    const dup = await post(h, a1, thread, s1.body);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.code, "DUPLICATE_MESSAGE");
    assert.equal(dup.body.resource_id, s1.res.body.message_id);
    assert.equal(dup.body.message, MESSAGES.DUPLICATE_MESSAGE);
    valid("Error", dup.body);
    // client_ref chỉ duy nhất theo thiết bị gửi: thiết bị khác dùng trùng chuỗi vẫn là tin khác.
    const fromB = await post(h, b1, thread, await seal(h, b1, thread, "của B", s1.body.client_ref));
    assert.equal(fromB.status, 201);
    assert.equal(count(h, "msg_messages"), 2);

    // B thêm thiết bị: thân đã niêm phong cho tập khóa cũ bị từ chối dứt khoát, không lưu gì, không để lại dấu chống lặp.
    const ref = clientRef();
    const stale = await seal(h, a1, thread, "niêm phong trước khi B thêm máy", ref);
    const b2 = await device(h, "dev_b", "PHONE");
    const k = key();
    const changed = await post(h, a1, thread, stale, k);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "KEYS_CHANGED");
    assert.equal(changed.body.message, MESSAGES.KEYS_CHANGED);
    assert.equal(count(h, "msg_messages"), 2);
    assert.equal(count(h, "idem_keys", "idem_key = ?", k), 0);
    // Niêm phong lại cho tập khóa mới, khóa idempotency mới, vẫn client_ref cũ: được lưu đúng một lần, B2 nhận được.
    const resealed = await seal(h, a1, thread, "niêm phong trước khi B thêm máy", ref);
    assert.equal(resealed.envelopes.length, 3);
    const ok = await post(h, a1, thread, resealed);
    assert.equal(ok.status, 201);
    assert.equal(await open(b2, (await pending(h, b2))[0], a1), "niêm phong trước khi B thêm máy");
    assert.equal((await pending(h, b2)).length, 1, "thiết bị mới chỉ thấy tin gửi sau khi nó được thêm (LNH-T32)");
    assert.equal((await post(h, a1, thread, resealed)).body.code, "DUPLICATE_MESSAGE");

    // Thân sai dạng dù key_set đúng: thiếu phong bì, trùng phong bì, bản mã không phải bội số của 256 byte, enc không phải điểm không nén.
    const good = await seal(h, a1, thread, "thân chuẩn");
    const bytes = (n: number, first = 0) => {
      const u = new Uint8Array(n);
      u[0] = first;
      return toBase64url(u);
    };
    const before = count(h, "msg_messages");
    for (const [why, bad] of [
      ["thiếu một phong bì", { ...good, envelopes: good.envelopes.slice(1) }],
      ["hai phong bì cho một thiết bị", { ...good, envelopes: [good.envelopes[0], good.envelopes[0], good.envelopes[2]] }],
      ["phong bì cho thiết bị lạ", { ...good, envelopes: [{ ...good.envelopes[0], endpoint_id: `mep_${uuid()}` }, ...good.envelopes.slice(1)] }],
      ["bản mã không tròn khối", { ...good, ct: bytes(300) }],
      ["bản mã quá lớn", { ...good, ct: bytes(MESSAGING_LIMITS.maxPaddedBytes + 256 + 16) }],
      ["bản mã quá nhỏ", { ...good, ct: bytes(16) }],
      ["IV sai độ dài", { ...good, iv: bytes(16) }],
      ["enc dạng nén", { ...good, envelopes: [{ ...good.envelopes[0], enc: bytes(65, 2) }, ...good.envelopes.slice(1)] }],
      ["wrapped sai độ dài", { ...good, envelopes: [{ ...good.envelopes[0], wrapped: bytes(47) }, ...good.envelopes.slice(1)] }],
      ["client_ref quá ngắn", { ...good, client_ref: "ngan" }],
      ["base64 có padding", { ...good, ct: good.ct.slice(0, -1) + "=" }],
    ] as const) {
      const r = await post(h, a1, thread, bad);
      assert.equal(r.status, 400, `${why} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, "SCHEMA_INVALID", why);
    }
    assert.equal(count(h, "msg_messages"), before);
    assert.equal((await post(h, a1, thread, good)).status, 201, "cùng thân chuẩn thì qua");
    // Thiết bị gửi phải là của chính người gọi.
    assert.equal((await post(h, a1, thread, { ...(await seal(h, a1, thread, "mượn danh")), sender_endpoint: b1.endpoint_id })).status, 404);

    // Bằng chứng đi trước lời từ chối: sau khi B chặn, A hỏi lại về tin đã lưu vẫn được trả lời «đã lưu», bằng cả hai lớp.
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/block`, { sub: "dev_b" })).status, 200);
    assert.equal((await post(h, a1, thread, resealed)).body.code, "DUPLICATE_MESSAGE");
    assert.equal((await post(h, a1, thread, s1.body, s1.key)).status, 201, "phát lại cùng khóa: người gọi vẫn là một bên của hội thoại");
    const blocked = await post(h, a1, thread, good, key());
    assert.equal(blocked.body.code, "DUPLICATE_MESSAGE");
    const fresh = await post(h, a1, thread, { ...good, client_ref: clientRef() });
    assert.equal(fresh.status, 409);
    assert.equal(fresh.body.code, "RECIPIENT_UNAVAILABLE");
    assert.equal(fresh.body.message, MESSAGES.RECIPIENT_UNAVAILABLE);
  } finally {
    await h.close();
  }
});

test("lời mời, từ chối, chặn: không có gì tới người chưa chấp nhận; người bị chặn thấy «đã đóng» như khi người kia vắng mặt; danh bạ chỉ gồm người đã bật nhắn tin và có thiết bị", async () => {
  const h = await harness();
  try {
    await consent(h, "dev_a");
    await consent(h, "dev_b");
    const a1 = await device(h, "dev_a");
    const names = async (sub: string) => ((await h.call("GET", "/v1/messages/people", { sub })).body.people as { user_id: string }[]).map((p) => p.user_id);
    assert.deepEqual(await names("dev_a"), [], "B đã đồng ý nhưng chưa có thiết bị; dev_ops chưa đồng ý");
    const notYet = await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } });
    assert.equal(notYet.status, 404);
    const b1 = await device(h, "dev_b");
    const people = await h.call("GET", "/v1/messages/people");
    valid("MsgPeople", people.body);
    assert.deepEqual(people.body.people, [{ user_id: "dev_b", name: "Thử nghiệm B" }]);
    assert.deepEqual(await names("dev_b"), ["dev_a"]);
    for (const peer of ["dev_a", "dev_ops", "stranger", "dev_b@ws_other"]) {
      assert.equal((await h.call("POST", "/v1/messages/threads", { body: { peer } })).status, 404, `${peer}: ngoài danh sách thì câu trả lời như nhau`);
    }

    // Mời: không kèm chữ; chưa chấp nhận thì không gửi được gì.
    const req = await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } });
    assert.equal(req.status, 201);
    valid("MsgThread", req.body);
    const thread = req.body.thread_id as string;
    assert.deepEqual([req.body.state, req.body.role, req.body.peer.user_id, req.body.peer.name, req.body.can_request, req.body.key_set], ["THREAD_REQUESTED", "REQUESTER", "dev_b", "Thử nghiệm B", false, null]);
    assert.deepEqual([(await viewOf(h, b1, thread)).state, (await viewOf(h, b1, thread)).role], ["THREAD_REQUESTED", "ADDRESSEE"]);
    const again = await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } });
    assert.equal(again.status, 409);
    assert.equal(again.body.resource_id, thread);
    assert.equal((await h.call("POST", "/v1/messages/threads", { sub: "dev_b", body: { peer: "dev_a" } })).status, 409, "một cặp người chỉ có một hội thoại");
    assert.equal((await h.call("GET", `/v1/messages/threads/${thread}/keys`)).body.code, "RECIPIENT_UNAVAILABLE", "chưa chấp nhận thì chưa có khóa để niêm phong");
    assert.equal(count(h, "msg_messages"), 0);

    // Từ chối: chỉ người từ chối được mời lại.
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/decline`, { sub: "dev_b" })).body.state, "THREAD_CLOSED");
    assert.equal((await viewOf(h, a1, thread)).can_request, false);
    assert.equal((await viewOf(h, b1, thread)).can_request, true);
    assert.equal((await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } })).status, 409);
    const back = await h.call("POST", "/v1/messages/threads", { sub: "dev_b", body: { peer: "dev_a" } });
    assert.equal(back.status, 201);
    assert.equal(back.body.thread_id, thread);
    assert.equal(back.body.role, "REQUESTER");
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/accept`, { sub: "dev_b" })).status, 409, "người mời không tự chấp nhận");
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/accept`, {})).body.state, "THREAD_ACTIVE");

    // A gửi một tin; B chưa kịp nhận thì chặn: tin chờ giao tới B bị xóa, bản của A còn.
    const s = await sendText(h, a1, thread, "tin gửi ngay trước khi bị chặn");
    assert.equal(s.res.status, 201);
    const blocked = await h.call("POST", `/v1/messages/threads/${thread}/block`, { sub: "dev_b" });
    assert.equal(blocked.body.state, "THREAD_BLOCKED");
    assert.equal((await pending(h, b1)).length, 0, "người chặn không nhận tin còn chờ của người bị chặn");
    assert.equal((await pending(h, a1)).length, 1);
    // Phía bị chặn: «đã đóng», không mời lại được, người kia biến khỏi danh bạ, mọi đường gửi trả cùng một lỗi.
    const aSees = await viewOf(h, a1, thread);
    assert.deepEqual([aSees.state, aSees.can_request, aSees.key_set], ["THREAD_CLOSED", false, null]);
    assert.equal((await viewOf(h, b1, thread)).key_set, null, "đã chặn thì không còn tập khóa để gửi");
    assert.deepEqual(await names("dev_a"), []);
    assert.deepEqual(await names("dev_b"), []);
    assert.equal((await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } })).status, 404);
    assert.equal((await h.call("GET", `/v1/messages/threads/${thread}/keys`)).body.code, "RECIPIENT_UNAVAILABLE");
    for (const op of ["accept", "decline", "withdraw", "unblock"]) {
      const r = await h.call("POST", `/v1/messages/threads/${thread}/${op}`, {});
      assert.deepEqual([r.status, r.body.code, r.body.state], [409, "INVALID_TRANSITION", "THREAD_CLOSED"], op);
    }
    // Giới hạn đã nói rõ trong mô-đun: thử chặn lại thì bị từ chối, và từ đó suy ra được mình đang bị chặn.
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/block`, {})).status, 409);

    // So với «người kia vắng mặt thật»: cùng hình dạng (đã đóng, không mời lại được, không có trong danh bạ, cùng mã lỗi khi gửi).
    await consent(h, "dev_ops");
    const o1 = await device(h, "dev_ops");
    const t2 = await openThread(h, "dev_a", "dev_ops");
    await h.call("POST", "/v1/consents/messaging/withdraw", { sub: "dev_ops" });
    const gone = await viewOf(h, a1, t2);
    assert.deepEqual([gone.state, gone.can_request, gone.key_set], [aSees.state, aSees.can_request, aSees.key_set]);
    assert.deepEqual(Object.keys(gone).sort(), Object.keys(aSees).sort());
    assert.equal((await h.call("GET", `/v1/messages/threads/${t2}/keys`)).body.code, "RECIPIENT_UNAVAILABLE");
    assert.equal((await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_ops" } })).status, 404);
    assert.ok(o1.endpoint_id);

    // Bỏ chặn: đóng, và chỉ người đã chặn được mời lại.
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/unblock`, { sub: "dev_b" })).body.state, "THREAD_CLOSED");
    assert.equal((await viewOf(h, a1, thread)).can_request, false);
    assert.equal((await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } })).status, 409);
    assert.equal((await h.call("POST", "/v1/messages/threads", { sub: "dev_b", body: { peer: "dev_a" } })).status, 201);
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/withdraw`, { sub: "dev_b" })).body.state, "THREAD_CLOSED");
    assert.equal((await viewOf(h, a1, thread)).can_request, true, "rút lời mời: ai cũng mời lại được");

    // Người kia không còn thiết bị nào: cùng một câu trả lời.
    const t3row = await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } });
    await h.call("POST", `/v1/messages/threads/${thread}/accept`, { sub: "dev_b" });
    assert.equal(t3row.status, 201);
    const sealed = await seal(h, a1, thread, "trước khi B gỡ máy");
    await h.call("POST", `/v1/messages/endpoints/${b1.endpoint_id}/revoke`, { sub: "dev_b" });
    assert.equal((await post(h, a1, thread, sealed)).body.code, "RECIPIENT_UNAVAILABLE");
    assert.equal((await h.call("GET", `/v1/messages/threads/${thread}/keys`)).body.code, "RECIPIENT_UNAVAILABLE");
    assert.deepEqual([(await viewOf(h, a1, thread)).state, (await viewOf(h, a1, thread)).key_set], ["THREAD_ACTIVE", null], "hội thoại còn mở nhưng người kia không còn thiết bị: không có tập khóa");
    assert.deepEqual(await names("dev_a"), []);
  } finally {
    await h.close();
  }
});

test("giới hạn trên đồng hồ tay: 30 tin một phút, 500 tin một ngày (429 kèm Retry-After), 10 lời mời đang chờ, 20 báo cáo một ngày", async () => {
  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread } = await pair(h);
    for (let i = 0; i < MESSAGING_LIMITS.sendsPerMinute; i++) {
      assert.equal((await sendText(h, a1, thread, `tin ${i}`)).res.status, 201, String(i));
      h.clock.advance(1000);
    }
    const body = await seal(h, a1, thread, "tin thứ 31");
    const k = key();
    const over = await post(h, a1, thread, body, k);
    assert.equal(over.status, 429);
    assert.equal(over.body.code, "RATE_LIMITED");
    assert.equal(over.body.retryable, true);
    assert.equal(over.headers.get("retry-after"), "30", "tin cũ nhất trong cửa sổ ra khỏi cửa sổ sau 30 giây nữa");
    assert.equal(count(h, "msg_messages"), 30);
    h.clock.advance(29_000);
    assert.equal((await post(h, a1, thread, body, k)).status, 429);
    h.clock.advance(1_000);
    // Lời từ chối không để lại dấu chống lặp: đúng khóa cũ, đúng byte cũ được nhận khi hết hạn chờ.
    assert.equal((await post(h, a1, thread, body, k)).status, 201);

    // 500 tin một ngày: các hàng dưới đây là dữ liệu chèn thẳng vào sổ chỉ để chạm ngưỡng, không phải tin đã gửi thật.
    h.clock.advance(120_000);
    const now = h.clock.now();
    const have = count(h, "msg_messages");
    for (let i = have; i < MESSAGING_LIMITS.sendsPerDay; i++) {
      run(h.app.ctx.db, "INSERT INTO msg_messages (id, workspace_id, thread_id, seq, sender_user, sender_endpoint, client_ref, sent_at) VALUES (?, ?, ?, ?, 'dev_a', ?, ?, ?)",
        `msg_${uuid()}`, WS, thread, 1000 + i, a1.endpoint_id, `filler-${String(i).padStart(22, "0")}`, new Date(now - 3_600_000 - i * 1000).toISOString());
    }
    const day = await sendText(h, a1, thread, "tin thứ 501 trong ngày");
    assert.equal(day.res.status, 429);
    assert.ok(Number(day.res.headers.get("retry-after")) > 3600, "phải chờ tới khi tin cũ nhất ra khỏi cửa sổ 24 giờ");
    assert.equal(count(h, "msg_messages"), MESSAGING_LIMITS.sendsPerDay);
    assert.equal((await sendText(h, b1, thread, "giới hạn tính theo từng người: B vẫn gửi được")).res.status, 201);
    h.clock.advance(23 * 3_600_000);
    assert.equal((await sendText(h, a1, thread, "sang cửa sổ mới")).res.status, 201);

    // 10 lời mời đang chờ trả lời.
    const others: string[] = [];
    for (let i = 1; i <= MESSAGING_LIMITS.openRequests + 1; i++) {
      const sub = `syn_${String(i).padStart(2, "0")}`;
      await addMember(h, sub);
      others.push(sub);
    }
    const sent: string[] = [];
    for (const peer of others.slice(0, MESSAGING_LIMITS.openRequests)) {
      const r = await h.call("POST", "/v1/messages/threads", { body: { peer } });
      assert.equal(r.status, 201, peer);
      sent.push(r.body.thread_id);
    }
    const eleventh = await h.call("POST", "/v1/messages/threads", { body: { peer: others[MESSAGING_LIMITS.openRequests] } });
    assert.equal(eleventh.status, 429);
    assert.equal(eleventh.body.code, "RATE_LIMITED");
    assert.equal((await h.call("POST", `/v1/messages/threads/${sent[0]}/withdraw`, {})).status, 200);
    assert.equal((await h.call("POST", "/v1/messages/threads", { body: { peer: others[MESSAGING_LIMITS.openRequests] } })).status, 201, "rút một lời mời thì mời tiếp được");

    // 20 báo cáo một ngày.
    for (let i = 0; i < MESSAGING_LIMITS.reportsPerDay; i++) assert.equal((await h.call("POST", "/v1/messages/reports", { body: { thread_id: thread, reason: "SPAM" } })).status, 201);
    assert.equal((await h.call("POST", "/v1/messages/reports", { body: { thread_id: thread, reason: "SPAM" } })).status, 429);
    h.clock.advance(24 * 3_600_000 + 1000);
    assert.equal((await h.call("POST", "/v1/messages/reports", { body: { thread_id: thread, reason: "SPAM" } })).status, 201);
  } finally {
    await h.close();
  }
});

test("báo cáo không kèm nội dung; quản trị workspace xem danh sách và tạm ngừng một người bằng thu hồi quyền có sẵn", async () => {
  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread } = await pair(h);
    const s = await sendText(h, a1, thread, "tin bị báo cáo");
    const own = await sendText(h, b1, thread, "tin của chính người báo cáo");
    const r1 = await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "HARASSMENT", message_id: s.res.body.message_id } });
    assert.equal(r1.status, 201);
    valid("MsgReportCreated", r1.body);
    assert.deepEqual(Object.keys(r1.body), ["report_id"]);
    assert.equal((await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "HARASSMENT", message_id: own.res.body.message_id } })).status, 404, "chỉ báo cáo được tin của người kia");
    assert.equal((await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "HARASSMENT", message_id: `msg_${uuid()}` } })).status, 404);
    assert.equal((await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "RUDE" } })).status, 400);
    await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "OTHER" } });
    await h.call("POST", "/v1/messages/reports", { sub: "dev_a", body: { thread_id: thread, reason: "SPAM" } });
    assert.deepEqual((h.app.ctx.db.prepare("PRAGMA table_info(msg_reports)").all() as { name: string }[]).map((c) => c.name), ["id", "workspace_id", "reporter", "reported", "thread_id", "message_id", "reason", "at"], "sổ báo cáo không có cột nào cho chữ");
    assert.equal(threadRow(h, thread)!.state, "THREAD_ACTIVE", "báo cáo không tự đổi hội thoại");

    const list = await h.call("GET", "/v1/ops/messages/reports", { sub: "dev_ops" });
    assert.equal(list.status, 200);
    valid("MsgOpsReports", list.body);
    assert.equal(list.body.reports.length, 3);
    const byUser = Object.fromEntries(list.body.reported.map((x: { user_id: string; count: number; grant_id: string | null }) => [x.user_id, x]));
    assert.equal(byUser.dev_a.count, 2);
    assert.equal(byUser.dev_b.count, 1);
    assert.equal(byUser.dev_a.grant_id, grantOf(h, "dev_a")!.id);
    assert.ok(!JSON.stringify(list.body).includes("tin bị báo cáo"));

    // Tạm ngừng dev_a: thu hồi quyền bằng route có sẵn. Cổng chặn ngay; vòng tick kế tiếp đóng hội thoại và gỡ thiết bị.
    assert.equal((await h.call("POST", `/v1/grants/${byUser.dev_a.grant_id}/revoke`, { sub: "dev_ops" })).status, 200);
    assert.equal((await inbox(h, a1)).body.code, "FORBIDDEN");
    assert.equal((await h.call("GET", `/v1/messages/threads/${thread}/keys`, { sub: "dev_b" })).body.code, "RECIPIENT_UNAVAILABLE", "B không còn gửi được tới người vừa bị tạm ngừng");
    await h.app.tick();
    assert.equal(threadRow(h, thread)!.state, "THREAD_CLOSED");
    assert.equal(count(h, "msg_endpoints", "user_id = 'dev_a' AND status = 'ACTIVE'"), 0);
    assert.equal((await h.call("GET", "/v1/ops/messages/reports", { sub: "dev_ops" })).body.reported.find((x: { user_id: string }) => x.user_id === "dev_a").grant_id, null);
  } finally {
    await h.close();
  }
});
