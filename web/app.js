// LeNhip web (bản tham chiếu): 5 phương án giao diện của gói V1.0, nối với API /v1 theo LNH-SRS-001 V1.1.
// - Lịch và đèn đi qua plan → xem lại nội dung đã chuẩn hóa → xác nhận trong 120 giây → worker → bằng chứng; giao diện chỉ hiện
//   trạng thái theo bằng chứng, có màn hình "Chưa xác minh kết quả" (SRS mục 13).
// - Sức khỏe tính trên thiết bị bằng LNH-SLEEP-1 với dữ liệu tổng hợp; không gửi gì về máy chủ (SRS mục 05, 06, 07).
// - Chữ LeLe theo hình đã chốt (shared/lele-mark.js). LeLe chỉ đề xuất; người dùng xác nhận qua plan (SRS mục 04, 24).
import { THEMES, FONT_SIZES, ZONES, defaults, sanitizeSettings, restorePrefs, inkFor } from "./model.js";
import { Api, ApiError } from "./api.js";
import { leleMark } from "./shared/lele-mark.js";
import { digestJcs } from "./shared/jcs.js";
import { computeHealthDays, sleepSentence, formatDuration } from "./shared/sleep.js";
import { syntheticHealthInput } from "./shared/synthetic.js";
import { localParts, localDate, addDays, zonedToInstant } from "./shared/zone.js";

