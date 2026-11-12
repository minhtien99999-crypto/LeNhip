// @ts-check
// LNH-SLEEP-1: tính thời lượng ngủ và bước chân theo ngày, chạy trên điện thoại (SRS mục 06, 07). Bản này là bản
// tham chiếu: app iOS và Android phải cho kết quả trùng từng trường trên bộ fixture contracts/fixtures/sleep/*.json.
//
// Quy tắc được chốt trong bản tham chiếu (xem docs/RA_SOAT_LENHIP_V1_1.md, LNH-T07 đến LNH-T10):
// - Mọi thời điểm là mili giây UTC nguyên; thời lượng tính trên khoảng nửa mở [start, end).
// - Một nguồn duy nhất: nguồn người dùng chọn; chưa chọn thì nguồn có đoạn asleep kết thúc muộn nhất (hòa: mã nguồn
//   nhỏ hơn theo thứ tự chuỗi) và cần người dùng xác nhận. Không gộp hai nguồn.
// - Đoạn asleep chồng hoặc chạm nhau được hợp; đoạn awake của cùng nguồn được trừ khỏi phần hợp (inBed không trừ).
// - Episode: các khối asleep cách nhau không quá 90 phút. Episode thuộc ngày local chứa thời điểm kết thúc của nó.
// - Episode dài hơn 24 giờ (từ đầu đến cuối) là lỗi dữ liệu, không tính vào ngày.
// - sleep_seconds của ngày là episode chính (asleep dài nhất, hòa thì kết thúc muộn hơn); episode khác là giấc phụ.
// - Trung bình chỉ tính trên ngày có quan sát trong 7 ngày đã kết thúc, cần ít nhất 4 ngày; hôm nay tách riêng.
// - Giây = floor(ms / 1000); trung bình = floor(tổng / số ngày + 0,5).

import { addDays, isValidZone, localDate, parseInstant } from "./zone.js";

export const ALGORITHM_VERSION = "LNH-SLEEP-1";
export const EPISODE_GAP_MS = 90 * 60_000;
export const MAX_EPISODE_MS = 24 * 3_600_000;
export const COMPLETED_DAYS = 7;
export const MIN_OBSERVED_DAYS = 4;

const IOS_ASLEEP = new Set(["asleepUnspecified", "asleepCore", "asleepDeep", "asleepREM"]);
const IOS_AWAKE = new Set(["awake"]);
const IOS_IGNORED = new Set(["inBed"]);
const ANDROID_ASLEEP = new Set(["SLEEPING", "LIGHT", "DEEP", "REM"]);
const ANDROID_AWAKE = new Set(["AWAKE", "AWAKE_IN_BED", "OUT_OF_BED"]);
const ANDROID_IGNORED = new Set(["UNKNOWN"]);

/**
 * @typedef {{ id: string, source: string, platform: "ios", value: string, start: string, end: string }} IosSample
 * @typedef {{ stage: string, start: string, end: string }} AndroidStage
 * @typedef {{ id: string, source: string, platform: "android", type: "session", start: string, end: string, stages?: AndroidStage[] }} AndroidSession
 * @typedef {IosSample | AndroidSession} SleepRecord
 * @typedef {{ local_date: string, count: number | null, provenance?: string | null }} StepsDay
 * @typedef {{ analysis_zone: string, now: string, selected_source?: string | null, source_revision: number,
 *   records: SleepRecord[], steps?: StepsDay[] }} SleepInput
 * @typedef {{ record: string, code: string }} Flag
 * @typedef {[number, number]} Span
 * @typedef {{ start: number, end: number, asleep: number, date: string, error: string | null }} Episode
 */

/**
 * @param {Span[]} spans
 * @returns {Span[]}
 */
