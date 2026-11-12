// Bộ phân tích GATT chuẩn và phiên đọc nhịp tim (LNH-T54). Không có thiết bị Bluetooth thật ở đây: vector là dữ liệu tổng hợp
// dựng từ bố cục của GATT Specification Supplement, và «thiết bị» của phiên là một đối tượng giả trong bộ nhớ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GATT, SENSOR_LOCATIONS, parseBatteryLevel, parseBodySensorLocation, parseHeartRateMeasurement } from "../web/shared/ble-gatt.js";
import { REQUEST_OPTIONS, STALE_AFTER_MS, TRACE_WINDOW_MS, adapterAvailable, bluetoothSupport, createHeartRateSession } from "../web/shared/ble-live.js";

const bytes = (hex: string) => Uint8Array.from((hex.match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16)));
const view = (hex: string) => new DataView(bytes(hex).buffer);

test("số được gán: hai dịch vụ và ba đặc tính mà bản này đọc", () => {
  assert.deepEqual({ ...GATT }, { HEART_RATE_SERVICE: 0x180d, BATTERY_SERVICE: 0x180f, HEART_RATE_MEASUREMENT: 0x2a37, BODY_SENSOR_LOCATION: 0x2a38, BATTERY_LEVEL: 0x2a19 });
});

test("0x2A37 theo vector: uint8 có tiếp xúc và một khoảng RR", () => {
  assert.deepEqual(parseHeartRateMeasurement(view("16 48 00 04")), {
    ok: true, bpm: 72, format: 8, contact: "detected", energyExpendedRaw: null, rrRaw: [1024], rrMs: [1000], reservedFlags: 0, extraBytes: 0,
  });
});

test("0x2A37 theo vector: uint16, cảm biến không hỗ trợ phát hiện tiếp xúc", () => {
  assert.deepEqual(parseHeartRateMeasurement(view("01 2c 01")), {
    ok: true, bpm: 300, format: 16, contact: "not_supported", energyExpendedRaw: null, rrRaw: [], rrMs: [], reservedFlags: 0, extraBytes: 0,
  });
});

test("0x2A37 theo vector: năng lượng và hai khoảng RR (đơn vị 1/1024 giây, cũ nhất trước)", () => {
  assert.deepEqual(parseHeartRateMeasurement(view("18 50 10 00 66 03 70 03")), {
    ok: true, bpm: 80, format: 8, contact: "not_supported", energyExpendedRaw: 16, rrRaw: [870, 880], rrMs: [850, 859], reservedFlags: 0, extraBytes: 0,
  });
});

test("0x2A37: có hỗ trợ tiếp xúc nhưng chưa chạm da thì báo not_detected", () => {
  const r = parseHeartRateMeasurement(view("04 00"));
  assert.ok(r.ok);
  assert.equal(r.contact, "not_detected");
  assert.equal(r.bpm, 0);
  // bit 1 đặt mà bit 2 không đặt: cảm biến không hỗ trợ, bit 1 không có nghĩa
  const odd = parseHeartRateMeasurement(view("02 3c"));
  assert.ok(odd.ok);
  assert.equal(odd.contact, "not_supported");
});

test("0x2A37: mọi tổ hợp cờ đọc đúng thứ tự trường", () => {
  // uint16 + tiếp xúc + năng lượng + ba khoảng RR
  const r = parseHeartRateMeasurement(view("1f 2c 01 34 12 00 04 00 02 ff ff"));
  assert.deepEqual(r, { ok: true, bpm: 300, format: 16, contact: "detected", energyExpendedRaw: 0x1234, rrRaw: [1024, 512, 65535], rrMs: [1000, 500, 63999], reservedFlags: 0, extraBytes: 0 });
  // bit dành riêng và byte thừa khi không có cờ RR: đọc các trường đã biết, ghi lại phần còn lại, không đoán nghĩa
  const reserved = parseHeartRateMeasurement(view("e0 48 aa bb"));
  assert.deepEqual(reserved, { ok: true, bpm: 72, format: 8, contact: "not_supported", energyExpendedRaw: null, rrRaw: [], rrMs: [], reservedFlags: 0xe0, extraBytes: 2 });
});

