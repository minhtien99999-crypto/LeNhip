// Kiểm phần Mạng xã hội trên trình duyệt thật, bước «chia sẻ ra từ thiết bị» (LNH-T40, LNH-T41): danh mục 34 nền tảng, hộp
// soạn «Chia sẻ LeNhip», nơi nhận (bảng chia sẻ của thiết bị, năm liên kết đang bật, Sao chép, Email), câu chữ sau khi mở nơi
// nhận, và bằng chứng rằng việc chia sẻ không gọi máy chủ, không ra khỏi gốc của LeNhip, không ghi gì vào trình duyệt.
//   node scripts/e2e-social.mjs [thư-mục-ảnh]        (cả bộ: npm run e2e)
//
// Những thứ là GIẢ trong tệp này:
// - navigator.share: Chromium không đầu trên Linux không có bảng chia sẻ. Hàm được thay bằng bản thử chỉ ghi lại dữ liệu nhận
//   được rồi trả lời theo kịch bản (nhận, người dùng đóng, bị từ chối). Bảng chia sẻ thật của điện thoại chưa được kiểm.
// - Nền tảng: mọi yêu cầu ra ngoài gốc của LeNhip bị chặn ở trình duyệt của phép kiểm và nhận một trang thử. Không nền tảng
//   thật nào được gọi; phép kiểm chỉ xác nhận cửa sổ mới đi tới đúng địa chỉ mà trình dựng liên kết tạo ra.
// - Địa chỉ công khai https://lenhip.example/: LeNhip chưa có địa chỉ công khai (LNH-Q13); giá trị được đưa vào bằng
//   setPublicUrl() của web/views/connect-social.js.
import { run, THEMES } from "./e2e-lib.mjs";
import { SOCIAL_PLATFORMS, SHARE_REACHES, shareReach, buildShareUrl, buildMailtoUrl } from "../web/shared/social-registry.js";
import { buildShareCard, NOTE_LIMIT } from "../web/shared/share-card.js";

const PUBLIC = "https://lenhip.example/";
const NOTE = "Một ngày đúng nhịp 🙂\nvới LeNhip & bạn #1 100%";
// 280 ký tự, có từ dài không ngắt được và chữ viết từ phải sang trái, để đo bố cục ở trường hợp xấu nhất.
const LONG = ("Donaudampfschifffahrtsgesellschaftskapitänsmützenabzeichen https://vi-du.example/duong-dan-rat-dai?tham_so=gia_tri مرحبا بالعالم 🙂 " + "Một ngày đúng nhịp. ".repeat(20)).slice(0, NOTE_LIMIT);
const SIZES = [["điện thoại", { width: 390, height: 844 }], ["máy tính bảng", { width: 820, height: 1180 }], ["máy tính", { width: 1440, height: 900 }]];
const NAME = Object.fromEntries(SOCIAL_PLATFORMS.map((p) => [p.id, p.name]));
const UNKNOWN = "LeNhip không biết bạn đã đăng hay chưa.";
/** Câu có khẳng định đã đăng, đã gửi hay thành công không, sau khi bỏ mệnh đề «LeNhip không biết…». */
const claimsPost = (text) => /đã đăng|đã gửi|đã chia sẻ|thành công/i.test(text.replace(/LeNhip không biết bạn đã (?:đăng|gửi) hay chưa\./g, ""));

const go = async (page, id) => {
  await page.evaluate((v) => {
    location.hash = "#" + v;
  }, id);
  await page.waitForSelector(`body[data-view=${id}]`, { state: "attached" });
};
const openComposer = async (page) => {
  await page.click("[data-social-open]");
  await page.waitForSelector("#action-dialog[open] #social-note");
};
const closeComposer = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
};
/** Đưa địa chỉ công khai vào phần (null là chưa có) rồi vào lại màn hình Kết nối để phần được vẽ lại. */
const setPublic = async (page, value) => {
  await page.evaluate(async (v) => {
    (await import("/views/connect-social.js")).setPublicUrl(v);
  }, value);
  await go(page, "home");
  await go(page, "connect");
};
/** Thay navigator.share bằng bản thử: ghi lại dữ liệu nhận được vào window.__shared, trả lời theo window.__shareMode. */
const stubShare = (page) =>
  page.evaluate(() => {
    window.__shared = [];
    window.__shareMode = "resolve";
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => window.__shareMode !== "cannot" });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data) => {
        window.__shared.push(data);
        if (window.__shareMode === "abort") throw new DOMException("Share canceled", "AbortError");
        if (window.__shareMode === "deny") throw new DOMException("Permission denied", "NotAllowedError");
      },
    });
  });
