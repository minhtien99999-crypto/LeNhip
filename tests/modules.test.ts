// Sổ đăng ký mô-đun của máy chủ (src/server/modules.ts): mỗi hook của ServerModule được nối vào đúng đường xử lý của lõi.
// Mô-đun «fake» dưới đây chỉ tồn tại trong tệp kiểm thử này; nó không phải một tính năng và không được đăng ký vào MODULES.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { ApiError, MESSAGES, registerMessages } from "../src/core/errors.ts";
import { uuid } from "../src/core/crypto.ts";
import { CORE_ROUTES, ROUTES } from "../src/server/api.ts";
import { KINDS, exportPolicy, isActiveMember, policyEntry, requireMember, requireModuleGate } from "../src/server/authority.ts";
import { type Ctx, nowIso } from "../src/server/context.ts";
import { getByActionId, getRow } from "../src/server/machine.ts";
import { MODULES, validateModules, type KindSpec, type ServerModule } from "../src/server/modules.ts";
import { createPlan } from "../src/server/plans.ts";
import { PermitError } from "../src/server/permit.ts";
import type { DispatchAdapter, ExecResult, Precheck, Readback } from "../src/server/receiver.ts";
import { applyRevocations, backupLedger, beginRecovery, journalRevocation, restoreLedgerFile } from "../src/server/recovery.ts";
import { all, one, run } from "../src/server/store.ts";
import { issuePermit } from "../src/server/worker.ts";
import { action, calendarPlan, harness, key, lampPlan, planAndApprove, tick, vn, WS, type Harness } from "./helpers.ts";

const DAY = 86_400_000;

/** Thế giới bên ngoài giả lập của mô-đun fake: sống qua khởi động lại như lịch và đèn giả lập. */
interface FakeWorld {
  posts: Map<string, string>;
  silent: boolean;
  binding: number;
  /** Kiểm thử: adapter khai sai hạng bằng chứng cho một đích giả lập. */
  grade?: "SIMULATED" | "PROVIDER_READBACK";
}

/** Những gì các hook đã thấy, để kiểm thử đối chiếu. */
interface Probe {
  seeds: number;
  ticks: number[];
  withdrawn: string[];
  restricted: string[];
  deleted: string[];
  failWithdraw: boolean;
  failTick: boolean;
}

const newProbe = (): Probe => ({ seeds: 0, ticks: [], withdrawn: [], restricted: [], deleted: [], failWithdraw: false, failTick: false });

/** Trạng thái theo từng app (mất khi khởi động lại), tìm lại bằng ctx: cách mô-đun thật giữ token hay bộ đếm trong bộ nhớ. */
const STATE = new WeakMap<Ctx, { world: FakeWorld }>();

class FakeAdapter implements DispatchAdapter {
  readonly kind = "fake.echo";
  readonly ackTimeoutMs = 1_000;
  readonly unknownAfterMs = 5_000;
  readonly readsAtMs = [0, 2_000];
  private readonly ctx: Ctx;
  private readonly world: FakeWorld;
  constructor(ctx: Ctx, world: FakeWorld) {
    this.ctx = ctx;
    this.world = world;
  }
  audience() {
    return "lenhip:fake-sim";
  }
  servesAudience(aud: string) {
    return aud === "lenhip:fake-sim";
  }
  async precheck(): Promise<Precheck> {
    return { result: "CLEAR" };
  }
  async execute(row: { action_id: string | null; payload: string }): Promise<ExecResult> {
    this.world.posts.set(row.action_id as string, (JSON.parse(row.payload) as { card_code: string }).card_code);
    return { result: "ACK", provider_ref: `fake-${row.action_id}` };
  }
  async readback(row: { action_id: string | null }): Promise<Readback> {
    if (this.world.silent || !this.world.posts.has(row.action_id as string)) return { result: "UNDETERMINED", note: "bên giả lập chưa trả lời" };
    return { result: "MATCH", outcome: "SIMULATED", evidence: { grade: this.world.grade ?? "SIMULATED", source: "sim:fake", observed_at: nowIso(this.ctx), data: { post: `fake-${row.action_id}` } } };
  }
}

const fakeKind: KindSpec = {
  kind: "fake.echo",
  scope: "social.post",
  purpose: "social_post",
  module: "social",
  trust: "sim",
  exportPolicy: { fields: ["card_code"], residual_inference: "Không có: đích giả chỉ tồn tại trong kiểm thử." },
  outcomes: { match: "SIMULATED", conflict: "NO_EFFECT" },
  resolve(ctx, ws, actor, input) {
    const binding = (STATE.get(ctx) as { world: FakeWorld }).world.binding;
    return {
      payload: { kind: "fake.echo", schema_version: 1, workspace_id: ws, target: { type: "fake", ref: "fake-target" }, card_code: input.args.card_code, target_binding_version: binding },
      target_ref: "fake-target", site_id: null, resource_key: `fake:${ws}:${actor}`, window: null, binding,
    };
  },
  binding: (ctx) => STATE.get(ctx)?.world.binding ?? null,
  adapter(ctx, world) {
    const w = (world.get("fake") as FakeWorld | undefined) ?? { posts: new Map<string, string>(), silent: false, binding: 1 };
    world.set("fake", w);
    STATE.set(ctx, { world: w });
    return new FakeAdapter(ctx, w);
  },
};

