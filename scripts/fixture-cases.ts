// Đầu vào và phép kiểm của bộ fixture LNH-SLEEP-1. S01–S08 theo SRS mục 07 (S06–S08 là phần "gói kỹ thuật có thêm"),
// S09–S16 bổ sung các nhánh của quy tắc 1–5 mà fixture SRS chưa phủ. Phép kiểm (checks) viết tay từ chữ của SRS, không lấy
// từ kết quả chương trình.
import { zonedToInstant } from "../web/shared/zone.js";
import type { SleepInput } from "../web/shared/sleep.js";

const HCM = "Asia/Ho_Chi_Minh";
const NOW = "2026-11-11T03:00:00.000Z"; // 10:00 ngày 11/11 tại HCM: hôm nay = 2026-11-11, bảy ngày đã kết thúc 04/11–10/11

/** Giờ local của múi zone (ngày YYYY-MM-DD, giờ HH:MM) sang RFC 3339 UTC. */
const at = (date: string, hhmm: string, zone = HCM) => new Date(zonedToInstant(date, hhmm, zone)).toISOString();
const ios = (id: string, value: string, start: string, end: string, source = "watch") => ({ id, source, platform: "ios" as const, value, start, end });

export type Check =
  | { day: string; sleep_seconds?: number | null; source_status?: string; steps?: number | null }
  | { episodes_on: string; roles: { role: string; asleep_seconds: number }[] }
  | { summary: Record<string, unknown> }
  | { source: { id: string | null; selection: string } }
  | { flags: { record: string; code: string }[] }
  | { cache_key_differs_from_case: number };

export interface SleepCase {
  id: string;
  title: string;
  srs: string;
  cases: { input: SleepInput; checks: Check[] }[];
}

const base = (records: SleepInput["records"], extra: Partial<SleepInput> = {}): SleepInput => ({
  analysis_zone: HCM, now: NOW, selected_source: "watch", source_revision: 1, records, ...extra,
});