test("0x2A37: nhận DataView có byteOffset, ArrayBuffer và Uint8Array; không đọc ra ngoài khung nhìn", () => {
  const wide = bytes("ff ff 16 48 00 04 ff ff");
  const inner = new DataView(wide.buffer, 2, 4);
  const expected = parseHeartRateMeasurement(view("16 48 00 04"));
  assert.deepEqual(parseHeartRateMeasurement(inner), expected);
  assert.deepEqual(parseHeartRateMeasurement(wide.subarray(2, 6)), expected);
  assert.deepEqual(parseHeartRateMeasurement(bytes("16 48 00 04").buffer), expected);
  // khung nhìn dừng trước khoảng RR mà cờ đã hứa: từ chối, dù bộ đệm phía sau còn byte
  assert.deepEqual(parseHeartRateMeasurement(new DataView(wide.buffer, 2, 2)), { ok: false, error: "TRUNCATED" });
});

test("0x2A37: gói hỏng bị từ chối, không đọc quá cuối gói", () => {
  for (const [hex, error] of [
    ["", "EMPTY"],
    ["00", "TRUNCATED"], // thiếu giá trị uint8
    ["01 2c", "TRUNCATED"], // uint16 thiếu một byte
    ["08 50", "TRUNCATED"], // hứa năng lượng, không có
    ["08 50 10", "TRUNCATED"], // năng lượng thiếu một byte
    ["10 50", "TRUNCATED"], // hứa khoảng RR, không có
    ["10 50 00", "TRUNCATED"], // khoảng RR thiếu một byte
    ["10 50 00 04 01", "ODD_RR_BYTES"], // một khoảng trọn và một byte lẻ
    ["19 2c 01 10 00", "TRUNCATED"], // uint16 + năng lượng + RR nhưng hết gói
  ] as const) {
    assert.deepEqual(parseHeartRateMeasurement(view(hex)), { ok: false, error }, hex || "(rỗng)");
  }
  for (const junk of [null, undefined, "16480004", 72, [0x16, 0x48], {}]) assert.deepEqual(parseHeartRateMeasurement(junk), { ok: false, error: "NOT_BYTES" });
});

test("0x2A38: bảy vị trí có tên, còn lại là dành riêng", () => {
  assert.deepEqual([...SENSOR_LOCATIONS], ["other", "chest", "wrist", "finger", "hand", "ear_lobe", "foot"]);
  SENSOR_LOCATIONS.forEach((location, code) => assert.deepEqual(parseBodySensorLocation(Uint8Array.of(code)), { ok: true, code, location }));
  assert.deepEqual(parseBodySensorLocation(view("07")), { ok: true, code: 7, location: "reserved" });
  assert.deepEqual(parseBodySensorLocation(view("ff")), { ok: true, code: 255, location: "reserved" });
  assert.deepEqual(parseBodySensorLocation(view("")), { ok: false, error: "EMPTY" });
  assert.deepEqual(parseBodySensorLocation("02"), { ok: false, error: "NOT_BYTES" });
});

test("0x2A19 theo vector: 0x5a là 90 %; ngoài 0–100 bị từ chối, không cắt về 100", () => {
  assert.deepEqual(parseBatteryLevel(view("5a")), { ok: true, percent: 90 });
  assert.deepEqual(parseBatteryLevel(view("00")), { ok: true, percent: 0 });
  assert.deepEqual(parseBatteryLevel(view("64")), { ok: true, percent: 100 });
  assert.deepEqual(parseBatteryLevel(view("65")), { ok: false, error: "OUT_OF_RANGE" });
  assert.deepEqual(parseBatteryLevel(view("ff")), { ok: false, error: "OUT_OF_RANGE" });
  assert.deepEqual(parseBatteryLevel(view("")), { ok: false, error: "EMPTY" });
  assert.deepEqual(parseBatteryLevel(90), { ok: false, error: "NOT_BYTES" });
});

