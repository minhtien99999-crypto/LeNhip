// Máy khách nhắn tin trên thiết bị (web/shared/msg-client.js) chạy với MÁY CHỦ THẬT của harness: đúng mã mà màn hình Tin nhắn
// dùng, chỉ thay IndexedDB bằng kho trong bộ nhớ và thay fetch của trình duyệt bằng fetch tới cổng của harness. «Mất mạng» và
// «mất phản hồi» ở đây là do lớp fetch của kiểm thử tạo ra, không phải mạng thật. Người dùng là các tài khoản thử tổng hợp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEndpointKey, keySetDigest } from "../web/shared/msg-crypto.js";
import { MSG_POLL, MsgClient, type MsgClientError, type MsgHost } from "../web/shared/msg-client.js";
import { memoryBackend, openMsgStore, type MsgBackend } from "../web/shared/msg-store.js";
import { harness, WS, type Harness } from "./helpers.ts";
import { consent, count } from "./helpers-messaging.ts";

const DAY = 86_400_000;
const MARKER = "BANRO-MAYKHACH-90417";

interface Wire { method: string; path: string; key: string | null; body: string | null; status: number }
interface Net {
  /** ok: bình thường. down: yêu cầu không rời thiết bị. drop-response: máy chủ xử lý xong nhưng phản hồi mất. */
  mode: "ok" | "down" | "drop-response";
  match: RegExp;
  fake: null | { match: RegExp; status: number; code: string; retryAfter?: string };
  tamper: null | ((path: string, json: any) => Promise<any>);
}
interface Rig { client: MsgClient; backend: MsgBackend; wire: Wire[]; net: Net; seen: { changed: number; incoming: number }; consent: { ok: boolean } }

/** Một «thiết bị»: máy khách thật + kho trong bộ nhớ (được coi là bền, như IndexedDB) + lớp fetch ghi lại mọi yêu cầu. */
async function rig(h: Harness, sub: string, backend: MsgBackend = { ...memoryBackend(), persistent: true }): Promise<Rig> {
  const wire: Wire[] = [];
  const net: Net = { mode: "ok", match: /^POST .*\/messages$/, fake: null, tamper: null };
  const seen = { changed: 0, incoming: 0 };
  const agreed = { ok: true };
  const host: MsgHost = {
    async fetch(path, init) {
      const headers = init.headers as Record<string, string>;
      const rec: Wire = { method: String(init.method), path, key: headers["Idempotency-Key"] ?? null, body: typeof init.body === "string" ? init.body : null, status: 0 };
      wire.push(rec);
      const line = `${rec.method} ${path}`;
      if (net.fake?.match.test(line)) {
        rec.status = net.fake.status;
        return new Response(JSON.stringify({ code: net.fake.code, message: "giả lập", request_id: "req_test", retryable: true }), { status: net.fake.status, headers: { "Content-Type": "application/json", ...(net.fake.retryAfter ? { "Retry-After": net.fake.retryAfter } : {}) } });
      }
      const hit = net.mode !== "ok" && net.match.test(line);
      if (hit && net.mode === "down") throw new TypeError("fetch failed");
      const res = await fetch(h.base + path, init);
      rec.status = res.status;
      if (hit) {
        await res.arrayBuffer();
        throw new TypeError("fetch failed");
      }
      if (net.tamper && res.ok) return new Response(JSON.stringify(await net.tamper(path, await res.json())), { status: res.status, headers: { "Content-Type": "application/json" } });
      return res;
    },
    token: () => h.token(sub),
    workspace: () => WS,
    user: sub,
    consented: () => agreed.ok,
    now: () => h.clock.now(),
    changed: () => void seen.changed++,
    incoming: () => void seen.incoming++,
  };
  const client = new MsgClient(host, await openMsgStore(sub, backend));
  await client.start();
  return { client, backend, wire, net, seen, consent: agreed };
}

