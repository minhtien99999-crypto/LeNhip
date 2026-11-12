// Kiểm phần «Thiết bị theo dõi» của màn hình Kết nối trên trình duyệt thật (LNH-T52..LNH-T56):
//   - đọc nhịp tim trực tiếp qua Web Bluetooth với một THIẾT BỊ GIẢ cấy vào trang (navigator.bluetooth giả phát thông báo
//     Heart Rate Measurement); không có thiết bị Bluetooth thật nào trong phép kiểm này;
//   - nhập một export.xml TỔNG HỢP qua ô chọn tệp và xem ở Sức khỏe. Dữ liệu đã nhập chỉ ở bộ nhớ của trang (SRS mục 11):
//     localStorage, sessionStorage, IndexedDB, Cache API và cookie không đổi và không chứa số đo, tên nguồn hay tên tệp; xóa,
//     tải lại trang, tắt cờ, đổi tài khoản và rút đồng ý Sức khỏe đều kết thúc dữ liệu đã nhập;
//   - chặn và ghi mọi yêu cầu mạng: trong lúc đọc trực tiếp và nhập tệp không yêu cầu nào mang số đo, tên nguồn, tên thiết bị
//     hay tên tệp;
//   - trình duyệt không có Web Bluetooth; chỉ dùng bàn phím; ba cỡ màn hình, năm phong cách và chữ 200 % theo một tập đại
//     diện (MATRIX), không phải mọi tổ hợp.
//   node scripts/e2e-trackers.mjs [thư-mục-ảnh]        (cả bộ: npm run e2e)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, THEMES } from "./e2e-lib.mjs";

// Tên bịa, có mã riêng để dò trong các yêu cầu mạng.
const DEVICE = "Dây đo mẫu E2E-7731";
const SOURCE = "Đồng hồ mẫu E2E-4409";
const OTHER = "Điện thoại mẫu E2E-5512";
const STEPS_A = 6007;
const STEPS_B = 7572; // mỗi ngày 13 579 bước
const OTHER_STEPS = 4321;
const FILE_NAME = "xuat-mau-E2E-8823.xml"; // loại tệp được nhận từ nội dung, không từ tên
const SECRETS = ["E2E-7731", "E2E-4409", "E2E-5512", "E2E-8823", "xuat-mau", "13579", "13.579", String(STEPS_A), String(STEPS_B), String(OTHER_STEPS), "27000", "Dây đo mẫu", "Đồng hồ mẫu", "Điện thoại mẫu"];
const MEMORY_ONLY = ["chỉ nằm trong bộ nhớ của trang đang mở", "tải lại hoặc đóng trang là mất", "không lưu xuống đĩa của thiết bị này", "không gửi về máy chủ", "không đồng bộ sang thiết bị khác của bạn", "hãy nhập lại tệp"];
const NONE = "Chưa có dữ liệu nào được nhập trong lượt mở trang này";
// Tập đại diện, không phải mọi tổ hợp: cả năm phong cách ở cỡ máy tính; ba cỡ màn hình ở phong cách orbit; chữ 200 % ở điện
// thoại và máy tính. Màu của phong cách không đổi theo cỡ màn hình, bố cục không đổi theo phong cách.
const MATRIX = [
  ["điện thoại", { width: 390, height: 844 }, [["orbit", 100], ["night", 200]]],
  ["máy tính bảng", { width: 820, height: 1180 }, [["orbit", 100]]],
  ["máy tính", { width: 1440, height: 900 }, [...THEMES.map((theme) => [theme, 100]), ["titanium", 200]]],
];
const SECTION = ".connect-section[data-section=trackers]";
const BLE = `${SECTION} [data-tracker-body=ble]`;
const IMPORT = `${SECTION} [data-tracker-body=import]`;

