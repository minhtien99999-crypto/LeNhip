// Phần Le‑NodeHealth của màn hình Dịch vụ (SRS V2.0 mục 08, N20‑MEAS, LNH-T67, ca X08, X09). Chỉ HIỂN THỊ: nhật ký và xu hướng
// của phép đo hợp lệ, nhắc đo theo lịch người dùng tự đặt. Không chỉ báo AFib, không chẩn đoán, không gợi ý đổi thuốc, không
// cảnh báo y tế tự động; lời lẽ trung tính; ghi rõ «không phải thiết bị y tế chẩn đoán».
//
// - Phép đo đến từ adapter đã duyệt ở máy chủ (bản này chỉ có adapter mô phỏng); trang không có token adapter. Ở chế độ dev, ô
//   «Máy đo giả lập» nhờ adapter mô phỏng của máy chủ phát một phép đo tổng hợp, nhãn «mô phỏng».
// - Người dùng xác nhận hoặc từ chối ánh xạ máy đo → mình, trả lời bản ghi cách ly (chỉ thấy thời điểm, máy, lý do; không thấy
//   giá trị), cấp và thu hồi grant chia sẻ, xem phép đo người khác chia sẻ, xuất, xóa.
// - Lịch nhắc đo chỉ nằm trên thiết bị này (localStorage, theo tài khoản) và chỉ hiện khi trang đang mở: chưa có thông báo đẩy.
//   Giá trị đo không bao giờ được ghi xuống bộ nhớ của trình duyệt.
// - Phần có ô nhập nên dùng `update` (hợp đồng ở web/views/services.js): render và bind một lần, nền chỉ thay từng vùng khi đổi.
// Chuỗi: khóa `meas.*` trong web/shared/i18n-<ngôn ngữ>-meas.js. Kiểu: web/views/services-measure.css (lớp meas-).
import { addDays, localDate, localParts } from "../shared/zone.js";

const PREFIX = "meas.";
const REMINDER_KEY = "lenhip.meas.reminders.v1:";
const TREND_POINTS = 14;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Trạng thái của phần đang hiện (một lần bind). */
let st = null;

const consented = (me) => !!me?.consents?.some((c) => c.purpose_id === "measurements" && c.choice === "GRANTED" && !c.withdrawn_at);
const hasGrant = (me) => !!me?.grants?.some((g) => g.scope === "measurements.record" && g.status === "ACTIVE");

function readReminders(sub) {
  try {
    const v = JSON.parse(localStorage.getItem(REMINDER_KEY + sub) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && HM.test(x)).slice(0, 4) : [];
  } catch {
    return [];
  }
}
function writeReminders(sub, list) {
  try {
    localStorage.setItem(REMINDER_KEY + sub, JSON.stringify(list));
  } catch {
    /* bộ nhớ của trình duyệt bị chặn: lịch chỉ còn trong phiên này */
  }
}

const when = (ctx, iso) => ctx.formatDate(iso, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ctx.zone() });
const errKey = (e) => (e?.code === "MODULE_DISABLED" ? "meas.gate.disabled" : e?.code === "FORBIDDEN" ? "meas.gate.forbidden" : e?.status === 0 ? "meas.offline" : "meas.error");
const hhmm = (ctx) => {
  const p = localParts(ctx.now(), ctx.zone());
  return String(p.hour).padStart(2, "0") + ":" + String(p.minute).padStart(2, "0");
};

// ── Vùng ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function gateHtml(ctx) {
  const ts = ctx.tSafe;
  if (!hasGrant(ctx.me)) return '<p class="empty-state">' + ts("meas.gate.forbidden") + "</p>";
  if (consented(ctx.me)) return "";
  const text = ctx.consentText("measurements", PREFIX);
  return '<form class="meas-consent" data-meas-consent><h3>' + ts("meas.consent.measurements.title") + "</h3><p>" + ctx.safe(text.body) + "</p>" +
    '<p class="fine-print">' + ts("meas.consent.version", { version: text.text_version }) + "</p>" +
    '<label class="meas-check"><input type="checkbox" required> <span>' + ts("meas.consent.check") + "</span></label>" +
    '<p class="meas-error" role="alert" data-meas-consent-error hidden></p><button class="button primary" type="submit">' + ts("meas.consent.accept") + "</button></form>";
}

