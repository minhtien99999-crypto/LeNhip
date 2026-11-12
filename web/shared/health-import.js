// @ts-check
// Nhập tệp xuất của chính người dùng, phân tích ngay trên thiết bị (LNH-T55). Chạy trên trình duyệt lẫn Node; tệp này không
// gọi mạng. Ba loại tệp có bộ đọc, mọi loại khác nằm trong danh mục ở trạng thái «chưa hỗ trợ» (web/shared/tracker-registry.js):
//   apple_health_xml   export.xml của ứng dụng Sức khỏe (Apple): bước chân và giấc ngủ, có khoảng thời gian
//   samsung_steps_csv  com.samsung.shealth.activity.day_summary.*.csv: tổng bước chân theo ngày
//   garmin_sleep_json  *_sleepData.json: phiên ngủ chỉ có tổng theo giai đoạn, không có khoảng → DURATION_UNKNOWN
// Kết quả là đúng dạng đầu vào của computeHealthDays() (web/shared/sleep.js). Giới hạn của HealthSource v1 được giữ: chỉ bước
// chân và giấc ngủ, cửa sổ 7 ngày đã kết thúc cộng hôm nay, MỘT nguồn do người dùng chọn, không gộp nguồn.
// Dữ liệu đã nhập CHỈ nằm trong bộ nhớ của trang đang mở (SRS mục 11: mẫu chỉ ở RAM, LNH-T55). Tệp này không ghi gì xuống kho
// của trình duyệt: không mẫu, không tổng theo ngày, không tên tệp, tên nguồn, thời điểm nhập hay cờ nào. Tải lại hoặc đóng
// trang là mất; muốn xem lại thì nhập lại tệp.
//
// Quy tắc chuyển đổi của bộ đọc (đứng trước LNH-SLEEP-1, không đổi thuật toán):
// - Apple, ngày giờ: "YYYY-MM-DD HH:MM:SS ±HHMM" là một thời điểm chính xác; độ lệch trong tệp không dùng làm múi phân tích.
// - Apple, giấc ngủ: …AsleepCore/Deep/REM/Unspecified → asleepCore/asleepDeep/asleepREM/asleepUnspecified; …Asleep (giá trị cũ)
//   → asleepUnspecified; …Awake → awake; …InBed → inBed (thuật toán bỏ qua). Giá trị lạ giữ nguyên để thuật toán gắn cờ
//   UNKNOWN_VALUE.
// - Apple, bước chân: chỉ cộng bản ghi của nguồn đã chọn. Một bản ghi thuộc ngày local chứa mili giây cuối cùng của nó
//   (end − 1 ms), không chia theo tỷ lệ. Giữ theo ô 15 phút UTC để tính lại được khi đổi múi phân tích (mọi múi hiện hành lệch
//   UTC một bội số của 15 phút). Tổng này có thể khác số trong ứng dụng Sức khỏe, vốn gộp nhiều nguồn theo thứ tự ưu tiên.
// - Samsung, bước chân: `day_time` là mili giây. Đúng nửa đêm UTC thì coi là ngày theo lịch đó (cách ghi được mô tả nhưng CHƯA
//   kiểm với tệp thật); khác thì là ngày local chứa thời điểm ấy. Một ngày có nhiều dòng với số khác nhau là dữ liệu thiếu:
//   không cộng, không chọn.
// - Garmin, giấc ngủ: thời điểm GMT không có hậu tố, thêm Z. Mục UNCONFIRMED và mục không có giây ngủ nào bị bỏ. Các tổng theo
//   giai đoạn KHÔNG được đọc thành thời lượng và không được giữ lại: phiên không có khoảng → DURATION_UNKNOWN.
// Chưa tệp xuất thật nào được kiểm ở đây (LNH-D16): fixture trong contracts/fixtures/import/ là dữ liệu tổng hợp.
import { computeHealthDays } from "./sleep.js";
import { addDays, isValidZone, localDate, parseInstant, zonedToInstant } from "./zone.js";

const DAY_MS = 86_400_000;
/**
 * Tiền tố khóa localStorage của các bản dựng trước, vốn ghi dữ liệu đã nhập xuống kho của trình duyệt. Bản này không ghi khóa
 * nào; purgeLegacyStore() xóa khóa cũ còn sót, một lần lúc nạp trang.
 */
