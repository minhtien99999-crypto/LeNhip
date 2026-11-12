// @ts-check
// LNH-MSG-1: mã hóa đầu cuối cho tin nhắn 1:1 giữa hai thành viên (LNH-T31). Chạy bằng WebCrypto trong trình duyệt và Node 22,
// không thư viện. App iOS/Android phải cho đúng từng byte của contracts/fixtures/msg/lnh-msg-1.json.
//
// Định dạng (mọi chuỗi nhị phân trên dây là base64url không padding):
//   nội dung    JCS của {"text": <chuỗi>, "type": "text"} (RFC 8785, web/shared/jcs.js), UTF-8. Chuỗi có 1–2.000 điểm mã, không
//               surrogate lẻ, không chuẩn hóa thêm.
//   đệm         nội dung ‖ 0x80 ‖ 0x00… cho tới bội số kế tiếp của 256 byte (luôn có ít nhất một byte đệm; tối đa 12.032 byte).
//   AAD         JCS của {"client_ref", "sender_endpoint", "thread_id", "v": "LNH-MSG-1"}, UTF-8.
//   mã hóa      AES-256-GCM, khóa nội dung 32 byte và IV 12 byte ngẫu nhiên cho từng tin; `ct` = bản mã ‖ thẻ 16 byte.
//   niêm phong  khóa nội dung được niêm phong riêng cho từng điểm nhận tin bằng HPKE (RFC 9180) một lần gửi, chế độ xác thực
//               mode_auth (0x02), DHKEM(P-256, HKDF-SHA256) (0x0010), HKDF-SHA256 (0x0001), AES-256-GCM (0x0002);
//               info = UTF-8 "LNH-MSG-1", aad = AAD của tin, bản rõ = khóa nội dung. Khóa người gửi là khóa của điểm nhận tin
//               đang gửi, nên bên nhận kiểm được thiết bị nào đã gửi. Kết quả: `enc` (khóa tạm, 65 byte) và `wrapped` (48 byte).
//   khóa        P-256, khóa công khai ở dạng điểm không nén 65 byte (0x04 ‖ X ‖ Y); key_id = SHA-256 của 65 byte đó.
//   key_set     SHA-256 của JCS {"endpoints": [{"endpoint_id","public_key","user_id"}… xếp theo endpoint_id], "thread_id", "v"}.
//   mã an toàn  30 chữ số từ tập khóa của hai người (safetyCode bên dưới); hai người so với nhau ngoài LeNhip.
//
// Giới hạn nói rõ (LNH-T31): máy chủ phát mã nguồn web, nên E2EE chặn việc đọc ở máy chủ, không chặn người vận hành sửa mã.
// Không có bí mật chuyển tiếp: ai lấy được khóa riêng của một thiết bị thì mở được các phong bì còn nằm ở máy chủ (LNH-D20).
// Không văn bản đã dịch nào đi vào đây: lỗi chỉ mang mã (MsgCryptoError.code), giao diện dựng câu từ mã.

import { base64url, canonicalize, isWellFormed } from "./jcs.js";

/** @typedef {Uint8Array<ArrayBuffer>} Bytes */
/** @typedef {{ endpoint_id: string, enc: string, wrapped: string }} MsgEnvelope */
/** @typedef {{ client_ref: string, sender_endpoint: string, key_set: string, iv: string, ct: string, envelopes: MsgEnvelope[] }} MsgSendBody */
/** @typedef {{ endpoint_id: string, user_id: string, public_key: string }} MsgKeyEntry */
/** @typedef {{ privateKey: CryptoKey, public_key: string }} MsgKeyPair */

export const MSG_SCHEME = "LNH-MSG-1";

