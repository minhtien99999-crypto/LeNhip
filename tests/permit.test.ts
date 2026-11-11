// T06 (PER01) và T09 (TX01, PER01): JWS ES256, alg/kid/header, đồng hồ tương lai/lệch/hết hạn, khóa JSON trùng, sai mTLS/aud/
// target/digest, thu hồi và xoay khóa, jti tiêu thụ một lần qua khởi động lại, permit cũ sau khi đổi epoch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64url, certThumbprint, es256Sign, generateEs256 } from "../src/core/crypto.ts";
import { PermitError, PermitIssuer, TrustStore, verifyPermit, type PermitClaims } from "../src/server/permit.ts";
import { issuePermit } from "../src/server/worker.ts";
import { getByActionId } from "../src/server/machine.ts";
import { harness, lampPlan, planAndApprove } from "./helpers.ts";
import { canonicalize } from "../web/shared/jcs.js";

const NOW = Date.parse("2026-11-11T02:00:00Z");
const cert = new Uint8Array([1, 2, 3, 4, 5]);
const otherCert = new Uint8Array([9, 9, 9]);

function setup() {
  const key = generateEs256("k1");
  const issuer = new PermitIssuer("https://authority.test", key);
  const trust = new TrustStore();
  trust.add("k1", key.publicKey);
  const base: Omit<PermitClaims, "iss" | "iat" | "nbf" | "exp" | "jti"> = {
    aud: "lenhip:site:site_lab01", action_id: "6f1c0e2a-1d3b-4c5d-9e8f-0a1b2c3d4e5f", action_revision: 3, workspace_id: "ws_demo", site: "site_lab01",
    target: "dev_lamp_01", target_binding_version: 1, payload_digest: "A".repeat(43), authz_version: 1, export_policy_digest: "B".repeat(43), recovery_epoch: 1,
    cnf: { "x5t#S256": certThumbprint(cert) },
  };
  const opts = { trust, issuer: "https://authority.test", audience: "lenhip:site:site_lab01", nowMs: NOW, skewMs: 2000, maxLifetimeS: 30, peerCertDer: cert };
  return { key, issuer, trust, base, opts };
}

/** Ký một token tùy ý (header/payload thô) để thử các dạng tấn công cú pháp. */
function forge(key: ReturnType<typeof generateEs256>, headerJson: string, payloadText: string) {
  const h = b64url(headerJson);
  const p = b64url(payloadText);
  return `${h}.${p}.${b64url(es256Sign(`${h}.${p}`, key.privateKey))}`;
}

const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as PermitError).code;
  }
  return "OK";
};

test("permit hợp lệ qua mọi bước; header đúng ba trường, payload là JCS", () => {
  const { issuer, base, opts } = setup();
  const { token, claims } = issuer.issue(base, NOW, 30);
  assert.equal(claims.exp - claims.iat, 30);
  assert.equal(claims.nbf, claims.iat);
  const out = verifyPermit(token, opts);
  assert.equal(out.jti, claims.jti);
  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
  assert.deepEqual(Object.keys(header).sort(), ["alg", "kid", "typ"]);
  assert.equal(header.typ, "lnh-permit+jwt");
});