export const LEGACY_STORE_PREFIX = "lenhip.trackers.";
/** Bản ghi kết thúc trước (now − WINDOW_DAYS ngày) không được đọc: 7 ngày đã kết thúc, hôm nay, và phần đệm khi đổi múi. */
export const WINDOW_DAYS = 10;
export const STEP_BUCKET_MS = 15 * 60_000;
export const LIMITS = Object.freeze({
  /** Một thẻ XML chưa đóng dài hơn ngần này ký tự là tệp hỏng; nhờ vậy bộ đệm không bao giờ lớn theo cỡ tệp. */
  maxTagChars: 65_536,
  maxChunkBytes: 1_048_576,
  maxSources: 50,
  maxSleepPerSource: 4_000,
  maxSourceNameChars: 120,
  /** Tệp CSV và JSON được đọc trọn vào bộ nhớ nên có trần. */
  maxSmallFileBytes: 20 * 1_048_576,
  maxRows: 100_000,
});
export const PROVENANCE_SINGLE_SOURCE = "EXPORT_SINGLE_SOURCE";
export const PROVENANCE_DAILY_TOTAL = "EXPORT_DAILY_TOTAL";
/** Mã nguồn cố định cho tệp không ghi tên nguồn. Là mã, không phải chữ hiển thị. */
export const SAMSUNG_SOURCE = "samsung-health-export";
export const GARMIN_SOURCE = "garmin-export";

/**
 * Các bộ đọc có trong bản này. Danh mục thiết bị theo dõi chỉ được dẫn tới một khóa của bảng này.
 * `durations`: bộ đọc có cho LNH-SLEEP-1 khoảng ngủ để tính thời lượng không.
 */
export const IMPORTERS = Object.freeze({
  apple_health_xml: Object.freeze({ steps: true, sleep: true, durations: true, streaming: true }),
  samsung_steps_csv: Object.freeze({ steps: true, sleep: false, durations: false, streaming: false }),
  garmin_sleep_json: Object.freeze({ steps: false, sleep: true, durations: false, streaming: false }),
});

/**
 * @typedef {keyof typeof IMPORTERS} ImportKind
 * @typedef {"UNREADABLE" | "EMPTY" | "ZIP_NOT_SUPPORTED" | "ENCODING" | "UNRECOGNIZED" | "MALFORMED" | "TOO_LARGE"
 *   | "TOO_MANY_RECORDS" | "TOO_MANY_SOURCES" | "ABORTED" | "UNKNOWN_SOURCE"} ImportErrorCode
 * @typedef {[value: string, startMs: number, endMs: number]} SleepTuple
 * @typedef {[startMs: number, endMs: number]} SessionTuple
 * @typedef {[bucket: number, count: number]} BucketTuple
 * @typedef {[dayTimeMs: number, count: number]} DayTuple
 * @typedef {{ name: string, sleep: SleepTuple[], sessions: SessionTuple[], buckets: BucketTuple[], days: DayTuple[],
 *   summary: { sleep_records: number, asleep_records: number, sessions: number, step_records: number, step_days: number, latest_ms: number | null } }} ScannedSource
 * @typedef {{ kind: ImportKind, now_ms: number, window_start_ms: number, sources: ScannedSource[], suggested: string | null,
 *   stats: { bytes: number, peak_buffer_chars: number, matched: number, skipped: Record<string, number> } }} ScanResult
 * @typedef {{ kind: ImportKind, source: string, imported_at: number, sleep: SleepTuple[], sessions: SessionTuple[],
 *   buckets: BucketTuple[], days: DayTuple[] }} HeldImport
 *   Dữ liệu của một nguồn đã chọn. Chỉ tồn tại trong bộ nhớ của trang; không có dạng nào của nó được ghi xuống kho.
 */

/** Lỗi có mã; giao diện dịch mã thành câu. Thông điệp không bao giờ chứa nội dung tệp. */
export class ImportError extends Error {
  /** @param {ImportErrorCode} code */
  constructor(code) {
    super(code);
    this.name = "ImportError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- đọc theo khối

/**
 * Các khối byte của một nguồn: File/Blob (dùng stream()), ReadableStream, hoặc bất kỳ thứ gì lặp được ra Uint8Array.
 * Khối lớn hơn LIMITS.maxChunkBytes được cắt nhỏ để chuỗi đã giải mã không bao giờ lớn theo cỡ tệp.
 * @param {unknown} source
 * @returns {AsyncGenerator<Uint8Array, void, void>}
 */
export async function* chunksOf(source) {
  /** @type {any} */
  let s = source;
  if (s && typeof s.stream === "function") s = s.stream();
  /** @param {unknown} chunk */
  const split = function* (chunk) {
    if (!(chunk instanceof Uint8Array)) throw new ImportError("UNREADABLE");
    for (let o = 0; o < chunk.byteLength; o += LIMITS.maxChunkBytes) yield chunk.subarray(o, Math.min(chunk.byteLength, o + LIMITS.maxChunkBytes));
  };
  if (s && typeof s.getReader === "function") {
    const reader = s.getReader();
    let done = false;
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) {
          done = true;
          return;
        }
        yield* split(step.value);
      }
    } finally {
      if (!done) await reader.cancel().catch(() => {}); // dừng giữa chừng: thả tệp ra
      reader.releaseLock?.();
    }
  }
  if (s && (typeof s[Symbol.asyncIterator] === "function" || typeof s[Symbol.iterator] === "function")) {
    for await (const chunk of s) yield* split(chunk);
    return;
  }
  throw new ImportError("UNREADABLE");
}