export const MSG_LIMITS = Object.freeze({
  /** Số điểm mã Unicode tối đa của một tin (LNH-T33). */
  textCodePoints: 2000,
  /** Nội dung được đệm tới bội số của ngần này byte. */
  block: 256,
  /** 2.000 điểm mã × 6 byte (dạng \u00XX của JSON) + 25 byte khung + 1 byte đệm, làm tròn lên bội số của 256. */
  maxPaddedBytes: 12032,
  tagBytes: 16,
  ivBytes: 12,
  keyBytes: 32,
  publicKeyBytes: 65,
  /** Khóa nội dung 32 byte + thẻ 16 byte. */
  wrappedBytes: 48,
  /** Mỗi thành viên tối đa 5 điểm nhận tin (LNH-T30), nên một tin có tối đa 10 phong bì. */
  maxEnvelopes: 10,
});

/**
 * Lỗi của LNH-MSG-1. `code` là một trong: TEXT_EMPTY, TEXT_TOO_LONG, TEXT_MALFORMED, ENCODING, KEY_INVALID, FIELD_INVALID,
 * RECIPIENTS, KEY_SET, OPEN_FAILED, PADDING, CONTENT_INVALID. Không có câu chữ cho người dùng ở đây.
 */
export class MsgCryptoError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "MsgCryptoError";
    this.code = code;
  }
}

const te = new TextEncoder();
const EMPTY = new Uint8Array(0);

/** @returns {SubtleCrypto} */
const subtle = () => globalThis.crypto.subtle;

/**
 * @param {...Uint8Array} parts
 * @returns {Bytes}
 */
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * @param {number} n
 * @param {number} len
 * @returns {Bytes}
 */
function i2osp(n, len) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = n & 255;
    n = Math.floor(n / 256);
  }
  return out;
}

/**
 * Giải base64url chặt: đúng bảng chữ, không padding, mã hóa lại phải ra đúng chuỗi (chặn bit thừa ở ký tự cuối).
 * @param {string} s
 * @returns {Bytes}
 */
export function fromBase64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new MsgCryptoError("ENCODING");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (base64url(out) !== s) throw new MsgCryptoError("ENCODING");
  return out;
}

export const toBase64url = base64url;

/**
 * @param {Bytes} data
 * @returns {Promise<Bytes>}
 */
async function sha256(data) {
  return new Uint8Array(await subtle().digest("SHA-256", data));
}

/**
 * @param {unknown} value
 * @returns {Promise<string>}
 */
async function digestOf(value) {
  return base64url(await sha256(te.encode(canonicalize(value))));
}

/**
 * @param {unknown} v
 * @param {string} code
 * @returns {string}
 */
function field(v, code = "FIELD_INVALID") {
  if (typeof v !== "string" || v.length === 0 || v.length > 256 || !isWellFormed(v)) throw new MsgCryptoError(code);
  return v;
}

// ── Khóa ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Khóa công khai trên dây → 65 byte điểm không nén. Chỉ kiểm dạng; điểm có nằm trên đường cong hay không do WebCrypto kiểm khi nhập.
 * @param {string} publicKey
 * @returns {Bytes}
 */
export function publicKeyBytes(publicKey) {
  /** @type {Bytes} */
  let raw;
  try {
    raw = fromBase64url(publicKey);
  } catch {
    throw new MsgCryptoError("KEY_INVALID");
  }
  if (raw.length !== MSG_LIMITS.publicKeyBytes || raw[0] !== 4) throw new MsgCryptoError("KEY_INVALID");
  return raw;
}

/**
 * @param {Bytes} raw
 * @returns {Promise<CryptoKey>}
 */
async function importPublic(raw) {
  if (raw.length !== MSG_LIMITS.publicKeyBytes || raw[0] !== 4) throw new MsgCryptoError("KEY_INVALID");
  try {
    return await subtle().importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []);
  } catch {
    throw new MsgCryptoError("KEY_INVALID");
  }
}

/**
 * Tạo cặp khóa của một điểm nhận tin. Khóa riêng không xuất được: nó chỉ sống trong kho khóa của trình duyệt (IndexedDB) và
 * không bao giờ rời thiết bị.
 * @returns {Promise<MsgKeyPair>}
 */
export async function generateEndpointKey() {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey: pair.privateKey, public_key: base64url(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))) };
}

