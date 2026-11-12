// Giao diện của đồng bộ bản nháp và phiên thiết bị (LNH-T63, LNH-T64): hộp sửa bản nháp, hộp chọn khi xung đột (X01), hộp đăng ký
// thiết bị này, và màn hình trung tính «Phiên này đã bị thu hồi» (X02). Dùng chung cho thẻ tóm tắt (web/shared/brief.js) và phần
// «Phiên trên các thiết bị» của Kết nối. Mọi chữ qua ctx.t với khóa brief.* (web/shared/i18n-<ngôn ngữ>-brief.js).
import { SYNC_KINDS, isQueued, newDraftId, onSyncRevoked } from "../shared/sync-client.js";
import { addDays, localDate, localParts, zonedToInstant } from "../shared/zone.js";

export const KIND_ICON = { PHONE: "phone", TABLET: "tablet", LAPTOP: "laptop", DESKTOP: "desktop", WATCH: "watch", OTHER: "key" };

const hhmm = (ctx, iso) => ctx.formatTime24(iso, ctx.zone());
const dayLabel = (ctx, iso) => ctx.formatDate(iso, { weekday: "short", day: "2-digit", month: "2-digit", timeZone: ctx.zone() });

/** Một dòng văn bản thuần mô tả bản nháp (không HTML). */
export function draftLabel(ctx, entry) {
  const s = entry.snapshot ?? {};
  if (entry.purpose === "calendar_block") return ctx.t("brief.draft.calendar", { day: dayLabel(ctx, s.start), start: hhmm(ctx, s.start), end: hhmm(ctx, s.end) });
  // Việc tạo từ Hộp tổng hợp chưa có dòng người dùng gõ thì hiện tóm tắt của nguồn, như dữ liệu (X04).
  const title = s.title ?? s.summary ?? "";
  if (entry.purpose === "personal_task") return s.done ? ctx.t("brief.draft.taskDone", { title }) : ctx.t("brief.draft.task", { title });
  return ctx.t("brief.draft.reply");
}

/** Mô tả đầy đủ một snapshot cho hộp xung đột (HTML đã thoát). */
function snapshotHtml(ctx, purpose, s) {
  if (!s) return '<p class="fine-print">' + ctx.tSafe("brief.conflict.discarded") + "</p>";
  if (purpose === "inbox_reply") return '<p class="sync-quote">' + ctx.safe(s.body || ctx.t("brief.editor.emptyReply")) + "</p>";
  const extra = purpose === "personal_task" && s.due ? '<p class="fine-print">' + ctx.tSafe("brief.editor.dueOn", { date: ctx.formatDate(s.due, { day: "2-digit", month: "2-digit", year: "numeric" }) }) + "</p>" : "";
  return '<p class="sync-quote">' + ctx.safe(draftLabel(ctx, { purpose, snapshot: s })) + "</p>" + extra;
}

function dayOptions(ctx, selected) {
  const today = localDate(ctx.now(), ctx.zone());
  let html = "";
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i);
    html += '<option value="' + d + '"' + (d === selected ? " selected" : "") + ">" + ctx.safe(ctx.formatDate(d, { weekday: "long", day: "2-digit", month: "2-digit" })) + "</option>";
  }
  return html;
}

/** Trường nguồn của một mục Hộp tổng hợp (hợp đồng của nhánh inbox), giữ nguyên khi người dùng sửa phần của mình. */
const INBOX_FIELDS = ["kind", "item_ref", "source_kind", "summary", "source_link", "observed_at"];
const inboxPart = (base) => (base?.kind === "inbox_item" ? Object.fromEntries(INBOX_FIELDS.map((k) => [k, base[k]])) : null);

