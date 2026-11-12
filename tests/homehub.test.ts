// Le‑NodeHome và HaaS (V1.0.1, SRS V2.0 mục 06–07, N20‑HOME, N20‑HAAS, LNH-T66) qua API thật: cổng, máy HAAS_ đi qua mọi cạnh và
// mọi người làm, quyền của chủ hộ và của LeLS, danh tính hub mô phỏng, chống trùng và sự kiện trễ (X05), đổi hub và binding cũ (X07),
// quyền xem tạm thời có hạn (X06 một phần), dọn theo hạn, xuất và xóa, restore, và phép quét: không trường hình, video, âm thanh.
// Người dùng là ba tài khoản thử tổng hợp; hub và camera là dữ liệu giả lập.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, MINUTE } from "../src/core/clock.ts";
import { MESSAGES } from "../src/core/errors.ts";
import { SCHEMAS } from "../src/server/app.ts";
import { HOME_LIMITS, exportHomeFor, homehub, hubProof } from "../src/server/homehub.ts";
import { transitionsFor } from "../src/server/machine.ts";
import { MODULES } from "../src/server/modules.ts";
import { applyRevocations, backupLedger, restoreLedgerFile } from "../src/server/recovery.ts";
import { grantConsentsDirect } from "../src/server/seed.ts";
import { all, one, run } from "../src/server/store.ts";
import { harness, key, WS, type Harness } from "./helpers.ts";

const TERMS = HOME_LIMITS.termsVersion;
const REQUEST = { site_ref: "site-home-synthetic-01", package_code: "HOME_PILOT", contact_grant: "IN_APP", terms_version: TERMS };
const CAMS = ["cam_front", "cam_yard"];

async function homeHarness() {
  const h = await harness();
  grantConsentsDirect(h.app.ctx, "dev_a", ["home_hub"]);
  grantConsentsDirect(h.app.ctx, "dev_b", ["home_hub"]);
  return h;
}

type Sub = { subscription_ref: string; state: string; revision: number; hub: { hub_id: string; serial: string; binding_version: number } | null; [k: string]: unknown };
const S = (id: string) => `/v2/home/subscriptions/${id}`;
const O = (id: string) => `/v2/ops/home/subscriptions/${id}`;
const sub = async (h: Harness, id: string, who = "dev_a"): Promise<Sub> =>
  ((await h.call("GET", "/v2/home/subscriptions", { sub: who })).body.subscriptions as Sub[]).find((s) => s.subscription_ref === id) as Sub;
const rev = (id: string, h: Harness) => (one<{ revision: number }>(h.app.ctx.db, "SELECT revision FROM home_subscriptions WHERE id = ?", id) as { revision: number }).revision;
const state = (id: string, h: Harness) => one<{ state: string }>(h.app.ctx.db, "SELECT state FROM home_subscriptions WHERE id = ?", id)?.state;
const count = (h: Harness, table: string, where = "1 = 1", ...args: (string | number)[]) => (one<{ n: number }>(h.app.ctx.db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args) as { n: number }).n;

/** Bước của chủ hộ hoặc LeLS với revision hiện hành (đúng bản người đó vừa xem). */
async function ownerStep(h: Harness, id: string, op: string, extra: Record<string, unknown> = {}, who = "dev_a") {
  return h.call("POST", `${S(id)}/${op}`, { sub: who, body: { revision: rev(id, h), ...extra } });
}
const OPS_BODY: Record<string, Record<string, unknown>> = {
  survey: { camera_count: 2, quote_vnd: 690000 },
  reject: { reason_code: "INCOMPATIBLE" },
  install: { serial: "LNH-HUB-0001", firmware: "1.0.0", camera_refs: CAMS },
  "replace-hub": { serial: "LNH-HUB-0002", firmware: "1.0.1", camera_refs: CAMS },
  suspend: { reason_code: "MAINTENANCE" },
  resume: { reason_code: "MAINTENANCE" },
  terminate: { reason_code: "END_OF_TERM" },
  return: { hub_wiped: true },
};
async function opsStep(h: Harness, id: string, op: string, extra: Record<string, unknown> = {}, who = "dev_ops") {
  return h.call("POST", `${O(id)}/${op}`, { sub: who, body: { revision: rev(id, h), ...OPS_BODY[op], ...extra } });
}

