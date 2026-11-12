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
// - tParts() trả từng phần của thông điệp (chữ của bản dịch, giá trị tham số) để nơi gọi bọc tham số bằng HTML tin cậy của
//   mình (<bdi>, chữ LeLe…) mà bản dịch vẫn là văn bản thuần. tSource() luôn đọc bản gốc tiếng Việt (văn bản đồng ý gốc,
//   tiêu đề cố định của sự kiện lịch, LNH-T26). localizeStatic() điền chữ cho HTML tĩnh qua data-i18n và data-i18n-attr.
//
// QUY TẮC ĐẶT KHÓA (tests/i18n.test.ts kiểm phần máy kiểm được)
// - Khóa phẳng có dấu chấm, `^[a-z][a-z0-9]*(\.[A-Za-z0-9_]+)+$`. Đoạn đầu là lớp rà soát: consent.* (pháp lý; thân văn bản được
//   băm ở consent.<purpose_id>.body), health.* (câu về sức khỏe), state.* outcome.* reason.* grade.* (nhãn của MÃ hợp đồng, đoạn
//   cuối là đúng mã đó), review.* (màn hình quyết định), error.<CODE>[.<DETAIL_CODE>], lele.* (lele.answer.<ANSWER_CODE>),
//   nav.* (nhãn điều hướng: tối đa 12 ký tự với chữ Latin và Kirin, 6 với chữ Hán, kana, Hangul), settings.*, common.*, và
//   theo màn hình: home.*, work.*, house.*, shell.*, theme.<id>.name. Các phần dùng cùng lớp sau tiền tố của mình
//   (msg.error.<CODE>, social.state.<CODE>, msg.consent.messaging.body).
// - Một khóa là một câu trọn vẹn có {tham_số}; không ghép câu từ nhiều khóa. Chỗ có số đếm dùng nhánh số nhiều với `n`.
//
// HƯỚNG DẪN CHO NGƯỜI DỊCH (một ngôn ngữ = i18n-<file>.js và ba phần -msg, -social, -dev; bản gốc là i18n-vi*.js)
// - Giọng văn: câu ngắn, lịch sự, trung tính, nói thẳng với người dùng; viết hoa kiểu câu thường (nhãn nhỏ do CSS viết hoa).
//   Nhãn dài tối đa 2 lần, đoạn văn 1,5 lần bản tiếng Việt.
// - Không dịch: LeNhip, LeLe, LeDB, LeTRON, LeASO, Le-ORION, Microsoft 365, HealthKit, Health Connect, HealthSource, LNH-SLEEP-1,
//   OIDC, Outlook, Titanium, tên header, mã (UNKNOWN…). `brand.name` và `calendar.title.PERSONAL_TIME` giữ nguyên như bản tiếng
//   Việt; tiêu đề lịch «Thời gian cá nhân» nhắc trong câu cũng giữ nguyên tiếng Việt (LNH-T26).
// - Tham số: giữ đúng tên trong ngoặc nhọn, dùng đủ, được đổi thứ tự. Nhánh số nhiều: đúng và đủ các loại CLDR của ngôn ngữ
//   mình (Intl.PluralRules), nhánh `other` có đủ tham số. Không HTML, không thực thể, không ký tự ẩn hay ký tự điều khiển hướng
//   chữ; dạng NFC; chỉ xuống dòng ở chỗ bản gốc xuống dòng. Giờ, số, ngày do runtime định dạng: không viết sẵn trong câu.
// - Nghĩa phải giữ: state.UNKNOWN là «chưa xác minh», không bao giờ thành «thất bại» hay «đã xong»; health.* trung tính, không
//   chẩn đoán, không khuyên điều trị; consent.* dịch sát. Sửa một consent.*.body hoặc consent.notice.head thì đổi phiên bản ở
//   CONSENT_TEXT_VERSIONS (shared/consent-text.js) rồi chạy `node scripts/make-consent-texts.ts`.
// - lele.example.* phải là câu lệnh mà bảng từ của chính ngôn ngữ đó nhận ra (shared/lele-lex-<file>.js).
// - Kiểm riêng ngôn ngữ của mình: LENHIP_I18N_ONLY=<tag> node --test tests/i18n.test.ts tests/i18n-runtime.test.ts tests/lele-i18n.test.ts
import viCore from "./i18n-vi.js";
import viMsg from "./i18n-vi-msg.js";
import viSocial from "./i18n-vi-social.js";
import viDev from "./i18n-vi-dev.js";
import viBrief from "./i18n-vi-brief.js";
import viInbox from "./i18n-vi-inbox.js";
import viHomehub from "./i18n-vi-homehub.js";
import viMeas from "./i18n-vi-meas.js";
import viSim from "./i18n-vi-sim.js";
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