function fakeModule(probe: Probe): ServerModule {
  const mine = (ctx: Ctx, ws: string, user: string) =>
    all<{ id: string; label: string; revoked: number }>(ctx.db, "SELECT id, label, revoked FROM fake_notes WHERE workspace_id = ? AND user_id = ? ORDER BY created_at, id", ws, user);
  return {
    name: "fake",
    errors: { FAKE_LIMIT: "Đã chạm giới hạn của mô-đun giả." },
    kinds: [fakeKind],
    routes: [
      {
        method: "GET", path: "/v1/fake/notes",
        handler: (c) => {
          requireMember(c.d.ctx, c.ws, c.p.sub);
          return { status: 200, body: { items: mine(c.d.ctx, c.ws, c.p.sub), filter: c.query.get("filter") } };
        },
      },
      {
        // POST đồng bộ: ghi dữ liệu và bản ghi khóa idempotency trong cùng một giao dịch.
        method: "POST", path: "/v1/fake/notes", schema: "DeviceOp", readable: (c) => isActiveMember(c.d.ctx, c.ws, c.p.sub),
        handler: (c) => {
          const { ctx } = c.d;
          requireMember(ctx, c.ws, c.p.sub);
          if (mine(ctx, c.ws, c.p.sub).length >= 2) throw new ApiError(422, "FAKE_LIMIT");
          const id = `fn_${uuid()}`;
          run(ctx.db, "INSERT INTO fake_notes (id, workspace_id, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)", id, c.ws, c.p.sub, (c.body as { reason: string }).reason, nowIso(ctx));
          return { status: 201, body: { id }, resource: { type: "fake_note", id } };
        },
      },
      {
        method: "POST", path: "/v1/fake/notes/{note_id}/revoke", schema: "Empty", optionalBody: true, readable: (c) => isActiveMember(c.d.ctx, c.ws, c.p.sub),
        handler: (c) => {
          const { ctx } = c.d;
          requireMember(ctx, c.ws, c.p.sub);
          const n = one<{ id: string }>(ctx.db, "SELECT id FROM fake_notes WHERE id = ? AND workspace_id = ? AND user_id = ?", c.params.note_id, c.ws, c.p.sub);
          if (!n) throw new ApiError(404, "NOT_FOUND");
          run(ctx.db, "UPDATE fake_notes SET revoked = 1 WHERE id = ?", n.id);
          journalRevocation(ctx, "fake_note_revoked", nowIso(ctx), { note_id: n.id });
          return { status: 200, body: { id: n.id, revoked: true }, resource: { type: "fake_note", id: n.id } };
        },
      },
      {
        // Route sau cổng của mô-đun: thành viên → cờ → quyền → đồng ý.
        method: "GET", path: "/v1/fake/gated",
        handler: (c) => ({ status: 200, body: { user: requireModuleGate(c.d.ctx, c.ws, c.p.sub, { module: "messaging", scope: "messaging.use", purpose: "messaging" }).user_id } }),
      },
      {
        // POST bất đồng bộ: handler có await, chạy ngoài giao dịch.
        method: "POST", path: "/v1/fake/echo", schema: "DeviceOp", async: true, readable: (c) => isActiveMember(c.d.ctx, c.ws, c.p.sub),
        handler: async (c) => {
          requireMember(c.d.ctx, c.ws, c.p.sub);
          await new Promise((r) => setTimeout(r, 5));
          return { status: 200, body: { echo: (c.body as { reason: string }).reason, auth_time: c.p.auth_time }, resource: { type: "fake_echo", id: c.requestId } };
        },
      },
    ],
    devRoutes: [
      { path: "/dev/fake/info", handler: (d) => ({ status: 200, body: { members: all(d.ctx.db, "SELECT user_id FROM members").length } }) },
      { path: "/dev/fake/authorize", handler: (_d, q) => ({ status: 302, location: `/?code=fake-code&state=${encodeURIComponent(q.get("state") ?? "")}` }) },
      { path: "/dev/fake/elsewhere", handler: () => ({ status: 302, location: "//evil.test/" }) },
    ],
    seed(ctx) {
      probe.seeds++;
      // Mô-đun thật tạo bảng bằng một migration (src/server/migrations/); mô-đun giả tạo bảng ở đây để không đụng tới sổ đăng ký thật.
      ctx.db.exec("CREATE TABLE IF NOT EXISTS fake_notes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, label TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)");
      if (!one(ctx.db, "SELECT 1 FROM grants WHERE id = 'gr_fake_social'")) {
        run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES ('gr_fake_social', ?, 'dev_a', 'social.post', NULL, 'ACTIVE', ?)", WS, nowIso(ctx));
      }
    },
    async onTick(ctx, now) {
      await Promise.resolve();
      if (probe.failTick) throw new Error("mô-đun giả hỏng khi dọn");
      probe.ticks.push(now);
      run(ctx.db, "DELETE FROM fake_notes WHERE created_at < ?", new Date(now - 30 * DAY).toISOString());
    },
    privacy: {
      exportFor: (ctx, ws, user) => ({ notes: mine(ctx, ws, user).map((n) => ({ id: n.id, label: n.label })) }),
      deleteFor(ctx, ws, user) {
        probe.deleted.push(user);
        run(ctx.db, "DELETE FROM fake_notes WHERE workspace_id = ? AND user_id = ?", ws, user);
      },
      onConsentWithdrawn(_ctx, _ws, user, purpose) {
        if (probe.failWithdraw) throw new Error("mô-đun giả hỏng khi rút đồng ý");
        probe.withdrawn.push(`${user}:${purpose}`);
      },
      onRestrict(_ctx, _ws, user) {
        probe.restricted.push(user);
      },
    },
    revocations: {
      fake_note_revoked: (ctx, e) => Number(run(ctx.db, "UPDATE fake_notes SET revoked = 1 WHERE id = ? AND revoked = 0", e.note_id as string).changes) > 0,
      // Phản ứng thêm với một loại dòng của lõi: người đã xóa dữ liệu thì ghi chú của họ cũng không được sống lại sau restore.
      member_deleted: (ctx, e) => Number(run(ctx.db, "DELETE FROM fake_notes WHERE workspace_id = ? AND user_id = ?", e.workspace_id as string, e.user_id as string).changes) > 0,
    },
  };
}

