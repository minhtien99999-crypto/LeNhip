// Le‑NodeHealth phép đo (N20‑MEAS, LNH-T67, ca X08, X09) qua API thật: ma trận cổng, nhập bằng danh tính adapter mô phỏng, ánh xạ
// do chính người được đo xác nhận, cách ly khi mơ hồ, chống trùng hai tầng, phát lại idempotent, grant chia sẻ, xuất, xóa, restore,
// quét byte. Mọi phép đo là dữ liệu tổng hợp; «adapter» là hai danh tính mô phỏng của dữ liệu mẫu, không phải adapter được duyệt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMAS } from "../src/server/app.ts";
import { MESSAGES } from "../src/core/errors.ts";
import { MEAS_LIMITS, SIM_ADAPTERS, measurements } from "../src/server/measurements.ts";
import { MODULES } from "../src/server/modules.ts";
import { applyRevocations, backupLedger, restoreLedgerFile } from "../src/server/recovery.ts";
import { all, one, run } from "../src/server/store.ts";
import { harness, key, T0, WS, type Harness } from "./helpers.ts";

/** Có trường nào mang đúng giá trị đo này không (số, hay chuỗi chỉ gồm số đó). Không so chuỗi JSON thô: mã ngẫu nhiên có thể chứa
 * các chữ số giống giá trị đo. */
const holdsValue = (v: unknown, n: number): boolean =>
  v === n || v === String(n) || (typeof v === "object" && v !== null && Object.values(v).some((x) => holdsValue(x, n)));

const PHONE: string = SIM_ADAPTERS[0].principal_sub;
const CLOUD: string = SIM_ADAPTERS[1].principal_sub;
const MIN = 60_000;
const valid = (schema: string, body: unknown) => assert.deepEqual(SCHEMAS.validate(schema, body), [], `${schema}: ${JSON.stringify(body)}`);
const count = (h: Harness, table: string, where = "1 = 1", ...args: (string | number)[]) => (one<{ n: number }>(h.app.ctx.db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args) as { n: number }).n;
const consent = (h: Harness, sub: string, choice: "GRANTED" | "DECLINED" = "GRANTED") =>
  h.call("POST", "/v1/consents", { sub, body: { purpose_id: "measurements", text_version: "v1-2026-11-12", text_hash: "A".repeat(43), choice } });
const flag = (h: Harness, enabled: boolean) => h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "measurements", enabled, reason: "kiểm cổng phép đo" } });
/** Giờ Hà Nội có độ lệch, `ago` phút trước đồng hồ tay. */
const vnAt = (h: Harness, ago: number) => {
  const d = new Date(h.clock.now() - ago * MIN + 7 * 3600_000).toISOString().slice(0, 19);
  return `${d}+07:00`;
};
let seq = 0;
const reading = (h: Harness, o: Partial<{ source_key: string; device_ref: string; user_slot: number | null; subject_hint: string | null; measured_at: string; zone: string | null; systolic: number; diastolic: number; quality_flags: string[] }> = {}) => ({
  source_key: o.source_key ?? `k${++seq}`, device_ref: o.device_ref ?? "cuff_shared", user_slot: o.user_slot === undefined ? 1 : o.user_slot, subject_hint: o.subject_hint ?? null,
  measured_at: o.measured_at ?? vnAt(h, 10 + seq), zone: o.zone ?? null, systolic: o.systolic ?? 121, diastolic: o.diastolic ?? 79, unit: "mmHg", quality_flags: o.quality_flags ?? [],
});
const imp = (h: Harness, items: unknown[], sub = PHONE, k?: string) => h.call("POST", "/v2/health/observations/import", { sub, body: { observations: items }, key: k });
const one1 = async (h: Harness, item: unknown, sub = PHONE) => {
  const r = await imp(h, [item], sub);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  valid("MeasImportResponse", r.body);
  return r.body.results[0];
};
const obsOf = async (h: Harness, sub: string) => (await h.call("GET", "/v2/health/observations", { sub })).body.observations as { observation_id: string; systolic: number; measured_at: string }[];
const mappingsOf = async (h: Harness, sub: string) => (await h.call("GET", "/v2/health/mappings", { sub })).body.mappings as { mapping_id: string; state: string; user_slot: number }[];
const quarantineOf = async (h: Harness, sub: string) => (await h.call("GET", "/v2/health/quarantine", { sub })).body.records as { record_id: string; reason: string; candidates: number }[];

/** Người `sub` bật đồng ý rồi xác nhận ánh xạ (máy, hồ sơ) mà adapter đề nghị qua một phép đo có subject_hint. */
async function pairPerson(h: Harness, sub: string, device: string, slot: number | null) {
  const r = await one1(h, reading(h, { device_ref: device, user_slot: slot, subject_hint: sub }));
  assert.equal(r.result, "QUARANTINED");
  assert.equal(r.reason, "MAPPING_UNCONFIRMED");
  const m = (await mappingsOf(h, sub)).find((x) => x.state === "MEASMAP_PROPOSED") as { mapping_id: string };
  const c = await h.call("POST", `/v2/health/mappings/${m.mapping_id}/confirm`, { sub });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  return { mapping_id: m.mapping_id, first: r.record_ref as string, confirm: c.body };
}

