// Kiểm trình duyệt của bản trình diễn tĩnh (scripts/build-demo.mjs): KHÔNG có máy chủ LeNhip. Tệp này tự dựng bản trình diễn vào
// thư mục tạm, phục vụ nó bằng một máy chủ tệp tĩnh thuần (không /v1, /v2, /dev), bọc index.html trong một khung tài liệu tối
// thiểu như nơi phát hành làm, rồi đi các hành trình chính trên Chromium. Vì tự dựng nên chạy được trong `npm run e2e` như mọi
// tệp e2e-*.mjs khác (chừng 1–2 phút); chạy riêng: `npm run e2e -- demo` hoặc `node scripts/e2e-demo.mjs [thư-mục-ảnh]`.
//
// Kiểm: khởi động không lỗi console; đăng nhập tài khoản thử; thông báo đầu tiên; khung giờ qua xem lại và xác nhận tới VERIFIED
// với bằng chứng mô phỏng; đèn; thẻ tóm tắt buổi sáng; Hộp tổng hợp (nhập, nối nguồn Outlook giả lập); bản nháp giữa hai thẻ và
// 409; Dịch vụ: Le‑NodeHome qua các bước LeLS của bản trình diễn, phép đo tổng hợp, lượt mô phỏng; nhắn tin với người nhận mô
// phỏng; tiếng Anh, tiếng Nhật; năm
// phong cách; điện thoại 390×844 và máy tính 1440×900; dải bản trình diễn hiện và không đè thanh điều hướng; không yêu cầu nào
// rời khỏi gốc của trang.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { acceptNotice, chooseSettings, DEFAULT_CONTEXT, DESKTOP, dismissNotice, overflowX, PHONE, playwright, THEMES } from "./e2e-lib.mjs";
import { buildDemo } from "./build-demo.mjs";

const TYPES = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", png: "image/png", json: "application/json" };
const shots = process.argv[2] ?? null;
let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("✗ " + msg);
  checks++;
  console.log("✓ " + msg);
};

/** Máy chủ tệp tĩnh: `/` là khung tài liệu tối thiểu bọc index.html (như nơi phát hành); mọi đường khác là tệp, không có API. */
function serve(dir) {
  const hits = [];
  const index = readFileSync(join(dir, "index.html"), "utf8");
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body>\n${index}</body></html>`;
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    hits.push(`${req.method} ${path}`);
    if (path === "/") {
      res.writeHead(200, { "Content-Type": TYPES.html, "Cache-Control": "no-store" });
      return res.end(page);
    }
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile() || path === "/index.html") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("không có");
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(file).slice(1)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, base: `http://127.0.0.1:${server.address().port}` })));
}