const withFake = async (opts: Parameters<typeof harness>[0] = {}) => {
  const probe = newProbe();
  const h = await harness({ modules: [fakeModule(probe)], ...opts });
  return { h, probe };
};
const note = (h: Harness, label: string, sub = "dev_a", k?: string) => h.call("POST", "/v1/fake/notes", { sub, body: { reason: label }, key: k });
const consent = (h: Harness, purpose: string, choice: "GRANTED" | "DECLINED" = "GRANTED", sub = "dev_a") =>
  h.call("POST", "/v1/consents", { sub, body: { purpose_id: purpose, text_version: "v1", text_hash: "A".repeat(43), choice } });
const fakePlan = (h: Harness, sub = "dev_a") => createPlan(h.app.ctx, sub, WS, { kind: "fake.echo", schema_version: 1, workspace_ref: WS, args: { card_code: "INVITE" } }, null);
const approve = (h: Harness, p: { plan_id: string; plan_version: number; payload_digest: string }, sub = "dev_a") =>
  h.call("POST", `/v1/plans/${p.plan_id}/approve`, { sub, body: { plan_version: p.plan_version, approved_digest: p.payload_digest } });

test("sổ đăng ký đang phát hành hợp lệ: ROUTES = route lõi + route của MODULES, không trùng", () => {
  validateModules(MODULES, { routes: CORE_ROUTES, kinds: KINDS });
  assert.deepEqual(ROUTES.map((r) => `${r.method} ${r.path}`), [...CORE_ROUTES, ...MODULES.flatMap((m) => m.routes ?? [])].map((r) => `${r.method} ${r.path}`));
  assert.equal(new Set(ROUTES.map((r) => `${r.method} ${r.path}`)).size, ROUTES.length);
});

test("validateModules: trùng tên, trùng route, POST thiếu schema/readable, loại tác vụ trùng lõi, đường dev sai đều bị từ chối khi dựng app", () => {
  const core = { routes: CORE_ROUTES, kinds: KINDS };
  const ok = (): { status: number; body: unknown } => ({ status: 200, body: {} });
  const readable = () => true;
  assert.throws(() => validateModules([{ name: "a1" }, { name: "a1" }], core), /hai lần/);
  assert.throws(() => validateModules([{ name: "Bad Name" }], core), /tên mô-đun/);
  assert.throws(() => validateModules([{ name: "aa", routes: [{ method: "GET", path: "/v1/me", handler: ok }] }], core), /đã có/);
  assert.throws(() => validateModules([{ name: "aa", routes: [{ method: "GET", path: "/v1/x", handler: ok }] }, { name: "bb", routes: [{ method: "GET", path: "/v1/x", handler: ok }] }], core), /đã có/);
  assert.throws(() => validateModules([{ name: "aa", routes: [{ method: "GET", path: "/v2/x", handler: ok }] }], core), /\/v1\//);
  assert.throws(() => validateModules([{ name: "aa", routes: [{ method: "POST", path: "/v1/x", readable, handler: ok }] }], core), /schema hoặc readable/);
  assert.throws(() => validateModules([{ name: "aa", routes: [{ method: "POST", path: "/v1/x", schema: "Empty", handler: ok }] }], core), /schema hoặc readable/);
  assert.throws(() => validateModules([{ name: "aa", kinds: [{ ...fakeKind, kind: "robot.simulate" }] }], core), /đã có/);
  assert.throws(() => validateModules([{ name: "aa", kinds: [{ ...fakeKind, kind: "NoDot" }] }], core), /loại tác vụ/);
  assert.throws(() => validateModules([{ name: "aa", devRoutes: [{ path: "/dev/token", handler: () => ({ status: 200, body: {} }) }] }], core), /đường dev/);
  assert.throws(() => validateModules([{ name: "aa", devRoutes: [{ path: "/v1/dev", handler: () => ({ status: 200, body: {} }) }] }], core), /đường dev/);
  validateModules([{ name: "aa", routes: [{ method: "POST", path: "/v1/x", schema: "Empty", readable, handler: ok }] }], core);
});

test("mã lỗi của mô-đun: đăng ký lặp lại cùng nội dung được, đè lên mã đã có hoặc sai dạng thì không", () => {
  registerMessages({ FAKE_ONLY_HERE: "Chỉ có trong kiểm thử." });
  registerMessages({ FAKE_ONLY_HERE: "Chỉ có trong kiểm thử." });
  assert.equal(new ApiError(422, "FAKE_ONLY_HERE").message, "Chỉ có trong kiểm thử.");
  assert.throws(() => registerMessages({ FAKE_ONLY_HERE: "Nội dung khác." }), /đã có với nội dung khác/);
  assert.throws(() => registerMessages({ NOT_FOUND: "Mô-đun không được đổi câu của lõi." }), /đã có với nội dung khác/);
  assert.equal(MESSAGES.NOT_FOUND, "Không tìm thấy.");
  assert.throws(() => registerMessages({ "fake-lower": "x" }), /không hợp lệ/);
});

test("quy tắc import: chỉ api.ts và app.ts nạp modules.ts lúc chạy; tệp khác chỉ import type (tránh vòng nạp mô-đun)", () => {
  const root = new URL("../src/", import.meta.url);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      if (f.isDirectory()) walk(`${dir}${f.name}/`);
      else if (f.name.endsWith(".ts")) files.push(`${dir}${f.name}`);
    }
  };
  walk("");
  const allowed: Record<string, string[]> = { "modules.ts": ["server/api.ts", "server/app.ts"], "api.ts": ["server/app.ts"], "app.ts": ["main.ts"] };
  const bad: string[] = [];
  for (const f of files) {
    const text = readFileSync(new URL(f, root), "utf8");
    for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gm)) {
      const target = m[2].split("/").pop() as string;
      if (m[1] || !(target in allowed) || !/(^|\/)(server\/)?(modules|api|app)\.ts$/.test(m[2])) continue;
      if (!allowed[target].includes(f)) bad.push(`${f} nạp ${m[2]} lúc chạy`);
    }
  }
  assert.deepEqual(bad, []);
});

