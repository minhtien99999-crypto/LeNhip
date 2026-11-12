// Phần dùng chung của các phép kiểm trình duyệt (Playwright có sẵn trên máy kiểm; không cài thêm gì).
//
// Chạy tất cả:      npm run e2e                      = node scripts/e2e-lib.mjs
//                   chạy scripts/e2e.mjs trước, rồi mọi scripts/e2e-*.mjs khác (trừ tệp này); một tệp hỏng thì cả lượt hỏng.
// Chạy một phần:    npm run e2e -- shell             chỉ scripts/e2e-shell.mjs ("main" là scripts/e2e.mjs)
// Lưu ảnh:          npm run e2e -- --shots=thư-mục   mỗi tệp ghi vào thư-mục/<tên>/
// Chạy riêng:       node scripts/e2e-shell.mjs [thư-mục-ảnh]
//
// Viết một tệp kiểm mới (scripts/e2e-<tên>.mjs), không cần sửa package.json hay tệp này:
//
//   import { run } from "./e2e-lib.mjs";
//   await run("tên", async (t) => {
//     const { page } = await t.open({ modules: { messaging: true } });   // máy chủ dev + trình duyệt + đã vào tài khoản dev_a
//     await t.dismissNotice(page);
//     await page.click("button[data-nav=messages]");
//     t.ok((await page.textContent("main")).includes("…"), "mô tả phép kiểm");
//   });
//
// Mỗi tệp có máy chủ riêng (cổng trống, LENHIP_DEV=1, thư mục dữ liệu tạm bị xóa khi xong) nên các tệp không ảnh hưởng nhau.
// Mọi lỗi JavaScript hoặc console.error trên trang làm hỏng lượt kiểm, trừ khi trang được mở với { collectErrors: false }.
// Cờ mô-đun (messaging, social, trackers) được thêm vào phản hồi /v1/me bằng chặn route, không sửa máy chủ.
// Máy chủ giới hạn 5 yêu cầu/giây cho mỗi tài khoản (dồn tối đa 40): trong vòng lặp dài hãy đổi màn hình bằng #id và đổi
// phong cách bằng chooseSettings thay vì nạp lại trang, nếu không /v1/me sẽ nhận 429.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const THEMES = ["orbit", "night", "calm", "flow", "titanium"];
/** Ngữ cảnh mặc định của mọi phép kiểm: giờ Việt Nam, trình duyệt tiếng Việt, một điểm ảnh thiết bị cho một điểm ảnh CSS. */
export const DEFAULT_CONTEXT = { timezoneId: "Asia/Ho_Chi_Minh", locale: "vi-VN", deviceScaleFactor: 1 };
export const DESKTOP = { width: 1440, height: 900 };
export const PHONE = { width: 390, height: 844 };
const PREFS_KEY = "lenhip.ui.v2";

export function playwright() {
  return createRequire(import.meta.url)("playwright");
}

/** Một cổng TCP đang trống trên localhost. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Dựng máy chủ chạy thử (dữ liệu tổng hợp của chế độ dev) trên cổng trống với thư mục dữ liệu tạm. */
export async function startServer({ env = {} } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "lenhip-e2e-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["src/main.ts"], {
    cwd: ROOT,
    env: { ...process.env, LENHIP_DEV: "1", PORT: String(port), LENHIP_DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const stop = () => {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  };
  for (let i = 0; i < 75; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(base + "/healthz")).ok) return { base, port, dataDir, stop };
    } catch {
      /* chưa lên */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  stop();
  throw new Error("máy chủ chạy thử không lên:\n" + log.slice(-2000));
}

/** Chờ ứng dụng nạp xong /v1/me và vẽ lần đầu (app.js đặt body[data-ready] sau lượt refresh đầu tiên). */
export async function ready(page) {
  await page.waitForSelector("body[data-ready=true]", { state: "attached" });
}

/** Đặt ba cờ mô-đun mới trong phản hồi /v1/me: cờ không nêu trong `modules` được coi là tắt (seed dev bật sẵn cả ba). */
export async function withModules(context, modules) {
  await context.route("**/v1/me", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const json = await response.json();
    json.modules = { ...json.modules, messaging: false, social: false, trackers: false, ...modules };
    await route.fulfill({ response, json });
  });
}

