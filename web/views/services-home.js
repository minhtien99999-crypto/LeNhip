// Phần Le‑NodeHome của màn hình Dịch vụ (V1.0.1, SRS V2.0 mục 06–07, N20‑HOME, N20‑HAAS, LNH-T66). Chủ hộ xem trạng thái gói
// thuê HaaS theo các bước, gửi yêu cầu khảo sát, nhận báo giá, xác nhận hub đã lắp, xem danh sách sự kiện tối thiểu của nhà mình,
// cấp hoặc thu hồi quyền xem tạm thời cho LeLS. Mọi quyền tính từ trạng thái ở máy chủ (GET /v2/home/subscriptions): phần này
// không tự suy ra quyền từ điều nó đang hiển thị.
//
// Không có hình camera, video, âm thanh hay khuôn mặt: máy chủ không có chúng. Xem clip từ xa chưa mở (chỉ sau nghiệm thu).
// Giá thử của §07 chỉ hiện dưới dạng chữ, ghi rõ «giả định, không phải báo giá». Ở chế độ dev có thêm khung «Hub giả lập» để
// gửi sự kiện thử bằng danh tính hub mô phỏng (đường dev /dev/home/hub-credential), ghi rõ «mô phỏng».
//
// Phần có ô nhập nên dùng `update` (hợp đồng ở web/views/services.js): render và bind một lần, các lần vẽ nền chỉ thay từng
// vùng khi nội dung đổi, và không thay vùng đang có ô nhập được chọn. Chuỗi: khóa `homehub.*` trong
// web/shared/i18n-<ngôn ngữ>-homehub.js. Kiểu: web/views/services-home.css.
import { digestJcs } from "../shared/jcs.js";

const PATH = ["HAAS_REQUESTED", "HAAS_SURVEYED", "HAAS_ACCEPTED", "HAAS_INSTALLED", "HAAS_ACTIVE"];
const ENDED = ["HAAS_TERMINATED", "HAAS_RETURNED"];
const TONE = { HAAS_ACTIVE: "ok", HAAS_SUSPENDED: "warn", HAAS_TERMINATED: "muted", HAAS_RETURNED: "muted", HAAS_SURVEYED: "warn", HAAS_INSTALLED: "warn" };
const EVENT_TYPES = ["PERSON_IN_ZONE", "CAMERA_OFFLINE", "CAMERA_ONLINE", "HUB_OFFLINE_RECOVERED"];
const ERROR_KEYS = ["HOME_REVISION_CONFLICT", "HOME_TERMS_OUTDATED", "HOME_OPEN_LIMIT", "HOME_SERIAL_MISMATCH", "HOME_VIEW_GRANT_ACTIVE", "REAUTH_REQUIRED", "INVALID_TRANSITION", "OFFLINE"];
/** Giá thử của SRS V2.0 §07: chỉ để hiển thị dưới dạng chữ, không phải báo giá. */
const PILOT = { monthly: 349000, install: 690000, invest: 3800000, serve: 110000, months: 13 };

/** Trạng thái của phần đang hiện trên trang (một lần bind). */
let state = null;

