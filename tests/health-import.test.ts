// Nhập tệp xuất trên thiết bị (LNH-T55): ba bộ đọc, một nguồn duy nhất, cửa sổ 7 ngày, dữ liệu chỉ ở bộ nhớ của trang. Mọi tệp ở
// contracts/fixtures/import/ và mọi tệp dựng trong kiểm thử này là DỮ LIỆU TỔNG HỢP với tên nguồn bịa; chưa tệp xuất thật nào
// của hãng được kiểm ở đây (LNH-D16).
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, createReadStream, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
  APPLE_SLEEP_VALUES, GARMIN_SOURCE, IMPORTERS, ImportError, LEGACY_STORE_PREFIX, LIMITS, SAMSUNG_SOURCE, STEP_BUCKET_MS, WINDOW_DAYS,
  appleInstant, buildImport, chunksOf, createImportMemory, csvCells, describeImport, detectKind, importToHealthInput, purgeLegacyStore,
  scanImport,
} from "../web/shared/health-import.js";
import { computeHealthDays } from "../web/shared/sleep.js";

const dir = new URL("../contracts/fixtures/import/", import.meta.url);
const NOW = Date.parse("2026-11-11T03:00:00Z"); // 10:00 giờ Việt Nam
const HCM = "Asia/Ho_Chi_Minh";
const WATCH = "Đồng hồ mẫu";
const PHONE = "Điện thoại mẫu";
const APP = "Ứng dụng mẫu & đo bước";
const DAY = 86_400_000;
const utf8 = new TextEncoder();

const fixture = (name: string, chunk = 65_536) => createReadStream(new URL(name, dir), { highWaterMark: chunk });
/** Một chuỗi thành nguồn lặp ra các khối byte có cỡ cho trước. */
async function* pieces(text: string, size = 4096) {
  const all = utf8.encode(text);
  for (let o = 0; o < all.length; o += size) yield all.subarray(o, o + size);
}
type Scan = Awaited<ReturnType<typeof scanImport>>;
/** Chọn một nguồn rồi đưa qua LNH-SLEEP-1, như ứng dụng làm. */
function analyse(scan: Scan, source: string, zone: string, now = scan.now_ms) {
  const held = buildImport(scan, source, now);
  return { held, out: computeHealthDays(importToHealthInput(held, { nowMs: now, zone, revision: 3 })) };
}
type Out = ReturnType<typeof computeHealthDays>;
const day = (out: Out, date: string) => {
  const row = out.days.find((d) => d.local_date === date);
  assert.ok(row, `thiếu ngày ${date}`);
  return [row.source_status, row.sleep_seconds, row.steps];
};
const record = (type: "steps" | "sleep", source: string, start: string, end: string, value: string) =>
  `<Record type="${type === "steps" ? "HKQuantityTypeIdentifierStepCount" : "HKCategoryTypeIdentifierSleepAnalysis"}" sourceName="${source}" startDate="${start}" endDate="${end}" value="${value}"/>\n`;
