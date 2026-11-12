// Kiểm trình duyệt cho Le‑NodeHealth và cổng mô phỏng Le‑ORION (V1.0.1, LNH-T67, LNH-T68). Máy đo là «Máy đo giả lập» của chế
// độ dev (adapter mô phỏng ở máy chủ); dữ liệu tổng hợp. Hành trình: đồng ý → phép đo giả lập qua hai kênh → xác nhận máy đo →
// nhật ký và xu hướng → cách ly và trả lời → chia sẻ → lượt mô phỏng với nhãn SIMULATED; rồi năm phong cách ở máy tính, ba cỡ
// màn hình ở một phong cách, chữ 200 % ở điện thoại và máy tính.
import { run, THEMES } from "./e2e-lib.mjs";

const MEAS = ".connect-section[data-section=measure]";
const SIM = ".connect-section[data-section=sim]";
const MODULES = { measurements: true, sim: true };

/** Tràn ngang, vùng bấm < 44 px, nút vượt khung, chữ có tương phản < 4,5 trong hai phần. */
function layoutProblems(sels) {
  const out = [];
  const page = document.documentElement;
  if (page.scrollWidth > page.clientWidth) out.push("trang tràn ngang " + (page.scrollWidth - page.clientWidth) + " px");
  const rgba = (css) => {
    const v = css.match(/[\d.]+/g).map(Number);
    return [v[0], v[1], v[2], v[3] ?? 1];
  };
  const over = ([r, g, b, a], under) => [r, g, b].map((v, i) => v * a + under[i] * (1 - a));
  const backdrop = (el) => {
    if (!el) return [255, 255, 255];
    const own = rgba(getComputedStyle(el).backgroundColor);
    return own[3] >= 1 ? own.slice(0, 3) : over(own, backdrop(el.parentElement));
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const sel of sels) {
    const section = document.querySelector(sel);
    if (!section) {
      out.push(sel + " không có");
      continue;
    }
    const box = section.getBoundingClientRect();
    for (const el of section.querySelectorAll("button, summary, select, input")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const what = el.textContent.trim().slice(0, 24) || el.getAttribute("name") || el.tagName;
      if (el.type !== "checkbox" && (r.height < 44 || r.width < 44)) out.push(`${what} nhỏ ${Math.round(r.width)}×${Math.round(r.height)}`);
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${what} vượt khung`);
    }
    for (const el of section.querySelectorAll(".meas-row, .sim-run, .meas-block, .sim-form")) if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className} tràn chữ`);
    for (const el of section.querySelectorAll("*")) {
      if (el.closest("svg") || el.getClientRects().length === 0) continue;
      if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
      const behind = backdrop(el);
      const [hi, lo] = [lum(over(rgba(getComputedStyle(el).color), behind)), lum(behind)].sort((x, y) => y - x);
      const c = (hi + 0.05) / (lo + 0.05);
      if (c < 4.5) out.push(`tương phản ${c.toFixed(2)} ở «${el.textContent.trim().slice(0, 30)}»`);
    }
  }
  return [...new Set(out)].slice(0, 12);
}

