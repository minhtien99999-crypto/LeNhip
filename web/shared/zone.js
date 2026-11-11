// @ts-check
// Ngày và giờ theo múi IANA, không thư viện ngoài. Thời điểm luôn là mili giây UTC; ngày local là chuỗi YYYY-MM-DD.

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatters = new Map();

/**
 * @param {string} zone
 * @returns {Intl.DateTimeFormat}
 */
function formatter(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    formatters.set(zone, f);
  }
  return f;
}

/**
 * @param {unknown} zone
 * @returns {zone is string}
 */
export function isValidZone(zone) {
  if (typeof zone !== "string" || zone.length < 1 || zone.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zone)) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Các thành phần giờ local của một thời điểm.
 * @param {number} ms
 * @param {string} zone
 */
export function localParts(ms, zone) {
  /** @type {Record<string, string>} */
  const p = {};
  for (const part of formatter(zone).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
    weekday: /** @type {number} */ (WEEKDAYS[/** @type {keyof typeof WEEKDAYS} */ (p.weekday)]),
  };
}

/**
 * @param {number} n
 * @param {number} width
 */
const pad = (n, width = 2) => String(n).padStart(width, "0");

/**
 * Ngày local (YYYY-MM-DD) chứa thời điểm ms trong múi zone.
 * @param {number} ms
 * @param {string} zone
 */
export function localDate(ms, zone) {
  const p = localParts(ms, zone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * Độ lệch của múi so với UTC tại thời điểm ms, tính bằng mili giây.
 * @param {number} ms
 * @param {string} zone
 */
export function zoneOffset(ms, zone) {
  const p = localParts(ms, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Thời điểm UTC của giờ tường local date + HH:MM trong múi zone. Giờ rơi vào khoảng nhảy DST lấy thời điểm sau nhảy;
 * giờ lặp lại lấy lần đầu.
 * @param {string} date YYYY-MM-DD
 * @param {string} hhmm HH:MM
 * @param {string} zone
 */
export function zonedToInstant(date, hhmm, zone) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!d || !t) throw new RangeError("Ngày hoặc giờ không hợp lệ");
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  let guess = wall - zoneOffset(wall, zone);
  const second = wall - zoneOffset(guess, zone);
  if (second !== guess) {
    const alt = wall - zoneOffset(second, zone);
    guess = alt === second ? second : Math.max(guess, second);
  }
  const earlier = guess - 3600_000;
  if (earlier + zoneOffset(earlier, zone) === wall) return earlier;
  return guess;
}

/**
 * Cộng n ngày vào một ngày local (lịch Gregory, không phụ thuộc múi).
 * @param {string} date
 * @param {number} n
 */
export function addDays(date, n) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) throw new RangeError("Ngày không hợp lệ");
  const t = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Thứ trong tuần của ngày local (0 = Chủ nhật).
 * @param {string} date
 */
export function weekdayOf(date) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!d) throw new RangeError("Ngày không hợp lệ");
  return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]))).getUTCDay();
}

/**
 * Phân tích RFC 3339 có múi (Z hoặc ±hh:mm); trả mili giây UTC hoặc NaN.
 * @param {unknown} s
 */
export function parseInstant(s) {
  if (typeof s !== "string") return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se, frac, tz] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59 || Number(se) > 59) return NaN;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
  const check = new Date(ms);
  if (check.getUTCDate() !== Number(d)) return NaN;
  if (frac) ms += Math.floor(Number(frac) * 1000);
  if (tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const [oh, om] = tz.slice(1).split(":").map(Number);
    if (oh > 23 || om > 59) return NaN;
    ms -= sign * (oh * 60 + om) * 60_000;
  }
  return ms;
}

/**
 * RFC 3339 UTC có mili giây.
 * @param {number} ms
 */
export function iso(ms) {
  return new Date(ms).toISOString();
}
