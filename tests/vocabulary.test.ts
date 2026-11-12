// Từ vựng mới của Authority ở V1.0.0 (LNH-T36, LNH-T45): mục đích đồng ý messaging và social_post, quyền messaging.use và
// social.post. Chúng đi được qua các route có sẵn (ghi và rút đồng ý, thu hồi quyền) trước khi có mô-đun nào dùng tới.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMAS } from "../src/server/app.ts";
import { activeGrant, consentGranted } from "../src/server/authority.ts";
import { all, run } from "../src/server/store.ts";
import { harness, key, WS } from "./helpers.ts";

test("đồng ý cho mục đích mới: ghi, hiện trong /v1/me, rút qua route có sẵn; sức khỏe vẫn bị từ chối; mục đích lạ không qua schema", async () => {
  const h = await harness({ consents: false });
  try {
    for (const purpose of ["messaging", "social_post"] as const) {
      const c = await h.call("POST", "/v1/consents", { body: { purpose_id: purpose, text_version: "v1.en", text_hash: "A".repeat(43), choice: "GRANTED" } });
      assert.equal(c.status, 201, purpose);
      assert.deepEqual(SCHEMAS.validate("ConsentReceipt", c.body), []);
      assert.equal(consentGranted(h.app.ctx, WS, "dev_a", purpose), true);
    }
    const me = await h.call("GET", "/v1/me");
    assert.deepEqual(SCHEMAS.validate("Me", me.body), []);
    assert.deepEqual(me.body.consents.map((c: { purpose_id: string }) => c.purpose_id).sort(), ["messaging", "social_post"]);
    const before = me.body.grants.length;
    for (const purpose of ["messaging", "social_post"] as const) {
      const k = key();
      const w = await h.call("POST", `/v1/consents/${purpose}/withdraw`, { key: k });
      assert.equal(w.status, 200, purpose);
      assert.ok(w.body.withdrawn_at);
      assert.deepEqual((await h.call("POST", `/v1/consents/${purpose}/withdraw`, { key: k })).body, w.body, "phát lại cùng khóa");
      assert.equal(consentGranted(h.app.ctx, WS, "dev_a", purpose), false);
    }
    assert.deepEqual(h.app.ctx.revocations.readAll().entries.map((e) => `${e.type}:${e.purpose_id}`), ["consent_withdrawn:messaging", "consent_withdrawn:social_post"], "thu hồi vào sổ độc lập để restore không làm sống lại");
    assert.equal((await h.call("GET", "/v1/me")).body.grants.length, before);
    assert.equal((await h.call("POST", "/v1/consents/messaging/withdraw", { sub: "dev_b" })).status, 404, "chưa từng có biên nhận");
    assert.equal((await h.call("POST", "/v1/consents/tracking/withdraw", {})).status, 404);
    assert.equal((await h.call("POST", "/v1/consents", { body: { purpose_id: "tracking", text_version: "v1", text_hash: "A".repeat(43), choice: "GRANTED" } })).status, 400);
    const health = await h.call("POST", "/v1/consents", { body: { purpose_id: "health_local", text_version: "v1", text_hash: "A".repeat(43), choice: "GRANTED" } });
    assert.equal(health.body.code, "HEALTH_LOCAL_ONLY");
  } finally {
    await h.close();
  }
});

test("quyền mới: messaging.use và social.post hiện trong /v1/me và thu hồi được qua POST /v1/grants/{id}/revoke", async () => {
  const h = await harness();
  try {
    const at = new Date(h.clock.now()).toISOString();
    for (const [id, scope] of [["gr_msg_a", "messaging.use"], ["gr_soc_a", "social.post"]] as const) {
      run(h.app.ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, 'dev_a', ?, NULL, 'ACTIVE', ?)", id, WS, scope, at);
    }
    const me = await h.call("GET", "/v1/me");
    assert.deepEqual(SCHEMAS.validate("Me", me.body), []);
    assert.ok(me.body.grants.some((g: { scope: string }) => g.scope === "messaging.use") && me.body.grants.some((g: { scope: string }) => g.scope === "social.post"));
    assert.ok(activeGrant(h.app.ctx, WS, "dev_a", "messaging.use", null));
    const version = () => all<{ authz_version: number }>(h.app.ctx.db, "SELECT authz_version FROM members WHERE user_id = 'dev_a'")[0].authz_version;
    const v0 = version();
    const r1 = await h.call("POST", "/v1/grants/gr_msg_a/revoke", {});
    assert.equal(r1.status, 200);
    assert.deepEqual(SCHEMAS.validate("GrantRevoked", r1.body), []);
    assert.equal(r1.body.authz_version, v0 + 1);
    assert.equal(activeGrant(h.app.ctx, WS, "dev_a", "messaging.use", null), null);
    assert.ok(activeGrant(h.app.ctx, WS, "dev_a", "social.post", null), "thu hồi một quyền không đụng quyền kia");
    // Quản trị workspace thu hồi quyền của người khác (đường «tạm ngừng» một thành viên của mô-đun mới).
    const r2 = await h.call("POST", "/v1/grants/gr_soc_a/revoke", { sub: "dev_ops" });
    assert.equal(r2.status, 200);
    assert.equal(r2.body.already_revoked, false);
    assert.equal((await h.call("POST", "/v1/grants/gr_soc_a/revoke", { sub: "dev_b" })).status, 404);
    assert.deepEqual(h.app.ctx.revocations.readAll().entries.map((e) => `${e.type}:${e.grant}`), ["grant_revoked:gr_msg_a", "grant_revoked:gr_soc_a"]);
    const scopes = (await h.call("GET", "/v1/me")).body.grants.filter((g: { status: string }) => g.status === "REVOKED").map((g: { scope: string }) => g.scope).sort();
    assert.deepEqual(scopes, ["messaging.use", "social.post"]);
  } finally {
    await h.close();
  }
});
