// Le‑NodeHealth: phép đo huyết áp từ máy đo đối tác (SRS V2.0 mục 08, 11, 12, 13; N20‑MEAS; LNH-T67; ca X08, X09). Đây là
// ngoại lệ duy nhất của V1.0.1 cho quy tắc «số liệu sức khỏe không tới máy chủ» (LNH-T52): chỉ sau cờ `measurements`, đồng ý
// `measurements` và quyền `measurements.record` của chính người được đo, chỉ với dữ liệu tổng hợp.
//
// - Phép đo chỉ vào qua POST /v2/health/observations/import, gọi bằng DANH TÍNH ADAPTER ĐÃ DUYỆT (meas_adapters). Bản này chỉ có
//   hai adapter mô phỏng do dữ liệu mẫu dev tạo (svc_meas_phone_sim, svc_meas_cloud_sim); danh tính của chúng nằm ở máy chủ,
//   trang web không có token adapter. Chưa có quy trình duyệt adapter thật, chưa có tích hợp với máy đo hay cloud của hãng nào.
// - Người được đo chỉ được gán theo ánh xạ (máy đo + hồ sơ trên máy → người) mà CHÍNH NGƯỜI ĐÓ xác nhận trong app (MEASMAP_).
//   Adapter chỉ đề nghị (subject_hint), không bao giờ tự gán. Thiếu người đo, ánh xạ chưa xác nhận, hai hồ sơ cùng nhận một máy,
//   số đo không rõ hồ sơ trên máy dùng chung, hay cùng khóa chống trùng mà khác giá trị: cách ly (MEAS_), không suy đoán (X08).
// - Cách ly chỉ hiện siêu dữ liệu (thời điểm, máy, lý do) cho đúng những người là ứng viên, không hiện giá trị đo. Gán khi mọi
//   ứng viên đã trả lời và đúng một người nói «của tôi»; không ai nhận thì bỏ; không xong trong 30 ngày thì hết hạn và xóa giá trị.
// - Chống trùng hai tầng: (adapter, source_key) cho gửi lại của cùng kênh; (máy, hồ sơ, thời điểm đo) cho cùng phép đo qua hai
//   kênh (X09). Phép đo đã xóa để lại mốc chống trùng (chỉ mã băm), nên nhập lại không làm nó sống lại.
// - Chia sẻ với người thân hay chuyên gia qua grant riêng (MEASSHARE_): mục đích, phạm vi từ ngày, hạn tối đa 90 ngày, thu hồi.
//   Grant chỉ mở phép đo đã NHẬN trước lúc cấp: grant cũ không mở dữ liệu mới (X09). Xem, xuất, chia sẻ, thu hồi có nhật ký.
// - Vai trò độc lập: người mua gói không có đường đọc nào; người được đo đọc của mình; người xem chỉ đọc qua grant còn hiệu lực;
//   LeLS (vai vận hành) chỉ thấy tình trạng adapter, không thấy giá trị hay người đo.
// - Chỉ hiển thị nhật ký và xu hướng. Không chỉ báo AFib, không chẩn đoán, không gợi ý đổi thuốc, không cảnh báo y tế tự động;
//   không phải thiết bị y tế chẩn đoán. Giá trị đo không vào audit, sổ thu hồi, phản hồi của POST (nên không vào idem_keys) hay log.
// - LeLe không có đường nào tới đây: tệp này không nạp lele.ts và lele.ts không nạp tệp này (kiểm ở tests/measurements.test.ts).
import { DAY, MINUTE } from "../core/clock.ts";
import { digestJcs, uuid } from "../core/crypto.ts";
import { ApiError } from "../core/errors.ts";
import { isValidZone, localParts, parseInstant, zonedToInstant } from "../../web/shared/zone.js";
import type { Call, Route } from "./api.ts";
import { activeGrant, consentGranted, isActiveMember, member, requireMember, requireModuleGate, requireRole } from "./authority.ts";
import { type Ctx, nowIso } from "./context.ts";
import type { Stored } from "./idempotency.ts";
import { indexTransitions, transitionsFor } from "./machine.ts";
import type { ServerModule } from "./modules.ts";
import { journalRevocation } from "./recovery.ts";
import { DEMO_WS, DEV_USERS } from "./seed.ts";
import { all, audit, one, run, tx } from "./store.ts";

const GATE = { module: "measurements", scope: "measurements.record", purpose: "measurements" } as const;

export const MEAS_LIMITS = {
  batch: 50,
  quarantineRetentionMs: 30 * DAY,
  shareMaxDays: 90,
  activeShares: 10,
  futureSkewMs: 5 * MINUTE,
  maxAgeMs: 365 * DAY,
  listPage: 500,
  accessLogPage: 100,
  systolic: [50, 300],
  diastolic: [20, 200],
} as const;

/** Adapter mô phỏng của dữ liệu mẫu dev. Danh tính (principal) chỉ ở máy chủ; không phải adapter đã được duyệt cho dữ liệu thật. */
export const SIM_ADAPTERS = [
  { adapter_id: "mad_sim_phone", principal_sub: "svc_meas_phone_sim", channel: "PHONE_GATEWAY" },
  { adapter_id: "mad_sim_cloud", principal_sub: "svc_meas_cloud_sim", channel: "PARTNER_CLOUD" },
] as const;

type QState = "MEAS_QUARANTINED" | "MEAS_ASSIGNED" | "MEAS_DISCARDED" | "MEAS_EXPIRED";
type MapState = "MEASMAP_PROPOSED" | "MEASMAP_CONFIRMED" | "MEASMAP_REJECTED" | "MEASMAP_REVOKED";
type ShareState = "MEASSHARE_ACTIVE" | "MEASSHARE_REVOKED" | "MEASSHARE_EXPIRED";
type Reason = "SUBJECT_MISSING" | "MAPPING_UNCONFIRMED" | "PROFILE_CONFLICT" | "AMBIGUOUS_USER" | "SOURCE_CONFLICT";

const findQ = indexTransitions(transitionsFor("MEAS_"));
const findMap = indexTransitions(transitionsFor("MEASMAP_"));
const findShare = indexTransitions(transitionsFor("MEASSHARE_"));

interface AdapterRow {
  adapter_id: string;
  workspace_id: string;
  principal_sub: string;
  channel: "PHONE_GATEWAY" | "PARTNER_CLOUD";
  trust: "SIMULATED";
  status: "APPROVED" | "SUSPENDED";
  approved_by: string;
  approved_at: string;
  last_seen_at: string | null;
}

interface MappingRow {
  id: string;
  workspace_id: string;
  device_ref: string;
  user_slot: number;
  subject: string;
  state: MapState;
  proposed_by: string;
  created_at: string;
  decided_at: string | null;
}

interface ObservationRow {
  id: string;
  workspace_id: string;
  subject: string;
  adapter_id: string;
  device_ref: string;
  user_slot: number | null;
  measured_at: string;
  zone: string | null;
  measured_instant: string;
  received_at: string;
  systolic: number;
  diastolic: number;
  unit: "mmHg";
  quality_status: "VALID" | "QUESTIONABLE";
  dedupe_key: string;
  created_at: string;
}

