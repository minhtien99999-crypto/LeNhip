// Phần «Thiết bị của tôi» của màn hình Kết nối (LNH-T30): mỗi trình duyệt đã đăng nhập và đăng ký là một điểm nhận tin, có cặp
// khóa riêng. Phần này liệt kê các điểm nhận tin của chính người dùng (loại máy, ngày thêm, «thiết bị này»), cho đăng ký trình
// duyệt này và gỡ một thiết bị sau khi xác nhận. Không đổi được gì khác: không đặt tên máy, không sửa loại máy.
// Máy chủ chỉ giữ loại máy do người dùng chọn và khóa công khai; không có tên máy hay user agent.
// Lưu ý tên gọi: `devices`, `data-device`, `/v1/devices` trong app.js là ĐÈN tại site, không phải máy của người dùng.
//
// Phần có ô nhập nên dùng `update` (hợp đồng ở web/views/connect.js): render và bind một lần, các lần render nền chỉ thay từng
// vùng khi nội dung đổi. Trạng thái và mọi yêu cầu tới máy chủ đi qua web/shared/msg-client.js, dùng chung với màn hình Tin nhắn.
// Chuỗi: khóa `msg.*` trong web/shared/i18n-<ngôn ngữ>-msg.js. Kiểu: web/views/connect-endpoints.css (và các lớp msg- chung).
import { MSG_KINDS, getMsgClient, messagingConsented } from "../shared/msg-client.js";

const KIND_ICON = { PHONE: "phone", TABLET: "tablet", LAPTOP: "laptop", DESKTOP: "desktop", OTHER: "key" };

/** Trạng thái của phần đang hiện trên trang (một lần bind): HTML từng vùng, tài khoản đã nạp danh sách, lỗi nạp. */
let state = null;

const dateOf = (ctx, iso) => ctx.formatDate(iso, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: ctx.zone() });
const kindName = (ctx, kind) => ctx.t("msg.device.kind." + (MSG_KINDS.includes(kind) ? kind : "OTHER"));

function listHtml(ctx, client) {
  const ts = ctx.tSafe;
  if (!client || !client.ready) return '<p class="empty-state">' + ts("msg.endpoints.loading") + "</p>";
  if (client.failed || !client.persistent) return '<p class="empty-state">' + ts("msg.unsupported") + "</p>";
  if (!messagingConsented(ctx.me)) {
    return '<p class="empty-state">' + ts("msg.endpoints.needConsent") + '</p><div class="msg-actions"><button type="button" class="button secondary" data-nav="messages">' + ts("msg.endpoints.openMessages") + "</button></div>";
  }
  if (client.gate === "MODULE_DISABLED") return '<p class="empty-state">' + ts("msg.gate.disabled") + "</p>";
  if (client.gate === "FORBIDDEN") return '<p class="empty-state">' + ts("msg.gate.forbidden") + "</p>";
  if (state?.failed) return '<p class="empty-state">' + ts("msg.endpoints.loadFailed") + "</p>";
  if (!state?.loaded) return '<p class="empty-state">' + ts("msg.endpoints.loading") + "</p>";
  const active = client.endpoints.filter((e) => e.status === "ACTIVE");
  if (!active.length) return '<p class="empty-state">' + ts("msg.endpoints.empty") + "</p>";
  return '<ul class="endpoint-list">' + active.map((e) => {
    const date = dateOf(ctx, e.created_at);
    const kind = kindName(ctx, e.kind);
    return '<li class="endpoint-row">' + ctx.icon(KIND_ICON[e.kind] ?? "key") +
      '<div class="endpoint-copy"><strong><span>' + ctx.safe(kind) + "</span>" + (e.endpoint_id === client.device?.endpoint_id ? '<span class="tiny-pill">' + ts("msg.endpoints.this") + "</span>" : "") + "</strong><small>" + ts("msg.endpoints.added", { date }) + "</small></div>" +
      '<button type="button" class="button secondary endpoint-remove" data-endpoint-revoke="' + ctx.safe(e.endpoint_id) + '" data-focus="revoke:' + ctx.safe(e.endpoint_id) + '" aria-label="' + ts("msg.endpoints.removeLabel", { kind, date }) + '">' + ts("msg.endpoints.remove") + "</button></li>";
  }).join("") + "</ul>";
}

/** Ô đăng ký chỉ hiện khi trình duyệt này chưa có điểm nhận tin. HTML của nó không đổi khi nền vẽ lại, nên lựa chọn đang dở còn nguyên. */
function registerHtml(ctx, client) {
  const ts = ctx.tSafe;
  if (!client || !client.ready || client.failed || !client.persistent || !messagingConsented(ctx.me) || client.gate || client.registered || !state?.loaded) return "";
  return '<form class="endpoint-register" data-endpoint-form><h3>' + ts("msg.endpoints.registerTitle") + "</h3>" +
    (client.revoked ? '<p class="msg-note warn" role="status">' + ts("msg.device.revokedNote") + "</p>" : "") +
    '<fieldset class="msg-kinds"><legend>' + ts("msg.device.kindLegend") + "</legend>" +
    MSG_KINDS.map((k) => '<label class="msg-kind"><input type="radio" name="kind" value="' + k + '" required>' + ctx.icon(KIND_ICON[k]) + "<span>" + ts("msg.device.kind." + k) + "</span></label>").join("") + "</fieldset>" +
    '<p class="msg-error" role="alert" data-endpoint-error hidden></p><button class="button primary" type="submit">' + ts("msg.device.register") + "</button></form>";
}