test("routes: GET, POST đồng bộ và bất đồng bộ của mô-đun đi cùng đường với route lõi (xác thực, workspace, schema, idempotency, readable)", async () => {
  const { h } = await withFake();
  try {
    assert.equal((await h.call("GET", "/v1/me")).status, 200, "route lõi vẫn chạy");
    const noAuth = await fetch(h.base + "/v1/fake/notes", { headers: { "X-LeNhip-Workspace": WS } });
    assert.equal(noAuth.status, 401);
    assert.equal((await h.call("GET", "/v1/fake/notes", { headers: { "X-LeNhip-Workspace": "bad" } })).status, 400);
    assert.equal((await h.call("GET", "/v1/fake/notes", { sub: "stranger" })).status, 404, "handler tự gọi requireMember");
    assert.equal((await h.call("GET", "/v1/fake/nothing")).status, 404);
    assert.equal((await fetch(h.base + "/v1/fake/notes", { method: "DELETE" })).status, 405);

    const noKey = await h.call("POST", "/v1/fake/notes", { body: { reason: "ghi chú" }, key: null });
    assert.equal(noKey.body.code, "IDEMPOTENCY_KEY_REQUIRED");
    const extra = await h.call("POST", "/v1/fake/notes", { body: { reason: "ghi chú", reason_from_health: "ngủ kém" } });
    assert.equal(extra.status, 400, "schema đóng: không lọt trường lạ");
    assert.equal(extra.body.code, "SCHEMA_INVALID");
    assert.equal((await h.call("POST", "/v1/fake/notes", {})).status, 400, "thân rỗng chỉ được khi optionalBody");

    const k = key();
    const first = await note(h, "ghi chú một", "dev_a", k);
    assert.equal(first.status, 201);
    const again = await note(h, "ghi chú một", "dev_a", k);
    assert.deepEqual(again.body, first.body);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.equal((await note(h, "nội dung khác", "dev_a", k)).body.code, "IDEMPOTENCY_CONFLICT");
    const list = await h.call("GET", "/v1/fake/notes?filter=x");
    assert.equal(list.body.items.length, 1, "phát lại không ghi lần hai");
    assert.equal(list.body.filter, "x");
    assert.equal((await h.call("GET", "/v1/fake/notes", { sub: "dev_b" })).body.items.length, 0);

    // Lỗi của mô-đun rollback cả giao dịch và không để lại bản ghi khóa: mã lỗi do mô-đun đóng góp có câu của nó.
    await note(h, "ghi chú hai");
    const limit = await note(h, "ghi chú ba");
    assert.equal(limit.status, 422);
    assert.equal(limit.body.code, "FAKE_LIMIT");
    assert.equal(limit.body.message, "Đã chạm giới hạn của mô-đun giả.");
    assert.equal(MESSAGES.FAKE_LIMIT, "Đã chạm giới hạn của mô-đun giả.");

    const ek = key();
    const echo = await h.call("POST", "/v1/fake/echo", { body: { reason: "xin chào" }, key: ek });
    assert.equal(echo.status, 200);
    assert.equal(echo.body.echo, "xin chào");
    assert.equal(typeof echo.body.auth_time, "number", "handler thấy auth_time để đòi xác thực lại khi cần");
    assert.equal((await h.call("POST", "/v1/fake/echo", { body: { reason: "xin chào" }, key: ek })).headers.get("idempotent-replayed"), "true");

    // Phát lại vẫn qua readable: người đã rời workspace không đọc lại được bản cũ.
    run(h.app.ctx.db, "UPDATE members SET status = 'LEFT' WHERE user_id = 'dev_a'");
    assert.equal((await note(h, "ghi chú một", "dev_a", k)).status, 404);
  } finally {
    await h.close();
  }
});

