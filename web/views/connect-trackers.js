// Phần «Thiết bị theo dõi» của màn hình Kết nối (LNH-T52..LNH-T56). Mọi thứ ở đây chạy trên thiết bị này:
//   1. Bluetooth chuẩn (LNH-T54): hiện nhịp tim và pin trực tiếp khi trang đang mở; số đo chỉ ở trong bộ nhớ, giữ 60 giây.
//   2. Nhập tệp xuất (LNH-T55): phân tích trên thiết bị và CHỈ giữ trong bộ nhớ của trang đang mở (SRS mục 11: mẫu chỉ ở RAM),
//      rồi đưa vào màn hình Sức khỏe qua web/shared/health-input.js. Không gì lấy từ tệp được ghi xuống localStorage,
//      sessionStorage, IndexedDB, cookie hay Cache API: không mẫu, không tổng theo ngày, không tên nguồn, tên tệp, thời điểm
//      nhập, và không cờ nào. Dữ liệu đã nhập kết thúc khi tải lại hoặc đóng trang, khi người khác đăng nhập, khi đồng ý
//      «Sức khỏe» trên thiết bị không còn, khi cờ `trackers` tắt, và khi người dùng bấm «Xóa dữ liệu đã nhập»; khi đó màn
//      hình Sức khỏe quay về dữ liệu tổng hợp của bản tham chiếu. Muốn xem lại thì nhập lại tệp.
//   3. App native (LNH-T56): đường chính tới HealthKit và Health Connect, CHƯA có trong bản này; thẻ thứ ba chỉ nói điều đó.
//   4. Danh mục theo đường kết nối (LNH-T53), có trạng thái và mức bằng chứng bằng lời.
// Tệp này không gọi máy chủ: không dùng client API, không gọi mạng. Thứ duy nhất của máy chủ được đọc là cờ me.modules.trackers.
// Không gì ở đây được đồng bộ sang thiết bị khác của người dùng (LNH-T52). Chưa đường nào được thử với thiết bị hay tệp thật.
//
// Hai chỗ dựa vào app.js vì ctx chưa có hàm tương ứng (đã báo cho người tích hợp):
//   - đọc (không ghi) biên nhận đồng ý sức khỏe trên thiết bị ở khóa localStorage `lenhip.health.v1.<sub>`;
//   - nút `data-action="onboarding"` mở Thông báo đầu tiên, đúng nghĩa app.js đã đặt cho thuộc tính đó.
// Người đang đăng nhập, cờ `trackers` và đồng ý sức khỏe được đọc lại mỗi lần khung hỏi `visible` của phần này.
// Hợp đồng của một phần: web/views/connect.js. Kiểu: web/views/connect-trackers.css. Chuỗi: khóa `dev.*`.
import { notifyHealthInputChanged, registerHealthProvider } from "../shared/health-input.js";
import { formatDate, formatTime24, t } from "../shared/i18n.js";
import { STALE_AFTER_MS, TRACE_WINDOW_MS, adapterAvailable, bluetoothSupport, createHeartRateSession } from "../shared/ble-live.js";
import { GARMIN_SOURCE, ImportError, SAMSUNG_SOURCE, buildImport, createImportMemory, describeImport, importToHealthInput, purgeLegacyStore, scanImport } from "../shared/health-import.js";
import { ROUTES, SERVICES, trackersByRoute } from "../shared/tracker-registry.js";

const HEALTH_RECEIPT = "lenhip.health.v1.";
const TRACE_W = 240;
const TRACE_H = 64;

/** Kho của trình duyệt. Phần này chỉ ĐỌC biên nhận đồng ý sức khỏe của ứng dụng và dọn khóa của bản dựng trước; không ghi gì. */
const storage = (() => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // trình duyệt chặn kho: coi như chưa đồng ý, phần còn lại vẫn chạy
  }
})();
// Các bản dựng trước ghi dữ liệu đã nhập xuống localStorage. Bản này không ghi nữa: khóa cũ còn sót bị xóa một lần lúc nạp trang.
purgeLegacyStore(storage);