test("cú pháp và header: alg khác, header thừa (crit, jku, x5u, b64), khóa trùng, padding, không phải compact", () => {
  const { key, issuer, base, opts } = setup();
  const { claims } = issuer.issue(base, NOW, 30);
  const payload = canonicalize(claims);
  assert.equal(code(() => verifyPermit(forge(key, '{"alg":"HS256","typ":"lnh-permit+jwt","kid":"k1"}', payload), opts)), "PERMIT_HEADER");
  assert.equal(code(() => verifyPermit(forge(key, '{"alg":"none","typ":"lnh-permit+jwt","kid":"k1"}', payload), opts)), "PERMIT_HEADER");
  for (const extra of ['"crit":["exp"]', '"jku":"https://x.test/k"', '"x5u":"https://x.test/c"', '"b64":false']) {
    assert.equal(code(() => verifyPermit(forge(key, `{"alg":"ES256","typ":"lnh-permit+jwt","kid":"k1",${extra}}`, payload), opts)), "PERMIT_HEADER", extra);
  }
  assert.equal(code(() => verifyPermit(forge(key, '{"alg":"ES256","alg":"ES256","typ":"lnh-permit+jwt","kid":"k1"}', payload), opts)), "PERMIT_HEADER");
  const dup = payload.replace('{"action_id"', '{"action_id":"x","action_id"');
  assert.equal(code(() => verifyPermit(forge(key, '{"alg":"ES256","typ":"lnh-permit+jwt","kid":"k1"}', dup), opts)), "PERMIT_SYNTAX");
  const notJcs = JSON.stringify(claims, null, 1);
  assert.equal(code(() => verifyPermit(forge(key, '{"alg":"ES256","typ":"lnh-permit+jwt","kid":"k1"}', notJcs), opts)), "PERMIT_SYNTAX");
  const good = issuer.issue(base, NOW, 30).token;
  assert.equal(code(() => verifyPermit(good + "=", opts)), "PERMIT_SYNTAX");
  assert.equal(code(() => verifyPermit(good.split(".").slice(0, 2).join("."), opts)), "PERMIT_SYNTAX");
  assert.equal(code(() => verifyPermit(`${good}.x`, opts)), "PERMIT_SYNTAX");
  const extraClaim = canonicalize({ ...claims, extra: 1 });
  assert.equal(code(() => verifyPermit(forge(key, '{"alg":"ES256","typ":"lnh-permit+jwt","kid":"k1"}', extraClaim), opts)), "PERMIT_SYNTAX");
});

