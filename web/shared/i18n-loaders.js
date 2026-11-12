// @ts-nocheck
// Bảng nạp catalog cố định của runtime ngôn ngữ (LNH-T22): mỗi ngôn ngữ × (lõi + ba phần) là một lời gọi import() viết sẵn.
// Tag đã lưu chỉ dùng để tra bảng này, không bao giờ ghép thành đường dẫn. Tệp chưa có thì import() bị từ chối và runtime lùi
// về tiếng Việt cho phần đó (i18n.js, loadLocale). Không kiểm kiểu ở tệp này vì catalog của các ngôn ngữ chưa dịch chưa tồn tại;
// tests/i18n-runtime.test.ts kiểm bảng khớp đúng LOCALES × (core + PARTS) và đúng tên tệp.
export const LOADERS = {
  "vi": {
    core: () => import("./i18n-vi.js"),
    msg: () => import("./i18n-vi-msg.js"),
    social: () => import("./i18n-vi-social.js"),
    dev: () => import("./i18n-vi-dev.js"),
  },
  "en": {
    core: () => import("./i18n-en.js"),
    msg: () => import("./i18n-en-msg.js"),
    social: () => import("./i18n-en-social.js"),
    dev: () => import("./i18n-en-dev.js"),
  },
  "fr": {
    core: () => import("./i18n-fr.js"),
    msg: () => import("./i18n-fr-msg.js"),
    social: () => import("./i18n-fr-social.js"),
    dev: () => import("./i18n-fr-dev.js"),
  },
  "zh-Hans": {
    core: () => import("./i18n-zh-hans.js"),
    msg: () => import("./i18n-zh-hans-msg.js"),
    social: () => import("./i18n-zh-hans-social.js"),
    dev: () => import("./i18n-zh-hans-dev.js"),
  },
  "ko": {
    core: () => import("./i18n-ko.js"),
    msg: () => import("./i18n-ko-msg.js"),
    social: () => import("./i18n-ko-social.js"),
    dev: () => import("./i18n-ko-dev.js"),
  },
  "ja": {
    core: () => import("./i18n-ja.js"),
    msg: () => import("./i18n-ja-msg.js"),
    social: () => import("./i18n-ja-social.js"),
    dev: () => import("./i18n-ja-dev.js"),
  },
  "es": {
    core: () => import("./i18n-es.js"),
    msg: () => import("./i18n-es-msg.js"),
    social: () => import("./i18n-es-social.js"),
    dev: () => import("./i18n-es-dev.js"),
  },
  "pt-BR": {
    core: () => import("./i18n-pt-br.js"),
    msg: () => import("./i18n-pt-br-msg.js"),
    social: () => import("./i18n-pt-br-social.js"),
    dev: () => import("./i18n-pt-br-dev.js"),
  },
  "it": {
    core: () => import("./i18n-it.js"),
    msg: () => import("./i18n-it-msg.js"),
    social: () => import("./i18n-it-social.js"),
    dev: () => import("./i18n-it-dev.js"),
  },
  "zh-Hant": {
    core: () => import("./i18n-zh-hant.js"),
    msg: () => import("./i18n-zh-hant-msg.js"),
    social: () => import("./i18n-zh-hant-social.js"),
    dev: () => import("./i18n-zh-hant-dev.js"),
  },
  "id": {
    core: () => import("./i18n-id.js"),
    msg: () => import("./i18n-id-msg.js"),
    social: () => import("./i18n-id-social.js"),
    dev: () => import("./i18n-id-dev.js"),
  },
  "ru": {
    core: () => import("./i18n-ru.js"),
    msg: () => import("./i18n-ru-msg.js"),
    social: () => import("./i18n-ru-social.js"),
    dev: () => import("./i18n-ru-dev.js"),
  },
  "de": {
    core: () => import("./i18n-de.js"),
    msg: () => import("./i18n-de-msg.js"),
    social: () => import("./i18n-de-social.js"),
    dev: () => import("./i18n-de-dev.js"),
  },
};
