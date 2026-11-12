// LeNhip web (bản tham chiếu): 5 phương án giao diện của gói V1.0, nối với API /v1 theo LNH-SRS-001 V1.1.
// - Lịch và đèn đi qua plan → xem lại nội dung đã chuẩn hóa → xác nhận trong 120 giây → worker → bằng chứng; giao diện chỉ hiện
//   trạng thái theo bằng chứng, có màn hình "Chưa xác minh kết quả" (SRS mục 13).
// - Sức khỏe tính trên thiết bị bằng LNH-SLEEP-1 với dữ liệu tổng hợp; không gửi gì về máy chủ (SRS mục 05, 06, 07).
// - Chữ LeLe theo hình đã chốt (shared/lele-mark.js). LeLe chỉ đề xuất; người dùng xác nhận qua plan (SRS mục 04, 24).
// Khung V1.0.0 (docs/THIET_KE_V1_0_0.md; «LNH-T20», «LNH-F25»… là mã quyết định và phát hiện trong tài liệu đó):
// - Màn hình lấy từ sổ đăng ký web/views/index.js; điều hướng, địa chỉ #id và <main> dựng từ một chỗ. Màn hình có trạng thái
//   được mount một lần, render nền chỉ gọi update (không dựng lại DOM). Mô-đun mới nhận `ctx` (makeCtx), không import tệp này.
// - Chữ LeNhip đổi theo phong cách (shared/brand.js, T20); icon ứng dụng luôn là I01.
// - Ngôn ngữ (LNH-T21..LNH-T29): mọi chữ hiển thị lấy từ catalog qua t() (shared/i18n.js, tệp shared/i18n-<ngôn ngữ>.js); tệp này
//   không chứa câu chữ nào. Catalog nạp trước lần vẽ đầu; ô chọn ngôn ngữ ở đầu hộp Cá nhân hóa và trên Thông báo đầu tiên; đổi
//   ngôn ngữ thì vẽ lại, không nạp lại trang, và bị từ chối khi một kế hoạch đang chờ đồng ý. Bản không phải tiếng Việt là bản
//   dịch máy chưa rà soát và giao diện nói rõ điều đó. Máy chủ không biết ngôn ngữ của người dùng: lỗi và câu trả lời hiển
//   thị được dựng từ mã (LNH-T23). Không văn bản đã dịch nào đi vào payload hay digest (LNH-T26).
import { THEMES, FONT_SIZES, ZONES, defaults, sanitizeSettings, restorePrefs, inkFor, SettingsFileError } from "./model.js";
import { Api, ApiError } from "./api.js";
import { buildViews, planKinds, isStateful, BAR_LIMIT } from "./views/index.js";
import { wordmark } from "./shared/brand.js";
import {
  LOCALES, PARTS, SOURCE_LOCALE, LANGUAGE_WORD, isLocale, localeInfo, resolveLocale, loadLocale, setLocale, getLocale, hasCatalog, hasMessage, messageLocale,
  t, tParts, tSource, localizeStatic, formatNumber, formatDate, formatWeekday, formatWeekdayCompact, formatTime24, formatDuration as formatMinutes, formatDurationParts, formatList,
} from "./shared/i18n.js";
import { leleMark } from "./shared/lele-mark.js";
import { scanLele, leleBlock } from "./shared/lele-lexicon.js";
import { digestJcs } from "./shared/jcs.js";
import { computeHealthDays, sleepMessage } from "./shared/sleep.js";
import { consentText, consentReceipt } from "./shared/consent-text.js";
import { healthInputFor, onHealthInputChanged } from "./shared/health-input.js";
import { localParts, localDate, addDays, zonedToInstant } from "./shared/zone.js";

const KEY = "lenhip.ui.v2";
// Số phiên bản và mã đặc tả in ở chân trang: dữ liệu, không dịch. Đổi ở đây khi phát hành.
const APP_VERSION = "0.1.0";
const SPEC_ID = "LNH-SRS-001 V1.1";
const $ = (id) => document.getElementById(id);
const glyphs = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  today: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-12 5 2 2 5-4"/>',
  health: '<path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
  work: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V4h8v3M3 12c5 3 13 3 18 0m-9 0v4"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>',
  moon: '<path d="M20 13a8.5 8.5 0 0 1-9-10A9 9 0 1 0 20 13Z"/>',
  steps: '<path d="m8 13-4 6m11-6 4 6M8 9l4 3 3-5m-3 5-3 4m3-4 4 1"/><circle cx="15" cy="4" r="2"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  spark: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  lamp: '<path d="m7 3-4 8h12l-4-8zM9 11v10M5 21h8m1-14 5 3v11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  robot: '<rect x="5" y="6" width="14" height="12" rx="4"/><path d="M12 2v4M2 10v5m20-5v5M8 21h8m-7-8h6"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5m0 3v.01"/>',
  // Glyph thêm ở V1.0.0 cho Tin nhắn, Kết nối và các phần của chúng (cùng lưới 24, nét 1.7 như trên).
  messages: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M8 10h8m-8 3h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="5.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="m8.2 10.8 7.6-4.1m-7.6 6.5 7.6 4.1"/>',
  send: '<path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="m10 13 4-4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  tablet: '<rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M11 18h2"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19h19"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6m-3-4v4"/>',
  watch: '<rect x="7" y="7" width="10" height="10" rx="3"/><path d="M9 7V3.5h6V7M9 17v3.5h6V17m-3-6.5V12l1 1"/>',
  bluetooth: '<path d="m7 7.5 10 9-5 4.5V3l5 4.5-10 9"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6m-6 4h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18m0-18c-3 3.2-3 14.8 0 18"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  trash: '<path d="M4 7h16M10 7V4h4v3m-7 0 1 13h8l1-13"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  flag: '<path d="M5 21V4m0 1h12l-2 4 2 4H5"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8m-3 3 2.5 2.5M13.5 8.5 15 10"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 13a8 8 0 0 0 14.5 4"/><path d="M5 3v4h4m10 14v-4h-4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20v-1a6.5 6.5 0 0 1 13 0v1"/><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.5a6 6 0 0 1 3.5 5.5"/>',
};
const icon = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (glyphs[name] || glyphs.spark) + "</svg>";
const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const api = new Api();
let prefs = restorePrefs(readStore(KEY));
let me = null; // GET /v1/me
let online = false;
// Màn hình muốn mở theo địa chỉ #id. Có hợp lệ và có hiển thị với tài khoản này không thì resolveView() xét lúc vẽ, sau khi
// đã có /v1/me (màn hình của mô-đun mới phụ thuộc cờ trong me.modules).
let screen = location.hash.slice(1) || "home";
let context = "personal";
let toastTimer;
let draftSettings;
let availability = null;
let devices = [];
let site = null;
let actions = [];
let health = null;
let healthFrom = { kind: "synthetic" };
let pendingPlan = null; // { plan, input, label, digestOk }
let countdownTimer = null;
const tracked = new Set();

function readStore(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeStore(k, v) {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch {
    toast(t("settings.storeBlocked"));
    return false;
  }
}
const sub = () => me?.user.id ?? prefs.activeSub ?? "khach";
const settings = () => prefs.users[sub()] ?? (prefs.users[sub()] = defaults(me?.user.name ?? ""));
/** Tên hiển thị. Để trống thì dùng chữ «Bạn» của ngôn ngữ đang chọn; chữ đó không được lưu vào thiết lập. */
const displayName = () => settings().name || t("common.you");
const zone = () => settings().zone;
function savePrefs() {
  prefs.activeSub = sub();
  return writeStore(KEY, JSON.stringify(prefs));
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4500);
}
function hhmm(iso) {
  if (!iso) return "—";
  const p = localParts(Date.parse(iso), zone());
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
function hhmmss(iso) {
  if (!iso) return "—";
  const p = localParts(Date.parse(iso), zone());
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
}
// Dòng ngày ở đầu Hôm nay: thứ và ngày tháng theo ngôn ngữ đang chọn (Intl), ở múi phân tích. Chữ hoa do CSS của .eyebrow.
function dateLine() {
  const now = api.serverNow();
  return t("home.dateLine", { weekday: formatWeekday(now, "long", zone()), date: formatDate(now, { day: "numeric", month: "long", timeZone: zone() }) });
}

// ---------------------------------------------------------------- chữ: mọi câu lấy từ catalog, ghép vào HTML qua các hàm dưới đây
const tSafe = (key, params) => safe(t(key, params));
/** Tên lấy từ dữ liệu (người dùng, đèn, site): cô lập hướng chữ để tên viết theo chiều khác không làm đảo câu của giao diện. */
const bdi = (value) => "<bdi>" + safe(value) + "</bdi>";
/** Ngôn ngữ đang hiện có phải bản dịch máy chưa rà soát không (LNH-T21). Catalog chưa nạp được thì chữ đang hiện là bản gốc. */
const draftUi = () => localeInfo().draft && hasCatalog(getLocale());
/** Đoạn tiếng Việt cố định đặt trong câu của ngôn ngữ khác (tiêu đề sự kiện lịch, câu lệnh mẫu của LeLe): mang lang="vi". */
const viSpan = (text) => (getLocale() === SOURCE_LOCALE ? safe(text) : '<span lang="' + SOURCE_LOCALE + '">' + safe(text) + "</span>");
/** Tiêu đề mà máy chủ ghi vào lịch: luôn là câu tiếng Việt này ở mọi ngôn ngữ, vì nó nằm trong payload và phép đọc lại (LNH-T26). */
const calendarTitle = () => tSource("calendar.title.PERSONAL_TIME");
/** Một bản dịch nhắc nguyên văn tiêu đề lịch (văn bản đồng ý): đánh dấu đoạn đó là tiếng Việt. `html` đã được thoát ký tự. */
function markCalendarTitle(html) {
  if (getLocale() === SOURCE_LOCALE) return html;
  const title = safe(calendarTitle());
  return html.split(title).join('<span lang="' + SOURCE_LOCALE + '">' + title + "</span>");
}
/**
 * Thông điệp có chỗ chèn HTML tin cậy của ứng dụng: phần chữ của bản dịch được thoát ký tự, tham số có tên trong `slots` được
 * thay bằng HTML đã cho (chữ LeLe, tên trong <bdi>, đoạn có lang riêng). Bản dịch vẫn là văn bản thuần, không chứa HTML.
 */
function rich(key, slots, params = {}) {
  const all = { ...params };
  for (const name of Object.keys(slots)) all[name] = "";
  return tParts(key, all).map((p) => (p.type === "param" && Object.hasOwn(slots, p.name) ? slots[p.name] : safe(p.value))).join("");
}
/** Tiêu đề nhiều dòng: bản dịch tự đặt chỗ xuống dòng bằng ký tự xuống dòng. */
const lines = (key) => tSafe(key).replaceAll("\n", "<br>");
/** Số kèm đơn vị trong ô số liệu: phần số giữ cỡ lớn, phần chữ của bản dịch (đơn vị) in nhỏ. */
function withUnit(key, n) {
  return tParts(key, { n }).map((p) => (p.type === "param" ? safe(p.value) : p.value.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_, a, b, c) => a + (b ? "<small>" + safe(b) + "</small>" : "") + c))).join("");
}
/** Thời lượng (giây, làm tròn xuống phút như LNH-SLEEP-1) dựng từ các phần của Intl: đơn vị in nhỏ, không đọc lại chuỗi đã định dạng. */
const durationHtml = (seconds) => formatDurationParts(Math.floor(seconds / 60)).map((p) => (p.type === "unit" ? "<small>" + safe(p.value) + "</small>" : safe(p.value))).join("");
const durationText = (seconds) => formatMinutes(Math.floor(seconds / 60));
/** Nối các ý độc lập bằng dấu chấm giữa của ngôn ngữ đang chọn; bỏ ý rỗng. */
const dotJoin = (items) => items.filter(Boolean).reduce((a, b) => t("common.dot", { a, b }));
/**
 * Tra một khóa theo lớp ở phần lõi rồi ở từng phần mô-đun: `state.UNKNOWN`, rồi `msg.state.UNKNOWN`, `social.state.UNKNOWN`…
 * Không có khóa, hoặc thông điệp cần tham số mà nơi gọi không có, thì trả null.
 */