test("cổng của mô-đun: thành viên (404) → cờ (503) → quyền (403) → đồng ý (403), như createPlan", async () => {
  const { h } = await withFake();
  try {
    const gated = (sub = "dev_a") => h.call("GET", "/v1/fake/gated", { sub });
    const flag = (enabled: boolean) => h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "messaging", enabled, reason: "kiểm cổng mô-đun" } });
    await flag(false);
    assert.equal((await gated("stranger")).status, 404, "người ngoài miền không biết mô-đun bật hay tắt");
    const off = await gated();
    assert.equal(off.status, 503);
    assert.equal(off.body.code, "MODULE_DISABLED");
    await flag(true);
    const noGrant = await gated();
    assert.equal(noGrant.status, 403);
    assert.equal(noGrant.body.code, "FORBIDDEN");
    run(h.app.ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES ('gr_fake_msg', ?, 'dev_a', 'messaging.use', NULL, 'ACTIVE', ?)", WS, nowIso(h.app.ctx));
    const noConsent = await gated();
    assert.equal(noConsent.status, 403);
    assert.equal(noConsent.body.code, "CONSENT_REQUIRED");
    await consent(h, "messaging");
    assert.deepEqual((await gated()).body, { user: "dev_a" });
    await h.call("POST", "/v1/consents/messaging/withdraw", {});
    assert.equal((await gated()).body.code, "CONSENT_REQUIRED");
    await consent(h, "messaging");
    await h.call("POST", "/v1/grants/gr_fake_msg/revoke", {});
    assert.equal((await gated()).body.code, "FORBIDDEN");
  } finally {
    await h.close();
  }
});

test("routes của mô-đun chịu cùng giới hạn tốc độ theo người dùng như route lõi", async () => {
  const { h } = await withFake({ config: { rateLimit: { perSecond: 0.001, burst: 3 } } as never });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await h.call("GET", i % 2 ? "/v1/me" : "/v1/fake/notes")).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429], "một xô chung cho route lõi và route mô-đun");
    assert.equal((await h.call("GET", "/v1/fake/notes", { sub: "dev_b" })).status, 200, "người khác có xô riêng");
  } finally {
    await h.close();
  }
});

test("devRoutes: chỉ có ở chế độ dev, chỉ GET, chuyển hướng chỉ trong cùng gốc", async () => {
  const { h } = await withFake();
  try {
    const info = await fetch(h.base + "/dev/fake/info");
    assert.equal(info.status, 200);
    assert.equal((await info.json()).members, 3);
    const go = await fetch(h.base + "/dev/fake/authorize?state=a%26b", { redirect: "manual" });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get("location"), "/?code=fake-code&state=a%26b");
    assert.equal(go.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(h.base + "/dev/fake/elsewhere", { redirect: "manual" })).status, 500, "không chuyển hướng ra ngoài gốc");
    assert.equal((await fetch(h.base + "/dev/fake/info", { method: "POST" })).status, 404);
    assert.equal((await fetch(h.base + "/dev/fake/missing")).status, 404);
    assert.equal((await fetch(h.base + "/dev/users")).status, 200, "đường dev của lõi vẫn chạy");
  } finally {
    await h.close();
  }
  const prod = await harness({ modules: [fakeModule(newProbe())], dev: false });
  try {
    assert.equal((await fetch(prod.base + "/dev/fake/info")).status, 404, "không có issuer phát triển thì không có đường dev nào");
  } finally {
    await prod.close();
  }
});

test("seed: chạy ở mỗi lần khởi động có seed và tự kiểm đã có; onTick: chạy trên đồng hồ tiêm được, lỗi không chặn lõi", async () => {
  const { h, probe } = await withFake();
  try {
    assert.equal(probe.seeds, 1);
    await h.restart();
    assert.equal(probe.seeds, 2);
    assert.equal(all(h.app.ctx.db, "SELECT id FROM grants WHERE id = 'gr_fake_social'").length, 1, "seed lặp lại không nhân đôi hàng");

    await note(h, "sẽ hết hạn");
    await h.app.tick();
    assert.equal(probe.ticks.at(-1), h.clock.now(), "now lấy từ đồng hồ của app");
    assert.equal((await h.call("GET", "/v1/fake/notes")).body.items.length, 1);
    h.clock.advance(31 * DAY);
    await h.app.tick();
    assert.equal((await h.call("GET", "/v1/fake/notes")).body.items.length, 0, "mô-đun dọn dữ liệu quá 30 ngày trong onTick");

    // Một mô-đun hỏng không chặn phát lệnh và đối soát của lõi, cũng không chặn mô-đun đứng sau nó.
    probe.failTick = true;
    const later: number[] = [];
    await h.restart({ modules: [fakeModule(probe), { name: "later", onTick: (_c, now) => void later.push(now) }] });
    const { action_id } = await planAndApprove(h, lampPlan("SET_OFF"));
    await assert.rejects(h.app.tick(), /mô-đun giả hỏng/);
    assert.notEqual((await action(h, action_id)).status, "AUTHORIZED", "lõi đã phát lệnh trước khi tới mô-đun");
    assert.deepEqual(later, [h.clock.now()]);
    probe.failTick = false;
    await h.app.tick();
    assert.equal(later.length, 2, "vòng sau vẫn chạy");
  } finally {
    await h.close();
  }
});