await run("meas", async (t) => {
  const { ok, shot } = t;
  const text = (page, sel) => page.textContent(sel).then((s) => (s ?? "").replace(/\s+/g, " "));
  const go = (page) => page.evaluate(() => (location.hash = "#services"));

  const { page, context } = await t.open({ modules: MODULES, reducedMotion: "reduce" });
  const requests = [];
  page.on("request", (r) => requests.push({ url: r.url(), body: r.postData() ?? "" }));
  await t.dismissNotice(page);
  await go(page);
  await page.waitForSelector(MEAS);
  await page.waitForSelector(SIM);
  ok((await text(page, MEAS)).includes("không phải thiết bị y tế chẩn đoán"), "Le‑NodeHealth ghi rõ không phải thiết bị y tế chẩn đoán");
  ok(!/AFib|rung nhĩ|loạn nhịp|chẩn đoán là|nguy cơ/i.test((await text(page, MEAS)).replace("không chẩn đoán", "").replace("không phải thiết bị y tế chẩn đoán", "")), "không có chỉ báo AFib hay lời chẩn đoán");

  // Đồng ý theo văn bản của mục đích measurements.
  await page.waitForSelector(`${MEAS} [data-meas-consent]`);
  await page.check(`${MEAS} [data-meas-consent] input[type=checkbox]`);
  await page.click(`${MEAS} [data-meas-consent] button[type=submit]`);
  await page.waitForSelector(`${MEAS} [data-meas-simbox]`);
  ok(true, "đồng ý ghi phép đo mở phần thân");

  // Máy đo giả lập: một phép đo qua cả hai kênh → kênh thứ hai là trùng; ánh xạ chờ xác nhận.
  await page.click(`${MEAS} [data-meas-simbox] summary`);
  const sim = `${MEAS} [data-meas-sim]`;
  await page.selectOption(`${sim} select[name=channel]`, "BOTH");
  await page.click(`${sim} button[type=submit]`);
  await page.waitForFunction((s) => /cách ly/.test(document.querySelector(s + " [data-meas-sim-status]").textContent), sim);
  ok(/trùng/.test(await text(page, `${sim} [data-meas-sim-status]`)), "cùng phép đo qua kênh thứ hai: trùng, không ghi thêm");
  await page.waitForSelector(`${MEAS} [data-meas-map=confirm]`);
  ok((await text(page, `${MEAS} [data-meas=log]`)).includes("Chưa có phép đo"), "trước khi xác nhận: chưa gán phép đo nào");
  await page.click(`${MEAS} [data-meas-map=confirm]`);
  await page.waitForSelector(`${MEAS} [data-meas=log] .meas-row`);
  ok((await page.$$(`${MEAS} [data-meas=log] .meas-row`)).length === 1, "xác nhận máy đo: phép đo chờ được gán");
  await page.selectOption(`${sim} select[name=channel]`, "PHONE_GATEWAY");
  await page.click(`${sim} button[type=submit]`);
  await page.waitForFunction((s) => !/…/.test(document.querySelector(s + " [data-meas-sim-status]").textContent), sim);
  await page.waitForFunction((s) => document.querySelectorAll(s + " [data-meas=log] .meas-row").length === 2, MEAS, { timeout: 8000 }).catch(async (e) => {
    throw new Error(e.message + " · trạng thái: " + (await text(page, `${sim} [data-meas-sim-status]`)) + " · nhật ký: " + (await text(page, `${MEAS} [data-meas=log]`)));
  });
  await page.waitForSelector(`${MEAS} svg.meas-chart`);
  ok((await page.$$(`${MEAS} svg.meas-chart circle`)).length === 4, "xu hướng: hai đường, hai điểm mỗi đường");
  ok((await text(page, `${MEAS} [data-meas=log]`)).includes("mô phỏng"), "phép đo từ adapter mô phỏng có nhãn «mô phỏng»");

  // Máy dùng chung không báo hồ sơ: cách ly, chỉ siêu dữ liệu; trả lời «Của tôi».
  await page.selectOption(`${sim} select[name=user_slot]`, "0");
  await page.click(`${sim} button[type=submit]`);
  await page.waitForSelector(`${MEAS} [data-meas-q=MINE]`);
  ok((await text(page, `${MEAS} [data-meas=quarantine]`)).includes("không báo hồ sơ") && !/mmHg/.test(await text(page, `${MEAS} [data-meas=quarantine]`)), "cách ly hiện lý do, không hiện giá trị");
  await page.click(`${MEAS} [data-meas-q=MINE]`);
  await page.waitForFunction((s) => document.querySelectorAll(s + " [data-meas=log] .meas-row").length === 3, MEAS);
  ok(true, "trả lời «Của tôi»: phép đo được gán");

  // Chia sẻ có mục đích và hạn.
  await page.selectOption(`${MEAS} [data-meas-share] select[name=grantee_user]`, "dev_b");
  await page.click(`${MEAS} [data-meas-share] button[type=submit]`);
  await page.waitForSelector(`${MEAS} [data-meas-revoke]`);
  ok((await text(page, `${MEAS} [data-meas=shares]`)).includes("Thử nghiệm B"), "grant chia sẻ hiện người nhận, mục đích, phạm vi, hạn");
  ok((await text(page, `${MEAS} [data-meas=shares]`)).includes("đã chia sẻ"), "nhật ký truy cập ghi việc chia sẻ");

  // Lịch nhắc đo trên thiết bị.
  await page.fill(`${MEAS} [data-meas-rem] input[name=time]`, "21:15");
  await page.click(`${MEAS} [data-meas-rem] button[type=submit]`);
  await page.waitForSelector(`${MEAS} [data-meas-rem-del="21:15"]`);
  ok((await text(page, `${MEAS} [data-meas-next]`)).includes("21:15"), "nhắc đo theo giờ người dùng đặt");

  // Cổng mô phỏng.
  ok((await text(page, SIM)).includes("Robot thật theo đề án riêng của LeHR"), "ghi rõ robot thật theo đề án riêng của LeHR");
  await page.waitForSelector(`${SIM} [data-sim-form]`);
  await page.selectOption(`${SIM} select[name=skill_ref]`, "skl_navigate_room");
  await page.click(`${SIM} [data-sim-form] button[type=submit]`);
  await page.waitForSelector(`${SIM} .sim-run`);
  ok((await text(page, `${SIM} .sim-run`)).includes("SIMULATED"), "lượt mô phỏng có nhãn SIMULATED");
  ok((await text(page, `${SIM} [data-sim-status]`)).includes("SIMULATED"), "thông báo của lượt chạy có nhãn SIMULATED");
  await page.waitForFunction((s) => /Xong/.test(document.querySelector(s + " .sim-run").textContent), SIM, { timeout: 15000 });
  ok((await text(page, `${SIM} .sim-run`)).includes("Kết quả mô phỏng"), "trình mô phỏng hoàn tất, kết quả ghi là mô phỏng");

  // Trang không gửi giá trị đo đi đâu: mọi yêu cầu của trang chỉ tới cùng gốc, không thân POST nào mang systolic/diastolic.
  ok(requests.every((r) => r.url.startsWith(t.base)) && !requests.some((r) => /systolic|diastolic/.test(r.body)), "trang không gửi giá trị đo; không yêu cầu tới bên ngoài");
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  ok(!/systolic|diastolic|mmHg/.test(stored), "bộ nhớ của trình duyệt không có giá trị đo");
  await shot(page, "meas-desktop", true);

  // Năm phong cách ở máy tính.
  for (const theme of THEMES) {
    await t.chooseSettings(page, { theme, fontSize: 100 });
    const problems = await page.evaluate(layoutProblems, [MEAS, SIM]);
    ok(problems.length === 0, `1440×900 · ${theme}: không tràn, vùng bấm ≥ 44 px, chữ đọc được` + (problems.length ? " — " + problems.join("; ") : ""));
    await shot(page, `1440x900-${theme}`, true);
  }
  await context.close();

  // Ba cỡ màn hình ở một phong cách; chữ 200 % ở điện thoại và máy tính.
  const MATRIX = [
    ["điện thoại", { width: 390, height: 844 }, [100, 200]],
    ["máy tính bảng", { width: 820, height: 1180 }, [100]],
    ["máy tính", { width: 1440, height: 900 }, [200]],
  ];
  for (const [name, viewport, scales] of MATRIX) {
    const o = await t.open({ viewport, modules: MODULES, reducedMotion: "reduce" });
    await t.dismissNotice(o.page);
    await go(o.page);
    await o.page.waitForSelector(`${MEAS} [data-meas=log] .meas-row`);
    await o.page.waitForSelector(`${SIM} .sim-run`);
    await o.page.$$eval(`${MEAS} details`, (els) => els.forEach((d) => (d.open = true)));
    for (const scale of scales) {
      await t.chooseSettings(o.page, { theme: "titanium", fontSize: scale });
      const problems = await o.page.evaluate(layoutProblems, [MEAS, SIM]);
      ok(problems.length === 0, `${name} ${viewport.width}×${viewport.height} · chữ ${scale} %: không tràn, vùng bấm ≥ 44 px, chữ đọc được` + (problems.length ? " — " + problems.join("; ") : ""));
      await shot(o.page, `${viewport.width}x${viewport.height}-${scale}`, true);
    }
    await o.context.close();
  }

  // Người nhận chia sẻ: không cần đồng ý ghi phép đo của riêng mình để xem grant người khác cấp; lần xem được ghi cho người chia sẻ.
  const b = await t.open({ modules: MODULES, reducedMotion: "reduce" });
  await t.signIn(b.page, "dev_b");
  await go(b.page);
  await b.page.waitForTimeout(300);
  await t.dismissNotice(b.page);
  await b.page.waitForSelector(`${MEAS} [data-meas-consent]`);
  ok(!(await b.page.$(`${MEAS} [data-meas=log]`)), "người chưa đồng ý không có nhật ký của riêng mình");
  await b.page.waitForSelector(`${MEAS} [data-meas-view]`);
  await b.page.click(`${MEAS} [data-meas-view]`);
  await b.page.waitForSelector("#action-dialog[open] .meas-dialog .meas-row");
  ok((await text(b.page, "#action-dialog[open] .meas-dialog")).includes("mmHg") && (await text(b.page, "#action-dialog[open]")).includes("không phải thiết bị y tế chẩn đoán"), "người xem mở được phép đo đã chia sẻ, có câu không phải thiết bị y tế");
  await shot(b.page, "viewer-dialog");
  await b.context.close();
});
