// Bản trình diễn trong trình duyệt (demo/backend.js): mọi phản hồi của bản giả trong một hành trình có kịch bản phải khớp schema
// phản hồi của hợp đồng OpenAPI đã ghép (cùng tài liệu máy chủ thật dùng), phát lại idempotent đúng như máy chủ, và các cổng
// đồng ý và cờ trả cùng mã lỗi. Chạy trên Node với đồng hồ tay, không máy chủ, không trình duyệt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { digestJcs } from "../src/core/crypto.ts";
import { SchemaSet, type Schema } from "../src/core/schema.ts";
import { loadOpenApi } from "../src/server/openapi.ts";

// Nạp bằng đường động để tsc không kiểm kiểu tệp JS của bản trình diễn (nó không thuộc phạm vi typecheck của repo).
const demo: any = await import(new URL("../demo/backend.js", import.meta.url).href);

const doc = loadOpenApi() as unknown as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, Schema>; responses?: Record<string, any> } };
const inline: Record<string, Schema> = {};
const ops: { method: string; re: RegExp; template: string; responses: Record<string, string> }[] = [];
let n = 0;
for (const [template, item] of Object.entries(doc.paths)) {
  const re = new RegExp("^" + template.replace(/\{[a-z_]+\}/g, "[A-Za-z0-9_-]{1,128}") + "$");
  for (const [method, op] of Object.entries(item)) {
    if (method === "parameters") continue;
    const responses: Record<string, string> = {};
    for (const [status, r0] of Object.entries(op.responses as Record<string, any>)) {
      const r = r0.$ref ? doc.components.responses?.[String(r0.$ref).split("/").pop() as string] : r0;
      const s = r?.content?.["application/json"]?.schema;
      if (!s) continue;
      if (s.$ref) responses[status] = String(s.$ref).split("/").pop() as string;
      else {
        const name = `Inline${++n}`;
        inline[name] = s;
        responses[status] = name;
      }
    }
    ops.push({ method: method.toUpperCase(), re, template, responses });
  }
}
const schemas = new SchemaSet({ ...doc.components.schemas, ...inline });
const checked = new Set<string>();

/** Phản hồi của bản giả khớp schema của thao tác và mã trạng thái trong hợp đồng; trả thân. */
function conform(method: string, path: string, res: { status: number; body: unknown }) {
  const op = ops.find((o) => o.method === method && o.re.test(path)) ?? ops.find((o) => o.re.test(path) && o.method === method);
  assert.ok(op, `thao tác không có trong hợp đồng: ${method} ${path}`);
  // 409 REVISION_CONFLICT mang bản hiện hành: thân của nó là SyncDraftConflict (contracts/openapi/sync.json), không phải Error chung.
  const name = (res.body as { code?: string })?.code === "REVISION_CONFLICT" && res.status === 409 ? "SyncDraftConflict" : op.responses[String(res.status)];
  assert.ok(name, `${method} ${op.template}: mã ${res.status} không có trong hợp đồng (${JSON.stringify(res.body)})`);
  assert.deepEqual(schemas.validate(name, res.body), [], `${method} ${op.template} ${res.status} ${name}: ${JSON.stringify(res.body).slice(0, 600)}`);
  checked.add(`${method} ${op.template} ${res.status}`);
  return res.body as any;
}

type Clock = { t: number };
const T0 = Date.parse("2026-11-12T02:00:00.000Z"); // 09:00 tại Hà Nội, thứ Năm

export function demoHarness(o: { at?: number; store?: { v: unknown } } = {}) {
  const clock: Clock = { t: o.at ?? T0 };
  const store = o.store ?? { v: null };
  const b = demo.createBackend({ now: () => clock.t, load: () => store.v, save: (s: unknown) => (store.v = JSON.parse(JSON.stringify(s))) });
  const tokens: Record<string, string> = {};
  async function raw(method: string, url: string, o2: { sub?: string | null; body?: unknown; key?: string | null; headers?: Record<string, string> } = {}) {
    const u = new URL(url, "https://demo.invalid");
    const sub = o2.sub === undefined ? "dev_a" : o2.sub;
    const headers: Record<string, string> = { accept: "application/json", "x-lenhip-workspace": "ws_demo", ...(o2.headers ?? {}) };
    if (sub) {
      if (!tokens[sub]) tokens[sub] = (await b.handle({ method: "POST", path: "/dev/token", search: "", headers: {}, body: JSON.stringify({ sub }) })).body.token;
      headers.authorization = `Bearer ${tokens[sub]}`;
    }
    if (method === "POST" && o2.key !== null) headers["idempotency-key"] = o2.key ?? randomBytes(32).toString("base64url");
    return b.handle({ method, path: u.pathname, search: u.search, headers, body: method === "POST" ? JSON.stringify(o2.body ?? {}) : undefined });
  }
  /** Gọi bản giả và kiểm phản hồi theo hợp đồng. */
  async function call(method: string, url: string, o2: Parameters<typeof raw>[2] = {}) {
    const res = await raw(method, url, o2);
    const path = new URL(url, "https://demo.invalid").pathname;
    if (path.startsWith("/dev/")) return { status: res.status, body: res.body, headers: res.headers };
    return { status: res.status, body: conform(method, path, res), headers: res.headers };
  }
  return { b, clock, store, raw, call, relogin: (sub: string) => delete tokens[sub] };
}
export type DemoHarness = ReturnType<typeof demoHarness>;

