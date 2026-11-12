// Danh mục thiết bị theo dõi (LNH-T53, LNH-T56): mã, đường, trạng thái, mức bằng chứng. Danh mục không được hứa nhiều hơn
// những gì bản này làm được: đường chưa xác minh phải nói rõ là chưa xác minh, và không dòng nào dẫn tới bộ đọc không tồn tại.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { BUILT_SERVICES, EVIDENCE, FORMATS, NEEDS, NOTES, ROUTES, ROUTE_STATUSES, SERVICES, STATUSES, STORES, TRACKERS, trackersByRoute } from "../web/shared/tracker-registry.js";
import { IMPORTERS } from "../web/shared/health-import.js";
import { REQUEST_OPTIONS } from "../web/shared/ble-live.js";
import vi from "../web/shared/i18n-vi-dev.js";
import en from "../web/shared/i18n-en-dev.js";

const catalogs: Record<string, Record<string, unknown>> = { vi, en };
const hasKey = (key: string) => Object.values(catalogs).every((c) => Object.hasOwn(c, key));
const routes = TRACKERS.flatMap((t) => t.routes.map((route) => ({ tracker: t, route })));
const web = new URL("../web/", import.meta.url);

test("mã của danh mục: duy nhất, đúng dạng, đủ các hệ sinh thái đã nghiên cứu", () => {
  const ids = TRACKERS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "mã trùng");
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]{1,40}$/);
  for (const expected of ["apple_health", "health_connect", "samsung_health", "garmin", "fitbit_google", "oura", "whoop", "polar", "withings", "xiaomi_zepp", "huawei", "suunto", "coros", "wahoo", "generic_heart_rate"]) {
    assert.ok(ids.includes(expected), `thiếu ${expected}`);
  }
  for (const t of TRACKERS) {
    // Tên là văn bản: tên riêng giữ nguyên, hoặc một khóa `dev.reg.*` có đủ tiếng Việt và tiếng Anh. Không có trường logo hay ảnh.
    assert.ok((typeof t.name === "string") !== (typeof t.nameKey === "string"), `${t.id}: cần đúng một trong name hoặc nameKey`);
    if (t.nameKey) assert.ok(/^dev\.reg\.[A-Za-z]+$/.test(t.nameKey) && hasKey(t.nameKey), `${t.id}: thiếu khóa ${t.nameKey}`);
    if (t.name) assert.ok(t.name.trim() === t.name && t.name.length > 0 && t.name.length <= 40, t.id);
    assert.deepEqual(Object.keys(t).filter((k) => !["id", "name", "nameKey", "routes"].includes(k)), [], `${t.id}: trường lạ`);
    assert.ok(t.routes.length > 0, `${t.id}: không có đường nào`);
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.routes) && t.routes.every((r) => Object.isFrozen(r)), `${t.id}: phải đóng băng`);
  }
});

test("mỗi đường: loại, trạng thái và mức bằng chứng hợp lệ; lời hiển thị có đủ hai ngôn ngữ", () => {
  assert.deepEqual([...ROUTES], ["ble_standard", "file_import", "os_store", "vendor_cloud"]);
  assert.deepEqual(Object.keys(EVIDENCE), ["P", "T", "S", "M"]);
  for (const route of ROUTES) assert.ok(hasKey(`dev.route.${route}`) && hasKey(`dev.routeHint.${route}`), route);
  for (const status of STATUSES) assert.ok(hasKey(`dev.status.${status}`), status);
  for (const grade of Object.keys(EVIDENCE)) assert.ok(hasKey(`dev.evidence.${grade}`), grade);
  for (const code of FORMATS) assert.ok(hasKey(`dev.format.${code}`), code);
  for (const code of STORES) assert.ok(hasKey(`dev.store.${code}`), code);
  for (const code of NEEDS) assert.ok(hasKey(`dev.needs.${code}`), code);
  for (const code of NOTES) assert.ok(hasKey(`dev.note.${code}`), code);
  const used = { formats: new Set<string>(), stores: new Set<string>(), needs: new Set<string>(), notes: new Set<string>() };
  for (const { tracker, route } of routes) {
    const where = `${tracker.id}/${route.route}`;
    assert.ok((ROUTES as readonly string[]).includes(route.route), where);
    assert.ok((ROUTE_STATUSES[route.route] as readonly string[]).includes(route.status), `${where}: trạng thái ${route.status}`);
    assert.ok(Object.hasOwn(EVIDENCE, route.evidence), `${where}: mức bằng chứng`);
    if (route.note !== undefined) {
      assert.ok(NOTES.includes(route.note), `${where}: ghi chú ${route.note}`);
      used.notes.add(route.note);
    }
    if (route.route === "ble_standard") {
      assert.ok(route.services.length > 0 && route.services.every((s) => Object.hasOwn(SERVICES, s)), where);
    } else if (route.route === "file_import") {
      assert.ok(FORMATS.includes(route.format), `${where}: định dạng ${route.format}`);
      used.formats.add(route.format);
    } else if (route.route === "os_store") {
      assert.ok(STORES.includes(route.store), `${where}: kho ${route.store}`);
      used.stores.add(route.store);
      for (const n of route.needs ?? []) used.needs.add(n);
      assert.ok((route.needs ?? []).every((n) => NEEDS.includes(n)), where);
    } else {
      assert.ok(route.label.length > 0 && route.label.length <= 40, where);
      assert.ok(route.needs.every((n) => NEEDS.includes(n)), where);
      for (const n of route.needs) used.needs.add(n);
      assert.equal(route.needs.length > 0, route.status === "needs_agreement", `${where}: đường cần thỏa thuận phải nêu điều kiện`);
    }
  }
  // Không có mã thừa: mọi định dạng, kho, điều kiện và ghi chú đã khai đều được một dòng dùng tới.
  assert.deepEqual([...used.formats].sort(), [...FORMATS].sort());
  assert.deepEqual([...used.stores].sort(), [...STORES].sort());
  assert.deepEqual([...used.needs].sort(), [...NEEDS].sort());
  assert.deepEqual([...used.notes].sort(), [...NOTES].sort());
  const grouped = trackersByRoute();
  assert.deepEqual(Object.keys(grouped), [...ROUTES]);
  assert.equal(Object.values(grouped).reduce((n, list) => n + list.length, 0), routes.length);
});

