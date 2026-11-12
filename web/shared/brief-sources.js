// @ts-check
// Sổ nguồn của Bản tóm tắt buổi sáng (SRS V2.0 mục 03, LNH-T62). Mô-đun khác (Hộp tổng hợp, Ngôi nhà…) thêm một dòng vào bản tóm
// tắt bằng cách đăng ký ở đây lúc nạp tệp của mình, không sửa app.js hay web/shared/brief.js:
//
//   import { registerBriefSource } from "../shared/brief-sources.js";
//   registerBriefSource({ id: "inbox", order: 60, visible: (ctx) => ctx.modules.inbox === true, render: (ctx) => "<span>…</span>" });
//
// - id: chữ thường, số, gạch nối; duy nhất. order: số; các dòng sẵn có của bản tóm tắt dùng 10 (giấc ngủ), 20 (bước chân),
//   30 (lịch hôm nay), 40 (tin nhắn), 50 (bản nháp). Nguồn mới dùng từ 60.
// - visible(ctx) -> boolean; render(ctx) -> HTML của nội dung một dòng (đã thoát ký tự), "" để bỏ dòng. ctx là ctx chỉ đọc của khung
//   (không có every/onLeave), cộng ctx.state.online. Không có dữ liệu sức khỏe nào trong ctx.
// - Dòng phải dựng được từ dữ liệu thiết bị đã có, không gọi mạng khi vẽ, và nói trung tính khi nguồn chưa sẵn sàng hay ngoại tuyến.
//   Nội dung không tin cậy (tiêu đề email, nội dung chia sẻ) chỉ là chữ, không phải nút hành động (X04).
// - Lỗi của một nguồn chỉ làm mất dòng của nó.

/** @typedef {{ id: string, order: number, visible: (ctx: any) => boolean, render: (ctx: any) => string }} BriefSource */

/** @type {BriefSource[]} */
const SOURCES = [];

/** @param {BriefSource} source */
export function registerBriefSource(source) {
  if (!source || !/^[a-z][a-z0-9-]*$/.test(source.id)) throw new TypeError("nguồn tóm tắt cần id chữ thường");
  if (typeof source.order !== "number" || typeof source.visible !== "function" || typeof source.render !== "function") throw new TypeError(`nguồn tóm tắt ${source.id}: cần order, visible, render`);
  if (SOURCES.some((s) => s.id === source.id)) throw new Error(`nguồn tóm tắt ${source.id} đăng ký hai lần`);
  SOURCES.push(Object.freeze({ ...source }));
  SOURCES.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1));
}

/** Các nguồn đã đăng ký, theo thứ tự. @returns {readonly BriefSource[]} */
export const briefSources = () => SOURCES.slice();

/** Dòng của các nguồn đang hiện: [{ id, order, html }]. Nguồn ném lỗi bị bỏ qua. @param {any} ctx */
export function sourceLines(ctx) {
  const out = [];
  for (const s of SOURCES) {
    try {
      if (s.visible(ctx) !== true) continue;
      const html = s.render(ctx);
      if (typeof html === "string" && html) out.push({ id: s.id, order: s.order, html });
    } catch {
      /* nguồn hỏng chỉ mất dòng của nó */
    }
  }
  return out;
}