/** Hai người đã đồng ý, mỗi người một thiết bị, một hội thoại đang mở: toàn bộ qua máy khách. */
async function duo(h: Harness) {
  await consent(h, "dev_a");
  await consent(h, "dev_b");
  const A = await rig(h, "dev_a");
  const B = await rig(h, "dev_b");
  await A.client.registerDevice("LAPTOP");
  await B.client.registerDevice("PHONE");
  const thread = (await A.client.invite("dev_b")).thread_id;
  await B.client.threadOp(thread, "accept");
  await A.client.poll();
  return { A, B, thread };
}

const sends = (r: Rig) => r.wire.filter((w) => w.method === "POST" && w.path.endsWith("/messages"));
const bubble = (r: Rig, thread: string, ref: string) => r.client.timeline(thread).find((b) => b.client_ref === ref);
const dump = async (b: MsgBackend) => JSON.stringify(await Promise.all((["kv", "messages", "peers", "threads"] as const).map((s) => b.all(s))));
const code = (c: string) => (e: unknown) => (e as MsgClientError).code === c;

test("hai người qua máy chủ thật: đăng ký thiết bị, lời mời, gửi, nhận, xác nhận đã lưu, trạng thái theo bằng chứng, «đã xem» chỉ khi bật chia sẻ; lịch sử mở lại sau khi nạp lại; không yêu cầu hay kho nào mang bản rõ", async () => {
  const h = await harness();
  try {
    await consent(h, "dev_a");
    await consent(h, "dev_b");
    const A = await rig(h, "dev_a");
    const B = await rig(h, "dev_b");
    await A.client.poll();
    assert.equal(A.wire.length, 0, "chưa đăng ký thiết bị thì chưa có hộp thư nào để hỏi");
    const device = await A.client.registerDevice("LAPTOP");
    assert.match(String(device.endpoint_id), /^mep_/);
    assert.deepEqual(JSON.parse(A.wire[0].body ?? "{}"), { public_key: device.public_key, kind: "LAPTOP" }, "đăng ký chỉ gửi khóa công khai và loại máy do người dùng chọn");
    await B.client.registerDevice("PHONE");
    await assert.rejects(A.client.registerDevice("WATCH"), code("KIND"));
    assert.equal(count(h, "msg_endpoints"), 2);
    await A.client.loadPeople();
    assert.deepEqual(A.client.people, [{ user_id: "dev_b", name: "Thử nghiệm B" }]);

    const thread = (await A.client.invite("dev_b")).thread_id;
    assert.deepEqual(JSON.parse(A.wire.at(-1)?.body ?? "{}"), { peer: "dev_b" }, "lời mời không kèm chữ");
    await B.client.poll();
    assert.deepEqual([B.client.threads[0].state, B.client.threads[0].role, B.client.unread()], ["THREAD_REQUESTED", "ADDRESSEE", 1], "lời mời đang chờ tính vào huy hiệu");
    await assert.rejects(A.client.send(thread, "chưa được chấp nhận"), code("NOT_ACTIVE"));
    await B.client.threadOp(thread, "accept");
    assert.equal(B.client.unread(), 0);
    await A.client.poll();
    assert.equal(A.client.thread(thread)?.state, "THREAD_ACTIVE");

    const TEXT = `Chào B, dấu ${MARKER} 👋`;
    await assert.rejects(A.client.send(thread, ""), (e: Error) => e.message === "TEXT_EMPTY");
    await assert.rejects(A.client.send(thread, "x".repeat(2001)), (e: Error) => e.message === "TEXT_TOO_LONG");
    assert.equal(sends(A).length, 0);
    const ref = await A.client.send(thread, TEXT);
    await A.client.pump();
    assert.deepEqual(A.client.timeline(thread).map((b) => [b.status, b.text, b.mine, b.seq, b.client_ref]), [["SENT", TEXT, true, 1, ref]], "201 của máy chủ: «Máy chủ đã nhận»");
    assert.equal(B.seen.incoming, 0);
    await B.client.poll();
    assert.equal(B.seen.incoming, 1, "báo có tin mới đúng một lần");
    assert.equal(B.client.unread(), 1);
    assert.deepEqual(B.client.timeline(thread).map((b) => [b.status, b.text]), [["RECEIVED", null]], "phong bì đã lưu nhưng chưa mở: không có bản rõ");
    assert.equal(count(h, "msg_envelopes", "endpoint_id = ?", String(B.client.device?.endpoint_id)), 0, "B lưu rồi mới xác nhận: phong bì của B rời máy chủ");
    assert.equal(await B.client.decrypt(thread), true);
    assert.deepEqual(B.client.timeline(thread).map((b) => [b.status, b.text, b.mine]), [["RECEIVED", TEXT, false]]);
    assert.equal(await B.client.decrypt(thread), false, "đã mở rồi thì không mở lại");

    await A.client.poll();
    assert.equal(A.client.outbox.items.length, 0, "bản của chính A đã về kho: tin rời hộp gửi");
    assert.deepEqual(A.client.timeline(thread).map((b) => [b.status, b.text]), [["DELIVERED", TEXT]], "một thiết bị của B đã lưu: «Đã tới thiết bị»");
    assert.equal(count(h, "msg_envelopes"), 0);
    assert.equal(sends(A).length, 1);

    // «Đã xem» chỉ khi người đọc bật chia sẻ (mặc định tắt).
    assert.deepEqual(B.client.settings, { share_read: false });
    B.client.focus = thread;
    await B.client.poll();
    assert.equal(B.client.unread(), 0, "hội thoại đang mở: đánh dấu đã đọc");
    assert.deepEqual(JSON.parse(B.wire.filter((w) => w.path.endsWith("/read")).at(-1)?.body ?? "{}"), { through_seq: 1, share: false });
    await A.client.poll();
    assert.equal(A.client.timeline(thread)[0].status, "DELIVERED", "không chia sẻ thì người gửi không thấy «đã xem»");
    await B.client.setShareRead(true);
    await A.client.send(thread, "tin thứ hai");
    await A.client.pump();
    await B.client.poll();
    assert.equal(B.seen.incoming, 1, "tin tới hội thoại đang mở thì không báo");
    await A.client.poll();
    assert.deepEqual(A.client.timeline(thread).map((b) => b.status), ["READ", "READ"]);

    // B trả lời; A nhận.
    await B.client.send(thread, "B trả lời");
    await B.client.pump();
    await A.client.poll();
    await A.client.decrypt(thread);
    assert.deepEqual(A.client.timeline(thread).map((b) => [b.mine, b.text]), [[true, TEXT], [true, "tin thứ hai"], [false, "B trả lời"]]);
    assert.equal(A.seen.incoming, 1);

    // Nạp lại trang (máy khách mới trên cùng kho): thiết bị, lịch sử và khóa đã ghim còn nguyên, mở lại được.
    const A2 = await rig(h, "dev_a", A.backend);
    assert.equal(A2.client.device?.endpoint_id, device.endpoint_id);
    await A2.client.poll();
    assert.equal(await A2.client.decrypt(thread), true);
    assert.deepEqual(A2.client.timeline(thread).map((b) => b.text), [TEXT, "tin thứ hai", "B trả lời"]);
    assert.equal(A2.seen.incoming, 0, "tin đã có trên thiết bị không được báo lại là tin mới");

    for (const w of [...A.wire, ...B.wire, ...A2.wire]) assert.ok(!`${w.path} ${w.body ?? ""}`.includes(MARKER), `${w.method} ${w.path} mang bản rõ`);
    assert.ok(!(await dump(A.backend)).includes(MARKER) && !(await dump(B.backend)).includes(MARKER), "kho trên thiết bị không chứa bản rõ");
    assert.ok((await dump(B.backend)).includes(thread), "đối chứng: kho có phong bì của hội thoại");
    assert.ok(A.seen.changed > 0 && B.seen.changed > 0);
  } finally {
    await h.close();
  }
});

