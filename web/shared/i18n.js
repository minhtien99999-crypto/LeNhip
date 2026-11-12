// @ts-check
// Runtime ngôn ngữ của LeNhip (LNH-T22, LNH-T27, LNH-T28, LNH-T29). Không thư viện, chạy trên Node 22 và trình duyệt, chỉ dùng Intl.
// - Catalog là mô-đun `i18n-<file>.js` (phần lõi) và `i18n-<file>-<phần>.js` (PARTS), mỗi tệp đúng dạng
//   `export default ` + JSON chặt + `;` + xuống dòng. Khóa phẳng có dấu chấm. Nạp qua bảng import() cố định ở
//   i18n-loaders.js: một tag đã lưu chỉ được dùng để tra bảng, không bao giờ ghép thành đường dẫn.
// - Một thông điệp là chuỗi có {tên}, hoặc một đối tượng nhánh số nhiều theo loại CLDR (one, few, many, other…), chọn theo
//   tham số số `n` bằng Intl.PluralRules của ngôn ngữ CATALOG chứa thông điệp. Không cú pháp lồng, không HTML: t() trả văn
//   bản thuần, nơi gọi tự thoát ký tự khi ghép vào HTML.
// - Thiếu khóa: dùng bản tiếng Việt (bản gốc), rồi mới trả lại chính khóa và cảnh báo một lần. Thiếu tham số: ném lỗi.
// - Tiếng Việt được import tĩnh nên t() dùng được ngay, trước cả initI18n().
// - Giờ luôn 24 giờ HH:MM (LNH-T27). Thời lượng dựng từ NumberFormat đơn vị và ListFormat vì Node 22 chưa có
//   Intl.DurationFormat. Số, ngày, thứ định dạng theo ngôn ngữ đang chọn (tag của catalog).
// - Mọi bản không phải tiếng Việt là bản dịch máy chưa rà soát (draft: true, T21).
import viCore from "./i18n-vi.js";
import viMsg from "./i18n-vi-msg.js";
import viSocial from "./i18n-vi-social.js";
import viDev from "./i18n-vi-dev.js";
import { LOADERS as RAW_LOADERS } from "./i18n-loaders.js";

/** @typedef {string | Record<string, string>} Message */
/** @typedef {Record<string, Message>} Catalog */
/** @typedef {{ tag: string, file: string, name: string, dir: "ltr" | "rtl", draft: boolean }} LocaleInfo */
/** @typedef {Record<string, string | number | bigint | boolean>} Params */
/** @typedef {Record<string, Record<string, () => Promise<{ default: unknown }>>>} LoaderMap */

/**
 * 13 ngôn ngữ (LNH-T21): chín theo yêu cầu, bốn đề xuất thêm. `name` là tên tự gọi (không dịch), `file` là tag viết thường.
 * @type {readonly LocaleInfo[]}
 */
export const LOCALES = Object.freeze([
  { tag: "vi", file: "vi", name: "Tiếng Việt", dir: /** @type {const} */ ("ltr"), draft: false },
  { tag: "en", file: "en", name: "English", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "fr", file: "fr", name: "Français", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "zh-Hans", file: "zh-hans", name: "简体中文", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "ko", file: "ko", name: "한국어", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "ja", file: "ja", name: "日本語", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "es", file: "es", name: "Español", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "pt-BR", file: "pt-br", name: "Português (Brasil)", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "it", file: "it", name: "Italiano", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "zh-Hant", file: "zh-hant", name: "繁體中文", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "id", file: "id", name: "Bahasa Indonesia", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "ru", file: "ru", name: "Русский", dir: /** @type {const} */ ("ltr"), draft: true },
  { tag: "de", file: "de", name: "Deutsch", dir: /** @type {const} */ ("ltr"), draft: true },
].map((l) => Object.freeze(l)));

/** Các phần catalog theo mô-đun: msg (nhắn tin, thiết bị của tôi), social (mạng xã hội), dev (thiết bị theo dõi). */
export const PARTS = Object.freeze(["msg", "social", "dev"]);
/** Bản gốc: luôn đủ khóa, là chỗ lùi của mọi ngôn ngữ. */
export const SOURCE_LOCALE = "vi";
/** Trình duyệt không khớp ngôn ngữ nào thì dùng tiếng Anh (LNH-T29, LNH-Q14). */
export const DEFAULT_LOCALE = "en";
/** Loại số nhiều CLDR hợp lệ làm khóa nhánh. */
export const PLURAL_CATEGORIES = Object.freeze(["zero", "one", "two", "few", "many", "other"]);

