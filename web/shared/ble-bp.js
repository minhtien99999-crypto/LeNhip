// @ts-check
// Bộ phân tích đặc tính Blood Pressure Measurement 0x2A35 (dịch vụ Blood Pressure 0x1810) của Bluetooth SIG, cho Le‑NodeHealth
// (SRS V2.0 mục 08, N20‑MEAS, LNH-T67). Hàm thuần trên DataView, chạy được trên trình duyệt lẫn Node; không gọi Bluetooth, không
// lưu, không gửi. Bản này KHÔNG nối với máy đo nào: chưa có tích hợp OMRON hay Withings, chưa có Web Bluetooth cho máy đo huyết áp.
//
// Bố cục (GATT Specification Supplement), mọi trường nhiều byte little-endian:
//   Flags uint8: bit 0 đơn vị (0 mmHg, 1 kPa), bit 1 có thời điểm, bit 2 có nhịp mạch, bit 3 có mã người dùng, bit 4 có trạng thái
//   ba SFLOAT (IEEE‑11073 16 bit): tâm thu, tâm trương, huyết áp trung bình
//   [Date Time 7 byte: năm uint16, tháng, ngày, giờ, phút, giây]   giờ của máy đo, KHÔNG có múi giờ
//   [SFLOAT nhịp mạch, nhịp/phút]  [uint8 mã người dùng, 0xFF = không rõ]
//   [uint16 trạng thái: bit 0 cử động, bit 1 băng quấn lỏng, bit 2 mạch không đều, bit 3–4 dải mạch, bit 5 sai tư thế]
// - Gói ngắn hơn điều cờ đã hứa bị TỪ CHỐI, không đọc quá cuối gói.
// - SFLOAT đặc biệt (NaN, NRes, ±INF, dành riêng) ra null: «không có giá trị», không đoán.
// - Bit «mạch không đều» được đọc đúng theo đặc tả nhưng LeNhip KHÔNG hiển thị, không lưu và không chuyển lên máy chủ:
//   chỉ báo nhịp tim (AFib) nằm ngoài phạm vi V2.0 (§08). toImportItem() bỏ nó đi.

export const BP_GATT = Object.freeze({ BLOOD_PRESSURE_SERVICE: 0x1810, BLOOD_PRESSURE_MEASUREMENT: 0x2a35 });

/** 1 kPa = 7,50062 mmHg. */
export const MMHG_PER_KPA = 7.50062;

/**
 * @typedef {"NOT_BYTES" | "EMPTY" | "TRUNCATED"} BpError
 * @typedef {{ ok: false, error: BpError }} BpFailure
 * @typedef {{ bodyMovement: boolean, cuffTooLoose: boolean, irregularPulse: boolean,
 *   pulseRange: "in_range" | "exceeds_upper" | "below_lower" | "reserved", improperPosition: boolean, raw: number }} BpStatus
 * @typedef {{ ok: true, unit: "mmHg" | "kPa", systolic: number | null, diastolic: number | null, meanArterial: number | null,
 *   timestamp: string | null, pulseRate: number | null, userId: number | null, userUnknown: boolean, status: BpStatus | null,
 *   reservedFlags: number, extraBytes: number }} BloodPressure
 *   `timestamp`: "YYYY-MM-DDTHH:MM:SS" theo đồng hồ của máy đo, không có độ lệch; null khi không có hoặc năm/tháng/ngày là 0.
 *   `userId`: 0–254 theo hồ sơ trên máy đo; 0xFF ra null cùng userUnknown = true.
 */

