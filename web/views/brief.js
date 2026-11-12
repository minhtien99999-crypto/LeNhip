// Bản tóm tắt buổi sáng (SRS V2.0 mục 01 G1‑H, mục 03; N20‑MOB; LNH-T62; ca X11). Thẻ đầu màn hình «Hôm nay», dựng hoàn toàn trên
// thiết bị từ thứ thiết bị đã có:
//   - giấc ngủ đêm qua và bước chân hôm qua từ bản tổng hợp sức khỏe trên thiết bị, chỉ khi đồng ý đọc sức khỏe trên máy này đang
//     bật. app.js đưa bản tổng hợp thẳng vào briefCard() (không qua ctx); không giá trị nào rời thiết bị, không gọi LeLe;
//   - các khung lịch hôm nay đã nạp (ctx.state.availability), số tin chưa đọc khi nhắn tin bật, bản nháp đang mở khi đồng bộ bật;
//   - dòng của mô-đun khác qua sổ web/shared/brief-sources.js.
// Mỗi dòng phân biệt: có dữ liệu, thiếu dữ liệu, nguồn chưa sẵn sàng, quyền đã tắt. «Thiếu dữ liệu» nói trung tính (hệ điều hành
// có thể không cho biết người dùng từ chối hay chưa có số liệu). Khi mất mạng hay máy chủ, AI không trả lời, phần trên thiết bị vẫn
// hiện và thẻ nói rõ phần từ máy chủ chưa có.
import { briefHealth } from "../shared/brief-health.js";
import { sourceLines } from "../shared/brief-sources.js";
import "./brief-wiring.js"; // dòng của Hộp tổng hợp và Le‑NodeHome
import { getMsgClient, messagingConsented } from "../shared/msg-client.js";
import { getSyncClient, isQueued, visibleDrafts } from "../shared/sync-client.js";
import { draftLabel, openConflictDialog, openDraftDialog, openRegisterDialog } from "./sync-ui.js";
import { localDate } from "../shared/zone.js";

const line = (ctx, icon, html, tone = "", extra = "") =>
  '<li class="brief-line' + (tone ? " " + tone : "") + '">' + '<span class="brief-icon">' + ctx.icon(icon) + '</span><div class="brief-copy">' + html + "</div>" + extra + "</li>";
const text = (ctx, key, params) => "<span>" + ctx.tSafe(key, params) + "</span>";
const navButton = (ctx, nav, key) => '<button type="button" class="text-button brief-go" data-nav="' + nav + '">' + ctx.tSafe(key) + "</button>";

function healthLines(ctx, local) {
  const h = briefHealth(local);
  if (h.state === "off") return [line(ctx, "moon", text(ctx, "brief.health.off"), "muted", navButton(ctx, "health", "brief.health.open"))];
  if (h.state === "withdrawn") return [line(ctx, "moon", text(ctx, "brief.health.withdrawn"), "muted")];
  if (h.state === "unavailable") return [line(ctx, "moon", text(ctx, "brief.health.unavailable"), "muted")];
  const tag = local.synthetic ? ' <small class="brief-tag">' + ctx.tSafe("brief.health.synthetic") + "</small>" : "";
  const sleep = h.sleepSeconds === null
    ? line(ctx, "moon", text(ctx, "brief.health.sleepMissing"), "muted")
    : line(ctx, "moon", "<strong>" + ctx.tSafe("brief.health.sleep", { duration: ctx.formatDuration(Math.floor(h.sleepSeconds / 60)) }) + "</strong>" + tag);
  const steps = h.steps === null
    ? line(ctx, "steps", text(ctx, "brief.health.stepsMissing"), "muted")
    : line(ctx, "steps", "<strong>" + ctx.tSafe("brief.health.steps", { n: h.steps }) + "</strong>" + tag);
  return [sleep, steps];
}

function calendarLine(ctx) {
  const me = ctx.me;
  if (!ctx.state.online) return line(ctx, "clock", text(ctx, "brief.calendar.offline"), "muted");
  if (!me?.calendar?.linked) return line(ctx, "clock", text(ctx, "brief.calendar.notLinked"), "muted", navButton(ctx, "work", "brief.calendar.open"));
  const consented = Array.isArray(me.consents) && me.consents.some((c) => c.purpose_id === "calendar_link" && c.choice === "GRANTED" && !c.withdrawn_at);
  if (!consented) return line(ctx, "clock", text(ctx, "brief.calendar.consent"), "muted", navButton(ctx, "work", "brief.calendar.open"));
  const a = ctx.state.availability;
  if (!a || a.error) return line(ctx, "clock", text(ctx, "brief.calendar.unavailable"), "muted");
  const zone = ctx.zone();
  const now = ctx.now();
  const today = localDate(now, zone);
  const onToday = (b) => localDate(Date.parse(b.start), zone) === today;
  const blocks = [...(a.busy ?? []), ...(a.lenhip_blocks ?? [])].filter(onToday)
    .filter((b, i, all) => all.findIndex((x) => x.start === b.start && x.end === b.end) === i)
    .sort((x, y) => x.start.localeCompare(y.start));
  if (!blocks.length) return line(ctx, "clock", text(ctx, "brief.calendar.free"));
  const next = blocks.find((b) => Date.parse(b.end) > now);
  const head = "<strong>" + ctx.tSafe("brief.calendar.count", { n: blocks.length }) + "</strong>";
  const tail = next ? "<span>" + ctx.tSafe("brief.calendar.next", { start: ctx.formatTime24(next.start, zone), end: ctx.formatTime24(next.end, zone) }) + "</span>" : text(ctx, "brief.calendar.done");
  return line(ctx, "clock", head + tail, "", navButton(ctx, "work", "brief.calendar.open"));
}