/** Dữ liệu đã nhập của lượt mở trang này: chỉ là biến trong bộ nhớ, của đúng một người đăng nhập (LNH-T55). */
const memory = createImportMemory();
/** Người đang đăng nhập và cờ `trackers` của họ, lần gần nhất `visible` thấy. Chưa thấy thì coi là tắt (LNH-F27). */
let gate = { sub: /** @type {string | null} */ (null), on: false };
/** Trạng thái giao diện của phần, theo phần tử <section> đang hiện. */
const STATE = new WeakMap();
const PAINTED = new WeakMap();
const SEEN = new WeakMap();

/** Đồng ý «Sức khỏe» trên thiết bị này của một người: đúng phép kiểm của app.js, chỉ đọc. */
function healthConsentOn(sub) {
  try {
    const state = JSON.parse(storage?.getItem(HEALTH_RECEIPT + sub) ?? "null");
    return !!state && state.receipt?.choice === "GRANTED" && !state.receipt.withdrawn_at;
  } catch {
    return false;
  }
}

const whenText = (ms, zone) => formatTime24(ms, zone) + " · " + formatDate(ms, { dateStyle: "medium", timeZone: zone });

// Nguồn dữ liệu cho màn hình Sức khỏe: dữ liệu đã nhập trong lượt mở trang này, của đúng người đang đăng nhập, khi cờ `trackers`
// đang bật. Ứng dụng chỉ hỏi khi người dùng đã đồng ý «Sức khỏe» trên thiết bị. Không có thì trả null và ứng dụng dùng dữ liệu
// tổng hợp của bản tham chiếu.
registerHealthProvider((q) => {
  if (memory.owner() !== null && memory.owner() !== q.sub) memory.end(); // người khác đăng nhập: dữ liệu của người trước kết thúc
  const held = memory.get(q.sub);
  if (!held || gate.sub !== q.sub || !gate.on) return null;
  return {
    input: importToHealthInput(held, q),
    provenance: { kind: "import", label: t("dev.provenance.label", { kind: t("dev.kind." + held.kind) }), detail: t("dev.provenance.detail", { when: whenText(held.imported_at, q.zone) }) },
  };
});

/**
 * Chạy mỗi lần khung hỏi `visible`: ghi lại người đang đăng nhập cùng cờ của họ, và KẾT THÚC dữ liệu đã nhập khi không còn ai
 * đăng nhập, người khác đăng nhập, cờ `trackers` tắt, hoặc đồng ý «Sức khỏe» trên thiết bị không còn (SRS mục 11: xóa khi rút
 * mục đích). Có dữ liệu vừa kết thúc thì báo ứng dụng tính lại sau lượt vẽ này.
 */
function syncGate(ctx) {
  const id = ctx.me?.user?.id;
  const sub = typeof id === "string" ? id : null;
  const on = sub !== null && ctx.modules.trackers === true;
  gate = { sub, on };
  const owner = memory.owner();
  if (owner !== null && (owner !== sub || !on || !healthConsentOn(owner)) && memory.end()) setTimeout(notifyHealthInputChanged, 0);
}

// ---------------------------------------------------------------- khung tĩnh của phần

const sourceLabel = (ctx, name) => (name === SAMSUNG_SOURCE ? ctx.t("dev.source.samsung") : name === GARMIN_SOURCE ? ctx.t("dev.source.garmin") : name);

function catalogueRow(ctx, { tracker, route }) {
  const name = tracker.name ?? ctx.t(tracker.nameKey);
  const what =
    route.route === "ble_standard" ? route.services.map((s) => SERVICES[s]).join(", ")
    : route.route === "file_import" ? ctx.t("dev.format." + route.format)
    : route.route === "os_store" ? ctx.t("dev.store." + route.store)
    : route.label;
  const needs = route.needs?.length ? ctx.t("dev.needs.label", { list: ctx.formatList(route.needs.map((n) => ctx.t("dev.needs." + n))) }) : "";
  const tone = route.status === "built" ? "ok" : route.status === "reported" ? "warn" : "muted";
  const detail = [needs, route.note ? ctx.t("dev.note." + route.note) : "", ctx.t("dev.evidence." + route.evidence)].filter(Boolean).join(" ");
  return (
    '<li class="tracker-row" data-tracker-entry="' + ctx.safe(tracker.id) + '" data-tracker-status="' + ctx.safe(route.status) + '"><div class="tracker-row-head"><strong>' + ctx.safe(name) + '</strong><span class="status-chip ' + tone + '">' + ctx.tSafe("dev.status." + route.status) + "</span></div>" +
    '<span class="tracker-row-what">' + ctx.safe(what) + '</span><span class="fine-print">' + ctx.safe(detail) + "</span></li>"
  );
}

