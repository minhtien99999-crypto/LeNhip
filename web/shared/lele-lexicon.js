// @ts-check
// Bảng từ của LeLe cho 13 ngôn ngữ (LNH-T24, sửa LNH-F24). MỘT bộ quy tắc dùng chung cho thiết bị (web/app.js) và máy chủ
// (src/server/lele.ts): cùng tệp, cùng kết quả. Không gọi mạng, không dùng mô hình.
//
// Đóng khi không chắc:
// - Thiết bị chỉ gửi câu tới /v1/lele/proposals khi scanLele() nhận ra lệnh đèn hoặc lệnh khung giờ VÀ không có từ sức khỏe
//   hay dữ liệu cá nhân nào. Câu có từ sức khỏe được trả lời ngay trên thiết bị; câu không nhận ra thì chỉ hiện câu hướng dẫn.
// - Máy chủ lặp lại đúng phép kiểm này trước khi xử lý và không lưu câu chữ.
// - Từ sức khỏe và dữ liệu cá nhân của CẢ 13 ngôn ngữ được xét với mọi câu, bất kể ngôn ngữ giao diện. Lệnh thì xét theo
//   từng bảng (động từ, đơn vị, từ chỉ giờ phải cùng một ngôn ngữ); riêng danh từ chỉ đèn nhận của mọi ngôn ngữ, vì tên đèn
//   là dữ liệu của site.
// Đây là bộ lọc theo từ khóa: nó sót cách nói vòng, nên giao diện vẫn dặn «đừng gõ chi tiết sức khỏe ở đây».
//
// Mỗi ngôn ngữ một tệp `lele-lex-<file>.js`, đúng dạng `export default ` + JSON chặt + `;` + xuống dòng:
//   tag       tag trong LOCALES (web/shared/i18n.js)
//   draft     true với mọi bản không phải tiếng Việt: bản nháp dịch máy, chưa người bản ngữ rà soát
//   on, off   động từ bật, tắt          lamp      danh từ chỉ đèn
//   block     từ báo lệnh khung giờ (dành, giữ, đặt, tập trung, thời gian cá nhân…)
//   minute, hour   đơn vị đứng SAU con số của thời lượng («30 phút», «2 giờ»)
//   at        từ đứng TRƯỚC giờ («lúc 15:00»)          oclock    dấu giờ đứng SAU con số («15 giờ», «15時»)
//   half      «rưỡi» sau dấu giờ (không bắt buộc)       pm        từ chỉ buổi chiều, tối: giờ dưới 12 được cộng 12
//   tomorrow  ngày mai                                   ignore    cụm bỏ đi trước khi tìm lệnh (không bắt buộc)
//   ui        từ về giao diện: trả lời trên thiết bị    pick      "last" nếu từ bật/tắt đứng cuối câu (không bắt buộc)
//   health    từ về sức khỏe, cố ý rộng                 pii       từ chỉ giấy tờ, tài khoản, mật khẩu
// Một mục từ: chữ thường, đã chuẩn hóa NFKC; các từ cách nhau một dấu cách (khớp mọi khoảng trắng); `*` ở đầu hoặc cuối bỏ
// ranh giới từ ở phía đó («sleep*» khớp sleeping, «*lampe» khớp Stehlampe). Mục từ có chữ Hán, kana hoặc Hangul được tìm như
// chuỗi con; mục từ khác phải đứng thành từ riêng, ranh giới xét theo Unicode (không dùng \b của ASCII: «mở» ở cuối câu vẫn khớp).
// Tiếng Pháp, Tây Ban Nha, Bồ Đào Nha, Ý, Đức được tự thêm dạng viết không dấu của từng mục từ.
//
// NGƯỜI RÀ SOÁT MỘT NGÔN NGỮ CẦN KIỂM (bảng từ ngoài tiếng Việt là bản nháp dịch máy):
// 1. health: đủ từ thường ngày về giấc ngủ, bước chân, tim và mạch, huyết áp, cân nặng, bệnh, đau, sốt, thuốc, bác sĩ và bệnh
//    viện, thai kỳ và kinh nguyệt, sức khỏe tinh thần, kể cả dạng biến cách (dùng `*`) và dạng gõ không dấu. Thừa còn hơn thiếu.
//    Chỉ bỏ một mục khi nó trùng một từ rất thường gặp không liên quan sức khỏe của BẤT KỲ ngôn ngữ nào trong 13 ngôn ngữ (mọi
//    câu đều bị xét bằng từ sức khỏe của cả 13 bảng), ví dụ «sono» tiếng Bồ trùng «sono» tiếng Ý.
// 2. on, off, lamp, block, đơn vị, từ chỉ giờ: đúng cách người bản ngữ ra lệnh; từ bật/tắt không nằm trong từ khác thường gặp
//    (với chữ Hán, kana, Hangul mục từ được tìm như chuỗi con); `pick: "last"` nếu từ bật/tắt đứng cuối câu.
// 3. pii: tên giấy tờ tùy thân, mã số thuế, bảo hiểm, mật khẩu, tài khoản, thẻ của nước dùng ngôn ngữ đó.
// 4. Câu lệnh mẫu của catalog giao diện (lele.example.*) và các câu trong SAMPLES của tests/lele-i18n.test.ts vẫn đạt; mỗi lần
//    sửa thêm câu mẫu tương ứng (ít nhất sáu câu mỗi ngôn ngữ) và đổi LELE_RULES_VERSION.
// 5. Chỉ đặt `draft: false` khi người bản ngữ và chuyên gia y tế đã rà xong (LNH-D13).
// Giới hạn đã biết: «phòng ngủ» (vi), «kamar tidur» (id) chứa từ «ngủ» nên lệnh có cụm đó bị chặn như câu sức khỏe.
import vi from "./lele-lex-vi.js";
import en from "./lele-lex-en.js";
import fr from "./lele-lex-fr.js";
import zhHans from "./lele-lex-zh-hans.js";
import ko from "./lele-lex-ko.js";
import ja from "./lele-lex-ja.js";
import es from "./lele-lex-es.js";
import ptBR from "./lele-lex-pt-br.js";
import it from "./lele-lex-it.js";
import zhHant from "./lele-lex-zh-hant.js";
import id from "./lele-lex-id.js";
import ru from "./lele-lex-ru.js";
import de from "./lele-lex-de.js";