const consent = (h: DemoHarness, purpose: string, sub = "dev_a", choice = "GRANTED") =>
  h.call("POST", "/v1/consents", { sub, body: { purpose_id: purpose, text_version: "v1-2026-11-12", text_hash: "A".repeat(43), choice } });
const vnTomorrow = (hhmm: string) => {
  const d = new Date(T0 + 7 * 3600_000 + 86_400_000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${d}T${hhmm}:00+07:00`)).toISOString();
};

test("lõi /v1: đăng nhập thử, đồng ý, lịch, plan → xem lại → duyệt → VERIFIED với bằng chứng SIMULATED, đèn, LeLe, xuất dữ liệu", async () => {
  const h = demoHarness();
  const users = await h.call("GET", "/dev/users", { sub: null });
  assert.deepEqual(users.body.users.map((u: any) => u.sub), ["dev_a", "dev_b", "dev_ops"]);
  assert.equal((await h.call("GET", "/v1/me", { sub: null })).status, 401);

  const me = await h.call("GET", "/v1/me");
  assert.equal(me.body.user.id, "dev_a");
  assert.deepEqual(me.body.consents, [], "Thông báo đầu tiên mở như lần đầu");
  assert.ok(Object.values(me.body.modules).every((v) => v === true), "bản trình diễn bật mọi cờ");

  const start = vnTomorrow("10:00");
  const end = vnTomorrow("10:30");
  const plan = { kind: "calendar.block", schema_version: 1, workspace_ref: "ws_demo", args: { calendar_ref: "primary", start, end, zone: "Asia/Ho_Chi_Minh", title_code: "PERSONAL_TIME", visibility: "private" } };
  const gated = await h.call("POST", "/v1/plans", { body: plan });
  assert.equal(gated.status, 403);
  assert.equal(gated.body.code, "CONSENT_REQUIRED");
  assert.equal((await h.call("GET", "/v1/calendar/availability?start=2026-11-11T17:00:00.000Z&end=2026-11-13T17:00:00.000Z")).body.code, "CONSENT_REQUIRED");

  assert.equal((await consent(h, "calendar_link")).status, 201);
  assert.equal((await consent(h, "home_control")).status, 201);
  assert.equal((await consent(h, "health_local")).body.code, "HEALTH_LOCAL_ONLY");
  const av = await h.call("GET", "/v1/calendar/availability?start=2026-11-11T17:00:00.000Z&end=2026-11-13T17:00:00.000Z");
  assert.equal(av.status, 200);
  assert.ok(av.body.busy.length >= 2, "cuộc họp mô phỏng 09:00 và 14:00");
  assert.equal((await h.call("GET", "/v1/calendar/availability?start=2026-11-11T17:00:00.000Z&end=2026-12-13T17:00:00.000Z")).body.detail_code, "WINDOW_TOO_LONG");

  const p = await h.call("POST", "/v1/plans", { body: plan });
  assert.equal(p.status, 201);
  assert.equal(p.body.state, "PENDING_APPROVAL");
  assert.equal((await h.call("GET", `/v1/plans/${p.body.plan_id}`)).body.payload_digest, p.body.payload_digest);
  assert.equal((await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: "B".repeat(43) } })).body.code, "DIGEST_MISMATCH");
  const k = randomBytes(32).toString("base64url");
  const ap = await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: p.body.payload_digest }, key: k });
  assert.equal(ap.status, 202);
  const again = await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: p.body.payload_digest }, key: k });
  assert.deepEqual(again.body, ap.body, "phát lại nguyên phản hồi");
  assert.equal(again.headers["Idempotent-Replayed"], "true");
  assert.equal((await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { body: { plan_version: 3, approved_digest: p.body.payload_digest }, key: k })).body.code, "IDEMPOTENCY_CONFLICT");
  assert.equal((await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: p.body.payload_digest } })).body.code, "PLAN_STALE");
  assert.equal((await h.raw("POST", `/v1/plans/${p.body.plan_id}/cancel`, { key: null })).body.code, "IDEMPOTENCY_KEY_REQUIRED");

  const seen: string[] = [];
  for (const dt of [0, 700, 700, 1200]) {
    h.clock.t += dt;
    seen.push((await h.call("GET", `/v1/actions/${ap.body.action_id}`)).body.status);
  }
  assert.deepEqual(seen, ["AUTHORIZED", "DISPATCHING", "ACKED", "VERIFIED"]);
  const done = (await h.call("GET", `/v1/actions/${ap.body.action_id}`)).body;
  assert.equal(done.evidence_grade, "SIMULATED", "không bao giờ giả là bằng chứng thật");
  assert.equal(done.outcome, "EVENT_CREATED");
  assert.equal((await h.call("POST", `/v1/actions/${ap.body.action_id}/cancel`)).body.code, "ACTION_FINAL");
  const av2 = await h.call("GET", "/v1/calendar/availability?start=2026-11-11T17:00:00.000Z&end=2026-11-13T17:00:00.000Z");
  assert.equal(av2.body.lenhip_blocks[0].status, "VERIFIED");
  assert.equal((await h.call("GET", "/v1/actions")).body.items.length, 1);

  // Đèn: trạng thái đổi sau khi tác vụ được xác minh (mô phỏng).
  const before = (await h.call("GET", "/v1/devices?site=site_lab01")).body.devices.find((d: any) => d.device_ref === "dev_lamp_02");
  assert.equal(before.state.power, "OFF");
  const lp = await h.call("POST", "/v1/plans", { body: { kind: "device.set_power", schema_version: 1, workspace_ref: "ws_demo", args: { site: "site_lab01", device_ref: "dev_lamp_02", command: "SET_ON" } } });
  const la = await h.call("POST", `/v1/plans/${lp.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: lp.body.payload_digest } });
  h.clock.t += 3000;
  assert.equal((await h.call("GET", `/v1/actions/${la.body.action_id}`)).body.outcome, "APPLIED");
  assert.equal((await h.call("GET", "/v1/devices?site=site_lab01")).body.devices.find((d: any) => d.device_ref === "dev_lamp_02").state.power, "ON");
  assert.equal((await h.call("GET", "/v1/devices?site=site_lab01", { sub: "dev_b" })).status, 403);

  // Hủy trước khi nhận; hạn 120 giây; từ chối.
  const rp = await h.call("POST", "/v1/plans", { body: { kind: "robot.simulate", schema_version: 1, workspace_ref: "ws_demo", args: { scenario: "DELIVER_DOCUMENT" } } });
  const ra = await h.call("POST", `/v1/plans/${rp.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: rp.body.payload_digest } });
  assert.equal((await h.call("POST", `/v1/actions/${ra.body.action_id}/cancel`)).body.status, "CANCELED");
  const ep = await h.call("POST", "/v1/plans", { body: plan });
  h.clock.t += 121_000;
  const late = await h.call("POST", `/v1/plans/${ep.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: ep.body.payload_digest } });
  assert.equal(late.status, 410);
  assert.equal(late.body.code, "APPROVAL_EXPIRED");
  const cp = await h.call("POST", "/v1/plans", { body: plan });
  assert.equal((await h.call("POST", `/v1/plans/${cp.body.plan_id}/cancel`)).body.state, "CANCELED");
  const past = await h.call("POST", "/v1/plans", { body: { ...plan, args: { ...plan.args, start: new Date(T0).toISOString(), end: new Date(T0 + 1800_000).toISOString() } } });
  assert.equal(past.body.detail_code, "START_IN_PAST");

  // LeLe: cùng bảng từ và cùng phép chặn với thiết bị.
  const lele = async (text: string, context = "work") => (await h.call("POST", "/v1/lele/proposals", { body: { text, context, zone: "Asia/Ho_Chi_Minh" } })).body;
  assert.equal((await lele("dành 30 phút tập trung lúc 17:00 ngày mai")).proposal.kind, "calendar.block");
  assert.equal((await lele("bật đèn trần", "home")).proposal.args.device_ref, "dev_lamp_02");
  assert.equal((await lele("bật đèn", "home")).answer_code, "PICK_LAMP");
  assert.equal((await lele("tôi ngủ kém và đau đầu")).answer_code, "HEALTH_LOCAL");
  assert.equal((await lele("xin chào")).answer_code, "HELP");

  // Rút đồng ý: plan đang chờ không duyệt được nữa.
  const wp = await h.call("POST", "/v1/plans", { body: plan });
  assert.equal((await h.call("POST", "/v1/consents/calendar_link/withdraw")).body.withdrawn_at !== null, true);
  assert.equal((await h.call("POST", `/v1/plans/${wp.body.plan_id}/approve`, { body: { plan_version: 2, approved_digest: wp.body.payload_digest } })).body.code, "PLAN_STALE");
  assert.equal((await h.call("GET", "/v1/consents")).body.items.length, 2);

  // Xuất dữ liệu: cần đăng nhập lại trong 5 phút.
  h.clock.t += 400_000;
  assert.equal((await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } })).body.code, "REAUTH_REQUIRED");
  h.relogin("dev_a");
  const ex = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
  assert.equal(ex.status, 202);
  const file = await h.call("GET", ex.body.export.path);
  assert.equal(file.body.simulated, true);
  assert.equal((await h.call("GET", `/v1/privacy/requests/${ex.body.request_id}`)).body.status, "COMPLETED");
  assert.equal((await h.call("GET", ex.body.export.path, { sub: "dev_b" })).status, 404);
  assert.equal((await h.raw("GET", "/v1/nope")).status, 404);
});

