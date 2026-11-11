// @ts-check
// Chữ LeLe đã chốt (LeASO–LHLC Web 1.0.7, "LeLe sử dụng font chữ như ảnh"): hình vẽ theo ảnh chữ "Le" màu hổ phách đã duyệt,
// không phải phông. Chữ L góc vuông, mép ngoài bo mềm, góc trong bo nhỏ; chữ e là khối bo tròn có rãnh, góc dưới phải hở. Cùng
// dữ liệu đường với app/_ui/lele-mark.tsx của LeASO–LHLC. Màu hổ phách (--lele); trên quả cầu dùng bản hai màu như ảnh đăng nhập
// V1.0 (Le hổ phách, Le xanh). Trình đọc màn hình đọc "LeLe".

/** @param {number} x */
const L = (x) => `M${x} 0h32v133a10 10 0 0 0 10 10h79v29h-73a48 36 0 0 1-48-36z`;
/** @param {number} x @param {number} y */
const E = (x, y) =>
  `M${x + 15} ${y}h114a15 15 0 0 1 15 15v54a12 12 0 0 1-12 12h-102v21h114v16a15 15 0 0 1-15 15h-114a15 15 0 0 1-15-15v-103a15 15 0 0 1 15-15zM${x + 30} ${y + 30}h85v21h-85z`;

/** Cặp "Le" thứ nhất và thứ hai; chiều cao chữ hoa 172, chiều cao chữ thường 133. */
export const LE_FIRST = L(0) + E(143, 39);
export const LE_SECOND = L(309) + E(452, 39);
export const VIEWBOX = "0 0 596 172";

/**
 * SVG của chữ LeLe.
 * @param {{ tone?: "amber" | "duo" | "current", className?: string, label?: boolean }} [o]
 */
export function leleMark(o = {}) {
  const tone = o.tone ?? "amber";
  const cls = ["lele-mark", tone === "duo" ? "duo" : tone === "current" ? "current" : "amber", o.className ?? ""].join(" ").trim();
  const a11y = o.label === false ? 'aria-hidden="true"' : 'role="img" aria-label="LeLe"';
  if (tone === "duo") {
    return `<svg class="${cls}" viewBox="${VIEWBOX}" ${a11y} focusable="false"><path d="${LE_FIRST}" fill="var(--lele-a)" fill-rule="evenodd"/><path d="${LE_SECOND}" fill="var(--lele-b)" fill-rule="evenodd"/></svg>`;
  }
  return `<svg class="${cls}" viewBox="${VIEWBOX}" ${a11y} focusable="false"><path d="${LE_FIRST}${LE_SECOND}" fill="currentColor" fill-rule="evenodd"/></svg>`;
}