/**
 * Nhập một khóa riêng từ số vô hướng `d` (32 byte) và khóa công khai của nó. Chỉ dùng cho vector kiểm thử và fixture: khóa của
 * người dùng luôn được tạo bằng generateEndpointKey() và không xuất được.
 * @param {Bytes} d
 * @param {string} publicKey
 * @returns {Promise<MsgKeyPair>}
 */
export async function importKeyPair(d, publicKey) {
  const raw = publicKeyBytes(publicKey);
  if (d.length !== 32) throw new MsgCryptoError("KEY_INVALID");
  const jwk = { kty: "EC", crv: "P-256", d: base64url(d), x: base64url(raw.slice(1, 33)), y: base64url(raw.slice(33, 65)) };
  try {
    return { privateKey: await subtle().importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]), public_key: publicKey };
  } catch {
    throw new MsgCryptoError("KEY_INVALID");
  }
}

/**
 * key_id của một điểm nhận tin: SHA-256 của 65 byte khóa công khai. Máy chủ tính cùng giá trị khi đăng ký.
 * @param {string} publicKey
 * @returns {Promise<string>}
 */
export async function endpointKeyId(publicKey) {
  return base64url(await sha256(publicKeyBytes(publicKey)));
}

/**
 * @param {readonly MsgKeyEntry[]} endpoints
 * @returns {MsgKeyEntry[]}
 */
function normalizedEntries(endpoints) {
  if (!Array.isArray(endpoints)) throw new MsgCryptoError("KEY_SET");
  const seen = new Set();
  const out = endpoints.map((e) => {
    const entry = { endpoint_id: field(e?.endpoint_id, "KEY_SET"), public_key: field(e?.public_key, "KEY_SET"), user_id: field(e?.user_id, "KEY_SET") };
    publicKeyBytes(entry.public_key);
    if (seen.has(entry.endpoint_id)) throw new MsgCryptoError("KEY_SET");
    seen.add(entry.endpoint_id);
    return entry;
  });
  return out.sort((a, b) => (a.endpoint_id < b.endpoint_id ? -1 : a.endpoint_id > b.endpoint_id ? 1 : 0));
}

/**
 * Mã băm của tập khóa một hội thoại: mọi điểm nhận tin đang dùng của cả hai người. Thiết bị gửi kèm giá trị này trong mỗi tin;
 * máy chủ từ chối (KEYS_CHANGED) nếu tập khóa đã đổi, để không tin nào được niêm phong cho một danh sách thiết bị cũ.
 * @param {string} threadId
 * @param {readonly MsgKeyEntry[]} endpoints
 * @returns {Promise<string>}
 */
export async function keySetDigest(threadId, endpoints) {
  return digestOf({ endpoints: normalizedEntries(endpoints), thread_id: field(threadId, "KEY_SET"), v: MSG_SCHEME });
}

/**
 * Mã an toàn 30 chữ số của một cặp người: cả hai thấy cùng một mã khi và chỉ khi họ thấy cùng tập khóa của nhau. Mã đổi khi một
 * trong hai người thêm hoặc gỡ thiết bị. Không phụ thuộc mã hội thoại hay mã điểm nhận tin, chỉ phụ thuộc người và khóa.
 *   dấu vân tay(người) = SHA-256(JCS {"keys": [khóa công khai… xếp tăng dần], "user_id", "v"})
 *   mã = SHA-256("LNH-MSG-1/safety" ‖ dấu vân tay người có user_id nhỏ hơn ‖ dấu vân tay người kia);
 *        sáu nhóm, mỗi nhóm là 5 byte kế tiếp đọc như số nguyên không dấu, lấy dư cho 100000, viết đủ 5 chữ số.
 * @param {string} userA
 * @param {string} userB
 * @param {readonly MsgKeyEntry[]} endpoints
 * @returns {Promise<string>} 30 chữ số, không dấu cách (groupSafetyCode chia nhóm để hiển thị)
 */
