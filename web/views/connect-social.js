// Phần "Mạng xã hội" của màn hình Kết nối (LNH-T40, LNH-T41): chia sẻ ra từ thiết bị và danh mục 34 nền tảng.
//
// - «Chia sẻ LeNhip» mở hộp soạn: ghi chú người dùng tự gõ (tối đa 280 ký tự) và liên kết LeNhip nếu có địa chỉ công khai
//   (không chọn sẵn). Không có ô nào để chọn dữ liệu sức khỏe, lịch hay ngôi nhà; ctx cũng không mang dữ liệu sức khỏe.
// - Nơi nhận: bảng chia sẻ của thiết bị (chỉ khi trình duyệt có navigator.share), năm nền tảng có liên kết chia sẻ đang bật
//   (thẻ <a target="_blank" rel="noopener noreferrer"> thật, do chính người dùng bấm), Sao chép, Email (mailto:).
// - Mọi việc diễn ra trên thiết bị: tệp này không gọi máy chủ, không ghi gì vào bộ nhớ của trình duyệt, không lưu lịch sử.
//   Bản nháp chỉ nằm trong bộ nhớ của trang, theo tài khoản đang đăng nhập, mất khi tải lại trang.
// - Sau khi mở một nơi nhận, giao diện chỉ nói điều nó biết: cửa sổ đã mở, hoặc thiết bị đã nhận nội dung. LeNhip không biết
//   người dùng đã đăng hay chưa và không bao giờ nói «đã đăng».
// - Danh mục liệt kê đủ 34 nền tảng theo cách tới được từ trình duyệt, kèm trạng thái và mức bằng chứng (LNH-F26). Tên nền
//   tảng là chữ, không logo, không liên kết. KHÔNG tài khoản nền tảng thật nào liên kết được ở bản dựng này (LNH-F21).
// - Địa chỉ công khai của LeNhip hiện chưa có (LNH-Q13). Giá trị được đưa vào qua setPublicUrl(); mặc định là chưa có, khi đó
//   không có ô kèm liên kết, và Telegram, LINE (bắt buộc có liên kết) không hiện trong hộp soạn.
//
// Hợp đồng của một phần: web/views/connect.js. Kiểu riêng: web/views/connect-social.css. Chuỗi: khóa `social.*` trong
// web/shared/i18n-<ngôn ngữ>-social.js. Quy tắc dựng thẻ và liên kết: web/shared/share-card.js, web/shared/social-registry.js.
import { SOCIAL_PLATFORMS, SHARE_REACHES, platformById, shareReach, shareStatus, shareLinkPlatforms, buildShareUrl, buildMailtoUrl } from "../shared/social-registry.js";
import { NOTE_LIMIT, NOTE_UNIT_LIMIT, buildShareCard, normalizePublicUrl } from "../shared/share-card.js";

/** Tiêu đề thư: chỉ là tên sản phẩm, giống nhau ở mọi ngôn ngữ; nội dung thư là đúng văn bản trong ô xem trước. */
const MAIL_SUBJECT = "LeNhip";
/** Trạng thái trong danh mục → kiểu viên nhãn. Trạng thái luôn có chữ, không chỉ phân biệt bằng màu. */
const TONE = { on: "ok", wait_url: "warn", unconfirmed: "muted", app_scheme: "muted", needs_id: "muted", sheet_only: "muted" };

/** Địa chỉ công khai của LeNhip đã qua normalizePublicUrl(), hoặc null khi chưa có. */
let publicUrl = null;
/** Bản nháp trong bộ nhớ của trang, thuộc về một tài khoản; đổi tài khoản thì bỏ. */
let draft = { user: null, note: "", includeLink: false };

/**
 * Đặt địa chỉ công khai của LeNhip (null là chưa có). Giá trị không hợp lệ bị coi là chưa có. Phần được vẽ lại ở lần render
 * kế tiếp của ứng dụng.
 */
export function setPublicUrl(value) {
  publicUrl = normalizePublicUrl(value);
  return publicUrl;
}