const KEY = "lenhip.ui.v2";
const NOTICE_VERSION = "v1-2026-11-11";
const $ = (id) => document.getElementById(id);
const glyphs = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  today: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-12 5 2 2 5-4"/>',
  health: '<path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
  work: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V4h8v3M3 12c5 3 13 3 18 0m-9 0v4"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="var(--surface)"/><circle cx="15" cy="17" r="3" fill="var(--surface)"/>',
  moon: '<path d="M20 13a8.5 8.5 0 0 1-9-10A9 9 0 1 0 20 13Z"/>',
  steps: '<path d="m8 13-4 6m11-6 4 6M8 9l4 3 3-5m-3 5-3 4m3-4 4 1"/><circle cx="15" cy="4" r="2"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  spark: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  lamp: '<path d="m7 3-4 8h12l-4-8zM9 11v10M5 21h8m1-14 5 3v11"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  robot: '<rect x="5" y="6" width="14" height="12" rx="4"/><path d="M12 2v4M2 10v5m20-5v5M8 21h8m-7-8h6"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5m0 3v.01"/>',
};
const icon = (name) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (glyphs[name] || glyphs.spark) + "</svg>";
const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const api = new Api();
let prefs = restorePrefs(readStore(KEY));
let me = null; // GET /v1/me
let online = false;
let screen = ["home", "health", "work", "house"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
let context = "personal";
let toastTimer;
let draftSettings;
let availability = null;
let devices = [];
let site = null;
let actions = [];
let health = null;
let pendingPlan = null; // { plan, input, label, digestOk }
let countdownTimer = null;
const tracked = new Set();

function readStore(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeStore(k, v) {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch {
    toast("Trình duyệt chưa cho lưu. Tùy chọn chỉ giữ trong phiên này.");
    return false;
  }
}
const sub = () => me?.user.id ?? prefs.activeSub ?? "khach";
const settings = () => prefs.users[sub()] ?? (prefs.users[sub()] = defaults(me?.user.name ?? "Bạn"));
const zone = () => settings().zone;
function savePrefs() {
  prefs.activeSub = sub();
  return writeStore(KEY, JSON.stringify(prefs));
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4500);
}
function hhmm(iso) {
  if (!iso) return "—";
  const p = localParts(Date.parse(iso), zone());
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
function hhmmss(iso) {
  if (!iso) return "—";
  const p = localParts(Date.parse(iso), zone());
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
}
const WEEKDAY = ["CHỦ NHẬT", "THỨ HAI", "THỨ BA", "THỨ TƯ", "THỨ NĂM", "THỨ SÁU", "THỨ BẢY"];
const SHORT = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
function dateLine() {
  const p = localParts(api.serverNow(), zone());
  return `${WEEKDAY[p.weekday]} · ${p.day} THÁNG ${p.month}`;
}

// ---------------------------------------------------------------- LeLe
const mark = (tone = "amber", cls = "") => leleMark({ tone, className: cls });
const askLele = () => '<button class="ask-lele" data-action="chat"><span class="mini-orb"></span><span class="ask-copy">Hỏi ' + mark("amber", "inline") + "</span>" + icon("spark") + "</button>";

// ---------------------------------------------------------------- khung
function themeButton(t, inSettings = false) {
  const isActive = (inSettings ? draftSettings.theme : settings().theme) === t.id;
  const swatch = '<span class="palette">' + t.colors.map((c) => '<i style="background:' + c + '"></i>').join("") + "</span>";
  if (inSettings) return '<button type="button" class="settings-theme ' + (isActive ? "active" : "") + '" data-draft-theme="' + t.id + '" aria-pressed="' + isActive + '">' + swatch + t.code + "</button>";
  return '<button class="theme-option ' + (isActive ? "active" : "") + '" data-theme-choice="' + t.id + '" aria-pressed="' + isActive + '">' + swatch + "<span><strong>" + t.name + "</strong><small>" + t.code + " · " + t.description + "</small></span>" + (isActive ? '<span class="selection-check">' + icon("check") + "</span>" : "") + "</button>";
}
const tabs = [["home", "today", "Hôm nay"], ["health", "health", "Sức khỏe"], ["work", "work", "Công việc"], ["house", "home", "Ngôi nhà"]];
function applyTheme() {
  const s = settings();
  document.body.dataset.theme = s.theme;
  document.body.classList.toggle("reduced-motion", s.reducedMotion);
  document.body.classList.toggle("compact", s.compact);
  document.documentElement.style.setProperty("--font-scale", s.fontSize / 100);
  document.body.classList.toggle("large-text", s.fontSize >= 150);
  if (s.accent) {
    document.body.style.setProperty("--accent", s.accent);
    document.body.style.setProperty("--accent-ink", inkFor(s.accent));
  } else {
    document.body.style.removeProperty("--accent");
    document.body.style.removeProperty("--accent-ink");
  }
  $("profile-button").textContent = (s.name || "Bạn").split(/\s+/).slice(-2).map((x) => x[0]).join("").toUpperCase();
}
function nav() {
  const html = tabs.map(([id, i, label]) => '<button class="nav-button" data-nav="' + id + '" ' + (screen === id ? 'aria-current="page"' : "") + ">" + icon(i) + "<span>" + label + "</span></button>").join("");
  $("desktop-nav").innerHTML = html;
  $("mobile-nav").innerHTML = html;
}
function contextControl() {
  return '<div class="context-switch" aria-label="Không gian hiện tại">' + [["personal", "person", "Cá nhân"], ["work", "work", "Công việc"]].map(([id, i, text]) => '<button data-context="' + id + '" class="' + (context === id ? "active" : "") + '" aria-pressed="' + (context === id) + '">' + icon(i) + text + "</button>").join("") + "</div>";
}
function orb(sceneClass = "") {
  return '<div class="orb-scene ' + sceneClass + '" aria-hidden="true"><div class="orbit-ring"></div><div class="orbit-ring second"></div><div class="orb"><span class="orb-label">' + leleMark({ tone: "duo", label: false }) + "</span></div></div>";
}
function banner() {
  const b = $("banner");
  if (!online) {
    b.hidden = false;
    b.className = "banner warn";
    b.innerHTML = icon("alert") + "<span>Chưa kết nối được máy chủ LeNhip. Sức khỏe vẫn tính trên thiết bị; lịch và đèn tạm khóa, không có thao tác giả.</span>";
  } else if (me && !me.dispatch_open) {
    b.hidden = false;
    b.className = "banner warn";
    b.innerHTML = icon("lock") + "<span>Đang đóng phát tác vụ để kiểm tra hệ thống. Bạn vẫn xem được trạng thái; thao tác mới sẽ chờ.</span>";
  } else {
    b.hidden = true;
  }
}

// ---------------------------------------------------------------- dữ liệu
async function loadMe() {
  me = await api.get("/v1/me");
  online = true;
}
function computeHealth() {
  if (!healthConsent()) {
    health = null;
    return;
  }
  health = computeHealthDays(syntheticHealthInput(api.serverNow(), zone(), healthRevision()));
}
function healthKey() {
  return `lenhip.health.v1.${sub()}`;
}
function healthState() {
  try {
    return JSON.parse(readStore(healthKey()) ?? "null");
  } catch {
    return null;
  }
}
function healthConsent() {
  const s = healthState();
  return !!s && s.receipt?.choice === "GRANTED" && !s.receipt.withdrawn_at;
}
function healthRevision() {
  return healthState()?.revision ?? 1;
}
async function loadWork() {
  if (!online || !me?.modules.calendar || !me.calendar.linked || !serverConsent("calendar_link")) {
    availability = null;
    return;
  }
  const day = localDate(api.serverNow(), zone());
  const start = new Date(zonedToInstant(day, "00:00", zone())).toISOString();
  const end = new Date(zonedToInstant(addDays(day, 2), "00:00", zone())).toISOString();
  try {
    availability = await api.get(`/v1/calendar/availability?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  } catch (e) {
    availability = { error: e instanceof ApiError ? e.code : "ERROR" };
  }
}
async function loadHouse() {
  site = me?.sites?.[0] ?? null;
  if (!online || !site || !serverConsent("home_control")) {
    devices = [];
    return;
  }
  try {
    devices = (await api.get(`/v1/devices?site=${encodeURIComponent(site.id)}`)).devices;
  } catch {
    devices = [];
  }
}
async function loadActions() {
  if (!online) return;
  try {
    actions = (await api.get("/v1/actions")).items;
  } catch {
    actions = [];
  }
}
function serverConsent(purpose) {
  const c = me?.consents?.find((x) => x.purpose_id === purpose);
  return !!c && c.choice === "GRANTED" && !c.withdrawn_at;
}
async function refresh() {
  try {
    await loadMe();
  } catch (e) {
    online = false;
    if (e instanceof ApiError && e.status === 401 && api.dev) {
      await api.login(prefs.activeSub ?? api.devUsers[0]?.sub ?? "dev_a");
      return refresh();
    }
  }
  computeHealth();
  await Promise.all([loadWork(), loadHouse(), loadActions()]);
  render();
}

// ---------------------------------------------------------------- trạng thái tác vụ
const STATUS = {
  AUTHORIZED: "Đã xác nhận · chờ gửi",
  DISPATCHING: "Đang gửi",
  ACKED: "Đã gửi · đang xác minh",
  UNKNOWN: "Chưa xác minh kết quả",
  VERIFIED: "Đã xác minh",
  FAILED: "Không thực hiện",
  CONFLICT: "Trùng lịch",
  REJECTED: "Không còn hiệu lực",
  EXPIRED: "Hết hạn",
  CANCELED: "Đã hủy",
};
const OUTCOME = {
  APPLIED: "Thiết bị đã báo trạng thái mới.",
  ALREADY_IN_STATE: "Thiết bị đã ở trạng thái này nên không gửi lệnh.",
  EVENT_CREATED: "Khung giờ đã có trong lịch công việc.",
  SIMULATED: "Mô phỏng hoàn tất (không có thiết bị thật).",
  BUSY_BEFORE_CREATE: "Khung giờ đã bận khi kiểm ngay trước lúc ghi; chưa tạo gì.",
  OVERLAP_AFTER_CREATE: "Khối đã được tạo nhưng trùng một cuộc hẹn khác. Chọn giờ khác, hoặc xóa khối trong Outlook (hủy khối từ LeNhip chưa có trong bản này).",
  EVENT_CHANGED: "Khối trong lịch đã bị sửa hoặc xóa trước khi xác minh.",
  NO_EFFECT: "Nguồn xác nhận chưa có tác động.",
};
const REASON = {
  AUTHZ_CHANGED: "Quyền của bạn đã thay đổi.",
  GRANT_REVOKED: "Quyền đã bị thu hồi.",
  CONSENT_REVOKED: "Bạn đã rút đồng ý cho mục đích này.",
  POLICY_CHANGED: "Chính sách xuất dữ liệu đã đổi.",
  BINDING_CHANGED: "Thiết bị đã reset hoặc đổi cấu hình.",
  TARGET_UNAVAILABLE: "Đích không còn sẵn sàng.",
  APPROVAL_TIMEOUT: "Quá 120 giây chưa xác nhận.",
  DISPATCH_WINDOW_PASSED: "Không gửi được trong cửa sổ 120 giây.",
  USER_CANCELED: "Bạn đã hủy.",
  USER_DENIED: "Bạn đã từ chối.",
  BARRIER_UNAVAILABLE: "Hệ thống tạm đóng phát; chưa có lệnh nào được gửi.",
  NO_BARRIER_NO_IO: "Lệnh chưa được gửi.",
  PRECHECK_ERROR: "Không đọc được trạng thái trước khi gửi; chưa gửi lệnh.",
  PROVIDER_THROTTLED: "Lịch đang giới hạn tốc độ; chưa gửi gì.",
};
const GRADE = { PROVIDER_READBACK: "đọc lại từ lịch", DEVICE_REPORTED: "thiết bị báo", PHYSICAL_OBSERVED: "quan sát độc lập", SIMULATED: "mô phỏng" };

function describe(a) {
  const p = a.preview;
  if (p.kind === "calendar.block") return `Thời gian cá nhân ${hhmm(p.start)}–${hhmm(p.end)}`;
  if (p.kind === "device.set_power") {
    const d = devices.find((x) => x.device_ref === p.target.device_ref);
    return `${p.command === "SET_ON" ? "Bật" : "Tắt"} ${d?.name ?? p.target.device_ref}`;
  }
  return "Le-ORION · kịch bản đưa tài liệu (mô phỏng)";
}
function unknownPanel(a) {
  return '<div class="unknown-panel" role="status"><strong>' + icon("alert") + "Chưa xác minh kết quả</strong><dl>" +
    "<dt>Gửi lúc</dt><dd>" + hhmmss(a.times.first_io_at ?? a.times.dispatch_claimed_at) + "</dd>" +
    "<dt>Đối soát gần nhất</dt><dd>" + hhmmss(a.times.last_check_at) + "</dd>" +
    "<dt>Cập nhật tiếp theo</dt><dd>" + hhmmss(a.deadlines.next_check) + "</dd>" +
    "<dt>Mã hỗ trợ</dt><dd><code>" + safe(a.support_code ?? "—") + "</code></dd></dl>" +
    '<p class="fine-print">Thao tác tương tự trên cùng ' + (a.kind === "calendar.block" ? "khung giờ" : "thiết bị") + " tạm khóa tới khi có bằng chứng. Không tự gửi lại." +
    (a.reconciliation_status === "ESCALATED" || a.reconciliation_status === "MANUAL_REQUIRED" ? " Đội vận hành LeDB đang xử lý." : "") + "</p>" +
    '<button class="button secondary" data-check-action="' + safe(a.action_id) + '">' + icon("clock") + "Kiểm tra trạng thái</button></div>";
}
function actionCard(a, compact = false) {
  const terminal = ["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"].includes(a.status);
  const tone = a.status === "VERIFIED" ? "ok" : a.status === "UNKNOWN" || a.status === "CONFLICT" ? "warn" : terminal ? "muted" : "busy";
  let html = '<div class="action-card ' + tone + '" data-action-id="' + safe(a.action_id) + '"><div class="action-head"><strong>' + safe(describe(a)) + '</strong><span class="status-chip ' + tone + '">' + (STATUS[a.status] ?? a.status) + "</span></div>";
  if (!compact) {
    if (a.outcome && OUTCOME[a.outcome]) html += "<p>" + OUTCOME[a.outcome] + "</p>";
    else if (a.reason && REASON[a.reason]) html += "<p>" + REASON[a.reason] + "</p>";
    if (a.evidence_grade) html += '<p class="fine-print">Bằng chứng: ' + (GRADE[a.evidence_grade] ?? a.evidence_grade) + (a.times.last_observed_at ? " lúc " + hhmmss(a.times.last_observed_at) : "") + ". Kết quả này ghi theo lúc kiểm, không đổi khi thiết bị đổi sau đó.</p>";
    if (a.cancel_requested && !terminal) html += '<p class="fine-print">Đã ghi yêu cầu hủy; lệnh đã bắt đầu nên vẫn đối soát tới khi có bằng chứng.</p>';
    if (a.status === "UNKNOWN") html += unknownPanel(a);
    else if (a.status === "AUTHORIZED") html += '<button class="text-button" data-cancel-action="' + safe(a.action_id) + '">Hủy trước khi gửi</button>';
  }
  return html + "</div>";
}

// ---------------------------------------------------------------- trang
function sleepTile() {
  if (!health) return '<button class="card" data-nav="health"><div class="stat-label">' + icon("moon") + 'Giấc ngủ</div><div class="stat-value">—</div><div class="stat-meta">Sức khỏe đang tắt trên thiết bị này</div></button>';
  const s = health.summary;
  const today = health.days[health.days.length - 1];
  const value = today.sleep_seconds !== null ? formatDuration(today.sleep_seconds) : s.sleep_average_seconds !== null ? formatDuration(s.sleep_average_seconds) : "—";
  const meta = today.sleep_seconds !== null ? "Đêm qua · dữ liệu tổng hợp" : `${s.sleep_observed_days}/7 ngày có dữ liệu · tổng hợp`;
  const bars = health.days.slice(0, 7).map((d) => '<i class="' + (d.sleep_seconds === null ? "missing" : "") + '" style="--h:' + (d.sleep_seconds === null ? 6 : Math.min(100, Math.round((d.sleep_seconds / 36000) * 100))) + '%"></i>').join("");
  return '<button class="card" data-nav="health"><div class="stat-label">' + icon("moon") + 'Giấc ngủ</div><div class="stat-value">' + safe(value).replace(/(\d+) (giờ|phút)/g, "$1 <small>$2</small>") + '</div><div class="stat-meta">' + meta + '</div><div class="spark-bars" aria-hidden="true">' + bars + "</div></button>";
}
function stepsTile() {
  if (!health) return '<button class="card" data-nav="health"><div class="stat-label">' + icon("steps") + 'Vận động</div><div class="stat-value">—</div><div class="stat-meta">Sức khỏe đang tắt trên thiết bị này</div></button>';
  const today = health.days[health.days.length - 1];
  const v = today.steps;
  return '<button class="card" data-nav="health"><div class="stat-label">' + icon("steps") + 'Vận động</div><div class="stat-value">' + (v === null ? "—" : v.toLocaleString("vi-VN") + " <small>bước</small>") + '</div><div class="stat-meta">' + (v === null ? "Hôm nay chưa có dữ liệu" : "Hôm nay, chưa đủ ngày · tổng hợp") + "</div></button>";
}
function scheduleRows(dayOffset = 0) {
  if (!online) return '<p class="empty-state">Chưa kết nối máy chủ.</p>';
  if (!me?.calendar.linked) return '<p class="empty-state">Chưa liên kết tài khoản Microsoft 365 công việc.</p>';
  if (!serverConsent("calendar_link")) return '<p class="empty-state">Bạn chưa đồng ý liên kết lịch công việc. Mở Cá nhân hóa → Quyền riêng tư để bật.</p>';
  if (!availability || availability.error) return '<p class="empty-state">Chưa đọc được lịch' + (availability?.error ? " (" + safe(availability.error) + ")" : "") + ".</p>";
  const day = addDays(localDate(api.serverNow(), zone()), dayOffset);
  const onDay = (iso) => localDate(Date.parse(iso), zone()) === day;
  const mine = availability.lenhip_blocks.filter((b) => onDay(b.start));
  const rows = [
    ...availability.busy.filter((b) => onDay(b.start) && !mine.some((m) => m.start === b.start && m.end === b.end)).map((b) => ({ start: b.start, end: b.end, title: "Bận", detail: "Lịch công việc · không hiện tiêu đề" })),
    ...mine.map((b) => ({ start: b.start, end: b.end, title: "Thời gian cá nhân", detail: "Chỉ mình tôi · " + (STATUS[b.status] ?? b.status) })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  if (!rows.length) return '<p class="empty-state">Không có lịch bận trong ngày.</p>';
  return rows.map((e) => '<div class="event-row"><span class="event-time">' + hhmm(e.start) + '</span><div class="event-copy"><strong>' + safe(e.title) + "</strong><span>" + hhmm(e.start) + " – " + hhmm(e.end) + " · " + safe(e.detail) + "</span></div>" + icon("arrow") + "</div>").join("");
}
function timeline() {
  return '<div class="timeline">' + [["07:30", "Buổi sáng", "sun", "Xem tóm tắt và chuẩn bị ngày mới", "health"], ["09:00", "Công việc", "work", "Lịch hôm nay và thời gian tập trung", "work"], ["18:00", "Về nhà", "home", "Thiết bị và không gian của bạn", "house"]].map(([time, title, i, desc, target]) => '<button class="card" data-nav="' + target + '"><span class="tile-icon">' + icon(i) + '</span><span class="event-copy"><strong>' + time + " · " + title + "</strong><span>" + desc + "</span></span>" + icon("arrow") + "</button>").join("") + "</div>";
}
function statWidgets() {
  const widgets = settings().widgets;
  const tiles = [];
  if (widgets.includes("sleep")) tiles.push(sleepTile());
  if (widgets.includes("steps")) tiles.push(stepsTile());
  return (tiles.length ? '<div class="stats-grid">' + tiles.join("") + "</div>" : "") + (widgets.includes("schedule") ? '<div class="section-heading"><h2>Lịch hôm nay</h2><button class="text-button" data-nav="work">Xem tất cả →</button></div><div class="card">' + scheduleRows() + "</div>" : "");
}
function home() {
  const { name, theme } = settings();
  const work = context === "work";
  let html = '<div class="heading-row"><div><span class="eyebrow">' + dateLine() + "</span><h1>Chào " + safe(name) + '.</h1><p class="subtitle">Một ngày của bạn, theo nhịp của bạn.</p></div></div>';
  if (theme === "flow") {
    html += '<section class="hero flow-hero"><div class="hero-copy"><span class="eyebrow" style="color:#c9f0ff">DÒNG THỜI GIAN</span><h2>Ngày của bạn,<br>gọn gàng hơn.</h2><p>Cá nhân, công việc và ngôi nhà trong cùng một hành trình.</p></div>' + orb() + "</section>" + timeline();
  } else if (theme === "titanium") {
    html += '<div class="space-tiles">' + [["person", "Cá nhân", "Tóm tắt sức khỏe và nhịp sống", "health"], ["work", "Công việc", "Lịch hôm nay, việc tiếp theo", "work"], ["home", "Ngôi nhà", "Thiết bị và không gian của bạn", "house"]].map(([i, t, d, target]) => '<button class="card space-tile" data-nav="' + target + '"><span class="tile-icon">' + icon(i) + '</span><span class="event-copy"><strong>' + t + "</strong><span>" + d + "</span></span>" + icon("arrow") + "</button>").join("") + "</div>";
  } else {
    const title = work ? "Dành chỗ cho điều quan trọng." : theme === "calm" ? "Một ngày<br>nhẹ nhàng." : theme === "night" ? "Không gian<br>đúng nhịp." : "Nhịp sống<br>hôm nay.";
    html += '<section class="hero ' + theme + '-hero"><div class="hero-copy"><span class="tiny-pill">' + (work ? "Không gian công việc" : mark("amber", "inline") + " đồng hành cùng bạn") + "</span><h2>" + title + "</h2><p>" + (work ? "Chủ động sắp xếp lịch, có thời gian cho chính mình." : "Bắt đầu với những điều nhỏ, tận hưởng một ngày trọn vẹn.") + '</p><button class="button primary" data-nav="' + (work ? "work" : "health") + '">' + (work ? "Xem lịch hôm nay" : "Xem tóm tắt") + icon("arrow") + "</button></div>" + orb() + "</section>";
    html += statWidgets();
  }
  if ((theme === "flow" || theme === "titanium") && settings().widgets.length) html += '<details class="today-details"><summary>Thông tin hôm nay</summary>' + statWidgets() + "</details>";
  const live = actions.filter((a) => !["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"].includes(a.status));
  if (live.length) html += '<div class="section-heading"><h2>Đang theo dõi</h2></div>' + live.map((a) => actionCard(a)).join("");
  return html + askLele();
}
function health_() {
  let html = '<span class="eyebrow">CHỈ TRONG KHÔNG GIAN CÁ NHÂN · TÍNH TRÊN THIẾT BỊ</span><h1>Nhịp sống của bạn.</h1><p class="subtitle">Từng thay đổi nhỏ, được nhìn rõ hơn.</p>';
  if (!health) {
    return html + '<section class="card health-card"><div class="stat-label">' + icon("shield") + 'Sức khỏe đang tắt</div><p>LeNhip chỉ đọc bước chân và giấc ngủ sau khi bạn đồng ý, tính trên thiết bị và không gửi số liệu sức khỏe về máy chủ. Bạn vẫn dùng được lịch và ngôi nhà khi không bật.</p><button class="button primary" data-action="onboarding">Xem thông báo và lựa chọn</button></section>' + askLele();
  }
  const s = health.summary;
  const completed = health.days.slice(0, 7);
  const today = health.days[7];
  const label = (d) => SHORT[new Date(d.local_date + "T00:00:00Z").getUTCDay()];
  const avg = s.sleep_average_seconds;
  html += '<section class="card health-card"><div class="stat-label">' + icon("moon") + "Giấc ngủ · 7 ngày đã kết thúc</div>" +
    '<div class="stat-value">' + (avg === null ? "—" : safe(formatDuration(avg))) + '</div><p class="subtitle">' + safe(sleepSentence(s)) + "</p>" +
    '<div class="bar-chart" role="img" aria-label="' + safe(`${s.sleep_observed_days} ngày có quan sát giấc ngủ, ${7 - s.sleep_observed_days} ngày thiếu dữ liệu`) + '">' +
    completed.map((d) => '<div><i class="' + (d.sleep_seconds === null ? "missing" : "") + '" style="--h:' + (d.sleep_seconds === null ? 3 : Math.min(100, Math.round((d.sleep_seconds / 36000) * 100))) + '%"></i><span>' + label(d) + "</span></div>").join("") +
    '</div><p class="fine-print">Hôm nay (' + label(today) + ") tách riêng vì chưa đủ ngày: " + (today.sleep_seconds === null ? "chưa có dữ liệu ngủ." : "giấc chính " + safe(formatDuration(today.sleep_seconds)) + ".") + " Ngày thiếu hiển thị vạch mờ, không tính là 0.</p></section>";
  const stepsDays = completed.filter((d) => d.steps !== null);
  html += '<div class="stats-grid" style="margin-top:15px"><div class="card"><div class="stat-label">' + icon("steps") + 'Vận động</div><div class="stat-value">' + (s.steps_average === null ? "—" : s.steps_average.toLocaleString("vi-VN") + " <small>bước/ngày</small>") + '</div><div class="stat-meta">Trung bình ' + stepsDays.length + "/7 ngày có dữ liệu</div></div>" +
    '<div class="card"><div class="stat-label">' + icon("shield") + 'Nguồn dữ liệu</div><h3 style="margin-top:16px">Dữ liệu tổng hợp</h3><div class="stat-meta">Nguồn ' + safe(health.source.id ?? "—") + (health.source.selection === "MOST_RECENT_NEEDS_CONFIRMATION" ? " · cần bạn xác nhận" : "") + " · " + health.algorithm_version + " · múi " + safe(health.analysis_zone) + "</div></div></div>";
  html += '<div class="privacy-note">' + icon("lock") + "<span>Bản web dùng dữ liệu tổng hợp vì trình duyệt không đọc được HealthKit hay Health Connect. App iOS và Android đọc qua HealthSource, tính bằng cùng thuật toán và không gửi số liệu sức khỏe về máy chủ.</span></div>";
  html += '<div class="button-row"><button class="button secondary" data-action="health-source">Quyền và nguồn dữ liệu ' + icon("arrow") + '</button><button class="button secondary" data-action="health-export">Xuất dữ liệu trên thiết bị</button><button class="button secondary" data-action="health-erase">Xóa bộ nhớ đệm</button></div>';
  return html + askLele();
}
function work() {
  const live = actions.filter((a) => a.kind === "calendar.block").slice(0, 3);
  return '<div class="heading-row"><div><span class="eyebrow">KHÔNG GIAN CÔNG VIỆC</span><h1>Lịch theo nhịp bạn.</h1></div><span class="tiny-pill">Microsoft 365 · giả lập</span></div><p class="subtitle">Dành thời gian cho cả công việc và chính mình.</p>' +
    '<section class="card" style="margin-top:25px"><div class="section-heading" style="margin-top:0"><h2>Hôm nay · ' + localParts(api.serverNow(), zone()).day + "/" + localParts(api.serverNow(), zone()).month + "</h2>" + icon("today") + "</div>" + scheduleRows() + "</section>" +
    '<button class="button primary full" style="margin-top:18px" data-action="new-block" ' + (online && me?.calendar.linked && serverConsent("calendar_link") ? "" : "disabled") + ">" + icon("plus") + "Thêm thời gian cá nhân</button>" +
    '<div class="privacy-note">' + icon("lock") + "<span>Tiêu đề cố định “Thời gian cá nhân”, chỉ mình bạn, hiển thị bận. LeNhip không gửi lý do hay dữ liệu sức khỏe, và không đọc tiêu đề cuộc hẹn của bạn.</span></div>" +
    (live.length ? '<div class="section-heading"><h2>Khung giờ gần đây</h2></div>' + live.map((a) => actionCard(a)).join("") : "") + askLele();
}
function roomVisual() {
  const lamp = devices.find((d) => d.device_ref === "dev_lamp_01") ?? devices[0];
  const on = lamp?.state?.power === "ON";
  return '<div class="room-visual"><svg viewBox="0 0 520 225" role="img" aria-label="Minh họa bàn làm việc và đèn ' + (on ? "đang bật" : "đang tắt") + '"><defs><linearGradient id="desk" x2="1" y2="1"><stop stop-color="#e4caa8"/><stop offset="1" stop-color="#b69779"/></linearGradient><radialGradient id="light"><stop stop-color="#fff3a8" stop-opacity=".7"/><stop offset="1" stop-color="#ffe997" stop-opacity="0"/></radialGradient><linearGradient id="screen" x2="1" y2="1"><stop stop-color="#6ac4dc"/><stop offset="1" stop-color="#284c73"/></linearGradient></defs><path d="M80 120 350 75 450 140 175 190Z" fill="url(#desk)"/><path d="M80 120v12l95 68 275-48v-12l-275 50Z" fill="#a88c70"/><path d="m100 140 6 63h12l-2-54m307 14-5 51h12l9-64m-250 40 3 29h13l1-34" fill="#8b7c6c"/><path d="m170 57 116-17v74l-116 19Z" fill="#244150"/><path d="m176 62 104-15v62l-104 17Z" fill="url(#screen)"/><path d="m220 122 3 22 27-5-4-21" fill="#5b6b75"/><ellipse cx="346" cy="133" rx="26" ry="8" fill="#827759"/><path d="m345 130 6-58-27-25" stroke="#b39d67" stroke-width="6" fill="none"/><path d="m304 39 29-4 16 29-54 7Z" fill="' + (on ? "#c9af70" : "#71818e") + '"/>' + (on ? '<ellipse cx="320" cy="103" rx="66" ry="40" fill="url(#light)"/>' : "") + '<path d="m386 99 20-4v22l-20 4Z" fill="#f7f3e8"/><path d="M406 100q17-1 0 14" fill="none" stroke="#e7ded0" stroke-width="5"/></svg></div>';
}
function deviceRow(d) {
  const st = d.state;
  const on = st?.power === "ON";
  // Thẻ trạng thái hiện tại: báo "đã cũ" sau 60 giây. Bằng chứng của tác vụ dùng max-age 2 giây ở gateway (SRS mục 23).
  const status = !st ? "Chưa có trạng thái mới" : (on ? "Đang bật" : "Đang tắt") + " · báo lúc " + hhmmss(st.observed_at) + (st.age_ms > 60_000 ? " (đã cũ)" : "");
  const disabled = !online || d.locked || d.status !== "ACTIVE" || !me?.dispatch_open;
  return '<div class="device-control">' + icon("lamp") + '<div class="device-copy"><h3>' + safe(d.name) + "</h3><p>" + safe(status) + (d.locked ? " · đang chờ xác minh thao tác trước" : "") + (d.status !== "ACTIVE" ? " · " + (d.status === "QUARANTINED" ? "đang cách ly sau reset" : d.status) : "") + '</p></div><button class="switch" data-device="' + safe(d.device_ref) + '" role="switch" aria-label="' + safe(d.name) + '" aria-checked="' + on + '" ' + (disabled ? "disabled" : "") + "></button></div>";
}
function house() {
  const live = actions.filter((a) => a.kind !== "calendar.block").slice(0, 3);
  let body;
  if (!online) body = '<p class="empty-state">Chưa kết nối máy chủ.</p>';
  else if (!site) body = '<p class="empty-state">Bạn chưa thuộc nhóm Home ở site nào. Nhóm Home của bản thử nghiệm có 10–20 người tại 1–3 site có người quản lý.</p>';
  else if (!serverConsent("home_control")) body = '<p class="empty-state">Bạn chưa đồng ý điều khiển đèn tại site. Mở Cá nhân hóa → Quyền riêng tư để bật.</p>';
  else body = devices.length ? devices.map(deviceRow).join('<hr class="soft">') : '<p class="empty-state">Site chưa có đèn được đăng ký.</p>';
  return '<span class="eyebrow">NGÔI NHÀ · ' + safe((site?.name ?? "PHÒNG LÀM VIỆC").toUpperCase()) + '</span><h1>Mọi thứ sẵn sàng.</h1><p class="subtitle">Một không gian thoải mái, theo cách của bạn.</p><section class="card" style="margin-top:25px">' + roomVisual() + body + "</section>" +
    (live.length ? '<div class="section-heading"><h2>Thao tác gần đây</h2></div>' + live.map((a) => actionCard(a)).join("") : "") +
    '<div class="section-heading"><h2>Le-ORION</h2><span class="tiny-pill">Mô phỏng</span></div><button class="card device-control full" data-action="robot" ' + (online && me?.grants.some((g) => g.scope === "robot.simulate" && g.status === "ACTIVE") ? "" : "disabled") + ">" + icon("robot") + '<span class="event-copy"><strong>Đồng hành trong không gian</strong><span>Chạy kịch bản đưa tài liệu, bằng chứng mô phỏng</span></span>' + icon("arrow") + "</button>" +
    '<div class="privacy-note">' + icon("shield") + "<span>Lệnh đi qua gateway của site sau khi bạn xác nhận; kết quả chỉ hiện theo bằng chứng thiết bị báo. Robot là mô phỏng, chưa điều khiển robot thật.</span></div>" + askLele();
}
function render() {
  applyTheme();
  nav();
  banner();
  $("privacy-chip").innerHTML = icon("shield") + "Sức khỏe tính trên thiết bị";
  $("settings-button").innerHTML = icon("settings");
  $("note-icon").innerHTML = icon("lock");
  $("theme-options").innerHTML = THEMES.map((t) => themeButton(t)).join("");
  $("main").innerHTML = contextControl() + ({ home, health: health_, work, house })[screen]();
}
function navigate(next, focus = true) {
  if (!tabs.some((t) => t[0] === next)) return;
  screen = next;
  if (next === "work") context = "work";
  if (next === "health" || next === "house") context = "personal";
  history.replaceState(null, "", "#" + next);
  render();
  if (focus) $("main").focus();
}
function showAction(title, html) {
  $("action-title").innerHTML = title;
  $("action-body").innerHTML = html;
  if (!$("action-dialog").open) $("action-dialog").showModal();
  $("action-title").focus();
}

// ---------------------------------------------------------------- plan → xem lại → xác nhận
function errorText(e) {
  const map = {
    CONSENT_REQUIRED: "Bạn chưa đồng ý cho mục đích này. Mở Cá nhân hóa → Quyền riêng tư.",
    FORBIDDEN: "Tài khoản của bạn chưa có quyền với thao tác này.",
    RESOURCE_LOCKED: "Đang chờ xác minh một thao tác trước trên cùng tài nguyên. Xem mục Đang theo dõi.",
    MODULE_DISABLED: "Mô-đun đang tạm tắt.",
    DISPATCH_CLOSED: "Hệ thống đang tạm đóng phát tác vụ. Thử lại sau.",
    CALENDAR_NOT_LINKED: "Chưa liên kết tài khoản Microsoft 365.",
    PLAN_STALE: "Quyền, chính sách hoặc thiết bị đã thay đổi. Cần xem lại và xác nhận mới.",
    DIGEST_MISMATCH: "Nội dung xác nhận khác nội dung đã chuẩn hóa.",
    OFFLINE: "Không kết nối được máy chủ LeNhip.",
    RATE_LIMITED: "Bạn thao tác quá nhanh. Thử lại sau ít giây.",
  };
  return map[e.code] ?? e.body?.message ?? e.message;
}
function planSummary(p) {
  if (p.kind === "calendar.block") {
    const date = localDate(Date.parse(p.start), zone());
    return '<div class="card preview-card"><h3>Thời gian cá nhân</h3><div class="event-row">' + icon("clock") + safe(hhmm(p.start)) + " – " + safe(hhmm(p.end)) + " · " + safe(date.split("-").reverse().join("/")) + '</div><div class="event-row">' + icon("lock") + 'Chỉ mình tôi · hiển thị bận</div><div class="event-row">' + icon("work") + "Lịch primary của tài khoản đã liên kết</div></div>";
  }
  if (p.kind === "device.set_power") {
    const d = devices.find((x) => x.device_ref === p.target.device_ref);
    return '<div class="card preview-card"><h3>' + (p.command === "SET_ON" ? "Bật" : "Tắt") + " " + safe(d?.name ?? p.target.device_ref) + '</h3><div class="event-row">' + icon("home") + safe(site?.name ?? p.target.site) + '</div><div class="event-row">' + icon("shield") + "Qua gateway của site · cấu hình bản " + p.target_binding_version + "</div></div>";
  }
  return '<div class="card preview-card"><h3>Le-ORION · đưa tài liệu</h3><div class="event-row">' + icon("robot") + "Kịch bản mô phỏng, không có robot thật</div></div>";
}
async function propose(input, label) {
  try {
    const plan = await api.post("/v1/plans", input);
    const digestOk = (await digestJcs(plan.preview)) === plan.payload_digest;
    pendingPlan = { plan, input, label, digestOk };
    showPreview();
  } catch (e) {
    showAction("Chưa tạo được thao tác", "<p>" + safe(errorText(e)) + '</p><button class="button primary" data-action="close-action">Đã hiểu</button>');
  }
}
function showPreview() {
  const { plan, label, digestOk } = pendingPlan;
  showAction("Xem lại và xác nhận", '<span class="tiny-pill">' + safe(label) + "</span>" + planSummary(plan.preview) +
    '<p class="fine-print">' + (digestOk ? icon("check") + " Nội dung trên đúng với nội dung máy chủ đã khóa (mã " + safe(plan.payload_digest.slice(0, 10)) + "…)." : icon("alert") + " Nội dung không khớp mã đã khóa; không nên xác nhận.") + "</p>" +
    '<p class="countdown" id="countdown" aria-live="polite"></p>' +
    '<button class="button primary full" data-action="approve-plan" ' + (digestOk ? "" : "disabled") + '>Xác nhận</button><button class="text-button full" data-action="cancel-plan">Không làm</button>');
  clearInterval(countdownTimer);
  const tickDown = () => {
    const left = Math.max(0, Math.ceil((Date.parse(plan.approval_deadline) - api.serverNow()) / 1000));
    const el = $("countdown");
    if (!el) return clearInterval(countdownTimer);
    el.textContent = left > 0 ? `Còn ${left} giây để xác nhận.` : "Bản xem lại đã hết hạn.";
    if (left <= 0) {
      clearInterval(countdownTimer);
      expired();
    }
  };
  tickDown();
  countdownTimer = setInterval(tickDown, 1000);
}
function expired() {
  // Hết 120 giây: giữ bản nháp, giải thích, cho xem lại để xác nhận mới; không tự gia hạn (SRS mục 13).
  showAction("Bản xem lại đã hết hạn", "<p>Quá 120 giây chưa xác nhận nên thao tác chưa được gửi. Nội dung vẫn giữ để bạn xem lại.</p>" + planSummary(pendingPlan.plan.preview) + '<button class="button primary full" data-action="repropose">Xem lại để xác nhận mới</button><button class="text-button full" data-action="close-action">Bỏ qua</button>');
}
async function approve() {
  const { plan } = pendingPlan;
  clearInterval(countdownTimer);
  try {
    const r = await api.post(`/v1/plans/${plan.plan_id}/approve`, { plan_version: plan.plan_version, approved_digest: plan.payload_digest });
    track(r.action_id);
  } catch (e) {
    if (e.code === "APPROVAL_EXPIRED") return expired();
    showAction("Chưa gửi được", "<p>" + safe(errorText(e)) + "</p>" + (e.code === "PLAN_STALE" ? '<button class="button primary full" data-action="repropose">Xem lại để xác nhận mới</button>' : "") + '<button class="text-button full" data-action="close-action">Đóng</button>');
  }
}
async function track(actionId) {
  tracked.add(actionId);
  const draw = (a) => showAction("Theo dõi thao tác", actionCard(a) + '<button class="button secondary full" data-action="close-action">Đóng</button>');
  let a = await api.get(`/v1/actions/${actionId}`);
  draw(a);
  const started = Date.now();
  while (!["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED", "UNKNOWN"].includes(a.status) && Date.now() - started < 60_000) {
    await new Promise((r) => setTimeout(r, 800));
    a = await api.get(`/v1/actions/${actionId}`);
    if ($("action-dialog").open && $("action-body").querySelector(`[data-action-id="${actionId}"]`)) draw(a);
  }
  await Promise.all([loadWork(), loadHouse(), loadActions()]);
  render();
}

// ---------------------------------------------------------------- thông báo đầu tiên và đồng ý
const PURPOSES = [
  { id: "health_local", title: "Sức khỏe trên điện thoại", text: "Đọc bước chân và giấc ngủ từ HealthKit/Health Connect, tính tóm tắt trên điện thoại. Không gửi số liệu hay nhãn sức khỏe về máy chủ. Bộ nhớ đệm tối đa 30 ngày trên máy." },
  { id: "calendar_link", title: "Liên kết lịch công việc", text: "Đọc khoảng bận/trống của lịch primary và tạo khung giờ “Thời gian cá nhân” riêng tư khi bạn xác nhận. Không đọc tiêu đề hay khách mời. Máy chủ LeNhip đặt tại Việt Nam; Microsoft 365 là bên xử lý của doanh nghiệp." },
  { id: "home_control", title: "Điều khiển đèn tại site", text: "Gửi lệnh bật/tắt tới đèn đã đăng ký tại site có người quản lý, sau khi bạn xác nhận từng lần. Lưu kết quả và bằng chứng tối thiểu 90 ngày." },
  { id: "beta_telemetry", title: "Số liệu thử nghiệm", text: "Gửi sự kiện tối thiểu về hành trình (không giá trị sức khỏe, không nội dung) để đo chất lượng bản thử nghiệm. Rút lại bất cứ lúc nào, vẫn dùng app bình thường." },
];
const NOTICE_HEAD = "LeNhip là ứng dụng của LeDB. Mỗi mục đích dưới đây là một lựa chọn riêng, mặc định để trống. Bạn có quyền xem, sửa, rút lại, hạn chế, xóa và nhận bản sao dữ liệu; đầu mối là người phụ trách bảo vệ dữ liệu của LeDB (CHƯA CHỐT tên). Tham gia thử nghiệm là tự nguyện, từ 18 tuổi; dữ liệu sức khỏe không dùng để đánh giá nhân sự.";
async function onboarding() {
  const hs = healthState();
  const checked = (p) => (p === "health_local" ? healthConsent() : serverConsent(p));
  showAction("Thông báo đầu tiên", '<p class="fine-print">' + safe(NOTICE_HEAD) + '</p><form id="consent-form">' + PURPOSES.map((p) =>
    '<label class="consent-row"><input type="checkbox" name="' + p.id + '" ' + (checked(p.id) ? "checked" : "") + " " + ((p.id !== "health_local" && !online) ? "disabled" : "") + "><span><strong>" + safe(p.title) + "</strong><small>" + safe(p.text) + "</small></span></label>").join("") +
    '<p class="fine-print">Phiên bản thông báo ' + NOTICE_VERSION + (hs ? " · lựa chọn sức khỏe lưu trên thiết bị này" : "") + '.</p><button class="button primary full">Lưu lựa chọn</button></form>');
}
async function saveConsents(form) {
  const now = new Date(api.serverNow()).toISOString();
  for (const p of PURPOSES) {
    const want = form.elements[p.id].checked;
    const hash = await digestJcs(NOTICE_HEAD + "\n" + p.text);
    if (p.id === "health_local") {
      // Biên nhận sức khỏe chỉ lưu trên thiết bị (SRS mục 08).
      const prev = healthState();
      const receipt = { purpose_id: "health_local", text_version: NOTICE_VERSION, text_hash: hash, choice: want ? "GRANTED" : "DECLINED", at: now, withdrawn_at: null };
      if (prev?.receipt?.choice === "GRANTED" && !want) receipt.withdrawn_at = now;
      writeStore(healthKey(), JSON.stringify({ receipt, revision: (prev?.revision ?? 0) + 1 }));
      continue;
    }
    if (!online) continue;
    const has = serverConsent(p.id);
    if (want && !has) await api.post("/v1/consents", { purpose_id: p.id, text_version: NOTICE_VERSION, text_hash: hash, choice: "GRANTED" });
    if (!want && has) await api.post(`/v1/consents/${p.id}/withdraw`);
    if (!want && !has && !me.consents.some((c) => c.purpose_id === p.id)) await api.post("/v1/consents", { purpose_id: p.id, text_version: NOTICE_VERSION, text_hash: hash, choice: "DECLINED" });
  }
  $("action-dialog").close();
  toast("Đã lưu lựa chọn của bạn.");
  await refresh();
}

// ---------------------------------------------------------------- LeLe
function chat() {
  showAction("Trò chuyện cùng " + mark("amber", "inline title"), '<p class="fine-print">LeLe chỉ soạn đề xuất; bạn xem lại và xác nhận trước khi LeNhip làm. Bản này dùng quy tắc cục bộ, không gửi nội dung tới mô hình AI. Câu hỏi về sức khỏe không rời thiết bị.</p><div id="chat-list" class="chat-list" role="log" aria-live="polite"><div class="chat-message">Chào bạn! Tôi có thể soạn khung giờ riêng trong lịch công việc (“dành 30 phút lúc 15:00”) hoặc bật/tắt đèn đã đăng ký (“tắt đèn bàn”).</div></div><form id="chat-form" class="chat-form"><input name="message" maxlength="400" required aria-label="Nội dung gửi LeLe" placeholder="Bạn muốn làm gì?"><button class="button primary" aria-label="Gửi tin nhắn">' + icon("arrow") + "</button></form>");
}
function chatLine(text, kind, extra = "") {
  const node = document.createElement("div");
  node.className = "chat-message " + kind;
  node.textContent = text;
  if (extra) node.insertAdjacentHTML("beforeend", extra);
  $("chat-list").append(node);
  $("chat-list").scrollTop = $("chat-list").scrollHeight;
}
let lastProposal = null;
async function chatSend(value) {
  chatLine(value, "user");
  const lower = value.toLocaleLowerCase("vi");
  if (/(ngủ|giấc|bước|nhịp tim|sức khỏe|sức khoẻ|bệnh|thuốc)/.test(lower)) {
    return chatLine("Câu hỏi sức khỏe được xử lý trên điện thoại và không gửi tới LeLe trong miền công việc. Màn hình Sức khỏe cho thấy số ngày có dữ liệu và trung bình; LeNhip không chẩn đoán hay khuyến nghị điều trị.", "assistant");
  }
  if (/giao diện|phong cách|màu|cá nhân hóa/.test(lower)) return chatLine("Mở nút Cá nhân hóa ở góc trên: 5 phong cách, màu nhấn, cỡ chữ tới 200 %, giảm chuyển động.", "assistant");
  if (!online) return chatLine("Chưa kết nối máy chủ nên chưa soạn được đề xuất.", "assistant");
  try {
    const r = await api.post("/v1/lele/proposals", { text: value, context: /đèn|nhà|robot/.test(lower) ? "home" : "work", zone: zone() });
    if (r.type === "PROPOSAL") {
      lastProposal = r.proposal;
      chatLine((r.ai_generated ? "Đề xuất từ mô hình AI: " : "Đề xuất: ") + r.proposal.summary, "assistant proposal", '<button class="button primary small" data-action="use-proposal">Xem và xác nhận</button>');
    } else chatLine(r.answer ?? "Dùng form trong Công việc hoặc Ngôi nhà để tạo thao tác.", "assistant");
  } catch (e) {
    chatLine(errorText(e), "assistant");
  }
}

// ---------------------------------------------------------------- cài đặt
function settingFields() {
  const s = draftSettings;
  $("settings-fields").innerHTML = '<div class="field"><label for="display-name">Tên hiển thị</label><input id="display-name" name="name" value="' + safe(s.name) + '" maxlength="48" autocomplete="off"></div><div class="field"><span>Phong cách giao diện</span><div class="settings-themes">' + THEMES.map((t) => themeButton(t, true)).join("") + '</div><span class="fine-print">' + THEMES.find((t) => t.id === s.theme).name + '</span></div><div class="field"><label for="font-size">Cỡ chữ</label><select id="font-size" name="fontSize">' + FONT_SIZES.map((n) => '<option value="' + n + '" ' + (n === s.fontSize ? "selected" : "") + ">" + n + "%</option>").join("") + '</select></div><div class="field"><label for="zone">Múi giờ phân tích</label><select id="zone" name="zone">' + [...new Set([s.zone, ...ZONES])].map((z) => '<option value="' + safe(z) + '" ' + (z === s.zone ? "selected" : "") + ">" + safe(z) + "</option>").join("") + '</select><span class="fine-print">Đổi múi thì tính lại cả chuỗi 7 ngày và ghi nhãn; không sửa lịch sử ngầm.</span></div><div class="field"><label for="accent-color">Màu nhấn riêng</label><div style="display:flex;align-items:center;gap:12px"><input type="color" id="accent-color" name="accent" value="' + (s.accent || THEMES.find((t) => t.id === s.theme).accent) + '"><button type="button" class="text-button" data-action="theme-accent">Dùng màu của phong cách</button></div></div><label class="checkbox-row">Giảm chuyển động<input type="checkbox" name="reducedMotion" ' + (s.reducedMotion ? "checked" : "") + '></label><label class="checkbox-row">Bố cục gọn<input type="checkbox" name="compact" ' + (s.compact ? "checked" : "") + '></label><div class="field"><span>Nội dung trên Hôm nay</span><span class="fine-print">Với Dòng thời gian và Titanium, mở Thông tin hôm nay để xem.</span></div>' + ["sleep", "steps", "schedule"].map((k) => '<label class="checkbox-row">' + { sleep: "Giấc ngủ", steps: "Vận động", schedule: "Lịch hôm nay" }[k] + '<input type="checkbox" data-widget="' + k + '" ' + (s.widgets.includes(k) ? "checked" : "") + "></label>").join("");
  $("privacy-settings").innerHTML = '<div class="privacy-box"><h3>Quyền riêng tư</h3><p class="fine-print">Sức khỏe: ' + (healthConsent() ? "đang bật trên thiết bị này" : "đang tắt") + " · Lịch: " + (serverConsent("calendar_link") ? "đã đồng ý" : "chưa đồng ý") + " · Đèn: " + (serverConsent("home_control") ? "đã đồng ý" : "chưa đồng ý") + " · Số liệu thử nghiệm: " + (serverConsent("beta_telemetry") ? "đã đồng ý" : "chưa đồng ý") + '</p><div class="button-row"><button type="button" class="button secondary" data-action="onboarding">Đổi lựa chọn</button><button type="button" class="button secondary" data-action="privacy-export" ' + (online ? "" : "disabled") + ">Nhận bản sao dữ liệu máy chủ</button></div></div>";
}
function captureDraft() {
  const form = $("settings-form");
  draftSettings = { ...draftSettings, name: form.elements.name.value, fontSize: Number(form.elements.fontSize.value), zone: form.elements.zone.value, reducedMotion: form.elements.reducedMotion.checked, compact: form.elements.compact.checked, widgets: [...form.querySelectorAll("[data-widget]:checked")].map((el) => el.dataset.widget) };
}
function openSettings() {
  if ($("action-dialog").open) $("action-dialog").close();
  draftSettings = structuredClone(settings());
  settingFields();
  $("settings-dialog").showModal();
}
async function profiles() {
  if ($("settings-dialog").open) $("settings-dialog").close();
  const users = api.devUsers;
  showAction("Tài khoản", api.dev
    ? '<p class="fine-print">Bản chạy thử: chọn một tài khoản thử của dữ liệu tổng hợp. App thật đăng nhập bằng tài khoản LeASO (OIDC).</p>' + users.map((u) => '<div class="profile-row"><button class="button secondary" data-login="' + safe(u.sub) + '">' + safe(u.name) + (u.sub === me?.user.id ? icon("check") : "") + "</button></div>").join("")
    : '<p class="fine-print">Đăng nhập bằng tài khoản LeASO (OIDC). Bản web tham chiếu chưa có trang đăng nhập riêng.</p>');
}

const actionsMap = {
  settings: openSettings,
  profiles,
  onboarding,
  chat,
  "close-settings": () => $("settings-dialog").close(),
  "close-action": () => {
    clearInterval(countdownTimer);
    $("action-dialog").close();
  },
  "theme-accent": () => {
    captureDraft();
    draftSettings.accent = "";
    settingFields();
  },
  "reset-settings": () => {
    draftSettings = defaults(settings().name);
    settingFields();
  },
  export: () => {
    const blob = new Blob([JSON.stringify({ version: 2, settings: settings() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "LeNhip-tuy-chon.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  "new-block": () => {
    const today = localDate(api.serverNow(), zone());
    showAction("Dành thời gian cá nhân", '<p class="fine-print">Lịch công việc Microsoft 365 · múi ' + safe(zone()) + '</p><form id="block-form"><div class="field"><label for="block-day">Ngày</label><select id="block-day" name="day"><option value="' + today + '">Hôm nay</option><option value="' + addDays(today, 1) + '">Ngày mai</option></select></div><div class="field"><label for="block-start">Bắt đầu</label><input id="block-start" name="start" type="time" value="10:00" required></div><div class="field"><label for="block-end">Kết thúc</label><input id="block-end" name="end" type="time" value="10:30" required></div><p id="block-error" class="form-error" role="alert" hidden></p><button class="button primary full">Xem lại</button></form>');
  },
  "approve-plan": approve,
  "cancel-plan": async () => {
    clearInterval(countdownTimer);
    try {
      await api.post(`/v1/plans/${pendingPlan.plan.plan_id}/cancel`);
    } catch {
      /* đã hết hạn hoặc đã đóng */
    }
    $("action-dialog").close();
    toast("Đã bỏ thao tác. Chưa có gì được gửi.");
  },
  repropose: () => propose(pendingPlan.input, pendingPlan.label),
  robot: () => propose({ kind: "robot.simulate", schema_version: 1, workspace_ref: api.ws, args: { scenario: "DELIVER_DOCUMENT" } }, "Le-ORION · mô phỏng"),
  "use-proposal": () => {
    if (!lastProposal) return;
    const label = lastProposal.kind === "calendar.block" ? "Đề xuất của LeLe · lịch công việc" : "Đề xuất của LeLe · ngôi nhà";
    propose({ kind: lastProposal.kind, schema_version: 1, workspace_ref: api.ws, args: lastProposal.args }, label);
  },
  "health-source": () => showAction("Nguồn và quyền dữ liệu", '<div class="privacy-note">' + icon("shield") + "<span>Bản web dùng dữ liệu tổng hợp cố định theo ngày.</span></div><p>App iOS dùng HealthKit, app Android dùng Health Connect qua cùng hợp đồng HealthSource v1: xin quyền bước chân và giấc ngủ riêng, đọc trong cửa sổ 7 ngày, không đọc nền.</p><p class=\"fine-print\">Thuật toán " + safe(health?.algorithm_version ?? "LNH-SLEEP-1") + " · revision " + safe(health?.source_revision ?? "-") + " · múi " + safe(zone()) + '</p><button class="button primary full" data-action="close-action">Đã hiểu</button>'),
  "health-export": () => {
    if (!health) return;
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), note: "Dữ liệu tổng hợp tính trên thiết bị", days: health.days, summary: health.summary }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "LeNhip-suc-khoe-tren-thiet-bi.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  "health-erase": () => {
    const s = healthState();
    if (s) writeStore(healthKey(), JSON.stringify({ ...s, revision: (s.revision ?? 0) + 1 }));
    computeHealth();
    render();
    toast("Đã xóa bộ nhớ đệm và tính lại từ nguồn.");
  },
  "privacy-export": async () => {
    try {
      if (api.dev) await api.login(me.user.id); // xác thực lại (auth_time mới) trước khi xuất
      const r = await api.post("/v1/privacy/requests", { type: "EXPORT" });
      const data = await api.get(r.export.path);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "LeNhip-du-lieu-may-chu.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Đã tải bản sao. Liên kết chỉ dùng một lần.");
    } catch (e) {
      toast(errorText(e));
    }
  },
};

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.nav) return navigate(target.dataset.nav);
  if (target.dataset.themeChoice) {
    settings().theme = target.dataset.themeChoice;
    settings().accent = "";
    savePrefs();
    return render();
  }
  if (target.dataset.draftTheme) {
    captureDraft();
    draftSettings.theme = target.dataset.draftTheme;
    draftSettings.accent = "";
    return settingFields();
  }
  if (target.dataset.context) {
    context = target.dataset.context;
    if (context === "work" && (screen === "health" || screen === "house")) return navigate("work");
    if (context === "personal" && screen === "work") return navigate("home");
    return render();
  }
  if (target.dataset.login) {
    await api.login(target.dataset.login);
    prefs.activeSub = target.dataset.login;
    $("action-dialog").close();
    await refresh();
    savePrefs();
    if (!healthState() && !me?.consents?.length) onboarding();
    return;
  }
  if (target.dataset.device) {
    const d = devices.find((x) => x.device_ref === target.dataset.device);
    if (!d) return;
    const on = d.state?.power === "ON";
    return propose({ kind: "device.set_power", schema_version: 1, workspace_ref: api.ws, args: { site: d.site, device_ref: d.device_ref, command: on ? "SET_OFF" : "SET_ON" } }, "Ngôi nhà · " + (site?.name ?? d.site));
  }
  if (target.dataset.checkAction) {
    const a = await api.get(`/v1/actions/${target.dataset.checkAction}`);
    actions = actions.map((x) => (x.action_id === a.action_id ? a : x));
    if ($("action-dialog").open) showAction("Theo dõi thao tác", actionCard(a) + '<button class="button secondary full" data-action="close-action">Đóng</button>');
    else render();
    return;
  }
  if (target.dataset.cancelAction) {
    try {
      await api.post(`/v1/actions/${target.dataset.cancelAction}/cancel`);
    } catch (e) {
      toast(errorText(e));
    }
    await loadActions();
    return render();
  }
  const handler = actionsMap[target.dataset.action];
  if (handler) handler();
});
$("settings-form").addEventListener("input", (event) => {
  if (event.target.name === "accent") draftSettings.accent = event.target.value;
});
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  captureDraft();
  const before = settings().zone;
  prefs.users[sub()] = sanitizeSettings(draftSettings);
  const persisted = savePrefs();
  $("settings-dialog").close();
  if (before !== settings().zone) computeHealth();
  render();
  if (persisted) toast(before !== settings().zone ? "Đã lưu. Sức khỏe được tính lại theo múi " + settings().zone + "." : "Đã lưu giao diện riêng cho " + settings().name + ".");
});
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (form.id === "block-form") {
    event.preventDefault();
    const { day, start, end } = Object.fromEntries(new FormData(form));
    try {
      if (!(String(end) > String(start))) throw new Error("Chọn giờ kết thúc sau giờ bắt đầu.");
      const s = new Date(zonedToInstant(String(day), String(start), zone())).toISOString();
      const e = new Date(zonedToInstant(String(day), String(end), zone())).toISOString();
      propose({ kind: "calendar.block", schema_version: 1, workspace_ref: api.ws, args: { calendar_ref: "primary", start: s, end: e, zone: zone(), title_code: "PERSONAL_TIME", visibility: "private" } }, "Công việc · lịch Microsoft 365");
    } catch (err) {
      $("block-error").textContent = err.message;
      $("block-error").hidden = false;
    }
  }
  if (form.id === "consent-form") {
    event.preventDefault();
    saveConsents(form);
  }
  if (form.id === "chat-form") {
    event.preventDefault();
    const input = form.elements.message;
    const value = input.value.trim();
    if (!value) return;
    input.value = "";
    chatSend(value);
  }
});
$("import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 16384) throw new Error("Tệp tùy chọn vượt quá 16 KB.");
    const data = JSON.parse(await file.text());
    if (![1, 2].includes(data.version) || !data.settings) throw new Error("Định dạng tùy chọn không được hỗ trợ.");
    prefs.users[sub()] = sanitizeSettings({ ...settings(), ...data.settings });
    savePrefs();
    $("settings-dialog").close();
    computeHealth();
    render();
    toast("Đã nhập tùy chọn vào tài khoản hiện tại.");
  } catch (err) {
    toast(err.message);
  } finally {
    event.target.value = "";
  }
});
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1);
  if (tabs.some((t) => t[0] === next)) navigate(next, false);
});

// ---------------------------------------------------------------- khởi động
(async () => {
  render();
  await api.init();
  $("build-label").textContent = api.dev ? "Bản chạy thử · Dữ liệu tổng hợp" : "Bản tham chiếu";
  const restored = api.restoreSession();
  if (!restored && api.dev) {
    try {
      await api.login(prefs.activeSub ?? "dev_a");
    } catch {
      /* máy chủ chưa chạy */
    }
  }
  await refresh();
  savePrefs();
  if (online && !healthState() && !(me?.consents?.length)) onboarding();
  // Cập nhật thẻ trạng thái định kỳ khi có thao tác chưa kết thúc.
  setInterval(async () => {
    if (!online || document.hidden || $("action-dialog").open || $("settings-dialog").open) return;
    if (!actions.some((a) => !["VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"].includes(a.status))) return;
    await Promise.all([loadActions(), loadHouse(), loadWork()]);
    render();
  }, 5000);
})();