export async function safetyCode(userA, userB, endpoints) {
  const a = field(userA, "KEY_SET");
  const b = field(userB, "KEY_SET");
  if (a === b) throw new MsgCryptoError("KEY_SET");
  const entries = normalizedEntries(endpoints);
  if (entries.some((e) => e.user_id !== a && e.user_id !== b)) throw new MsgCryptoError("KEY_SET");
  /** @param {string} user */
  const fingerprint = async (user) => {
    const keys = entries.filter((e) => e.user_id === user).map((e) => e.public_key).sort();
    if (!keys.length) throw new MsgCryptoError("KEY_SET");
    return sha256(te.encode(canonicalize({ keys, user_id: user, v: MSG_SCHEME })));
  };
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const h = await sha256(concat(te.encode(`${MSG_SCHEME}/safety`), await fingerprint(lo), await fingerprint(hi)));
  let out = "";
  for (let g = 0; g < 6; g++) {
    const o = g * 5;
    // 5 byte = 40 bit: vượt 32 bit nên tách byte cao ra, vẫn nằm trong khoảng số nguyên chính xác của Number.
    const n = h[o] * 4294967296 + (((h[o + 1] << 24) | (h[o + 2] << 16) | (h[o + 3] << 8) | h[o + 4]) >>> 0);
    out += String(n % 100000).padStart(5, "0");
  }
  return out;
}

/**
 * @param {string} code 30 chữ số
 * @returns {string[]} sáu nhóm năm chữ số
 */
export function groupSafetyCode(code) {
  if (!/^\d{30}$/.test(code)) throw new MsgCryptoError("FIELD_INVALID");
  return /** @type {string[]} */ (code.match(/\d{5}/g));
}

// ── Nội dung và đệm ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * @param {unknown} text
 * @returns {string}
 */
function checkText(text) {
  if (typeof text !== "string" || !isWellFormed(text)) throw new MsgCryptoError("TEXT_MALFORMED");
  if (text.length === 0) throw new MsgCryptoError("TEXT_EMPTY");
  // Đếm theo điểm mã: một ký tự ngoài BMP (hai đơn vị UTF-16) là một.
  if (text.length > MSG_LIMITS.textCodePoints * 2) throw new MsgCryptoError("TEXT_TOO_LONG");
  let n = 0;
  for (const _ of text) n++;
  if (n > MSG_LIMITS.textCodePoints) throw new MsgCryptoError("TEXT_TOO_LONG");
  return text;
}

/**
 * Nội dung đã đệm của một tin văn bản.
 * @param {string} text
 * @returns {Bytes}
 */
export function encodeContent(text) {
  const body = te.encode(canonicalize({ text: checkText(text), type: "text" }));
  const size = (Math.floor(body.length / MSG_LIMITS.block) + 1) * MSG_LIMITS.block;
  const out = new Uint8Array(size);
  out.set(body, 0);
  out[body.length] = 0x80;
  return out;
}

/**
 * Bỏ đệm và đọc nội dung. Chỉ nhận đúng dạng chuẩn: bất kỳ byte nào khác với JCS của nội dung đọc được đều bị từ chối.
 * @param {Bytes} padded
 * @returns {{ type: "text", text: string }}
 */
export function decodeContent(padded) {
  if (padded.length === 0 || padded.length % MSG_LIMITS.block !== 0 || padded.length > MSG_LIMITS.maxPaddedBytes) throw new MsgCryptoError("PADDING");
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x80 || padded.length - end > MSG_LIMITS.block) throw new MsgCryptoError("PADDING");
  /** @type {unknown} */
  let value;
  let json = "";
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(padded.subarray(0, end));
    value = JSON.parse(json);
  } catch {
    throw new MsgCryptoError("CONTENT_INVALID");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MsgCryptoError("CONTENT_INVALID");
  const o = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(o).length !== 2 || o.type !== "text" || typeof o.text !== "string") throw new MsgCryptoError("CONTENT_INVALID");
  try {
    checkText(o.text);
    if (canonicalize({ text: o.text, type: "text" }) !== json) throw new MsgCryptoError("CONTENT_INVALID");
  } catch {
    throw new MsgCryptoError("CONTENT_INVALID");
  }
  return { type: "text", text: o.text };
}