/**
 * Nhận loại tệp từ các byte đầu. Không dựa vào tên tệp.
 * @param {Uint8Array} head
 * @returns {ImportKind | "json" | "zip" | "utf16" | "unknown"}
 */
export function detectKind(head) {
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return "zip";
  if (head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) return "utf16";
  const text = new TextDecoder("utf-8").decode(head.subarray(0, 4096)).replace(/^\s+/, "");
  if (text.startsWith("<")) return text.includes("HealthData") ? "apple_health_xml" : "unknown";
  if (text.startsWith("com.samsung.shealth.activity.day_summary")) return "samsung_steps_csv";
  if (text.startsWith("[") || text.startsWith("{")) return "json";
  return "unknown";
}

// ---------------------------------------------------------------- Apple Health export.xml

const STEP_TYPE = "HKQuantityTypeIdentifierStepCount";
const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";
/** Giá trị trong tệp xuất → giá trị của IosSample. `…Asleep` là giá trị cũ, trước khi có các giai đoạn. */
export const APPLE_SLEEP_VALUES = Object.freeze({
  HKCategoryValueSleepAnalysisInBed: "inBed",
  HKCategoryValueSleepAnalysisAsleep: "asleepUnspecified",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleepUnspecified",
  HKCategoryValueSleepAnalysisAsleepCore: "asleepCore",
  HKCategoryValueSleepAnalysisAsleepDeep: "asleepDeep",
  HKCategoryValueSleepAnalysisAsleepREM: "asleepREM",
  HKCategoryValueSleepAnalysisAwake: "awake",
});
const IOS_ASLEEP = new Set(["asleepUnspecified", "asleepCore", "asleepDeep", "asleepREM"]);
const RECORD_TAG = /<Record\s((?:[^"'>]|"[^"]*"|'[^']*')*)>/y;
const ANY_TAG = /<(?:[^"'>]|"[^"]*"|'[^']*')*>/y;
const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const APPLE_DATE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/;
const ENTITY = /&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#x([0-9A-Fa-f]{1,6}));/g;
const NAMED = /** @type {Record<string, string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });

/**
 * Ngày giờ của tệp xuất Apple → mili giây UTC, hoặc NaN.
 * @param {unknown} s
 */
export function appleInstant(s) {
  const m = typeof s === "string" ? APPLE_DATE.exec(s) : null;
  return m ? parseInstant(`${m[1]}T${m[2]}${m[3]}:${m[4]}`) : NaN;
}

/** @param {string} s */
function unescapeXml(s) {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY, (all, name, dec, hex) => {
    if (name) return NAMED[name];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : all;
  });
}

/** Chuỗi con của V8 giữ cả khối văn bản gốc; chép ra chuỗi mới để tên nguồn không níu bộ đệm của tệp. @param {string} s */
const detached = (s) => Array.from(s).join("");

/** @param {string} body phần giữa `<Record ` và `>` */
function attributes(body) {
  /** @type {Record<string, string>} */
  const out = Object.create(null);
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(body); m; m = ATTRIBUTE.exec(body)) out[m[1]] = m[2] ?? m[3];
  return out;
}

/** Thẻ (hoặc chú thích, CDATA, chỉ thị) bắt đầu ở `i` đã đóng trong `buffer` chưa. @param {string} buffer @param {number} i */
function tagComplete(buffer, i) {
  if (buffer.startsWith("<!--", i)) return buffer.includes("-->", i + 4);
  if (buffer.startsWith("<![CDATA[", i)) return buffer.includes("]]>", i + 9);
  if (buffer.startsWith("<?", i)) return buffer.includes("?>", i + 2);
  ANY_TAG.lastIndex = i;
  return ANY_TAG.test(buffer);
}

/**
 * @typedef {{ name: string, sleep: SleepTuple[], asleep: number, sessions: SessionTuple[], buckets: Map<number, number>,
 *   days: DayTuple[], stepRecords: number, latest: number }} Collector
 */

/** @param {Map<string, Collector>} sources @param {string} rawName @param {Record<string, number>} skipped */
function collectorFor(sources, rawName, skipped) {
  const name = unescapeXml(rawName).trim();
  if (!name || name.length > LIMITS.maxSourceNameChars) {
    skipped.bad_source++;
    return null;
  }
  let c = sources.get(name);
  if (!c) {
    if (sources.size >= LIMITS.maxSources) throw new ImportError("TOO_MANY_SOURCES");
    const own = detached(name);
    sources.set(own, (c = { name: own, sleep: [], asleep: 0, sessions: [], buckets: new Map(), days: [], stepRecords: 0, latest: -Infinity }));
  }
  return c;
}

/**
 * Quét export.xml theo dòng chảy: chỉ tìm thẻ <Record> của hai loại cần đọc, không dựng cây XML và không giữ cả tệp.
 * Bộ đệm chỉ chứa khối đang đọc và một thẻ chưa đóng ở cuối khối.
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {{ nowMs: number, windowStart: number, signal?: AbortSignal | null, onProgress?: ((bytes: number) => void) | null }} o
 */
async function scanApple(chunks, o) {
  const decoder = new TextDecoder("utf-8");
  /** @type {Map<string, Collector>} */
  const sources = new Map();
  /** @type {Record<string, number>} */
  const skipped = { before_window: 0, future: 0, bad_date: 0, bad_value: 0, bad_source: 0 };
  let matched = 0;
  let bytes = 0;
  let peak = 0;
  let sawRoot = false;

  /** @param {Record<string, string>} a */
  const spanInWindow = (a) => {
    const start = appleInstant(a.startDate);
    const end = appleInstant(a.endDate);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      skipped.bad_date++;
      return null;
    }
    if (end <= o.windowStart) {
      skipped.before_window++;
      return null;
    }
    if (start > o.nowMs) {
      skipped.future++;
      return null;
    }
    return { start, end };
  };
  /** @param {Record<string, string>} a */
  const onSteps = (a) => {
    const span = spanInWindow(a);
    if (!span) return;
    if (span.end < span.start || !/^\d{1,9}(?:\.0+)?$/.test(a.value ?? "")) {
      skipped.bad_value++;
      return;
    }
    const c = collectorFor(sources, a.sourceName ?? "", skipped);
    if (!c) return;
    const at = span.end > span.start ? span.end - 1 : span.end;
    const bucket = Math.floor(at / STEP_BUCKET_MS);
    c.buckets.set(bucket, (c.buckets.get(bucket) ?? 0) + Math.trunc(Number(a.value)));
    c.stepRecords++;
    if (span.end > c.latest) c.latest = span.end;
    matched++;
  };
  /** @param {Record<string, string>} a */
  const onSleep = (a) => {
    const span = spanInWindow(a);
    if (!span) return;
    const c = collectorFor(sources, a.sourceName ?? "", skipped);
    if (!c) return;
    if (c.sleep.length >= LIMITS.maxSleepPerSource) throw new ImportError("TOO_MANY_RECORDS");
    const raw = a.value ?? "";
    const value = Object.hasOwn(APPLE_SLEEP_VALUES, raw) ? APPLE_SLEEP_VALUES[/** @type {keyof typeof APPLE_SLEEP_VALUES} */ (raw)] : detached(raw.slice(0, 80));
    c.sleep.push([value, span.start, span.end]);
    if (IOS_ASLEEP.has(value)) c.asleep++;
    if (span.end > c.latest) c.latest = span.end;
    matched++;
  };
  /** @type {[string, (a: Record<string, string>) => void][]} */
  const needles = [[STEP_TYPE, onSteps], [SLEEP_TYPE, onSleep]];

  /** Xử lý mọi thẻ đã trọn trong bộ đệm, trả phần đuôi chưa trọn. @param {string} buffer @param {boolean} final */
  const consume = (buffer, final) => {
    let cut = buffer.length;
    const last = buffer.lastIndexOf("<");
    if (last !== -1 && !tagComplete(buffer, last)) cut = last;
    if (buffer.length - cut > LIMITS.maxTagChars) throw new ImportError("MALFORMED");
    if (!sawRoot && buffer.lastIndexOf("<HealthData", cut) !== -1) sawRoot = true;
    for (const [needle, handle] of needles) {
      let p = buffer.indexOf(needle);
      while (p !== -1 && p < cut) {
        const start = buffer.lastIndexOf("<", p);
        RECORD_TAG.lastIndex = start;
        const m = start === -1 ? null : RECORD_TAG.exec(buffer);
        if (m && RECORD_TAG.lastIndex <= cut) {
          const a = attributes(m[1]);
          if (a.type === needle) handle(a);
          p = buffer.indexOf(needle, Math.max(RECORD_TAG.lastIndex, p + needle.length));
        } else {
          p = buffer.indexOf(needle, p + needle.length);
        }
      }
    }
    if (final && cut < buffer.length) throw new ImportError("MALFORMED"); // tệp kết thúc giữa một thẻ
    return buffer.slice(cut);
  };

  let buffer = "";
  for await (const chunk of chunks) {
    if (o.signal?.aborted) throw new ImportError("ABORTED");
    bytes += chunk.byteLength;
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > peak) peak = buffer.length;
    buffer = consume(buffer, false);
    o.onProgress?.(bytes);
  }
  consume(buffer + decoder.decode(), true);
  if (!sawRoot) throw new ImportError("UNRECOGNIZED");

  /** @type {ScannedSource[]} */
  const list = [...sources.values()].map((c) => ({
    name: c.name,
    sleep: c.sleep,
    sessions: [],
    buckets: /** @type {BucketTuple[]} */ ([...c.buckets.entries()].sort((x, y) => x[0] - y[0])),
    days: [],
    summary: { sleep_records: c.sleep.length, asleep_records: c.asleep, sessions: 0, step_records: c.stepRecords, step_days: 0, latest_ms: Number.isFinite(c.latest) ? c.latest : null },
  }));
  return { sources: list, stats: { bytes, peak_buffer_chars: peak, matched, skipped } };
}

// ---------------------------------------------------------------- tệp nhỏ: Samsung CSV, Garmin JSON

/**
 * Đọc trọn một tệp văn bản nhỏ, có trần.
 * @param {AsyncIterable<Uint8Array>} chunks
 * @param {{ signal?: AbortSignal | null, onProgress?: ((bytes: number) => void) | null }} o
 */
async function readSmallText(chunks, o) {
  const decoder = new TextDecoder("utf-8");
  let text = "";
  let bytes = 0;
  for await (const chunk of chunks) {
    if (o.signal?.aborted) throw new ImportError("ABORTED");
    bytes += chunk.byteLength;
    if (bytes > LIMITS.maxSmallFileBytes) throw new ImportError("TOO_LARGE");
    text += decoder.decode(chunk, { stream: true });
    o.onProgress?.(bytes);
  }
  return { text: text + decoder.decode(), bytes };
}

/** Một dòng CSV theo RFC 4180 (dấu phẩy, ngoặc kép, "" là một dấu ngoặc kép). @param {string} line */
export function csvCells(line) {
  /** @type {string[]} */
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/**
 * Samsung Health, tệp tổng hợp hoạt động theo ngày: dòng đầu là dòng mô tả, dòng hai là tên cột, cần `day_time` và `step_count`.
 * @param {string} text
 * @param {{ nowMs: number, windowStart: number }} o
 */
function scanSamsung(text, o) {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length < 2) throw new ImportError("UNRECOGNIZED");
  if (lines.length > LIMITS.maxRows) throw new ImportError("TOO_LARGE");
  const header = csvCells(lines[1]).map((h) => h.trim());
  const column = (/** @type {string} */ name) => header.findIndex((h) => h === name || h.endsWith("." + name));
  const dayAt = column("day_time");
  const stepsAt = column("step_count");
  if (dayAt === -1 || stepsAt === -1) throw new ImportError("UNRECOGNIZED");
  /** @type {Record<string, number>} */
  const skipped = { before_window: 0, future: 0, bad_row: 0 };
  /** @type {DayTuple[]} */
  const days = [];
  for (let i = 2; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = csvCells(lines[i]);
    const day = (cells[dayAt] ?? "").trim();
    const steps = (cells[stepsAt] ?? "").trim();
    if (!/^\d{10,15}$/.test(day) || !/^\d{1,9}$/.test(steps)) {
      skipped.bad_row++;
      continue;
    }
    const ms = Number(day);
    if (ms + DAY_MS <= o.windowStart) skipped.before_window++;
    else if (ms > o.nowMs + DAY_MS) skipped.future++;
    else days.push([ms, Number(steps)]);
  }
  days.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {ScannedSource[]} */
  const sources = days.length
    ? [{ name: SAMSUNG_SOURCE, sleep: [], sessions: [], buckets: [], days, summary: { sleep_records: 0, asleep_records: 0, sessions: 0, step_records: days.length, step_days: new Set(days.map((d) => d[0])).size, latest_ms: days[days.length - 1][0] } }]
    : [];
  return { sources, matched: days.length, skipped };
}

/**
 * Garmin, tệp giấc ngủ: mảng các mục có sleepStartTimestampGMT và sleepEndTimestampGMT. Chỉ lấy hai thời điểm đó.
 * @param {string} text
 * @param {{ nowMs: number, windowStart: number }} o
 */
function scanGarmin(text, o) {
  /** @type {unknown} */
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ImportError("MALFORMED");
  }
  if (!Array.isArray(doc)) throw new ImportError("UNRECOGNIZED");
  if (doc.length > LIMITS.maxRows) throw new ImportError("TOO_LARGE");
  const isEntry = (/** @type {any} */ e) => e !== null && typeof e === "object" && typeof e.sleepStartTimestampGMT === "string" && typeof e.sleepEndTimestampGMT === "string";
  if (!doc.some(isEntry)) throw new ImportError("UNRECOGNIZED");
  /** @type {Record<string, number>} */
  const skipped = { before_window: 0, future: 0, bad_date: 0, unconfirmed: 0, no_sleep: 0, not_entry: 0 };
  /** @type {SessionTuple[]} */
  const sessions = [];
  const seconds = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  for (const e of doc) {
    if (!isEntry(e)) {
      skipped.not_entry++;
      continue;
    }
    if (e.sleepWindowConfirmationType === "UNCONFIRMED") {
      skipped.unconfirmed++;
      continue;
    }
    // Chỉ để biết có giấc ngủ hay không; ba tổng này không được đọc thành thời lượng và không được giữ lại (LNH-T55).
    if (seconds(e.deepSleepSeconds) + seconds(e.lightSleepSeconds) + seconds(e.remSleepSeconds) === 0) {
      skipped.no_sleep++;
      continue;
    }
    const start = parseInstant(e.sleepStartTimestampGMT + "Z");
    const end = parseInstant(e.sleepEndTimestampGMT + "Z");
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) skipped.bad_date++;
    else if (end <= o.windowStart) skipped.before_window++;
    else if (start > o.nowMs) skipped.future++;
    else sessions.push([start, end]);
  }
  if (sessions.length > LIMITS.maxSleepPerSource) throw new ImportError("TOO_MANY_RECORDS");
  sessions.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {ScannedSource[]} */
  const sources = sessions.length
    ? [{ name: GARMIN_SOURCE, sleep: [], sessions, buckets: [], days: [], summary: { sleep_records: 0, asleep_records: 0, sessions: sessions.length, step_records: 0, step_days: 0, latest_ms: Math.max(...sessions.map((s) => s[1])) } }]
    : [];
  return { sources, matched: sessions.length, skipped };
}

