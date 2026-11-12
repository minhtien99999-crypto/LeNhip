// Nhắn tin: lưu giữ, quyền của chủ thể dữ liệu và khôi phục (LNH-T30, LNH-T32, LNH-T36). Dọn theo hạn 30 ngày trên đồng hồ tay,
// rút đồng ý và RESTRICT, DELETE, xuất siêu dữ liệu, restore rồi nạp lại sổ thu hồi, quét byte tìm bản rõ trong mọi tệp máy chủ
// ghi ra, và LeLe không có đường nào tới tin nhắn. Người dùng là ba tài khoản thử tổng hợp; «thiết bị» là cặp khóa tạo trong
// tiến trình kiểm thử; «restore» là chép đè tệp sổ bằng bản sao lưu trong cùng thư mục tạm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DAY } from "../src/core/clock.ts";
import { exportMessagingFor, MESSAGING_LIMITS, messaging } from "../src/server/messaging.ts";
import { applyRevocations, backupLedger, restoreLedgerFile } from "../src/server/recovery.ts";
import { all } from "../src/server/store.ts";
import { harness, WS, type Harness } from "./helpers.ts";
import { ack, consent, count, device, inbox, open, openThread, pair, pending, post, seal, sendText, threadRow } from "./helpers-messaging.ts";

const MSG_ROUTES = "substr(route, 1, 13) = '/v1/messages/'";
const TABLES = ["msg_endpoints", "msg_threads", "msg_marks", "msg_messages", "msg_envelopes", "msg_reports"];
const journalTypes = (h: Harness, from = 0) => h.app.ctx.revocations.readAll().entries.slice(from).map((e) => e.type);
const viewOf = async (h: Harness, d: { sub: string; endpoint_id: string }, thread: string) =>
  ((await h.call("GET", `/v1/messages/inbox?endpoint=${d.endpoint_id}`, { sub: d.sub })).body.threads as { thread_id: string }[]).find((t) => t.thread_id === thread) as Record<string, unknown>;
/** Ảnh chụp phần trạng thái mà restore không được làm sai: thiết bị nào còn dùng, hội thoại ở đâu, phong bì nào còn chờ. */
const rows = <T>(h: Harness, sql: string) => JSON.parse(JSON.stringify(all(h.app.ctx.db, sql))) as T[];
const snapshot = (h: Harness) => ({
  endpoints: rows<{ id: string; status: string }>(h, "SELECT id, status FROM msg_endpoints ORDER BY id"),
  threads: rows<{ id: string; state: string; requested_by: string; blocked_by: string | null; reopen_by: string | null }>(h, "SELECT id, state, requested_by, blocked_by, reopen_by FROM msg_threads ORDER BY id"),
  envelopes: rows<{ message_id: string; endpoint_id: string }>(h, "SELECT message_id, endpoint_id FROM msg_envelopes ORDER BY message_id, endpoint_id"),
});