/** Snapshot từ ô nhập của hộp sửa; null kèm mã lỗi khi chưa hợp lệ. */
function readForm(ctx, purpose, form, base) {
  const f = new FormData(form);
  if (purpose === "personal_task") {
    const title = String(f.get("title") ?? "").trim();
    if (!title) return { error: "brief.editor.needTitle" };
    const due = String(f.get("due") ?? "");
    return { snapshot: { ...inboxPart(base), title: title.slice(0, 120), done: f.get("done") === "on", due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null } };
  }
  if (purpose === "calendar_block") {
    const day = String(f.get("day") ?? "");
    const start = String(f.get("start") ?? "");
    const end = String(f.get("end") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return { error: "brief.editor.needTime" };
    const s = zonedToInstant(day, start, ctx.zone());
    const e = zonedToInstant(day, end, ctx.zone());
    if (!(e > s) || e - s > 12 * 3600_000) return { error: "brief.editor.badWindow" };
    return { snapshot: { title_code: "PERSONAL_TIME", start: new Date(s).toISOString(), end: new Date(e).toISOString(), zone: ctx.zone() } };
  }
  const body = String(f.get("body") ?? "").slice(0, 1000);
  const src = inboxPart(base);
  return { snapshot: src ? { ...src, body } : { item_ref: base?.item_ref ?? "", body } };
}

function editorFields(ctx, purpose, s) {
  const ts = ctx.tSafe;
  // Mục nguồn từ Hộp tổng hợp: chữ thuần, không liên kết, không nút; không gì trong đó mở quyền hay phát lệnh (X04).
  const source = s?.kind === "inbox_item" ? '<div class="sync-source"><span class="eyebrow">' + ts("brief.editor.fromInbox") + '</span><p class="sync-quote">' + ctx.safe(s.summary ?? "") + "</p></div>" : "";
  if (purpose === "personal_task") {
    return source + '<label class="field"><span>' + ts("brief.editor.title") + '</span><input name="title" maxlength="120" required value="' + ctx.safe(s?.title ?? String(s?.summary ?? "").slice(0, 120)) + '" autocomplete="off"></label>' +
      '<label class="field"><span>' + ts("brief.editor.due") + '</span><input name="due" type="date" value="' + ctx.safe(s?.due ?? "") + '"></label>' +
      '<label class="sync-check"><input type="checkbox" name="done"' + (s?.done ? " checked" : "") + "><span>" + ts("brief.editor.done") + "</span></label>" +
      '<p class="fine-print">' + ts("brief.editor.taskNote") + "</p>";
  }
  if (purpose === "calendar_block") {
    const z = ctx.zone();
    const start = s?.start ? localParts(Date.parse(s.start), z) : null;
    const day = s?.start ? localDate(Date.parse(s.start), z) : addDays(localDate(ctx.now(), z), 1);
    const t2 = (p, def) => (p ? String(p.hour).padStart(2, "0") + ":" + String(p.minute).padStart(2, "0") : def);
    const end = s?.end ? localParts(Date.parse(s.end), z) : null;
    return '<label class="field"><span>' + ts("brief.editor.day") + '</span><select name="day">' + dayOptions(ctx, day) + "</select></label>" +
      '<div class="sync-times"><label class="field"><span>' + ts("brief.editor.start") + '</span><input name="start" type="time" required value="' + t2(start, "09:00") + '"></label>' +
      '<label class="field"><span>' + ts("brief.editor.end") + '</span><input name="end" type="time" required value="' + t2(end, "10:00") + '"></label></div>' +
      '<p class="fine-print">' + ts("brief.editor.calendarNote") + "</p>";
  }
  return source + '<label class="field"><span>' + ts("brief.editor.reply") + '</span><textarea name="body" maxlength="1000" rows="4">' + ctx.safe(s?.body ?? "") + "</textarea></label>" +
    '<p class="fine-print">' + ts("brief.editor.replyNote") + "</p>";
}

/**
 * Hộp sửa một bản nháp (hoặc tạo mới khi `id` là null). Lưu chỉ đổi bản nháp; với khung giờ, «Giữ khung này» đọc lại bản nháp
 * trên máy chủ (phiên còn dùng, revision khớp) rồi mới gọi ctx.propose: xác nhận thật vẫn là bước xem lại 120 giây, trực tuyến.
 */
export function openDraftDialog(ctx, client, id, purpose) {
  const entry = id ? client.state.drafts[id] : null;
  if (id && !entry) return;
  if (entry?.conflict) return openConflictDialog(ctx, client, id);
  const p = entry?.purpose ?? purpose;
  const draftId = id ?? newDraftId();
  const ts = ctx.tSafe;
  const online = ctx.state.online && client.online;
  const queued = id ? isQueued(client.state, id) : false;
  const canHold = p === "calendar_block" && !!id && !queued;
  const html = '<form class="sync-editor" data-sync-editor novalidate>' + editorFields(ctx, p, entry?.snapshot) +
    '<p class="sync-error" role="alert" data-sync-error hidden></p>' +
    '<div class="sync-actions"><button class="button primary" type="submit">' + ts("brief.editor.save") + "</button>" +
    (id ? '<button class="button secondary" type="button" data-sync="discard">' + ts("brief.editor.discard") + "</button>" : "") + "</div>" +
    (canHold ? '<div class="sync-hold"><button class="button secondary full" type="button" data-sync="hold"' + (online ? "" : " disabled") + ">" + ts("brief.editor.hold") + "</button>" +
      '<p class="fine-print">' + ts(online ? "brief.editor.holdNote" : "brief.editor.holdOffline") + "</p></div>" : "") +
    '<p class="fine-print">' + ts(p === "inbox_reply" ? "brief.sync.memoryOnly" : "brief.sync.local") + "</p></form>";
  const body = ctx.openDialog(ctx.t(id ? "brief.editor.editTitle" : p === "calendar_block" ? "brief.editor.newCalendar" : "brief.editor.newTask"), html);
  const form = /** @type {HTMLFormElement} */ (body.querySelector("[data-sync-editor]"));
  const err = /** @type {HTMLElement} */ (body.querySelector("[data-sync-error]"));
  const fail = (key) => {
    err.textContent = ctx.t(key);
    err.hidden = false;
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const r = readForm(ctx, p, form, entry?.snapshot);
    if (r.error) return fail(r.error);
    client.edit({ draft_id: draftId, purpose: p, snapshot: r.snapshot });
    ctx.closeDialog();
    ctx.toast(ctx.t(client.online && ctx.state.online ? "brief.toast.saved" : "brief.toast.queued"));
  });
  body.querySelector('[data-sync="discard"]')?.addEventListener("click", () => {
    client.discard(draftId);
    ctx.closeDialog();
    ctx.toast(ctx.t("brief.toast.discarded"));
  });
  body.querySelector('[data-sync="hold"]')?.addEventListener("click", async () => {
    const local = client.state.drafts[draftId];
    try {
      const d = await client.check(draftId);
      if (!local || d.revision !== local.revision || d.state !== "OPEN") return fail("brief.editor.changedElsewhere");
      const s = d.snapshot;
      await ctx.propose({ kind: "calendar.block", schema_version: 1, workspace_ref: ctx.api.ws, args: { calendar_ref: "primary", start: s.start, end: s.end, zone: s.zone, title_code: "PERSONAL_TIME", visibility: "private" } }, ctx.t("review.label.calendar"));
    } catch (e) {
      if (client.device === "revoked") return;
      fail(errorKey(e));
    }
  });
}

