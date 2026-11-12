// Phần "Thiết bị theo dõi" của màn hình Kết nối — PHẦN GIỮ CHỖ của khung giao diện V1.0.0. Nhánh thiết bị theo dõi
// (LNH-T53..LNH-T56) thay toàn bộ tệp này. Hiện chỉ có một câu nói rõ bản dựng chưa có phần này: chưa đọc dữ liệu từ thiết bị
// hay tệp xuất nào. Máy chủ không có API nào về thiết bị theo dõi; mọi thứ của phần này ở lại trên thiết bị (LNH-T52, LNH-T53).
//
// Hợp đồng của một phần: web/views/connect.js. Kiểu riêng: web/views/connect-trackers.css. Chuỗi của nhánh: khóa `dev.*`
// trong web/shared/i18n-<ngôn ngữ>-dev.js (khóa `shell.*` dưới đây thuộc phần giữ chỗ).

export default {
  id: "trackers",
  order: 30,
  // Cờ `trackers` tắt khi chưa đặt rõ (LNH-F27, LNH-T53).
  visible: (ctx) => ctx.modules.trackers === true,
  render: (ctx) =>
    '<div class="section-heading"><h2>' + ctx.icon("watch") + ctx.tSafe("connect.trackers.title") + '</h2><span class="tiny-pill">' + ctx.tSafe("shell.placeholder") + "</span></div>" +
    '<p class="empty-state">' + ctx.tSafe("shell.trackers.empty") + "</p>",
};
