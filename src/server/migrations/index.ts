// Danh sách migration sau 0001, theo thứ tự áp dụng. 0001 nằm trong ../store.ts và không bao giờ sửa.
//
// Thêm một migration = một tệp mới `NNNN_ten.ts` trong thư mục này (export một Migration có id, sql, sha256) + một dòng import
// và một dòng trong mảng, đặt NGAY DƯỚI dòng mốc của số đó. Mỗi số có mốc riêng để hai nhánh thêm hai migration khác nhau
// không sửa cùng một chỗ. Số đã dành:
//   0002  Authority V1.0.0 (grants.scope, consents.purpose_id)            đã có
//   0003  nhắn tin và «Thiết bị của tôi» (LNH-T30..T36)                   dành cho track nhắn tin
//   0004  mạng xã hội (LNH-T42..T45)                                      dành cho track mạng xã hội
// 0003 và 0004 chỉ được dựa vào lược đồ tới hết 0002, không dựa vào nhau: một sổ có thể đã chạy số này trước số kia.
// Số từ 0005 trở đi: thêm mốc mới ở cuối khi cần.
import type { Migration } from "../store.ts";
import { m0002 } from "./0002_v1_authority.ts";
// ── 0003 nhắn tin: dòng import đặt ngay dưới dòng này ──
// ── 0004 mạng xã hội: dòng import đặt ngay dưới dòng này ──

export const LATER_MIGRATIONS: Migration[] = [
  m0002,
  // ── 0003 nhắn tin: một dòng `m0003,` đặt ngay dưới dòng này ──
  // ── 0004 mạng xã hội: một dòng `m0004,` đặt ngay dưới dòng này ──
];