const errKey = (e) => "homehub.error." + (ERROR_KEYS.includes(e?.code) ? e.code : "other");
const vnd = (ctx, n) => ctx.formatNumber(n, { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const day = (ctx, iso) => ctx.formatDate(iso, { day: "2-digit", month: "2-digit", timeZone: ctx.zone() });
const when = (ctx, iso) => ctx.t("homehub.at", { date: day(ctx, iso), time: ctx.formatTime24(iso, ctx.zone()) });
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** Đăng ký đang mở, nếu có; không thì đăng ký gần nhất (đã kết thúc). */
const current = () => state?.data?.subscriptions?.find((s) => !ENDED.includes(s.state)) ?? state?.data?.subscriptions?.[0] ?? null;

// ── Các vùng ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function gateHtml(ctx) {
  const ts = ctx.tSafe;
  if (!state.gate) return "";
  if (state.gate === "CONSENT_REQUIRED") {
    const c = ctx.consentText("home_hub", "homehub.");
    return '<form class="homehub-box" data-home-form="consent"><h3>' + ctx.safe(c.title) + '</h3><p lang="' + ctx.safe(c.locale) + '">' + ctx.safe(c.body) + "</p>" +
      '<p class="homehub-error" role="alert" data-home-error hidden></p><div class="button-row"><button class="button primary" type="submit">' + ts("homehub.consent.accept") + "</button></div></form>";
  }
  const key = { MODULE_DISABLED: "homehub.gate.disabled", FORBIDDEN: "homehub.gate.forbidden", OFFLINE: "homehub.gate.offline" }[state.gate] ?? "homehub.loadFailed";
  return '<p class="empty-state">' + ts(key) + "</p>";
}

function requestHtml(ctx) {
  const ts = ctx.tSafe;
  const s = current();
  if (state.gate || !state.data || (s && !ENDED.includes(s.state))) return "";
  return '<form class="homehub-box" data-home-form="request"><h3>' + ts("homehub.request.title") + "</h3>" +
    '<div class="field"><label for="homehub-site">' + ts("homehub.request.site") + '</label><input id="homehub-site" name="site_ref" required pattern="[A-Za-z0-9_\\-]{3,64}" maxlength="64" autocomplete="off" value="' +
    ctx.safe(state.draftSite) + '"><small class="fine-print">' + ts("homehub.request.siteHint") + "</small></div>" +
    '<fieldset class="homehub-choices"><legend>' + ts("homehub.request.package") + '</legend><label class="homehub-choice"><input type="radio" name="package_code" value="HOME_PILOT" checked><span>' + ts("homehub.package.HOME_PILOT") + "</span></label></fieldset>" +
    '<fieldset class="homehub-choices"><legend>' + ts("homehub.request.contact") + "</legend>" +
    ["IN_APP", "IN_APP_AND_CALL"].map((v, i) => '<label class="homehub-choice"><input type="radio" name="contact_grant" value="' + v + '"' + (i === 0 ? " checked" : "") + "><span>" + ts("homehub.contact." + v) + "</span></label>").join("") + "</fieldset>" +
    '<label class="homehub-choice"><input type="checkbox" name="terms" required><span>' + ts("homehub.request.terms", { version: state.data.terms_version }) + "</span></label>" +
    '<p class="homehub-error" role="alert" data-home-error hidden></p><div class="button-row"><button class="button primary" type="submit">' + ts("homehub.request.submit") + "</button></div></form>";
}

function stepsHtml(ctx, s) {
  const ts = ctx.tSafe;
  const reached = new Set(s.steps.map((x) => x.to_state));
  const at = PATH.indexOf(s.state);
  const list = PATH.map((st, i) => {
    const done = reached.has(st) && (at === -1 || i <= at);
    const now = st === s.state;
    return '<li class="homehub-step' + (now ? " now" : done ? " done" : "") + '"' + (now ? ' aria-current="step"' : "") + '><span class="homehub-dot" aria-hidden="true"></span><span>' + ts("homehub.state." + st) + "</span>" +
      (now ? '<span class="tiny-pill">' + ts("homehub.steps.now") + "</span>" : done ? '<span class="homehub-tick">' + ts("homehub.steps.done") + "</span>" : "") + "</li>";
  }).join("");
  const extra = at === -1 ? '<p class="homehub-note" role="status">' + ts("homehub.stateNote." + s.state) + "</p>" : "";
  const history = '<details class="homehub-history"><summary>' + ts("homehub.steps.history") + "</summary><ol>" +
    s.steps.map((x) => "<li><span>" + ts("homehub.step." + x.event) + '</span><small class="fine-print">' + ts("homehub.actor." + x.actor_kind) + " · " + ctx.safe(when(ctx, x.at)) + "</small></li>").join("") + "</ol></details>";
  return '<ol class="homehub-steps">' + list + "</ol>" + extra + history;
}

function actionsHtml(ctx, s) {
  const ts = ctx.tSafe;
  const btn = (op, cls, key) => '<button type="button" class="button ' + cls + '" data-home-op="' + op + '">' + ts(key) + "</button>";
  let html = "";
  if (s.state === "HAAS_REQUESTED") html = '<p class="fine-print">' + ts("homehub.owner.waitSurvey") + '</p><div class="button-row">' + btn("cancel", "secondary", "homehub.owner.cancel") + "</div>";
  else if (s.state === "HAAS_SURVEYED") {
    html = '<div class="homehub-quote"><span>' + ts("homehub.owner.quote", { n: s.camera_count ?? 0 }) + "</span><strong>" + ctx.safe(vnd(ctx, s.quote_vnd ?? 0)) + "</strong></div>" +
      '<p class="fine-print">' + ts("homehub.owner.quoteNote") + '</p><div class="button-row">' + btn("accept-quote", "primary", "homehub.owner.accept") + btn("cancel", "secondary", "homehub.owner.decline") + "</div>";
  } else if (s.state === "HAAS_ACCEPTED") html = '<p class="fine-print">' + ts("homehub.owner.waitInstall") + '</p><div class="button-row">' + btn("cancel", "secondary", "homehub.owner.cancel") + "</div>";
  else if (s.state === "HAAS_INSTALLED") {
    html = '<form class="homehub-box" data-home-form="confirm"><p>' + ts("homehub.owner.confirmIntro") + '</p><div class="field"><label for="homehub-serial">' + ts("homehub.owner.serial") +
      '</label><input id="homehub-serial" name="serial" required pattern="[A-Za-z0-9\\-]{4,32}" maxlength="32" autocomplete="off" autocapitalize="characters"></div>' +
      '<p class="homehub-error" role="alert" data-home-error hidden></p><div class="button-row"><button class="button primary" type="submit">' + ts("homehub.owner.confirm") + "</button>" + btn("terminate", "secondary", "homehub.owner.terminate") + "</div></form>";
  } else if (s.state === "HAAS_ACTIVE" || s.state === "HAAS_SUSPENDED") html = '<div class="button-row">' + btn("export", "secondary", "homehub.owner.export") + btn("terminate", "quiet", "homehub.owner.terminate") + "</div>";
  return html ? '<div class="homehub-actions">' + html + '<p class="homehub-error" role="alert" data-home-op-error hidden></p></div>' : "";
}

function hubHtml(ctx, s) {
  const ts = ctx.tSafe;
  if (!s.hub || s.hub.status !== "ACTIVE") return "";
  const cams = s.hub.cameras.map((c) => "<li><span>" + ctx.safe(c.camera_ref) + '</span><span class="status-chip ' + (c.online ? "ok" : "muted") + '">' + ts(c.online ? "homehub.camera.online" : "homehub.camera.unknown") + "</span></li>").join("");
  return '<div class="homehub-hub"><h3>' + ts("homehub.hub.title") + '</h3><p class="fine-print">' + ts("homehub.hub.line", { serial: s.hub.serial, firmware: s.hub.firmware, binding: s.hub.binding_version }) + "</p>" +
    '<p class="fine-print">' + (s.hub.last_seen_at ? ts("homehub.hub.seen", { at: when(ctx, s.hub.last_seen_at) }) : ts("homehub.hub.never")) + '</p><ul class="homehub-cameras">' + cams + "</ul></div>";
}

function eventsHtml(ctx, s) {
  const ts = ctx.tSafe;
  if (!s.access.events_visible) return "";
  const rows = state.events ?? [];
  const body = rows.length
    ? '<ul class="homehub-events">' + rows.map((e) =>
      '<li class="homehub-event" data-home-event="' + ctx.safe(e.type) + '"><div class="homehub-event-time"><strong>' + ctx.safe(ctx.formatTime24(e.observed_at, ctx.zone())) + "</strong><small>" + ctx.safe(day(ctx, e.observed_at)) + "</small></div>" +
      '<div class="homehub-event-copy"><strong>' + ts("homehub.event.type." + (EVENT_TYPES.includes(e.type) ? e.type : "OTHER")) + "</strong><small>" + ts("homehub.event.camera", { camera: e.camera_ref }) + "</small>" +
      '<span class="homehub-tags">' + (e.type === "PERSON_IN_ZONE" ? '<span class="tiny-pill">' + ts("homehub.event.unverified") + "</span>" : "") +
      (e.late ? '<span class="tiny-pill homehub-late" data-home-late>' + ts("homehub.event.late", { at: when(ctx, e.received_at) }) + "</span>" : "") +
      (e.clip_ref ? '<span class="tiny-pill">' + ts("homehub.event.clip") + "</span>" : "") + "</span></div></li>").join("") + "</ul>"
    : '<p class="empty-state">' + ts("homehub.events.empty") + "</p>";
  return '<div class="homehub-events-box"><div class="heading-row"><h3>' + ts("homehub.events.title") + '</h3><span class="tiny-pill">' + ts("homehub.events.count", { n: rows.length }) + "</span></div>" + body +
    '<p class="privacy-note">' + ctx.icon("camera") + "<span>" + ts("homehub.events.note") + "</span></p></div>";
}

function grantsHtml(ctx, s) {
  const ts = ctx.tSafe;
  if (!s.access.events_visible) return "";
  const active = s.view_grants.find((g) => g.active);
  const list = s.view_grants.slice(0, 5).map((g) => '<li class="homehub-grant"><div><strong>' + ts("homehub.grant.ticket", { ticket: g.ticket_ref }) + '</strong><small class="fine-print">' +
    ts(g.active ? "homehub.grant.until" : g.revoked_at ? "homehub.grant.revoked" : "homehub.grant.expired", { at: when(ctx, g.revoked_at ?? g.expires_at) }) + " · " + ts("homehub.grant.uses", { n: g.uses }) + "</small></div>" +
    (g.active ? '<button type="button" class="button secondary" data-home-revoke="' + ctx.safe(g.grant_id) + '">' + ts("homehub.grant.revoke") + "</button>" : "") + "</li>").join("");
  const form = active ? "" : '<form class="homehub-grant-form" data-home-form="grant"><div class="field"><label for="homehub-ticket">' + ts("homehub.grant.ticketLabel") +
    '</label><input id="homehub-ticket" name="ticket_ref" required pattern="[A-Za-z0-9_\\-]{3,40}" maxlength="40" autocomplete="off"></div><div class="field"><label for="homehub-minutes">' + ts("homehub.grant.minutes") +
    '</label><select id="homehub-minutes" name="minutes">' + [15, 60, 240].map((m) => '<option value="' + m + '">' + ctx.safe(ctx.formatDuration(m)) + "</option>").join("") + "</select></div>" +
    '<p class="homehub-error" role="alert" data-home-error hidden></p><div class="button-row"><button class="button primary" type="submit">' + ts("homehub.grant.create") + "</button></div></form>";
  return '<div class="homehub-grants"><h3>' + ts("homehub.grant.title") + '</h3><p class="fine-print">' + ts("homehub.grant.intro") + "</p>" + (list ? '<ul class="homehub-grant-list">' + list + "</ul>" : "") + form +
    '<p class="privacy-note">' + ctx.icon("lock") + "<span>" + ts("homehub.clip.unavailable") + "</span></p></div>";
}

function simHtml(ctx, s) {
  const ts = ctx.tSafe;
  if (ctx.api.dev !== true || !s.hub || s.hub.status !== "ACTIVE" || !s.access.hub_accepting) return "";
  return '<form class="homehub-sim" data-home-form="sim"><div class="heading-row"><h3>' + ts("homehub.sim.title") + '</h3><span class="tiny-pill">' + ts("homehub.sim.badge") + "</span></div>" +
    '<p class="fine-print">' + ts("homehub.sim.intro") + "</p>" +
    '<div class="homehub-sim-grid"><div class="field"><label for="homehub-sim-type">' + ts("homehub.sim.type") + '</label><select id="homehub-sim-type" name="type">' +
    EVENT_TYPES.map((x) => '<option value="' + x + '">' + ts("homehub.event.type." + x) + "</option>").join("") + "</select></div>" +
    '<div class="field"><label for="homehub-sim-camera">' + ts("homehub.sim.camera") + '</label><select id="homehub-sim-camera" name="camera_ref">' +
    s.hub.cameras.map((c) => '<option value="' + ctx.safe(c.camera_ref) + '">' + ctx.safe(c.camera_ref) + "</option>").join("") + "</select></div>" +
    '<div class="field"><label for="homehub-sim-age">' + ts("homehub.sim.age") + '</label><select id="homehub-sim-age" name="age">' +
    [0, 10, 60].map((m) => '<option value="' + m + '">' + (m ? ts("homehub.sim.ago", { duration: ctx.formatDuration(m) }) : ts("homehub.sim.now")) + "</option>").join("") + "</select></div></div>" +
    '<p class="homehub-note" role="status" data-home-sim-result' + (state.simResult ? "" : " hidden") + ">" + ctx.safe(state.simResult ?? "") + "</p>" +
    '<div class="button-row"><button class="button primary" type="submit">' + ts("homehub.sim.send") + "</button>" +
    '<button type="button" class="button secondary" data-home-sim-repeat' + (state.lastSim ? "" : " disabled") + ">" + ts("homehub.sim.repeat") + "</button></div></form>";
}

function bodyHtml(ctx) {
  const ts = ctx.tSafe;
  if (state.gate) return "";
  if (!state.data) return '<p class="empty-state">' + ts(state.failed ? "homehub.loadFailed" : "homehub.loading") + "</p>";
  const s = current();
  if (!s) return "";
  return '<div class="homehub-status"><div class="heading-row"><h3>' + ts("homehub.status.title") + '</h3><span class="status-chip ' + (TONE[s.state] ?? "busy") + '" data-home-state="' + ctx.safe(s.state) + '">' + ts("homehub.state." + s.state) + "</span></div>" +
    '<p class="fine-print">' + ts("homehub.status.site", { site: s.site_ref }) + "</p>" + stepsHtml(ctx, s) + actionsHtml(ctx, s) + "</div>" +
    hubHtml(ctx, s) + eventsHtml(ctx, s) + grantsHtml(ctx, s) + simHtml(ctx, s);
}

// ── Nạp, vẽ, thao tác ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function draw(ctx, el) {
  if (!state) return;
  const sub = ctx.me?.user?.id ?? null;
  if (sub !== state.loadedFor && !state.loading) void load(ctx, el);
  const put = (name, html) => {
    if (state.html[name] === html) return;
    const box = el.querySelector('[data-home="' + name + '"]');
    // Không thay vùng có ô nhập đang được chọn: chữ người dùng đang gõ còn nguyên; lần vẽ sau sẽ cập nhật.
    const focused = document.activeElement;
    if (state.html[name] !== undefined && box.contains(focused) && focused.matches("input, select")) return;
    state.html[name] = html;
    box.innerHTML = html;
  };
  put("gate", gateHtml(ctx));
  put("request", requestHtml(ctx));
  put("body", bodyHtml(ctx));
}