test("mất phản hồi: tin ở «chưa rõ đã gửi hay chưa» và không POST nào được gửi lại; chỉ bằng chứng từ hộp thư của chính thiết bị, hoặc «Thử lại» với đúng khóa và đúng byte cũ, đưa nó về «đã gửi»: đúng một tin ở bên kia", async () => {
  const h = await harness();
  try {
    const { A, B, thread } = await duo(h);
    // (a) Máy chủ đã lưu nhưng phản hồi mất.
    A.net.mode = "drop-response";
    const ref1 = await A.client.send(thread, "tin một");
    await A.client.pump();
    A.net.mode = "ok";
    assert.equal(bubble(A, thread, ref1)?.status, "UNCERTAIN");
    assert.equal(count(h, "msg_messages"), 1);
    await A.client.pump();
    await A.client.pump();
    assert.equal(sends(A).length, 1, "không tự gửi lại");
    await A.client.poll();
    assert.deepEqual([bubble(A, thread, ref1)?.status, sends(A).length, A.client.outbox.items.length], ["SENT", 1, 0], "tin trở về trong hộp thư của chính thiết bị: bằng chứng, không cần gửi lại");

    // (b) Yêu cầu không rời thiết bị. Thời gian trôi không đổi gì; tin sau của cùng hội thoại chờ.
    A.net.mode = "down";
    const ref2 = await A.client.send(thread, "tin hai");
    await A.client.pump();
    A.net.mode = "ok";
    assert.equal(count(h, "msg_messages"), 1);
    const before = sends(A).length;
    for (let i = 0; i < 3; i++) {
      h.clock.advance(60_000);
      A.client.poke();
      await A.client.tick();
      await A.client.pump();
    }
    h.clock.advance(6 * DAY);
    await A.client.poll();
    assert.deepEqual([bubble(A, thread, ref2)?.status, bubble(A, thread, ref2)?.can_retry, sends(A).length], ["UNCERTAIN", true, before], "sáu ngày sau vẫn «chưa rõ», chưa hề gửi lại");
    const ref3 = await A.client.send(thread, "tin ba");
    await A.client.pump();
    assert.deepEqual([bubble(A, thread, ref3)?.status, sends(A).length], ["WAITING", before], "tin sau chờ tin trước có kết quả để không đảo thứ tự");
    await A.client.retry(ref2);
    const [first, second] = sends(A).filter((w) => (w.body ?? "").includes(ref2));
    assert.deepEqual([first.status, second.status], [0, 201]);
    assert.equal(second.key, first.key, "thử lại dùng đúng Idempotency-Key cũ");
    assert.equal(second.body, first.body, "thử lại gửi đúng các byte cũ");
    assert.deepEqual([bubble(A, thread, ref2)?.status, bubble(A, thread, ref3)?.status], ["SENT", "SENT"], "tin hai có kết quả thì tin ba được gửi lần đầu");
    assert.equal(count(h, "msg_messages", "client_ref = ?", ref2), 1);

    // (c) Quá 7 ngày: không thử lại được nữa, tin vẫn «chưa rõ» cho tới khi người dùng bỏ nó.
    A.net.mode = "down";
    const ref4 = await A.client.send(thread, "tin bốn");
    await A.client.pump();
    A.net.mode = "ok";
    h.clock.advance(7 * DAY + 1000);
    assert.deepEqual([bubble(A, thread, ref4)?.status, bubble(A, thread, ref4)?.can_retry, bubble(A, thread, ref4)?.can_discard], ["UNCERTAIN", false, true]);
    const n = sends(A).length;
    await A.client.retry(ref4);
    assert.equal(sends(A).length, n);
    await A.client.discard(ref4);
    assert.equal(bubble(A, thread, ref4), undefined);

    await B.client.poll();
    await B.client.decrypt(thread);
    assert.deepEqual(B.client.timeline(thread).map((b) => b.text), ["tin một", "tin hai", "tin ba"], "mỗi tin đúng một lần, đúng thứ tự");
    assert.equal(count(h, "msg_messages"), 3);

    // (d) Lời từ chối dứt khoát: «không gửi được», không phải «chưa rõ». Người kia chặn rồi A gửi.
    await B.client.threadOp(thread, "block");
    const ref5 = await A.client.send(thread, "tin năm").catch(() => null);
    if (ref5) {
      await A.client.pump();
      assert.deepEqual([bubble(A, thread, ref5)?.status, bubble(A, thread, ref5)?.refusal, bubble(A, thread, ref5)?.can_discard], ["REJECTED", "RECIPIENT_UNAVAILABLE", true]);
    }
    assert.equal(count(h, "msg_messages"), 3);
  } finally {
    await h.close();
  }
});