test("trust và chữ ký: kid lạ, chữ ký sai, khóa thu hồi, xoay khóa giữ khóa cũ tới hết hạn", () => {
  const { issuer, base, opts, trust } = setup();
  const { token } = issuer.issue(base, NOW, 30);
  const parts = token.split(".");
  const flipped = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -2)}${parts[2].endsWith("AA") ? "AB" : "AA"}`;
  assert.equal(code(() => verifyPermit(flipped, opts)), "PERMIT_SIGNATURE");
  const stranger = new PermitIssuer("https://authority.test", generateEs256("k-unknown"));
  assert.equal(code(() => verifyPermit(stranger.issue(base, NOW, 30).token, opts)), "PERMIT_UNTRUSTED_KEY");
  // Xoay khóa: token cũ còn hợp lệ tới exp + skew; token mới dùng kid mới.
  const k2 = generateEs256("k2");
  trust.add("k2", k2.publicKey);
  issuer.rotate(k2);
  trust.retire("k1", NOW + 32_000);
  assert.equal(code(() => verifyPermit(token, opts)), "OK");
  assert.equal(code(() => verifyPermit(token, { ...opts, nowMs: NOW + 33_000 })), "PERMIT_UNTRUSTED_KEY");
  assert.equal(code(() => verifyPermit(issuer.issue(base, NOW, 30).token, opts)), "OK");
  trust.revoke("k2");
  assert.equal(code(() => verifyPermit(issuer.issue(base, NOW, 30).token, opts)), "PERMIT_UNTRUSTED_KEY");
});

test("thời gian: lifetime > 30 giây, nbf ≠ iat, tương lai quá skew, quá exp + skew", () => {
  const { issuer, base, opts } = setup();
  assert.equal(code(() => verifyPermit(issuer.issue(base, NOW, 31).token, opts)), "PERMIT_LIFETIME");
  assert.equal(code(() => verifyPermit(issuer.issue(base, NOW + 3000, 30).token, opts)), "PERMIT_NOT_YET_VALID");
  assert.equal(code(() => verifyPermit(issuer.issue(base, NOW + 2000, 30).token, opts)), "OK", "đúng biên skew 2 giây");
  assert.equal(code(() => verifyPermit(issuer.issue(base, NOW - 32_500, 30).token, opts)), "PERMIT_EXPIRED");
  assert.equal(code(() => verifyPermit(issuer.issue(base, NOW - 31_500, 30).token, opts)), "OK", "trong exp + skew");
});

test("issuer, audience và danh tính mTLS", () => {
  const { issuer, base, opts } = setup();
  const { token } = issuer.issue(base, NOW, 30);
  assert.equal(code(() => verifyPermit(token, { ...opts, issuer: "https://other" })), "PERMIT_ISSUER");
  assert.equal(code(() => verifyPermit(token, { ...opts, audience: "lenhip:site:site_x" })), "PERMIT_AUDIENCE");
  assert.equal(code(() => verifyPermit(token, { ...opts, peerCertDer: otherCert })), "PERMIT_IDENTITY");
});

test("receiver: sai digest/target, jti dùng lại, epoch cũ, đồng hồ lệch > 2 giây khóa phát", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    const receiver = h.app.receivers.get("device.set_power")!;
    const row = getByActionId(h.app.ctx.db, action_id)!;
    // mTLS: worker trình chứng chỉ khác chứng chỉ trong cnf.
    const p1 = issuePermit(h.app.ctx, h.app.issuer, receiver, row, h.app.identity);
    await assert.rejects(receiver.accept(p1.token, new Uint8Array([7, 7, 7])), (e: PermitError) => e.code === "PERMIT_IDENTITY");
    // Epoch cũ sau khi Incident Lead tăng epoch.
    const p2 = issuePermit(h.app.ctx, h.app.issuer, receiver, row, h.app.identity);
    h.app.ctx.control.beginRecovery(new Date(h.clock.now()).toISOString(), "lead", "diễn tập");
    h.app.ctx.control.unlockDispatch(new Date(h.clock.now()).toISOString(), ["lead", "ops"], null);
    await assert.rejects(receiver.accept(p2.token, h.app.identity.certDer), (e: PermitError) => e.code === "PERMIT_EPOCH");
    // Permit hợp lệ dùng một lần; trình lại cùng jti bị chặn, không có I/O mới.
    const p3 = issuePermit(h.app.ctx, h.app.issuer, receiver, row, h.app.identity);
    await receiver.accept(p3.token, h.app.identity.certDer);
    await assert.rejects(receiver.accept(p3.token, h.app.identity.certDer), (e: PermitError) => e.code === "PERMIT_REPLAY" || e.code === "PERMIT_REVISION");
    assert.equal(h.app.hubs.get("site_lab01")!.commands.length, 1);
    // Khởi động lại tiến trình: jti đã tiêu thụ vẫn nằm trong sổ.
    await h.restart();
    const r2 = h.app.receivers.get("device.set_power")!;
    await assert.rejects(r2.accept(p3.token, h.app.identity.certDer), (e: PermitError) => e.code === "PERMIT_REPLAY" || e.code === "PERMIT_REVISION");
    // Lệch đồng hồ > 2 giây: khóa phát toàn hệ.
    r2.clockOffsetMs = 2500;
    await assert.rejects(r2.accept(p3.token, h.app.identity.certDer), (e: PermitError) => e.code === "CLOCK_SKEW");
    assert.equal(h.app.ctx.control.dispatchOpen(), false);
    assert.equal(h.app.hubs.get("site_lab01")!.commands.length, 1, "không tạo I/O mới từ bản trùng");
  } finally {
    await h.close();
  }
});

test("robot dùng trust root riêng: permit của Authority chính không qua receiver mô phỏng và ngược lại", async () => {
  const h = await harness();
  try {
    const { action_id } = await planAndApprove(h, { kind: "robot.simulate", schema_version: 1, workspace_ref: "ws_demo", args: { scenario: "DELIVER_DOCUMENT" } });
    const row = getByActionId(h.app.ctx.db, action_id)!;
    const robot = h.app.receivers.get("robot.simulate")!;
    const wrong = issuePermit(h.app.ctx, h.app.issuer, robot, row, h.app.identity);
    await assert.rejects(robot.accept(wrong.token, h.app.identity.certDer), (e: PermitError) => e.code === "PERMIT_UNTRUSTED_KEY");
  } finally {
    await h.close();
  }
});