/** Khóa câu báo cho một lỗi của /v2/sync hay /v2/devices. */
export function errorKey(e) {
  const known = ["OFFLINE", "REAUTH_REQUIRED", "DEVICE_LIMIT", "DEVICE_REQUIRED", "DEVICE_REVOKED", "MODULE_DISABLED", "DRAFT_LIMIT", "DRAFT_INVALID", "REVISION_CONFLICT", "DRAFT_DISCARDED", "NOT_FOUND"];
  return "brief.error." + (known.includes(e?.code) ? e.code : "generic");
}

/** Xung đột (X01): hai bản cạnh nhau, người dùng chọn; không bản nào bị ghi đè trước khi chọn. */
export function openConflictDialog(ctx, client, id) {
  const entry = client.state.drafts[id];
  if (!entry?.conflict) return;
  const theirs = entry.conflict.theirs;
  const ts = ctx.tSafe;
  const mine = entry.conflict.mine_op === "discard" ? null : entry.snapshot;
  const html = '<p class="subtitle">' + ts("brief.conflict.text") + "</p>" +
    '<div class="sync-versions"><section class="sync-version" data-version="mine"><h3>' + ts("brief.conflict.mine") + "</h3>" + snapshotHtml(ctx, entry.purpose, mine) +
    '<button class="button primary full" type="button" data-sync="mine">' + ts(mine ? "brief.conflict.keepMine" : "brief.conflict.keepDiscard") + "</button></section>" +
    '<section class="sync-version" data-version="theirs"><h3>' + ts("brief.conflict.theirs", { revision: theirs.revision }) + "</h3>" + snapshotHtml(ctx, entry.purpose, theirs.snapshot) +
    '<button class="button secondary full" type="button" data-sync="theirs">' + ts("brief.conflict.useTheirs") + "</button></section></div>";
  const body = ctx.openDialog(ctx.t("brief.conflict.title"), html);
  for (const choice of ["mine", "theirs"]) {
    body.querySelector('[data-sync="' + choice + '"]')?.addEventListener("click", () => {
      client.resolve(id, choice);
      ctx.closeDialog();
      ctx.toast(ctx.t(choice === "mine" ? "brief.toast.keptMine" : "brief.toast.usedTheirs"));
    });
  }
}