/**
 * Các phần catalog theo mô-đun: msg (nhắn tin, thiết bị của tôi), social (mạng xã hội), dev (thiết bị theo dõi); từ V1.0.1 (SRS V2.0):
 * brief (Bản tóm tắt buổi sáng, bản nháp, phiên thiết bị), inbox (Hộp tổng hợp), homehub (Le‑NodeHome, HaaS), meas (Le‑NodeHealth),
 * sim (cổng mô phỏng Le‑ORION).
 */
export const PARTS = Object.freeze(["msg", "social", "dev", "brief", "inbox", "homehub", "meas", "sim"]);
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
const catalogs = new Map([[SOURCE_LOCALE, /** @type {Catalog} */ ({ ...viCore, ...viMsg, ...viSocial, ...viDev, ...viBrief, ...viInbox, ...viHomehub, ...viMeas, ...viSim })]]);
/** Phần catalog đã nạp được của từng ngôn ngữ ("core", "msg"…); phần thiếu đang lùi về tiếng Việt. @type {Map<string, Set<string>>} */
const loadedParts = new Map([[SOURCE_LOCALE, new Set(["core", ...PARTS])]]);
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
    /** @type {Set<string>} */
    const got = new Set();
    await Promise.all(["core", ...PARTS].map(async (part) => {
      const file = `i18n-${info.file}${part === "core" ? "" : "-" + part}.js`;
      try {
        const load = Object.hasOwn(loaders, info.tag) ? loaders[info.tag][part] : undefined;
        if (typeof load !== "function") throw new Error("không có trong bảng nạp");
        const data = (await load()).default;
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("không phải đối tượng");
        Object.assign(merged, data);
        got.add(part);
      } catch {
        missing.push(file);
      }
    }));
    if (missing.length) warnOnce("load:" + info.tag, `i18n: chưa nạp được ${missing.sort().join(", ")}; các phần này dùng bản tiếng Việt.`);
    catalogs.set(info.tag, merged);
    loadedParts.set(info.tag, got);
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
 * Ngôn ngữ này đã nạp được phần catalog đó chưa. Chưa nạp (hoặc tệp chưa có) thì các khóa của phần ấy đang hiện bằng tiếng Việt.
 * @param {string} tag
 * @param {string} [part] "core" hoặc một phần trong PARTS
 */
export function hasCatalog(tag, part = "core") {
  return loadedParts.get(tag)?.has(part) === true;
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

/** @param {string} key @param {readonly string[]} [tags] thứ tự tra @returns {{ tag: string, message: Message } | null} */
function lookup(key, tags = active === SOURCE_LOCALE ? [SOURCE_LOCALE] : [active, SOURCE_LOCALE]) {
  for (const tag of tags) {
    const catalog = catalogs.get(tag);
    if (catalog && Object.hasOwn(catalog, key)) return { tag, message: catalog[key] };
  }
  return null;
}

/** Có khóa này trong ngôn ngữ đang chọn hoặc trong bản gốc không. @param {string} key */
export function hasMessage(key) {
  return lookup(key) !== null;
}

/** Bản gốc tiếng Việt có khóa này không (bất kể ngôn ngữ đang chọn). @param {string} key */
export function hasSourceMessage(key) {
  return lookup(key, [SOURCE_LOCALE]) !== null;
}

/**
 * Tag của catalog đang cung cấp khóa này: ngôn ngữ đang chọn, hoặc "vi" khi khóa thiếu ở đó; null khi không đâu có.
 * Văn bản đồng ý dùng hàm này để ghi đúng phiên bản của văn bản thật sự hiện ra (LNH-T25).
 * @param {string} key
 */
export function messageLocale(key) {
  return lookup(key)?.tag ?? null;
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

/** @typedef {{ type: "text", value: string } | { type: "param", name: string, value: string }} MessagePart */

/**
 * @param {{ tag: string, message: Message }} found
 * @param {string} key
 * @param {Params} [params]
 * @returns {MessagePart[]}
 */
function partsOf(found, key, params) {
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
  /** @type {MessagePart[]} */
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1];
    const value = params && Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined || value === null) throw new Error(`i18n: thiếu tham số {${name}} của khóa ${key}`);
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
    parts.push({ type: "param", name, value: typeof value === "number" ? numberFormat(found.tag, undefined).format(value) : String(value) });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts;
}