async function load(ctx, el) {
  state.loading = true;
  const sub = ctx.me?.user?.id ?? null;
  try {
    const data = await ctx.api.get("/v2/home/subscriptions");
    if (!state) return;
    state.data = data;
    state.gate = null;
    state.failed = false;
    const s = current();
    state.events = s && s.access.events_visible ? (await ctx.api.get("/v2/home/subscriptions/" + encodeURIComponent(s.subscription_ref) + "/events")).events : [];
  } catch (e) {
    if (!state) return;
    if (["CONSENT_REQUIRED", "MODULE_DISABLED", "FORBIDDEN", "OFFLINE"].includes(e?.code)) {
      state.gate = e.code;
      state.data = null;
    } else state.failed = true;
  }
  if (!state) return;
  state.loading = false;
  state.loadedFor = sub;
  draw(ctx, el);
}

async function reload(ctx, el) {
  if (!state || state.loading) return;
  await load(ctx, el);
}

function showError(box, ctx, e) {
  if (!box) return;
  box.textContent = ctx.t(errKey(e));
  box.hidden = false;
}

async function ownerOp(ctx, el, op, extra = {}) {
  const s = current();
  if (!s) return;
  await ctx.api.post("/v2/home/subscriptions/" + encodeURIComponent(s.subscription_ref) + "/" + op, { revision: s.revision, ...extra });
  await reload(ctx, el);
}