// ---------------------------------------------------------------- phiên đọc trực tiếp với thiết bị giả

type Listener = (e: unknown) => void;
class FakeTarget {
  listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
  fire(type: string, event: unknown) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}
class FakeCharacteristic extends FakeTarget {
  value: DataView | null = null;
  notifying = false;
  properties: { notify: boolean };
  initial: string;
  constructor(initial: string, properties = { notify: true }) {
    super();
    this.initial = initial;
    this.properties = properties;
  }
  async readValue() {
    return (this.value = view(this.initial));
  }
  async startNotifications() {
    this.notifying = true;
    return this;
  }
  emit(hex: string) {
    this.value = view(hex);
    this.fire("characteristicvaluechanged", { target: this });
  }
}
/** Dây đo giả: dịch vụ nhịp tim, tùy chọn vị trí cảm biến và pin. Tên thiết bị là tên bịa. */
function fakeStrap(o: { battery?: boolean; location?: boolean; heartRate?: boolean; connectError?: string } = {}) {
  const measurement = new FakeCharacteristic("00 00");
  const place = new FakeCharacteristic("01", { notify: false });
  const level = new FakeCharacteristic("5a");
  const device = new FakeTarget() as FakeTarget & { name: string; gatt: any };
  const named = (name: string) => Object.assign(new Error(name), { name });
  const calls = { connect: 0, disconnect: 0, request: [] as unknown[] };
  const server = {
    connected: false,
    async connect() {
      calls.connect++;
      if (o.connectError) throw named(o.connectError);
      server.connected = true;
      return server;
    },
    disconnect() {
      calls.disconnect++;
      server.connected = false;
    },
    async getPrimaryService(id: string) {
      if (id === "heart_rate" && o.heartRate !== false) {
        return {
          async getCharacteristic(c: string) {
            if (c === "heart_rate_measurement") return measurement;
            if (c === "body_sensor_location" && o.location !== false) return place;
            throw named("NotFoundError");
          },
        };
      }
      if (id === "battery_service" && o.battery !== false) return { getCharacteristic: async () => level };
      throw named("NotFoundError");
    },
  };
  device.name = "Dây đo mẫu";
  device.gatt = server;
  const bluetooth = {
    async requestDevice(options: unknown) {
      calls.request.push(options);
      return device;
    },
  };
  return { bluetooth, device, server, measurement, place, level, calls };
}

test("dò tính năng: cần ngữ cảnh an toàn và navigator.bluetooth.requestDevice", async () => {
  assert.deepEqual(bluetoothSupport({ isSecureContext: true, navigator: {} }), { ok: false, reason: "NO_API" });
  assert.deepEqual(bluetoothSupport({ isSecureContext: true, navigator: { bluetooth: {} } }), { ok: false, reason: "NO_API" });
  assert.deepEqual(bluetoothSupport({ isSecureContext: false, navigator: { bluetooth: { requestDevice() {} } } }), { ok: false, reason: "INSECURE_CONTEXT" });
  assert.deepEqual(bluetoothSupport({}), { ok: false, reason: "NO_API" });
  const bt = { requestDevice: async () => ({}) };
  assert.deepEqual(bluetoothSupport({ isSecureContext: true, navigator: { bluetooth: bt } }), { ok: true, bluetooth: bt });
  assert.equal(bluetoothSupport().ok, false, "Node không có Web Bluetooth");
  const noop = { requestDevice: async () => ({}) as never };
  assert.equal(await adapterAvailable(noop), null, "trình duyệt không cho biết");
  assert.equal(await adapterAvailable({ ...noop, getAvailability: async () => false }), false);
  assert.equal(await adapterAvailable({ ...noop, getAvailability: async () => true }), true);
  assert.equal(await adapterAvailable({ ...noop, getAvailability: async () => { throw new Error("x"); } }), null);
});