/**
 * AAD của một tin: gắn bản mã với hội thoại, thiết bị gửi và client_ref.
 * @param {{ thread_id: string, sender_endpoint: string, client_ref: string }} h
 * @returns {Bytes}
 */
export function messageAad(h) {
  return te.encode(canonicalize({ client_ref: field(h.client_ref), sender_endpoint: field(h.sender_endpoint), thread_id: field(h.thread_id), v: MSG_SCHEME }));
}

// ── HPKE (RFC 9180), một lần gửi, mode_auth, DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM ────────────────────────────

const KEM_SUITE = concat(te.encode("KEM"), i2osp(0x0010, 2));
const HPKE_SUITE = concat(te.encode("HPKE"), i2osp(0x0010, 2), i2osp(0x0001, 2), i2osp(0x0002, 2));
const HPKE_V1 = te.encode("HPKE-v1");
const MODE_AUTH = 0x02;
const HPKE_INFO = te.encode(MSG_SCHEME);

/**
 * @param {Bytes} key
 * @param {Bytes} data
 * @returns {Promise<Bytes>}
 */
async function hmac(key, data) {
  const k = await subtle().importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, data));
}

/**
 * HKDF-Extract. Muối rỗng là 32 byte 0 (RFC 5869), viết rõ vì WebCrypto không nhận khóa HMAC rỗng.
 * @param {Bytes} salt
 * @param {Bytes} ikm
 */
const extract = (salt, ikm) => hmac(salt.length ? salt : new Uint8Array(32), ikm);

/**
 * HKDF-Expand.
 * @param {Bytes} prk
 * @param {Bytes} info
 * @param {number} len
 * @returns {Promise<Bytes>}
 */
async function expand(prk, info, len) {
  /** @type {Bytes} */
  let t = new Uint8Array(0);
  /** @type {Bytes} */
  let out = new Uint8Array(0);
  for (let i = 1; out.length < len; i++) {
    t = await hmac(prk, concat(t, info, Uint8Array.of(i)));
    out = concat(out, t);
  }
  return out.slice(0, len);
}

/**
 * @param {Bytes} suite
 * @param {Bytes} salt
 * @param {string} label
 * @param {Bytes} ikm
 */
const labeledExtract = (suite, salt, label, ikm) => extract(salt, concat(HPKE_V1, suite, te.encode(label), ikm));

/**
 * @param {Bytes} suite
 * @param {Bytes} prk
 * @param {string} label
 * @param {Bytes} info
 * @param {number} len
 */
const labeledExpand = (suite, prk, label, info, len) => expand(prk, concat(i2osp(len, 2), HPKE_V1, suite, te.encode(label), info), len);

/**
 * @param {CryptoKey} privateKey
 * @param {CryptoKey} publicKey
 * @returns {Promise<Bytes>}
 */
async function dh(privateKey, publicKey) {
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
}

/**
 * Khóa và nonce AEAD của ngữ cảnh HPKE (số thứ tự 0: mỗi ngữ cảnh chỉ niêm phong một lần).
 * @param {Bytes} dhs  DH(tạm, nhận) ‖ DH(gửi, nhận)
 * @param {Bytes} enc
 * @param {Bytes} pkR
 * @param {Bytes} pkS
 * @param {Bytes} info
 */
async function hpkeKeys(dhs, enc, pkR, pkS, info) {
  const eaePrk = await labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dhs);
  const shared = await labeledExpand(KEM_SUITE, eaePrk, "shared_secret", concat(enc, pkR, pkS), 32);
  const context = concat(Uint8Array.of(MODE_AUTH), await labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY), await labeledExtract(HPKE_SUITE, EMPTY, "info_hash", info));
  const secret = await labeledExtract(HPKE_SUITE, shared, "secret", EMPTY);
  return { key: await labeledExpand(HPKE_SUITE, secret, "key", context, 32), nonce: await labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12) };
}

/**
 * @param {Bytes} key
 * @param {"encrypt" | "decrypt"} usage
 */
const aesKey = (key, usage) => subtle().importKey("raw", key, { name: "AES-GCM" }, false, [usage]);

