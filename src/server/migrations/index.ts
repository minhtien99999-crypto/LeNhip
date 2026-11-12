// Danh sách migration sau 0001, theo thứ tự áp dụng. 0001 nằm trong ../store.ts và không bao giờ sửa.
//
// Thêm một migration = một tệp mới `NNNN_ten.ts` trong thư mục này (export một Migration có id, sql, sha256) + một dòng import
// và một dòng trong mảng, đặt NGAY DƯỚI dòng mốc của số đó. Mỗi số có mốc riêng để hai nhánh thêm hai migration khác nhau
// không sửa cùng một chỗ. Số đã dành:
//   0002  Authority V1.0.0 (grants.scope, consents.purpose_id)            đã có
//   0003  nhắn tin và «Thiết bị của tôi» (LNH-T30..T36)                   dành cho track nhắn tin
//   0004  mạng xã hội (LNH-T42..T45)                                      dành cho track mạng xã hội
//   0005  Authority V1.0.1 (từ vựng của SRS V2.0)                         đã có
//   0006  đồng bộ bản nháp và phiên thiết bị (N20‑SYNC)                   dành cho track sync
//   0007  Hộp tổng hợp (N20‑INB)                                          dành cho track inbox
//   0008  Le‑NodeHome và HaaS (N20‑HOME, N20‑HAAS)                        dành cho track home
//   0009  Le‑NodeHealth phép đo (N20‑MEAS)                                dành cho track measurements
//   0010  cổng mô phỏng Le‑ORION (N20‑SIM)                                dành cho track sim
// Từ 0006, mỗi migration chỉ được dựa vào lược đồ tới hết 0005, không dựa vào nhau.
// 0003 và 0004 chỉ được dựa vào lược đồ tới hết 0002, không dựa vào nhau: một sổ có thể đã chạy số này trước số kia.
// Số từ 0005 trở đi: thêm mốc mới ở cuối khi cần.
import type { Migration } from "../store.ts";
import { m0002 } from "./0002_v1_authority.ts";
// ── 0003 nhắn tin: dòng import đặt ngay dưới dòng này ──
import { m0003 } from "./0003_messaging.ts";
// ── 0004 mạng xã hội: dòng import đặt ngay dưới dòng này ──
import { m0005 } from "./0005_v2_authority.ts";
// ── 0006 sync: dòng import đặt ngay dưới dòng này ──
import { m0006 } from "./0006_sync.ts";
// ── 0007 inbox: dòng import đặt ngay dưới dòng này ──
import { m0007 } from "./0007_inbox.ts";
// ── 0008 home: dòng import đặt ngay dưới dòng này ──
import { m0008 } from "./0008_home.ts";
// ── 0009 measurements: dòng import đặt ngay dưới dòng này ──
import { m0009 } from "./0009_measurements.ts";
// ── 0010 sim: dòng import đặt ngay dưới dòng này ──
import { m0010 } from "./0010_sim.ts";

export const LATER_MIGRATIONS: Migration[] = [
  m0002,
  // ── 0003 nhắn tin: một dòng `m0003,` đặt ngay dưới dòng này ──
  m0003,
  // ── 0004 mạng xã hội: một dòng `m0004,` đặt ngay dưới dòng này ──
  m0005,
  // ── 0006 sync: một dòng `m0006,` đặt ngay dưới dòng này ──
  m0006,
  // ── 0007 inbox: một dòng `m0007,` đặt ngay dưới dòng này ──
  m0007,
  // ── 0008 home: một dòng `m0008,` đặt ngay dưới dòng này ──
  m0008,
  // ── 0009 measurements: một dòng `m0009,` đặt ngay dưới dòng này ──
  m0009,
  // ── 0010 sim: một dòng `m0010,` đặt ngay dưới dòng này ──
  m0010,
];