const dir = mkdtempSync(join(tmpdir(), "lenhip-demo-"));
let browser = null;
let srv = null;
const errors = [];
const outside = [];
try {
  if (shots) mkdirSync(shots, { recursive: true });
  const files = buildDemo(dir);
  const bytes = files.reduce((n, f) => n + f.bytes, 0);
  ok(bytes < 16 * 1024 * 1024 && files.some((f) => f.path === "demo/backend.js"), `bản dựng có ${files.length} tệp, ${(bytes / 1048576).toFixed(2)} MB, dưới 16 MB`);
  const index = readFileSync(join(dir, "index.html"), "utf8");
  ok(!/<!doctype|<\/?(html|head|body)[\s>]/i.test(index) && !index.includes('rel="manifest"') && index.indexOf("./demo/boot.js") < index.indexOf("./app.js"), "index.html không có khung tài liệu, không manifest, demo/boot.js nạp trước app.js");
  srv = await serve(dir);
  const { base } = srv;
  browser = await playwright().chromium.launch();
  const shot = (page, name, fullPage = false) => (shots ? page.screenshot({ path: join(shots, name + ".png"), fullPage }) : null);
  const newContext = async (viewport = DESKTOP, more = {}) => {
    const context = await browser.newContext({ ...DEFAULT_CONTEXT, viewport, ...more });
    // Không yêu cầu nào được rời khỏi gốc của trang: chặn và ghi lại.
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      if (u.origin !== base) {
        outside.push(u.href);
        return route.abort();
      }
      return route.continue();
    });
    return context;
  };
  const openPage = async (context) => {
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(base + "/");
    await page.waitForSelector("body[data-ready=true]", { state: "attached" });
    return page;
  };
  // signIn của e2e-lib chờ phản hồi mạng /v1/me; ở đây không có mạng (bản giả trả lời trong trang), nên chờ phiên đổi.
  const signIn = async (p, sub) => {
    await dismissNotice(p);
    await p.click("#profile-button");
    await p.click(`button[data-login=${sub}]`);
    await p.waitForFunction((id) => JSON.parse(sessionStorage.getItem("lenhip.session") ?? "{}").sub === id, sub);
    await p.waitForTimeout(300);
  };
  const text = (page, sel = "main") => page.textContent(sel).then((s) => s ?? "");
  const go = (page, id) => page.evaluate((v) => (location.hash = "#" + v), id);
  const ribbonOk = (page) => page.evaluate(() => {
    const r = document.getElementById("demo-ribbon")?.getBoundingClientRect();
    if (!r || r.height === 0) return "không thấy dải";
    const out = [];
    for (const sel of ["#mobile-nav", "#desktop-nav", ".topbar", "#main"]) {
      const el = document.querySelector(sel);
      if (!el || getComputedStyle(el).display === "none" || !el.getClientRects().length) continue;
      const b = el.getBoundingClientRect();
      if (b.height && b.top < r.bottom - 0.5 && b.bottom > r.top + 0.5 && b.left < r.right && b.right > r.left) out.push(sel + " bị dải đè");
    }
    if (r.top < 0) out.push("dải lọt khỏi màn hình");
    return out.join(", ");
  });

  // ---------------------------------------------------------------- 1. khởi động, đăng nhập, thông báo đầu tiên
  const ctxA = await newContext();
  const page = await openPage(ctxA);
  const ribbonText = await text(page, "#demo-ribbon");
  ok(ribbonText.includes("Bản trình diễn chạy trong trình duyệt · không có máy chủ · mọi kết quả là mô phỏng · dữ liệu chỉ lưu trên trình duyệt này") && ribbonText.includes("Đặt lại bản trình diễn"), "dải bản trình diễn: câu tiếng Việt và nút đặt lại");
  ok((await ribbonOk(page)) === "", "máy tính: dải không đè thanh bên, đầu trang hay nội dung");
  ok((await page.evaluate(() => JSON.parse(sessionStorage.getItem("lenhip.session") ?? "{}").sub)) === "dev_a", "tự đăng nhập tài khoản thử Thử nghiệm A như chế độ dev");
  await page.waitForSelector("#consent-form");
  ok((await page.$$("#consent-form input[type=checkbox]:checked")).length === 0, "thông báo đầu tiên mở như lần đầu, mặc định để trống");
  await shot(page, "01-thong-bao");
  await acceptNotice(page);
  await signIn(page, "dev_b");
  ok((await text(page, "#profile-button")).trim().length > 0 && (await page.evaluate(() => JSON.parse(sessionStorage.getItem("lenhip.session")).sub)) === "dev_b", "đổi sang Thử nghiệm B qua hộp Tài khoản");
  await signIn(page, "dev_a");

  // ---------------------------------------------------------------- 2. khung giờ: plan → xem lại → xác nhận → VERIFIED (mô phỏng)
  await page.waitForSelector(".brief-card");
  ok((await text(page, ".brief-card")).includes("Bản tóm tắt buổi sáng"), "thẻ tóm tắt buổi sáng trên Hôm nay");
  await page.click("button[data-nav=work]");
  await page.waitForTimeout(300);
  ok((await text(page)).includes("Bận"), "lịch mô phỏng có khoảng bận");
  await page.click("button[data-action=new-block]");
  await page.selectOption("#block-day", { index: 1 });
  await page.fill("#block-start", "16:00");
  await page.fill("#block-end", "16:30");
  await page.click("#block-form button");
  await page.waitForSelector("#countdown");
  ok((await text(page, "#action-body")).includes("16:00 – 16:30"), "xem lại nội dung đã chuẩn hóa, có đếm ngược 120 giây");
  await page.click("button[data-action=approve-plan]");
  await page.waitForSelector("#action-body .status-chip.ok", { timeout: 15000 });
  ok((await text(page, "#action-body")).includes("mô phỏng") && !(await text(page, "#action-body")).includes("đọc lại từ lịch"), "khung giờ VERIFIED với bằng chứng hạng mô phỏng, không giả là đọc lại từ lịch");
  await shot(page, "02-da-xac-minh");
  await page.click("#action-dialog [data-action=close-action]");

  // ---------------------------------------------------------------- 3. đèn
  await page.click("button[data-nav=house]");
  await page.waitForSelector("button.switch[data-device=dev_lamp_01]");
  const before = await page.getAttribute("button.switch[data-device=dev_lamp_01]", "aria-checked");
  await page.click("button.switch[data-device=dev_lamp_01]");
  await page.waitForSelector("#countdown");
  await page.click("button[data-action=approve-plan]");
  await page.waitForSelector("#action-body .status-chip.ok", { timeout: 15000 });
  ok((await text(page, "#action-body")).includes("mô phỏng"), "đèn: kết quả theo bằng chứng mô phỏng");
  await page.click("#action-dialog [data-action=close-action]");
  await page.waitForFunction((b) => document.querySelector("button.switch[data-device=dev_lamp_01]")?.getAttribute("aria-checked") !== b, before, { timeout: 15000 });
  ok(true, "đèn đổi trạng thái sau khi tác vụ được xác minh");

  // ---------------------------------------------------------------- 4. LeLe
  await page.click("button[data-nav=home]");
  await page.click("main button[data-action=chat]");
  await page.fill("#chat-form input", "tối qua tôi ngủ kém");
  await page.click("#chat-form button");
  await page.waitForTimeout(300);
  ok((await text(page, "#chat-list")).includes("không gửi tới LeLe"), "LeLe: câu về sức khỏe bị chặn bằng cùng bảng từ");
  await page.fill("#chat-form input", "dành 30 phút tập trung lúc 17:00 ngày mai");
  await page.click("#chat-form button");
  await page.waitForSelector("button[data-action=use-proposal]");
  ok(true, "LeLe soạn đề xuất khung giờ từ câu gõ");
  await page.keyboard.press("Escape").catch(() => {});
  await page.goto(base + "/#home");
  await page.waitForSelector("body[data-ready=true]", { state: "attached" });
  ok((await page.$$("#consent-form")).length === 0, "nạp lại trang: đồng ý vẫn còn (trạng thái lưu trên trình duyệt này)");

  // ---------------------------------------------------------------- 5. Hộp tổng hợp
  await go(page, "inbox");
  await page.waitForSelector("[data-inbox-add]");
  await page.click("[data-inbox-add]");
  await page.fill("#action-body textarea[name=text]", "Xem lại biên bản họp quý");
  await page.click("[data-inbox-save]");
  await page.waitForSelector(".inbox-item[data-source=SHARED]");
  ok(true, "Hộp tổng hợp: lưu phần tự chia sẻ");
  await page.waitForSelector("form[data-inbox-consent]");
  await page.check("form[data-inbox-consent] input[name=agree]");
  await page.click("form[data-inbox-consent] button[type=submit]");
  await page.waitForSelector("[data-inbox-src=OUTLOOK_MAIL][data-status=CONNECTED]", { timeout: 15000 });
  await page.waitForSelector(".inbox-item[data-source=OUTLOOK_MAIL]", { timeout: 20000 });
  ok((await text(page)).includes("(thử)"), "nguồn Outlook giả lập: thư tổng hợp, người gửi ghi «thử»");
  await shot(page, "03-hop-tong-hop");

  // ---------------------------------------------------------------- 6. bản nháp giữa hai thẻ của cùng trình duyệt và 409
  await go(page, "home");
  const register = async (p, kind) => {
    await p.waitForSelector(".brief-card [data-brief=register]");
    await p.click(".brief-card [data-brief=register]");
    await p.check(`#action-body input[name=kind][value=${kind}]`);
    await p.click("#action-body [data-sync-register] button[type=submit]");
    await p.waitForSelector("#action-dialog:not([open])", { state: "attached" });
    await p.waitForSelector(".brief-card [data-brief=new-task]");
  };
  const saveTask = async (p, title, open = null) => {
    if (open) await p.click(`.brief-card [data-brief=open]:has-text("${open}")`);
    else await p.click(".brief-card [data-brief=new-task]");
    await p.fill("#action-body input[name=title]", title);
    await p.click("#action-body [data-sync-editor] button[type=submit]");
    await p.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  };
  await register(page, "LAPTOP");
  const tab2 = await openPage(ctxA);
  await dismissNotice(tab2);
  // Hai thẻ của cùng trình duyệt là cùng một thiết bị: thẻ thứ hai dùng phiên đồng bộ đã lưu trên trình duyệt này.
  await tab2.waitForSelector(".brief-card [data-brief=new-task]");
  await saveTask(page, "Mua sữa");
  await page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Mua sữa") && !document.querySelector(".brief-card")?.textContent.includes("Chờ kết nối"));
  await tab2.click(".brief-card [data-brief=refresh]");
  await tab2.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Mua sữa"));
  ok(true, "bản nháp tạo ở thẻ thứ nhất hiện ở thẻ thứ hai (cùng «máy chủ» trong trình duyệt)");
  await saveTask(page, "Mua sữa và trứng", "Mua sữa");
  await page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Mua sữa và trứng") && !document.querySelector(".brief-card")?.textContent.includes("Chờ kết nối"));
  await saveTask(tab2, "Mua bánh mì", "Mua sữa");
  await tab2.waitForSelector(".brief-card [data-brief=conflict]", { timeout: 15000 });
  await tab2.click(".brief-card [data-brief=conflict]");
  await tab2.waitForSelector("#action-body .sync-versions");
  const dlg = await text(tab2, "#action-body");
  ok(dlg.includes("Mua bánh mì") && dlg.includes("Mua sữa và trứng"), "sửa trên bản cũ: 409 REVISION_CONFLICT, hộp hiện cả hai bản để chọn");
  await shot(tab2, "04-xung-dot");
  await tab2.click('#action-body [data-sync="mine"]');
  await tab2.waitForFunction(() => !document.querySelector(".brief-card [data-brief=conflict]"));
  await tab2.close();

  // ---------------------------------------------------------------- 7. Dịch vụ: Le‑NodeHome, phép đo, mô phỏng
  const HOME = ".connect-section[data-section=home-hub]";
  const MEAS = ".connect-section[data-section=measure]";
  const SIM = ".connect-section[data-section=sim]";
  await go(page, "services");
  await page.waitForSelector(`${HOME} [data-home-form=consent]`);
  await page.check(`${HOME} [data-home-form=consent] input[type=checkbox]`).catch(() => {});
  await page.click(`${HOME} [data-home-form=consent] button[type=submit]`);
  await page.waitForSelector(`${HOME} [data-home-form=request]`);
  await page.fill("#homehub-site", "nha-thu-nghiem");
  await page.check(`${HOME} input[name=terms]`);
  await page.click(`${HOME} [data-home-form=request] button[type=submit]`);
  await page.waitForSelector('#demo-ribbon [data-demo=step]:not([hidden])', { timeout: 5000 });
  await page.click("#demo-ribbon [data-demo=step]");
  await page.waitForSelector(`${HOME} [data-home-op=accept-quote]`, { timeout: 12000 });
  ok(true, "Le‑NodeHome: yêu cầu gửi, điều khiển của bản trình diễn làm bước khảo sát của LeLS, báo giá hiện ra");
  await page.click(`${HOME} [data-home-op=accept-quote]`);
  await page.waitForFunction(() => document.querySelector("#demo-ribbon [data-demo=step]")?.textContent.includes("lắp"), null, { timeout: 5000 });
  await page.click("#demo-ribbon [data-demo=step]");
  const serial = /LNH-HUB-[0-9A-F]{4}/.exec(await text(page, "#demo-ribbon"))?.[0];
  ok(!!serial, "bước lắp hub của LeLS cho biết serial mô phỏng để chủ hộ xác nhận");
  await page.waitForSelector("#homehub-serial", { timeout: 12000 });
  await page.fill("#homehub-serial", serial);
  await page.click(`${HOME} [data-home-form=confirm] button[type=submit]`);
  await page.waitForSelector(`${HOME} .homehub-sim`, { timeout: 12000 });
  await page.selectOption("#homehub-sim-type", "PERSON_IN_ZONE");
  await page.click(`${HOME} .homehub-sim button[type=submit]`);
  await page.waitForSelector(`${HOME} .homehub-event`, { timeout: 12000 });
  ok((await text(page, HOME)).includes("mô phỏng"), "hub giả lập gửi sự kiện có chữ ký; sự kiện hiện, ghi rõ mô phỏng");

  await page.waitForSelector(`${MEAS} [data-meas-consent]`);
  await page.check(`${MEAS} [data-meas-consent] input[type=checkbox]`);
  await page.click(`${MEAS} [data-meas-consent] button[type=submit]`);
  await page.waitForSelector(`${MEAS} [data-meas-simbox]`);
  await page.click(`${MEAS} [data-meas-simbox] summary`);
  const simForm = `${MEAS} [data-meas-sim]`;
  await page.selectOption(`${simForm} select[name=channel]`, "BOTH");
  await page.click(`${simForm} button[type=submit]`);
  await page.waitForSelector(`${MEAS} [data-meas-map=confirm]`, { timeout: 10000 });
  await page.click(`${MEAS} [data-meas-map=confirm]`);
  await page.waitForSelector(`${MEAS} [data-meas=log] .meas-row`, { timeout: 10000 });
  ok(true, "Le‑NodeHealth: máy đo giả lập, xác nhận ánh xạ, phép đo tổng hợp hiện trong nhật ký");

  await page.waitForSelector(`${SIM} [data-sim-form]`);
  await page.selectOption(`${SIM} select[name=skill_ref]`, "skl_navigate_room");
  await page.click(`${SIM} [data-sim-form] button[type=submit]`);
  await page.waitForSelector(`${SIM} .sim-run`, { timeout: 10000 });
  ok((await text(page, SIM)).includes("SIMULATED") || (await text(page, SIM)).includes("mô phỏng"), "Le‑ORION: lượt mô phỏng xếp hàng, nhãn mô phỏng");
  await shot(page, "05-dich-vu", true);

  // ---------------------------------------------------------------- 8. nhắn tin với người nhận mô phỏng «Thử nghiệm B»
  await go(page, "messages");
  await page.waitForSelector("form[data-msg-form=consent]");
  await page.check("form[data-msg-form=consent] input[name=agree]");
  await page.click("form[data-msg-form=consent] button[type=submit]");
  await page.waitForSelector("form[data-msg-form=device]");
  await page.check("form[data-msg-form=device] input[value=LAPTOP]");
  await page.click("form[data-msg-form=device] button[type=submit]");
  await page.waitForSelector("[data-msg-invite=dev_b]", { timeout: 15000 });
  await page.click("[data-msg-invite=dev_b]");
  await page.waitForSelector(".msg-composer:not([hidden])", { timeout: 20000 });
  ok(true, "nhắn tin: mời Thử nghiệm B, thiết bị mô phỏng của B nhận lời mời");
  await page.fill("#msg-input", "Chào B, đây là tin thử");
  await page.press("#msg-input", "Enter");
  await page.waitForSelector(".msg-bubble.theirs .msg-text", { timeout: 25000 });
  ok((await text(page, ".msg-bubble.theirs .msg-text")).includes("trả lời tự động của Thử nghiệm B"), "B trả lời một câu soạn sẵn, mã hóa LNH-MSG-1 và giải mã trên thiết bị này");
  await shot(page, "08-nhan-tin");

  // ---------------------------------------------------------------- 9. ngôn ngữ, phong cách, cỡ màn hình
  const chooseLanguage = async (p, value) => {
    await p.click("#settings-button");
    await p.selectOption("#locale", value);
    await p.click("#settings-form button[type=submit]");
    await p.waitForSelector("#settings-dialog:not([open])", { state: "attached" });
  };
  await go(page, "home");
  await chooseLanguage(page, "en");
  await page.waitForFunction(() => document.documentElement.lang.startsWith("en"));
  await page.waitForFunction(() => document.getElementById("demo-ribbon").textContent.includes("In-browser demo"));
  ok((await text(page, "#demo-ribbon")).includes("every result is simulated") && (await text(page, "#demo-ribbon")).includes("Reset demo"), "tiếng Anh: dải chuyển sang tiếng Anh");
  await chooseLanguage(page, "ja");
  await page.waitForFunction(() => document.documentElement.lang.startsWith("ja"));
  ok((await text(page, "#demo-ribbon")).includes("In-browser demo") && (await page.$$("main")).length === 1, "tiếng Nhật: giao diện đổi, dải dùng tiếng Anh");
  await shot(page, "06-tieng-nhat");
  await chooseLanguage(page, "vi");
  await page.waitForFunction(() => document.getElementById("demo-ribbon").textContent.includes("Bản trình diễn chạy"));
  for (const theme of THEMES) {
    await chooseSettings(page, { theme });
    const look = await page.evaluate(() => {
      const r = getComputedStyle(document.getElementById("demo-ribbon"));
      return { bg: r.backgroundColor, fg: r.color };
    });
    ok(look.bg !== look.fg && look.bg !== "rgba(0, 0, 0, 0)" && (await ribbonOk(page)) === "", `phong cách ${theme}: dải theo màu của phong cách, không đè gì`);
    await shot(page, `07-${theme}`);
  }
  ok((await overflowX(page)) <= 0, "máy tính 1440×900: không cuộn ngang");

  const ctxPhone = await newContext(PHONE, { hasTouch: true, isMobile: true });
  const phone = await openPage(ctxPhone);
  await dismissNotice(phone);
  ok((await ribbonOk(phone)) === "", "điện thoại 390×844: dải không đè đầu trang, nội dung hay thanh dưới");
  for (const tab of ["home", "work", "house"]) {
    await phone.click(`#mobile-nav button[data-nav=${tab}]`);
    await phone.waitForTimeout(200);
    ok((await overflowX(phone)) <= 0, `điện thoại, ${tab}: không cuộn ngang`);
  }
  const nav = await phone.evaluate(() => {
    const r = document.getElementById("demo-ribbon").getBoundingClientRect();
    const n = document.getElementById("mobile-nav").getBoundingClientRect();
    return { ribbonBottom: r.bottom, navTop: n.top, h: innerHeight };
  });
  ok(nav.ribbonBottom < nav.navTop && nav.ribbonBottom < nav.h * 0.25, "điện thoại: dải ở đầu, thanh dưới không bị che");
  await shot(phone, "09-dien-thoai");
  // Đặt lại: hai lần bấm (alert/confirm không có ở nơi phát hành), dữ liệu bản trình diễn và tùy chọn trên trình duyệt bị xóa.
  await phone.click("#demo-ribbon [data-demo=reset]");
  ok((await text(phone, "#demo-ribbon")).includes("Bấm lần nữa"), "đặt lại cần bấm lần thứ hai");
  await Promise.all([phone.waitForEvent("load"), phone.click("#demo-ribbon [data-demo=reset]")]);
  await phone.waitForSelector("#consent-form", { timeout: 15000 });
  ok(true, "đặt lại: bản trình diễn về ban đầu, thông báo đầu tiên mở lại");

  // Đặt lại trên máy tính, nơi đã dùng mọi mô-đun: thông báo đầu tiên mở lại, kho tin nhắn trên trình duyệt bị xóa.
  await page.click("#demo-ribbon [data-demo=reset]");
  await Promise.all([page.waitForEvent("load"), page.click("#demo-ribbon [data-demo=reset]")]);
  await page.waitForSelector("#consent-form", { timeout: 15000 });
  // Sau khi nạp lại, ứng dụng tự ghi lại tùy chọn giao diện (lenhip.ui.v2); phần còn lại phải là trạng thái ban đầu.
  const left = await page.evaluate(() => ({ keys: Object.keys(localStorage).filter((k) => k.startsWith("lenhip.") && !["lenhip.demo.v1", "lenhip.ui.v2"].includes(k)), state: JSON.parse(localStorage.getItem("lenhip.demo.v1") ?? "{}") }));
  ok(left.keys.length === 0 && (left.state.consents ?? []).length === 0 && Object.keys(left.state.plans ?? {}).length === 0, "đặt lại trên máy tính: «máy chủ» về ban đầu, không còn phiên đồng bộ hay dữ liệu cũ trên trình duyệt" + (left.keys.length ? ": " + left.keys.join(", ") : ""));

  ok(outside.length === 0, "không yêu cầu nào rời khỏi gốc của trang" + (outside.length ? ": " + outside.join(" | ") : ""));
  const api = srv.hits.filter((h) => /^\w+ \/(v1|v2|dev)\//.test(h));
  ok(api.length === 0, "máy chủ tệp không nhận yêu cầu API nào (bản giả trả lời trong trang)" + (api.length ? ": " + api.slice(0, 5).join(" | ") : ""));
  ok(errors.length === 0, "không có lỗi JavaScript hay console.error" + (errors.length ? ": " + errors.join(" | ") : ""));
  console.log(`\n${checks} phép kiểm trình duyệt đạt (bản trình diễn)`);
} catch (e) {
  console.error(e instanceof Error ? (e.message.startsWith("✗") ? e.message : e.stack) : e);
  if (errors.length) console.error("lỗi trang: " + errors.join(" | "));
  console.error(`\nbản trình diễn: hỏng sau ${checks} phép kiểm đạt`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  srv?.server.close();
  rmSync(dir, { recursive: true, force: true });
}
