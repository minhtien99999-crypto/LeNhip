// @ts-check
// Phương án giao diện và tùy chọn cá nhân của LeNhip (gói giao diện V1.0, 5 phương án PA01–PA05), tinh chỉnh: cỡ chữ tới 200 %
// (SRS mục 13, T18), múi phân tích IANA, tôn trọng prefers-reduced-motion. Chỉ lưu tùy chọn giao diện trên trình duyệt; lịch,
// đèn và đồng ý nằm ở máy chủ; sức khỏe tính trên thiết bị, không lưu số đo.
// V1.0.0: thêm `locale` ("auto" theo trình duyệt, hoặc một tag trong LOCALES của shared/i18n.js). Ngôn ngữ lưu theo thiết bị
// như các tùy chọn giao diện khác (LNH-T29); máy chủ không biết ngôn ngữ của người dùng (LNH-T23).
// Tệp này không chứa chữ hiển thị: tên và mô tả phong cách nằm ở khóa `theme.<id>.name`, `theme.<id>.description` của catalog,
// lỗi của tệp tùy chọn mang khóa catalog (SettingsFileError), tên hiển thị để trống nghĩa là «Bạn» của ngôn ngữ đang chọn.

import { isValidZone } from "./shared/zone.js";
import { isLocale } from "./shared/i18n.js";

/** Năm phương án PA01–PA05. Tên và mô tả hiển thị: khóa `theme.<id>.name` và `theme.<id>.description` của catalog. */
export const THEMES = [
  { id: "orbit", code: "PA01", accent: "#087f91", colors: ["#edfaff", "#19aabd", "#e2b45a"] },
  { id: "night", code: "PA02", accent: "#65dcff", colors: ["#101c35", "#65dcff", "#a893ff"] },
  { id: "calm", code: "PA03", accent: "#5c713d", colors: ["#f5f2e9", "#768655", "#e9b38c"] },
  { id: "flow", code: "PA04", accent: "#0864d9", colors: ["#e9f4ff", "#0878f5", "#43cfbb"] },
  { id: "titanium", code: "PA05", accent: "#65f0ec", colors: ["#30343b", "#65f0ec", "#acb4c2"] },
];

/** Lỗi của tệp tùy chọn giao diện; `key` là khóa catalog của câu báo cho người dùng (không mang câu chữ). */
export class SettingsFileError extends Error {
  /** @param {string} key */
  constructor(key) {
    super(key);
    this.name = "SettingsFileError";
    this.key = key;
  }
}

/**
 * Tên mặc định mà bản 0.1.0 ghi vào thiết lập khi người dùng chưa đặt tên (chữ «Bạn», viết bằng mã ký tự vì đây là dữ liệu cũ
 * cần nhận ra, không phải chữ hiển thị). Từ V1.0.0 tên để trống và giao diện in `common.you` của ngôn ngữ đang chọn.
 */
const LEGACY_DEFAULT_NAME = "B\u1ea1n";

export const FONT_SIZES = [100, 115, 130, 150, 200];
export const WIDGETS = ["sleep", "steps", "schedule"];
export const ZONES = ["Asia/Ho_Chi_Minh", "Asia/Bangkok", "Asia/Singapore", "Asia/Tokyo", "Europe/Berlin", "America/Los_Angeles", "UTC"];

const prefersReduced = () => {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
};

export function browserZone() {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidZone(z) ? z : "Asia/Ho_Chi_Minh";
  } catch {
    return "Asia/Ho_Chi_Minh";
  }
}

/** @param {string} name tên hiển thị; để trống thì giao diện dùng `common.you` */
export function defaults(name = "") {
  return { theme: "orbit", accent: "", name, fontSize: 100, reducedMotion: prefersReduced(), compact: false, widgets: [...WIDGETS], zone: browserZone(), locale: "auto" };
}

/**
 * Chỉ giữ đúng các tùy chọn giao diện được phép; mọi trường khác (lịch, hội thoại...) bị bỏ.
 * @param {any} value
 */
export function sanitizeSettings(value) {
  if (!value || typeof value !== "object") throw new SettingsFileError("settings.import.invalid");
  const name = typeof value.name === "string" ? value.name.trim().slice(0, 48) : "";
  const theme = THEMES.some((t) => t.id === value.theme) ? value.theme : "orbit";
  const widgets = Array.isArray(value.widgets) ? [...new Set(value.widgets.filter((/** @type {string} */ x) => WIDGETS.includes(x)))] : [...WIDGETS];
  return {
    theme,
    accent: /^#[0-9a-f]{6}$/i.test(value.accent || "") ? value.accent : "",
    name: name === LEGACY_DEFAULT_NAME ? "" : name,
    fontSize: FONT_SIZES.includes(Number(value.fontSize)) ? Number(value.fontSize) : 100,
    reducedMotion: value.reducedMotion === true,
    compact: value.compact === true,
    widgets,
    zone: isValidZone(value.zone) ? value.zone : browserZone(),
    locale: isLocale(value.locale) ? value.locale : "auto",
  };
}

/**
 * Tùy chọn giao diện theo tài khoản trên trình duyệt này (khóa lenhip.ui.v2). Bản lưu hỏng hoặc phiên bản lạ được thay bằng mặc định.
 * @param {string | null} raw
 */
export function restorePrefs(raw) {
  try {
    const data = JSON.parse(String(raw));
    if (!data || data.version !== 2 || typeof data.users !== "object") throw new Error("version");
    /** @type {Record<string, ReturnType<typeof sanitizeSettings>>} */
    const users = {};
    for (const [k, v] of Object.entries(data.users).slice(0, 16)) if (/^[A-Za-z0-9_.:@-]{1,128}$/.test(k)) users[k] = sanitizeSettings(v);
    return { version: 2, users, activeSub: typeof data.activeSub === "string" && data.activeSub in users ? data.activeSub : null };
  } catch {
    return { version: 2, users: {}, activeSub: null };
  }
}

/** Độ tương phản WCAG giữa chữ và nền (để chọn màu chữ trên màu nhấn riêng). @param {string} hex */
export function inkFor(hex) {
  const ch = (hex.slice(1).match(/../g) ?? ["00", "00", "00"]).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return lum > 0.179 ? "#071827" : "#ffffff";
}
