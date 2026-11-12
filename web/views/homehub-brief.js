// Dòng của Le‑NodeHome trong Bản tóm tắt buổi sáng (V1.0.1, SRS V2.0 mục 03, LNH-T62, LNH-T66). Sổ đăng ký dòng tóm tắt do
// nhánh sync dựng; tệp này chỉ export một mục, người ghép thêm một dòng import vào sổ đó.
//
// Hợp đồng đề xuất của một mục: { id, order, visible(ctx) -> boolean, line(ctx) -> Promise<null | { text, tone, nav }> }
//   - text: văn bản thuần đã dịch; tone: "ok" | "warn" | "muted"; nav: id màn hình mở khi bấm.
//   - null khi không có gì để nói, khi chưa đồng ý, khi mô-đun tắt hoặc khi mất mạng: không bao giờ đoán.
// Chỉ đọc trạng thái dịch vụ và tình trạng camera từ GET /v2/home/subscriptions. KHÔNG có nội dung sự kiện camera (không đếm
// người, không giờ phát hiện), không hình, không video. LeLe không đọc dòng này.
export default {
  id: "homehub",
  order: 40,
  visible: (ctx) => ctx.modules.home_hub === true,
  async line(ctx) {
    let data;
    try {
      data = await ctx.api.get("/v2/home/subscriptions");
    } catch {
      return null;
    }
    const s = (data?.subscriptions ?? []).find((x) => !["HAAS_TERMINATED", "HAAS_RETURNED"].includes(x.state));
    if (!s) return null;
    const short = s.state.replace(/^HAAS_/, "");
    if (short === "ACTIVE") {
      const off = (s.hub?.cameras ?? []).filter((c) => !c.online).length;
      return off ? { text: ctx.t("homehub.brief.camerasOffline", { n: off }), tone: "warn", nav: "services" } : { text: ctx.t("homehub.brief.ACTIVE"), tone: "ok", nav: "services" };
    }
    const tone = short === "SURVEYED" || short === "INSTALLED" || short === "SUSPENDED" ? "warn" : "muted";
    return { text: ctx.t("homehub.brief." + short), tone, nav: "services" };
  },
};