test("privacy: mô-đun góp vào tệp xuất, xóa dữ liệu khi DELETE, phản ứng khi rút đồng ý và khi RESTRICT, trong cùng giao dịch của lõi", async () => {
  const { h, probe } = await withFake();
  try {
    // Rút đồng ý qua route có sẵn, với mục đích mới của V1.0.0.
    assert.equal((await consent(h, "messaging")).status, 201);
    const w = await h.call("POST", "/v1/consents/messaging/withdraw", {});
    assert.equal(w.status, 200);
    assert.ok(w.body.withdrawn_at);
    assert.deepEqual(probe.withdrawn, ["dev_a:messaging"]);
    await h.call("POST", "/v1/consents/messaging/withdraw", {});
    assert.deepEqual(probe.withdrawn, ["dev_a:messaging"], "rút lần hai không báo lại");
    // Đổi từ đồng ý sang từ chối cũng là mất đồng ý.
    await consent(h, "social_post");
    await consent(h, "social_post", "DECLINED");
    assert.deepEqual(probe.withdrawn, ["dev_a:messaging", "dev_a:social_post"]);
    await consent(h, "social_post", "DECLINED");
    assert.equal(probe.withdrawn.length, 2, "từ chối khi chưa đồng ý không phải là rút");

    // Hook hỏng: cả thao tác rút bị hủy, đồng ý vẫn còn, không có gì nửa vời.
    await consent(h, "messaging");
    probe.failWithdraw = true;
    assert.equal((await h.call("POST", "/v1/consents/messaging/withdraw", {})).status, 500);
    assert.equal(one<{ withdrawn_at: string | null }>(h.app.ctx.db, "SELECT withdrawn_at FROM consents WHERE user_id = 'dev_a' AND purpose_id = 'messaging' ORDER BY rowid DESC LIMIT 1")?.withdrawn_at, null);
    probe.failWithdraw = false;

    // Xuất: phần của mô-đun nằm ở modules.<tên>, chỉ dữ liệu của chính người đó.
    await note(h, "của A");
    await note(h, "của B", "dev_b");
    const ex = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
    const file = (await h.call("GET", ex.body.export.path)).body;
    assert.deepEqual(file.modules.fake.notes.map((n: { label: string }) => n.label), ["của A"]);
    assert.ok(Array.isArray(file.consents) && Array.isArray(file.grants), "phần của lõi giữ nguyên");

    // RESTRICT: từng đồng ý đang hiệu lực bị rút (dev_ops có calendar_link và home_control), rồi tới onRestrict.
    probe.withdrawn.length = 0;
    assert.equal((await h.call("POST", "/v1/privacy/requests", { sub: "dev_ops", body: { type: "RESTRICT" } })).status, 202);
    assert.deepEqual(probe.withdrawn.sort(), ["dev_ops:calendar_link", "dev_ops:home_control"]);
    assert.deepEqual(probe.restricted, ["dev_ops"]);

    // DELETE: mô-đun xóa phần của mình trước tombstone; không gọi onConsentWithdrawn.
    probe.withdrawn.length = 0;
    assert.equal((await h.call("POST", "/v1/privacy/requests", { sub: "dev_b", body: { type: "DELETE" } })).status, 202);
    assert.deepEqual(probe.deleted, ["dev_b"]);
    assert.deepEqual(probe.withdrawn, []);
    assert.equal(all(h.app.ctx.db, "SELECT id FROM fake_notes WHERE user_id = 'dev_b'").length, 0);
    assert.equal(all(h.app.ctx.db, "SELECT id FROM fake_notes WHERE user_id = 'dev_a'").length, 1);
  } finally {
    await h.close();
  }
  const plain = await harness();
  try {
    const ex = await plain.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
    assert.equal("modules" in (await plain.call("GET", ex.body.export.path)).body, false, "không mô-đun nào có dữ liệu thì tệp xuất như 0.1.0");
  } finally {
    await plain.close();
  }
});

