// Màn hình Tin nhắn (LNH-T30..LNH-T36): nhắn tin 1:1 giữa hai thành viên cùng workspace, mã hóa đầu cuối LNH-MSG-1.
//
// Màn hình có trạng thái (hợp đồng ở web/views/index.js): DOM dựng một lần trong mount(); các lần render nền chỉ gọi paint(),
// thay từng vùng khi HTML của vùng đó đổi và KHÔNG BAO GIỜ đụng tới ô soạn, nên chữ đang gõ, con trỏ và focus còn nguyên.
// Mọi việc với máy chủ, khóa và hộp gửi nằm ở web/shared/msg-client.js; tệp này chỉ vẽ và nhận thao tác.
//
//   - Lần mở đầu: bước đồng ý cho mục đích `messaging` (một ô, mặc định trống; thông báo đầu tiên của ứng dụng vẫn bốn ô), rồi
//     bước đăng ký thiết bị với loại máy do người dùng chọn.
//   - Chữ của tin chỉ vào trang bằng textContent, dir="auto"; liên kết trong tin không bấm được. LeLe không có lối vào ô soạn,
//     không có nút chia sẻ sức khỏe, không tạo kế hoạch từ tin nhắn (LNH-T36).
//   - Trạng thái dưới mỗi tin theo bằng chứng: «Đang gửi» → «Máy chủ đã nhận» → «Đã tới thiết bị»; «Đã xem» chỉ khi người đọc
//     bật chia sẻ. Mất phản hồi thì «Chưa rõ đã gửi hay chưa» kèm «Thử lại» (đúng các byte cũ); không gì tự gửi lại.
//   - Thông báo chỉ là huy hiệu trên mục điều hướng và câu «Bạn có tin nhắn mới», không tên, không nội dung (LNH-T35).
//   - Tới 980 px (và khi cỡ chữ từ 150 %): danh sách → hội thoại, có nút quay lại. Từ 981 px: hai cột cạnh nhau.
//
// Người dùng và «thiết bị» ở bản chạy thử là các tài khoản thử và các trình duyệt trên cùng một máy; mật mã và máy chủ là thật.
import { MSG_LIMITS } from "../shared/msg-crypto.js";
import { MSG_KINDS, dropMsgClient, getMsgClient, messagingConsented } from "../shared/msg-client.js";

const KIND_ICON = { PHONE: "phone", TABLET: "tablet", LAPTOP: "laptop", DESKTOP: "desktop", OTHER: "key" };
const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
const STATE_RANK = { THREAD_REQUESTED: 0, THREAD_ACTIVE: 1, THREAD_CLOSED: 2, THREAD_BLOCKED: 3 };

/** Phiên bản văn bản đồng ý đang hiển thị: bản dịch mang hậu tố ngôn ngữ (LNH-T25). */
// Phiên bản và mã băm của văn bản đồng ý lấy từ shared/consent-text.js qua ctx (LNH-T25): khớp sổ ghim contracts/consent-texts.json.
const consentVersion = (ctx) => ctx.consentText("messaging", "msg.").text_version;
const codePoints = (s) => {
  let n = 0;
  for (const _ of s) n++;
  return n;
};
const wide = () => window.matchMedia("(min-width: 981px)").matches && !document.body.classList.contains("large-text");

/** Ô chọn loại máy ở bước đăng ký thiết bị. Không ô nào được chọn sẵn: loại máy do người dùng chọn (LNH-T30). */
function kindPicker(ctx) {
  return '<fieldset class="msg-kinds"><legend>' + ctx.tSafe("msg.device.kindLegend") + "</legend>" +
    MSG_KINDS.map((k) => '<label class="msg-kind"><input type="radio" name="kind" value="' + k + '" required>' + ctx.icon(KIND_ICON[k]) + "<span>" + ctx.tSafe("msg.device.kind." + k) + "</span></label>").join("") + "</fieldset>";
}

