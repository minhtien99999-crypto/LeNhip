// @ts-check
// Bộ phân tích GATT chuẩn cho thiết bị theo dõi (LNH-T54): Heart Rate Measurement 0x2A37, Body Sensor Location 0x2A38,
// Battery Level 0x2A19. Hàm thuần trên DataView, chạy được trên trình duyệt lẫn Node; không gọi Bluetooth, không lưu, không gửi.
// Bố cục byte theo GATT Specification Supplement của Bluetooth SIG; mọi trường nhiều byte là little-endian.
// - Gói ngắn hơn điều cờ đã hứa bị TỪ CHỐI, không đọc quá cuối gói.
// - Nhịp tim ngoài HealthSource v1 (bước chân, giấc ngủ): chỉ để hiển thị trực tiếp, không phải thiết bị y tế (LNH-Q11).
// - Không có bộ phân tích cho Physical Activity Monitor 0x183E: bố cục chưa kiểm chứng được và chưa thấy thiết bị nào dùng.

/** Số được gán của Bluetooth SIG cho hai dịch vụ và ba đặc tính mà bản này đọc. */
export const GATT = Object.freeze({
  HEART_RATE_SERVICE: 0x180d,
  BATTERY_SERVICE: 0x180f,
  HEART_RATE_MEASUREMENT: 0x2a37,
  BODY_SENSOR_LOCATION: 0x2a38,
  BATTERY_LEVEL: 0x2a19,
});

/** Vị trí cảm biến theo giá trị 0–6 của 0x2A38; 7–255 là dành riêng. */
export const SENSOR_LOCATIONS = Object.freeze(["other", "chest", "wrist", "finger", "hand", "ear_lobe", "foot"]);

/**
 * @typedef {"NOT_BYTES" | "EMPTY" | "TRUNCATED" | "ODD_RR_BYTES" | "OUT_OF_RANGE"} GattError
 * @typedef {{ ok: false, error: GattError }} GattFailure
 * @typedef {{ ok: true, bpm: number, format: 8 | 16, contact: "detected" | "not_detected" | "not_supported",
 *   energyExpendedRaw: number | null, rrRaw: number[], rrMs: number[], reservedFlags: number, extraBytes: number }} HeartRate
 *   `contact`: chỉ có nghĩa khi cảm biến báo hỗ trợ (bit 2). "not_detected" nghĩa là chưa chạm da: số bpm không được coi là
 *   số đo. `energyExpendedRaw`: số nguyên 16 bit đúng như thiết bị gửi; đơn vị (joule hay kilojoule) chưa kiểm chứng nên không
 *   hiển thị. `rrRaw`: đơn vị 1/1024 giây, cũ nhất trước; `rrMs` = làm tròn(raw × 1000 / 1024).
 */

/**
 * Nhận DataView (kể cả có byteOffset), ArrayBuffer hoặc Uint8Array.
 * @param {unknown} value
 * @returns {DataView | null}
 */
function view(value) {
  if (value instanceof DataView) return value;
  if (value instanceof ArrayBuffer) return new DataView(value);
  if (ArrayBuffer.isView(value)) return new DataView(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** @param {GattError} error @returns {GattFailure} */
const fail = (error) => ({ ok: false, error });

/**
 * Heart Rate Measurement (0x2A37). Thứ tự: cờ, nhịp tim (uint8 hoặc uint16), [năng lượng uint16], [các khoảng RR uint16…].
 * Cờ: bit 0 dạng giá trị, bit 1 đang chạm da, bit 2 có hỗ trợ phát hiện chạm da, bit 3 có năng lượng, bit 4 có khoảng RR.
 * @param {unknown} value
 * @returns {HeartRate | GattFailure}
 */
export function parseHeartRateMeasurement(value) {
  const v = view(value);
  if (!v) return fail("NOT_BYTES");
  if (v.byteLength < 1) return fail("EMPTY");
  const flags = v.getUint8(0);
  let o = 1;
  /** @type {8 | 16} */
  const format = flags & 0x01 ? 16 : 8;
  if (v.byteLength < o + format / 8) return fail("TRUNCATED");
  const bpm = format === 16 ? v.getUint16(o, true) : v.getUint8(o);
  o += format / 8;
  /** @type {number | null} */
  let energyExpendedRaw = null;
  if (flags & 0x08) {
    if (v.byteLength < o + 2) return fail("TRUNCATED");
    energyExpendedRaw = v.getUint16(o, true);
    o += 2;
  }
  /** @type {number[]} */
  const rrRaw = [];
  let extraBytes = 0;
  if (flags & 0x10) {
    const rest = v.byteLength - o;
    if (rest < 2) return fail("TRUNCATED"); // cờ hứa ít nhất một khoảng RR
    if (rest % 2 !== 0) return fail("ODD_RR_BYTES");
    for (; o < v.byteLength; o += 2) rrRaw.push(v.getUint16(o, true));
  } else {
    extraBytes = v.byteLength - o; // byte thừa sau các trường đã biết (bit 5–7 dành riêng): bỏ qua, không đoán nghĩa
  }
  const contact = flags & 0x04 ? (flags & 0x02 ? "detected" : "not_detected") : "not_supported";
  return {
    ok: true, bpm, format, contact, energyExpendedRaw, rrRaw,
    rrMs: rrRaw.map((raw) => Math.round((raw * 1000) / 1024)),
    reservedFlags: flags & 0xe0, extraBytes,
  };
}

/**
 * Body Sensor Location (0x2A38): một byte.
 * @param {unknown} value
 * @returns {{ ok: true, code: number, location: string } | GattFailure} `location` là một mục của SENSOR_LOCATIONS hoặc "reserved"
 */
export function parseBodySensorLocation(value) {
  const v = view(value);
  if (!v) return fail("NOT_BYTES");
  if (v.byteLength < 1) return fail("EMPTY");
  const code = v.getUint8(0);
  return { ok: true, code, location: SENSOR_LOCATIONS[code] ?? "reserved" };
}

/**
 * Battery Level (0x2A19): một byte phần trăm, khoảng cho phép 0–100. Giá trị ngoài khoảng bị từ chối, không cắt về 100.
 * @param {unknown} value
 * @returns {{ ok: true, percent: number } | GattFailure}
 */
export function parseBatteryLevel(value) {
  const v = view(value);
  if (!v) return fail("NOT_BYTES");
  if (v.byteLength < 1) return fail("EMPTY");
  const percent = v.getUint8(0);
  if (percent > 100) return fail("OUT_OF_RANGE");
  return { ok: true, percent };
}