function catalogue(ctx) {
  const grouped = trackersByRoute();
  return (
    '<h3 class="tracker-subtitle">' + ctx.tSafe("dev.catalogue.title") + '</h3><p class="fine-print">' + ctx.tSafe("dev.catalogue.intro") + "</p>" +
    ROUTES.map((route) =>
      '<details class="tracker-group" data-tracker-route="' + route + '"><summary><span class="tracker-group-name">' + ctx.tSafe("dev.route." + route) + '</span><span class="tiny-pill">' + ctx.tSafe("dev.catalogue.count", { n: grouped[route].length }) + "</span></summary>" +
      '<p class="fine-print">' + ctx.tSafe("dev.routeHint." + route) + '</p><ul class="tracker-rows">' + grouped[route].map((entry) => catalogueRow(ctx, entry)).join("") + "</ul></details>").join("")
  );
}

/** Một thẻ: tiêu đề, phần chữ cố định, dòng trạng thái (role=status, luôn có mặt để trình đọc màn hình nghe được), phần thân động. */
function card(ctx, id, glyph, title, fixed, pill = "") {
  return (
    '<article class="tracker-card" data-tracker-card="' + id + '" aria-labelledby="tracker-' + id + '-title"><div class="tracker-card-head"><h3 id="tracker-' + id + '-title" tabindex="-1">' + ctx.icon(glyph) + "<span>" + ctx.tSafe(title) + "</span></h3>" + pill + "</div>" +
    fixed + '<p class="tracker-status" role="status" data-tracker-status-for="' + id + '"></p><div class="tracker-body" data-tracker-body="' + id + '"></div></article>'
  );
}

function frame(ctx) {
  const T = ctx.tSafe;
  const facts = ["browsers", "session", "memory", "scope", "medical"].map((k) => "<li>" + T("dev.ble.fact." + k) + "</li>").join("");
  const kinds = ["apple", "samsung", "garmin"].map((k) => "<li>" + T("dev.import.kind." + k) + "</li>").join("");
  return (
    '<div class="section-heading"><h2>' + ctx.icon("watch") + T("connect.trackers.title") + '</h2><span class="tiny-pill">' + T("dev.pill.onDevice") + "</span></div>" +
    '<div class="privacy-note tracker-lead">' + ctx.icon("lock") + "<span>" + T("dev.lead.local") + "</span></div>" +
    '<p class="fine-print">' + T("dev.lead.scope") + "</p>" +
    '<div class="tracker-cards">' +
    card(ctx, "ble", "bluetooth", "dev.ble.title", "<p>" + T("dev.ble.intro") + '</p><ul class="tracker-list">' + facts + "</ul>") +
    card(ctx, "import", "file", "dev.import.title", "<p>" + T("dev.import.intro") + '</p><p class="tracker-note" data-tracker-memory>' + T("dev.import.local") + '</p><ul class="tracker-list">' + kinds + '</ul><p class="fine-print">' + T("dev.import.rules") + "</p>") +
    card(ctx, "native", "phone", "dev.native.title", "<p>" + T("dev.native.body") + '</p><p class="fine-print">' + T("dev.native.local") + "</p>", '<span class="status-chip muted">' + T("dev.native.pill") + "</span>") +
    "</div>" +
    catalogue(ctx)
  );
}

// ---------------------------------------------------------------- vẽ phần thân động