const composer = (page) =>
  page.evaluate(() => {
    const body = document.getElementById("action-body");
    const q = (s) => body.querySelector(s);
    return {
      title: document.getElementById("action-title").textContent,
      note: q("#social-note").value,
      count: q("#social-note-count").textContent,
      error: q("#social-note-error").hidden ? null : q("#social-note-error").textContent,
      invalid: q("#social-note").getAttribute("aria-invalid"),
      checkbox: q("#social-include-link") ? q("#social-include-link").checked : null,
      noUrl: q("#social-no-url")?.textContent ?? null,
      preview: q("#social-preview").textContent,
      needLink: q("#social-need-link") && !q("#social-need-link").hidden ? q("#social-need-link").textContent : null,
      status: q("#social-status").textContent,
      statusRole: q("#social-status").getAttribute("role"),
      order: [...q("#social-targets").children].map((el) => el.dataset.socialPlatform ?? el.dataset.socialTarget),
      links: [...body.querySelectorAll("a[data-social-platform]")].map((a) => ({ id: a.dataset.socialPlatform, href: a.getAttribute("href"), target: a.target, rel: a.rel, text: a.textContent, disabled: a.getAttribute("aria-disabled") })),
      mail: q("a[data-social-target=email]").getAttribute("href"),
      buttons: Object.fromEntries([...body.querySelectorAll("button[data-social-target]")].map((b) => [b.dataset.socialTarget, !b.disabled])),
      fields: [...body.querySelectorAll("input, textarea, select, [contenteditable]")].map((e) => e.localName + (e.type ? ":" + e.type : "") + "#" + e.id),
    };
  });
const catalogue = (page) =>
  page.evaluate(() => ({
    summary: document.querySelector(".social-catalogue > summary").textContent,
    open: document.querySelector(".social-catalogue").open,
    noAccount: document.querySelector(".social-no-account").textContent,
    groups: [...document.querySelectorAll(".social-group")].map((g) => ({
      reach: g.dataset.socialGroup, title: g.querySelector("h3 span").textContent, count: g.querySelector("h3 .tiny-pill").textContent,
      items: [...g.querySelectorAll("li")].map((li) => ({ id: li.dataset.socialItem, name: li.querySelector(".social-platform-name").textContent, status: li.querySelector(".status-chip").textContent, evidence: li.querySelector(".social-evidence").textContent })),
    })),
  }));