async function ready(opts: { consents?: string[] } = {}) {
  const h = await harness();
  for (const sub of opts.consents ?? ["dev_a", "dev_b"]) assert.equal((await consent(h, sub)).status, 201);
  return h;
}

test("mô-đun đã đăng ký; dữ liệu mẫu tạo hai adapter mô phỏng và quyền measurements.record cho dev_a, dev_b, KHÔNG cấp sẵn đồng ý; mã lỗi mới có câu tiếng Việt", async () => {
  assert.ok(MODULES.includes(measurements));
  const h = await harness();
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(all(h.app.ctx.db, "SELECT adapter_id, trust, status FROM meas_adapters ORDER BY adapter_id"))),
      [{ adapter_id: "mad_sim_cloud", trust: "SIMULATED", status: "APPROVED" }, { adapter_id: "mad_sim_phone", trust: "SIMULATED", status: "APPROVED" }]);
    assert.equal(count(h, "grants", "scope = 'measurements.record'"), 2);
    assert.equal(count(h, "consents", "purpose_id = 'measurements'"), 0);
    const first = await h.call("GET", "/v2/health/observations");
    assert.equal(first.status, 403);
    assert.equal(first.body.code, "CONSENT_REQUIRED");
    await h.restart();
    assert.equal(count(h, "meas_adapters") + count(h, "grants", "scope = 'measurements.record'"), 4, "seed không nhân đôi");
    for (const code of Object.keys(measurements.errors ?? {})) assert.match(MESSAGES[code] ?? "", /[à-ỹ]/i, code);
    assert.equal((await h.call("GET", "/v1/me")).body.modules.measurements, true);
  } finally {
    await h.close();
  }
});

test("cổng trên mọi route của người dùng: thành viên (404) → cờ (503) → quyền (403) → đồng ý (403); xuất và xóa chỉ cần thành viên và cờ", async () => {
  const h = await ready({ consents: ["dev_a"] });
  try {
    const gets = ["/v2/health/observations", "/v2/health/mappings", "/v2/health/quarantine"];
    for (const p of gets) {
      assert.equal((await h.call("GET", p)).status, 200, p);
      assert.equal((await h.call("GET", p, { ws: "ws_other" })).status, 404, `${p} workspace khác`);
      assert.equal((await h.call("GET", p, { sub: "stranger" })).status, 404, `${p} người ngoài`);
      const nogrant = await h.call("GET", p, { sub: "dev_ops" });
      assert.equal(nogrant.status, 403, p);
      assert.equal(nogrant.body.code, "FORBIDDEN");
      assert.equal((await h.call("GET", p, { sub: "dev_b" })).body.code, "CONSENT_REQUIRED", p);
    }
    const share = { grantee_user: "dev_b", purpose: "FAMILY_CARE", from_date: "2026-11-01", expires_in_days: 7 };
    assert.equal((await h.call("POST", "/v2/health/shares", { sub: "dev_ops", body: share })).status, 403);
    assert.equal((await h.call("POST", "/v2/health/shares", { body: { ...share, note: "x" } })).status, 400, "schema đóng");
    assert.equal((await h.call("POST", "/v2/health/shares", { body: share, key: null })).status, 400, "thiếu Idempotency-Key");
    // Người không có quyền vẫn xuất và xóa được phần của mình (quyền của chủ thể dữ liệu không phụ thuộc đồng ý).
    assert.equal((await h.call("GET", "/v2/health/observations/export", { sub: "dev_ops" })).status, 200);
    assert.equal((await h.call("GET", "/v2/health/shares", { sub: "dev_ops" })).status, 200);
    assert.equal((await flag(h, false)).status, 200);
    for (const p of [...gets, "/v2/health/shares", "/v2/health/observations/export"]) assert.equal((await h.call("GET", p)).body.code, "MODULE_DISABLED", p);
    assert.equal((await imp(h, [reading(h)])).body.code, "MODULE_DISABLED");
    assert.equal((await h.call("POST", "/v2/health/shares", { body: share })).status, 503);
  } finally {
    await h.close();
  }
});