function createView(ctx, host) {
  const client = getMsgClient(ctx);
  const t = ctx.t;
  const ts = ctx.tSafe;
  const S = { thread: null, pane: "list", sending: false, decrypting: false, draftTimer: 0, draftFor: null, refreshedAt: 0, focusWas: null, dead: false };
  /** Vùng → HTML đang hiện, để chỉ thay DOM khi nội dung đổi. */
  const shown = new Map();
  /** Bong bóng đang có trong khung tin: khóa tin → phần tử. */
  const nodes = new Map();

  host.innerHTML =
    '<div class="msg-root" data-msg-pane="list">' +
    '<div class="heading-row msg-heading"><h1>' + ts("nav.messages") + '</h1><span class="tiny-pill">' + ts("msg.e2ee.pill") + "</span></div>" +
    '<div class="msg-gate" data-msg="gate"></div>' +
    '<div class="msg-panes" data-msg="panes" hidden>' +
    '<section class="card msg-list" data-msg="list" aria-label="' + ts("msg.list.title") + '"></section>' +
    '<section class="card msg-thread" data-msg="thread">' +
    '<p class="empty-state msg-pick" data-msg="pick">' + ts("msg.thread.pick") + "</p>" +
    '<div class="msg-body" data-msg="body" hidden>' +
    '<header class="msg-head" data-msg="head"></header>' +
    '<div class="msg-notices" data-msg="notice"></div>' +
    '<p class="empty-state msg-log-empty" data-msg="logEmpty" hidden>' + ts("msg.thread.empty") + "</p>" +
    '<div class="msg-log" data-msg="log" role="log" aria-live="polite" tabindex="0"></div>' +
    '<div class="msg-state" data-msg="state"></div>' +
    '<form class="msg-composer" data-msg="form" hidden novalidate>' +
    '<label class="msg-sr" for="msg-input" data-msg="inputLabel"></label>' +
    '<div class="msg-composer-row"><textarea id="msg-input" rows="2" maxlength="4000" autocomplete="off" enterkeyhint="send" aria-describedby="msg-hint" placeholder="' + ts("msg.composer.placeholder") + '"></textarea>' +
    '<button class="button primary msg-send" type="submit" data-msg="send">' + ctx.icon("send") + "<span>" + ts("msg.composer.send") + "</span></button></div>" +
    '<p class="fine-print msg-hint" id="msg-hint"><span>' + ts("msg.composer.hint") + '</span> <span data-msg="count"></span></p>' +
    '<p class="msg-error" role="alert" data-msg="composerError" hidden></p>' +
    "</form></div></section></div></div>";
  const el = {};
  for (const node of host.querySelectorAll("[data-msg]")) el[node.dataset.msg] = node;
  el.root = host.firstElementChild;
  el.input = host.querySelector("#msg-input");

  /** Thay HTML của một vùng khi nó đổi; giữ focus đang nằm trong vùng theo data-focus. */
  function swap(name, html) {
    if (shown.get(name) === html) return false;
    const node = el[name];
    const active = node.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    shown.set(name, html);
    node.innerHTML = html;
    if (active) node.querySelector('[data-focus="' + CSS.escape(active) + '"]')?.focus();
    return true;
  }

  function phase() {
    if (!client || !client.ready) return "loading";
    if (client.failed || !client.persistent) return "unsupported";
    if (!messagingConsented(ctx.me)) return "consent";
    if (client.gate === "MODULE_DISABLED") return "disabled";
    if (client.gate === "FORBIDDEN") return "forbidden";
    if (client.gate === "NOT_FOUND") return "gone";
    if (!client.registered) return "device";
    return "ready";
  }

  // ── Các bước trước khi nhắn tin ─────────────────────────────────────────────────────────────────────────────────────────────

  function gateHtml(p) {
    const card = (inner) => '<section class="card view-card msg-step">' + inner + "</section>";
    if (p === "loading") return card('<p class="empty-state">' + ts("msg.loading") + "</p>");
    if (p === "unsupported") return card('<p class="empty-state">' + ts("msg.unsupported") + "</p>");
    if (p === "disabled" || p === "forbidden" || p === "gone") return card('<p class="empty-state">' + ts("msg.gate." + p) + "</p>");
    if (p === "consent") {
      return card("<h2>" + ts("msg.consent.messaging.title") + '</h2><p class="msg-consent-text">' + ts("msg.consent.messaging.body") + "</p>" +
        '<form data-msg-form="consent"><label class="consent-row"><input type="checkbox" name="agree" required data-focus="agree"><span><strong>' + ts("msg.consent.messaging.check") + "</strong></span></label>" +
        '<p class="fine-print">' + ts("msg.consent.version", { version: consentVersion(ctx) }) + '</p><p class="msg-error" role="alert" data-msg-error hidden></p>' +
        '<button class="button primary" type="submit" data-focus="accept">' + ts("msg.consent.messaging.accept") + "</button></form>");
    }
    if (p === "device") {
      return card((client.revoked ? '<p class="msg-note warn" role="status">' + ts("msg.device.revokedNote") + "</p>" : "") +
        "<h2>" + ts("msg.device.title") + "</h2><p>" + ts("msg.device.body") + '</p><form data-msg-form="device">' + kindPicker(ctx) +
        '<p class="privacy-note">' + ctx.icon("shield") + "<span>" + ts("msg.device.newNote") + '</span></p><p class="msg-error" role="alert" data-msg-error hidden></p>' +
        '<button class="button primary" type="submit" data-focus="register">' + ts("msg.device.register") + "</button></form>");
    }
    return "";
  }

  function gateError(form, key) {
    const box = form.querySelector("[data-msg-error]");
    box.textContent = key ? t(key) : "";
    box.hidden = !key;
  }

  async function submitConsent(form) {
    if (!form.reportValidity()) return;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    gateError(form, null);
    try {
      // Biên nhận ghi đúng văn bản người dùng vừa thấy: phiên bản theo ngôn ngữ và mã băm của thân văn bản đang hiển thị.
      const receipt = await ctx.consentReceipt("messaging", "msg.");
      await ctx.api.post("/v1/consents", { purpose_id: "messaging", text_version: receipt.text_version, text_hash: receipt.text_hash, choice: "GRANTED" });
      await ctx.refresh();
    } catch {
      if (form.isConnected) {
        gateError(form, "msg.consent.failed");
        button.disabled = false;
      }
    }
  }

  async function submitDevice(form) {
    const kind = new FormData(form).get("kind");
    if (!kind) return gateError(form, "msg.device.chooseKind");
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = t("msg.device.registering");
    gateError(form, null);
    try {
      await client.registerDevice(String(kind));
      void client.loadPeople().catch(() => {});
    } catch (e) {
      if (!form.isConnected) return;
      const code = e?.code;
      gateError(form, ["REAUTH_REQUIRED", "ENDPOINT_LIMIT", "STORAGE", "OFFLINE"].includes(code) ? "msg.device.error." + code : "msg.device.error.other");
      button.disabled = false;
      button.textContent = t("msg.device.register");
    }
  }

  // ── Danh sách ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  const stateLabel = (th) => (th.state === "THREAD_REQUESTED" ? ts("msg.state.THREAD_REQUESTED." + th.role) : ts("msg.state." + th.state));

  function listHtml() {
    const threads = [...client.threads].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || a.peer.name.localeCompare(b.peer.name, ctx.locale()) || (a.thread_id < b.thread_id ? -1 : 1));
    const known = new Set(threads.map((x) => x.peer.user_id));
    const people = (client.people ?? []).filter((p) => !known.has(p.user_id));
    const item = (th) => {
      const n = client.unreadOf(th.thread_id);
      const waiting = th.state === "THREAD_REQUESTED" && th.role === "ADDRESSEE";
      return '<li><button type="button" class="msg-item" data-msg-open="' + ctx.safe(th.thread_id) + '" data-focus="open:' + ctx.safe(th.thread_id) + '"' + (th.thread_id === S.thread ? ' aria-current="true"' : "") + ">" +
        '<span class="msg-avatar" aria-hidden="true">' + ctx.safe([...th.peer.name.trim()].pop() ?? "·") + "</span>" +
        '<span class="msg-item-copy"><strong dir="auto">' + ctx.safe(th.peer.name) + "</strong><small>" + stateLabel(th) + "</small></span>" +
        (n > 0 ? '<span class="msg-unread" role="img" aria-label="' + ts("msg.list.unread", { n }) + '">' + ctx.safe(n > 99 ? "99+" : ctx.formatNumber(n)) + "</span>" : waiting ? '<span class="msg-unread dot" aria-hidden="true"></span>' : "") +
        "</button></li>";
    };
    return '<h2 class="msg-h">' + ts("msg.list.title") + "</h2>" +
      (threads.length ? '<ul class="msg-items">' + threads.map(item).join("") + "</ul>" : '<p class="empty-state">' + ts("msg.list.empty") + "</p>") +
      '<h2 class="msg-h">' + ts("msg.list.people") + '</h2><p class="fine-print">' + ts("msg.list.peopleNote") + "</p>" +
      (people.length
        ? '<ul class="msg-people">' + people.map((p) => '<li><span class="msg-person" dir="auto">' + ctx.safe(p.name) + '</span><button type="button" class="button secondary msg-invite" data-msg-invite="' + ctx.safe(p.user_id) + '" data-focus="invite:' + ctx.safe(p.user_id) + '" aria-label="' + ts("msg.list.inviteTo", { name: p.name }) + '">' + ts("msg.list.invite") + "</button></li>").join("") + "</ul>"
        : '<p class="empty-state">' + ts("msg.list.peopleEmpty") + "</p>") +
      '<label class="msg-share"><input type="checkbox" data-msg-share data-focus="share"' + (client.settings.share_read ? " checked" : "") + "><span><strong>" + ts("msg.share.label") + "</strong><small>" + ts("msg.share.note") + "</small></span></label>";
  }

  // ── Hội thoại ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  function headHtml(th) {
    const chip = th.state === "THREAD_ACTIVE" ? "ok" : th.state === "THREAD_REQUESTED" ? "busy" : "muted";
    const items = [];
    const button = (attr, key) => '<button type="button" class="button secondary" ' + attr + ">" + ts(key) + "</button>";
    if (th.state === "THREAD_ACTIVE" && th.key_set) items.push(button('data-msg-safety data-focus="safety"', "msg.thread.safety"));
    if (th.state === "THREAD_BLOCKED") items.push(button('data-msg-op="unblock"', "msg.thread.unblock"));
    else if (th.state !== "THREAD_REQUESTED" || th.role === "ADDRESSEE") items.push(button("data-msg-block", "msg.thread.block"));
    items.push(button("data-msg-report", "msg.thread.report"));
    return '<button type="button" class="button secondary msg-back" data-msg-back data-focus="back" aria-label="' + ts("msg.thread.back") + '">' + BACK_ICON + "</button>" +
      '<div class="msg-head-copy"><h2 class="msg-title" tabindex="-1" data-focus="title" dir="auto">' + ctx.safe(th.peer.name) + '</h2><span class="status-chip ' + chip + '">' + stateLabel(th) + "</span></div>" +
      '<details class="msg-menu"><summary class="button secondary" data-focus="menu" aria-label="' + ts("msg.thread.menuLabel", { name: th.peer.name }) + '">' + ts("msg.thread.menu") + '</summary><div class="msg-menu-items">' + items.join("") + "</div></details>";
  }

  function noticeHtml(th) {
    const out = [];
    if (!client.online) out.push('<p class="msg-note warn" role="status">' + ts("msg.offline") + "</p>");
    const fault = client.keyFault.get(th.thread_id);
    if (fault) {
      out.push('<div class="msg-note warn" role="alert"><p>' + ts("msg.thread.keyFault." + (fault === "KEY_CONFLICT" ? "KEY_CONFLICT" : "KEY_SET_MISMATCH")) + '</p><div class="msg-actions"><button type="button" class="button secondary" data-msg-recheck data-focus="recheck">' + ts("msg.thread.recheck") + "</button></div></div>");
    } else if (th.state === "THREAD_ACTIVE" && client.note(th.thread_id)?.devices_changed) {
      out.push('<div class="msg-note" role="status" data-msg-devices-changed><p><strong>' + ts("msg.thread.devicesChanged") + "</strong> " + ts("msg.thread.devicesChangedNote", { name: th.peer.name }) + "</p>" +
        '<div class="msg-actions"><button type="button" class="button secondary" data-msg-safety data-focus="safety2">' + ts("msg.thread.safety") + '</button><button type="button" class="button secondary" data-msg-dismiss data-focus="dismiss">' + ts("msg.thread.dismiss") + "</button></div></div>");
    }
    return out.join("");
  }

  function stateHtml(th) {
    const name = { name: th.peer.name };
    const op = (o, key, cls = "secondary") => '<button type="button" class="button ' + cls + '" data-msg-op="' + o + '" data-focus="op:' + o + '">' + ts(key) + "</button>";
    if (th.state === "THREAD_REQUESTED" && th.role === "ADDRESSEE") {
      return '<p><strong dir="auto">' + ts("msg.thread.invite.incoming", name) + '</strong></p><p class="fine-print">' + ts("msg.thread.invite.incomingNote") + '</p><div class="msg-actions">' +
        op("accept", "msg.thread.accept", "primary") + op("decline", "msg.thread.decline") + '<button type="button" class="button secondary" data-msg-block data-focus="block2">' + ts("msg.thread.block") + "</button></div>";
    }
    if (th.state === "THREAD_REQUESTED") return '<p dir="auto">' + ts("msg.thread.invite.outgoing", name) + '</p><div class="msg-actions">' + op("withdraw", "msg.thread.withdraw") + "</div>";
    if (th.state === "THREAD_BLOCKED") return '<p dir="auto">' + ts("msg.thread.blocked", name) + '</p><div class="msg-actions">' + op("unblock", "msg.thread.unblock") + "</div>";
    if (th.state === "THREAD_CLOSED") {
      return '<p dir="auto">' + ts("msg.thread.closed", name) + "</p>" + (th.can_request ? '<div class="msg-actions"><button type="button" class="button primary" data-msg-reinvite data-focus="reinvite">' + ts("msg.thread.reinvite") + "</button></div>" : "");
    }
    if (!th.key_set) return '<p dir="auto">' + ts("msg.thread.unavailable", name) + "</p>";
    return "";
  }

  const dayOf = (value) => ctx.formatDate(value, { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ctx.zone() });

  function fillBubble(node, b) {
    const sig = JSON.stringify([b.text, b.problem, b.status, b.refusal, b.can_retry, b.can_discard, b.sent_at]);
    if (node.dataset.sig === sig) return;
    node.dataset.sig = sig;
    node.dataset.status = b.status;
    const [who, text, meta] = node.children;
    who.textContent = b.mine ? t("msg.bubble.you") : "";
    // Chữ của tin chỉ vào trang ở đây, bằng textContent: không HTML, không liên kết bấm được.
    text.textContent = b.text ?? (b.problem === "UNKNOWN_SENDER" ? t("msg.bubble.unknownSender") : b.problem ? t("msg.bubble.locked") : t("msg.bubble.opening"));
    text.classList.toggle("muted", b.text === null);
    meta.textContent = "";
    const add = (tag, cls, content) => {
      const x = document.createElement(tag);
      if (cls) x.className = cls;
      x.textContent = content;
      meta.append(x);
      return x;
    };
    if (b.sent_at) {
      const time = add("time", "msg-time", (dayOf(b.sent_at) === dayOf(ctx.now()) ? "" : ctx.formatDate(b.sent_at, { day: "2-digit", month: "2-digit", timeZone: ctx.zone() }) + " ") + ctx.formatTime24(b.sent_at, ctx.zone()));
      time.dateTime = b.sent_at;
    }
    if (!b.mine) return;
    add("span", "msg-status", t("msg.status." + b.status)).dataset.msgStatus = b.status;
    if (b.status === "REJECTED") add("span", "msg-status-note", t(["RECIPIENT_UNAVAILABLE", "RATE_LIMITED", "KEYS_CHANGED"].includes(b.refusal) ? "msg.refusal." + b.refusal : "msg.refusal.other"));
    if (b.status === "UNCERTAIN") add("span", "msg-status-note", t(b.can_retry || !b.can_discard ? "msg.status.uncertainNote" : "msg.status.tooOld"));
    if (b.can_retry) {
      const retry = add("button", "text-button", t("msg.bubble.retry"));
      retry.type = "button";
      retry.dataset.msgRetry = b.client_ref;
    }
    if (b.can_discard) {
      const discard = add("button", "text-button", t("msg.bubble.discard"));
      discard.type = "button";
      discard.dataset.msgDiscard = b.client_ref;
    }
  }

  function paintLog(threadId) {
    const log = el.log;
    const fresh = log.dataset.thread !== threadId;
    if (fresh) {
      log.textContent = "";
      nodes.clear();
      log.dataset.thread = threadId;
    }
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 96;
    const bubbles = client.timeline(threadId);
    const keep = new Set();
    let prev = null;
    let added = false;
    let locked = false;
    for (const b of bubbles) {
      keep.add(b.key);
      let node = nodes.get(b.key);
      if (!node) {
        node = document.createElement("div");
        node.className = "msg-bubble " + (b.mine ? "mine" : "theirs");
        node.innerHTML = '<span class="msg-sr"></span><p class="msg-text" dir="auto"></p><div class="msg-meta"></div>';
        nodes.set(b.key, node);
        added = true;
      }
      fillBubble(node, b);
      if (b.text === null && !b.problem) locked = true;
      const want = prev ? prev.nextSibling : log.firstChild;
      if (node !== want) log.insertBefore(node, want);
      prev = node;
    }
    for (const [key, node] of nodes) {
      if (keep.has(key)) continue;
      node.remove();
      nodes.delete(key);
    }
    // Câu «chưa có tin nào» chỉ hiện ở hội thoại đang mở; lời mời và hội thoại đã đóng có dòng trạng thái riêng.
    el.logEmpty.hidden = bubbles.length > 0 || client.thread(threadId)?.state !== "THREAD_ACTIVE";
    log.hidden = bubbles.length === 0;
    if (added && (fresh || nearBottom)) log.scrollTop = log.scrollHeight;
    // Mở các phong bì chưa mở (bản rõ chỉ ở trong bộ nhớ của trang), rồi vẽ lại.
    if (locked && !S.decrypting) {
      S.decrypting = true;
      client.decrypt(threadId).catch(() => false).then((changed) => {
        S.decrypting = false;
        if (changed && !S.dead) paint();
      });
    }
  }

  function updateCount() {
    const n = codePoints(el.input.value);
    el.count.textContent = n > MSG_LIMITS.textCodePoints - 200 ? t("msg.composer.count", { count: n, max: MSG_LIMITS.textCodePoints }) : "";
    el.count.classList.toggle("over", n > MSG_LIMITS.textCodePoints);
  }

  function composerError(code) {
    el.composerError.textContent = code ? t(["TEXT_TOO_LONG", "TEXT_MALFORMED", "NOT_ACTIVE", "OFFLINE", "RECIPIENT_UNAVAILABLE"].includes(code) ? "msg.composer.error." + code : "msg.composer.error.other") : "";
    el.composerError.hidden = !code;
  }

  function saveDraftNow() {
    clearTimeout(S.draftTimer);
    if (S.draftFor) void client.setDraft(S.draftFor, el.input.value);
  }

  function paintThread() {
    let th = S.thread ? client.thread(S.thread) : null;
    if (S.thread && !th) {
      // Hội thoại không còn (người kia đã xóa dữ liệu): quay về danh sách.
      S.thread = null;
      S.draftFor = null;
      S.pane = "list";
      th = null;
    }
    el.pick.hidden = !!th;
    el.body.hidden = !th;
    if (!th) return;
    swap("head", headHtml(th));
    swap("notice", noticeHtml(th));
    swap("state", stateHtml(th));
    el.log.setAttribute("aria-label", t("msg.thread.log", { name: th.peer.name }));
    paintLog(th.thread_id);
    el.form.hidden = !(th.state === "THREAD_ACTIVE" && !!th.key_set && !client.keyFault.has(th.thread_id));
    el.inputLabel.textContent = t("msg.composer.label", { name: th.peer.name });
  }

  function paint() {
    if (S.dead) return;
    const p = phase();
    // Máy chủ nói chưa đồng ý trong khi /v1/me đang giữ nói đã đồng ý (rút ở thiết bị khác): nạp lại /v1/me, nhiều nhất 30 giây một lần.
    if (client?.gate === "CONSENT_REQUIRED" && p !== "consent" && Date.now() - S.refreshedAt > 30_000) {
      S.refreshedAt = Date.now();
      void ctx.refresh();
    }
    swap("gate", gateHtml(p));
    el.gate.hidden = p === "ready";
    el.panes.hidden = p !== "ready";
    if (p !== "ready") {
      if (client) client.focus = null;
      return;
    }
    paintThread();
    swap("list", listHtml());
    el.root.dataset.msgPane = S.thread ? S.pane : "list";
    // Hội thoại đang thật sự hiện trên màn hình: thăm dò 3 giây và đánh dấu đã đọc.
    const focus = S.thread && (S.pane === "thread" || wide()) ? S.thread : null;
    client.focus = focus;
    if (focus && focus !== S.focusWas) {
      client.poke();
      void client.markRead(focus);
    }
    S.focusWas = focus;
  }

  async function openThread(id) {
    if (S.thread !== id) {
      saveDraftNow();
      S.thread = id;
      S.draftFor = id;
      el.input.value = "";
      composerError(null);
      updateCount();
      void client.draft(id).then((text) => {
        if (!S.dead && S.thread === id && !el.input.value && text) {
          el.input.value = text;
          updateCount();
        }
      });
    }
    S.pane = "thread";
    paint();
    const th = client.thread(id);
    if (!el.form.hidden) el.input.focus();
    else host.querySelector(".msg-title")?.focus();
    if (th?.state === "THREAD_ACTIVE" && th.key_set && client.note(id)?.key_set !== th.key_set && !client.keyFault.has(id)) {
      await client.ensureKeys(id).catch(() => {});
      if (!S.dead) paint();
    }
  }

  function backToList() {
    const id = S.thread;
    S.pane = "list";
    paint();
    (host.querySelector('[data-msg-open="' + CSS.escape(id ?? "") + '"]') ?? host.querySelector(".msg-list button"))?.focus();
  }

  /** Một thao tác với máy chủ do người dùng bấm: lỗi thành một câu ngắn; không gì được coi là đã xảy ra khi chưa có phản hồi. */
  async function act(fn) {
    try {
      return await fn();
    } catch (e) {
      const code = e?.code;
      ctx.toast(t(["RATE_LIMITED", "INVALID_TRANSITION", "OFFLINE", "NOT_FOUND"].includes(code) ? "msg.error." + code : "msg.error.op"));
      client.poke();
      return null;
    } finally {
      if (!S.dead) paint();
    }
  }

  async function submitMessage() {
    const id = S.thread;
    const text = el.input.value;
    if (!id || S.sending || !text.trim()) return;
    if (codePoints(text) > MSG_LIMITS.textCodePoints) return composerError("TEXT_TOO_LONG");
    S.sending = true;
    el.send.disabled = true;
    try {
      // Niêm phong và xếp vào hộp gửi (đã lưu). Việc gửi chạy tiếp ở nền; trạng thái hiện dưới bong bóng theo bằng chứng.
      await client.send(id, text);
      composerError(null);
      if (S.thread === id) {
        el.input.value = "";
        updateCount();
      }
      void client.setDraft(id, "");
      paint();
      el.log.scrollTop = el.log.scrollHeight;
    } catch (e) {
      composerError(e?.code ?? "other");
    } finally {
      S.sending = false;
      el.send.disabled = false;
    }
  }

  // ── Hộp thoại: mã an toàn, báo cáo, chặn ────────────────────────────────────────────────────────────────────────────────────

  async function openSafety(id) {
    const th = client.thread(id);
    if (!th) return;
    let s;
    try {
      s = await client.safety(id);
    } catch {
      ctx.toast(t("msg.safety.failed"));
      return paint();
    }
    const body = ctx.openDialog(t("msg.safety.title"),
      '<p class="msg-safety-code" role="img" aria-label="' + ts("msg.safety.codeLabel") + ": " + ctx.safe(s.groups.join(" ")) + '">' + s.groups.map((g) => "<span>" + ctx.safe(g) + "</span>").join("") + "</p>" +
      "<p>" + ts("msg.safety.body") + '</p><p class="fine-print" dir="auto">' + ts("msg.safety.devices", { mine: s.mine, theirs: s.theirs, name: th.peer.name }) + " " + ts("msg.safety.changes") + "</p>" +
      '<p class="msg-safety-state" data-msg-verified>' + ts(s.verified ? "msg.safety.verified" : "msg.safety.unverified") + "</p>" +
      (s.verified ? "" : '<div class="button-row"><button type="button" class="button primary" data-msg-confirm>' + ts("msg.safety.confirm") + "</button></div>"));
    body.querySelector("[data-msg-confirm]")?.addEventListener("click", async (e) => {
      const row = e.currentTarget.closest(".button-row");
      await client.confirmSafety(id);
      row?.remove();
      const state = body.querySelector("[data-msg-verified]");
      if (state) state.textContent = t("msg.safety.verified");
      paint();
    });
    paint();
  }

  function openReport(id) {
    const th = client.thread(id);
    if (!th) return;
    const body = ctx.openDialog(t("msg.report.title", { name: th.peer.name }),
      "<p>" + ts("msg.report.body") + '</p><form data-msg-form="report"><fieldset class="msg-kinds"><legend>' + ts("msg.report.reason") + "</legend>" +
      ["SPAM", "HARASSMENT", "OTHER"].map((r) => '<label class="msg-kind"><input type="radio" name="reason" value="' + r + '" required><span>' + ts("msg.report." + r) + "</span></label>").join("") + "</fieldset>" +
      '<p class="fine-print">' + ts("msg.report.blockToo") + '</p><div class="button-row"><button class="button primary" type="submit">' + ts("msg.report.send") + '</button><button type="button" class="button secondary" data-msg-cancel>' + ts("msg.cancel") + "</button></div></form>");
    body.querySelector("[data-msg-cancel]").addEventListener("click", () => ctx.closeDialog());
    body.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const reason = new FormData(e.currentTarget).get("reason");
      if (!reason) return;
      try {
        // Chỉ có lý do và mã hội thoại: không chữ nào của tin đi kèm.
        await client.report(id, String(reason));
        ctx.closeDialog();
        ctx.toast(t("msg.report.sent"));
      } catch {
        ctx.toast(t("msg.report.failed"));
      }
    });
  }

  function openBlock(id) {
    const th = client.thread(id);
    if (!th) return;
    const body = ctx.openDialog(t("msg.block.title", { name: th.peer.name }),
      "<p>" + ts("msg.block.body") + '</p><div class="button-row"><button type="button" class="button primary" data-msg-confirm>' + ts("msg.block.confirm") + '</button><button type="button" class="button secondary" data-msg-cancel>' + ts("msg.cancel") + "</button></div>");
    body.querySelector("[data-msg-cancel]").addEventListener("click", () => ctx.closeDialog());
    body.querySelector("[data-msg-confirm]").addEventListener("click", async () => {
      ctx.closeDialog();
      await act(() => client.threadOp(id, "block"));
      void client.loadPeople().catch(() => {});
    });
  }

  // ── Sự kiện ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  const on = (type, fn) => host.addEventListener(type, fn, { signal: ctx.signal });
  /** Đóng bảng tùy chọn; `refocus` đưa focus về nút mở bảng, để hộp thoại mở tiếp theo trả focus về đó khi đóng. */
  const closeMenu = (refocus = true) => {
    const menu = host.querySelector(".msg-menu[open]");
    if (!menu) return;
    menu.removeAttribute("open");
    if (refocus) menu.querySelector("summary")?.focus();
  };
  on("click", (e) => {
    const hit = (sel) => e.target.closest?.(sel);
    let x;
    // Bấm ra ngoài bảng tùy chọn đang mở thì đóng nó.
    if (!hit(".msg-menu")) closeMenu(false);
    if ((x = hit("[data-msg-open]"))) return void openThread(x.dataset.msgOpen);
    if (hit("[data-msg-back]")) return backToList();
    if ((x = hit("[data-msg-invite]"))) {
      x.disabled = true;
      return void act(() => client.invite(x.dataset.msgInvite)).then((th) => {
        void client.loadPeople().catch(() => {});
        if (th && !S.dead) void openThread(th.thread_id);
      });
    }
    if (hit("[data-msg-reinvite]") && S.thread) {
      const peer = client.thread(S.thread)?.peer.user_id;
      return void (peer && act(() => client.invite(peer)));
    }
    if ((x = hit("[data-msg-op]")) && S.thread) {
      x.disabled = true;
      closeMenu();
      return void act(() => client.threadOp(S.thread, x.dataset.msgOp)).then(() => client.loadPeople().catch(() => {}));
    }
    if (hit("[data-msg-block]") && S.thread) return closeMenu(), openBlock(S.thread);
    if (hit("[data-msg-report]") && S.thread) return closeMenu(), openReport(S.thread);
    if (hit("[data-msg-safety]") && S.thread) return closeMenu(), void openSafety(S.thread);
    if (hit("[data-msg-dismiss]") && S.thread) return void client.dismissDevicesChanged(S.thread).then(() => !S.dead && paint());
    if (hit("[data-msg-recheck]") && S.thread) return void client.ensureKeys(S.thread).catch(() => {}).then(() => !S.dead && paint());
    if ((x = hit("[data-msg-retry]"))) {
      x.disabled = true;
      return void client.retry(x.dataset.msgRetry).then(() => !S.dead && paint());
    }
    if ((x = hit("[data-msg-discard]"))) return void client.discard(x.dataset.msgDiscard).then(() => !S.dead && paint());
  });
  on("change", (e) => {
    if (e.target.matches?.("[data-msg-share]")) void client.setShareRead(e.target.checked);
  });
  on("submit", (e) => {
    e.preventDefault();
    const kind = e.target.dataset.msgForm ?? e.target.dataset.msg;
    if (kind === "consent") void submitConsent(e.target);
    else if (kind === "device") void submitDevice(e.target);
    else if (kind === "form") void submitMessage();
  });
  on("keydown", (e) => {
    // Escape đóng bảng tùy chọn của hội thoại và trả focus về nút mở nó.
    if (e.key === "Escape") closeMenu();
  });
  el.input.addEventListener("keydown", (e) => {
    // Enter gửi, Shift+Enter xuống dòng. Đang ghép chữ bằng bộ gõ (IME) thì Enter thuộc về bộ gõ.
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submitMessage();
  }, { signal: ctx.signal });
  el.input.addEventListener("input", () => {
    updateCount();
    if (!el.composerError.hidden) composerError(null);
    clearTimeout(S.draftTimer);
    // Bản nháp được lưu ở dạng đã mã hóa trong kho của thiết bị, sau khi ngừng gõ nửa giây.
    S.draftTimer = setTimeout(saveDraftNow, 500);
  }, { signal: ctx.signal });
  window.matchMedia("(min-width: 981px)").addEventListener("change", () => paint(), { signal: ctx.signal });

  if (client) {
    void client.start().then(() => {
      if (S.dead) return;
      client.poke();
      paint();
      if (phase() === "ready") void client.loadPeople().catch(() => {});
    });
    // Danh sách người có thể nhắn tin: nạp lại mỗi nửa phút khi màn hình đang mở.
    ctx.every(30_000, () => (phase() === "ready" ? client.loadPeople().catch(() => {}) : undefined));
  }
  paint();

  return {
    paint,
    destroy() {
      saveDraftNow();
      S.dead = true;
      if (client) client.focus = null;
    },
  };
}

