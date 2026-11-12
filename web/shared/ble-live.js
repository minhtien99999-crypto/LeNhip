// @ts-check
// Phiên đọc nhịp tim trực tiếp qua Web Bluetooth (LNH-T54). Chỉ Chromium có API này (Chrome, Edge, Samsung Internet); Safari,
// Firefox và mọi trình duyệt trên iOS không có (LNH-F22).
// - Chỉ dịch vụ chuẩn Heart Rate 0x180D, kèm Battery 0x180F nếu thiết bị có. Không dịch vụ riêng của hãng nào.
// - requestDevice() phải được gọi ngay trong thao tác bấm của người dùng; trình duyệt tự vẽ hộp chọn, trang không thấy danh sách
//   thiết bị ở gần. Mỗi lần mở trang phải chọn lại thiết bị: không kết nối lại ngầm, không đồng bộ nền.
// - Số đo chỉ nằm trong bộ nhớ của phiên này, giữ 60 giây gần nhất cho đường vẽ trên màn hình. Không gì được lưu hay gửi đi:
//   tệp này không gọi mạng, không đụng localStorage hay IndexedDB. Dừng phiên là xóa số đo khỏi bộ nhớ.
// - Tên thiết bị do trình duyệt trả có thể chứa tên người: chỉ để hiện trên màn hình, không đưa vào API hay log.
// - Không phải thiết bị y tế, không dùng để chẩn đoán.
import { parseBatteryLevel, parseBodySensorLocation, parseHeartRateMeasurement } from "./ble-gatt.js";

/** Cửa sổ của đường vẽ trên màn hình: 60 giây gần nhất. */
export const TRACE_WINDOW_MS = 60_000;
/** Quá ngần này mili giây không có gói mới thì giao diện ghi «đang chờ số đo». */
export const STALE_AFTER_MS = 5_000;
const MAX_NAME = 80;

/**
 * Kiểu tối thiểu của Web Bluetooth mà tệp này dùng (lib DOM của TypeScript chưa có).
 * @typedef {{ value?: DataView | null, properties?: { notify?: boolean, read?: boolean },
 *   readValue(): Promise<DataView>, startNotifications(): Promise<unknown>,
 *   addEventListener(type: string, fn: (e: any) => void): void, removeEventListener(type: string, fn: (e: any) => void): void }} BleCharacteristic
 * @typedef {{ getCharacteristic(id: string | number): Promise<BleCharacteristic> }} BleService
 * @typedef {{ connected?: boolean, connect(): Promise<BleServer>, disconnect(): void,
 *   getPrimaryService(id: string | number): Promise<BleService> }} BleServer
 * @typedef {{ name?: string | null, gatt?: BleServer | null,
 *   addEventListener(type: string, fn: (e: any) => void): void, removeEventListener(type: string, fn: (e: any) => void): void }} BleDevice
 * @typedef {{ requestDevice(options: unknown): Promise<BleDevice>, getAvailability?: () => Promise<boolean> }} BluetoothLike
 *
 * @typedef {"idle" | "choosing" | "connecting" | "live"} Phase
 * @typedef {"STOPPED" | "CANCELLED" | "BLOCKED" | "NO_HEART_RATE_SERVICE" | "CONNECT_FAILED" | "DEVICE_DISCONNECTED" | "FAILED"} EndCode
 * @typedef {{ bpm: number, measured: boolean, contact: "detected" | "not_detected" | "not_supported", at: number }} Reading
 *   `measured` sai khi cảm biến báo chưa chạm da hoặc gửi 0: khi đó bpm không phải số đo và không vào đường vẽ.
 * @typedef {{ phase: Phase, ended: EndCode | null, deviceName: string | null, reading: Reading | null, battery: number | null,
 *   location: string | null, trace: { t: number, bpm: number }[], packets: number, malformed: number, now: number }} Snapshot
 */

/** Yêu cầu gửi cho hộp chọn của trình duyệt: lọc theo dịch vụ nhịp tim chuẩn, xin thêm quyền đọc dịch vụ pin nếu có. */
export const REQUEST_OPTIONS = Object.freeze({ filters: [{ services: ["heart_rate"] }], optionalServices: ["battery_service"] });