test("chỉ danh tính adapter đã duyệt nhập được: thành viên, người lạ, adapter của workspace khác, adapter bị đình chỉ đều 403; trường lạ 400; LeLS chỉ thấy tình trạng adapter", async () => {
  const h = await ready();
  try {
    for (const sub of ["dev_a", "dev_ops", "svc_unknown"]) {
      const r = await imp(h, [reading(h)], sub);
      assert.equal(r.status, 403, sub);
      assert.equal(r.body.code, "FORBIDDEN");
    }
    assert.equal((await imp(h, [reading(h)], PHONE)).status, 200);
    assert.equal((await h.call("POST", "/v2/health/observations/import", { sub: PHONE, ws: "ws_other", body: { observations: [reading(h)] } })).status, 403);
    for (const bad of [{ ...reading(h), pulse: 70 }, { ...reading(h), unit: "kPa" }, { ...reading(h), subject_ref: "dev_a" }, { ...reading(h), image_ref: "cam_1" }]) {
      assert.equal((await imp(h, [bad])).status, 400, JSON.stringify(bad));
    }
    assert.equal((await imp(h, [])).status, 400);
    assert.equal((await imp(h, Array.from({ length: MEAS_LIMITS.batch + 1 }, () => reading(h)))).status, 400);
    run(h.app.ctx.db, "UPDATE meas_adapters SET status = 'SUSPENDED' WHERE principal_sub = ?", CLOUD);
    assert.equal((await imp(h, [reading(h)], CLOUD)).status, 403);
    const sup = await h.call("GET", "/v2/health/support/adapters", { sub: "dev_ops" });
    assert.equal(sup.status, 200);
    valid("MeasSupportAdapters", sup.body);
    assert.ok(!/systolic|diastolic|subject|dev_a|dev_b/.test(JSON.stringify(sup.body)), "LeLS không thấy giá trị hay người được đo");
    assert.equal((await h.call("GET", "/v2/health/support/adapters", { sub: "dev_a" })).status, 403);
  } finally {
    await h.close();
  }
});

test("ánh xạ: adapter chỉ đề nghị, người được đo tự xác nhận; trước đó phép đo bị cách ly; sau đó gán thẳng; từ chối thì không đề nghị lại; thời điểm gốc giữ nguyên", async () => {
  const h = await ready();
  try {
    // Không gợi ý ai: cách ly, không ai thấy.
    const none = await one1(h, reading(h, { device_ref: "cuff_a" }));
    assert.deepEqual([none.result, none.reason], ["QUARANTINED", "SUBJECT_MISSING"]);
    // Gợi ý một người chưa đồng ý: không đề nghị.
    await consent(h, "dev_b", "DECLINED");
    assert.equal((await one1(h, reading(h, { device_ref: "cuff_a", subject_hint: "dev_b" }))).reason, "SUBJECT_MISSING");
    const { mapping_id, first, confirm } = await pairPerson(h, "dev_a", "cuff_a", 1);
    valid("MeasMapping", confirm);
    assert.equal(confirm.assigned, 1, "phép đo chờ xác nhận được gán khi chính người đó xác nhận");
    assert.equal(one<{ state: string; systolic: number | null }>(h.app.ctx.db, "SELECT state, systolic FROM meas_quarantine WHERE id = ?", first)?.state, "MEAS_ASSIGNED");
    assert.equal(one<{ systolic: number | null }>(h.app.ctx.db, "SELECT systolic FROM meas_quarantine WHERE id = ?", first)?.systolic, null, "giá trị đã chuyển đi, bản cách ly chỉ còn siêu dữ liệu");
    const at = vnAt(h, 3);
    const direct = await one1(h, reading(h, { device_ref: "cuff_a", measured_at: at, systolic: 133, diastolic: 84 }));
    assert.equal(direct.result, "ACCEPTED");
    // Thời điểm không có độ lệch: giữ nguyên chuỗi, cần múi của điện thoại.
    const local = vnAt(h, 4).slice(0, 19);
    assert.equal((await one1(h, reading(h, { device_ref: "cuff_a", measured_at: local, zone: "Asia/Ho_Chi_Minh" }))).result, "ACCEPTED");
    assert.deepEqual(await one1(h, reading(h, { source_key: "nozone", device_ref: "cuff_a", measured_at: local })), { source_key: "nozone", result: "REJECTED", detail_code: "TIME_ZONE_MISSING" });
    assert.equal((await one1(h, reading(h, { device_ref: "cuff_a", systolic: 70, diastolic: 90 }))).detail_code, "VALUE_OUT_OF_RANGE");
    assert.equal((await one1(h, reading(h, { device_ref: "cuff_a", measured_at: vnAt(h, -60) }))).detail_code, "TIME_INVALID", "thời điểm ở tương lai");
    const list = await h.call("GET", "/v2/health/observations");
    valid("MeasObservationList", list.body);
    const o = list.body.observations.find((x: { observation_id: string }) => x.observation_id === direct.record_ref);
    assert.deepEqual(Object.keys(o).sort(), ["device_ref", "diastolic", "measured_at", "observation_id", "quality_status", "received_at", "source", "subject_ref", "systolic", "unit"]);
    assert.deepEqual([o.subject_ref, o.source, o.measured_at, o.systolic, o.diastolic, o.unit, o.quality_status], ["dev_a", "mad_sim_phone", at, 133, 84, "mmHg", "VALID"]);
    assert.ok(list.body.observations.some((x: { measured_at: string }) => x.measured_at === local));
    assert.equal(list.body.disclaimer_code, "NOT_A_DIAGNOSTIC_DEVICE");
    assert.equal((await one1(h, reading(h, { device_ref: "cuff_a", quality_flags: ["CUFF_LOOSE"] }))).result, "ACCEPTED");
    assert.ok((await obsOf(h, "dev_a")).some((x) => (x as unknown as { quality_status: string }).quality_status === "QUESTIONABLE"));
    assert.equal((await h.call("GET", "/v2/health/observations", { sub: "dev_b" })).body.code, "CONSENT_REQUIRED", "người đã từ chối không đọc được gì");
    // Từ chối: bản chờ bị bỏ, adapter không đề nghị lại.
    await consent(h, "dev_b");
    const p = await one1(h, reading(h, { device_ref: "cuff_b", subject_hint: "dev_b" }));
    const mb = (await mappingsOf(h, "dev_b"))[0];
    const rej = await h.call("POST", `/v2/health/mappings/${mb.mapping_id}/reject`, { sub: "dev_b" });
    assert.equal(rej.body.state, "MEASMAP_REJECTED");
    assert.equal(rej.body.discarded, 1);
    assert.equal(one<{ state: string }>(h.app.ctx.db, "SELECT state FROM meas_quarantine WHERE id = ?", p.record_ref)?.state, "MEAS_DISCARDED");
    assert.equal((await one1(h, reading(h, { device_ref: "cuff_b", subject_hint: "dev_b" }))).reason, "SUBJECT_MISSING");
    assert.equal((await mappingsOf(h, "dev_b")).length, 1);
    // Ánh xạ của người khác: 404 đồng nhất; xác nhận lại: 409.
    assert.equal((await h.call("POST", `/v2/health/mappings/${mapping_id}/reject`, { sub: "dev_b" })).status, 404);
    assert.equal((await h.call("POST", `/v2/health/mappings/${mapping_id}/confirm`)).status, 409);
    // Gỡ ánh xạ đã xác nhận: phép đo mới không còn gán.
    assert.equal((await h.call("POST", `/v2/health/mappings/${mapping_id}/reject`)).body.state, "MEASMAP_REVOKED");
    assert.equal((await one1(h, reading(h, { device_ref: "cuff_a" }))).reason, "SUBJECT_MISSING");
  } finally {
    await h.close();
  }
});

