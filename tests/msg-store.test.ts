// Kho nhắn tin trên thiết bị (web/shared/msg-store.js, LNH-T31, LNH-T32): ghim khóa không ghi đè, hạn 30 ngày, bản nháp mã hóa,
// hộp gửi sau khi nạp lại trang, và «không có bản rõ nào trong kho». Chạy trên memoryBackend(): Node không có IndexedDB, nên phần
// nối với IndexedDB thật (idbBackend) chỉ được kiểm trong trình duyệt (scripts/e2e-messages.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateEndpointKey, keySetDigest, openMessage, sealMessage } from "../web/shared/msg-crypto.js";
import { emptyOutbox, outboxStep } from "../web/shared/msg-outbox.js";
import { MSG_HISTORY_MS, MsgStore, expired, memoryBackend, msgDbName, openMsgStore, pinDecision, type MsgPin, type MsgStored } from "../web/shared/msg-store.js";

const NOW = Date.parse("2026-11-11T02:00:00.000Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const envelope = (id: string, thread: string, seq: number, sentAt: number): MsgStored => ({
  message_id: id, thread_id: thread, seq, sender_user: "dev_b", sender_endpoint: "mep_sender01", client_ref: `ref-${id}`.padEnd(22, "0"), iv: "A".repeat(16), ct: "B".repeat(363), enc: "C".repeat(87), wrapped: "D".repeat(64), sent_at: iso(sentAt),
});
/** Mọi thứ đang nằm trong kho, ở dạng chuỗi (CryptoKey không tuần tự hóa được và không lộ gì). */
const dump = async (store: MsgStore) => JSON.stringify(await Promise.all((["kv", "messages", "peers", "threads"] as const).map((s) => store.backend.all(s))));

test("ghim khóa: khóa mới được ghim một lần; mã điểm nhận tin xuất hiện lại với khóa hoặc người khác là xung đột và khóa cũ được giữ", async () => {
  const a: MsgPin = { endpoint_id: "mep_aaaaaa", user_id: "dev_a", public_key: "K1" };
  const b: MsgPin = { endpoint_id: "mep_bbbbbb", user_id: "dev_b", public_key: "K2" };
  assert.deepEqual(pinDecision(new Map(), [a, b]), { add: [a, b], conflicts: [] });
  assert.deepEqual(pinDecision(new Map([[a.endpoint_id, a]]), [a, b]), { add: [b], conflicts: [] });
  assert.deepEqual(pinDecision(new Map([[a.endpoint_id, a]]), [{ ...a, public_key: "K9" }]), { add: [], conflicts: [a.endpoint_id] }, "khóa bị tráo");
  assert.deepEqual(pinDecision(new Map([[a.endpoint_id, a]]), [{ ...a, user_id: "dev_b" }]), { add: [], conflicts: [a.endpoint_id] }, "cùng khóa nhưng gán cho người khác");
  assert.deepEqual(pinDecision(new Map(), [a, { ...a, public_key: "K9" }]), { add: [a], conflicts: [a.endpoint_id] }, "một danh sách nêu một điểm nhận tin hai lần");

  const backend = memoryBackend();
  const store = await openMsgStore("dev_a", backend);
  assert.deepEqual(await store.pin([a, b]), { added: [a.endpoint_id, b.endpoint_id], conflicts: [] });
  assert.deepEqual(await store.pin([{ ...b, public_key: "K9" }, a]), { added: [], conflicts: [b.endpoint_id] });
  assert.equal(store.pinned(b.endpoint_id)?.public_key, "K2", "khóa đã ghim không bao giờ bị ghi đè");
  assert.equal(store.pinned("mep_khong_co"), null);
  // Nạp lại trang: khóa đã ghim vẫn còn.
  assert.equal((await openMsgStore("dev_a", backend)).pinned(a.endpoint_id)?.public_key, "K1");
  assert.equal(msgDbName("dev_a"), "lenhip.msg.v1.dev_a");
});