let view = null;

export default {
  id: "messages",
  order: 50,
  nav: {
    label: (ctx) => ctx.t("nav.messages"),
    icon: "messages",
    bar: true,
    // Huy hiệu: chỉ một con số (tin chưa đọc và lời mời đang chờ), không tên, không nội dung.
    badge(ctx) {
      const n = ctx.modules.messaging === true ? getMsgClient(ctx)?.unread() ?? 0 : 0;
      return n > 0 ? { text: n > 99 ? "99+" : ctx.formatNumber(n), label: ctx.t("msg.badge.label", { n }) } : null;
    },
  },
  // Danh sách và hội thoại cạnh nhau từ 981 px: dùng hết bề ngang, ẩn cột chọn phong cách.
  wide: true,
  // Cờ `messaging` tắt khi chưa đặt rõ (LNH-F27, LNH-T36).
  visible: (ctx) => ctx.modules.messaging === true,

  /**
   * Chạy cả khi người dùng ở màn hình khác: cấp nhịp cho máy khách (mỗi giây; máy khách tự quyết 3 giây, 15 giây hay đang lùi).
   * Khung tự dừng nhịp khi ẩn tab và khi đổi tài khoản; khi đó máy khách bị bỏ và bản rõ đã mở rời bộ nhớ.
   */
  background(ctx) {
    const sub = ctx.me?.user?.id;
    const client = getMsgClient(ctx);
    if (!client || !sub) return;
    ctx.every(1000, () => client.tick(), { immediate: true });
    ctx.onLeave(() => dropMsgClient(sub));
  },

  mount(ctx, host) {
    view = createView(ctx, host);
  },

  // Render nền: chỉ vẽ lại các vùng có nội dung đổi; ô soạn không bao giờ bị dựng lại.
  update() {
    view?.paint();
  },

  unmount() {
    view?.destroy();
    view = null;
  },
};