/**
 * HPKE SealAuth một lần gửi. `ephemeral` chỉ truyền khi kiểm vector; bình thường mỗi lần niêm phong tạo một khóa tạm mới.
 * @param {{ pkR: Bytes, skS: CryptoKey, pkS: Bytes, info: Bytes, aad: Bytes, pt: Bytes, ephemeral?: { privateKey: CryptoKey, publicKey: Bytes } }} o
 * @returns {Promise<{ enc: Bytes, ct: Bytes }>}
 */
export async function hpkeSealAuth(o) {
  let eph = o.ephemeral;
  if (!eph) {
    const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    eph = { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)) };
  }
  const recipient = await importPublic(o.pkR);
  const { key, nonce } = await hpkeKeys(concat(await dh(eph.privateKey, recipient), await dh(o.skS, recipient)), eph.publicKey, o.pkR, o.pkS, o.info);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: o.aad }, await aesKey(key, "encrypt"), o.pt));
  return { enc: eph.publicKey, ct };
}

/**
 * HPKE OpenAuth một lần gửi. Ném lỗi nếu khóa người gửi, khóa người nhận, info, aad, enc hay bản mã không khớp.
 * @param {{ skR: CryptoKey, pkR: Bytes, pkS: Bytes, info: Bytes, aad: Bytes, enc: Bytes, ct: Bytes }} o
 * @returns {Promise<Bytes>}
 */
export async function hpkeOpenAuth(o) {
  const { key, nonce } = await hpkeKeys(concat(await dh(o.skR, await importPublic(o.enc)), await dh(o.skR, await importPublic(o.pkS))), o.enc, o.pkR, o.pkS, o.info);
  return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: nonce, additionalData: o.aad }, await aesKey(key, "decrypt"), o.ct));
}

// ── Niêm phong và mở một tin ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Niêm phong một tin thành đúng thân của POST /v1/messages/threads/{thread_id}/messages. Gọi MỘT lần cho mỗi lần gửi: hộp gửi
 * (web/shared/msg-outbox.js) lưu kết quả cùng Idempotency-Key trước lần thử đầu, và mọi lần thử lại dùng lại đúng các byte đó.
 *
 * `recipients` là mọi điểm nhận tin đang dùng của cả hai người, kể cả thiết bị đang gửi (GET …/keys); `key_set` là mã băm máy chủ
 * trả cùng danh sách đó, sau khi thiết bị đã tự tính lại bằng keySetDigest() và so khóa đã ghim. Phong bì xếp theo endpoint_id.
 *
 * `fixed` thay phần ngẫu nhiên bằng giá trị cho trước và CHỈ dành cho fixture: dùng lại khóa nội dung hay IV là phá mã.
 *
 * @param {{
 *   text: string, thread_id: string, client_ref: string, key_set: string,
 *   sender: { endpoint_id: string, privateKey: CryptoKey, public_key: string },
 *   recipients: readonly { endpoint_id: string, public_key: string }[],
 *   fixed?: { content_key: Bytes, iv: Bytes, ephemeral: Record<string, MsgKeyPair> },
 * }} o
 * @returns {Promise<MsgSendBody>}
 */