function platformItem(ctx, p, hasUrl) {
  const status = shareStatus(p, hasUrl);
  return (
    '<li class="social-platform" data-social-item="' + p.id + '"><span class="social-platform-name">' + ctx.safe(p.name) + "</span>" +
    '<span class="status-chip ' + TONE[status] + '">' + ctx.tSafe("social.status." + status) + "</span>" +
    '<span class="social-evidence">' + ctx.tSafe("social.evidence.label", { grade: ctx.t("social.evidence." + p.evidence) }) + "</span></li>"
  );
}

function catalogue(ctx) {
  const hasUrl = publicUrl !== null;
  const real = SOCIAL_PLATFORMS.filter((p) => shareReach(p) !== null);
  const groups = SHARE_REACHES.map((reach) => {
    const items = real.filter((p) => shareReach(p) === reach);
    return (
      '<div class="social-group" role="group" aria-labelledby="social-group-' + reach + '" data-social-group="' + reach + '">' +
      '<h3 class="social-subhead" id="social-group-' + reach + '"><span>' + ctx.tSafe("social.group." + reach + ".title") + '</span><span class="tiny-pill">' + ctx.safe(ctx.formatNumber(items.length)) + "</span></h3>" +
      '<p class="fine-print">' + ctx.tSafe("social.group." + reach + ".note") + "</p>" +
      '<ul class="social-platforms">' + items.map((p) => platformItem(ctx, p, hasUrl)).join("") + "</ul></div>"
    );
  });
  return (
    '<details class="social-catalogue"><summary>' + ctx.tSafe("social.catalogue.summary", { n: real.length }) + "</summary>" +
    '<p class="fine-print">' + ctx.tSafe("social.catalogue.intro") + "</p>" +
    '<p class="social-no-account">' + ctx.tSafe("social.catalogue.noAccount") + "</p>" +
    groups.join("") + "</details>"
  );
}

function composerHtml(ctx, o) {
  const link = (p) =>
    '<a class="button secondary social-target" data-social-platform="' + p.id + '" target="_blank" rel="noopener noreferrer"><span>' + ctx.safe(p.name) + '</span><span aria-hidden="true">↗</span>' +
    '<span class="social-sr">, ' + ctx.tSafe("social.target.newWindow") + "</span></a>";
  return (
    '<div class="social-composer">' +
    '<p class="fine-print">' + ctx.tSafe("social.composer.intro") + "</p>" +
    '<div class="field"><label for="social-note">' + ctx.tSafe("social.composer.noteLabel") + "</label>" +
    '<textarea id="social-note" rows="4" maxlength="' + NOTE_UNIT_LIMIT + '" autocomplete="off" dir="auto" aria-describedby="social-note-count social-note-error"></textarea>' +
    '<span class="fine-print" id="social-note-count"></span><span class="social-error" id="social-note-error" role="alert" hidden></span></div>' +
    (o.hasUrl
      ? '<label class="social-check"><input type="checkbox" id="social-include-link"><span><strong>' + ctx.tSafe("social.composer.includeLink") + '</strong><span class="social-url">' + ctx.safe(publicUrl) + "</span></span></label>"
      : '<p class="fine-print" id="social-no-url">' + ctx.tSafe("social.composer.noPublicUrl", { names: o.needNames }) + "</p>") +
    '<h3 class="social-subhead">' + ctx.tSafe("social.composer.previewTitle") + "</h3>" +
    '<p class="social-preview" id="social-preview" dir="auto"></p>' +
    '<p class="fine-print">' + ctx.tSafe("social.composer.previewNote") + "</p>" +
    '<h3 class="social-subhead" id="social-targets-title">' + ctx.tSafe("social.composer.targetsTitle") + "</h3>" +
    '<div class="social-targets" id="social-targets" role="group" aria-labelledby="social-targets-title">' +
    (o.canSheet ? '<button type="button" class="button primary social-target" data-social-target="device">' + ctx.icon("share") + "<span>" + ctx.tSafe("social.target.device") + "</span></button>" : "") +
    o.links.map(link).join("") +
    '<button type="button" class="button secondary social-target" data-social-target="copy">' + ctx.icon("copy") + "<span>" + ctx.tSafe("social.target.copy") + "</span></button>" +
    '<a class="button secondary social-target" data-social-target="email">' + ctx.icon("mail") + "<span>" + ctx.tSafe("social.target.email") + "</span></a>" +
    "</div>" +
    (o.hasUrl ? '<p class="fine-print" id="social-need-link" hidden>' + ctx.tSafe("social.composer.needLink", { names: o.needNames }) + "</p>" : "") +
    '<p class="social-status" id="social-status" role="status" aria-live="polite"></p>' +
    '<p class="privacy-note">' + ctx.icon("lock") + "<span>" + ctx.tSafe("social.composer.footer") + "</span></p>" +
    "</div>"
  );
}