test("máy chủ là hộp thư: tin, phong bì và dấu chống lặp của /v1/messages/* bị xóa sau 30 ngày, cả khi chưa ai nhận; thiết bị đã gỡ và báo cáo cũng vậy; dấu của route khác giữ nguyên", async () => {
  const h = await harness();
  try {
    assert.equal(MESSAGING_LIMITS.retentionMs, 30 * DAY);
    const { a: [a1], b: [b1], thread } = await pair(h);
    const a2 = await device(h, "dev_a", "PHONE");
    assert.equal((await h.call("POST", `/v1/messages/endpoints/${a2.endpoint_id}/revoke`, {})).status, 200);
    const s1 = await sendText(h, a1, thread, "tin ngày đầu");
    assert.equal(s1.res.status, 201);
    const id1 = s1.res.body.message_id as string;
    assert.equal((await ack(h, b1, [id1])).body.acked, 1, "B đã lưu; bản của chính A1 còn chờ");
    assert.equal((await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "SPAM" } })).status, 201);
    const day0 = { messaging: count(h, "idem_keys", MSG_ROUTES), other: count(h, "idem_keys", `NOT (${MSG_ROUTES})`) };
    assert.ok(day0.messaging >= 7 && day0.other >= 2, JSON.stringify(day0));

    h.clock.advance(29 * DAY);
    const s2 = await sendText(h, a1, thread, "tin ngày 29");
    assert.equal(s2.res.status, 201);
    await h.app.tick();
    assert.equal(count(h, "msg_messages"), 2, "chưa tới hạn thì chưa xóa");
    assert.equal(count(h, "msg_envelopes", "message_id = ?", id1), 1);
    assert.equal(count(h, "msg_endpoints", "status = 'REVOKED'"), 1);
    assert.equal(count(h, "msg_reports"), 1);
    assert.equal(count(h, "idem_keys", MSG_ROUTES), day0.messaging + 1);

    h.clock.advance(DAY + 1000);
    await h.app.tick();
    assert.deepEqual(all<{ id: string }>(h.app.ctx.db, "SELECT id FROM msg_messages").map((m) => m.id), [s2.res.body.message_id], "tin quá 30 ngày bị xóa cả hàng");
    assert.equal(count(h, "msg_envelopes", "message_id = ?", id1), 0, "phong bì chưa ai nhận cũng bị xóa: muộn nhất 30 ngày");
    assert.equal(count(h, "msg_envelopes"), 2, "tin ngày 29 còn nguyên hai phong bì");
    assert.equal(count(h, "idem_keys", MSG_ROUTES), 1, "dấu chống lặp của /v1/messages/* đi cùng tin");
    assert.equal(count(h, "idem_keys", `NOT (${MSG_ROUTES})`), day0.other, "dấu của route khác vẫn theo hạn của lõi");
    assert.equal(count(h, "msg_endpoints", "status = 'REVOKED'"), 0, "thiết bị đã gỡ quá 30 ngày bị xóa khỏi sổ");
    assert.equal(count(h, "msg_endpoints", "status = 'ACTIVE'"), 2);
    assert.equal(count(h, "msg_reports"), 0);
    assert.equal(threadRow(h, thread)!.state, "THREAD_ACTIVE", "hội thoại không phải tin: giữ nguyên");
    assert.deepEqual((await pending(h, a1)).map((m) => m.message_id), [s2.res.body.message_id]);

    // Giới hạn đã nói rõ: sau 30 ngày máy chủ không còn nhận ra một lần gửi lại (dấu và tin đều đã xóa), nên đúng khóa cũ và đúng
    // byte cũ được lưu như tin mới. Vì vậy hộp gửi trên thiết bị không cho thử lại quá 7 ngày (tests/msg-outbox.test.ts).
    const late = await post(h, a1, thread, s1.body, s1.key);
    assert.equal(late.status, 201);
    assert.equal(late.headers.get("idempotent-replayed"), null);
    assert.notEqual(late.body.message_id, id1);

    h.clock.advance(30 * DAY + 1000);
    await h.app.tick();
    assert.equal(count(h, "msg_messages") + count(h, "msg_envelopes") + count(h, "idem_keys", MSG_ROUTES), 0, "không còn gì của nhắn tin quá 30 ngày");
  } finally {
    await h.close();
  }
});