const doc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="vi_VN">\n${body}</HealthData>\n`;
const rejects = (source: unknown, code: string, now = NOW) => assert.rejects(scanImport(source, { nowMs: now }), (e: unknown) => e instanceof ImportError && e.code === code, code);

test("ba bộ đọc, đúng ba; nhận loại tệp từ nội dung, không từ tên", () => {
  assert.deepEqual(Object.keys(IMPORTERS).sort(), ["apple_health_xml", "garmin_sleep_json", "samsung_steps_csv"]);
  assert.equal(IMPORTERS.garmin_sleep_json.durations, false, "Garmin chỉ có tổng theo giai đoạn: không tính được thời lượng");
  assert.equal(detectKind(utf8.encode('<?xml version="1.0"?>\n<!DOCTYPE HealthData [')), "apple_health_xml");
  assert.equal(detectKind(utf8.encode('\ufeff  <HealthData locale="vi_VN">')), "apple_health_xml");
  assert.equal(detectKind(utf8.encode("<html><body>")), "unknown");
  assert.equal(detectKind(utf8.encode("com.samsung.shealth.activity.day_summary,6312001,7\n")), "samsung_steps_csv");
  assert.equal(detectKind(utf8.encode("com.samsung.shealth.sleep,6312001,7\n")), "unknown", "tệp giấc ngủ của Samsung chưa có bộ đọc");
  assert.equal(detectKind(utf8.encode(' [{"sleepStartTimestampGMT":')), "json");
  assert.equal(detectKind(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14)), "zip");
  assert.equal(detectKind(Uint8Array.of(0xff, 0xfe, 0x3c, 0x00)), "utf16");
  assert.equal(detectKind(utf8.encode("bước chân, giấc ngủ")), "unknown");
});

test("ngày giờ của Apple là một thời điểm chính xác; dạng khác bị từ chối", () => {
  assert.equal(appleInstant("2014-09-13 10:27:54 +0100"), Date.parse("2014-09-13T09:27:54Z"));
  assert.equal(appleInstant("2026-11-09 23:00:00 +0700"), Date.parse("2026-11-09T16:00:00Z"));
  assert.equal(appleInstant("2026-11-01 01:30:00 -0400"), Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(appleInstant("2026-11-01 01:30:00 +0545"), Date.parse("2026-10-31T19:45:00Z"));
  for (const bad of ["2026-11-09T23:00:00+07:00", "2026-11-09 23:00:00", "2026-11-09 23:00:00 +07:00", "2026-13-09 23:00:00 +0700", "2026-02-30 10:00:00 +0700", "2026-11-09 24:00:00 +0700", "", null, 1794268800000]) {
    assert.ok(Number.isNaN(appleInstant(bad)), String(bad));
  }
});

test("Apple export.xml: đi lại ca S01 của LNH-SLEEP-1 qua đường nhập tệp", async () => {
  const s01 = JSON.parse(readFileSync(new URL("../contracts/fixtures/sleep/S01.json", import.meta.url), "utf8")).cases[0];
  const scan = await scanImport(fixture("apple-export-s01.xml"), { nowMs: Date.parse(s01.input.now) });
  assert.equal(scan.kind, "apple_health_xml");
  assert.deepEqual(scan.sources.map((s) => s.name), [WATCH]);
  const { held, out } = analyse(scan, WATCH, s01.input.analysis_zone);
  // Cùng các thời điểm như đầu vào của S01 nên phần giấc ngủ phải trùng từng trường; khác ở tên nguồn, revision và bước chân.
  const sleepOnly = (o: Out) => o.days.map((d) => [d.local_date, d.source_status, d.sleep_seconds, d.coverage_days, d.complete]);
  assert.deepEqual(sleepOnly(out), sleepOnly(s01.expected));
  assert.deepEqual(out.episodes, s01.expected.episodes);
  assert.deepEqual(day(out, "2026-11-10"), ["OBSERVED", 27000, 812]);
  assert.deepEqual(out.source, { id: WATCH, selection: "USER" });
  assert.deepEqual(out.flags, []);
  assert.deepEqual(held.sleep, [["asleepCore", Date.parse("2026-11-09T16:00:00Z"), Date.parse("2026-11-10T00:00:00Z")], ["awake", Date.parse("2026-11-09T19:00:00Z"), Date.parse("2026-11-09T19:30:00Z")]]);
});

test("Apple export.xml: giá trị giấc ngủ cũ và mới, nhiều nguồn không gộp, bản ghi ngoài cửa sổ bị bỏ", async () => {
  const scan = await scanImport(fixture("apple-export-multi.xml"), { nowMs: NOW });
  assert.deepEqual(scan.sources.map((s) => s.name), [PHONE, WATCH, APP].sort((a, b) => (a < b ? -1 : 1)));
  assert.equal(scan.suggested, WATCH, "gợi ý nguồn có dữ liệu ngủ kết thúc muộn nhất; người dùng vẫn phải tự chọn");
  assert.deepEqual(scan.stats.skipped, { before_window: 1, future: 1, bad_date: 1, bad_value: 1, bad_source: 0 });
  assert.equal(scan.stats.matched, 22);
  assert.equal(scan.window_start_ms, NOW - WINDOW_DAYS * DAY);
  const of = (name: string) => scan.sources.find((s) => s.name === name)!.summary;
  assert.deepEqual([of(WATCH).sleep_records, of(WATCH).asleep_records, of(WATCH).step_records], [10, 7, 7]);
  assert.deepEqual([of(PHONE).sleep_records, of(PHONE).asleep_records, of(PHONE).step_records], [2, 1, 2]);
  assert.deepEqual([of(APP).sleep_records, of(APP).step_records], [0, 1], "tên nguồn có &amp; được giải mã; thuộc tính nháy đơn đọc được");

  // Nguồn A: giai đoạn Core/Deep/REM/Unspecified là ngủ, Awake bị trừ, InBed bị bỏ qua, giá trị lạ được gắn cờ.
  const a = analyse(scan, WATCH, HCM).out;
  assert.deepEqual(day(a, "2026-11-08"), ["MISSING", null, null]);
  assert.deepEqual(day(a, "2026-11-09"), ["OBSERVED", 25200, 2000]);
  assert.deepEqual(day(a, "2026-11-10"), ["OBSERVED", 26400, 3512], "bước 23:50–00:05 thuộc ngày chứa mili giây cuối; bước kết thúc đúng 00:00 thuộc ngày trước");
  assert.deepEqual(day(a, "2026-11-11"), ["OBSERVED", 23400, 120]);
  assert.deepEqual(a.episodes.filter((e) => e.local_date === "2026-11-09").map((e) => [e.role, e.asleep_seconds]), [["MAIN", 25200], ["SECONDARY", 1500]]);
  assert.deepEqual(a.flags, [{ record: "ah-9", code: "UNKNOWN_VALUE" }]);
  assert.deepEqual(a.source, { id: WATCH, selection: "USER" });

  // Nguồn B: «Asleep» kiểu cũ là asleepUnspecified. Không có bước chân hay giấc ngủ nào của nguồn A lẫn vào.
  const b = analyse(scan, PHONE, HCM);
  assert.deepEqual(day(b.out, "2026-11-09"), ["MISSING", null, 1800]);
  assert.deepEqual(day(b.out, "2026-11-10"), ["OBSERVED", 25200, 700]);
  assert.deepEqual(b.held.sleep.map((r) => r[0]), ["inBed", "asleepUnspecified"]);
  const c = analyse(scan, APP, HCM).out;
  assert.deepEqual(day(c, "2026-11-10"), ["MISSING", null, 950]);
  assert.equal(c.summary.sleep_observed_days, 0);
  assert.equal(a.days.reduce((n, d) => n + (d.steps ?? 0), 0), 2000 + 3512 + 120, "không cộng bước của hai nguồn");
  assert.throws(() => buildImport(scan, "Nguồn không có", NOW), (e: unknown) => e instanceof ImportError && e.code === "UNKNOWN_SOURCE");
  assert.throws(() => buildImport(scan, `${WATCH},${PHONE}`, NOW), ImportError, "không có cách nào chọn hai nguồn");
});

test("Apple export.xml: kết quả không phụ thuộc cách tệp bị cắt thành khối", async () => {
  const whole = await scanImport(fixture("apple-export-multi.xml", 1 << 20), { nowMs: NOW });
  for (const chunk of [1, 2, 3, 7, 61, 257, 4096]) {
    const cut = await scanImport(fixture("apple-export-multi.xml", chunk), { nowMs: NOW });
    assert.deepEqual(cut.sources, whole.sources, `khối ${chunk} byte`);
    assert.deepEqual(cut.stats.skipped, whole.stats.skipped, `khối ${chunk} byte`);
    assert.ok(cut.stats.peak_buffer_chars <= Math.max(chunk, 4096 + chunk) + 1024, `khối ${chunk}: bộ đệm ${cut.stats.peak_buffer_chars}`);
  }
  // Cùng nội dung qua Blob.stream() (đường trình duyệt dùng cho File) và qua mảng khối.
  const text = readFileSync(new URL("apple-export-multi.xml", dir), "utf8");
  assert.deepEqual((await scanImport(new Blob([text]), { nowMs: NOW })).sources, whole.sources);
  assert.deepEqual((await scanImport([utf8.encode(text)], { nowMs: NOW })).sources, whole.sources);
});

test("Apple export.xml: đổi giờ mùa hè và mùa đông, bước chân tính lại theo múi phân tích", async () => {
  const NY = "America/New_York";
  const november = await scanImport(fixture("apple-export-dst.xml"), { nowMs: Date.parse("2026-11-03T15:00:00Z") });
  assert.deepEqual(november.stats.skipped.before_window, 3, "ba bản ghi tháng Ba nằm ngoài cửa sổ");
  const fall = analyse(november, WATCH, NY).out;
  assert.deepEqual(day(fall, "2026-11-01"), ["OBSERVED", 32400, 650], "23:00 EDT → 07:00 EST là 9 giờ thật; giờ 01:30 lặp lại hai lần đều thuộc 01/11");
  assert.deepEqual(day(fall, "2026-11-02"), ["MISSING", null, 400]);
  assert.deepEqual(day(fall, "2026-10-31"), ["MISSING", null, null]);
  // Cùng dữ liệu đang giữ, người dùng đổi múi phân tích: ranh giới ngày đổi theo, không cần nhập lại.
  const held = buildImport(november, WATCH, november.now_ms);
  const ktm = computeHealthDays(importToHealthInput(held, { nowMs: november.now_ms, zone: "Asia/Kathmandu", revision: 4 }));
  assert.deepEqual(day(ktm, "2026-11-01"), ["OBSERVED", 32400, 300]);
  assert.deepEqual(day(ktm, "2026-11-02"), ["MISSING", null, 750]);
  assert.equal(ktm.analysis_zone, "Asia/Kathmandu");

  const march = await scanImport(fixture("apple-export-dst.xml"), { nowMs: Date.parse("2026-03-10T15:00:00Z") });
  assert.deepEqual(march.stats.skipped.future, 6, "sáu bản ghi tháng Mười một ở tương lai so với «bây giờ»");
  const spring = analyse(march, WATCH, NY).out;
  assert.deepEqual(day(spring, "2026-03-08"), ["OBSERVED", 25200, 70], "23:00 EST → 07:00 EDT là 7 giờ thật");
  assert.deepEqual(day(spring, "2026-03-07"), ["MISSING", null, 30], "bước kết thúc đúng nửa đêm thuộc ngày trước");
});

test("Apple export.xml: múi lệch 45 phút, ô 15 phút vẫn chia đúng ngày", async () => {
  const xml = doc(
    record("steps", WATCH, "2026-11-09 23:50:00 +0545", "2026-11-09 23:59:00 +0545", "11") +
    record("steps", WATCH, "2026-11-10 00:00:00 +0545", "2026-11-10 00:10:00 +0545", "22") +
    record("steps", WATCH, "2026-11-09 23:46:00 +0545", "2026-11-10 00:00:00 +0545", "44") +
    record("sleep", WATCH, "2026-11-09 22:00:00 +0545", "2026-11-10 05:00:00 +0545", "HKCategoryValueSleepAnalysisAsleepDeep"));
  const scan = await scanImport(pieces(xml, 50), { nowMs: NOW });
  const out = analyse(scan, WATCH, "Asia/Kathmandu").out;
  assert.deepEqual(day(out, "2026-11-09"), ["MISSING", null, 55]);
  assert.deepEqual(day(out, "2026-11-10"), ["OBSERVED", 25200, 22]);
  assert.ok(scan.sources[0].buckets.every(([b]) => Number.isInteger(b) && (b * STEP_BUCKET_MS) % STEP_BUCKET_MS === 0));
});

test("Apple export.xml: thuộc tính viết lộn thứ tự, xuống dòng, có dấu > và ký tự thoát; 0 bước là số 0 quan sát", async () => {
  const xml = doc(
    `<Record\n  value="0"\n  endDate="2026-11-10 08:10:00 +0700"\n  device="a > b &lt;x&gt;"\n  startDate="2026-11-10 08:00:00 +0700" sourceName="&#x110;ồng hồ m&#7851;u"\n  type="HKQuantityTypeIdentifierStepCount" />\n` +
    `<Record type = "HKQuantityTypeIdentifierStepCount" sourceName = '${WATCH}' startDate="2026-11-09 08:00:00 +0700" endDate="2026-11-09 08:00:00 +0700" value="7.0"></Record>\n` +
    `<Record type="HKQuantityTypeIdentifierStepCountExtra" sourceName="${WATCH}" startDate="2026-11-10 09:00:00 +0700" endDate="2026-11-10 09:10:00 +0700" value="999"/>\n` +
    `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${WATCH}" startDate="2026-11-10 09:10:00 +0700" endDate="2026-11-10 09:00:00 +0700" value="5"/>\n` +
    `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${WATCH}" startDate="2026-11-10 09:00:00 +0700" endDate="2026-11-10 09:10:00 +0700" value="-5"/>\n` +
    `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="" startDate="2026-11-10 09:00:00 +0700" endDate="2026-11-10 09:10:00 +0700" value="5"/>\n` +
    `<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${"x".repeat(LIMITS.maxSourceNameChars + 1)}" startDate="2026-11-10 09:00:00 +0700" endDate="2026-11-10 09:10:00 +0700" value="5"/>\n` +
    `<!-- <Record type="HKQuantityTypeIdentifierStepCount" sourceName="${WATCH}" startDate="2026-11-10 10:00:00 +0700" endDate="2026-11-10 10:10:00 +0700" value="100"/> là chú thích nhưng vẫn là một thẻ Record đúng dạng -->\n`);
  for (const size of [1, 13, 4096]) {
    const scan = await scanImport(pieces(xml, size), { nowMs: NOW });
    assert.deepEqual(scan.sources.map((s) => s.name), [WATCH], "tên có ký tự thoát dạng số trùng với tên viết thẳng");
    assert.deepEqual(scan.stats.skipped, { before_window: 0, future: 0, bad_date: 0, bad_value: 2, bad_source: 2 });
    const out = analyse(scan, WATCH, HCM).out;
    // Bản ghi nằm trong chú thích XML vẫn được đọc: bộ quét không dựng cây XML. Tệp xuất của Apple không có chú thích trong thân.
    assert.deepEqual(day(out, "2026-11-10"), ["MISSING", null, 100]);
    assert.deepEqual(day(out, "2026-11-09"), ["MISSING", null, 7], "bản ghi dài 0 giây thuộc ngày của chính thời điểm đó; 7.0 là số nguyên");
  }
  const zero = await scanImport(pieces(doc(record("steps", WATCH, "2026-11-10 08:00:00 +0700", "2026-11-10 08:10:00 +0700", "0"))), { nowMs: NOW });
  assert.deepEqual(day(analyse(zero, WATCH, HCM).out, "2026-11-10"), ["MISSING", null, 0], "0 có nguồn là số 0 quan sát, khác với thiếu");
  assert.deepEqual(day(analyse(zero, WATCH, HCM).out, "2026-11-09"), ["MISSING", null, null]);
});

