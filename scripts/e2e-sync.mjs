// Kiểm trình duyệt của nhánh sync (SRS V2.0 mục 03; LNH-T62, LNH-T63, LNH-T64; ca X01, X02, X11): Bản tóm tắt buổi sáng khi chưa
// bật và khi đã bật đọc sức khỏe trên máy, khi mất mạng; hai ngữ cảnh trình duyệt (hai «thiết bị» của cùng tài khoản thử) cùng sửa
// một bản nháp → 409 → chọn bản; thu hồi một thiết bị từ thiết bị kia → trang cũ từ chối và chỉ hiện màn hình trung tính; năm phong
// cách; điện thoại, máy tính bảng, máy tính; chữ 200 %.
import { DESKTOP, PHONE, THEMES, run } from "./e2e-lib.mjs";

const TABLET = { width: 820, height: 1180 };

await run("sync", async (t) => {
  const { ok, shot } = t;
  const text = (page, sel = "main") => page.textContent(sel).then((s) => s ?? "");
  const brief = (page) => text(page, ".brief-card");

  /** Bố cục của thẻ tóm tắt (và hộp đang mở): tràn ngang, vùng bấm dưới 44 px, phần tử lọt ngoài thẻ. */
  const layout = (page) => page.evaluate(() => {
    const out = [];
    const over = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over) out.push("trang tràn ngang " + over + " px");
    const card = document.querySelector(".brief-card");
    if (!card) return ["không có thẻ tóm tắt"];
    const box = card.getBoundingClientRect();
    for (const el of card.querySelectorAll("button, a, input, select")) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      if (r.height < 44) out.push((el.textContent || el.tagName).trim().slice(0, 30) + " cao " + Math.round(r.height) + " px");
      if (r.left < box.left - 1 || r.right > box.right + 1) out.push((el.textContent || el.tagName).trim().slice(0, 30) + " lọt ngoài thẻ");
    }
    return out;
  });

  /** Mọi yêu cầu mạng của trang, để chứng minh không số liệu sức khỏe nào rời thiết bị. */
  const traffic = (page) => {
    const seen = [];
    page.on("request", (r) => seen.push(r.url() + " " + (r.postData() ?? "")));
    return seen;
  };

  // ---------------------------------------------------------------- 1. tóm tắt khi chưa bật đọc sức khỏe
  const A = await t.open({ modules: { sync: true } });
  await t.dismissNotice(A.page);
  await A.page.waitForSelector(".brief-card");
  let b = await brief(A.page);
  ok(b.includes("Bản tóm tắt buổi sáng") && b.includes("Giấc ngủ và bước chân chưa được bật đọc trên thiết bị này") && !b.includes("Đêm qua ngủ"), "chưa bật đọc sức khỏe: một dòng trung tính, không số liệu, không lỗi");
  ok(b.includes("Lịch chưa được bật cho LeNhip") && b.includes("Bật đồng bộ trên thiết bị này"), "lịch chưa đồng ý và thiết bị chưa đăng ký: nói rõ, có đường đi tiếp");
  ok((await A.page.$$("main > .brief-card, main .brief-card")).length === 1 && (await A.page.evaluate(() => document.querySelector("main").firstElementChild?.nextElementSibling?.classList.contains("brief-card") || document.querySelector("main .brief-card") === document.querySelector("main").children[document.querySelector(".context-switch") ? 2 : 1])), "thẻ tóm tắt nằm đầu màn hình Hôm nay, ngay dưới lời chào");
  await shot(A.page, "01-tom-tat-chua-bat-suc-khoe");

  // ---------------------------------------------------------------- 2. đã bật đọc sức khỏe; mất mạng (X11)
  // Trang mất mạng, nhận 409 và 403 có chủ đích: trình duyệt ghi «Failed to load resource» vào console; chỉ lỗi JavaScript làm hỏng.
  const pageErrors = [];
  const C = await t.open({ modules: { sync: true }, viewport: PHONE, collectErrors: false });
  C.page.on("pageerror", (e) => pageErrors.push("C: " + e.message));
  C.page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && pageErrors.push("C: " + m.text()));
  const sent = traffic(C.page);
  await t.acceptNotice(C.page, ["health_local", "calendar_link"]);
  await C.page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Đêm qua ngủ"));
  b = await brief(C.page);
  ok(b.includes("Đêm qua ngủ") && /Hôm qua đi [\d.]+ bước/.test(b) && b.includes("dữ liệu mẫu"), "đã bật: giấc ngủ đêm qua và bước chân hôm qua, ghi rõ là dữ liệu mẫu");
  ok(/Hôm nay có \d+ khung bận|Hôm nay lịch trống|Các khung hôm nay đã qua/.test(b), "lịch hôm nay từ dữ liệu đã nạp");
  ok(b.includes("Dựng trên thiết bị này, không gọi LeLe"), "nói rõ thẻ dựng trên thiết bị, không gọi LeLe");
  await shot(C.page, "02-tom-tat-co-du-lieu-dien-thoai");
  await C.context.setOffline(true);
  await C.page.waitForFunction(() => document.querySelector(".brief-offline"));
  b = await brief(C.page);
  ok(b.includes("Đang ngoại tuyến") && b.includes("Đêm qua ngủ") && b.includes("Lịch hôm nay chưa có khi ngoại tuyến"), "mất mạng: phần trên thiết bị vẫn hiện, phần từ máy chủ nói rõ là chưa có");
  await shot(C.page, "03-tom-tat-ngoai-tuyen");
  await C.context.setOffline(false);
  const leaked = sent.filter((s) => /sleep|steps|giấc|bước|duration|asleep/i.test(s.replace(/\/v1\/(health|me)\b/, "")) && !s.includes("/shared/") && !s.includes("/views/") && !s.endsWith(".js "));
  ok(leaked.length === 0, "không yêu cầu mạng nào mang số liệu sức khỏe (" + sent.length + " yêu cầu)" + (leaked.length ? " — " + leaked.join(" | ") : ""));
  await C.context.close();

  // ---------------------------------------------------------------- 3. hai thiết bị cùng sửa một bản nháp (X01)
  const register = async (page, kind) => {
    await page.click(".brief-card [data-brief=register]");
    await page.check(`#action-body input[name=kind][value=${kind}]`);
    await page.click("#action-body [data-sync-register] button[type=submit]");
    await page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
    await page.waitForSelector(".brief-card [data-brief=new-task]");
  };
  await register(A.page, "LAPTOP");
  ok((await brief(A.page)).includes("Chưa có bản nháp nào"), "A đăng ký thiết bị: danh sách bản nháp trống");
  const B = await t.open({ modules: { sync: true }, viewport: TABLET, collectErrors: false });
  B.page.on("pageerror", (e) => pageErrors.push("B: " + e.message));
  B.page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && pageErrors.push("B: " + m.text()));
  await t.dismissNotice(B.page);
  await register(B.page, "TABLET");
  const saveTask = async (page, title, open = null) => {
    if (open) await page.click(`.brief-card [data-brief=open]:has-text("${open}")`);
    else await page.click(".brief-card [data-brief=new-task]");
    await page.fill("#action-body input[name=title]", title);
    await page.click("#action-body [data-sync-editor] button[type=submit]");
    await page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  };
  await saveTask(A.page, "Mua sữa");
  await A.page.waitForFunction(() => !document.querySelector(".brief-card")?.textContent.includes("Chờ kết nối") && document.querySelector(".brief-card")?.textContent.includes("Mua sữa"));
  await B.page.click(".brief-card [data-brief=refresh]");
  await B.page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Mua sữa"));
  ok(true, "bản nháp tạo ở máy tính hiện trên máy tính bảng sau khi đồng bộ");
  await B.context.setOffline(true);
  await B.page.waitForSelector(".brief-offline");
  await saveTask(B.page, "Mua bánh mì", "Mua sữa");
  await B.page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Chờ kết nối"));
  ok((await brief(B.page)).includes("Mua bánh mì"), "máy tính bảng ngoại tuyến: sửa đổi nằm trong hàng đợi trên thiết bị («Chờ kết nối»)");
  const stored = await B.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("lenhip.sync.v1.")).map((k) => localStorage.getItem(k)).join(""));
  ok(stored.includes("Mua bánh mì") && !/sleep|steps/.test(stored), "localStorage chỉ giữ bản nháp việc cá nhân và hàng đợi, không số liệu sức khỏe");
  await saveTask(A.page, "Mua sữa và trứng", "Mua sữa");
  await A.page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Mua sữa và trứng") && !document.querySelector(".brief-card")?.textContent.includes("Chờ kết nối"));
  await B.context.setOffline(false);
  await B.page.waitForSelector(".brief-card [data-brief=conflict]", { timeout: 15000 });
  ok((await brief(B.page)).includes("Cần chọn bản"), "kết nối lại: máy chủ trả 409, máy tính bảng báo cần chọn bản, không ghi đè");
  await B.page.click(".brief-card [data-brief=conflict]");
  await B.page.waitForSelector("#action-body .sync-versions");
  const dlg = await text(B.page, "#action-body");
  ok(dlg.includes("Mua bánh mì") && dlg.includes("Mua sữa và trứng") && dlg.includes("bản 2"), "hộp xung đột hiện cả hai bản và revision mới nhất");
  await shot(B.page, "04-xung-dot-may-tinh-bang");
  await B.page.click('#action-body [data-sync="mine"]');
  await B.page.waitForFunction(() => !document.querySelector(".brief-card")?.textContent.includes("Chờ kết nối") && !document.querySelector(".brief-card [data-brief=conflict]"));
  await A.page.click(".brief-card [data-brief=refresh]");
  await A.page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Mua bánh mì"));
  ok(!(await brief(A.page)).includes("Mua sữa và trứng"), "chọn «Giữ bản của thiết bị này»: bản đó lên revision 3 và về máy tính");

  // ---------------------------------------------------------------- 4. thu hồi thiết bị từ thiết bị kia (X02)
  await B.page.click('.brief-card [data-brief=open]:has-text("Mua bánh mì")');
  await B.page.waitForSelector("#action-body [data-sync-editor]");
  await A.page.click("#desktop-nav button[data-nav=connect]");
  await A.page.waitForSelector(".connect-section[data-section=sessions] .sync-session");
  const sessions = await text(A.page, ".connect-section[data-section=sessions]");
  ok(sessions.includes("Máy tính xách tay") && sessions.includes("Máy tính bảng") && sessions.includes("Thiết bị này") && sessions.includes("Đồng hồ chỉ nhận lời nhắc chung"), "Kết nối → Phiên trên các thiết bị: hai phiên theo loại máy, đánh dấu thiết bị này, nói rõ đồng hồ chỉ nhận lời nhắc chung");
  await shot(A.page, "05-phien-thiet-bi");
  const other = await A.page.$eval(".sync-session:not(:has(.tiny-pill)) [data-session-revoke]", (el) => el.dataset.sessionRevoke);
  await A.page.click(`[data-session-revoke="${other}"]`);
  await A.page.click("#action-body [data-session-confirm]");
  await A.page.waitForFunction(() => document.querySelectorAll(".sync-session").length === 1);
  ok(true, "thu hồi phiên máy tính bảng từ máy tính");
  // Trang cũ đang xem bản nháp và định lưu: bị từ chối, chỉ hiện màn hình trung tính.
  await B.page.fill("#action-body input[name=title]", "Mua bánh mì nguyên cám");
  await B.page.click("#action-body [data-sync-editor] button[type=submit]");
  await B.page.waitForSelector("#sync-revoked[open]");
  const after = await B.page.evaluate(() => ({ body: document.body.innerText, title: document.title, store: Object.keys(localStorage).filter((k) => k.startsWith("lenhip.sync.v1.")).length, action: document.getElementById("action-dialog").open }));
  ok(after.body.includes("Phiên này đã bị thu hồi") && !after.body.includes("Mua bánh mì") && !after.title.includes("Mua") && after.store === 0 && !after.action, "trang cũ: màn hình «Phiên này đã bị thu hồi», hộp sửa đã đóng, không còn nội dung nháp trên trang hay trong localStorage");
  await shot(B.page, "06-phien-bi-thu-hoi");
  await B.page.click("[data-sync-revoked-close]");
  const refused = await B.page.evaluate(async () => {
    const s = JSON.parse(sessionStorage.getItem("lenhip.session") ?? "{}");
    const r = await fetch("/v2/sync/drafts", { headers: { Authorization: "Bearer " + s.token, "X-LeNhip-Workspace": "ws_demo" } });
    return r.status;
  });
  ok(refused === 403 && (await brief(B.page)).includes("Phiên đồng bộ của thiết bị này đã bị thu hồi"), "sau đó: không phiên thì máy chủ từ chối (403), thẻ chỉ nói phiên đã bị thu hồi");
  await A.page.click("#desktop-nav button[data-nav=home]");
  await A.page.click(".brief-card [data-brief=refresh]");
  await A.page.waitForFunction(() => document.querySelector(".brief-card")?.textContent.includes("Mua bánh mì"));
  ok(!(await brief(A.page)).includes("nguyên cám"), "sửa đổi từ phiên đã thu hồi không tới máy chủ");
  await B.context.close();
  ok(pageErrors.length === 0, "trang mất mạng và trang bị thu hồi: không lỗi JavaScript ngoài các phản hồi 403/409 có chủ đích" + (pageErrors.length ? " — " + pageErrors.join(" | ") : ""));

  // ---------------------------------------------------------------- 5. năm phong cách, ba cỡ màn hình, chữ 200 %
  await A.page.click('.brief-card [data-brief=open]:has-text("Mua bánh mì")');
  await A.page.click("#action-dialog [data-action=close-action]");
  for (const theme of THEMES) {
    await t.chooseSettings(A.page, { theme });
    await A.page.waitForSelector(".brief-card");
    const found = await layout(A.page);
    ok(found.length === 0, `1440×900 · ${theme}: thẻ tóm tắt không tràn, vùng bấm từ 44 px` + (found.length ? " — " + found.join("; ") : ""));
    await shot(A.page, "07-phong-cach-" + theme);
  }
  await t.chooseSettings(A.page, { theme: "orbit" });
  for (const [name, viewport] of [["điện thoại", PHONE], ["máy tính bảng", TABLET], ["máy tính", DESKTOP]]) {
    await A.page.setViewportSize(viewport);
    await A.page.waitForTimeout(150);
    const found = await layout(A.page);
    ok(found.length === 0, `${name} ${viewport.width}×${viewport.height}: thẻ tóm tắt không tràn, vùng bấm từ 44 px` + (found.length ? " — " + found.join("; ") : ""));
    await shot(A.page, "08-co-" + viewport.width, true);
  }
  for (const [name, viewport] of [["điện thoại", PHONE], ["máy tính", DESKTOP]]) {
    await A.page.setViewportSize(viewport);
    await t.chooseSettings(A.page, { fontSize: 200 });
    const found = await layout(A.page);
    ok(found.length === 0, `${name} · chữ 200 %: thẻ tóm tắt không tràn, vùng bấm từ 44 px` + (found.length ? " — " + found.join("; ") : ""));
    await shot(A.page, "09-chu-200-" + viewport.width, true);
    await A.page.click('.brief-card [data-brief=new-calendar]');
    const dialog = await A.page.evaluate(() => {
      const d = document.getElementById("action-dialog").getBoundingClientRect();
      const bad = [...document.querySelectorAll("#action-body button, #action-body input, #action-body select")].filter((el) => el.getBoundingClientRect().height < 44 && el.type !== "checkbox").length;
      return { over: d.right > window.innerWidth + 1 || d.left < -1, bad };
    });
    ok(!dialog.over && dialog.bad === 0, `${name} · chữ 200 %: hộp nháp khung giờ nằm trong màn hình, ô nhập và nút từ 44 px`);
    await A.page.click("#action-dialog [data-action=close-action]");
    await t.chooseSettings(A.page, { fontSize: 100 });
  }
});