// ---------------------------------------------------------------- quét một tệp

/**
 * Quét một tệp xuất: nhận loại, đọc theo dòng chảy, gom theo nguồn. Chưa giữ gì; người dùng còn phải chọn một nguồn.
 * `sources` rỗng nghĩa là tệp hợp lệ nhưng không có bước chân hay giấc ngủ trong cửa sổ.
 * @param {unknown} source File, Blob, ReadableStream hoặc nguồn lặp ra Uint8Array
 * @param {{ nowMs: number, signal?: AbortSignal | null, onProgress?: ((bytes: number) => void) | null }} options
 * @returns {Promise<ScanResult>}
 */
export async function scanImport(source, options) {
  const nowMs = options.nowMs;
  if (!Number.isFinite(nowMs)) throw new RangeError("nowMs không hợp lệ");
  const o = { nowMs, windowStart: nowMs - WINDOW_DAYS * DAY_MS, signal: options.signal ?? null, onProgress: options.onProgress ?? null };
  const stream = chunksOf(source);
  /** @type {Uint8Array[]} */
  const head = [];
  let headBytes = 0;
  // Gom đủ 4096 byte đầu (hoặc hết tệp) để nhận loại, rồi đọc tiếp từ chính dòng chảy đó.
  while (headBytes < 4096) {
    const step = await stream.next();
    if (step.done) break;
    head.push(step.value);
    headBytes += step.value.byteLength;
  }
  if (headBytes === 0) throw new ImportError("EMPTY");
  const first = new Uint8Array(Math.min(headBytes, 4096 + 4));
  for (let i = 0, at = 0; i < head.length && at < first.length; i++) {
    first.set(head[i].subarray(0, first.length - at), at);
    at += head[i].byteLength;
  }
  const detected = detectKind(first);
  const all = (async function* () {
    yield* head.splice(0);
    yield* stream;
  })();
  try {
    if (detected === "zip") throw new ImportError("ZIP_NOT_SUPPORTED");
    if (detected === "utf16") throw new ImportError("ENCODING");
    if (detected === "unknown") throw new ImportError("UNRECOGNIZED");
    /** @type {ImportKind} */
    let kind;
    /** @type {ScannedSource[]} */
    let sources;
    /** @type {ScanResult["stats"]} */
    let stats;
    if (detected === "apple_health_xml") {
      kind = detected;
      ({ sources, stats } = await scanApple(all, o));
    } else {
      const { text, bytes } = await readSmallText(all, o);
      const found = detected === "samsung_steps_csv" ? scanSamsung(text, o) : scanGarmin(text, o);
      kind = detected === "samsung_steps_csv" ? detected : "garmin_sleep_json";
      sources = found.sources;
      stats = { bytes, peak_buffer_chars: text.length, matched: found.matched, skipped: found.skipped };
    }
    sources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind, now_ms: nowMs, window_start_ms: o.windowStart, sources, suggested: suggestSource(sources), stats };
  } finally {
    await all.return(undefined);
    await stream.return(undefined);
  }
}

