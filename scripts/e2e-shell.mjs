// Kiểm khung giao diện V1.0.0 trên trình duyệt thật: icon và manifest, chữ LeNhip theo phong cách, sổ đăng ký màn hình (màn
// hình có trạng thái không bị dựng lại khi render nền), điều hướng năm mục, bốn cỡ màn hình × cỡ chữ 100/200 % × năm phong
// cách, thanh bên cuộn được, phím Escape trên hộp xem lại, ngôn ngữ của trang.
//   node scripts/e2e-shell.mjs [thư-mục-ảnh]        (cả bộ: npm run e2e)
// Cờ messaging/social/trackers được thêm vào phản hồi /v1/me bằng chặn route. Một phần kiểm thay web/views/messages.js bằng
// một mô-đun thử (chỉ trong trình duyệt của phép kiểm) để đo đúng hợp đồng của sổ đăng ký: số lần mount/update/unmount, nhịp
// dừng khi ẩn tab, phần chạy nền, huy hiệu, hộp thoại.
import { run, THEMES, PHONE } from "./e2e-lib.mjs";

const ALL = { messaging: true, social: true, trackers: true };
const VIEW_IDS = ["home", "health", "work", "house", "messages", "connect"];
const WORDMARK = { orbit: ["L01", "rgb(18, 57, 74)"], night: ["L02", "rgb(242, 243, 255)"], calm: ["L03", "rgb(55, 74, 49)"], flow: ["L04", "rgb(20, 69, 140)"], titanium: ["L05", "rgb(239, 244, 247)"] };
const VIEWPORTS = [
  ["điện thoại", { width: 390, height: 844 }],
  ["máy tính bảng", { width: 820, height: 1180 }],
  ["máy tính xách tay", { width: 1280, height: 800 }],
  ["máy tính để bàn", { width: 1920, height: 1080 }],
];