/**
 * Trình duyệt này có dùng được Web Bluetooth không. Không gọi API nào, chỉ dò tính năng.
 * @param {any} [env] mặc định globalThis
 * @returns {{ ok: true, bluetooth: BluetoothLike } | { ok: false, reason: "INSECURE_CONTEXT" | "NO_API" }}
 */
export function bluetoothSupport(env = globalThis) {
  if (env?.isSecureContext === false) return { ok: false, reason: "INSECURE_CONTEXT" };
  const bluetooth = env?.navigator?.bluetooth;
  if (!bluetooth || typeof bluetooth.requestDevice !== "function") return { ok: false, reason: "NO_API" };
  return { ok: true, bluetooth };
}

/**
 * Máy có bộ thu phát Bluetooth đang bật không: true, false, hoặc null khi trình duyệt không cho biết.
 * @param {BluetoothLike} bluetooth
 * @returns {Promise<boolean | null>}
 */
export async function adapterAvailable(bluetooth) {
  if (typeof bluetooth.getAvailability !== "function") return null;
  try {
    return (await bluetooth.getAvailability()) === true;
  } catch {
    return null;
  }
}

/**
 * Lỗi của trình duyệt → mã kết thúc. NotFoundError ở bước chọn nghĩa là người dùng đóng hộp chọn hoặc không thiết bị nào khớp.
 * @param {unknown} e
 * @param {"choose" | "connect"} stage
 * @returns {EndCode}
 */
function endCodeOf(e, stage) {
  const name = /** @type {{ name?: unknown }} */ (e)?.name;
  if (name === "SecurityError" || name === "NotAllowedError") return "BLOCKED";
  if (stage === "choose") return name === "NotFoundError" ? "CANCELLED" : "FAILED";
  if (name === "NotFoundError") return "NO_HEART_RATE_SERVICE";
  if (name === "NetworkError" || name === "NotSupportedError" || name === "InvalidStateError" || name === "AbortError") return "CONNECT_FAILED";
  return "FAILED";
}

/**
 * Một phiên đọc nhịp tim. `start()` gọi từ thao tác bấm; `stop()` ngắt kết nối và xóa số đo khỏi bộ nhớ.
 * @param {{ bluetooth: BluetoothLike, now?: () => number, onChange?: () => void }} options
 */