/** Đặt dòng trạng thái và phần thân của một thẻ. HTML không đổi thì giữ nguyên DOM; đổi thì đưa focus về nút chính của thân mới. */
function setBody(ui, id, html, status = "") {
  const body = ui.el.querySelector('[data-tracker-body="' + id + '"]');
  const line = ui.el.querySelector('[data-tracker-status-for="' + id + '"]');
  if (!body || !line) return null;
  if (line.textContent !== status) line.textContent = status;
  if (PAINTED.get(body) === html) return body;
  const hadFocus = body.contains(document.activeElement);
  body.innerHTML = html;
  PAINTED.set(body, html);
  if (hadFocus) (body.querySelector("[data-tracker-focus]") ?? ui.el.querySelector("#tracker-" + id + "-title"))?.focus();
  return body;
}

const button = (ctx, action, kind, label, focus = false) =>
  '<button type="button" class="button ' + kind + '" data-tracker="' + action + '"' + (focus ? " data-tracker-focus" : "") + ">" + label + "</button>";

/** Chưa đồng ý «Sức khỏe» trên thiết bị này: nói rõ và dẫn tới Thông báo đầu tiên, không đọc và không nhập gì. */
const consentBlock = (ctx, key) =>
  '<p class="tracker-note" data-tracker-need-consent>' + ctx.tSafe(key) + '</p><button type="button" class="button primary" data-action="onboarding" data-tracker-focus>' + ctx.tSafe("dev.consent.open") + "</button>";

function liveFrame(ctx) {
  const T = ctx.tSafe;
  return (
    '<div class="tracker-live" data-tracker-phase="live"><div class="stat-label">' + ctx.icon("health") + T("dev.ble.liveLabel") + "</div>" +
    '<div class="tracker-live-value"><span data-live="bpm">—</span> <small>' + T("dev.ble.unit") + "</small></div>" +
    '<p class="fine-print" data-live="state"></p>' +
    '<svg class="tracker-trace" viewBox="0 0 ' + TRACE_W + " " + TRACE_H + '" role="img" aria-label="' + T("dev.ble.traceLabel") + '"><line class="tracker-trace-base" x1="0" y1="' + (TRACE_H - 1) + '" x2="' + TRACE_W + '" y2="' + (TRACE_H - 1) + '"/><polyline data-live="line" points=""/><circle data-live="dot" r="4" cx="-10" cy="-10"/></svg>' +
    '<p class="fine-print" data-live="summary"></p><p class="fine-print" data-live="device"></p><p class="fine-print" data-live="malformed" hidden></p>' +
    button(ctx, "ble-stop", "secondary", T("dev.ble.stop"), true) + "</div>"
  );
}

/** Lề ngang của đường vẽ, để chấm của số đo mới nhất không bị cắt ở mép phải. */
const TRACE_PAD = 6;

/** Tọa độ của đường nhịp tim: trục ngang là 60 giây gần nhất, trục dọc tự co theo số đo nhưng không hẹp hơn 20 nhịp/phút. */
function tracePoints(trace, now) {
  if (!trace.length) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of trace) {
    lo = Math.min(lo, p.bpm);
    hi = Math.max(hi, p.bpm);
  }
  const pad = Math.max(4, (20 - (hi - lo)) / 2);
  lo -= pad;
  hi += pad;
  return trace.map((p) => [
    TRACE_PAD + Math.max(0, Math.min(1, (p.t - (now - TRACE_WINDOW_MS)) / TRACE_WINDOW_MS)) * (TRACE_W - 2 * TRACE_PAD),
    6 + (1 - (p.bpm - lo) / (hi - lo)) * (TRACE_H - 14),
  ]);
}

