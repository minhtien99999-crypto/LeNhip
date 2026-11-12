// Bộ phân tích Blood Pressure Measurement 0x2A35 (N20‑MEAS, LNH-T67). Không có máy đo thật ở đây: vector là dữ liệu tổng hợp dựng
// từ bố cục của GATT Specification Supplement; bản này không nối với máy đo nào.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BP_GATT, MMHG_PER_KPA, parseBloodPressureMeasurement, sfloat, toImportItem } from "../web/shared/ble-bp.js";

const bytes = (hex: string) => Uint8Array.from((hex.match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16)));
const view = (hex: string) => new DataView(bytes(hex).buffer);

test("số được gán của dịch vụ và đặc tính", () => {
  assert.deepEqual({ ...BP_GATT }, { BLOOD_PRESSURE_SERVICE: 0x1810, BLOOD_PRESSURE_MEASUREMENT: 0x2a35 });
});

test("SFLOAT IEEE‑11073: số mũ âm, số âm, giá trị đặc biệt ra null", () => {
  assert.equal(sfloat(0x0078), 120);
  assert.equal(sfloat(0xf16e), 36.6); // định trị 366, số mũ −1
  assert.equal(sfloat(0x0fff), -1); // định trị −1, số mũ 0
  assert.equal(sfloat(0x1002), 20); // định trị 2, số mũ 1
  for (const special of [0x07ff, 0x0800, 0x07fe, 0x0802, 0x0801]) assert.equal(sfloat(special), null, special.toString(16));
});

test("0x2A35 theo vector: mmHg, có thời điểm và nhịp mạch", () => {
  assert.deepEqual(parseBloodPressureMeasurement(view("06 78 00 50 00 5d 00 ea 07 0b 0b 06 1e 00 48 00")), {
    ok: true, unit: "mmHg", systolic: 120, diastolic: 80, meanArterial: 93, timestamp: "2026-11-11T06:30:00", pulseRate: 72,
    userId: null, userUnknown: false, status: null, reservedFlags: 0, extraBytes: 0,
  });
});

test("0x2A35: kPa, mã người dùng, trạng thái; nhận Uint8Array và DataView có byteOffset", () => {
  // cờ 0x19: kPa + mã người dùng + trạng thái; 16,0 / 10,7 / 12,5 kPa (định trị 160/107/125, số mũ −1); người dùng 2;
  // trạng thái 0x0023: cử động, băng quấn lỏng, sai tư thế.
  const hex = "19 a0 f0 6b f0 7d f0 02 23 00";
  const expected = {
    ok: true, unit: "kPa", systolic: 16, diastolic: 10.7, meanArterial: 12.5, timestamp: null, pulseRate: null, userId: 2, userUnknown: false,
    status: { bodyMovement: true, cuffTooLoose: true, irregularPulse: false, pulseRange: "in_range", improperPosition: true, raw: 0x23 }, reservedFlags: 0, extraBytes: 0,
  };
  assert.deepEqual(parseBloodPressureMeasurement(bytes(hex)), expected);
  const padded = bytes("ff ff " + hex);
  assert.deepEqual(parseBloodPressureMeasurement(new DataView(padded.buffer, 2)), expected);
  assert.deepEqual(parseBloodPressureMeasurement(bytes(hex).buffer), expected);
});

test("0x2A35: mã người dùng 0xFF là không rõ; dải mạch; bit dành riêng và byte thừa không đoán nghĩa", () => {
  const r = parseBloodPressureMeasurement(view("f8 78 00 50 00 5d 00 ff 0c 00 aa"));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.userId, null);
  assert.equal(r.userUnknown, true);
  assert.equal(r.status?.irregularPulse, true);
  assert.equal(r.status?.pulseRange, "exceeds_upper");
  assert.equal(r.reservedFlags, 0xe0);
  assert.equal(r.extraBytes, 1);
});

test("0x2A35: thời điểm có năm hoặc tháng bằng 0 không dựng được; NaN của nhịp mạch ra null", () => {
  const r = parseBloodPressureMeasurement(view("06 78 00 50 00 5d 00 00 00 00 00 00 00 00 ff 07"));
  assert.equal(r.ok && r.timestamp, null);
  assert.equal(r.ok && r.pulseRate, null);
});

test("0x2A35: gói ngắn hơn điều cờ hứa bị từ chối; giá trị không phải byte bị từ chối", () => {
  assert.deepEqual(parseBloodPressureMeasurement(view("")), { ok: false, error: "EMPTY" });
  assert.deepEqual(parseBloodPressureMeasurement(view("00 78 00 50 00 5d")), { ok: false, error: "TRUNCATED" });
  assert.deepEqual(parseBloodPressureMeasurement(view("06 78 00 50 00 5d 00 ea 07 0b 0b 06 1e 00 48")), { ok: false, error: "TRUNCATED" });
  assert.deepEqual(parseBloodPressureMeasurement(view("10 78 00 50 00 5d 00 01")), { ok: false, error: "TRUNCATED" });
  assert.deepEqual(parseBloodPressureMeasurement("06 78"), { ok: false, error: "NOT_BYTES" });
  assert.deepEqual(parseBloodPressureMeasurement(null), { ok: false, error: "NOT_BYTES" });
});

test("toImportItem: đổi kPa sang mmHg, giữ thời điểm gốc cùng múi của điện thoại, bỏ bit mạch không đều", () => {
  const kpa = parseBloodPressureMeasurement(view("1b a0 f0 6b f0 7d f0 ea 07 0b 0b 06 1e 00 01 04 00"));
  assert.equal(kpa.ok, true);
  if (!kpa.ok) return;
  assert.equal(kpa.status?.irregularPulse, true);
  const item = toImportItem(kpa, { sourceKey: "k1", deviceRef: "cuff_x", zone: "Asia/Ho_Chi_Minh" });
  assert.deepEqual(item, {
    source_key: "k1", device_ref: "cuff_x", user_slot: 1, subject_hint: null, measured_at: "2026-11-11T06:30:00", zone: "Asia/Ho_Chi_Minh",
    systolic: Math.round(16 * MMHG_PER_KPA), diastolic: Math.round(10.7 * MMHG_PER_KPA), unit: "mmHg", quality_flags: [],
  });
  assert.ok(!JSON.stringify(item).includes("irregular"));
  const noTime = parseBloodPressureMeasurement(view("00 78 00 50 00 5d 00"));
  assert.equal(noTime.ok && toImportItem(noTime, { sourceKey: "k2", deviceRef: "cuff_x", zone: "UTC" }), null, "không có thời điểm thì không đoán");
});

test("bộ phân tích không gọi Bluetooth, mạng hay bộ nhớ của trình duyệt", () => {
  const src = readFileSync(new URL("../web/shared/ble-bp.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const word of ["navigator", "fetch(", "localStorage", "indexedDB", "XMLHttpRequest"]) assert.ok(!src.includes(word), word);
  assert.ok(!/^\s*import\s/m.test(src), "không import gì");
});