/**
 * Các phần của một thông điệp theo thứ tự của bản dịch: chữ của bản dịch (`text`) và giá trị tham số (`param`, kèm tên).
 * Nơi gọi dùng để chèn HTML tin cậy của mình vào chỗ một tham số (tên từ dữ liệu trong <bdi>, chữ LeLe, đoạn tiếng Việt có
 * lang="vi") hoặc để định kiểu riêng phần đơn vị; phần `text` vẫn phải được thoát ký tự khi ghép vào HTML.
 * Thiếu khóa: một phần `text` là chính khóa (và cảnh báo một lần), như t().
 * @param {string} key
 * @param {Params} [params]
 * @returns {MessagePart[]}
 */
export function tParts(key, params) {
  const found = lookup(key);
  if (!found) {
    warnOnce("key:" + key, `i18n: thiếu khóa ${key}`);
    return [{ type: "text", value: key }];
  }
  return partsOf(found, key, params);
}

/**
 * Văn bản thuần của một khóa. Số trong tham số được định dạng theo ngôn ngữ của thông điệp; muốn giữ nguyên thì truyền chuỗi.
 * @param {string} key
 * @param {Params} [params] thông điệp số nhiều cần `n` là số
 */
export function t(key, params) {
  let out = "";
  for (const part of tParts(key, params)) out += part.value;
  return out;
}

/**
 * Như t() nhưng luôn đọc bản gốc tiếng Việt, bất kể ngôn ngữ đang chọn: văn bản đồng ý gốc đặt cạnh bản dịch (LNH-T21) và
 * tiêu đề cố định mà máy chủ ghi vào lịch (LNH-T26). Nơi hiển thị đặt lang="vi" cho đoạn này.
 * @param {string} key
 * @param {Params} [params]
 */
export function tSource(key, params) {
  const found = lookup(key, [SOURCE_LOCALE]);
  if (!found) {
    warnOnce("key:" + key, `i18n: thiếu khóa ${key}`);
    return key;
  }
  let out = "";
  for (const part of partsOf(found, key, params)) out += part.value;
  return out;
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

/** Ngày Chủ nhật 2026-11-15 và sáu ngày kế tiếp: đủ bảy thứ để xét tên hẹp của một ngôn ngữ có trùng nhau không. */
const WEEK_PROBE = [15, 16, 17, 18, 19, 20, 21].map((day) => new Date(Date.UTC(2026, 10, day)));
/** @type {Map<string, "narrow" | "short">} */
const compactStyle = new Map();
/**
 * Tên thứ gọn cho nhãn cột biểu đồ. Dùng dạng hẹp khi bảy tên hẹp của ngôn ngữ khác nhau từng đôi (tiếng Việt «CN, T2…T7»,
 * tiếng Nhật «日, 月…»); ngôn ngữ có tên hẹp trùng nhau (tiếng Anh «S M T W T F S») thì dùng dạng ngắn («Sun, Mon…»).
 * @param {Date | number | string} value thời điểm hoặc ngày theo lịch "YYYY-MM-DD"
 * @param {string} [timeZone] múi IANA cho thời điểm
 */
export function formatWeekdayCompact(value, timeZone) {
  let style = compactStyle.get(active);
  if (!style) {
    const narrow = dateFormat(active, { weekday: "narrow", timeZone: "UTC" });
    style = new Set(WEEK_PROBE.map((d) => narrow.format(d))).size === 7 ? "narrow" : "short";
    compactStyle.set(active, style);
  }
  return formatWeekday(value, style, timeZone);
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

/** @typedef {{ type: "number" | "unit" | "literal", value: string }} DurationPart */

/**
 * Thời lượng từ số phút ở dạng từng phần: số, đơn vị, và chữ nối (khoảng trắng, dấu phẩy của danh sách). Giao diện dùng để
 * định kiểu riêng phần đơn vị mà không phải đọc lại chuỗi đã định dạng. Ghép mọi `value` lại đúng bằng formatDuration().
 * @param {number} minutes làm tròn tới phút; phải ≥ 0
 * @param {{ unit?: "long" | "short" | "narrow", list?: "long" | "short" | "narrow" }} [o]
 * @returns {DurationPart[]}
 */
export function formatDurationParts(minutes, o = {}) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) throw new RangeError("i18n: thời lượng phải là số phút không âm");
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  const unitDisplay = o.unit ?? "short";
  /** @type {Intl.NumberFormatPart[][]} */
  const pieces = [];
  if (hours > 0) pieces.push(numberFormat(active, { style: "unit", unit: "hour", unitDisplay }).formatToParts(hours));
  if (rest > 0 || hours === 0) pieces.push(numberFormat(active, { style: "unit", unit: "minute", unitDisplay }).formatToParts(rest));
  const listOptions = /** @type {Intl.ListFormatOptions} */ ({ type: "unit", style: o.list ?? "narrow" });
  const id = active + "|" + JSON.stringify(listOptions);
  let list = listCache.get(id);
  if (!list) listCache.set(id, (list = new Intl.ListFormat(active, listOptions)));
  /** @type {DurationPart[]} */
  const out = [];
  let index = 0;
  // Phần tử của danh sách chỉ để giữ chỗ; mỗi chỗ được thay bằng các phần của số có đơn vị tương ứng.
  for (const part of list.formatToParts(pieces.map((_, i) => String(i)))) {
    if (part.type !== "element") {
      out.push({ type: "literal", value: part.value });
      continue;
    }
    for (const p of pieces[index++]) out.push({ type: p.type === "unit" ? "unit" : p.type === "literal" ? "literal" : "number", value: p.value });
  }
  return out;
}