export async function sealMessage(o) {
  const padded = encodeContent(o.text);
  const senderEndpoint = field(o.sender?.endpoint_id);
  const aad = messageAad({ thread_id: o.thread_id, sender_endpoint: senderEndpoint, client_ref: o.client_ref });
  const keySet = field(o.key_set);
  const pkS = publicKeyBytes(o.sender.public_key);
  if (!Array.isArray(o.recipients) || o.recipients.length < 1 || o.recipients.length > MSG_LIMITS.maxEnvelopes) throw new MsgCryptoError("RECIPIENTS");
  const recipients = o.recipients.map((r) => ({ endpoint_id: field(r?.endpoint_id, "RECIPIENTS"), raw: publicKeyBytes(r.public_key) }));
  if (new Set(recipients.map((r) => r.endpoint_id)).size !== recipients.length) throw new MsgCryptoError("RECIPIENTS");
  recipients.sort((a, b) => (a.endpoint_id < b.endpoint_id ? -1 : 1));

  const contentKey = o.fixed ? o.fixed.content_key : globalThis.crypto.getRandomValues(new Uint8Array(MSG_LIMITS.keyBytes));
  const iv = o.fixed ? o.fixed.iv : globalThis.crypto.getRandomValues(new Uint8Array(MSG_LIMITS.ivBytes));
  if (contentKey.length !== MSG_LIMITS.keyBytes || iv.length !== MSG_LIMITS.ivBytes) throw new MsgCryptoError("FIELD_INVALID");
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad }, await aesKey(contentKey, "encrypt"), padded));

  /** @type {MsgEnvelope[]} */
  const envelopes = [];
  for (const r of recipients) {
    /** @type {{ privateKey: CryptoKey, publicKey: Bytes } | undefined} */
    let ephemeral;
    if (o.fixed) {
      const e = o.fixed.ephemeral[r.endpoint_id];
      if (!e) throw new MsgCryptoError("RECIPIENTS");
      ephemeral = { privateKey: e.privateKey, publicKey: publicKeyBytes(e.public_key) };
    }
    const sealed = await hpkeSealAuth({ pkR: r.raw, skS: o.sender.privateKey, pkS, info: HPKE_INFO, aad, pt: contentKey, ephemeral });
    envelopes.push({ endpoint_id: r.endpoint_id, enc: base64url(sealed.enc), wrapped: base64url(sealed.ct) });
  }
  return { client_ref: o.client_ref, sender_endpoint: senderEndpoint, key_set: keySet, iv: base64url(iv), ct: base64url(ct), envelopes };
}

/**
 * Mở một tin lấy từ hộp thư của thiết bị này. `sender_public_key` là khóa ĐÃ GHIM của điểm nhận tin gửi (theo sender_endpoint),
 * không phải khóa máy chủ vừa trả: mở được nghĩa là tin do đúng thiết bị giữ khóa đó niêm phong, cho đúng hội thoại và client_ref.
 * Mọi sai lệch (khóa, hội thoại, client_ref, bản mã, phong bì) đều ra OPEN_FAILED; nội dung sai dạng ra PADDING hoặc CONTENT_INVALID.
 *
 * @param {{
 *   thread_id: string,
 *   message: { client_ref: string, sender_endpoint: string, iv: string, ct: string, enc: string, wrapped: string },
 *   recipient: MsgKeyPair,
 *   sender_public_key: string,
 * }} o
 * @returns {Promise<{ type: "text", text: string }>}
 */
export async function openMessage(o) {
  const m = o.message;
  const aad = messageAad({ thread_id: o.thread_id, sender_endpoint: m.sender_endpoint, client_ref: m.client_ref });
  const pkR = publicKeyBytes(o.recipient.public_key);
  const pkS = publicKeyBytes(o.sender_public_key);
  /** @type {Bytes} */
  let padded;
  try {
    const iv = fromBase64url(m.iv);
    const ct = fromBase64url(m.ct);
    const enc = fromBase64url(m.enc);
    const wrapped = fromBase64url(m.wrapped);
    if (iv.length !== MSG_LIMITS.ivBytes || enc.length !== MSG_LIMITS.publicKeyBytes || wrapped.length !== MSG_LIMITS.wrappedBytes) throw new MsgCryptoError("OPEN_FAILED");
    if (ct.length < MSG_LIMITS.block + MSG_LIMITS.tagBytes || ct.length > MSG_LIMITS.maxPaddedBytes + MSG_LIMITS.tagBytes) throw new MsgCryptoError("OPEN_FAILED");
    const contentKey = await hpkeOpenAuth({ skR: o.recipient.privateKey, pkR, pkS, info: HPKE_INFO, aad, enc, ct: wrapped });
    padded = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv, additionalData: aad }, await aesKey(contentKey, "decrypt"), ct));
  } catch {
    throw new MsgCryptoError("OPEN_FAILED");
  }
  return decodeContent(padded);
}