function fillLive(ui, body, s) {
  const { ctx } = ui;
  const set = (name, text) => {
    const node = body.querySelector('[data-live="' + name + '"]');
    if (node && node.textContent !== text) node.textContent = text;
    return node;
  };
  const r = s.reading;
  set("bpm", r && r.measured ? ctx.formatNumber(r.bpm) : "—");
  const age = r ? Math.max(0, s.now - r.at) : 0;
  set("state", !r ? ctx.t("dev.ble.waiting") : !r.measured ? ctx.t("dev.ble.noContact") : age > STALE_AFTER_MS ? ctx.t("dev.ble.stale", { n: Math.floor(age / 1000) }) : ctx.t("dev.ble.fresh"));
  const points = tracePoints(s.trace, s.now);
  body.querySelector('[data-live="line"]')?.setAttribute("points", points.map(([x, y]) => x.toFixed(1) + "," + y.toFixed(1)).join(" "));
  const dot = body.querySelector('[data-live="dot"]');
  const last = points[points.length - 1];
  dot?.setAttribute("cx", last ? last[0].toFixed(1) : "-10");
  dot?.setAttribute("cy", last ? last[1].toFixed(1) : "-10");
  const bpms = s.trace.map((p) => p.bpm);
  const summary = bpms.length ? ctx.t("dev.ble.traceSummary", { min: Math.min(...bpms), max: Math.max(...bpms), n: bpms.length }) : ctx.t("dev.ble.traceEmpty");
  set("summary", summary);
  body.querySelector(".tracker-trace")?.setAttribute("aria-label", ctx.t("dev.ble.traceLabel") + ". " + summary);
  // Tên thiết bị do trình duyệt trả: chỉ hiện ở đây, đặt bằng textContent, không đi đâu khác.
  set("device", [
    s.deviceName ? ctx.t("dev.ble.from", { name: s.deviceName }) : ctx.t("dev.ble.fromUnnamed"),
    s.battery === null ? "" : ctx.t("dev.ble.battery", { percent: ctx.formatNumber(s.battery / 100, { style: "percent" }) }),
    s.location ? ctx.t("dev.ble.location", { place: ctx.t("dev.ble.place." + s.location) }) : "",
  ].filter(Boolean).join(" · "));
  const bad = set("malformed", s.malformed ? ctx.t("dev.ble.malformed", { n: s.malformed }) : "");
  if (bad) bad.hidden = !s.malformed;
}

function paintBle(ui) {
  if (!ui.el.isConnected) return;
  const { ctx } = ui;
  const T = ctx.tSafe;
  if (!ui.support.ok) return void setBody(ui, "ble", '<p class="tracker-note" data-tracker-unsupported="' + ui.support.reason + '">' + T("dev.ble.unsupported." + ui.support.reason) + "</p>");
  if (!ui.consent) return void setBody(ui, "ble", consentBlock(ctx, "dev.ble.needConsent"));
  const s = ui.session.snapshot();
  if (s.phase === "live") {
    const body = setBody(ui, "ble", liveFrame(ctx), ctx.t("dev.ble.connected"));
    if (body) fillLive(ui, body, s);
    return;
  }
  if (s.phase === "choosing") return void setBody(ui, "ble", button(ctx, "ble-stop", "secondary", T("dev.ble.cancel"), true), ctx.t("dev.ble.choosing"));
  if (s.phase === "connecting") return void setBody(ui, "ble", button(ctx, "ble-stop", "secondary", T("dev.ble.cancel"), true), s.deviceName ? ctx.t("dev.ble.connectingTo", { name: s.deviceName }) : ctx.t("dev.ble.connecting"));
  setBody(
    ui, "ble",
    (ui.adapter === false ? '<p class="tracker-note">' + T("dev.ble.noAdapter") + "</p>" : "") + button(ctx, "ble-start", "primary", ctx.icon("bluetooth") + T("dev.ble.choose"), true),
    s.ended ? ctx.t("dev.ble.ended." + s.ended) : "",
  );
}

const sizeText = (ctx, bytes) =>
  bytes < 1_048_576 ? ctx.formatNumber(Math.ceil(bytes / 1024), { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 }) : ctx.formatNumber(bytes / 1_048_576, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });

function scanFrame(ctx) {
  return (
    '<progress class="tracker-progress" data-scan="bar" max="1" value="0" aria-label="' + ctx.tSafe("dev.import.reading") + '"></progress><p class="fine-print" data-scan="text"></p>' +
    button(ctx, "scan-cancel", "secondary", ctx.tSafe("dev.import.cancel"), true)
  );
}