function draw(ctx, el) {
  if (!state) return;
  const client = getMsgClient(ctx);
  const sub = ctx.me?.user?.id ?? null;
  // Đổi tài khoản, hoặc vừa đồng ý xong: nạp danh sách của đúng người đang đăng nhập.
  const want = client && client.ready && messagingConsented(ctx.me) ? sub : null;
  if (want && state.loadedFor !== want && !state.loading) void load(ctx, el, client, want);
  if (!want) {
    state.loadedFor = null;
    state.loaded = false;
  }
  const put = (name, html) => {
    if (state.html[name] === html) return;
    const box = el.querySelector('[data-endpoint="' + name + '"]');
    const active = box.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    state.html[name] = html;
    box.innerHTML = html;
    if (active) box.querySelector('[data-focus="' + CSS.escape(active) + '"]')?.focus();
  };
  put("list", listHtml(ctx, client));
  put("register", registerHtml(ctx, client));
  const n = client?.endpoints.filter((e) => e.status === "ACTIVE").length ?? 0;
  const max = client?.endpointLimit ?? 5;
  const pill = el.querySelector('[data-endpoint="count"]');
  const show = !!want && state.loaded && !state.failed;
  pill.hidden = !show;
  pill.textContent = show ? ctx.t("msg.endpoints.count", { n, max }) : "";
  pill.setAttribute("aria-label", show ? ctx.t("msg.endpoints.countLabel", { n, max }) : "");
}

async function load(ctx, el, client, sub) {
  state.loading = true;
  try {
    await client.loadEndpoints();
    state.failed = false;
  } catch {
    state.failed = true;
  }
  if (!state) return;
  state.loading = false;
  state.loaded = true;
  state.loadedFor = sub;
  draw(ctx, el);
}

function confirmRevoke(ctx, el, client, id) {
  const mine = id === client.device?.endpoint_id;
  const body = ctx.openDialog(ctx.t("msg.endpoints.confirmTitle"),
    "<p>" + ctx.tSafe(mine ? "msg.endpoints.confirmThis" : "msg.endpoints.confirmOther") + '</p><div class="button-row"><button type="button" class="button primary" data-endpoint-confirm>' + ctx.tSafe("msg.endpoints.confirm") + '</button><button type="button" class="button secondary" data-endpoint-cancel>' + ctx.tSafe("msg.cancel") + "</button></div>");
  body.querySelector("[data-endpoint-cancel]").addEventListener("click", () => ctx.closeDialog());
  body.querySelector("[data-endpoint-confirm]").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      await client.revokeEndpoint(id);
      ctx.closeDialog();
      ctx.toast(ctx.t("msg.endpoints.removed"));
    } catch {
      ctx.closeDialog();
      ctx.toast(ctx.t("msg.endpoints.removeFailed"));
    }
    if (state) draw(ctx, el);
  });
}

export default {
  id: "endpoints",
  order: 20,
  // Thiết bị của tôi là điểm nhận tin nên đi theo cờ `messaging` (LNH-T30, LNH-T36).
  visible: (ctx) => ctx.modules.messaging === true,

  render: (ctx) =>
    '<div class="section-heading"><h2>' + ctx.icon("laptop") + ctx.tSafe("connect.endpoints.title") + '</h2><span class="tiny-pill" data-endpoint="count" role="img" hidden></span></div>' +
    '<p class="fine-print">' + ctx.tSafe("msg.endpoints.intro") + "</p>" +
    '<div data-endpoint="list"></div><div data-endpoint="register"></div>' +
    '<p class="privacy-note">' + ctx.icon("shield") + "<span>" + ctx.tSafe("msg.device.newNote") + " " + ctx.tSafe("msg.endpoints.limitNote", { max: 5 }) + "</span></p>" +
    // LNH-T52: dữ liệu sức khỏe không đi theo thiết bị nhận tin.
    '<p class="privacy-note">' + ctx.icon("lock") + "<span>" + ctx.tSafe("msg.endpoints.healthNote") + "</span></p>",

  bind(ctx, el) {
    state = { html: {}, loadedFor: null, loaded: false, loading: false, failed: false };
    ctx.onLeave(() => {
      state = null;
    });
    el.addEventListener("click", (e) => {
      const button = e.target.closest?.("[data-endpoint-revoke]");
      const client = getMsgClient(ctx);
      if (button && client) confirmRevoke(ctx, el, client, button.dataset.endpointRevoke);
    }, { signal: ctx.signal });
    el.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target;
      const client = getMsgClient(ctx);
      const kind = new FormData(form).get("kind");
      const error = form.querySelector("[data-endpoint-error]");
      const fail = (key) => {
        error.textContent = ctx.t(key);
        error.hidden = false;
      };
      if (!client) return;
      if (!kind) return fail("msg.device.chooseKind");
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      error.hidden = true;
      try {
        await client.registerDevice(String(kind));
        await client.loadEndpoints().catch(() => {});
      } catch (err) {
        if (form.isConnected) {
          fail(["REAUTH_REQUIRED", "ENDPOINT_LIMIT", "STORAGE", "OFFLINE"].includes(err?.code) ? "msg.device.error." + err.code : "msg.device.error.other");
          button.disabled = false;
        }
      }
      if (state) draw(ctx, el);
    }, { signal: ctx.signal });
    const client = getMsgClient(ctx);
    void client?.start().then(() => state && draw(ctx, el));
    // Khi trình duyệt này chưa đăng ký thì không có hộp thư nào mang danh sách về: nạp lại danh sách mỗi 15 giây.
    ctx.every(15_000, () => {
      const c = getMsgClient(ctx);
      const sub = ctx.me?.user?.id;
      return state && c && sub && !c.registered && messagingConsented(ctx.me) && !state.loading ? load(ctx, el, c, sub) : undefined;
    });
    draw(ctx, el);
  },

  update(ctx, el) {
    draw(ctx, el);
  },
};