/**
 * Nguồn gợi ý sẵn trong ô chọn: nguồn có dữ liệu ngủ kết thúc muộn nhất, không có thì nguồn có dữ liệu mới nhất (hòa: tên nhỏ
 * hơn theo thứ tự chuỗi). Chỉ là gợi ý: người dùng vẫn phải tự xác nhận một nguồn (SRS mục 07).
 * @param {ScannedSource[]} sources
 */
function suggestSource(sources) {
  /** @type {string | null} */
  let best = null;
  let bestKey = [-1, -Infinity];
  for (const s of sources.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const sleepEnd = Math.max(-Infinity, ...s.sleep.filter((r) => IOS_ASLEEP.has(r[0])).map((r) => r[2]), ...s.sessions.map((r) => r[1]));
    const key = Number.isFinite(sleepEnd) ? [1, sleepEnd] : [0, s.summary.latest_ms ?? -Infinity];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) [best, bestKey] = [s.name, key];
  }
  return best;
}

// ---------------------------------------------------------------- dữ liệu đã nhập (chỉ trong bộ nhớ)

/**
 * Dữ liệu của MỘT nguồn đã chọn, ở dạng gọn để giữ trong bộ nhớ của trang. Nguồn khác trong tệp bị bỏ, không gộp.
 * @param {ScanResult} scan
 * @param {string} sourceName
 * @param {number} nowMs
 * @returns {HeldImport}
 */
