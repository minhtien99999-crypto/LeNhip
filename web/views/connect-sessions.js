// Phần «Phiên trên các thiết bị» của màn hình Kết nối (SRS V2.0 mục 03, 12 `/v2/devices`; N20‑SYNC; LNH-T64; ca X02). Mỗi trình
// duyệt đăng ký một phiên riêng với loại máy người dùng chọn; phần này liệt kê các phiên của chính người dùng (loại máy, ngày tạo,
// ngày thấy gần nhất, «thiết bị này»), cho đăng ký trình duyệt này và thu hồi một phiên sau khi xác nhận. Máy chủ không lưu tên
// máy hay user agent. Đồng hồ chỉ nhận lời nhắc chung (không sức khỏe, camera hay nội dung công việc) và chưa có ứng dụng đồng hồ:
// phần này chỉ nói điều đó bằng chữ.
//
// Khác với «Thiết bị của tôi» của nhắn tin (điểm nhận tin có khóa mã hóa, LNH-T30): hai danh sách chưa gộp (LNH-F34, LNH-Q18).
// Phần có ô nhập nên dùng `update`: render và bind một lần, render nền chỉ thay từng vùng khi nội dung đổi.
// Chuỗi: khóa brief.* trong web/shared/i18n-<ngôn ngữ>-brief.js (tiêu đề là khóa lõi connect.sessions.title).
import { getSyncClient } from "../shared/sync-client.js";
import { KIND_ICON, bindRegister, errorKey, registerFormHtml } from "./sync-ui.js";

let state = null;

const dayText = (ctx, d) => ctx.formatDate(d, { day: "2-digit", month: "2-digit", year: "numeric" });

function listHtml(ctx, client) {
  const ts = ctx.tSafe;
  if (client.device === "revoked") return '<p class="empty-state">' + ts("brief.sessions.revokedHere") + "</p>";
  if (state.error) return '<p class="empty-state">' + ts(state.error) + "</p>";
  if (!client.devices) return '<p class="empty-state">' + ts("brief.sessions.loading") + "</p>";
  const active = client.devices.filter((d) => d.state === "ACTIVE");
  if (!active.length) return '<p class="empty-state">' + ts("brief.sessions.empty") + "</p>";
  return '<ul class="sync-sessions">' + active.map((d) => {
    const kind = ctx.t("brief.device.kind." + d.kind);
    const canRevoke = client.device === "active";
    return '<li class="sync-session" data-session="' + ctx.safe(d.device_id) + '">' + ctx.icon(KIND_ICON[d.kind] ?? "key") +
      '<div class="sync-session-copy"><strong><span>' + ctx.safe(kind) + "</span>" + (d.current ? '<span class="tiny-pill">' + ts("brief.sessions.this") + "</span>" : "") + "</strong>" +
      "<small>" + ts("brief.sessions.days", { created: dayText(ctx, d.created_day), seen: dayText(ctx, d.last_seen_day) }) + "</small></div>" +
      (canRevoke ? '<button type="button" class="button secondary" data-session-revoke="' + ctx.safe(d.device_id) + '" aria-label="' + ts("brief.sessions.revokeLabel", { kind }) + '">' + ts("brief.sessions.revoke") + "</button>" : "") + "</li>";
  }).join("") + "</ul>";
}

function draw(ctx, el) {
  if (!state) return;
  const client = getSyncClient(ctx);
  if (!client) return;
  const put = (name, html) => {
    if (state.html[name] === html) return;
    state.html[name] = html;
    const box = el.querySelector('[data-sessions="' + name + '"]');
    box.innerHTML = html;
    if (name === "register" && html) bindRegister(ctx, client, box.querySelector("[data-sync-register]"), () => void load(ctx, el));
  };
  put("list", listHtml(ctx, client));
  put("register", client.device === "active" ? "" : "<h3>" + ctx.tSafe("brief.device.registerTitle") + "</h3>" + (client.device === "revoked" ? '<p class="fine-print">' + ctx.tSafe("brief.sessions.reRegister") + "</p>" : "") + registerFormHtml(ctx));
}

async function load(ctx, el) {
  const client = getSyncClient(ctx);
  if (!client || !state || client.device === "revoked") return draw(ctx, el);
  try {
    await client.listDevices();
    if (state) state.error = null;
  } catch (e) {
    if (state) state.error = errorKey(e);
  }
  draw(ctx, el);
}

function confirmRevoke(ctx, el, client, id) {
  const mine = id === client.deviceId;
  const body = ctx.openDialog(ctx.t("brief.sessions.confirmTitle"),
    "<p>" + ctx.tSafe(mine ? "brief.sessions.confirmThis" : "brief.sessions.confirmOther") + '</p><div class="button-row"><button type="button" class="button primary" data-session-confirm>' + ctx.tSafe("brief.sessions.revoke") + '</button><button type="button" class="button secondary" data-session-cancel>' + ctx.tSafe("brief.sessions.cancel") + "</button></div>");
  body.querySelector("[data-session-cancel]").addEventListener("click", () => ctx.closeDialog());
  body.querySelector("[data-session-confirm]").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    try {
      await client.revoke(id);
      ctx.closeDialog();
      ctx.toast(ctx.t("brief.toast.revoked"));
    } catch (err) {
      if (client.device === "revoked") return;
      ctx.closeDialog();
      ctx.toast(ctx.t(errorKey(err)));
    }
    if (state) draw(ctx, el);
  });
}

export default {
  id: "sessions",
  order: 15,
  visible: (ctx) => ctx.modules.sync === true,

  render: (ctx) =>
    '<div class="section-heading"><h2>' + ctx.icon("sync") + ctx.tSafe("connect.sessions.title") + "</h2></div>" +
    '<p class="fine-print">' + ctx.tSafe("brief.sessions.intro") + "</p>" +
    '<div data-sessions="list"></div><div data-sessions="register"></div>' +
    '<p class="privacy-note">' + ctx.icon("shield") + "<span>" + ctx.tSafe("brief.sessions.stored") + "</span></p>" +
    '<p class="privacy-note">' + ctx.icon("watch") + "<span>" + ctx.tSafe("brief.sessions.watch") + "</span></p>",

  bind(ctx, el) {
    state = { html: {}, error: null };
    ctx.onLeave(() => {
      state = null;
    });
    el.addEventListener("click", (e) => {
      const button = e.target.closest?.("[data-session-revoke]");
      const client = getSyncClient(ctx);
      if (button && client) confirmRevoke(ctx, el, client, button.dataset.sessionRevoke);
    }, { signal: ctx.signal });
    ctx.every(15_000, () => load(ctx, el), { immediate: true });
    draw(ctx, el);
  },

  update(ctx, el) {
    draw(ctx, el);
  },
};
