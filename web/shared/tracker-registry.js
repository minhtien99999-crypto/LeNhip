// @ts-check
// Danh mục thiết bị theo dõi (LNH-T53): hệ sinh thái nào, đi được đường nào, điều kiện gì, bằng chứng tới đâu. Danh mục chỉ ở
// trên thiết bị; máy chủ không có API, bảng hay trường nào về thiết bị theo dõi và không nhận tên, mã hay nhãn của chúng.
// Tên hãng là văn bản, không logo. LeNhip không có thỏa thuận hay chứng nhận nào với các hãng trong danh mục.
//
// Bốn đường (LNH-F22, LNH-T54, LNH-T55, LNH-T56):
//   ble_standard  Bluetooth chuẩn qua Web Bluetooth: chỉ nhịp tim (0x180D) và pin (0x180F), khi trang đang mở
//   file_import   tệp xuất của chính người dùng, phân tích trên thiết bị (bộ đọc ở web/shared/health-import.js)
//   os_store      kho sức khỏe của hệ điều hành: chỉ app native đọc được (HealthKit, Health Connect); bản web không có
//   vendor_cloud  cloud của hãng: cần đăng ký, thỏa thuận, thẩm định hoặc trả phí; KHÔNG có mã nào trong repo gọi tới
//
// Mức bằng chứng của từng dòng (theo ghi chép nghiên cứu ngày 11/11/2026; mạng của phiên đó chặn trang của phần lớn các hãng):
//   P  tài liệu gốc đã đọc            T  nguồn bên thứ ba đã đọc, không phải lời của hãng
//   S  chỉ có tóm tắt tìm kiếm        M  ghi theo trí nhớ, chưa kiểm lại
// S và M là CHƯA XÁC MINH: dòng đó không bao giờ ở trạng thái «built», và giao diện ghi rõ «chưa xác minh».
// Chưa đường nào được thử với thiết bị thật hay tệp xuất thật (LNH-D16).

export const ROUTES = Object.freeze(/** @type {const} */ (["ble_standard", "file_import", "os_store", "vendor_cloud"]));

/** Mức bằng chứng → đã đối chiếu với một nguồn đọc được hay chưa. */
export const EVIDENCE = Object.freeze({
  P: Object.freeze({ verified: true }),
  T: Object.freeze({ verified: true }),
  S: Object.freeze({ verified: false }),
  M: Object.freeze({ verified: false }),
});

/**
 * Trạng thái của một đường, nói bằng lời ở khóa `dev.status.<mã>`:
 *   built            bản này có mã cho đường đó, và việc hãng đi được đường đó đã có nguồn đọc được
 *   reported         bản này có mã chung, nhưng việc thiết bị của hãng phát theo chuẩn mới chỉ là lời thuật lại
 *   not_supported    định dạng hoặc bố cục chưa kiểm chứng (hoặc không hợp bản web): không có bộ đọc
 *   native_app       cần app iOS hoặc Android, chưa có trong bản này
 *   needs_agreement  cần đăng ký hoặc thỏa thuận với hãng; không có mã gọi
 *   closed           chương trình đã đóng với bên mới hoặc API đã tắt
 *   out_of_scope     ngoài phạm vi bản này, cần thẩm định y tế trước (LNH-Q11)
 */
export const STATUSES = Object.freeze(/** @type {const} */ (["built", "reported", "not_supported", "native_app", "needs_agreement", "closed", "out_of_scope"]));

/** Trạng thái hợp lệ theo đường. */
export const ROUTE_STATUSES = Object.freeze({
  ble_standard: Object.freeze(["built", "reported", "not_supported", "out_of_scope"]),
  file_import: Object.freeze(["built", "not_supported"]),
  os_store: Object.freeze(["native_app"]),
  vendor_cloud: Object.freeze(["needs_agreement", "closed"]),
});

/** Dịch vụ GATT chuẩn: bí danh của Web Bluetooth (hoặc tên tự đặt cho 0x183E, vốn không có bí danh) → tên chuẩn và số được gán. */
export const SERVICES = Object.freeze({
  heart_rate: "Heart Rate (0x180D)",
  battery_service: "Battery (0x180F)",
  physical_activity_monitor: "Physical Activity Monitor (0x183E)",
  weight_scale: "Weight Scale (0x181D)",
  body_composition: "Body Composition (0x181B)",
  blood_pressure: "Blood Pressure (0x1810)",
  health_thermometer: "Health Thermometer (0x1809)",
  pulse_oximeter: "Pulse Oximeter (0x1822)",
});
/** Hai dịch vụ duy nhất bản này đọc (LNH-T54). */
export const BUILT_SERVICES = Object.freeze(["heart_rate", "battery_service"]);

