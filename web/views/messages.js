// Màn hình Tin nhắn — PHẦN GIỮ CHỖ của khung giao diện V1.0.0. Nhánh nhắn tin (LNH-T30..LNH-T36) thay toàn bộ tệp này.
// Hiện chỉ có: một câu nói rõ bản dựng chưa có phần nhắn tin, và một ô soạn thử để kiểm rằng màn hình có trạng thái không
// bị dựng lại khi ứng dụng render nền (scripts/e2e-shell.mjs gõ vào ô, gây render nền, rồi kiểm nội dung và con trỏ còn
// nguyên). Ô soạn thử KHÔNG gửi, không lưu, không gọi máy chủ; không có nút gửi vì chưa có gì để gửi.
//
// Hợp đồng màn hình có trạng thái: web/views/index.js. Kiểu riêng của màn hình: web/views/messages.css. Chuỗi của nhánh
// nhắn tin: khóa `msg.*` trong web/shared/i18n-<ngôn ngữ>-msg.js (các khóa `shell.*` dưới đây thuộc phần giữ chỗ).

export default {
  id: "messages",
  order: 50,
  nav: { label: (ctx) => ctx.t("nav.messages"), icon: "messages", bar: true },
  // Cờ `messaging` tắt khi chưa đặt rõ (LNH-F27, LNH-T36).
  visible: (ctx) => ctx.modules.messaging === true,

  mount(ctx, host) {
    host.innerHTML =
      '<div class="heading-row"><h1>' + ctx.tSafe("nav.messages") + '</h1><span class="tiny-pill">' + ctx.tSafe("shell.placeholder") + "</span></div>" +
      '<section class="card view-card"><p class="empty-state">' + ctx.tSafe("shell.messages.empty") + "</p></section>" +
      '<section class="card view-card"><div class="field"><label for="shell-draft">' + ctx.tSafe("shell.messages.draftLabel") + "</label>" +
      '<textarea id="shell-draft" rows="3" maxlength="2000" autocomplete="off" aria-describedby="shell-draft-note"></textarea>' +
      '<span class="fine-print" id="shell-draft-note">' + ctx.tSafe("shell.messages.draftNote") + "</span></div></section>";
  },

  // Render nền: phần giữ chỗ không có gì để cập nhật; DOM (và chữ đang gõ) được giữ nguyên.
  update() {},

  unmount() {},
};