test("người kia thêm thiết bị: KEYS_CHANGED → lấy lại khóa, niêm phong lại với khóa idempotency mới và client_ref cũ; cờ «danh sách thiết bị đã đổi» và mã an toàn; thiết bị mới chỉ thấy tin sau khi được thêm; khóa bị tráo thì dừng gửi; thiết bị bị gỡ xóa dữ liệu của nó", async () => {
  const h = await harness();
  try {
    const { A, B, thread } = await duo(h);
    await A.client.send(thread, "trước khi B thêm máy");
    await A.client.pump();
    await B.client.poll();
    const before = await A.client.safety(thread);
    assert.match(before.code, /^\d{30}$/);
    assert.deepEqual([before.groups.length, before.mine, before.theirs, before.verified], [6, 1, 1, false]);
    assert.equal((await B.client.safety(thread)).code, before.code, "hai người thấy cùng một mã an toàn");
    await A.client.confirmSafety(thread);
    assert.equal((await A.client.safety(thread)).verified, true);

    const B2 = await rig(h, "dev_b");
    await B2.client.registerDevice("TABLET");
    await B2.client.poll();
    assert.deepEqual(B2.client.timeline(thread), [], "thiết bị mới không có lịch sử");
    assert.equal(B2.client.thread(thread)?.state, "THREAD_ACTIVE");
    assert.equal(A.client.note(thread)?.devices_changed, false);

    const ref = await A.client.send(thread, "sau khi B thêm máy");
    await A.client.pump();
    const posts = sends(A).filter((w) => (w.body ?? "").includes(ref));
    assert.deepEqual(posts.map((w) => w.status), [409, 201], "tập khóa cũ bị từ chối dứt khoát, rồi niêm phong lại và gửi lần đầu với khóa mới");
    assert.notEqual(posts[0].key, posts[1].key);
    assert.deepEqual([JSON.parse(posts[0].body ?? "{}").envelopes.length, JSON.parse(posts[1].body ?? "{}").envelopes.length], [2, 3]);
    assert.equal(bubble(A, thread, ref)?.status, "SENT");
    assert.equal(count(h, "msg_messages", "client_ref = ?", ref), 1);
    assert.equal(A.client.note(thread)?.devices_changed, true, "«Danh sách thiết bị đã đổi»");
    const after = await A.client.safety(thread);
    assert.notEqual(after.code, before.code);
    assert.deepEqual([after.mine, after.theirs, after.verified], [1, 2, false], "tập khóa đổi thì lần so mã trước không còn giá trị");
    await A.client.dismissDevicesChanged(thread);
    assert.equal(A.client.note(thread)?.devices_changed, false);
    await B2.client.poll();
    await B2.client.decrypt(thread);
    assert.deepEqual(B2.client.timeline(thread).map((b) => b.text), ["sau khi B thêm máy"], "thiết bị mới chỉ thấy tin gửi sau khi nó được thêm (LNH-T32)");

    // Lần thêm thiết bị kế tiếp được thấy ngay ở lần thăm dò thường (key_set của hội thoại đổi), trước khi gửi: không còn 409.
    const B3 = await rig(h, "dev_b");
    await B3.client.registerDevice("DESKTOP");
    await A.client.poll();
    assert.equal(A.client.note(thread)?.devices_changed, true, "báo «danh sách thiết bị đã đổi» mà không cần gửi tin");
    assert.equal(A.client.note(thread)?.key_set, A.client.thread(thread)?.key_set);
    const ref3 = await A.client.send(thread, "tới ba thiết bị của B");
    await A.client.pump();
    assert.deepEqual(sends(A).filter((w) => (w.body ?? "").includes(ref3)).map((w) => w.status), [201]);
    assert.equal(JSON.parse(sends(A).at(-1)?.body ?? "{}").envelopes.length, 4);
    await A.client.dismissDevicesChanged(thread);

    // Máy chủ (hoặc ai đó giữa đường) tráo khóa của một điểm nhận tin đã ghim, kèm mã băm tính lại cho khớp: dừng, không gửi.
    const fake = await generateEndpointKey();
    A.net.tamper = async (path, json) => {
      if (!path.endsWith("/keys")) return json;
      const endpoints = json.endpoints.map((e: { endpoint_id: string }) => (e.endpoint_id === B.client.device?.endpoint_id ? { ...e, public_key: fake.public_key } : e));
      return { ...json, endpoints, key_set: await keySetDigest(thread, endpoints) };
    };
    await assert.rejects(A.client.ensureKeys(thread), code("KEY_CONFLICT"));
    const n = sends(A).length;
    await assert.rejects(A.client.send(thread, "không được gửi tới khóa bị tráo"), code("KEY_CONFLICT"));
    assert.equal(sends(A).length, n);
    A.net.tamper = async (path, json) => (path.endsWith("/keys") ? { ...json, endpoints: json.endpoints.slice(0, -1) } : json);
    await assert.rejects(A.client.ensureKeys(thread), code("KEY_SET_MISMATCH"));
    A.net.tamper = null;
    await A.client.ensureKeys(thread);
    await A.client.send(thread, "tập khóa thật thì gửi lại được");
    await A.client.pump();
    assert.equal(sends(A).at(-1)?.status, 201);

    // B gỡ thiết bị thứ hai từ thiết bị thứ nhất: thiết bị bị gỡ tự xóa khóa và lịch sử của nó ở lần thăm dò kế tiếp.
    await B.client.revokeEndpoint(String(B2.client.device?.endpoint_id));
    assert.equal(B.client.registered, true);
    assert.equal(B.client.endpoints.filter((e) => e.status === "ACTIVE").length, 2);
    await B2.client.poll();
    assert.deepEqual([B2.client.registered, B2.client.revoked, B2.client.timeline(thread).length], [false, true, 0]);
    assert.equal(await dump(B2.backend), "[[],[],[],[]]");
    // Gỡ chính thiết bị đang dùng: cũng xóa sạch, nhưng không phải «bị gỡ từ nơi khác».
    await B.client.revokeEndpoint(String(B.client.device?.endpoint_id));
    assert.deepEqual([B.client.registered, B.client.revoked, await dump(B.backend)], [false, false, "[[],[],[],[]]"]);
    assert.equal(count(h, "msg_endpoints", "user_id = 'dev_b' AND status = 'ACTIVE'"), 1, "chỉ còn thiết bị thứ ba");
    // Đăng ký lại: khóa mới, điểm nhận tin mới.
    const again = await B.client.registerDevice("PHONE");
    assert.equal(count(h, "msg_endpoints", "user_id = 'dev_b' AND status = 'ACTIVE'"), 2);
    assert.ok(again.endpoint_id);

    // Kho không bền (không có IndexedDB): không đăng ký thiết bị, vì khóa sẽ mất khi đóng trang.
    const C = await rig(h, "dev_ops", memoryBackend());
    await assert.rejects(C.client.registerDevice("LAPTOP"), code("STORAGE"));
    assert.equal(C.wire.length, 0);
  } finally {
    await h.close();
  }
});

