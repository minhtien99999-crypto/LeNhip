// Màn hình Hộp tổng hợp (SRS V2.0 mục 04; N20‑INB; LNH-T65). Gom mục người dùng tự chia sẻ vào và thư đọc được từ nguồn chỉ đọc
// đã cấp quyền; mỗi mục có nguồn, thời điểm và «Mở bản gốc». Bốn thao tác: Lưu, Để sau, Tạo việc cá nhân, Soạn phản hồi; thêm Xong.
//
// - Màn hình có trạng thái (hợp đồng ở web/views/index.js): DOM dựng một lần trong mount(); nhịp 4 giây nạp lại trang đầu và trạng
//   thái nguồn; mỗi vùng chỉ thay khi HTML của nó đổi.
// - Tiêu đề thư và nội dung chia sẻ là dữ liệu không tin cậy (X04): chỉ vào trang qua ctx.safe, dir="auto", không bao giờ thành
//   liên kết, lệnh hay câu hỏi cho LeLe. Liên kết duy nhất bấm được là «Mở bản gốc», đã kiểm https ở máy chủ và kiểm lại ở đây.
// - «Tạo việc cá nhân» và «Soạn phản hồi» chỉ tạo bản nháp qua POST /v2/sync/drafts của track đồng bộ; không gì được gửi ra ngoài.
//   Máy chủ chưa có API bản nháp (404) thì báo «Bản nháp chưa bật trên máy chủ này» và mục giữ nguyên.
// - Nguồn Outlook ở bản này là nguồn mô phỏng (Microsoft 365 giả lập), chỉ có ở bản chạy thử; mục của nguồn biến khỏi danh sách
//   ngay khi máy chủ báo nguồn mất quyền (X03).
// - Chia sẻ vào từ hệ điều hành (share target của PWA, GET): `/?share-title=…&share-text=…&share-url=…` mở hộp thêm mục đã điền
//   sẵn để người dùng xem trước rồi mới lưu; tham số bị gỡ khỏi địa chỉ ngay.
import { checkedLink, INBOX_TEXT_LIMITS, linkSummary, userText } from "../shared/inbox-text.js";
import { addDays, localDate, zonedToInstant } from "../shared/zone.js";

const FILTERS = ["NEW", "SAVED", "SNOOZED"];
const POLL_MS = 4000;
const SHARE_PARAMS = ["share-title", "share-text", "share-url"];
const PAGE = 20;
const ERROR_KEYS = ["INBOX_LIMIT", "INBOX_SNOOZE_INVALID", "INBOX_CONTENT_INVALID", "INBOX_LINK_INVALID", "NOT_FOUND", "INVALID_TRANSITION", "OFFLINE"];

/** Lần chia sẻ vào đang chờ người dùng xem trước (đọc một lần từ địa chỉ). */
let pendingShare = null;
let view = null;