/** Định dạng tệp xuất nhắc trong danh mục; nhãn ở `dev.format.<mã>`. Mã có bộ đọc trùng khóa của IMPORTERS. */
export const FORMATS = Object.freeze(["apple_health_xml", "samsung_steps_csv", "samsung_sleep_csv", "garmin_sleep_json", "garmin_steps_json", "fitbit_json", "google_fit_csv", "oura_export", "health_connect_zip"]);
/** Kho của hệ điều hành; nhãn ở `dev.store.<mã>`. */
export const STORES = Object.freeze(["healthkit", "health_connect", "samsung_health_sdk", "huawei_health_kit", "phone_store"]);
/** Điều kiện của cloud hãng; lời ở `dev.needs.<mã>`. */
export const NEEDS = Object.freeze(["agreement", "review", "paid", "org_only", "server_secret", "server_push"]);
/** Ghi chú ngắn; lời ở `dev.note.<mã>`. */
export const NOTES = Object.freeze(["broadcast_mode", "polar_sensors", "pams", "medical_scope", "apple_values", "samsung_day_time", "totals_only", "format_unverified", "legacy_format", "sqlite", "phone_sync", "workouts_only", "api_retired"]);

/**
 * @typedef {keyof typeof EVIDENCE} Evidence
 * @typedef {{ route: "ble_standard", status: "built" | "reported" | "not_supported" | "out_of_scope", evidence: Evidence, services: (keyof typeof SERVICES)[], note?: string }} BleRoute
 * @typedef {{ route: "file_import", status: "built" | "not_supported", evidence: Evidence, format: string, parser?: string, note?: string }} FileRoute
 * @typedef {{ route: "os_store", status: "native_app", evidence: Evidence, store: string, needs?: string[], note?: string }} StoreRoute
 * @typedef {{ route: "vendor_cloud", status: "needs_agreement" | "closed", evidence: Evidence, label: string, needs: string[], note?: string }} CloudRoute
 * @typedef {BleRoute | FileRoute | StoreRoute | CloudRoute} TrackerRoute
 * @typedef {{ id: string, name?: string, nameKey?: string, routes: readonly TrackerRoute[] }} Tracker
 *   `name` là tên riêng, giữ nguyên ở mọi ngôn ngữ; mục không thuộc một hãng dùng `nameKey` (khóa `dev.reg.<...>`).
 */

