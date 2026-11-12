// @ts-check
// Nguồn dữ liệu sức khỏe trên thiết bị (LNH-T52, LNH-T55). Mặc định là dữ liệu tổng hợp của bản web tham chiếu.
// Một nguồn khác (ví dụ tệp xuất do người dùng tự nhập) đăng ký bằng registerHealthProvider(). Mọi thứ ở đây ở lại trên
// thiết bị này: không hàm nào gọi mạng, và máy chủ không biết thiết bị đang dùng nguồn nào.
import { syntheticHealthInput } from "./synthetic.js";

/**
 * @typedef {{ kind: "synthetic" } | { kind: "import", label: string, detail?: string }} HealthProvenance
 *   `label` và `detail` là văn bản đã dịch do nguồn cung cấp (tên loại tệp, tên nguồn người dùng chọn, thời điểm nhập).
 * @typedef {{ sub: string, nowMs: number, zone: string, revision: number }} HealthQuery
 * @typedef {(q: HealthQuery) => ({ input: any, provenance: HealthProvenance } | null)} HealthProvider
 *   `input` đúng dạng đầu vào của computeHealthDays() trong sleep.js. Trả null khi nguồn không có dữ liệu cho người này.
 */

/** @type {HealthProvider[]} */
const providers = [];
/** @type {Set<() => void>} */
const listeners = new Set();

/** Đăng ký một nguồn; nguồn đăng ký trước được hỏi trước. Gọi lúc nạp mô-đun, trước khi ứng dụng tính sức khỏe. */
export function registerHealthProvider(/** @type {HealthProvider} */ provider) {
  providers.push(provider);
}

/** Đầu vào cho LNH-SLEEP-1 và nguồn gốc của nó. Không nguồn nào có dữ liệu thì dùng dữ liệu tổng hợp. */
export function healthInputFor(/** @type {HealthQuery} */ query) {
  for (const provider of providers) {
    const found = provider(query);
    if (found) return found;
  }
  return { input: syntheticHealthInput(query.nowMs, query.zone, query.revision), provenance: /** @type {HealthProvenance} */ ({ kind: "synthetic" }) };
}

/** Ứng dụng nghe để tính lại và vẽ lại khi một nguồn nhập hoặc xóa dữ liệu. Trả hàm hủy đăng ký. */
export function onHealthInputChanged(/** @type {() => void} */ listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Nguồn gọi sau khi dữ liệu của nó đổi (nhập xong, xóa xong). */
export function notifyHealthInputChanged() {
  for (const listener of [...listeners]) listener();
}