/** Bảng nạp: tag → { core, msg, social, dev } → hàm import(). Xuất ra để kiểm thử đối chiếu với LOCALES × (core + PARTS). */
export const LOADERS = /** @type {LoaderMap} */ (RAW_LOADERS);

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Ngôn ngữ (subtag đầu) → tag catalog, trừ tiếng Trung (chọn theo hệ chữ) và tiếng Bồ (luôn pt-BR). */
const BY_LANGUAGE = new Map(LOCALES.filter((l) => !l.tag.includes("-")).map((l) => [l.tag, l.tag]));

/** @type {Map<string, Catalog>} */
const catalogs = new Map([[SOURCE_LOCALE, /** @type {Catalog} */ ({ ...viCore, ...viMsg, ...viSocial, ...viDev })]]);
/** @type {Map<string, Promise<void>>} */
const loading = new Map();
/** @type {Set<string>} */
const warned = new Set();
let active = SOURCE_LOCALE;

/** @param {string} id @param {string} message */
function warnOnce(id, message) {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(message);
}

/** @param {unknown} tag @returns {tag is string} */
export function isLocale(tag) {
  return typeof tag === "string" && LOCALES.some((l) => l.tag === tag);
}

/** @param {string} [tag] mặc định là ngôn ngữ đang chọn */
export function localeInfo(tag = active) {
  const info = LOCALES.find((l) => l.tag === tag);
  if (!info) throw new RangeError(`i18n: ngôn ngữ không được hỗ trợ: ${String(tag).slice(0, 35)}`);
  return info;
}

/** @param {unknown} raw một phần tử của navigator.languages; có thể là rác */
function matchTag(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 35) return null;
  let locale;
  try {
    locale = new Intl.Locale(raw);
  } catch {
    return null; // "*", "pt_BR", "zh-CHS", chuỗi rỗng…: bỏ qua, xét tag kế tiếp
  }
  if (locale.language === "zh") {
    // Hệ chữ quyết định: zh-TW, zh-HK, zh-MO, zh-Hant-* → phồn thể; không bao giờ đưa người đọc phồn thể sang giản thể.
    const script = locale.script ?? locale.maximize().script;
    return script === "Hant" ? "zh-Hant" : "zh-Hans";
  }
  if (locale.language === "pt") return "pt-BR";
  return BY_LANGUAGE.get(locale.language) ?? null;
}

/**
 * Chọn catalog theo danh sách ưu tiên của trình duyệt (navigator.languages). Tag đầu tiên khớp thắng; không khớp → tiếng Anh.
 * @param {readonly unknown[] | string | null | undefined} requested
 */
export function negotiate(requested) {
  const list = typeof requested === "string" ? [requested] : Array.isArray(requested) ? requested : [];
  for (const raw of list) {
    const tag = matchTag(raw);
    if (tag) return tag;
  }
  return DEFAULT_LOCALE;
}

/**
 * Thiết lập `locale` của người dùng ("auto" hoặc một tag trong LOCALES) → tag catalog. Giá trị lạ được coi là "auto".
 * @param {unknown} pref
 * @param {readonly unknown[] | string | null | undefined} requested
 */
export function resolveLocale(pref, requested) {
  return isLocale(pref) ? pref : negotiate(requested);
}

const browserNavigator = () => /** @type {{ navigator?: { languages?: readonly string[], language?: string } }} */ (globalThis).navigator;

/**
 * Nạp catalog của một ngôn ngữ (lõi và mọi phần). Tệp chưa có hoặc hỏng thì phần đó lùi về tiếng Việt, không ném lỗi, và
 * ghi một dòng cảnh báo cho cả ngôn ngữ. Tham số thứ hai chỉ để kiểm thử thay bảng nạp (khi đó luôn nạp lại).
 * @param {string} tag
 * @param {LoaderMap} [loaders]
 */