function lookupLabel(suffix, params) {
  for (const prefix of ["", ...PARTS.map((part) => part + ".")]) {
    const key = prefix + suffix;
    if (!hasMessage(key)) continue;
    try {
      return t(key, params);
    } catch {
      return null;
    }
  }
  return null;
}
/**
 * Nhãn của một mã do máy chủ trả (lớp `state`, `outcome`, `reason`, `grade`): khóa `<lớp>.<MÃ>`, mô-đun khai mã riêng ở
 * `<phần>.<lớp>.<MÃ>` (ví dụ `social.outcome.POSTED`). Chưa có nhãn thì trả null và nơi gọi in nguyên mã.
 */
function codeLabel(cls, code, params) {
  if (typeof code !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code)) return null;
  return lookupLabel(cls + "." + code, params);
}

// ---------------------------------------------------------------- LeLe
const mark = (tone = "amber", cls = "") => leleMark({ tone, className: cls });
const askLele = () => '<button class="ask-lele" data-action="chat"><span class="mini-orb"></span><span class="ask-copy">' + rich("lele.ask", { lele: mark("amber", "inline") }) + "</span>" + icon("spark") + "</button>";

// ---------------------------------------------------------------- khung
function themeButton(th, inSettings = false) {
  const isActive = (inSettings ? draftSettings.theme : settings().theme) === th.id;
  const swatch = '<span class="palette">' + th.colors.map((c) => '<i style="background:' + c + '"></i>').join("") + "</span>";
  if (inSettings) return '<button type="button" class="settings-theme ' + (isActive ? "active" : "") + '" data-draft-theme="' + th.id + '" aria-pressed="' + isActive + '">' + swatch + th.code + "</button>";
  return '<button class="theme-option ' + (isActive ? "active" : "") + '" data-theme-choice="' + th.id + '" aria-pressed="' + isActive + '">' + swatch + "<span><strong>" + tSafe("theme." + th.id + ".name") + "</strong><small>" + tSafe("theme.option.meta", { code: th.code, description: t("theme." + th.id + ".description") }) + "</small></span>" + (isActive ? '<span class="selection-check">' + icon("check") + "</span>" : "") + "</button>";
}
// Sổ đăng ký màn hình (web/views/index.js). Bốn màn hình gốc vẫn vẽ bằng các hàm home/health_/work/house bên dưới.
const VIEWS = buildViews({ home, health: health_, work, house });
const PLAN_KINDS = planKinds(VIEWS);
/** Chỉ thay DOM khi HTML đổi: giữ focus bàn phím và hoạt ảnh qua các lần render nền. */
const lastHtml = new WeakMap();
function setHtml(el, html) {
  if (lastHtml.get(el) === html) return false;
  // Nút đang có focus nằm trong vùng sắp thay (ví dụ vừa bấm chọn phong cách bằng bàn phím): tìm lại nút tương ứng sau khi thay.
  const active = el.contains(document.activeElement) ? document.activeElement : null;
  const key = active?.id ? "#" + CSS.escape(active.id) : active && Object.keys(active.dataset).length ? active.localName + Object.entries(active.dataset).map(([k, v]) => "[data-" + k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + '="' + CSS.escape(v) + '"]').join("") : null;
  el.innerHTML = html;
  lastHtml.set(el, html);
  if (key) el.querySelector(key)?.focus({ preventScroll: true });
  return true;
}
function applyTheme() {
  const s = settings();
  document.body.dataset.theme = s.theme;
  document.body.classList.toggle("reduced-motion", s.reducedMotion);
  document.body.classList.toggle("compact", s.compact);
  document.documentElement.style.setProperty("--font-scale", s.fontSize / 100);
  document.body.classList.toggle("large-text", s.fontSize >= 150);
  if (s.accent) {
    document.body.style.setProperty("--accent", s.accent);
    document.body.style.setProperty("--accent-ink", inkFor(s.accent));
  } else {
    document.body.style.removeProperty("--accent");
    document.body.style.removeProperty("--accent-ink");
  }
  // Chữ tắt của tên: ký tự đầu (theo điểm mã, không cắt đôi ký tự ngoài BMP) của hai từ cuối.
  $("profile-button").textContent = displayName().trim().split(/\s+/).slice(-2).map((x) => Array.from(x)[0] ?? "").join("").toLocaleUpperCase(getLocale());
  // Màu thanh trình duyệt và thanh trạng thái của bản cài (PWA) đi theo nền của phong cách.
  const themeColor = getComputedStyle(document.body).getPropertyValue("--bg").trim();
  if (/^#[0-9a-f]{6}$/i.test(themeColor)) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
}
// Chữ LeNhip theo phong cách đang chọn (LNH-T20): Quỹ đạo L01, Không gian đêm L02, Nhịp an L03, Dòng thời gian L04, Titanium L05.
function brand() {
  const svg = wordmark(settings().theme, { label: t("brand.name") });
  setHtml($("brand-side"), svg);
  setHtml($("brand-top"), svg);
}
function isVisible(view) {
  try {
    return view.visible(baseCtx) === true;
  } catch (e) {
    console.error(e);
    return false;
  }
}
/** Màn hình đang hiện: màn hình muốn mở nếu có và được phép hiện, không thì Hôm nay. */
function resolveView() {
  const wanted = VIEWS.find((v) => v.id === screen);
  const view = wanted && isVisible(wanted) ? wanted : VIEWS.find((v) => v.id === "home");
  // Chỉ sửa địa chỉ khi đã có /v1/me: trước đó chưa biết mô-đun nào bật, giữ nguyên #id để mở đúng màn hình sau khi nạp.
  if (me && view.id !== screen) {
    screen = view.id;
    history.replaceState(null, "", "#" + screen);
  }
  return view;
}
function navButton(v, current) {
  let badge = null;
  try {
    badge = v.nav.badge?.(baseCtx) ?? null;
  } catch (e) {
    console.error(e);
  }
  return '<button class="nav-button" data-nav="' + v.id + '" ' + (current ? 'aria-current="page"' : "") + ">" + icon(v.nav.icon) + '<span class="nav-label">' + safe(v.nav.label(baseCtx)) + "</span>" +
    (badge ? '<span class="nav-badge" role="img" aria-label="' + safe(badge.label ?? "") + '">' + safe(badge.text ?? "") + "</span>" : "") + "</button>";
}
// Thanh bên (từ 701 px) có mọi màn hình đang hiển thị; thanh dưới của điện thoại chỉ có các mục nav.bar, tối đa năm
// (LNH-T51). Mục còn lại (Kết nối) vào được từ hộp Tài khoản.
function nav(current) {
  const visible = VIEWS.filter(isVisible);
  setHtml($("desktop-nav"), visible.map((v) => navButton(v, v === current)).join(""));
  setHtml($("mobile-nav"), visible.filter((v) => v.nav.bar).slice(0, BAR_LIMIT).map((v) => navButton(v, v === current)).join(""));
}
function contextControl() {
  return '<div class="context-switch" role="group" aria-label="' + tSafe("context.label") + '">' + [["personal", "person", "context.personal"], ["work", "work", "context.work"]].map(([id, i, key]) => '<button data-context="' + id + '" class="' + (context === id ? "active" : "") + '" aria-pressed="' + (context === id) + '">' + icon(i) + tSafe(key) + "</button>").join("") + "</div>";
}
function orb(sceneClass = "") {
  return '<div class="orb-scene ' + sceneClass + '" aria-hidden="true"><div class="orbit-ring"></div><div class="orbit-ring second"></div><div class="orb"><span class="orb-label">' + leleMark({ tone: "duo", label: false }) + "</span></div></div>";
}
function banner() {
  const b = $("banner");
  if (!online) {
    b.hidden = false;
    b.className = "banner warn";
    setHtml(b, icon("alert") + "<span>" + tSafe("banner.offline") + "</span>");
  } else if (me && !me.dispatch_open) {
    b.hidden = false;
    b.className = "banner warn";
    setHtml(b, icon("lock") + "<span>" + tSafe("banner.dispatchClosed") + "</span>");
  } else {
    b.hidden = true;
  }
}

// ---------------------------------------------------------------- dữ liệu
async function loadMe() {
  me = await api.get("/v1/me");
  online = true;
}
function computeHealth() {
  if (!healthConsent()) {
    health = null;
    healthFrom = { kind: "synthetic" };
    return;
  }
  // Nguồn mặc định là dữ liệu tổng hợp; dữ liệu người dùng tự nhập trên thiết bị này (LNH-T55) được hỏi trước.
  const found = healthInputFor({ sub: sub(), nowMs: api.serverNow(), zone: zone(), revision: healthRevision() });
  health = computeHealthDays(found.input);
  healthFrom = found.provenance;
}
/** Dữ liệu sức khỏe đang hiện có phải là dữ liệu tổng hợp của bản tham chiếu không. */
function healthSynthetic() {
  return healthFrom.kind !== "import";
}
function healthKey() {
  return `lenhip.health.v1.${sub()}`;
}
function healthState() {
  try {
    return JSON.parse(readStore(healthKey()) ?? "null");
  } catch {
    return null;
  }
}
function healthConsent() {
  const s = healthState();
  return !!s && s.receipt?.choice === "GRANTED" && !s.receipt.withdrawn_at;
}
function healthRevision() {
  return healthState()?.revision ?? 1;
}
async function loadWork() {
  if (!online || !me?.modules.calendar || !me.calendar.linked || !serverConsent("calendar_link")) {
    availability = null;
    return;
  }
  const day = localDate(api.serverNow(), zone());
  const start = new Date(zonedToInstant(day, "00:00", zone())).toISOString();
  const end = new Date(zonedToInstant(addDays(day, 2), "00:00", zone())).toISOString();
  try {
    availability = await api.get(`/v1/calendar/availability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  } catch (e) {
    availability = { error: e instanceof ApiError ? e.code : "ERROR" };
  }
}
async function loadHouse() {
  site = me?.sites?.[0] ?? null;
  if (!online || !site || !serverConsent("home_control")) {
    devices = [];
    return;
  }
  try {
    devices = (await api.get(`/v1/devices?site=${encodeURIComponent(site.id)}`)).devices;
  } catch {
    devices = [];
  }
}
async function loadActions() {
  if (!online) return;
  try {
    actions = (await api.get("/v1/actions")).items;
  } catch {
    actions = [];
  }
}
function serverConsent(purpose) {
  const c = me?.consents?.find((x) => x.purpose_id === purpose);
  return !!c && c.choice === "GRANTED" && !c.withdrawn_at;
}
async function refresh() {
  try {
    await loadMe();
  } catch (e) {
    online = false;
    if (e instanceof ApiError && e.status === 401 && api.dev) {
      await api.login(prefs.activeSub ?? api.devUsers[0]?.sub ?? "dev_a");
      return refresh();
    }
  }
  computeHealth();
  await Promise.all([loadWork(), loadHouse(), loadActions()]);
  await syncLocale(); // tùy chọn ngôn ngữ lưu theo tài khoản trên trình duyệt này; đổi tài khoản có thể đổi ngôn ngữ
  render();
}
// ---------------------------------------------------------------- ngôn ngữ (LNH-T21, LNH-T28, LNH-T29)
let reviewing = false; // hộp xem lại kế hoạch đang mở
let staticLocale = null; // ngôn ngữ của lần điền HTML tĩnh gần nhất
/**
 * Một kế hoạch đang chờ đồng ý: hộp xem lại đang mở hoặc đồng hồ 120 giây đang chạy. Lúc này không đổi ngôn ngữ (LNH-T29).
 * Xét cả trạng thái thật của hộp: sự kiện `close` (nơi hạ cờ `reviewing`) tới sau lời gọi close() một nhịp.
 */
const planPending = () => (reviewing && $("action-dialog").open) || countdownTimer !== null;
// Chọn catalog theo thiết lập `locale` ("auto" theo trình duyệt), đặt <html lang dir> và điền chữ cho HTML tĩnh. Trả false khi
// hoãn vì một kế hoạch đang chờ đồng ý: màn hình xem lại giữ nguyên một ngôn ngữ tới khi đóng.
async function syncLocale() {
  const want = resolveLocale(settings().locale, navigator.languages);
  if (want !== getLocale()) {
    if (planPending()) return false;
    try {
      await setLocale(want);
    } catch (e) {
      console.error(e);
    }
  }
  applyLocale();
  return true;
}
function applyLocale() {
  const info = localeInfo();
  document.documentElement.lang = info.tag;
  document.documentElement.dir = info.dir;
  if (staticLocale === info.tag) return;
  // Tiêu đề trang, mô tả, liên kết bỏ qua, nhãn truy cập và chữ cố định của index.html (data-i18n, data-i18n-attr).
  localizeStatic(document);
  staticLocale = info.tag;
}
/**
 * Ngôn ngữ người dùng vừa chọn có dùng được không: "auto" luôn được; một ngôn ngữ cụ thể phải nạp được catalog lõi của nó,
 * không thì giao diện sẽ hiện tiếng Việt dưới tên một ngôn ngữ khác.
 */
async function localeUsable(pref) {
  if (!isLocale(pref)) return true;
  try {
    await loadLocale(pref);
  } catch {
    return false;
  }
  return hasCatalog(pref);
}
/** Lý do từ chối đổi sang `next` (khóa catalog của câu báo), hoặc null nếu đổi được. */
async function localeRefusal(next, current) {
  if (next === current) return null;
  if (planPending()) return "settings.language.pending";
  return (await localeUsable(next)) ? null : "settings.language.unavailable";
}
/**
 * Ô chọn ngôn ngữ: «Theo trình duyệt» và 13 ngôn ngữ bằng tên tự gọi, mỗi lựa chọn mang lang của chính nó. Nhãn có thêm chữ
 * "Language" cố định để người không đọc được ngôn ngữ đang hiện vẫn tìm ra ô này. `extra` là HTML đặt dưới ô chọn.
 */
function languageField(id, selected, extra = "") {
  const options = '<option value="auto"' + (isLocale(selected) ? "" : " selected") + ">" + tSafe("settings.language.auto") + "</option>" +
    LOCALES.map((l) => '<option value="' + l.tag + '" lang="' + l.tag + '"' + (l.tag === selected ? " selected" : "") + ">" + safe(l.name) + "</option>").join("");
  const fixed = getLocale() === "en" ? "" : ' · <span lang="en">' + LANGUAGE_WORD + "</span>";
  return '<div class="field language-field"><label for="' + id + '">' + icon("globe") + "<span>" + tSafe("settings.language.label") + fixed + '</span></label><select id="' + id + '" name="locale" autocomplete="off">' + options + "</select>" + extra + "</div>";
}
/** Dòng báo bản dịch máy chưa rà soát; rỗng khi đang hiện bản gốc tiếng Việt. */
const draftNote = (key = "i18n.draft.notice") => (draftUi() ? '<p class="fine-print draft-note">' + tSafe(key) + "</p>" : "");

// ---------------------------------------------------------------- trạng thái tác vụ
// Nhãn trạng thái, kết quả, lý do và hạng bằng chứng nằm ở các khóa `state.<MÃ>`, `outcome.<MÃ>`, `reason.<MÃ>`, `grade.<MÃ>`
// (codeLabel). Mã chưa có nhãn thì in nguyên mã: không đoán nghĩa, và UNKNOWN không bao giờ được diễn giải thành thất bại.
/** Tên đèn theo mã trong kế hoạch; không tìm thấy thì dùng chính mã. */
const lampName = (ref) => devices.find((x) => x.device_ref === ref)?.name ?? ref;
/** Mô tả một tác vụ theo nội dung đã chuẩn hóa của nó (HTML đã thoát ký tự; tên đèn nằm trong <bdi>). */
function describeHtml(a) {
  const p = a.preview;
  if (PLAN_KINDS[p.kind]) return safe(String(PLAN_KINDS[p.kind].title(baseCtx, p)));
  if (p.kind === "calendar.block") return tSafe("review.describe.calendarBlock", { start: hhmm(p.start), end: hhmm(p.end) });
  if (p.kind === "device.set_power") return rich(p.command === "SET_ON" ? "review.describe.powerOn" : "review.describe.powerOff", { device: bdi(lampName(p.target.device_ref)) });
  return tSafe("review.describe.robot");
}
function unknownPanel(a) {
  const slot = a.kind === "calendar.block";
  const escalated = a.reconciliation_status === "ESCALATED" || a.reconciliation_status === "MANUAL_REQUIRED";
  const locked = slot ? (escalated ? "review.unknown.lockedSlotEscalated" : "review.unknown.lockedSlot") : escalated ? "review.unknown.lockedDeviceEscalated" : "review.unknown.lockedDevice";
  return '<div class="unknown-panel" role="status"><strong>' + icon("alert") + tSafe("state.UNKNOWN") + "</strong><dl>" +
    "<dt>" + tSafe("review.unknown.sentAt") + "</dt><dd>" + hhmmss(a.times.first_io_at ?? a.times.dispatch_claimed_at) + "</dd>" +
    "<dt>" + tSafe("review.unknown.lastCheck") + "</dt><dd>" + hhmmss(a.times.last_check_at) + "</dd>" +
    "<dt>" + tSafe("review.unknown.nextCheck") + "</dt><dd>" + hhmmss(a.deadlines.next_check) + "</dd>" +
    "<dt>" + tSafe("review.unknown.supportCode") + "</dt><dd><code>" + safe(a.support_code ?? "—") + "</code></dd></dl>" +
    '<p class="fine-print">' + tSafe(locked) + "</p>" +
    '<button class="button secondary" data-check-action="' + safe(a.action_id) + '">' + icon("clock") + tSafe("review.unknown.check") + "</button></div>";
}
function actionCard(a, compact = false) {
  const terminal = ["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"].includes(a.status);
  const tone = a.status === "VERIFIED" ? "ok" : a.status === "UNKNOWN" || a.status === "CONFLICT" ? "warn" : terminal ? "muted" : "busy";
  let html = '<div class="action-card ' + tone + '" data-action-id="' + safe(a.action_id) + '"><div class="action-head"><strong>' + describeHtml(a) + '</strong><span class="status-chip ' + tone + '">' + safe(codeLabel("state", a.status) ?? a.status) + "</span></div>";
  if (!compact) {
    const result = codeLabel("outcome", a.outcome) ?? codeLabel("reason", a.reason);
    if (result) html += "<p>" + safe(result) + "</p>";
    if (a.evidence_grade) {
      const grade = codeLabel("grade", a.evidence_grade) ?? a.evidence_grade;
      html += '<p class="fine-print">' + (a.times.last_observed_at ? tSafe("review.evidence.at", { grade, time: hhmmss(a.times.last_observed_at) }) : tSafe("review.evidence.plain", { grade })) + "</p>";
    }
    if (a.cancel_requested && !terminal) html += '<p class="fine-print">' + tSafe("review.cancelRequested") + "</p>";
    if (a.status === "UNKNOWN") html += unknownPanel(a);
    else if (a.status === "AUTHORIZED") html += '<button class="text-button" data-cancel-action="' + safe(a.action_id) + '">' + tSafe("review.cancelBeforeSend") + "</button>";
  }
  return html + "</div>";
}

// ---------------------------------------------------------------- trang
function sleepTile() {
  if (!health) return '<button class="card" data-nav="health"><div class="stat-label">' + icon("moon") + tSafe("health.sleep.title") + '</div><div class="stat-value">—</div><div class="stat-meta">' + tSafe("health.off.tile") + "</div></button>";
  const s = health.summary;
  const today = health.days[health.days.length - 1];
  const seconds = today.sleep_seconds ?? s.sleep_average_seconds;
  const counts = { n: s.sleep_observed_days, total: s.completed_days };
  const meta = today.sleep_seconds !== null
    ? (healthSynthetic() ? tSafe("health.sleep.lastNight.synthetic") : tSafe("health.sleep.lastNight.source", { source: healthFrom.label }))
    : healthSynthetic() ? tSafe("health.sleep.observed.synthetic", counts) : tSafe("health.sleep.observed.source", { ...counts, source: healthFrom.label });
  const bars = health.days.slice(0, 7).map((d) => '<i class="' + (d.sleep_seconds === null ? "missing" : "") + '" style="--h:' + (d.sleep_seconds === null ? 6 : Math.min(100, Math.round((d.sleep_seconds / 36000) * 100))) + '%"></i>').join("");
  return '<button class="card" data-nav="health"><div class="stat-label">' + icon("moon") + tSafe("health.sleep.title") + '</div><div class="stat-value">' + (seconds === null ? "—" : durationHtml(seconds)) + '</div><div class="stat-meta">' + meta + '</div><div class="spark-bars" aria-hidden="true">' + bars + "</div></button>";
}
function stepsTile() {
  if (!health) return '<button class="card" data-nav="health"><div class="stat-label">' + icon("steps") + tSafe("health.steps.title") + '</div><div class="stat-value">—</div><div class="stat-meta">' + tSafe("health.off.tile") + "</div></button>";
  const today = health.days[health.days.length - 1];
  const v = today.steps;
  const meta = v === null ? tSafe("health.steps.noneToday") : healthSynthetic() ? tSafe("health.steps.partial.synthetic") : tSafe("health.steps.partial.source", { source: healthFrom.label });
  return '<button class="card" data-nav="health"><div class="stat-label">' + icon("steps") + tSafe("health.steps.title") + '</div><div class="stat-value">' + (v === null ? "—" : withUnit("health.steps.value", v)) + '</div><div class="stat-meta">' + meta + "</div></button>";
}
function scheduleRows(dayOffset = 0) {
  const empty = (text) => '<p class="empty-state">' + safe(text) + "</p>";
  if (!online) return empty(t("common.offline"));
  if (!me?.calendar.linked) return empty(t("work.notLinked"));
  if (!serverConsent("calendar_link")) return empty(t("work.consentNeeded"));
  if (!availability || availability.error) return empty(availability?.error ? t("work.unreadableCode", { code: availability.error }) : t("work.unreadable"));
  const day = addDays(localDate(api.serverNow(), zone()), dayOffset);
  const onDay = (iso) => localDate(Date.parse(iso), zone()) === day;
  const mine = availability.lenhip_blocks.filter((b) => onDay(b.start));
  const rows = [
    ...availability.busy.filter((b) => onDay(b.start) && !mine.some((m) => m.start === b.start && m.end === b.end)).map((b) => ({ start: b.start, end: b.end, title: t("work.row.busy"), detail: t("work.row.busyDetail") })),
    ...mine.map((b) => ({ start: b.start, end: b.end, title: t("work.row.personal"), detail: t("work.row.personalDetail", { status: codeLabel("state", b.status) ?? b.status }) })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  if (!rows.length) return empty(t("work.empty"));
  return rows.map((e) => '<div class="event-row"><span class="event-time">' + hhmm(e.start) + '</span><div class="event-copy"><strong>' + safe(e.title) + "</strong><span>" + tSafe("work.row.line", { start: hhmm(e.start), end: hhmm(e.end), detail: e.detail }) + "</span></div>" + icon("arrow") + "</div>").join("");
}
function timeline() {
  const items = [["07:30", "home.timeline.morning", "sun", "home.timeline.morningDesc", "health"], ["09:00", "home.timeline.work", "work", "home.timeline.workDesc", "work"], ["18:00", "home.timeline.evening", "home", "home.timeline.eveningDesc", "house"]];
  return '<div class="timeline">' + items.map(([time, title, i, desc, target]) => '<button class="card" data-nav="' + target + '"><span class="tile-icon">' + icon(i) + '</span><span class="event-copy"><strong>' + tSafe("home.timeline.item", { time, title: t(title) }) + "</strong><span>" + tSafe(desc) + "</span></span>" + icon("arrow") + "</button>").join("") + "</div>";
}
function statWidgets() {
  const widgets = settings().widgets;
  const tiles = [];
  if (widgets.includes("sleep")) tiles.push(sleepTile());
  if (widgets.includes("steps")) tiles.push(stepsTile());
  return (tiles.length ? '<div class="stats-grid">' + tiles.join("") + "</div>" : "") + (widgets.includes("schedule") ? '<div class="section-heading"><h2>' + tSafe("home.schedule.title") + '</h2><button class="text-button" data-nav="work">' + tSafe("home.schedule.all") + '</button></div><div class="card">' + scheduleRows() + "</div>" : "");
}
function home() {
  const { name, theme } = settings();
  const work = context === "work";
  let html = '<div class="heading-row"><div><span class="eyebrow">' + safe(dateLine()) + "</span><h1>" + (name ? rich("home.greeting", { name: bdi(name) }) : tSafe("home.greetingAnon")) + '</h1><p class="subtitle">' + tSafe("home.subtitle") + "</p></div></div>";
  if (theme === "flow") {
    html += '<section class="hero flow-hero"><div class="hero-copy"><span class="eyebrow" style="color:#c9f0ff">' + tSafe("home.flow.eyebrow") + "</span><h2>" + lines("home.flow.title") + "</h2><p>" + tSafe("home.flow.text") + "</p></div>" + orb() + "</section>" + timeline();
  } else if (theme === "titanium") {
    const tiles = [["person", "home.space.personal", "home.space.personalDesc", "health"], ["work", "home.space.work", "home.space.workDesc", "work"], ["home", "home.space.house", "home.space.houseDesc", "house"]];
    html += '<div class="space-tiles">' + tiles.map(([i, title, d, target]) => '<button class="card space-tile" data-nav="' + target + '"><span class="tile-icon">' + icon(i) + '</span><span class="event-copy"><strong>' + tSafe(title) + "</strong><span>" + tSafe(d) + "</span></span>" + icon("arrow") + "</button>").join("") + "</div>";
  } else {
    const title = lines(work ? "home.hero.work.title" : theme === "calm" ? "home.hero.calm.title" : theme === "night" ? "home.hero.night.title" : "home.hero.orbit.title");
    html += '<section class="hero ' + theme + '-hero"><div class="hero-copy"><span class="tiny-pill">' + (work ? tSafe("home.hero.work.pill") : rich("lele.companion", { lele: mark("amber", "inline") })) + "</span><h2>" + title + "</h2><p>" + tSafe(work ? "home.hero.work.text" : "home.hero.personal.text") + '</p><button class="button primary" data-nav="' + (work ? "work" : "health") + '">' + tSafe(work ? "home.hero.work.cta" : "home.hero.personal.cta") + icon("arrow") + "</button></div>" + orb() + "</section>";
    html += statWidgets();
  }
  if ((theme === "flow" || theme === "titanium") && settings().widgets.length) html += '<details class="today-details"><summary>' + tSafe("home.today.details") + "</summary>" + statWidgets() + "</details>";
  const live = actions.filter((a) => !["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"].includes(a.status));
  if (live.length) html += '<div class="section-heading"><h2>' + tSafe("home.tracking.title") + "</h2></div>" + live.map((a) => actionCard(a)).join("");
  return html + askLele();
}
/** Câu trung tính về giấc ngủ (SRS mục 10) theo ngôn ngữ đang chọn, dựng từ khóa và tham số của LNH-SLEEP-1. */
function sleepText(summary) {
  const m = sleepMessage(summary);
  return t(m.key, m.durationMinutes === null ? m.params : { ...m.params, duration: formatMinutes(m.durationMinutes) });
}
function health_() {
  let html = '<span class="eyebrow">' + tSafe("health.eyebrow") + "</span><h1>" + tSafe("health.title") + '</h1><p class="subtitle">' + tSafe("health.subtitle") + "</p>";
  if (!health) {
    return html + '<section class="card health-card"><div class="stat-label">' + icon("shield") + tSafe("health.off.title") + "</div><p>" + tSafe("health.off.text") + '</p><button class="button primary" data-action="onboarding">' + tSafe("health.off.cta") + "</button></section>" + askLele();
  }
  const s = health.summary;
  const completed = health.days.slice(0, 7);
  const today = health.days[7];
  const label = (d) => formatWeekdayCompact(d.local_date);
  const avg = s.sleep_average_seconds;
  const chartLabel = t("health.sleep.chart.label", { observed: t("health.sleep.chart.observed", { n: s.sleep_observed_days }), missing: t("health.sleep.chart.missing", { n: s.completed_days - s.sleep_observed_days }) });
  html += '<section class="card health-card"><div class="stat-label">' + icon("moon") + tSafe("health.sleep.heading", { n: s.completed_days }) + "</div>" +
    '<div class="stat-value">' + (avg === null ? "—" : safe(durationText(avg))) + '</div><p class="subtitle">' + safe(sleepText(s)) + "</p>" + draftNote("health.draft") +
    '<div class="bar-chart" role="img" aria-label="' + safe(chartLabel) + '">' +
    completed.map((d) => '<div><i class="' + (d.sleep_seconds === null ? "missing" : "") + '" style="--h:' + (d.sleep_seconds === null ? 3 : Math.min(100, Math.round((d.sleep_seconds / 36000) * 100))) + '%"></i><span>' + safe(label(d)) + "</span></div>").join("") +
    '</div><p class="fine-print">' + (today.sleep_seconds === null ? tSafe("health.sleep.today.none", { weekday: label(today) }) : tSafe("health.sleep.today.main", { weekday: label(today), duration: durationText(today.sleep_seconds) })) + "</p></section>";
  const stepsDays = completed.filter((d) => d.steps !== null);
  const sourceMeta = t(health.source.selection === "MOST_RECENT_NEEDS_CONFIRMATION" ? "health.source.metaConfirm" : "health.source.meta", { id: health.source.id ?? "—", algorithm: health.algorithm_version, zone: health.analysis_zone });
  html += '<div class="stats-grid" style="margin-top:15px"><div class="card"><div class="stat-label">' + icon("steps") + tSafe("health.steps.title") + '</div><div class="stat-value">' + (s.steps_average === null ? "—" : withUnit("health.steps.perDay", s.steps_average)) + '</div><div class="stat-meta">' + tSafe("health.steps.observed", { n: stepsDays.length, total: s.completed_days }) + "</div></div>" +
    '<div class="card"><div class="stat-label">' + icon("shield") + tSafe("health.source.title") + '</div><h3 style="margin-top:16px">' + (healthSynthetic() ? tSafe("health.source.synthetic") : safe(healthFrom.label)) + '</h3><div class="stat-meta">' + safe(healthSynthetic() || !healthFrom.detail ? sourceMeta : dotJoin([healthFrom.detail, sourceMeta])) + "</div></div></div>";
  html += '<div class="privacy-note">' + icon("lock") + "<span>" + tSafe(healthSynthetic() ? "health.note.synthetic" : "health.note.import") + "</span></div>";
  html += '<div class="button-row"><button class="button secondary" data-action="health-source">' + tSafe("health.actions.source") + " " + icon("arrow") + '</button><button class="button secondary" data-action="health-export">' + tSafe("health.actions.export") + '</button><button class="button secondary" data-action="health-erase">' + tSafe("health.actions.erase") + "</button></div>";
  return html + askLele();
}
function work() {
  const live = actions.filter((a) => a.kind === "calendar.block").slice(0, 3);
  const date = formatDate(api.serverNow(), { day: "numeric", month: "numeric", timeZone: zone() });
  return '<div class="heading-row"><div><span class="eyebrow">' + tSafe("work.eyebrow") + "</span><h1>" + tSafe("work.title") + '</h1></div><span class="tiny-pill">' + tSafe("work.simulatedPill") + '</span></div><p class="subtitle">' + tSafe("work.subtitle") + "</p>" +
    '<section class="card" style="margin-top:25px"><div class="section-heading" style="margin-top:0"><h2>' + tSafe("work.today", { date }) + "</h2>" + icon("today") + "</div>" + scheduleRows() + "</section>" +
    '<button class="button primary full" style="margin-top:18px" data-action="new-block" ' + (online && me?.calendar.linked && serverConsent("calendar_link") ? "" : "disabled") + ">" + icon("plus") + tSafe("work.addBlock") + "</button>" +
    '<div class="privacy-note">' + icon("lock") + "<span>" + rich("work.note", { title: viSpan(calendarTitle()) }) + "</span></div>" +
    (live.length ? '<div class="section-heading"><h2>' + tSafe("work.recent") + "</h2></div>" + live.map((a) => actionCard(a)).join("") : "") + askLele();
}
function roomVisual() {
  const lamp = devices.find((d) => d.device_ref === "dev_lamp_01") ?? devices[0];
  const on = lamp?.state?.power === "ON";
  return '<div class="room-visual"><svg viewBox="0 0 520 225" role="img" aria-label="' + tSafe(on ? "house.visual.on" : "house.visual.off") + '"><defs><linearGradient id="desk" x2="1" y2="1"><stop stop-color="#e4caa8"/><stop offset="1" stop-color="#b69779"/></linearGradient><radialGradient id="light"><stop stop-color="#fff3a8" stop-opacity=".7"/><stop offset="1" stop-color="#ffe997" stop-opacity="0"/></radialGradient><linearGradient id="screen" x2="1" y2="1"><stop stop-color="#6ac4dc"/><stop offset="1" stop-color="#284c73"/></linearGradient></defs><path d="M80 120 350 75 450 140 175 190Z" fill="url(#desk)"/><path d="M80 120v12l95 68 275-48v-12l-275 50Z" fill="#a88c70"/><path d="m100 140 6 63h12l-2-54m307 14-5 51h12l9-64m-250 40 3 29h13l1-34" fill="#8b7c6c"/><path d="m170 57 116-17v74l-116 19Z" fill="#244150"/><path d="m176 62 104-15v62l-104 17Z" fill="url(#screen)"/><path d="m220 122 3 22 27-5-4-21" fill="#5b6b75"/><ellipse cx="346" cy="133" rx="26" ry="8" fill="#827759"/><path d="m345 130 6-58-27-25" stroke="#b39d67" stroke-width="6" fill="none"/><path d="m304 39 29-4 16 29-54 7Z" fill="' + (on ? "#c9af70" : "#71818e") + '"/>' + (on ? '<ellipse cx="320" cy="103" rx="66" ry="40" fill="url(#light)"/>' : "") + '<path d="m386 99 20-4v22l-20 4Z" fill="#f7f3e8"/><path d="M406 100q17-1 0 14" fill="none" stroke="#e7ded0" stroke-width="5"/></svg></div>';
}
function deviceRow(d) {
  const st = d.state;
  const on = st?.power === "ON";
  // Thẻ trạng thái hiện tại: báo "đã cũ" sau 60 giây. Bằng chứng của tác vụ dùng max-age 2 giây ở gateway (SRS mục 23).
  const stale = st ? st.age_ms > 60_000 : false;
  const state = !st ? t("house.lamp.noState") : t(on ? (stale ? "house.lamp.onStale" : "house.lamp.on") : stale ? "house.lamp.offStale" : "house.lamp.off", { time: hhmmss(st.observed_at) });
  // Trạng thái đăng ký lạ (không phải ACTIVE hay QUARANTINED) in nguyên mã của máy chủ.
  const status = dotJoin([state, d.locked ? t("house.lamp.locked") : "", d.status === "ACTIVE" ? "" : d.status === "QUARANTINED" ? t("house.lamp.quarantined") : String(d.status)]);
  const disabled = !online || d.locked || d.status !== "ACTIVE" || !me?.dispatch_open;
  return '<div class="device-control">' + icon("lamp") + '<div class="device-copy"><h3>' + bdi(d.name) + "</h3><p>" + safe(status) + '</p></div><button class="switch" data-device="' + safe(d.device_ref) + '" role="switch" aria-label="' + safe(d.name) + '" aria-checked="' + on + '" ' + (disabled ? "disabled" : "") + "></button></div>";
}
function house() {
  const live = actions.filter((a) => a.kind === "device.set_power" || a.kind === "robot.simulate").slice(0, 3);
  const empty = (key) => '<p class="empty-state">' + tSafe(key) + "</p>";
  let body;
  if (!online) body = empty("common.offline");
  else if (!site) body = empty("house.noSite");
  else if (!serverConsent("home_control")) body = empty("house.consentNeeded");
  else body = devices.length ? devices.map(deviceRow).join('<hr class="soft">') : empty("house.noLamps");
  return '<span class="eyebrow">' + rich("house.eyebrow", { site: site?.name ? bdi(site.name) : tSafe("house.defaultSite") }) + "</span><h1>" + tSafe("house.title") + '</h1><p class="subtitle">' + tSafe("house.subtitle") + '</p><section class="card" style="margin-top:25px">' + roomVisual() + body + "</section>" +
    (live.length ? '<div class="section-heading"><h2>' + tSafe("house.recent") + "</h2></div>" + live.map((a) => actionCard(a)).join("") : "") +
    '<div class="section-heading"><h2>' + tSafe("house.robot.heading") + '</h2><span class="tiny-pill">' + tSafe("common.simulated") + '</span></div><button class="card device-control full" data-action="robot" ' + (online && me?.grants.some((g) => g.scope === "robot.simulate" && g.status === "ACTIVE") ? "" : "disabled") + ">" + icon("robot") + '<span class="event-copy"><strong>' + tSafe("house.robot.title") + "</strong><span>" + tSafe("house.robot.text") + "</span></span>" + icon("arrow") + "</button>" +
    '<div class="privacy-note">' + icon("shield") + "<span>" + tSafe("house.note") + "</span></div>" + askLele();
}

// ---------------------------------------------------------------- khung: phạm vi sống, ctx của màn hình, vẽ
// Phạm vi sống của một màn hình (hoặc một phần, hoặc phần chạy nền của mô-đun): giữ các việc dọn dẹp và các nhịp lặp. Nhịp
// tạm dừng khi tab bị ẩn và chạy lại (kèm một lần gọi ngay) khi tab hiện; mọi thứ dừng hẳn khi phạm vi kết thúc.
const rootScopes = new Set();
function createScope(parent = null) {
  let ended = false;
  const cleanups = [];
  const timers = new Set();
  const children = new Set();
  const abort = new AbortController();
  const scope = {
    get ended() {
      return ended;
    },
    // Tín hiệu bị hủy khi phạm vi kết thúc: addEventListener(…, { signal: ctx.signal }) tự gỡ khi rời màn hình.
    signal: abort.signal,
    onLeave(fn) {
      if (typeof fn !== "function") throw new TypeError("onLeave cần một hàm");
      if (ended) fn();
      else cleanups.push(fn);
    },
    every(ms, fn, o = {}) {
      if (typeof fn !== "function" || !(ms >= 250)) throw new TypeError("every cần chu kỳ từ 250 ms và một hàm");
      const timer = { id: 0, busy: false };
      // Một lần gọi chưa xong thì bỏ nhịp kế tiếp: thăm dò chậm không chồng lên nhau.
      const run = async () => {
        if (ended || timer.busy || document.hidden) return;
        timer.busy = true;
        try {
          await fn();
        } catch (e) {
          console.error(e);
        } finally {
          timer.busy = false;
        }
      };
      timer.start = (now) => {
        if (ended || timer.id) return;
        timer.id = setInterval(run, ms);
        if (now) run();
      };
      timer.stop = () => {
        clearInterval(timer.id);
        timer.id = 0;
      };
      timers.add(timer);
      if (!document.hidden) timer.start(o.immediate === true);
      return () => {
        timer.stop();
        timers.delete(timer);
      };
    },
    pause() {
      for (const x of timers) x.stop();
      for (const c of children) c.pause();
    },
    resume() {
      for (const x of timers) x.start(true);
      for (const c of children) c.resume();
    },
    fork() {
      const child = createScope(scope);
      children.add(child);
      child.ctx = makeCtx(child);
      return child;
    },
    end() {
      if (ended) return;
      ended = true;
      abort.abort();
      for (const c of [...children]) c.end();
      for (const x of timers) x.stop();
      timers.clear();
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch (e) {
          console.error(e);
        }
      }
      if (parent) parent.forget(scope);
      else rootScopes.delete(scope);
    },
    forget(child) {
      children.delete(child);
    },
  };
  if (!parent) rootScopes.add(scope);
  return scope;
}
// `ctx`: mọi thứ một màn hình hay một phần của mô-đun mới được dùng, để không phải import app.js. Bảng trường và chữ ký:
// web/views/index.js. `scope` rỗng là ctx chỉ để đọc (visible, nav.label, nav.badge, plans): không đăng ký được nhịp.
function makeCtx(scope) {
  const needScope = () => {
    throw new Error("ctx.every/onLeave/fork chỉ dùng trong mount, bind, render của màn hình hoặc trong background");
  };
  return {
    get me() {
      return me;
    },
    // Cờ mô-đun từ /v1/me. Mô-đun mới (messaging, social, trackers) coi là tắt trừ khi đúng bằng true (LNH-F27).
    get modules() {
      return Object.freeze({ ...(me?.modules ?? {}) });
    },
    // Ảnh chụp chỉ đọc. Không có dữ liệu sức khỏe: số liệu sức khỏe không đi qua ctx (LNH-T36, LNH-T41, LNH-T52).
    get state() {
      return Object.freeze({ online, view: currentView?.id ?? null, context, zone: zone(), settings: Object.freeze({ ...settings() }), actions, site, lamps: devices, availability });
    },
    api,
    t,
    tSafe,
    locale: getLocale,
    formatNumber,
    formatDate,
    formatWeekday,
    formatTime24,
    formatDuration: formatMinutes,
    formatList,
    // Thêm ở nhánh ngôn ngữ (cùng nghĩa với các hàm cùng tên trong tệp này và trong shared/i18n.js, shared/consent-text.js):
    formatWeekdayCompact, // tên thứ gọn cho nhãn cột
    formatDurationParts, // thời lượng theo từng phần (số, đơn vị, chữ nối)
    rich, // (key, slots, params?) -> HTML: chèn HTML tin cậy vào chỗ tham số, phần chữ của bản dịch được thoát ký tự
    bdi, // tên lấy từ dữ liệu -> "<bdi>…</bdi>" đã thoát ký tự
    errorText, // (lỗi) -> câu báo theo mã: error.<CODE>.<detail_code> → error.<CODE> → error.generic (LNH-T23)
    codeLabel, // (lớp, mã, params?) -> nhãn của `state`/`outcome`/`reason`/`grade`, tra cả `<phần>.<lớp>.<MÃ>`; null nếu chưa có
    draft: draftUi, // () -> ngôn ngữ đang hiện là bản dịch máy chưa rà soát
    consentText, // (purpose_id, tiền tố?) -> văn bản đồng ý đang hiện { head, body, title, text, text_version, locale }
    consentReceipt, // (purpose_id, tiền tố?) -> Promise<{ text_version, text_hash, locale }> cho POST /v1/consents (LNH-T25)
    safe,
    icon,
    toast,
    zone,
    now: () => api.serverNow(),
    openDialog,
    closeDialog,
    rerender: render,
    refresh,
    navigate: (id, o = {}) => navigate(id, o.focus !== false),
    propose,
    actionCard: (action, compact = false) => actionCard(action, compact),
    signal: scope ? scope.signal : null,
    onLeave: scope ? scope.onLeave : needScope,
    every: scope ? scope.every : needScope,
    fork: scope ? scope.fork : needScope,
  };
}
const baseCtx = makeCtx(null);
let currentView = null;
let mounted = null; // màn hình có trạng thái đang hiện: { view, user, locale, scope, ctx }
let drawn = null; // màn hình đơn giản đang hiện: { view, scope }
const services = new Map(); // phần chạy nền của mô-đun: id màn hình → { user, scope }
function leaveView() {
  if (mounted) {
    const m = mounted;
    mounted = null;
    try {
      m.view.unmount?.();
    } catch (e) {
      console.error(e);
    }
    m.scope.end();
  }
  if (drawn) {
    drawn.scope.end();
    drawn = null;
  }
}
function viewError(e) {
  console.error(e);
  return '<section class="card view-card"><p class="empty-state">' + tSafe("shell.viewError") + "</p></section>";
}
// Phần chạy nền (background) của một màn hình: bật khi màn hình hiển thị với tài khoản đang đăng nhập, tắt khi mô-đun tắt
// hoặc đổi tài khoản. Chạy cả khi người dùng đang ở màn hình khác (ví dụ huy hiệu tin mới).
function syncServices() {
  const user = me?.user.id ?? null;
  for (const v of VIEWS) {
    if (typeof v.background !== "function") continue;
    const running = services.get(v.id);
    const want = user !== null && isVisible(v);
    if (running && (!want || running.user !== user)) {
      running.scope.end();
      services.delete(v.id);
    }
    if (want && !services.has(v.id)) {
      const scope = createScope();
      services.set(v.id, { user, scope });
      try {
        v.background(makeCtx(scope));
      } catch (e) {
        console.error(e);
      }
    }
  }
}
function render() {
  applyTheme();
  brand();
  const view = resolveView();
  currentView = view;
  syncServices();
  nav(view);
  banner();
  setHtml($("privacy-chip"), icon("shield") + tSafe("shell.privacyChip"));
  // Chữ phụ thuộc trạng thái nên không đi qua data-i18n: nhãn bản dựng, dòng phiên bản ở chân trang, số phong cách.
  $("build-label").textContent = t(!apiReady ? "shell.build.pending" : api.dev ? "shell.build.dev" : "shell.build.reference");
  $("footer-build").textContent = t("shell.footer.build", { version: APP_VERSION, spec: SPEC_ID });
  $("theme-count").textContent = t("theme.panel.count", { n: THEMES.length });
  setHtml($("settings-button"), icon("settings"));
  setHtml($("note-icon"), icon("lock"));
  setHtml($("theme-options"), THEMES.map((th) => themeButton(th)).join(""));
  document.body.dataset.view = view.id;
  document.body.dataset.layout = view.wide ? "wide" : "default";
  const main = $("main");
  const user = me?.user.id ?? null;
  if (isStateful(view)) {
    // Màn hình có trạng thái: mount một lần. Render nền (thăm dò 5 giây, đổi phong cách, kết nối lại…) chỉ gọi update, không
    // dựng lại DOM, nên ô đang soạn, con trỏ và vị trí cuộn được giữ. Đổi tài khoản thì mount lại: trạng thái thuộc người cũ.
    // Đổi ngôn ngữ cũng mount lại: chữ của màn hình được dựng lúc mount, update không vẽ lại chúng.
    if (mounted && mounted.view === view && mounted.user === user && mounted.locale === getLocale()) {
      try {
        view.update?.(mounted.ctx);
      } catch (e) {
        console.error(e);
      }
      return;
    }
    leaveView();
    main.innerHTML = '<div class="view-host" data-view-host="' + view.id + '"></div>';
    lastHtml.delete(main);
    const scope = createScope();
    mounted = { view, user, locale: getLocale(), scope, ctx: makeCtx(scope) };
    try {
      view.mount(mounted.ctx, main.firstElementChild);
    } catch (e) {
      main.firstElementChild.innerHTML = viewError(e);
    }
    return;
  }
  // Màn hình đơn giản: vẽ lại HTML; nếu không đổi thì giữ nguyên DOM và các nhịp của lần vẽ trước.
  if (mounted || (drawn && drawn.view !== view)) leaveView();
  const scope = createScope();
  const ctx = makeCtx(scope);
  let html;
  try {
    html = (view.contextSwitch ? contextControl() : "") + view.render(ctx);
  } catch (e) {
    html = viewError(e);
  }
  if (drawn && lastHtml.get(main) === html) return scope.end();
  drawn?.scope.end();
  setHtml(main, html);
  drawn = { view, scope };
  try {
    view.bind?.(ctx, main);
  } catch (e) {
    console.error(e);
  }
}
function navigate(next, focus = true) {
  const view = VIEWS.find((v) => v.id === next);
  if (!view || !isVisible(view)) return false;
  screen = next;
  if (view.context) context = view.context;
  history.replaceState(null, "", "#" + next);
  render();
  if (focus) $("main").focus();
  return true;
}
// Hộp thoại thao tác dùng chung. `title` là HTML (để chèn chữ LeLe); mô-đun mới dùng ctx.openDialog với tiêu đề văn bản thuần.
let dialogOwner = null; // hàm onClose của nội dung đang hiện, gọi đúng một lần khi hộp đóng hoặc nội dung bị thay
function releaseDialog() {
  const fn = dialogOwner;
  dialogOwner = null;
  if (!fn) return;
  try {
    fn();
  } catch (e) {
    console.error(e);
  }
}
function showAction(title, html) {
  releaseDialog();
  reviewing = false; // nội dung hộp bị thay: bước xem lại (nếu có) không còn trên màn hình
  $("action-title").innerHTML = title;
  $("action-body").innerHTML = html;
  if (!$("action-dialog").open) $("action-dialog").showModal();
  $("action-title").focus();
}
function openDialog(title, html, o = {}) {
  showAction(safe(title), html);
  dialogOwner = typeof o.onClose === "function" ? o.onClose : null;
  return $("action-body");
}
function closeDialog() {
  if ($("action-dialog").open) $("action-dialog").close();
}
function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

// ---------------------------------------------------------------- plan → xem lại → xác nhận
// Câu báo lỗi dựng từ MÃ (LNH-T23): error.<CODE>.<detail_code> → error.<CODE> → error.generic kèm mã và request_id. Mô-đun
// khai mã riêng ở phần catalog của mình (`msg.error.<CODE>`, `social.error.<CODE>`…). Câu `message` của máy chủ không bao giờ
// được in. Thông điệp chi tiết có giới hạn nhận `n` (và `limit`) từ trường `limit` của lỗi; thiếu thì lùi về câu của mã.
function errorText(e) {
  const code = typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.code) ? e.code : "ERROR";
  const detail = typeof e?.detail_code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(e.detail_code) ? e.detail_code : null;
  const params = typeof e?.limit === "number" && Number.isFinite(e.limit) ? { n: e.limit, limit: e.limit } : undefined;
  const text = (detail ? lookupLabel("error." + code + "." + detail, params) : null) ?? lookupLabel("error." + code);
  if (text) return text;
  const id = typeof e?.request_id === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(e.request_id) ? e.request_id : null;
  return id ? t("error.genericWithId", { code, request_id: id }) : t("error.generic", { code });
}
function planSummary(p) {
  // Loại kế hoạch của mô-đun mới (trường `plans` của màn hình): mô-đun tự vẽ phần tóm tắt và tự thoát ký tự.
  if (PLAN_KINDS[p.kind]) return '<div class="card preview-card">' + PLAN_KINDS[p.kind].summary(baseCtx, p) + "</div>";
  if (p.kind === "calendar.block") {
    const date = formatDate(localDate(Date.parse(p.start), zone()), { day: "2-digit", month: "2-digit", year: "numeric" });
    // Ở ngôn ngữ khác tiếng Việt, tiêu đề hiển thị là bản dịch; dòng dưới nói rõ tiêu đề thật sẽ ghi vào lịch (LNH-T26).
    const written = getLocale() === SOURCE_LOCALE ? "" : '<div class="event-row">' + icon("today") + "<span>" + rich("review.calendar.writtenTitle", { title: viSpan(calendarTitle()) }) + "</span></div>";
    return '<div class="card preview-card"><h3>' + tSafe("review.calendar.title") + '</h3><div class="event-row">' + icon("clock") + tSafe("review.calendar.when", { start: hhmm(p.start), end: hhmm(p.end), date }) + "</div>" + written + '<div class="event-row">' + icon("lock") + tSafe("review.calendar.privacy") + '</div><div class="event-row">' + icon("work") + tSafe("review.calendar.target") + "</div></div>";
  }
  if (p.kind === "device.set_power") {
    return '<div class="card preview-card"><h3>' + rich(p.command === "SET_ON" ? "review.describe.powerOn" : "review.describe.powerOff", { device: bdi(lampName(p.target.device_ref)) }) + '</h3><div class="event-row">' + icon("home") + bdi(site?.name ?? p.target.site) + '</div><div class="event-row">' + icon("shield") + tSafe("review.device.gateway", { version: String(p.target_binding_version) }) + "</div></div>";
  }
  return '<div class="card preview-card"><h3>' + tSafe("review.robot.title") + '</h3><div class="event-row">' + icon("robot") + tSafe("review.robot.text") + "</div></div>";
}
async function propose(input, label) {
  try {
    const plan = await api.post("/v1/plans", input);
    const digestOk = (await digestJcs(plan.preview)) === plan.payload_digest;
    pendingPlan = { plan, input, label, digestOk };
    showPreview();
  } catch (e) {
    showAction(tSafe("review.failed.createTitle"), "<p>" + safe(errorText(e)) + '</p><button class="button primary" data-action="close-action">' + tSafe("common.understood") + "</button>");
  }
}
function showPreview() {
  const { plan, label, digestOk } = pendingPlan;
  showAction(tSafe("review.title"), '<span class="tiny-pill">' + safe(label) + "</span>" + planSummary(plan.preview) +
    '<p class="fine-print">' + (digestOk ? icon("check") + " " + rich("review.digest.ok", { digest: "<code>" + safe(plan.payload_digest.slice(0, 10)) + "</code>" }) : icon("alert") + " " + tSafe("review.digest.mismatch")) + "</p>" +
    '<p class="countdown" id="countdown" aria-live="polite"></p>' +
    '<button class="button primary full" data-action="approve-plan" ' + (digestOk ? "" : "disabled") + ">" + tSafe("review.approve") + '</button><button class="text-button full" data-action="cancel-plan">' + tSafe("review.cancel") + "</button>");
  reviewing = true;
  stopCountdown();
  const tickDown = () => {
    const left = Math.max(0, Math.ceil((Date.parse(plan.approval_deadline) - api.serverNow()) / 1000));
    const el = $("countdown");
    if (!el) return stopCountdown();
    el.textContent = left > 0 ? t("review.countdown", { n: left }) : t("review.expired.short");
    if (left <= 0) {
      stopCountdown();
      expired();
    }
  };
  tickDown();
  countdownTimer = setInterval(tickDown, 1000);
}
function expired() {
  // Hết 120 giây: giữ bản nháp, giải thích, cho xem lại để xác nhận mới; không tự gia hạn (SRS mục 13).
  showAction(tSafe("review.expired.title"), "<p>" + tSafe("review.expired.text") + "</p>" + planSummary(pendingPlan.plan.preview) + '<button class="button primary full" data-action="repropose">' + tSafe("review.repropose") + '</button><button class="text-button full" data-action="close-action">' + tSafe("common.skip") + "</button>");
}
async function approve() {
  const { plan } = pendingPlan;
  stopCountdown();
  try {
    const r = await api.post(`/v1/plans/${plan.plan_id}/approve`, { plan_version: plan.plan_version, approved_digest: plan.payload_digest });
    track(r.action_id);
  } catch (e) {
    if (e.code === "APPROVAL_EXPIRED") return expired();
    showAction(tSafe("review.failed.approveTitle"), "<p>" + safe(errorText(e)) + "</p>" + (e.code === "PLAN_STALE" ? '<button class="button primary full" data-action="repropose">' + tSafe("review.repropose") + "</button>" : "") + '<button class="text-button full" data-action="close-action">' + tSafe("common.close") + "</button>");
  }
}
/** Hộp theo dõi một tác vụ: thẻ theo bằng chứng và nút đóng. */
const trackDialog = (a) => showAction(tSafe("review.track.title"), actionCard(a) + '<button class="button secondary full" data-action="close-action">' + tSafe("common.close") + "</button>");
async function track(actionId) {
  tracked.add(actionId);
  let a = await api.get(`/v1/actions/${actionId}`);
  trackDialog(a);
  const started = Date.now();
  while (!["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED", "UNKNOWN"].includes(a.status) && Date.now() - started < 60_000) {
    await new Promise((r) => setTimeout(r, 800));
    a = await api.get(`/v1/actions/${actionId}`);
    if ($("action-dialog").open && $("action-body").querySelector(`[data-action-id="${actionId}"]`)) trackDialog(a);
  }
  await Promise.all([loadWork(), loadHouse(), loadActions()]);
  render();
}

// ---------------------------------------------------------------- thông báo đầu tiên và đồng ý
// Bốn mục đích của Thông báo đầu tiên. Tiêu đề, thân và phần đầu chung nằm ở catalog: `consent.<purpose_id>.title`,
// `consent.<purpose_id>.body`, `consent.notice.head`. Văn bản được băm vào biên nhận là văn bản ĐANG HIỆN lúc bấm lưu, ở
// ngôn ngữ đang chọn; `text_version` của bản dịch có hậu tố `.<tag>` (LNH-T25, shared/consent-text.js).
const PURPOSES = ["health_local", "calendar_link", "home_control", "beta_telemetry"];
/** `ticked`: giữ các ô đã đánh dấu khi hộp được vẽ lại vì đổi ngôn ngữ; bỏ trống thì lấy theo lựa chọn đã lưu. */
function onboarding(ticked = null) {
  const hs = healthState();
  const checked = (id) => (ticked ? ticked[id] === true : id === "health_local" ? healthConsent() : serverConsent(id));
  const texts = PURPOSES.map((id) => consentText(id));
  // Văn bản đang lùi về bản gốc (ngôn ngữ đang chọn thiếu bản dịch của mục đó) mang lang="vi".
  const langOf = (c) => (c.locale === getLocale() ? "" : ' lang="' + c.locale + '"');
  // Bản dịch máy chưa rà soát: nói rõ, và cho đọc bản gốc tiếng Việt ngay tại đây (LNH-T21).
  const original = draftUi()
    ? '<details class="notice-original"><summary>' + tSafe("i18n.draft.original") + '</summary><div lang="' + SOURCE_LOCALE + '"><p>' + safe(tSource("consent.notice.head")) + "</p>" +
      PURPOSES.map((id) => "<p><strong>" + safe(tSource("consent." + id + ".title")) + "</strong><br>" + safe(tSource("consent." + id + ".body")) + "</p>").join("") + "</div></details>"
    : "";
  const versions = formatList([...new Set(texts.map((c) => c.text_version))]);
  showAction(tSafe("consent.notice.title"), languageField("notice-locale", settings().locale) + draftNote() + original +
    '<p class="fine-print"' + langOf(texts[0]) + ">" + safe(texts[0].head) + '</p><form id="consent-form">' + texts.map((c) =>
      '<label class="consent-row"><input type="checkbox" name="' + c.purpose_id + '" ' + (checked(c.purpose_id) ? "checked" : "") + " " + ((c.purpose_id !== "health_local" && !online) ? "disabled" : "") + "><span" + langOf(c) + "><strong>" + safe(c.title) + "</strong><small>" + markCalendarTitle(safe(c.body)) + "</small></span></label>").join("") +
    '<p class="fine-print">' + tSafe(hs ? "consent.notice.versionLocal" : "consent.notice.version", { version: versions }) + '</p><button class="button primary full">' + tSafe("consent.save") + "</button></form>");
}
async function saveConsents(form) {
  const now = new Date(api.serverNow()).toISOString();
  const wanted = Object.fromEntries(PURPOSES.map((id) => [id, form.elements[id].checked]));
  // Phiên bản và mã băm của văn bản đang hiện, lấy một lượt trước mọi lời gọi mạng.
  const receipts = Object.fromEntries(await Promise.all(PURPOSES.map(async (id) => [id, await consentReceipt(id)])));
  for (const id of PURPOSES) {
    const want = wanted[id];
    const { text_version, text_hash } = receipts[id];
    if (id === "health_local") {
      // Biên nhận sức khỏe chỉ lưu trên thiết bị (SRS mục 08).
      const prev = healthState();
      const receipt = { purpose_id: "health_local", text_version, text_hash, choice: want ? "GRANTED" : "DECLINED", at: now, withdrawn_at: null };
      if (prev?.receipt?.choice === "GRANTED" && !want) receipt.withdrawn_at = now;
      writeStore(healthKey(), JSON.stringify({ receipt, revision: (prev?.revision ?? 0) + 1 }));
      continue;
    }
    if (!online) continue;
    const has = serverConsent(id);
    if (want && !has) await api.post("/v1/consents", { purpose_id: id, text_version, text_hash, choice: "GRANTED" });
    if (!want && has) await api.post(`/v1/consents/${id}/withdraw`);
    if (!want && !has && !me.consents.some((c) => c.purpose_id === id)) await api.post("/v1/consents", { purpose_id: id, text_version, text_hash, choice: "DECLINED" });
  }
  $("action-dialog").close();
  toast(t("consent.saved"));
  await refresh();
}

// ---------------------------------------------------------------- LeLe
// Câu lệnh mẫu viết bằng ngôn ngữ đang chọn: bảng từ dùng chung (shared/lele-lexicon.js, LNH-T24) nhận lệnh của cả 13 ngôn
// ngữ, và tests/lele-i18n.test.ts kiểm rằng câu mẫu của mỗi catalog được nhận ra. Catalog thiếu khóa thì câu mẫu là bản gốc
// tiếng Việt và mang lang="vi".
const leleExample = (key) => (messageLocale(key) === getLocale() ? safe(t(key)) : viSpan(tSource(key)));
function chat() {
  showAction(rich("lele.chat.title", { lele: mark("amber", "inline title") }), '<p class="fine-print">' + tSafe("lele.chat.intro") + '</p><div id="chat-list" class="chat-list" role="log" aria-live="polite"><div class="chat-message">' + rich("lele.chat.greeting", { exampleBlock: leleExample("lele.example.block"), exampleLamp: leleExample("lele.example.lampOff") }) + '</div></div><form id="chat-form" class="chat-form"><input name="message" maxlength="400" required aria-label="' + tSafe("lele.chat.inputLabel") + '" placeholder="' + tSafe("lele.chat.placeholder") + '"><button class="button primary" aria-label="' + tSafe("lele.chat.send") + '">' + icon("arrow") + "</button></form>");
}
/** Thêm một dòng vào cuộc trò chuyện. `text` là văn bản thuần; `html` (nếu có) thay cho `text` và phải đã thoát ký tự. */
function chatLine(text, kind, extra = "", html = null) {
  const node = document.createElement("div");
  node.className = "chat-message " + kind;
  if (html === null) node.textContent = text;
  else node.innerHTML = html;
  if (extra) node.insertAdjacentHTML("beforeend", extra);
  $("chat-list").append(node);
  $("chat-list").scrollTop = $("chat-list").scrollHeight;
}
/**
 * Tóm tắt một đề xuất, dựng trên thiết bị từ loại và tham số của chính đề xuất (không in câu `summary` tiếng Việt của máy
 * chủ, và không in câu do mô hình viết): người dùng đọc đúng thứ sẽ đi vào bước xem lại.
 */
function proposalSummary(p) {
  if (p.kind === "device.set_power") return t(p.args.command === "SET_ON" ? "review.describe.powerOn" : "review.describe.powerOff", { device: lampName(p.args.device_ref) });
  if (p.kind === "calendar.block") {
    const start = Date.parse(p.args.start);
    const n = Math.round((Date.parse(p.args.end) - start) / 60_000);
    const day = localDate(start, zone());
    const today = localDate(api.serverNow(), zone());
    const time = hhmm(p.args.start);
    if (day === today) return t("lele.summary.blockToday", { n, time });
    if (day === addDays(today, 1)) return t("lele.summary.blockTomorrow", { n, time });
    return t("lele.summary.blockDate", { n, time, date: formatDate(day, { day: "numeric", month: "numeric" }) });
  }
  return String(p.kind);
}
/** Câu trả lời không phải đề xuất: dựng từ `answer_code` (LNH-T23). */
function chatAnswer(r) {
  const code = typeof r.answer_code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(r.answer_code) ? r.answer_code : null;
  if (code === "HELP") return chatLine("", "assistant", "", rich("lele.answer.HELP", { exampleBlock: leleExample("lele.example.block"), exampleLamp: leleExample("lele.example.lampOn") }));
  if (code && hasMessage("lele.answer." + code)) return chatLine(t("lele.answer." + code), "assistant");
  // Máy chủ chưa gửi answer_code: câu `answer` của nó là tiếng Việt, chỉ in khi giao diện cũng đang là tiếng Việt.
  chatLine(getLocale() === SOURCE_LOCALE && typeof r.answer === "string" && r.answer ? r.answer : t("lele.answer.fallback"), "assistant");
}
let lastProposal = null;
// Đóng khi không chắc (LNH-T24, sửa LNH-F24). Câu chỉ được gửi tới máy chủ khi bảng từ dùng chung nhận ra lệnh đèn hoặc lệnh
// khung giờ VÀ không có từ sức khỏe hay dữ liệu cá nhân của bất kỳ ngôn ngữ nào trong 13 ngôn ngữ. Câu có từ sức khỏe được trả
// lời ngay tại đây; câu không nhận ra chỉ nhận câu hướng dẫn và không rời thiết bị. Máy chủ lặp lại đúng phép chặn này.
async function chatSend(value) {
  chatLine(value, "user");
  const scan = scanLele(value);
  const blocked = leleBlock(scan);
  if (blocked === "HEALTH") return chatLine(t("lele.local.health"), "assistant");
  if (blocked === "PII") return chatLine(t("lele.local.pii"), "assistant");
  if (!scan.intent) return scan.ui ? chatLine(t("lele.local.interface"), "assistant") : chatAnswer({ answer_code: "HELP" });
  if (!online) return chatLine(t("lele.local.offline"), "assistant");
  try {
    const r = await api.post("/v1/lele/proposals", { text: value, context: scan.intent.kind === "device.set_power" ? "home" : "work", zone: zone() });
    if (r.type === "PROPOSAL") {
      lastProposal = r.proposal;
      chatLine(t(r.ai_generated ? "lele.proposal.ai" : "lele.proposal.rules", { summary: proposalSummary(r.proposal) }), "assistant proposal", '<button class="button primary small" data-action="use-proposal">' + tSafe("lele.proposal.use") + "</button>");
    } else chatAnswer(r);
  } catch (e) {
    chatLine(errorText(e), "assistant");
  }
}

// ---------------------------------------------------------------- cài đặt
function settingFields() {
  const s = draftSettings;
  const theme = THEMES.find((th) => th.id === s.theme);
  const consentLine = dotJoin([
    t(healthConsent() ? "settings.privacy.health.on" : "settings.privacy.health.off"),
    t(serverConsent("calendar_link") ? "settings.privacy.calendar.on" : "settings.privacy.calendar.off"),
    t(serverConsent("home_control") ? "settings.privacy.home.on" : "settings.privacy.home.off"),
    t(serverConsent("beta_telemetry") ? "settings.privacy.telemetry.on" : "settings.privacy.telemetry.off"),
  ]);
  // Ô ngôn ngữ đứng đầu (LNH-T29). Dòng «bản dịch máy» hiện khi ngôn ngữ đang chọn trong ô là bản nháp (LNH-T21).
  const chosenDraft = localeInfo(resolveLocale(s.locale, navigator.languages)).draft;
  $("settings-fields").innerHTML = languageField("locale", s.locale, '<span class="fine-print">' + tSafe("settings.language.note") + "</span>" + (chosenDraft ? '<span class="fine-print draft-note">' + tSafe("i18n.draft.notice") + "</span>" : "")) +
    '<div class="field"><label for="display-name">' + tSafe("settings.name") + '</label><input id="display-name" name="name" value="' + safe(s.name) + '" placeholder="' + tSafe("common.you") + '" maxlength="48" autocomplete="off"></div>' +
    '<div class="field"><span>' + tSafe("settings.theme") + '</span><div class="settings-themes">' + THEMES.map((th) => themeButton(th, true)).join("") + '</div><span class="fine-print">' + tSafe("theme." + theme.id + ".name") + "</span></div>" +
    '<div class="field"><label for="font-size">' + tSafe("settings.fontSize") + '</label><select id="font-size" name="fontSize">' + FONT_SIZES.map((n) => '<option value="' + n + '" ' + (n === s.fontSize ? "selected" : "") + ">" + safe(formatNumber(n / 100, { style: "percent" })) + "</option>").join("") + "</select></div>" +
    '<div class="field"><label for="zone">' + tSafe("settings.zone") + '</label><select id="zone" name="zone">' + [...new Set([s.zone, ...ZONES])].map((z) => '<option value="' + safe(z) + '" ' + (z === s.zone ? "selected" : "") + ">" + safe(z) + "</option>").join("") + '</select><span class="fine-print">' + tSafe("settings.zoneNote") + "</span></div>" +
    '<div class="field"><label for="accent-color">' + tSafe("settings.accent") + '</label><div style="display:flex;align-items:center;gap:12px"><input type="color" id="accent-color" name="accent" value="' + (s.accent || theme.accent) + '"><button type="button" class="text-button" data-action="theme-accent">' + tSafe("settings.accentReset") + "</button></div></div>" +
    '<label class="checkbox-row">' + tSafe("settings.reducedMotion") + '<input type="checkbox" name="reducedMotion" ' + (s.reducedMotion ? "checked" : "") + "></label>" +
    '<label class="checkbox-row">' + tSafe("settings.compact") + '<input type="checkbox" name="compact" ' + (s.compact ? "checked" : "") + "></label>" +
    '<div class="field"><span>' + tSafe("settings.widgets") + '</span><span class="fine-print">' + tSafe("settings.widgetsNote") + "</span></div>" +
    [["sleep", "settings.widget.sleep"], ["steps", "settings.widget.steps"], ["schedule", "settings.widget.schedule"]].map(([k, key]) => '<label class="checkbox-row">' + tSafe(key) + '<input type="checkbox" data-widget="' + k + '" ' + (s.widgets.includes(k) ? "checked" : "") + "></label>").join("");
  $("privacy-settings").innerHTML = '<div class="privacy-box"><h3>' + tSafe("settings.privacy.title") + '</h3><p class="fine-print">' + safe(consentLine) + '</p><div class="button-row"><button type="button" class="button secondary" data-action="onboarding">' + tSafe("settings.privacy.change") + '</button><button type="button" class="button secondary" data-action="privacy-export" ' + (online ? "" : "disabled") + ">" + tSafe("settings.privacy.export") + "</button></div></div>";
}
function captureDraft() {
  const form = $("settings-form");
  draftSettings = { ...draftSettings, locale: form.elements.locale.value, name: form.elements.name.value, fontSize: Number(form.elements.fontSize.value), zone: form.elements.zone.value, reducedMotion: form.elements.reducedMotion.checked, compact: form.elements.compact.checked, widgets: [...form.querySelectorAll("[data-widget]:checked")].map((el) => el.dataset.widget) };
}
function openSettings() {
  if ($("action-dialog").open) $("action-dialog").close();
  draftSettings = structuredClone(settings());
  settingFields();
  $("settings-dialog").showModal();
}
async function profiles() {
  if ($("settings-dialog").open) $("settings-dialog").close();
  const users = api.devUsers;
  // Màn hình không nằm trên thanh dưới của điện thoại (Kết nối) vào được từ đây ở mọi cỡ màn hình (LNH-T51).
  const more = VIEWS.filter((v) => !v.nav.bar && isVisible(v));
  const moreRows = more.length
    ? '<div class="account-nav"><h3>' + tSafe("nav.more") + "</h3>" + more.map((v) => '<button class="card account-nav-row" data-nav="' + v.id + '">' + icon(v.nav.icon) + '<span class="event-copy"><strong>' + safe(v.nav.label(baseCtx)) + "</strong>" + (v.nav.hint ? "<span>" + safe(v.nav.hint(baseCtx)) + "</span>" : "") + "</span>" + icon("arrow") + "</button>").join("") + "</div>"
    : "";
  showAction(tSafe("account.title"), (api.dev
    ? '<p class="fine-print">' + tSafe("account.devNote") + "</p>" + users.map((u) => '<div class="profile-row"><button class="button secondary" data-login="' + safe(u.sub) + '">' + bdi(u.name) + (u.sub === me?.user.id ? icon("check") : "") + "</button></div>").join("")
    : '<p class="fine-print">' + tSafe("account.oidcNote") + "</p>") + moreRows);
}

const actionsMap = {
  settings: openSettings,
  profiles,
  onboarding,
  chat,
  "close-settings": () => $("settings-dialog").close(),
  "close-action": () => {
    stopCountdown();
    $("action-dialog").close();
  },
  "theme-accent": () => {
    captureDraft();
    draftSettings.accent = "";
    settingFields();
  },
  "reset-settings": () => {
    // Khôi phục mặc định không đổi tên hiển thị và ngôn ngữ đang chọn trong ô.
    captureDraft();
    draftSettings = { ...defaults(draftSettings.name), locale: draftSettings.locale };
    settingFields();
  },
  export: () => {
    const blob = new Blob([JSON.stringify({ version: 2, settings: settings() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "LeNhip-tuy-chon.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  "new-block": () => {
    const today = localDate(api.serverNow(), zone());
    showAction(tSafe("work.block.title"), '<p class="fine-print">' + tSafe("work.block.zone", { zone: zone() }) + '</p><form id="block-form"><div class="field"><label for="block-day">' + tSafe("work.block.day") + '</label><select id="block-day" name="day"><option value="' + today + '">' + tSafe("common.today") + '</option><option value="' + addDays(today, 1) + '">' + tSafe("common.tomorrow") + '</option></select></div><div class="field"><label for="block-start">' + tSafe("work.block.start") + '</label><input id="block-start" name="start" type="time" value="10:00" required></div><div class="field"><label for="block-end">' + tSafe("work.block.end") + '</label><input id="block-end" name="end" type="time" value="10:30" required></div><p id="block-error" class="form-error" role="alert" hidden></p><button class="button primary full">' + tSafe("work.block.review") + "</button></form>");
  },
  "approve-plan": approve,
  "cancel-plan": async () => {
    stopCountdown();
    try {
      await api.post(`/v1/plans/${pendingPlan.plan.plan_id}/cancel`);
    } catch {
      /* đã hết hạn hoặc đã đóng */
    }
    $("action-dialog").close();
    toast(t("review.canceled"));
  },
  repropose: () => propose(pendingPlan.input, pendingPlan.label),
  robot: () => propose({ kind: "robot.simulate", schema_version: 1, workspace_ref: api.ws, args: { scenario: "DELIVER_DOCUMENT" } }, t("review.label.robot")),
  "use-proposal": () => {
    if (!lastProposal) return;
    const label = t(lastProposal.kind === "calendar.block" ? "review.label.leleCalendar" : "review.label.leleHome");
    propose({ kind: lastProposal.kind, schema_version: 1, workspace_ref: api.ws, args: lastProposal.args }, label);
  },
  "health-source": () => showAction(tSafe("health.sourceDialog.title"), '<div class="privacy-note">' + icon("shield") + "<span>" + tSafe("health.sourceDialog.synthetic") + "</span></div><p>" + tSafe("health.sourceDialog.text") + '</p><p class="fine-print">' + tSafe("health.sourceDialog.meta", { algorithm: health?.algorithm_version ?? "LNH-SLEEP-1", revision: String(health?.source_revision ?? "-"), zone: zone() }) + '</p><button class="button primary full" data-action="close-action">' + tSafe("common.understood") + "</button>"),
  "health-export": () => {
    if (!health) return;
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), note: t(healthSynthetic() ? "health.export.noteSynthetic" : "health.export.noteImport"), days: health.days, summary: health.summary }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "LeNhip-suc-khoe-tren-thiet-bi.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  "health-erase": () => {
    const s = healthState();
    if (s) writeStore(healthKey(), JSON.stringify({ ...s, revision: (s.revision ?? 0) + 1 }));
    computeHealth();
    render();
    toast(t("health.erased"));
  },
  "privacy-export": async () => {
    try {
      if (api.dev) await api.login(me.user.id); // xác thực lại (auth_time mới) trước khi xuất
      const r = await api.post("/v1/privacy/requests", { type: "EXPORT" });
      const data = await api.get(r.export.path);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "LeNhip-du-lieu-may-chu.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(t("settings.privacy.exported"));
    } catch (e) {
      toast(errorText(e));
    }
  },
};

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.nav) {
    // Dòng điều hướng trong hộp Tài khoản: đóng hộp trước để focus chuyển được vào nội dung của màn hình mới.
    const dialog = target.closest("dialog");
    if (dialog?.open) dialog.close();
    navigate(target.dataset.nav);
    return;
  }
  if (target.dataset.themeChoice) {
    settings().theme = target.dataset.themeChoice;
    settings().accent = "";
    savePrefs();
    return render();
  }
  if (target.dataset.draftTheme) {
    captureDraft();
    draftSettings.theme = target.dataset.draftTheme;
    draftSettings.accent = "";
    return settingFields();
  }
  if (target.dataset.context) {
    context = target.dataset.context;
    if (context === "work" && currentView?.context === "personal") return navigate("work");
    if (context === "personal" && currentView?.context === "work") return navigate("home");
    return render();
  }
  if (target.dataset.login) {
    await api.login(target.dataset.login);
    prefs.activeSub = target.dataset.login;
    $("action-dialog").close();
    await refresh();
    savePrefs();
    if (!healthState() && !me?.consents?.length) onboarding();
    return;
  }
  if (target.dataset.device) {
    const d = devices.find((x) => x.device_ref === target.dataset.device);
    if (!d) return;
    const on = d.state?.power === "ON";
    return propose({ kind: "device.set_power", schema_version: 1, workspace_ref: api.ws, args: { site: d.site, device_ref: d.device_ref, command: on ? "SET_OFF" : "SET_ON" } }, t("review.label.home", { site: site?.name ?? d.site }));
  }
  if (target.dataset.checkAction) {
    const a = await api.get(`/v1/actions/${target.dataset.checkAction}`);
    actions = actions.map((x) => (x.action_id === a.action_id ? a : x));
    if ($("action-dialog").open) trackDialog(a);
    else render();
    return;
  }
  if (target.dataset.cancelAction) {
    try {
      await api.post(`/v1/actions/${target.dataset.cancelAction}/cancel`);
    } catch (e) {
      toast(errorText(e));
    }
    await loadActions();
    return render();
  }
  const handler = actionsMap[target.dataset.action];
  if (handler) handler();
});
$("settings-form").addEventListener("input", (event) => {
  if (event.target.name === "accent") draftSettings.accent = event.target.value;
});
// Đổi ngôn ngữ trong ô của hộp Cá nhân hóa: vẽ lại các trường để dòng «bản dịch máy» khớp lựa chọn; chưa áp dụng tới khi lưu.
$("settings-form").addEventListener("change", (event) => {
  if (event.target.name !== "locale") return;
  captureDraft();
  settingFields();
  $("locale").focus();
});
$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  captureDraft();
  const before = settings();
  const next = sanitizeSettings(draftSettings);
  // Ngôn ngữ đổi khi lưu, không nạp lại trang. Bị từ chối khi một kế hoạch đang chờ đồng ý (LNH-T29) hoặc khi bản dựng chưa
  // có catalog của ngôn ngữ đó; các tùy chọn khác vẫn được lưu.
  const refusal = await localeRefusal(next.locale, before.locale);
  if (refusal) next.locale = before.locale;
  prefs.users[sub()] = next;
  const persisted = savePrefs();
  $("settings-dialog").close();
  if (before.zone !== next.zone) computeHealth();
  await syncLocale();
  render();
  if (refusal) toast(t(refusal));
  else if (persisted) toast(before.zone !== next.zone ? t("settings.saved.zone", { zone: next.zone }) : next.name ? t("settings.saved.name", { name: next.name }) : t("settings.saved.anon"));
});
// Đổi ngôn ngữ ngay trên Thông báo đầu tiên: áp dụng liền, vẽ lại hộp bằng ngôn ngữ mới và giữ các ô đã đánh dấu. Biên nhận
// ghi phiên bản và mã băm của văn bản đang hiện lúc bấm lưu.
document.addEventListener("change", async (event) => {
  const select = event.target;
  if (select.id !== "notice-locale") return;
  const form = $("consent-form");
  const ticked = Object.fromEntries(PURPOSES.map((id) => [id, form.elements[id].checked]));
  const current = settings().locale;
  const next = isLocale(select.value) ? select.value : "auto";
  const refusal = await localeRefusal(next, current);
  if (refusal) {
    select.value = current;
    return toast(t(refusal));
  }
  settings().locale = next;
  savePrefs();
  await syncLocale();
  render();
  // Thông báo mở từ hộp Cá nhân hóa nằm chồng lên hộp đó: các trường bên dưới cũng đổi ngôn ngữ và ô ngôn ngữ của nó nhận
  // lựa chọn mới, để bấm «Lưu» ở đó không đưa ngôn ngữ cũ trở lại.
  if ($("settings-dialog").open) {
    captureDraft();
    draftSettings.locale = next;
    settingFields();
  }
  if (!$("consent-form")) return; // hộp đã đóng trong lúc nạp catalog
  onboarding(ticked);
  $("notice-locale").focus();
});
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (form.id === "block-form") {
    event.preventDefault();
    const { day, start, end } = Object.fromEntries(new FormData(form));
    let problem = null;
    let window = null;
    if (!(String(end) > String(start))) problem = "work.block.endBeforeStart";
    else {
      try {
        window = [String(start), String(end)].map((hhmm) => new Date(zonedToInstant(String(day), hhmm, zone())).toISOString());
      } catch {
        problem = "work.block.invalidTime";
      }
    }
    if (problem) {
      $("block-error").textContent = t(problem);
      $("block-error").hidden = false;
    } else propose({ kind: "calendar.block", schema_version: 1, workspace_ref: api.ws, args: { calendar_ref: "primary", start: window[0], end: window[1], zone: zone(), title_code: "PERSONAL_TIME", visibility: "private" } }, t("review.label.calendar"));
  }
  if (form.id === "consent-form") {
    event.preventDefault();
    saveConsents(form);
  }
  if (form.id === "chat-form") {
    event.preventDefault();
    const input = form.elements.message;
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    chatSend(value);
  }
});
$("import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 16384) throw new SettingsFileError("settings.import.tooLarge");
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new SettingsFileError("settings.import.invalid");
    }
    if (!data || ![1, 2].includes(data.version) || !data.settings) throw new SettingsFileError("settings.import.unsupported");
    const before = settings();
    const next = sanitizeSettings({ ...before, ...data.settings });
    // Ngôn ngữ trong tệp nhập đi qua cùng phép kiểm với ô chọn ngôn ngữ.
    const refusal = await localeRefusal(next.locale, before.locale);
    if (refusal) next.locale = before.locale;
    prefs.users[sub()] = next;
    savePrefs();
    $("settings-dialog").close();
    computeHealth();
    await syncLocale();
    render();
    toast(t(refusal ?? "settings.import.done"));
  } catch (err) {
    // Chỉ in câu của catalog theo khóa của lỗi; không in thông báo lỗi thô của trình duyệt.
    toast(t(err instanceof SettingsFileError ? err.key : "settings.import.invalid"));
  } finally {
    event.target.value = "";
  }
});
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1);
  if (!VIEWS.some((v) => v.id === next)) return; // ví dụ #main của liên kết bỏ qua: không phải màn hình
  // Màn hình có trong sổ đăng ký nhưng không hiện với tài khoản này (mô-đun tắt): trả địa chỉ về màn hình đang hiện.
  if (!navigate(next, false)) history.replaceState(null, "", "#" + (currentView?.id ?? "home"));
});
// Mọi cách đóng hộp thao tác (nút ✕, phím Escape, đóng từ mã) đều dừng đếm ngược của màn hình xem lại. Trước đây Escape để
// đồng hồ chạy tiếp và hộp tự mở lại với "Bản xem lại đã hết hạn" sau 120 giây. Kế hoạch chưa xác nhận tự hết hạn ở máy chủ.
$("action-dialog").addEventListener("close", async () => {
  if ($("action-dialog").open) return;
  stopCountdown();
  reviewing = false;
  releaseDialog();
  // Một lần đổi ngôn ngữ bị hoãn vì kế hoạch đang chờ đồng ý (ví dụ đổi tài khoản ở nền) được áp dụng khi hộp đóng.
  if (resolveLocale(settings().locale, navigator.languages) !== getLocale() && (await syncLocale())) render();
});
// Mất và có lại kết nối mạng: cập nhật thanh cảnh báo ngay, rồi nạp lại từ máy chủ khi có mạng. Không gửi lại thao tác nào.
window.addEventListener("offline", () => {
  online = false;
  render();
});
window.addEventListener("online", () => void refresh());
// Ẩn tab thì dừng mọi nhịp của màn hình và của phần chạy nền; hiện lại thì chạy tiếp (LNH-T35).
document.addEventListener("visibilitychange", () => {
  for (const scope of [...rootScopes]) {
    if (document.hidden) scope.pause();
    else scope.resume();
  }
});
// Thanh dưới của điện thoại cao theo nhãn (nhãn dài xuống dòng, cỡ chữ 200 %): chừa đúng chỗ đó cho nội dung và thông báo nổi.
if (typeof ResizeObserver === "function") {
  new ResizeObserver(() => {
    const h = Math.ceil($("mobile-nav").getBoundingClientRect().height);
    document.documentElement.style.setProperty("--bar-block", h + "px");
  }).observe($("mobile-nav"));
}

// ---------------------------------------------------------------- khởi động
let apiReady = false; // đã hỏi xong máy chủ đây là bản chạy thử hay bản tham chiếu
(async () => {
  // Phong cách và chữ LeNhip không phụ thuộc ngôn ngữ nên vẽ ngay; phần còn lại chờ catalog (LNH-T22: nạp trước lần vẽ đầu).
  // Khung ẩn (lớp i18n-pending) tới khi catalog nạp xong để không lóe chữ của ngôn ngữ khác; quá 1,5 giây thì hiện dù chưa xong.
  const reveal = () => document.body.classList.remove("i18n-pending");
  setTimeout(reveal, 1500);
  applyTheme();
  brand();
  try {
    await syncLocale();
  } finally {
    reveal();
  }
  render();
  await api.init();
  apiReady = true;
  const restored = api.restoreSession();
  if (!restored && api.dev) {
    try {
      await api.login(prefs.activeSub ?? "dev_a");
    } catch {
      /* máy chủ chưa chạy */
    }
  }
  await refresh();
  savePrefs();
  if (online && !healthState() && !(me?.consents?.length)) onboarding();
  // Một nguồn trên thiết bị vừa nhập hoặc xóa dữ liệu (LNH-T55): tính lại và vẽ lại, không gọi máy chủ.
  onHealthInputChanged(() => {
    computeHealth();
    render();
  });
  document.body.dataset.ready = "true"; // đã nạp xong lượt đầu (kể cả khi chưa nối được máy chủ); phép kiểm trình duyệt chờ mốc này
  // Cập nhật thẻ trạng thái định kỳ khi có thao tác chưa kết thúc.
  setInterval(async () => {
    if (!online || document.hidden || $("action-dialog").open || $("settings-dialog").open) return;
    if (!actions.some((a) => !["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"].includes(a.status))) return;
    await Promise.all([loadActions(), loadHouse(), loadWork()]);
    render();
  }, 5000);
})();
