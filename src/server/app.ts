// Ghép các thành phần của máy chủ tham chiếu: sổ, control store, barrier, Authority, issuer permit (chính và mô phỏng), receiver,
// worker, reconciler, Model Gateway và API. Một tiến trình cho chạy thử; ranh giới tin cậy (Authority ↔ worker ↔ receiver) vẫn
// đi qua permit ký, mTLS identity giả lập và kiểm phiên bản như khi tách dịch vụ.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import { join } from "node:path";
import { systemClock, type Clock } from "../core/clock.ts";
import { generateEs256, type EcKeyPair } from "../core/crypto.ts";
import { SchemaSet } from "../core/schema.ts";
import { CONFIG, type Ctx } from "./context.ts";
import { ControlStore } from "./control.ts";
import { AppendJournal } from "./journal.ts";
import { openLedger } from "./store.ts";
import { loadOpenApi } from "./openapi.ts";
import { PermitIssuer, TrustStore } from "./permit.ts";
import { Receiver, type DispatchAdapter } from "./receiver.ts";
import type { ActionRow } from "./machine.ts";
import { Dispatcher, type WorkerIdentity } from "./worker.ts";
import { Reconciler } from "./reconciler.ts";
import { Idempotency, purgeIdempotency } from "./idempotency.ts";
import { purgeExports } from "./privacy.ts";
import { LocalRulesProvider, ModelGateway, type ModelProvider } from "./lele.ts";
import { DevIssuer, OidcVerifier } from "./auth.ts";
import { CORE_ROUTES, createHandler, type Metrics } from "./api.ts";
import { DEV_USERS, seedDemo, seedMocks, seedModuleFlags } from "./seed.ts";
import { KINDS, ensureKindPolicies } from "./authority.ts";
import { registerMessages } from "../core/errors.ts";
import { MODULES, validateModules, type ServerModule } from "./modules.ts";
import { MockGraph, type GraphClient } from "../adapters/graph-mock.ts";
import { CalendarAdapter } from "../adapters/calendar.ts";
import { MockMatterHub } from "../adapters/matter-mock.ts";
import { SiteGatewayAdapter } from "../adapters/site.ts";
import { RobotSimAdapter } from "../adapters/robot.ts";

export const AUTHORITY_ISSUER = "https://authority.lenhip.ledb.internal";
export const SIM_ISSUER = "https://sim-authority.lenhip.ledb.internal";
export const API_AUDIENCE = "lenhip-api";

/** Schema của hợp đồng đã ghép (lõi + mảnh của mô-đun, xem openapi.ts): máy chủ kiểm thân yêu cầu bằng chính các schema này. */
export const SCHEMAS = new SchemaSet(loadOpenApi().components.schemas);