/** @param {unknown} value @returns {DataView | null} */
function view(value) {
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (ArrayBuffer.isView(value)) return new DataView(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** @param {BpError} error @returns {BpFailure} */
const fail = (error) => ({ ok: false, error });

/**
 * SFLOAT IEEE‑11073 16 bit: số mũ 4 bit có dấu (nibble cao), phần định trị 12 bit có dấu. Giá trị đặc biệt ra null.
 * @param {number} raw số 16 bit
 * @returns {number | null}
 */
export function sfloat(raw) {
  const r = raw & 0xffff;
  if (r === 0x07ff || r === 0x0800 || r === 0x07fe || r === 0x0802 || r === 0x0801) return null;
  let mantissa = r & 0x0fff;
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  let exponent = r >> 12;
  if (exponent >= 0x8) exponent -= 0x10;
  // Làm tròn theo số chữ số thập phân của số mũ để 366 × 10^-1 ra 36.6, không ra 36.599999…
  const value = mantissa * 10 ** exponent;
  return exponent < 0 ? Number(value.toFixed(-exponent)) : value;
}

const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, "0");

/**
 * Blood Pressure Measurement (0x2A35).
 * @param {unknown} value
 * @returns {BloodPressure | BpFailure}
 */
export function parseBloodPressureMeasurement(value) {
  const v = view(value);
  if (!v) return fail("NOT_BYTES");
  if (v.byteLength < 1) return fail("EMPTY");
  const flags = v.getUint8(0);
  const need = 1 + 6 + (flags & 0x02 ? 7 : 0) + (flags & 0x04 ? 2 : 0) + (flags & 0x08 ? 1 : 0) + (flags & 0x10 ? 2 : 0);
  if (v.byteLength < need) return fail("TRUNCATED");
  let o = 1;
  const next16 = () => {
    const x = v.getUint16(o, true);
    o += 2;
    return x;
  };
  const systolic = sfloat(next16());
  const diastolic = sfloat(next16());
  const meanArterial = sfloat(next16());
  /** @type {string | null} */
  let timestamp = null;
  if (flags & 0x02) {
    const year = next16();
    const [month, day, hh, mm, ss] = [0, 1, 2, 3, 4].map((i) => v.getUint8(o + i));
    o += 5;
    // Năm, tháng hoặc ngày bằng 0 nghĩa là máy đo không biết: không dựng thời điểm.
    if (year >= 1582 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= 31 && hh <= 23 && mm <= 59 && ss <= 59) {
      timestamp = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hh)}:${pad(mm)}:${pad(ss)}`;
    }
  }
  const pulseRate = flags & 0x04 ? sfloat(next16()) : null;
  let userId = null;
  let userUnknown = false;
  if (flags & 0x08) {
    const u = v.getUint8(o);
    o += 1;
    if (u === 0xff) userUnknown = true;
    else userId = u;
  }
  /** @type {BpStatus | null} */
  let status = null;
  if (flags & 0x10) {
    const s = next16();
    const range = (s >> 3) & 0x03;
    status = {
      bodyMovement: !!(s & 0x01),
      cuffTooLoose: !!(s & 0x02),
      irregularPulse: !!(s & 0x04),
      pulseRange: /** @type {const} */ (["in_range", "exceeds_upper", "below_lower", "reserved"])[range],
      improperPosition: !!(s & 0x20),
      raw: s,
    };
  }
  return {
    ok: true, unit: flags & 0x01 ? "kPa" : "mmHg", systolic, diastolic, meanArterial, timestamp, pulseRate, userId, userUnknown, status,
    reservedFlags: flags & 0xe0, extraBytes: v.byteLength - o,
  };
}

/**
 * Chuyển một số đo đã phân tích sang một mục của POST /v2/health/observations/import (schema MeasImportItem). Hàm cho adapter
 * tương lai trên thiết bị; bản này chưa gọi nó ở đâu. Trả null khi thiếu tâm thu, tâm trương hoặc thời điểm: không đoán.
 * - kPa đổi sang mmHg, làm tròn tới số nguyên (máy chủ chỉ nhận mmHg).
 * - Thời điểm của máy đo không có múi giờ: đi kèm `zone` của điện thoại chuyển tiếp, bên nhận giữ nguyên chuỗi gốc.
 * - Trạng thái chỉ còn ba cờ chất lượng (cử động, băng quấn lỏng, sai tư thế); bit «mạch không đều» và dải mạch bị bỏ.
 * @param {BloodPressure} m
 * @param {{ sourceKey: string, deviceRef: string, zone: string }} o
 */
export function toImportItem(m, o) {
  if (m.systolic === null || m.diastolic === null || m.timestamp === null) return null;
  const toMmHg = (/** @type {number} */ x) => Math.round(m.unit === "kPa" ? x * MMHG_PER_KPA : x);
  /** @type {("BODY_MOVEMENT" | "CUFF_LOOSE" | "IMPROPER_POSITION")[]} */
  const quality = [];
  if (m.status?.bodyMovement) quality.push("BODY_MOVEMENT");
  if (m.status?.cuffTooLoose) quality.push("CUFF_LOOSE");
  if (m.status?.improperPosition) quality.push("IMPROPER_POSITION");
  return {
    source_key: o.sourceKey, device_ref: o.deviceRef, user_slot: m.userId !== null && m.userId >= 1 && m.userId <= 8 ? m.userId : null, subject_hint: null,
    measured_at: m.timestamp, zone: o.zone, systolic: toMmHg(m.systolic), diastolic: toMmHg(m.diastolic), unit: "mmHg", quality_flags: quality,
  };
}