test("trạng thái sống qua lần nạp lại trang (bộ lưu) và đặt lại về ban đầu", async () => {
  const store = { v: null as unknown };
  const h = demoHarness({ store });
  await consent(h, "calendar_link");
  const h2 = demoHarness({ store });
  assert.equal((await h2.call("GET", "/v1/me")).body.consents.length, 1);
  h2.b.reset();
  assert.equal((await h2.call("GET", "/v1/me")).body.consents.length, 0);
});

test("/v2: phiên thiết bị và bản nháp (409 REVISION_CONFLICT), Hộp tổng hợp với nguồn Outlook giả lập, Le‑NodeHome qua các bước LeLS, phép đo, mô phỏng", async () => {
  const h = demoHarness();
  // Cổng: cờ bật, nhưng chưa đồng ý thì 403 CONSENT_REQUIRED; người không có quyền thì 403 FORBIDDEN.
  assert.equal((await h.call("GET", "/v2/home/subscriptions")).body.code, "CONSENT_REQUIRED");
  assert.equal((await h.call("GET", "/v2/sim/catalog", { sub: "dev_b" })).body.code, "FORBIDDEN");
  assert.equal((await h.call("GET", "/v2/health/observations")).body.code, "CONSENT_REQUIRED");

  // Đồng bộ: hai «máy» của cùng người, sửa trên bản cũ thì 409 giữ bản hiện hành.
  const secret = () => randomBytes(32);
  const hash = (b: Buffer) => createHash("sha256").update(b).digest("base64url");
  const s1 = secret();
  const s2 = secret();
  const d1 = await h.call("POST", "/v2/devices", { body: { kind: "LAPTOP", secret_hash: hash(s1) } });
  const d2 = await h.call("POST", "/v2/devices", { body: { kind: "TABLET", secret_hash: hash(s2) } });
  assert.equal(d1.status, 201);
  const dev1 = `?device=${d1.body.device_id}.${s1.toString("base64url")}`;
  const dev2 = `?device=${d2.body.device_id}.${s2.toString("base64url")}`;
  assert.equal((await h.call("GET", "/v2/sync/drafts")).body.code, "DEVICE_REQUIRED");
  const task = { purpose: "personal_task", snapshot: { title: "Mua sữa", done: false, due: null } };
  const cr = await h.call("POST", `/v2/sync/drafts${dev1}`, { body: { draft_id: "drf_" + randomBytes(16).toString("base64url"), ...task } });
  assert.equal(cr.status, 201);
  const id = cr.body.draft_id;
  assert.equal((await h.call("GET", `/v2/sync/drafts${dev2}`)).body.drafts.length, 1);
  assert.equal((await h.call("POST", `/v2/sync/drafts/${id}/revisions${dev1}`, { body: { purpose: "personal_task", base_revision: 1, snapshot: { title: "Mua sữa và trứng", done: false, due: null } } })).body.revision, 2);
  const conflict = await h.call("POST", `/v2/sync/drafts/${id}/revisions${dev2}`, { body: { purpose: "personal_task", base_revision: 1, snapshot: { title: "Mua bánh mì", done: false, due: null } } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.current.snapshot.title, "Mua sữa và trứng");
  assert.equal((await h.call("GET", `/v2/sync/drafts/${id}${dev2}`)).body.revision, 2);
  assert.equal((await h.call("POST", `/v2/sync/drafts/${id}/discard${dev2}`, { body: { base_revision: 2 } })).body.state, "DISCARDED");
  assert.equal((await h.call("GET", `/v2/devices${dev1}`)).body.devices.length, 2);
  assert.equal((await h.call("POST", `/v2/devices/${d2.body.device_id}/revoke${dev1}`)).body.state, "REVOKED");
  assert.equal((await h.call("GET", `/v2/sync/drafts${dev2}`)).body.code, "DEVICE_REVOKED");
  assert.equal((await h.call("POST", "/v2/sync/drafts", { body: task })).body.code, "DEVICE_REQUIRED", "trang không có phiên: như máy chủ thật");

  // Hộp tổng hợp: phần tự chia sẻ, trùng, các bước, rồi nguồn Outlook giả lập cần đồng ý và đăng nhập mới.
  const imp = await h.call("POST", "/v2/inbox/imports", { body: { kind: "TEXT", purpose: "REFERENCE", storage: "WORKSPACE", text: "Xem lại biên bản họp quý" } });
  assert.equal(imp.status, 201);
  assert.equal((await h.call("POST", "/v2/inbox/imports", { body: { kind: "TEXT", purpose: "REFERENCE", storage: "WORKSPACE", text: "Xem lại biên bản họp quý" } })).body.result, "DUPLICATE");
  assert.equal((await h.call("POST", "/v2/inbox/imports", { body: { kind: "URL", purpose: "REFERENCE", storage: "WORKSPACE", url: "http://vi-du.example/x" } })).body.code, "INBOX_LINK_INVALID");
  assert.equal((await h.call("POST", "/v2/inbox/imports", { body: { kind: "URL", purpose: "FOLLOW_UP", storage: "WORKSPACE", url: "https://vi-du.example/tai-lieu" } })).status, 201);
  const ref = imp.body.item_ref;
  assert.equal((await h.call("POST", `/v2/inbox/items/${ref}/save`)).body.state, "SAVED");
  assert.equal((await h.call("POST", `/v2/inbox/items/${ref}/snooze`, { body: { until: new Date(h.clock.t + 3 * 3600_000).toISOString() } })).body.state, "SNOOZED");
  assert.equal((await h.call("POST", `/v2/inbox/items/${ref}/done`)).body.state, "DONE");
  assert.equal((await h.call("POST", `/v2/inbox/items/${ref}/done`)).body.code, "INVALID_TRANSITION");
  assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).body.code, "CONSENT_REQUIRED");
  await consent(h, "inbox_mail");
  assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).status, 201);
  h.clock.t += 1500;
  const page1 = await h.call("GET", "/v2/inbox/items?state=NEW&limit=20");
  assert.equal(page1.body.items.filter((i: any) => i.source_kind === "OUTLOOK_MAIL").length, 19);
  assert.ok(page1.body.next_cursor);
  const page2 = await h.call("GET", `/v2/inbox/items?state=NEW&limit=20&cursor=${page1.body.next_cursor}`);
  assert.equal(page2.body.items.length, 3);
  assert.equal(page1.body.sources[1].simulated, true);
  assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/disconnect")).body.status, "DISCONNECTED");
  assert.equal((await h.call("GET", "/v2/inbox/items?state=NEW&limit=50")).body.items.length, 1);

  // Le‑NodeHome: yêu cầu → LeLS khảo sát (điều khiển của bản trình diễn) → nhận báo giá → lắp → xác nhận serial → hub gửi sự kiện.
  await consent(h, "home_hub");
  const terms = (await h.call("GET", "/v2/home/subscriptions")).body.terms_version;
  const sub = await h.call("POST", "/v2/home/subscriptions", { body: { site_ref: "nha-thu-nghiem", package_code: "HOME_PILOT", contact_grant: "IN_APP", terms_version: terms } });
  assert.equal(sub.status, 201);
  const S = `/v2/home/subscriptions/${sub.body.subscription_ref}`;
  assert.equal((await h.call("POST", "/v2/home/subscriptions", { body: { site_ref: "nha-khac", package_code: "HOME_PILOT", contact_grant: "IN_APP", terms_version: terms } })).body.code, "HOME_OPEN_LIMIT");
  assert.equal((await h.b.controls.homeNext("dev_a")).event, "survey");
  assert.equal((await h.call("POST", `${S}/accept-quote`, { body: { revision: 1 } })).body.code, "HOME_REVISION_CONFLICT");
  assert.equal((await h.call("POST", `${S}/accept-quote`, { body: { revision: 2 } })).body.state, "HAAS_ACCEPTED");
  const inst = await h.b.controls.homeNext("dev_a");
  assert.equal(inst.event, "install");
  assert.equal((await h.call("POST", `${S}/confirm-install`, { body: { revision: 4, serial: "LNH-HUB-XXXX" } })).body.code, "HOME_SERIAL_MISMATCH");
  const active = await h.call("POST", `${S}/confirm-install`, { body: { revision: 4, serial: inst.serial } });
  assert.equal(active.body.state, "HAAS_ACTIVE");
  const hubId = active.body.hub.hub_id;
  const cred = await h.call("GET", `/dev/home/hub-credential?hub_id=${hubId}`, { sub: null });
  const env = { event_id: "sim-" + randomBytes(9).toString("hex"), observed_at: new Date(h.clock.t - 3 * 60_000).toISOString(), type: "CAMERA_OFFLINE", camera_ref: "cam_front", binding_version: 1, schema_version: 1, epoch: 1 };
  const proof = createHmac("sha256", Buffer.from(cred.body.key, "base64url")).update(digestJcs(env), "ascii").digest("base64url");
  const hubCall = (k?: string, p = proof) => h.call("POST", `/v2/home/hubs/${hubId}/events`, { sub: null, key: k, headers: { authorization: `Bearer ${cred.body.token}` }, body: { ...env, proof: p } });
  const ev = await hubCall();
  assert.equal(ev.status, 201);
  assert.equal(ev.body.late, true);
  assert.equal((await hubCall()).body.duplicate, true, "cùng sự kiện, khóa khác: không nhân đôi");
  assert.equal((await hubCall(undefined, "A".repeat(43))).body.code, "HOME_HUB_IDENTITY_INVALID");
  assert.equal((await h.call("GET", `${S}/events`)).body.events.length, 1);
  const vg = await h.call("POST", `${S}/view-grants`, { body: { ticket_ref: "TK-DEMO-01", minutes: 15 } });
  assert.equal(vg.status, 201);
  assert.equal((await h.call("POST", `${S}/view-grants`, { body: { ticket_ref: "TK-DEMO-02", minutes: 15 } })).body.code, "HOME_VIEW_GRANT_ACTIVE");
  assert.equal((await h.call("POST", `/v2/home/view-grants/${vg.body.grant_id}/revoke`)).body.active, false);
  assert.equal((await h.call("GET", `${S}/export`)).status, 200);
  assert.equal((await h.b.controls.homeNext("dev_a")).event, "suspend");
  assert.equal((await hubCall(randomBytes(32).toString("base64url"))).body.code, "HOME_NOT_ACCEPTING", "tạm ngừng: hub không gửi được");
  assert.equal((await h.b.controls.homeNext("dev_a")).event, "resume");
  h.relogin("dev_a");
  const ended = await h.call("POST", `${S}/terminate`, { body: { revision: 7 } });
  assert.equal(ended.body.state, "HAAS_TERMINATED");
  assert.equal((await h.b.controls.homeNext("dev_a")).event, "return_hub");
  assert.equal((await h.call("GET", "/v2/home/subscriptions")).body.subscriptions[0].state, "HAAS_RETURNED");

  // Le‑NodeHealth: máy đo giả lập trên máy dùng chung → ánh xạ chờ xác nhận → xác nhận → phép đo; chia sẻ có hạn.
  await consent(h, "measurements");
  const r1 = await h.call("POST", "/v2/health/sim-device/readings", { body: { device: "SHARED", user_slot: 1, hint_self: true, channel: "BOTH", repeat_last: false } });
  assert.deepEqual(r1.body.results.map((r: any) => r.result), ["QUARANTINED", "DUPLICATE"]);
  const maps = await h.call("GET", "/v2/health/mappings");
  assert.equal((await h.call("GET", "/v2/health/quarantine")).body.records.length, 1);
  assert.equal((await h.call("POST", `/v2/health/mappings/${maps.body.mappings[0].mapping_id}/confirm`)).body.assigned, 1);
  assert.equal((await h.call("POST", "/v2/health/sim-device/readings", { body: { device: "SHARED", user_slot: 1, hint_self: false, channel: "PHONE_GATEWAY", repeat_last: false } })).body.results[0].result, "ACCEPTED");
  const amb = await h.call("POST", "/v2/health/sim-device/readings", { body: { device: "SHARED", user_slot: 0, hint_self: false, channel: "PHONE_GATEWAY", repeat_last: false } });
  assert.equal(amb.body.results[0].reason, "AMBIGUOUS_USER");
  assert.equal((await h.call("POST", `/v2/health/quarantine/${amb.body.results[0].record_ref}/resolve`, { body: { answer: "MINE" } })).body.outcome, "ASSIGNED");
  const obs = await h.call("GET", "/v2/health/observations");
  assert.equal(obs.body.observations.length, 3);
  assert.equal((await h.call("POST", "/v2/health/shares", { body: { grantee_user: "dev_b", purpose: "FAMILY_CARE", from_date: "2026-10-13", expires_in_days: 7 } })).status, 201);
  const shares = await h.call("GET", "/v2/health/shares", { sub: "dev_b" });
  assert.equal(shares.body.received.length, 1);
  assert.equal((await h.call("GET", `/v2/health/shares/${shares.body.received[0].share_id}/observations`, { sub: "dev_b" })).body.observations.length, 3);
  assert.equal((await h.call("GET", "/v2/health/shares")).body.access_log[0].action, "SHARE_VIEWED");
  assert.equal((await h.call("POST", `/v2/health/observations/${obs.body.observations[0].observation_id}/delete`)).body.deleted, true);
  assert.equal((await h.call("GET", "/v2/health/observations/export")).body.observations.length, 2);
  assert.equal((await h.call("POST", `/v2/health/shares/${shares.body.received[0].share_id}/revoke`)).body.state, "MEASSHARE_REVOKED");
  h.relogin("dev_a");
  assert.equal((await h.call("POST", "/v2/health/erase")).body.deleted, 2);

  // Mô phỏng Le‑ORION: lượt chờ rồi có kết quả nhãn SIMULATED; cùng request_ref không xếp hàng lần hai.
  const cat = await h.call("GET", "/v2/sim/catalog");
  assert.equal(cat.body.label, "SIMULATED");
  const run1 = await h.call("POST", "/v2/sim/runs", { body: { skill_ref: "skl_navigate_room", scene_version: "scn_kitchen@1.0.0", request_ref: "req_demo_000001" } });
  assert.equal(run1.status, 201);
  assert.match(run1.body.receipt_token, /^lnhsim1\./);
  assert.equal((await h.call("POST", "/v2/sim/runs", { body: { skill_ref: "skl_navigate_room", scene_version: "scn_kitchen@1.0.0", request_ref: "req_demo_000001" } })).status, 200);
  assert.equal((await h.call("POST", "/v2/sim/runs", { body: { skill_ref: "skl_fold_towel", scene_version: "scn_kitchen@1.0.0", request_ref: "req_demo_000002" } })).body.code, "SIM_SCENE_UNKNOWN");
  h.clock.t += 2500;
  assert.equal((await h.call("GET", "/v2/sim/runs")).body.runs[0].state, "SIMRUN_COMPLETED");

  // Tệp xuất có phần của từng mô-đun; rút đồng ý Hộp tổng hợp xóa phần Outlook.
  h.relogin("dev_a");
  const ex = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
  const file = (await h.call("GET", ex.body.export.path)).body;
  assert.deepEqual(Object.keys(file.modules).sort(), ["home_hub", "inbox", "measurements", "messaging", "sync"]);
});

