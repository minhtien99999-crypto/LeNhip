// Bốn màn hình gốc của bản 0.1.0 (Hôm nay, Sức khỏe, Công việc, Ngôi nhà). Phần vẽ vẫn nằm trong app.js; tệp này chỉ khai
// báo chúng với sổ đăng ký để điều hướng được dựng từ một chỗ. Nhãn điều hướng lấy từ catalog (khóa `nav.*`, tối đa 12 ký tự
// với chữ Latin và Kirin, 6 với chữ Hán, kana, Hangul: LNH-T28).

/** @param {{ home: () => string, health: () => string, work: () => string, house: () => string }} r hàm vẽ của app.js */
export function coreViews(r) {
  return [
    { id: "home", order: 10, nav: { label: (ctx) => ctx.t("nav.home"), icon: "today", bar: true }, contextSwitch: true, visible: () => true, render: () => r.home() },
    { id: "health", order: 20, nav: { label: (ctx) => ctx.t("nav.health"), icon: "health", bar: true }, context: "personal", contextSwitch: true, visible: () => true, render: () => r.health() },
    { id: "work", order: 30, nav: { label: (ctx) => ctx.t("nav.work"), icon: "work", bar: true }, context: "work", contextSwitch: true, visible: () => true, render: () => r.work() },
    { id: "house", order: 40, nav: { label: (ctx) => ctx.t("nav.house"), icon: "home", bar: true }, context: "personal", contextSwitch: true, visible: () => true, render: () => r.house() },
  ];
}