function takeShare() {
  try {
    const q = new URLSearchParams(location.search);
    if (!SHARE_PARAMS.some((k) => q.has(k))) return null;
    const share = { title: q.get("share-title") ?? "", text: q.get("share-text") ?? "", url: q.get("share-url") ?? "" };
    for (const k of SHARE_PARAMS) q.delete(k);
    const rest = q.toString();
    history.replaceState(history.state, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    return share;
  } catch {
    return null;
  }
}

function createView(first, host) {
  let ctx = first;
  const t = (k, p) => ctx.t(k, p);
  const ts = (k, p) => ctx.tSafe(k, p);
  const S = { filter: "NEW", items: [], next: null, sources: null, loaded: false, failed: false, disabled: false, busy: new Set(), loading: false, wanted: PAGE, updatedAt: null, alive: true };
  const shown = new Map();

  host.innerHTML =
    '<div class="inbox-root">' +
    '<div class="heading-row inbox-heading"><h1>' + ts("nav.inbox") + '</h1><button type="button" class="button primary" data-inbox-add data-focus="add">' + ctx.icon("plus") + "<span>" + ts("inbox.add") + "</span></button></div>" +
    '<p class="fine-print inbox-subtitle">' + ts("inbox.subtitle") + "</p>" +
    '<div class="inbox-layout">' +
    '<section class="card inbox-main" aria-labelledby="inbox-list-title"><h2 class="inbox-h" id="inbox-list-title">' + ts("inbox.list.title") + "</h2>" +
    '<div class="inbox-filters" role="group" aria-label="' + ts("inbox.filter.legend") + '" data-inbox="filters"></div>' +
    '<p class="privacy-note inbox-untrusted">' + ctx.icon("shield") + "<span>" + ts("inbox.untrusted") + "</span></p>" +
    '<div data-inbox="list" aria-live="polite"></div><div data-inbox="more"></div></section>' +
    '<aside class="card inbox-sources" aria-labelledby="inbox-sources-title" data-inbox="sources"></aside>' +
    "</div></div>";
  const el = {};
  for (const node of host.querySelectorAll("[data-inbox]")) el[node.dataset.inbox] = node;

  function swap(name, html) {
    if (shown.get(name) === html) return;
    const node = el[name];
    const active = node.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    shown.set(name, html);
    node.innerHTML = html;
    if (active) node.querySelector('[data-focus="' + CSS.escape(active) + '"]')?.focus();
  }

  const when = (value) => {
    const z = ctx.zone();
    const day = (v) => ctx.formatDate(v, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: z });
    return (day(value) === day(ctx.now()) ? "" : ctx.formatDate(value, { day: "2-digit", month: "2-digit", timeZone: z }) + " ") + ctx.formatTime24(value, z);
  };

  // ── Vẽ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  function filtersHtml() {
    return FILTERS.map((f) => '<button type="button" class="button secondary small inbox-filter" data-inbox-filter="' + f + '" data-focus="filter:' + f + '" aria-pressed="' + (S.filter === f) + '">' + ts("inbox.filter." + f) + "</button>").join("");
  }

  function itemHtml(it) {
    const dis = S.busy.has(it.item_ref) ? " disabled" : "";
    const ref = ctx.safe(it.item_ref);
    const link = checkedLink(it.source_link);
    const stateText = it.state === "SNOOZED" && it.snooze_until ? ts("inbox.state.SNOOZED_until", { time: when(it.snooze_until) }) : ts("inbox.state." + it.state);
    const chip = it.state === "NEW" ? "busy" : it.state === "SAVED" ? "ok" : "muted";
    const button = (op, key, icon) => '<button type="button" class="button secondary small" data-inbox-op="' + op + '" data-inbox-ref="' + ref + '" data-focus="' + op + ":" + ref + '"' + dis + ">" + (icon ? ctx.icon(icon) : "") + "<span>" + ts(key) + "</span></button>";
    const ops = [];
    if (it.state !== "SAVED" && it.state !== "DONE") ops.push(button("save", "inbox.action.save", "check"));
    if (it.state !== "DONE") ops.push(button("snooze", "inbox.action.snooze", "clock"));
    ops.push(button("task", "inbox.action.task", "draft"), button("reply", "inbox.action.reply", "mail"));
    if (it.state !== "DONE") ops.push(button("done", "inbox.action.done", null));
    return '<li class="inbox-item" data-inbox-item="' + ref + '" data-source="' + ctx.safe(it.source_kind) + '">' +
      '<div class="inbox-item-head"><span class="tiny-pill inbox-source">' + ctx.icon(it.source_kind === "SHARED" ? "share" : "mail") + "<span>" + ts("inbox.source." + it.source_kind) + "</span></span>" +
      '<time class="inbox-time" datetime="' + ctx.safe(it.observed_at) + '">' + ctx.safe(when(it.observed_at)) + "</time>" +
      '<span class="status-chip ' + chip + '">' + stateText + "</span></div>" +
      // Dữ liệu nguồn: chỉ chữ đã thoát ký tự, không HTML, không liên kết tự động (X04).
      '<p class="inbox-summary" dir="auto" data-inbox-summary>' + ctx.safe(it.display_summary) + "</p>" +
      (it.sender ? '<p class="inbox-sender" dir="auto">' + ts("inbox.item.sender", { sender: it.sender }) + "</p>" : "") +
      '<div class="inbox-actions">' +
      (link
        ? '<a class="button quiet small inbox-open" href="' + ctx.safe(link) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-focus="open:' + ref + '">' + ctx.icon("link") + "<span>" + ts("inbox.item.open") + "</span></a>"
        : '<span class="fine-print inbox-nolink">' + ts("inbox.item.noLink") + "</span>") +
      ops.join("") + "</div></li>";
  }

  function listHtml() {
    if (S.disabled) return '<p class="empty-state">' + ts("inbox.gate.disabled") + "</p>";
    if (!S.loaded) return '<p class="empty-state">' + ts(S.failed ? "inbox.loadFailed" : "inbox.loading") + "</p>";
    const rows = S.items.filter((i) => i.state === S.filter);
    const fail = S.failed ? '<p class="inbox-error" role="status">' + ts("inbox.loadFailed") + "</p>" : "";
    if (!rows.length) return fail + '<p class="empty-state" data-inbox-empty>' + ts("inbox.empty." + S.filter) + "</p>";
    return fail + '<ul class="inbox-items">' + rows.map(itemHtml).join("") + "</ul>" +
      (S.updatedAt ? '<p class="fine-print">' + ts("inbox.updated", { time: ctx.formatTime24(S.updatedAt, ctx.zone()) }) + "</p>" : "");
  }

  function moreHtml() {
    return S.next && !S.disabled ? '<button type="button" class="button secondary full" data-inbox-more data-focus="more"' + (S.loading ? " disabled" : "") + ">" + ts("inbox.more") + "</button>" : "";
  }

  function outlookHtml(o) {
    const chip = o.status === "CONNECTED" ? "ok" : o.status === "REVOKED" || o.status === "EXPIRED" ? "warn" : "muted";
    const lost = o.status === "REVOKED" || o.status === "EXPIRED";
    const body = ['<p class="fine-print">' + ts("inbox.sources.outlookNote") + "</p>"];
    if (o.status === "CONNECTED") body.push('<p class="fine-print">' + (o.last_sync_at ? ts("inbox.sources.lastSync", { time: when(o.last_sync_at) }) : ts("inbox.sources.neverSynced")) + "</p>");
    if (lost) body.push('<p class="inbox-note warn" role="status" data-inbox-lost>' + ts("inbox.sources.hiddenNote") + "</p>");
    if (!o.available) body.push('<p class="empty-state">' + ts("inbox.sources.unavailable") + "</p>");
    else if (o.permission === "FORBIDDEN") body.push('<p class="empty-state">' + ts("inbox.sources.forbidden") + "</p>");
    else if (o.status === "CONNECTED") {
      body.push('<p class="fine-print">' + ts("inbox.sources.disconnectNote") + '</p><button type="button" class="button secondary" data-inbox-disconnect data-focus="disconnect">' + ts("inbox.sources.disconnect") + "</button>");
    } else if (o.permission === "CONSENT_REQUIRED") {
      const c = ctx.consentText("inbox_mail", "inbox.");
      body.push('<form class="inbox-consent" data-inbox-consent><h3>' + ctx.safe(c.title) + '</h3><p class="inbox-consent-text"' + (c.locale !== ctx.locale() ? ' lang="' + ctx.safe(c.locale) + '"' : "") + ">" + ctx.safe(c.body) + "</p>" +
        '<label class="consent-row"><input type="checkbox" name="agree" required data-focus="agree"><span><strong>' + ts("inbox.consent.check") + "</strong></span></label>" +
        '<p class="fine-print">' + ts("inbox.consent.version", { version: c.text_version }) + '</p><p class="inbox-error" role="alert" data-inbox-error hidden></p>' +
        '<button type="submit" class="button primary" data-focus="consent">' + ts("inbox.consent.accept") + "</button></form>");
    } else {
      body.push('<p class="inbox-error" role="alert" data-inbox-error hidden></p><button type="button" class="button primary" data-inbox-connect data-focus="connect">' + ts(o.status === "NOT_CONNECTED" ? "inbox.sources.connect" : "inbox.sources.reconnect") + "</button>");
    }
    return '<li class="inbox-src" data-inbox-src="OUTLOOK_MAIL" data-status="' + ctx.safe(o.status) + '"><div class="inbox-src-head">' + ctx.icon("mail") +
      '<span class="inbox-src-name"><strong>' + ts("inbox.sources.outlook") + '</strong><small class="tiny-pill">' + ts("inbox.sources.simulated") + "</small></span>" +
      '<span class="status-chip ' + chip + '" data-inbox-src-status>' + ts("inbox.sources.status." + o.status) + "</span></div>" + body.join("") + "</li>";
  }

  function sourcesHtml() {
    const o = S.sources?.find((s) => s.kind === "OUTLOOK_MAIL");
    return '<h2 class="inbox-h" id="inbox-sources-title">' + ts("inbox.sources.title") + '</h2><ul class="inbox-srcs">' +
      '<li class="inbox-src" data-inbox-src="SHARED"><div class="inbox-src-head">' + ctx.icon("share") + '<span class="inbox-src-name"><strong>' + ts("inbox.sources.shared") + '</strong></span><span class="status-chip ok">' + ts("inbox.sources.status.AVAILABLE") + "</span></div>" +
      '<p class="fine-print">' + ts("inbox.sources.sharedNote") + "</p></li>" + (o ? outlookHtml(o) : "") + "</ul>";
  }

  function paint() {
    swap("filters", filtersHtml());
    swap("list", listHtml());
    swap("more", moreHtml());
    swap("sources", S.disabled ? "" : sourcesHtml());
  }

  // ── Dữ liệu ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Nạp lại từ đầu bộ lọc hiện tại, giữ số mục đã xem. Mục mất quyền nguồn rơi khỏi danh sách ngay ở lần nạp này (X03). */
  async function load() {
    const filter = S.filter;
    S.loading = true;
    try {
      const r = await ctx.api.get("/v2/inbox/items?state=" + filter + "&limit=" + Math.min(50, Math.max(PAGE, S.wanted)));
      if (!S.alive || filter !== S.filter) return;
      S.items = r.items;
      S.next = r.next_cursor;
      S.sources = r.sources;
      S.loaded = true;
      S.failed = false;
      S.disabled = false;
      S.updatedAt = r.server_time;
    } catch (e) {
      if (!S.alive) return;
      if (e?.code === "MODULE_DISABLED") S.disabled = true;
      else S.failed = true;
    } finally {
      S.loading = false;
    }
    if (S.alive) paint();
  }

  async function more() {
    if (!S.next || S.loading) return;
    S.loading = true;
    paint();
    const filter = S.filter;
    try {
      const r = await ctx.api.get("/v2/inbox/items?state=" + filter + "&limit=" + PAGE + "&cursor=" + encodeURIComponent(S.next));
      if (filter !== S.filter) return;
      const known = new Set(S.items.map((i) => i.item_ref));
      S.items = [...S.items, ...r.items.filter((i) => !known.has(i.item_ref))];
      S.next = r.next_cursor;
      S.wanted = S.items.length;
    } catch {
      S.failed = true;
    } finally {
      S.loading = false;
    }
    if (S.alive) paint();
  }

  const find = (ref) => S.items.find((i) => i.item_ref === ref);
  const errorText = (e) => (ERROR_KEYS.includes(e?.code) ? t("inbox.error." + e.code) : t("inbox.action.failed"));

  async function op(ref, name, body) {
    if (S.busy.has(ref)) return;
    S.busy.add(ref);
    paint();
    try {
      const item = await ctx.api.post("/v2/inbox/items/" + encodeURIComponent(ref) + "/" + name, body);
      S.items = S.items.map((i) => (i.item_ref === ref ? item : i));
      ctx.toast(name === "snooze" ? t("inbox.action.snoozed", { time: when(item.snooze_until) }) : t("inbox.action." + name + "Toast"));
    } catch (e) {
      ctx.toast(errorText(e));
      void load();
    } finally {
      S.busy.delete(ref);
      if (S.alive) paint();
    }
  }

  /** Bản nháp qua API của track đồng bộ: không gửi gì ra ngoài, không đổi trạng thái của mục. */
  async function draft(ref, purpose) {
    const it = find(ref);
    if (!it || S.busy.has(ref)) return;
    S.busy.add(ref);
    paint();
    const snapshot = { kind: "inbox_item", item_ref: it.item_ref, source_kind: it.source_kind, summary: it.display_summary, source_link: it.source_link, observed_at: it.observed_at };
    try {
      await ctx.api.post("/v2/sync/drafts", { purpose, snapshot });
      ctx.toast(t("inbox.draft.created"));
    } catch (e) {
      ctx.toast(e?.status === 404 || e?.code === "MODULE_DISABLED" ? t("inbox.draft.unavailable") : t("inbox.draft.failed"));
    } finally {
      S.busy.delete(ref);
      if (S.alive) paint();
    }
  }

  // ── Hộp thoại ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  function snoozeDialog(ref) {
    const z = ctx.zone();
    const now = ctx.now();
    const today = localDate(now, z);
    const wd = new Date(today + "T00:00:00Z").getUTCDay();
    const options = [
      { id: "in3h", at: now + 3 * 3600_000 },
      { id: "tomorrow", at: zonedToInstant(addDays(today, 1), "08:00", z) },
      { id: "nextWeek", at: zonedToInstant(addDays(today, ((8 - wd) % 7) || 7), "08:00", z) },
    ];
    const label = (o) => (o.id === "in3h" ? ts("inbox.snooze.in3h", { time: ctx.formatTime24(o.at, z) })
      : o.id === "tomorrow" ? ts("inbox.snooze.tomorrow", { time: "08:00" })
      : ts("inbox.snooze.nextWeek", { day: ctx.formatWeekday(o.at, "long", z), date: ctx.formatDate(o.at, { day: "2-digit", month: "2-digit", timeZone: z }), time: "08:00" }));
    const body = ctx.openDialog(t("inbox.snooze.title"),
      '<form class="inbox-dialog" data-inbox-snooze><fieldset class="inbox-choices"><legend>' + ts("inbox.snooze.legend") + "</legend>" +
      options.map((o, i) => '<label class="inbox-choice"><input type="radio" name="when" value="' + o.id + '"' + (i === 0 ? " checked" : "") + "><span>" + label(o) + "</span></label>").join("") +
      '<label class="inbox-choice"><input type="radio" name="when" value="custom"><span>' + ts("inbox.snooze.custom") + "</span></label>" +
      '<label class="field inbox-custom"><span>' + ts("inbox.snooze.customLabel") + '</span><input type="datetime-local" name="custom" step="60"></label></fieldset>' +
      '<p class="inbox-error" role="alert" data-inbox-error hidden></p><div class="inbox-dialog-actions"><button type="submit" class="button primary">' + ts("inbox.snooze.confirm") + "</button></div></form>");
    const form = body.querySelector("form");
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const pick = data.get("when");
      let at = options.find((o) => o.id === pick)?.at ?? NaN;
      if (pick === "custom") {
        const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(data.get("custom") ?? ""));
        at = m ? zonedToInstant(m[1], m[2], z) : NaN;
      }
      if (!Number.isFinite(at) || at <= ctx.now() + 60_000 || at > ctx.now() + 30 * 86_400_000) {
        const box = form.querySelector("[data-inbox-error]");
        box.textContent = t("inbox.snooze.invalid");
        box.hidden = false;
        return;
      }
      ctx.closeDialog();
      void op(ref, "snooze", { until: new Date(at).toISOString() });
    });
  }

  /** Hộp thêm mục: dán văn bản hoặc liên kết, xem trước đúng chuỗi sẽ lưu, chọn mục đích và nơi lưu. */
  function importDialog(prefill) {
    const ws = ctx.me?.workspace?.name ?? "";
    const startKind = prefill?.url ? "URL" : "TEXT";
    const text0 = prefill ? [prefill.title, prefill.text].filter(Boolean).join(" ") : "";
    const body = ctx.openDialog(t("inbox.import.title"),
      '<form class="inbox-dialog" data-inbox-import novalidate>' +
      (prefill ? '<p class="inbox-note" role="status">' + ts("inbox.import.shared") + "</p>" : "") +
      '<fieldset class="inbox-choices inbox-row"><legend>' + ts("inbox.import.kind") + "</legend>" +
      ["TEXT", "URL"].map((k) => '<label class="inbox-choice"><input type="radio" name="kind" value="' + k + '"' + (k === startKind ? " checked" : "") + "><span>" + ts("inbox.import.kind" + k) + "</span></label>").join("") + "</fieldset>" +
      '<label class="field" data-inbox-for="URL"><span>' + ts("inbox.import.url") + '</span><input type="url" name="url" inputmode="url" autocomplete="off" maxlength="2048" spellcheck="false" dir="ltr"></label>' +
      '<label class="field"><span data-inbox-textlabel></span><textarea name="text" rows="4" maxlength="2000" dir="auto"></textarea></label>' +
      '<p class="fine-print">' + ts("inbox.import.textHint", { n: INBOX_TEXT_LIMITS.summary }) + "</p>" +
      '<label class="field"><span>' + ts("inbox.import.purpose") + '</span><select name="purpose"><option value="REFERENCE">' + ts("inbox.import.purpose.REFERENCE") + '</option><option value="FOLLOW_UP">' + ts("inbox.import.purpose.FOLLOW_UP") + "</option></select></label>" +
      '<fieldset class="inbox-choices"><legend>' + ts("inbox.import.storage") + '</legend><label class="inbox-choice"><input type="radio" name="storage" value="WORKSPACE" checked><span>' + ts("inbox.import.storageWorkspace", { name: ws }) + "</span></label></fieldset>" +
      '<section class="inbox-preview" aria-live="polite"><h3>' + ts("inbox.import.preview") + "</h3><div data-inbox-preview></div></section>" +
      '<p class="inbox-error" role="alert" data-inbox-error hidden></p>' +
      '<div class="inbox-dialog-actions"><button type="button" class="button secondary" data-inbox-trim hidden>' + ts("inbox.import.trim", { n: INBOX_TEXT_LIMITS.summary }) + '</button><button type="submit" class="button primary" data-inbox-save>' + ts("inbox.import.save") + "</button></div></form>");
    const form = body.querySelector("form");
    const f = form.elements;
    f.text.value = text0;
    f.url.value = prefill?.url ?? "";
    const preview = form.querySelector("[data-inbox-preview]");
    const trim = form.querySelector("[data-inbox-trim]");
    const save = form.querySelector("[data-inbox-save]");
    /** Đúng thứ máy chủ sẽ lưu, theo cùng quy tắc (web/shared/inbox-text.js). */
    const compute = () => {
      const kind = f.kind.value;
      const tr = f.text.value.trim() ? userText(f.text.value) : null;
      const rawUrl = f.url.value.trim();
      const link = rawUrl ? checkedLink(rawUrl) : null;
      if (kind === "TEXT" && !tr) return { error: "inbox.import.previewEmpty" };
      if (tr && !tr.ok) return { error: tr.reason === "EMPTY" ? "inbox.import.previewEmpty" : "inbox.import.error." + tr.reason, long: tr.reason === "TOO_LONG" };
      if ((kind === "URL" || rawUrl) && !link) return { error: rawUrl ? "inbox.import.error.LINK" : "inbox.import.previewEmpty" };
      const text = tr && tr.ok ? tr.text : null;
      return { ok: true, kind, text, link, summary: text ?? linkSummary(link) };
    };
    const refresh = () => {
      const kind = f.kind.value;
      form.querySelector('[data-inbox-for="URL"]').hidden = kind !== "URL" && !f.url.value;
      form.querySelector("[data-inbox-textlabel]").textContent = t(kind === "URL" ? "inbox.import.note" : "inbox.import.text");
      const c = compute();
      trim.hidden = !c.long;
      save.disabled = !c.ok;
      preview.innerHTML = c.ok
        ? '<p class="inbox-summary" dir="auto" data-inbox-preview-text>' + ctx.safe(c.summary) + "</p>" + (c.link ? '<p class="fine-print inbox-preview-link" dir="ltr">' + ctx.icon("link") + "<span>" + ctx.safe(c.link) + "</span></p>" : "")
        : '<p class="empty-state">' + ts(c.error) + "</p>";
      return c;
    };
    form.addEventListener("input", refresh);
    form.addEventListener("change", refresh);
    trim.addEventListener("click", () => {
      f.text.value = [...f.text.value.replace(/\s+/gu, " ").trim()].slice(0, INBOX_TEXT_LIMITS.summary).join("");
      refresh();
      f.text.focus();
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const c = refresh();
      if (!c.ok) return;
      save.disabled = true;
      const box = form.querySelector("[data-inbox-error]");
      box.hidden = true;
      const req = { kind: c.kind, purpose: f.purpose.value, storage: "WORKSPACE" };
      if (c.text) req.text = c.text;
      if (c.link) req.url = c.link;
      try {
        const r = await ctx.api.post("/v2/inbox/imports", req);
        ctx.closeDialog();
        ctx.toast(t(r.result === "DUPLICATE" ? "inbox.import.duplicate" : "inbox.import.stored"));
        if (r.item.state === "NEW" && S.filter !== "NEW") {
          S.filter = "NEW";
          S.loaded = false;
        }
        void load();
      } catch (e) {
        if (!form.isConnected) return;
        box.textContent = errorText(e);
        box.hidden = false;
        save.disabled = false;
      }
    });
    refresh();
    (prefill ? save : f.text).focus();
  }

  // ── Nguồn ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  function sourceError(key) {
    const box = el.sources.querySelector("[data-inbox-error]");
    if (!box) return ctx.toast(t(key));
    box.textContent = t(key);
    box.hidden = false;
  }

  async function connect() {
    try {
      // Nối nguồn đọc thư cần đăng nhập mới (SRS V2.0 mục 03): bản chạy thử tự lấy token mới.
      if (ctx.api.dev && ctx.me?.user?.id) await ctx.api.login(ctx.me.user.id);
      await ctx.api.post("/v2/inbox/sources/outlook/connect");
      ctx.toast(t("inbox.sources.connected"));
    } catch {
      sourceError("inbox.sources.failed");
      return;
    }
    await load();
  }

  async function consentAndConnect(form) {
    if (!form.reportValidity()) return;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      // Biên nhận ghi đúng văn bản người dùng vừa thấy (LNH-T25).
      const receipt = await ctx.consentReceipt("inbox_mail", "inbox.");
      await ctx.api.post("/v1/consents", { purpose_id: "inbox_mail", text_version: receipt.text_version, text_hash: receipt.text_hash, choice: "GRANTED" });
    } catch {
      sourceError("inbox.consent.failed");
      button.disabled = false;
      return;
    }
    await connect();
    await ctx.refresh();
  }

  async function disconnect(button) {
    button.disabled = true;
    try {
      await ctx.api.post("/v2/inbox/sources/outlook/disconnect");
      ctx.toast(t("inbox.sources.disconnected"));
    } catch {
      sourceError("inbox.sources.failed");
    }
    await load();
  }

  // ── Sự kiện ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  host.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const f = target.closest("[data-inbox-filter]");
    if (f) {
      if (S.filter !== f.dataset.inboxFilter) {
        S.filter = f.dataset.inboxFilter;
        S.items = [];
        S.next = null;
        S.loaded = false;
        S.wanted = PAGE;
        paint();
        void load();
      }
      return;
    }
    if (target.closest("[data-inbox-add]")) return importDialog(null);
    if (target.closest("[data-inbox-more]")) return void more();
    if (target.closest("[data-inbox-connect]")) return void connect();
    const d = target.closest("[data-inbox-disconnect]");
    if (d) return void disconnect(d);
    const b = target.closest("[data-inbox-op]");
    if (!b || b.disabled) return;
    const ref = b.dataset.inboxRef;
    const name = b.dataset.inboxOp;
    if (name === "snooze") snoozeDialog(ref);
    else if (name === "task") void draft(ref, "personal_task");
    else if (name === "reply") void draft(ref, "inbox_reply");
    else void op(ref, name);
  }, { signal: first.signal });
  host.addEventListener("submit", (ev) => {
    const form = ev.target instanceof HTMLFormElement && ev.target.matches("[data-inbox-consent]") ? ev.target : null;
    if (!form) return;
    ev.preventDefault();
    void consentAndConnect(form);
  }, { signal: first.signal });

  const api = {
    paint,
    setCtx(next) {
      ctx = next;
    },
    openShare(share) {
      importDialog(share);
    },
    destroy() {
      S.alive = false;
    },
  };
  paint();
  first.every(POLL_MS, load, { immediate: true });
  return api;
}

export default {
  id: "inbox",
  order: 55,
  // bar=false: thanh dưới của điện thoại đã đủ năm mục; Hộp tổng hợp có ở thanh bên và trong hộp Tài khoản.
  nav: { label: (ctx) => ctx.t("nav.inbox"), hint: (ctx) => ctx.t("nav.inboxHint"), icon: "inbox", bar: false },
  wide: true,
  // Cờ `inbox` tắt khi chưa đặt rõ (LNH-T61).
  visible: (ctx) => ctx.modules.inbox === true,

  /** Chia sẻ vào từ hệ điều hành: đọc tham số một lần, chuyển sang Hộp tổng hợp và mở bước xem trước. */
  background(ctx) {
    const share = takeShare();
    if (!share) return;
    if (view) view.openShare(share);
    else {
      pendingShare = share;
      ctx.navigate("inbox");
    }
  },

  mount(ctx, host) {
    view = createView(ctx, host);
    if (pendingShare) {
      const share = pendingShare;
      pendingShare = null;
      view.openShare(share);
    }
  },

  update(ctx) {
    view?.setCtx(ctx);
    view?.paint();
  },

  unmount() {
    view?.destroy();
    view = null;
  },
};