function fileField(ctx, replacing) {
  return (
    (replacing ? "" : '<p class="tracker-note" data-tracker-none>' + ctx.tSafe("dev.import.none") + "</p>") +
    '<div class="field tracker-file"><label for="tracker-file">' + ctx.tSafe("dev.import.fileLabel") + '</label><input type="file" id="tracker-file" accept=".xml,.csv,.json,text/xml,application/xml,text/csv,application/json" data-tracker-focus></div>' +
    (replacing ? button(ctx, "keep", "secondary", ctx.tSafe("dev.import.keep")) : "")
  );
}

function picker(ui) {
  const { ctx, imp } = ui;
  const scan = imp.scan;
  const T = ctx.tSafe;
  const skipped = scan.stats.skipped;
  const old = (skipped.before_window ?? 0) + (skipped.future ?? 0);
  const bad = Object.entries(skipped).reduce((n, [k, v]) => (k === "before_window" || k === "future" ? n : n + v), 0);
  const options = scan.sources.map((source, i) => {
    const s = source.summary;
    const parts = [
      s.sleep_records ? ctx.t("dev.import.count.sleep", { n: s.sleep_records }) : "",
      s.sessions ? ctx.t("dev.import.count.sessions", { n: s.sessions }) : "",
      s.step_days ? ctx.t("dev.import.count.stepDays", { n: s.step_days }) : s.step_records ? ctx.t("dev.import.count.steps", { n: s.step_records }) : "",
      s.latest_ms === null ? "" : ctx.t("dev.import.latest", { date: ctx.formatDate(s.latest_ms, { dateStyle: "medium", timeZone: ctx.zone() }) }),
    ].filter(Boolean).join(" · ");
    return '<label class="tracker-source"><input type="radio" name="tracker-source" value="' + i + '"' + (i === imp.choice ? " checked data-tracker-focus" : "") + "><span><strong>" + ctx.safe(sourceLabel(ctx, source.name)) + "</strong><small>" + ctx.safe(parts) + "</small></span></label>";
  }).join("");
  return (
    '<fieldset class="tracker-sources"><legend>' + (scan.sources.length === 1 ? T("dev.import.pickOne") : T("dev.import.pickMany", { n: scan.sources.length })) + "</legend>" + options + "</fieldset>" +
    '<p class="fine-print">' + T("dev.import.note." + scan.kind) + "</p>" +
    (old || bad ? '<p class="fine-print">' + T("dev.import.skipped", { old, bad }) + "</p>" : "") +
    '<div class="button-row">' + button(ctx, "import-confirm", "primary", T("dev.import.confirm")) + button(ctx, "import-discard", "secondary", T("dev.import.discard")) + "</div>"
  );
}

/** Đếm ngày có dữ liệu trong bản đã nhập; nhớ theo phút để render nền không chạy lại LNH-SLEEP-1 mỗi lần. */
function seenIn(held, nowMs, zone) {
  const key = zone + "|" + Math.floor(nowMs / 60_000);
  let memo = SEEN.get(held);
  if (!memo || memo.key !== key) SEEN.set(held, (memo = { key, value: describeImport(held, { nowMs, zone }) }));
  return memo.value;
}

function imported(ui, held) {
  const { ctx, imp } = ui;
  const T = ctx.tSafe;
  const zone = ctx.zone();
  const seen = seenIn(held, ctx.now(), zone);
  const fact = (key, value) => "<div><dt>" + T("dev.import.fact." + key) + "</dt><dd>" + ctx.safe(value) + "</dd></div>";
  return (
    '<div class="tracker-imported" data-tracker-imported="' + ctx.safe(held.kind) + '"><p class="tracker-active">' + ctx.icon("check") + "<span>" + T("dev.import.active") + "</span></p>" +
    '<dl class="tracker-facts">' +
    fact("kind", ctx.t("dev.kind." + held.kind)) +
    fact("source", sourceLabel(ctx, held.source)) +
    fact("when", whenText(held.imported_at, zone)) +
    fact("seen", ctx.t("dev.import.seen", { sleep: seen.sleep_observed_days, unknown: seen.sleep_unknown_days, steps: seen.steps_days })) +
    fact("until", ctx.t("dev.import.until")) +
    "</dl>" +
    (imp.confirmDelete
      ? '<p class="tracker-note">' + T("dev.import.deleteAsk") + '</p><div class="button-row">' + button(ctx, "delete-no", "secondary", T("dev.import.deleteNo"), true) + button(ctx, "delete-yes", "primary", ctx.icon("trash") + T("dev.import.deleteYes")) + "</div>"
      : '<div class="button-row"><button type="button" class="button primary" data-nav="health" data-tracker-focus>' + T("dev.import.view") + "</button>" + button(ctx, "replace", "secondary", T("dev.import.replace")) + button(ctx, "delete", "secondary", ctx.icon("trash") + T("dev.import.delete")) + "</div>") +
    "</div>"
  );
}

