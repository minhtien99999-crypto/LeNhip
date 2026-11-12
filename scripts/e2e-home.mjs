// Kiểm trình duyệt phần Le‑NodeHome của màn hình Dịch vụ (V1.0.1, SRS V2.0 mục 06–07, LNH-T66): chủ hộ đồng ý, gửi yêu cầu
// khảo sát; vận hành LeLS (dev_ops) khảo sát và lắp qua API; chủ hộ nhận báo giá và xác nhận serial trong trang; Hub giả lập
// (mô phỏng) gửi sự kiện mới, sự kiện trễ và sự kiện trùng; quyền xem tạm thời cấp rồi thu hồi. Rồi bố cục: năm phong cách ở
// 1440×900, ba cỡ màn hình 390×844, 820×1180, 1440×900 ở một phong cách, chữ 200 % ở điện thoại và máy tính.
// Không có hình camera hay video nào trên trang. Dữ liệu tổng hợp của chế độ dev.
import { THEMES, run } from "./e2e-lib.mjs";

const MODULES = { home_hub: true };
const SECTION = ".connect-section[data-section=home-hub]";

await run("home", async (t) => {
  const shot = (p, name) => t.shot(p, name, true);
  const keyOf = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const opsToken = async () => (await (await fetch(t.base + "/dev/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub: "dev_ops" }) })).json()).token;
  /** Bước của vận hành LeLS qua API thật, với revision hiện hành. */
  async function ops(op, body) {
    const token = await opsToken();
    const headers = { Authorization: "Bearer " + token, "X-LeNhip-Workspace": "ws_demo", Accept: "application/json" };
    const list = await (await fetch(t.base + "/v2/ops/home/subscriptions", { headers })).json();
    const s = list.subscriptions.find((x) => x.owner_id === "dev_a" && !["HAAS_TERMINATED", "HAAS_RETURNED"].includes(x.state));
    const r = await fetch(t.base + `/v2/ops/home/subscriptions/${s.subscription_ref}/${op}`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": keyOf() }, body: JSON.stringify({ revision: s.revision, ...body }),
    });
    t.ok(r.status === 200, `LeLS ${op}: ${r.status}`);
    return r.json();
  }
  const stateOf = (p) => p.getAttribute(SECTION + " [data-home-state]", "data-home-state");
  const waitState = (p, st) => p.waitForSelector(`${SECTION} [data-home-state=${st}]`);
  async function reopen(p) {
    await p.reload();
    await t.ready(p);
    await t.dismissNotice(p);
    await p.evaluate(() => (location.hash = "#services"));
    await p.waitForSelector(SECTION);
  }

  // ---------------------------------------------------------------- hành trình
  // Trang hành trình mở với collectErrors: false vì cổng đồng ý (403) và serial sai (422) là phản hồi lỗi chủ ý: trình duyệt tự
  // ghi «Failed to load resource». Mọi lỗi JavaScript và console.error khác vẫn làm hỏng lượt kiểm.
  const softErrors = [];
  const { page } = await t.open({ modules: MODULES, collectErrors: false });
  page.on("pageerror", (e) => softErrors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && softErrors.push(m.text()));
  await t.dismissNotice(page);
  await page.evaluate(() => (location.hash = "#services"));
  await page.waitForSelector(SECTION);
  t.ok((await page.textContent(SECTION)).includes("giả định, không phải báo giá") || (await page.textContent(SECTION)).includes("Giả định, không phải báo giá"), "giá thử ghi rõ «giả định, không phải báo giá»");
  await page.waitForSelector(`${SECTION} [data-home-form=consent]`);
  t.ok(true, "chưa đồng ý: phần hiện văn bản đồng ý home_hub, không gì khác");
  await page.click(`${SECTION} [data-home-form=consent] button[type=submit]`);
  await page.waitForSelector(`${SECTION} [data-home-form=request]`);
  await page.fill("#homehub-site", "nha-thu-nghiem");
  await page.check(`${SECTION} input[name=terms]`);
  await page.click(`${SECTION} [data-home-form=request] button[type=submit]`);
  await waitState(page, "HAAS_REQUESTED");
  t.ok((await page.$$(`${SECTION} .homehub-step`)).length === 5, "danh sách năm bước");
  await shot(page, "1-requested");

  await ops("survey", { camera_count: 2, quote_vnd: 690000 });
  await reopen(page);
  await waitState(page, "HAAS_SURVEYED");
  t.ok(/690\.000/.test(await page.textContent(`${SECTION} .homehub-quote`)), "báo giá khảo sát hiện cho chủ hộ");
  await page.click(`${SECTION} [data-home-op=accept-quote]`);
  await waitState(page, "HAAS_ACCEPTED");

  await ops("install", { serial: "LNH-HUB-E2E1", firmware: "1.0.0", camera_refs: ["cam_front", "cam_yard"] });
  await reopen(page);
  await waitState(page, "HAAS_INSTALLED");
  await page.fill("#homehub-serial", "LNH-HUB-XXXX");
  await page.click(`${SECTION} [data-home-form=confirm] button[type=submit]`);
  await page.waitForSelector(`${SECTION} [data-home-form=confirm] [data-home-error]:not([hidden])`);
  t.ok((await page.textContent(`${SECTION} [data-home-form=confirm] [data-home-error]`)).includes("không khớp"), "serial sai bị từ chối");
  await page.fill("#homehub-serial", "lnh-hub-e2e1");
  await page.click(`${SECTION} [data-home-form=confirm] button[type=submit]`);
  await waitState(page, "HAAS_ACTIVE");
  t.ok(await page.isVisible(`${SECTION} .homehub-sim`), "chế độ dev: có khung Hub giả lập");
  t.ok((await page.textContent(`${SECTION} .homehub-sim`)).includes("Mô phỏng"), "Hub giả lập ghi rõ «mô phỏng»");

  // Hub giả lập: sự kiện mới, sự kiện trễ (60 phút trước), rồi gửi lại đúng sự kiện vừa rồi.
  await page.selectOption("#homehub-sim-type", "PERSON_IN_ZONE");
  await page.click(`${SECTION} .homehub-sim button[type=submit]`);
  await page.waitForSelector(`${SECTION} .homehub-event`);
  t.ok((await page.textContent(`${SECTION} .homehub-events`)).includes("Chưa xác minh"), "phát hiện người hiện «chưa xác minh»");
  await page.selectOption("#homehub-sim-type", "CAMERA_OFFLINE");
  await page.selectOption("#homehub-sim-age", "60");
  await page.click(`${SECTION} .homehub-sim button[type=submit]`);
  await page.waitForSelector(`${SECTION} [data-home-late]`);
  t.ok(true, "sự kiện trễ có dấu «đến trễ (ngoại tuyến)»");
  const before = (await page.$$(`${SECTION} .homehub-event`)).length;
  await page.click(`${SECTION} [data-home-sim-repeat]`);
  await page.waitForFunction((sel) => document.querySelector(sel + " [data-home-sim-result]")?.textContent.includes("trùng"), SECTION);
  t.ok((await page.$$(`${SECTION} .homehub-event`)).length === before && before === 2, "gửi lại sự kiện trùng không nhân đôi");
  t.ok((await page.$$(`${SECTION} img, ${SECTION} video, ${SECTION} canvas, ${SECTION} iframe`)).length === 0, "không có hình hay video camera trên trang");
  t.ok((await page.textContent(SECTION)).includes("Xem clip từ xa chưa mở"), "xem clip từ xa hiện là chưa có");

  // Quyền xem tạm thời: cấp, rồi thu hồi.
  await page.fill("#homehub-ticket", "TK-E2E-01");
  await page.click(`${SECTION} [data-home-form=grant] button[type=submit]`);
  await page.waitForSelector(`${SECTION} [data-home-revoke]`);
  t.ok((await page.textContent(`${SECTION} .homehub-grant-list`)).includes("TK-E2E-01"), "quyền xem tạm thời hiện kèm hạn dùng");
  await shot(page, "2-active");
  await page.click(`${SECTION} [data-home-revoke]`);
  await page.waitForSelector(`${SECTION} [data-home-form=grant]`);
  t.ok((await page.textContent(`${SECTION} .homehub-grant-list`)).includes("Đã thu hồi"), "thu hồi quyền xem");

  // ---------------------------------------------------------------- bố cục
  const layout = (p) => p.evaluate((sel) => {
    const out = [];
    const root = document.querySelector(sel);
    if (!root) return ["không có phần"];
    const box = root.getBoundingClientRect();
    for (const el of root.querySelectorAll("button, input:not([type=radio]):not([type=checkbox]), select, summary")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.height < 44 - 0.5) out.push(`${el.tagName.toLowerCase()} thấp ${Math.round(r.height)} px`);
      if (r.right > box.right + 1 || r.left < box.left - 1) out.push(`${el.tagName.toLowerCase()} vượt khung`);
    }
    return out;
  }, SECTION);
  for (const theme of THEMES) {
    await t.chooseSettings(page, { theme });
    const problems = await layout(page);
    t.ok(problems.length === 0 && (await t.overflowX(page)) === 0, `1440×900 ${theme}: không cuộn ngang, mục tiêu ≥ 44 px ${problems.join("; ")}`);
    await shot(page, `3-1440-${theme}`);
  }
  for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
    const { page: p } = await t.open({ viewport, modules: MODULES });
    await t.dismissNotice(p);
    await p.evaluate(() => (location.hash = "#services"));
    await waitState(p, "HAAS_ACTIVE");
    const problems = await layout(p);
    t.ok(problems.length === 0 && (await t.overflowX(p)) === 0, `${viewport.width}×${viewport.height}: không cuộn ngang, mục tiêu ≥ 44 px ${problems.join("; ")}`);
    await shot(p, `4-${viewport.width}`);
    if (viewport.width === 390) {
      await t.chooseSettings(p, { fontSize: 200 });
      await waitState(p, "HAAS_ACTIVE");
      const big = await layout(p);
      t.ok(big.length === 0 && (await t.overflowX(p)) === 0, `390×844 chữ 200 %: không cuộn ngang ${big.join("; ")}`);
      await shot(p, "5-390-200");
    }
    await p.context().close();
  }
  await t.chooseSettings(page, { theme: "orbit", fontSize: 200 });
  const big = await layout(page);
  t.ok(big.length === 0 && (await t.overflowX(page)) === 0, `1440×900 chữ 200 %: không cuộn ngang ${big.join("; ")}`);
  await shot(page, "5-1440-200");
  t.ok((await stateOf(page)) === "HAAS_ACTIVE", "trạng thái lấy từ máy chủ vẫn là ACTIVE");
  t.ok(softErrors.length === 0, "trang hành trình không có lỗi JavaScript" + (softErrors.length ? ": " + softErrors.join(" | ") : ""));
});