function union(spans) {
  const sorted = spans.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {Span[]} */
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Trừ các khoảng cuts khỏi blocks (cả hai đã hợp và sắp xếp).
 * @param {Span[]} blocks
 * @param {Span[]} cuts
 * @returns {Span[]}
 */
function subtract(blocks, cuts) {
  /** @type {Span[]} */
  const out = [];
  for (const [bs, be] of blocks) {
    let cursor = bs;
    for (const [cs, ce] of cuts) {
      if (ce <= cursor || cs >= be) continue;
      if (cs > cursor) out.push([cursor, cs]);
      cursor = Math.max(cursor, ce);
      if (cursor >= be) break;
    }
    if (cursor < be) out.push([cursor, be]);
  }
  return out;
}

/**
 * @param {string} id
 * @param {unknown} start
 * @param {unknown} end
 * @param {Flag[]} flags
 * @returns {Span | null}
 */
function span(id, start, end, flags) {
  const s = parseInstant(start);
  const e = parseInstant(end);
  if (Number.isNaN(s) || Number.isNaN(e)) {
    flags.push({ record: id, code: "INVALID_TIME" });
    return null;
  }
  if (e <= s) {
    flags.push({ record: id, code: "END_NOT_AFTER_START" });
    return null;
  }
  return [s, e];
}

/**
 * Tách bản ghi của mọi nguồn thành khoảng asleep, awake và phiên không có stage.
 * @param {SleepRecord[]} records
 * @param {Flag[]} flags
 */
function classify(records, flags) {
  /** @type {Map<string, { asleep: Span[], awake: Span[], stageless: Span[] }>} */
  const bySource = new Map();
  const of = (/** @type {string} */ source) => {
    let v = bySource.get(source);
    if (!v) bySource.set(source, (v = { asleep: [], awake: [], stageless: [] }));
    return v;
  };
  for (const r of records) {
    if (!r || typeof r.id !== "string" || typeof r.source !== "string") {
      flags.push({ record: String(r && /** @type {any} */ (r).id), code: "INVALID_RECORD" });
      continue;
    }
    if (r.platform === "ios") {
      if (IOS_IGNORED.has(r.value)) continue;
      const kind = IOS_ASLEEP.has(r.value) ? "asleep" : IOS_AWAKE.has(r.value) ? "awake" : null;
      if (!kind) {
        flags.push({ record: r.id, code: "UNKNOWN_VALUE" });
        continue;
      }
      const sp = span(r.id, r.start, r.end, flags);
      if (sp) of(r.source)[kind].push(sp);
    } else if (r.platform === "android" && r.type === "session") {
      const session = span(r.id, r.start, r.end, flags);
      if (!session) continue;
      const stages = Array.isArray(r.stages) ? r.stages : [];
      if (stages.length === 0) {
        of(r.source).stageless.push(session);
        continue;
      }
      stages.forEach((st, i) => {
        const id = `${r.id}#${i}`;
        if (ANDROID_IGNORED.has(st.stage)) return;
        const kind = ANDROID_ASLEEP.has(st.stage) ? "asleep" : ANDROID_AWAKE.has(st.stage) ? "awake" : null;
        if (!kind) {
          flags.push({ record: id, code: "UNKNOWN_VALUE" });
          return;
        }
        const sp = span(id, st.start, st.end, flags);
        if (sp) of(r.source)[kind].push(sp);
      });
    } else {
      flags.push({ record: r.id, code: "UNKNOWN_PLATFORM" });
    }
  }
  return bySource;
}

/**
 * @param {Map<string, { asleep: Span[], awake: Span[], stageless: Span[] }>} bySource
 * @param {string | null | undefined} selected
 * @returns {{ id: string | null, selection: "USER" | "MOST_RECENT_NEEDS_CONFIRMATION" | "NONE" }}
 */
function chooseSource(bySource, selected) {
  if (typeof selected === "string" && selected.length) return { id: selected, selection: "USER" };
  /** @param {"asleep" | "stageless"} kind */
  const latest = (kind) => {
    /** @type {string | null} */
    let best = null;
    let bestEnd = -Infinity;
    for (const [source, v] of [...bySource.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      for (const [, e] of v[kind]) if (e > bestEnd) [best, bestEnd] = [source, e];
    }
    return best;
  };
  const id = latest("asleep") ?? latest("stageless");
  return id ? { id, selection: "MOST_RECENT_NEEDS_CONFIRMATION" } : { id: null, selection: "NONE" };
}

/**
 * @param {Span[]} blocks
 * @param {string} zone
 * @returns {Episode[]}
 */
function episodes(blocks, zone) {
  /** @type {Episode[]} */
  const out = [];
  /** @type {Episode | null} */
  let cur = null;
  for (const [s, e] of blocks) {
    if (cur && s - cur.end <= EPISODE_GAP_MS) {
      cur.end = e;
      cur.asleep += e - s;
    } else {
      if (cur) out.push(cur);
      cur = { start: s, end: e, asleep: e - s, date: "", error: null };
    }
  }
  if (cur) out.push(cur);
  for (const ep of out) {
    ep.date = localDate(ep.end, zone);
    if (ep.end - ep.start > MAX_EPISODE_MS) ep.error = "EPISODE_OVER_24H";
  }
  return out;
}

/** @param {number[]} values */
const roundedMean = (values) => Math.floor(values.reduce((a, b) => a + b, 0) / values.length + 0.5);

/**
 * Tính chuỗi HealthDay cho 7 ngày đã kết thúc và hôm nay.
 * @param {SleepInput} input
 */
export function computeHealthDays(input) {
  const zone = input.analysis_zone;
  if (!isValidZone(zone)) throw new RangeError("analysis_zone không hợp lệ");
  const now = parseInstant(input.now);
  if (Number.isNaN(now)) throw new RangeError("now không hợp lệ");
  if (!Number.isInteger(input.source_revision) || input.source_revision < 0) throw new RangeError("source_revision không hợp lệ");
  /** @type {Flag[]} */
  const flags = [];
  const bySource = classify(Array.isArray(input.records) ? input.records : [], flags);
  const source = chooseSource(bySource, input.selected_source);
  const data = (source.id && bySource.get(source.id)) || { asleep: [], awake: [], stageless: [] };
  const blocks = subtract(union(data.asleep), union(data.awake));
  const eps = episodes(blocks, zone);
  const stagelessDays = new Set(data.stageless.map(([, e]) => localDate(e, zone)));

  const today = localDate(now, zone);
  const dates = [];
  for (let i = COMPLETED_DAYS; i >= 1; i--) dates.push(addDays(today, -i));
  dates.push(today);

  /** @type {Map<string, number | null>} */
  const steps = new Map();
  for (const s of Array.isArray(input.steps) ? input.steps : []) {
    const ok = typeof s.count === "number" && Number.isInteger(s.count) && s.count >= 0 && typeof s.provenance === "string" && s.provenance.length > 0;
    steps.set(s.local_date, ok ? /** @type {number} */ (s.count) : null);
  }

  /** @type {{ local_date: string, role: "MAIN" | "SECONDARY" | "ERROR", start: string, end: string, asleep_seconds: number, error: string | null }[]} */
  const episodeRows = [];
  const rows = dates.map((date) => {
    const onDay = eps.filter((e) => e.date === date);
    const valid = onDay.filter((e) => !e.error);
    /** @type {Episode | null} */
    let main = null;
    for (const e of valid) if (!main || e.asleep > main.asleep || (e.asleep === main.asleep && e.end > main.end)) main = e;
    for (const e of onDay.slice().sort((a, b) => a.end - b.end)) {
      episodeRows.push({
        local_date: date, role: e.error ? "ERROR" : e === main ? "MAIN" : "SECONDARY",
        start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(),
        asleep_seconds: Math.floor(e.asleep / 1000), error: e.error,
      });
    }
    const status = main ? "OBSERVED" : onDay.some((e) => e.error) ? "DATA_ERROR" : stagelessDays.has(date) ? "DURATION_UNKNOWN" : "MISSING";
    return {
      local_date: date,
      zone,
      source_status: status,
      steps: steps.has(date) ? /** @type {number | null} */ (steps.get(date)) : null,
      sleep_seconds: main ? Math.floor(main.asleep / 1000) : null,
      coverage_days: 0,
      computed_at: new Date(now).toISOString(),
      algorithm_version: ALGORITHM_VERSION,
      source_revision: input.source_revision,
      complete: date !== today,
    };
  });

  const completed = rows.filter((r) => r.complete);
  const sleepObserved = completed.filter((r) => r.source_status === "OBSERVED").map((r) => /** @type {number} */ (r.sleep_seconds));
  const stepsObserved = completed.filter((r) => r.steps !== null).map((r) => /** @type {number} */ (r.steps));
  for (const r of rows) r.coverage_days = sleepObserved.length;

  return {
    algorithm_version: ALGORITHM_VERSION,
    analysis_zone: zone,
    computed_at: new Date(now).toISOString(),
    source_revision: input.source_revision,
    source,
    cache_key: [ALGORITHM_VERSION, zone, source.id ?? "-", input.source_revision, today].join("|"),
    days: rows,
    episodes: episodeRows,
    summary: {
      today,
      completed_days: COMPLETED_DAYS,
      sleep_observed_days: sleepObserved.length,
      sleep_average_seconds: sleepObserved.length >= MIN_OBSERVED_DAYS ? roundedMean(sleepObserved) : null,
      steps_observed_days: stepsObserved.length,
      steps_average: stepsObserved.length >= MIN_OBSERVED_DAYS ? roundedMean(stepsObserved) : null,
    },
    flags,
  };
}

/**
 * Câu hiển thị trung tính cho xu hướng ngủ (SRS mục 10), không suy ra bệnh.
 * @param {{ sleep_observed_days: number, sleep_average_seconds: number | null }} summary
 */
export function sleepSentence(summary) {
  if (summary.sleep_average_seconds === null) {
    return `Mới có ${summary.sleep_observed_days} trong 7 ngày có dữ liệu ngủ, cần ít nhất ${MIN_OBSERVED_DAYS} ngày để tính trung bình.`;
  }
  return `Trong ${summary.sleep_observed_days} ngày có dữ liệu, thời lượng ngủ trung bình là ${formatDuration(summary.sleep_average_seconds)}.`;
}

/**
 * Cùng câu trung tính với sleepSentence() ở dạng khóa catalog + tham số, để giao diện dựng câu theo ngôn ngữ đang chọn
 * (LNH-T22) mà không phân tích lại câu tiếng Việt. Điều kiện chọn câu giống hệt sleepSentence(); `durationMinutes` là thời
 * lượng trung bình đã làm tròn xuống phút như formatDuration(), null khi chưa đủ ngày. Thuật toán LNH-SLEEP-1 không đổi.
 * @param {{ sleep_observed_days: number, sleep_average_seconds: number | null }} summary
 * @returns {{ key: string, params: Record<string, number>, durationMinutes: number | null }}
 */
export function sleepMessage(summary) {
  if (summary.sleep_average_seconds === null) {
    return { key: "health.sleep.sentence.insufficient", params: { n: summary.sleep_observed_days, total: COMPLETED_DAYS, min: MIN_OBSERVED_DAYS }, durationMinutes: null };
  }
  return { key: "health.sleep.sentence.average", params: { n: summary.sleep_observed_days }, durationMinutes: Math.floor(summary.sleep_average_seconds / 60) };
}

/** @param {number} seconds */
export function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} phút`;
  return r ? `${h} giờ ${r} phút` : `${h} giờ`;
}