test("X08: hai người dùng chung một máy đo, đo cùng thời điểm: tách theo hồ sơ đã xác nhận; không rõ hồ sơ hay hai người cùng nhận một hồ sơ thì cách ly, không lộ giá trị, gán khi đúng một người nhận", async () => {
  const h = await ready();
  try {
    await pairPerson(h, "dev_a", "cuff_shared", 1);
    await pairPerson(h, "dev_b", "cuff_shared", 2);
    const at = vnAt(h, 2);
    const r = await imp(h, [reading(h, { user_slot: 1, measured_at: at, systolic: 118, diastolic: 76 }), reading(h, { user_slot: 2, measured_at: at, systolic: 141, diastolic: 92 })]);
    assert.deepEqual(r.body.results.map((x: { result: string }) => x.result), ["ACCEPTED", "ACCEPTED"]);
    assert.deepEqual((await obsOf(h, "dev_a")).filter((o) => o.measured_at === at).map((o) => o.systolic), [118]);
    assert.deepEqual((await obsOf(h, "dev_b")).filter((o) => o.measured_at === at).map((o) => o.systolic), [141]);
    // Không rõ hồ sơ (mã người dùng 0xFF trên máy): mơ hồ → cách ly, cả hai là ứng viên.
    const amb = await one1(h, reading(h, { user_slot: null, measured_at: at, systolic: 127 }));
    assert.deepEqual([amb.result, amb.reason], ["QUARANTINED", "AMBIGUOUS_USER"]);
    for (const sub of ["dev_a", "dev_b"]) {
      const q = await h.call("GET", "/v2/health/quarantine", { sub });
      valid("MeasQuarantineList", q.body);
      assert.deepEqual(q.body.records.map((x: { record_id: string }) => x.record_id), [amb.record_ref], sub);
      assert.ok(!/systolic|diastolic|127/.test(JSON.stringify(q.body)), "cách ly không hiện giá trị cho ứng viên");
    }
    assert.equal((await h.call("POST", `/v2/health/quarantine/${amb.record_ref}/resolve`, { sub: "dev_ops", body: { answer: "MINE" } })).status, 403, "không có quyền");
    const a1 = await h.call("POST", `/v2/health/quarantine/${amb.record_ref}/resolve`, { body: { answer: "MINE" } });
    assert.equal(a1.body.outcome, "WAITING", "chưa đủ mọi ứng viên trả lời");
    const b1 = await h.call("POST", `/v2/health/quarantine/${amb.record_ref}/resolve`, { sub: "dev_b", body: { answer: "MINE" } });
    assert.equal(b1.body.outcome, "CONTESTED", "hai người cùng nhận: vẫn cách ly");
    const b2 = await h.call("POST", `/v2/health/quarantine/${amb.record_ref}/resolve`, { sub: "dev_b", body: { answer: "NOT_MINE" } });
    valid("MeasQuarantineRecord", b2.body);
    assert.equal(b2.body.outcome, "RESOLVED", "người nói không phải của mình không biết gán cho ai");
    assert.ok((await obsOf(h, "dev_a")).some((o) => o.systolic === 127));
    assert.ok(!(await obsOf(h, "dev_b")).some((o) => o.systolic === 127));
    assert.equal((await h.call("POST", `/v2/health/quarantine/${amb.record_ref}/resolve`, { body: { answer: "MINE" } })).status, 409);
    // Hai hồ sơ mâu thuẫn: dev_b cũng xác nhận hồ sơ 1 → phép đo hồ sơ 1 bị cách ly; bản chờ của dev_b lúc xác nhận cũng vậy.
    const pend = await one1(h, reading(h, { device_ref: "cuff_shared", user_slot: 1, subject_hint: "dev_b" }));
    assert.deepEqual([pend.result, pend.reason], ["ACCEPTED", undefined], "đã có người xác nhận hồ sơ 1: gán theo ánh xạ đó, gợi ý của adapter không đổi gì");
    run(h.app.ctx.db, "INSERT INTO meas_mappings (id, workspace_id, device_ref, user_slot, subject, state, proposed_by, created_at) VALUES ('mmp_x', ?, 'cuff_shared', 1, 'dev_b', 'MEASMAP_CONFIRMED', 'mad_sim_phone', ?)", WS, T0);
    const conflict = await one1(h, reading(h, { user_slot: 1 }));
    assert.deepEqual([conflict.result, conflict.reason], ["QUARANTINED", "PROFILE_CONFLICT"]);
    for (const [sub, answer] of [["dev_a", "NOT_MINE"], ["dev_b", "NOT_MINE"]] as const) await h.call("POST", `/v2/health/quarantine/${conflict.record_ref}/resolve`, { sub, body: { answer } });
    assert.equal(one<{ state: string }>(h.app.ctx.db, "SELECT state FROM meas_quarantine WHERE id = ?", conflict.record_ref)?.state, "MEAS_DISCARDED", "không ai nhận: bỏ");
    // Xác nhận khi người khác đã giữ cùng hồ sơ: bản chờ không gán, thêm ứng viên.
    const h2 = await one1(h, reading(h, { device_ref: "cuff_two", user_slot: 1, subject_hint: "dev_a" }));
    run(h.app.ctx.db, "INSERT INTO meas_mappings (id, workspace_id, device_ref, user_slot, subject, state, proposed_by, created_at) VALUES ('mmp_y', ?, 'cuff_two', 0, 'dev_b', 'MEASMAP_CONFIRMED', 'mad_sim_phone', ?)", WS, T0);
    const ma = (await mappingsOf(h, "dev_a")).find((m) => m.state === "MEASMAP_PROPOSED") as { mapping_id: string };
    const c = await h.call("POST", `/v2/health/mappings/${ma.mapping_id}/confirm`);
    assert.deepEqual([c.body.assigned, c.body.conflicted], [0, 1]);
    assert.ok((await quarantineOf(h, "dev_b")).some((x) => x.record_id === h2.record_ref && x.reason === "PROFILE_CONFLICT" && x.candidates === 2));
    // Thiếu người đo: không ai thấy, hết hạn sau 30 ngày và giá trị bị xóa.
    const lost = await one1(h, reading(h, { device_ref: "cuff_nobody" }));
    for (const sub of ["dev_a", "dev_b"]) assert.ok(!(await quarantineOf(h, sub)).some((x) => x.record_id === lost.record_ref));
    h.clock.advance(MEAS_LIMITS.quarantineRetentionMs + MIN);
    await h.app.tick();
    assert.deepEqual({ ...one<object>(h.app.ctx.db, "SELECT state, systolic, diastolic FROM meas_quarantine WHERE id = ?", lost.record_ref) }, { state: "MEAS_EXPIRED", systolic: null, diastolic: null });
  } finally {
    await h.close();
  }
});