interface QuarantineRow extends Omit<ObservationRow, "subject" | "systolic" | "diastolic" | "created_at"> {
  systolic: number | null;
  diastolic: number | null;
  reason: Reason;
  mapping_id: string | null;
  candidates: string;
  answers: string;
  state: QState;
  observation_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface ShareRow {
  id: string;
  workspace_id: string;
  owner: string;
  grantee: string;
  purpose: "FAMILY_CARE" | "PROFESSIONAL_REVIEW";
  data_from: string;
  data_until: string;
  expires_at: string;
  state: ShareState;
  created_at: string;
  ended_at: string | null;
}

export interface ImportItem {
  source_key: string;
  device_ref: string;
  user_slot: number | null;
  subject_hint: string | null;
  measured_at: string;
  zone: string | null;
  systolic: number;
  diastolic: number;
  unit: "mmHg";
  quality_flags: ("BODY_MOVEMENT" | "CUFF_LOOSE" | "IMPROPER_POSITION")[];
}

type ItemResult =
  | { source_key: string; result: "ACCEPTED"; record_ref: string }
  | { source_key: string; result: "QUARANTINED"; record_ref: string; reason: Reason }
  | { source_key: string; result: "DUPLICATE"; record_ref: string | null }
  | { source_key: string; result: "REJECTED"; detail_code: "VALUE_OUT_OF_RANGE" | "TIME_INVALID" | "TIME_ZONE_MISSING" | "SOURCE_KEY_REUSED" | "SUBJECT_UNAVAILABLE" };

const iso = (ms: number) => new Date(ms).toISOString();
const notFound = () => new ApiError(404, "NOT_FOUND");
const invalidTransition = () => new ApiError(409, "INVALID_TRANSITION");
const parseList = (s: string) => JSON.parse(s) as string[];

// ── Cổng ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Người được đo dùng được Le‑NodeHealth theo Authority: thành viên ACTIVE, có quyền measurements.record, còn đồng ý. */
export const entitled = (ctx: Ctx, ws: string, user: string) =>
  isActiveMember(ctx, ws, user) && !!activeGrant(ctx, ws, user, GATE.scope, null) && consentGranted(ctx, ws, user, GATE.purpose);

const gate = (c: Call) => requireModuleGate(c.d.ctx, c.ws, c.p.sub, GATE);

/** Cổng nhẹ cho người xem và cho quyền của chủ thể dữ liệu (xuất, xóa): thành viên (404) → cờ (503). */
function memberGate(c: Call) {
  const m = requireMember(c.d.ctx, c.ws, c.p.sub);
  if (!c.d.ctx.control.moduleOn(GATE.module)) throw new ApiError(503, "MODULE_DISABLED");
  return m;
}

/** Adapter đã duyệt của workspace ứng với danh tính đang gọi, hoặc undefined. Người dùng thường không bao giờ là adapter. */
const adapterOf = (ctx: Ctx, ws: string, sub: string) =>
  one<AdapterRow>(ctx.db, "SELECT * FROM meas_adapters WHERE workspace_id = ? AND principal_sub = ? AND status = 'APPROVED'", ws, sub);

function stepQ(ctx: Ctx, r: QuarantineRow, event: string, actor: string, at: string, set: Partial<QuarantineRow> = {}) {
  const t = findQ(r.state, event, actor);
  if (!t) throw invalidTransition();
  const fields: Record<string, string | number | null> = { state: t.to, ...(set as Record<string, string | number | null>) };
  if (t.to !== "MEAS_QUARANTINED") Object.assign(fields, { resolved_at: at, systolic: null, diastolic: null });
  const cols = Object.keys(fields);
  run(ctx.db, `UPDATE meas_quarantine SET ${cols.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...cols.map((k) => fields[k]), r.id);
  return one<QuarantineRow>(ctx.db, "SELECT * FROM meas_quarantine WHERE id = ?", r.id) as QuarantineRow;
}

function stepMap(ctx: Ctx, m: MappingRow, event: string, actor: string, at: string) {
  const t = findMap(m.state, event, actor);
  if (!t) throw invalidTransition();
  run(ctx.db, "UPDATE meas_mappings SET state = ?, decided_at = ? WHERE id = ?", t.to, at, m.id);
  return { ...m, state: t.to as MapState, decided_at: at };
}

function stepShare(ctx: Ctx, s: ShareRow, event: string, actor: string, at: string) {
  const t = findShare(s.state, event, actor);
  if (!t) throw invalidTransition();
  run(ctx.db, "UPDATE meas_shares SET state = ?, ended_at = ? WHERE id = ?", t.to, at, s.id);
  return { ...s, state: t.to as ShareState, ended_at: at };
}

function logAccess(ctx: Ctx, ws: string, owner: string, actor: string, action: string, ref: string | null, at: string) {
  run(ctx.db, "INSERT INTO meas_access (id, workspace_id, owner, actor, action, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?)", `mac_${uuid()}`, ws, owner, actor, action, ref, at);
}

// ── Nhập phép đo (adapter) ────────────────────────────────────────────────────────────────────────────────────────────────────

const confirmedOn = (ctx: Ctx, ws: string, device: string) =>
  all<MappingRow>(ctx.db, "SELECT * FROM meas_mappings WHERE workspace_id = ? AND device_ref = ? AND state = 'MEASMAP_CONFIRMED' ORDER BY created_at, id", ws, device);

/**
 * Ai có thể là người được đo theo các ánh xạ ĐÃ XÁC NHẬN. Có hồ sơ (1–8): ánh xạ đúng hồ sơ đó hoặc cả máy (0). Không rõ hồ sơ:
 * mọi ánh xạ của máy, và chỉ gán thẳng khi đúng một người giữ ánh xạ cả máy (máy một người dùng).
 */
function routeOf(ctx: Ctx, ws: string, device: string, slot: number | null): { assign: string | null; candidates: string[]; reason: Reason | null } {
  const rel = confirmedOn(ctx, ws, device).filter((m) => slot === null || m.user_slot === slot || m.user_slot === 0);
  const subjects = [...new Set(rel.map((m) => m.subject))];
  if (!subjects.length) return { assign: null, candidates: [], reason: null };
  if (subjects.length === 1 && (slot !== null || rel.every((m) => m.user_slot === 0))) return { assign: subjects[0], candidates: subjects, reason: null };
  return { assign: null, candidates: subjects, reason: slot === null ? "AMBIGUOUS_USER" : "PROFILE_CONFLICT" };
}

/** Thời điểm đo: giữ nguyên chuỗi gốc; có độ lệch thì đọc thẳng, không có thì cần `zone` của điện thoại chuyển tiếp. */
function instantOf(item: ImportItem): number | "TIME_INVALID" | "TIME_ZONE_MISSING" {
  if (/(Z|[+-]\d{2}:\d{2})$/.test(item.measured_at)) {
    const ms = parseInstant(item.measured_at);
    return Number.isNaN(ms) ? "TIME_INVALID" : ms;
  }
  if (!item.zone) return "TIME_ZONE_MISSING";
  if (!isValidZone(item.zone)) return "TIME_INVALID";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})$/.exec(item.measured_at);
  if (!m) return "TIME_INVALID";
  try {
    const ms = zonedToInstant(m[1], m[2], item.zone) + Number(m[3]) * 1000;
    // Kiểm vòng lại: ngày không có thật (30/02) hay giờ rơi vào khoảng chuyển giờ thì không khớp.
    const p = localParts(ms, item.zone);
    const back = `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
    return back === item.measured_at ? ms : "TIME_INVALID";
  } catch {
    return "TIME_INVALID";
  }
}

/**
 * Nhập một lô phép đo cho một adapter đã duyệt. Dùng chung cho route của adapter và cho máy đo giả lập của chế độ dev (cùng một
 * đường xử lý, cùng danh tính adapter). Chạy trong giao dịch của route.
 */
export function importBatch(ctx: Ctx, ws: string, adapter: AdapterRow, items: ImportItem[], requestId: string | null): ItemResult[] {
  const now = ctx.clock.now();
  const at = iso(now);
  const out: ItemResult[] = [];
  for (const item of items) {
    const sk = item.source_key;
    const ms = instantOf(item);
    if (typeof ms === "string") {
      out.push({ source_key: sk, result: "REJECTED", detail_code: ms });
      continue;
    }
    if (ms > now + MEAS_LIMITS.futureSkewMs || ms < now - MEAS_LIMITS.maxAgeMs) {
      out.push({ source_key: sk, result: "REJECTED", detail_code: "TIME_INVALID" });
      continue;
    }
    const [sLo, sHi] = MEAS_LIMITS.systolic;
    const [dLo, dHi] = MEAS_LIMITS.diastolic;
    if (item.systolic < sLo || item.systolic > sHi || item.diastolic < dLo || item.diastolic > dHi || item.systolic <= item.diastolic) {
      out.push({ source_key: sk, result: "REJECTED", detail_code: "VALUE_OUT_OF_RANGE" });
      continue;
    }
    const instant = iso(ms);
    const quality = item.quality_flags.length ? "QUESTIONABLE" : "VALID";
    const dedupe = digestJcs({ device_ref: item.device_ref, user_slot: item.user_slot, measured_instant: instant });
    const content = digestJcs({ dedupe, systolic: item.systolic, diastolic: item.diastolic, unit: item.unit, quality });
    // Tầng 1: cùng kênh gửi lại cùng khóa nguồn.
    const seen = one<{ digest: string; record_id: string }>(ctx.db, "SELECT digest, record_id FROM meas_source_keys WHERE workspace_id = ? AND adapter_id = ? AND source_key = ?", ws, adapter.adapter_id, sk);
    if (seen) {
      out.push(seen.digest === content ? { source_key: sk, result: "DUPLICATE", record_ref: seen.record_id } : { source_key: sk, result: "REJECTED", detail_code: "SOURCE_KEY_REUSED" });
      continue;
    }
    const remember = (type: "OBSERVATION" | "QUARANTINE", id: string) =>
      run(ctx.db, "INSERT INTO meas_source_keys (workspace_id, adapter_id, source_key, digest, record_type, record_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)", ws, adapter.adapter_id, sk, content, type, id, at);
    // Phép đo đã bị xóa: không sống lại qua kênh nào.
    if (one(ctx.db, "SELECT 1 FROM meas_tombstones WHERE workspace_id = ? AND dedupe_key = ?", ws, dedupe)) {
      out.push({ source_key: sk, result: "DUPLICATE", record_ref: null });
      continue;
    }
    // Tầng 2: cùng phép đo (máy, hồ sơ, thời điểm) đã tới qua kênh khác.
    const sameObs = one<ObservationRow>(ctx.db, "SELECT * FROM meas_observations WHERE workspace_id = ? AND dedupe_key = ? ORDER BY created_at LIMIT 1", ws, dedupe);
    const sameQ = sameObs ? undefined : one<QuarantineRow>(ctx.db, "SELECT * FROM meas_quarantine WHERE workspace_id = ? AND dedupe_key = ? AND state = 'MEAS_QUARANTINED' ORDER BY created_at LIMIT 1", ws, dedupe);
    const quarantine = (reason: Reason, candidates: string[], mappingId: string | null) => {
      const id = `mqr_${uuid()}`;
      run(ctx.db, `INSERT INTO meas_quarantine (id, workspace_id, adapter_id, device_ref, user_slot, measured_at, zone, measured_instant, received_at, systolic, diastolic, unit,
        quality_status, dedupe_key, reason, mapping_id, candidates, answers, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'MEAS_QUARANTINED', ?)`,
        id, ws, adapter.adapter_id, item.device_ref, item.user_slot, item.measured_at, item.zone, instant, at, item.systolic, item.diastolic, item.unit, quality, dedupe, reason, mappingId, JSON.stringify(candidates), at);
      remember("QUARANTINE", id);
      out.push({ source_key: sk, result: "QUARANTINED", record_ref: id, reason });
    };
    if (sameObs || sameQ) {
      const prev = sameObs ?? (sameQ as QuarantineRow);
      const prevContent = digestJcs({ dedupe, systolic: prev.systolic, diastolic: prev.diastolic, unit: prev.unit, quality: prev.quality_status });
      if (prevContent === content) {
        remember(sameObs ? "OBSERVATION" : "QUARANTINE", prev.id);
        out.push({ source_key: sk, result: "DUPLICATE", record_ref: prev.id });
      } else {
        quarantine("SOURCE_CONFLICT", sameObs ? [sameObs.subject] : parseList((sameQ as QuarantineRow).candidates), null);
      }
      continue;
    }
    const route = routeOf(ctx, ws, item.device_ref, item.user_slot);
    if (route.assign) {
      if (!entitled(ctx, ws, route.assign)) {
        out.push({ source_key: sk, result: "REJECTED", detail_code: "SUBJECT_UNAVAILABLE" });
        continue;
      }
      const id = `mob_${uuid()}`;
      run(ctx.db, `INSERT INTO meas_observations (id, workspace_id, subject, adapter_id, device_ref, user_slot, measured_at, zone, measured_instant, received_at, systolic, diastolic,
        unit, quality_status, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ws, route.assign, adapter.adapter_id, item.device_ref, item.user_slot, item.measured_at, item.zone, instant, at, item.systolic, item.diastolic, item.unit, quality, dedupe, at);
      remember("OBSERVATION", id);
      out.push({ source_key: sk, result: "ACCEPTED", record_ref: id });
      continue;
    }
    if (route.reason) {
      quarantine(route.reason, route.candidates, null);
      continue;
    }
    // Chưa ai xác nhận máy này: adapter chỉ được đề nghị một người (subject_hint), người đó phải tự xác nhận.
    const hint = item.subject_hint;
    if (hint && entitled(ctx, ws, hint)) {
      const slot = item.user_slot ?? 0;
      const existing = all<MappingRow>(ctx.db, "SELECT * FROM meas_mappings WHERE workspace_id = ? AND device_ref = ? AND user_slot = ? AND subject = ? ORDER BY created_at DESC", ws, item.device_ref, slot, hint);
      if (existing.some((m) => m.state === "MEASMAP_REJECTED")) {
        quarantine("SUBJECT_MISSING", [], null); // người đó đã nói không phải máy của mình: không đề nghị lại
        continue;
      }
      let mapping = existing.find((m) => m.state === "MEASMAP_PROPOSED");
      if (!mapping) {
        const mid = `mmp_${uuid()}`;
        run(ctx.db, "INSERT INTO meas_mappings (id, workspace_id, device_ref, user_slot, subject, state, proposed_by, created_at) VALUES (?, ?, ?, ?, ?, 'MEASMAP_PROPOSED', ?, ?)",
          mid, ws, item.device_ref, slot, hint, adapter.adapter_id, at);
        mapping = one<MappingRow>(ctx.db, "SELECT * FROM meas_mappings WHERE id = ?", mid) as MappingRow;
      }
      quarantine("MAPPING_UNCONFIRMED", [hint], mapping.id);
      continue;
    }
    quarantine("SUBJECT_MISSING", [], null);
  }
  run(ctx.db, "UPDATE meas_adapters SET last_seen_at = ? WHERE adapter_id = ?", at, adapter.adapter_id);
  const count = (r: string) => out.filter((x) => x.result === r).length;
  // Audit chỉ có số đếm: không giá trị đo, không người được đo, không mã máy (SRS V2.0 mục 11).
  audit(ctx.db, at, {
    workspace_id: ws, actor: adapter.principal_sub, action: "measurements.import", target: adapter.adapter_id, request_id: requestId,
    data: { accepted: count("ACCEPTED"), quarantined: count("QUARANTINED"), duplicate: count("DUPLICATE"), rejected: count("REJECTED") },
  });
  return out;
}

function importRoute(c: Call): Stored {
  const { ctx } = c.d;
  const adapter = adapterOf(ctx, c.ws, c.p.sub);
  if (!adapter) throw new ApiError(403, "FORBIDDEN");
  if (!ctx.control.moduleOn(GATE.module)) throw new ApiError(503, "MODULE_DISABLED");
  const b = c.body as { observations: ImportItem[] };
  const results = importBatch(ctx, c.ws, adapter, b.observations, c.requestId);
  return { status: 200, body: { adapter_id: adapter.adapter_id, trust: adapter.trust, results }, resource: { type: "meas_import", id: adapter.adapter_id } };
}

// ── Máy đo giả lập (chỉ chế độ dev) ───────────────────────────────────────────────────────────────────────────────────────────

const LAST_SIM = new WeakMap<Ctx, Map<string, { channel: string; item: ImportItem }[]>>();
const LAST_AT = new WeakMap<Ctx, Map<string, number>>();

/**
 * Thành viên bấm «Máy đo giả lập»: adapter mô phỏng trong tiến trình máy chủ phát một phép đo tổng hợp rồi đi đúng đường nhập
 * của adapter (importBatch với danh tính adapter, không phải danh tính người bấm). Chỉ có khi chạy với issuer phát triển; ở
 * mọi nơi khác trả 404. Phản hồi không có giá trị đo.
 */
function simReading(c: Call): Stored {
  const { ctx } = c.d;
  if (!c.d.dev) throw notFound();
  memberGate(c);
  const b = c.body as { device: "SHARED" | "PERSONAL"; user_slot: number; hint_self: boolean; channel: "PHONE_GATEWAY" | "PARTNER_CLOUD" | "BOTH"; repeat_last: boolean };
  const channels = b.channel === "BOTH" ? (["PHONE_GATEWAY", "PARTNER_CLOUD"] as const) : [b.channel];
  const memo = LAST_SIM.get(ctx) ?? new Map();
  LAST_SIM.set(ctx, memo);
  const memoKey = `${c.ws}|${c.p.sub}`;
  let batch: { channel: string; item: ImportItem }[];
  if (b.repeat_last && memo.get(memoKey)) batch = memo.get(memoKey) as { channel: string; item: ImportItem }[];
  else {
    // Một máy đo thật không cho hai lần đo trong cùng một giây: máy giả lập giữ thời điểm tăng dần theo từng máy.
    const deviceKey = `${c.ws}|${b.device === "SHARED" ? "shared" : c.p.sub}`;
    const prev = LAST_AT.get(ctx)?.get(deviceKey) ?? 0;
    const now = Math.max(Math.floor((ctx.clock.now() - MINUTE) / 1000) * 1000, prev + 1000);
    if (!LAST_AT.has(ctx)) LAST_AT.set(ctx, new Map());
    LAST_AT.get(ctx)?.set(deviceKey, now);
    const p = localParts(now, "Asia/Ho_Chi_Minh");
    const pad = (n: number) => String(n).padStart(2, "0");
    const measuredAt = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+07:00`;
    const r = Number.parseInt(uuid().replace(/[^0-9a-f]/gi, "").slice(0, 6), 16);
    const item: ImportItem = {
      source_key: "", device_ref: b.device === "SHARED" ? "sim_cuff_shared" : `sim_cuff_${c.p.sub}`.slice(0, 64), user_slot: b.user_slot === 0 ? null : b.user_slot,
      subject_hint: b.hint_self ? c.p.sub : null, measured_at: measuredAt, zone: null, systolic: 108 + (r % 27), diastolic: 66 + ((r >> 5) % 17), unit: "mmHg", quality_flags: [],
    };
    batch = channels.map((channel) => ({ channel, item: { ...item, source_key: `sim-${uuid()}` } }));
  }
  memo.set(memoKey, batch);
  const results = batch.map(({ channel, item }) => {
    const adapter = one<AdapterRow>(ctx.db, "SELECT * FROM meas_adapters WHERE workspace_id = ? AND channel = ? AND status = 'APPROVED' ORDER BY adapter_id LIMIT 1", c.ws, channel);
    if (!adapter) throw new ApiError(422, "MEAS_ADAPTER_MISSING");
    return { adapter_id: adapter.adapter_id, channel, label: "SIMULATED", ...importBatch(ctx, c.ws, adapter, [item], c.requestId)[0] };
  });
  return { status: 200, body: { label: "SIMULATED", results }, resource: { type: "meas_sim", id: c.p.sub } };
}

// ── Người được đo ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const observationView = (o: ObservationRow) => ({
  observation_id: o.id, subject_ref: o.subject, source: o.adapter_id, device_ref: o.device_ref, measured_at: o.measured_at, received_at: o.received_at,
  systolic: o.systolic, diastolic: o.diastolic, unit: o.unit, quality_status: o.quality_status,
});

const sourcesView = (ctx: Ctx, ws: string) =>
  all<AdapterRow>(ctx.db, "SELECT * FROM meas_adapters WHERE workspace_id = ? ORDER BY adapter_id", ws).map((a) => ({ adapter_id: a.adapter_id, channel: a.channel, trust: a.trust, status: a.status }));

const ownObservations = (ctx: Ctx, ws: string, user: string) =>
  all<ObservationRow>(ctx.db, "SELECT * FROM meas_observations WHERE workspace_id = ? AND subject = ? ORDER BY measured_instant DESC, id LIMIT ?", ws, user, MEAS_LIMITS.listPage);

function listObservations(c: Call): Stored {
  gate(c);
  const { ctx } = c.d;
  return { status: 200, body: { observations: ownObservations(ctx, c.ws, c.p.sub).map(observationView), sources: sourcesView(ctx, c.ws), disclaimer_code: "NOT_A_DIAGNOSTIC_DEVICE" } };
}

const mappingView = (ctx: Ctx, m: MappingRow) => ({
  mapping_id: m.id, device_ref: m.device_ref, user_slot: m.user_slot, state: m.state, proposed_by: m.proposed_by, created_at: m.created_at, decided_at: m.decided_at,
  pending_records: (one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM meas_quarantine WHERE mapping_id = ? AND state = 'MEAS_QUARANTINED'", m.id) as { n: number }).n,
});

const ownMapping = (ctx: Ctx, ws: string, user: string, id: string) => {
  const m = one<MappingRow>(ctx.db, "SELECT * FROM meas_mappings WHERE id = ? AND workspace_id = ? AND subject = ?", id, ws, user);
  if (!m) throw notFound();
  return m;
};

function listMappings(c: Call): Stored {
  gate(c);
  const rows = all<MappingRow>(c.d.ctx.db, "SELECT * FROM meas_mappings WHERE workspace_id = ? AND subject = ? ORDER BY created_at DESC, id LIMIT 100", c.ws, c.p.sub);
  return { status: 200, body: { mappings: rows.map((m) => mappingView(c.d.ctx, m)) } };
}

/** Gán một bản ghi cách ly cho một người: chuyển giá trị sang meas_observations, bản cách ly chỉ còn siêu dữ liệu. */
function assign(ctx: Ctx, r: QuarantineRow, subject: string, event: string, at: string) {
  const id = `mob_${uuid()}`;
  run(ctx.db, `INSERT INTO meas_observations (id, workspace_id, subject, adapter_id, device_ref, user_slot, measured_at, zone, measured_instant, received_at, systolic, diastolic,
    unit, quality_status, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, r.workspace_id, subject, r.adapter_id, r.device_ref, r.user_slot, r.measured_at, r.zone, r.measured_instant, r.received_at, r.systolic, r.diastolic, r.unit, r.quality_status, r.dedupe_key, at);
  run(ctx.db, "UPDATE meas_source_keys SET record_type = 'OBSERVATION', record_id = ? WHERE record_type = 'QUARANTINE' AND record_id = ?", id, r.id);
  stepQ(ctx, r, event, "PERSON", at, { observation_id: id });
  return id;
}

function confirmMapping(c: Call): Stored {
  gate(c);
  const { ctx } = c.d;
  const at = nowIso(ctx);
  const m = stepMap(ctx, ownMapping(ctx, c.ws, c.p.sub, c.params.mapping_id), "confirm", "PERSON", at);
  let assigned = 0;
  let conflicted = 0;
  for (const r of all<QuarantineRow>(ctx.db, "SELECT * FROM meas_quarantine WHERE mapping_id = ? AND state = 'MEAS_QUARANTINED' AND reason = 'MAPPING_UNCONFIRMED' ORDER BY created_at", m.id)) {
    const route = routeOf(ctx, c.ws, r.device_ref, r.user_slot);
    if (route.assign === c.p.sub) {
      assign(ctx, r, c.p.sub, "mapping_confirmed", at);
      assigned++;
    } else {
      // Người khác cũng đã xác nhận cùng máy và hồ sơ: không gán bằng suy đoán, mọi ứng viên phải trả lời (X08).
      const candidates = [...new Set([...parseList(r.candidates), ...route.candidates])];
      stepQ(ctx, r, "conflict", "AUTHORITY", at, { candidates: JSON.stringify(candidates), reason: route.reason ?? "PROFILE_CONFLICT" });
      conflicted++;
    }
  }
  logAccess(ctx, c.ws, c.p.sub, c.p.sub, "MAPPING_CONFIRMED", m.id, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "measurements.mapping.confirm", target: m.id, request_id: c.requestId, data: { assigned, conflicted } });
  return { status: 200, body: { ...mappingView(ctx, m), assigned, conflicted }, resource: { type: "meas_mapping", id: m.id } };
}

function rejectMapping(c: Call): Stored {
  gate(c);
  const { ctx } = c.d;
  const at = nowIso(ctx);
  const before = ownMapping(ctx, c.ws, c.p.sub, c.params.mapping_id);
  const m = stepMap(ctx, before, before.state === "MEASMAP_CONFIRMED" ? "unlink" : "reject", "PERSON", at);
  let discarded = 0;
  for (const r of all<QuarantineRow>(ctx.db, "SELECT * FROM meas_quarantine WHERE mapping_id = ? AND state = 'MEAS_QUARANTINED' AND reason = 'MAPPING_UNCONFIRMED'", m.id)) {
    if (parseList(r.candidates).length === 1) {
      stepQ(ctx, r, "mapping_rejected", "PERSON", at);
      discarded++;
    }
  }
  journalRevocation(ctx, "meas_mapping_ended", at, { workspace_id: c.ws, mapping_id: m.id });
  logAccess(ctx, c.ws, c.p.sub, c.p.sub, "MAPPING_REJECTED", m.id, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "measurements.mapping.end", target: m.id, request_id: c.requestId, data: { state: m.state } });
  return { status: 200, body: { ...mappingView(ctx, m), discarded }, resource: { type: "meas_mapping", id: m.id } };
}

const quarantineView = (r: QuarantineRow, user: string) => {
  const answers = JSON.parse(r.answers) as Record<string, string>;
  const candidates = parseList(r.candidates);
  return {
    record_id: r.id, state: r.state, reason: r.reason, source: r.adapter_id, device_ref: r.device_ref, user_slot: r.user_slot, measured_at: r.measured_at, received_at: r.received_at,
    mapping_id: r.mapping_id, my_answer: answers[user] ?? null, candidates: candidates.length, answered: candidates.filter((x) => answers[x]).length,
  };
};

/** Bản ghi cách ly mà người này là ứng viên. Không có giá trị đo: người kia cùng dùng máy có thể là ứng viên. */
const candidateRecords = (ctx: Ctx, ws: string, user: string) =>
  all<QuarantineRow>(ctx.db, "SELECT q.* FROM meas_quarantine q, json_each(q.candidates) j WHERE q.workspace_id = ? AND q.state = 'MEAS_QUARANTINED' AND j.value = ? ORDER BY q.measured_instant DESC LIMIT 200", ws, user);

function listQuarantine(c: Call): Stored {
  gate(c);
  return { status: 200, body: { records: candidateRecords(c.d.ctx, c.ws, c.p.sub).map((r) => quarantineView(r, c.p.sub)), retention_days: MEAS_LIMITS.quarantineRetentionMs / DAY } };
}

function resolveRecord(c: Call): Stored {
  gate(c);
  const { ctx } = c.d;
  const at = nowIso(ctx);
  const r = one<QuarantineRow>(ctx.db, "SELECT * FROM meas_quarantine WHERE id = ? AND workspace_id = ?", c.params.record_id, c.ws);
  if (!r || !parseList(r.candidates).includes(c.p.sub)) throw notFound();
  if (r.state !== "MEAS_QUARANTINED") throw invalidTransition();
  const answers = { ...(JSON.parse(r.answers) as Record<string, string>), [c.p.sub]: (c.body as { answer: string }).answer };
  run(ctx.db, "UPDATE meas_quarantine SET answers = ? WHERE id = ?", JSON.stringify(answers), r.id);
  const candidates = parseList(r.candidates);
  const next = { ...r, answers: JSON.stringify(answers) };
  let outcome: "WAITING" | "ASSIGNED" | "DISCARDED" | "CONTESTED" = "WAITING";
  if (candidates.every((x) => answers[x])) {
    const mine = candidates.filter((x) => answers[x] === "MINE");
    if (mine.length === 0) {
      stepQ(ctx, next, "discard", "PERSON", at);
      outcome = "DISCARDED";
    } else if (mine.length === 1 && entitled(ctx, c.ws, mine[0])) {
      assign(ctx, next, mine[0], "resolve", at);
      outcome = "ASSIGNED";
    } else outcome = "CONTESTED"; // hai người cùng nhận: giữ cách ly, chờ sửa câu trả lời hoặc hết hạn
  }
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "measurements.quarantine.answer", target: r.id, request_id: c.requestId, data: { outcome } });
  const now = one<QuarantineRow>(ctx.db, "SELECT * FROM meas_quarantine WHERE id = ?", r.id) as QuarantineRow;
  // Người trả lời chỉ biết bản ghi đã gán hay chưa, không biết gán cho ai.
  return { status: 200, body: { ...quarantineView(now, c.p.sub), outcome: outcome === "ASSIGNED" && answers[c.p.sub] !== "MINE" ? "RESOLVED" : outcome }, resource: { type: "meas_quarantine", id: r.id } };
}

// ── Chia sẻ có grant ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const shareView = (s: ShareRow) => ({
  share_id: s.id, owner: s.owner, grantee: s.grantee, purpose: s.purpose, scope: { kind: "blood_pressure", from_date: s.data_from, received_until: s.data_until },
  expires_at: s.expires_at, state: s.state, created_at: s.created_at, ended_at: s.ended_at,
});

/** Grant còn dùng được ngay lúc đọc: ACTIVE, chưa tới hạn, chủ dữ liệu còn dùng Le‑NodeHealth, người xem còn là thành viên. */
const shareUsable = (ctx: Ctx, s: ShareRow) => s.state === "MEASSHARE_ACTIVE" && s.expires_at > nowIso(ctx) && entitled(ctx, s.workspace_id, s.owner) && isActiveMember(ctx, s.workspace_id, s.grantee);

function listShares(c: Call): Stored {
  memberGate(c);
  const { ctx } = c.d;
  const granted = all<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE workspace_id = ? AND owner = ? ORDER BY created_at DESC LIMIT 50", c.ws, c.p.sub).map(shareView);
  const received = all<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE workspace_id = ? AND grantee = ? AND state = 'MEASSHARE_ACTIVE' ORDER BY created_at DESC LIMIT 50", c.ws, c.p.sub)
    .filter((s) => shareUsable(ctx, s))
    .map((s) => ({ ...shareView(s), owner_name: member(ctx, c.ws, s.owner)?.display_name ?? s.owner }));
  const people = entitled(ctx, c.ws, c.p.sub)
    ? all<{ user_id: string; display_name: string }>(ctx.db, "SELECT user_id, display_name FROM members WHERE workspace_id = ? AND status = 'ACTIVE' AND user_id <> ? ORDER BY display_name, user_id", c.ws, c.p.sub)
      .map((m) => ({ user_id: m.user_id, name: m.display_name }))
    : [];
  const log = all<{ actor: string; action: string; ref: string | null; at: string }>(ctx.db, "SELECT actor, action, ref, at FROM meas_access WHERE workspace_id = ? AND owner = ? ORDER BY at DESC, rowid DESC LIMIT ?", c.ws, c.p.sub, MEAS_LIMITS.accessLogPage);
  return { status: 200, body: { granted, received, people, access_log: log } };
}

function createShare(c: Call): Stored {
  gate(c);
  const { ctx } = c.d;
  const b = c.body as { grantee_user: string; purpose: ShareRow["purpose"]; from_date: string; expires_in_days: number };
  if (b.grantee_user === c.p.sub || !isActiveMember(ctx, c.ws, b.grantee_user)) throw notFound();
  if (Number.isNaN(Date.parse(b.from_date + "T00:00:00Z"))) throw new ApiError(400, "SCHEMA_INVALID");
  const active = (one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM meas_shares WHERE workspace_id = ? AND owner = ? AND state = 'MEASSHARE_ACTIVE'", c.ws, c.p.sub) as { n: number }).n;
  if (active >= MEAS_LIMITS.activeShares) throw new ApiError(422, "MEAS_SHARE_LIMIT");
  const now = ctx.clock.now();
  const at = iso(now);
  const id = `msh_${uuid()}`;
  // data_until = lúc cấp: phép đo nhận sau đó không bao giờ nằm trong grant này (X09).
  run(ctx.db, "INSERT INTO meas_shares (id, workspace_id, owner, grantee, purpose, data_from, data_until, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MEASSHARE_ACTIVE', ?)",
    id, c.ws, c.p.sub, b.grantee_user, b.purpose, b.from_date, at, iso(now + b.expires_in_days * DAY), at);
  logAccess(ctx, c.ws, c.p.sub, c.p.sub, "SHARE_CREATED", id, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "measurements.share.create", target: id, request_id: c.requestId, data: { purpose: b.purpose, days: b.expires_in_days } });
  return { status: 201, body: shareView(one<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE id = ?", id) as ShareRow), resource: { type: "meas_share", id } };
}

function revokeShare(c: Call): Stored {
  memberGate(c);
  const { ctx } = c.d;
  const at = nowIso(ctx);
  const s = one<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE id = ? AND workspace_id = ? AND owner = ?", c.params.share_id, c.ws, c.p.sub);
  if (!s) throw notFound();
  const next = stepShare(ctx, s, "revoke", "OWNER", at);
  journalRevocation(ctx, "meas_share_revoked", at, { workspace_id: c.ws, share_id: s.id });
  logAccess(ctx, c.ws, c.p.sub, c.p.sub, "SHARE_REVOKED", s.id, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "measurements.share.revoke", target: s.id, request_id: c.requestId });
  return { status: 200, body: shareView(next), resource: { type: "meas_share", id: s.id } };
}

/** Người xem đọc qua grant: chỉ phép đo hợp lệ từ ngày trong phạm vi, NHẬN trước lúc cấp; mỗi lần đọc có nhật ký cho chủ dữ liệu. */
function sharedObservations(c: Call): Stored {
  memberGate(c);
  const { ctx } = c.d;
  const s = one<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE id = ? AND workspace_id = ? AND grantee = ?", c.params.share_id, c.ws, c.p.sub);
  if (!s || !shareUsable(ctx, s)) throw notFound();
  const rows = all<ObservationRow>(ctx.db,
    "SELECT * FROM meas_observations WHERE workspace_id = ? AND subject = ? AND substr(measured_at, 1, 10) >= ? AND received_at <= ? ORDER BY measured_instant DESC, id LIMIT ?",
    c.ws, s.owner, s.data_from, s.data_until, MEAS_LIMITS.listPage);
  logAccess(ctx, c.ws, s.owner, c.p.sub, "SHARE_VIEWED", s.id, nowIso(ctx));
  return { status: 200, body: { share: shareView(s), owner_name: member(ctx, c.ws, s.owner)?.display_name ?? s.owner, observations: rows.map(observationView), disclaimer_code: "NOT_A_DIAGNOSTIC_DEVICE" } };
}

// ── Xuất, xóa ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Phần Le‑NodeHealth của tệp xuất: phép đo của chính người đó, ánh xạ, grant đã cấp, nhật ký truy cập. Không có dữ liệu của người khác. */
export function exportMeasurementsFor(ctx: Ctx, ws: string, user: string) {
  const observations = all<ObservationRow>(ctx.db, "SELECT * FROM meas_observations WHERE workspace_id = ? AND subject = ? ORDER BY measured_instant, id", ws, user)
    .map((o) => ({ ...observationView(o), zone: o.zone, user_slot: o.user_slot }));
  const mappings = all<MappingRow>(ctx.db, "SELECT * FROM meas_mappings WHERE workspace_id = ? AND subject = ? ORDER BY created_at, id", ws, user)
    .map((m) => ({ mapping_id: m.id, device_ref: m.device_ref, user_slot: m.user_slot, state: m.state, created_at: m.created_at, decided_at: m.decided_at }));
  const shares = all<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE workspace_id = ? AND owner = ? ORDER BY created_at, id", ws, user).map(shareView);
  const access_log = all<{ actor: string; action: string; ref: string | null; at: string }>(ctx.db, "SELECT actor, action, ref, at FROM meas_access WHERE workspace_id = ? AND owner = ? ORDER BY at, rowid", ws, user);
  if (!observations.length && !mappings.length && !shares.length && !access_log.length) return undefined;
  return {
    format: "LNH-MEAS-EXPORT-1",
    scope: "Phép đo huyết áp của chính bạn mà máy chủ LeNhip đang giữ (Le‑NodeHealth), cùng ánh xạ máy đo, grant chia sẻ và nhật ký truy cập. Dữ liệu tổng hợp của bản tham chiếu; không phải hồ sơ y tế, không phải thiết bị y tế chẩn đoán.",
    observations, mappings, shares, access_log,
  };
}

function exportRoute(c: Call): Stored {
  memberGate(c);
  const { ctx } = c.d;
  const at = nowIso(ctx);
  const body = exportMeasurementsFor(ctx, c.ws, c.p.sub) ?? { format: "LNH-MEAS-EXPORT-1", observations: [], mappings: [], shares: [], access_log: [] };
  logAccess(ctx, c.ws, c.p.sub, c.p.sub, "EXPORTED", null, at);
  return { status: 200, body: { ...body, exported_at: at } };
}

function deleteObservationRow(ctx: Ctx, ws: string, o: { id: string; dedupe_key: string }, at: string) {
  run(ctx.db, "DELETE FROM meas_observations WHERE id = ?", o.id);
  run(ctx.db, "INSERT OR IGNORE INTO meas_tombstones (workspace_id, dedupe_key, at) VALUES (?, ?, ?)", ws, o.dedupe_key, at);
}

function deleteObservation(c: Call): Stored {
  memberGate(c);
  const { ctx } = c.d;
  const at = nowIso(ctx);
  const o = one<ObservationRow>(ctx.db, "SELECT * FROM meas_observations WHERE id = ? AND workspace_id = ? AND subject = ?", c.params.observation_id, c.ws, c.p.sub);
  if (!o) throw notFound();
  deleteObservationRow(ctx, c.ws, o, at);
  journalRevocation(ctx, "meas_observation_deleted", at, { workspace_id: c.ws, observation_id: o.id, dedupe_key: o.dedupe_key });
  logAccess(ctx, c.ws, c.p.sub, c.p.sub, "DELETED", o.id, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "measurements.observation.delete", target: o.id, request_id: c.requestId });
  return { status: 200, body: { observation_id: o.id, deleted: true }, resource: { type: "meas_observation", id: o.id } };
}

/** Bỏ người này khỏi mọi ánh xạ, grant và danh sách ứng viên. Dùng khi rút đồng ý, hạn chế xử lý, xóa toàn bộ. Không ghi sổ thu hồi. */
function withdrawPerson(ctx: Ctx, ws: string, user: string, at: string): boolean {
  let changed = false;
  for (const m of all<MappingRow>(ctx.db, "SELECT * FROM meas_mappings WHERE workspace_id = ? AND subject = ? AND state IN ('MEASMAP_PROPOSED','MEASMAP_CONFIRMED')", ws, user)) {
    stepMap(ctx, m, "revoke", "AUTHORITY", at);
    changed = true;
  }
  for (const s of all<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE workspace_id = ? AND (owner = ? OR grantee = ?) AND state = 'MEASSHARE_ACTIVE'", ws, user, user)) {
    stepShare(ctx, s, "withdraw", "AUTHORITY", at);
    logAccess(ctx, ws, s.owner, "authority", "SHARE_ENDED", s.id, at);
    changed = true;
  }
  for (const r of candidateRecords(ctx, ws, user)) {
    const candidates = parseList(r.candidates).filter((x) => x !== user);
    const answers = JSON.parse(r.answers) as Record<string, string>;
    delete answers[user];
    // Một người rời đi thì bản ghi không còn được gán bằng câu trả lời của người đó; nó chờ người còn lại hoặc hết hạn.
    run(ctx.db, "UPDATE meas_quarantine SET candidates = ?, answers = ? WHERE id = ?", JSON.stringify(candidates), JSON.stringify(answers), r.id);
    changed = true;
  }
  return changed;
}

function eraseFor(ctx: Ctx, ws: string, user: string, at: string, upTo: string | null): number {
  let n = 0;
  for (const o of all<ObservationRow>(ctx.db, "SELECT * FROM meas_observations WHERE workspace_id = ? AND subject = ? AND (? IS NULL OR received_at <= ?)", ws, user, upTo, upTo ?? "")) {
    deleteObservationRow(ctx, ws, o, at);
    n++;
  }
  return n;
}

function erase(c: Call): Stored {
  memberGate(c);
  const { ctx } = c.d;
  const now = ctx.clock.now();
  if (c.p.auth_time === null || now / 1000 - c.p.auth_time > ctx.config.reauthMaxAgeS) throw new ApiError(401, "REAUTH_REQUIRED");
  const at = iso(now);
  const deleted = eraseFor(ctx, c.ws, c.p.sub, at, null);
  withdrawPerson(ctx, c.ws, c.p.sub, at);
  journalRevocation(ctx, "meas_erased", at, { workspace_id: c.ws, user_id: c.p.sub });
  logAccess(ctx, c.ws, c.p.sub, c.p.sub, "DELETED", null, at);
  audit(ctx.db, at, { workspace_id: c.ws, actor: c.p.sub, action: "measurements.erase", target: c.p.sub, request_id: c.requestId, data: { deleted } });
  return { status: 200, body: { deleted }, resource: { type: "meas_erase", id: c.p.sub } };
}

/** Xóa mọi thứ của một người (yêu cầu DELETE của lõi, hoặc nạp lại member_deleted). */
function purgeMember(ctx: Ctx, ws: string, user: string, at: string): boolean {
  const n = eraseFor(ctx, ws, user, at, null);
  const changed = withdrawPerson(ctx, ws, user, at);
  const m = Number(run(ctx.db, "DELETE FROM meas_mappings WHERE workspace_id = ? AND subject = ?", ws, user).changes)
    + Number(run(ctx.db, "DELETE FROM meas_shares WHERE workspace_id = ? AND (owner = ? OR grantee = ?)", ws, user, user).changes)
    + Number(run(ctx.db, "DELETE FROM meas_access WHERE workspace_id = ? AND (owner = ? OR actor = ?)", ws, user, user).changes)
    + Number(run(ctx.db, "DELETE FROM idem_keys WHERE workspace_id = ? AND actor = ? AND substr(route, 1, 11) = '/v2/health/'", ws, user).changes);
  return n > 0 || m > 0 || changed;
}

// ── LeLS / vận hành: chỉ tình trạng kết nối ───────────────────────────────────────────────────────────────────────────────────

function supportAdapters(c: Call): Stored {
  const m = requireMember(c.d.ctx, c.ws, c.p.sub);
  requireRole(m, "LEDB_OPERATOR", "SITE_OPERATOR");
  const { ctx } = c.d;
  const adapters = all<AdapterRow>(ctx.db, "SELECT * FROM meas_adapters WHERE workspace_id = ? ORDER BY adapter_id", c.ws).map((a) => ({
    adapter_id: a.adapter_id, channel: a.channel, trust: a.trust, status: a.status, last_seen_at: a.last_seen_at,
    quarantined: (one<{ n: number }>(ctx.db, "SELECT COUNT(*) AS n FROM meas_quarantine WHERE adapter_id = ? AND state = 'MEAS_QUARANTINED'", a.adapter_id) as { n: number }).n,
  }));
  return { status: 200, body: { adapters, note_code: "SUPPORT_NO_VALUES" } };
}

// ── Định kỳ ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function sweep(ctx: Ctx, now: number) {
  const at = iso(now);
  tx(ctx.db, () => {
    for (const s of all<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE state = 'MEASSHARE_ACTIVE'")) {
      if (s.expires_at <= at) {
        stepShare(ctx, s, "expire", "SCHEDULER", at);
        logAccess(ctx, s.workspace_id, s.owner, "scheduler", "SHARE_ENDED", s.id, at);
      } else if (!entitled(ctx, s.workspace_id, s.owner) || !isActiveMember(ctx, s.workspace_id, s.grantee)) {
        // Thu hồi quyền measurements.record hay rời workspace không có hook riêng: quét ở đây (route đọc đã chặn ngay từ lúc đó).
        stepShare(ctx, s, "withdraw", "AUTHORITY", at);
        logAccess(ctx, s.workspace_id, s.owner, "authority", "SHARE_ENDED", s.id, at);
      }
    }
    const cutoff = iso(now - MEAS_LIMITS.quarantineRetentionMs);
    for (const r of all<QuarantineRow>(ctx.db, "SELECT * FROM meas_quarantine WHERE state = 'MEAS_QUARANTINED' AND created_at < ?", cutoff)) stepQ(ctx, r, "expire", "SCHEDULER", at);
    // Bản cách ly đã xong chỉ còn siêu dữ liệu; sau hạn thì bỏ hẳn. Dấu chống lặp của /v2/health/ đi cùng hạn này.
    run(ctx.db, "DELETE FROM meas_quarantine WHERE state <> 'MEAS_QUARANTINED' AND resolved_at < ?", cutoff);
  });
}

// ── Seed ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function seed(ctx: Ctx) {
  const at = nowIso(ctx);
  if (!one(ctx.db, "SELECT 1 FROM workspaces WHERE id = ?", DEMO_WS)) return;
  for (const a of SIM_ADAPTERS) {
    if (one(ctx.db, "SELECT 1 FROM meas_adapters WHERE adapter_id = ?", a.adapter_id)) continue;
    run(ctx.db, "INSERT INTO meas_adapters (adapter_id, workspace_id, principal_sub, channel, trust, status, approved_by, approved_at) VALUES (?, ?, ?, ?, 'SIMULATED', 'APPROVED', 'dev-seed', ?)",
      a.adapter_id, DEMO_WS, a.principal_sub, a.channel, at);
  }
  // Quyền measurements.record cho hai tài khoản thử; đồng ý KHÔNG cấp sẵn: người dùng tự bật ở lần mở đầu tiên.
  for (const u of DEV_USERS.filter((x) => x.sub === "dev_a" || x.sub === "dev_b")) {
    if (!isActiveMember(ctx, DEMO_WS, u.sub)) continue;
    if (one(ctx.db, "SELECT 1 FROM grants WHERE workspace_id = ? AND user_id = ? AND scope = ?", DEMO_WS, u.sub, GATE.scope)) continue;
    run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, ?, ?, NULL, 'ACTIVE', ?)", `gr_${uuid()}`, DEMO_WS, u.sub, GATE.scope, at);
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const usable = (c: Call) => c.d.ctx.control.moduleOn(GATE.module) && entitled(c.d.ctx, c.ws, c.p.sub);
const readableOwn = (table: string, col: string) => (c: Call, r: { type: string; id: string } | null) =>
  !!r && isActiveMember(c.d.ctx, c.ws, c.p.sub) && c.d.ctx.control.moduleOn(GATE.module) && !!one(c.d.ctx.db, `SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ? AND ${col} = ?`, r.id, c.ws, c.p.sub);

const ROUTES: Route[] = [
  { method: "POST", path: "/v2/health/observations/import", schema: "MeasImport", readable: (c) => !!adapterOf(c.d.ctx, c.ws, c.p.sub), handler: importRoute },
  { method: "GET", path: "/v2/health/observations", handler: listObservations },
  { method: "GET", path: "/v2/health/observations/export", handler: exportRoute },
  { method: "POST", path: "/v2/health/observations/{observation_id}/delete", schema: "Empty", optionalBody: true, readable: (c) => isActiveMember(c.d.ctx, c.ws, c.p.sub), handler: deleteObservation },
  { method: "POST", path: "/v2/health/erase", schema: "Empty", optionalBody: true, readable: (c) => isActiveMember(c.d.ctx, c.ws, c.p.sub), handler: erase },
  { method: "GET", path: "/v2/health/mappings", handler: listMappings },
  { method: "POST", path: "/v2/health/mappings/{mapping_id}/confirm", schema: "Empty", optionalBody: true, readable: (c, r) => usable(c) && readableOwn("meas_mappings", "subject")(c, r), handler: confirmMapping },
  { method: "POST", path: "/v2/health/mappings/{mapping_id}/reject", schema: "Empty", optionalBody: true, readable: (c, r) => usable(c) && readableOwn("meas_mappings", "subject")(c, r), handler: rejectMapping },
  { method: "GET", path: "/v2/health/quarantine", handler: listQuarantine },
  {
    method: "POST", path: "/v2/health/quarantine/{record_id}/resolve", schema: "MeasResolve", handler: resolveRecord,
    readable: (c, r) => usable(c) && !!r && !!one(c.d.ctx.db, "SELECT 1 FROM meas_quarantine q, json_each(q.candidates) j WHERE q.id = ? AND q.workspace_id = ? AND j.value = ?", r.id, c.ws, c.p.sub),
  },
  { method: "GET", path: "/v2/health/shares", handler: listShares },
  { method: "POST", path: "/v2/health/shares", schema: "MeasShareCreate", readable: readableOwn("meas_shares", "owner"), handler: createShare },
  { method: "POST", path: "/v2/health/shares/{share_id}/revoke", schema: "Empty", optionalBody: true, readable: readableOwn("meas_shares", "owner"), handler: revokeShare },
  { method: "GET", path: "/v2/health/shares/{share_id}/observations", handler: sharedObservations },
  { method: "POST", path: "/v2/health/sim-device/readings", schema: "MeasSimReading", readable: (c) => !!c.d.dev && isActiveMember(c.d.ctx, c.ws, c.p.sub), handler: simReading },
  { method: "GET", path: "/v2/health/support/adapters", handler: supportAdapters },
];

export const measurements: ServerModule = {
  name: "measurements",
  routes: ROUTES,
  errors: {
    MEAS_SHARE_LIMIT: "Đã đủ 10 grant chia sẻ đang hiệu lực; hãy thu hồi một grant trước khi cấp thêm.",
    MEAS_ADAPTER_MISSING: "Chưa có adapter mô phỏng cho kênh này.",
  },
  seed,
  onTick: (ctx, now) => sweep(ctx, now),
  privacy: {
    exportFor: exportMeasurementsFor,
    deleteFor: (ctx, ws, user, at) => void purgeMember(ctx, ws, user, at),
    onConsentWithdrawn(ctx, ws, user, purpose, at) {
      if (purpose === GATE.purpose) withdrawPerson(ctx, ws, user, at);
    },
    onRestrict: (ctx, ws, user, at) => void withdrawPerson(ctx, ws, user, at),
  },
  revocations: {
    meas_share_revoked: (ctx, e) => {
      const s = one<ShareRow>(ctx.db, "SELECT * FROM meas_shares WHERE id = ? AND state = 'MEASSHARE_ACTIVE'", e.share_id as string);
      return !!s && (stepShare(ctx, s, "withdraw", "AUTHORITY", e.at), true);
    },
    meas_mapping_ended: (ctx, e) => {
      const m = one<MappingRow>(ctx.db, "SELECT * FROM meas_mappings WHERE id = ? AND state IN ('MEASMAP_PROPOSED','MEASMAP_CONFIRMED')", e.mapping_id as string);
      return !!m && (stepMap(ctx, m, "revoke", "AUTHORITY", e.at), true);
    },
    meas_observation_deleted: (ctx, e) => {
      const ws = e.workspace_id as string;
      const had = Number(run(ctx.db, "DELETE FROM meas_observations WHERE id = ? OR (workspace_id = ? AND dedupe_key = ?)", e.observation_id as string, ws, e.dedupe_key as string).changes);
      const t = Number(run(ctx.db, "INSERT OR IGNORE INTO meas_tombstones (workspace_id, dedupe_key, at) VALUES (?, ?, ?)", ws, e.dedupe_key as string, e.at).changes);
      return had + t > 0;
    },
    meas_erased: (ctx, e) => eraseFor(ctx, e.workspace_id as string, e.user_id as string, e.at, e.at) > 0,
    consent_withdrawn: (ctx, e) => e.purpose_id === GATE.purpose && withdrawPerson(ctx, e.workspace_id as string, e.user_id as string, e.at),
    member_deleted: (ctx, e) => purgeMember(ctx, e.workspace_id as string, e.user_id as string, e.at),
  },
};