/**
 * @typedef {{ tag: string, draft: boolean, on: string[], off: string[], lamp: string[], block: string[], minute: string[], hour: string[],
 *   at: string[], oclock: string[], half?: string[], pm: string[], tomorrow: string[], ignore?: string[], ui: string[], pick?: string,
 *   health: string[], pii: string[] }} LeleLexicon
 * @typedef {{ kind: "device.set_power", command: "SET_ON" | "SET_OFF" }} LampIntent
 * @typedef {{ kind: "calendar.block", minutes: number, hour: number, minute: number, tomorrow: boolean }} BlockIntent
 * @typedef {{ norm: string, health: boolean, pii: boolean, ui: boolean, intent: LampIntent | BlockIntent | null }} LeleScan
 */

/** Phiên bản của bộ quy tắc và bảng từ. Đổi quy tắc khớp hoặc một mục từ thì đổi phiên bản. */
export const LELE_RULES_VERSION = "lele-rules-2.2026-11-12";

/** 13 bảng từ theo đúng thứ tự LOCALES. @type {readonly LeleLexicon[]} */
export const LEXICONS = Object.freeze(/** @type {LeleLexicon[]} */ ([vi, en, fr, zhHans, ko, ja, es, ptBR, it, zhHant, id, ru, de]));

/** Các danh sách mục từ bắt buộc và không bắt buộc của một tệp. */
export const LEXICON_LISTS = Object.freeze(["on", "off", "lamp", "block", "minute", "hour", "at", "oclock", "pm", "tomorrow", "ui", "health", "pii"]);
export const LEXICON_OPTIONAL_LISTS = Object.freeze(["half", "ignore"]);