function messagesLine(ctx) {
  if (ctx.modules.messaging !== true || !messagingConsented(ctx.me)) return "";
  const client = getMsgClient(ctx);
  if (!client) return "";
  const n = client.unread();
  return line(ctx, "messages", n > 0 ? "<strong>" + ctx.tSafe("brief.messages.unread", { n }) + "</strong>" : text(ctx, "brief.messages.none"), n > 0 ? "" : "muted", navButton(ctx, "messages", "brief.messages.open"));
}

function draftsBlock(ctx) {
  if (ctx.modules.sync !== true) return "";
  const client = getSyncClient(ctx);
  if (!client) return "";
  const ts = ctx.tSafe;
  let body;
  if (client.device !== "active") {
    body = '<p class="brief-empty">' + ts(client.device === "revoked" ? "brief.drafts.revoked" : "brief.drafts.noDevice") + '</p><div class="brief-actions"><button type="button" class="button secondary" data-brief="register">' + ts("brief.device.registerShort") + "</button></div>";
  } else {
    const drafts = visibleDrafts(client.state);
    const shown = drafts.slice(0, 5);
    body = shown.length
      ? '<ul class="brief-drafts">' + shown.map((d) => {
        const badge = d.conflict ? '<span class="status-chip warn">' + ts("brief.drafts.conflict") + "</span>" : isQueued(client.state, d.draft_id) ? '<span class="status-chip muted">' + ts("brief.drafts.queued") + "</span>" : "";
        return '<li><button type="button" class="brief-draft" data-brief="' + (d.conflict ? "conflict" : "open") + '" data-draft-id="' + ctx.safe(d.draft_id) + '">' + ctx.icon(d.purpose === "calendar_block" ? "clock" : d.purpose === "inbox_reply" ? "mail" : "check") +
          '<span class="brief-draft-copy">' + ctx.safe(draftLabel(ctx, d)) + "</span>" + badge + "</button></li>";
      }).join("") + "</ul>" + (drafts.length > shown.length ? '<p class="fine-print">' + ts("brief.drafts.more", { n: drafts.length - shown.length }) + "</p>" : "")
      : '<p class="brief-empty">' + ts(client.loaded || !ctx.state.online ? "brief.drafts.empty" : "brief.drafts.loading") + "</p>";
    body += '<div class="brief-actions"><button type="button" class="button secondary small" data-brief="new-task">' + ctx.icon("plus") + ts("brief.drafts.newTask") + "</button>" +
      '<button type="button" class="button secondary small" data-brief="new-calendar">' + ctx.icon("plus") + ts("brief.drafts.newCalendar") + "</button>" +
      '<button type="button" class="button quiet small" data-brief="refresh">' + ctx.icon("refresh") + ts("brief.drafts.refresh") + "</button></div>";
  }
  return '<div class="brief-drafts-block"><h3>' + ctx.icon("draft") + ts("brief.drafts.title") + "</h3>" + body + "</div>";
}

let lastCtx = null;

/**
 * HTML của thẻ tóm tắt. `local` chỉ có thứ app.js đã tính trên thiết bị: { consent, health, synthetic }. Không gọi mạng khi vẽ;
 * phần chạy nền (máy khách đồng bộ, nhắn tin) gọi ctx.rerender khi có dữ liệu mới.
 * @param {any} ctx  ctx chỉ đọc của khung
 * @param {{ consent: "granted" | "declined" | "withdrawn" | "none", health: any, synthetic: boolean }} local
 */
export function briefCard(ctx, local) {
  lastCtx = ctx;
  try {
    const own = [...healthLines(ctx, local), calendarLine(ctx), messagesLine(ctx)].filter(Boolean);
    const extra = sourceLines(ctx).map((s) => '<li class="brief-line" data-brief-source="' + ctx.safe(s.id) + '">' + s.html + "</li>");
    const offline = !ctx.state.online ? '<p class="brief-offline" role="status">' + ctx.icon("alert") + "<span>" + ctx.tSafe("brief.offline") + "</span></p>" : "";
    return '<section class="card brief-card" aria-labelledby="brief-title"><div class="brief-head"><span class="eyebrow">' + ctx.tSafe("brief.eyebrow") + '</span><h2 id="brief-title">' + ctx.tSafe("brief.title") + "</h2></div>" +
      offline + '<ul class="brief-lines">' + own.join("") + extra.join("") + "</ul>" + draftsBlock(ctx) +
      '<p class="fine-print brief-privacy">' + ctx.icon("shield") + "<span>" + ctx.tSafe("brief.privacy") + "</span></p></section>";
  } catch {
    return '<section class="card brief-card"><p class="brief-empty">' + ctx.tSafe("brief.error.generic") + "</p></section>";
  }
}

// Một bộ nghe chung cho mọi nút của thẻ (thẻ được vẽ lại bằng chuỗi HTML trong app.js, không có bind riêng).
if (typeof document !== "undefined") {
  document.addEventListener("click", (ev) => {
    const el = /** @type {HTMLElement | null} */ (ev.target instanceof Element ? ev.target.closest("[data-brief]") : null);
    if (!el || !lastCtx || !el.closest(".brief-card")) return;
    const ctx = lastCtx;
    const client = getSyncClient(ctx);
    if (!client) return;
    const what = el.dataset.brief;
    const id = el.dataset.draftId ?? null;
    if (what === "register") openRegisterDialog(ctx, client);
    else if (what === "new-task") openDraftDialog(ctx, client, null, "personal_task");
    else if (what === "new-calendar") openDraftDialog(ctx, client, null, "calendar_block");
    else if (what === "open" && id) openDraftDialog(ctx, client, id, null);
    else if (what === "conflict" && id) openConflictDialog(ctx, client, id);
    else if (what === "refresh") void client.refresh();
  });
}