test("rút đồng ý, đổi sang từ chối và RESTRICT: ngay trong thao tác đó hội thoại đóng, thiết bị bị gỡ, phong bì chờ tới người đó bị xóa; tin họ đã gửi vẫn được giao; đồng ý lại không làm sống lại thiết bị cũ", async () => {
  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread } = await pair(h);
    await consent(h, "dev_ops");
    const o1 = await device(h, "dev_ops");
    const invite = await h.call("POST", "/v1/messages/threads", { sub: "dev_ops", body: { peer: "dev_b" } });
    assert.equal(invite.status, 201, "một lời mời đang chờ B trả lời");
    const fromA = await sendText(h, a1, thread, "A gửi B, B chưa kịp nhận");
    const fromB = await sendText(h, b1, thread, "B gửi A trước khi rút đồng ý");
    const base = journalTypes(h).length;

    assert.equal((await h.call("POST", "/v1/consents/messaging/withdraw", { sub: "dev_b" })).status, 200);
    assert.equal(count(h, "msg_endpoints", "user_id = 'dev_b' AND status = 'ACTIVE'"), 0, "không chờ vòng tick");
    assert.equal(count(h, "msg_envelopes", "endpoint_id = ?", b1.endpoint_id), 0, "không gì còn chờ giao tới người đã rút");
    assert.deepEqual([threadRow(h, thread)!.state, threadRow(h, thread)!.reopen_by], ["THREAD_CLOSED", null]);
    assert.equal(threadRow(h, invite.body.thread_id)!.state, "THREAD_CLOSED", "lời mời đang chờ cũng đóng");
    assert.equal((await inbox(h, b1)).body.code, "CONSENT_REQUIRED");
    const inA = await pending(h, a1);
    assert.deepEqual(inA.map((m) => m.message_id), [fromA.res.body.message_id, fromB.res.body.message_id], "bản của A và tin B đã gửi trước đó vẫn chờ A");
    assert.equal(await open(a1, inA[1], b1), "B gửi A trước khi rút đồng ý");
    const aSees = await viewOf(h, a1, thread);
    assert.deepEqual([aSees.state, aSees.can_request], ["THREAD_CLOSED", false]);
    assert.equal((await h.call("GET", `/v1/messages/threads/${thread}/keys`)).body.code, "RECIPIENT_UNAVAILABLE");
    assert.deepEqual(journalTypes(h, base), ["consent_withdrawn"], "sổ thu hồi chỉ có dòng của lõi; mô-đun không ghi thêm");

    // Đồng ý lại: thiết bị cũ không sống lại và hội thoại vẫn đóng. Phải đăng ký khóa mới rồi mời và chấp nhận lại.
    await consent(h, "dev_b");
    assert.equal((await inbox(h, b1)).status, 404, "điểm nhận tin đã gỡ");
    assert.equal(threadRow(h, thread)!.state, "THREAD_CLOSED");
    assert.equal((await h.call("POST", "/v1/messages/endpoints", { sub: "dev_b", body: { public_key: b1.public_key, kind: "DESKTOP" } })).status, 409, "khóa đã gỡ không đăng ký lại được");
    const b2 = await device(h, "dev_b", "PHONE");
    const again = await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } });
    assert.deepEqual([again.status, again.body.thread_id], [201, thread]);
    assert.equal((await h.call("POST", `/v1/messages/threads/${thread}/accept`, { sub: "dev_b" })).body.state, "THREAD_ACTIVE");
    assert.equal((await pending(h, b2)).length, 0, "thiết bị mới chỉ thấy tin gửi sau khi nó được thêm");

    // Đổi GRANTED → DECLINED cũng là mất đồng ý.
    const t2 = await openThread(h, "dev_a", "dev_ops");
    await consent(h, "dev_ops", "messaging", "DECLINED");
    assert.equal(threadRow(h, t2)!.state, "THREAD_CLOSED");
    assert.equal(count(h, "msg_endpoints", "id = ? AND status = 'REVOKED'", o1.endpoint_id), 1);

    // RESTRICT rút mọi đồng ý của người đó, trong đó có messaging.
    const sent = await sendText(h, b2, thread, "B gửi A ngay trước khi A yêu cầu hạn chế xử lý");
    assert.equal(sent.res.status, 201);
    assert.equal((await h.call("POST", "/v1/privacy/requests", { body: { type: "RESTRICT" } })).status, 202);
    assert.equal(count(h, "msg_endpoints", "user_id = 'dev_a' AND status = 'ACTIVE'"), 0);
    assert.equal(count(h, "msg_envelopes", "endpoint_id = ?", a1.endpoint_id), 0);
    assert.equal(threadRow(h, thread)!.state, "THREAD_CLOSED");
    assert.equal((await pending(h, b2)).length, 1, "bản của chính người gửi không bị đụng tới");
  } finally {
    await h.close();
  }
});