test("bảng giá trị giấc ngủ của Apple: đủ bảy giá trị, cũ và mới", () => {
  assert.deepEqual({ ...APPLE_SLEEP_VALUES }, {
    HKCategoryValueSleepAnalysisInBed: "inBed",
    HKCategoryValueSleepAnalysisAsleep: "asleepUnspecified",
    HKCategoryValueSleepAnalysisAsleepUnspecified: "asleepUnspecified",
    HKCategoryValueSleepAnalysisAsleepCore: "asleepCore",
    HKCategoryValueSleepAnalysisAsleepDeep: "asleepDeep",
    HKCategoryValueSleepAnalysisAsleepREM: "asleepREM",
    HKCategoryValueSleepAnalysisAwake: "awake",
  });
});

test("Samsung Health CSV: tổng bước theo ngày; ngày có hai số khác nhau là thiếu, không cộng", async () => {
  for (const chunk of [1, 16, 65_536]) {
    const scan = await scanImport(fixture("samsung-steps.csv", chunk), { nowMs: NOW });
    assert.equal(scan.kind, "samsung_steps_csv");
    assert.deepEqual(scan.sources.map((s) => s.name), [SAMSUNG_SOURCE]);
    assert.deepEqual(scan.stats.skipped, { before_window: 1, future: 1, bad_row: 1 });
    assert.deepEqual(scan.sources[0].summary.step_days, 5);
    const { out, held } = analyse(scan, SAMSUNG_SOURCE, HCM);
    assert.deepEqual(day(out, "2026-11-10"), ["MISSING", null, 6120]);
    assert.deepEqual(day(out, "2026-11-09"), ["MISSING", null, 4005]);
    assert.deepEqual(day(out, "2026-11-08"), ["MISSING", null, 7310], "hai dòng trùng số là một số");
    assert.deepEqual(day(out, "2026-11-07"), ["MISSING", null, null], "hai dòng khác số: không cộng, không chọn");
    assert.deepEqual(day(out, "2026-11-06"), ["MISSING", null, 3100], "day_time không phải nửa đêm UTC: ngày local chứa thời điểm đó");
    assert.equal(out.summary.steps_average, 5134);
    assert.equal(out.summary.sleep_observed_days, 0);
    assert.deepEqual([held.sleep, held.sessions, held.buckets], [[], [], []]);
    // Ở múi UTC, thời điểm 17:00Z ngày 05 thuộc ngày 05.
    const utc = computeHealthDays(importToHealthInput(held, { nowMs: NOW, zone: "UTC", revision: 1 }));
    assert.deepEqual([day(utc, "2026-11-05")[2], day(utc, "2026-11-06")[2], day(utc, "2026-11-10")[2]], [3100, null, 6120]);
  }
  assert.deepEqual(csvCells('a,"b,c","d ""e""",,f,'), ["a", "b,c", 'd "e"', "", "f", ""]);
  // Tên cột có tiền tố loại dữ liệu cũng nhận; dòng trống và CRLF không làm hỏng.
  const prefixed = "com.samsung.shealth.activity.day_summary,1,2\r\ncom.samsung.shealth.activity.day_summary.day_time,com.samsung.shealth.activity.day_summary.step_count\r\n1794268800000,42\r\n\r\n";
  assert.deepEqual(day(analyse(await scanImport(pieces(prefixed), { nowMs: NOW }), SAMSUNG_SOURCE, HCM).out, "2026-11-10")[2], 42);
});