/** Đưa một đăng ký mới của dev_a tới trạng thái `target` qua đúng các route. */
async function reach(h: Harness, target: string): Promise<string> {
  const c = await h.call("POST", "/v2/home/subscriptions", { body: REQUEST });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const id = c.body.subscription_ref as string;
  const path: [string, () => Promise<{ status: number; body: any }>][] = [
    ["HAAS_SURVEYED", () => opsStep(h, id, "survey")],
    ["HAAS_ACCEPTED", () => ownerStep(h, id, "accept-quote")],
    ["HAAS_INSTALLED", () => opsStep(h, id, "install", { serial: `LNH-HUB-${id.slice(5, 13).toUpperCase().replace(/[^A-Z0-9]/g, "0")}` })],
    ["HAAS_ACTIVE", async () => ownerStep(h, id, "confirm-install", { serial: (await sub(h, id)).hub?.serial })],
    ["HAAS_SUSPENDED", () => opsStep(h, id, "suspend")],
  ];
  if (target === "HAAS_REQUESTED") return id;
  if (target === "HAAS_TERMINATED") {
    await reach2(path, "HAAS_ACTIVE");
    assert.equal((await ownerStep(h, id, "terminate")).status, 200);
    return id;
  }
  await reach2(path, target);
  return id;
}
async function reach2(path: [string, () => Promise<{ status: number; body: any }>][], target: string) {
  for (const [st, fn] of path) {
    const r = await fn();
    assert.equal(r.status, 200, `${st}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.state, st);
    if (st === target) return;
  }
}
/** Đóng hẳn đăng ký (dữ liệu kiểm thử) để dev_a mở được đăng ký mới. */
const clear = (h: Harness) => {
  run(h.app.ctx.db, "UPDATE home_subscriptions SET state = 'HAAS_RETURNED'");
  run(h.app.ctx.db, "UPDATE home_hubs SET status = 'REVOKED'");
};

async function credential(h: Harness, hubId: string) {
  const r = await fetch(`${h.base}/dev/home/hub-credential?hub_id=${hubId}`);
  return { status: r.status, body: (await r.json()) as { token: string; key: string; binding_version: number; cameras: string[]; workspace_id: string; simulated: boolean } };
}

let seq = 0;
function envelope(binding: number, o: Partial<Record<string, unknown>> = {}, at = "2026-11-11T02:00:00.000Z") {
  return { event_id: `ev-${String(++seq).padStart(6, "0")}`, observed_at: at, type: "PERSON_IN_ZONE", camera_ref: "cam_front", binding_version: binding, schema_version: 1, epoch: 1, ...o };
}
async function hubPost(h: Harness, hubId: string, env: Record<string, unknown>, o: { token?: string; key?: string; idem?: string; ws?: string } = {}) {
  const cred = o.token && o.key ? null : (await credential(h, hubId)).body;
  const body = { ...env, proof: hubProof((o.key ?? cred?.key) as string, env) };
  return h.call("POST", `/v2/home/hubs/${hubId}/events`, { headers: { Authorization: `Bearer ${o.token ?? cred?.token}` }, body, key: o.idem, ws: o.ws });
}

test("mô-đun đã đăng ký; dữ liệu mẫu cấp home.hub cho dev_a, dev_b (không cho vận hành) và không cấp sẵn đồng ý; mã lỗi mới có câu tiếng Việt", async () => {
  assert.ok(MODULES.includes(homehub));
  const h = await harness();
  try {
    for (const s of ["dev_a", "dev_b"]) {
      const me = (await h.call("GET", "/v1/me", { sub: s })).body;
      assert.equal(me.modules.home_hub, true);
      assert.equal(me.grants.filter((g: { scope: string }) => g.scope === "home.hub").length, 1);
      const r = await h.call("GET", "/v2/home/subscriptions", { sub: s });
      assert.equal(r.body.code, "CONSENT_REQUIRED", "người dùng tự bật đồng ý");
    }
    assert.equal(count(h, "grants", "user_id = 'dev_ops' AND scope = 'home.hub'"), 0);
    await h.restart();
    assert.equal(count(h, "grants", "scope = 'home.hub'"), 2, "seed không nhân đôi");
    for (const [code, text] of Object.entries(homehub.errors ?? {})) {
      assert.equal(MESSAGES[code], text);
      assert.match(text, /[à-ỹ]/i);
    }
  } finally {
    await h.close();
  }
});

test("cổng: thành viên (404) → cờ home_hub (503) → quyền (403) → đồng ý (403); người khác, workspace khác 404; LeLS cần vai SITE_OPERATOR; trường lạ 400", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    assert.equal((await h.call("GET", `${S(id)}/events`, { sub: "dev_b" })).status, 404, "đăng ký của người khác: 404 đồng nhất");
    assert.equal((await h.call("GET", `${S(id)}/events`, { sub: "dev_ops" })).status, 403, "vận hành không có home.hub");
    assert.equal((await h.call("GET", "/v2/home/subscriptions", { ws: "ws_other" })).status, 404);
    assert.equal((await h.call("GET", "/v2/ops/home/subscriptions", { sub: "dev_a" })).status, 403, "chủ hộ không có vai LeLS");
    assert.equal((await opsStep(h, id, "suspend", {}, "dev_b")).status, 403);
    assert.equal((await h.call("POST", `${S(id)}/accept-quote`, { sub: "dev_ops", body: { revision: 1 } })).status, 403);
    assert.equal((await h.call("POST", "/v2/home/subscriptions", { body: { ...REQUEST, image: "x" } })).status, 400);
    assert.equal((await h.call("POST", "/v2/home/subscriptions", { body: REQUEST, key: null })).status, 400, "POST thiếu Idempotency-Key");
    const outdated = await h.call("POST", "/v2/home/subscriptions", { sub: "dev_b", body: { ...REQUEST, terms_version: "haas-terms-v0" } });
    assert.equal(outdated.body.code, "HOME_TERMS_OUTDATED");
    assert.deepEqual(SCHEMAS.validate("HomeError", outdated.body), [], "thân lỗi khớp hợp đồng (HomeError)");
    assert.equal((await h.call("POST", "/v2/home/subscriptions", { body: REQUEST })).body.code, "HOME_OPEN_LIMIT", "một đăng ký đang mở");
    run(h.app.ctx.db, "UPDATE grants SET status = 'REVOKED' WHERE user_id = 'dev_b' AND scope = 'home.hub'");
    assert.equal((await h.call("GET", "/v2/home/subscriptions", { sub: "dev_b" })).body.code, "FORBIDDEN");
    const off = await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "home_hub", enabled: false, reason: "kiểm cổng home" } });
    assert.equal(off.status, 200);
    assert.equal((await h.call("GET", "/v2/home/subscriptions")).body.code, "MODULE_DISABLED");
    assert.equal((await h.call("GET", "/v2/ops/home/subscriptions", { sub: "dev_ops" })).body.code, "MODULE_DISABLED");
    const hubId = (await sub(h, id).catch(() => null))?.hub?.hub_id ?? one<{ hub_id: string }>(h.app.ctx.db, "SELECT hub_id FROM home_subscriptions WHERE id = ?", id)!.hub_id;
    assert.equal((await hubPost(h, hubId, envelope(1))).body.code, "MODULE_DISABLED", "hub cũng dừng khi cờ tắt");
  } finally {
    await h.close();
  }
});

test("máy HAAS_: mọi cạnh của contracts/state_transitions.csv đi được bằng đúng người làm, ghi bước kèm loại người làm; mọi bước ngoài bảng là 409", async () => {
  const h = await homeHarness();
  try {
    const rows = transitionsFor("HAAS_");
    assert.equal(rows.length, 24);
    for (const t of rows) {
      let id: string;
      if (t.event === "close") {
        // Hệ thống đóng ngay khi chưa từng lắp hub.
        id = await reach(h, "HAAS_REQUESTED");
        assert.equal((await ownerStep(h, id, "cancel")).body.state, "HAAS_RETURNED");
      } else if (t.event === "revoke") {
        id = await reach(h, t.from);
        const w = await h.call("POST", "/v1/consents/home_hub/withdraw", { body: {} });
        assert.equal(w.status, 200, JSON.stringify(w.body));
        assert.ok(["HAAS_TERMINATED", "HAAS_RETURNED"].includes(state(id, h) as string));
        grantConsentsDirect(h.app.ctx, "dev_a", ["home_hub"]);
      } else {
        id = await reach(h, t.from);
        const ownerOp = { cancel: "cancel", accept_quote: "accept-quote", confirm_install: "confirm-install", terminate: "terminate" }[t.event];
        const opsOp = { survey: "survey", reject: "reject", install: "install", replace_hub: "replace-hub", suspend: "suspend", resume: "resume", terminate: "terminate", return_hub: "return" }[t.event];
        const extra = t.event === "confirm_install" ? { serial: (await sub(h, id)).hub?.serial } : {};
        const r = t.actor === "OWNER" ? await ownerStep(h, id, ownerOp as string, extra) : await opsStep(h, id, opsOp as string);
        assert.equal(r.status, 200, `${t.from} --${t.event}/${t.actor}--> ${JSON.stringify(r.body)}`);
      }
      const steps = all<{ event: string; actor_kind: string; to_state: string }>(h.app.ctx.db, "SELECT event, actor_kind, to_state FROM home_steps WHERE subscription_id = ? ORDER BY seq", id);
      assert.ok(steps.some((s) => s.event === t.event && s.actor_kind === t.actor && s.to_state === t.to), `${t.from} --${t.event}/${t.actor}--> ${t.to}: ${JSON.stringify(steps)}`);
      clear(h);
    }
    // Ma trận phủ định: ở mỗi trạng thái, mọi bước không có trong bảng nhận 409 INVALID_TRANSITION và không đổi gì.
    const OWNER_OPS = { "accept-quote": "accept_quote", "confirm-install": "confirm_install", cancel: "cancel", terminate: "terminate" } as const;
    const OPS = { survey: "survey", reject: "reject", install: "install", "replace-hub": "replace_hub", suspend: "suspend", resume: "resume", terminate: "terminate", return: "return_hub" } as const;
    for (const st of ["HAAS_REQUESTED", "HAAS_SURVEYED", "HAAS_ACCEPTED", "HAAS_INSTALLED", "HAAS_ACTIVE", "HAAS_SUSPENDED", "HAAS_TERMINATED"]) {
      const id = await reach(h, st);
      const has = (event: string, actor: string) => rows.some((t) => t.from === st && t.event === event && t.actor === actor);
      for (const [op, event] of Object.entries(OWNER_OPS)) {
        if (has(event, "OWNER")) continue;
        const r = await ownerStep(h, id, op, op === "confirm-install" ? { serial: "LNH-HUB-0000" } : {});
        assert.equal(r.body.code, "INVALID_TRANSITION", `${st} chủ hộ ${op}: ${JSON.stringify(r.body)}`);
      }
      for (const [op, event] of Object.entries(OPS)) {
        if (has(event, "LELS")) continue;
        const r = await opsStep(h, id, op, op === "install" || op === "replace-hub" ? { serial: "LNH-HUB-9999" } : {});
        assert.equal(r.body.code, "INVALID_TRANSITION", `${st} LeLS ${op}: ${JSON.stringify(r.body)}`);
      }
      assert.equal(state(id, h), st);
      clear(h);
    }
  } finally {
    await h.close();
  }
});

test("quyền theo trạng thái ở máy chủ: revision cũ 409; chủ hộ phải nhận báo giá và xác nhận đúng serial; LeLS không làm trên đăng ký của chính mình và không thấy sự kiện; chấm dứt cần đăng nhập mới", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_SURVEYED");
    const stale = await h.call("POST", `${S(id)}/accept-quote`, { body: { revision: 1 } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "HOME_REVISION_CONFLICT");
    assert.equal(stale.body.revision, rev(id, h));
    assert.deepEqual(SCHEMAS.validate("HomeError", stale.body), [], "thân lỗi khớp hợp đồng (HomeError)");
    const viewed = await sub(h, id);
    assert.equal(viewed.quote_vnd, 690000);
    assert.equal(viewed.access && (viewed.access as { clip_view: string }).clip_view, "UNAVAILABLE");
    await ownerStep(h, id, "accept-quote");
    await opsStep(h, id, "install");
    assert.equal((await ownerStep(h, id, "confirm-install", { serial: "LNH-HUB-9998" })).body.code, "HOME_SERIAL_MISMATCH");
    assert.equal((await ownerStep(h, id, "confirm-install", { serial: "LNH-HUB-0001" })).body.state, "HAAS_ACTIVE");
    const ops = (await h.call("GET", "/v2/ops/home/subscriptions", { sub: "dev_ops" })).body.subscriptions[0];
    assert.deepEqual(Object.keys(ops.hub).sort(), ["cameras", "cameras_online", "firmware", "hub_id", "last_seen_at", "serial", "status"]);
    assert.ok(!("events" in ops) && !("steps" in ops), "LeLS chỉ thấy trạng thái vận hành");
    assert.equal((await h.call("GET", `${O(id)}/events`, { sub: "dev_ops" })).body.code, "HOME_VIEW_GRANT_REQUIRED");
    // Vận hành viên tự đăng ký cho nhà mình: không được tự khảo sát.
    run(h.app.ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES ('gr_ops_home', ?, 'dev_ops', 'home.hub', NULL, 'ACTIVE', ?)", WS, "2026-11-11T02:00:00.000Z");
    grantConsentsDirect(h.app.ctx, "dev_ops", ["home_hub"]);
    const mine = await h.call("POST", "/v2/home/subscriptions", { sub: "dev_ops", body: REQUEST });
    assert.equal((await opsStep(h, mine.body.subscription_ref, "survey")).status, 403);
    const old = h.token("dev_a", { authTime: Math.floor(h.clock.now() / 1000) - 600 });
    const t = await h.call("POST", `${S(id)}/terminate`, { headers: { Authorization: `Bearer ${old}` }, body: { revision: rev(id, h) } });
    assert.equal(t.body.code, "REAUTH_REQUIRED");
  } finally {
    await h.close();
  }
});

test("danh tính hub: token người dùng, hub khác, workspace khác, chữ ký sai, hub đã thu hồi đều 401 HOME_HUB_IDENTITY_INVALID; đường dev phát token sub hub:<id> và khóa mô phỏng", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const hubId = (await sub(h, id)).hub!.hub_id;
    const cred = await credential(h, hubId);
    assert.equal(cred.status, 200);
    assert.equal(cred.body.simulated, true);
    assert.deepEqual(cred.body.cameras, CAMS);
    const env = envelope(1);
    const userCall = await h.call("POST", `/v2/home/hubs/${hubId}/events`, { sub: "dev_a", body: { ...env, proof: hubProof(cred.body.key, env) } });
    assert.equal(userCall.status, 401);
    assert.equal(userCall.body.code, "HOME_HUB_IDENTITY_INVALID", "token người dùng không phải danh tính hub");
    const badSig = await h.call("POST", `/v2/home/hubs/${hubId}/events`, { headers: { Authorization: `Bearer ${cred.body.token}` }, body: { ...env, proof: "A".repeat(43) } });
    assert.equal(badSig.body.code, "HOME_HUB_IDENTITY_INVALID");
    assert.equal((await hubPost(h, hubId, env, { ws: "ws_other" })).status, 401);
    const other = await h.call("POST", `/v2/home/hubs/hub_somewhere_else/events`, { headers: { Authorization: `Bearer ${cred.body.token}` }, body: { ...env, proof: hubProof(cred.body.key, env) } });
    assert.equal(other.status, 401, "token của hub này không dùng cho đường dẫn hub khác");
    assert.equal((await hubPost(h, hubId, env)).status, 201);
    assert.equal(count(h, "home_events"), 1);
    assert.equal((await fetch(`${h.base}/dev/home/hub-credential?hub_id=hub_none`)).status, 404);
  } finally {
    await h.close();
  }
});

test("X05: gửi trùng không nhân đôi (cùng hub, camera, epoch, event_id); sự kiện trễ giữ giờ quan sát và cờ đến trễ; trạng thái camera không bị sự kiện cũ ghi đè; tạm ngừng thì hub không gửi được, mở lại thì hàng đợi vào với cờ trễ", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const hubId = (await sub(h, id)).hub!.hub_id;
    const cred = (await credential(h, hubId)).body;
    const o = { token: cred.token, key: cred.key };
    const e1 = envelope(1, { clip_ref: "clp_abcdefgh1234" });
    const idem = key();
    const first = await hubPost(h, hubId, e1, { ...o, idem });
    assert.equal(first.status, 201);
    assert.equal(first.body.late, false);
    const replay = await hubPost(h, hubId, e1, { ...o, idem });
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    const again = await hubPost(h, hubId, e1, o);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.deepEqual(SCHEMAS.validate("HomeHubReceipt", again.body), [], "200 của sự kiện trùng có trong hợp đồng");
    assert.equal(again.body.event_ref, first.body.event_ref);
    assert.equal((await hubPost(h, hubId, { ...e1, epoch: 2 }, o)).status, 201, "epoch mới sau khởi động lại hub là sự kiện khác");
    assert.equal(count(h, "home_events"), 2);
    // Camera mất kết nối lúc 02:00, có lại lúc 02:01; một sự kiện «mất kết nối» cũ hơn tới sau không ghi đè.
    h.clock.advance(10 * MINUTE);
    await hubPost(h, hubId, envelope(1, { type: "CAMERA_ONLINE", camera_ref: "cam_yard" }, "2026-11-11T02:01:00.000Z"), o);
    const late = await hubPost(h, hubId, envelope(1, { type: "CAMERA_OFFLINE", camera_ref: "cam_yard" }, "2026-11-11T02:00:30.000Z"), o);
    assert.equal(late.body.late, true);
    const cams = (await sub(h, id)).hub as unknown as { cameras: { camera_ref: string; online: boolean }[] };
    assert.equal(cams.cameras.find((c) => c.camera_ref === "cam_yard")?.online, true);
    const list = (await h.call("GET", `${S(id)}/events`)).body;
    const lateRow = list.events.find((e: { event_ref: string }) => e.event_ref === late.body.event_ref);
    assert.equal(lateRow.observed_at, "2026-11-11T02:00:30.000Z", "giữ giờ quan sát, không dùng giờ nhận");
    assert.equal(lateRow.late, true);
    assert.equal(lateRow.verified, false);
    assert.equal(list.clip_view, "UNAVAILABLE");
    assert.equal((await hubPost(h, hubId, envelope(1, { camera_ref: "cam_unknown" }), o)).body.code, "HOME_UNKNOWN_CAMERA");
    assert.equal((await hubPost(h, hubId, envelope(1, { type: "CAMERA_OFFLINE", clip_ref: "clp_abcdefgh9999" }), o)).status, 400, "clip chỉ đi với PERSON_IN_ZONE");
    assert.equal((await hubPost(h, hubId, envelope(1, {}, "2026-11-12T02:00:00.000Z"), o)).body.code, "HOME_EVENT_TIME", "giờ quan sát ở tương lai");
    await opsStep(h, id, "suspend");
    const queued = envelope(1, { type: "HUB_OFFLINE_RECOVERED" }, "2026-11-11T02:05:00.000Z");
    assert.equal((await hubPost(h, hubId, queued, o)).body.code, "HOME_NOT_ACCEPTING");
    assert.ok((await h.call("GET", `${S(id)}/events`)).body.events.length > 0, "chủ hộ vẫn xem lịch sử khi tạm ngừng");
    await opsStep(h, id, "resume");
    const after = await hubPost(h, hubId, queued, o);
    assert.equal(after.status, 201);
    assert.equal(after.body.late, true);
  } finally {
    await h.close();
  }
});

test("X07: đổi hub thu hồi danh tính cũ và tăng binding_version; hàng đợi của hub cũ bị từ chối, binding cũ trên hub mới 409; chủ hộ xác nhận lại; chấm dứt khi còn hàng đợi: hub bị chặn, sự kiện bị xóa, LeLS thu hồi hub rồi RETURNED", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const oldHub = (await sub(h, id)).hub!.hub_id;
    const oldCred = (await credential(h, oldHub)).body;
    assert.equal((await hubPost(h, oldHub, envelope(1), { token: oldCred.token, key: oldCred.key })).status, 201);
    const rep = await opsStep(h, id, "replace-hub");
    assert.equal(rep.body.state, "HAAS_INSTALLED");
    assert.equal(rep.body.binding_version, 2);
    const s = await sub(h, id);
    assert.notEqual(s.hub!.hub_id, oldHub);
    assert.equal((await hubPost(h, oldHub, envelope(1), { token: oldCred.token, key: oldCred.key })).body.code, "HOME_HUB_IDENTITY_INVALID", "hàng đợi của hub cũ bị chặn");
    assert.equal((await credential(h, oldHub)).status, 404);
    const staleBinding = await hubPost(h, s.hub!.hub_id, envelope(1));
    assert.equal(staleBinding.body.code, "HOME_BINDING_STALE");
    assert.deepEqual(SCHEMAS.validate("HomeError", staleBinding.body), [], "thân lỗi khớp hợp đồng (HomeError)");
    assert.equal((await hubPost(h, s.hub!.hub_id, envelope(2))).status, 201, "sự kiện thử lúc lắp, trước khi chủ hộ xác nhận");
    assert.equal((await ownerStep(h, id, "confirm-install", { serial: "LNH-HUB-0001" })).body.code, "HOME_SERIAL_MISMATCH", "serial của hub cũ");
    assert.equal((await ownerStep(h, id, "confirm-install", { serial: "LNH-HUB-0002" })).body.state, "HAAS_ACTIVE");
    assert.equal(count(h, "home_events", "subscription_id = ?", id), 2);
    // Chấm dứt khi hub mới còn hàng đợi.
    const newHub = s.hub!.hub_id;
    const cred = (await credential(h, newHub)).body;
    assert.equal((await ownerStep(h, id, "terminate")).body.state, "HAAS_TERMINATED");
    assert.equal((await hubPost(h, newHub, envelope(2), { token: cred.token, key: cred.key })).body.code, "HOME_HUB_IDENTITY_INVALID");
    assert.equal(count(h, "home_events", "subscription_id = ?", id), 0, "sự kiện ở máy chủ đã xóa");
    assert.deepEqual((await h.call("GET", `${S(id)}/events`)).body.events, []);
    assert.equal((await h.call("POST", `${O(id)}/return`, { sub: "dev_ops", body: { revision: rev(id, h), hub_wiped: false } })).status, 400, "biên bản cần xác nhận đã xóa dữ liệu tại hub");
    assert.equal((await opsStep(h, id, "return")).body.state, "HAAS_RETURNED");
    const types = h.app.ctx.revocations.readAll().entries.map((e) => e.type);
    assert.ok(types.filter((t) => t === "home_hub_revoked").length >= 2 && types.includes("home_subscription_ended"));
  } finally {
    await h.close();
  }
});

test("X06 (một phần): chủ hộ cấp quyền xem tạm thời cho LeLS theo ticket; mỗi lần dùng được đếm và ghi nhật ký; hết hạn hoặc thu hồi thì mất quyền; restore không mở lại quyền đã thu hồi; xem clip từ xa chưa có", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const hubId = (await sub(h, id)).hub!.hub_id;
    await hubPost(h, hubId, envelope(1, { clip_ref: "clp_abcdefgh5555" }));
    assert.equal((await h.call("POST", `${S(id)}/view-grants`, { body: { ticket_ref: "TK-0001", minutes: 5 } })).status, 400, "tối thiểu 15 phút");
    const g = await h.call("POST", `${S(id)}/view-grants`, { body: { ticket_ref: "TK-0001", minutes: 15 } });
    assert.equal(g.status, 201);
    assert.equal(g.body.active, true);
    assert.equal((await h.call("POST", `${S(id)}/view-grants`, { body: { ticket_ref: "TK-0002", minutes: 15 } })).body.code, "HOME_VIEW_GRANT_ACTIVE");
    assert.equal((await h.call("POST", `${S(id)}/view-grants`, { sub: "dev_b", body: { ticket_ref: "TK-0002", minutes: 15 } })).status, 404);
    const seen = await h.call("GET", `${O(id)}/events`, { sub: "dev_ops" });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.events.length, 1);
    assert.ok(!JSON.stringify(seen.body).includes("clp_"), "LeLS không nhận clip_ref");
    assert.equal(seen.body.clip_view, "UNAVAILABLE");
    await h.call("GET", `${O(id)}/events`, { sub: "dev_ops" });
    const used = (await sub(h, id)).view_grants as { uses: number; last_used_at: string }[];
    assert.equal(used[0].uses, 2);
    assert.equal(count(h, "audit", "action = 'home.view_grant.use'"), 2);
    h.clock.advance(16 * MINUTE);
    assert.equal((await h.call("GET", `${O(id)}/events`, { sub: "dev_ops" })).body.code, "HOME_VIEW_GRANT_REQUIRED", "hết hạn");
    const g2 = await h.call("POST", `${S(id)}/view-grants`, { body: { ticket_ref: "TK-0003", minutes: 60 } });
    const backupPath = join(h.dir, "truoc-khi-thu-hoi.db");
    backupLedger(h.app.ctx, backupPath);
    assert.equal((await h.call("POST", `/v2/home/view-grants/${g2.body.grant_id}/revoke`, { body: {} })).body.active, false);
    assert.equal((await h.call("GET", `${O(id)}/events`, { sub: "dev_ops" })).status, 403);
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    assert.equal(count(h, "home_view_grants", "id = ? AND revoked_at IS NULL", g2.body.grant_id), 1, "bản restore còn quyền cũ");
    applyRevocations(h.app.ctx);
    assert.equal((await h.call("GET", `${O(id)}/events`, { sub: "dev_ops" })).status, 403, "sau khi nạp lại sổ thu hồi");
    const again = applyRevocations(h.app.ctx);
    assert.ok(again.applied >= 0, "nạp lần hai an toàn");
  } finally {
    await h.close();
  }
});

test("restore: hub đã thu hồi và đăng ký đã chấm dứt sau bản sao lưu không sống lại; rút đồng ý home_hub làm hệ thống chấm dứt và thu hồi hub", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const hubId = (await sub(h, id)).hub!.hub_id;
    const backupPath = join(h.dir, "truoc-khi-cham-dut.db");
    backupLedger(h.app.ctx, backupPath);
    await ownerStep(h, id, "terminate");
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    assert.equal(state(id, h), "HAAS_ACTIVE", "bản restore cũ");
    applyRevocations(h.app.ctx);
    assert.equal(state(id, h), "HAAS_TERMINATED");
    assert.equal(one<{ status: string }>(h.app.ctx.db, "SELECT status FROM home_hubs WHERE id = ?", hubId)?.status, "REVOKED");
    assert.equal((await credential(h, hubId)).status, 404, "đường dev không còn phát danh tính cho hub đã thu hồi");
    clear(h);
    const id2 = await reach(h, "HAAS_ACTIVE");
    const hub2 = (await sub(h, id2)).hub!.hub_id;
    assert.equal((await h.call("POST", "/v1/consents/home_hub/withdraw", { body: {} })).status, 200);
    assert.equal(state(id2, h), "HAAS_TERMINATED");
    assert.equal(one<{ status: string }>(h.app.ctx.db, "SELECT status FROM home_hubs WHERE id = ?", hub2)?.status, "REVOKED");
    const steps = all<{ event: string; actor_kind: string }>(h.app.ctx.db, "SELECT event, actor_kind FROM home_steps WHERE subscription_id = ? ORDER BY seq", id2);
    assert.deepEqual({ ...steps.at(-1) }, { event: "revoke", actor_kind: "SYSTEM" });
  } finally {
    await h.close();
  }
});

test("dọn theo hạn: sự kiện quá hạn lưu bị xóa ở tick; thu hồi quyền home.hub làm hệ thống chấm dứt ở tick", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const hubId = (await sub(h, id)).hub!.hub_id;
    await hubPost(h, hubId, envelope(1));
    h.clock.advance(HOME_LIMITS.eventRetentionMs - DAY);
    await hubPost(h, hubId, envelope(1, {}, new Date(h.clock.now()).toISOString()));
    await h.app.tick();
    assert.equal(count(h, "home_events"), 2);
    h.clock.advance(2 * DAY);
    await h.app.tick();
    assert.equal(count(h, "home_events"), 1, "chỉ còn sự kiện trong hạn");
    run(h.app.ctx.db, "UPDATE grants SET status = 'REVOKED' WHERE user_id = 'dev_a' AND scope = 'home.hub'");
    await h.app.tick();
    assert.equal(state(id, h), "HAAS_TERMINATED");
    assert.equal(count(h, "home_events"), 0);
  } finally {
    await h.close();
  }
});

test("xuất và xóa: bản xuất của đăng ký và phần home trong tệp xuất không có khóa hub hay token; DELETE xóa mọi hàng và dấu chống lặp; restore rồi nạp lại sổ thu hồi xóa lại", async () => {
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const hubId = (await sub(h, id)).hub!.hub_id;
    const cred = (await credential(h, hubId)).body;
    await hubPost(h, hubId, envelope(1, { clip_ref: "clp_exportclip01" }), { token: cred.token, key: cred.key });
    const ex = (await h.call("GET", `${S(id)}/export`)).body;
    assert.equal(ex.subscription.events.length, 1);
    const ext = JSON.stringify(ex);
    assert.ok(!ext.includes(cred.key) && !ext.includes("hmac") && !ext.includes(cred.token));
    const req = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
    assert.equal(req.status, 202, JSON.stringify(req.body));
    const file = (await h.call("GET", req.body.export.path)).body;
    assert.deepEqual(file.modules.homehub, JSON.parse(JSON.stringify(exportHomeFor(h.app.ctx, WS, "dev_a"))));
    assert.ok(!JSON.stringify(file).includes(cred.key));
    const backupPath = join(h.dir, "truoc-khi-xoa.db");
    backupLedger(h.app.ctx, backupPath);
    const TABLES = ["home_subscriptions", "home_steps", "home_hubs", "home_cameras", "home_events", "home_view_grants"];
    const gone = (why: string) => {
      for (const t of TABLES) assert.equal(count(h, t), 0, `${why}: ${t}`);
      assert.equal(count(h, "idem_keys", "substr(route, 1, 9) = '/v2/home/' OR substr(route, 1, 13) = '/v2/ops/home/'"), 0, `${why}: dấu chống lặp`);
    };
    assert.equal((await h.call("POST", "/v1/privacy/requests", { body: { type: "DELETE" } })).status, 202);
    gone("sau DELETE");
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    assert.ok(count(h, "home_events") > 0);
    applyRevocations(h.app.ctx);
    gone("sau restore và nạp lại sổ thu hồi");
  } finally {
    await h.close();
  }
});

test("phép quét: phong bì không có trường hình, video, âm thanh, khuôn mặt hay danh tính; clip_ref không phải URL; sổ, phản hồi và bản xuất không chứa dữ liệu hình hay đường dẫn", async () => {
  const env = { event_id: "ev-scan-0001", observed_at: "2026-11-11T02:00:00.000Z", type: "PERSON_IN_ZONE", camera_ref: "cam_front", binding_version: 1, schema_version: 1, epoch: 1, proof: "A".repeat(43) };
  assert.deepEqual(SCHEMAS.validate("HomeHubEvent", env), []);
  for (const field of ["image", "snapshot", "thumbnail", "video", "video_url", "audio", "face", "face_id", "person_id", "identity", "url"]) {
    assert.ok(SCHEMAS.validate("HomeHubEvent", { ...env, [field]: "x" }).length > 0, `trường ${field} bị từ chối`);
  }
  for (const clip of ["https://example.invalid/clip.mp4", "data:video/mp4;base64,AAAA", "clp_../../etc"]) assert.ok(SCHEMAS.validate("HomeHubEvent", { ...env, clip_ref: clip }).length > 0, clip);
  assert.ok(SCHEMAS.validate("HomeHubEvent", { ...env, type: "FACE_MATCH" }).length > 0);
  const props = Object.keys((JSON.parse(readFileSync(new URL("../contracts/openapi/homehub.json", import.meta.url), "utf8")).components.schemas.HomeHubEvent.properties));
  assert.deepEqual(props.sort(), ["binding_version", "camera_ref", "clip_ref", "epoch", "event_id", "observed_at", "proof", "schema_version", "type"]);
  const h = await homeHarness();
  try {
    const id = await reach(h, "HAAS_ACTIVE");
    const hubId = (await sub(h, id)).hub!.hub_id;
    for (const type of ["PERSON_IN_ZONE", "CAMERA_OFFLINE", "CAMERA_ONLINE", "HUB_OFFLINE_RECOVERED"]) assert.equal((await hubPost(h, hubId, envelope(1, { type }))).status, 201);
    const dump = JSON.stringify([...["home_events", "home_hubs", "home_cameras", "home_subscriptions"].map((t) => all(h.app.ctx.db, `SELECT * FROM ${t}`)), (await h.call("GET", `${S(id)}/events`)).body, (await h.call("GET", `${S(id)}/export`)).body.subscription]);
    // Bỏ mã ngẫu nhiên và mã băm (chuỗi chữ số dài, ví dụ hex có thể chứa «face») trước khi tìm: chỉ xét chữ thật sự có nghĩa.
    const words = dump.replace(/[A-Za-z0-9_-]{16,}/g, " ").toLowerCase();
    for (const needle of ["http", "data:", "base64,", "image", "video", "audio", "face", "jpeg", "mp4"]) assert.ok(!words.includes(needle), `không có «${needle}»`);
  } finally {
    await h.close();
  }
});
