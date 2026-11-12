// @ts-check
// Văn bản đồng ý theo ngôn ngữ (LNH-T25, LNH-F28). Biên nhận đồng ý ghi phiên bản và mã băm của đúng văn bản người dùng đang
// đọc lúc bấm lưu, nên mỗi bản dịch là một văn bản riêng: `text_version` của bản tiếng Việt là phiên bản gốc, của bản dịch có
// thêm hậu tố `.<tag>`. Dùng chung cho giao diện (web/app.js, các mô-đun qua ctx.consentText / ctx.consentReceipt) và cho
// scripts/make-consent-texts.ts, tệp sinh sổ ghim contracts/consent-texts.json.
//
// Quy ước khóa, áp dụng cho mọi catalog kể cả các phần:
//   <tiền tố>consent.<purpose_id>.body    thân văn bản của một mục đích (bắt buộc)
//   <tiền tố>consent.<purpose_id>.title   tiêu đề hiển thị, không băm
//   <tiền tố>consent.notice.head          phần đầu chung của các mục đích cùng tiền tố (không bắt buộc)
// Tiền tố rỗng ở phần lõi; "msg." và "social." ở các phần (msg.consent.messaging.body, social.consent.social_post.body).
// Văn bản được băm = phần đầu + "\n" + thân khi bản gốc có phần đầu, không thì chỉ có thân. Mã băm là digestJcs() của chuỗi
// đó: SHA-256 trên dạng JCS, base64url, đúng giá trị `text_hash` gửi lên /v1/consents.
import { SOURCE_LOCALE, getLocale, hasMessage, hasSourceMessage, messageLocale, t, tSource } from "./i18n.js";
import { digestJcs } from "./jcs.js";

/**
 * Phiên bản văn bản gốc của từng mục đích. Sửa thân hoặc phần đầu của một mục đích, ở BẤT KỲ ngôn ngữ nào, thì đổi phiên bản
 * của mục đích đó ở đây rồi chạy `node scripts/make-consent-texts.ts`; tests/i18n.test.ts chặn việc sửa văn bản mà giữ
 * nguyên phiên bản. Mỗi phiên bản dài tối đa 24 ký tự để còn chỗ cho hậu tố ngôn ngữ (text_version tối đa 32 ký tự).
 */
export const CONSENT_TEXT_VERSIONS = Object.freeze({
  health_local: "v1-2026-11-11",
  calendar_link: "v1-2026-11-11",
  home_control: "v1-2026-11-11",
  beta_telemetry: "v1-2026-11-11",
  messaging: "v1-2026-11-11",
  social_post: "v1-2026-11-11",
  // V1.0.1 (SRS V2.0): nguồn Microsoft 365 của Hộp tổng hợp, sự kiện Le‑NodeHome, phép đo Le‑NodeHealth.
  inbox_mail: "v1-2026-11-12",
  home_hub: "v1-2026-11-12",
  measurements: "v1-2026-11-12",
});

/** Khóa thân văn bản đồng ý trong mọi catalog; nhóm 1 là purpose_id. */
export const CONSENT_BODY_KEY = /(?:^|\.)consent\.([a-z][a-z0-9_]*)\.body$/;

/**
 * @param {string} purposeId
 * @param {string} [prefix] "" cho phần lõi, "msg." hoặc "social." cho các phần
 */
export function consentKeys(purposeId, prefix = "") {
  if (!/^[a-z][a-z0-9_]*$/.test(purposeId) || !/^(?:[a-z][a-z0-9]*\.(?:[A-Za-z0-9_]+\.)*)?$/.test(prefix)) throw new RangeError("consent: mục đích hoặc tiền tố không hợp lệ");
  return { head: `${prefix}consent.notice.head`, title: `${prefix}consent.${purposeId}.title`, body: `${prefix}consent.${purposeId}.body` };
}

/**
 * `text_version` của văn bản một mục đích ở một ngôn ngữ: phiên bản gốc cho tiếng Việt, thêm `.<tag>` cho bản dịch.
 * @param {string} purposeId
 * @param {string} tag tag catalog ("vi", "en", "zh-Hant"…)
 */
export function consentTextVersion(purposeId, tag) {
  const base = Object.hasOwn(CONSENT_TEXT_VERSIONS, purposeId) ? CONSENT_TEXT_VERSIONS[/** @type {keyof typeof CONSENT_TEXT_VERSIONS} */ (purposeId)] : undefined;
  if (!base) throw new RangeError(`consent: mục đích ${purposeId} chưa có phiên bản văn bản trong CONSENT_TEXT_VERSIONS`);
  const version = tag === SOURCE_LOCALE ? base : `${base}.${tag}`;
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(version)) throw new RangeError(`consent: text_version không hợp lệ: ${version}`);
  return version;
}

/** Văn bản được băm: phần đầu chung (nếu có) rồi tới thân. @param {string} head @param {string} body */
export function composeConsentText(head, body) {
  return head ? `${head}\n${body}` : body;
}

/**
 * Văn bản đồng ý của một mục đích như nó hiện ra ở ngôn ngữ đang chọn. Bản dịch chỉ được dùng khi ngôn ngữ đang chọn có đủ
 * cả thân lẫn phần đầu; thiếu một trong hai thì trả trọn bản gốc tiếng Việt (`locale` = "vi", nơi hiển thị đặt lang="vi"):
 * không bao giờ ghép hai ngôn ngữ vào một văn bản được băm.
 * @param {string} purposeId
 * @param {string} [prefix]
 */
export function consentText(purposeId, prefix = "") {
  const keys = consentKeys(purposeId, prefix);
  if (!hasSourceMessage(keys.body)) throw new Error(`consent: bản gốc thiếu khóa ${keys.body}`);
  const withHead = hasSourceMessage(keys.head);
  const tag = getLocale();
  const translated = tag !== SOURCE_LOCALE && messageLocale(keys.body) === tag && (!withHead || messageLocale(keys.head) === tag);
  const read = translated ? t : tSource;
  const head = withHead ? read(keys.head) : "";
  const body = read(keys.body);
  const locale = translated ? tag : SOURCE_LOCALE;
  return {
    purpose_id: purposeId,
    locale,
    head,
    body,
    title: hasMessage(keys.title) ? (translated ? t(keys.title) : tSource(keys.title)) : "",
    text: composeConsentText(head, body),
    text_version: consentTextVersion(purposeId, locale),
  };
}

/**
 * Hai trường của biên nhận cho văn bản đang hiện: gọi đúng lúc người dùng bấm lưu lựa chọn.
 * @param {string} purposeId
 * @param {string} [prefix]
 * @returns {Promise<{ text_version: string, text_hash: string, locale: string }>}
 */
export async function consentReceipt(purposeId, prefix = "") {
  const shown = consentText(purposeId, prefix);
  return { text_version: shown.text_version, text_hash: await digestJcs(shown.text), locale: shown.locale };
}