export function buildImport(scan, sourceName, nowMs) {
  const chosen = scan.sources.find((s) => s.name === sourceName);
  if (!chosen) throw new ImportError("UNKNOWN_SOURCE");
  return { kind: scan.kind, source: chosen.name, imported_at: nowMs, sleep: chosen.sleep.slice(), sessions: chosen.sessions.slice(), buckets: chosen.buckets.slice(), days: chosen.days.slice() };
}

/**
 * Dữ liệu đã nhập → đúng dạng đầu vào của computeHealthDays(). Bước chân được tính lại theo múi phân tích hiện tại; ngày không
 * có bản ghi nào thì không có dòng (thiếu, không phải 0).
 * @param {HeldImport} held
 * @param {{ nowMs: number, zone: string, revision: number }} q
 * @returns {import("./sleep.js").SleepInput}
 */
export function importToHealthInput(held, q) {
  if (!isValidZone(q.zone)) throw new RangeError("múi phân tích không hợp lệ");
  const from = q.nowMs - WINDOW_DAYS * DAY_MS;
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  /** @type {import("./sleep.js").SleepRecord[]} */
  const records = [];
  held.sleep.forEach(([value, start, end], i) => {
    if (end > from) records.push({ id: `ah-${i}`, source: held.source, platform: "ios", value, start: iso(start), end: iso(end) });
  });
  held.sessions.forEach(([start, end], i) => {
    if (end > from) records.push({ id: `gm-${i}`, source: held.source, platform: "android", type: "session", start: iso(start), end: iso(end) });
  });
  const today = localDate(q.nowMs, q.zone);
  /** @type {import("./sleep.js").StepsDay[]} */
  const steps = [];
  if (held.buckets.length) {
    for (let i = 7; i >= 0; i--) {
      const date = addDays(today, -i);
      const lo = zonedToInstant(date, "00:00", q.zone);
      const hi = zonedToInstant(addDays(date, 1), "00:00", q.zone);
      let sum = 0;
      let seen = false;
      for (const [bucket, count] of held.buckets) {
        const at = bucket * STEP_BUCKET_MS;
        if (at >= lo && at < hi) {
          sum += count;
          seen = true;
        }
      }
      if (seen) steps.push({ local_date: date, count: sum, provenance: PROVENANCE_SINGLE_SOURCE });
    }
  }
  if (held.days.length) {
    /** @type {Map<string, Set<number>>} */
    const byDate = new Map();
    for (const [ms, count] of held.days) {
      const date = ms % DAY_MS === 0 ? iso(ms).slice(0, 10) : localDate(ms, q.zone);
      byDate.set(date, (byDate.get(date) ?? new Set()).add(count));
    }
    for (const [date, counts] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (counts.size === 1) steps.push({ local_date: date, count: /** @type {number} */ ([...counts][0]), provenance: PROVENANCE_DAILY_TOTAL });
    }
  }
  return { analysis_zone: q.zone, now: iso(q.nowMs), selected_source: held.source, source_revision: q.revision, records, steps };
}