test("chống trùng và phát lại: cùng kênh gửi lại; cùng phép đo qua hai kênh (X09); cùng khóa khác giá trị; khóa idempotency cũ phát lại đúng phản hồi", async () => {
  const h = await ready();
  try {
    await pairPerson(h, "dev_a", "cuff_shared", 1);
    const item = reading(h, { measured_at: vnAt(h, 1) });
    const k = key();
    const first = await imp(h, [item], PHONE, k);
    assert.equal(first.body.results[0].result, "ACCEPTED");
    const replay = await imp(h, [item], PHONE, k);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(replay.body, first.body);
    assert.equal((await imp(h, [{ ...item, systolic: 150 }], PHONE, k)).status, 409, "cùng khóa khác nội dung");
    // Khóa idempotency mới, cùng khóa nguồn: đối soát, không tạo bản thứ hai.
    assert.deepEqual((await imp(h, [item])).body.results[0], { source_key: item.source_key, result: "DUPLICATE", record_ref: first.body.results[0].record_ref });
    assert.equal((await imp(h, [{ ...item, systolic: 150 }])).body.results[0].detail_code, "SOURCE_KEY_REUSED");
    // Kênh thứ hai, khóa nguồn khác, cùng máy, hồ sơ và thời điểm: trùng.
    const viaCloud = await one1(h, { ...item, source_key: "cloud-001" }, CLOUD);
    assert.deepEqual([viaCloud.result, viaCloud.record_ref], ["DUPLICATE", first.body.results[0].record_ref]);
    // Kênh thứ hai báo khác giá trị: cách ly, không ghi đè, không gán nhầm.
    const diff = await one1(h, { ...item, source_key: "cloud-002", systolic: 140 }, CLOUD);
    assert.deepEqual([diff.result, diff.reason], ["QUARANTINED", "SOURCE_CONFLICT"]);
    assert.equal((await obsOf(h, "dev_a")).filter((o) => o.measured_at === item.measured_at).length, 1);
    assert.equal(count(h, "meas_observations"), 2);
  } finally {
    await h.close();
  }
});

