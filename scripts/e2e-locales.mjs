// Kiểm nhanh từng ngôn ngữ trong LOCALES trên trình duyệt thật (LNH-T21, LNH-T28): giao diện nạp đúng catalog, không lỗi
// JavaScript, không tràn ngang và nhãn điều hướng nằm gọn trong nút ở cỡ điện thoại, với chữ 100 % và 200 %, trên mọi màn hình.
// Phép kiểm này xét cấu trúc và bố cục; nó KHÔNG xét nghĩa của bản dịch: mọi bản ngoài tiếng Việt vẫn là bản dịch máy chưa rà soát.
import { run, PHONE } from "./e2e-lib.mjs";
import { LOCALES } from "../web/shared/i18n.js";

const ALL = { messaging: true, social: true, trackers: true };
/** Ngôn ngữ trình duyệt dẫn tới từng catalog qua negotiate(). */
const BROWSER = { vi: "vi-VN", en: "en-US", fr: "fr-FR", "zh-Hans": "zh-CN", ko: "ko-KR", ja: "ja-JP", es: "es-ES", "pt-BR": "pt-BR", it: "it-IT", "zh-Hant": "zh-TW", id: "id-ID", ru: "ru-RU", de: "de-DE" };
const VIEWS = ["home", "health", "work", "house", "messages", "connect"];

const go = async (page, id) => {
  await page.evaluate((view) => {
    location.hash = "#" + view;
  }, id);
  await page.waitForSelector(`body[data-view=${id}]`, { state: "attached" });
};

await run("từng ngôn ngữ", async (t) => {
  const { ok } = t;
  let viLabels = "";
  for (const locale of LOCALES) {
    const { context, page } = await t.open({ viewport: PHONE, modules: ALL, locale: BROWSER[locale.tag] });
    await t.dismissNotice(page);
    const boot = await page.evaluate(() => ({
      lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title,
      labels: [...document.querySelectorAll("#mobile-nav .nav-label")].map((e) => e.textContent.trim()).join("|"),
    }));
    if (locale.tag === "vi") viLabels = boot.labels;
    ok(boot.lang === locale.tag && boot.dir === locale.dir && boot.labels.split("|").length === 5 && boot.labels.split("|").every((x) => x.length > 0),
      `${locale.tag}: <html lang="${boot.lang}" dir="${boot.dir}">, thanh dưới có năm nhãn (${boot.labels})`);
    if (locale.tag !== "vi") ok(boot.labels !== viLabels, `${locale.tag}: nhãn điều hướng lấy từ catalog của ngôn ngữ đó, không rơi về tiếng Việt`);
    for (const scale of [100, 200]) {
      await t.chooseSettings(page, { fontSize: scale });
      const bad = [];
      for (const view of VIEWS) {
        await go(page, view);
        const over = await t.overflowX(page);
        const spill = await t.navSpill(page);
        if (over > 0 || spill.length) bad.push(`${view}: tràn ${over}px${spill.length ? ", nhãn " + spill.join("; ") : ""}`);
      }
      ok(bad.length === 0, `${locale.tag} · chữ ${scale} %: sáu màn hình không tràn ngang ở 390 px, nhãn điều hướng nằm trong nút${bad.length ? " — " + bad.join(" | ") : ""}`);
    }
    if (locale.tag === "ja" || locale.tag === "ru" || locale.tag === "de") await t.shot?.(page, `locale-${locale.file}`);
    await context.close();
  }
});