/** Ngày theo lịch của giờ Việt Nam, lệch `offset` ngày so với hôm nay. */
const vnDay = (offset) => new Date(Date.now() + 7 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
const record = (type, source, start, end, value) =>
  ` <Record type="${type === "steps" ? "HKQuantityTypeIdentifierStepCount" : "HKCategoryTypeIdentifierSleepAnalysis"}" sourceName="${source}" startDate="${start} +0700" endDate="${end} +0700" value="${value}"/>\n`;
/** export.xml tổng hợp: năm ngày đã kết thúc gần nhất, mỗi đêm ngủ 23:00–06:30 (7 giờ 30 phút) và 13 579 bước; nguồn thứ hai khác số. */
function syntheticExport() {
  let body = "";
  for (let i = 1; i <= 5; i++) {
    body += record("sleep", SOURCE, `${vnDay(-i - 1)} 23:00:00`, `${vnDay(-i)} 06:30:00`, "HKCategoryValueSleepAnalysisAsleepCore");
    body += record("steps", SOURCE, `${vnDay(-i)} 09:00:00`, `${vnDay(-i)} 09:10:00`, STEPS_A);
    body += record("steps", SOURCE, `${vnDay(-i)} 18:00:00`, `${vnDay(-i)} 18:10:00`, STEPS_B);
  }
  // Nguồn thứ hai ngủ dậy muộn hơn nên là nguồn được gợi ý sẵn; phép kiểm phải tự chọn nguồn kia.
  body += record("sleep", OTHER, `${vnDay(-2)} 22:00:00`, `${vnDay(-1)} 08:00:00`, "HKCategoryValueSleepAnalysisAsleep");
  body += record("steps", OTHER, `${vnDay(-1)} 10:00:00`, `${vnDay(-1)} 10:30:00`, OTHER_STEPS);
  body += record("steps", SOURCE, "2019-08-04 09:00:00", "2019-08-04 09:10:00", 999);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- DỮ LIỆU TỔNG HỢP của phép kiểm trình duyệt LeNhip -->\n<HealthData locale="vi_VN">\n${body}</HealthData>\n`;
}

/** Cấy vào trang trước khi ứng dụng chạy: một navigator.bluetooth giả với một dây đo nhịp tim giả. Không phải Web Bluetooth thật. */
function installBluetoothStub(deviceName) {
  const calls = { request: [], connect: 0, disconnect: 0, notifying: [] };
  class Target {
    constructor() {
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    fire(type, event) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    }
  }
  const view = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
  const named = (name) => Object.assign(new Error(name), { name });
  const characteristic = (id, initial, notify) => {
    const c = new Target();
    c.properties = { notify, read: true };
    c.value = null;
    c.readValue = async () => (c.value = view(initial));
    c.startNotifications = async () => {
      calls.notifying.push(id);
      return c;
    };
    c.emit = (bytes) => {
      c.value = view(bytes);
      c.fire("characteristicvaluechanged", { target: c });
    };
    return c;
  };
  const measurement = characteristic("heart_rate_measurement", [0, 0], true);
  const place = characteristic("body_sensor_location", [2], false);
  const level = characteristic("battery_level", [90], true);
  const device = new Target();
  device.name = deviceName;
  const server = {
    connected: false,
    async connect() {
      calls.connect++;
      server.connected = true;
      return server;
    },
    disconnect() {
      calls.disconnect++;
      if (!server.connected) return;
      server.connected = false;
      device.fire("gattserverdisconnected", { target: device });
    },
    async getPrimaryService(id) {
      if (id === "heart_rate") {
        return {
          async getCharacteristic(c) {
            if (c === "heart_rate_measurement") return measurement;
            if (c === "body_sensor_location") return place;
            throw named("NotFoundError");
          },
        };
      }
      if (id === "battery_service") return { getCharacteristic: async () => level };
      throw named("NotFoundError");
    },
  };
  device.gatt = server;
  const state = {
    calls,
    cancelNext: false,
    emit: (bytes) => measurement.emit(bytes),
    battery: (percent) => level.emit([percent]),
    drop() {
      server.connected = false;
      device.fire("gattserverdisconnected", { target: device });
    },
  };
  const bluetooth = {
    async getAvailability() {
      return true;
    },
    async requestDevice(options) {
      calls.request.push(JSON.parse(JSON.stringify(options)));
      if (state.cancelNext) {
        state.cancelNext = false;
        throw named("NotFoundError");
      }
      return device;
    },
  };
  Object.defineProperty(Navigator.prototype, "bluetooth", { configurable: true, get: () => bluetooth });
  window.__ble = state;
}

/** Chạy trong trang: các lỗi bố cục của phần (tràn ngang, vùng bấm dưới 44 px, chữ tràn khung, tương phản dưới 4,5). Rỗng là đạt. */
function layoutProblems(sel) {
  const out = [];
  const section = document.querySelector(sel);
  const page = document.documentElement;
  if (page.scrollWidth > page.clientWidth) out.push("trang tràn ngang " + (page.scrollWidth - page.clientWidth) + " px");
  const box = section.getBoundingClientRect();
  for (const el of section.querySelectorAll("button, summary, input[type=file], label.tracker-source")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const what = el.dataset.tracker ?? el.dataset.nav ?? el.id ?? el.tagName;
    if (r.height < 44 || r.width < 44) out.push(`${what} nhỏ ${Math.round(r.width)}×${Math.round(r.height)}`);
    if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${what} vượt khung của phần`);
  }
  for (const el of section.querySelectorAll(".tracker-card, .tracker-group, .tracker-row, .tracker-facts, .tracker-live")) {
    if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className} tràn chữ ${el.scrollWidth - el.clientWidth} px`);
  }
  // Chữ đọc được trên nền thật của từng phong cách: MỌI phần tử đang hiện có chữ của riêng nó, màu chữ so với nền đặc gần nhất
  // phía sau, tương phản tối thiểu 4,5 (mức cho chữ nhỏ).
  const rgba = (css) => {
    const v = css.match(/[\d.]+/g).map(Number);
    return [v[0], v[1], v[2], v[3] ?? 1];
  };
  const over = ([r, g, b, a], under) => [r, g, b].map((v, i) => v * a + under[i] * (1 - a));
  const backdrop = (el) => {
    if (!el) return [255, 255, 255];
    const own = rgba(getComputedStyle(el).backgroundColor);
    return own[3] >= 1 ? own.slice(0, 3) : over(own, backdrop(el.parentElement));
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const weak = new Map();
  let measured = 0;
  for (const el of section.querySelectorAll("*")) {
    if (el.closest("svg") || el.getClientRects().length === 0) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const behind = backdrop(el);
    const [hi, lo] = [lum(over(rgba(getComputedStyle(el).color), behind)), lum(behind)].sort((x, y) => y - x);
    const c = (hi + 0.05) / (lo + 0.05);
    measured++;
    if (c < 4.5) weak.set(el.tagName.toLowerCase() + (el.className ? "." + String(el.className).trim().replace(/\s+/g, ".") : ""), c);
  }
  for (const [what, c] of weak) out.push(`${what} tương phản ${c.toFixed(2)}`);
  if (measured < 40) out.push(`chỉ đo được ${measured} phần tử có chữ`);
  const trace = section.querySelector("svg.tracker-trace").getBoundingClientRect();
  if (trace.width < 100 || trace.height < 24) out.push("đường nhịp tim quá nhỏ");
  return out;
}

await run("thiết bị theo dõi", async (t) => {
  const { ok, shot } = t;
  const tmp = mkdtempSync(join(tmpdir(), "lenhip-e2e-trackers-"));
  const file = (name, content) => {
    const path = join(tmp, name);
    writeFileSync(path, content);
    return path;
  };
  const exportXml = file(FILE_NAME, syntheticExport());

  /** Mở ứng dụng với thiết bị giả (hoặc không có Web Bluetooth) và ghi lại mọi yêu cầu mạng của ngữ cảnh. */
  const openApp = async ({ viewport, bluetooth = true } = {}) => {
    const opened = await t.open({ ...(viewport ? { viewport } : {}), modules: { trackers: true }, path: "/healthz", wait: false, reducedMotion: "reduce" });
    const requests = [];
    opened.context.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: r.postData() ?? "" }));
    if (bluetooth) await opened.context.addInitScript(installBluetoothStub, DEVICE);
    else await opened.context.addInitScript(() => delete Navigator.prototype.bluetooth);
    await opened.page.goto(t.base + "/");
    await t.ready(opened.page);
    return { ...opened, requests };
  };
  const go = async (page, id) => {
    await page.evaluate((v) => (location.hash = "#" + v), id);
    await page.waitForSelector(`body[data-view=${id}]`, { state: "attached" });
  };
  const text = (page, selector) => page.$eval(selector, (el) => el.textContent ?? "");
  const statusOf = (page, card) => text(page, `${SECTION} [data-tracker-status-for=${card}]`);
  const ble = (page, fn, arg) => page.evaluate(([f, a]) => new Function("ble", "a", `return (${f})(ble, a)`)(window.__ble, a), [fn.toString(), arg]);
  /** Yêu cầu nào mang một mã bí mật trong địa chỉ hoặc thân (cả dạng mã hóa URL và dạng \u của JSON). */
  const leaks = (requests) => requests.filter((r) => {
    let url = r.url;
    try {
      url = decodeURIComponent(r.url);
    } catch {
      /* giữ nguyên */
    }
    let body = r.body;
    try {
      body = r.body + " " + JSON.stringify(JSON.parse(r.body)) + " " + decodeURIComponent(r.body);
    } catch {
      /* thân không phải JSON */
    }
    return SECRETS.some((s) => url.includes(s) || body.includes(s));
  });
  /** Mọi thứ trang để lại trong kho của trình duyệt: khóa và giá trị của localStorage, sessionStorage; tên cơ sở dữ liệu IndexedDB; tên bộ đệm Cache API; cookie. */
  const persisted = (page) => page.evaluate(async () => {
    const dump = (store) => Object.keys(store).sort().map((k) => k + "=" + store.getItem(k));
    return { local: dump(localStorage), session: dump(sessionStorage), idb: (await indexedDB.databases()).map((d) => String(d.name)).sort(), caches: "caches" in window ? (await caches.keys()).sort() : [], cookie: document.cookie };
  });
  /** Những gì KHÔNG được có trong kho: số đo, tên nguồn, tên thiết bị, tên tệp, và mọi khóa hay cơ sở dữ liệu của phần này. Rỗng là đạt. */
  const residue = (p) => {
    const all = [...p.local, ...p.session, ...p.idb, ...p.caches, p.cookie].join("\n");
    const names = [...p.local, ...p.session].map((entry) => entry.split("=")[0]).concat(p.idb, p.caches);
    return [...SECRETS.filter((secret) => all.includes(secret)), ...names.filter((name) => /tracker|import/i.test(name))];
  };
  /** Mở Thông báo đầu tiên từ hộp Cá nhân hóa, đổi hoặc giữ nguyên mục Sức khỏe rồi lưu: ứng dụng nạp lại /v1/me và vẽ lại, KHÔNG tải lại trang. */
  const saveNotice = async (page, health = null) => {
    await page.click("#settings-button");
    await page.click("#privacy-settings button[data-action=onboarding]");
    await page.waitForSelector("#consent-form");
    if (health !== null) await page.setChecked("#consent-form input[name=health_local]", health);
    const me = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/me" && r.ok());
    await page.click("#consent-form button");
    await me;
    await page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
    if (await page.$("#settings-dialog[open]")) await page.click("#settings-dialog [data-action=close-settings]");
  };
  const healthText = async (page) => {
    await go(page, "health");
    return text(page, "main");
  };
  /** Mở Sức khỏe và chờ tới khi màn hình dùng dữ liệu tổng hợp của bản tham chiếu, không còn gì của tệp đã nhập; quá 5 giây là hỏng. */
  const backToSynthetic = async (page) => {
    await go(page, "health");
    return page.waitForFunction(() => {
      const main = document.getElementById("main").textContent;
      return main.includes("Dữ liệu tổng hợp") && main.includes("Nguồn web-tong-hop") && !main.includes("tệp bạn nhập") && !main.includes("13.579") && !main.includes("E2E-");
    }, null, { timeout: 5000 }).then(() => true, () => false);
  };
  /** Bật riêng mục Sức khỏe của Thông báo đầu tiên qua nút trong thẻ, như người dùng. */
  const grantHealth = async (page) => {
    await page.click(`${IMPORT} button[data-action=onboarding]`);
    await t.acceptNotice(page, ["health_local"]);
    await page.waitForSelector(`${IMPORT} #tracker-file`);
  };
  const importExport = async (page, pick = SOURCE) => {
    await page.setInputFiles("#tracker-file", exportXml);
    await page.waitForSelector(`${IMPORT} input[name=tracker-source]`);
    await page.click(`${IMPORT} label.tracker-source:has-text("${pick}") input`);
    await page.click(`${IMPORT} button[data-tracker=import-confirm]`);
    await page.waitForSelector(`${IMPORT} [data-tracker-imported]`);
  };

  try {
    // ---------------------------------------------------------------- chưa đồng ý Sức khỏe: không đọc, không nhập
    const desk = await openApp();
    const page = desk.page;
    await t.dismissNotice(page);
    await go(page, "connect");
    await page.waitForSelector(SECTION);
    const lead = await text(page, SECTION);
    ok(["chỉ nằm trong bộ nhớ của trang đang mở", "không lưu xuống đĩa của thiết bị này", "không gửi về máy chủ", "không đồng bộ sang thiết bị khác của bạn"].every((x) => lead.includes(x)), "phần nói rõ: dữ liệu chỉ ở bộ nhớ của trang, không lưu xuống đĩa, không gửi về máy chủ, không đồng bộ sang thiết bị khác");
    const memoryNote = await text(page, `${SECTION} [data-tracker-card=import] [data-tracker-memory]`);
    ok(MEMORY_ONLY.every((x) => memoryNote.includes(x)), "thẻ nhập tệp, ngay từ trước khi nhập: «" + memoryNote + "»");
    ok((await page.$$eval(`${SECTION} .tracker-card`, (els) => els.map((e) => e.dataset.trackerCard))).join() === "ble,import,native", "ba thẻ: Bluetooth, nhập tệp, ứng dụng điện thoại");
    const native = await text(page, `${SECTION} [data-tracker-card=native]`);
    ok(native.includes("HealthKit") && native.includes("Health Connect") && native.includes("Chưa có trong bản này") && (await page.$(`${SECTION} [data-tracker-card=native] button`)) === null, "thẻ ứng dụng điện thoại: đường chính tới HealthKit và Health Connect, chưa có trong bản này, không có nút nào");
    const bleFacts = await text(page, `${SECTION} [data-tracker-card=ble]`);
    ok(["Chỉ chạy trên Chrome, Edge và Samsung Internet", "Mỗi lần mở trang phải chọn lại thiết bị", "Không đồng bộ nền", "Không phải thiết bị y tế, không dùng để chẩn đoán", "không lưu và không gửi đi"].every((s) => bleFacts.includes(s)), "thẻ Bluetooth nêu đủ giới hạn: trình duyệt, chọn lại mỗi lần, không đồng bộ nền, không phải thiết bị y tế");
    ok((await page.$(`${BLE} [data-tracker=ble-start]`)) === null && (await page.$(`${IMPORT} #tracker-file`)) === null && (await page.$$(`${SECTION} [data-tracker-need-consent]`)).length === 2 && (await text(page, IMPORT)).includes("chưa bật mục Sức khỏe"),
      "chưa đồng ý Sức khỏe trên thiết bị: hai thẻ nói rõ và dẫn tới Thông báo đầu tiên, không có nút đọc hay ô chọn tệp");
    await shot(page, "01-chua-dong-y", true);
    await grantHealth(page);
    ok((await page.$(`${BLE} [data-tracker=ble-start]`)) !== null && (await page.$(`${IMPORT} #tracker-file`)) !== null, "sau khi đồng ý Sức khỏe: có nút chọn thiết bị và ô chọn tệp");

    // ---------------------------------------------------------------- danh mục theo đường kết nối
    const groups = await page.$$eval(`${SECTION} details.tracker-group`, (els) => els.map((d) => ({ route: d.dataset.trackerRoute, open: d.open, rows: d.querySelectorAll(".tracker-row").length, summary: d.querySelector("summary").textContent })));
    ok(groups.map((g) => g.route).join() === "ble_standard,file_import,os_store,vendor_cloud" && groups.every((g) => !g.open && g.rows > 0) && groups[0].summary.includes("Bluetooth chuẩn") && groups[3].summary.includes("Cloud của hãng"), "danh mục chia theo bốn đường, mặc định gập: " + groups.map((g) => g.rows).join(", ") + " mục");
    await page.click(`${SECTION} details[data-tracker-route=vendor_cloud] summary`);
    const cloud = await text(page, `${SECTION} details[data-tracker-route=vendor_cloud]`);
    ok(cloud.includes("Bản này không có mã nào gọi tới các dịch vụ đó") && cloud.includes("Garmin") && cloud.includes("Cần thỏa thuận") && cloud.includes("chưa xác minh"), "cloud của hãng: cần thỏa thuận, không có mã gọi, mục chưa xác minh được ghi rõ");
    await page.click(`${SECTION} details[data-tracker-route=file_import] summary`);
    const files = await page.$$eval(`${SECTION} details[data-tracker-route=file_import] .tracker-row`, (els) => els.map((e) => e.dataset.trackerEntry + ":" + e.dataset.trackerStatus));
    ok(files.filter((f) => f.endsWith(":built")).sort().join() === "apple_health:built,garmin:built,samsung_health:built" && files.includes("oura:not_supported") && files.includes("fitbit_google:not_supported") && files.includes("health_connect:not_supported"),
      "tệp xuất: ba loại có bộ đọc; Fitbit, Oura, Health Connect và giấc ngủ Samsung ghi là chưa hỗ trợ");
    ok((await page.$$(`${SECTION} img, ${SECTION} picture, ${SECTION} [style*=url]`)).length === 0, "tên hãng là chữ: không có ảnh hay logo nào trong phần");

    // ---------------------------------------------------------------- đọc trực tiếp qua Bluetooth (thiết bị giả)
    const liveFrom = desk.requests.length;
    await page.click(`${BLE} [data-tracker=ble-start]`);
    await page.waitForSelector(`${BLE} [data-tracker-phase=live]`);
    const asked = await ble(page, (b) => b.calls);
    ok(JSON.stringify(asked.request) === JSON.stringify([{ filters: [{ services: ["heart_rate"] }], optionalServices: ["battery_service"] }]) && asked.connect === 1 && asked.notifying.join() === "heart_rate_measurement,battery_level",
      "hộp chọn chỉ xin dịch vụ nhịp tim và pin; bật thông báo cho hai đặc tính đó");
    ok((await text(page, `${BLE} [data-live=bpm]`)) === "—" && (await text(page, `${BLE} [data-live=state]`)).includes("đang chờ số đo đầu tiên") && (await statusOf(page, "ble")).includes("Đang đọc trực tiếp"), "vừa kết nối: chưa có số đo thì hiện dấu gạch, không hiện số bịa");
    await ble(page, (b) => b.emit([0x16, 72, 0x00, 0x04]));
    ok((await text(page, `${BLE} [data-live=bpm]`)) === "72", "gói Heart Rate Measurement đầu tiên: hiện 72 nhịp/phút");
    await page.waitForTimeout(1100);
    await ble(page, (b) => b.emit([0x06, 81]));
    const live = await page.evaluate((sel) => {
      const body = document.querySelector(sel);
      const points = body.querySelector("[data-live=line]").getAttribute("points").trim().split(/\s+/).filter(Boolean);
      return { bpm: body.querySelector("[data-live=bpm]").textContent, points: points.length, summary: body.querySelector("[data-live=summary]").textContent, device: body.querySelector("[data-live=device]").textContent, label: body.querySelector("svg.tracker-trace").getAttribute("aria-label"), dot: body.querySelector("[data-live=dot]").getAttribute("cx") };
    }, BLE);
    ok(live.bpm === "81" && live.points === 2 && Number(live.dot) > 200 && live.summary.includes("thấp nhất 72") && live.summary.includes("cao nhất 81") && live.summary.includes("2 số đo") && live.label.includes("thấp nhất 72"), "số đo mới: giá trị và đường vẽ 60 giây cùng cập nhật, có tóm tắt bằng chữ cho trình đọc màn hình");
    ok(live.device.includes(DEVICE) && live.device.includes("Pin 90%") && live.device.includes("Cảm biến ở cổ tay"), "tên thiết bị, mức pin và vị trí cảm biến hiện trên màn hình: " + live.device);
    await ble(page, (b) => b.battery(89));
    await ble(page, (b) => b.emit([0x10, 80]));
    ok((await text(page, `${BLE} [data-live=device]`)).includes("Pin 89%") && (await text(page, `${BLE} [data-live=bpm]`)) === "81" && (await text(page, `${BLE} [data-live=malformed]`)).includes("Đã bỏ 1 gói"), "pin đổi được cập nhật; gói hỏng bị bỏ và được đếm, số đo trước giữ nguyên");
    await ble(page, (b) => b.emit([0x04, 0]));
    ok((await text(page, `${BLE} [data-live=bpm]`)) === "—" && (await text(page, `${BLE} [data-live=state]`)).includes("chưa chạm da"), "cảm biến báo chưa chạm da: hiện dấu gạch, không hiện 0 như một số đo");
    await ble(page, (b) => b.emit([0x06, 78]));
    await shot(page, "02-dang-doc", true);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    ok(!/E2E-7731|Dây đo/.test(stored) && !(await page.evaluate(async () => (await indexedDB.databases()).length)), "số đo và tên thiết bị không vào localStorage, sessionStorage hay IndexedDB");

    await page.click(`${BLE} [data-tracker=ble-stop]`);
    await page.waitForSelector(`${BLE} [data-tracker=ble-start]`);
    ok((await statusOf(page, "ble")).includes("Đã ngắt kết nối") && (await ble(page, (b) => b.calls.disconnect)) === 1 && !(await text(page, `${SECTION} [data-tracker-card=ble]`)).includes(DEVICE) && (await page.$(`${BLE} [data-live=bpm]`)) === null,
      "ngắt kết nối: thiết bị bị ngắt, số đo và tên thiết bị biến khỏi màn hình");
    await page.click(`${BLE} [data-tracker=ble-start]`);
    await page.waitForSelector(`${BLE} [data-tracker-phase=live]`);
    ok((await text(page, `${BLE} [data-live=bpm]`)) === "—" && (await text(page, `${BLE} [data-live=summary]`)).includes("Chưa có số đo nào"), "kết nối lại là một phiên mới: không còn số đo của phiên trước");
    await ble(page, (b) => b.drop());
    await page.waitForSelector(`${BLE} [data-tracker=ble-start]`);
    ok((await statusOf(page, "ble")).includes("Thiết bị đã ngắt kết nối"), "thiết bị tự ngắt: thẻ báo đúng điều đó");
    await ble(page, (b) => (b.cancelNext = true));
    await page.click(`${BLE} [data-tracker=ble-start]`);
    await page.waitForFunction((sel) => document.querySelector(sel).textContent.includes("Chưa có thiết bị nào được chọn"), `${SECTION} [data-tracker-status-for=ble]`);
    ok((await ble(page, (b) => b.calls.connect)) === 2, "đóng hộp chọn mà không chọn: báo chưa chọn thiết bị, không kết nối gì");
    // Rời màn hình trong lúc đang đọc: ngắt, và quay lại không tự kết nối (mỗi lần phải chọn lại thiết bị).
    await page.click(`${BLE} [data-tracker=ble-start]`);
    await page.waitForSelector(`${BLE} [data-tracker-phase=live]`);
    const before = await ble(page, (b) => ({ ...b.calls, request: b.calls.request.length }));
    await go(page, "home");
    const afterLeave = await ble(page, (b) => b.calls.disconnect);
    await go(page, "connect");
    await page.waitForSelector(`${BLE} [data-tracker=ble-start]`);
    ok(afterLeave === before.disconnect + 1 && (await ble(page, (b) => b.calls.request.length)) === before.request && (await statusOf(page, "ble")) === "", "rời màn hình Kết nối là ngắt Bluetooth; quay lại không tự kết nối lại");
    const liveRequests = desk.requests.slice(liveFrom);
    ok(leaks(liveRequests).length === 0 && liveRequests.every((r) => r.method === "GET"), `trong lúc đọc trực tiếp: ${liveRequests.length} yêu cầu mạng, không yêu cầu nào mang số đo hay tên thiết bị, không có POST`);

    // ---------------------------------------------------------------- nhập export.xml tổng hợp: chỉ vào bộ nhớ của trang
    const importFrom = desk.requests.length;
    ok((await text(page, IMPORT)).includes(NONE), "chưa nhập gì: thẻ nói rõ chưa có dữ liệu nào được nhập trong lượt mở trang này");
    const baseline = await persisted(page);
    await page.setInputFiles("#tracker-file", exportXml);
    await page.waitForSelector(`${IMPORT} input[name=tracker-source]`);
    const pick = await page.evaluate((sel) => {
      const body = document.querySelector(sel);
      return { legend: body.querySelector("legend").textContent, options: [...body.querySelectorAll("label.tracker-source")].map((l) => ({ name: l.querySelector("strong").textContent, detail: l.querySelector("small").textContent, checked: l.querySelector("input").checked })), text: body.textContent };
    }, IMPORT);
    ok(pick.legend.includes("2 nguồn") && pick.legend.includes("không gộp nguồn") && pick.options.map((o) => o.name).sort().join("|") === [OTHER, SOURCE].sort().join("|") && pick.options.filter((o) => o.checked).map((o) => o.name).join() === OTHER,
      "tệp có hai nguồn: người dùng phải chọn một; nguồn có giấc ngủ kết thúc muộn nhất chỉ được gợi ý sẵn");
    ok(pick.options.find((o) => o.name === SOURCE).detail.includes("5 bản ghi giấc ngủ") && pick.options.find((o) => o.name === SOURCE).detail.includes("10 bản ghi bước chân") && pick.text.includes("1 bản ghi ngoài 10 ngày gần nhất") && (await statusOf(page, "import")).includes("Apple Health (export.xml)") && !(await text(page, SECTION)).includes(FILE_NAME),
      "trước khi xác nhận: đếm bản ghi theo nguồn, nói rõ phần bị bỏ; tên tệp không được hiện hay giữ lại");
    await shot(page, "03-chon-nguon", true);
    await page.click(`${IMPORT} label.tracker-source:has-text("${SOURCE}") input`);
    await page.click(`${IMPORT} button[data-tracker=import-confirm]`);
    await page.waitForSelector(`${IMPORT} [data-tracker-imported]`);
    const card = await text(page, IMPORT);
    ok(card.includes("Apple Health (export.xml)") && card.includes(SOURCE) && !card.includes(OTHER) && card.includes("5 ngày có giấc ngủ tính được, 0 ngày chưa rõ thời lượng, 5 ngày có bước chân") && card.includes("Giữ đến khi") && card.includes("Bạn tải lại hoặc đóng trang, đổi tài khoản, rút đồng ý Sức khỏe") && (await statusOf(page, "import")).includes("Đã nhập vào bộ nhớ của trang này"),
      "đã nhập: thẻ ghi loại tệp, nguồn đã chọn, thời điểm nhập, số ngày LeNhip thấy và dữ liệu được giữ đến khi nào");
    await shot(page, "04-da-nhap", true);

    await page.click(`${IMPORT} button[data-nav=health]`);
    await page.waitForSelector("body[data-view=health]", { state: "attached" });
    const health = await text(page, "main");
    ok(health.includes("7 giờ 30 phút") && health.includes("13.579") && health.includes("Trung bình 5/7 ngày có dữ liệu") && (await page.getAttribute("main .bar-chart", "aria-label")).includes("5 ngày có quan sát giấc ngủ, 2 ngày thiếu dữ liệu"),
      "Sức khỏe hiện các ngày đã nhập: trung bình ngủ 7 giờ 30 phút và 13.579 bước trên 5 ngày, 2 ngày thiếu vẫn là thiếu");
    ok(health.includes("Apple Health (export.xml) · tệp bạn nhập") && health.includes("Nguồn " + SOURCE) && health.includes("Nhập lúc") && health.includes("chỉ giữ trong bộ nhớ của trang này") && !health.includes("Dữ liệu tổng hợp") && !health.includes("cần bạn xác nhận"),
      "Sức khỏe ghi nguồn gốc: tệp bạn nhập, tên nguồn đã chọn, thời điểm nhập, chỉ giữ trong bộ nhớ của trang; không còn nhãn dữ liệu tổng hợp");
    await shot(page, "05-suc-khoe-da-nhap", true);
    await go(page, "home");
    ok((await text(page, "main")).includes("Apple Health (export.xml) · tệp bạn nhập"), "Hôm nay cũng ghi nguồn là tệp bạn nhập");
    // Không gì lấy từ tệp được ghi xuống kho của trình duyệt: kho sau khi nhập và xem y nguyên như trước khi nhập.
    const after = await persisted(page);
    ok(JSON.stringify(after) === JSON.stringify(baseline) && residue(after).length === 0 && after.idb.length === 0 && after.cookie === "",
      `sau khi nhập và xem ở Sức khỏe: localStorage (${after.local.length} khóa của ứng dụng), sessionStorage (${after.session.length}), IndexedDB, Cache API và cookie y nguyên như trước khi nhập; không chứa số đo, tên nguồn hay tên tệp` + (residue(after).length ? " — " + residue(after).join(", ") : ""));

    // Xóa: có hiệu lực ngay, không cần tải lại trang.
    await go(page, "connect");
    await page.waitForSelector(`${IMPORT} [data-tracker-imported]`);
    await page.click(`${IMPORT} button[data-tracker=delete]`);
    ok((await text(page, IMPORT)).includes("Xóa dữ liệu đã nhập khỏi bộ nhớ của trang này?") && (await page.$(`${IMPORT} [data-tracker-imported]`)) !== null, "xóa cần một bước xác nhận; chưa xác nhận thì chưa xóa");
    await page.click(`${IMPORT} button[data-tracker=delete-no]`);
    await page.click(`${IMPORT} button[data-tracker=delete]`);
    await page.click(`${IMPORT} button[data-tracker=delete-yes]`);
    await page.waitForSelector(`${IMPORT} #tracker-file`);
    ok((await statusOf(page, "import")).includes("Đã xóa dữ liệu đã nhập") && (await text(page, IMPORT)).includes(NONE) && (await page.$(`${IMPORT} [data-tracker-imported]`)) === null, "xóa: thẻ về trạng thái chưa nhập gì");
    ok((await backToSynthetic(page)), "xóa xong, không tải lại trang: Sức khỏe quay về dữ liệu tổng hợp của bản tham chiếu");

    // Tải lại trang: dữ liệu đã nhập không còn; muốn xem lại phải nhập lại tệp.
    await go(page, "connect");
    await importExport(page);
    ok((await healthText(page)).includes("tệp bạn nhập"), "nhập lại: Sức khỏe lại dùng dữ liệu đã nhập");
    await page.reload();
    await t.ready(page);
    ok((await page.getAttribute("body", "data-view")) === "health" && (await backToSynthetic(page)), "tải lại trang: dữ liệu đã nhập không còn, Sức khỏe quay về dữ liệu tổng hợp");
    await go(page, "connect");
    await page.waitForSelector(`${IMPORT} #tracker-file`);
    ok((await text(page, IMPORT)).includes(NONE) && (await page.$(`${IMPORT} [data-tracker-imported]`)) === null && (await statusOf(page, "import")) === "", "sau khi tải lại: thẻ nói chưa có dữ liệu nào được nhập trong lượt mở trang này");
    ok(residue(await persisted(page)).length === 0 && JSON.stringify(await persisted(page)) === JSON.stringify(baseline), "sau khi tải lại: kho của trình duyệt vẫn y nguyên, không có gì của tệp");
    const importRequests = desk.requests.slice(importFrom);
    ok(leaks(importRequests).length === 0 && importRequests.every((r) => r.method === "GET"), `trong lúc nhập tệp, xem Sức khỏe, xóa, nhập lại và tải lại trang: ${importRequests.length} yêu cầu mạng, không yêu cầu nào mang số đo, tên nguồn hay tên tệp, không có POST`);

    // Cờ `trackers` bị tắt giữa chừng, không tải lại trang: dữ liệu đã nhập kết thúc, và không quay lại khi cờ bật lại.
    await importExport(page);
    await t.withModules(desk.context, { trackers: false });
    await saveNotice(page);
    await page.waitForSelector("#desktop-nav button[data-nav=connect]", { state: "detached" });
    ok((await backToSynthetic(page)), "cờ trackers tắt giữa chừng: không còn Kết nối, dữ liệu đã nhập kết thúc, Sức khỏe quay về dữ liệu tổng hợp");
    await t.withModules(desk.context, { trackers: true });
    await saveNotice(page);
    await page.waitForSelector("#desktop-nav button[data-nav=connect]");
    await go(page, "connect");
    await page.waitForSelector(`${IMPORT} #tracker-file`);
    ok((await text(page, IMPORT)).includes(NONE) && (await backToSynthetic(page)), "cờ bật lại: phần hiện lại và nói chưa có gì được nhập; dữ liệu trước đó không quay lại");

    // Đổi tài khoản: dữ liệu đã nhập kết thúc; người kia không thấy, và quay lại tài khoản cũ cũng không còn.
    await go(page, "connect");
    await importExport(page);
    await t.signIn(page, "dev_b");
    // Tài khoản chưa từng dùng thiết bị này: ứng dụng tự mở Thông báo đầu tiên. Bật riêng mục Sức khỏe để Sức khỏe có dữ liệu.
    await t.acceptNotice(page, ["health_local"]);
    ok((await backToSynthetic(page)), "tài khoản khác trên cùng trang: không thấy dữ liệu người kia đã nhập");
    await t.signIn(page, "dev_a");
    ok((await backToSynthetic(page)), "quay lại tài khoản cũ: đổi tài khoản đã kết thúc dữ liệu đã nhập, Sức khỏe dùng dữ liệu tổng hợp");
    await go(page, "connect");
    await page.waitForSelector(`${IMPORT} #tracker-file`);
    ok((await text(page, IMPORT)).includes(NONE), "sau khi đổi tài khoản: thẻ nói chưa có dữ liệu nào được nhập");

    // Rút đồng ý Sức khỏe: dữ liệu đã nhập kết thúc, hai thẻ quay về trạng thái chưa đồng ý; đồng ý lại cũng không quay lại.
    await importExport(page);
    await saveNotice(page, false);
    await page.waitForSelector(`${IMPORT} [data-tracker-need-consent]`);
    ok((await page.$(`${BLE} [data-tracker=ble-start]`)) === null && (await page.$(`${IMPORT} [data-tracker-imported]`)) === null && (await page.$(`${IMPORT} #tracker-file`)) === null, "rút đồng ý Sức khỏe: không còn nút đọc, ô chọn tệp hay dữ liệu đã nhập");
    await grantHealth(page);
    ok((await text(page, IMPORT)).includes(NONE) && (await backToSynthetic(page)), "đồng ý lại: dữ liệu đã nhập trước khi rút không quay lại");

    // Trình duyệt từng chạy bản dựng trước (ghi dữ liệu đã nhập xuống localStorage): khóa cũ bị xóa lúc nạp trang, không được dùng.
    await page.evaluate(([source, total]) => {
      localStorage.setItem("lenhip.trackers.import.v1.dev_a", JSON.stringify({ v: 1, kind: "apple_health_xml", source, imported_at: Date.now(), sleep: [], sessions: [], buckets: [[Math.floor(Date.now() / 900000) - 96, total]], days: [] }));
      localStorage.setItem("lenhip.trackers.flag.v1.dev_a", "1");
    }, [SOURCE, STEPS_A + STEPS_B]);
    ok(residue(await persisted(page)).length > 0, "(phép kiểm kho nhận ra khóa cũ vừa cấy)");
    await page.reload();
    await t.ready(page);
    ok(residue(await persisted(page)).length === 0 && (await backToSynthetic(page)), "khóa của bản dựng trước bị xóa khỏi localStorage ngay lúc nạp trang và không được dùng");

    // ---------------------------------------------------------------- tệp không đọc được, và hai loại tệp còn lại
    await go(page, "connect");
    await page.setInputFiles("#tracker-file", file("export.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 8, 0])));
    await page.waitForFunction((sel) => document.querySelector(sel).textContent.includes("tệp nén"), `${SECTION} [data-tracker-status-for=import]`);
    ok((await page.$(`${IMPORT} #tracker-file`)) !== null, "tệp ZIP: báo phải giải nén trước, không nhập gì");
    await page.setInputFiles("#tracker-file", file("ghi-chu.txt", "bước chân hôm nay: 5000"));
    await page.waitForFunction((sel) => document.querySelector(sel).textContent.includes("không nhận ra tệp này"), `${SECTION} [data-tracker-status-for=import]`);
    await page.setInputFiles("#tracker-file", file("cu.xml", `<?xml version="1.0"?>\n<HealthData locale="vi_VN">\n${record("steps", SOURCE, "2019-08-04 09:00:00", "2019-08-04 09:10:00", 5)}</HealthData>\n`));
    await page.waitForFunction((sel) => document.querySelector(sel).textContent.includes("không có gì để nhập"), `${SECTION} [data-tracker-status-for=import]`);
    await page.setInputFiles("#tracker-file", file("hong.xml", syntheticExport().slice(0, -60)));
    await page.waitForFunction((sel) => document.querySelector(sel).textContent.includes("bị hỏng hoặc bị cắt dở"), `${SECTION} [data-tracker-status-for=import]`);
    ok((await text(page, IMPORT)).includes(NONE) && (await page.$(`${IMPORT} [data-tracker-imported]`)) === null && (await backToSynthetic(page)), "tệp lạ, tệp không có dữ liệu trong cửa sổ và tệp bị cắt dở: báo rõ lý do, không nhập gì");

    await go(page, "connect");
    const gmt = (offsetDays, hhmm) => `${new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)}T${hhmm}:00.0`;
    const garmin = [1, 2].map((i) => ({ sleepStartTimestampGMT: gmt(-i - 1, "16:00"), sleepEndTimestampGMT: gmt(-i - 1, "23:00"), sleepWindowConfirmationType: "ENHANCED_CONFIRMED_FINAL", deepSleepSeconds: 3600, lightSleepSeconds: 14400, remSleepSeconds: 5400, awakeSleepSeconds: 1800 }));
    await page.setInputFiles("#tracker-file", file("x_sleepData.json", JSON.stringify(garmin)));
    await page.waitForSelector(`${IMPORT} input[name=tracker-source]`);
    ok((await text(page, IMPORT)).includes("Tệp giấc ngủ của Garmin") && (await text(page, IMPORT)).includes("chỉ có tổng theo giai đoạn"), "tệp Garmin: một nguồn, nói trước là chỉ có tổng theo giai đoạn");
    await page.click(`${IMPORT} button[data-tracker=import-confirm]`);
    await page.waitForSelector(`${IMPORT} [data-tracker-imported=garmin_sleep_json]`);
    const garminCard = await text(page, IMPORT);
    const garminHealth = await healthText(page);
    ok(garminCard.includes("0 ngày có giấc ngủ tính được, 2 ngày chưa rõ thời lượng") && garminHealth.includes("Garmin (giấc ngủ, JSON) · tệp bạn nhập") && (await page.getAttribute("main .bar-chart", "aria-label")).includes("0 ngày có quan sát giấc ngủ") && !/\b[5-9] giờ/.test(garminHealth.split("Vận động")[0]),
      "Garmin chỉ có tổng theo giai đoạn: hai đêm là «chưa rõ thời lượng», Sức khỏe không hiện số giờ nào được suy ra");
    await go(page, "connect");
    await page.click(`${IMPORT} button[data-tracker=replace]`);
    const utcMidnight = (offset) => Date.parse(new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z");
    await page.setInputFiles("#tracker-file", file("com.samsung.shealth.activity.day_summary.1.csv", `com.samsung.shealth.activity.day_summary,6312001,7\nstep_count,distance,day_time,\n5111,3500.5,${utcMidnight(-2)},\n6222,4200.0,${utcMidnight(-3)},\n`));
    await page.waitForSelector(`${IMPORT} input[name=tracker-source]`);
    await page.click(`${IMPORT} button[data-tracker=import-confirm]`);
    await page.waitForSelector(`${IMPORT} [data-tracker-imported=samsung_steps_csv]`);
    ok((await text(page, IMPORT)).includes("Tệp tổng hợp ngày của Samsung Health") && (await text(page, IMPORT)).includes("0 ngày có giấc ngủ tính được, 0 ngày chưa rõ thời lượng, 2 ngày có bước chân"), "tệp Samsung thay cho tệp trước: chỉ có bước chân của hai ngày");
    await page.click(`${IMPORT} button[data-tracker=delete]`);
    await page.click(`${IMPORT} button[data-tracker=delete-yes]`);
    await page.waitForSelector(`${IMPORT} #tracker-file`);
    ok(residue(await persisted(page)).length === 0, "sau cả ba loại tệp: kho của trình duyệt không có gì của tệp nào");

    // ---------------------------------------------------------------- chỉ dùng bàn phím
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await page.focus("#main");
    const tabTo = async (selector, limit = 90) => {
      for (let i = 0; i < limit; i++) {
        if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return true;
        await page.keyboard.press("Tab");
      }
      return page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector);
    };
    const focused = () => page.evaluate(() => ({ tracker: document.activeElement?.dataset?.tracker ?? null, id: document.activeElement?.id ?? "", tag: document.activeElement?.tagName, nav: document.activeElement?.dataset?.nav ?? null, name: document.activeElement?.getAttribute("name"), outline: getComputedStyle(document.activeElement).outlineStyle }));
    ok(await tabTo("[data-tracker=ble-start]"), "bàn phím: Tab tới được nút chọn thiết bị Bluetooth");
    ok((await focused()).outline !== "none", "nút đang có focus hiện viền focus");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${BLE} [data-tracker-phase=live]`);
    ok((await focused()).tracker === "ble-stop", "bàn phím: Enter mở phiên đọc, focus chuyển sang nút Ngắt kết nối");
    await ble(page, (b) => b.emit([0x06, 66]));
    ok((await focused()).tracker === "ble-stop" && (await text(page, `${BLE} [data-live=bpm]`)) === "66", "số đo mới không làm mất focus của bàn phím");
    await page.keyboard.press("Space");
    await page.waitForSelector(`${BLE} [data-tracker=ble-start]`);
    ok((await focused()).tracker === "ble-start", "bàn phím: phím cách ngắt kết nối, focus về nút chọn thiết bị");
    ok(await tabTo("#tracker-file"), "bàn phím: Tab tới được ô chọn tệp");
    await page.setInputFiles("#tracker-file", exportXml); // hộp chọn tệp của hệ điều hành không điều khiển được trong phép kiểm
    await page.waitForSelector(`${IMPORT} input[name=tracker-source]`);
    let f = await focused();
    ok(f.name === "tracker-source" && f.tag === "INPUT", "bàn phím: sau khi đọc tệp, focus ở nguồn đang được chọn");
    const checkedName = () => page.$eval(`${IMPORT} input[name=tracker-source]:checked`, (i) => i.closest("label").querySelector("strong").textContent);
    const first = await checkedName();
    await page.keyboard.press(first === OTHER ? "ArrowUp" : "ArrowDown");
    ok((await checkedName()) !== first && [SOURCE, OTHER].includes(await checkedName()), "bàn phím: phím mũi tên đổi nguồn");
    if ((await checkedName()) !== SOURCE) await page.keyboard.press("ArrowDown");
    ok(await tabTo("[data-tracker=import-confirm]", 6), "bàn phím: Tab tới nút Nhập nguồn này");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${IMPORT} [data-tracker-imported]`);
    f = await focused();
    ok(f.nav === "health" && (await text(page, IMPORT)).includes(SOURCE), "bàn phím: nhập xong, focus ở nút Xem ở Sức khỏe");
    ok(await tabTo("[data-tracker=delete]", 6), "bàn phím: Tab tới nút Xóa dữ liệu đã nhập");
    await page.keyboard.press("Enter");
    ok((await focused()).tracker === "delete-no", "bàn phím: bước xác nhận xóa đặt focus ở lựa chọn an toàn (Giữ lại)");
    await page.keyboard.press("Tab");
    ok((await focused()).tracker === "delete-yes", "bàn phím: Tab tới nút Xóa");
    await page.keyboard.press("Enter");
    await page.waitForSelector(`${IMPORT} #tracker-file`);
    ok((await focused()).id === "tracker-file" && (await text(page, IMPORT)).includes(NONE), "bàn phím: xóa xong, focus về ô chọn tệp, thẻ về trạng thái chưa nhập gì");
    await page.$$eval(`${SECTION} details.tracker-group`, (els) => els.forEach((d) => (d.open = false)));
    ok(await tabTo(`${SECTION} details[data-tracker-route=ble_standard] summary`, 12), "bàn phím: Tab tới nhóm đầu của danh mục");
    await page.keyboard.press("Enter");
    ok(await page.$eval(`${SECTION} details[data-tracker-route=ble_standard]`, (d) => d.open), "bàn phím: Enter mở nhóm của danh mục");
    ok(leaks(desk.requests).length === 0, `cả lượt kiểm trên máy tính: ${desk.requests.length} yêu cầu mạng, không yêu cầu nào mang số đo, tên nguồn, tên thiết bị hay tên tệp`);
    const posts = desk.requests.filter((r) => r.method !== "GET").map((r) => new URL(r.url).pathname);
    ok(posts.every((p) => p === "/v1/consents" || p === "/dev/token" || /^\/v1\/consents\/[a-z_]+\/withdraw$/.test(p)), "POST duy nhất trong cả lượt là đăng nhập thử và lựa chọn đồng ý của các mục đích khác: " + [...new Set(posts)].join(", "));
    await desk.context.close();

    // ---------------------------------------------------------------- trình duyệt không có Web Bluetooth
    const plain = await openApp({ bluetooth: false });
    await t.dismissNotice(plain.page);
    await go(plain.page, "connect");
    await plain.page.waitForSelector(`${BLE} [data-tracker-unsupported=NO_API]`);
    const why = await text(plain.page, BLE);
    ok(why.includes("Trình duyệt này không có Web Bluetooth") && why.includes("Chrome, Edge hoặc Samsung Internet") && (await plain.page.$(`${BLE} button`)) === null, "không có navigator.bluetooth: thẻ giải thích vì sao và nên dùng trình duyệt nào, không có nút bấm vô ích");
    await grantHealth(plain.page);
    ok((await plain.page.$(`${BLE} [data-tracker-unsupported=NO_API]`)) !== null && (await plain.page.$(`${IMPORT} #tracker-file`)) !== null, "không có Web Bluetooth: đường nhập tệp vẫn dùng được");
    await shot(plain.page, "06-khong-co-bluetooth", true);
    await plain.context.close();

    // ---------------------------------------------------------------- ba cỡ màn hình, năm phong cách, chữ 100 % và 200 %
    for (const [name, viewport, looks] of MATRIX) {
      const sized = await openApp({ viewport });
      const p = sized.page;
      await t.dismissNotice(p);
      await go(p, "connect");
      await p.waitForSelector(SECTION);
      if (await p.$(`${IMPORT} [data-tracker-need-consent]`)) await grantHealth(p);
      await importExport(p);
      await p.click(`${BLE} [data-tracker=ble-start]`);
      await p.waitForSelector(`${BLE} [data-tracker-phase=live]`);
      await ble(p, (b) => [72, 75, 71, 188].forEach((v) => b.emit([0x06, v])));
      await p.$$eval(`${SECTION} details.tracker-group`, (els) => els.forEach((d) => (d.open = true)));
      for (const [theme, scale] of looks) {
        await t.chooseSettings(p, { theme, fontSize: scale });
        const problems = await p.evaluate(layoutProblems, SECTION);
        ok(problems.length === 0, `${name} ${viewport.width}×${viewport.height} · chữ ${scale} % · ${theme}: không tràn, vùng bấm ≥ 44 px, chữ đọc được` + (problems.length ? " — " + problems.join("; ") : ""));
        await shot(p, `${viewport.width}x${viewport.height}-${scale}-${theme}`, true);
      }
      ok((await ble(p, (b) => b.calls.request.length)) === 1 && (await text(p, `${BLE} [data-live=bpm]`)) === "188" && (await p.$(`${IMPORT} [data-tracker-imported]`)) !== null, `${name}: đổi phong cách và cỡ chữ không dựng lại phần, phiên đọc và dữ liệu đã nhập được giữ`);
      ok(leaks(sized.requests).length === 0 && residue(await persisted(p)).length === 0, `${name}: không yêu cầu mạng nào mang số đo, tên nguồn hay tên thiết bị, và kho của trình duyệt không có gì của tệp`);
      await sized.context.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