test("xóa dữ liệu (DELETE): máy chủ không còn gì từ hoặc tới người đó, kể cả dấu chống lặp của người kia cho hội thoại chung; dữ liệu của người khác giữ nguyên; restore bản cũ rồi nạp sổ thu hồi thì vẫn mất", async () => {
  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread } = await pair(h);
    await consent(h, "dev_ops");
    const o1 = await device(h, "dev_ops");
    const t2 = await openThread(h, "dev_a", "dev_ops");
    const t3 = await openThread(h, "dev_ops", "dev_b");
    const m1 = await sendText(h, a1, thread, "A gửi B");
    await sendText(h, b1, thread, "B gửi A");
    const kept = await sendText(h, a1, t2, "A gửi quản trị");
    await sendText(h, o1, t3, "quản trị gửi B");
    await ack(h, b1, [m1.res.body.message_id]);
    await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_b", body: { through_seq: 1, share: true } });
    for (const [sub, id] of [["dev_b", thread], ["dev_a", thread], ["dev_ops", t3], ["dev_ops", t2]] as const) {
      assert.equal((await h.call("POST", "/v1/messages/reports", { sub, body: { thread_id: id, reason: "OTHER" } })).status, 201);
    }
    const backupPath = join(h.dir, "truoc-khi-xoa.db");
    backupLedger(h.app.ctx, backupPath);

    /** Không hàng nào của nhắn tin, kể cả dấu chống lặp, còn nhắc tới người đã xóa, tên, thiết bị hay hội thoại của họ. */
    const gone = (why: string) => {
      const needles = ["dev_b", "Thử nghiệm B", b1.endpoint_id, thread, t3];
      for (const table of [...TABLES, `idem_keys WHERE ${MSG_ROUTES}`]) {
        const dump = JSON.stringify(all(h.app.ctx.db, `SELECT * FROM ${table}`));
        for (const n of needles) assert.ok(!dump.includes(n), `${why}: ${table} còn «${n}»`);
      }
    };
    const others = () => ({
      thread: threadRow(h, t2)!.state,
      messages: count(h, "msg_messages", "thread_id = ?", t2),
      envelopes: count(h, "msg_envelopes", "message_id = ?", kept.res.body.message_id),
      endpoints: count(h, "msg_endpoints", "user_id IN ('dev_a', 'dev_ops') AND status = 'ACTIVE'"),
      reports: count(h, "msg_reports"),
    });
    assert.deepEqual(others(), { thread: "THREAD_ACTIVE", messages: 1, envelopes: 2, endpoints: 2, reports: 4 });
    assert.throws(() => gone("trước khi xóa"), "phép quét phải thấy dữ liệu khi nó còn đó");

    assert.equal((await h.call("POST", "/v1/privacy/requests", { sub: "dev_b", body: { type: "DELETE" } })).status, 202);
    gone("sau DELETE");
    assert.deepEqual(others(), { thread: "THREAD_ACTIVE", messages: 1, envelopes: 2, endpoints: 2, reports: 1 }, "chỉ còn báo cáo giữa A và quản trị");
    assert.equal((await h.call("GET", "/v1/messages/people", { sub: "dev_b" })).status, 404, "người đã xóa không còn là thành viên");
    assert.deepEqual(((await inbox(h, a1)).body.threads as { thread_id: string }[]).map((t) => t.thread_id), [t2], "A không còn thấy hội thoại với người đã xóa");
    assert.deepEqual((await h.call("GET", "/v1/messages/people")).body.people.map((p: { user_id: string }) => p.user_id), ["dev_ops"]);
    assert.equal(journalTypes(h).at(-1), "member_deleted");
    // Bản đã giao nằm trên thiết bị của người kia và ở lại đó (thiết kế mục 7): máy chủ không với tới, kiểm thử này không kiểm được.

    // Restore bản sao lưu chụp trước khi xóa: dữ liệu sống lại trong tệp sổ, rồi dòng member_deleted của sổ thu hồi xóa lại.
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    assert.equal(count(h, "msg_endpoints", "user_id = 'dev_b'"), 1, "bản restore còn dữ liệu cũ");
    assert.ok(applyRevocations(h.app.ctx).applied >= 1);
    gone("sau restore và nạp lại sổ thu hồi");
    assert.deepEqual(others(), { thread: "THREAD_ACTIVE", messages: 1, envelopes: 2, endpoints: 2, reports: 1 });
  } finally {
    await h.close();
  }
});

