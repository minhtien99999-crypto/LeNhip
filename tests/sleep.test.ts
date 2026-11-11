// T03 (phần chạy được không cần máy thật): golden fixture LNH-SLEEP-1, phép kiểm theo chữ của SRS và kết quả đầy đủ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { computeHealthDays, sleepSentence, formatDuration } from "../web/shared/sleep.js";
import { SLEEP_CASES, type Check } from "../scripts/fixture-cases.ts";

const dir = new URL("../contracts/fixtures/sleep/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

type Output = ReturnType<typeof computeHealthDays>;

function applyCheck(out: Output, check: Check, all: Output[]) {
  if ("day" in check) {
    const row = out.days.find((d) => d.local_date === check.day);
    assert.ok(row, `thiếu ngày ${check.day}`);
    for (const k of ["sleep_seconds", "source_status", "steps"] as const) {
      if (k in check) assert.equal(row[k], (check as Record<string, unknown>)[k], `${check.day}.${k}`);
    }
  } else if ("episodes_on" in check) {
    const got = out.episodes.filter((e) => e.local_date === check.episodes_on).map((e) => ({ role: e.role, asleep_seconds: e.asleep_seconds }));
    assert.deepEqual(got, check.roles);
  } else if ("summary" in check) {
    for (const [k, v] of Object.entries(check.summary)) assert.equal((out.summary as Record<string, unknown>)[k], v, `summary.${k}`);
  } else if ("source" in check) {
    assert.deepEqual(out.source, check.source);
  } else if ("flags" in check) {
    assert.deepEqual(out.flags, check.flags);
  } else if ("cache_key_differs_from_case" in check) {
    assert.notEqual(out.cache_key, all[check.cache_key_differs_from_case].cache_key);
  }
}

test("mọi fixture có trong danh sách ca và ngược lại", () => {
  assert.deepEqual(files, SLEEP_CASES.map((c) => `${c.id}.json`));
});

for (const file of files) {
  test(`fixture ${file}: kết quả đầy đủ và phép kiểm theo SRS`, () => {
    const fx = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    const outs: Output[] = [];
    for (const c of fx.cases) {
      const out = computeHealthDays(c.input);
      outs.push(out);
      assert.deepEqual(out, c.expected, "kết quả khác fixture đã duyệt");
      for (const check of c.checks) applyCheck(out, check, outs);
    }
  });
}

test("phép kiểm trong fixture khớp phép kiểm viết tay của scripts/fixture-cases.ts", () => {
  for (const fx of SLEEP_CASES) {
    const doc = JSON.parse(readFileSync(new URL(`${fx.id}.json`, dir), "utf8"));
    assert.deepEqual(doc.cases.map((c: { checks: unknown }) => c.checks), fx.cases.map((c) => c.checks), fx.id);
    assert.deepEqual(doc.cases.map((c: { input: unknown }) => c.input), JSON.parse(JSON.stringify(fx.cases.map((c) => c.input))), fx.id);
  }
});

test("từ chối múi, thời điểm và revision không hợp lệ", () => {
  const ok = { analysis_zone: "Asia/Ho_Chi_Minh", now: "2026-11-11T03:00:00Z", source_revision: 0, records: [] };
  assert.throws(() => computeHealthDays({ ...ok, analysis_zone: "Mars/Base" }), RangeError);
  assert.throws(() => computeHealthDays({ ...ok, analysis_zone: "../etc" }), RangeError);
  assert.throws(() => computeHealthDays({ ...ok, now: "2026-11-11 03:00" }), RangeError);
  assert.throws(() => computeHealthDays({ ...ok, source_revision: -1 }), RangeError);
});

test("câu hiển thị trung tính và định dạng thời lượng", () => {
  assert.equal(formatDuration(27000), "7 giờ 30 phút");
  assert.equal(formatDuration(25200), "7 giờ");
  assert.equal(formatDuration(1740), "29 phút");
  assert.equal(sleepSentence({ sleep_observed_days: 5, sleep_average_seconds: 25920 }), "Trong 5 ngày có dữ liệu, thời lượng ngủ trung bình là 7 giờ 12 phút.");
  assert.match(sleepSentence({ sleep_observed_days: 3, sleep_average_seconds: null }), /cần ít nhất 4 ngày/);
});