test("nhịp thăm dò: 15 giây khi không mở hội thoại, 3 giây khi mở, lùi dần tới 60 giây sau 429; chưa đồng ý thì không gọi máy chủ; cổng đóng được ghi nhận; rút đồng ý làm thiết bị bị gỡ và dữ liệu trên máy bị xóa", async () => {
  const h = await harness();
  try {
    const { A, thread } = await duo(h);
    const polls = () => A.wire.filter((w) => w.method === "GET" && w.path.startsWith("/v1/messages/inbox")).length;
    assert.deepEqual({ ...MSG_POLL }, { openMs: 3000, idleMs: 15000, maxMs: 60000 });
    let clock = 5_000_000;
    A.client.poke();
    await A.client.tick(clock);
    const base = polls();
    assert.equal(A.client.interval(), 15000);
    await A.client.tick(clock + 14_999);
    assert.equal(polls(), base);
    await A.client.tick((clock += 15_000));
    assert.equal(polls(), base + 1);
    A.client.focus = thread;
    assert.equal(A.client.interval(), 3000);
    await A.client.tick(clock + 2_999);
    assert.equal(polls(), base + 1);
    await A.client.tick((clock += 3_000));
    assert.equal(polls(), base + 2);
    // Hộp thư không đổi: máy chủ chỉ trả lại etag.
    assert.match(A.wire.filter((w) => w.path.startsWith("/v1/messages/inbox")).at(-1)?.path ?? "", /&etag=[A-Za-z0-9_-]{43}$/);

    A.net.fake = { match: /inbox/, status: 429, code: "RATE_LIMITED", retryAfter: "1" };
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      A.client.poke();
      await A.client.tick(clock);
      waits.push(A.client.interval());
    }
    assert.deepEqual(waits, [6000, 12000, 24000, 48000, 60000, 60000]);
    A.net.fake = null;
    A.client.poke();
    await A.client.tick(clock);
    assert.equal(A.client.interval(), 3000, "một lần thành công đưa nhịp về bình thường");
    A.net.fake = { match: /inbox/, status: 429, code: "RATE_LIMITED", retryAfter: "30" };
    A.client.poke();
    await A.client.tick(clock);
    assert.equal(A.client.interval(), 30000, "không hỏi lại sớm hơn Retry-After của máy chủ");
    A.net.fake = null;

    // Chưa đồng ý (theo /v1/me): không yêu cầu nào rời thiết bị.
    A.consent.ok = false;
    const quiet = A.wire.length;
    A.client.poke();
    await A.client.tick(clock + 100_000);
    await A.client.poll();
    assert.equal(A.wire.length, quiet);
    A.consent.ok = true;

    // Cờ mô-đun tắt rồi bật lại.
    const flag = (enabled: boolean) => h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "messaging", enabled, reason: "kiểm máy khách" } });
    await flag(false);
    await A.client.poll();
    assert.equal(A.client.gate, "MODULE_DISABLED");
    await flag(true);
    await A.client.poll();
    assert.equal(A.client.gate, null);

    // Rút đồng ý ở nơi khác: cổng báo ngay; đồng ý lại thì thiết bị cũ đã bị máy chủ gỡ, máy khách xóa dữ liệu trên máy.
    await h.call("POST", "/v1/consents/messaging/withdraw", { sub: "dev_a" });
    await A.client.poll();
    assert.equal(A.client.gate, "CONSENT_REQUIRED");
    assert.equal(A.client.registered, true, "chưa biết thiết bị đã bị gỡ: chưa xóa gì");
    await consent(h, "dev_a");
    await A.client.poll();
    assert.deepEqual([A.client.registered, A.client.revoked, A.client.gate, await dump(A.backend)], [false, true, null, "[[],[],[],[]]"]);
  } finally {
    await h.close();
  }
});