test("Garmin JSON: chỉ có tổng theo giai đoạn nên ngày là DURATION_UNKNOWN, không có thời lượng nào được suy ra", async () => {
  const scan = await scanImport(fixture("garmin-sleep.json", 9), { nowMs: NOW });
  assert.equal(scan.kind, "garmin_sleep_json");
  assert.deepEqual(scan.sources.map((s) => s.name), [GARMIN_SOURCE]);
  assert.deepEqual(scan.stats.skipped, { before_window: 1, future: 0, bad_date: 1, unconfirmed: 1, no_sleep: 1, not_entry: 1 });
  const { out, held } = analyse(scan, GARMIN_SOURCE, HCM);
  assert.deepEqual(day(out, "2026-11-10"), ["DURATION_UNKNOWN", null, null]);
  assert.deepEqual(day(out, "2026-11-09"), ["DURATION_UNKNOWN", null, null]);
  assert.deepEqual(day(out, "2026-11-08"), ["MISSING", null, null], "mục UNCONFIRMED bị bỏ");
  assert.deepEqual(day(out, "2026-11-07"), ["MISSING", null, null], "mục không có giây ngủ nào bị bỏ");
  assert.deepEqual([out.summary.sleep_observed_days, out.summary.sleep_average_seconds, out.episodes.length], [0, null, 0]);
  assert.ok(out.days.every((d) => d.sleep_seconds === null));
  // Các tổng deep/light/rem/awake của tệp không có mặt ở đâu trong dữ liệu được giữ.
  assert.deepEqual(held.sessions, [[Date.parse("2026-11-08T16:00:00Z"), Date.parse("2026-11-08T23:00:00Z")], [Date.parse("2026-11-09T15:28:00Z"), Date.parse("2026-11-09T23:30:00Z")]]);
  assert.doesNotMatch(JSON.stringify(held), /19440|8460|14400|5400|Seconds/);
  assert.deepEqual(describeImport(held, { nowMs: NOW, zone: HCM }), { sleep_observed_days: 0, sleep_unknown_days: 2, steps_days: 0, flags: 0 });
});