/** Thông báo đầu tiên: chọn các mục đích rồi lưu. */
export async function acceptNotice(page, purposes = ["health_local", "calendar_link", "home_control"]) {
  await page.waitForSelector("#consent-form");
  for (const name of purposes) await page.check(`#consent-form input[name=${name}]`);
  await page.click("#consent-form button");
  await page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
}

/** Đóng thông báo đầu tiên nếu nó đang mở, không chọn gì. */
export async function dismissNotice(page) {
  if (await page.$("#action-dialog[open] #consent-form")) await page.click("#action-dialog [data-action=close-action]");
}

/** Đổi sang một tài khoản thử của chế độ dev (dev_a, dev_b, dev_ops) qua hộp Tài khoản như người dùng. */
export async function signIn(page, sub) {
  await dismissNotice(page);
  await page.click("#profile-button");
  const me = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/me" && r.ok());
  await page.click(`button[data-login=${sub}]`);
  await me;
  await page.waitForFunction((id) => JSON.parse(sessionStorage.getItem("lenhip.session") ?? "{}").sub === id, sub);
  await page.waitForTimeout(150);
}

/** Đổi phong cách và cỡ chữ qua hộp Cá nhân hóa như người dùng: không nạp lại trang, không gọi máy chủ. */
export async function chooseSettings(page, { theme, fontSize } = {}) {
  await page.click("#settings-button");
  if (fontSize) await page.selectOption("#font-size", String(fontSize));
  if (theme) await page.click(`button[data-draft-theme=${theme}]`);
  await page.click("#settings-form button[type=submit]");
  await page.waitForSelector("#settings-dialog:not([open])", { state: "attached" });
  if (theme) await page.waitForSelector(`body[data-theme=${theme}]`, { state: "attached" });
}

/**
 * Ghi thẳng tùy chọn giao diện của tài khoản vào localStorage rồi nạp lại trang (cho tùy chọn không có trong hộp Cá nhân hóa).
 * Mỗi lần nạp lại là bốn yêu cầu API: đừng gọi trong vòng lặp dài, máy chủ giới hạn 5 yêu cầu/giây cho mỗi tài khoản.
 */
export async function applySettings(page, settings, sub = "dev_a") {
  await page.evaluate(([key, user, patch]) => {
    const prefs = JSON.parse(localStorage.getItem(key) ?? "null") ?? { version: 2, users: {}, activeSub: user };
    prefs.users[user] = { ...(prefs.users[user] ?? {}), ...patch };
    prefs.activeSub = user;
    localStorage.setItem(key, JSON.stringify(prefs));
  }, [PREFS_KEY, sub, settings]);
  await page.reload();
  await ready(page);
  await dismissNotice(page);
}