test("sổ thu hồi: mô-đun ghi dòng của mình và được nạp lại sau restore, cùng với phản ứng thêm cho dòng của lõi; nạp lại không ghi thêm", async () => {
  const { h } = await withFake();
  try {
    const at = nowIso(h.app.ctx);
    assert.throws(() => journalRevocation(h.app.ctx, "fake_unknown", at, {}), /chưa có bên nạp lại/, "dòng không ai nạp lại được thì không cho ghi");
    const n1 = (await note(h, "bị thu hồi sau backup")).body.id as string;
    await note(h, "của B, sẽ xóa", "dev_b");
    const backupPath = join(h.dir, "backup.db");
    backupLedger(h.app.ctx, backupPath);
    assert.equal((await h.call("POST", `/v1/fake/notes/${n1}/revoke`, {})).status, 200);
    assert.equal((await h.call("POST", "/v1/privacy/requests", { sub: "dev_b", body: { type: "DELETE" } })).status, 202);
    const entries = h.app.ctx.revocations.readAll().entries;
    assert.deepEqual(entries.map((e) => e.type), ["fake_note_revoked", "member_deleted"]);

    beginRecovery(h.app.ctx, "lead_1", "diễn tập nạp lại sổ thu hồi của mô-đun");
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    const revoked = () => one<{ revoked: number }>(h.app.ctx.db, "SELECT revoked FROM fake_notes WHERE id = ?", n1)?.revoked;
    assert.equal(revoked(), 0, "bản restore đã quên việc thu hồi");
    assert.equal(all(h.app.ctx.db, "SELECT id FROM fake_notes WHERE user_id = 'dev_b'").length, 1, "và làm sống lại dữ liệu đã xóa");
    const first = applyRevocations(h.app.ctx);
    assert.equal(first.entries, 2);
    assert.equal(first.applied, 3, "một dòng của mô-đun, một dòng của lõi và phản ứng thêm của mô-đun cho dòng đó");
    assert.equal(revoked(), 1);
    assert.equal(all(h.app.ctx.db, "SELECT id FROM fake_notes WHERE user_id = 'dev_b'").length, 0);
    assert.equal(one<{ status: string }>(h.app.ctx.db, "SELECT status FROM members WHERE user_id = 'dev_b'")?.status, "LEFT");
    assert.equal(applyRevocations(h.app.ctx).applied, 0, "lặp lại an toàn");
    assert.equal(h.app.ctx.revocations.readAll().entries.length, 2);

    // Một bên nạp lại mà ghi thêm vào sổ thu hồi là lỗi lập trình: bị chặn, sổ của bản restore không đổi.
    await h.restart({ modules: [{ name: "leaky", revocations: { member_deleted: (ctx, e) => (ctx.revocations.append("member_deleted", e.at, { workspace_id: e.workspace_id, user_id: e.user_id }), true) } }] });
    assert.throws(() => applyRevocations(h.app.ctx), /không được ghi thêm/);
  } finally {
    await h.close();
  }
});

test("kinds: một lần khai là vào đủ ba bảng; plan → đồng ý → giấy phép sim → receiver → bằng chứng SIMULATED", async () => {
  const { h } = await withFake();
  try {
    for (const map of [h.app.adapters, h.app.receivers, h.app.issuers]) assert.ok(map.has("fake.echo"));
    assert.equal(h.app.issuers.get("fake.echo"), h.app.simIssuer, "trust sim dùng issuer mô phỏng");
    assert.deepEqual(exportPolicy(h.app.ctx, WS).doc.kinds["fake.echo"], { purpose: "social_post", fields: ["card_code"], residual_inference: fakeKind.exportPolicy.residual_inference }, "workspace mới có sẵn mục chính sách xuất của loại này");

    // Cổng theo thứ tự của createPlan: cờ mô-đun → quyền → đồng ý.
    assert.throws(() => fakePlan(h, "dev_b"), (e: ApiError) => e.status === 403 && e.code === "FORBIDDEN", "dev_b không có quyền social.post");
    assert.throws(() => fakePlan(h), (e: ApiError) => e.code === "CONSENT_REQUIRED");
    await consent(h, "social_post");
    await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "social", enabled: false, reason: "kiểm kill switch của loại mới" } });
    assert.throws(() => fakePlan(h), (e: ApiError) => e.status === 503 && e.code === "MODULE_DISABLED");
    await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "social", enabled: true, reason: "mở lại" } });

    const plan = fakePlan(h);
    assert.equal(plan.state, "PENDING_APPROVAL");
    assert.equal(plan.preview.card_code, "INVITE");
    const ok = await approve(h, plan);
    assert.equal(ok.status, 202);
    const actionId = ok.body.action_id as string;
    // Giấy phép của issuer chính không mở được receiver của loại sim.
    const row = getByActionId(h.app.ctx.db, actionId)!;
    const wrong = issuePermit(h.app.ctx, h.app.issuer, h.app.receivers.get("fake.echo")!, row, h.app.identity);
    await assert.rejects(h.app.receivers.get("fake.echo")!.accept(wrong.token, h.app.identity.certDer), PermitError);
    assert.equal(getRow(h.app.ctx.db, row.id)?.state, "AUTHORIZED");
    await tick(h);
    const act = await action(h, actionId);
    assert.equal(act.status, "VERIFIED");
    assert.equal(act.evidence_grade, "SIMULATED");
    assert.equal(act.outcome, "SIMULATED");
    assert.equal((h.app.world.get("fake") as FakeWorld).posts.get(actionId), "INVITE");
    assert.equal(h.app.dispatcher.dispatched, 1);

    // Thế giới bên ngoài giả lập sống qua khởi động lại; trạng thái theo app thì dựng lại.
    const world = h.app.world;
    await h.restart();
    assert.equal(h.app.world, world);
    assert.equal((h.app.world.get("fake") as FakeWorld).posts.size, 1);

    // Rút đồng ý của mục đích gắn với loại này: plan chờ duyệt của loại đó bị vô hiệu, plan loại khác chưa bị đụng tới.
    const pending = fakePlan(h);
    const cal = (await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")) })).body;
    await h.call("POST", "/v1/consents/social_post/withdraw", {});
    assert.equal(getRow(h.app.ctx.db, pending.plan_id)?.state, "REJECTED");
    assert.equal(getRow(h.app.ctx.db, cal.plan_id)?.state, "PENDING_APPROVAL");
    assert.equal((await approve(h, pending)).body.code, "PLAN_STALE");

    // Binding của đích đổi sau khi lập plan: stale ở lần duyệt.
    await consent(h, "social_post");
    const p2 = fakePlan(h);
    (h.app.world.get("fake") as FakeWorld).binding = 2;
    const stale = await approve(h, p2);
    assert.equal(stale.body.code, "PLAN_STALE");
    assert.equal(getRow(h.app.ctx.db, p2.plan_id)?.reason, "BINDING_CHANGED");
  } finally {
    await h.close();
  }
});