const go = async (page, id) => {
  await page.evaluate((v) => {
    location.hash = "#" + v;
  }, id);
  await page.waitForSelector(`body[data-view=${id}]`, { state: "attached" });
};
/** Bật đủ lựa chọn của thông báo đầu tiên trong ngữ cảnh này để các màn hình có nội dung thật (lịch, đèn, sức khỏe). */
const consentAll = async (t, page) => {
  if (!(await page.$("#action-dialog[open] #consent-form"))) {
    await go(page, "health");
    if (!(await page.$("main button[data-action=onboarding]"))) return;
    await page.click("main button[data-action=onboarding]");
  }
  await t.acceptNotice(page);
  await page.waitForFunction(() => !document.querySelector("main button[data-action=onboarding]"));
};
const contrast = (a, b) => {
  const lum = (rgb) => {
    const [r, g, bl] = rgb.match(/\d+/g).slice(0, 3).map((v) => Number(v) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Chữ LeNhip đang hiển thị (thanh bên hoặc đầu trang điện thoại): mã bản vẽ, màu chữ, nền thật phía sau, kích thước. */
const brandInfo = (page) =>
  page.evaluate(() => {
    const svg = [...document.querySelectorAll("svg.brand-wordmark")].find((s) => s.getClientRects().length > 0);
    if (!svg) return null;
    const box = svg.getBoundingClientRect();
    const letter = svg.querySelector("path");
    let behind = svg;
    let background = "rgba(0, 0, 0, 0)";
    while (behind && /rgba\(0, 0, 0, 0\)|transparent/.test(background)) {
      background = getComputedStyle(behind).backgroundColor;
      behind = behind.parentElement;
    }
    const by = svg.closest(".wordmark, .mobile-brand").querySelector(".brand-by");
    return {
      shown: document.querySelectorAll("svg.brand-wordmark").length - [...document.querySelectorAll("svg.brand-wordmark")].filter((s) => s.getClientRects().length === 0).length,
      code: svg.dataset.wordmark, label: svg.getAttribute("aria-label"), role: svg.getAttribute("role"),
      width: box.width, height: box.height, left: box.left, right: box.right, viewport: innerWidth,
      fill: getComputedStyle(letter).fill, stroke: getComputedStyle(letter).stroke, background,
      by: by.textContent, byBelow: by.getBoundingClientRect().top >= box.bottom - 1,
    };
  });

await run("khung giao diện", async (t) => {
  const { ok, shot } = t;

  // ---------------------------------------------------------------- icon, manifest, trang
  for (const [path, type] of [["/icon.svg", "image/svg+xml"], ["/icons/favicon-32.png", "image/png"], ["/icons/icon-192.png", "image/png"], ["/icons/icon-512.png", "image/png"], ["/icons/apple-touch-icon.png", "image/png"], ["/manifest.json", "application/manifest+json"], ["/views/index.js", "text/javascript; charset=utf-8"]]) {
    const r = await fetch(t.base + path);
    ok(r.status === 200 && r.headers.get("content-type") === type && r.headers.get("x-content-type-options") === "nosniff", `${path} được phục vụ với kiểu ${type}`);
  }
  const requests = [];
  // Các ngữ cảnh đo bố cục bật "giảm chuyển động": nền không chuyển màu dần 0,3 giây nên ảnh chụp và phép đo màu ổn định.
  const first = await t.open({ modules: ALL, wait: false, reducedMotion: "reduce" });
  first.page.on("request", (r) => requests.push(r.url()));
  await first.page.reload();
  await t.ready(first.page);
  const head = await first.page.evaluate(async () => {
    const links = [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map((l) => ({ rel: l.rel, href: l.href, type: l.type }));
    const fetched = [];
    for (const l of links) fetched.push({ ...l, status: (await fetch(l.href)).status });
    const manifest = await (await fetch(document.querySelector('link[rel="manifest"]').href)).json();
    const icons = [];
    for (const i of manifest.icons) icons.push((await fetch(new URL(i.src, document.querySelector('link[rel="manifest"]').href))).status);
    const html = document.documentElement;
    return { fetched, manifest, icons, lang: html.lang, dir: html.dir, translate: html.getAttribute("translate"), workers: "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0 };
  });
  ok(head.fetched.length === 5 && head.fetched.every((l) => l.status === 200) && head.fetched.some((l) => l.rel === "icon" && l.href.endsWith("/icon.svg")) && head.fetched.some((l) => l.rel === "apple-touch-icon"), "trang trỏ tới icon SVG, PNG 32/48, apple-touch-icon và manifest; tất cả tải được");
  ok(head.manifest.name === "LeNhip" && head.manifest.display === "standalone" && head.manifest.theme_color === "#12394A" && head.icons.length === 4 && head.icons.every((s) => s === 200) && head.workers === 0, "manifest cài được (standalone, icon 192 và 512 any + maskable); chưa có service worker");
  ok(head.lang === "vi" && head.dir === "ltr" && head.translate === "no", 'trình duyệt tiếng Việt: <html lang="vi" dir="ltr" translate="no">');
  ok(requests.length > 10 && requests.every((u) => u.startsWith(t.base + "/")), "trang không gọi ra ngoài: mọi yêu cầu đều về chính máy chủ LeNhip");
  await consentAll(t, first.page);

  // ---------------------------------------------------------------- chữ LeNhip theo phong cách (LNH-T20, LNH-F25)
  const desk = first.page;
  for (const theme of THEMES) {
    await t.chooseSettings(desk, { theme, fontSize: 100 });
    const b = await brandInfo(desk);
    const [code, ink] = WORDMARK[theme];
    const themeColor = await desk.evaluate(() => [document.querySelector('meta[name="theme-color"]').content.toLowerCase(), getComputedStyle(document.body).getPropertyValue("--bg").trim().toLowerCase()]);
    ok(b && b.shown === 1 && b.code === code && b.label === "LeNhip" && b.role === "img" && b.fill === ink && b.stroke === "none" && b.height >= 34 && b.width > 100 && b.width < 190 && b.by === "by LeTRON" && b.byBelow && contrast(b.fill, b.background) >= 3 && themeColor[0] === themeColor[1],
      `phong cách ${theme}: chữ LeNhip ${code} đúng màu gốc, tương phản ${b ? contrast(b.fill, b.background).toFixed(1) : "?"}:1 trên thanh bên, có dòng by LeTRON`);
    await shot(desk, `brand-${theme}`);
  }
  // Bàn phím: bấm Enter trên nút phong cách thì focus vẫn ở nút đó sau khi trang vẽ lại.
  await t.chooseSettings(desk, { theme: "orbit" });
  await desk.focus("button[data-theme-choice=calm]");
  await desk.keyboard.press("Enter");
  await desk.waitForSelector("body[data-theme=calm]", { state: "attached" });
  ok(await desk.evaluate(() => document.activeElement?.dataset?.themeChoice === "calm"), "đổi phong cách bằng bàn phím: focus ở lại nút vừa bấm");

  // ---------------------------------------------------------------- điều hướng từ sổ đăng ký (LNH-T51)
  await t.chooseSettings(desk, { theme: "orbit" });
  const navIds = (page, nav) => page.$$eval(`#${nav} .nav-button`, (els) => els.map((e) => e.dataset.nav));
  ok((await navIds(desk, "desktop-nav")).join() === VIEW_IDS.join(), "thanh bên: Hôm nay, Sức khỏe, Công việc, Ngôi nhà, Tin nhắn, Kết nối");
  ok((await navIds(desk, "mobile-nav")).join() === "home,health,work,house,messages", "thanh dưới của điện thoại: đúng năm mục, không có Kết nối");
  await desk.click("#desktop-nav button[data-nav=connect]");
  const connect = await desk.evaluate(() => ({
    sections: [...document.querySelectorAll(".connect-grid > section")].map((s) => s.dataset.section + ":" + s.querySelector("h2").textContent),
    panelHidden: getComputedStyle(document.querySelector(".design-panel")).display === "none",
    layout: document.body.dataset.layout, current: document.querySelector("#desktop-nav [aria-current=page]")?.dataset.nav, hash: location.hash, focus: document.activeElement?.id,
  }));
  ok(connect.sections.join("|") === "social:Mạng xã hội|endpoints:Thiết bị của tôi|trackers:Thiết bị theo dõi" && connect.current === "connect" && connect.hash === "#connect" && connect.focus === "main", "Kết nối: ba phần theo thứ tự Mạng xã hội, Thiết bị của tôi, Thiết bị theo dõi");
  ok(connect.layout === "wide" && connect.panelHidden, "màn hình khai báo wide dùng hết bề ngang, ẩn cột chọn phong cách");
  // Nội dung của từng phần do tệp kiểm riêng của phần đó xét (e2e-social, e2e-messages, e2e-trackers).
  await shot(desk, "connect-desktop");

  const none = await t.open({ modules: { messaging: false, social: false, trackers: false } });
  await t.dismissNotice(none.page);
  await go(none.page, "home");
  await none.page.evaluate(() => {
    location.hash = "#messages";
  });
  await none.page.waitForTimeout(200);
  ok((await navIds(none.page, "desktop-nav")).join() === "home,health,work,house" && (await none.page.getAttribute("body", "data-view")) === "home" && (await none.page.evaluate(() => location.hash)) === "#home", "cờ mô-đun chưa đặt: không có Tin nhắn và Kết nối, địa chỉ #messages quay về Hôm nay");
  await none.page.click("#profile-button");
  ok((await none.page.$(".account-nav")) === null, "cờ mô-đun chưa đặt: hộp Tài khoản không có dòng Kết nối");
  await none.context.close();

  const only = await t.open({ modules: { trackers: true }, path: "/#connect" });
  await t.dismissNotice(only.page);
  ok((await navIds(only.page, "desktop-nav")).join() === "home,health,work,house,connect" && (await only.page.$$eval(".connect-grid > section", (els) => els.map((e) => e.dataset.section))).join() === "trackers" && (await only.page.getAttribute("body", "data-view")) === "connect", "chỉ bật trackers: có Kết nối với một phần Thiết bị theo dõi, không có Tin nhắn; mở thẳng được bằng #connect");
  await only.context.close();

  // ---------------------------------------------------------------- màn hình có trạng thái: không dựng lại khi render nền
  await desk.click("#desktop-nav button[data-nav=messages]");
  ok((await desk.textContent("main")).includes("Phần nhắn tin chưa có trong bản dựng này") && (await desk.$("main button, main form")) === null, "Tin nhắn (giữ chỗ): nói rõ chưa có phần nhắn tin, không có nút gửi");
  await desk.click("#shell-draft");
  await desk.keyboard.type("nháp đang gõ dở");
  await desk.evaluate(() => {
    const box = document.getElementById("shell-draft");
    box.setSelectionRange(4, 9);
    box.dataset.probe = "nút-ban-đầu";
    window.__sameBox = box;
  });
  const draft = () => desk.evaluate(() => {
    const box = document.getElementById("shell-draft");
    return { same: box === window.__sameBox, value: box?.value, focused: document.activeElement === box, selection: [box?.selectionStart, box?.selectionEnd].join("-") };
  });
  const kept = (d) => d.same && d.value === "nháp đang gõ dở" && d.focused && d.selection === "4-9";
  await first.context.setOffline(true);
  await desk.waitForSelector("#banner:not([hidden])");
  const whileOffline = await draft();
  await first.context.setOffline(false);
  await desk.waitForSelector("#banner", { state: "hidden" });
  await desk.waitForTimeout(300);
  const afterOnline = await draft();
  ok(kept(whileOffline) && kept(afterOnline), "ô đang soạn trong màn hình có trạng thái: chữ, con trỏ và focus còn nguyên qua hai lần render nền (mất mạng, có mạng lại và nạp lại /v1/me)");
  await desk.click("#settings-button");
  await desk.check("#settings-form input[name=compact]");
  await desk.click("#settings-form button[type=submit]");
  await desk.waitForSelector("body.compact", { state: "attached" });
  const afterSettings = await draft();
  ok(afterSettings.same && afterSettings.value === "nháp đang gõ dở", "lưu Cá nhân hóa (render lại cả trang): ô đang soạn không bị dựng lại, chữ còn nguyên");
  await shot(desk, "messages-desktop");
  await desk.click("#desktop-nav button[data-nav=home]");
  await desk.click("#desktop-nav button[data-nav=messages]");
  ok((await desk.inputValue("#shell-draft")) === "", "rời màn hình rồi quay lại: màn hình được mount mới");

  // ---------------------------------------------------------------- hợp đồng của sổ đăng ký, đo bằng một mô-đun thử
  const probe = await t.open({ modules: ALL, wait: false });
  await probe.context.route("**/views/messages.js", (route) => route.fulfill({ contentType: "text/javascript; charset=utf-8", body: `
    const log = (globalThis.__probe = { mount: 0, update: 0, unmount: 0, left: 0, ticks: 0, aborted: 0, bg: 0, bgLeft: 0, bgTicks: 0, badge: 0, closed: 0, ctx: null });
    export default {
      id: "messages", order: 50,
      nav: { label: (ctx) => ctx.t("nav.messages"), icon: "messages", bar: true, badge: () => (log.badge ? { text: String(log.badge), label: "Có tin mới" } : null) },
      visible: (ctx) => ctx.modules.messaging === true,
      background(ctx) { log.bg++; ctx.every(250, () => { log.bgTicks++; }); ctx.onLeave(() => { log.bgLeft++; }); },
      mount(ctx, host) {
        log.mount++; log.ctx = ctx;
        host.innerHTML = '<textarea id="probe-box"></textarea>';
        ctx.every(250, async () => { log.ticks++; });
        ctx.onLeave(() => { log.left++; });
        ctx.signal.addEventListener("abort", () => { log.aborted++; });
      },
      update() { log.update++; },
      unmount() { log.unmount++; },
    };` }));
  // Hai phần thử của màn hình Kết nối: một phần có update (tự giữ DOM, có ô nhập, khai báo một loại kế hoạch), một phần không
  // có update (được vẽ lại khi HTML đổi).
  await probe.context.route("**/views/connect-social.js", (route) => route.fulfill({ contentType: "text/javascript; charset=utf-8", body: `
    const log = (globalThis.__social = { render: 0, bind: 0, update: 0 });
    export default {
      id: "social", order: 10,
      visible: (ctx) => ctx.modules.social === true,
      plans: { "robot.simulate": { title: () => "Kế hoạch <thử> của mô-đun", summary: (ctx, preview) => '<h3 id="probe-plan">' + ctx.safe(preview.kind) + "</h3>" } },
      render() { log.render++; return '<h2>Phần có update</h2><input id="probe-note" maxlength="280"><button type="button" id="probe-propose">Đề xuất</button>'; },
      bind(ctx, el) {
        log.bind++;
        el.querySelector("#probe-propose").addEventListener("click", () => ctx.propose({ kind: "robot.simulate", schema_version: 1, workspace_ref: ctx.api.ws, args: { scenario: "DELIVER_DOCUMENT" } }, "Nhãn của mô-đun"), { signal: ctx.signal });
      },
      update() { log.update++; },
    };` }));
  await probe.context.route("**/views/connect-trackers.js", (route) => route.fulfill({ contentType: "text/javascript; charset=utf-8", body: `
    const log = (globalThis.__track = { render: 0, bind: 0, left: 0, n: 0 });
    export default {
      id: "trackers", order: 30,
      visible: (ctx) => ctx.modules.trackers === true,
      render() { log.render++; return '<h2 id="probe-count">Đếm ' + log.n + '</h2><button type="button" id="probe-inc">+</button>'; },
      bind(ctx, el) {
        log.bind++;
        ctx.onLeave(() => { log.left++; });
        el.querySelector("#probe-inc").addEventListener("click", () => { log.n++; ctx.rerender(); });
      },
    };` }));
  await probe.page.reload();
  await t.ready(probe.page);
  await t.dismissNotice(probe.page);
  const p = probe.page;
  const read = () => p.evaluate(() => ({ ...globalThis.__probe, ctx: undefined }));
  const hide = (hidden) => p.evaluate((h) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  let s = await read();
  ok(s.bg === 1 && s.mount === 0, "phần chạy nền của mô-đun bật một lần sau khi có /v1/me, kể cả khi chưa mở màn hình của nó");
  await p.click("#desktop-nav button[data-nav=messages]");
  await p.waitForTimeout(700);
  s = await read();
  ok(s.mount === 1 && s.unmount === 0 && s.ticks >= 1 && s.bgTicks >= 1, "vào màn hình: mount đúng một lần, nhịp ctx.every chạy");
  const keys = await p.evaluate(() => {
    const c = globalThis.__probe.ctx;
    const fns = ["t", "tSafe", "locale", "formatNumber", "formatDate", "formatWeekday", "formatTime24", "formatDuration", "formatList", "safe", "icon", "toast", "zone", "now", "openDialog", "closeDialog", "rerender", "refresh", "navigate", "propose", "actionCard", "onLeave", "every", "fork"];
    return {
      missing: fns.filter((k) => typeof c[k] !== "function"), api: typeof c.api?.get === "function" && typeof c.api?.post === "function", user: c.me?.user.id, messaging: c.modules.messaging, frozen: Object.isFrozen(c.modules) && Object.isFrozen(c.state),
      view: c.state.view, noHealth: !("health" in c.state) && !("health" in c), signal: c.signal instanceof AbortSignal, safe: c.safe('<a href="x">&'), text: c.t("nav.connect"), time: c.formatTime24("2026-11-11T07:05:00Z", "Asia/Ho_Chi_Minh"), duration: c.formatDuration(450), icon: c.icon("messages").startsWith("<svg"),
    };
  });
  ok(keys.missing.length === 0 && keys.api && keys.user === "dev_a" && keys.messaging === true && keys.frozen && keys.view === "messages" && keys.noHealth && keys.signal && keys.safe === "&lt;a href=&quot;x&quot;&gt;&amp;" && keys.text === "Kết nối" && keys.time === "14:05" && /7 giờ 30 phút/.test(keys.duration.replace(/\s/g, " ")) && keys.icon,
    "ctx có đủ trường của hợp đồng (api, t và các hàm định dạng, safe, toast, hộp thoại, rerender, navigate, every/onLeave…), không có dữ liệu sức khỏe" + (keys.missing.length ? ": thiếu " + keys.missing.join(", ") : ""));
  await probe.context.setOffline(true);
  await p.waitForSelector("#banner:not([hidden])");
  await probe.context.setOffline(false);
  await p.waitForSelector("#banner", { state: "hidden" });
  s = await read();
  ok(s.mount === 1 && s.update >= 2 && s.unmount === 0, `render nền gọi update (${s.update} lần), không mount lại`);
  await hide(true);
  const hiddenAt = await read();
  await p.waitForTimeout(800);
  const stillHidden = await read();
  await hide(false);
  await p.waitForTimeout(100);
  const shownAgain = await read();
  ok(stillHidden.ticks === hiddenAt.ticks && stillHidden.bgTicks === hiddenAt.bgTicks && shownAgain.ticks > stillHidden.ticks && shownAgain.bgTicks > stillHidden.bgTicks, "ẩn tab: mọi nhịp dừng; hiện lại: chạy tiếp và gọi ngay một lần");
  await p.evaluate(() => {
    globalThis.__probe.badge = 3;
    globalThis.__probe.ctx.rerender();
  });
  const badges = await p.$$eval("[data-nav=messages] .nav-badge", (els) => els.map((e) => e.textContent + "/" + e.getAttribute("aria-label")));
  ok(badges.length === 2 && badges.every((b) => b === "3/Có tin mới"), "huy hiệu của mục điều hướng lấy từ nav.badge ở cả thanh bên và thanh dưới");
  await p.evaluate(() => {
    const c = globalThis.__probe.ctx;
    c.openDialog("Tiêu đề <b>&", '<p id="probe-p">nội dung</p>', { onClose: () => globalThis.__probe.closed++ });
  });
  const dialog = await p.evaluate(() => ({ open: document.getElementById("action-dialog").open, title: document.getElementById("action-title").textContent, bold: document.querySelector("#action-title b") !== null, body: document.getElementById("probe-p")?.textContent }));
  await p.keyboard.press("Escape");
  await p.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  await p.waitForTimeout(100);
  s = await read();
  ok(dialog.open && dialog.title === "Tiêu đề <b>&" && !dialog.bold && dialog.body === "nội dung" && s.closed === 1, "ctx.openDialog: tiêu đề là văn bản thuần (đã thoát ký tự), onClose gọi đúng một lần khi đóng bằng Escape");
  const navigated = await p.evaluate(() => globalThis.__probe.ctx.navigate("connect"));
  await p.waitForSelector("body[data-view=connect]", { state: "attached" });
  s = await read();
  const ticksAtLeave = s.ticks;
  await p.waitForTimeout(700);
  const later = await read();
  ok(navigated === true && s.unmount === 1 && s.left === 1 && s.aborted === 1 && later.ticks === ticksAtLeave && later.bgTicks > s.bgTicks && later.bgLeft === 0, "rời màn hình: unmount, onLeave và signal chạy một lần, nhịp của màn hình dừng hẳn; phần chạy nền vẫn chạy");
  // Đang ở màn hình Kết nối với hai phần thử.
  const sections = () => p.evaluate(() => ({ social: { ...globalThis.__social }, track: { ...globalThis.__track }, note: document.getElementById("probe-note")?.value, sameNote: document.getElementById("probe-note") === window.__note, count: document.getElementById("probe-count")?.textContent }));
  await p.fill("#probe-note", "ghi chú đang gõ");
  await p.evaluate(() => (window.__note = document.getElementById("probe-note")));
  const sec0 = await sections();
  await probe.context.setOffline(true);
  await p.waitForSelector("#banner:not([hidden])");
  await probe.context.setOffline(false);
  await p.waitForSelector("#banner", { state: "hidden" });
  const sec1 = await sections();
  ok(sec0.social.render === 1 && sec0.social.bind === 1 && sec1.social.render === 1 && sec1.social.bind === 1 && sec1.social.update >= 2 && sec1.note === "ghi chú đang gõ" && sec1.sameNote,
    "phần của Kết nối có update: render và bind một lần, render nền chỉ gọi update, ô nhập còn nguyên");
  ok(sec0.track.bind === 1 && sec1.track.render > sec0.track.render && sec1.track.bind === 1 && sec1.track.left === 0, "phần không có update: được hỏi lại HTML mỗi lần render nền, HTML không đổi thì DOM và bind giữ nguyên");
  await p.click("#probe-inc");
  const sec2 = await sections();
  ok(sec2.count === "Đếm 1" && sec2.track.bind === 2 && sec2.track.left === 1 && sec2.sameNote && sec2.note === "ghi chú đang gõ", "phần không có update đổi HTML: vẽ lại và bind lại, phạm vi cũ được dọn (onLeave), phần bên cạnh không bị đụng tới");
  await p.click("#probe-propose");
  await p.waitForSelector("#countdown");
  const review = await p.evaluate(() => ({ plan: document.getElementById("probe-plan")?.textContent, label: document.querySelector("#action-body .tiny-pill")?.textContent, confirm: !!document.querySelector("#action-body [data-action=approve-plan]:not([disabled])"), countdown: document.getElementById("countdown").textContent }));
  await p.click("button[data-action=cancel-plan]");
  await p.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  ok(review.plan === "robot.simulate" && review.label === "Nhãn của mô-đun" && review.confirm && /Còn \d+ giây/.test(review.countdown), "ctx.propose: kế hoạch của mô-đun đi qua cùng bước xem lại và đồng ý 120 giây; phần tóm tắt do mô-đun vẽ qua plans");
  await p.click("#desktop-nav button[data-nav=home]");
  const sec3 = await sections();
  ok(sec3.track.left === 2 && sec3.count === undefined, "rời màn hình Kết nối: phạm vi của từng phần được dọn");
  await p.click("#desktop-nav button[data-nav=messages]");
  await t.signIn(p, "dev_b");
  await p.waitForFunction(() => globalThis.__probe.bg === 2);
  s = await read();
  ok(s.mount === 3 && s.unmount === 2 && s.bg === 2 && s.bgLeft === 1 && (await p.evaluate(() => globalThis.__probe.ctx.me.user.id)) === "dev_b", "đổi tài khoản: màn hình có trạng thái được mount lại và phần chạy nền khởi động lại cho người mới");
  await probe.context.close();

  // ---------------------------------------------------------------- điện thoại: Kết nối trong hộp Tài khoản
  const phone = await t.open({ viewport: PHONE, modules: ALL, reducedMotion: "reduce" });
  await consentAll(t, phone.page);
  await go(phone.page, "home");
  const bar = await phone.page.evaluate(() => ({ side: getComputedStyle(document.querySelector(".sidebar")).display, bar: getComputedStyle(document.getElementById("mobile-nav")).display, ids: [...document.querySelectorAll("#mobile-nav .nav-button")].map((b) => b.dataset.nav).join() }));
  await phone.page.click("#profile-button");
  const row = await phone.page.$eval(".account-nav-row[data-nav=connect]", (b) => ({ text: b.textContent, height: b.getBoundingClientRect().height }));
  await phone.page.click(".account-nav-row[data-nav=connect]");
  await phone.page.waitForSelector("body[data-view=connect]", { state: "attached" });
  const landed = await phone.page.evaluate(() => ({ open: document.getElementById("action-dialog").open, focus: document.activeElement?.id, sections: document.querySelectorAll(".connect-grid > section").length }));
  ok(bar.side === "none" && bar.bar === "flex" && bar.ids === "home,health,work,house,messages" && row.text.includes("Kết nối") && row.text.includes("Mạng xã hội, thiết bị của tôi, thiết bị theo dõi") && row.height >= 44 && !landed.open && landed.focus === "main" && landed.sections === 3,
    "điện thoại: thanh dưới năm mục; Kết nối là một dòng trong hộp Tài khoản, bấm thì đóng hộp và mở màn hình");
  await shot(phone.page, "connect-phone", true);

  // ---------------------------------------------------------------- bốn cỡ màn hình × cỡ chữ × phong cách (LNH-T51)
  for (const [name, viewport] of VIEWPORTS) {
    const { context, page } = viewport.width === PHONE.width ? phone : await t.open({ viewport, modules: ALL, reducedMotion: "reduce" });
    if (viewport.width !== PHONE.width) await consentAll(t, page);
    for (const scale of [100, 200]) {
      for (const theme of THEMES) {
        await t.chooseSettings(page, { theme, fontSize: scale });
        const problems = [];
        for (const id of VIEW_IDS) {
          await go(page, id);
          const over = await t.overflowX(page);
          if (over > 0) problems.push(`${id} tràn ngang ${over} px`);
          for (const spill of await t.navSpill(page)) problems.push(`${id}: ${spill}`);
          if (theme === "orbit" || id === "home") await shot(page, `${viewport.width}x${viewport.height}-${scale}-${theme}-${id}`, true);
        }
        const b = await brandInfo(page);
        if (!b || b.shown !== 1 || b.code !== WORDMARK[theme][0] || b.left < 0 || b.right > b.viewport || b.height < 28 || b.stroke !== "none" || contrast(b.fill, b.background) < 3) problems.push("chữ LeNhip không hiển thị trọn hoặc khó đọc: " + JSON.stringify(b));
        const layout = await page.evaluate(() => ({ side: getComputedStyle(document.querySelector(".sidebar")).display !== "none", bar: getComputedStyle(document.getElementById("mobile-nav")).display !== "none", panel: getComputedStyle(document.querySelector(".design-panel")).display !== "none" }));
        const wantPhone = viewport.width <= 700 || scale >= 150;
        if (layout.side === wantPhone || layout.bar !== wantPhone) problems.push("sai bố cục điều hướng: " + JSON.stringify(layout));
        ok(problems.length === 0, `${name} ${viewport.width}×${viewport.height} · chữ ${scale} % · ${theme}: sáu màn hình không cuộn ngang, nhãn điều hướng nằm trong nút` + (problems.length ? " — " + problems.join("; ") : ""));
      }
    }
    // Nhãn dài của các ngôn ngữ khác (chưa có bản dịch ở nhánh này): thay chữ của nhãn rồi đo lại.
    for (const scale of [100, 200]) {
      await t.chooseSettings(page, { theme: "orbit", fontSize: scale });
      const words = ["Aujourd’hui", "Gesundheit", "Nachrichten", "Dispositivos", "Сообщения", "Verbindungen"];
      await page.evaluate((list) => {
        document.querySelectorAll("#desktop-nav, #mobile-nav").forEach((nav) => nav.querySelectorAll(".nav-label").forEach((label, i) => (label.textContent = list[i % list.length])));
      }, words);
      const spills = await t.navSpill(page);
      const over = await t.overflowX(page);
      ok(spills.length === 0 && over === 0, `${name} · chữ ${scale} %: nhãn dài (Aujourd’hui, Nachrichten, Dispositivos…) xuống dòng trong nút, không tràn` + (spills.length ? " — " + spills.join("; ") : ""));
      await shot(page, `${viewport.width}x${viewport.height}-${scale}-nhan-dai`);
    }
    await t.chooseSettings(page, { theme: "orbit", fontSize: 100 });
    await go(page, "home");
    const at100 = await page.evaluate(() => ({ panel: getComputedStyle(document.querySelector(".design-panel")).display !== "none", main: Math.round(document.getElementById("main").getBoundingClientRect().width), side: Math.round(document.querySelector(".sidebar").getBoundingClientRect().width) }));
    const expected = { 390: [false, 0, 346, 346], 820: [false, 190, 550, 720], 1280: [true, 236, 600, 740], 1920: [true, 236, 860, 860] }[viewport.width];
    ok(at100.panel === expected[0] && at100.side === expected[1] && at100.main >= expected[2] && at100.main <= expected[3],
      `${name}: thanh bên ${at100.side} px, nội dung ${at100.main} px, cột chọn phong cách ${at100.panel ? "hiện" : "ẩn"}`);
    if (viewport.width !== PHONE.width) await context.close();
  }
  await phone.context.close();

  // ---------------------------------------------------------------- màn hình thấp: thanh bên cuộn được
  const short = await t.open({ viewport: { width: 1024, height: 600 }, modules: ALL });
  await t.dismissNotice(short.page);
  const side = await short.page.evaluate(() => {
    const el = document.querySelector(".sidebar");
    const foot = el.querySelector(".sidebar-bottom [data-action=settings]");
    const before = foot.getBoundingClientRect();
    el.scrollTop = el.scrollHeight;
    const after = foot.getBoundingClientRect();
    const build = document.getElementById("build-label").getBoundingClientRect();
    return { overflow: getComputedStyle(el).overflowY, scrollable: el.scrollHeight > el.clientHeight, before: before.bottom, after: after.bottom, buildBottom: build.bottom, height: innerHeight, items: el.querySelectorAll(".nav-button").length };
  });
  await short.page.evaluate(() => (document.querySelector(".sidebar").scrollTop = 0));
  await short.page.click(".sidebar-bottom [data-action=settings]");
  ok(side.overflow === "auto" && side.items === 6 && side.after <= side.height && side.buildBottom <= side.height + 1 && (await short.page.evaluate(() => document.getElementById("settings-dialog").open)),
    `1024×600: thanh bên cuộn được, nút Cá nhân hóa ở chân thanh bên bấm được (trước khi cuộn đáy nút ở ${Math.round(side.before)} px, khung cao ${side.height} px)`);
  await short.page.click("[data-action=close-settings]");
  await shot(short.page, "sidebar-1024x600");
  await short.context.close();
  const landscape = await t.open({ viewport: { width: 844, height: 390 }, modules: ALL });
  await t.dismissNotice(landscape.page);
  const low = await landscape.page.evaluate(() => {
    const el = document.querySelector(".sidebar");
    const last = el.querySelector(".nav-button:last-child").getBoundingClientRect();
    return { extra: el.scrollHeight - el.clientHeight, lastTop: last.top, height: innerHeight };
  });
  await landscape.page.click("#desktop-nav button[data-nav=connect]");
  const reached = (await landscape.page.getAttribute("body", "data-view")) === "connect";
  await landscape.page.click(".sidebar-bottom [data-action=settings]");
  ok(low.extra > 100 && low.lastTop > low.height && reached && (await landscape.page.evaluate(() => document.getElementById("settings-dialog").open)) && (await t.overflowX(landscape.page)) === 0,
    `điện thoại xoay ngang 844×390: thanh bên dài hơn khung ${low.extra} px, cuộn tới được mục cuối và nút ở chân thanh bên; không cuộn ngang`);
  await landscape.context.close();

  // ---------------------------------------------------------------- Escape trên hộp xem lại dừng đếm ngược
  const esc = await t.open({ wait: false });
  await esc.page.clock.install();
  await esc.page.reload();
  await t.ready(esc.page);
  await t.dismissNotice(esc.page);
  await go(esc.page, "work");
  await esc.page.click("button[data-action=new-block]");
  await esc.page.selectOption("#block-day", { index: 1 });
  await esc.page.fill("#block-start", "10:00");
  await esc.page.fill("#block-end", "10:30");
  await esc.page.click("#block-form button");
  await esc.page.waitForSelector("#countdown");
  const counting = await esc.page.textContent("#countdown");
  await esc.page.keyboard.press("Escape");
  await esc.page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  await esc.page.clock.fastForward(125_000);
  await esc.page.waitForTimeout(400);
  const afterEscape = await esc.page.evaluate(() => ({ open: document.getElementById("action-dialog").open, title: document.getElementById("action-title").textContent }));
  ok(/Còn \d+ giây/.test(counting) && !afterEscape.open && !afterEscape.title.includes("hết hạn"), "Escape trên hộp xem lại: đồng hồ đếm ngược dừng, hộp không tự mở lại sau 120 giây");
  // Đối chứng: không bấm gì thì sau 120 giây hộp báo hết hạn (đồng hồ của phép kiểm thật sự chạy tới đó).
  await esc.page.click("button[data-action=new-block]");
  await esc.page.selectOption("#block-day", { index: 1 });
  await esc.page.fill("#block-start", "11:00");
  await esc.page.fill("#block-end", "11:30");
  await esc.page.click("#block-form button");
  await esc.page.waitForSelector("#countdown");
  await esc.page.clock.fastForward(125_000);
  await esc.page.waitForFunction(() => document.getElementById("action-title").textContent.includes("hết hạn"));
  ok(await esc.page.evaluate(() => document.getElementById("action-dialog").open), "đối chứng: để nguyên hộp xem lại quá 120 giây thì báo hết hạn, không tự gia hạn");
  await esc.context.close();

  // ---------------------------------------------------------------- ngôn ngữ của trang theo trình duyệt (LNH-T28, T29)
  const en = await t.open({ modules: ALL, locale: "en-US" });
  await t.dismissNotice(en.page);
  const english = await en.page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, translate: document.documentElement.getAttribute("translate"), labels: [...document.querySelectorAll("#desktop-nav .nav-label")].map((e) => e.textContent).join("|"), brand: document.querySelector("svg.brand-wordmark").getAttribute("aria-label") }));
  ok(english.lang === "en" && english.dir === "ltr" && english.translate === "no" && english.labels.endsWith("|Messages|Connect") && english.brand === "LeNhip", 'trình duyệt tiếng Anh: <html lang="en">, nhãn của màn hình mới lấy từ catalog tiếng Anh (chuỗi cũ của 0.1.0 chưa chuyển sang catalog)');
  await en.context.close();
  const zh = await t.open({ locale: "zh-TW", collectErrors: false });
  ok((await zh.page.evaluate(() => document.documentElement.lang)) === "zh-Hant" && (await zh.page.textContent("#desktop-nav")).includes("Hôm nay"), "trình duyệt zh-TW: chọn zh-Hant (không bao giờ ra giản thể); catalog chưa có nên trang vẫn chạy bằng bản tiếng Việt");
  await zh.context.close();
});