test("lịch sử trên thiết bị: phong bì lưu nguyên dạng, lưu lại không nhân đôi, xếp theo hội thoại rồi seq, quá 30 ngày thì không hiện và bị dọn", async () => {
  const store = await openMsgStore("dev_a", memoryBackend());
  assert.equal(MSG_HISTORY_MS, 30 * DAY);
  assert.equal(expired({ sent_at: iso(NOW - 30 * DAY + 1000) }, NOW), false);
  assert.equal(expired({ sent_at: iso(NOW - 30 * DAY) }, NOW), true, "đúng 30 ngày là hết hạn");
  assert.equal(expired({ sent_at: "không phải thời điểm" }, NOW), true, "thời điểm hỏng thì không giữ");
  const rows = [envelope("msg_000003", "th_bbbbbb", 1, NOW - DAY), envelope("msg_000002", "th_aaaaaa", 2, NOW - 2 * DAY), envelope("msg_000001", "th_aaaaaa", 1, NOW - 3 * DAY), envelope("msg_000000", "th_aaaaaa", 0, NOW - 31 * DAY)];
  await store.putMessages(rows);
  await store.putMessages(rows.slice(0, 2));
  assert.deepEqual((await store.messages(NOW)).map((m) => m.message_id), ["msg_000001", "msg_000002", "msg_000003"], "tin quá hạn không được trả ra kể cả trước khi dọn");
  assert.deepEqual(await store.messages(NOW), [rows[2], rows[1], rows[0]], "đúng các trường của phong bì, không thêm gì");
  assert.deepEqual(await store.prune(NOW), ["msg_000000"]);
  assert.equal((await store.backend.all("messages")).length, 3);
  assert.deepEqual((await store.prune(NOW + 28 * DAY + 1000)).sort(), ["msg_000001", "msg_000002"], "tin gửi 1 ngày trước còn lại tới khi đủ 30 ngày");
  // Trường lạ máy chủ gửi kèm không được lưu.
  await store.putMessages([{ ...envelope("msg_000009", "th_cccccc", 1, NOW), text: "chữ đọc được" } as MsgStored]);
  assert.ok(!(await dump(store)).includes("chữ đọc được"));
});

test("bản nháp được mã hóa trong kho, gắn với đúng hội thoại, chuỗi rỗng thì xóa; lựa chọn chia sẻ «đã xem» mặc định tắt", async () => {
  const backend = memoryBackend();
  const store = await openMsgStore("dev_a", backend);
  const DRAFT = "Nháp có dấu NHAP-RO-7731 và ký tự 🙂";
  assert.equal(await store.draft("th_aaaaaa"), "");
  await store.setDraft("th_aaaaaa", DRAFT);
  assert.equal(await store.draft("th_aaaaaa"), DRAFT);
  assert.ok(!(await dump(store)).includes("NHAP-RO-7731"), "kho không chứa chữ của bản nháp");
  // Nạp lại trang: mở được bằng khóa nháp không xuất được đã lưu trong kho.
  const again = await openMsgStore("dev_a", backend);
  assert.equal(await again.draft("th_aaaaaa"), DRAFT);
  const key = (await backend.get("kv", "draftKey")) as CryptoKey;
  assert.deepEqual([key.type, key.extractable, key.algorithm.name], ["secret", false, "AES-GCM"]);
  // Bản nháp của hội thoại này không mở được dưới tên hội thoại khác.
  await again.saveNote("th_bbbbbb", { draft: again.note("th_aaaaaa").draft });
  assert.equal(await again.draft("th_bbbbbb"), "");
  await again.setDraft("th_aaaaaa", "");
  assert.equal(again.note("th_aaaaaa").draft, null);
  assert.equal(await again.draft("th_aaaaaa"), "");
  // Ghi chú hội thoại: mặc định, rồi giữ qua lần nạp lại.
  assert.deepEqual(store.note("th_zzzzzz"), { thread_id: "th_zzzzzz", key_set: null, endpoints: [], devices_changed: false, verified_key_set: null, draft: null });
  await again.saveNote("th_aaaaaa", { key_set: "S".repeat(43), devices_changed: true });
  assert.deepEqual([(await openMsgStore("dev_a", backend)).note("th_aaaaaa").key_set, (await openMsgStore("dev_a", backend)).note("th_aaaaaa").devices_changed], ["S".repeat(43), true]);

  assert.deepEqual(await store.settings(), { share_read: false });
  await store.saveSettings({ share_read: true });
  assert.deepEqual(await (await openMsgStore("dev_a", backend)).settings(), { share_read: true });
  await backend.put("kv", "settings", { share_read: "yes" });
  assert.deepEqual(await store.settings(), { share_read: false }, "chỉ đúng true mới là bật");
});