test("đường chưa xác minh không bao giờ được ghi là có sẵn, và lời hiển thị nói rõ «chưa xác minh»", () => {
  assert.deepEqual(Object.entries(EVIDENCE).map(([g, e]) => [g, e.verified]), [["P", true], ["T", true], ["S", false], ["M", false]]);
  for (const { tracker, route } of routes) {
    if (!EVIDENCE[route.evidence].verified) assert.notEqual(route.status, "built", `${tracker.id}/${route.route}: bằng chứng ${route.evidence} mà ghi là có sẵn`);
  }
  // Đường Bluetooth của một hãng chỉ dựa trên lời thuật lại thì ở trạng thái «reported», không phải «built».
  for (const { tracker, route } of routes) {
    if (route.route === "ble_standard" && (route.evidence === "S" || route.evidence === "M")) assert.ok(["reported", "not_supported", "out_of_scope"].includes(route.status), tracker.id);
  }
  assert.ok(routes.some(({ route }) => route.status === "reported"), "phải có ít nhất một dòng «reported» để phép kiểm này có nghĩa");
  for (const grade of ["S", "M"]) {
    assert.match(String(vi[`dev.evidence.${grade}` as keyof typeof vi]), /chưa xác minh/);
    assert.match(String(en[`dev.evidence.${grade}` as keyof typeof en]), /not verified/);
  }
  for (const grade of ["P", "T"]) {
    assert.doesNotMatch(String(vi[`dev.evidence.${grade}` as keyof typeof vi]), /chưa xác minh/);
    assert.doesNotMatch(String(en[`dev.evidence.${grade}` as keyof typeof en]), /not verified/);
  }
  assert.match(String(vi["dev.status.reported"]), /thuật lại/);
});

test("đường nhập tệp: dòng «built» dẫn tới một bộ đọc có thật, và mỗi bộ đọc có đúng một dòng", () => {
  const built = routes.filter(({ route }) => route.route === "file_import" && route.status === "built").map(({ route }) => route as Extract<typeof route, { route: "file_import" }>);
  for (const route of built) {
    assert.ok(typeof route.parser === "string" && Object.hasOwn(IMPORTERS, route.parser), `không có bộ đọc ${route.parser}`);
    assert.equal(route.parser, route.format);
    assert.ok(hasKey(`dev.kind.${route.parser}`) && hasKey(`dev.import.note.${route.parser}`), route.parser);
  }
  assert.deepEqual(built.map((r) => r.parser).sort(), Object.keys(IMPORTERS).sort(), "mỗi bộ đọc xuất hiện đúng một lần trong danh mục");
  for (const { tracker, route } of routes) {
    if (route.route === "file_import" && route.status !== "built") {
      assert.equal(route.parser, undefined, `${tracker.id}: định dạng chưa hỗ trợ không được có bộ đọc`);
      assert.ok(!Object.hasOwn(IMPORTERS, route.format), `${tracker.id}: ${route.format} có bộ đọc nhưng ghi là chưa hỗ trợ`);
    }
  }
  // Các định dạng nghiên cứu ghi là chưa kiểm chứng đều có mặt, ở trạng thái chưa hỗ trợ.
  const unsupported = routes.filter(({ route }) => route.route === "file_import" && route.status === "not_supported").map(({ route }) => (route as { format: string }).format);
  for (const format of ["fitbit_json", "samsung_sleep_csv", "oura_export", "health_connect_zip", "garmin_steps_json"]) assert.ok(unsupported.includes(format), format);
  // Garmin chỉ có tổng theo giai đoạn: dòng của nó nói rõ điều đó.
  const garmin = TRACKERS.find((t) => t.id === "garmin")!.routes.find((r) => r.route === "file_import" && r.status === "built")!;
  assert.equal(garmin.note, "totals_only");
});