test("X09 grant chia sẻ: mục đích, phạm vi, hạn, thu hồi; grant cũ không mở dữ liệu mới; mỗi lần xem có nhật ký; người xem không có đường nào khác", async () => {
  const h = await ready();
  try {
    await pairPerson(h, "dev_a", "cuff_shared", 1);
    await one1(h, reading(h, { measured_at: vnAt(h, 5), systolic: 119 }));
    const before = (await obsOf(h, "dev_a")).map((o) => o.observation_id).sort();
    assert.equal(before.length, 2);
    assert.equal((await h.call("POST", "/v2/health/shares", { body: { grantee_user: "dev_a", purpose: "FAMILY_CARE", from_date: "2026-11-01", expires_in_days: 7 } })).status, 404, "không tự chia sẻ cho mình");
    assert.equal((await h.call("POST", "/v2/health/shares", { body: { grantee_user: "stranger", purpose: "FAMILY_CARE", from_date: "2026-11-01", expires_in_days: 7 } })).status, 404);
    assert.equal((await h.call("POST", "/v2/health/shares", { body: { grantee_user: "dev_b", purpose: "FAMILY_CARE", from_date: "2026-11-01", expires_in_days: 91 } })).status, 400);
    const s = await h.call("POST", "/v2/health/shares", { body: { grantee_user: "dev_ops", purpose: "PROFESSIONAL_REVIEW", from_date: "2026-11-01", expires_in_days: 7 } });
    assert.equal(s.status, 201);
    valid("MeasShare", s.body);
    assert.ok(!holdsValue(s.body, 119));
    h.clock.advance(MIN);
    // Phép đo nhận sau lúc cấp: không nằm trong grant, kể cả khi đo trước đó (nhập muộn qua kênh khác).
    await one1(h, reading(h, { measured_at: vnAt(h, 30), systolic: 125 }), CLOUD);
    await one1(h, reading(h, { measured_at: vnAt(h, 0), systolic: 131 }));
    const shares = await h.call("GET", "/v2/health/shares", { sub: "dev_ops" });
    valid("MeasShareList", shares.body);
    assert.deepEqual(shares.body.received.map((x: { share_id: string }) => x.share_id), [s.body.share_id]);
    assert.deepEqual(shares.body.people, [], "người xem không có quyền measurements.record không có danh bạ chia sẻ");
    const read = await h.call("GET", `/v2/health/shares/${s.body.share_id}/observations`, { sub: "dev_ops" });
    valid("MeasSharedObservations", read.body);
    assert.deepEqual(read.body.observations.map((o: { observation_id: string }) => o.observation_id).sort(), before, "grant cũ không mở dữ liệu mới");
    assert.equal((await obsOf(h, "dev_a")).length, 4);
    assert.equal((await h.call("GET", `/v2/health/shares/${s.body.share_id}/observations`, { sub: "dev_b" })).status, 404, "người khác 404");
    assert.equal((await h.call("GET", `/v2/health/shares/${s.body.share_id}/observations`)).status, 404, "chủ dữ liệu đọc qua route của mình");
    // Người xem (vai vận hành) không đọc được qua đường nào khác.
    assert.equal((await h.call("GET", "/v2/health/observations", { sub: "dev_ops" })).status, 403);
    const log = (await h.call("GET", "/v2/health/shares")).body.access_log as { actor: string; action: string }[];
    assert.deepEqual(log.map((x) => [x.actor, x.action]).slice(0, 2), [["dev_ops", "SHARE_VIEWED"], ["dev_a", "SHARE_CREATED"]]);
    // Thu hồi: đọc ngay 404, có sổ thu hồi; thu hồi lần hai 409.
    const rv = await h.call("POST", `/v2/health/shares/${s.body.share_id}/revoke`);
    assert.equal(rv.body.state, "MEASSHARE_REVOKED");
    assert.equal((await h.call("GET", `/v2/health/shares/${s.body.share_id}/observations`, { sub: "dev_ops" })).status, 404);
    assert.equal((await h.call("POST", `/v2/health/shares/${s.body.share_id}/revoke`)).status, 409);
    assert.equal((await h.call("POST", `/v2/health/shares/${s.body.share_id}/revoke`, { sub: "dev_b" })).status, 404);
    // Hết hạn và rút đồng ý của chủ dữ liệu cũng đóng grant.
    const s2 = await h.call("POST", "/v2/health/shares", { body: { grantee_user: "dev_b", purpose: "FAMILY_CARE", from_date: "2026-11-01", expires_in_days: 1 } });
    const s3 = await h.call("POST", "/v2/health/shares", { body: { grantee_user: "dev_b", purpose: "FAMILY_CARE", from_date: "2026-11-01", expires_in_days: 30 } });
    h.clock.advance(86_400_000 + MIN);
    assert.equal((await h.call("GET", `/v2/health/shares/${s2.body.share_id}/observations`, { sub: "dev_b" })).status, 404, "quá hạn: chặn ngay cả trước khi quét");
    await h.app.tick();
    assert.equal(one<{ state: string }>(h.app.ctx.db, "SELECT state FROM meas_shares WHERE id = ?", s2.body.share_id)?.state, "MEASSHARE_EXPIRED");
    assert.equal((await h.call("GET", `/v2/health/shares/${s3.body.share_id}/observations`, { sub: "dev_b" })).status, 200);
    assert.equal((await h.call("POST", "/v1/consents/measurements/withdraw")).status, 200);
    assert.equal(one<{ state: string }>(h.app.ctx.db, "SELECT state FROM meas_shares WHERE id = ?", s3.body.share_id)?.state, "MEASSHARE_REVOKED");
    assert.equal(count(h, "meas_mappings", "subject = 'dev_a' AND state IN ('MEASMAP_PROPOSED','MEASMAP_CONFIRMED')"), 0, "rút đồng ý gỡ ánh xạ: dừng nhận");
    assert.equal((await one1(h, reading(h))).reason, "SUBJECT_MISSING");
  } finally {
    await h.close();
  }
});

