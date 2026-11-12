// Trợ giúp cho kiểm thử nhắn tin: «thiết bị» ở đây là một cặp khóa P-256 tạo trong tiến trình kiểm thử cùng khóa đã ghim của
// các thiết bị khác, làm đúng những việc trình duyệt làm (lấy khóa, tự tính lại key_set, niêm phong, gửi, mở). Không có máy thật.
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { uuid } from "../src/core/crypto.ts";
import { nowIso } from "../src/server/context.ts";
import { one, run } from "../src/server/store.ts";
import { generateEndpointKey, keySetDigest, openMessage, sealMessage, type MsgSendBody } from "../web/shared/msg-crypto.js";
import { key, WS, type Harness } from "./helpers.ts";

export interface Device {
  sub: string;
  endpoint_id: string;
  privateKey: CryptoKey;
  public_key: string;
}

export interface InboxMessage {
  message_id: string; thread_id: string; seq: number; sender_user: string; sender_endpoint: string; client_ref: string; iv: string; ct: string; enc: string; wrapped: string; sent_at: string;
}

export const clientRef = () => randomBytes(18).toString("base64url");

export const consent = (h: Harness, sub: string, purpose = "messaging", choice: "GRANTED" | "DECLINED" = "GRANTED") =>
  h.call("POST", "/v1/consents", { sub, body: { purpose_id: purpose, text_version: "v1", text_hash: "A".repeat(43), choice } });

/** Đăng ký một điểm nhận tin mới cho `sub` với một cặp khóa vừa tạo (khóa riêng không xuất được, như trên trình duyệt). */
export async function device(h: Harness, sub: string, kind = "LAPTOP"): Promise<Device> {
  const k = await generateEndpointKey();
  const r = await h.call("POST", "/v1/messages/endpoints", { sub, body: { public_key: k.public_key, kind } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { sub, endpoint_id: r.body.endpoint_id as string, ...k };
}

/** Mời rồi chấp nhận: một hội thoại đang mở giữa hai người đã đồng ý và có thiết bị. */
export async function openThread(h: Harness, a = "dev_a", b = "dev_b"): Promise<string> {
  const req = await h.call("POST", "/v1/messages/threads", { sub: a, body: { peer: b } });
  assert.equal(req.status, 201, JSON.stringify(req.body));
  const acc = await h.call("POST", `/v1/messages/threads/${req.body.thread_id}/accept`, { sub: b });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.equal(acc.body.state, "THREAD_ACTIVE");
  return req.body.thread_id as string;
}

/** Hai người đã đồng ý, mỗi người `perUser` thiết bị, và một hội thoại đang mở. */
export async function pair(h: Harness, perUser = 1, a = "dev_a", b = "dev_b") {
  await consent(h, a);
  await consent(h, b);
  const as: Device[] = [];
  const bs: Device[] = [];
  for (let i = 0; i < perUser; i++) {
    as.push(await device(h, a, i ? "PHONE" : "LAPTOP"));
    bs.push(await device(h, b, i ? "TABLET" : "DESKTOP"));
  }
  return { a: as, b: bs, thread: await openThread(h, a, b) };
}

/** Lấy tập khóa của hội thoại và tự tính lại key_set như thiết bị thật, trước khi tin vào nó. */
export async function keysOf(h: Harness, d: Device, thread: string) {
  const r = await h.call("GET", `/v1/messages/threads/${thread}/keys`, { sub: d.sub });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await keySetDigest(thread, r.body.endpoints), r.body.key_set, "máy chủ và thiết bị tính cùng một key_set");
  return r.body as { thread_id: string; endpoints: { endpoint_id: string; user_id: string; public_key: string }[]; key_set: string };
}

/** Niêm phong một tin cho tập khóa hiện hành. */
export async function seal(h: Harness, d: Device, thread: string, text: string, ref = clientRef()): Promise<MsgSendBody> {
  const ks = await keysOf(h, d, thread);
  return sealMessage({ text, thread_id: thread, client_ref: ref, key_set: ks.key_set, sender: { endpoint_id: d.endpoint_id, privateKey: d.privateKey, public_key: d.public_key }, recipients: ks.endpoints });
}

export const post = (h: Harness, d: Device, thread: string, body: unknown, k = key()) => h.call("POST", `/v1/messages/threads/${thread}/messages`, { sub: d.sub, body, key: k });

/** Niêm phong và gửi; trả phản hồi cùng thân và khóa đã dùng (để phát lại đúng byte cũ). */
export async function sendText(h: Harness, d: Device, thread: string, text: string) {
  const body = await seal(h, d, thread, text);
  const k = key();
  const res = await post(h, d, thread, body, k);
  return { res, body, key: k };
}

export const inbox = (h: Harness, d: Device, etag?: string) => h.call("GET", `/v1/messages/inbox?endpoint=${d.endpoint_id}${etag ? `&etag=${etag}` : ""}`, { sub: d.sub });
export const ack = (h: Harness, d: Device, ids: string[]) => h.call("POST", "/v1/messages/ack", { sub: d.sub, body: { endpoint_id: d.endpoint_id, message_ids: ids } });
export const pending = async (h: Harness, d: Device) => ((await inbox(h, d)).body.messages ?? []) as InboxMessage[];

/** Mở một tin trong hộp thư bằng khóa của thiết bị này và khóa ĐÃ GHIM của thiết bị gửi. */
export async function open(d: Device, m: InboxMessage, sender: Device) {
  assert.equal(m.sender_endpoint, sender.endpoint_id);
  return (await openMessage({ thread_id: m.thread_id, message: m, recipient: d, sender_public_key: sender.public_key })).text;
}

/** Thêm một thành viên tổng hợp đã có quyền messaging.use, đã đồng ý và có một điểm nhận tin (để thử danh bạ và giới hạn). */
export async function addMember(h: Harness, sub: string, name = `Thử nghiệm ${sub}`) {
  const ctx = h.app.ctx;
  const at = nowIso(ctx);
  if (!one(ctx.db, "SELECT 1 FROM members WHERE workspace_id = ? AND user_id = ?", WS, sub)) {
    run(ctx.db, "INSERT INTO members (workspace_id, user_id, display_name, roles, status) VALUES (?, ?, ?, '[\"MEMBER\"]', 'ACTIVE')", WS, sub, name);
    run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, ?, 'messaging.use', NULL, 'ACTIVE', ?)", `gr_${uuid()}`, WS, sub, at);
  }
  await consent(h, sub);
  return device(h, sub);
}

export const count = (h: Harness, table: string, where = "1 = 1", ...args: (string | number)[]) => (one<{ n: number }>(h.app.ctx.db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args) as { n: number }).n;
export const threadRow = (h: Harness, id: string) => one<{ state: string; requested_by: string; blocked_by: string | null; reopen_by: string | null; last_seq: number; revision: number; journal_seq: number }>(h.app.ctx.db, "SELECT * FROM msg_threads WHERE id = ?", id);