function paintImport(ui) {
  if (!ui.el.isConnected) return;
  const { ctx, imp } = ui;
  if (!ui.consent) return void setBody(ui, "import", consentBlock(ctx, "dev.import.needConsent"));
  if (imp.phase === "scanning") {
    const body = setBody(ui, "import", scanFrame(ctx), ctx.t("dev.import.reading"));
    if (!body) return;
    const bar = body.querySelector('[data-scan="bar"]');
    if (bar) bar.value = imp.total > 0 ? Math.min(1, imp.bytes / imp.total) : 0;
    const text = body.querySelector('[data-scan="text"]');
    if (text) text.textContent = ctx.t("dev.import.progress", { done: sizeText(ctx, imp.bytes), total: sizeText(ctx, imp.total) });
    return;
  }
  if (imp.phase === "pick" && imp.scan) return void setBody(ui, "import", picker(ui), imp.message);
  const held = memory.get(ui.sub);
  setBody(ui, "import", held && !imp.replacing ? imported(ui, held) : fileField(ctx, !!held), imp.message);
}

// ---------------------------------------------------------------- thao tác

const idleImport = (message = "") => ({ phase: "idle", scan: null, abort: null, bytes: 0, total: 0, choice: 0, replacing: false, confirmDelete: false, message });

async function startScan(ui, file) {
  const { ctx } = ui;
  if (!ui.consent) return;
  ui.imp.abort?.abort();
  const abort = new AbortController();
  const replacing = ui.imp.replacing;
  ui.imp = { ...idleImport(), phase: "scanning", abort, total: file.size, replacing };
  paintImport(ui);
  let painted = 0;
  let message;
  try {
    const scan = await scanImport(file, {
      nowMs: ctx.now(),
      signal: abort.signal,
      onProgress(bytes) {
        if (ui.imp.abort !== abort) return;
        ui.imp.bytes = bytes;
        if (performance.now() - painted > 120) {
          painted = performance.now();
          paintImport(ui);
        }
      },
    });
    if (ui.imp.abort !== abort) return; // đã có lượt đọc khác thay thế, hoặc đã rời màn hình
    if (scan.sources.length) {
      ui.imp = { ...idleImport(ctx.t("dev.import.detected", { kind: ctx.t("dev.kind." + scan.kind) })), phase: "pick", scan, choice: Math.max(0, scan.sources.findIndex((s) => s.name === scan.suggested)), replacing };
      return paintImport(ui);
    }
    message = ctx.t("dev.import.empty");
  } catch (e) {
    if (ui.imp.abort !== abort) return;
    const code = e instanceof ImportError ? e.code : "FAILED";
    if (!(e instanceof ImportError)) console.error(e);
    message = code === "ABORTED" ? ctx.t("dev.import.aborted") : ctx.t("dev.import.error." + code);
  }
  ui.imp = { ...idleImport(message), replacing };
  paintImport(ui);
}