export function createHeartRateSession({ bluetooth, now = () => Date.now(), onChange = () => {} }) {
  /** @type {Phase} */
  let phase = "idle";
  /** @type {EndCode | null} */
  let ended = null;
  /** @type {string | null} */
  let deviceName = null;
  /** @type {Reading | null} */
  let reading = null;
  /** @type {number | null} */
  let battery = null;
  /** @type {string | null} */
  let location = null;
  /** @type {{ t: number, bpm: number }[]} */
  let trace = [];
  let packets = 0;
  let malformed = 0;
  let generation = 0;
  /** @type {BleDevice | null} */
  let device = null;
  /** @type {(() => void)[]} */
  let detach = [];

  const emit = () => {
    try {
      onChange();
    } catch (e) {
      console.error(e);
    }
  };
  const prune = () => {
    const from = now() - TRACE_WINDOW_MS;
    if (trace.length && trace[0].t < from) trace = trace.filter((p) => p.t >= from);
  };
  const forget = () => {
    reading = null;
    battery = null;
    location = null;
    trace = [];
    packets = 0;
    malformed = 0;
    deviceName = null;
  };
  /** Gỡ mọi bộ nghe, ngắt kết nối, xóa số đo khỏi bộ nhớ. @param {EndCode} code */
  const finish = (code) => {
    generation++;
    for (const off of detach.splice(0)) off();
    const gatt = device?.gatt;
    device = null;
    try {
      if (gatt && gatt.connected !== false) gatt.disconnect();
    } catch {
      /* đã ngắt */
    }
    forget();
    phase = "idle";
    ended = code;
    emit();
  };
  /** @param {BleCharacteristic | BleDevice} target @param {string} type @param {(e: any) => void} fn */
  const listen = (target, type, fn) => {
    target.addEventListener(type, fn);
    detach.push(() => target.removeEventListener(type, fn));
  };

  /** @param {any} event */
  const onHeartRate = (event) => {
    const parsed = parseHeartRateMeasurement(event?.target?.value);
    if (!parsed.ok) {
      malformed++; // gói hỏng: bỏ qua, giữ số đo trước đó
      return emit();
    }
    packets++;
    const at = now();
    const measured = parsed.contact !== "not_detected" && parsed.bpm > 0;
    reading = { bpm: parsed.bpm, measured, contact: parsed.contact, at };
    if (measured) trace.push({ t: at, bpm: parsed.bpm });
    prune();
    emit();
  };
  /** @param {any} event */
  const onBattery = (event) => {
    const parsed = parseBatteryLevel(event?.target?.value);
    if (parsed.ok) {
      battery = parsed.percent;
      emit();
    }
  };

  return {
    /** Mở hộp chọn của trình duyệt rồi kết nối. Phải được gọi đồng bộ trong trình xử lý thao tác bấm. */
    async start() {
      if (phase !== "idle") return;
      const run = ++generation;
      forget();
      ended = null;
      phase = "choosing";
      emit();
      /** @type {BleDevice} */
      let chosen;
      try {
        chosen = await bluetooth.requestDevice(REQUEST_OPTIONS);
      } catch (e) {
        if (run === generation) finish(endCodeOf(e, "choose"));
        return;
      }
      if (run !== generation) {
        try {
          chosen.gatt?.disconnect();
        } catch {
          /* chưa kết nối */
        }
        return;
      }
      device = chosen;
      deviceName = typeof chosen.name === "string" && chosen.name ? chosen.name.slice(0, MAX_NAME) : null;
      phase = "connecting";
      emit();
      listen(chosen, "gattserverdisconnected", () => {
        if (run === generation) finish("DEVICE_DISCONNECTED");
      });
      try {
        if (!chosen.gatt) throw Object.assign(new Error("no gatt"), { name: "NotSupportedError" });
        const server = await chosen.gatt.connect();
        if (run !== generation) return;
        const service = await server.getPrimaryService("heart_rate");
        if (run !== generation) return;
        const measurement = await service.getCharacteristic("heart_rate_measurement");
        if (run !== generation) return;
        listen(measurement, "characteristicvaluechanged", onHeartRate);
        await measurement.startNotifications();
        if (run !== generation) return;
        phase = "live";
        emit();
        // Hai phần tùy chọn; thiết bị không có thì bỏ qua, không làm hỏng phiên.
        try {
          const place = parseBodySensorLocation(await (await service.getCharacteristic("body_sensor_location")).readValue());
          if (run === generation && place.ok) {
            location = place.location;
            emit();
          }
        } catch {
          /* không có vị trí cảm biến */
        }
        if (run !== generation) return;
        try {
          const level = await (await server.getPrimaryService("battery_service")).getCharacteristic("battery_level");
          const first = parseBatteryLevel(await level.readValue());
          if (run !== generation) return;
          if (first.ok) battery = first.percent;
          emit();
          if (level.properties?.notify) {
            listen(level, "characteristicvaluechanged", onBattery);
            await level.startNotifications();
          }
        } catch {
          /* không có dịch vụ pin */
        }
      } catch (e) {
        if (run === generation) finish(endCodeOf(e, "connect"));
      }
    },

    /** Người dùng dừng, rời màn hình, hoặc phần bị ẩn: ngắt kết nối và xóa số đo khỏi bộ nhớ. */
    stop() {
      if (phase === "idle") return;
      finish("STOPPED");
    },

    /** Ảnh chụp để vẽ; đường vẽ đã bỏ các điểm cũ hơn 60 giây. @returns {Snapshot} */
    snapshot() {
      prune();
      return { phase, ended, deviceName, reading: reading && { ...reading }, battery, location, trace: trace.map((p) => ({ ...p })), packets, malformed, now: now() };
    },
  };
}