export async function loadLocale(tag, loaders = LOADERS) {
  const info = localeInfo(tag);
  if (loaders === LOADERS) {
    if (catalogs.has(info.tag)) return;
    const pending = loading.get(info.tag);
    if (pending) return pending;
  }
  const job = (async () => {
    /** @type {Catalog} */
    const merged = {};
    /** @type {string[]} */
    const missing = [];
    await Promise.all(["core", ...PARTS].map(async (part) => {
      const file = `i18n-${info.file}${part === "core" ? "" : "-" + part}.js`;
      try {
        const load = Object.hasOwn(loaders, info.tag) ? loaders[info.tag][part] : undefined;
        if (typeof load !== "function") throw new Error("không có trong bảng nạp");
        const data = (await load()).default;
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("không phải đối tượng");
        Object.assign(merged, data);
      } catch {
        missing.push(file);
      }
    }));
    if (missing.length) warnOnce("load:" + info.tag, `i18n: chưa nạp được ${missing.sort().join(", ")}; các phần này dùng bản tiếng Việt.`);
    catalogs.set(info.tag, merged);
  })();
  if (loaders !== LOADERS) return job;
  loading.set(info.tag, job);
  try {
    await job;
  } finally {
    loading.delete(info.tag);
  }
}

/**
 * Chọn ngôn ngữ đang dùng. Ném RangeError nếu tag không thuộc LOCALES.
 * @param {string} tag
 */
export async function setLocale(tag) {
  const info = localeInfo(tag);
  await loadLocale(info.tag);
  active = info.tag;
  return active;
}

export function getLocale() {
  return active;
}

/**
 * Khởi động: `pref` là thiết lập đã lưu ("auto" hoặc tag); "auto" thì theo trình duyệt (LNH-T29).
 * @param {unknown} [pref]
 * @param {readonly unknown[] | string | null} [requested] mặc định navigator.languages
 */
export async function initI18n(pref = "auto", requested) {
  const nav = browserNavigator();
  return setLocale(resolveLocale(pref, requested ?? nav?.languages ?? nav?.language));
}

/** @param {string} key @returns {{ tag: string, message: Message } | null} */
function lookup(key) {
  for (const tag of active === SOURCE_LOCALE ? [SOURCE_LOCALE] : [active, SOURCE_LOCALE]) {
    const catalog = catalogs.get(tag);
    if (catalog && Object.hasOwn(catalog, key)) return { tag, message: catalog[key] };
  }
  return null;
}

/** Có khóa này trong ngôn ngữ đang chọn hoặc trong bản gốc không. @param {string} key */
export function hasMessage(key) {
  return lookup(key) !== null;
}

/** @type {Map<string, Intl.PluralRules>} */
const pluralCache = new Map();
/** @param {string} tag */
function pluralRules(tag) {
  let rules = pluralCache.get(tag);
  if (!rules) pluralCache.set(tag, (rules = new Intl.PluralRules(tag)));
  return rules;
}

/** @type {Map<string, Intl.NumberFormat>} */
const numberCache = new Map();
/** @param {string} tag @param {Intl.NumberFormatOptions} [options] */
function numberFormat(tag, options) {
  const id = tag + "|" + (options ? JSON.stringify(options) : "");
  let f = numberCache.get(id);
  if (!f) numberCache.set(id, (f = new Intl.NumberFormat(tag, options)));
  return f;
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const dateCache = new Map();
/** @param {string} tag @param {Intl.DateTimeFormatOptions} options */
function dateFormat(tag, options) {
  const id = tag + "|" + JSON.stringify(options);
  let f = dateCache.get(id);
  if (!f) dateCache.set(id, (f = new Intl.DateTimeFormat(tag, options)));
  return f;
}

/**
 * Văn bản thuần của một khóa. Số trong tham số được định dạng theo ngôn ngữ của thông điệp; muốn giữ nguyên thì truyền chuỗi.
 * @param {string} key
 * @param {Params} [params] thông điệp số nhiều cần `n` là số
 */
export function t(key, params) {
  const found = lookup(key);
  if (!found) {
    warnOnce("key:" + key, `i18n: thiếu khóa ${key}`);
    return key;
  }
  let text;
  if (typeof found.message === "string") {
    text = found.message;
  } else {
    const n = params?.n;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`i18n: khóa ${key} là thông điệp số nhiều, cần tham số số n`);
    const branch = found.message[pluralRules(found.tag).select(n)] ?? found.message.other;
    if (typeof branch !== "string") throw new Error(`i18n: khóa ${key} thiếu nhánh other`);
    text = branch;
  }
  return text.replace(PLACEHOLDER, (_, /** @type {string} */ name) => {
    const value = params && Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined || value === null) throw new Error(`i18n: thiếu tham số {${name}} của khóa ${key}`);
    return typeof value === "number" ? numberFormat(found.tag, undefined).format(value) : String(value);
  });
}