/**
 * Thời lượng từ số phút: giờ và phút, bỏ phần bằng 0 (0 phút vẫn in "0 phút"). Mặc định đơn vị ngắn, nối kiểu hẹp:
 * tiếng Việt "7 giờ 30 phút", tiếng Anh "7 hr 30 min".
 * @param {number} minutes làm tròn tới phút; phải ≥ 0
 * @param {{ unit?: "long" | "short" | "narrow", list?: "long" | "short" | "narrow" }} [o]
 */
export function formatDuration(minutes, o = {}) {
  let out = "";
  for (const part of formatDurationParts(minutes, o)) out += part.value;
  return out;
}

/** Chữ "Language" cố định đặt cạnh nhãn ô chọn ngôn ngữ, để người không đọc được ngôn ngữ đang hiện vẫn tìm ra ô này. */
export const LANGUAGE_WORD = "Language";

/** Thuộc tính mà data-i18n-attr được phép đặt: chỉ thuộc tính chứa văn bản, không bao giờ là địa chỉ hay mã. */
const STATIC_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt", "content"]);

/**
 * Điền chữ cho HTML tĩnh (web/index.html) theo ngôn ngữ đang chọn:
 *   <span data-i18n="khóa"></span>                         → textContent
 *   <nav data-i18n-attr="aria-label:khóa; title:khóa2">    → setAttribute (chỉ aria-label, title, placeholder, alt, content)
 * Gọi lại sau khi đổi ngôn ngữ. Không dùng innerHTML: bản dịch luôn là văn bản thuần.
 * @param {{ querySelectorAll(selector: string): Iterable<{ getAttribute(name: string): string | null, setAttribute(name: string, value: string): void, textContent: string | null }> }} root document hoặc một phần tử
 * @param {(key: string) => string} [translate] mặc định t()
 */
export function localizeStatic(root, translate = t) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const text = translate(String(el.getAttribute("data-i18n")));
    if (el.textContent !== text) el.textContent = text;
  }
  for (const el of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of String(el.getAttribute("data-i18n-attr")).split(";")) {
      if (!pair.trim()) continue;
      const cut = pair.indexOf(":");
      const attr = pair.slice(0, cut).trim();
      const key = pair.slice(cut + 1).trim();
      if (cut < 1 || !key || !STATIC_ATTRIBUTES.has(attr)) throw new Error(`i18n: data-i18n-attr không hợp lệ: ${pair.trim().slice(0, 80)}`);
      const text = translate(key);
      if (el.getAttribute(attr) !== text) el.setAttribute(attr, text);
    }
  }
}