test("xuất, xóa một phép đo, xóa hết (cần đăng nhập mới), DELETE của lõi; phép đo đã xóa không sống lại qua kênh nào, kể cả sau restore", async () => {
  const h = await ready();
  try {
    await pairPerson(h, "dev_a", "cuff_shared", 1);
    await pairPerson(h, "dev_b", "cuff_shared", 2);
    const item = reading(h, { measured_at: vnAt(h, 2), systolic: 122 });
    const a = await one1(h, item);
    await one1(h, reading(h, { user_slot: 2, systolic: 144 }));
    const ex = await h.call("GET", "/v2/health/observations/export");
    valid("MeasExport", ex.body);
    assert.ok(ex.body.observations.length >= 1 && ex.body.observations.every((o: { subject_ref: string }) => o.subject_ref === "dev_a"));
    assert.ok(!holdsValue(ex.body, 144), "không có dữ liệu của người khác");
    const backupPath = join(h.dir, "truoc-khi-xoa.db");
    backupLedger(h.app.ctx, backupPath);
    assert.equal((await h.call("POST", `/v2/health/observations/${a.record_ref}/delete`, { sub: "dev_b" })).status, 404);
    const del = await h.call("POST", `/v2/health/observations/${a.record_ref}/delete`);
    valid("MeasDeleted", del.body);
    assert.deepEqual((await one1(h, { ...item, source_key: "again-1" })).record_ref, null, "nhập lại: mốc chống trùng");
    assert.equal((await one1(h, { ...item, source_key: "again-2" }, CLOUD)).result, "DUPLICATE");
    h.app.close();
    restoreLedgerFile(backupPath, join(h.dir, "ledger.db"));
    await h.restart();
    assert.equal(count(h, "meas_observations", "id = ?", a.record_ref), 1, "bản restore còn phép đo đã xóa");
    assert.ok(applyRevocations(h.app.ctx).applied >= 1);
    assert.equal(count(h, "meas_observations", "id = ?", a.record_ref), 0, "nạp sổ thu hồi: xóa lại");
    assert.equal((await one1(h, { ...item, source_key: "again-3" }, CLOUD)).result, "DUPLICATE");
    // Xóa hết cần đăng nhập mới.
    h.clock.advance(10 * MIN);
    const stale = await h.call("POST", "/v2/health/erase", { headers: { Authorization: `Bearer ${h.token("dev_b", { authTime: Math.floor(h.clock.now() / 1000) - 3600 })}` } });
    assert.equal(stale.status, 401);
    const er = await h.call("POST", "/v2/health/erase", { sub: "dev_b" });
    assert.equal(er.body.deleted, 2, "phép đo chờ xác nhận lúc ghép và phép đo hồ sơ 2");
    assert.equal(count(h, "meas_observations", "subject = 'dev_b'"), 0);
    // DELETE của lõi: không còn gì của dev_a.
    await one1(h, reading(h, { systolic: 117 }));
    assert.equal((await h.call("POST", "/v1/privacy/requests", { body: { type: "DELETE" } })).status, 202);
    for (const t of ["meas_observations", "meas_mappings", "meas_shares", "meas_access"]) assert.equal(count(h, t, t === "meas_shares" ? "owner = 'dev_a' OR grantee = 'dev_a'" : t === "meas_access" ? "owner = 'dev_a'" : "subject = 'dev_a'"), 0, t);
  } finally {
    await h.close();
  }
});