/**
 * LeNhip thấy gì trong dữ liệu đã nhập, đếm theo ngày (7 ngày đã kết thúc và hôm nay). Chỉ số ngày, không có số đo.
 * @param {HeldImport} held
 * @param {{ nowMs: number, zone: string }} q
 */
export function describeImport(held, q) {
  const out = computeHealthDays(importToHealthInput(held, { ...q, revision: 0 }));
  return {
    sleep_observed_days: out.days.filter((d) => d.source_status === "OBSERVED").length,
    sleep_unknown_days: out.days.filter((d) => d.source_status === "DURATION_UNKNOWN").length,
    steps_days: out.days.filter((d) => d.steps !== null).length,
    flags: out.flags.length,
  };
}

// ---------------------------------------------------------------- bộ nhớ của trang

/**
 * Chỗ giữ dữ liệu đã nhập của lượt mở trang này: CHỈ là một biến trong bộ nhớ, của đúng một người đăng nhập (SRS mục 11: mẫu
 * chỉ ở RAM). Từ đây không có đường nào xuống localStorage, sessionStorage, IndexedDB, cookie hay Cache API, và không có đường
 * nào ra mạng; tải lại hoặc đóng trang là mất. Người gọi kết thúc dữ liệu (`end`) khi người khác đăng nhập, khi cờ `trackers`
 * tắt, khi đồng ý «Sức khỏe» trên thiết bị không còn, và khi người dùng bấm xóa.
 */
