// Dựng một máy chủ LeNhip thật trên cổng ngẫu nhiên với đồng hồ tay, dữ liệu tổng hợp và lịch/đèn giả lập.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ManualClock } from "../src/core/clock.ts";
import { createApp, type App, type AppOptions } from "../src/server/app.ts";
import { DEMO_WS, grantConsentsDirect } from "../src/server/seed.ts";

export const WS = DEMO_WS;
export const T0 = "2026-11-11T02:00:00.000Z"; // 09:00 tại Hà Nội, thứ Tư

export interface Harness {
  app: App;
  clock: ManualClock;
  dir: string;
  base: string;
  token(sub: string, opts?: { authTime?: number }): string;
  call(method: string, path: string, o?: { sub?: string; body?: unknown; key?: string | null; ws?: string; raw?: string; headers?: Record<string, string> }): Promise<{ status: number; body: any; headers: Headers }>;
  close(): Promise<void>;
  restart(opts?: Partial<AppOptions>): Promise<void>;
}

export const key = () => randomBytes(32).toString("base64url");

export async function harness(opts: Partial<AppOptions> & { consents?: boolean; at?: string } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "lenhip-test-"));
  const clock = new ManualClock(opts.at ?? T0);
  let app = createApp({ dataDir: dir, clock, dev: true, seed: true, config: { rateLimit: { perSecond: 1000, burst: 100000 } }, ...opts });
  if (opts.consents !== false) {
    grantConsentsDirect(app.ctx, "dev_a", ["calendar_link", "home_control"]);
    grantConsentsDirect(app.ctx, "dev_b", ["calendar_link"]);
    grantConsentsDirect(app.ctx, "dev_ops", ["calendar_link", "home_control"]);
  }
  let server: Server = createServer((req, res) => void app.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = () => (server.address() as { port: number }).port;
  const h: Harness = {
    get app() {
      return app;
    },
    clock,
    dir,
    get base() {
      return `http://127.0.0.1:${port()}`;
    },
    token(sub, o = {}) {
      return (app.dev as NonNullable<App["dev"]>).mint(sub, sub, clock.now(), { authTime: o.authTime });
    },
    async call(method, path, o = {}) {
      const headers: Record<string, string> = { "X-LeNhip-Workspace": o.ws ?? WS, ...(o.headers ?? {}) };
      if (o.sub !== undefined || !("headers" in o && o.headers?.Authorization)) headers.Authorization = `Bearer ${h.token(o.sub ?? "dev_a")}`;
      let body: string | undefined;
      if (method === "POST") {
        if (o.key !== null) headers["Idempotency-Key"] = o.key ?? key();
        body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
        if (body !== undefined) headers["Content-Type"] = "application/json";
      }
      const res = await fetch(h.base + path, { method, headers, body });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* không phải JSON */
      }
      return { status: res.status, body: parsed, headers: res.headers };
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      try {
        app.close();
      } catch {
        /* đã đóng */
      }
      rmSync(dir, { recursive: true, force: true });
    },
    async restart(more = {}) {
      await new Promise<void>((r) => server.close(() => r()));
      try {
        app.close();
      } catch {
        /* đã đóng (ví dụ trước khi restore tệp sổ) */
      }
      // Thế giới bên ngoài giả lập (lịch, đèn, và `world` của các mô-đun) sống qua lần khởi động lại; trạng thái trong bộ nhớ của app thì không.
      app = createApp({ dataDir: dir, clock, dev: true, seed: true, graph: app.graph, hubs: app.hubs, world: app.world, config: { rateLimit: { perSecond: 1000, burst: 100000 } }, ...opts, ...more });
      server = createServer((req, res) => void app.handle(req, res));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    },
  };
  return h;
}

/** Giờ local Hà Nội của hôm nay theo đồng hồ tay. */
export function vn(clock: ManualClock, hhmm: string, dayOffset = 0) {
  const d = new Date(clock.now() + 7 * 3600_000 + dayOffset * 86_400_000).toISOString().slice(0, 10);
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${d}T00:00:00Z`) + (h * 60 + m - 7 * 60) * 60_000).toISOString();
}

export function calendarPlan(start: string, end: string) {
  return { kind: "calendar.block", schema_version: 1, workspace_ref: WS, args: { calendar_ref: "primary", start, end, zone: "Asia/Ho_Chi_Minh", title_code: "PERSONAL_TIME", visibility: "private" } };
}

export function lampPlan(command: "SET_ON" | "SET_OFF", device = "dev_lamp_01") {
  return { kind: "device.set_power", schema_version: 1, workspace_ref: WS, args: { site: "site_lab01", device_ref: device, command } };
}

/** Tạo plan rồi duyệt; trả action_id. */
export async function planAndApprove(h: Harness, body: unknown, sub = "dev_a") {
  const p = await h.call("POST", "/v1/plans", { sub, body });
  if (p.status !== 201) throw new Error(`plan ${p.status} ${JSON.stringify(p.body)}`);
  const a = await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { sub, body: { plan_version: p.body.plan_version, approved_digest: p.body.payload_digest } });
  if (a.status !== 202) throw new Error(`approve ${a.status} ${JSON.stringify(a.body)}`);
  return { plan: p.body, action_id: a.body.action_id as string };
}

/**
 * Một vòng: worker phát, reconciler đọc ngay (lịch đọc tại t=0), đồng hồ tiến 1,1 giây rồi reconciler đọc lần nữa (đèn đọc tại
 * t=1 giây). Đồng hồ tay không tự chạy.
 */
export async function tick(h: Harness, times = 1) {
  for (let i = 0; i < times; i++) {
    await h.app.dispatcher.tick();
    await h.app.reconciler.tick();
    h.clock.advance(1100);
    await h.app.reconciler.tick();
  }
}

export const action = async (h: Harness, id: string, sub = "dev_a") => (await h.call("GET", `/v1/actions/${id}`, { sub })).body;
