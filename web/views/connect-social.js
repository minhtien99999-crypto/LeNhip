// Phần "Mạng xã hội" của màn hình Kết nối — PHẦN GIỮ CHỖ của khung giao diện V1.0.0. Nhánh mạng xã hội (LNH-T40..LNH-T45)
// thay toàn bộ tệp này. Hiện chỉ có một câu nói rõ bản dựng chưa có phần này: chưa liên kết tài khoản, chưa chia sẻ gì.
//
// Hợp đồng của một phần: web/views/connect.js. Kiểu riêng: web/views/connect-social.css. Chuỗi của nhánh: khóa `social.*`
// trong web/shared/i18n-<ngôn ngữ>-social.js (khóa `shell.*` dưới đây thuộc phần giữ chỗ).

export default {
  id: "social",
  order: 10,
  // Cờ `social` tắt khi chưa đặt rõ (LNH-F27, LNH-T45).
  visible: (ctx) => ctx.modules.social === true,
  render: (ctx) =>
    '<div class="section-heading"><h2>' + ctx.icon("share") + ctx.tSafe("connect.social.title") + '</h2><span class="tiny-pill">' + ctx.tSafe("shell.placeholder") + "</span></div>" +
    '<p class="empty-state">' + ctx.tSafe("shell.social.empty") + "</p>",
};