test("restore: gỡ thiết bị, chặn, bỏ chặn và rút đồng ý sau bản sao lưu được nạp lại từ sổ thu hồi đúng thứ tự; hội thoại đã mở lại trước bản sao lưu không bị chặn oan; nạp lần hai không đổi gì", async () => {
  const h = await harness();
  try {
    const { a: [a1], b: [b1], thread: t1 } = await pair(h);
    const a2 = await device(h, "dev_a", "PHONE");
    await consent(h, "dev_ops");
    const o1 = await device(h, "dev_ops");
    const t2 = await openThread(h, "dev_a", "dev_ops");
    // Trước bản sao lưu: B chặn A, bỏ chặn, mời lại, A chấp nhận. Hai dòng cũ này của sổ thu hồi không được áp lại lên bản restore.
    for (const [op, sub] of [["block", "dev_b"], ["unblock", "dev_b"]] as const) assert.equal((await h.call("POST", `/v1/messages/threads/${t1}/${op}`, { sub })).status, 200);
    assert.equal((await h.call("POST", "/v1/messages/threads", { sub: "dev_b", body: { peer: "dev_a" } })).status, 201);
    assert.equal((await h.call("POST", `/v1/messages/threads/${t1}/accept`, {})).body.state, "THREAD_ACTIVE");
    const m1 = await sendText(h, b1, t1, "B gửi A trước bản sao lưu");
    assert.equal(count(h, "msg_envelopes", "message_id = ?", m1.res.body.message_id), 3);
    const backupPath = join(h.dir, "backup.db");
    backupLedger(h.app.ctx, backupPath);
    const base = journalTypes(h).length;
    assert.deepEqual(journalTypes(h), ["thread_blocked", "thread_unblocked"]);

    // Sau bản sao lưu.
    assert.equal((await h.call("POST", `/v1/messages/endpoints/${a2.endpoint_id}/revoke`, {})).status, 200);
    assert.equal((await h.call("POST", `/v1/messages/threads/${t1}/block`, { sub: "dev_b" })).status, 200);
    assert.equal((await h.call("POST", `/v1/messages/threads/${t2}/block`, { sub: "dev_ops" })).status, 200);
    assert.equal((await h.call("POST", `/v1/messages/threads/${t2}/unblock`, { sub: "dev_ops" })).status, 200);
    const made = await h.call("POST", "/v1/messages/threads", { sub: "dev_b", body: { peer: "dev_ops" } });
    assert.equal(made.status, 201);
    const t3 = made.body.thread_id as string;
    assert.equal((await h.call("POST", `/v1/messages/threads/${t3}/block`, { sub: "dev_ops" })).status, 200);
    assert.equal((await h.call("POST", "/v1/consents/messaging/withdraw", {})).status, 200);
    assert.deepEqual(journalTypes(h, base), ["endpoint_revoked", "thread_blocked", "thread_blocked", "thread_unblocked", "thread_blocked", "consent_withdrawn"]);
    const live = snapshot(h);
    assert.deepEqual(live.threads.map((t) => [t.id, t.state, t.blocked_by, t.reopen_by]).sort(), [[t1, "THREAD_BLOCKED", "dev_b", null], [t2, "THREAD_CLOSED", null, "dev_ops"], [t3, "THREAD_BLOCKED", "dev_ops", null]].sort());
    assert.deepEqual(live.envelopes, [{ message_id: m1.res.body.message_id, endpoint_id: b1.endpoint_id }], "chỉ còn bản của chính B");

    // Sự cố: sổ được thay bằng bản sao lưu, quên mọi thứ ở trên.
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    assert.equal(count(h, "msg_endpoints", "status = 'ACTIVE'"), 4, "bản restore: thiết bị đã gỡ lại đang dùng");
    assert.equal(threadRow(h, t1)!.state, "THREAD_ACTIVE", "bản restore: lệnh chặn đã mất");
    assert.equal(threadRow(h, t3), undefined, "bản restore: hội thoại lập sau bản sao lưu không có");
    assert.equal(count(h, "msg_envelopes", "endpoint_id = ?", a2.endpoint_id), 1, "bản restore: thiết bị đã gỡ lại có tin chờ");

    const entries = journalTypes(h).length;
    const first = applyRevocations(h.app.ctx);
    assert.ok(first.applied >= 6, JSON.stringify(first));
    assert.deepEqual(snapshot(h), live, "sau khi nạp lại: đúng trạng thái trước sự cố");
    assert.equal((await inbox(h, a2)).status, 403, "A đã rút đồng ý");
    assert.equal((await h.call("GET", `/v1/messages/threads/${t1}/keys`, { sub: "dev_b" })).body.code, "RECIPIENT_UNAVAILABLE");
    assert.equal((await h.call("POST", "/v1/messages/threads", { sub: "dev_b", body: { peer: "dev_ops" } })).status, 404, "hội thoại dựng lại từ sổ thu hồi vẫn chặn");
    // Lặp lại an toàn và không ghi thêm vào sổ thu hồi.
    const second = applyRevocations(h.app.ctx);
    assert.equal(second.applied, 0);
    assert.deepEqual(snapshot(h), live);
    assert.equal(journalTypes(h).length, entries);
    assert.ok(o1.endpoint_id);
  } finally {
    await h.close();
  }
});

