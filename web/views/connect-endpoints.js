// Phần "Thiết bị của tôi" của màn hình Kết nối — PHẦN GIỮ CHỖ của khung giao diện V1.0.0. Nhánh nhắn tin (LNH-T30: mỗi trình
// duyệt đã đăng nhập đăng ký một điểm nhận tin) thay toàn bộ tệp này. Hiện chỉ có một câu nói rõ bản dựng chưa có phần này:
// trình duyệt này chưa được đăng ký, chưa có khóa nào được tạo.
// Lưu ý tên gọi: `devices`, `data-device`, `/v1/devices` trong app.js là ĐÈN tại site, không phải máy của người dùng.
//
// Hợp đồng của một phần: web/views/connect.js. Kiểu riêng: web/views/connect-endpoints.css. Chuỗi của nhánh: khóa `msg.*`
// trong web/shared/i18n-<ngôn ngữ>-msg.js (khóa `shell.*` dưới đây thuộc phần giữ chỗ).

export default {
  id: "endpoints",
  order: 20,
  // Thiết bị của tôi là điểm nhận tin nên đi theo cờ `messaging` (LNH-T30, LNH-T36).
  visible: (ctx) => ctx.modules.messaging === true,
  render: (ctx) =>
    '<div class="section-heading"><h2>' + ctx.icon("laptop") + ctx.tSafe("connect.endpoints.title") + '</h2><span class="tiny-pill">' + ctx.tSafe("shell.placeholder") + "</span></div>" +
    '<p class="empty-state">' + ctx.tSafe("shell.endpoints.empty") + "</p>",
};