/** Số điểm ảnh trang tràn theo chiều ngang (0 là không cuộn ngang). */
export function overflowX(page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

/**
 * Nhãn điều hướng đang hiển thị mà chữ vượt ra ngoài nút của nó, hoặc nút vượt ra ngoài thanh điều hướng.
 * Trả mảng mô tả; rỗng là đạt. Đo hộp của chữ thật (Range), không phải hộp của phần tử.
 */
export function navSpill(page) {
  return page.evaluate(() => {
    const out = [];
    for (const nav of document.querySelectorAll("#desktop-nav, #mobile-nav")) {
      if (getComputedStyle(nav).display === "none" || nav.getClientRects().length === 0) continue;
      const bar = nav.getBoundingClientRect();
      for (const button of nav.querySelectorAll(".nav-button")) {
        const b = button.getBoundingClientRect();
        const label = button.querySelector(".nav-label");
        const range = document.createRange();
        range.selectNodeContents(label);
        const text = range.getBoundingClientRect();
        const name = nav.id + ":" + label.textContent;
        if (text.left < b.left - 0.5 || text.right > b.right + 0.5 || text.top < b.top - 0.5 || text.bottom > b.bottom + 0.5) out.push(`${name} chữ ${Math.round(text.width)} px trong nút ${Math.round(b.width)} px`);
        if (b.left < bar.left - 0.5 || b.right > bar.right + 0.5) out.push(`${name} nút vượt thanh`);
        if (b.height < 44) out.push(`${name} nút thấp ${Math.round(b.height)} px`);
      }
    }
    return out;
  });
}

/**
 * Khung của một tệp kiểm: dựng máy chủ và trình duyệt, chạy `fn(t)`, kiểm không có lỗi JavaScript, dọn dẹp, đặt mã thoát.
 * `t`: { base, browser, ok(điều kiện, mô tả), shot(page, tên, cả trang?), open(tùy chọn) -> { context, page }, errors,
 *        ready, acceptNotice, dismissNotice, signIn, chooseSettings, applySettings, overflowX, navSpill, withModules }.
 * t.open({ viewport, modules, collectErrors, path, wait, …tùy chọn ngữ cảnh của Playwright }) mở trang ứng dụng và chờ sẵn sàng.
 */
export async function run(name, fn, { shots = process.argv[2] ?? null, env } = {}) {
  if (shots) mkdirSync(shots, { recursive: true });
  let checks = 0;
  const ok = (cond, msg) => {
    if (!cond) throw new Error("✗ " + msg);
    checks++;
    console.log("✓ " + msg);
  };
  const errors = [];
  let server = null;
  let browser = null;
  try {
    server = await startServer({ env });
    browser = await playwright().chromium.launch();
    const base = server.base;
    const shot = async (page, file, fullPage = false) => (shots ? page.screenshot({ path: join(shots, file + ".png"), fullPage }) : null);
    const open = async ({ viewport = DESKTOP, modules = null, collectErrors = true, path = "/", wait = true, ...contextOptions } = {}) => {
      const context = await browser.newContext({ ...DEFAULT_CONTEXT, viewport, ...contextOptions });
      if (modules) await withModules(context, modules);
      const page = await context.newPage();
      if (collectErrors) {
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      }
      await page.goto(base + path);
      if (wait) await ready(page);
      return { context, page };
    };
    await fn({ base, browser, ok, shot, open, errors, ready, acceptNotice, dismissNotice, signIn, chooseSettings, applySettings, overflowX, navSpill, withModules });
    ok(errors.length === 0, "không có lỗi JavaScript" + (errors.length ? ": " + errors.join(" | ") : ""));
    console.log(`\n${checks} phép kiểm trình duyệt đạt (${name})`);
  } catch (e) {
    console.error(e instanceof Error ? (e.message.startsWith("✗") ? e.message : e.stack) : e);
    console.error(`\n${name}: hỏng sau ${checks} phép kiểm đạt`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    server?.stop();
  }
}

// ---------------------------------------------------------------- chạy cả bộ khi tệp này được gọi trực tiếp
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const shotsArg = args.find((a) => a.startsWith("--shots="))?.slice(8) ?? null;
  const only = args.filter((a) => !a.startsWith("--"));
  const dir = join(ROOT, "scripts");
  const others = readdirSync(dir).filter((f) => /^e2e-[a-z0-9-]+\.mjs$/.test(f) && f !== basename(fileURLToPath(import.meta.url))).sort();
  const files = ["e2e.mjs", ...others].filter((f) => only.length === 0 || only.includes(f === "e2e.mjs" ? "main" : f.slice(4, -4)));
  if (!files.length) {
    console.error("Không có tệp kiểm nào khớp: " + only.join(", "));
    process.exit(1);
  }
  const failed = [];
  for (const file of files) {
    const label = file === "e2e.mjs" ? "main" : file.slice(4, -4);
    console.log(`\n━━ ${file}`);
    const r = spawnSync(process.execPath, [join(dir, file), ...(shotsArg ? [join(shotsArg, label)] : [])], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) failed.push(file);
  }
  console.log(`\n${files.length - failed.length}/${files.length} tệp kiểm trình duyệt đạt` + (failed.length ? "; hỏng: " + failed.join(", ") : ""));
  process.exit(failed.length ? 1 : 0);
}