test("đầu vào cho LNH-SLEEP-1 có đúng dạng của computeHealthDays, không thêm trường nào", async () => {
  const scan = await scanImport(fixture("apple-export-multi.xml"), { nowMs: NOW });
  const held = buildImport(scan, WATCH, NOW);
  assert.deepEqual(Object.keys(held).sort(), ["buckets", "days", "imported_at", "kind", "sessions", "sleep", "source"]);
  const input = importToHealthInput(held, { nowMs: NOW, zone: HCM, revision: 7 });
  assert.deepEqual(Object.keys(input).sort(), ["analysis_zone", "now", "records", "selected_source", "source_revision", "steps"]);
  assert.deepEqual([input.analysis_zone, input.now, input.selected_source, input.source_revision], [HCM, "2026-11-11T03:00:00.000Z", WATCH, 7]);
  for (const r of input.records) {
    assert.deepEqual(Object.keys(r).sort(), ["end", "id", "platform", "source", "start", "value"]);
    assert.equal(r.source, WATCH);
    assert.match(r.start, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
  for (const s of input.steps ?? []) assert.deepEqual([Object.keys(s).sort(), s.provenance], [["count", "local_date", "provenance"], "EXPORT_SINGLE_SOURCE"]);
  assert.deepEqual((input.steps ?? []).map((s) => s.local_date), ["2026-11-09", "2026-11-10", "2026-11-11"], "ngày không có bản ghi thì không có dòng: thiếu, không phải 0");
  const garmin = importToHealthInput(buildImport(await scanImport(fixture("garmin-sleep.json"), { nowMs: NOW }), GARMIN_SOURCE, NOW), { nowMs: NOW, zone: HCM, revision: 1 });
  for (const r of garmin.records) assert.deepEqual([Object.keys(r).sort(), r.platform], [["end", "id", "platform", "source", "start", "type"], "android"], "phiên không có stages");
  // Thời gian trôi: cửa sổ trượt, bản ghi cũ không còn được đưa vào thuật toán.
  const later = importToHealthInput(held, { nowMs: NOW + 12 * DAY, zone: HCM, revision: 7 });
  assert.deepEqual([later.records.length, later.steps?.length], [0, 0]);
  assert.throws(() => importToHealthInput(held, { nowMs: NOW, zone: "Mars/Base", revision: 1 }), RangeError);
  assert.deepEqual(describeImport(held, { nowMs: NOW, zone: HCM }), { sleep_observed_days: 3, sleep_unknown_days: 0, steps_days: 3, flags: 1 });
});

test("tệp không đọc được bị từ chối bằng mã rõ ràng, không đoán", async () => {
  await rejects(pieces(""), "EMPTY");
  await rejects([Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0)], "ZIP_NOT_SUPPORTED");
  await rejects([Uint8Array.of(0xff, 0xfe, 0x3c, 0x00, 0x48, 0x00)], "ENCODING");
  await rejects(pieces("bước chân hôm nay: 5000"), "UNRECOGNIZED");
  await rejects(pieces("<html><body>HealthData</body></html>"), "UNRECOGNIZED", NOW);
  await rejects(pieces("<!-- HealthData -->\n<Other/>"), "UNRECOGNIZED");
  await rejects(pieces(doc(record("steps", WATCH, "2026-11-10 08:00:00 +0700", "2026-11-10 08:10:00 +0700", "5")).slice(0, -40)), "MALFORMED");
  await rejects(pieces(`<HealthData locale="vi_VN">\n<Record type="HKQuantityTypeIdentifierStepCount" sourceName="${"y".repeat(LIMITS.maxTagChars + 10)}`), "MALFORMED");
  await rejects(pieces("com.samsung.shealth.activity.day_summary,1,2\n"), "UNRECOGNIZED");
  await rejects(pieces("com.samsung.shealth.activity.day_summary,1,2\nday,steps\n1,2\n"), "UNRECOGNIZED");
  await rejects(pieces('[{"sleepStartTimestampGMT":"2026-11-09T15:28:00.0"'), "MALFORMED");
  await rejects(pieces('{"sleepStartTimestampGMT":"2026-11-09T15:28:00.0","sleepEndTimestampGMT":"2026-11-09T23:30:00.0"}'), "UNRECOGNIZED");
  await rejects(pieces('[{"logId":1,"dateOfSleep":"2026-11-10","startTime":"2026-11-09T23:00:00.000"}]'), "UNRECOGNIZED");
  await rejects(pieces("[]"), "UNRECOGNIZED");
  await rejects(42, "UNREADABLE");
  await rejects(["không phải byte"], "UNREADABLE");
  await assert.rejects(scanImport(pieces("[]"), { nowMs: NaN }), RangeError);

  let sources = "";
  for (let i = 0; i <= LIMITS.maxSources; i++) sources += record("steps", `Nguồn mẫu ${i}`, "2026-11-10 08:00:00 +0700", "2026-11-10 08:10:00 +0700", "1");
  await rejects(pieces(doc(sources)), "TOO_MANY_SOURCES");
  const one = record("sleep", WATCH, "2026-11-10 01:00:00 +0700", "2026-11-10 01:01:00 +0700", "HKCategoryValueSleepAnalysisAsleepCore");
  await rejects(pieces(doc(one.repeat(LIMITS.maxSleepPerSource + 1)), 65_536), "TOO_MANY_RECORDS");
  // Tệp nhỏ có trần: một CSV lớn hơn trần bị từ chối trước khi đọc hết.
  const big = async function* () {
    yield utf8.encode("com.samsung.shealth.activity.day_summary,1,2\nstep_count,day_time\n");
    const row = utf8.encode("100,1794268800000\n".repeat(50_000));
    for (let sent = 0; sent <= LIMITS.maxSmallFileBytes; sent += row.length) yield row;
  };
  await rejects(big(), "TOO_LARGE");
  // Người dùng hủy giữa chừng.
  const abort = new AbortController();
  let read = 0;
  const slow = async function* () {
    for (const part of [doc(one).slice(0, 60), doc(one).slice(60)]) {
      read++;
      yield utf8.encode(part);
      abort.abort();
    }
  };
  await assert.rejects(scanImport(slow(), { nowMs: NOW, signal: abort.signal }), (e: unknown) => e instanceof ImportError && e.code === "ABORTED");
  assert.ok(read <= 2);
  // Tệp hợp lệ nhưng không có gì trong cửa sổ: không phải lỗi, chỉ là không có nguồn nào để chọn.
  const empty = await scanImport(pieces(doc(record("steps", WATCH, "2019-08-04 08:00:00 +0700", "2019-08-04 08:10:00 +0700", "5"))), { nowMs: NOW });
  assert.deepEqual([empty.sources, empty.suggested, empty.stats.skipped.before_window], [[], null, 1]);
});

test("đọc theo khối: Blob, ReadableStream, khối lớn được cắt nhỏ, dừng sớm thì thả nguồn", async () => {
  const sizes: number[] = [];
  for await (const c of chunksOf([new Uint8Array(LIMITS.maxChunkBytes * 2 + 5)])) sizes.push(c.byteLength);
  assert.deepEqual(sizes, [LIMITS.maxChunkBytes, LIMITS.maxChunkBytes, 5]);
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(utf8.encode("x".repeat(1000)));
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  // Dòng chảy vô hạn không phải tệp sức khỏe: bộ quét dừng ngay sau phần đầu và hủy việc đọc.
  await rejects(stream, "UNRECOGNIZED");
  assert.ok(cancelled && pulls < 10, `đã đọc ${pulls} khối`);
  const blob = new Blob([doc(record("steps", WATCH, "2026-11-10 08:00:00 +0700", "2026-11-10 08:10:00 +0700", "5"))]);
  assert.equal((await scanImport(blob, { nowMs: NOW })).sources[0].summary.step_records, 1);
});

test("tệp 50 MB được quét theo dòng chảy với bộ nhớ có trần", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "lenhip-import-"));
  const path = join(tmp, "export.xml");
  try {
    // Phần lớn tệp là loại bản ghi khác và bản ghi cũ, như một tệp xuất nhiều năm; bản ghi trong cửa sổ nằm ở đầu, giữa và cuối.
    const filler =
      `<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="${WATCH}" unit="count/min" creationDate="2021-03-04 10:00:05 +0700" startDate="2021-03-04 10:00:00 +0700" endDate="2021-03-04 10:00:00 +0700" value="60"/>\n`.repeat(40) +
      record("steps", WATCH, "2021-03-04 10:00:00 +0700", "2021-03-04 10:10:00 +0700", "321") +
      record("sleep", PHONE, "2021-03-03 23:00:00 +0700", "2021-03-04 06:00:00 +0700", "HKCategoryValueSleepAnalysisAsleep") +
      `<Workout workoutActivityType="HKWorkoutActivityTypeWalking" sourceName="${WATCH}" startDate="2021-03-04 17:30:00 +0700" endDate="2021-03-04 18:00:00 +0700"><MetadataEntry key="GhiChuMau" value="HKQuantityTypeIdentifierStepCount"/></Workout>\n`;
    const block = Buffer.from(filler.repeat(64), "utf8");
    const blocks = Math.ceil((50 * 1024 * 1024) / block.length);
    const fd = openSync(path, "w");
    writeSync(fd, `<?xml version="1.0" encoding="UTF-8"?>\n<HealthData locale="vi_VN">\n` + record("sleep", WATCH, "2026-11-09 23:00:00 +0700", "2026-11-10 07:00:00 +0700", "HKCategoryValueSleepAnalysisAsleepCore"));
    for (let i = 0; i < blocks; i++) {
      writeSync(fd, block);
      if (i === blocks >> 1) writeSync(fd, record("steps", WATCH, "2026-11-10 09:00:00 +0700", "2026-11-10 09:10:00 +0700", "4000") + record("steps", PHONE, "2026-11-10 09:00:00 +0700", "2026-11-10 09:10:00 +0700", "1"));
    }
    writeSync(fd, record("steps", WATCH, "2026-11-10 18:00:00 +0700", "2026-11-10 18:10:00 +0700", "2500") + "</HealthData>\n");
    closeSync(fd);
    const size = statSync(path).size;
    assert.ok(size >= 50 * 1024 * 1024, `tệp thử ${size} byte`);

    // Đo bộ nhớ CÒN SỐNG: ép thu gom rác rồi mới đọc số, để rác chờ thu gom không làm nhiễu phép đo.
    setFlagsFromString("--expose-gc");
    const collect = runInNewContext("gc") as () => void;
    const live = () => {
      collect();
      const m = process.memoryUsage();
      return m.heapUsed + m.external;
    };
    const chunk = 64 * 1024;
    const before = live();
    let peak = before;
    let lastBytes = 0;
    let calls = 0;
    const scan = await scanImport(createReadStream(path, { highWaterMark: chunk }), {
      nowMs: NOW,
      onProgress(bytes) {
        assert.ok(bytes > lastBytes, "tiến độ chỉ tăng");
        lastBytes = bytes;
        if (++calls % 100 === 0) peak = Math.max(peak, live());
      },
    });
    assert.equal(scan.stats.bytes, size);
    assert.equal(lastBytes, size);
    assert.ok(calls >= size / chunk, "mỗi khối được xử lý ngay khi tới, không gom lại");
    // Bộ đệm văn bản không bao giờ lớn hơn một khối cộng một thẻ dở dang: không phụ thuộc cỡ tệp.
    assert.ok(scan.stats.peak_buffer_chars <= chunk + 4096, `bộ đệm lớn nhất ${scan.stats.peak_buffer_chars} ký tự`);
    // Tệp là 50 MB (chuỗi đã giải mã còn lớn hơn); bộ nhớ còn sống trong lúc quét phải nhỏ hơn nhiều.
    assert.ok(peak - before < 8 * 1024 * 1024, `bộ nhớ còn sống tăng ${((peak - before) / 1048576).toFixed(1)} MB`);
    assert.deepEqual(scan.sources.map((s) => [s.name, s.summary.sleep_records, s.summary.step_records]), [[PHONE, 0, 1], [WATCH, 1, 2]]);
    assert.equal(scan.stats.skipped.before_window, blocks * 64 * 2);
    assert.deepEqual(day(analyse(scan, WATCH, HCM).out, "2026-11-10"), ["OBSERVED", 28800, 6500]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dữ liệu đã nhập chỉ ở bộ nhớ của trang: của đúng một người, kết thúc là hết, không có dạng nào để ghi xuống kho", async () => {
  const scan = await scanImport(fixture("apple-export-multi.xml"), { nowMs: NOW });
  const held = buildImport(scan, WATCH, NOW);
  const memory = createImportMemory();
  assert.deepEqual(Object.keys(memory).sort(), ["end", "get", "hold", "owner"], "chỉ có giữ, đọc và kết thúc: không có lưu, nạp hay xuất");
  assert.deepEqual([memory.owner(), memory.get("dev_a"), memory.end()], [null, null, false]);
  memory.hold("dev_a", held);
  assert.equal(memory.owner(), "dev_a");
  assert.equal(memory.get("dev_a"), held, "cùng một đối tượng trong bộ nhớ, không qua bước chuyển thành chuỗi nào");
  assert.equal(memory.get("dev_b"), null, "người khác trên cùng trình duyệt không đọc được");
  assert.equal(memory.get("dev_a"), held, "hỏi cho người khác không tự xóa: người gọi quyết định kết thúc");
  // Nguồn gốc giữ trong bộ nhớ: loại tệp, tên nguồn đã chọn, thời điểm nhập. Không có tên tệp, không có nguồn không được chọn.
  assert.deepEqual([held.kind, held.source, held.imported_at], ["apple_health_xml", WATCH, NOW]);
  assert.doesNotMatch(JSON.stringify(held), new RegExp(PHONE), "nguồn không được chọn không được giữ");
  // Người khác nhập: dữ liệu của người trước bị thay, không giữ hai người cùng lúc.
  const other = buildImport(scan, PHONE, NOW + 1);
  memory.hold("dev_b", other);
  assert.deepEqual([memory.owner(), memory.get("dev_a"), memory.get("dev_b")], ["dev_b", null, other]);
  assert.equal(memory.end(), true);
  assert.deepEqual([memory.owner(), memory.get("dev_b"), memory.end()], [null, null, false]);
  // Hai chỗ giữ độc lập (hai trang): cái này kết thúc không ảnh hưởng cái kia, và một chỗ giữ mới luôn rỗng (như sau khi tải lại).
  const first = createImportMemory();
  first.hold("dev_a", held);
  assert.deepEqual([createImportMemory().owner(), first.owner()], [null, "dev_a"]);
});

