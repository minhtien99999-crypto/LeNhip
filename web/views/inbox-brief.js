// Dòng của Hộp tổng hợp trong Bản tóm tắt buổi sáng (SRS V2.0 mục 03, 04; LNH-T62, LNH-T65). Track đồng bộ dựng
// web/shared/brief-sources.js với registerBriefSource({ id, order, visible(ctx), render(ctx) }); khi gộp, thêm một dòng:
//   registerBriefSource(inboxBrief);   (import { inboxBrief } from "../views/inbox-brief.js")
//
// Dòng chỉ có MỘT CON SỐ (số mục mới) và nút mở Hộp tổng hợp: không tiêu đề thư, không người gửi, không nội dung chia sẻ. Con số
// lấy từ GET /v2/inbox/items, nên mục của nguồn đã mất quyền không bao giờ được đếm (X03). render() đồng bộ: nó trả HTML từ bản đếm
// đã có và, khi bản đếm cũ hơn 60 giây, tự nạp lại rồi gọi ctx.rerender(). Mất mạng thì dòng nói chưa tải được, không đoán.
const STALE_MS = 60_000;
/** Bản đếm theo tài khoản: { n, more, at } hoặc { failed, at }. */
const counts = new Map();
const inflight = new Set();

function refresh(ctx, sub) {
  if (inflight.has(sub)) return;
  inflight.add(sub);
  ctx.api.get("/v2/inbox/items?state=NEW&limit=50")
    .then((r) => counts.set(sub, { n: r.items.length, more: r.next_cursor !== null, at: Date.now() }))
    .catch(() => counts.set(sub, { failed: true, at: Date.now() }))
    .finally(() => {
      inflight.delete(sub);
      ctx.rerender();
    });
}

export const inboxBrief = {
  id: "inbox",
  order: 40,
  visible: (ctx) => ctx.modules.inbox === true && !!ctx.me,
  render(ctx) {
    const sub = ctx.me?.user?.id ?? "";
    const c = counts.get(sub);
    if (!c || Date.now() - c.at > STALE_MS) refresh(ctx, sub);
    const text = !c ? ctx.tSafe("inbox.loading")
      : c.failed ? ctx.tSafe("inbox.brief.unavailable")
      : c.more ? ctx.tSafe("inbox.brief.many", { n: c.n })
      : c.n === 0 ? ctx.tSafe("inbox.brief.none")
      : ctx.tSafe("inbox.brief.line", { n: c.n });
    return '<span class="brief-icon">' + ctx.icon("inbox") + '</span><div class="brief-copy inbox-brief" data-brief="inbox">' + text + "</div>" +
      '<button type="button" class="text-button brief-go" data-nav="inbox">' + ctx.tSafe("inbox.brief.open") + "</button>";
  },
};

export default inboxBrief;