test("phiên đọc: chỉ xin dịch vụ nhịp tim và pin; số đo vào đường vẽ 60 giây; dừng là ngắt và xóa khỏi bộ nhớ", async () => {
  const strap = fakeStrap();
  let clock = 1_000_000;
  let changes = 0;
  const session = createHeartRateSession({ bluetooth: strap.bluetooth, now: () => clock, onChange: () => changes++ });
  assert.deepEqual(session.snapshot(), { phase: "idle", ended: null, deviceName: null, reading: null, battery: null, location: null, trace: [], packets: 0, malformed: 0, now: clock });
  await session.start();
  assert.deepEqual(strap.calls.request, [{ filters: [{ services: ["heart_rate"] }], optionalServices: ["battery_service"] }]);
  assert.deepEqual(strap.calls.request[0], REQUEST_OPTIONS);
  let s = session.snapshot();
  assert.equal(s.phase, "live");
  assert.equal(s.deviceName, "Dây đo mẫu");
  assert.equal(s.battery, 90);
  assert.equal(s.location, "chest");
  assert.equal(s.reading, null, "chưa có gói nào thì chưa có số đo");
  assert.ok(strap.measurement.notifying && strap.level.notifying);

  strap.measurement.emit("16 48 00 04");
  clock += 1000;
  strap.measurement.emit("06 50");
  s = session.snapshot();
  assert.deepEqual(s.reading, { bpm: 80, measured: true, contact: "detected", at: 1_001_000 });
  assert.deepEqual(s.trace, [{ t: 1_000_000, bpm: 72 }, { t: 1_001_000, bpm: 80 }]);
  assert.equal(s.packets, 2);

  // gói hỏng: đếm, giữ số đo trước
  strap.measurement.emit("10 50");
  s = session.snapshot();
  assert.equal(s.malformed, 1);
  assert.equal(s.reading?.bpm, 80);
  // chưa chạm da, hoặc thiết bị gửi 0: không phải số đo, không vào đường vẽ
  clock += 1000;
  strap.measurement.emit("04 00");
  s = session.snapshot();
  assert.deepEqual(s.reading, { bpm: 0, measured: false, contact: "not_detected", at: 1_002_000 });
  assert.equal(s.trace.length, 2);
  strap.measurement.emit("00 00");
  assert.equal(session.snapshot().reading?.measured, false);
  assert.equal(session.snapshot().trace.length, 2);
  // pin đổi
  strap.level.emit("59");
  assert.equal(session.snapshot().battery, 89);
  strap.level.emit("c8");
  assert.equal(session.snapshot().battery, 89, "mức pin ngoài 0–100 bị bỏ");

  // cửa sổ 60 giây: điểm cũ rơi khỏi đường vẽ kể cả khi không có gói mới
  clock = 1_000_000 + TRACE_WINDOW_MS + 500;
  assert.deepEqual(session.snapshot().trace, [{ t: 1_001_000, bpm: 80 }]);
  clock += 1000;
  assert.deepEqual(session.snapshot().trace, []);
  assert.ok(STALE_AFTER_MS < TRACE_WINDOW_MS);

  assert.ok(changes > 5);
  session.stop();
  s = session.snapshot();
  assert.deepEqual({ phase: s.phase, ended: s.ended, deviceName: s.deviceName, reading: s.reading, battery: s.battery, location: s.location, trace: s.trace, packets: s.packets }, { phase: "idle", ended: "STOPPED", deviceName: null, reading: null, battery: null, location: null, trace: [], packets: 0 });
  assert.equal(strap.calls.disconnect, 1);
  assert.equal(strap.measurement.count("characteristicvaluechanged") + strap.level.count("characteristicvaluechanged") + strap.device.count("gattserverdisconnected"), 0, "mọi bộ nghe đã gỡ");
  // gói tới sau khi dừng không làm gì
  strap.measurement.emit("06 50");
  assert.equal(session.snapshot().reading, null);
});

test("phiên đọc: thiết bị không có pin hay vị trí cảm biến vẫn đọc được nhịp tim", async () => {
  const strap = fakeStrap({ battery: false, location: false });
  const session = createHeartRateSession({ bluetooth: strap.bluetooth });
  await session.start();
  strap.measurement.emit("00 3c");
  const s = session.snapshot();
  assert.equal(s.phase, "live");
  assert.equal(s.battery, null);
  assert.equal(s.location, null);
  assert.equal(s.reading?.bpm, 60);
  session.stop();
});