/** Kho giả cùng giao diện với localStorage, ghi lại mọi lần ghi. */
function fakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    map, writes,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void (writes.push(k), map.set(k, v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

test("khóa của bản dựng trước bị dọn một lần lúc nạp trang; bản này không ghi khóa nào", () => {
  assert.equal(LEGACY_STORE_PREFIX, "lenhip.trackers.");
  const storage = fakeStorage({
    "lenhip.trackers.import.v1.dev_a": '{"v":1,"kind":"apple_health_xml","source":"Đồng hồ mẫu"}',
    "lenhip.ui.v2": '{"version":2}',
    "lenhip.trackers.import.v1.dev_b": "{}",
    "lenhip.trackers.flag.v1.dev_a": "1",
    "lenhip.health.v1.dev_a": '{"receipt":{"choice":"GRANTED"},"revision":1}',
    "lenhip.trackersX": "không phải khóa của phần này",
  });
  assert.equal(purgeLegacyStore(storage), 3);
  assert.deepEqual([...storage.map.keys()].sort(), ["lenhip.health.v1.dev_a", "lenhip.trackersX", "lenhip.ui.v2"], "chỉ khóa có tiền tố của phần này bị xóa");
  assert.equal(purgeLegacyStore(storage), 0, "lần sau không còn gì để dọn");
  assert.deepEqual(storage.writes, [], "không ghi gì vào kho");
  // Trình duyệt chặn kho hoặc không có kho: không ném lỗi.
  assert.equal(purgeLegacyStore(null), 0);
  assert.equal(purgeLegacyStore(undefined), 0);
  const blocked = { get length(): number { throw new Error("blocked"); }, key: () => null, removeItem() { throw new Error("blocked"); } };
  assert.equal(purgeLegacyStore(blocked), 0);
});

test("mã của nhánh không gọi mạng và không ghi gì xuống kho của trình duyệt", () => {
  const strip = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const lib = strip("../web/shared/health-import.js");
  assert.doesNotMatch(lib, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|\bhttps?:|\bimport\s*\(/);
  assert.doesNotMatch(lib, /localStorage|sessionStorage|indexedDB|document\./);
  // Phần giao diện: chỉ đọc biên nhận đồng ý của ứng dụng (getItem) và dọn khóa cũ qua purgeLegacyStore; không có lệnh ghi nào.
  const view = strip("../web/views/connect-trackers.js");
  for (const [name, code] of [["health-import.js", lib], ["connect-trackers.js", view]] as const) {
    assert.doesNotMatch(code, /setItem|sessionStorage|indexedDB|document\.cookie|\bcaches\b|cookieStore|showSaveFilePicker|createWritable|JSON\.stringify/, `${name}: không được ghi xuống kho hay chuyển dữ liệu thành chuỗi để lưu`);
  }
  assert.equal((view.match(/localStorage/g) ?? []).length, 1, "phần giao diện chỉ lấy localStorage ở một chỗ");
  assert.deepEqual([...new Set(view.match(/storage\??\.\w+/g) ?? [])], ["storage?.getItem"], "và chỉ gọi getItem trên nó");
  assert.match(view, /purgeLegacyStore\(storage\)/);
});