function onClick(ui, event) {
  const target = event.target instanceof Element ? event.target.closest("button[data-tracker]") : null;
  if (!target || !ui.el.contains(target)) return;
  const { ctx, imp } = ui;
  const action = target.dataset.tracker;
  if (action === "ble-start") {
    // Gọi ngay trong thao tác bấm: trình duyệt chỉ mở hộp chọn thiết bị khi có thao tác của người dùng.
    if (ui.consent) ui.session?.start();
  } else if (action === "ble-stop") {
    ui.session?.stop();
  } else if (action === "scan-cancel") {
    imp.abort?.abort();
  } else if (action === "import-discard") {
    ui.imp = { ...idleImport(), replacing: imp.replacing };
    paintImport(ui);
  } else if (action === "import-confirm") {
    const source = imp.scan?.sources[imp.choice];
    if (!imp.scan || !source || !ui.consent) return;
    // Chỉ nguồn đã chọn được giữ, và chỉ trong bộ nhớ của trang; các nguồn khác của tệp bị bỏ cùng kết quả quét.
    memory.hold(ui.sub, buildImport(imp.scan, source.name, ctx.now()));
    ui.imp = idleImport(ctx.t("dev.import.done"));
    notifyHealthInputChanged(); // ứng dụng tính lại và vẽ lại, không gọi máy chủ
    paintImport(ui);
  } else if (action === "replace" || action === "keep") {
    ui.imp = { ...idleImport(), replacing: action === "replace" };
    paintImport(ui);
  } else if (action === "delete" || action === "delete-no") {
    ui.imp = { ...idleImport(), confirmDelete: action === "delete" };
    paintImport(ui);
  } else if (action === "delete-yes") {
    memory.end(); // xóa ngay khỏi bộ nhớ của trang
    ui.imp = idleImport(ctx.t("dev.import.deleted"));
    notifyHealthInputChanged();
    paintImport(ui);
  }
}

function onChange(ui, event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !ui.el.contains(target)) return;
  if (target.id === "tracker-file") {
    const file = target.files?.[0];
    if (file) startScan(ui, file);
  } else if (target.name === "tracker-source") {
    ui.imp.choice = Number(target.value);
  }
}

/** Đọc lại đồng ý rồi vẽ hai thẻ động. Mất đồng ý thì ngắt Bluetooth và bỏ lượt đọc tệp đang dở. */
function refresh(ui) {
  ui.consent = healthConsentOn(ui.sub);
  if (!ui.consent) {
    ui.session?.stop();
    ui.imp.abort?.abort();
    ui.imp = idleImport();
  }
  paintBle(ui);
  paintImport(ui);
}

export default {
  id: "trackers",
  order: 30,
  // Cờ `trackers` tắt khi chưa đặt rõ (LNH-F27, LNH-T53).
  visible(ctx) {
    syncGate(ctx);
    return ctx.modules.trackers === true;
  },
  render: (ctx) => frame(ctx),

  bind(ctx, el) {
    const support = bluetoothSupport();
    const ui = { ctx, el, locale: ctx.locale(), sub: ctx.me?.user?.id ?? "", support, adapter: null, session: null, consent: false, imp: idleImport() };
    STATE.set(el, ui);
    if (support.ok) {
      ui.session = createHeartRateSession({ bluetooth: support.bluetooth, onChange: () => paintBle(ui) });
      adapterAvailable(support.bluetooth).then((available) => {
        ui.adapter = available;
        paintBle(ui);
      });
    }
    el.addEventListener("click", (event) => onClick(ui, event), { signal: ctx.signal });
    el.addEventListener("change", (event) => onChange(ui, event), { signal: ctx.signal });
    // Mỗi giây: trượt cửa sổ 60 giây của đường vẽ và cập nhật «chưa có số đo mới».
    ctx.every(1000, () => {
      if (ui.session?.snapshot().phase === "live") paintBle(ui);
    });
    // Rời màn hình, đổi tài khoản hoặc phần bị ẩn: ngắt Bluetooth (số đo bị xóa khỏi bộ nhớ) và bỏ lượt đọc tệp đang dở.
    ctx.onLeave(() => {
      ui.session?.stop();
      ui.imp.abort?.abort();
      ui.imp = idleImport();
    });
    refresh(ui);
  },

  // Render nền của ứng dụng: không dựng lại khung (ô chọn tệp, mục đang mở và phiên Bluetooth được giữ), chỉ vẽ lại phần động.
  update(ctx, el) {
    const ui = STATE.get(el);
    if (!ui) return;
    if (ui.locale !== ctx.locale()) {
      ui.locale = ctx.locale();
      el.innerHTML = frame(ctx);
    }
    refresh(ui);
  },
};