test("kinds: không tự gửi lại, UNKNOWN chờ bằng chứng; bằng chứng tay của vận hành dùng outcome mô-đun khai", async () => {
  const { h } = await withFake();
  try {
    await consent(h, "social_post");
    const world = h.app.world.get("fake") as FakeWorld;
    world.silent = true;
    const plan = fakePlan(h);
    const actionId = (await approve(h, plan)).body.action_id as string;
    await tick(h);
    assert.equal((await action(h, actionId)).status, "ACKED");
    h.clock.advance(6_000);
    await h.app.reconciler.tick();
    assert.equal((await action(h, actionId)).status, "UNKNOWN", "thiếu adapter trong bảng của reconciler thì không bao giờ tới được đây");
    for (let i = 0; i < 5; i++) await tick(h);
    assert.equal((await action(h, actionId)).status, "UNKNOWN", "thời gian trôi qua không phải bằng chứng");
    assert.equal(world.posts.size, 1, "không gửi lại");
    assert.throws(() => fakePlan(h), (e: ApiError) => e.code === "RESOURCE_LOCKED");
    const ev = await h.call("POST", `/v1/ops/actions/${actionId}/evidence`, { sub: "dev_ops", body: { grade: "PHYSICAL_OBSERVED", result: "MATCH", source: "người vận hành thử", observed_at: nowIso(h.app.ctx), note: "đã xem bên giả lập" } });
    assert.equal(ev.status, 200);
    assert.equal(ev.body.status, "VERIFIED");
    assert.equal(ev.body.outcome, "SIMULATED");
  } finally {
    await h.close();
  }
});

test("kinds: đích giả lập (trust sim) không thể kết thúc bằng bằng chứng không ghi mô phỏng", async () => {
  const { h } = await withFake();
  try {
    await consent(h, "social_post");
    const world = h.app.world.get("fake") as FakeWorld;
    world.grade = "PROVIDER_READBACK";
    const actionId = (await approve(h, fakePlan(h))).body.action_id as string;
    for (let i = 0; i < 4; i++) await tick(h);
    const act = await action(h, actionId);
    assert.notEqual(act.status, "VERIFIED", "bằng chứng sai hạng không được dùng để xác minh");
    assert.equal(act.evidence_grade, null);
    assert.equal(all(h.app.ctx.db, "SELECT id FROM evidence WHERE grade <> 'SIMULATED'").length, 0, "không có gì lọt vào số liệu tác động thật");
    assert.match(one<{ last_note: string }>(h.app.ctx.db, "SELECT last_note FROM checks WHERE plan_id = ?", act.plan_id)?.last_note ?? "", /đích giả lập fake\.echo trả bằng chứng hạng PROVIDER_READBACK/);
    // Sửa lại đúng hạng thì lần đọc sau xác minh được, vẫn với nhãn mô phỏng.
    world.grade = "SIMULATED";
    h.clock.advance(10_000);
    for (let i = 0; i < 3; i++) await tick(h);
    const done = await action(h, actionId);
    assert.equal(done.status, "VERIFIED");
    assert.equal(done.evidence_grade, "SIMULATED");
  } finally {
    await h.close();
  }
});

test("kinds: workspace có từ trước nhận mục chính sách xuất khi mô-đun được đăng ký (plan chưa claim bị vô hiệu); gỡ mô-đun thì loại đó đóng", async () => {
  const h = await harness();
  try {
    assert.equal("fake.echo" in exportPolicy(h.app.ctx, WS).doc.kinds, false);
    const before = exportPolicy(h.app.ctx, WS).digest;
    const cal = (await h.call("POST", "/v1/plans", { body: calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")) })).body;
    await h.restart({ modules: [fakeModule(newProbe())] });
    const after = exportPolicy(h.app.ctx, WS);
    assert.deepEqual(after.doc.kinds["fake.echo"], policyEntry(fakeKind));
    assert.notEqual(after.digest, before);
    assert.equal(getRow(h.app.ctx.db, cal.plan_id)?.state, "REJECTED", "miền xuất mới làm stale bản duyệt cũ (SRS mục 14)");
    await h.restart({ modules: [fakeModule(newProbe())] });
    assert.equal(exportPolicy(h.app.ctx, WS).digest, after.digest, "đủ mục rồi thì không đổi nữa");

    await consent(h, "social_post");
    const plan = fakePlan(h);
    await h.restart({ modules: [] });
    const gone = await approve(h, plan);
    assert.equal(gone.status, 503, "loại không còn ai khai: không duyệt, không phát");
    assert.equal(gone.body.code, "MODULE_DISABLED");
    assert.throws(() => fakePlan(h), (e: ApiError) => e.status === 422 && e.code === "UNSUPPORTED");
  } finally {
    await h.close();
  }
});
