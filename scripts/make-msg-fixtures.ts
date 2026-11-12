// Sinh lại fixture của LNH-MSG-1 (contracts/fixtures/msg/lnh-msg-1.json). Chỉ chạy khi đổi fixture có chủ đích:
//   node scripts/make-msg-fixtures.ts
// Đổi định dạng thì phải đổi tên lược đồ (LNH-MSG-1 → LNH-MSG-2): app iOS/Android và các thiết bị đang chạy đều dựa vào từng byte.
//
// Mọi khóa trong fixture là KHÓA THỬ CÔNG KHAI, suy ra từ một nhãn bằng SHA-256 (ai cũng tính lại được), không bảo vệ thứ gì và
// không bao giờ được dùng ngoài kiểm thử. Khóa nội dung, IV và khóa tạm cũng cố định, điều mà mã thật không bao giờ làm.
import { createECDH, createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { canonicalize } from "../web/shared/jcs.js";
import { MSG_SCHEME, encodeContent, endpointKeyId, importKeyPair, keySetDigest, messageAad, safetyCode, sealMessage, toBase64url } from "../web/shared/msg-crypto.js";

const sha = (label: string) => new Uint8Array(createHash("sha256").update(label, "utf8").digest());

/** Cặp khóa P-256 có số vô hướng d = SHA-256("LNH-MSG-1 fixture key: " + nhãn). */
function keyFromLabel(label: string) {
  const d = sha(`${MSG_SCHEME} fixture key: ${label}`);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  return { d: toBase64url(d), public_key: toBase64url(new Uint8Array(ecdh.getPublicKey())) };
}

const ENDPOINTS = [
  { name: "a1", endpoint_id: "mep_00000000-0000-4000-8000-0000000000a1", user_id: "dev_a" },
  { name: "a2", endpoint_id: "mep_00000000-0000-4000-8000-0000000000a2", user_id: "dev_a" },
  { name: "b1", endpoint_id: "mep_00000000-0000-4000-8000-0000000000b1", user_id: "dev_b" },
  { name: "b2", endpoint_id: "mep_00000000-0000-4000-8000-0000000000b2", user_id: "dev_b" },
];
const THREAD = "th_00000000-0000-4000-8000-00000000ab01";

const CASES = [
  { name: "van-ban-tieng-viet", sender: "a1", recipients: ["a1", "a2", "b1", "b2"], client_ref: "fixture-ref-0001-AAAAAAAAAA", text: "Xin chào, đây là tin thử số 1 của fixture LNH-MSG-1." },
  { name: "ngoai-bmp-va-xuong-dong", sender: "b2", recipients: ["a1", "b1", "b2"], client_ref: "fixture-ref-0002-AAAAAAAAAA", text: "Dòng một 👋🏽\nDòng hai: 𠮷野家, ½, “ngoặc kép”, \\ và \"" },
  // 231 ký tự ASCII: nội dung JCS dài đúng 256 byte, nên phần đệm chiếm trọn một khối nữa (512 byte).
  { name: "tron-mot-khoi", sender: "a2", recipients: ["a2", "b1"], client_ref: "fixture-ref-0003-AAAAAAAAAA", text: "k".repeat(231) },
];

const keys: Record<string, { endpoint_id: string; user_id: string; d: string; public_key: string; key_id: string }> = {};
for (const e of ENDPOINTS) {
  const k = keyFromLabel(`endpoint ${e.name}`);
  keys[e.name] = { endpoint_id: e.endpoint_id, user_id: e.user_id, ...k, key_id: await endpointKeyId(k.public_key) };
}
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

const cases = [];
for (const c of CASES) {
  const sender = keys[c.sender];
  const entries = c.recipients.map((n) => ({ endpoint_id: keys[n].endpoint_id, user_id: keys[n].user_id, public_key: keys[n].public_key }));
  const key_set = await keySetDigest(THREAD, entries);
  const content_key = sha(`${MSG_SCHEME} fixture content key: ${c.name}`);
  const iv = sha(`${MSG_SCHEME} fixture iv: ${c.name}`).slice(0, 12);
  const ephemeral: Record<string, { d: string; public_key: string }> = {};
  const ephemeralKeys: Record<string, Awaited<ReturnType<typeof importKeyPair>>> = {};
  for (const n of c.recipients) {
    const k = keyFromLabel(`ephemeral ${c.name} ${n}`);
    ephemeral[keys[n].endpoint_id] = k;
    ephemeralKeys[keys[n].endpoint_id] = await importKeyPair(b64(k.d), k.public_key);
  }
  const senderKey = await importKeyPair(b64(sender.d), sender.public_key);
  const request = await sealMessage({
    text: c.text, thread_id: THREAD, client_ref: c.client_ref, key_set,
    sender: { endpoint_id: sender.endpoint_id, privateKey: senderKey.privateKey, public_key: sender.public_key },
    recipients: entries, fixed: { content_key, iv, ephemeral: ephemeralKeys },
  });
  cases.push({
    name: c.name,
    input: { thread_id: THREAD, client_ref: c.client_ref, text: c.text, sender: c.sender, recipients: c.recipients, content_key: toBase64url(content_key), iv: toBase64url(iv), ephemeral },
    expected: {
      content_json: canonicalize({ text: c.text, type: "text" }),
      padded_bytes: encodeContent(c.text).length,
      aad: new TextDecoder().decode(messageAad({ thread_id: THREAD, sender_endpoint: sender.endpoint_id, client_ref: c.client_ref })),
      key_set,
      safety_code: await safetyCode("dev_a", "dev_b", entries),
      request,
    },
  });
}

const doc = {
  scheme: MSG_SCHEME,
  note: "Fixture của LNH-MSG-1 (LNH-T31), mô tả định dạng ở đầu web/shared/msg-crypto.js. Mọi khóa ở đây là khóa thử công khai: d = SHA-256(\"LNH-MSG-1 fixture key: <nhãn>\"), không bảo vệ thứ gì. Khóa nội dung, IV và khóa tạm được cố định chỉ để kết quả lặp lại được; mã thật luôn lấy ngẫu nhiên. Chuỗi nhị phân là base64url không padding. Sinh lại bằng node scripts/make-msg-fixtures.ts.",
  keys,
  cases,
};
writeFileSync(new URL("../contracts/fixtures/msg/lnh-msg-1.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log(`đã ghi contracts/fixtures/msg/lnh-msg-1.json: ${cases.length} ca, ${Object.keys(keys).length} khóa thử`);