/** Bản xuất của đăng ký thành một tệp JSON lưu trên máy: dựng trong trang, không gửi đi đâu. */
async function downloadExport(ctx, s) {
  const data = await ctx.api.get("/v2/home/subscriptions/" + encodeURIComponent(s.subscription_ref) + "/export");
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "lenhip-home-" + s.subscription_ref + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function confirmTerminate(ctx, el) {
  const s = current();
  if (!s) return;
  const ts = ctx.tSafe;
  const body = ctx.openDialog(ctx.t("homehub.terminate.title"),
    "<p>" + ts("homehub.terminate.body") + '</p><p class="homehub-error" role="alert" data-home-dialog-error hidden></p><div class="button-row"><button type="button" class="button secondary" data-home-dialog="export">' + ts("homehub.owner.export") +
    '</button><button type="button" class="button primary" data-home-dialog="confirm">' + ts("homehub.terminate.confirm") + '</button><button type="button" class="button quiet" data-home-dialog="cancel">' + ts("homehub.cancel") + "</button></div>");
  const err = body.querySelector("[data-home-dialog-error]");
  body.querySelector('[data-home-dialog="cancel"]').addEventListener("click", () => ctx.closeDialog());
  body.querySelector('[data-home-dialog="export"]').addEventListener("click", () => downloadExport(ctx, s).catch((e) => showError(err, ctx, e)));
  body.querySelector('[data-home-dialog="confirm"]').addEventListener("click", async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    try {
      await ownerOp(ctx, el, "terminate");
      ctx.closeDialog();
      ctx.toast(ctx.t("homehub.terminate.done"));
    } catch (x) {
      showError(err, ctx, x);
      button.disabled = false;
    }
  });
}