/** Khóa ký permit của bản tham chiếu: tệp 0600 trong thư mục dữ liệu. Môi trường thật dùng KMS (LNH-D06). */
function loadKey(dir: string, name: string): EcKeyPair {
  const path = join(dir, `${name}.pem`);
  if (existsSync(path)) {
    const pem = readFileSync(path, "utf8");
    const privateKey = createPrivateKey(pem);
    const kid = readFileSync(join(dir, `${name}.kid`), "utf8").trim();
    return { kid, privateKey, publicKey: createPublicKey(privateKey) };
  }
  const k = generateEs256(`${name}-${randomBytes(4).toString("hex")}`);
  writeFileSync(path, k.privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
  writeFileSync(join(dir, `${name}.kid`), k.kid, { mode: 0o600 });
  return k;
}

/**
 * Đích giả lập (KindSpec.trust "sim") chỉ được đưa ra bằng chứng hạng SIMULATED (LNH-T19, LNH-T44). Bằng chứng hạng khác từ một
 * đích giả lập sẽ bị đọc như tác động thật, nên adapter bị chặn ngay tại đây: lần đọc trước I/O thành không dùng được, kết quả
 * thực thi và lần đọc lại thành chưa xác định. Không có đường nào để một tác vụ mô phỏng kết thúc với bằng chứng không ghi mô phỏng.
 */
function simulatedOnly(adapter: DispatchAdapter): DispatchAdapter {
  const check = <T extends object>(r: T): T => {
    const grade = "evidence" in r ? (r.evidence as { grade?: string } | undefined)?.grade : undefined;
    if (grade !== undefined && grade !== "SIMULATED") throw new Error(`đích giả lập ${adapter.kind} trả bằng chứng hạng ${grade}`);
    return r;
  };
  return Object.assign(Object.create(adapter) as DispatchAdapter, {
    precheck: async (row: ActionRow) => check(await adapter.precheck(row)),
    execute: async (row: ActionRow) => check(await adapter.execute(row)),
    readback: async (row: ActionRow) => check(await adapter.readback(row)),
  });
}

export interface AppOptions {
  dataDir: string;
  clock?: Clock;
  dev?: boolean;
  seed?: boolean;
  graph?: GraphClient & Partial<MockGraph>;
  hubs?: Map<string, MockMatterHub>;
  oidc?: { issuer: string; audience: string; keys: Map<string, import("node:crypto").KeyObject> };
  provider?: ModelProvider;
  config?: Partial<typeof CONFIG>;
  /** Mô-đun của app; mặc định là sổ đăng ký MODULES. Kiểm thử truyền mô-đun giả vào đây. */
  modules?: readonly ServerModule[];
  /** Thế giới bên ngoài giả lập của các mô-đun (KindSpec.adapter nhận nó); kiểm thử truyền lại để giữ qua khởi động lại. */
  world?: Map<string, unknown>;
}

export function createApp(o: AppOptions) {
  mkdirSync(o.dataDir, { recursive: true });
  const clock = o.clock ?? systemClock;
  const modules = o.modules ?? MODULES;
  validateModules(modules, { routes: CORE_ROUTES, kinds: KINDS });
  for (const m of modules) if (m.errors) registerMessages(m.errors);
  const ctx: Ctx = {
    db: openLedger(join(o.dataDir, "ledger.db")),
    clock,
    control: new ControlStore(join(o.dataDir, "control.json")),
    barrier: new AppendJournal(join(o.dataDir, "barrier.jsonl")),
    revocations: new AppendJournal(join(o.dataDir, "revocations.jsonl")),
    config: { ...CONFIG, ...(o.config ?? {}) },
    modules,
  };
  if (o.seed) {
    seedDemo(ctx);
    seedModuleFlags(ctx);
  }
  ensureKindPolicies(ctx);
  if (o.seed) for (const m of modules) m.seed?.(ctx);

  const issuer = new PermitIssuer(AUTHORITY_ISSUER, loadKey(o.dataDir, "permit-key"));
  const simIssuer = new PermitIssuer(SIM_ISSUER, loadKey(o.dataDir, "sim-permit-key"));
  const trust = new TrustStore();
  trust.add(issuer.kid, issuer.publicKey);
  const simTrust = new TrustStore();
  simTrust.add(simIssuer.kid, simIssuer.publicKey);

  const graph = (o.graph ?? new MockGraph()) as MockGraph;
  const hubs = o.hubs ?? new Map<string, MockMatterHub>();
  if (o.seed) seedMocks(ctx, graph, hubs, (site) => new MockMatterHub(site, () => clock.now()));

  const calendar = new CalendarAdapter(ctx, graph);
  const site = new SiteGatewayAdapter(ctx, hubs);
  const robot = new RobotSimAdapter(ctx);
  const adapters = new Map<string, DispatchAdapter>([["calendar.block", calendar], ["device.set_power", site], ["robot.simulate", robot]]);
  const receivers = new Map<string, Receiver>([
    ["calendar.block", new Receiver(ctx, calendar, trust, AUTHORITY_ISSUER)],
    ["device.set_power", new Receiver(ctx, site, trust, AUTHORITY_ISSUER)],
    ["robot.simulate", new Receiver(ctx, robot, simTrust, SIM_ISSUER)],
  ]);
  const issuers = new Map<string, PermitIssuer>([["calendar.block", issuer], ["device.set_power", issuer], ["robot.simulate", simIssuer]]);
  // Loại tác vụ của mô-đun: một lần khai, vào đủ cả ba bảng. Thiếu receiver hoặc issuer thì hàng outbox của loại đó không bao
  // giờ được giao và chặn các loại khác; thiếu adapter thì reconciler không đọc lại, tác vụ cũng không bao giờ thành UNKNOWN.
  const world = o.world ?? new Map<string, unknown>();
  for (const m of modules) {
    for (const k of m.kinds ?? []) {
      const sim = k.trust === "sim";
      const adapter = sim ? simulatedOnly(k.adapter(ctx, world)) : k.adapter(ctx, world);
      if (adapter.kind !== k.kind) throw new Error(`mô-đun ${m.name}: adapter của ${k.kind} khai loại ${adapter.kind}`);
      adapters.set(k.kind, adapter);
      receivers.set(k.kind, new Receiver(ctx, adapter, sim ? simTrust : trust, sim ? SIM_ISSUER : AUTHORITY_ISSUER));
      issuers.set(k.kind, sim ? simIssuer : issuer);
    }
  }

  // Chứng chỉ mTLS của worker: bản tham chiếu giữ một chuỗi byte cố định làm "DER" để tính x5t#S256; môi trường thật lấy từ
  // tlsSocket.getPeerCertificate().raw (LNH-D06).
  const certPath = join(o.dataDir, "worker-cert.der");
  if (!existsSync(certPath)) writeFileSync(certPath, randomBytes(256), { mode: 0o600 });
  const identity: WorkerIdentity = { certDer: readFileSync(certPath) };
  const dispatcher = new Dispatcher(ctx, issuers, receivers, identity);
  const reconciler = new Reconciler(ctx, adapters);

  const dev = o.dev ? new DevIssuer("https://dev-issuer.lenhip.local", API_AUDIENCE) : null;
  const verifier = new OidcVerifier(o.oidc ?? { issuer: dev?.issuer ?? "unset", audience: API_AUDIENCE, keys: dev?.keys() ?? new Map() });
  const idem = new Idempotency(ctx);
  const gateway = new ModelGateway(o.provider ?? new LocalRulesProvider(), SCHEMAS, { inputBytes: ctx.config.leleInputBytes, outputBytes: ctx.config.leleOutputBytes, timeoutMs: ctx.config.leleTimeoutMs });
  const metrics: Metrics = { requests: 0, recent: [], policyDenials: 0 };
  const handle = createHandler({
    ctx, schemas: SCHEMAS, idem, verifier, dev, devUsers: DEV_USERS.map((u) => ({ sub: u.sub, name: u.name })), gateway, calendar, metrics,
    dispatched: () => dispatcher.dispatched, webRoot: new URL("../../web/", import.meta.url), modules,
  });

  let running = false;
  let lastPoll = 0;
  /** Một vòng của worker và reconciler, cùng dọn dữ liệu hết hạn và ngắt phát khi tỉ lệ lỗi vượt ngưỡng (SRS mục 24). */
  async function tick() {
    if (running) return;
    running = true;
    try {
      await dispatcher.tick();
      await reconciler.tick();
      if (clock.now() - lastPoll >= 10_000) {
        lastPoll = clock.now();
        await site.pollStatus();
      }
      purgeIdempotency(ctx);
      purgeExports(ctx);
      errorRateBreaker();
      // Việc định kỳ của mô-đun chạy sau cùng: lỗi của một mô-đun không chặn phát lệnh, đối soát hay cầu dao ở trên, cũng không
      // chặn mô-đun khác (ví dụ việc dọn dữ liệu hết hạn của nó). Lỗi vẫn được ném ra sau khi mọi mô-đun đã chạy.
      const failed: unknown[] = [];
      for (const m of modules) {
        try {
          await m.onTick?.(ctx, clock.now());
        } catch (e) {
          failed.push(e);
        }
      }
      if (failed.length) throw failed.length === 1 ? failed[0] : new AggregateError(failed, "onTick của nhiều mô-đun lỗi");
    } finally {
      running = false;
    }
  }

  function errorRateBreaker() {
    const since = new Date(clock.now() - 5 * 60_000).toISOString();
    const rows = ctx.db.prepare("SELECT state FROM actions WHERE dispatch_claimed_at IS NOT NULL AND dispatch_claimed_at > ? AND imported = 0").all(since) as { state: string }[];
    const bad = rows.filter((r) => r.state === "FAILED" || r.state === "UNKNOWN").length;
    if (rows.length >= 20 && bad / rows.length > 0.05 && ctx.control.dispatchOpen()) {
      ctx.control.lockDispatch(new Date(clock.now()).toISOString(), "breaker", `ERROR_RATE ${bad}/${rows.length} trong 5 phút`);
      console.error(JSON.stringify({ level: "alert", alert: "DISPATCH_ERROR_RATE", bad, total: rows.length }));
    }
  }

  function start(intervalMs = 1000) {
    const t = setInterval(() => void tick().catch((e) => console.error(JSON.stringify({ level: "error", where: "tick", error: (e as Error).message }))), intervalMs);
    return () => clearInterval(t);
  }

  function close() {
    ctx.db.close();
  }

  return { ctx, issuer, simIssuer, trust, simTrust, graph, hubs, world, adapters, receivers, issuers, identity, dispatcher, reconciler, dev, verifier, idem, gateway, metrics, handle, tick, start, close };
}

export type App = ReturnType<typeof createApp>;
