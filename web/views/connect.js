// Màn hình Kết nối (LNH-T51): khung chứa ba phần, vẽ theo thứ tự — Mạng xã hội, Thiết bị của tôi, Thiết bị theo dõi.
// Màn hình hiện khi có ít nhất một phần hiện. Tệp này thuộc khung giao diện; mỗi nhánh tính năng chỉ sửa tệp phần của mình.
//
// Hợp đồng của một phần (connect-*.js):
//   { id, order, visible(ctx), render(ctx) -> chuỗi HTML, bind?(ctx, el), update?(ctx, el), plans? }
//   - render trả phần ruột của <section class="card connect-section" data-section="<id>">, gồm cả tiêu đề <h2>.
//   - bind gắn sự kiện sau mỗi lần HTML của phần được đặt vào trang.
//   - Khi ứng dụng render nền: phần có update thì chỉ gọi update(ctx, el) và tự lo DOM của mình (dùng cho phần có ô nhập);
//     phần không có update thì render lại, và chỉ thay DOM (rồi bind lại) khi HTML khác lần trước.
//   - ctx của phần là một nhánh riêng: mọi ctx.every / ctx.onLeave đăng ký trong render/bind được dừng trước khi phần bị vẽ
//     lại, khi phần bị ẩn và khi rời màn hình.
//   - plans: như của màn hình (web/views/index.js), gộp vào màn hình Kết nối.
import social from "./connect-social.js";
import endpoints from "./connect-endpoints.js";
import trackers from "./connect-trackers.js";
// ── V1.0.1 phiên trên các thiết bị (N20‑SYNC) ──
import sessions from "./connect-sessions.js";

const SECTIONS = [social, endpoints, sessions, trackers].sort((a, b) => a.order - b.order);

/** @type {HTMLElement | null} */
let grid = null;
/** Phần đang có trên trang: id → { el, html, scope }. */
const slots = new Map();

function dropSlot(id) {
  const slot = slots.get(id);
  if (!slot) return;
  slot.scope.end();
  slot.el.remove();
  slots.delete(id);
}

function sync(ctx) {
  if (!grid) return;
  for (const section of SECTIONS) {
    let on = false;
    try {
      on = section.visible(ctx) === true;
    } catch (e) {
      console.error(e);
    }
    if (!on) {
      dropSlot(section.id);
      continue;
    }
    let slot = slots.get(section.id);
    if (slot && typeof section.update === "function") {
      try {
        section.update(slot.scope.ctx, slot.el);
      } catch (e) {
        console.error(e);
      }
      continue;
    }
    const scope = ctx.fork();
    let html;
    try {
      html = String(section.render(scope.ctx));
    } catch (e) {
      console.error(e);
      html = '<p class="empty-state">' + ctx.tSafe("shell.viewError") + "</p>";
    }
    if (slot && slot.html === html) {
      scope.end(); // không có gì đổi: giữ DOM, sự kiện và nhịp đang chạy của lần vẽ trước
      continue;
    }
    if (!slot) {
      const el = document.createElement("section");
      el.className = "card connect-section";
      el.dataset.section = section.id;
      // Chèn đúng thứ tự mà không di chuyển các phần đã có (di chuyển nút DOM làm mất focus).
      const after = SECTIONS.slice(SECTIONS.indexOf(section) + 1).map((s) => slots.get(s.id)?.el).find(Boolean);
      grid.insertBefore(el, after ?? null);
      slot = { el, html: "", scope };
      slots.set(section.id, slot);
    } else {
      slot.scope.end();
      slot.scope = scope;
    }
    slot.html = html;
    slot.el.innerHTML = html;
    try {
      section.bind?.(scope.ctx, slot.el);
    } catch (e) {
      console.error(e);
    }
  }
}

export default {
  id: "connect",
  order: 60,
  // bar=false: không nằm trên thanh dưới của điện thoại; có ở thanh bên từ 701 px và trong hộp Tài khoản (LNH-T51).
  nav: { label: (ctx) => ctx.t("nav.connect"), hint: (ctx) => ctx.t("nav.connectHint"), icon: "link", bar: false },
  wide: true,
  // Hỏi MỌI phần ở mỗi lần vẽ (không dừng ở phần đầu tiên bật): một phần có thể dọn trạng thái của mình khi cờ vừa tắt.
  visible: (ctx) => SECTIONS.map((s) => s.visible(ctx) === true).includes(true),
  plans: Object.assign({}, ...SECTIONS.map((s) => s.plans ?? {})),

  mount(ctx, host) {
    host.innerHTML =
      '<span class="eyebrow">' + ctx.tSafe("connect.eyebrow") + "</span><h1>" + ctx.tSafe("connect.title") + '</h1><p class="subtitle">' + ctx.tSafe("connect.subtitle") + '</p><div class="connect-grid"></div>';
    grid = host.querySelector(".connect-grid");
    sync(ctx);
  },

  update(ctx) {
    sync(ctx);
  },

  unmount() {
    for (const id of [...slots.keys()]) dropSlot(id);
    grid = null;
  },
};