/** Hub giả lập (chỉ chế độ dev): lấy danh tính hub mô phỏng rồi gửi phong bì có chữ ký HMAC, đúng như một hub sẽ gửi. */
async function simSend(s, env) {
  const r = await fetch("/dev/home/hub-credential?hub_id=" + encodeURIComponent(s.hub.hub_id), { headers: { Accept: "application/json" } });
  if (!r.ok) throw { code: "OTHER" };
  const cred = await r.json();
  const raw = Uint8Array.from(atob(cred.key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const hmac = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const proof = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(await digestJcs(env)))));
  const res = await fetch("/v2/home/hubs/" + encodeURIComponent(s.hub.hub_id) + "/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + cred.token, "X-LeNhip-Workspace": cred.workspace_id, "Idempotency-Key": b64url(crypto.getRandomValues(new Uint8Array(32))) },
    body: JSON.stringify({ ...env, proof }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw { code: typeof data?.code === "string" ? data.code : "OTHER" };
  return data;
}

async function onSim(ctx, el, form, repeat) {
  const s = current();
  if (!s?.hub) return;
  let env = repeat ? state.lastSim : null;
  if (!env) {
    const f = new FormData(form);
    const type = String(f.get("type"));
    const id = hex(crypto.getRandomValues(new Uint8Array(9)));
    env = {
      event_id: "sim-" + id, observed_at: new Date(ctx.now() - Number(f.get("age")) * 60_000).toISOString(), type, camera_ref: String(f.get("camera_ref")),
      binding_version: s.hub.binding_version, schema_version: 1, epoch: 1, ...(type === "PERSON_IN_ZONE" ? { clip_ref: "clp_" + id } : {}),
    };
  }
  try {
    const r = await simSend(s, env);
    state.lastSim = env;
    state.simResult = ctx.t(r.duplicate ? "homehub.sim.duplicate" : r.late ? "homehub.sim.late" : "homehub.sim.sent");
  } catch (e) {
    state.simResult = ctx.t("homehub.sim.failed", { code: String(e?.code ?? "OTHER") });
  }
  await reload(ctx, el);
}

export default {
  id: "home-hub",
  order: 10,
  visible: (ctx) => ctx.modules.home_hub === true,

  render: (ctx) =>
    '<div class="section-heading"><h2>' + ctx.icon("camera") + ctx.tSafe("homehub.title") + '</h2><span class="tiny-pill">' + ctx.tSafe("homehub.pilot") + "</span></div>" +
    '<p class="fine-print">' + ctx.tSafe("homehub.intro") + "</p>" +
    '<p class="homehub-assumption"><strong>' + ctx.tSafe("homehub.price.label") + "</strong> " +
    ctx.tSafe("homehub.price.text", { monthly: vnd(ctx, PILOT.monthly), install: vnd(ctx, PILOT.install), invest: vnd(ctx, PILOT.invest), serve: vnd(ctx, PILOT.serve), months: PILOT.months }) + "</p>" +
    '<div data-home="gate"></div><div data-home="request"></div><div data-home="body"></div>' +
    '<p class="privacy-note">' + ctx.icon("shield") + "<span>" + ctx.tSafe("homehub.privacy") + "</span></p>",

  bind(ctx, el) {
    state = { html: {}, loadedFor: undefined, loading: false, failed: false, gate: null, data: null, events: [], draftSite: "", lastSim: null, simResult: null };
    ctx.onLeave(() => {
      state = null;
    });
    el.addEventListener("click", async (e) => {
      const target = /** @type {HTMLElement} */ (e.target);
      const op = target.closest?.("[data-home-op]");
      const revoke = target.closest?.("[data-home-revoke]");
      const repeat = target.closest?.("[data-home-sim-repeat]");
      if (repeat) return void onSim(ctx, el, repeat.closest("form"), true);
      if (revoke) {
        try {
          await ctx.api.post("/v2/home/view-grants/" + encodeURIComponent(revoke.dataset.homeRevoke) + "/revoke", {});
          ctx.toast(ctx.t("homehub.grant.revokedToast"));
          await reload(ctx, el);
        } catch (x) {
          ctx.toast(ctx.t(errKey(x)));
        }
        return;
      }
      if (!op) return;
      const name = op.dataset.homeOp;
      if (name === "terminate") return confirmTerminate(ctx, el);
      const box = el.querySelector("[data-home-op-error]");
      const s = current();
      if (name === "export") return void (s && downloadExport(ctx, s).catch((x) => showError(box, ctx, x)));
      op.disabled = true;
      try {
        await ownerOp(ctx, el, name);
      } catch (x) {
        await reload(ctx, el);
        showError(el.querySelector("[data-home-op-error]"), ctx, x);
      }
    }, { signal: ctx.signal });
    el.addEventListener("input", (e) => {
      if (e.target.name === "site_ref") state.draftSite = e.target.value;
    }, { signal: ctx.signal });
    el.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const kind = form.dataset.homeForm;
      if (kind === "sim") return void onSim(ctx, el, form, false);
      if (!form.reportValidity()) return;
      const error = form.querySelector("[data-home-error]");
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      const f = new FormData(form);
      try {
        if (kind === "consent") {
          // Biên nhận ghi đúng văn bản người dùng vừa thấy: phiên bản theo ngôn ngữ và mã băm của văn bản đang hiển thị.
          const receipt = await ctx.consentReceipt("home_hub", "homehub.");
          await ctx.api.post("/v1/consents", { purpose_id: "home_hub", text_version: receipt.text_version, text_hash: receipt.text_hash, choice: "GRANTED" });
          await ctx.refresh();
        } else if (kind === "request") {
          await ctx.api.post("/v2/home/subscriptions", { site_ref: String(f.get("site_ref")), package_code: String(f.get("package_code")), contact_grant: String(f.get("contact_grant")), terms_version: state.data.terms_version });
          state.draftSite = "";
          ctx.toast(ctx.t("homehub.request.sent"));
        } else if (kind === "confirm") {
          await ctx.api.post("/v2/home/subscriptions/" + encodeURIComponent(current().subscription_ref) + "/confirm-install", { revision: current().revision, serial: String(f.get("serial")).trim().toUpperCase() });
          ctx.toast(ctx.t("homehub.owner.confirmed"));
        } else if (kind === "grant") {
          await ctx.api.post("/v2/home/subscriptions/" + encodeURIComponent(current().subscription_ref) + "/view-grants", { ticket_ref: String(f.get("ticket_ref")), minutes: Number(f.get("minutes")) });
          ctx.toast(ctx.t("homehub.grant.created"));
        }
        if (document.activeElement && el.contains(document.activeElement)) /** @type {HTMLElement} */ (document.activeElement).blur();
        await reload(ctx, el);
      } catch (x) {
        if (form.isConnected) {
          showError(error, ctx, x);
          button.disabled = false;
        }
      }
    }, { signal: ctx.signal });
    // Trạng thái do LeLS và hub đổi ở máy chủ: nạp lại mỗi 10 giây khi phần đang hiện (tự dừng khi ẩn tab).
    ctx.every(10_000, () => (state && !state.loading ? load(ctx, el) : undefined));
    draw(ctx, el);
  },

  update(ctx, el) {
    draw(ctx, el);
  },
};