/** Ô chọn loại máy (không tên máy, không user agent). */
export function kindChooser(ctx) {
  return '<fieldset class="sync-kinds"><legend>' + ctx.tSafe("brief.device.kindLegend") + "</legend>" +
    SYNC_KINDS.map((k) => '<label class="sync-kind"><input type="radio" name="kind" value="' + k + '" required>' + ctx.icon(KIND_ICON[k]) + "<span>" + ctx.tSafe("brief.device.kind." + k) + "</span></label>").join("") + "</fieldset>";
}

/** Gắn hành vi đăng ký cho một form có kindChooser. */
export function bindRegister(ctx, client, form, done) {
  const err = form.querySelector("[data-sync-error]");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const kind = String(new FormData(form).get("kind") ?? "");
    if (!SYNC_KINDS.includes(kind)) {
      err.textContent = ctx.t("brief.device.needKind");
      err.hidden = false;
      return;
    }
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      await client.register(kind);
      ctx.toast(ctx.t("brief.toast.registered"));
      done?.();
    } catch (e) {
      err.textContent = ctx.t(errorKey(e));
      err.hidden = false;
    } finally {
      button.disabled = false;
    }
  }, ctx.signal ? { signal: ctx.signal } : undefined);
}

export function registerFormHtml(ctx) {
  return '<form class="sync-register" data-sync-register novalidate>' + kindChooser(ctx) + '<p class="fine-print">' + ctx.tSafe("brief.device.registerNote") + "</p>" +
    '<p class="sync-error" role="alert" data-sync-error hidden></p><button class="button primary" type="submit">' + ctx.tSafe("brief.device.register") + "</button></form>";
}

export function openRegisterDialog(ctx, client) {
  const body = ctx.openDialog(ctx.t("brief.device.registerTitle"), registerFormHtml(ctx));
  bindRegister(ctx, client, body.querySelector("[data-sync-register]"), () => ctx.closeDialog());
}

/**
 * Màn hình trung tính khi phiên của thiết bị này bị thu hồi (X02): đóng mọi hộp đang mở (kể cả bước xem lại sắp xác nhận), không
 * hiện bản nháp nào, không đổi tiêu đề trang. Bản nháp và hàng đợi đã rời trang và bộ nhớ trình duyệt trước khi màn hình hiện.
 */
function showRevoked(ctx) {
  ctx.closeDialog();
  let d = /** @type {HTMLDialogElement | null} */ (document.getElementById("sync-revoked"));
  if (!d) {
    d = document.createElement("dialog");
    d.id = "sync-revoked";
    d.className = "sync-revoked";
    d.setAttribute("aria-labelledby", "sync-revoked-title");
    document.body.append(d);
  }
  d.innerHTML = '<div class="sync-revoked-body">' + ctx.icon("lock") + '<h2 id="sync-revoked-title">' + ctx.tSafe("brief.revoked.title") + "</h2><p>" + ctx.tSafe("brief.revoked.text") + "</p>" +
    '<button class="button primary" type="button" data-sync-revoked-close>' + ctx.tSafe("brief.revoked.ok") + "</button></div>";
  d.querySelector("[data-sync-revoked-close]")?.addEventListener("click", () => d?.close());
  if (!d.open) d.showModal();
}
onSyncRevoked(showRevoked);
