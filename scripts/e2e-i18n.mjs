// Kiểm phần ngôn ngữ trên trình duyệt thật (LNH-T21..LNH-T29):
//   - trình duyệt tiếng Anh: ứng dụng mở bằng tiếng Anh, <html lang="en">, tiêu đề trang, nhãn truy cập, ô chọn ngôn ngữ;
//   - dòng «bản dịch máy» có ở tiếng Anh và không có ở tiếng Việt; đọc được bản gốc tiếng Việt của văn bản đồng ý;
//   - biên nhận đồng ý mang text_version và mã băm của bản tiếng Anh (khớp contracts/consent-texts.json);
//   - đổi ngôn ngữ lúc đang chạy: không nạp lại trang, giữ màn hình và trạng thái; bị từ chối khi một kế hoạch đang chờ đồng ý;
//   - lỗi và câu trả lời của LeLe dựng từ mã, không in câu tiếng Việt của máy chủ ở giao diện tiếng Anh;
//   - LeLe đóng khi không chắc (LNH-T24): câu sức khỏe bằng tiếng Anh, Pháp, Nhật không tạo yêu cầu nào tới /v1/lele/proposals;
//   - ngôn ngữ giả: thay i18n-en*.js bằng catalog sinh từ bản tiếng Việt (chữ có dấu lạ, dài hơn 60 %) ở 390×844 và 1280×800,
//     cỡ chữ 100 % và 200 %: không cuộn ngang, nhãn điều hướng nằm trong nút, và không còn chữ nào ngoài catalog (trừ dữ liệu,
//     tên thương hiệu và chữ do Intl định dạng).
//   node scripts/e2e-i18n.mjs [thư-mục-ảnh]        (cả bộ: npm run e2e)
//
// Máy chủ của phép kiểm là máy chủ chạy thử với dữ liệu tổng hợp. Máy chủ thật đã gửi detail_code, limit, answer_code; các ca
// «máy chủ cũ chưa gửi mã», «mã lạ», «thiếu giới hạn» được GIẢ LẬP bằng chặn route của Playwright.
import { readFileSync, existsSync } from "node:fs";
import { run, PHONE } from "./e2e-lib.mjs";
import { LOCALES, PARTS } from "../web/shared/i18n.js";

/**
 * Màn hình và hộp thoại của các mô-đun tính năng (Tin nhắn, Kết nối) có bị tính là lỗi khi còn chữ ngoài catalog không.
 * Ở nhánh ngôn ngữ chúng là phần giữ chỗ nên luôn đạt; sau khi gộp các nhánh tính năng, phần này chỉ IN ra chữ nghi vấn (tên
 * nền tảng, tên hãng thiết bị là dữ liệu hợp lệ mà phép kiểm chưa biết). Đặt true khi đã rà xong danh sách đó.
 */
const STRICT_MODULE_SCREENS = false;

const ROOT = new URL("../", import.meta.url);
const ALL = { messaging: true, social: true, trackers: true };
const LAPTOP = { width: 1280, height: 800 };
const VI_TITLE = "Thời gian cá nhân";
const registry = JSON.parse(readFileSync(new URL("contracts/consent-texts.json", ROOT), "utf8"));
const pinned = (purpose, locale) => registry.find((e) => e.purpose_id === purpose && e.locale === locale);
const catalog = (name) => JSON.parse(readFileSync(new URL("web/shared/" + name, ROOT), "utf8").slice("export default ".length, -2));
const vi = catalog("i18n-vi.js");
const en = catalog("i18n-en.js");

const go = async (page, id) => {
  await page.evaluate((v) => {
    location.hash = "#" + v;
  }, id);
  await page.waitForSelector(`body[data-view=${id}]`, { state: "attached" });
};
const closeAction = async (page) => {
  if (await page.$("#action-dialog[open]")) await page.click("#action-dialog [data-action=close-action]");
  await page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
};
/** Bật đủ lựa chọn của thông báo đầu tiên trên thiết bị (ngữ cảnh) này. */
const consentAll = async (t, page) => {
  if (!(await page.$("#action-dialog[open] #consent-form"))) {
    await go(page, "health");
    if (!(await page.$("main button[data-action=onboarding]"))) return;
    await page.click("main button[data-action=onboarding]");
  }
  await t.acceptNotice(page);
  await page.waitForFunction(() => !document.querySelector("main button[data-action=onboarding]"));
};
/** Đổi ngôn ngữ qua ô đầu tiên của hộp Cá nhân hóa như người dùng. */
const chooseLanguage = async (page, value) => {
  await page.click("#settings-button");
  await page.selectOption("#locale", value);
  await page.click("#settings-form button[type=submit]");
  await page.waitForSelector("#settings-dialog:not([open])", { state: "attached" });
};
const newBlock = async (page, start, end) => {
  await go(page, "work");
  await page.click("button[data-action=new-block]");
  await page.selectOption("#block-day", { index: 1 });
  await page.fill("#block-start", start);
  await page.fill("#block-end", end);
  await page.click("#block-form button");
};

// ---------------------------------------------------------------- ngôn ngữ giả
/** Tên riêng và mã giữ nguyên trong ngôn ngữ giả (cùng danh sách với tests/i18n.test.ts), cộng tiêu đề lịch cố định. */
const KEPT = ["LeNhip", "LeLe", "LeDB", "LeTRON", "LeASO", "Le-ORION", "Microsoft 365", "HealthKit", "Health Connect", "HealthSource", "LNH-SLEEP-1", "OIDC", "Outlook", "Titanium", "X-LeNhip-Workspace", "Idempotency-Key", "application/json", VI_TITLE];
const LOWER = "åƀçðëƒĝĥïĵķļɱñöþɋŕšţüṽŵẋÿž";
const UPPER = "ÅƁÇÐËƑĜĤÏĴĶĻṀÑÖÞɊŔŠŢÜṼŴẊŸŽ";
const VOWELS = new Set([..."åëïöüÿÅËÏÖÜŸ"]);
/** Một chữ cái bất kỳ của bản gốc → chữ Latin không dấu → chữ có dấu lạ cùng vị trí trong bảng chữ cái. */
function pseudoLetter(ch) {
  const base = ch.normalize("NFD").replace(/\p{M}/gu, "").replace("đ", "d").replace("Đ", "D");
  let out = "";
  for (const c of base) {
    const i = c.toLowerCase().charCodeAt(0) - 97;
    out += i >= 0 && i < 26 ? (c === c.toLowerCase() ? [...LOWER][i] : [...UPPER][i]) : c;
  }
  return out;
}
/** Chuỗi của bản gốc → chuỗi giả: đổi mọi chữ cái, giữ tham số, tên riêng và chỗ xuống dòng, rồi kéo dài tới 1,6 lần. */
function pseudoText(text) {
  const keep = new RegExp("(\\{[A-Za-z_][A-Za-z0-9_]*\\}|" + KEPT.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")");
  const pieces = text.split(keep).map((piece, i) => (i % 2 ? { fixed: piece } : { chars: [...piece].flatMap((ch) => (/\p{L}/u.test(ch) ? [...pseudoLetter(ch)] : [ch])) }));
  const length = () => pieces.reduce((n, p) => n + (p.fixed ? [...p.fixed].length : p.chars.length), 0);
  const target = Math.ceil([...text].length * 1.6);
  // Kéo dài bằng cách lặp nguyên âm trong từ (từ dài hơn, như tiếng Đức); hết nguyên âm thì thêm chữ ở cuối.
  for (let pass = 0; pass < 3 && length() < target; pass++) {
    for (const p of pieces) {
      if (p.fixed) continue;
      for (let i = 0; i < p.chars.length && length() < target; i++) {
        if (!VOWELS.has(p.chars[i])) continue;
        p.chars.splice(i, 0, p.chars[i]);
        i += pass + 1;
      }
    }
  }
  const last = pieces.findLast((p) => !p.fixed && p.chars.some((c) => (LOWER + UPPER).includes(c)));
  while (last && length() < target) last.chars.splice(last.chars.findLastIndex((c) => (LOWER + UPPER).includes(c)) + 1, 0, "ë");
  return pieces.map((p) => p.fixed ?? p.chars.join("")).join("");
}
/** Catalog giả từ một tệp i18n-vi*.js: thông điệp số nhiều có đủ nhánh one và other của tiếng Anh. */
function pseudoCatalog(source) {
  const out = {};
  for (const [key, message] of Object.entries(source)) {
    if (key === "calendar.title.PERSONAL_TIME" || key === "brand.name") out[key] = message;
    else if (typeof message === "string") out[key] = pseudoText(message);
    else out[key] = { one: pseudoText(message.other), other: pseudoText(message.other) };
  }
  return out;
}