export function createImportMemory() {
  /** @type {{ sub: string, data: HeldImport } | null} */
  let held = null;
  return {
    /** Người đang có dữ liệu đã nhập, hoặc null. */
    owner: () => (held ? held.sub : null),
    /** Dữ liệu đã nhập của đúng người này, hoặc null. @param {string} sub */
    get: (sub) => (held && held.sub === sub ? held.data : null),
    /** Thay dữ liệu đang giữ (của bất kỳ ai) bằng dữ liệu vừa nhập của người này. @param {string} sub @param {HeldImport} data */
    hold(sub, data) {
      held = { sub, data };
    },
    /** Bỏ dữ liệu đang giữ. Trả true nếu trước đó có dữ liệu. */
    end() {
      const had = held !== null;
      held = null;
      return had;
    },
  };
}

/**
 * Xóa mọi khóa mà các bản dựng trước để lại trong kho của trình duyệt (dữ liệu đã nhập và cờ đi kèm). Gọi một lần lúc nạp
 * trang; bản này không bao giờ ghi lại các khóa đó. Trả số khóa đã xóa.
 * @param {{ length: number, key(index: number): string | null, removeItem(key: string): void } | null | undefined} storage
 */
export function purgeLegacyStore(storage) {
  try {
    if (!storage) return 0;
    /** @type {string[]} */
    const keys = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (typeof key === "string" && key.startsWith(LEGACY_STORE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
    return keys.length;
  } catch {
    return 0; // kho bị chặn: không đọc được nên cũng không có gì để dọn
  }
}