test("nhắn tin với người nhận mô phỏng: lời mời được nhận, tin tới thiết bị của B, B trả lời bằng đúng LNH-MSG-1", async () => {
  const h = demoHarness();
  const crypto2: any = await import(new URL("../web/shared/msg-crypto.js", import.meta.url).href);
  assert.equal((await h.call("GET", "/v1/messages/people")).body.code, "CONSENT_REQUIRED");
  await consent(h, "messaging");
  const people = await h.call("GET", "/v1/messages/people");
  assert.deepEqual(people.body.people.map((p: any) => p.user_id), ["dev_b"], "danh bạ: chỉ Thử nghiệm B (có thiết bị mô phỏng); người chưa bật nhắn tin không hiện");
  const me = await crypto2.generateEndpointKey();
  const ep = await h.call("POST", "/v1/messages/endpoints", { body: { public_key: me.public_key, kind: "LAPTOP" } });
  assert.equal(ep.status, 201);
  assert.equal((await h.call("POST", "/v1/messages/endpoints", { body: { public_key: me.public_key, kind: "LAPTOP" } })).status, 200, "cùng khóa: trả điểm nhận tin đã có");
  const th = await h.call("POST", "/v1/messages/threads", { body: { peer: "dev_b" } });
  assert.equal(th.body.state, "THREAD_REQUESTED");
  const id = th.body.thread_id;
  assert.equal((await h.call("GET", `/v1/messages/threads/${id}/keys`)).body.code, "RECIPIENT_UNAVAILABLE");
  h.clock.t += 1600;
  const inbox0 = await h.call("GET", `/v1/messages/inbox?endpoint=${ep.body.endpoint_id}`);
  assert.equal(inbox0.body.threads[0].state, "THREAD_ACTIVE", "thiết bị mô phỏng của B nhận lời mời");
  assert.equal((await h.call("GET", `/v1/messages/inbox?endpoint=${ep.body.endpoint_id}&etag=${inbox0.body.etag}`)).body.changed, false);
  const keys = await h.call("GET", `/v1/messages/threads/${id}/keys`);
  assert.equal(keys.body.endpoints.length, 2);
  const sender = { endpoint_id: ep.body.endpoint_id, ...me };
  const sealed = await crypto2.sealMessage({ text: "Chào B", thread_id: id, client_ref: randomBytes(18).toString("base64url"), key_set: keys.body.key_set, sender, recipients: keys.body.endpoints });
  const sent = await h.call("POST", `/v1/messages/threads/${id}/messages`, { body: sealed });
  assert.equal(sent.status, 201);
  assert.equal((await h.call("POST", `/v1/messages/threads/${id}/messages`, { body: sealed })).body.code, "DUPLICATE_MESSAGE");
  assert.equal((await h.call("POST", `/v1/messages/threads/${id}/messages`, { body: { ...sealed, client_ref: randomBytes(18).toString("base64url"), key_set: "A".repeat(43) } })).body.code, "KEYS_CHANGED");
  h.clock.t += 2100;
  const inbox = await h.call("GET", `/v1/messages/inbox?endpoint=${ep.body.endpoint_id}`);
  const reply = inbox.body.messages.find((m: any) => m.sender_user === "dev_b");
  assert.ok(reply, "B đã trả lời");
  assert.equal(inbox.body.threads[0].peer_read_seq, 1, "B xác nhận đã đọc tin của bạn (mô phỏng)");
  const botKey = keys.body.endpoints.find((e: any) => e.user_id === "dev_b").public_key;
  const opened = await crypto2.openMessage({ thread_id: id, message: reply, recipient: me, sender_public_key: botKey });
  assert.match(opened.text, /trả lời tự động của Thử nghiệm B/);
  const own = inbox.body.messages.filter((m: any) => m.sender_user === "dev_a");
  assert.equal((await h.call("POST", "/v1/messages/ack", { body: { endpoint_id: ep.body.endpoint_id, message_ids: inbox.body.messages.map((m: any) => m.message_id) } })).body.acked, inbox.body.messages.length);
  assert.ok(own.length <= 1);
  assert.equal((await h.call("POST", `/v1/messages/threads/${id}/read`, { body: { through_seq: 2, share: true } })).body.read_seq, 2);
  assert.equal((await h.call("POST", "/v1/messages/reports", { body: { thread_id: id, reason: "OTHER" } })).status, 201);
  assert.equal((await h.call("POST", `/v1/messages/threads/${id}/block`)).body.state, "THREAD_BLOCKED");
  assert.equal((await h.call("POST", `/v1/messages/threads/${id}/unblock`)).body.state, "THREAD_CLOSED");
  assert.equal((await h.call("GET", "/v1/messages/endpoints")).body.endpoints.length, 1);
  assert.equal((await h.call("POST", `/v1/messages/endpoints/${ep.body.endpoint_id}/revoke`)).body.status, "REVOKED");
});

