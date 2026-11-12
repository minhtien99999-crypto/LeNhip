// LNH-MSG-1 (LNH-T31): HPKE theo vector công bố của CFRG, fixture đủ một tin với khóa cố định, các ca sửa byte, đệm, ký tự ngoài
// BMP và giới hạn kích thước. Ngoài bản WebCrypto của web/shared/msg-crypto.js, tệp này có một bản mở HPKE viết lại bằng
// node:crypto (ECDH, HMAC, AES-GCM của Node) để fixture không chỉ là «mã tự khớp với chính nó».
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalize } from "../web/shared/jcs.js";
import {
  MSG_LIMITS, MSG_SCHEME, MsgCryptoError, decodeContent, encodeContent, endpointKeyId, fromBase64url, generateEndpointKey, groupSafetyCode, hpkeOpenAuth, hpkeSealAuth,
  importKeyPair, keySetDigest, messageAad, openMessage, publicKeyBytes, safetyCode, sealMessage, toBase64url,
} from "../web/shared/msg-crypto.js";

type Bytes = Uint8Array<ArrayBuffer>;
const hex = (s: string): Bytes => new Uint8Array(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (s: string): Bytes => new Uint8Array(Buffer.from(s, "base64url"));
const read = (name: string) => JSON.parse(readFileSync(new URL(`../contracts/fixtures/msg/${name}`, import.meta.url), "utf8"));
const code = (c: string) => (e: unknown) => e instanceof MsgCryptoError && e.code === c;

interface FixtureKey { endpoint_id: string; user_id: string; d: string; public_key: string; key_id: string }
interface FixtureCase {
  name: string;
  input: { thread_id: string; client_ref: string; text: string; sender: string; recipients: string[]; content_key: string; iv: string; ephemeral: Record<string, { d: string; public_key: string }> };
  expected: { content_json: string; padded_bytes: number; aad: string; key_set: string; safety_code: string; request: { client_ref: string; sender_endpoint: string; key_set: string; iv: string; ct: string; envelopes: { endpoint_id: string; enc: string; wrapped: string }[] } };
}
const FIXTURE = read("lnh-msg-1.json") as { scheme: string; keys: Record<string, FixtureKey>; cases: FixtureCase[] };
const KAT = read("hpke-rfc9180-auth-p256.json") as Record<string, string> & { encryptions: { aad: string; ct: string; nonce: string; pt: string }[] };

// ── Bản tham chiếu độc lập bằng node:crypto: HPKE mode_auth, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM ──────────────
const i2osp = (n: number, len: number) => Buffer.from(Array.from({ length: len }, (_, i) => (n >> (8 * (len - 1 - i))) & 255));
const REF_KEM = Buffer.concat([Buffer.from("KEM"), i2osp(0x0010, 2)]);
const REF_HPKE = Buffer.concat([Buffer.from("HPKE"), i2osp(0x0010, 2), i2osp(0x0001, 2), i2osp(0x0002, 2)]);
const refExtract = (salt: Buffer, ikm: Buffer) => createHmac("sha256", salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
function refExpand(prk: Buffer, info: Buffer, len: number) {
  let t = Buffer.alloc(0);
  let out = Buffer.alloc(0);
  for (let i = 1; out.length < len; i++) {
    t = createHmac("sha256", prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out = Buffer.concat([out, t]);
  }
  return out.subarray(0, len);
}
const refLabeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) => refExtract(salt, Buffer.concat([Buffer.from("HPKE-v1"), suite, Buffer.from(label), ikm]));
const refLabeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, len: number) => refExpand(prk, Buffer.concat([i2osp(len, 2), Buffer.from("HPKE-v1"), suite, Buffer.from(label), info]), len);
function refDh(d: Uint8Array, pub: Uint8Array) {
  const e = createECDH("prime256v1");
  e.setPrivateKey(Buffer.from(d));
  return e.computeSecret(Buffer.from(pub));
}
/** Phía nhận: từ khóa riêng của người nhận ra shared_secret, key, base_nonce. */
function refReceiverKeys(skR: Uint8Array, pkR: Uint8Array, pkS: Uint8Array, enc: Uint8Array, info: Uint8Array) {
  const dhs = Buffer.concat([refDh(skR, enc), refDh(skR, pkS)]);
  const shared = refLabeledExpand(REF_KEM, refLabeledExtract(REF_KEM, Buffer.alloc(0), "eae_prk", dhs), "shared_secret", Buffer.concat([enc, pkR, pkS]), 32);
  const context = Buffer.concat([Buffer.from([2]), refLabeledExtract(REF_HPKE, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0)), refLabeledExtract(REF_HPKE, Buffer.alloc(0), "info_hash", Buffer.from(info))]);
  const secret = refLabeledExtract(REF_HPKE, shared, "secret", Buffer.alloc(0));
  return { shared, key: refLabeledExpand(REF_HPKE, secret, "key", context, 32), nonce: refLabeledExpand(REF_HPKE, secret, "base_nonce", context, 12) };
}
function refGcmOpen(key: Uint8Array, iv: Uint8Array, aad: Uint8Array, ct: Uint8Array) {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(aad);
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

const fixtureKey = (name: string) => importKeyPair(b64(FIXTURE.keys[name].d), FIXTURE.keys[name].public_key);
const entriesOf = (names: string[]) => names.map((n) => ({ endpoint_id: FIXTURE.keys[n].endpoint_id, user_id: FIXTURE.keys[n].user_id, public_key: FIXTURE.keys[n].public_key }));
const byEndpoint = (id: string) => Object.entries(FIXTURE.keys).find(([, k]) => k.endpoint_id === id)![0];

async function sealCase(c: FixtureCase) {
  const sender = await fixtureKey(c.input.sender);
  const ephemeral: Record<string, Awaited<ReturnType<typeof importKeyPair>>> = {};
  for (const [id, k] of Object.entries(c.input.ephemeral)) ephemeral[id] = await importKeyPair(b64(k.d), k.public_key);
  return sealMessage({
    text: c.input.text, thread_id: c.input.thread_id, client_ref: c.input.client_ref, key_set: c.expected.key_set,
    sender: { endpoint_id: FIXTURE.keys[c.input.sender].endpoint_id, privateKey: sender.privateKey, public_key: sender.public_key },
    recipients: entriesOf(c.input.recipients), fixed: { content_key: b64(c.input.content_key), iv: b64(c.input.iv), ephemeral },
  });
}

test("HPKE: vector CFRG của mode_auth, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM cho đúng enc và bản mã, mở lại ra đúng bản rõ", async () => {
  assert.deepEqual([KAT.mode, KAT.kem_id, KAT.kdf_id, KAT.aead_id], [2, 16, 1, 2]);
  const e0 = KAT.encryptions[0];
  assert.equal(e0.nonce, KAT.base_nonce, "số thứ tự 0: nonce chính là base_nonce");
  const pkR = hex(KAT.pkRm);
  const pkS = hex(KAT.pkSm);
  const sender = await importKeyPair(hex(KAT.skSm), toBase64url(pkS));
  const receiver = await importKeyPair(hex(KAT.skRm), toBase64url(pkR));
  const eph = await importKeyPair(hex(KAT.skEm), toBase64url(hex(KAT.pkEm)));
  const sealed = await hpkeSealAuth({ pkR, skS: sender.privateKey, pkS, info: hex(KAT.info), aad: hex(e0.aad), pt: hex(e0.pt), ephemeral: { privateKey: eph.privateKey, publicKey: hex(KAT.pkEm) } });
  assert.equal(toHex(sealed.enc), KAT.enc);
  assert.equal(toHex(sealed.ct), e0.ct);
  const open = (o: Partial<Parameters<typeof hpkeOpenAuth>[0]> = {}) => hpkeOpenAuth({ skR: receiver.privateKey, pkR, pkS, info: hex(KAT.info), aad: hex(e0.aad), enc: sealed.enc, ct: sealed.ct, ...o });
  assert.equal(toHex(await open()), e0.pt);

  // Bản tham chiếu node:crypto ra đúng các giá trị trung gian của vector, nên dùng được để kiểm fixture LNH-MSG-1 ở dưới.
  const ref = refReceiverKeys(hex(KAT.skRm), pkR, pkS, hex(KAT.enc), hex(KAT.info));
  assert.equal(ref.shared.toString("hex"), KAT.shared_secret);
  assert.equal(ref.key.toString("hex"), KAT.key);
  assert.equal(ref.nonce.toString("hex"), KAT.base_nonce);
  assert.equal(refGcmOpen(ref.key, ref.nonce, hex(e0.aad), hex(e0.ct)).toString("hex"), e0.pt);

  // Chế độ xác thực: khóa người gửi khác, aad, info, enc hay bản mã bị sửa đều không mở được.
  const other = await generateEndpointKey();
  await assert.rejects(open({ pkS: publicKeyBytes(other.public_key) }), "khóa người gửi khác");
  await assert.rejects(open({ aad: hex(e0.aad + "00") }));
  await assert.rejects(open({ info: hex(KAT.info + "00") }));
  await assert.rejects(open({ enc: publicKeyBytes(other.public_key) }));
  const bad = new Uint8Array(sealed.ct);
  bad[0] ^= 1;
  await assert.rejects(open({ ct: bad }));
  // Không truyền khóa tạm thì mỗi lần niêm phong dùng một khóa tạm mới.
  const r1 = await hpkeSealAuth({ pkR, skS: sender.privateKey, pkS, info: hex(KAT.info), aad: hex(e0.aad), pt: hex(e0.pt) });
  const r2 = await hpkeSealAuth({ pkR, skS: sender.privateKey, pkS, info: hex(KAT.info), aad: hex(e0.aad), pt: hex(e0.pt) });
  assert.notEqual(toHex(r1.enc), toHex(r2.enc));
  assert.equal(toHex(await open({ enc: r1.enc, ct: r1.ct })), e0.pt);
});

test("fixture LNH-MSG-1: niêm phong với khóa cố định ra đúng từng byte; mọi điểm nhận tin mở được; bản node:crypto độc lập cũng mở được", async () => {
  assert.equal(FIXTURE.scheme, MSG_SCHEME);
  assert.ok(FIXTURE.cases.length >= 3);
  for (const [name, k] of Object.entries(FIXTURE.keys)) {
    // Khóa thử suy ra từ nhãn công khai: ai cũng tính lại được, không phải bí mật.
    const d = createHash("sha256").update(`${MSG_SCHEME} fixture key: endpoint ${name}`, "utf8").digest();
    assert.equal(toBase64url(new Uint8Array(d)), k.d, name);
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(d);
    assert.equal(toBase64url(new Uint8Array(ecdh.getPublicKey())), k.public_key, name);
    assert.equal(await endpointKeyId(k.public_key), k.key_id);
    assert.equal(k.key_id, createHash("sha256").update(Buffer.from(k.public_key, "base64url")).digest("base64url"));
  }
  for (const c of FIXTURE.cases) {
    const senderKey = FIXTURE.keys[c.input.sender];
    assert.equal(canonicalize({ text: c.input.text, type: "text" }), c.expected.content_json, c.name);
    const padded = encodeContent(c.input.text);
    assert.equal(padded.length, c.expected.padded_bytes, c.name);
    assert.equal(new TextDecoder().decode(messageAad({ thread_id: c.input.thread_id, sender_endpoint: senderKey.endpoint_id, client_ref: c.input.client_ref })), c.expected.aad);
    assert.equal(await keySetDigest(c.input.thread_id, entriesOf(c.input.recipients)), c.expected.key_set);
    assert.equal(c.expected.key_set, createHash("sha256").update(canonicalize({ endpoints: entriesOf(c.input.recipients), thread_id: c.input.thread_id, v: MSG_SCHEME }), "utf8").digest("base64url"), "máy chủ tính key_set bằng đúng công thức này");
    assert.equal(await safetyCode("dev_a", "dev_b", entriesOf(c.input.recipients)), c.expected.safety_code);

    const request = await sealCase(c);
    assert.deepEqual(request, c.expected.request, `${c.name}: thân yêu cầu khác fixture`);
    assert.deepEqual(request.envelopes.map((e) => e.endpoint_id), [...c.input.recipients.map((n) => FIXTURE.keys[n].endpoint_id)].sort(), "phong bì xếp theo endpoint_id");
    assert.equal(b64(request.ct).length, c.expected.padded_bytes + 16);

    for (const env of request.envelopes) {
      const name = byEndpoint(env.endpoint_id);
      const message = { client_ref: request.client_ref, sender_endpoint: request.sender_endpoint, iv: request.iv, ct: request.ct, enc: env.enc, wrapped: env.wrapped };
      const opened = await openMessage({ thread_id: c.input.thread_id, message, recipient: await fixtureKey(name), sender_public_key: senderKey.public_key });
      assert.deepEqual(opened, { type: "text", text: c.input.text }, `${c.name} → ${name}`);

      // Bản độc lập: mở phong bì bằng khóa riêng của người nhận, rồi mở nội dung.
      const aad = Buffer.from(c.expected.aad, "utf8");
      const ref = refReceiverKeys(b64(FIXTURE.keys[name].d), b64(FIXTURE.keys[name].public_key), b64(senderKey.public_key), b64(env.enc), Buffer.from(MSG_SCHEME));
      const contentKey = refGcmOpen(ref.key, ref.nonce, aad, b64(env.wrapped));
      assert.equal(contentKey.toString("base64url"), c.input.content_key);
      const plain = refGcmOpen(contentKey, b64(request.iv), aad, b64(request.ct));
      assert.equal(plain.length % 256, 0);
      const end = plain.lastIndexOf(0x80);
      assert.equal(plain.subarray(0, end).toString("utf8"), c.expected.content_json);
      assert.ok(plain.subarray(end + 1).every((x) => x === 0));
    }
  }
});

test("sửa một byte ở bất kỳ đâu, đổi hội thoại, client_ref, thiết bị gửi, khóa người gửi hay người nhận: không mở được", async () => {
  const c = FIXTURE.cases[0];
  const request = c.expected.request;
  const senderKey = FIXTURE.keys[c.input.sender];
  const env = request.envelopes.find((e) => e.endpoint_id === FIXTURE.keys.b1.endpoint_id)!;
  const base = { client_ref: request.client_ref, sender_endpoint: request.sender_endpoint, iv: request.iv, ct: request.ct, enc: env.enc, wrapped: env.wrapped };
  const recipient = await fixtureKey("b1");
  const open = (m: Partial<typeof base> = {}, o: { thread_id?: string; recipient?: typeof recipient; sender_public_key?: string } = {}) =>
    openMessage({ thread_id: o.thread_id ?? c.input.thread_id, message: { ...base, ...m }, recipient: o.recipient ?? recipient, sender_public_key: o.sender_public_key ?? senderKey.public_key });
  assert.equal((await open()).text, c.input.text);
  const flip = (s: string, at = 0) => {
    const bytes = b64(s);
    bytes[at] ^= 0x01;
    return toBase64url(bytes);
  };
  const failed = code("OPEN_FAILED");
  await assert.rejects(open({}, { thread_id: c.input.thread_id.replace("ab01", "ab02") }), failed, "hội thoại khác");
  await assert.rejects(open({ client_ref: "fixture-ref-0001-AAAAAAAAAB" }), failed, "client_ref khác");
  await assert.rejects(open({ sender_endpoint: FIXTURE.keys.a2.endpoint_id }), failed, "thiết bị gửi khác trong AAD");
  await assert.rejects(open({}, { sender_public_key: FIXTURE.keys.a2.public_key }), failed, "khóa đã ghim của thiết bị gửi khác");
  await assert.rejects(open({}, { recipient: await fixtureKey("b2") }), failed, "phong bì của thiết bị khác");
  await assert.rejects(open({ iv: flip(request.iv) }), failed);
  await assert.rejects(open({ ct: flip(request.ct) }), failed, "bản mã");
  await assert.rejects(open({ ct: flip(request.ct, b64(request.ct).length - 1) }), failed, "thẻ xác thực");
  await assert.rejects(open({ wrapped: flip(env.wrapped) }), failed);
  await assert.rejects(open({ enc: flip(env.enc, 40) }), failed, "khóa tạm không còn là điểm trên đường cong hoặc là điểm khác");
  await assert.rejects(open({ enc: request.envelopes[0].enc }), failed, "enc của phong bì khác");
  await assert.rejects(open({ wrapped: request.envelopes[0].wrapped }), failed);
  await assert.rejects(open({ ct: request.ct.slice(0, -4) }), failed, "bản mã bị cắt");
  await assert.rejects(open({ iv: request.iv + "AA" }), failed, "IV sai độ dài");
  await assert.rejects(open({ ct: request.ct + "=" }), failed, "base64url có padding");
  // Bản mã của tin khác với phong bì của tin này: khóa nội dung khác nên không mở được.
  await assert.rejects(open({ ct: FIXTURE.cases[1].expected.request.ct, iv: FIXTURE.cases[1].expected.request.iv }), failed);
});

test("đệm: luôn là bội số của 256 byte, có ít nhất một byte đệm; chỉ nhận đúng dạng chuẩn của nội dung", () => {
  for (const n of [1, 2, 100, 229, 230, 231, 232, 486, 487, 488, 1000, 2000]) {
    const text = "k".repeat(n);
    const padded = encodeContent(text);
    const json = 25 + n;
    assert.equal(padded.length % 256, 0, String(n));
    assert.equal(padded.length, (Math.floor(json / 256) + 1) * 256, String(n));
    assert.equal(padded[json], 0x80);
    assert.ok(padded.subarray(json + 1).every((x) => x === 0));
    assert.deepEqual(decodeContent(padded), { type: "text", text });
  }
  assert.equal(encodeContent("k".repeat(230)).length, 256, "255 byte nội dung + 1 byte đệm");
  assert.equal(encodeContent("k".repeat(231)).length, 512, "256 byte nội dung: phần đệm chiếm trọn khối kế tiếp");
  // Độ dài thật bị che trong khối: mọi tin ngắn ra cùng một cỡ.
  assert.equal(encodeContent("ừ").length, encodeContent("Hẹn 7 giờ tối mai ở cổng trường nhé.").length);

  const padOf = (json: string, size = 256) => {
    const out = new Uint8Array(size);
    const body = new TextEncoder().encode(json);
    out.set(body);
    out[body.length] = 0x80;
    return out;
  };
  const good = padOf('{"text":"a","type":"text"}');
  assert.deepEqual(decodeContent(good), { type: "text", text: "a" });
  const noMarker = new Uint8Array(good);
  noMarker[26] = 0;
  assert.throws(() => decodeContent(noMarker), code("PADDING"));
  const dirty = new Uint8Array(good);
  dirty[200] = 1;
  assert.throws(() => decodeContent(dirty), code("PADDING"), "byte khác 0 sau dấu đệm");
  assert.throws(() => decodeContent(padOf('{"text":"a","type":"text"}', 512)), code("PADDING"), "thừa trọn một khối đệm");
  assert.throws(() => decodeContent(new Uint8Array(256)), code("PADDING"), "toàn 0");
  assert.throws(() => decodeContent(good.slice(0, 255)), code("PADDING"));
  assert.throws(() => decodeContent(new Uint8Array(0)), code("PADDING"));
  assert.throws(() => decodeContent(new Uint8Array(MSG_LIMITS.maxPaddedBytes + 256)), code("PADDING"));
  for (const bad of [
    '{"type":"text","text":"a"}', '{"text":"a", "type":"text"}', '{"text":"a","type":"text","more":1}', '{"text":"a","type":"image"}', '{"text":1,"type":"text"}',
    '{"text":"","type":"text"}', '{"text":"a","text":"b","type":"text"}', '["a"]', '"a"', "null", '{"text":"\\u0061","type":"text"}', "{",
  ]) assert.throws(() => decodeContent(padOf(bad)), code("CONTENT_INVALID"), bad);
  const invalidUtf8 = padOf('{"text":"a","type":"text"}');
  invalidUtf8[9] = 0xff;
  assert.throws(() => decodeContent(invalidUtf8), code("CONTENT_INVALID"));
});

test("ký tự ngoài BMP đếm theo điểm mã; giới hạn 2.000 điểm mã và cỡ lớn nhất; chuỗi rỗng và surrogate lẻ bị từ chối", async () => {
  const wave = "👋🏽"; // hai điểm mã, bốn đơn vị UTF-16
  assert.equal([...wave].length, 2);
  assert.deepEqual(decodeContent(encodeContent("𠮷野家 " + wave)), { type: "text", text: "𠮷野家 " + wave });
  const max = "𠮷".repeat(2000);
  assert.equal(max.length, 4000);
  assert.equal(decodeContent(encodeContent(max)).text, max);
  assert.throws(() => encodeContent(max + "a"), code("TEXT_TOO_LONG"));
  assert.throws(() => encodeContent("a".repeat(2001)), code("TEXT_TOO_LONG"));
  assert.throws(() => encodeContent("a".repeat(5000)), code("TEXT_TOO_LONG"));
  assert.throws(() => encodeContent(""), code("TEXT_EMPTY"));
  assert.throws(() => encodeContent("a\ud800"), code("TEXT_MALFORMED"));
  assert.throws(() => encodeContent("\udc00a"), code("TEXT_MALFORMED"));
  assert.throws(() => encodeContent(42 as unknown as string), code("TEXT_MALFORMED"));

  // Trường hợp nặng nhất: 2.000 ký tự điều khiển, mỗi ký tự thành 6 byte \u00XX trong JSON.
  const worst = "\u0001".repeat(2000);
  const padded = encodeContent(worst);
  assert.equal(padded.length, MSG_LIMITS.maxPaddedBytes);
  assert.equal(padded.length, 12032);
  assert.equal(decodeContent(padded).text, worst);

  const a = await generateEndpointKey();
  const b = await generateEndpointKey();
  const recipients = [{ endpoint_id: "mep_a", public_key: a.public_key }, { endpoint_id: "mep_b", public_key: b.public_key }];
  const sealed = await sealMessage({ text: worst, thread_id: "th_1", client_ref: "ref-0000000000000000000001", key_set: "ks", sender: { endpoint_id: "mep_a", ...a }, recipients });
  assert.equal(b64(sealed.ct).length, MSG_LIMITS.maxPaddedBytes + MSG_LIMITS.tagBytes);
  assert.equal(sealed.ct.length, 16064, "cỡ lớn nhất của ct trên dây (schema MsgSend)");
  assert.equal(sealed.iv.length, 16);
  assert.equal(sealed.envelopes[0].enc.length, 87);
  assert.equal(sealed.envelopes[0].wrapped.length, 64);
  assert.ok(JSON.stringify(sealed).length < 20_000, "thân lớn nhất với hai phong bì vẫn xa giới hạn 64 KiB");
  const message = { ...sealed, ...sealed.envelopes[1] };
  assert.equal((await openMessage({ thread_id: "th_1", message, recipient: b, sender_public_key: a.public_key })).text, worst);
  const small = await sealMessage({ text: "ừ", thread_id: "th_1", client_ref: "ref-0000000000000000000002", key_set: "ks", sender: { endpoint_id: "mep_a", ...a }, recipients });
  assert.equal(small.ct.length, 363, "cỡ nhỏ nhất của ct trên dây");
});

test("khóa của thiết bị: khóa riêng không xuất được; mỗi lần niêm phong dùng khóa nội dung, IV và khóa tạm mới; danh sách người nhận được kiểm", async () => {
  const a = await generateEndpointKey();
  const b = await generateEndpointKey();
  assert.equal(a.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("jwk", a.privateKey));
  await assert.rejects(crypto.subtle.exportKey("pkcs8", a.privateKey));
  assert.equal(publicKeyBytes(a.public_key).length, 65);
  assert.equal((await endpointKeyId(a.public_key)).length, 43);

  const recipients = [{ endpoint_id: "mep_b", public_key: b.public_key }, { endpoint_id: "mep_a", public_key: a.public_key }];
  const args = { text: "Gặp lúc 15:00 nhé", thread_id: "th_1", client_ref: "ref-0000000000000000000003", key_set: "ks", sender: { endpoint_id: "mep_a", ...a }, recipients };
  const s1 = await sealMessage(args);
  const s2 = await sealMessage(args);
  assert.notEqual(s1.iv, s2.iv);
  assert.notEqual(s1.ct, s2.ct);
  assert.notEqual(s1.envelopes[0].enc, s2.envelopes[0].enc);
  assert.notEqual(s1.envelopes[0].wrapped, s2.envelopes[0].wrapped);
  assert.deepEqual(s1.envelopes.map((e) => e.endpoint_id), ["mep_a", "mep_b"], "xếp theo endpoint_id dù đầu vào theo thứ tự khác");
  assert.deepEqual(Object.keys(s1), ["client_ref", "sender_endpoint", "key_set", "iv", "ct", "envelopes"], "đúng các trường của schema MsgSend, không trường nào mang chữ");
  // Thiết bị gửi cũng mở được phong bì của chính nó (bằng chứng «tin của tôi đã tới máy chủ» trong hộp thư của nó).
  assert.equal((await openMessage({ thread_id: "th_1", message: { ...s1, ...s1.envelopes[0] }, recipient: a, sender_public_key: a.public_key })).text, args.text);
  assert.equal((await openMessage({ thread_id: "th_1", message: { ...s1, ...s1.envelopes[1] }, recipient: b, sender_public_key: a.public_key })).text, args.text);
  // Người nhận không tự niêm phong được một tin «từ A»: mở bằng khóa đã ghim của A sẽ hỏng.
  const forged = await sealMessage({ ...args, sender: { endpoint_id: "mep_a", ...b } });
  await assert.rejects(openMessage({ thread_id: "th_1", message: { ...forged, ...forged.envelopes[1] }, recipient: b, sender_public_key: a.public_key }), code("OPEN_FAILED"));

  await assert.rejects(sealMessage({ ...args, recipients: [] }), code("RECIPIENTS"));
  await assert.rejects(sealMessage({ ...args, recipients: [recipients[0], recipients[0]] }), code("RECIPIENTS"));
  await assert.rejects(sealMessage({ ...args, recipients: Array.from({ length: 11 }, (_, i) => ({ endpoint_id: `mep_${i}`, public_key: a.public_key })) }), code("RECIPIENTS"));
  await assert.rejects(sealMessage({ ...args, recipients: [{ endpoint_id: "mep_x", public_key: a.public_key.slice(0, -1) }] }), code("KEY_INVALID"));
  // Điểm không nằm trên đường cong P-256 bị từ chối khi nhập.
  const off = publicKeyBytes(a.public_key);
  off[64] ^= 1;
  await assert.rejects(sealMessage({ ...args, recipients: [{ endpoint_id: "mep_x", public_key: toBase64url(off) }] }), code("KEY_INVALID"));
  const compressed = new Uint8Array(65);
  compressed[0] = 2;
  assert.throws(() => publicKeyBytes(toBase64url(compressed)), code("KEY_INVALID"));
  await assert.rejects(sealMessage({ ...args, client_ref: "" }), code("FIELD_INVALID"));
  await assert.rejects(sealMessage({ ...args, text: "" }), code("TEXT_EMPTY"));
});

test("key_set và mã an toàn: không phụ thuộc thứ tự, đổi khi tập khóa đổi, hai người thấy cùng một mã 30 chữ số", async () => {
  const all = entriesOf(["a1", "a2", "b1", "b2"]);
  const thread = FIXTURE.cases[0].input.thread_id;
  const ks = await keySetDigest(thread, all);
  assert.match(ks, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await keySetDigest(thread, [...all].reverse()), ks);
  assert.notEqual(await keySetDigest(thread, all.slice(0, 3)), ks, "gỡ một thiết bị");
  assert.notEqual(await keySetDigest(thread.replace("ab01", "ab02"), all), ks);
  assert.notEqual(await keySetDigest(thread, all.map((e, i) => (i === 0 ? { ...e, user_id: "dev_b" } : e))), ks, "cùng khóa nhưng gán cho người khác");
  const swapped = all.map((e, i) => (i === 0 ? { ...e, public_key: all[1].public_key } : e));
  assert.notEqual(await keySetDigest(thread, swapped), ks, "máy chủ tráo khóa của một điểm nhận tin");
  await assert.rejects(keySetDigest(thread, [all[0], all[0]]), code("KEY_SET"));
  await assert.rejects(keySetDigest(thread, [{ ...all[0], public_key: "AAAA" }]), code("KEY_INVALID"));

  const sc = await safetyCode("dev_a", "dev_b", all);
  assert.match(sc, /^\d{30}$/);
  assert.equal(await safetyCode("dev_b", "dev_a", [...all].reverse()), sc, "hai phía tính ra cùng một mã");
  assert.deepEqual(groupSafetyCode(sc).join(""), sc);
  assert.equal(groupSafetyCode(sc).length, 6);
  assert.notEqual(await safetyCode("dev_a", "dev_b", all.slice(0, 3)), sc, "một thiết bị bị gỡ");
  assert.notEqual(await safetyCode("dev_a", "dev_b", swapped), sc);
  // Mã chỉ phụ thuộc người và khóa: đổi mã điểm nhận tin mà giữ khóa thì mã không đổi.
  assert.equal(await safetyCode("dev_a", "dev_b", all.map((e) => ({ ...e, endpoint_id: e.endpoint_id + "x" }))), sc);
  await assert.rejects(safetyCode("dev_a", "dev_a", all), code("KEY_SET"));
  await assert.rejects(safetyCode("dev_a", "dev_b", entriesOf(["a1", "a2"])), code("KEY_SET"), "một bên chưa có khóa nào thì không có mã");
  await assert.rejects(safetyCode("dev_a", "dev_c", all), code("KEY_SET"), "khóa của người thứ ba");
  assert.throws(() => groupSafetyCode("12345"), code("FIELD_INVALID"));
});

test("base64url chặt: không padding, không ký tự của base64 thường, không bit thừa", () => {
  assert.deepEqual([...fromBase64url("AQID")], [1, 2, 3]);
  assert.deepEqual([...fromBase64url("")], []);
  assert.equal(toBase64url(fromBase64url("_-8")), "_-8");
  for (const bad of ["AQID=", "AQ+D", "AQ/D", "A", "AQIDB", "QR", "AQI D", "ÀQID"]) assert.throws(() => fromBase64url(bad), code("ENCODING"), bad);
  assert.throws(() => fromBase64url(7 as unknown as string), code("ENCODING"));
});