test("thiết bị và hộp gửi: khóa riêng không xuất được; nạp lại trang thì lần gửi đang chạy thành «chưa rõ», không tự gửi lại; xóa sạch khi gỡ thiết bị", async () => {
  const backend = memoryBackend();
  const store = await openMsgStore("dev_a", backend);
  assert.equal(store.persistent, false, "kho trong bộ nhớ không giữ được khóa qua lần nạp lại");
  assert.equal(await store.device(), null);
  const k = await generateEndpointKey();
  await store.saveDevice({ ...k, endpoint_id: "mep_aaaaaa", kind: "LAPTOP", created_at: iso(NOW) });
  const device = (await (await openMsgStore("dev_a", backend)).device())!;
  assert.deepEqual([device.endpoint_id, device.kind, device.public_key], ["mep_aaaaaa", "LAPTOP", k.public_key]);
  assert.equal(device.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", device.privateKey), "khóa riêng không rời được kho khóa");

  // Một tin thật: niêm phong, xếp vào hộp gửi, đang gửi thì trang bị đóng.
  const peer = await generateEndpointKey();
  const endpoints = [{ endpoint_id: "mep_aaaaaa", user_id: "dev_a", public_key: k.public_key }, { endpoint_id: "mep_bbbbbb", user_id: "dev_b", public_key: peer.public_key }];
  const TEXT = "Tin có dấu BANRO-KHO-5521";
  const ref = "r".repeat(24);
  const body = await sealMessage({ text: TEXT, thread_id: "th_aaaaaa", client_ref: ref, key_set: await keySetDigest("th_aaaaaa", endpoints), sender: { endpoint_id: "mep_aaaaaa", ...k }, recipients: endpoints });
  let outbox = outboxStep(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "th_aaaaaa", idem_key: "k".repeat(43), body: body as unknown as Record<string, unknown>, at: NOW }).outbox;
  outbox = outboxStep(outbox, { type: "attempt", client_ref: ref }).outbox;
  assert.equal(outbox.items[0].state, "SENDING");
  await store.saveOutbox(outbox);
  const reloaded = await (await openMsgStore("dev_a", backend)).outbox();
  assert.deepEqual([reloaded.items[0].state, reloaded.items[0].idem_key, reloaded.items[0].body, reloaded.items[0].attempts], ["UNCERTAIN", "k".repeat(43), outbox.items[0].body, 1]);
  assert.deepEqual((await (await openMsgStore("dev_a", memoryBackend())).outbox()).items, [], "kho mới: hộp gửi rỗng");

  // Tin tới cũng nằm trong kho ở dạng phong bì; chỉ mở được bằng khóa của thiết bị này và khóa đã ghim của thiết bị gửi.
  const mine = body.envelopes.find((e) => e.endpoint_id === "mep_aaaaaa")!;
  await store.putMessages([{ message_id: "msg_000001", thread_id: "th_aaaaaa", seq: 1, sender_user: "dev_a", sender_endpoint: "mep_aaaaaa", client_ref: ref, iv: body.iv, ct: body.ct, enc: mine.enc, wrapped: mine.wrapped, sent_at: iso(NOW) }]);
  await store.pin(endpoints);
  const [saved] = await store.messages(NOW);
  assert.equal((await openMessage({ thread_id: saved.thread_id, message: saved, recipient: device, sender_public_key: store.pinned(saved.sender_endpoint)!.public_key })).text, TEXT);
  assert.ok(!(await dump(store)).includes("BANRO-KHO-5521"), "phong bì, hộp gửi và ghi chú đều không chứa bản rõ");

  await store.wipe();
  assert.equal(await store.device(), null);
  assert.equal(await dump(store), "[[],[],[],[]]");
  assert.equal(store.pinned("mep_aaaaaa"), null);
});