test("cờ tắt: 503 MODULE_DISABLED như máy chủ (bản trình diễn bật mọi cờ, kiểm thử tắt để thử cổng)", async () => {
  const h = demoHarness();
  h.b.state().mod.flagsOff = { inbox: true, sim: true };
  assert.equal((await h.call("GET", "/v2/inbox/items")).body.code, "MODULE_DISABLED");
  assert.equal((await h.call("GET", "/v2/sim/runs")).status, 503);
  assert.equal((await h.call("GET", "/v1/me")).body.modules.inbox, false);
});

test("phủ hợp đồng: mọi thao tác giao diện web gọi đều đã được bản giả trả lời đúng schema ít nhất một lần", () => {
  const used = [
    "GET /v1/me", "POST /v1/plans", "POST /v1/plans/{plan_id}/approve", "POST /v1/plans/{plan_id}/cancel", "GET /v1/actions", "GET /v1/actions/{action_id}", "POST /v1/actions/{action_id}/cancel",
    "GET /v1/calendar/availability", "GET /v1/devices", "POST /v1/consents", "POST /v1/consents/{purpose_id}/withdraw", "POST /v1/privacy/requests", "GET /v1/privacy/exports/{token}", "POST /v1/lele/proposals",
    "GET /v2/devices", "POST /v2/devices", "POST /v2/devices/{device_id}/revoke", "GET /v2/sync/drafts", "POST /v2/sync/drafts", "GET /v2/sync/drafts/{draft_id}", "POST /v2/sync/drafts/{draft_id}/revisions", "POST /v2/sync/drafts/{draft_id}/discard",
    "GET /v2/inbox/items", "POST /v2/inbox/imports", "POST /v2/inbox/items/{item_ref}/save", "POST /v2/inbox/items/{item_ref}/snooze", "POST /v2/inbox/items/{item_ref}/done", "POST /v2/inbox/sources/outlook/connect", "POST /v2/inbox/sources/outlook/disconnect",
    "GET /v2/home/subscriptions", "POST /v2/home/subscriptions", "POST /v2/home/subscriptions/{subscription_id}/accept-quote", "POST /v2/home/subscriptions/{subscription_id}/confirm-install", "POST /v2/home/subscriptions/{subscription_id}/terminate",
    "GET /v2/home/subscriptions/{subscription_id}/events", "GET /v2/home/subscriptions/{subscription_id}/export", "POST /v2/home/subscriptions/{subscription_id}/view-grants", "POST /v2/home/view-grants/{grant_id}/revoke", "POST /v2/home/hubs/{hub_id}/events",
    "POST /v2/health/sim-device/readings", "GET /v2/health/observations", "GET /v2/health/observations/export", "POST /v2/health/observations/{observation_id}/delete", "POST /v2/health/erase", "GET /v2/health/mappings",
    "POST /v2/health/mappings/{mapping_id}/confirm", "GET /v2/health/quarantine", "POST /v2/health/quarantine/{record_id}/resolve", "GET /v2/health/shares", "POST /v2/health/shares", "POST /v2/health/shares/{share_id}/revoke", "GET /v2/health/shares/{share_id}/observations",
    "GET /v2/sim/catalog", "GET /v2/sim/runs", "POST /v2/sim/runs",
    "GET /v1/messages/people", "GET /v1/messages/endpoints", "POST /v1/messages/endpoints", "POST /v1/messages/endpoints/{endpoint_id}/revoke", "POST /v1/messages/threads",
    "POST /v1/messages/threads/{thread_id}/block", "POST /v1/messages/threads/{thread_id}/unblock", "GET /v1/messages/threads/{thread_id}/keys", "POST /v1/messages/threads/{thread_id}/messages",
    "POST /v1/messages/threads/{thread_id}/read", "GET /v1/messages/inbox", "POST /v1/messages/ack", "POST /v1/messages/reports",
  ];
  const ok2xx = new Set([...checked].filter((k) => / 2\d\d$/.test(k)).map((k) => k.replace(/ \d+$/, "")));
  assert.deepEqual(used.filter((u) => !ok2xx.has(u)), []);
});

export { conform, consent, checked, T0, vnTomorrow };