/** Thẻ <a> chỉ là liên kết khi có href. Chưa có gì để chia sẻ thì gỡ href: không bấm được, không nhận focus. */
function setHref(a, href) {
  if (href) {
    a.setAttribute("href", href);
    a.removeAttribute("role");
    a.removeAttribute("aria-disabled");
  } else {
    a.removeAttribute("href");
    a.setAttribute("role", "link");
    a.setAttribute("aria-disabled", "true");
  }
}

function openComposer(ctx) {
  const user = ctx.me?.user.id ?? null;
  if (draft.user !== user) draft = { user, note: "", includeLink: false };
  const hasUrl = publicUrl !== null;
  if (!hasUrl) draft.includeLink = false;
  const needUrl = SOCIAL_PLATFORMS.filter((p) => p.enabled && p.needs_url);
  const body = ctx.openDialog(
    ctx.t("social.composer.title"),
    // Bảng chia sẻ của thiết bị chỉ được mời khi trình duyệt này có Web Share API.
    composerHtml(ctx, { hasUrl, links: shareLinkPlatforms(hasUrl), needNames: ctx.formatList(needUrl.map((p) => p.name)), canSheet: typeof navigator.share === "function" }),
  );
  const noteEl = body.querySelector("#social-note");
  const linkEl = body.querySelector("#social-include-link");
  const countEl = body.querySelector("#social-note-count");
  const errorEl = body.querySelector("#social-note-error");
  const previewEl = body.querySelector("#social-preview");
  const needLinkEl = body.querySelector("#social-need-link");
  const statusEl = body.querySelector("#social-status");
  const targets = body.querySelector("#social-targets");
  const mailEl = targets.querySelector("a[data-social-target=email]");
  let card = buildShareCard({ note: "" });
  let sharing = false;
  const say = (text) => {
    statusEl.textContent = text;
  };

  const update = () => {
    draft.note = noteEl.value;
    draft.includeLink = linkEl?.checked === true;
    card = buildShareCard({ note: draft.note, includeLink: draft.includeLink, publicUrl });
    const tooLong = card.code === "NOTE_TOO_LONG" ? ctx.t("social.composer.tooLong", { limit: NOTE_LIMIT }) : "";
    countEl.textContent = ctx.t("social.composer.count", { used: card.graphemes, limit: NOTE_LIMIT });
    if (errorEl.textContent !== tooLong) errorEl.textContent = tooLong;
    errorEl.hidden = tooLong === "";
    noteEl.setAttribute("aria-invalid", String(tooLong !== ""));
    // Ô xem trước là đúng văn bản sẽ được đưa đi (textContent, không phải HTML).
    previewEl.textContent = card.ok ? card.text : tooLong || ctx.t(hasUrl ? "social.composer.previewEmptyLink" : "social.composer.previewEmpty");
    previewEl.classList.toggle("social-preview-empty", !card.ok);
    for (const a of targets.querySelectorAll("a[data-social-platform]")) setHref(a, card.ok ? buildShareUrl(a.dataset.socialPlatform, card) : null);
    setHref(mailEl, card.ok ? buildMailtoUrl({ subject: MAIL_SUBJECT, body: card.text }) : null);
    for (const b of targets.querySelectorAll("button[data-social-target]")) b.disabled = !card.ok;
    if (needLinkEl) needLinkEl.hidden = !(card.ok && card.url === null && needUrl.length > 0);
  };

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      say(ctx.t("social.result.copied"));
    } catch {
      // Không có quyền hoặc trình duyệt không có Clipboard API: chọn sẵn văn bản để người dùng tự sao chép.
      const range = document.createRange();
      range.selectNodeContents(previewEl);
      const selection = getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      say(ctx.t("social.result.copyFailed"));
    }
  };

  const viaDevice = async (text) => {
    if (sharing) return;
    sharing = true;
    try {
      const data = { text };
      if (typeof navigator.canShare === "function" && !navigator.canShare(data)) throw new Error("canShare");
      await navigator.share(data);
      // Lời hứa của Web Share API chỉ cho biết thiết bị đã nhận nội dung, không cho biết nó đi đâu hay đã được đăng chưa.
      say(ctx.t("social.result.sheetHanded"));
    } catch (e) {
      say(ctx.t(e?.name === "AbortError" ? "social.result.sheetClosed" : "social.result.sheetFailed"));
    } finally {
      sharing = false;
    }
  };

  const onTarget = (event) => {
    const el = event.target.closest("[data-social-platform], [data-social-target]");
    if (!el || !targets.contains(el) || !card.ok) return;
    if (el.dataset.socialPlatform) {
      // Liên kết do chính người dùng bấm mở trong cửa sổ mới. LeNhip không nhận lại gì từ cửa sổ đó.
      if (el.hasAttribute("href")) say(ctx.t("social.result.opened", { name: platformById(el.dataset.socialPlatform)?.name ?? "" }));
    } else if (el.dataset.socialTarget === "email") {
      if (el.hasAttribute("href")) say(ctx.t("social.result.mailOpened"));
    } else if (event.type !== "click") {
      return;
    } else if (el.dataset.socialTarget === "copy") {
      void copy(card.text);
    } else if (el.dataset.socialTarget === "device") {
      void viaDevice(card.text);
    }
  };

  noteEl.value = draft.note;
  if (linkEl) linkEl.checked = draft.includeLink;
  noteEl.addEventListener("input", () => {
    say("");
    update();
  });
  linkEl?.addEventListener("change", () => {
    say("");
    update();
  });
  targets.addEventListener("click", onTarget);
  // Bấm nút giữa chuột cũng mở liên kết trong thẻ mới.
  targets.addEventListener("auxclick", (event) => {
    if (event.button === 1) onTarget(event);
  });
  update();
}

export default {
  id: "social",
  order: 10,
  // Cờ `social` tắt khi chưa đặt rõ (LNH-F27, LNH-T45).
  visible: (ctx) => ctx.modules.social === true,
  render: (ctx) =>
    '<div class="section-heading"><h2>' + ctx.icon("share") + ctx.tSafe("connect.social.title") + '</h2><span class="tiny-pill">' + ctx.tSafe("social.section.pill") + "</span></div>" +
    '<p class="social-lead">' + ctx.tSafe("social.section.lead") + "</p>" +
    '<button type="button" class="button primary social-open" data-social-open>' + ctx.icon("share") + "<span>" + ctx.tSafe("social.section.open") + "</span></button>" +
    '<p class="privacy-note">' + ctx.icon("lock") + "<span>" + ctx.tSafe("social.section.noPicker") + "</span></p>" +
    '<h3 class="social-subhead">' + ctx.tSafe("social.link.title") + "</h3>" +
    '<p class="empty-state">' + ctx.tSafe("social.link.none") + "</p>" +
    catalogue(ctx),
  bind(ctx, el) {
    el.querySelector("[data-social-open]").addEventListener("click", () => openComposer(ctx), { signal: ctx.signal });
  },
};
