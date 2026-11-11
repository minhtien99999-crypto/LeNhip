// Kiểm giao diện trên trình duyệt thật (Playwright có sẵn trên máy kiểm): dựng máy chủ chạy thử trên cổng riêng với dữ liệu tạm,
// đi qua thông báo đầu tiên, tạo khung giờ lịch, bật/tắt đèn, xem sức khỏe, đề xuất của LeLe, 5 phương án và cỡ chữ 200 %.
//   node scripts/e2e.mjs [thư-mục-ảnh]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] ?? null;
if (out) mkdirSync(out, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "lenhip-e2e-"));
const port = 8900 + Math.floor(Math.random() * 90);
const server = spawn(process.execPath, ["src/main.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, LENHIP_DEV: "1", PORT: String(port), LENHIP_DATA_DIR: data },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = `http://127.0.0.1:${port}`;
let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("✗ " + msg);
  checks++;
  console.log("✓ " + msg);
};
const shot = async (page, name, full = false) => out && page.screenshot({ path: join(out, name + ".png"), fullPage: full });

try {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + "/healthz")).ok) break;
    } catch {
      /* chưa lên */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Ho_Chi_Minh", locale: "vi-VN" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(base + "/");
  await page.waitForSelector("#consent-form");
  const boxes = await page.$$eval("#consent-form input[type=checkbox]", (els) => els.map((e) => e.checked));
  ok(boxes.length === 4 && boxes.every((c) => !c), "thông báo đầu tiên: 4 mục đích, mặc định để trống");
  await shot(page, "01-thong-bao");
  for (const n of ["health_local", "calendar_link", "home_control"]) await page.check(`input[name=${n}]`);
  await page.click("#consent-form button");
  await page.waitForTimeout(800);
  ok(await page.isHidden("#banner"), "đã kết nối máy chủ, không hiện cảnh báo");
  const orbMark = await page.$eval(".orb-label svg.lele-mark", (e) => ({ cls: e.getAttribute("class"), label: e.getAttribute("aria-hidden"), paths: e.querySelectorAll("path").length }));
  ok(orbMark.cls.includes("duo") && orbMark.paths === 2, "chữ LeLe trên quả cầu là hình đã chốt, hai màu");
  const askMark = await page.$eval(".ask-lele svg.lele-mark", (e) => ({ label: e.getAttribute("aria-label"), color: getComputedStyle(e).color }));
  ok(askMark.label === "LeLe" && askMark.color === "rgb(250, 175, 77)", "nút Hỏi LeLe dùng chữ LeLe hổ phách, trình đọc màn hình đọc LeLe");
  ok(!(await page.textContent(".orb")).includes("LeLe") || (await page.$$eval(".orb-label", (els) => els.every((e) => !e.textContent.trim()))), "không còn chữ LeLe bằng phông Inter trên quả cầu");
  await shot(page, "02-hom-nay");

  await page.click("button[data-nav=work]");
  await page.waitForTimeout(400);
  const work = await page.textContent("main");
  ok(work.includes("Bận") && !work.includes("Cuộc họp"), "lịch hôm nay hiện khoảng bận, không lộ tiêu đề cuộc họp");
  await page.click("button[data-action=new-block]");
  await page.fill("#block-start", "16:00");
  await page.fill("#block-end", "16:30");
  await page.click("#block-form button");
  await page.waitForSelector("#countdown");
  const preview = await page.textContent("#action-body");
  ok(preview.includes("16:00 – 16:30") && preview.includes("Chỉ mình tôi") && preview.includes("đúng với nội dung máy chủ đã khóa"), "xem lại nội dung đã chuẩn hóa, digest khớp, có đếm ngược");
  await shot(page, "03-xem-lai");
  await page.click("button[data-action=approve-plan]");
  await page.waitForSelector("#action-body .status-chip.ok", { timeout: 15000 });
  ok((await page.textContent("#action-body")).includes("đọc lại từ lịch"), "khung giờ được xác minh bằng đọc lại từ lịch");
  await shot(page, "04-da-xac-minh");
  await page.click("#action-dialog [data-action=close-action]");

  await page.click("button[data-nav=house]");
  await page.waitForTimeout(300);
  const lampBefore = await page.getAttribute("button.switch[data-device=dev_lamp_01]", "aria-checked");
  await page.click("button.switch[data-device=dev_lamp_01]");
  await page.waitForSelector("#countdown");
  ok((await page.textContent("#action-body")).includes(lampBefore === "true" ? "Tắt Đèn bàn" : "Bật Đèn bàn"), "đổi đèn cần xem lại và xác nhận");
  await page.click("button[data-action=approve-plan]");
  await page.waitForSelector("#action-body .status-chip.ok", { timeout: 15000 });
  ok((await page.textContent("#action-body")).includes("thiết bị báo"), "kết quả đèn theo bằng chứng thiết bị báo");
  await page.click("#action-dialog [data-action=close-action]");
  await page.waitForTimeout(600);
  await shot(page, "05-ngoi-nha");

  await page.click("button[data-nav=health]");
  const health = await page.textContent("main");
  ok(/Trong \d ngày có dữ liệu, thời lượng ngủ trung bình là/.test(health) && health.includes("Dữ liệu tổng hợp"), "sức khỏe: câu trung tính, ghi rõ dữ liệu tổng hợp");
  ok((await page.$$(".bar-chart i.missing")).length === 2, "ngày thiếu dữ liệu hiển thị vạch mờ, không tính là 0");
  await shot(page, "06-suc-khoe", true);

  await page.click("main button[data-action=chat]");
  await page.fill("#chat-form input", "tối qua tôi ngủ kém");
  await page.click("#chat-form button");
  await page.waitForTimeout(300);
  ok((await page.textContent("#chat-list")).includes("không gửi tới LeLe"), "câu hỏi sức khỏe không rời thiết bị");
  await page.fill("#chat-form input", "dành 30 phút tập trung lúc 17:00");
  await page.click("#chat-form button");
  await page.waitForSelector("button[data-action=use-proposal]");
  await shot(page, "07-lele");
  await page.click("button[data-action=use-proposal]");
  await page.waitForSelector("#countdown");
  ok((await page.textContent("#action-body")).includes("17:00 – 17:30"), "đề xuất của LeLe đi qua cùng bước xem lại và xác nhận");
  await page.click("button[data-action=cancel-plan]");

  for (const t of ["orbit", "night", "calm", "flow", "titanium"]) {
    await page.click("button[data-nav=home]");
    await page.click(`button[data-theme-choice=${t}]`);
    await page.waitForTimeout(150);
    ok((await page.getAttribute("body", "data-theme")) === t, `phương án ${t} áp dụng`);
    await shot(page, `08-${t}`);
  }

  // Cỡ chữ 200 % trên điện thoại: không cuộn ngang, nút xác nhận còn trong khung.
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Asia/Ho_Chi_Minh", locale: "vi-VN", reducedMotion: "reduce" });
  const phone = await phoneCtx.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(base + "/");
  await phone.waitForTimeout(1000);
  if (await phone.$("#consent-form")) await phone.click("#action-dialog [data-action=close-action]");
  ok(await phone.evaluate(() => document.body.classList.contains("reduced-motion")), "mặc định theo prefers-reduced-motion của thiết bị");
  await phone.click("#settings-button");
  await phone.selectOption("#font-size", "200");
  await phone.click("#settings-form button[type=submit]");
  await phone.waitForTimeout(300);
  for (const tab of ["home", "health", "work", "house"]) {
    await phone.click(`#mobile-nav button[data-nav=${tab}]`);
    await phone.waitForTimeout(200);
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, `chữ 200 %, trang ${tab}: không cuộn ngang`);
  }
  await shot(phone, "09-dien-thoai-200", true);
  await phone.click("#mobile-nav button[data-nav=work]");
  await phone.click("button[data-action=new-block]");
  await phone.fill("#block-start", "18:00");
  await phone.fill("#block-end", "18:15");
  await phone.click("#block-form button");
  await phone.waitForSelector("button[data-action=approve-plan]");
  const box = await phone.$eval("button[data-action=approve-plan]", (b) => {
    b.scrollIntoView();
    const r = b.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: innerHeight, w: r.width };
  });
  ok(box.bottom <= box.h && box.w > 200, "chữ 200 %: nút Xác nhận nằm trong khung, đủ rộng");
  await phone.click("button[data-action=cancel-plan]");

  ok(errors.length === 0, "không có lỗi JavaScript" + (errors.length ? ": " + errors.join(" | ") : ""));
  await browser.close();
  console.log(`\n${checks} phép kiểm trình duyệt đạt`);
} finally {
  server.kill();
  rmSync(data, { recursive: true, force: true });
}