test("xuất dữ liệu: phần nhắn tin chỉ có siêu dữ liệu của chính người đó, không khóa, không bản mã, không thiết bị của người khác; người chưa dùng nhắn tin không có phần này", async () => {
  // Lõi bỏ qua phần mà hook trả undefined, nên tệp xuất của người chưa dùng nhắn tin giữ nguyên dạng 0.1.0.
  const h = await harness({ modules: [messaging] });
  try {
    assert.equal(messaging.privacy?.exportFor, exportMessagingFor, "mô-đun đăng ký đã nối phần xuất");
    assert.equal(exportMessagingFor(h.app.ctx, WS, "dev_a"), undefined, "chưa từng dùng nhắn tin");
    const { a: [a1], b: [b1], thread } = await pair(h);
    const a2 = await device(h, "dev_a", "PHONE");
    await h.call("POST", `/v1/messages/endpoints/${a2.endpoint_id}/revoke`, {});
    const s1 = await sendText(h, a1, thread, "tin không được có trong tệp xuất");
    const s2 = await sendText(h, b1, thread, "tin của người kia");
    await h.call("POST", "/v1/messages/reports", { body: { thread_id: thread, reason: "SPAM" } });
    await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "HARASSMENT" } });

    const ex = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
    assert.equal(ex.status, 202, JSON.stringify(ex.body));
    const file = (await h.call("GET", ex.body.export.path)).body;
    const part = file.modules.messaging;
    assert.deepEqual(part, JSON.parse(JSON.stringify(exportMessagingFor(h.app.ctx, WS, "dev_a"))));
    assert.deepEqual(Object.keys(part).sort(), ["endpoints", "messages", "reports", "scope", "threads"]);
    assert.deepEqual(part.endpoints.map((e: { endpoint_id: string; kind: string; status: string }) => [e.endpoint_id, e.kind, e.status]).sort(), [[a1.endpoint_id, "LAPTOP", "ACTIVE"], [a2.endpoint_id, "PHONE", "REVOKED"]].sort());
    assert.deepEqual(part.threads.map((t: Record<string, unknown>) => [t.thread_id, t.state, t.peer_user_id, t.role]), [[thread, "THREAD_ACTIVE", "dev_b", "REQUESTER"]]);
    assert.deepEqual(part.messages.map((m: Record<string, unknown>) => [m.message_id, m.seq, m.direction]), [[s1.res.body.message_id, 1, "SENT"], [s2.res.body.message_id, 2, "RECEIVED"]]);
    assert.equal(part.reports.length, 1, "chỉ báo cáo do chính người đó gửi; báo cáo về họ không lộ ai đã báo");
    const text = JSON.stringify(file);
    for (const secret of [a1.public_key, b1.public_key, b1.endpoint_id, s1.body.ct, s1.body.iv, s1.body.envelopes[0].wrapped, s1.body.envelopes[0].enc, s1.body.client_ref, "tin không được có"]) {
      assert.ok(!text.includes(secret), `tệp xuất không chứa ${secret.slice(0, 16)}…`);
    }
    for (const k of ["public_key", "key_id", "iv", "ct", "enc", "wrapped", "client_ref"]) assert.ok(!text.includes(`"${k}"`), `không có trường ${k}`);
    // Người bị chặn xuất dữ liệu cũng chỉ thấy «đã đóng».
    await h.call("POST", `/v1/messages/threads/${thread}/block`, { sub: "dev_b" });
    assert.equal((exportMessagingFor(h.app.ctx, WS, "dev_a") as { threads: { state: string }[] }).threads[0].state, "THREAD_CLOSED");
    assert.equal((exportMessagingFor(h.app.ctx, WS, "dev_b") as { threads: { state: string }[] }).threads[0].state, "THREAD_BLOCKED");
  } finally {
    await h.close();
  }
});