/**
 * Chữ đang hiển thị mà không đi qua catalog. Chạy trong trang đang dùng ngôn ngữ giả: mọi chữ cái của giao diện phải thuộc
 * bảng chữ giả, sau khi bỏ dữ liệu (tên từ máy chủ, mã, múi giờ), tên riêng, chữ do Intl định dạng và các đoạn mang lang khác.
 * Trả mảng mô tả; rỗng là đạt.
 */
function hardcoded(page, data, scope = "body") {
  return page.evaluate(([alphabet, kept, dataStrings, rootSelector]) => {
    const letters = new Set([...alphabet]);
    // Chữ do Intl định dạng theo tag "en" (thứ, tháng, đơn vị thời lượng) là dữ liệu định dạng, không phải câu của catalog.
    const intl = new Set();
    for (let d = 0; d < 14; d++) {
      const at = new Date(Date.UTC(2026, 10, 1 + d));
      for (const weekday of ["long", "short", "narrow"]) intl.add(new Intl.DateTimeFormat("en", { weekday, timeZone: "UTC" }).format(at));
    }
    for (let m = 0; m < 12; m++) for (const month of ["long", "short"]) intl.add(new Intl.DateTimeFormat("en", { month, timeZone: "UTC" }).format(new Date(Date.UTC(2026, m, 15))));
    for (const unit of ["hour", "minute"]) for (const unitDisplay of ["short", "long", "narrow"]) for (const n of [1, 2]) for (const p of new Intl.NumberFormat("en", { style: "unit", unit, unitDisplay }).formatToParts(n)) if (p.type === "unit") intl.add(p.value);
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const strip = (text) => {
      let s = text;
      for (const value of [...dataStrings, ...kept].sort((a, b) => b.length - a.length)) s = s.split(value).join(" ");
      s = s.replace(/\bLNH-[A-Z0-9-]+(?: V[\d.]+)?/g, " ").replace(/\bPA\d{2}\b/g, " ").replace(/\b(?:[A-Z][A-Za-z_]+\/[A-Za-z_/+-]+|UTC)\b/g, " ");
      for (const word of [...intl].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp("(^|[^\\p{L}])" + escape(word) + "(?![\\p{L}])", "gu"), "$1 ");
      return s;
    };
    const foreign = (text) => [...strip(text)].some((ch) => /\p{L}/u.test(ch) && !letters.has(ch));
    const root = document.querySelector(rootSelector);
    const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    // Dữ liệu và chữ cố định: tên trong <bdi>, mã trong <code>, chữ tắt của tên, múi giờ, chữ người dùng tự gõ, tên thương hiệu
    // (data-fixed), và mọi đoạn mang lang khác ngôn ngữ của trang (tên tự gọi của ngôn ngữ, đoạn tiếng Việt trích nguyên văn).
    const skipped = (el) => el.closest("bdi, code, script, style, [data-fixed], #profile-button, #zone, .chat-message.user") !== null || (el.closest("[lang]") ?? document.documentElement) !== document.documentElement;
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.nodeValue.trim() || skipped(el) || !visible(el)) continue;
      if (foreign(node.nodeValue)) out.push(`chữ «${node.nodeValue.trim().slice(0, 70)}» trong <${el.localName}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""}>`);
    }
    for (const el of root.querySelectorAll("[aria-label], [title], [placeholder], [alt]")) {
      if (skipped(el) || !visible(el)) continue;
      for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
        const value = el.getAttribute(attr);
        if (value && foreign(value)) out.push(`${attr}="${value.slice(0, 70)}" trên <${el.localName}${el.id ? "#" + el.id : ""}>`);
      }
    }
    if (rootSelector === "body") {
      if (foreign(document.title)) out.push(`tiêu đề trang «${document.title}»`);
      const description = document.querySelector('meta[name="description"]').content;
      if (foreign(description)) out.push(`mô tả trang «${description.slice(0, 70)}»`);
    }
    return out;
  }, [LOWER + UPPER, KEPT, data, scope]);
}
/** Hộp thoại đang mở có nội dung tràn ngang không (điểm ảnh). */
const dialogOverflow = (page) => page.evaluate(() => Math.max(0, ...[...document.querySelectorAll("dialog[open]")].map((d) => Math.max(d.scrollWidth - d.clientWidth, ...[...d.querySelectorAll("*")].map((el) => Math.ceil(el.getBoundingClientRect().right - d.getBoundingClientRect().right))))));

