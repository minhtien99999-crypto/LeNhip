// Sổ đăng ký màn hình của LeNhip (khung V1.0.0). Điều hướng (thanh bên, thanh dưới của điện thoại, hộp Tài khoản), địa chỉ
// `#<id>` và việc vẽ <main> đều đi từ danh sách này; app.js không còn bảng màn hình nào khác.
// «LNH-T51», «LNH-F27»… trong web/ là mã quyết định và phát hiện của docs/THIET_KE_V1_0_0.md.
//
// Mỗi mô-đun tính năng chỉ sửa tệp của mình trong web/views/ (kèm tệp .css cùng tên và phần catalog của mình) và nhận mọi
// thứ cần dùng qua `ctx`. KHÔNG import app.js từ một màn hình.
//
// Hai dạng màn hình
//   Đơn giản:      { id, order, nav, visible(ctx), render(ctx) -> chuỗi HTML, bind?(ctx, mainEl) }
//                  Được vẽ lại mỗi lần ứng dụng render; nếu HTML không đổi thì DOM được giữ nguyên.
//   Có trạng thái: { id, order, nav, visible(ctx), mount(ctx, hostEl), update?(ctx), unmount?() }
//                  mount một lần khi vào màn hình; các lần render nền chỉ gọi update(ctx), KHÔNG dựng lại DOM (ô soạn, con trỏ,
//                  vị trí cuộn được giữ). unmount khi rời màn hình hoặc khi đổi tài khoản.
//
// Trường chung
//   id        chữ thường, số, gạch nối; cũng là địa chỉ `#id` và giá trị `data-nav`.
//   order     thứ tự trong điều hướng (10 Hôm nay, 20 Sức khỏe, 30 Công việc, 40 Ngôi nhà, 50 Tin nhắn, 60 Kết nối).
//   nav       { label(ctx) -> văn bản, icon: tên glyph của ctx.icon, bar: boolean, hint?(ctx) -> văn bản,
//               badge?(ctx) -> null | { text, label } }
//             bar=true: có trên thanh dưới của điện thoại (tối đa BAR_LIMIT mục, T51). bar=false: chỉ ở thanh bên từ
//             701 px và là một dòng trong hộp Tài khoản.
//   visible   ctx -> boolean. Mô-đun mới đọc cờ một cách phòng thủ: `ctx.modules.messaging === true` (LNH-F27).
//   context?  "personal" | "work": vào màn hình thì chuyển công tắc Cá nhân/Công việc sang giá trị này.
//   contextSwitch?  true: hiện công tắc Cá nhân/Công việc phía trên (chỉ bốn màn hình gốc).
//   wide?     true: dùng hết bề ngang nội dung, ẩn cột chọn phong cách (cho bố cục danh sách + chi tiết).
//   background?(ctx)  chạy một lần khi màn hình trở nên hiển thị cho tài khoản đang đăng nhập (kể cả khi đang ở màn hình
//             khác), dừng khi mô-đun tắt hoặc đổi tài khoản. Dùng ctx.every/ctx.onLeave; nhịp tự dừng khi ẩn tab.
//   plans?    { "<kind>": { title(ctx, preview) -> văn bản, summary(ctx, preview) -> HTML } } cho loại kế hoạch mới đi qua
//             ctx.propose (kế hoạch → xem lại → đồng ý trong 120 giây → giấy phép → receiver → bằng chứng).
//
// `ctx` (app.js dựng bằng makeCtx; cùng một bộ trường cho màn hình, phần của Kết nối và phần chạy nền)
//   Dữ liệu (chỉ đọc)
//     ctx.me                    phản hồi GET /v1/me, hoặc null khi chưa nối được máy chủ
//     ctx.modules               cờ mô-đun của me.modules (đối tượng đóng băng; {} khi chưa có me)
//     ctx.state                 { online, view, context, zone, settings, actions, site, lamps, availability } đóng băng.
//                               `lamps` là đèn tại site (không phải máy của người dùng). Không có dữ liệu sức khỏe.
//     ctx.zone() -> múi IANA phân tích của người dùng;  ctx.now() -> mili giây theo đồng hồ máy chủ
//     ctx.api                   client /v1: api.get(path), api.post(path, body?, { key? }) — mọi POST có Idempotency-Key;
//                               tự tạo khóa cùng bản nháp và truyền { key } khi người dùng bấm gửi lại đúng nội dung cũ
//   Ngôn ngữ (web/shared/i18n.js)
//     ctx.t(key, params?) -> văn bản thuần;  ctx.tSafe(key, params?) -> đã thoát ký tự, ghép thẳng vào HTML
//     ctx.locale() -> tag đang chọn
//     ctx.formatNumber(n, options?)  ctx.formatDate(value, options?)  ctx.formatWeekday(value, style?, timeZone?)
//     ctx.formatTime24(value, timeZone?) -> "HH:MM"  ctx.formatDuration(phút, { unit?, list? }?)  ctx.formatList(items, options?)
//   Giao diện
//     ctx.safe(value) -> thoát & < > " '  (mọi dữ liệu và mọi chuỗi dịch ghép vào HTML phải qua safe hoặc tSafe)
//     ctx.icon(name) -> SVG 24 px của bộ glyph trong app.js (messages, link, share, send, phone, tablet, laptop, desktop,
//                       watch, bluetooth, file, globe, bell, search, trash, block, flag, key, copy, mail, refresh, close,
//                       people, và các glyph cũ: check, plus, lock, shield, clock, alert, arrow…); tên lạ ra glyph spark
//     ctx.toast(văn bản)
//     ctx.openDialog(tiêu đề văn bản, html, { onClose? }) -> phần tử thân hộp thoại; onClose gọi đúng một lần khi hộp
//                       đóng (nút ✕, Escape) hoặc khi nội dung bị thay.  ctx.closeDialog()
//     ctx.rerender()            vẽ lại ứng dụng (màn hình có trạng thái nhận update)
//     ctx.refresh() -> Promise  nạp lại /v1/me, lịch, đèn, tác vụ rồi vẽ lại (sau khi đổi đồng ý, liên kết…)
//     ctx.navigate(id, { focus? }?) -> boolean (false nếu màn hình không tồn tại hoặc không hiện với tài khoản này)
//   Thay đổi ra ngoài LeNhip
//     ctx.propose(input, nhãn)  tạo kế hoạch và mở bước xem lại + đồng ý 120 giây dùng chung; không có đường tắt nào khác
//     ctx.actionCard(action, compact?) -> HTML thẻ tác vụ theo bằng chứng (trạng thái, UNKNOWN không tự thành FAILED)
//   Vòng đời (chỉ trong mount, bind/render của màn hình hay phần, hoặc background; ctx của visible/nav/plans không có)
//     ctx.every(ms ≥ 250, fn, { immediate? }?) -> hàm dừng. Nhịp tạm dừng khi ẩn tab, chạy lại kèm một lần gọi ngay khi tab
//                       hiện, dừng hẳn khi rời màn hình; lần gọi trước chưa xong thì bỏ nhịp kế tiếp.
//     ctx.onLeave(fn)           dọn dẹp khi rời màn hình (hoặc trước khi phần/màn hình đơn giản bị vẽ lại)
//     ctx.signal                AbortSignal bị hủy cùng lúc: addEventListener(…, { signal: ctx.signal })
//     ctx.fork() -> { ctx, end() }  phạm vi con (màn hình Kết nối dùng cho từng phần)
//
// Thuộc tính và id app.js đã dùng, mô-đun mới không đặt lại nghĩa: data-nav, data-action, data-context, data-login,
// data-device, data-theme-choice, data-draft-theme, data-check-action, data-cancel-action; id chat-form, chat-list,
// block-form, consent-form, countdown, action-body, action-title. Muốn điều hướng thì dùng <button data-nav="id">.
import { coreViews } from "./core.js";
import messages from "./messages.js";
import connect from "./connect.js";