/** Lỗi bố cục của phần và của hộp soạn (nếu đang mở): tràn ngang, phần tử lọt ra ngoài khung, vùng bấm thấp hơn 44 px. */
const layoutProblems = (page) =>
  page.evaluate(() => {
    const out = [];
    const name = (el) => el.localName + (el.id ? "#" + el.id : "") + (el.classList.length ? "." + [...el.classList].join(".") : "");
    const inside = (root, frame, label) => {
      const box = frame.getBoundingClientRect();
      for (const el of root.querySelectorAll("*")) {
        if (el.closest(".social-sr") || el.closest("svg") || el.getClientRects().length === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${label}: ${name(el)} lọt ra ngoài ${Math.round(Math.max(box.left - r.left, r.right - box.right))} px`);
      }
    };
    const tall = (els, label) => {
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.height < 44 || r.width < 44) out.push(`${label}: ${name(el)} chỉ ${Math.round(r.width)}×${Math.round(r.height)} px`);
        if (el.scrollWidth > el.clientWidth + 1) out.push(`${label}: chữ của ${name(el)} bị cắt`);
      }
    };
    const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    if (over > 0) out.push(`trang cuộn ngang ${over} px`);
    const section = document.querySelector(".connect-section[data-section=social]");
    inside(section, section, "phần");
    tall(section.querySelectorAll("button, summary"), "phần");
    const dialog = document.getElementById("action-dialog");
    if (dialog.open) {
      const box = dialog.getBoundingClientRect();
      if (dialog.scrollWidth > dialog.clientWidth + 1) out.push(`hộp soạn cuộn ngang ${dialog.scrollWidth - dialog.clientWidth} px`);
      if (box.left < 0 || box.right > innerWidth + 0.5 || box.top < 0 || box.bottom > innerHeight + 0.5) out.push("hộp soạn vượt khung nhìn");
      inside(dialog, dialog, "hộp soạn");
      tall(dialog.querySelectorAll("button, a.social-target, textarea, label.social-check"), "hộp soạn");
    }
    return out;
  });
/** Tương phản thấp nhất của chữ chính và chữ phụ trong phần và hộp soạn, và của dòng phụ đề của khung (để so sánh). */
const contrasts = (page) =>
  page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/[\d.]+/g).map(Number);
      return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const mix = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const backgroundOf = (el) => {
      const layers = [];
      for (let n = el; n; n = n.parentElement) {
        const bg = parse(getComputedStyle(n).backgroundColor);
        if (bg.a > 0) layers.push(bg);
        if (bg.a === 1) break;
      }
      return layers.reverse().reduce((under, top) => mix(top, under), { r: 255, g: 255, b: 255, a: 1 });
    };
    const ratio = (el) => {
      const bg = backgroundOf(el);
      const [hi, lo] = [lum(mix(parse(getComputedStyle(el).color), bg)), lum(bg)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const lowest = (selectors) => {
      let min = Infinity;
      let where = "";
      for (const s of selectors) {
        for (const el of document.querySelectorAll(s)) {
          if (el.getClientRects().length === 0 || !el.textContent.trim()) continue;
          const c = ratio(el);
          if (c < min) [min, where] = [c, s];
        }
      }
      return { min, where };
    };
    const S = ".connect-section[data-section=social] ";
    return {
      primary: lowest([S + ".social-lead", S + ".social-open span", S + ".social-subhead > span:first-child", S + "summary", S + ".social-no-account", S + ".social-platform-name", S + ".status-chip", S + ".social-evidence",
        "#action-title", "label[for=social-note]", "#social-note", ".social-check strong", "#social-preview", ".social-target[href] span:first-child", "button.social-target:not(:disabled) span", "#social-status", "#social-note-error"]),
      muted: lowest([S + ".fine-print", S + ".privacy-note", S + ".empty-state", ".social-composer .fine-print", ".social-composer .privacy-note", ".social-url"]),
      shell: lowest(["main .subtitle"]),
    };
  });

await run("mạng xã hội · chia sẻ từ thiết bị", async (t) => {
  const { ok, shot } = t;
  const origin = new URL(t.base).origin;
  /** Ghi mọi yêu cầu của trang LeNhip, và chặn mọi yêu cầu ra ngoài gốc của LeNhip trong ngữ cảnh (trả một trang thử). */
  const watch = async (context, page) => {
    const log = { app: [], foreign: [] };
    page.on("request", (r) => log.app.push(r.method() + " " + r.url()));
    await context.route((url) => url.origin !== origin, async (route) => {
      const r = route.request();
      log.foreign.push({ url: r.url(), navigation: r.isNavigationRequest(), referer: r.headers().referer ?? null });
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><title>Trang thử</title><p>Trang thử của phép kiểm, không phải nền tảng thật.</p>" });
    });
    return log;
  };
  /** Bấm một liên kết nền tảng, chờ cửa sổ mới, trả địa chỉ nó đi tới và quan hệ của nó với trang LeNhip. */
  const follow = async (context, page, press) => {
    const [popup] = await Promise.all([context.waitForEvent("page"), press()]);
    await popup.waitForLoadState("domcontentloaded");
    const seen = { url: popup.url(), noOpener: await popup.evaluate(() => window.opener === null), referrer: await popup.evaluate(() => document.referrer) };
    await popup.close();
    await page.bringToFront();
    return seen;
  };
  const statuses = [];

  // ---------------------------------------------------------------- phần trong Kết nối và danh mục 34 nền tảng
  const desk = await t.open({ modules: { social: true }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
  const page = desk.page;
  const log = await watch(desk.context, page);
  await t.dismissNotice(page);
  await go(page, "connect");
  const section = await page.evaluate(() => {
    const el = document.querySelector(".connect-section[data-section=social]");
    return {
      sections: [...document.querySelectorAll(".connect-grid > section")].map((s) => s.dataset.section).join(), heading: el.querySelector("h2").textContent, pill: el.querySelector(".section-heading .tiny-pill").textContent,
      button: el.querySelector("[data-social-open]").textContent, text: el.textContent, foreign: el.querySelectorAll("a, img, picture, iframe, form, input, select, textarea, script").length, keys: /\bsocial\.[a-z]/.test(document.body.textContent),
    };
  });
  ok(section.sections === "social" && section.heading === "Mạng xã hội" && section.pill === "Trên thiết bị này" && section.button === "Chia sẻ LeNhip" && !section.keys, "Kết nối có phần Mạng xã hội với nút «Chia sẻ LeNhip»; mọi chuỗi lấy từ catalog");
  ok(section.text.includes("LeNhip không gửi nội dung về máy chủ và không lưu lịch sử chia sẻ") && section.text.includes("Không có ô nào để chọn dữ liệu sức khỏe, lịch hay ngôi nhà") && section.text.includes("Không tài khoản nền tảng thật nào liên kết được"),
    "phần nói rõ: chia sẻ diễn ra trên thiết bị, không có ô chọn dữ liệu sức khỏe, lịch hay ngôi nhà, chưa liên kết được tài khoản thật nào");
  ok(section.foreign === 0, "phần không có liên kết, ảnh, logo, khung nhúng hay ô nhập nào: tên nền tảng chỉ là chữ");
  const closed = await catalogue(page);
  await page.click(".social-catalogue > summary");
  const cat = await catalogue(page);
  const expected = SHARE_REACHES.map((reach) => SOCIAL_PLATFORMS.filter((p) => shareReach(p) === reach));
  const items = cat.groups.flatMap((g) => g.items);
  ok(!closed.open && cat.open && cat.summary === "Danh mục 34 nền tảng" && cat.groups.map((g) => g.reach).join() === SHARE_REACHES.join() && cat.groups.map((g) => g.count).join() === "5,16,3,10" && items.length === 34 &&
    cat.groups.every((g, i) => g.items.map((x) => x.id + "=" + x.name).join() === expected[i].map((p) => p.id + "=" + p.name).join()),
    "danh mục gập sẵn, mở ra đủ 34 nền tảng trong bốn nhóm theo cách tới được: 5 đang bật, 16 chưa bật, 3 cần đăng ký, 10 chỉ qua bảng chia sẻ");
  const statusOf = Object.fromEntries(items.map((x) => [x.id, x.status]));
  ok(cat.groups.map((g) => g.title).join("|") === "Liên kết chia sẻ đang bật|Liên kết chia sẻ chưa bật|Cần đăng ký với nền tảng|Chỉ qua bảng chia sẻ của thiết bị" &&
    ["threads", "x", "bluesky"].every((id) => statusOf[id] === "Đang bật") && ["telegram", "line"].every((id) => statusOf[id] === "Chờ địa chỉ công khai của LeNhip") &&
    cat.groups[1].items.every((x) => x.status === (x.id === "viber" ? "Chưa bật: liên kết chỉ mở ứng dụng đã cài" : "Chưa xác nhận")) && cat.groups[2].items.every((x) => x.status === "Cần đăng ký") && cat.groups[3].items.every((x) => x.status === "Chỉ qua bảng chia sẻ của thiết bị"),
    "trạng thái từng mục: Threads, X, Bluesky đang bật; Telegram, LINE chờ địa chỉ công khai; còn lại «chưa xác nhận», «cần đăng ký» hoặc «chỉ qua bảng chia sẻ của thiết bị»");
  const grades = ["tài liệu chính thức, đọc qua tóm tắt tìm kiếm", "một phần từ tài liệu chính thức, phần còn lại từ bên thứ ba", "chỉ có nguồn của bên thứ ba", "chưa có nguồn nào kiểm được"];
  ok(items.every((x) => grades.some((g) => x.evidence === "Mức bằng chứng: " + g)) && grades.map((g) => items.filter((x) => x.evidence.endsWith(g)).length).join() === "9,14,10,1" && statusOf.band === "Chưa xác nhận" &&
    cat.noAccount === "Bản dựng này không liên kết được tài khoản của bất kỳ nền tảng thật nào trong danh mục.",
    "mỗi mục ghi mức bằng chứng bằng lời (9 chính thức qua tìm kiếm, 14 một phần, 10 bên thứ ba, 1 chưa kiểm được); có dòng «không liên kết được tài khoản thật nào»");
  await shot(page, "danh-muc", true);

  // ---------------------------------------------------------------- hộp soạn khi chưa có địa chỉ công khai và không có bảng chia sẻ
  await page.evaluate(() => Object.defineProperty(navigator, "share", { configurable: true, value: undefined }));
  const before = await page.evaluate(async () => ({ storage: JSON.stringify([{ ...localStorage }, { ...sessionStorage }]), cookie: document.cookie, dbs: (await indexedDB.databases()).map((d) => d.name).sort().join() }));
  const mark = log.app.length;
  await openComposer(page);
  let c = await composer(page);
  ok(c.title === "Chia sẻ LeNhip" && c.fields.join() === "textarea:textarea#social-note" && c.checkbox === null && c.noUrl.includes("Telegram và LINE chỉ nhận chia sẻ có liên kết nên chưa hiện ở đây"),
    "hộp soạn chỉ có một ô ghi chú: không ô nào chọn dữ liệu sức khỏe, lịch hay ngôi nhà; chưa có địa chỉ công khai nên không có ô kèm liên kết");
  ok(c.order.join() === "threads,x,bluesky,copy,email" && c.links.every((a) => a.href === null && a.disabled === "true") && c.mail === null && c.buttons.copy === false && c.count === "0/280 ký tự" && c.preview === "Chưa có gì để chia sẻ. Hãy viết ghi chú.",
    "chưa viết gì: không có nút bảng chia sẻ (trình duyệt này không có navigator.share), không có Telegram và LINE, các nơi nhận chưa bấm được");
  await page.fill("#social-note", NOTE);
  const card = buildShareCard({ note: NOTE });
  c = await composer(page);
  ok(c.preview === card.text && c.count === `${card.graphemes}/280 ký tự` && c.error === null && c.invalid === "false", "ô xem trước là đúng văn bản sẽ chia sẻ; bộ đếm theo ký tự người đọc nhìn thấy (emoji là một ký tự)");
  ok(c.links.every((a) => a.href === buildShareUrl(a.id, card) && a.href.startsWith("https://") && a.target === "_blank" && a.rel === "noopener noreferrer" && a.disabled === null && a.text.includes(NAME[a.id])) &&
    c.mail === buildMailtoUrl({ subject: "LeNhip", body: card.text }) && c.buttons.copy === true,
    "mỗi nền tảng là một thẻ <a target=_blank rel=\"noopener noreferrer\"> có href đúng bằng kết quả của trình dựng liên kết; Email là mailto: không người nhận");
  for (const id of ["threads", "x", "bluesky"]) {
    const seen = await follow(desk.context, page, () => page.click(`a[data-social-platform=${id}]`));
    c = await composer(page);
    statuses.push(c.status);
    ok(seen.url === buildShareUrl(id, card) && seen.noOpener && seen.referrer === "" && c.status === `Đã mở cửa sổ của ${NAME[id]}. ${UNKNOWN}` && c.statusRole === "status",
      `${NAME[id]}: cửa sổ mới đi tới đúng liên kết đã dựng, không có quyền với trang LeNhip, không nhận địa chỉ trang; LeNhip chỉ nói «đã mở cửa sổ… không biết bạn đã đăng hay chưa»`);
  }
  await page.click("button[data-social-target=copy]");
  await page.waitForFunction(() => document.getElementById("social-status").textContent.includes("sao chép"));
  c = await composer(page);
  statuses.push(c.status);
  ok((await page.evaluate(() => navigator.clipboard.readText())) === card.text && c.status === "Đã sao chép nội dung vào bộ nhớ tạm của thiết bị.", "Sao chép: bộ nhớ tạm nhận đúng văn bản của ô xem trước");
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: () => Promise.reject(new DOMException("từ chối", "NotAllowedError")) }));
  await page.click("button[data-social-target=copy]");
  await page.waitForFunction(() => document.getElementById("social-status").textContent.includes("không cho sao chép"));
  c = await composer(page);
  statuses.push(c.status);
  ok(c.status === "Trình duyệt không cho sao chép. Nội dung trong ô xem trước đã được chọn sẵn để bạn tự sao chép." && (await page.evaluate(() => getSelection().toString())) === card.text, "trình duyệt từ chối sao chép: không báo đã sao chép, văn bản được chọn sẵn để tự sao chép");
  await page.evaluate(() => delete navigator.clipboard.writeText);
  // Liên kết mailto: chỉ kiểm sự kiện bấm; phép kiểm chặn thao tác mặc định vì máy kiểm không có ứng dụng thư.
  await page.evaluate(() => document.addEventListener("click", (e) => e.target.closest?.('a[href^="mailto:"]') && e.preventDefault(), true));
  await page.click("a[data-social-target=email]");
  c = await composer(page);
  statuses.push(c.status);
  ok(c.status === "Đã yêu cầu thiết bị mở ứng dụng thư. LeNhip không biết bạn đã gửi hay chưa.", "Email: chỉ nói đã yêu cầu thiết bị mở ứng dụng thư");
  await page.fill("#social-note", "ế".repeat(NOTE_LIMIT + 1));
  c = await composer(page);
  ok(c.error === "Ghi chú dài hơn 280 ký tự. Hãy rút gọn để chia sẻ." && c.invalid === "true" && c.count === "281/280 ký tự" && c.status === "" && c.links.every((a) => a.href === null) && c.mail === null && c.buttons.copy === false,
    "281 ký tự: báo lỗi, không cắt bớt, mọi nơi nhận ngừng bấm được và dòng trạng thái cũ được xóa");
  await page.fill("#social-note", "ế".repeat(NOTE_LIMIT));
  c = await composer(page);
  ok(c.error === null && c.count === "280/280 ký tự" && c.links.every((a) => a.href !== null), "280 chữ «ế» dạng tổ hợp (840 đơn vị mã) vẫn là 280 ký tự và chia sẻ được");
  await page.fill("#social-note", NOTE);
  await closeComposer(page);
  const focusBack = await page.evaluate(() => document.activeElement?.matches("[data-social-open]"));
  await openComposer(page);
  c = await composer(page);
  ok(focusBack && c.note === NOTE && c.status === "", "đóng bằng Escape: focus về nút «Chia sẻ LeNhip»; mở lại thì bản nháp còn trong bộ nhớ của trang");
  await closeComposer(page);
  const after = await page.evaluate(async () => ({ storage: JSON.stringify([{ ...localStorage }, { ...sessionStorage }]), cookie: document.cookie, dbs: (await indexedDB.databases()).map((d) => d.name).sort().join() }));
  const during = log.app.slice(mark);
  ok(during.length === 0, "từ lúc mở hộp soạn tới lúc đóng (gõ, mở ba nền tảng, sao chép, email): trang LeNhip không gửi yêu cầu nào, kể cả về máy chủ của chính nó" + (during.length ? ": " + during.join(", ") : ""));
  ok(log.foreign.length === 3 && log.foreign.every((r, i) => r.navigation && r.referer === null && r.url === buildShareUrl(["threads", "x", "bluesky"][i], card)) && log.app.every((r) => r.split(" ")[1].startsWith(origin + "/")),
    "yêu cầu ra ngoài gốc của LeNhip chỉ là ba lần điều hướng của cửa sổ mới do người dùng bấm, không kèm Referer; trang LeNhip không gọi ra ngoài lần nào");
  ok(after.storage === before.storage && !after.storage.includes("đúng nhịp") && after.cookie === before.cookie && after.dbs === before.dbs, "không có gì được ghi lại: localStorage, sessionStorage, cookie và IndexedDB như trước khi chia sẻ");

  // ---------------------------------------------------------------- có địa chỉ công khai: ô kèm liên kết, Telegram và LINE
  await setPublic(page, PUBLIC);
  await page.click(".social-catalogue > summary");
  const catUrl = Object.fromEntries((await catalogue(page)).groups.flatMap((g) => g.items).map((x) => [x.id, x.status]));
  ok(["threads", "x", "telegram", "line", "bluesky"].every((id) => catUrl[id] === "Đang bật") && catUrl.facebook === "Chưa xác nhận", "có địa chỉ công khai: Telegram và LINE chuyển sang «Đang bật»; các mục khác không đổi");
  await openComposer(page);
  c = await composer(page);
  ok(c.checkbox === false && c.noUrl === null && c.fields.join() === "textarea:textarea#social-note,input:checkbox#social-include-link" && c.preview === NOTE && c.order.join() === "threads,x,telegram,line,bluesky,copy,email",
    "ô «Kèm liên kết LeNhip» có mặt và KHÔNG chọn sẵn; ô xem trước chưa có liên kết; Telegram và LINE hiện trong danh sách");
  const hrefs = (state) => Object.fromEntries(state.links.map((a) => [a.id, a.href]));
  ok(hrefs(c).telegram === null && hrefs(c).line === null && hrefs(c).x === buildShareUrl("x", card) && c.needLink === "Telegram và LINE chỉ nhận chia sẻ có liên kết. Chọn «Kèm liên kết LeNhip» để dùng.",
    "chưa kèm liên kết: Telegram và LINE chưa bấm được và có dòng giải thích");
  await page.check("#social-include-link");
  const linked = buildShareCard({ note: NOTE, includeLink: true, publicUrl: PUBLIC });
  c = await composer(page);
  ok(c.preview === NOTE + "\n" + PUBLIC && c.needLink === null && c.links.length === 5 && c.links.every((a) => a.href === buildShareUrl(a.id, linked) && a.href !== null) && c.mail === buildMailtoUrl({ subject: "LeNhip", body: linked.text }),
    "kèm liên kết: ô xem trước thêm đúng một dòng địa chỉ; cả năm href đúng bằng kết quả của trình dựng liên kết");
  const viaTelegram = await follow(desk.context, page, () => page.click("a[data-social-platform=telegram]"));
  c = await composer(page);
  statuses.push(c.status);
  ok(viaTelegram.url === buildShareUrl("telegram", linked) && new URL(viaTelegram.url).searchParams.get("url") === PUBLIC && c.status === `Đã mở cửa sổ của Telegram. ${UNKNOWN}`, "Telegram: cửa sổ mới nhận liên kết LeNhip ở tham số riêng và ghi chú ở tham số văn bản");
  await page.fill("#social-note", "");
  const only = buildShareCard({ note: "", includeLink: true, publicUrl: PUBLIC });
  c = await composer(page);
  ok(c.preview === PUBLIC && c.links.every((a) => a.href === buildShareUrl(a.id, only) && a.href !== null), "chỉ có liên kết, không ghi chú: vẫn chia sẻ được, href theo đúng trình dựng");
  await page.uncheck("#social-include-link");
  c = await composer(page);
  ok(c.preview === "Chưa có gì để chia sẻ. Hãy viết ghi chú hoặc chọn kèm liên kết LeNhip." && c.links.every((a) => a.href === null) && c.buttons.copy === false, "bỏ chọn liên kết và không có ghi chú: không còn gì để chia sẻ");
  await closeComposer(page);
  await setPublic(page, "http://lenhip.example/");
  await openComposer(page);
  c = await composer(page);
  ok(c.checkbox === null && c.order.join() === "threads,x,bluesky,copy,email", "địa chỉ không phải https bị coi là chưa có địa chỉ công khai");
  await closeComposer(page);

  // ---------------------------------------------------------------- bảng chia sẻ của thiết bị (navigator.share là BẢN THỬ)
  await setPublic(page, PUBLIC);
  await stubShare(page);
  await openComposer(page);
  await page.fill("#social-note", NOTE);
  await page.check("#social-include-link");
  c = await composer(page);
  ok(c.order.join() === "device,threads,x,telegram,line,bluesky,copy,email" && c.buttons.device === true, "trình duyệt có navigator.share: nút «Chia sẻ qua thiết bị» đứng đầu danh sách nơi nhận");
  const sheet = async (mode) => {
    await page.evaluate((m) => {
      window.__shareMode = m;
      window.__shared.length = 0;
      document.getElementById("social-status").textContent = "";
    }, mode);
    await page.click("button[data-social-target=device]");
    await page.waitForFunction(() => document.getElementById("social-status").textContent !== "");
    const state = await composer(page);
    statuses.push(state.status);
    return { status: state.status, got: await page.evaluate(() => window.__shared) };
  };
  const handed = await sheet("resolve");
  ok(handed.got.length === 1 && JSON.stringify(handed.got[0]) === JSON.stringify({ text: linked.text }) && handed.status === `Bảng chia sẻ của thiết bị đã nhận nội dung. ${UNKNOWN}`,
    "bảng chia sẻ (bản thử) nhận đúng văn bản của ô xem trước, không trường nào khác; LeNhip chỉ nói thiết bị đã nhận nội dung, không nói đã đăng");
  const aborted = await sheet("abort");
  ok(aborted.status === "Thiết bị báo bảng chia sẻ đã đóng mà chưa chia sẻ gì.", "bảng chia sẻ bị đóng (AbortError): nói đúng điều thiết bị báo, không coi là đã chia sẻ");
  const denied = await sheet("deny");
  const cannot = await sheet("cannot");
  ok(denied.status === "Thiết bị không mở được bảng chia sẻ. Bạn có thể dùng Sao chép." && cannot.status === denied.status && cannot.got.length === 0, "bảng chia sẻ bị từ chối hoặc canShare trả false: báo không mở được và chỉ sang Sao chép");
  ok(statuses.length === 11 && statuses.every((s) => s !== "" && !claimsPost(s)) && statuses.filter((s) => s.endsWith(UNKNOWN)).length === 5,
    "cả 11 câu trạng thái đã thấy (mở cửa sổ, sao chép, email, bảng chia sẻ nhận, đóng, từ chối) không câu nào khẳng định đã đăng, đã gửi hay thành công");
  await closeComposer(page);

  // ---------------------------------------------------------------- bản nháp thuộc về tài khoản, không được lưu
  await t.signIn(page, "dev_b");
  await page.waitForTimeout(300); // thông báo đầu tiên của tài khoản mới có thể mở sau khi nạp xong /v1/me
  await t.dismissNotice(page);
  await go(page, "connect");
  await openComposer(page);
  c = await composer(page);
  ok(c.note === "" && c.checkbox === false && c.preview.startsWith("Chưa có gì để chia sẻ"), "đổi sang tài khoản khác trên cùng trang: bản nháp của người trước không hiện ra; bản nháp mới không chọn sẵn ô kèm liên kết");
  await closeComposer(page);
  await desk.context.close();

  // ---------------------------------------------------------------- ba cỡ màn hình × cỡ chữ 100/200 % × năm phong cách
  let lowestPrimary = Infinity;
  let lowestMuted = Infinity;
  for (const [name, viewport] of SIZES) {
    const { context, page: p } = await t.open({ viewport, modules: { social: true, messaging: true, trackers: true }, reducedMotion: "reduce" });
    await watch(context, p);
    await t.dismissNotice(p);
    await setPublic(p, PUBLIC);
    await stubShare(p);
    await p.click(".social-catalogue > summary");
    for (const scale of [100, 200]) {
      for (const theme of THEMES) {
        await t.chooseSettings(p, { theme, fontSize: scale });
        const problems = await layoutProblems(p);
        if (!(await p.evaluate(() => document.querySelector(".social-catalogue").open))) problems.push("danh mục bị gập lại khi đổi phong cách");
        // Danh mục đang mở chiếm cả hàng của lưới Kết nối (ba phần cùng bật): một cột trên điện thoại và ở chữ 200 %, nhiều cột khi rộng.
        const columns = await p.evaluate(() => new Set([...document.querySelectorAll(".social-group[data-social-group=link_off] .social-platform")].map((li) => Math.round(li.getBoundingClientRect().left))).size);
        const wantColumns = scale === 200 || viewport.width <= 700 ? [1, 2] : viewport.width < 1181 ? [2, 2] : [3, 4];
        if (columns < wantColumns[0] || columns > wantColumns[1]) problems.push(`danh mục chia ${columns} cột`);
        await shot(p, `${viewport.width}x${viewport.height}-${scale}-${theme}-phan`, true);
        await openComposer(p);
        await p.fill("#social-note", LONG);
        await p.check("#social-include-link");
        await p.click("button[data-social-target=device]");
        await p.waitForFunction(() => document.getElementById("social-status").textContent !== "");
        problems.push(...(await layoutProblems(p)));
        const state = await composer(p);
        if (state.links.length !== 5 || state.links.some((a) => a.href === null) || state.error !== null) problems.push("hộp soạn không đủ năm liên kết với ghi chú 280 ký tự");
        // Dòng trạng thái ở cuối hộp phải cuộn tới được.
        const reach = await p.evaluate(() => {
          const dialog = document.getElementById("action-dialog");
          document.getElementById("social-status").scrollIntoView({ block: "end" });
          const r = document.getElementById("social-status").getBoundingClientRect();
          return r.top >= dialog.getBoundingClientRect().top && r.bottom <= innerHeight + 0.5;
        });
        if (!reach) problems.push("không cuộn tới được dòng trạng thái");
        const contrast = await contrasts(p);
        lowestPrimary = Math.min(lowestPrimary, contrast.primary.min);
        lowestMuted = Math.min(lowestMuted, contrast.muted.min);
        if (contrast.primary.min < 4.5) problems.push(`chữ chính ${contrast.primary.where} tương phản ${contrast.primary.min.toFixed(2)}:1`);
        // Chữ phụ dùng token --muted của khung: đạt 4,5:1, hoặc ít nhất không kém dòng phụ đề của chính khung trong cùng phong cách.
        if (contrast.muted.min < 4.5 && contrast.muted.min < contrast.shell.min - 0.01) problems.push(`chữ phụ ${contrast.muted.where} tương phản ${contrast.muted.min.toFixed(2)}:1, kém dòng phụ đề của khung (${contrast.shell.min.toFixed(2)}:1)`);
        await shot(p, `${viewport.width}x${viewport.height}-${scale}-${theme}-hop-soan`);
        await closeComposer(p);
        ok(problems.length === 0, `${name} ${viewport.width}×${viewport.height} · chữ ${scale} % · ${theme}: phần và hộp soạn không tràn ngang, vùng bấm từ 44 px, chữ chính tương phản từ 4,5:1` + (problems.length ? " — " + problems.join("; ") : ""));
      }
    }
    await context.close();
  }
  console.log(`  (tương phản thấp nhất đo được: chữ chính ${lowestPrimary.toFixed(2)}:1; chữ phụ theo token --muted của khung ${lowestMuted.toFixed(2)}:1)`);
  // Hai đầu của dải bề ngang được hỗ trợ, một phong cách: 360 px và 1920 px.
  for (const viewport of [{ width: 360, height: 740 }, { width: 1920, height: 1080 }]) {
    const { context, page: p } = await t.open({ viewport, modules: { social: true, messaging: true, trackers: true }, reducedMotion: "reduce" });
    await watch(context, p);
    await t.dismissNotice(p);
    await setPublic(p, PUBLIC);
    await stubShare(p);
    await p.click(".social-catalogue > summary");
    for (const scale of [100, 200]) {
      await t.chooseSettings(p, { theme: "orbit", fontSize: scale });
      const problems = await layoutProblems(p);
      await openComposer(p);
      await p.fill("#social-note", LONG);
      await p.check("#social-include-link");
      await p.click("button[data-social-target=device]");
      await p.waitForFunction(() => document.getElementById("social-status").textContent !== "");
      problems.push(...(await layoutProblems(p)));
      await shot(p, `${viewport.width}x${viewport.height}-${scale}-orbit-hop-soan`);
      await closeComposer(p);
      ok(problems.length === 0, `${viewport.width}×${viewport.height} · chữ ${scale} %: phần và hộp soạn không tràn ngang, vùng bấm từ 44 px` + (problems.length ? " — " + problems.join("; ") : ""));
    }
    await context.close();
  }

  // ---------------------------------------------------------------- chỉ dùng bàn phím
  const kb = await t.open({ modules: { social: true }, reducedMotion: "reduce" });
  const k = kb.page;
  const kbLog = await watch(kb.context, k);
  await t.dismissNotice(k);
  await setPublic(k, PUBLIC);
  await go(k, "home");
  await k.evaluate(() => document.activeElement?.blur());
  const active = () => k.evaluate(() => {
    const el = document.activeElement;
    return el?.dataset?.socialPlatform ?? el?.dataset?.socialTarget ?? el?.dataset?.nav ?? (el?.hasAttribute("data-social-open") ? "open" : el?.id || el?.localName);
  });
  const tabTo = async (want, limit = 30) => {
    for (let i = 0; i < limit; i++) {
      await k.keyboard.press("Tab");
      if ((await active()) === want) return true;
    }
    return false;
  };
  const reachedNav = await tabTo("connect");
  await k.keyboard.press("Enter");
  await k.waitForSelector("body[data-view=connect]", { state: "attached" });
  await k.keyboard.press("Tab");
  const firstStop = await active();
  await k.keyboard.press("Enter");
  await k.waitForSelector("#action-dialog[open] #social-note");
  const reachedNote = await tabTo("social-note", 3);
  await k.keyboard.type("Xin chào từ bàn phím");
  const stops = [];
  for (let i = 0; i < 8; i++) {
    await k.keyboard.press("Tab");
    stops.push(await active());
    // Phím cách chọn ô «Kèm liên kết LeNhip»; từ đó Telegram và LINE mới có href và mới nhận focus.
    if (stops.at(-1) === "social-include-link") await k.keyboard.press("Space");
  }
  ok(reachedNav && firstStop === "open" && reachedNote && stops.join() === "social-include-link,threads,x,telegram,line,bluesky,copy,email",
    "bàn phím: Tab tới Kết nối, Enter, Tab tới «Chia sẻ LeNhip», Enter mở hộp soạn; thứ tự Tab là ghi chú, ô liên kết, năm nền tảng, Sao chép, Email");
  // Từ Email lùi năm bước về X: Sao chép, Bluesky, LINE, Telegram, X.
  for (let i = 0; i < 5; i++) await k.keyboard.press("Shift+Tab");
  const onX = await active();
  const typed = buildShareCard({ note: "Xin chào từ bàn phím", includeLink: true, publicUrl: PUBLIC });
  const byEnter = await follow(kb.context, k, () => k.keyboard.press("Enter"));
  const kbState = await composer(k);
  ok(onX === "x" && kbState.checkbox === true && byEnter.url === buildShareUrl("x", typed) && kbState.status === `Đã mở cửa sổ của X (Twitter). ${UNKNOWN}` && kbLog.foreign.length === 1,
    "bàn phím: phím cách chọn kèm liên kết, Enter trên X mở cửa sổ mới tới đúng liên kết; dòng trạng thái không khẳng định đã đăng");
  await k.keyboard.press("Escape");
  await k.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  const backOnOpen = await active();
  await k.keyboard.press("Tab");
  const onSummary = await k.evaluate(() => document.activeElement?.localName === "summary");
  await k.keyboard.press("Enter");
  ok(backOnOpen === "open" && onSummary && (await k.evaluate(() => document.querySelector(".social-catalogue").open)), "bàn phím: Escape đóng hộp và trả focus về nút mở; Tab tới danh mục, Enter mở danh mục");
  await kb.context.close();

  // ---------------------------------------------------------------- tiếng Anh, và cờ mô-đun tắt
  const en = await t.open({ modules: { social: true }, locale: "en-US" });
  await watch(en.context, en.page);
  await t.dismissNotice(en.page);
  await go(en.page, "connect");
  await en.page.click(".social-catalogue > summary");
  const enCat = await catalogue(en.page);
  await openComposer(en.page);
  const enNote = "A day in rhythm 🙂 & more #1";
  await en.page.fill("#social-note", enNote);
  await follow(en.context, en.page, () => en.page.click("a[data-social-platform=bluesky]"));
  const enState = await composer(en.page);
  const enText = await en.page.evaluate(() => document.querySelector(".connect-section[data-section=social]").textContent + document.getElementById("action-dialog").textContent);
  ok(enCat.summary === "Catalogue of 34 platforms" && enCat.groups[0].title === "Share links switched on" && enState.title === "Share LeNhip" && enState.count === `${buildShareCard({ note: enNote }).graphemes}/280 characters` && enState.preview === enNote &&
    enState.status === "Opened the Bluesky window. LeNhip does not know whether you posted." && !/\bsocial\.[a-z]/.test(enText) && !/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(enText),
    "trình duyệt tiếng Anh: phần, danh mục, hộp soạn và câu trạng thái đều bằng tiếng Anh, không sót chuỗi tiếng Việt hay tên khóa");
  await en.context.close();
  const off = await t.open({ modules: { trackers: true }, path: "/#connect" });
  await t.dismissNotice(off.page);
  ok((await off.page.$(".connect-section[data-section=social]")) === null && (await off.page.$("[data-social-open]")) === null && (await off.page.getAttribute("body", "data-view")) === "connect", "cờ social chưa bật: màn hình Kết nối không có phần Mạng xã hội");
  await off.context.close();
});
