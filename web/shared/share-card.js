// @ts-check
// Thẻ chia sẻ dựng trên thiết bị (LNH-T41). Một thẻ chỉ có hai thứ: ghi chú do người dùng tự gõ (tối đa 280 ký tự, đếm theo
// cụm chữ người đọc nhìn thấy) và liên kết LeNhip nếu LeNhip có địa chỉ công khai và người dùng tự chọn kèm. Tập trường của
// thẻ là đóng: không có trường nào cho dữ liệu sức khỏe, lịch hay ngôi nhà, và buildShareCard() từ chối mọi trường lạ, giống
// `additionalProperties=false` của các schema tác vụ.
// Tệp này không gọi mạng, không đọc hay ghi bộ nhớ của trình duyệt. Chạy được trên trình duyệt và Node 22; chỉ dùng Intl.

/** Số ký tự tối đa của ghi chú, đếm theo cụm chữ (grapheme): «ế», một emoji gia đình hay một lá cờ đều là một ký tự. */
export const NOTE_LIMIT = 280;
/**
 * Trần cứng theo đơn vị mã UTF-16, cũng là `maxlength` của ô nhập: một cụm chữ có thể mang rất nhiều dấu kết hợp, nên chỉ đếm
 * cụm chữ thì 280 «ký tự» vẫn có thể dài vô hạn.
 */
export const NOTE_UNIT_LIMIT = 2800;
/** Độ dài tối đa của địa chỉ công khai. */
export const PUBLIC_URL_LIMIT = 200;
/** Tập trường đóng của đầu vào buildShareCard(). */
export const SHARE_CARD_FIELDS = Object.freeze(["note", "includeLink", "publicUrl"]);

/**
 * @typedef {{ ok: true, code: null, note: string, url: string | null, text: string, graphemes: number }} ShareCardReady
 * @typedef {{ ok: false, code: "EMPTY" | "NOTE_TOO_LONG", note: "", url: null, text: "", graphemes: number }} ShareCardRefused
 * @typedef {ShareCardReady | ShareCardRefused} ShareCard
 *   `text` là đúng văn bản đưa cho Sao chép, Email và bảng chia sẻ của thiết bị: ghi chú, rồi liên kết ở dòng riêng.
 */

/** @type {Intl.Segmenter | null | undefined} */
let segmenter;

/**
 * Số ký tự người đọc nhìn thấy. Trình duyệt chưa có Intl.Segmenter thì đếm theo điểm mã (không bao giờ đếm ít hơn số cụm chữ,
 * nên giới hạn 280 không bị nới).
 * @param {string} text
 */
export function countGraphemes(text) {
  if (segmenter === undefined) segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  if (!segmenter) return Array.from(text).length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

/**
 * Thay nửa cặp thay thế (surrogate) đứng lẻ bằng U+FFFD: encodeURIComponent ném lỗi khi gặp chúng. Với cờ `u`, lớp ký tự
 * D800–DFFF chỉ khớp nửa cặp đứng lẻ; cặp đủ là một điểm mã ngoài khoảng đó.
 * @param {string} text
 */
export function toWellFormed(text) {
  return text.replace(/[\uD800-\uDFFF]/gu, "�");
}

/**
 * Ghi chú như sẽ được chia sẻ: xuống dòng kiểu LF, bỏ ký tự điều khiển (trừ xuống dòng và tab), bỏ khoảng trắng hai đầu.
 * Không đổi chữ của người dùng theo cách nào khác (không chuẩn hóa NFC, không cắt bớt).
 * @param {unknown} raw
 */
export function normalizeNote(raw) {
  if (typeof raw !== "string") return "";
  return toWellFormed(raw).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "").trim();
}

/**
 * Địa chỉ công khai của LeNhip, hoặc null. Chỉ nhận https, tên miền công khai viết ở dạng chuẩn (chữ thường, không tài khoản,
 * không dấu #, không khoảng trắng): chuỗi phải trùng với dạng mà bộ phân tích URL trả lại, để không có cách viết nào được
 * hiểu khác đi. localhost, tên một nhãn và địa chỉ IP không phải địa chỉ công khai.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizePublicUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > PUBLIC_URL_LIMIT) return null;
  if (!/^https:\/\/[a-z0-9]/.test(value) || /[\s\\#]/.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return null;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(parsed.hostname)) return null;
  if (parsed.href !== value && parsed.href !== value + "/") return null;
  return parsed.href;
}

/**
 * Văn bản của thẻ: ghi chú, rồi liên kết ở dòng riêng. Trình dựng liên kết chia sẻ dùng đúng hàm này cho nền tảng chỉ nhận
 * một tham số văn bản, nên ô xem trước và nội dung mở ra ở nền tảng là một.
 * @param {string} note
 * @param {string | null} url
 */
export function joinNoteAndUrl(note, url) {
  if (!url) return note;
  return note ? note + "\n" + url : url;
}

/**
 * Dựng thẻ từ ô nhập. `includeLink` phải đúng bằng true mới kèm liên kết (mặc định không kèm), và chỉ kèm được khi `publicUrl`
 * là một địa chỉ công khai hợp lệ. Trường ngoài SHARE_CARD_FIELDS bị từ chối bằng TypeError.
 * @param {{ note?: unknown, includeLink?: unknown, publicUrl?: unknown }} input
 * @returns {ShareCard}
 */
export function buildShareCard(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("thẻ chia sẻ cần một đối tượng { note, includeLink, publicUrl }");
  for (const key of Object.keys(input)) {
    if (!SHARE_CARD_FIELDS.includes(key)) throw new TypeError(`thẻ chia sẻ không có trường ${key.slice(0, 40)}: chỉ nhận ghi chú và liên kết LeNhip`);
  }
  const note = normalizeNote(input.note);
  const graphemes = countGraphemes(note);
  if (graphemes > NOTE_LIMIT || note.length > NOTE_UNIT_LIMIT) return { ok: false, code: "NOTE_TOO_LONG", note: "", url: null, text: "", graphemes };
  const url = input.includeLink === true ? normalizePublicUrl(input.publicUrl) : null;
  if (!note && !url) return { ok: false, code: "EMPTY", note: "", url: null, text: "", graphemes };
  return { ok: true, code: null, note, url, text: joinNoteAndUrl(note, url), graphemes };
}