test("máy đo giả lập chỉ có ở chế độ dev, đi đúng đường nhập của adapter mô phỏng, nhãn SIMULATED, phản hồi không có giá trị đo", async () => {
  const h = await ready();
  try {
    const r = await h.call("POST", "/v2/health/sim-device/readings", { body: { device: "SHARED", user_slot: 1, hint_self: true, channel: "BOTH", repeat_last: false } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    valid("MeasSimReadingResult", r.body);
    assert.deepEqual(r.body.results.map((x: { result: string; label: string }) => [x.result, x.label]), [["QUARANTINED", "SIMULATED"], ["DUPLICATE", "SIMULATED"]]);
    assert.ok(!/systolic|diastolic/.test(JSON.stringify(r.body)));
    const rep = await h.call("POST", "/v2/health/sim-device/readings", { body: { device: "SHARED", user_slot: 1, hint_self: true, channel: "BOTH", repeat_last: true } });
    assert.deepEqual(rep.body.results.map((x: { result: string }) => x.result), ["DUPLICATE", "DUPLICATE"]);
    assert.equal(one<{ actor: string }>(h.app.ctx.db, "SELECT actor FROM audit WHERE action = 'measurements.import' ORDER BY rowid LIMIT 1")?.actor, PHONE, "danh tính adapter, không phải người bấm");
    await h.restart({ dev: false });
    assert.equal((await h.call("POST", "/v2/health/sim-device/readings", { headers: { Authorization: `Bearer ${"x.y.z"}` }, body: { device: "SHARED", user_slot: 1, hint_self: true, channel: "BOTH", repeat_last: false } })).status, 401);
  } finally {
    await h.close();
  }
});

test("quét byte: giá trị đo không nằm trong audit, dấu chống lặp, sổ thu hồi, barrier hay phản hồi POST; LeLe không có đường nào tới phép đo", async () => {
  const h = await ready();
  try {
    const MARK_S = 187;
    const MARK_D = 113;
    await pairPerson(h, "dev_a", "cuff_shared", 1);
    await one1(h, reading(h, { systolic: MARK_S, diastolic: MARK_D }));
    await one1(h, reading(h, { user_slot: null, systolic: MARK_S, diastolic: MARK_D - 1 }));
    const s = await h.call("POST", "/v2/health/shares", { body: { grantee_user: "dev_b", purpose: "FAMILY_CARE", from_date: "2026-11-01", expires_in_days: 3 } });
    await h.call("GET", `/v2/health/shares/${s.body.share_id}/observations`, { sub: "dev_b" });
    await h.call("POST", `/v2/health/shares/${s.body.share_id}/revoke`);
    const rows = [
      ...all<Record<string, unknown>>(h.app.ctx.db, "SELECT * FROM audit"),
      ...all<Record<string, unknown>>(h.app.ctx.db, "SELECT * FROM idem_keys"),
      ...all<Record<string, unknown>>(h.app.ctx.db, "SELECT * FROM meas_access"),
      ...all<Record<string, unknown>>(h.app.ctx.db, "SELECT * FROM meas_source_keys"),
    ];
    const text = JSON.stringify(rows);
    // Số đo tìm như một số đứng riêng: mã ngẫu nhiên, mã băm và mốc giờ có thể chứa cùng chữ số nằm giữa chữ hay số khác.
    const asNumber = (n: number) => new RegExp(`(?<![0-9A-Za-z])${n}(?![0-9A-Za-z])`);
    for (const n of [MARK_S, MARK_D]) assert.ok(!asNumber(n).test(text), `không có ${n}`);
    for (const needle of ["systolic", "diastolic", "mmHg"]) assert.ok(!text.includes(needle), `không có ${needle}`);
    const files = readdirSync(h.dir).filter((f) => !/^ledger\.db/.test(f) && !f.endsWith(".db"));
    for (const f of files) {
      let body = "";
      try {
        body = readFileSync(join(h.dir, f), "utf8");
      } catch {
        continue; // thư mục
      }
      for (const needle of ["systolic", "diastolic"]) assert.ok(!body.includes(needle), `${f}: không có ${needle}`);
      assert.ok(!asNumber(MARK_S).test(body), `${f}: không có ${MARK_S}`);
    }
    // LeLe không nạp, không được nạp; trang LeLe không gọi /v2/health.
    const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
    assert.doesNotMatch(src("../src/server/lele.ts"), /measurements|meas_|\/v2\/health/);
    assert.doesNotMatch(src("../src/server/measurements.ts"), /from "\.\/lele\.ts"/);
    assert.doesNotMatch(src("../web/shared/lele-lexicon.js"), /\/v2\/health|measurements/);
    // Mô-đun khác không đọc bảng phép đo.
    for (const f of readdirSync(new URL("../src/server/", import.meta.url)).filter((x) => x.endsWith(".ts") && x !== "measurements.ts")) {
      assert.doesNotMatch(src(`../src/server/${f}`), /meas_observations|meas_quarantine/, f);
    }
  } finally {
    await h.close();
  }
});
