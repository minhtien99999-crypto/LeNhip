// @ts-check
// Quy tắc văn bản và liên kết của Hộp tổng hợp (SRS V2.0 mục 04, X04; LNH-T65), dùng chung cho máy chủ (src/server/inbox.ts) và
// trang (web/views/inbox.js): bước xem trước trên trang cho thấy ĐÚNG chuỗi máy chủ sẽ lưu. Không gọi mạng, không chữ giao diện.
//
// - Văn bản là dữ liệu thuần: chuẩn NFC, gộp khoảng trắng và xuống dòng thành một dấu cách, tối đa 280 điểm mã. Phần người dùng tự
//   chọn mà có ký tự điều khiển hay ký tự đảo hướng (U+202A…U+202E, U+2066…U+2069…) thì bị từ chối, để xem trước và bản lưu trùng
//   nhau. Dữ liệu của nguồn (tiêu đề thư) thì được làm sạch: bỏ các ký tự đó và cắt ở 280 điểm mã.
// - Liên kết chỉ nhận https, không tên người dùng hay mật khẩu trong URL, có tên máy; nguồn Outlook còn phải trỏ về máy chủ Outlook.

export const INBOX_TEXT_LIMITS = Object.freeze({ summary: 280, sender: 160, link: 2048 });
/** Máy chủ mà liên kết «Mở bản gốc» của một thư Outlook được trỏ tới. */
export const OUTLOOK_LINK_HOSTS = Object.freeze(["outlook.office365.com", "outlook.office.com"]);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩﻿]/u;
// eslint-disable-next-line no-control-regex
const CONTROL_ALL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩﻿]/gu;

/** @param {string} s */
const collapse = (s) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
/** @param {string} s */
export const codePoints = (s) => [...s].length;

/**
 * Văn bản người dùng tự chọn. `ok: false` kèm `reason` ("EMPTY" | "TOO_LONG" | "CONTROL") khi không lưu được nguyên văn.
 * @param {unknown} raw
 * @returns {{ ok: true, text: string } | { ok: false, reason: "EMPTY" | "TOO_LONG" | "CONTROL" }}
 */
export function userText(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "EMPTY" };
  if (CONTROL.test(raw)) return { ok: false, reason: "CONTROL" };
  const text = collapse(raw);
  if (!text) return { ok: false, reason: "EMPTY" };
  if (codePoints(text) > INBOX_TEXT_LIMITS.summary) return { ok: false, reason: "TOO_LONG" };
  return { ok: true, text };
}

/**
 * Văn bản của nguồn (tiêu đề, tên người gửi): bỏ ký tự điều khiển và đảo hướng, gộp khoảng trắng, cắt ở `max` điểm mã (thêm «…»).
 * Trả chuỗi rỗng khi không còn gì.
 * @param {unknown} raw
 * @param {number} [max]
 */
export function sourceText(raw, max = INBOX_TEXT_LIMITS.summary) {
  if (typeof raw !== "string") return "";
  const text = collapse(raw.replace(CONTROL_ALL, ""));
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max - 1).join("").trimEnd() + "…" : text;
}

/**
 * Liên kết đã kiểm, hoặc null. `hosts`: chỉ nhận đúng các tên máy này (nguồn Outlook).
 * @param {unknown} raw
 * @param {readonly string[]} [hosts]
 * @returns {string | null}
 */
export function checkedLink(raw, hosts) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > INBOX_TEXT_LIMITS.link || CONTROL.test(raw) || /\s/u.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || !u.hostname || u.hostname === "localhost") return null;
  if (hosts && !hosts.includes(u.hostname.toLowerCase())) return null;
  const href = u.href;
  return href.length <= INBOX_TEXT_LIMITS.link ? href : null;
}

/** Tóm tắt của một liên kết khi người dùng không ghi gì kèm: chính liên kết đó, cắt ở 280 điểm mã. @param {string} link */
export const linkSummary = (link) => sourceText(link);