/** Xu hướng: hai đường tâm thu và tâm trương của tối đa 14 phép đo hợp lệ gần nhất, một trục mmHg, có chú giải và nhãn từng điểm. */
function trendHtml(ctx, obs) {
  const ts = ctx.tSafe;
  const valid = obs.filter((o) => o.quality_status === "VALID").slice(0, TREND_POINTS).reverse();
  if (valid.length < 2) return '<p class="empty-state">' + ts("meas.trend.empty") + "</p>";
  const W = 320;
  const H = 140;
  const pad = { l: 34, r: 10, t: 10, b: 12 };
  const lo = Math.floor(Math.min(...valid.map((o) => o.diastolic)) / 10) * 10 - 10;
  const hi = Math.ceil(Math.max(...valid.map((o) => o.systolic)) / 10) * 10 + 10;
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (valid.length - 1);
  const y = (v) => pad.t + ((hi - v) * (H - pad.t - pad.b)) / (hi - lo);
  const line = (k) => valid.map((o, i) => `${x(i).toFixed(1)},${y(o[k]).toFixed(1)}`).join(" ");
  const ticks = [lo, Math.round((lo + hi) / 2), hi];
  const dots = (k, cls) => valid.map((o, i) => {
    const label = ctx.t("meas.trend.point", { when: when(ctx, o.measured_at), systolic: o.systolic, diastolic: o.diastolic });
    return `<circle class="${cls}" cx="${x(i).toFixed(1)}" cy="${y(o[k]).toFixed(1)}" r="4"><title>${ctx.safe(label)}</title></circle>`;
  }).join("");
  const first = valid[0];
  const last = valid[valid.length - 1];
  const summary = ctx.t("meas.trend.summary", { n: valid.length, from: when(ctx, first.measured_at), to: when(ctx, last.measured_at), systolic: last.systolic, diastolic: last.diastolic });
  return '<figure class="meas-trend"><svg class="meas-chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + ctx.safe(summary) + '">' +
    ticks.map((v) => `<line class="meas-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="meas-axis" x="${pad.l - 6}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join("") +
    `<polyline class="meas-line sys" points="${line("systolic")}"/><polyline class="meas-line dia" points="${line("diastolic")}"/>` + dots("systolic", "meas-dot sys") + dots("diastolic", "meas-dot dia") +
    '</svg><figcaption><span class="meas-key sys">' + ts("meas.trend.systolic") + '</span><span class="meas-key dia">' + ts("meas.trend.diastolic") + "</span><span>" + ts("meas.trend.unit") + "</span></figcaption>" +
    '<p class="fine-print">' + ctx.safe(summary) + "</p></figure>";
}

function logHtml(ctx, obs, sources) {
  const ts = ctx.tSafe;
  if (!obs.length) return '<p class="empty-state">' + ts("meas.log.empty") + "</p>";
  const sim = new Set(sources.filter((s) => s.trust === "SIMULATED").map((s) => s.adapter_id));
  return '<ul class="meas-log">' + obs.slice(0, 30).map((o) =>
    '<li class="meas-row"><div class="meas-copy"><strong>' + ts("meas.log.value", { systolic: o.systolic, diastolic: o.diastolic }) + "</strong><small>" + ctx.safe(when(ctx, o.measured_at)) + "</small>" +
    '<span class="meas-tags">' + (o.quality_status === "VALID" ? "" : '<span class="status-chip muted">' + ts("meas.log.questionable") + "</span>") + (sim.has(o.source) ? '<span class="tiny-pill">' + ts("meas.simulated") + "</span>" : "") + "</span></div>" +
    '<button type="button" class="button quiet small" data-meas-delete="' + ctx.safe(o.observation_id) + '" aria-label="' + ts("meas.log.deleteLabel", { when: when(ctx, o.measured_at) }) + '">' + ts("meas.log.delete") + "</button></li>").join("") + "</ul>";
}

function mappingsHtml(ctx, mappings) {
  const ts = ctx.tSafe;
  const open = mappings.filter((m) => m.state === "MEASMAP_PROPOSED" || m.state === "MEASMAP_CONFIRMED");
  if (!open.length) return '<p class="empty-state">' + ts("meas.map.empty") + "</p>";
  return '<ul class="meas-log">' + open.map((m) => {
    const what = m.user_slot ? ts("meas.map.slot", { device: m.device_ref, slot: m.user_slot }) : ts("meas.map.whole", { device: m.device_ref });
    const id = ctx.safe(m.mapping_id);
    const buttons = m.state === "MEASMAP_PROPOSED"
      ? '<button type="button" class="button primary small" data-meas-map="confirm" data-id="' + id + '">' + ts("meas.map.confirm") + '</button><button type="button" class="button secondary small" data-meas-map="reject" data-id="' + id + '">' + ts("meas.map.reject") + "</button>"
      : '<button type="button" class="button secondary small" data-meas-map="reject" data-id="' + id + '">' + ts("meas.map.unlink") + "</button>";
    const note = m.state === "MEASMAP_PROPOSED" ? ts("meas.map.proposed", { n: m.pending_records }) : ts("meas.map.confirmed");
    return '<li class="meas-row"><div class="meas-copy"><strong>' + what + "</strong><small>" + note + '</small></div><div class="meas-actions">' + buttons + "</div></li>";
  }).join("") + "</ul>";
}

function quarantineHtml(ctx, records) {
  const ts = ctx.tSafe;
  if (!records.length) return '<p class="empty-state">' + ts("meas.q.empty") + "</p>";
  return '<ul class="meas-log">' + records.map((r) =>
    '<li class="meas-row"><div class="meas-copy"><strong>' + ts("meas.q.reason." + r.reason) + "</strong><small>" + ts("meas.q.meta", { when: when(ctx, r.measured_at), device: r.device_ref }) + "</small>" +
    (r.my_answer ? "<small>" + ts(r.my_answer === "MINE" ? "meas.q.answeredMine" : "meas.q.answeredNot") + "</small>" : "") + '</div><div class="meas-actions">' +
    '<button type="button" class="button primary small" data-meas-q="MINE" data-id="' + ctx.safe(r.record_id) + '">' + ts("meas.q.mine") + "</button>" +
    '<button type="button" class="button secondary small" data-meas-q="NOT_MINE" data-id="' + ctx.safe(r.record_id) + '">' + ts("meas.q.notMine") + "</button></div></li>").join("") + "</ul>";
}

function sharesReceivedHtml(ctx, received) {
  const ts = ctx.tSafe;
  return received.length
    ? '<ul class="meas-log">' + received.map((s) => '<li class="meas-row"><div class="meas-copy"><strong>' + ts("meas.share.from", { name: s.owner_name }) + "</strong><small>" +
      ts("meas.share.expires", { expires: when(ctx, s.expires_at) }) + '</small></div><button type="button" class="button secondary small" data-meas-view="' + ctx.safe(s.share_id) + '">' + ts("meas.share.view") + "</button></li>").join("") + "</ul>"
    : '<p class="empty-state">' + ts("meas.share.noneReceived") + "</p>";
}

function sharesHtml(ctx, shares) {
  const ts = ctx.tSafe;
  const granted = shares.granted.filter((s) => s.state === "MEASSHARE_ACTIVE");
  const name = (id) => shares.people.find((p) => p.user_id === id)?.name ?? id;
  const g = granted.length
    ? '<ul class="meas-log">' + granted.map((s) => '<li class="meas-row"><div class="meas-copy"><strong>' + ts("meas.share.to", { name: name(s.grantee) }) + "</strong><small>" +
      ts("meas.share.scope", { purpose: ctx.t("meas.share.purpose." + s.purpose), from: ctx.formatDate(s.scope.from_date, { day: "2-digit", month: "2-digit", year: "numeric" }), until: when(ctx, s.scope.received_until), expires: when(ctx, s.expires_at) }) +
      '</small></div><button type="button" class="button secondary small" data-meas-revoke="' + ctx.safe(s.share_id) + '">' + ts("meas.share.revoke") + "</button></li>").join("") + "</ul>"
    : '<p class="empty-state">' + ts("meas.share.noneGranted") + "</p>";
  const r = sharesReceivedHtml(ctx, shares.received);
  const log = shares.access_log.slice(0, 8);
  const l = log.length
    ? '<ul class="meas-access">' + log.map((e) => "<li>" + ts("meas.access." + e.action, { who: e.actor === ctx.me?.user?.id ? ctx.t("meas.access.you") : name(e.actor), when: when(ctx, e.at) }) + "</li>").join("") + "</ul>"
    : '<p class="empty-state">' + ts("meas.access.empty") + "</p>";
  return "<h4>" + ts("meas.share.grantedTitle") + "</h4>" + g + "<h4>" + ts("meas.share.receivedTitle") + "</h4>" + r + "<h4>" + ts("meas.access.title") + "</h4>" + l;
}

const peopleOptions = (ctx, people) => people.map((p) => '<option value="' + ctx.safe(p.user_id) + '">' + ctx.safe(p.name) + "</option>").join("");

function remindersHtml(ctx) {
  const ts = ctx.tSafe;
  if (!st.reminders.length) return '<p class="empty-state">' + ts("meas.rem.empty") + "</p>";
  return '<ul class="meas-chips">' + st.reminders.map((t) => "<li><span>" + ctx.safe(t) + '</span><button type="button" class="button quiet small" data-meas-rem-del="' + ctx.safe(t) + '" aria-label="' + ts("meas.rem.removeLabel", { time: t }) + '">' + ctx.icon("close") + "</button></li>").join("") + "</ul>";
}

function simPanel(ctx) {
  const ts = ctx.tSafe;
  const opt = (v, k, p) => '<option value="' + v + '">' + ts(k, p) + "</option>";
  return '<details class="meas-sim" data-meas-simbox><summary>' + ts("meas.sim.title") + ' <span class="tiny-pill">' + ts("meas.simulated") + "</span></summary>" +
    '<p class="fine-print">' + ts("meas.sim.lead") + '</p><form class="meas-form" data-meas-sim>' +
    '<label class="field"><span>' + ts("meas.sim.device") + '</span><select name="device">' + opt("SHARED", "meas.sim.deviceShared") + opt("PERSONAL", "meas.sim.devicePersonal") + "</select></label>" +
    '<label class="field"><span>' + ts("meas.sim.slot") + '</span><select name="user_slot">' + opt("1", "meas.sim.slotN", { slot: 1 }) + opt("2", "meas.sim.slotN", { slot: 2 }) + opt("0", "meas.sim.slotUnknown") + "</select></label>" +
    '<label class="field"><span>' + ts("meas.sim.channel") + '</span><select name="channel">' + opt("PHONE_GATEWAY", "meas.sim.channelPhone") + opt("PARTNER_CLOUD", "meas.sim.channelCloud") + opt("BOTH", "meas.sim.channelBoth") + "</select></label>" +
    '<label class="meas-check"><input type="checkbox" name="hint_self" checked> <span>' + ts("meas.sim.hint") + "</span></label>" +
    '<div class="meas-actions"><button class="button primary" type="submit">' + ts("meas.sim.send") + '</button><button class="button secondary" type="button" data-meas-sim-repeat>' + ts("meas.sim.repeat") + "</button></div>" +
    '<p class="meas-status" role="status" data-meas-sim-status></p></form></details>';
}

function bodyShell(ctx) {
  const ts = ctx.tSafe;
  const today = localDate(ctx.now(), ctx.zone());
  return '<div class="meas-grid">' +
    '<div class="meas-block meas-wide"><h3>' + ts("meas.trend.title") + '</h3><div data-meas="trend"></div></div>' +
    '<div class="meas-block"><h3>' + ts("meas.log.title") + '</h3><div data-meas="log"></div></div>' +
    '<div class="meas-block"><h3>' + ts("meas.map.title") + '</h3><p class="fine-print">' + ts("meas.map.lead") + '</p><div data-meas="mappings"></div>' +
    "<h3>" + ts("meas.q.title") + '</h3><p class="fine-print">' + ts("meas.q.lead") + '</p><div data-meas="quarantine"></div></div>' +
    '<div class="meas-block"><h3>' + ts("meas.share.title") + '</h3><p class="fine-print">' + ts("meas.share.lead") + "</p>" +
    '<form class="meas-form" data-meas-share><label class="field"><span>' + ts("meas.share.grantee") + '</span><select name="grantee_user" required data-meas="people"></select></label>' +
    '<label class="field"><span>' + ts("meas.share.purposeLabel") + '</span><select name="purpose"><option value="FAMILY_CARE">' + ts("meas.share.purpose.FAMILY_CARE") + '</option><option value="PROFESSIONAL_REVIEW">' + ts("meas.share.purpose.PROFESSIONAL_REVIEW") + "</option></select></label>" +
    '<label class="field"><span>' + ts("meas.share.fromDate") + '</span><input type="date" name="from_date" required value="' + addDays(today, -30) + '" max="' + today + '"></label>' +
    '<label class="field"><span>' + ts("meas.share.days") + '</span><input type="number" name="expires_in_days" min="1" max="90" value="7" required></label>' +
    '<p class="meas-error" role="alert" data-meas-share-error hidden></p><button class="button primary" type="submit">' + ts("meas.share.create") + "</button></form>" +
    '<div data-meas="shares"></div></div>' +
    '<div class="meas-block"><h3>' + ts("meas.rem.title") + '</h3><p class="fine-print">' + ts("meas.rem.lead") + "</p>" +
    '<form class="meas-form meas-inline" data-meas-rem><label class="field"><span>' + ts("meas.rem.time") + '</span><input type="time" name="time" required value="07:30"></label><button class="button secondary" type="submit">' + ts("meas.rem.add") + "</button></form>" +
    '<div data-meas="reminders"></div><p class="meas-status" role="status" data-meas-next></p></div>' +
    '<div class="meas-block"><h3>' + ts("meas.data.title") + '</h3><p class="fine-print">' + ts("meas.data.lead") + '</p><div class="meas-actions"><button type="button" class="button secondary" data-meas-export>' + ts("meas.data.export") +
    '</button><button type="button" class="button quiet" data-meas-erase>' + ts("meas.data.erase") + '</button></div><p class="meas-status" role="status" data-meas-data-status></p>' + (ctx.api?.dev === true ? simPanel(ctx) : "") + "</div>" +
    "</div>";
}

// ── Nạp và vẽ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function load(ctx) {
  if (!st || st.loading) return;
  st.loading = true;
  const mine = st;
  try {
    const [o, m, q, s] = await Promise.all(["/v2/health/observations", "/v2/health/mappings", "/v2/health/quarantine", "/v2/health/shares"].map((p) => ctx.api.get(p)));
    if (st !== mine) return;
    st.data = { obs: o.observations, sources: o.sources, mappings: m.mappings, quarantine: q.records, shares: s };
    st.error = null;
  } catch (e) {
    if (st === mine) st.error = e;
  } finally {
    mine.loading = false;
  }
  if (st === mine && st.el.isConnected) draw(ctx, st.el);
}

async function loadViewer(ctx) {
  const mine = st;
  mine.loading = true;
  try {
    const s = await ctx.api.get("/v2/health/shares");
    if (st === mine) st.viewer = s.received;
  } catch {
    if (st === mine) st.viewer = [];
  } finally {
    mine.loading = false;
  }
  if (st === mine && st.el.isConnected) draw(ctx, st.el);
}

function nextReminder(ctx) {
  if (!st.reminders.length) return "";
  const hm = hhmm(ctx);
  const sorted = [...st.reminders].sort();
  return ctx.t("meas.rem.next", { time: sorted.find((t) => t > hm) ?? sorted[0] });
}

function draw(ctx, el) {
  if (!st) return;
  const put = (name, html) => {
    if (st.html[name] === html) return;
    const box = el.querySelector('[data-meas="' + name + '"]');
    if (!box) return;
    st.html[name] = html;
    box.innerHTML = html;
  };
  const gate = gateHtml(ctx);
  put("gate", gate);
  const open = gate === "";
  const body = el.querySelector('[data-meas="body"]');
  if (open && !st.shell) {
    body.innerHTML = bodyShell(ctx);
    st.shell = true;
    st.html = { gate };
    bindBody(ctx, el);
  } else if (!open && st.shell) {
    body.innerHTML = "";
    st.shell = false;
    st.html = { gate };
    st.data = null;
  }
  if (!open) {
    // Người xem không cần đồng ý hay quyền ghi phép đo của riêng mình: vẫn thấy grant người khác cấp cho mình.
    if (!st.viewer && !st.loading) void loadViewer(ctx);
    put("viewer", st.viewer?.length ? "<h3>" + ctx.tSafe("meas.share.receivedTitle") + "</h3>" + sharesReceivedHtml(ctx, st.viewer) : "");
    return;
  }
  put("viewer", "");
  if (!st.data && !st.loading && !st.error) void load(ctx);
  const d = st.data;
  if (st.error) put("trend", '<p class="empty-state" role="status">' + ctx.tSafe(errKey(st.error)) + "</p>");
  else if (!d) put("trend", '<p class="empty-state">' + ctx.tSafe("meas.loading") + "</p>");
  else put("trend", trendHtml(ctx, d.obs));
  if (d) {
    put("log", logHtml(ctx, d.obs, d.sources));
    put("mappings", mappingsHtml(ctx, d.mappings));
    put("quarantine", quarantineHtml(ctx, d.quarantine));
    put("shares", sharesHtml(ctx, d.shares));
    put("people", peopleOptions(ctx, d.shares.people));
  }
  put("reminders", remindersHtml(ctx));
  const nx = el.querySelector("[data-meas-next]");
  if (nx) nx.textContent = nextReminder(ctx);
}

/** Một thao tác ghi: gửi đúng một lần, nạp lại danh sách; lỗi hiện ở ô trạng thái của nó hoặc thành thông báo nổi. */
async function act(ctx, fn, statusSel) {
  const box = statusSel ? st?.el.querySelector(statusSel) : null;
  if (box) box.hidden = true;
  try {
    await fn();
    if (st) {
      st.data = null;
      st.error = null;
      await load(ctx);
    }
    return true;
  } catch (e) {
    if (box) {
      box.textContent = ctx.t(errKey(e));
      box.hidden = false;
    } else ctx.toast(ctx.t(errKey(e)));
    return false;
  }
}

function downloadJson(name, data) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openShared(ctx, id) {
  ctx.api.get("/v2/health/shares/" + encodeURIComponent(id) + "/observations").then((r) => {
    const ts = ctx.tSafe;
    const rows = r.observations.length
      ? '<ul class="meas-log">' + r.observations.map((o) => '<li class="meas-row"><div class="meas-copy"><strong>' + ts("meas.log.value", { systolic: o.systolic, diastolic: o.diastolic }) + "</strong><small>" + ctx.safe(when(ctx, o.measured_at)) + "</small></div></li>").join("") + "</ul>"
      : '<p class="empty-state">' + ts("meas.log.empty") + "</p>";
    ctx.openDialog(ctx.t("meas.share.viewTitle", { name: r.owner_name }), '<div class="meas-dialog"><p class="privacy-note">' + ts("meas.disclaimer") + "</p>" + rows + '<p class="fine-print">' + ts("meas.share.logged") + "</p></div>");
  }, (e) => ctx.toast(ctx.t(errKey(e))));
}

/** Nút của phần: gắn MỘT lần lên khung phần (khung sống qua các lần dựng lại ruột), kể cả nút «Xem» của người xem chưa đồng ý. */
function bindClicks(ctx, el) {
  el.addEventListener("click", (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest("button");
    if (!b) return;
    const enc = encodeURIComponent;
    if (b.dataset.measDelete) void act(ctx, () => ctx.api.post("/v2/health/observations/" + enc(b.dataset.measDelete) + "/delete"));
    else if (b.dataset.measMap) void act(ctx, () => ctx.api.post("/v2/health/mappings/" + enc(b.dataset.id) + "/" + (b.dataset.measMap === "confirm" ? "confirm" : "reject")));
    else if (b.dataset.measQ) void act(ctx, () => ctx.api.post("/v2/health/quarantine/" + enc(b.dataset.id) + "/resolve", { answer: b.dataset.measQ === "MINE" ? "MINE" : "NOT_MINE" }));
    else if (b.dataset.measRevoke) void act(ctx, () => ctx.api.post("/v2/health/shares/" + enc(b.dataset.measRevoke) + "/revoke"));
    else if (b.dataset.measView) openShared(ctx, b.dataset.measView);
    else if (b.dataset.measRemDel !== undefined) {
      st.reminders = st.reminders.filter((t) => t !== b.dataset.measRemDel);
      writeReminders(st.sub, st.reminders);
      draw(ctx, el);
    }
  }, { signal: ctx.signal });
}

function bindBody(ctx, el) {
  const on = (sel, type, fn) => el.querySelector(sel)?.addEventListener(type, fn, { signal: ctx.signal });
  on("[data-meas-share]", "submit", (ev) => {
    ev.preventDefault();
    const data = new FormData(/** @type {HTMLFormElement} */ (ev.currentTarget));
    const body = { grantee_user: String(data.get("grantee_user")), purpose: String(data.get("purpose")), from_date: String(data.get("from_date")), expires_in_days: Number(data.get("expires_in_days")) };
    void act(ctx, () => ctx.api.post("/v2/health/shares", body), "[data-meas-share-error]").then((ok) => ok && ctx.toast(ctx.t("meas.share.created")));
  });
  on("[data-meas-rem]", "submit", (ev) => {
    ev.preventDefault();
    const t = String(new FormData(/** @type {HTMLFormElement} */ (ev.currentTarget)).get("time") ?? "");
    if (!HM.test(t) || st.reminders.includes(t) || st.reminders.length >= 4) return;
    st.reminders = [...st.reminders, t].sort();
    writeReminders(st.sub, st.reminders);
    draw(ctx, el);
  });
  on("[data-meas-export]", "click", () => {
    const box = el.querySelector("[data-meas-data-status]");
    ctx.api.get("/v2/health/observations/export").then((r) => {
      downloadJson("lenhip-le-nodehealth.json", r);
      box.textContent = ctx.t("meas.data.exported");
    }, (e) => (box.textContent = ctx.t(errKey(e))));
  });
  on("[data-meas-erase]", "click", () => {
    const ts = ctx.tSafe;
    const dlg = ctx.openDialog(ctx.t("meas.data.eraseTitle"), "<p>" + ts("meas.data.eraseBody") + '</p><div class="meas-actions"><button type="button" class="button primary" data-meas-erase-yes>' + ts("meas.data.eraseConfirm") + '</button><button type="button" class="button secondary" data-meas-erase-no>' + ts("meas.data.cancel") + "</button></div>");
    dlg.querySelector("[data-meas-erase-no]")?.addEventListener("click", () => ctx.closeDialog());
    dlg.querySelector("[data-meas-erase-yes]")?.addEventListener("click", async () => {
      ctx.closeDialog();
      // Xóa hết cần đăng nhập mới (300 giây): bản chạy thử lấy lại token, như khi xuất dữ liệu của lõi.
      if (ctx.api.dev && ctx.me?.user?.id) await ctx.api.login(ctx.me.user.id).catch(() => {});
      if (await act(ctx, () => ctx.api.post("/v2/health/erase"), "[data-meas-data-status]")) el.querySelector("[data-meas-data-status]").textContent = ctx.t("meas.data.erased");
    });
  });
  const simForm = el.querySelector("[data-meas-sim]");
  if (simForm) {
    const send = (repeat) => {
      const data = new FormData(simForm);
      const status = simForm.querySelector("[data-meas-sim-status]");
      status.textContent = ctx.t("meas.sim.sending");
      const body = { device: String(data.get("device")), user_slot: Number(data.get("user_slot")), hint_self: data.get("hint_self") === "on", channel: String(data.get("channel")), repeat_last: repeat };
      ctx.api.post("/v2/health/sim-device/readings", body).then(async (r) => {
        status.textContent = r.results.map((x) => ctx.t("meas.sim.result." + x.result, { channel: ctx.t(x.channel === "PARTNER_CLOUD" ? "meas.sim.channelCloud" : "meas.sim.channelPhone") })).join(" · ");
        if (st) {
          st.data = null;
          await load(ctx);
        }
      }, (e) => (status.textContent = ctx.t(errKey(e))));
    };
    simForm.addEventListener("submit", (ev) => (ev.preventDefault(), send(false)), { signal: ctx.signal });
    simForm.querySelector("[data-meas-sim-repeat]")?.addEventListener("click", () => send(true), { signal: ctx.signal });
  }
}

export default {
  id: "measure",
  order: 20,
  visible: (ctx) => ctx.modules.measurements === true,

  render(ctx) {
    const ts = ctx.tSafe;
    return '<div class="section-heading"><h2>' + ctx.icon("gauge") + "<span>" + ts("meas.title") + '</span></h2><span class="tiny-pill">' + ts("meas.referencePill") + "</span></div>" +
      '<p class="privacy-note meas-disclaimer">' + ts("meas.disclaimer") + "</p>" +
      '<p class="fine-print">' + ts("meas.lead") + "</p>" +
      '<div data-meas="gate"></div><div data-meas="viewer"></div><div data-meas="body"></div>';
  },

  bind(ctx, el) {
    const sub = ctx.me?.user?.id ?? "";
    st = { el, sub, html: {}, shell: false, data: null, loading: false, error: null, reminders: readReminders(sub), fired: new Set() };
    el.addEventListener("submit", async (ev) => {
      const f = /** @type {HTMLFormElement} */ (ev.target);
      if (!f.matches("[data-meas-consent]")) return;
      ev.preventDefault();
      const button = f.querySelector("button[type=submit]");
      const err = f.querySelector("[data-meas-consent-error]");
      button.disabled = true;
      err.hidden = true;
      try {
        // Biên nhận ghi đúng văn bản người dùng vừa thấy (phiên bản theo ngôn ngữ và mã băm).
        const receipt = await ctx.consentReceipt("measurements", PREFIX);
        await ctx.api.post("/v1/consents", { purpose_id: "measurements", text_version: receipt.text_version, text_hash: receipt.text_hash, choice: "GRANTED" });
        await ctx.refresh();
      } catch {
        if (f.isConnected) {
          err.textContent = ctx.t("meas.consent.failed");
          err.hidden = false;
          button.disabled = false;
        }
      }
    }, { signal: ctx.signal });
    bindClicks(ctx, el);
    // Nhắc đo: chỉ khi trang đang mở, đúng phút đã đặt, mỗi mốc một lần mỗi ngày. Lời nhắc trung tính.
    ctx.every(20_000, () => {
      if (!st || !st.reminders.length) return;
      const hm = hhmm(ctx);
      const tag = localDate(ctx.now(), ctx.zone()) + " " + hm;
      if (st.reminders.includes(hm) && !st.fired.has(tag)) {
        st.fired.add(tag);
        ctx.toast(ctx.t("meas.rem.due"));
      }
    });
    draw(ctx, el);
  },

  update(ctx, el) {
    if (!st) return;
    const sub = ctx.me?.user?.id ?? "";
    if (sub !== st.sub) {
      st = { el, sub, html: {}, shell: false, data: null, loading: false, error: null, reminders: readReminders(sub), fired: new Set() };
      el.querySelector('[data-meas="body"]').innerHTML = "";
      el.querySelector('[data-meas="gate"]').innerHTML = "";
    }
    draw(ctx, el);
  },
};
