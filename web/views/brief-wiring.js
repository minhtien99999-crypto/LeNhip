// Nối các dòng của mô-đun khác vào Bản tóm tắt buổi sáng (LNH-T62). Mỗi mô-đun giữ dòng của mình trong tệp riêng; tệp này chỉ đăng
// ký chúng với sổ web/shared/brief-sources.js. Nạp một lần từ web/views/brief.js.
import { registerBriefSource } from "../shared/brief-sources.js";
import { inboxBrief } from "./inbox-brief.js";
import homehubBrief from "./homehub-brief.js";

registerBriefSource(inboxBrief);

// Dòng Le‑NodeHome trả kết quả bất đồng bộ (line(ctx) -> Promise). Sổ vẽ đồng bộ, nên giữ kết quả lần gần nhất theo tài khoản và
// nạp lại khi cũ hơn 60 giây; nạp xong thì vẽ lại. Mất mạng hay lỗi thì không có dòng (không đoán).
const homeCache = { user: null, at: 0, value: null, pending: false };
registerBriefSource({
  id: homehubBrief.id,
  order: 60 + homehubBrief.order,
  // Chỉ hỏi máy chủ khi người dùng đã đồng ý mục đích home_hub: chưa đồng ý thì không có gì để nói và không gọi API (tránh 403).
  visible: (ctx) =>
    homehubBrief.visible(ctx) && ctx.state?.online !== false &&
    !!ctx.me?.consents?.some((c) => c.purpose_id === "home_hub" && c.choice === "GRANTED" && !c.withdrawn_at),
  render(ctx) {
    const user = ctx.me?.user?.id ?? null;
    if (homeCache.user !== user) Object.assign(homeCache, { user, at: 0, value: null });
    if (!homeCache.pending && Date.now() - homeCache.at > 60_000) {
      homeCache.pending = true;
      Promise.resolve(homehubBrief.line(ctx))
        .then((v) => Object.assign(homeCache, { value: v ?? null, at: Date.now() }))
        .catch(() => Object.assign(homeCache, { value: null, at: Date.now() }))
        .finally(() => {
          homeCache.pending = false;
          if (homeCache.user === user) ctx.rerender();
        });
    }
    const v = homeCache.value;
    if (!v) return "";
    const tone = v.tone === "warn" ? "brief-warn" : v.tone === "ok" ? "brief-ok" : "brief-muted";
    return '<span class="brief-icon">' + ctx.icon("home") + '</span><div class="brief-copy ' + tone + '">' + ctx.safe(v.text) + '</div><button type="button" class="text-button brief-go" data-nav="' + ctx.safe(v.nav) + '">' + ctx.tSafe("brief.source.open") + "</button>";
  },
});