export const SLEEP_CASES: SleepCase[] = [
  {
    id: "S01", title: "Ngủ 23:00–07:00, thức 02:00–02:30", srs: "7,5 giờ asleep, gán ngày thức dậy.",
    cases: [{
      input: base([ios("a1", "asleepCore", at("2026-11-09", "23:00"), at("2026-11-10", "07:00")), ios("w1", "awake", at("2026-11-10", "02:00"), at("2026-11-10", "02:30"))]),
      checks: [{ day: "2026-11-10", sleep_seconds: 27000, source_status: "OBSERVED" }, { day: "2026-11-09", sleep_seconds: null, source_status: "MISSING" }],
    }],
  },
  {
    id: "S02", title: "Hai đoạn asleep chồng nhau cùng nguồn", srs: "7 giờ, không cộng trùng thành 8 giờ.",
    cases: [{
      input: base([ios("a1", "asleepCore", at("2026-11-09", "23:00"), at("2026-11-10", "03:00")), ios("a2", "asleepDeep", at("2026-11-10", "02:00"), at("2026-11-10", "06:00"))]),
      checks: [{ day: "2026-11-10", sleep_seconds: 25200 }],
    }],
  },
  {
    id: "S03", title: "Chỉ có inBed 22:00–07:00", srs: "sleep_seconds=null, ngày thiếu.",
    cases: [{
      input: base([ios("b1", "inBed", at("2026-11-09", "22:00"), at("2026-11-10", "07:00"))]),
      checks: [{ day: "2026-11-10", sleep_seconds: null, source_status: "MISSING" }, { summary: { sleep_observed_days: 0, sleep_average_seconds: null } }],
    }],
  },
  {
    id: "S04", title: "Giấc đêm 7 giờ và giấc trưa 30 phút", srs: "Phiên chính 7 giờ, giấc phụ 0,5 giờ.",
    cases: [{
      input: base([ios("a1", "asleepCore", at("2026-11-09", "23:00"), at("2026-11-10", "06:00")), ios("n1", "asleepUnspecified", at("2026-11-10", "13:00"), at("2026-11-10", "13:30"))]),
      checks: [
        { day: "2026-11-10", sleep_seconds: 25200 },
        { episodes_on: "2026-11-10", roles: [{ role: "MAIN", asleep_seconds: 25200 }, { role: "SECONDARY", asleep_seconds: 1800 }] },
      ],
    }],
  },
  {
    id: "S05", title: "Đổi analysis_zone và xóa một đoạn nguồn", srs: "Tính lại ngày/episode, tăng revision, loại cache cũ.",
    cases: [
      {
        input: base([
          ios("a1", "asleepCore", at("2026-11-08", "22:00"), at("2026-11-09", "05:00")),
          ios("n1", "asleepCore", at("2026-11-09", "22:00"), at("2026-11-09", "23:30")),
        ], { source_revision: 4 }),
        checks: [{ day: "2026-11-09", sleep_seconds: 25200 }, { episodes_on: "2026-11-09", roles: [{ role: "MAIN", asleep_seconds: 25200 }, { role: "SECONDARY", asleep_seconds: 5400 }] }],
      },
      {
        // Người dùng đổi sang Asia/Tokyo (+09) và nguồn xóa đoạn a1: đoạn n1 kết thúc 01:30 ngày 10/11 giờ Tokyo.
        input: base([ios("n1", "asleepCore", at("2026-11-09", "22:00"), at("2026-11-09", "23:30"))], { analysis_zone: "Asia/Tokyo", source_revision: 5 }),
        checks: [
          { day: "2026-11-09", sleep_seconds: null, source_status: "MISSING" },
          { day: "2026-11-10", sleep_seconds: 5400, source_status: "OBSERVED" },
          { cache_key_differs_from_case: 0 },
        ],
      },
    ],
  },
  {
    id: "S06", title: "Đêm chuyển giờ mùa hè (Europe/Berlin, 29/03/2026)", srs: "Gói kỹ thuật: S06 DST.",
    cases: [{
      input: {
        analysis_zone: "Europe/Berlin", now: "2026-03-30T10:00:00.000Z", selected_source: "watch", source_revision: 1,
        records: [ios("a1", "asleepCore", at("2026-03-28", "23:00", "Europe/Berlin"), at("2026-03-29", "07:00", "Europe/Berlin"))],
      },
      checks: [{ day: "2026-03-29", sleep_seconds: 25200 }],
    }],
  },
  {
    id: "S07", title: "Cùng khoảng UTC, múi Asia/Ho_Chi_Minh", srs: "Gói kỹ thuật: S07/S08 cùng khoảng UTC nhưng khác analysis_zone.",
    cases: [{
      input: base([ios("a1", "asleepCore", "2026-11-09T16:00:00.000Z", "2026-11-09T23:30:00.000Z")], { now: "2026-11-11T12:00:00.000Z" }),
      checks: [{ day: "2026-11-10", sleep_seconds: 27000 }, { day: "2026-11-09", sleep_seconds: null }],
    }],
  },
  {
    id: "S08", title: "Cùng khoảng UTC, múi America/Los_Angeles", srs: "Gói kỹ thuật: S07/S08 cùng khoảng UTC nhưng khác analysis_zone.",
    cases: [{
      input: base([ios("a1", "asleepCore", "2026-11-09T16:00:00.000Z", "2026-11-09T23:30:00.000Z")], { analysis_zone: "America/Los_Angeles", now: "2026-11-11T12:00:00.000Z" }),
      checks: [{ day: "2026-11-09", sleep_seconds: 27000 }, { day: "2026-11-10", sleep_seconds: null }],
    }],
  },
  {
    id: "S09", title: "Phiên Android không có stage", srs: "Quy tắc 2: session không có stage được đánh dấu DURATION_UNKNOWN.",
    cases: [{
      input: base([{ id: "s1", source: "band", platform: "android", type: "session", start: at("2026-11-09", "22:00"), end: at("2026-11-10", "06:00"), stages: [] }], { selected_source: "band" }),
      checks: [{ day: "2026-11-10", sleep_seconds: null, source_status: "DURATION_UNKNOWN" }],
    }],
  },
  {
    id: "S10", title: "Phiên Android có stage, có thức và rời giường", srs: "Quy tắc 2–3: chỉ stage asleep, trừ AWAKE/OUT_OF_BED.",
    cases: [{
      input: base([{
        id: "s1", source: "band", platform: "android", type: "session", start: at("2026-11-09", "23:00"), end: at("2026-11-10", "06:30"),
        stages: [
          { stage: "LIGHT", start: at("2026-11-09", "23:00"), end: at("2026-11-10", "01:00") },
          { stage: "AWAKE", start: at("2026-11-10", "01:00"), end: at("2026-11-10", "01:20") },
          { stage: "DEEP", start: at("2026-11-10", "01:20"), end: at("2026-11-10", "03:00") },
          { stage: "REM", start: at("2026-11-10", "03:00"), end: at("2026-11-10", "04:00") },
          { stage: "OUT_OF_BED", start: at("2026-11-10", "04:00"), end: at("2026-11-10", "04:10") },
          { stage: "LIGHT", start: at("2026-11-10", "04:10"), end: at("2026-11-10", "06:30") },
        ],
      }], { selected_source: "band" }),
      checks: [{ day: "2026-11-10", sleep_seconds: 25200 }, { episodes_on: "2026-11-10", roles: [{ role: "MAIN", asleep_seconds: 25200 }] }],
    }],
  },
  {
    id: "S11", title: "Mẫu end≤start và episode quá 24 giờ", srs: "Quy tắc 3–4: bỏ mẫu end≤start, giữ cờ lỗi; episode quá 24 giờ gắn lỗi dữ liệu.",
    cases: [{
      input: base([
        ios("z1", "asleepCore", at("2026-11-09", "23:00"), at("2026-11-09", "23:00")),
        ios("x1", "asleepCore", at("2026-11-06", "22:00"), at("2026-11-07", "23:00")),
      ]),
      checks: [
        { day: "2026-11-07", sleep_seconds: null, source_status: "DATA_ERROR" },
        { flags: [{ record: "z1", code: "END_NOT_AFTER_START" }] },
        { episodes_on: "2026-11-07", roles: [{ role: "ERROR", asleep_seconds: 90000 }] },
      ],
    }],
  },
  {
    id: "S12", title: "Hai nguồn không gộp", srs: "Quy tắc 1: một nguồn; chưa chọn thì nguồn asleep mới nhất và cần xác nhận.",
    cases: [
      {
        input: base([
          ios("w1", "asleepCore", at("2026-11-09", "23:00"), at("2026-11-10", "06:00"), "watch"),
          ios("p1", "asleepUnspecified", at("2026-11-09", "22:30"), at("2026-11-10", "06:30"), "phone"),
        ], { selected_source: null }),
        checks: [{ source: { id: "phone", selection: "MOST_RECENT_NEEDS_CONFIRMATION" } }, { day: "2026-11-10", sleep_seconds: 28800 }],
      },
      {
        input: base([
          ios("w1", "asleepCore", at("2026-11-09", "23:00"), at("2026-11-10", "06:00"), "watch"),
          ios("p1", "asleepUnspecified", at("2026-11-09", "22:30"), at("2026-11-10", "06:30"), "phone"),
        ], { selected_source: "watch" }),
        checks: [{ source: { id: "watch", selection: "USER" } }, { day: "2026-11-10", sleep_seconds: 25200 }],
      },
    ],
  },
  {
    id: "S13", title: "Xu hướng 7 ngày: tối thiểu 4 ngày, tách hôm nay", srs: "Quy tắc 5.",
    cases: [
      {
        input: base([
          ios("d05", "asleepCore", at("2026-11-04", "23:00"), at("2026-11-05", "06:00")),
          ios("d06", "asleepCore", at("2026-11-05", "23:30"), at("2026-11-06", "06:30")),
          ios("d08", "asleepCore", at("2026-11-07", "22:30"), at("2026-11-08", "06:30")),
          ios("d09", "asleepCore", at("2026-11-08", "23:00"), at("2026-11-09", "06:15")),
          ios("d10", "asleepCore", at("2026-11-09", "23:15"), at("2026-11-10", "06:00")),
          ios("d11", "asleepCore", at("2026-11-10", "23:00"), at("2026-11-11", "08:00")),
        ]),
        checks: [
          // 25200 + 25200 + 28800 + 26100 + 24300 = 129600 giây trên 5 ngày; đêm 10→11/11 thuộc hôm nay, không tính.
          { summary: { sleep_observed_days: 5, sleep_average_seconds: 25920, today: "2026-11-11" } },
          { day: "2026-11-11", sleep_seconds: 32400 },
          { day: "2026-11-04", sleep_seconds: null, source_status: "MISSING" },
        ],
      },
      {
        input: base([
          ios("d05", "asleepCore", at("2026-11-04", "23:00"), at("2026-11-05", "06:00")),
          ios("d06", "asleepCore", at("2026-11-05", "23:30"), at("2026-11-06", "06:30")),
          ios("d10", "asleepCore", at("2026-11-09", "23:15"), at("2026-11-10", "06:00")),
        ]),
        checks: [{ summary: { sleep_observed_days: 3, sleep_average_seconds: null } }],
      },
    ],
  },
  {
    id: "S14", title: "Bước chân: null khác 0", srs: "Mục 06: null/không sample là thiếu; 0 có provenance hợp lệ là 0 quan sát.",
    cases: [{
      input: base([], {
        steps: [
          { local_date: "2026-11-05", count: 0, provenance: "PLATFORM_AGGREGATE" },
          { local_date: "2026-11-06", count: null, provenance: "PLATFORM_AGGREGATE" },
          { local_date: "2026-11-07", count: 0, provenance: null },
          { local_date: "2026-11-08", count: 5000, provenance: "PLATFORM_AGGREGATE" },
          { local_date: "2026-11-09", count: 4200, provenance: "PLATFORM_AGGREGATE" },
          { local_date: "2026-11-10", count: 6100, provenance: "PLATFORM_AGGREGATE" },
        ],
      }),
      checks: [
        { day: "2026-11-05", steps: 0 }, { day: "2026-11-06", steps: null }, { day: "2026-11-07", steps: null }, { day: "2026-11-04", steps: null },
        { summary: { steps_observed_days: 4, steps_average: 3825 } },
      ],
    }],
  },
  {
    id: "S15", title: "Hai episode bằng nhau trong một ngày", srs: "Quy tắc 4: hòa thì chọn kết thúc muộn hơn.",
    cases: [{
      input: base([ios("e1", "asleepCore", at("2026-11-10", "00:00"), at("2026-11-10", "03:00")), ios("e2", "asleepCore", at("2026-11-10", "13:00"), at("2026-11-10", "16:00"))]),
      checks: [{ episodes_on: "2026-11-10", roles: [{ role: "SECONDARY", asleep_seconds: 10800 }, { role: "MAIN", asleep_seconds: 10800 }] }],
    }],
  },
  {
    id: "S16", title: "Khoảng trống đúng 90 phút và 91 phút", srs: "Quy tắc 3: gom episode khi khoảng trống ≤ 90 phút; đoạn chạm nhau được hợp.",
    cases: [{
      input: base([
        ios("a1", "asleepCore", at("2026-11-09", "22:00"), at("2026-11-10", "00:00")),
        ios("a2", "asleepDeep", at("2026-11-10", "00:00"), at("2026-11-10", "01:00")),
        ios("a3", "asleepCore", at("2026-11-10", "02:30"), at("2026-11-10", "06:00")),
        ios("a4", "asleepREM", at("2026-11-10", "07:31"), at("2026-11-10", "08:00")),
      ]),
      checks: [{ episodes_on: "2026-11-10", roles: [{ role: "MAIN", asleep_seconds: 23400 }, { role: "SECONDARY", asleep_seconds: 1740 }] }],
    }],
  },
];