/** @param {number | bigint} value @param {Intl.NumberFormatOptions} [options] */
export function formatNumber(value, options) {
  return numberFormat(active, options).format(value);
}

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/**
 * Chuỗi "YYYY-MM-DD" là ngày theo lịch (không có múi giờ). Thời điểm là Date, số mili giây, hoặc chuỗi ISO 8601 có độ lệch
 * ("…Z" hoặc "…+07:00") như API trả về; chuỗi dạng khác bị từ chối để không đoán theo cách đọc riêng của từng trình duyệt.
 * @param {Date | number | string} value
 * @returns {{ date: Date, calendar: boolean }}
 */
function toDate(value) {
  const calendar = typeof value === "string" && CALENDAR_DATE.test(value);
  if (typeof value === "string" && !calendar && !INSTANT.test(value)) throw new RangeError("i18n: ngày giờ không hợp lệ");
  const date = value instanceof Date ? value : new Date(calendar ? value + "T00:00:00Z" : value);
  if (Number.isNaN(date.getTime())) throw new RangeError("i18n: ngày giờ không hợp lệ");
  return { date, calendar };
}

/**
 * Ngày theo ngôn ngữ đang chọn. Mặc định dateStyle "medium". Thời điểm cần `timeZone` (múi IANA) trong options, không thì
 * dùng múi của máy; ngày theo lịch "YYYY-MM-DD" in đúng ngày đó ở mọi múi.
 * @param {Date | number | string} value
 * @param {Intl.DateTimeFormatOptions} [options]
 */
export function formatDate(value, options = { dateStyle: "medium" }) {
  const { date, calendar } = toDate(value);
  return dateFormat(active, calendar ? { ...options, timeZone: "UTC" } : options).format(date);
}

/**
 * Tên thứ trong tuần theo ngôn ngữ đang chọn.
 * @param {Date | number | string} value thời điểm hoặc ngày theo lịch "YYYY-MM-DD"
 * @param {"long" | "short" | "narrow"} [style]
 * @param {string} [timeZone] múi IANA cho thời điểm
 */
export function formatWeekday(value, style = "long", timeZone) {
  const { date, calendar } = toDate(value);
  return dateFormat(active, { weekday: style, timeZone: calendar ? "UTC" : timeZone }).format(date);
}

/**
 * Giờ luôn ở dạng 24 giờ HH:MM, không phụ thuộc ngôn ngữ (LNH-T27).
 * @param {Date | number | string} value thời điểm
 * @param {string} [timeZone] múi IANA; bỏ trống thì dùng múi của máy
 */
export function formatTime24(value, timeZone) {
  const { date } = toDate(value);
  const parts = dateFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(date);
  const pick = (/** @type {string} */ type) => (parts.find((p) => p.type === type)?.value ?? "00").padStart(2, "0");
  return `${pick("hour")}:${pick("minute")}`;
}

/** @type {Map<string, Intl.ListFormat>} */
const listCache = new Map();
/**
 * @param {readonly string[]} items
 * @param {Intl.ListFormatOptions} [options] mặc định liệt kê "và" dạng dài
 */
export function formatList(items, options = { type: "conjunction", style: "long" }) {
  const id = active + "|" + JSON.stringify(options);
  let f = listCache.get(id);
  if (!f) listCache.set(id, (f = new Intl.ListFormat(active, options)));
  return f.format(items);
}

/**
 * Thời lượng từ số phút: giờ và phút, bỏ phần bằng 0 (0 phút vẫn in "0 phút"). Mặc định đơn vị ngắn, nối kiểu hẹp:
 * tiếng Việt "7 giờ 30 phút", tiếng Anh "7 hr 30 min".
 * @param {number} minutes làm tròn tới phút; phải ≥ 0
 * @param {{ unit?: "long" | "short" | "narrow", list?: "long" | "short" | "narrow" }} [o]
 */
export function formatDuration(minutes, o = {}) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) throw new RangeError("i18n: thời lượng phải là số phút không âm");
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const unitDisplay = o.unit ?? "short";
  /** @type {string[]} */
  const parts = [];
  if (hours > 0) parts.push(numberFormat(active, { style: "unit", unit: "hour", unitDisplay }).format(hours));
  if (rest > 0 || hours === 0) parts.push(numberFormat(active, { style: "unit", unit: "minute", unitDisplay }).format(rest));
  return formatList(parts, { type: "unit", style: o.list ?? "narrow" });
}