await run("ngôn ngữ", async (t) => {
  const { ok, shot } = t;

  // ---------------------------------------------------------------- trình duyệt tiếng Anh: mở bằng tiếng Anh
  const first = await t.open({ locale: "en-US", modules: ALL, wait: false });
  const sent = [];
  first.page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/v1/consents") sent.push(r.postDataJSON());
  });
  const page = first.page;
  await t.ready(page);
  await page.waitForSelector("#consent-form");
  const boot = await page.evaluate(() => ({
    lang: document.documentElement.lang, dir: document.documentElement.dir, translate: document.documentElement.getAttribute("translate"), pending: document.body.classList.contains("i18n-pending"),
    title: document.title, description: document.querySelector('meta[name="description"]').content, skip: document.querySelector(".skip-link").textContent,
    nav: [...document.querySelectorAll("#desktop-nav .nav-label")].map((e) => e.textContent).join("|"), navLabel: document.getElementById("desktop-nav").getAttribute("aria-label"),
    settings: [document.getElementById("settings-button").getAttribute("aria-label"), document.getElementById("settings-button").title, document.getElementById("profile-button").getAttribute("aria-label")].join("|"),
    caption: document.querySelector(".sidebar-caption").textContent, captionCase: getComputedStyle(document.querySelector(".sidebar-caption")).textTransform,
    footer: document.querySelector(".workspace-footer").textContent.replace(/\s+/g, " ").trim(), build: document.getElementById("build-label").textContent, count: document.getElementById("theme-count").textContent,
  }));
  ok(boot.lang === "en" && boot.dir === "ltr" && boot.translate === "no" && !boot.pending, 'trình duyệt en-US: <html lang="en" dir="ltr" translate="no">, khung hiện sau khi catalog nạp xong');
  ok(boot.title === en["meta.title"] && boot.description === en["meta.description"] && boot.skip === "Skip to main content", "tiêu đề trang, mô tả trang và liên kết bỏ qua theo ngôn ngữ");
  ok(boot.nav === "Today|Health|Work|Home|Messages|Connect" && boot.navLabel === "Main navigation" && boot.settings === "Open Personalize|Personalize|Account", "điều hướng và nhãn truy cập bằng tiếng Anh");
  ok(boot.caption === "Your space" && boot.captionCase === "uppercase" && boot.footer === "LeNhip • Designed by LeDB • Reference build 1.0.1 per LNH-SRS-002 V2.0" && boot.build === "Trial build · Synthetic data" && boot.count === "5 styles",
    "chữ nhãn giữ kiểu tự nhiên trong catalog và được CSS viết hoa; chân trang, nhãn bản dựng, số phong cách theo ngôn ngữ");

  // ---------------------------------------------------------------- thông báo đầu tiên: ô ngôn ngữ, dòng bản dịch máy, bản gốc
  const notice = await page.evaluate(() => {
    const select = document.getElementById("notice-locale");
    const original = document.querySelector(".notice-original");
    return {
      title: document.getElementById("action-title").textContent, label: document.querySelector("label[for=notice-locale]").textContent,
      options: [...select.options].map((o) => [o.value, o.lang, o.textContent].join("/")), value: select.value, before: !!(select.compareDocumentPosition(document.getElementById("consent-form")) & Node.DOCUMENT_POSITION_FOLLOWING),
      draft: document.querySelector("#action-body .draft-note")?.textContent, summary: original?.querySelector("summary").textContent, originalLang: original?.querySelector("div").lang, originalOpen: original?.open,
      originalText: original?.querySelector("div").textContent, head: document.querySelector("#action-body > p.fine-print:not(.draft-note)").textContent,
      rows: [...document.querySelectorAll("#consent-form .consent-row")].map((r) => r.querySelector("strong").textContent), quoted: document.querySelector("#consent-form .consent-row span[lang=vi] ")?.textContent ?? document.querySelector("#consent-form small span[lang=vi]")?.textContent,
      version: [...document.querySelectorAll("#consent-form > p.fine-print")].at(-1).textContent, save: document.querySelector("#consent-form button").textContent, boxes: document.querySelectorAll("#consent-form input[type=checkbox]:checked").length,
    };
  });
  ok(notice.title === "First notice" && notice.label === "Language" && notice.value === "auto" && notice.before, "thông báo đầu tiên bằng tiếng Anh, ô ngôn ngữ đứng trước các lựa chọn");
  ok(notice.options.length === 14 && notice.options[0] === "auto//Follow the browser" && notice.options.slice(1).join("|") === LOCALES.map((l) => `${l.tag}/${l.tag}/${l.name}`).join("|"),
    "ô ngôn ngữ: «theo trình duyệt» và 13 ngôn ngữ bằng tên tự gọi, mỗi lựa chọn mang lang của chính nó");
  ok(notice.draft === en["i18n.draft.notice"] && notice.summary === "Read the Vietnamese original" && notice.originalLang === "vi" && notice.originalOpen === false && notice.originalText.includes(vi["consent.notice.head"]) && notice.originalText.includes(vi["consent.calendar_link.body"]),
    "tiếng Anh là bản dịch máy chưa rà soát: thông báo nói rõ và cho đọc bản gốc tiếng Việt (lang=vi)");
  ok(notice.head === en["consent.notice.head"] && notice.rows.join("|") === "Health on the phone|Link the work calendar|Control lamps at the site|Pilot metrics" && notice.quoted === VI_TITLE && notice.boxes === 0 && notice.save === "Save choices" && notice.version === "Notice version v1-2026-11-11.en.",
    "bốn mục đích bằng tiếng Anh, mặc định để trống; tiêu đề lịch tiếng Việt trích nguyên văn mang lang=vi; phiên bản thông báo có hậu tố .en");
  await page.click(".notice-original summary");
  await shot(page, "01-thong-bao-en", true);

  // ---------------------------------------------------------------- biên nhận mang phiên bản và mã băm của bản tiếng Anh
  await t.acceptNotice(page, ["health_local", "calendar_link", "home_control"]);
  await page.waitForFunction(() => !document.getElementById("action-dialog").open);
  await page.waitForTimeout(500);
  const receipts = await page.evaluate(async () => {
    const session = JSON.parse(sessionStorage.getItem("lenhip.session"));
    const me = await (await fetch("/v1/me", { headers: { Authorization: "Bearer " + session.token, "X-LeNhip-Workspace": "ws_demo" } })).json();
    return { health: JSON.parse(localStorage.getItem("lenhip.health.v1.dev_a")).receipt, server: me.consents, toast: document.getElementById("toast").textContent };
  });
  const byPurpose = Object.fromEntries(sent.map((b) => [b.purpose_id, b]));
  ok(sent.length === 3 && ["calendar_link", "home_control", "beta_telemetry"].every((p) => byPurpose[p]?.text_version === "v1-2026-11-11.en" && byPurpose[p].text_hash === pinned(p, "en").sha256) && byPurpose.beta_telemetry.choice === "DECLINED" && byPurpose.calendar_link.choice === "GRANTED",
    "biên nhận gửi lên máy chủ mang text_version v1-2026-11-11.en và mã băm của bản tiếng Anh trong sổ ghim");
  ok(receipts.health.text_version === "v1-2026-11-11.en" && receipts.health.text_hash === pinned("health_local", "en").sha256 && receipts.health.choice === "GRANTED" && receipts.server.every((c) => c.text_version === "v1-2026-11-11.en") && receipts.server.length === 3 && receipts.toast === "Your choices are saved.",
    "biên nhận sức khỏe (chỉ lưu trên thiết bị) và biên nhận máy chủ đều ghi bản tiếng Anh");
  ok(sent.every((b) => Object.keys(b).sort().join() === "choice,purpose_id,text_hash,text_version"), "yêu cầu đồng ý không mang trường ngôn ngữ nào ngoài phiên bản văn bản (máy chủ không biết ngôn ngữ, LNH-T23)");

  // ---------------------------------------------------------------- các màn hình bằng tiếng Anh
  await go(page, "home");
  const home = await page.evaluate(() => ({ h1: document.querySelector("main h1").textContent, name: document.querySelector("main h1 bdi")?.textContent, eyebrow: document.querySelector("main .eyebrow").textContent, ask: document.querySelector(".ask-copy").textContent.trim(), mark: document.querySelector(".ask-copy svg.lele-mark")?.getAttribute("aria-label") }));
  ok(home.h1 === "Hello, Thử nghiệm A." && home.name === "Thử nghiệm A" && /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day · [A-Z][a-z]+ \d{1,2}$/.test(home.eyebrow) && home.ask === "Ask" && home.mark === "LeLe",
    "Hôm nay: lời chào tiếng Anh, tên từ dữ liệu nằm trong <bdi>, dòng ngày do Intl định dạng, chữ LeLe là hình đã chốt");
  await go(page, "health");
  const health = await page.evaluate(() => ({ text: document.getElementById("main").textContent, draft: document.querySelector("main .health-card .draft-note")?.textContent, small: [...document.querySelectorAll("main .stat-value small")].map((e) => e.textContent).join("|"), days: [...document.querySelectorAll(".bar-chart span")].map((e) => e.textContent).join(" "), aria: document.querySelector(".bar-chart").getAttribute("aria-label") }));
  ok(/Across \d days with data, the average sleep duration is \d hr( \d+ min)?\./.test(health.text) && health.text.includes("Synthetic data") && health.draft === en["health.draft"] && /steps\/day/.test(health.small) && /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ?){7}$/.test(health.days) && /^\d days? with observed sleep, \d days? with missing data$/.test(health.aria),
    "Sức khỏe: câu trung tính bằng tiếng Anh, dòng «bản dịch máy chưa được chuyên gia rà soát» ngay dưới câu, đơn vị và tên thứ theo ngôn ngữ");
  await shot(page, "02-suc-khoe-en", true);
  await go(page, "work");
  const workNote = await page.evaluate(() => ({ quoted: document.querySelector("main .privacy-note span[lang=vi]")?.textContent, text: document.querySelector("main .privacy-note").textContent, busy: document.getElementById("main").textContent.includes("Busy") }));
  ok(workNote.quoted === VI_TITLE && workNote.text.includes("The title is always “Thời gian cá nhân” (written in Vietnamese)") && workNote.busy, "Công việc: tiêu đề lịch cố định được trích bằng tiếng Việt, mang lang=vi (LNH-T26)");
  await newBlock(page, "16:00", "16:30");
  await page.waitForSelector("#countdown");
  const review = await page.evaluate(() => ({ title: document.getElementById("action-title").textContent, h3: document.querySelector("#action-body h3").textContent, written: document.querySelector("#action-body .preview-card span[lang=vi]")?.textContent, text: document.getElementById("action-body").textContent, countdown: document.getElementById("countdown").textContent }));
  ok(review.title === "Review and confirm" && review.h3 === "Personal time" && review.written === VI_TITLE && review.text.includes("Title written to the calendar") && review.text.includes("16:00 – 16:30") && review.text.includes("matches what the server locked") && /^\d+ seconds left to confirm\.$/.test(review.countdown),
    "bước xem lại bằng tiếng Anh nói rõ tiêu đề thật sẽ ghi vào lịch là câu tiếng Việt; đếm ngược theo số nhiều tiếng Anh");
  await shot(page, "03-xem-lai-en");
  await page.click("button[data-action=approve-plan]");
  await page.waitForSelector("#action-body .status-chip.ok", { timeout: 15000 });
  const verified = await page.textContent("#action-body");
  ok(verified.includes("Verified") && verified.includes("Personal time 16:00–16:30") && verified.includes("Evidence: read back from the calendar at") && verified.includes("The time block is now in the work calendar."), "kết quả theo bằng chứng: trạng thái, kết quả và hạng bằng chứng dựng từ mã bằng tiếng Anh");
  await closeAction(page);

  // ---------------------------------------------------------------- đổi ngôn ngữ lúc đang chạy: giữ màn hình và trạng thái
  await t.chooseSettings(page, { theme: "night" });
  await go(page, "house");
  await page.evaluate(() => (window.__alive = "trang chưa nạp lại"));
  await page.click("#settings-button");
  const settingsEn = await page.evaluate(() => ({ first: document.querySelector("#settings-fields > *").className, label: document.querySelector("label[for=locale]").textContent, draft: document.querySelector("#settings-fields .draft-note")?.textContent, note: document.querySelector("#settings-fields .language-field .fine-print").textContent, title: document.getElementById("settings-title").textContent, save: document.querySelector("#settings-form button[type=submit]").textContent }));
  ok(settingsEn.first.includes("language-field") && settingsEn.label === "Language" && settingsEn.draft === en["i18n.draft.notice"] && settingsEn.note === en["settings.language.note"] && settingsEn.title === "At your rhythm" && settingsEn.save === "Save preferences",
    "hộp Cá nhân hóa: ô ngôn ngữ là trường đầu tiên, có dòng «bản dịch máy» khi đang chọn tiếng Anh");
  await page.selectOption("#locale", "vi");
  const draftGone = await page.evaluate(() => ({ draft: document.querySelector("#settings-fields .draft-note"), focus: document.activeElement?.id, lang: document.documentElement.lang }));
  ok(draftGone.draft === null && draftGone.focus === "locale" && draftGone.lang === "en", "chọn Tiếng Việt trong ô: dòng «bản dịch máy» biến mất, focus ở lại ô chọn, chưa áp dụng tới khi lưu");
  await page.click("#settings-form button[type=submit]");
  await page.waitForFunction(() => document.documentElement.lang === "vi");
  const switched = await page.evaluate(() => ({
    alive: window.__alive, hash: location.hash, view: document.body.dataset.view, theme: document.body.dataset.theme, title: document.title, skip: document.querySelector(".skip-link").textContent,
    nav: [...document.querySelectorAll("#desktop-nav .nav-label")].map((e) => e.textContent).join("|"), current: document.querySelector("#desktop-nav [aria-current=page]")?.dataset.nav, toast: document.getElementById("toast").textContent,
    lamp: document.querySelector("button.switch[data-device=dev_lamp_01]") !== null, h1: document.querySelector("main h1").textContent, stored: JSON.parse(localStorage.getItem("lenhip.ui.v2")).users.dev_a.locale, draft: document.querySelectorAll(".draft-note").length,
  }));
  ok(switched.alive === "trang chưa nạp lại" && switched.hash === "#house" && switched.view === "house" && switched.current === "house" && switched.theme === "night" && switched.lamp, "đổi sang tiếng Việt: không nạp lại trang, vẫn ở màn hình Ngôi nhà, phong cách và đèn đã đồng ý còn nguyên");
  ok(switched.title === vi["meta.title"] && switched.skip === "Đến nội dung chính" && switched.nav === "Hôm nay|Sức khỏe|Công việc|Ngôi nhà|Tin nhắn|Kết nối" && switched.h1 === "Mọi thứ sẵn sàng." && switched.toast === "Đã lưu giao diện riêng cho Thử nghiệm A." && switched.stored === "vi",
    "mọi chữ đổi sang tiếng Việt ngay, kể cả tiêu đề trang và thông báo nổi; lựa chọn lưu trên thiết bị");
  await go(page, "health");
  await page.click("#settings-button");
  const viUi = await page.evaluate(() => ({ health: document.querySelectorAll("main .draft-note").length, settings: document.querySelectorAll("#settings-fields .draft-note").length, label: document.querySelector("label[for=locale]").textContent, fixed: document.querySelector("label[for=locale] span[lang=en]")?.textContent, sentence: /Trong \d ngày có dữ liệu, thời lượng ngủ trung bình là/.test(document.getElementById("main").textContent) }));
  ok(switched.draft === 0 && viUi.health === 0 && viUi.settings === 0 && viUi.sentence && viUi.label === "Ngôn ngữ · Language" && viUi.fixed === "Language", "tiếng Việt là bản gốc: không có dòng «bản dịch máy» ở Sức khỏe và Cá nhân hóa; nhãn ô ngôn ngữ kèm chữ Language cố định");
  // Mở lại thông báo từ Cá nhân hóa, đổi dấu chọn, rồi đổi ngôn ngữ ngay trên thông báo: dấu chọn được giữ.
  await page.click("#privacy-settings button[data-action=onboarding]");
  await page.waitForSelector("#consent-form");
  const noticeVi = await page.evaluate(() => ({ title: document.getElementById("action-title").textContent, draft: document.querySelectorAll("#action-body .draft-note, #action-body .notice-original").length, value: document.getElementById("notice-locale").value, checked: [...document.querySelectorAll("#consent-form input:checked")].map((i) => i.name).join(), version: [...document.querySelectorAll("#consent-form > p.fine-print")].at(-1).textContent }));
  ok(noticeVi.title === "Thông báo đầu tiên" && noticeVi.draft === 0 && noticeVi.value === "vi" && noticeVi.checked === "health_local,calendar_link,home_control" && noticeVi.version === "Phiên bản thông báo v1-2026-11-11 · lựa chọn sức khỏe lưu trên thiết bị này.",
    "thông báo tiếng Việt: không có dòng «bản dịch máy», phiên bản không có hậu tố");
  await page.uncheck("#consent-form input[name=home_control]");
  await page.check("#consent-form input[name=beta_telemetry]");
  await page.selectOption("#notice-locale", "en");
  await page.waitForFunction(() => document.documentElement.lang === "en" && document.getElementById("action-title").textContent === "First notice");
  const noticeBack = await page.evaluate(() => ({ checked: [...document.querySelectorAll("#consent-form input:checked")].map((i) => i.name).join(), focus: document.activeElement?.id, value: document.getElementById("notice-locale").value, draft: document.querySelectorAll("#action-body .draft-note").length, alive: window.__alive, view: document.body.dataset.view, nav: document.querySelector("#desktop-nav .nav-label").textContent }));
  ok(noticeBack.checked === "health_local,calendar_link,beta_telemetry" && noticeBack.focus === "notice-locale" && noticeBack.value === "en" && noticeBack.draft === 1 && noticeBack.alive === "trang chưa nạp lại" && noticeBack.view === "health" && noticeBack.nav === "Today",
    "đổi ngôn ngữ ngay trên thông báo: hộp vẽ lại bằng ngôn ngữ mới, các ô đã đánh dấu được giữ, focus ở lại ô chọn, trang phía sau cũng đổi");
  await closeAction(page);
  // Thông báo mở từ hộp Cá nhân hóa nằm chồng lên hộp đó: hộp bên dưới cũng đổi ngôn ngữ và ô ngôn ngữ của nó nhận lựa chọn mới.
  const under = await page.evaluate(() => ({ open: document.getElementById("settings-dialog").open, value: document.getElementById("locale").value, label: document.querySelector("label[for=locale]").textContent, name: document.querySelector("label[for=display-name]").textContent, title: document.getElementById("settings-title").textContent }));
  ok(under.open && under.value === "en" && under.label === "Language" && under.name === en["settings.name"] && under.title === "At your rhythm", "hộp Cá nhân hóa nằm dưới thông báo cũng đổi sang ngôn ngữ mới; ô ngôn ngữ của nó không giữ lựa chọn cũ");
  await page.click("[data-action=close-settings]");
  // Màn hình có trạng thái (Kết nối) được mount lại khi đổi ngôn ngữ: chữ dựng lúc mount cũng đổi.
  await go(page, "connect");
  const connectEn = await page.evaluate(() => [document.querySelector("main h1").textContent, document.querySelector("main .eyebrow").textContent, getComputedStyle(document.querySelector("main .eyebrow")).textTransform].join("|"));
  await chooseLanguage(page, "vi");
  await page.waitForFunction(() => document.documentElement.lang === "vi");
  const connectVi = await page.evaluate(() => [document.querySelector("main h1").textContent, document.querySelector("main .eyebrow").textContent, document.body.dataset.view].join("|"));
  ok(connectEn === "Connect|Add-on modules|uppercase" && connectVi === "Kết nối|Mô-đun mở rộng|connect", "màn hình có trạng thái được dựng lại bằng ngôn ngữ mới và vẫn là màn hình đang mở");
  // Chữ nhãn: viết hoa bằng CSS với chữ Latin, giữ nguyên với chữ Hán, kana, Hangul.
  const cases = await page.evaluate(() => {
    const el = document.querySelector("main .eyebrow");
    const out = [];
    for (const lang of ["vi", "ru", "ja", "ko", "zh-Hans", "zh-Hant"]) {
      document.documentElement.lang = lang;
      out.push(lang + ":" + getComputedStyle(el).textTransform + ":" + getComputedStyle(el).letterSpacing);
    }
    document.documentElement.lang = "vi";
    return out.join(" ");
  });
  ok(/^vi:uppercase:1\.7px ru:uppercase:1\.7px(?: (?:ja|ko|zh-Hans|zh-Hant):none:(?:normal|0px)){4}$/.test(cases), "nhãn nhỏ: viết hoa và giãn chữ với hệ chữ có chữ hoa; chữ Hán, kana, Hangul giữ nguyên, không giãn — " + cases);
  await first.context.close();

  // ---------------------------------------------------------------- không đổi ngôn ngữ khi một kế hoạch đang chờ đồng ý
  const held = await t.open({ modules: ALL });
  const hp = held.page;
  await t.dismissNotice(hp);
  await hp.click("#settings-button"); // dựng các trường của hộp Cá nhân hóa một lần
  await hp.click("[data-action=close-settings]");
  await newBlock(hp, "09:00", "09:30");
  await hp.waitForSelector("#countdown");
  // Hộp xem lại là hộp modal nên người dùng không với tới ô ngôn ngữ; gửi form bằng mã để kiểm lớp chặn phía sau.
  const trySwitch = (value) => hp.evaluate((v) => {
    document.getElementById("locale").value = v;
    document.getElementById("settings-form").requestSubmit();
  }, value);
  await trySwitch("en");
  await hp.waitForFunction((text) => document.getElementById("toast").textContent === text, vi["settings.language.pending"]);
  const refused = await hp.evaluate(() => ({ lang: document.documentElement.lang, title: document.getElementById("action-title").textContent, countdown: document.getElementById("countdown")?.textContent, open: document.getElementById("action-dialog").open, stored: JSON.parse(localStorage.getItem("lenhip.ui.v2")).users.dev_a.locale, approve: document.querySelector("[data-action=approve-plan]").textContent }));
  ok(refused.lang === "vi" && refused.open && refused.title === "Xem lại và xác nhận" && /Còn \d+ giây/.test(refused.countdown) && refused.stored === "auto" && refused.approve === "Xác nhận", "đang xem lại một kế hoạch (đồng hồ 120 giây chạy): yêu cầu đổi ngôn ngữ bị từ chối, màn hình xem lại giữ nguyên chữ, thiết lập không đổi (LNH-T29)");
  await hp.click("button[data-action=cancel-plan]");
  await hp.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  await trySwitch("en");
  await hp.waitForFunction(() => document.documentElement.lang === "en");
  ok((await hp.textContent("#desktop-nav")).includes("Today") && (await hp.evaluate(() => JSON.parse(localStorage.getItem("lenhip.ui.v2")).users.dev_a.locale)) === "en", "sau khi bỏ kế hoạch, cùng yêu cầu đó được chấp nhận");
  await held.context.close();

  // ---------------------------------------------------------------- ngôn ngữ chưa có catalog trong bản dựng
  const lacking = await t.open({ modules: ALL, collectErrors: false, wait: false });
  await lacking.context.route("**/shared/i18n-de*.js", (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "" }));
  await lacking.page.reload();
  await t.ready(lacking.page);
  await t.dismissNotice(lacking.page);
  await chooseLanguage(lacking.page, "de");
  await lacking.page.waitForFunction((text) => document.getElementById("toast").textContent === text, vi["settings.language.unavailable"]);
  const kept = await lacking.page.evaluate(() => ({ lang: document.documentElement.lang, nav: document.querySelector("#desktop-nav .nav-label").textContent, stored: JSON.parse(localStorage.getItem("lenhip.ui.v2")).users.dev_a.locale }));
  ok(kept.lang === "vi" && kept.nav === "Hôm nay" && kept.stored === "auto", "chọn một ngôn ngữ mà bản dựng chưa có catalog (giả lập bằng trả 404 cho i18n-de*.js): báo rõ và giữ ngôn ngữ đang dùng, không hiện tiếng Việt dưới tên ngôn ngữ khác");
  await lacking.context.close();

  // ---------------------------------------------------------------- lỗi và câu trả lời của LeLe dựng từ mã (LNH-T23)
  const coded = await t.open({ locale: "en-US", modules: ALL, collectErrors: false });
  const cp = coded.page;
  await consentAll(t, cp);
  let planError = null;
  let leleAnswer = null;
  await coded.context.route("**/v1/plans", (route) => (planError ? route.fulfill({ status: planError.status, contentType: "application/json", body: JSON.stringify(planError.body) }) : route.continue()));
  await coded.context.route("**/v1/lele/proposals", (route) => (leleAnswer ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(leleAnswer) }) : route.continue()));
  const failPlan = async (status, body) => {
    planError = { status, body };
    await newBlock(cp, "10:00", "10:30");
    await cp.waitForFunction(() => document.getElementById("action-title").textContent === "The action could not be created");
    const text = await cp.textContent("#action-body p");
    await closeAction(cp);
    planError = null;
    return text;
  };
  // Máy chủ thật: khung giờ 5 tiếng vượt giới hạn 240 phút → 422 UNSUPPORTED kèm detail_code BLOCK_TOO_LONG và limit 240.
  await newBlock(cp, "10:00", "15:00");
  await cp.waitForFunction(() => document.getElementById("action-title").textContent === "The action could not be created");
  const realTooLong = await cp.textContent("#action-body p");
  await closeAction(cp);
  ok(realTooLong === "A time block can be at most 240 minutes long.", "máy chủ thật gửi detail_code BLOCK_TOO_LONG và limit 240: giao diện tiếng Anh dựng câu từ mã, không in câu tiếng Việt của máy chủ");
  const prose = "Khung giờ dài tối đa 240 phút.";
  const detailed = await failPlan(422, { code: "UNSUPPORTED", message: prose, detail_code: "BLOCK_TOO_LONG", limit: 240, request_id: "req_e2e_1", retryable: false });
  const plainCode = await failPlan(422, { code: "UNSUPPORTED", message: prose, request_id: "req_e2e_2", retryable: false });
  const noLimit = await failPlan(422, { code: "UNSUPPORTED", message: prose, detail_code: "BLOCK_TOO_LONG", request_id: "req_e2e_3", retryable: false });
  const unknownDetail = await failPlan(400, { code: "SCHEMA_INVALID", message: "Giờ kết thúc phải sau giờ bắt đầu.", detail_code: "SOMETHING_NEW", request_id: "req_e2e_4", retryable: false });
  const unknownCode = await failPlan(418, { code: "TEAPOT_MODE", message: "Ấm trà.", request_id: "req_e2e_5", retryable: false });
  const noBody = await failPlan(502, "<html>Bad gateway</html>");
  ok(detailed === "A time block can be at most 240 minutes long." && plainCode === "Not supported yet." && noLimit === "Not supported yet." && unknownDetail === "The request does not match the contract.",
    "lỗi có mã chi tiết và giới hạn (giả lập bằng chặn route): câu dựng từ error.<CODE>.<detail_code>; thiếu mã chi tiết hoặc giới hạn thì lùi về câu của mã");
  ok(unknownCode === "The request could not be completed (code TEAPOT_MODE, request ID req_e2e_5)." && noBody === "The request could not be completed (code ERROR)." && ![detailed, plainCode, noLimit, unknownDetail, unknownCode].some((x) => /[ăđơưạ-ỹ]/i.test(x)),
    "mã lạ: câu chung kèm mã và mã yêu cầu; câu message tiếng Việt của máy chủ không bao giờ được in");
  await go(cp, "home");
  await cp.click("main button[data-action=chat]");
  const chatIntro = await cp.evaluate(() => ({ title: document.getElementById("action-title").textContent.trim(), mark: document.querySelector("#action-title svg.lele-mark")?.getAttribute("aria-label"), greeting: document.querySelector("#chat-list .chat-message").textContent, vi: document.querySelectorAll("#chat-list .chat-message span[lang=vi]").length, placeholder: document.querySelector("#chat-form input").placeholder, label: document.querySelector("#chat-form input").getAttribute("aria-label"), intro: document.querySelector("#action-body .fine-print").textContent }));
  ok(chatIntro.title === "Chat with" && chatIntro.mark === "LeLe" && chatIntro.greeting.includes("“block 30 minutes at 15:00”") && chatIntro.greeting.includes("“turn off the desk lamp”") && chatIntro.vi === 0 && chatIntro.placeholder === "What would you like to do?" && chatIntro.label === "Message for LeLe" && chatIntro.intro === en["lele.chat.intro"] && chatIntro.intro.includes("do not type health details here"),
    "LeLe bằng tiếng Anh: câu lệnh mẫu bằng tiếng Anh; lời giới thiệu nói đúng việc bộ lọc làm (chặn theo từ khóa trước khi gửi, đừng gõ chi tiết sức khỏe)");
  // Đếm mọi yêu cầu tới /v1/lele/proposals của trang này, kể cả yêu cầu được trả lời bằng chặn route.
  const leleCalls = [];
  cp.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/v1/lele/proposals") leleCalls.push(r.postDataJSON());
  });
  const ask = async (text) => {
    const before = await cp.$$eval("#chat-list .chat-message", (els) => els.length);
    await cp.fill("#chat-form input", text);
    await cp.click("#chat-form button");
    await cp.waitForFunction((n) => document.querySelectorAll("#chat-list .chat-message").length >= n + 2, before);
    return cp.$eval("#chat-list .chat-message:last-child", (e) => e.textContent);
  };
  const base = { type: "FORM", engine: "local-rules", ai_generated: false, proposal: null, fallback: "device.set_power" };
  leleAnswer = { ...base, answer: "Chọn đèn trong Ngôi nhà rồi xác nhận.", answer_code: "PICK_LAMP" };
  const byCode = await ask("bật đèn");
  leleAnswer = { ...base, answer: "Chọn đèn trong Ngôi nhà rồi xác nhận." };
  const legacy = await ask("bật đèn");
  leleAnswer = null;
  ok(byCode === "Choose the lamp in Home, then confirm." && legacy === "Use the form in Work or Home to create the action." && leleCalls.length === 2 && leleCalls.every((b) => b.text === "bật đèn" && b.context === "home" && Object.keys(b).sort().join() === "context,text,zone"),
    "câu trả lời của LeLe dựng từ answer_code (giả lập bằng chặn route); máy chủ chưa gửi mã thì giao diện tiếng Anh in câu chung, không in câu tiếng Việt của máy chủ");
  // Đóng khi không chắc (LNH-T24): câu sức khỏe của ngôn ngữ nào cũng được trả lời trên thiết bị và KHÔNG có yêu cầu nào đi ra.
  leleCalls.length = 0;
  const healthAnswers = [];
  for (const text of ["I slept badly last night and my heart rate is high", "j'ai mal dormi, ma tension est élevée", "昨夜はよく眠れませんでした", "tối qua tôi ngủ kém".normalize("NFD"), "turn on the desk lamp, I have a headache"]) healthAnswers.push(await ask(text));
  const piiAnswer = await ask("call me on 0912 345 678");
  const help = await ask("hello there");
  const helpVi = await cp.$$eval("#chat-list .chat-message:last-child span[lang=vi]", (els) => els.length);
  const uiAnswer = await ask("how do I change the theme colour?");
  ok(leleCalls.length === 0 && healthAnswers.every((a) => a === en["lele.local.health"]),
    "câu sức khỏe bằng tiếng Anh, tiếng Pháp, tiếng Nhật, tiếng Việt dạng tổ hợp (NFD) và câu sức khỏe nằm trong lệnh đèn: trả lời trên thiết bị, không yêu cầu nào tới /v1/lele/proposals");
  ok(leleCalls.length === 0 && piiAnswer === en["lele.local.pii"] && help.startsWith("LeLe can draft a suggestion") && help.includes("“block 30 minutes at 15:00”") && help.includes("“turn on the desk lamp”") && helpVi === 0 && uiAnswer === en["lele.local.interface"],
    "số điện thoại, câu không phải lệnh và câu hỏi về giao diện: trả lời trên thiết bị bằng tiếng Anh, không gửi gì");
  const proposal = await ask("block 30 minutes at 17:00 tomorrow");
  const pick = await ask("turn off the desk lamp");
  const named = await ask("turn off Đèn trần");
  ok(leleCalls.length === 3 && leleCalls.map((b) => b.context).join() === "work,home,home" && proposal.startsWith("Suggestion: Block 30 minutes of personal time at 17:00 tomorrow") && proposal.endsWith("Review and confirm") && pick === "Choose the lamp in Home, then confirm." && named.startsWith("Suggestion: Turn off Đèn trần"),
    "lệnh bằng tiếng Anh được gửi và máy chủ thật trả đề xuất: tóm tắt dựng trên thiết bị bằng tiếng Anh; tên đèn là dữ liệu của site nên gọi đúng tên mới chọn được đèn");
  await closeAction(cp);
  await coded.context.close();

  // ---------------------------------------------------------------- ngôn ngữ giả: tìm chữ ghi cứng và chỗ tràn
  const pseudo = Object.fromEntries(["", ...PARTS.map((p) => "-" + p)].map((suffix) => [`i18n-en${suffix}.js`, "export default " + JSON.stringify(pseudoCatalog(catalog(`i18n-vi${suffix}.js`))) + ";\n"]));
  const sample = pseudoCatalog({ a: "Sức khỏe", b: "Xem {n} bước của LeNhip" });
  ok(sample.a.length >= Math.ceil("Sức khỏe".length * 1.6) && ![...sample.a].some((c) => /[A-Za-zÀ-ỹ]/.test(c) && !(LOWER + UPPER).includes(c)) && sample.b.includes("{n}") && sample.b.includes("LeNhip") && !/Xem|bước|của/.test(sample.b),
    `ngôn ngữ giả sinh từ bản tiếng Việt: «Sức khỏe» → «${sample.a}», giữ tham số và tên thương hiệu`);
  const problems = [];
  const moduleNotes = new Set();
  let slot = 0;
  for (const [name, viewport] of [["điện thoại 390×844", PHONE], ["máy tính xách tay 1280×800", LAPTOP]]) {
    const run1 = await t.open({ viewport, locale: "en-US", modules: ALL, wait: false, reducedMotion: "reduce" });
    for (const [file, body] of Object.entries(pseudo)) await run1.context.route("**/shared/" + file, (route) => route.fulfill({ contentType: "text/javascript; charset=utf-8", body }));
    // Dữ liệu từ máy chủ (tên người dùng, đèn, site) là thứ hợp lệ duy nhất không đi qua catalog: gom từ các phản hồi.
    const data = new Set(["web-tong-hop"]);
    run1.page.on("response", async (r) => {
      if (!/\/v1\/me$|\/v1\/devices|\/dev\/users$/.test(new URL(r.url()).pathname) || !r.ok()) return;
      const walk = (v) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (k === "name" && typeof x === "string" ? data.add(x) : walk(x));
      };
      walk(await r.json().catch(() => null));
    });
    const p = run1.page;
    await p.reload();
    await t.ready(p);
    const at = (scale, where) => `${name} · chữ ${scale} % · ${where}`;
    /** Một trạng thái của giao diện: không tràn ngang, nhãn điều hướng trong nút, không chữ ngoài catalog. */
    const check = async (scale, where, { module = false } = {}) => {
      const over = Math.max(await t.overflowX(p), await dialogOverflow(p));
      if (over > 0) problems.push(`${at(scale, where)}: tràn ngang ${over} px`);
      for (const spill of await t.navSpill(p)) problems.push(`${at(scale, where)}: ${spill}`);
      for (const found of await hardcoded(p, [...data])) (module && !STRICT_MODULE_SCREENS ? moduleNotes.add(`${where}: ${found}`) : problems.push(`${at(scale, where)}: ${found}`));
    };
    for (const scale of [100, 200]) {
      if (scale === 100) {
        // Lần đầu trên thiết bị này: thông báo đầu tiên, rồi các màn hình khi chưa đồng ý gì trên thiết bị.
        if (await p.$("#action-dialog[open] #consent-form")) {
          await check(scale, "thông báo đầu tiên");
          await shot(p, `pseudo-${viewport.width}-thong-bao`);
          await closeAction(p);
        }
        await go(p, "health");
        await check(scale, "Sức khỏe đang tắt");
        await consentAll(t, p);
      }
      await t.chooseSettings(p, { fontSize: scale, theme: "orbit" });
      for (const id of ["home", "health", "work", "house", "messages", "connect"]) {
        await go(p, id);
        await check(scale, "màn hình " + id, { module: id === "messages" || id === "connect" });
        await shot(p, `pseudo-${viewport.width}-${scale}-${id}`, true);
      }
      // Các dạng khác của Hôm nay: không gian công việc và bốn phong cách còn lại (mỗi phong cách có chữ riêng).
      await go(p, "home");
      await p.click("main button[data-context=work]");
      await p.waitForSelector("main button[data-context=work][aria-pressed=true]");
      await check(scale, "Hôm nay · không gian công việc");
      await p.click("main button[data-context=personal]");
      await p.waitForSelector("main button[data-context=personal][aria-pressed=true]");
      for (const theme of ["night", "calm", "flow", "titanium"]) {
        await t.chooseSettings(p, { theme });
        await go(p, "home");
        if (theme === "flow" || theme === "titanium") await p.click("main details.today-details summary");
        await check(scale, "Hôm nay · phong cách " + theme);
      }
      await t.chooseSettings(p, { theme: "orbit" });
      // Hộp thoại: Cá nhân hóa, Tài khoản, LeLe, thêm khung giờ, xem lại, theo dõi, nguồn dữ liệu, đổi đèn.
      await p.click("#settings-button");
      await check(scale, "hộp Cá nhân hóa");
      await shot(p, `pseudo-${viewport.width}-${scale}-ca-nhan-hoa`);
      await p.click("[data-action=close-settings]");
      await p.click("#profile-button");
      await check(scale, "hộp Tài khoản");
      await closeAction(p);
      await go(p, "home");
      await p.click("main button[data-action=chat]");
      await p.fill("#chat-form input", "tối qua tôi ngủ kém");
      await p.click("#chat-form button");
      await p.waitForFunction(() => document.querySelectorAll("#chat-list .chat-message").length >= 3);
      await check(scale, "hộp LeLe");
      await closeAction(p);
      await go(p, "work");
      await p.click("button[data-action=new-block]");
      await p.selectOption("#block-day", { index: 1 });
      // Mỗi lượt (cỡ màn hình × cỡ chữ) một khung giờ riêng của ngày mai: cùng tài khoản, cùng máy chủ nên không được trùng
      // nhau, và tránh hai cuộc họp của dữ liệu mẫu (09:00 và 14:00) cùng khung 16:00 đã ghi ở phần trên.
      const hour = ["11", "12", "13", "15"][slot++];
      await p.fill("#block-start", hour + ":00");
      await p.fill("#block-end", "10:00");
      await p.click("#block-form button");
      await p.waitForSelector("#block-error:not([hidden])");
      await check(scale, "hộp thêm khung giờ (báo lỗi giờ)");
      await p.fill("#block-end", hour + ":30");
      await p.click("#block-form button");
      await p.waitForSelector("#countdown");
      await check(scale, "hộp xem lại khung giờ");
      await shot(p, `pseudo-${viewport.width}-${scale}-xem-lai`);
      await p.click("button[data-action=approve-plan]");
      await p.waitForSelector("#action-body .status-chip.ok", { timeout: 15000 }).catch(async (e) => {
        throw new Error(`${at(scale, "khung giờ " + hour + ":00")}: không tới trạng thái đã xác minh — «${(await p.textContent("#action-body")).slice(0, 300)}»`, { cause: e });
      });
      await check(scale, "hộp theo dõi (đã xác minh)");
      await closeAction(p);
      await go(p, "house");
      await p.click("button.switch[data-device=dev_lamp_01]");
      await p.waitForSelector("#countdown");
      await check(scale, "hộp xem lại đèn");
      await p.click("button[data-action=cancel-plan]");
      await p.waitForSelector("#action-dialog:not([open])", { state: "attached" });
      await check(scale, "Ngôi nhà sau khi bỏ thao tác (thông báo nổi)");
      await go(p, "health");
      await p.click("main button[data-action=health-source]");
      await check(scale, "hộp nguồn dữ liệu");
      await closeAction(p);
      await run1.context.setOffline(true);
      await p.waitForSelector("#banner:not([hidden])");
      await check(scale, "mất kết nối (thanh cảnh báo)");
      await run1.context.setOffline(false);
      await p.waitForSelector("#banner", { state: "hidden" });
    }
    await run1.context.close();
  }
  if (moduleNotes.size) console.log("  (màn hình của mô-đun tính năng, chưa tính là lỗi — STRICT_MODULE_SCREENS=false)\n  " + [...moduleNotes].join("\n  "));
  ok(problems.length === 0, "ngôn ngữ giả ở 390×844 và 1280×800, chữ 100 % và 200 %: không cuộn ngang, nhãn điều hướng nằm trong nút, không còn chữ ngoài catalog" + (problems.length ? "\n  " + [...new Set(problems)].join("\n  ") : ""));
  ok(existsSync(new URL("web/shared/i18n-en.js", ROOT)), "catalog tiếng Anh thật không bị đụng tới: ngôn ngữ giả chỉ tồn tại trong trình duyệt của phép kiểm");
});