/** Số mục tối đa trên thanh dưới của điện thoại (LNH-T51). */
export const BAR_LIMIT = 5;

/** @param {{ mount?: unknown }} view */
export const isStateful = (view) => typeof view.mount === "function";

function validate(list) {
  const seen = new Set();
  for (const v of list) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(v.id ?? "")) throw new Error("views: id không hợp lệ: " + v.id);
    if (seen.has(v.id)) throw new Error("views: trùng id " + v.id);
    seen.add(v.id);
    if (typeof v.order !== "number" || typeof v.visible !== "function") throw new Error("views: " + v.id + " thiếu order hoặc visible");
    if (!v.nav || typeof v.nav.label !== "function" || typeof v.nav.icon !== "string" || typeof v.nav.bar !== "boolean") throw new Error("views: " + v.id + " thiếu nav.label, nav.icon hoặc nav.bar");
    if (isStateful(v) === (typeof v.render === "function")) throw new Error("views: " + v.id + " phải có đúng một trong render hoặc mount");
  }
  if (list.filter((v) => v.nav.bar).length > BAR_LIMIT) throw new Error("views: thanh dưới của điện thoại chỉ chứa " + BAR_LIMIT + " mục");
  if (!seen.has("home")) throw new Error("views: thiếu màn hình home");
}

/**
 * Danh sách màn hình theo thứ tự điều hướng. Bốn màn hình gốc vẫn vẽ trong app.js; app.js truyền hàm vẽ của chúng vào đây.
 * @param {{ home: () => string, health: () => string, work: () => string, house: () => string }} coreRenderers
 */
export function buildViews(coreRenderers) {
  const list = [...coreViews(coreRenderers), messages, connect];
  validate(list);
  return list.sort((a, b) => a.order - b.order);
}

/** Gộp phần `plans` của mọi màn hình: loại kế hoạch → { title, summary }. */
export function planKinds(views) {
  const out = {};
  for (const v of views) {
    for (const [kind, hooks] of Object.entries(v.plans ?? {})) {
      if (Object.hasOwn(out, kind)) throw new Error("views: trùng loại kế hoạch " + kind);
      if (typeof hooks?.title !== "function" || typeof hooks?.summary !== "function") throw new Error("views: loại kế hoạch " + kind + " cần title và summary");
      out[kind] = hooks;
    }
  }
  return out;
}