test("Bluetooth: chỉ nhịp tim và pin là có sẵn; 0x183E không có bộ đọc; số đo y tế ngoài phạm vi", () => {
  assert.deepEqual([...BUILT_SERVICES], ["heart_rate", "battery_service"]);
  assert.deepEqual([REQUEST_OPTIONS.filters[0].services, REQUEST_OPTIONS.optionalServices].flat().sort(), [...BUILT_SERVICES].sort(), "hộp chọn chỉ xin đúng hai dịch vụ của danh mục");
  for (const { tracker, route } of routes) {
    if (route.route !== "ble_standard") continue;
    if (route.status === "built" || route.status === "reported") assert.ok(route.services.every((s) => BUILT_SERVICES.includes(s)), `${tracker.id}: dịch vụ ngoài nhịp tim và pin`);
  }
  const pams = routes.filter(({ route }) => route.route === "ble_standard" && route.services.includes("physical_activity_monitor"));
  assert.deepEqual(pams.map(({ route }) => route.status), ["not_supported"]);
  assert.match(SERVICES.physical_activity_monitor, /0x183E/);
  const medical = routes.filter(({ route }) => route.route === "ble_standard" && route.services.some((s) => ["weight_scale", "blood_pressure", "health_thermometer", "pulse_oximeter", "body_composition"].includes(s)));
  assert.ok(medical.length > 0 && medical.every(({ route }) => route.status === "out_of_scope"));
});

test("kho của hệ điều hành và cloud của hãng không có mã nào trong bản web", () => {
  for (const { tracker, route } of routes) {
    if (route.route === "os_store") assert.equal(route.status, "native_app", tracker.id);
    if (route.route === "vendor_cloud") assert.ok(["needs_agreement", "closed"].includes(route.status), tracker.id);
  }
  const stores = routes.filter(({ route }) => route.route === "os_store").map(({ route }) => (route as { store: string }).store);
  assert.ok(stores.includes("healthkit") && stores.includes("health_connect"));
  // Mã của nhánh không gọi mạng và không chứa địa chỉ nào: danh mục chỉ là dữ liệu, không có client của hãng.
  const files = ["shared/tracker-registry.js", "shared/ble-gatt.js", "shared/ble-live.js", "shared/health-import.js", "views/connect-trackers.js"];
  for (const file of files) {
    const code = readFileSync(new URL(file, web), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bimport\s*\(/, `${file}: không được gọi mạng`);
    assert.doesNotMatch(code, /\bhttps?:|\/\/[a-z0-9-]+\.[a-z]{2,}/i, `${file}: không được chứa địa chỉ`);
    assert.doesNotMatch(code, /ctx\.api|\bapi\.(get|post)\b/, `${file}: không được gọi API của LeNhip`);
  }
});

test("máy chủ không biết gì về thiết bị theo dõi: không route, không schema, không bảng (LNH-T53)", () => {
  const openapi = readFileSync(new URL("../contracts/openapi.json", import.meta.url), "utf8");
  const fragments = (() => {
    try {
      return readdirSync(new URL("../contracts/openapi/", import.meta.url)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
  })();
  assert.ok(!fragments.includes("trackers.json"), "không có mảnh OpenAPI cho thiết bị theo dõi");
  const paths = Object.keys(JSON.parse(openapi).paths);
  for (const path of paths) assert.doesNotMatch(path, /tracker|wearable|bluetooth|heart|health-import/i, path);
  // Cờ `trackers` là thứ duy nhất của nhánh này mà máy chủ có.
  assert.match(openapi, /"trackers"/);
  const server = new URL("../src/server/", import.meta.url);
  for (const file of readdirSync(server).filter((f) => f.endsWith(".ts"))) {
    const code = readFileSync(new URL(file, server), "utf8");
    assert.doesNotMatch(code, /tracker-registry|ble-gatt|ble-live|health-import/, `${file}: máy chủ không nạp mã của nhánh thiết bị theo dõi`);
    for (const t of TRACKERS) if (t.name) assert.ok(!code.includes(t.name), `${file}: có tên ${t.name}`);
  }
});