const FOLD_TAGS = new Set(["fr", "es", "pt-BR", "it", "de"]);
const SUBSTRING_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD = "[\\p{L}\\p{N}\\p{M}]";
const LETTER = "[\\p{L}\\p{M}]";

/**
 * Chuẩn hóa trước khi so khớp: NFKC (gồm NFC, và đưa chữ, số toàn chiều rộng về dạng thường), bỏ ký tự ẩn có thể chẻ đôi một
 * từ, chữ thường, gộp khoảng trắng.
 * @param {string} text
 */
export function normalizeLele(text) {
  return String(text).normalize("NFKC").replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unaccent = (/** @type {string} */ s) => s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");

/**
 * Biểu thức của một danh sách mục từ. `left`, `right` là lớp ký tự không được đứng sát hai bên (mặc định chữ và số); chuỗi rỗng
 * bỏ ranh giới phía đó: đơn vị đứng sát con số («30min»), dấu giờ đứng sát phút («15h30»), «3pm». Mục từ được gom theo loại
 * ranh giới để phép xét ranh giới nằm ngoài nhóm lựa chọn: mỗi nhóm chỉ còn các chuỗi cố định, nên một câu 4.000 ký tự vẫn
 * được đọc trong vài mili giây. Dấu cách trong mục từ khớp đúng một dấu cách: câu đã được normalizeLele() gộp khoảng trắng.
 * @param {readonly string[]} terms
 */
function group(terms, left = WORD, right = WORD) {
  /** @type {Record<"plain" | "stem" | "tail" | "sub", string[]>} */
  const buckets = { plain: [], stem: [], tail: [], sub: [] };
  for (const term of terms) {
    const open = term.startsWith("*");
    const close = term.endsWith("*");
    const body = term.slice(open ? 1 : 0, close ? -1 : undefined);
    buckets[SUBSTRING_SCRIPT.test(body) || (open && close) ? "sub" : open ? "tail" : close ? "stem" : "plain"].push(escape(body));
  }
  const any = (/** @type {string[]} */ list) => `(?:${list.sort((a, b) => b.length - a.length).join("|")})`;
  const before = left ? `(?<!${left})` : "";
  const after = right ? `(?!${right})` : "";
  return [
    buckets.plain.length ? before + any(buckets.plain) + after : "",
    buckets.stem.length ? before + any(buckets.stem) : "",
    buckets.tail.length ? any(buckets.tail) + after : "",
    buckets.sub.length ? any(buckets.sub) : "",
  ].filter(Boolean).join("|");
}
/** @param {readonly string[]} terms */
const matcher = (terms, flags = "u") => (terms.length ? new RegExp(group(terms), flags) : null);

/** Mục từ của một danh sách, kèm dạng không dấu ở các ngôn ngữ thường gõ không dấu. @param {LeleLexicon} lex @param {readonly string[] | undefined} list */
function terms(lex, list) {
  const out = new Set(list ?? []);
  if (FOLD_TAGS.has(lex.tag)) for (const term of list ?? []) out.add(unaccent(term));
  return [...out];
}

// Dữ liệu cá nhân nhận ra theo hình dạng, không theo ngôn ngữ: địa chỉ email; dãy từ 9 chữ số (điện thoại, số giấy tờ, số thẻ),
// kể cả khi viết cách bằng dấu cách, chấm hoặc gạch.
const PII_SHAPES = [/[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}\.[\p{L}\p{N}-]{2,}/u, /(?<!\d)\+?\d(?:[ .\-]?\d){8,}(?!\d)/u];

const all = (/** @type {"health" | "pii" | "lamp"} */ key) => matcher(LEXICONS.flatMap((lex) => terms(lex, lex[key])));
const HEALTH = all("health");
const PII = all("pii");
// Danh từ chỉ đèn của mọi ngôn ngữ: tên đèn là dữ liệu của site («Đèn trần»), người dùng ngôn ngữ khác vẫn gọi đúng tên đó
// trong câu lệnh của mình («turn off Đèn trần»). Động từ bật, tắt thì vẫn xét theo từng bảng.
const LAMP = all("lamp");

/** Biểu thức của một ngôn ngữ, dựng một lần. @param {LeleLexicon} lex */
function compile(lex) {
  const t = (/** @type {readonly string[] | undefined} */ list) => terms(lex, list);
  const oclock = t(lex.oclock);
  const half = t(lex.half);
  const hours = t(lex.hour);
  // Dấu giờ không được là phần đầu của một đơn vị thời lượng dài hơn: «2時間» là hai tiếng, không phải 2 giờ đúng.
  const tails = oclock.flatMap((mark) => hours.filter((unit) => unit.startsWith(mark) && unit.length > mark.length).map((unit) => escape(unit.slice(mark.length))));
  const mark = oclock.length ? `(?:${group(oclock, "", LETTER)})${tails.length ? `(?!${tails.join("|")})` : ""}` : null;
  const minutes = `(?:\\s*(\\d{2})(?!\\d)${half.length ? `|\\s*(${group(half)})` : ""})?`;
  return {
    lex,
    on: matcher(t(lex.on), "gu"),
    off: matcher(t(lex.off), "gu"),
    block: matcher(t(lex.block)),
    ui: matcher(t(lex.ui)),
    tomorrow: matcher(t(lex.tomorrow)),
    ignore: matcher(t(lex.ignore), "gu"),
    // Từ chỉ buổi chiều, tối có thể đứng sát con số («3pm»): bỏ ranh giới trái với chữ số.
    pm: lex.pm.length ? new RegExp(group(t(lex.pm), LETTER), "u") : null,
    // «lúc 15», «lúc 15:30», «à 15h30», «pukul 15.30», «lúc 15 giờ rưỡi».
    timeAt: lex.at.length ? new RegExp(`(?:${group(t(lex.at), WORD, LETTER)})\\s*(\\d{1,2})(?!\\d)(?:\\s*(?:[:.]${mark ? "|" + mark : ""})${minutes})?`, "u") : null,
    // «15 giờ», «15h30», «15時», «15点半», «15 Uhr».
    timeMark: mark ? new RegExp(`(?<![\\d:.])(\\d{1,2})\\s*${mark}${minutes}`, "u") : null,
    minute: lex.minute.length ? new RegExp(`(?<![\\d:.])(\\d{1,3})\\s*(?:${group(t(lex.minute), "")})`, "u") : null,
    hour: hours.length ? new RegExp(`(?<![\\d:.])(\\d{1,3})\\s*(?:${group(hours, "")})`, "u") : null,
  };
}
const COMPILED = LEXICONS.map(compile);
const TIME_COLON = /(?<![\d:.])(\d{1,2}):(\d{2})(?![\d:])/u;

/** Vị trí khớp đầu (hoặc cuối) của một biểu thức toàn cục; -1 nếu không khớp. @param {RegExp | null} re @param {string} s */
function position(re, s, last = false) {
  let at = -1;
  if (!re) return at;
  for (const m of s.matchAll(re)) {
    at = m.index;
    if (!last) break;
  }
  return at;
}

/** @param {ReturnType<typeof compile>} c @param {string} s @returns {LampIntent | null} */
function lampIntent(c, s) {
  if (!LAMP?.test(s)) return null;
  const last = c.lex.pick === "last";
  const on = position(c.on, s, last);
  const off = position(c.off, s, last);
  if (on < 0 && off < 0) return null;
  const isOn = off < 0 || (on >= 0 && (last ? on > off : on < off));
  return { kind: "device.set_power", command: isOn ? "SET_ON" : "SET_OFF" };
}

/** @param {ReturnType<typeof compile>} c @param {string} s @returns {BlockIntent | null} */
function blockIntent(c, s) {
  if (!c.block?.test(s)) return null;
  // Giờ: ưu tiên dạng có từ đứng trước, rồi HH:MM, rồi dạng có dấu giờ đứng sau. Phần đã đọc được cắt đi trước khi tìm thời lượng.
  let rest = s;
  let m = c.timeAt?.exec(rest) ?? null;
  let hour = m ? Number(m[1]) : -1;
  let minute = m ? (m[3] ? 30 : Number(m[2] ?? 0)) : 0;
  if (!m && (m = TIME_COLON.exec(rest))) [hour, minute] = [Number(m[1]), Number(m[2])];
  if (!m && (m = c.timeMark?.exec(rest) ?? null)) [hour, minute] = [Number(m[1]), m[3] ? 30 : Number(m[2] ?? 0)];
  if (!m || hour > 23 || minute > 59) return null;
  rest = rest.slice(0, m.index) + " " + rest.slice(m.index + m[0].length);
  const h = c.hour?.exec(rest);
  if (h) rest = rest.slice(0, h.index) + " " + rest.slice(h.index + h[0].length);
  const min = c.minute?.exec(rest);
  if (!h && !min) return null;
  if (hour < 12 && c.pm?.test(s)) hour += 12;
  return { kind: "calendar.block", minutes: (h ? Number(h[1]) * 60 : 0) + (min ? Number(min[1]) : 0), hour, minute, tomorrow: c.tomorrow?.test(s) === true };
}

/**
 * Đọc một câu gửi LeLe. `health`, `pii`: có từ sức khỏe hoặc dữ liệu cá nhân của BẤT KỲ ngôn ngữ nào. `intent`: lệnh đèn hoặc
 * lệnh khung giờ nhận ra được theo bảng của một ngôn ngữ (xét lần lượt 13 bảng), null nếu không nhận ra. `ui`: câu hỏi về giao
 * diện. Thời lượng và giờ trả về chưa được xét giới hạn 5–240 phút: nơi gọi tự xét.
 * @param {string} text
 * @returns {LeleScan}
 */
export function scanLele(text) {
  const norm = normalizeLele(text);
  /** @type {LeleScan} */
  const out = { norm, health: HEALTH?.test(norm) === true, pii: PII?.test(norm) === true || PII_SHAPES.some((re) => re.test(norm)), ui: false, intent: null };
  for (const c of COMPILED) {
    const s = c.ignore ? norm.replace(c.ignore, " ") : norm;
    const found = lampIntent(c, s) ?? blockIntent(c, s);
    const first = out.intent;
    if (!first) out.intent = found;
    else if (found?.kind === "calendar.block" && first.kind === "calendar.block" && found.minutes === first.minutes && found.minute === first.minute) {
      // Ngôn ngữ gần nhau (Tây Ban Nha, Bồ Đào Nha, Ý) cùng đọc được một câu: bảng nào nhận ra «ngày mai» hoặc buổi chiều thì
      // lấy thêm phần đó, để câu của ngôn ngữ này không bị đọc thiếu bằng bảng của ngôn ngữ kia.
      if (found.tomorrow) first.tomorrow = true;
      if (found.hour === first.hour + 12) first.hour = found.hour;
    }
    out.ui ||= c.ui?.test(norm) === true;
  }
  return out;
}

/**
 * Phép chặn dùng chung của thiết bị và máy chủ: "HEALTH" hoặc "PII" thì câu không được gửi đi đâu và không được lưu; null là
 * không có từ bị chặn (chưa có nghĩa là câu được gửi: thiết bị còn đòi `intent`).
 * @param {LeleScan} scan
 * @returns {"HEALTH" | "PII" | null}
 */
export function leleBlock(scan) {
  return scan.health ? "HEALTH" : scan.pii ? "PII" : null;
}