/** @type {Tracker[]} */
const LIST = [
  {
    id: "generic_heart_rate", nameKey: "dev.reg.genericHeartRate",
    routes: [{ route: "ble_standard", status: "built", evidence: "P", services: ["heart_rate", "battery_service"], note: "broadcast_mode" }],
  },
  {
    id: "generic_activity_monitor", nameKey: "dev.reg.genericActivityMonitor",
    routes: [{ route: "ble_standard", status: "not_supported", evidence: "S", services: ["physical_activity_monitor"], note: "pams" }],
  },
  {
    id: "ble_measurement_devices", nameKey: "dev.reg.measurementDevices",
    routes: [{ route: "ble_standard", status: "out_of_scope", evidence: "M", services: ["weight_scale", "body_composition", "blood_pressure", "health_thermometer", "pulse_oximeter"], note: "medical_scope" }],
  },
  {
    id: "apple_health", name: "Apple Health · Apple Watch",
    routes: [
      { route: "os_store", status: "native_app", evidence: "P", store: "healthkit" },
      { route: "file_import", status: "built", evidence: "T", format: "apple_health_xml", parser: "apple_health_xml", note: "apple_values" },
    ],
  },
  {
    id: "health_connect", name: "Health Connect · Wear OS",
    routes: [
      { route: "os_store", status: "native_app", evidence: "P", store: "health_connect" },
      { route: "file_import", status: "not_supported", evidence: "S", format: "health_connect_zip", note: "sqlite" },
    ],
  },
  {
    id: "samsung_health", name: "Samsung Health · Galaxy Watch",
    routes: [
      { route: "os_store", status: "native_app", evidence: "S", store: "samsung_health_sdk", needs: ["agreement"] },
      { route: "file_import", status: "built", evidence: "T", format: "samsung_steps_csv", parser: "samsung_steps_csv", note: "samsung_day_time" },
      { route: "file_import", status: "not_supported", evidence: "M", format: "samsung_sleep_csv", note: "format_unverified" },
    ],
  },
  {
    id: "garmin", name: "Garmin",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "S", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "file_import", status: "built", evidence: "T", format: "garmin_sleep_json", parser: "garmin_sleep_json", note: "totals_only" },
      { route: "file_import", status: "not_supported", evidence: "M", format: "garmin_steps_json", note: "format_unverified" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "T", label: "Garmin Connect Developer Program", needs: ["agreement", "org_only", "server_push"] },
    ],
  },
  {
    id: "fitbit_google", name: "Fitbit · Google (Pixel Watch)",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "M", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "file_import", status: "not_supported", evidence: "M", format: "fitbit_json", note: "format_unverified" },
      { route: "file_import", status: "not_supported", evidence: "T", format: "google_fit_csv", note: "legacy_format" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "T", label: "Google Health API", needs: ["review", "paid"] },
      { route: "vendor_cloud", status: "closed", evidence: "T", label: "Fitbit Web API", needs: [], note: "api_retired" },
      { route: "vendor_cloud", status: "closed", evidence: "P", label: "Google Fit API", needs: [], note: "api_retired" },
    ],
  },
  {
    id: "oura", name: "Oura",
    routes: [
      { route: "file_import", status: "not_supported", evidence: "S", format: "oura_export", note: "format_unverified" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "T", label: "Oura API v2", needs: ["agreement", "server_secret"] },
    ],
  },
  {
    id: "whoop", name: "WHOOP",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "S", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "T", label: "WHOOP Developer Platform", needs: ["agreement", "review", "server_secret"], note: "totals_only" },
    ],
  },
  {
    id: "polar", name: "Polar",
    routes: [
      { route: "ble_standard", status: "built", evidence: "P", services: ["heart_rate"], note: "polar_sensors" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "P", label: "Polar AccessLink", needs: ["agreement", "server_secret"] },
    ],
  },
  {
    id: "withings", name: "Withings",
    routes: [{ route: "vendor_cloud", status: "needs_agreement", evidence: "T", label: "Withings Public API", needs: ["agreement", "server_secret"] }],
  },
  {
    id: "xiaomi_zepp", name: "Xiaomi · Zepp · Amazfit",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "S", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "os_store", status: "native_app", evidence: "S", store: "phone_store", note: "phone_sync" },
    ],
  },
  {
    id: "huawei", name: "Huawei",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "M", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "os_store", status: "native_app", evidence: "S", store: "huawei_health_kit", needs: ["agreement", "review"] },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "S", label: "Huawei Health Kit REST", needs: ["agreement", "review"] },
    ],
  },
  {
    id: "suunto", name: "Suunto",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "S", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "T", label: "Suunto Cloud API", needs: ["agreement", "org_only"] },
    ],
  },
  {
    id: "coros", name: "Coros",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "S", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "S", label: "Coros Partner API", needs: ["agreement", "org_only"] },
    ],
  },
  {
    id: "wahoo", name: "Wahoo",
    routes: [
      { route: "ble_standard", status: "reported", evidence: "M", services: ["heart_rate"], note: "broadcast_mode" },
      { route: "vendor_cloud", status: "needs_agreement", evidence: "S", label: "Wahoo Cloud API", needs: ["agreement", "review"], note: "workouts_only" },
    ],
  },
];

/** @type {readonly Tracker[]} */
export const TRACKERS = Object.freeze(LIST.map((entry) => Object.freeze({ ...entry, routes: Object.freeze(entry.routes.map((r) => Object.freeze(r))) })));

/**
 * Danh mục xếp theo đường: mỗi mục là một (thiết bị, đường), giữ thứ tự của TRACKERS.
 * @returns {Record<(typeof ROUTES)[number], { tracker: Tracker, route: TrackerRoute }[]>}
 */
export function trackersByRoute() {
  /** @type {Record<string, { tracker: Tracker, route: TrackerRoute }[]>} */
  const out = { ble_standard: [], file_import: [], os_store: [], vendor_cloud: [] };
  for (const tracker of TRACKERS) for (const route of tracker.routes) out[route.route].push({ tracker, route });
  return out;
}
