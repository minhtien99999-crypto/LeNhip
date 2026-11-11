// @ts-check
// Bộ dữ liệu sức khỏe TỔNG HỢP cho bản web (SRS mục 10: lập trình bằng dữ liệu tổng hợp trước G1-H). Trình duyệt không đọc được
// HealthKit/Health Connect; app native thay hàm này bằng HealthSource.queryDays(). Dữ liệu sinh xác định theo ngày, có hai đêm
// thiếu, một đêm có đoạn thức, một giấc trưa và một ngày thiếu bước chân, để màn hình luôn thể hiện đủ các trạng thái.

import { addDays, localDate, zonedToInstant } from "./zone.js";

/** @param {string} s */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * @param {number} nowMs
 * @param {string} zone
 * @param {number} revision
 * @returns {import("./sleep.js").SleepInput}
 */
export function syntheticHealthInput(nowMs, zone, revision = 1) {
  const today = localDate(nowMs, zone);
  /** @type {import("./sleep.js").SleepRecord[]} */
  const records = [];
  /** @type {import("./sleep.js").StepsDay[]} */
  const steps = [];
  const iso = (/** @type {number} */ ms) => new Date(ms).toISOString();
  for (let i = 7; i >= 0; i--) {
    const day = addDays(today, -i);
    const h = hash(day);
    const missing = i === 3 || i === 6;
    if (!missing) {
      const bedMin = 22 * 60 + 30 + (h % 75);
      const sleepMin = 6 * 60 + 25 + ((h >>> 8) % 95);
      const start = zonedToInstant(addDays(day, -1), "00:00", zone) + bedMin * 60_000;
      const end = start + sleepMin * 60_000;
      if (end <= nowMs) {
        records.push({ id: `syn-${day}-n`, source: "web-tong-hop", platform: "ios", value: "asleepCore", start: iso(start), end: iso(end) });
        if (i === 2) {
          const w = start + 3 * 3600_000;
          records.push({ id: `syn-${day}-w`, source: "web-tong-hop", platform: "ios", value: "awake", start: iso(w), end: iso(w + 25 * 60_000) });
        }
      }
    }
    if (i === 1) {
      const nap = zonedToInstant(day, "13:10", zone);
      records.push({ id: `syn-${day}-nap`, source: "web-tong-hop", platform: "ios", value: "asleepUnspecified", start: iso(nap), end: iso(nap + 25 * 60_000) });
    }
    steps.push({ local_date: day, count: i === 4 ? null : 3200 + (h % 5200), provenance: i === 4 ? null : "PLATFORM_AGGREGATE" });
  }
  return { analysis_zone: zone, now: iso(nowMs), selected_source: "web-tong-hop", source_revision: revision, records, steps };
}