test("phiên đọc: thiết bị tự ngắt thì phiên kết thúc và số đo bị xóa", async () => {
  const strap = fakeStrap();
  const session = createHeartRateSession({ bluetooth: strap.bluetooth });
  await session.start();
  strap.measurement.emit("00 3c");
  strap.server.connected = false;
  strap.device.fire("gattserverdisconnected", {});
  const s = session.snapshot();
  assert.deepEqual([s.phase, s.ended, s.reading, s.trace.length], ["idle", "DEVICE_DISCONNECTED", null, 0]);
  assert.equal(strap.calls.disconnect, 0, "đã ngắt rồi thì không gọi disconnect nữa");
  // chọn lại được: mỗi lần là một lượt chọn thiết bị mới
  await session.start();
  assert.equal(session.snapshot().phase, "live");
  assert.equal(strap.calls.request.length, 2);
  session.stop();
});

test("phiên đọc: lỗi của trình duyệt thành mã kết thúc, không ném ra ngoài", async () => {
  const named = (name: string) => Object.assign(new Error(name), { name });
  const end = async (bluetooth: { requestDevice(o: unknown): Promise<any> }) => {
    const session = createHeartRateSession({ bluetooth });
    await session.start();
    return [session.snapshot().phase, session.snapshot().ended];
  };
  assert.deepEqual(await end({ requestDevice: async () => { throw named("NotFoundError"); } }), ["idle", "CANCELLED"]);
  assert.deepEqual(await end({ requestDevice: async () => { throw named("SecurityError"); } }), ["idle", "BLOCKED"]);
  assert.deepEqual(await end({ requestDevice: async () => { throw named("NotAllowedError"); } }), ["idle", "BLOCKED"]);
  assert.deepEqual(await end({ requestDevice: async () => { throw new TypeError("x"); } }), ["idle", "FAILED"]);
  assert.deepEqual(await end(fakeStrap({ connectError: "NetworkError" }).bluetooth), ["idle", "CONNECT_FAILED"]);
  assert.deepEqual(await end(fakeStrap({ connectError: "SecurityError" }).bluetooth), ["idle", "BLOCKED"]);
  assert.deepEqual(await end(fakeStrap({ heartRate: false }).bluetooth), ["idle", "NO_HEART_RATE_SERVICE"]);
  assert.deepEqual(await end({ requestDevice: async () => ({ name: "x", gatt: null, addEventListener() {}, removeEventListener() {} }) }), ["idle", "CONNECT_FAILED"]);
});

test("phiên đọc: dừng trong lúc hộp chọn còn mở thì thiết bị chọn sau đó bị ngắt ngay, không đọc gì", async () => {
  const strap = fakeStrap();
  let release: (d: any) => void = () => {};
  const session = createHeartRateSession({ bluetooth: { requestDevice: () => new Promise<any>((resolve) => (release = resolve)) } });
  const started = session.start();
  assert.equal(session.snapshot().phase, "choosing");
  session.stop();
  assert.deepEqual([session.snapshot().phase, session.snapshot().ended], ["idle", "STOPPED"]);
  release(strap.device);
  await started;
  assert.equal(session.snapshot().phase, "idle");
  assert.equal(strap.calls.connect, 0);
  assert.equal(strap.measurement.count("characteristicvaluechanged"), 0);
});

test("hai tệp Bluetooth không gọi mạng, không lưu, và không có bộ đọc cho 0x183E", () => {
  for (const file of ["ble-gatt.js", "ble-live.js"]) {
    const code = readFileSync(new URL(`../web/shared/${file}`, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bhttps?:/, `${file}: không được gọi mạng`);
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${file}: không được lưu`);
    assert.doesNotMatch(code, /183e|2b3[b-f]|2b4[0-3]/i, `${file}: không có bộ đọc Physical Activity Monitor`);
  }
});