test("máy chủ không bao giờ có bản rõ: sau trọn một hành trình, dấu bản rõ không nằm trong sổ, WAL, sổ thu hồi, barrier, bản sao lưu, phản hồi API, số đo hay phần xuất", async () => {
  const MARKER = "ZQX7-BANRO-4F1C9E2D-KHONG-DUOC-LO";
  const h = await harness();
  try {
    const { a: [a1, a2], b: [b1, b2], thread } = await pair(h, 2);
    const text = `Mã két là ${MARKER}, đừng nói với ai 🤫`;
    const s = await sendText(h, a1, thread, text);
    assert.equal(s.res.status, 201);
    const id = s.res.body.message_id as string;
    const seen: unknown[] = [s.res.body];
    for (const d of [a1, a2, b1, b2]) {
      const box = await inbox(h, d);
      seen.push(box.body);
      assert.equal(await open(d, box.body.messages[0], a1), text, "dấu có thật trong tin: thiết bị nhận mở ra đúng chữ");
    }
    seen.push((await ack(h, b1, [id])).body);
    seen.push((await h.call("POST", `/v1/messages/threads/${thread}/read`, { sub: "dev_b", body: { through_seq: 1, share: true } })).body);
    seen.push((await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "OTHER", message_id: id } })).body);
    // Lời từ chối cũng không được để lại chữ: thân mang đúng dấu ở một trường lạ, có Idempotency-Key hợp lệ.
    const sealed = await seal(h, a1, thread, text);
    const refused = [
      await post(h, a1, thread, { ...sealed, text }),
      await h.call("POST", "/v1/messages/reports", { sub: "dev_b", body: { thread_id: thread, reason: "OTHER", note: text } }),
      await h.call("POST", "/v1/messages/threads", { sub: "dev_ops", body: { peer: "dev_a", text } }),
    ];
    for (const r of refused) {
      assert.ok(r.status === 400 || r.status === 403, JSON.stringify(r.body));
      seen.push(r.body);
    }
    assert.equal((await post(h, a1, thread, sealed)).status, 201, "cùng thân đó không có trường lạ thì được nhận");
    // Các thao tác ghi sổ thu hồi, audit và sao lưu.
    await h.call("POST", `/v1/messages/endpoints/${a2.endpoint_id}/revoke`, {});
    await h.call("POST", `/v1/messages/threads/${thread}/block`, { sub: "dev_b" });
    seen.push(exportMessagingFor(h.app.ctx, WS, "dev_a"), exportMessagingFor(h.app.ctx, WS, "dev_b"));
    seen.push((await h.call("GET", "/v1/ops/messages/reports", { sub: "dev_ops" })).body);
    const metrics = await h.call("GET", "/v1/ops/metrics", { sub: "dev_ops" });
    assert.equal(metrics.status, 200);
    assert.doesNotMatch(JSON.stringify(metrics.body), /th_|mep_|msg_|rp_|dev_a|dev_b/, "số đo vận hành không mang mã hội thoại, thiết bị, tin hay người");
    seen.push(metrics.body);
    backupLedger(h.app.ctx, join(h.dir, "backup.db"));
    await h.app.tick();
    assert.ok(!JSON.stringify(seen).includes(MARKER), "không phản hồi nào của máy chủ mang bản rõ");

    // Quét byte mọi tệp trong thư mục dữ liệu, ở cả UTF-8 và UTF-16. Đối chứng: cùng phép quét tìm thấy mã hội thoại và mã thiết bị.
    const files = readdirSync(h.dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => join(f.parentPath, f.name));
    const names = files.map((f) => f.slice(h.dir.length + 1));
    for (const must of ["ledger.db", "ledger.db-wal", "revocations.jsonl", "barrier.jsonl", "backup.db"]) assert.ok(names.includes(must), `thư mục dữ liệu có ${must}: ${names.join(", ")}`);
    const hits = (needle: string) => files.filter((f) => {
      const buf = readFileSync(f);
      return buf.includes(Buffer.from(needle, "utf8")) || buf.includes(Buffer.from(needle, "utf16le"));
    }).map((f) => f.slice(h.dir.length + 1));
    assert.deepEqual(hits(MARKER), [], "bản rõ không nằm trong tệp nào");
    assert.deepEqual(hits("Mã két"), []);
    assert.ok(hits(thread).some((f) => f.startsWith("ledger.db")), "đối chứng: sổ có mã hội thoại");
    assert.ok(hits(s.body.ct).some((f) => f.startsWith("ledger.db")), "đối chứng: sổ có bản mã");
    assert.ok(hits(a2.endpoint_id).includes("revocations.jsonl"), "đối chứng: sổ thu hồi có mã thiết bị đã gỡ");
    assert.ok(hits(a2.endpoint_id).includes("backup.db") && hits(thread).includes("backup.db"), "đối chứng: bản sao lưu được quét");
  } finally {
    await h.close();
  }
});

test("LeLe không có đường nào tới tin nhắn: lele.ts không nạp, không gọi và không nhắc tới nhắn tin; mô-đun nhắn tin và mật mã không nhắc tới LeLe", () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const lele = read("src/server/lele.ts");
  assert.doesNotMatch(lele, /messaging|msg[_-]|\/v1\/messages|MsgSend|msg_messages/i);
  assert.doesNotMatch(lele, /from "\.\/(store|messaging|modules)\.ts"/, "lele.ts không đọc sổ nên không đọc được hộp thư");
  for (const p of ["src/server/messaging.ts", "src/server/migrations/0003_messaging.ts", "web/shared/msg-crypto.js", "web/shared/msg-outbox.js"]) {
    const src = read(p).split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    assert.doesNotMatch(src, /lele/i, `${p}: mã chạy không nhắc tới LeLe`);
  }
  // Hợp đồng: không schema nào của LeLe tham chiếu schema nhắn tin.
  const api = JSON.parse(read("contracts/openapi.json")) as { components: { schemas: Record<string, unknown> } };
  for (const [name, schema] of Object.entries(api.components.schemas)) if (/lele/i.test(name)) assert.doesNotMatch(JSON.stringify(schema), /Msg[A-Z]|messages/, name);
});
