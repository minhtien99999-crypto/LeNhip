// Kiểm trình duyệt cho Tin nhắn và «Thiết bị của tôi» (LNH-T30..T36): hai tài khoản thử trong hai ngữ cảnh trình duyệt, thêm
// một ngữ cảnh thứ ba làm «thiết bị thứ hai» của người nhận. Mỗi ngữ cảnh có IndexedDB riêng, nên là một thiết bị riêng với
// cặp khóa riêng; tất cả chạy trên cùng một máy, với máy chủ chạy thử và tài khoản thử. Mật mã và máy chủ là thật.
//   node scripts/e2e-messages.mjs [thư-mục-ảnh]        (cả bộ: npm run e2e)
//
// Trang của A được mở với collectErrors: false vì bước «mất mạng khi đang gửi» làm trình duyệt tự ghi «Failed to load
// resource» vào console; phép kiểm tự thu lỗi của trang đó và chỉ bỏ qua đúng loại dòng ấy. Mọi lỗi JavaScript khác vẫn làm
// hỏng lượt kiểm, ở mọi trang.
import { run, THEMES } from "./e2e-lib.mjs";

const MARKER = "E2E-BANRO-58213";
const FIRST = `Chào B, hẹn 15:00 ở cổng B nhé 👋 ${MARKER}`;
const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };

await run("tin nhắn", async (t) => {
  const { ok, shot } = t;
  /** Mọi yêu cầu rời các trang: để quét bản rõ và đếm POST. */
  const wire = [];
  const softErrors = [];
  /** Thu lỗi của một trang mở với collectErrors: false: mọi lỗi JavaScript và console.error, trừ dòng trình duyệt tự ghi khi một yêu cầu mạng hỏng. */
  const soft = (page, who) => {
    page.on("pageerror", (e) => softErrors.push(who + ": " + e.message));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && softErrors.push(who + ": " + m.text()));
  };
  const watch = (page, who) => page.on("request", (r) => wire.push({ who, method: r.method(), url: r.url(), path: new URL(r.url()).pathname, body: r.postData() ?? "", key: r.headers()["idempotency-key"] ?? null }));
  const openMessages = async (page) => {
    await page.evaluate(() => {
      location.hash = "#messages";
    });
    await page.waitForSelector("body[data-view=messages] .msg-root");
  };
  /** Đổi tài khoản rồi đóng thông báo đầu tiên của tài khoản mới (nó mở lại vì tài khoản đó chưa chọn gì). */
  const signInAs = async (page, sub) => {
    await t.signIn(page, sub);
    await page.waitForTimeout(400);
    await t.dismissNotice(page);
  };
  const text = (page, sel = "main") => page.textContent(sel);
  const bubbles = (page) => page.$$eval(".msg-log .msg-bubble", (els) => els.map((e) => ({ mine: e.classList.contains("mine"), text: e.querySelector(".msg-text").textContent, status: e.dataset.status, label: e.querySelector(".msg-status")?.textContent ?? null })));
  const send = async (page, value) => {
    await page.fill("#msg-input", value);
    await page.press("#msg-input", "Enter");
  };
  const waitBubble = (page, value, status, timeout = 8000) => page.waitForFunction(([v, s]) => [...document.querySelectorAll(".msg-log .msg-bubble")].some((e) => e.querySelector(".msg-text").textContent === v && (!s || e.dataset.status === s)), [value, status ?? null], { timeout });
  const consentAndRegister = async (page, kind) => {
    await page.waitForSelector("form[data-msg-form=consent]");
    await page.check("form[data-msg-form=consent] input[name=agree]");
    await page.click("form[data-msg-form=consent] button[type=submit]");
    await page.waitForSelector("form[data-msg-form=device]");
    await page.check(`form[data-msg-form=device] input[value=${kind}]`);
    await page.click("form[data-msg-form=device] button[type=submit]");
    await page.waitForSelector(".msg-panes:not([hidden])");
  };

  // ---------------------------------------------------------------- A: lần mở đầu, đồng ý, đăng ký thiết bị
  const A = await t.open({ modules: { messaging: true }, collectErrors: false });
  soft(A.page, "A");
  watch(A.page, "A");
  await A.page.waitForSelector("#consent-form");
  const notice = await A.page.$$eval("#consent-form input[type=checkbox]", (els) => els.map((e) => e.name));
  ok(notice.length === 4 && !notice.includes("messaging"), "thông báo đầu tiên vẫn bốn ô, không có ô nhắn tin");
  await t.dismissNotice(A.page);
  await openMessages(A.page);
  await A.page.waitForSelector("form[data-msg-form=consent]");
  const consent = await A.page.evaluate(() => ({
    text: document.querySelector(".msg-step").textContent,
    checked: document.querySelector("form[data-msg-form=consent] input[name=agree]").checked,
    boxes: document.querySelectorAll("form[data-msg-form=consent] input[type=checkbox]").length,
    composer: document.querySelector(".msg-panes").hidden,
  }));
  ok(consent.boxes === 1 && !consent.checked && consent.composer && consent.text.includes("muộn nhất 30 ngày") && consent.text.includes("không đọc được nội dung") && consent.text.includes("LeLe không đọc tin nhắn") && consent.text.includes("không chặn được người vận hành sửa mã"),
    "lần mở đầu: văn bản mục đích nhắn tin, một ô chưa chọn; nêu rõ 30 ngày, máy chủ không đọc được, và giới hạn của mã hóa đầu cuối trên web");
  ok(wire.filter((w) => w.path.startsWith("/v1/messages")).length === 0, "chưa đồng ý thì chưa có yêu cầu nhắn tin nào rời trang");
  await shot(A.page, "01-dong-y");
  await A.page.check("form[data-msg-form=consent] input[name=agree]");
  await A.page.click("form[data-msg-form=consent] button[type=submit]");
  await A.page.waitForSelector("form[data-msg-form=device]");
  const consentPost = wire.find((w) => w.path === "/v1/consents" && w.method === "POST");
  ok(/"purpose_id":"messaging"/.test(consentPost.body) && /"text_version":"v1-2026-11-11"/.test(consentPost.body) && /"choice":"GRANTED"/.test(consentPost.body), "đồng ý ghi biên nhận cho mục đích messaging kèm phiên bản văn bản");
  const kinds = await A.page.$$eval("form[data-msg-form=device] input[name=kind]", (els) => els.map((e) => e.value + ":" + e.checked));
  ok(kinds.join() === "PHONE:false,TABLET:false,LAPTOP:false,DESKTOP:false,OTHER:false" && (await text(A.page, ".msg-step")).includes("Thiết bị mới chỉ thấy tin nhắn gửi sau khi được thêm"), "bước đăng ký thiết bị: năm loại máy, không loại nào chọn sẵn; nói rõ thiết bị mới chỉ thấy tin gửi sau khi được thêm");
  await shot(A.page, "02-dang-ky-thiet-bi");
  await A.page.check("form[data-msg-form=device] input[value=LAPTOP]");
  await A.page.click("form[data-msg-form=device] button[type=submit]");
  await A.page.waitForSelector(".msg-panes:not([hidden])");
  const register = wire.find((w) => w.path === "/v1/messages/endpoints" && w.method === "POST");
  ok(Object.keys(JSON.parse(register.body)).sort().join() === "kind,public_key" && JSON.parse(register.body).kind === "LAPTOP", "đăng ký chỉ gửi khóa công khai và loại máy đã chọn: không tên máy, không user agent");
  const keyState = await A.page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("lenhip.msg.v1.dev_a");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const device = await new Promise((res) => {
      const r = db.transaction("kv").objectStore("kv").get("device");
      r.onsuccess = () => res(r.result);
    });
    db.close();
    let exported = "không ném lỗi";
    try {
      await crypto.subtle.exportKey("jwk", device.privateKey);
    } catch (e) {
      exported = e.name;
    }
    return { type: device.privateKey.type, extractable: device.privateKey.extractable, exported, endpoint: device.endpoint_id.slice(0, 4), kind: device.kind };
  });
  ok(keyState.type === "private" && keyState.extractable === false && keyState.exported === "InvalidAccessError" && keyState.endpoint === "mep_" && keyState.kind === "LAPTOP", "khóa riêng nằm trong IndexedDB của trình duyệt và không xuất được");
  ok((await text(A.page, ".msg-list")).includes("Chưa có hội thoại nào") && (await text(A.page, ".msg-list")).includes("Chưa có ai khác để mời"), "chưa ai khác bật nhắn tin: danh sách trống, nói rõ");

  // ---------------------------------------------------------------- B (điện thoại): đồng ý, đăng ký; A mời, B chấp nhận
  const B = await t.open({ modules: { messaging: true }, viewport: PHONE });
  watch(B.page, "B");
  await signInAs(B.page, "dev_b");
  await openMessages(B.page);
  await consentAndRegister(B.page, "PHONE");
  // A rời màn hình rồi quay lại: màn hình được mount mới và nạp lại danh sách người có thể nhắn tin.
  await A.page.click("#desktop-nav button[data-nav=home]");
  await A.page.click("#desktop-nav button[data-nav=messages]");
  await A.page.waitForSelector("[data-msg-invite=dev_b]");
  ok((await text(A.page, ".msg-people")).includes("Thử nghiệm B") && !(await text(A.page, ".msg-people")).includes("Vận hành"), "người có thể nhắn tin: chỉ thành viên đã bật nhắn tin và có thiết bị");
  await A.page.click("[data-msg-invite=dev_b]");
  await A.page.waitForSelector(".msg-state [data-msg-op=withdraw]");
  ok((await text(A.page, ".msg-state")).includes("Đã gửi lời mời · chờ Thử nghiệm B trả lời") && (await A.page.isHidden(".msg-composer")), "A gửi lời mời: «Đã gửi lời mời · chờ trả lời», chưa có ô soạn");
  ok(wire.filter((w) => w.path === "/v1/messages/threads" && w.method === "POST").every((w) => w.body === '{"peer":"dev_b"}'), "lời mời không kèm chữ nào");
  // B đang ở danh sách (không mở hội thoại nào): huy hiệu xuất hiện trong một nhịp 15 giây.
  await B.page.waitForSelector("#mobile-nav [data-nav=messages] .nav-badge", { timeout: 20000 });
  const badge = await B.page.$eval("#mobile-nav [data-nav=messages] .nav-badge", (e) => e.textContent + "|" + e.getAttribute("aria-label"));
  ok(badge === "1|1 mục mới trong Tin nhắn", "B thấy huy hiệu trên mục Tin nhắn: chỉ một con số");
  ok((await B.page.getAttribute(".msg-root", "data-msg-pane")) === "list" && (await B.page.isHidden(".msg-thread")), "điện thoại: đang ở danh sách, khung hội thoại ẩn");
  await shot(B.page, "03-dien-thoai-danh-sach");
  await B.page.click(".msg-item");
  await B.page.waitForSelector(".msg-state [data-msg-op=accept]");
  const invite = await B.page.evaluate(() => ({ state: document.querySelector(".msg-state").textContent, buttons: [...document.querySelectorAll(".msg-state button")].map((b) => b.textContent), pane: document.querySelector(".msg-root").dataset.msgPane, listHidden: getComputedStyle(document.querySelector(".msg-list")).display === "none", back: !!document.querySelector(".msg-back")?.getClientRects().length }));
  ok(invite.state.includes("Lời mời nhắn tin từ Thử nghiệm A") && invite.buttons.join() === "Chấp nhận,Từ chối,Chặn" && invite.pane === "thread" && invite.listHidden && invite.back, "điện thoại: mở lời mời thì vào khung hội thoại có nút quay lại; ba lựa chọn Chấp nhận, Từ chối, Chặn");
  await shot(B.page, "04-dien-thoai-loi-moi");
  await B.page.click(".msg-state [data-msg-op=accept]");
  await B.page.waitForSelector(".msg-composer:not([hidden])");
  await A.page.waitForSelector(".msg-composer:not([hidden])", { timeout: 8000 });
  ok(true, "B chấp nhận: cả hai có ô soạn (A thấy trong một nhịp 3 giây)");

  // ---------------------------------------------------------------- gửi, tới trong một nhịp, trạng thái theo bằng chứng
  const sentAt = Date.now();
  await send(A.page, FIRST);
  await waitBubble(A.page, FIRST, null);
  await waitBubble(B.page, FIRST, "RECEIVED", 6000);
  const arrival = Date.now() - sentAt;
  ok(arrival < 6000, `tin tới thiết bị của B trong một nhịp thăm dò (${arrival} ms)`);
  await waitBubble(A.page, FIRST, "DELIVERED", 8000);
  const aBubbles = await bubbles(A.page);
  ok(aBubbles.length === 1 && aBubbles[0].mine && aBubbles[0].label === "Đã tới thiết bị", "A: «Đã tới thiết bị» sau khi thiết bị của B xác nhận đã lưu");
  ok((await A.page.inputValue("#msg-input")) === "" && (await A.page.evaluate(() => document.activeElement?.id)) === "msg-input", "sau khi gửi: ô soạn trống và vẫn giữ focus");
  const bBubble = await B.page.$eval(".msg-log .msg-bubble", (e) => ({ dir: e.querySelector(".msg-text").getAttribute("dir"), links: e.querySelectorAll("a").length, html: e.querySelector(".msg-text").children.length }));
  ok(bBubble.dir === "auto" && bBubble.links === 0 && bBubble.html === 0, "bong bóng: dir=auto, chữ thuần, không có liên kết");
  await shot(A.page, "05-may-tinh-hoi-thoai");
  await shot(B.page, "06-dien-thoai-hoi-thoai");

  // ---------------------------------------------------------------- bàn phím trong ô soạn: Shift+Enter, bộ gõ (IME)
  await A.page.fill("#msg-input", "dòng một");
  await A.page.press("#msg-input", "Shift+Enter");
  await A.page.keyboard.type("dòng hai");
  const multi = await A.page.inputValue("#msg-input");
  ok(multi === "dòng một\ndòng hai" && (await bubbles(A.page)).length === 1, "Shift+Enter xuống dòng, không gửi");
  await A.page.$eval("#msg-input", (box) => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));
  });
  await A.page.waitForTimeout(400);
  ok((await bubbles(A.page)).length === 1 && (await A.page.inputValue("#msg-input")) === multi, "Enter trong lúc bộ gõ đang ghép chữ không gửi tin");
  await A.page.press("#msg-input", "Enter");
  await waitBubble(B.page, multi, "RECEIVED");
  ok((await bubbles(A.page)).length === 2, "Enter gửi tin hai dòng");

  // ---------------------------------------------------------------- B trả lời; «Đã xem» chỉ khi người đọc bật chia sẻ
  await send(B.page, "Ok, 15:00.");
  await waitBubble(A.page, "Ok, 15:00.", "RECEIVED");
  await waitBubble(A.page, multi, "DELIVERED");
  await A.page.waitForTimeout(3500);
  ok((await bubbles(A.page)).filter((b) => b.mine).every((b) => b.status === "DELIVERED"), "B đã đọc nhưng chưa bật chia sẻ: A chỉ thấy «Đã tới thiết bị»");
  await B.page.click("[data-msg-back]");
  ok((await B.page.getAttribute(".msg-root", "data-msg-pane")) === "list" && !(await B.page.isChecked("[data-msg-share]")) && (await B.page.evaluate(() => document.activeElement?.matches(".msg-item"))), "điện thoại: nút quay lại về danh sách, focus về đúng hội thoại; chia sẻ «đã xem» mặc định tắt");
  await B.page.check("[data-msg-share]");
  await B.page.click(".msg-item");
  await send(A.page, "Tin sau khi B bật chia sẻ");
  await waitBubble(A.page, "Tin sau khi B bật chia sẻ", "READ", 12000);
  ok((await bubbles(A.page)).filter((b) => b.mine).map((b) => b.label).join() === "Đã xem,Đã xem,Đã xem", "B bật chia sẻ rồi đọc: A thấy «Đã xem»");

  // ---------------------------------------------------------------- huy hiệu và câu báo: không tên, không nội dung
  await A.page.click("#desktop-nav button[data-nav=home]");
  await send(B.page, "Tin khi A ở màn hình khác SECRET-TOAST");
  await A.page.waitForSelector("#toast:not([hidden])", { timeout: 20000 });
  const toast = await A.page.textContent("#toast");
  const aBadge = await A.page.$eval("#desktop-nav [data-nav=messages] .nav-badge", (e) => e.textContent + "|" + e.getAttribute("aria-label"));
  ok(toast === "Bạn có tin nhắn mới." && aBadge === "1|1 mục mới trong Tin nhắn", "A đang ở Hôm nay: câu báo đúng «Bạn có tin nhắn mới.» và huy hiệu 1, trong một nhịp 15 giây");
  ok(!(await text(A.page, "body")).includes("SECRET-TOAST") && !toast.includes("Thử nghiệm"), "câu báo và trang không có tên người gửi hay chữ của tin");
  await shot(A.page, "07-huy-hieu");

  // ---------------------------------------------------------------- nạp lại trang: lịch sử mở lại từ kho của thiết bị
  await A.page.reload();
  await t.ready(A.page);
  await t.dismissNotice(A.page);
  await openMessages(A.page);
  await A.page.click(".msg-item");
  await waitBubble(A.page, "Tin khi A ở màn hình khác SECRET-TOAST", "RECEIVED");
  const history = await bubbles(A.page);
  ok(history.map((b) => b.text).join("|") === [FIRST, multi, "Ok, 15:00.", "Tin sau khi B bật chia sẻ", "Tin khi A ở màn hình khác SECRET-TOAST"].join("|") && history.map((b) => b.mine).join() === "true,true,false,true,false", "nạp lại trang: cả năm tin mở lại được từ phong bì đã lưu trên thiết bị, đúng thứ tự");
  await A.page.waitForFunction(() => !document.querySelector("#desktop-nav [data-nav=messages] .nav-badge"), null, { timeout: 8000 });
  ok(true, "mở hội thoại thì huy hiệu hết");

  // ---------------------------------------------------------------- render nền giữ bản nháp, con trỏ và focus
  const DRAFT = "nháp đang gõ dở";
  await A.page.click("#msg-input");
  await A.page.keyboard.type(DRAFT);
  await A.page.evaluate(() => {
    const box = document.getElementById("msg-input");
    box.setSelectionRange(4, 9);
    window.__box = box;
  });
  const draft = () => A.page.evaluate(() => {
    const box = document.getElementById("msg-input");
    return { same: box === window.__box, value: box.value, focused: document.activeElement === box, selection: box.selectionStart + "-" + box.selectionEnd };
  });
  await send(B.page, "Tin tới khi A đang soạn");
  await waitBubble(A.page, "Tin tới khi A đang soạn", "RECEIVED");
  const whileTyping = await draft();
  ok(whileTyping.same && whileTyping.value === DRAFT && whileTyping.focused && whileTyping.selection === "4-9", "tin mới tới và trang vẽ lại nền: ô soạn không bị dựng lại, chữ, con trỏ và focus còn nguyên");
  await t.chooseSettings(A.page, { theme: "night" });
  const afterSettings = await draft();
  ok(afterSettings.same && afterSettings.value === DRAFT, "lưu Cá nhân hóa (vẽ lại cả trang): bản nháp còn nguyên");
  await A.page.waitForTimeout(900);
  await A.page.reload();
  await t.ready(A.page);
  await openMessages(A.page);
  await A.page.click(".msg-item");
  await A.page.waitForFunction((v) => document.getElementById("msg-input")?.value === v, DRAFT, { timeout: 8000 });
  ok(true, "nạp lại trang: bản nháp được trả lại từ kho của thiết bị");
  await A.page.fill("#msg-input", "");
  await t.chooseSettings(A.page, { theme: "orbit" });

  // ---------------------------------------------------------------- thiết bị thứ hai của B (ngữ cảnh thứ ba, máy tính bảng)
  const C = await t.open({ modules: { messaging: true }, viewport: TABLET, collectErrors: false });
  soft(C.page, "C");
  watch(C.page, "C");
  await signInAs(C.page, "dev_b");
  await openMessages(C.page);
  await C.page.waitForSelector("form[data-msg-form=device]");
  ok((await C.page.$("form[data-msg-form=consent]")) === null, "thiết bị thứ hai của B: đã đồng ý rồi, chỉ còn bước đăng ký thiết bị");
  await C.page.check("form[data-msg-form=device] input[value=TABLET]");
  await C.page.click("form[data-msg-form=device] button[type=submit]");
  await C.page.waitForSelector(".msg-panes:not([hidden]) .msg-item");
  await C.page.click(".msg-item");
  await C.page.waitForSelector(".msg-composer:not([hidden])");
  ok((await bubbles(C.page)).length === 0 && (await text(C.page, ".msg-thread")).includes("Chưa có tin nào trên thiết bị này"), "thiết bị mới không có lịch sử");
  await A.page.waitForSelector("[data-msg-devices-changed]", { timeout: 8000 });
  ok((await text(A.page, "[data-msg-devices-changed]")).includes("Danh sách thiết bị đã đổi."), "A thấy «Danh sách thiết bị đã đổi.» trong một nhịp, trước khi gửi tin kế tiếp");
  await shot(A.page, "08-thiet-bi-da-doi");
  await send(A.page, "Tin sau khi B thêm máy");
  await waitBubble(C.page, "Tin sau khi B thêm máy", "RECEIVED");
  await waitBubble(B.page, "Tin sau khi B thêm máy", "RECEIVED");
  ok((await bubbles(C.page)).map((b) => b.text).join("|") === "Tin sau khi B thêm máy", "thiết bị mới chỉ thấy tin gửi sau khi nó được thêm; thiết bị cũ của B cũng nhận tin đó");
  await shot(C.page, "09-may-tinh-bang");

  // ---------------------------------------------------------------- mã an toàn
  await A.page.click("[data-msg-devices-changed] [data-msg-safety]");
  await A.page.waitForSelector("#action-dialog[open] .msg-safety-code");
  const codeA = await A.page.$eval(".msg-safety-code", (e) => e.textContent);
  const safetyText = await text(A.page, "#action-body");
  ok(/^\d{30}$/.test(codeA) && (await A.page.$$eval(".msg-safety-code span", (els) => els.length)) === 6 && safetyText.includes("bạn 1, Thử nghiệm B 2") && safetyText.includes("Chưa đánh dấu so khớp"), "mã an toàn: 30 chữ số trong sáu nhóm, số thiết bị của hai bên, chưa so khớp");
  await shot(A.page, "10-ma-an-toan");
  await A.page.click("#action-body [data-msg-confirm]");
  await A.page.waitForFunction(() => document.querySelector("#action-body [data-msg-verified]")?.textContent.includes("đã so khớp"));
  await A.page.click("#action-dialog [data-action=close-action]");
  ok((await A.page.$("[data-msg-devices-changed]")) === null, "đánh dấu đã so khớp: thông báo thiết bị đổi được gỡ");
  await B.page.click(".msg-menu summary");
  await B.page.click(".msg-menu [data-msg-safety]");
  await B.page.waitForSelector("#action-dialog[open] .msg-safety-code");
  ok((await B.page.$eval(".msg-safety-code", (e) => e.textContent)) === codeA, "B thấy đúng mã an toàn đó");
  await B.page.click("#action-dialog [data-action=close-action]");

  // ---------------------------------------------------------------- mất mạng khi đang gửi: một POST, «chưa rõ», thử lại → đúng một tin
  const LOST = "Tin gửi lúc mất mạng";
  const posts = () => wire.filter((w) => w.who === "A" && w.method === "POST" && /\/messages$/.test(w.path));
  const before = posts().length;
  await A.context.setOffline(true);
  await send(A.page, LOST);
  await waitBubble(A.page, LOST, "UNCERTAIN");
  const lost = await A.page.$eval(".msg-bubble[data-status=UNCERTAIN]", (e) => ({ label: e.querySelector(".msg-status").textContent, note: e.querySelector(".msg-status-note").textContent, buttons: [...e.querySelectorAll("button")].map((b) => b.textContent) }));
  ok(lost.label === "Chưa rõ đã gửi hay chưa" && lost.buttons.join() === "Thử lại" && lost.note.includes("không tự gửi lại"), "mất mạng khi gửi: «Chưa rõ đã gửi hay chưa» kèm «Thử lại», không báo «không gửi được»");
  await shot(A.page, "11-chua-ro");
  await A.page.waitForTimeout(4500);
  ok(posts().length === before + 1, "đúng một POST khi mất mạng; chờ hơn một nhịp vẫn không có POST thứ hai");
  await A.context.setOffline(false);
  await A.page.waitForTimeout(5000);
  ok(posts().length === before + 1 && (await A.page.$(".msg-bubble[data-status=UNCERTAIN]")) !== null, "có mạng lại: vẫn không tự gửi lại, tin vẫn «chưa rõ»");
  await A.page.click(".msg-bubble[data-status=UNCERTAIN] [data-msg-retry]");
  await waitBubble(B.page, LOST, "RECEIVED");
  await A.page.waitForFunction(() => !document.querySelector(".msg-bubble[data-status=UNCERTAIN]"), null, { timeout: 8000 });
  const [try1, try2] = posts().slice(before);
  ok(posts().length === before + 2 && try1.key === try2.key && try1.body === try2.body && try1.body.length > 300, "«Thử lại»: đúng Idempotency-Key cũ và đúng các byte cũ");
  await B.page.waitForTimeout(3500);
  const copies = async (page) => (await bubbles(page)).filter((b) => b.text === LOST).length;
  ok((await copies(B.page)) === 1 && (await copies(C.page)) === 1 && (await copies(A.page)) === 1, "bên kia nhận đúng một tin, trên cả hai thiết bị");

  // ---------------------------------------------------------------- báo cáo không kèm nội dung; chặn, bỏ chặn, mời lại
  await B.page.click(".msg-menu summary");
  await B.page.click(".msg-menu [data-msg-report]");
  await B.page.waitForSelector("#action-dialog[open] form[data-msg-form=report]");
  const reportForm = await B.page.evaluate(() => ({ free: document.querySelectorAll("#action-body textarea, #action-body input:not([type=radio])").length, text: document.getElementById("action-body").textContent }));
  ok(reportForm.free === 0 && reportForm.text.includes("Nội dung tin nhắn không được gửi kèm"), "báo cáo: chỉ chọn lý do, không có ô nào để nhập chữ");
  await B.page.check("form[data-msg-form=report] input[value=HARASSMENT]");
  await B.page.click("form[data-msg-form=report] button[type=submit]");
  await B.page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  const report = JSON.parse(wire.find((w) => w.path === "/v1/messages/reports").body);
  ok(Object.keys(report).sort().join() === "reason,thread_id" && report.reason === "HARASSMENT", "báo cáo chỉ mang mã hội thoại và lý do");
  await B.page.click(".msg-menu summary");
  await B.page.click(".msg-menu [data-msg-block]");
  await B.page.click("#action-body [data-msg-confirm]");
  await B.page.waitForSelector(".msg-state [data-msg-op=unblock]");
  await A.page.waitForFunction(() => document.querySelector(".msg-state")?.textContent.includes("Hội thoại đã đóng"), null, { timeout: 8000 });
  const closed = await A.page.evaluate(() => ({ composer: document.querySelector(".msg-composer").hidden, reinvite: !!document.querySelector("[data-msg-reinvite]"), text: document.querySelector(".msg-thread").textContent, history: document.querySelectorAll(".msg-log .msg-bubble").length }));
  ok(closed.composer && !closed.reinvite && !/chặn/i.test(closed.text.replace("Chặn", "")) && closed.history >= 6, "B chặn: A chỉ thấy «Hội thoại đã đóng», không có ô soạn hay nút mời lại; lịch sử trên thiết bị của A còn nguyên");
  await B.page.click(".msg-state [data-msg-op=unblock]");
  await B.page.waitForSelector("[data-msg-reinvite]");
  await B.page.click("[data-msg-reinvite]");
  await A.page.waitForSelector(".msg-state [data-msg-op=accept]", { timeout: 8000 });
  await A.page.click(".msg-state [data-msg-op=accept]");
  await A.page.waitForSelector(".msg-composer:not([hidden])");
  await B.page.waitForSelector(".msg-composer:not([hidden])", { timeout: 8000 });
  ok(true, "B bỏ chặn và mời lại, A chấp nhận: hội thoại mở lại");

  // ---------------------------------------------------------------- chỉ dùng bàn phím
  const tab = async (page, selector, key = "Tab", max = 80) => {
    for (let i = 0; i < max; i++) {
      await page.keyboard.press(key);
      if (await page.evaluate((s) => document.activeElement?.matches(s) ?? false, selector)) return true;
    }
    return false;
  };
  await A.page.click("#desktop-nav button[data-nav=home]");
  await A.page.evaluate(() => document.querySelector("#desktop-nav button[data-nav=home]").focus());
  ok(await tab(A.page, "#desktop-nav button[data-nav=messages]"), "bàn phím: Tab tới mục Tin nhắn");
  await A.page.keyboard.press("Enter");
  await A.page.waitForSelector("body[data-view=messages] .msg-item");
  ok(await tab(A.page, ".msg-item"), "bàn phím: Tab tới hội thoại trong danh sách");
  await A.page.keyboard.press("Enter");
  await A.page.waitForFunction(() => document.activeElement?.id === "msg-input");
  await A.page.keyboard.type("Gửi bằng bàn phím");
  await A.page.keyboard.press("Enter");
  await waitBubble(B.page, "Gửi bằng bàn phím", "RECEIVED");
  ok(await tab(A.page, ".msg-menu summary", "Shift+Tab"), "bàn phím: Shift+Tab từ ô soạn về nút Tùy chọn");
  await A.page.keyboard.press("Enter");
  ok(await tab(A.page, ".msg-menu [data-msg-safety]"), "bàn phím: mở Tùy chọn, Tab tới «Mã an toàn»");
  await A.page.keyboard.press("Enter");
  await A.page.waitForSelector("#action-dialog[open] .msg-safety-code");
  await A.page.keyboard.press("Escape");
  await A.page.waitForSelector("#action-dialog:not([open])", { state: "attached" });
  ok(await A.page.evaluate(() => document.activeElement?.matches(".msg-menu summary")), "bàn phím: Escape đóng hộp mã an toàn, focus về nút Tùy chọn");

  // ---------------------------------------------------------------- «Thiết bị của tôi» (màn hình Kết nối)
  await B.page.evaluate(() => {
    location.hash = "#connect";
  });
  await B.page.waitForFunction(() => document.querySelectorAll(".connect-section[data-section=endpoints] .endpoint-row").length === 2, null, { timeout: 8000 });
  const section = await B.page.evaluate(() => {
    const s = document.querySelector(".connect-section[data-section=endpoints]");
    return { title: s.querySelector("h2").textContent, rows: [...s.querySelectorAll(".endpoint-row")].map((r) => r.querySelector(".endpoint-copy").textContent), count: s.querySelector("[data-endpoint=count]").textContent, text: s.textContent, form: !!s.querySelector("[data-endpoint-form]"), inputs: s.querySelectorAll("input, textarea, select").length };
  });
  ok(section.title === "Thiết bị của tôi" && section.count === "2/5" && section.rows.filter((r) => /^Điện thoại\s*Thiết bị này\s*Thêm ngày \d{2}\/\d{2}\/\d{4}$/.test(r)).length === 1 && section.rows.filter((r) => /^Máy tính bảng\s*Thêm ngày \d{2}\/\d{2}\/\d{4}$/.test(r)).length === 1,
    "Thiết bị của tôi: hai thiết bị của B với loại máy và ngày thêm, đúng một dòng «Thiết bị này», đếm 2/5 — " + JSON.stringify(section.rows));
  ok(section.text.includes("Thiết bị mới chỉ thấy tin nhắn gửi sau khi được thêm.") && section.text.includes("Dữ liệu sức khỏe ở lại trên từng thiết bị và không được đồng bộ giữa các thiết bị.") && !section.form && section.inputs === 0, "có câu về thiết bị mới và câu dữ liệu sức khỏe không đồng bộ; trình duyệt đã đăng ký thì không có gì để sửa");
  await shot(B.page, "12-thiet-bi-cua-toi", true);
  await B.page.click(".endpoint-row:not(:has(.tiny-pill)) [data-endpoint-revoke]");
  await B.page.waitForSelector("#action-dialog[open] [data-endpoint-confirm]");
  ok((await text(B.page, "#action-body")).includes("Thiết bị đó sẽ không nhận được tin mới") && (await B.page.$$eval(".endpoint-row", (els) => els.length)) === 2, "«Gỡ» hỏi lại trước; chưa xác nhận thì chưa có gì đổi");
  await B.page.click("[data-endpoint-confirm]");
  await B.page.waitForFunction(() => document.querySelectorAll(".endpoint-row").length === 1 && document.querySelector("[data-endpoint=count]").textContent === "1/5", null, { timeout: 8000 });
  await C.page.waitForSelector("form[data-msg-form=device]", { timeout: 20000 });
  const removed = await C.page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("lenhip.msg.v1.dev_b");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    let rows = 0;
    for (const name of db.objectStoreNames) rows += await new Promise((res) => {
      const r = db.transaction(name).objectStore(name).count();
      r.onsuccess = () => res(r.result);
    });
    db.close();
    return { rows, text: document.querySelector(".msg-step").textContent };
  });
  ok(removed.rows === 0 && removed.text.includes("Thiết bị này đã bị gỡ khỏi tài khoản"), "thiết bị bị gỡ: trong một nhịp nó nói rõ đã bị gỡ; khóa và lịch sử trên máy đó đã bị xóa");
  // Trình duyệt chưa đăng ký: đăng ký ngay trong phần Thiết bị của tôi.
  await C.page.evaluate(() => {
    location.hash = "#connect";
  });
  await C.page.waitForSelector(".connect-section[data-section=endpoints] [data-endpoint-form]");
  ok((await C.page.$$eval(".endpoint-row", (els) => els.map((e) => e.textContent.includes("Thiết bị này")))).join() === "false" && (await text(C.page, "[data-endpoint-form]")).includes("Trình duyệt này chưa được đăng ký"), "trình duyệt chưa đăng ký: thấy thiết bị kia của mình và ô đăng ký trình duyệt này");
  await C.page.check("[data-endpoint-form] input[value=TABLET]");
  await C.page.click("[data-endpoint-form] button[type=submit]");
  await C.page.waitForFunction(() => document.querySelectorAll(".endpoint-row").length === 2 && !document.querySelector("[data-endpoint-form]") && document.querySelectorAll(".endpoint-row .tiny-pill").length === 1, null, { timeout: 8000 });
  ok(true, "đăng ký từ phần Thiết bị của tôi: thêm một dòng «Thiết bị này», ô đăng ký biến mất");
  await A.page.click("#desktop-nav button[data-nav=connect]");
  await A.page.waitForSelector(".connect-section[data-section=endpoints] .endpoint-row");
  ok((await A.page.$$eval(".endpoint-row .endpoint-copy", (els) => els.map((e) => e.textContent))).every((r) => r.startsWith("Máy tính xách tay")) && (await A.page.textContent("[data-endpoint=count]")) === "1/5" && !(await text(A.page, ".connect-section[data-section=endpoints]")).includes("Điện thoại"), "A chỉ thấy thiết bị của chính mình");

  // ---------------------------------------------------------------- bố cục: năm phong cách, ba cỡ, chữ 200 %
  /** Lỗi bố cục của màn hình Tin nhắn: tràn ngang, phần tử lọt ngoài khung, vùng bấm dưới 44 px, chữ tương phản dưới 4,5:1. */
  const problems = (page) => page.evaluate(() => {
    const out = [];
    const root = document.querySelector(".msg-root");
    const vw = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > vw) out.push("trang tràn ngang " + (document.documentElement.scrollWidth - vw) + " px");
    // Nội dung của một <details> đang đóng vẫn có hộp trong Chromium nhưng không hiện: bỏ qua nó (nút <summary> thì luôn hiện).
    const shown = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden" && (e.matches("summary") || !e.closest("details:not([open])"));
    for (const e of root.querySelectorAll("button, summary, textarea, input, a[href]")) {
      if (!shown(e)) continue;
      const r = e.getBoundingClientRect();
      const name = (e.getAttribute("aria-label") || e.textContent || e.name || e.tagName).trim().slice(0, 28);
      // Ô chọn: vùng bấm là cả nhãn bọc nó.
      const box = e.matches("input[type=checkbox], input[type=radio]") ? e.closest("label").getBoundingClientRect() : r;
      if (box.height < 44 || box.width < 44) out.push(name + " chỉ " + Math.round(box.width) + "×" + Math.round(box.height) + " px");
      if (r.left < -0.5 || r.right > vw + 0.5) out.push(name + " lọt ngoài khung");
    }
    for (const e of root.querySelectorAll(".msg-bubble, .msg-item, .msg-state, .msg-head, .msg-note, .msg-list, .msg-thread")) {
      if (shown(e) && e.scrollWidth > e.clientWidth + 1) out.push("nội dung tràn trong ." + e.className.split(" ").join("."));
    }
    const rgb = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = (c) => {
      const [r, g, b] = rgb(c).map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const solid = (e) => {
      for (let x = e; x; x = x.parentElement) {
        const bg = getComputedStyle(x).backgroundColor;
        if (bg && !/rgba\(.*,\s*0\)|transparent/.test(bg)) return bg;
      }
      return "rgb(255,255,255)";
    };
    for (const e of root.querySelectorAll(".msg-text, .msg-status, .msg-time, .msg-item-copy strong, .msg-title, .msg-state p")) {
      if (!shown(e)) continue;
      const a = lum(getComputedStyle(e).color);
      const b = lum(solid(e));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 4.5) out.push("tương phản " + ratio.toFixed(2) + " ở ." + e.className);
    }
    return [...new Set(out)];
  });
  const panes = (page) => page.evaluate(() => ({ list: document.querySelector(".msg-list").getClientRects().length > 0, thread: document.querySelector(".msg-thread").getClientRects().length > 0, back: (document.querySelector(".msg-back")?.getClientRects().length ?? 0) > 0, layout: document.body.dataset.layout }));
  await A.page.click("#desktop-nav button[data-nav=messages]");
  await A.page.click(".msg-item");
  await A.page.waitForSelector(".msg-log .msg-bubble");
  for (const theme of THEMES) {
    await t.chooseSettings(A.page, { theme, fontSize: 100 });
    // Màu đổi có chuyển tiếp: chờ nó xong rồi mới đo tương phản.
    await A.page.waitForTimeout(600);
    const found = [...(await problems(A.page)), ...(await t.navSpill(A.page))];
    const p = await panes(A.page);
    ok(found.length === 0 && p.list && p.thread && !p.back && p.layout === "wide", `1440×900 · ${theme}: danh sách và hội thoại cạnh nhau, không tràn, vùng bấm từ 44 px, chữ tương phản từ 4,5:1` + (found.length ? " — " + found.join("; ") : ""));
    if (theme === "night" || theme === "titanium") await shot(A.page, "13-" + theme);
  }
  await t.chooseSettings(A.page, { theme: "orbit", fontSize: 100 });
  for (const [name, viewport] of [["điện thoại", PHONE], ["máy tính bảng", TABLET], ["máy tính", DESKTOP]]) {
    await A.page.setViewportSize(viewport);
    await A.page.waitForTimeout(250);
    const inThread = [...(await problems(A.page)), ...(await t.navSpill(A.page))];
    const p = await panes(A.page);
    const narrow = viewport.width <= 980;
    let inList = [];
    if (narrow) {
      await A.page.click("[data-msg-back]");
      inList = await problems(A.page);
      ok((await panes(A.page)).list && !(await panes(A.page)).thread, `${name}: nút quay lại về danh sách, khung hội thoại ẩn`);
      await A.page.click(".msg-item");
    }
    ok(inThread.length === 0 && inList.length === 0 && p.thread && p.list === !narrow && p.back === narrow, `${name} ${viewport.width}×${viewport.height}: ${narrow ? "một khung, có nút quay lại" : "hai khung"}, không tràn, vùng bấm từ 44 px` + (inThread.length + inList.length ? " — " + [...inThread, ...inList].join("; ") : ""));
  }
  for (const [name, viewport] of [["điện thoại", PHONE], ["máy tính", DESKTOP]]) {
    await A.page.setViewportSize(viewport);
    await t.chooseSettings(A.page, { fontSize: 200 });
    await A.page.waitForTimeout(250);
    const inThread = [...(await problems(A.page)), ...(await t.navSpill(A.page))];
    const p = await panes(A.page);
    await shot(A.page, "14-chu-200-" + viewport.width, true);
    await A.page.click("[data-msg-back]");
    const inList = await problems(A.page);
    await A.page.click(".msg-item");
    ok(inThread.length === 0 && inList.length === 0 && p.thread && !p.list && p.back, `${name} ${viewport.width}×${viewport.height} · chữ 200 %: một khung ở mọi bề ngang, không tràn, vùng bấm từ 44 px` + (inThread.length + inList.length ? " — " + [...inThread, ...inList].join("; ") : ""));
  }
  await t.chooseSettings(A.page, { fontSize: 100 });
  await A.page.setViewportSize(DESKTOP);

  // ---------------------------------------------------------------- không yêu cầu nào và không kho nào mang bản rõ
  const PLAIN = [MARKER, "dòng hai", "Ok, 15:00.", "Tin sau khi B bật chia sẻ", "SECRET-TOAST", "Tin tới khi A đang soạn", DRAFT, "Tin sau khi B thêm máy", LOST, "Gửi bằng bàn phím"];
  const leaks = wire.filter((w) => PLAIN.some((p) => w.body.includes(p) || decodeURIComponent(w.url).includes(p)));
  const sends = wire.filter((w) => w.method === "POST" && /\/v1\/messages\/threads\/[^/]+\/messages$/.test(w.path));
  ok(sends.length >= 9 && wire.length > 200 && leaks.length === 0, `quét ${wire.length} yêu cầu của ba trang (${sends.length} lần gửi tin): không thân hay địa chỉ nào mang bản rõ` + (leaks.length ? " — " + leaks.map((w) => w.method + " " + w.path).join(", ") : ""));
  ok(sends.every((w) => Object.keys(JSON.parse(w.body)).sort().join() === "client_ref,ct,envelopes,iv,key_set,sender_endpoint" && w.key), "mỗi lần gửi chỉ có các trường của LNH-MSG-1 và một Idempotency-Key");
  const stored = await A.page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open("lenhip.msg.v1.dev_a");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const out = {};
    for (const name of db.objectStoreNames) out[name] = await new Promise((res) => {
      const r = db.transaction(name).objectStore(name).getAll();
      r.onsuccess = () => res(r.result);
    });
    db.close();
    return { json: JSON.stringify(out), messages: out.messages.length, stores: Object.keys(out).sort().join() };
  });
  ok(stored.stores === "kv,messages,peers,threads" && stored.messages >= 9 && !PLAIN.some((p) => stored.json.includes(p)), `kho IndexedDB của A (${stored.messages} phong bì, hộp gửi, bản nháp, khóa đã ghim): không có bản rõ`);
  const session = await A.page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  ok(!PLAIN.some((p) => session.includes(p)), "localStorage và sessionStorage không có chữ của tin hay bản nháp");

  // ---------------------------------------------------------------- cờ mô-đun tắt; tiếng Anh
  const off = await t.open({ modules: {}, path: "/#messages" });
  const offWire = [];
  off.page.on("request", (r) => offWire.push(new URL(r.url()).pathname));
  await off.page.reload();
  await t.ready(off.page);
  await off.page.waitForTimeout(2500);
  ok((await off.page.$("[data-nav=messages]")) === null && (await off.page.getAttribute("body", "data-view")) === "home" && offWire.includes("/v1/me") && !offWire.some((p) => p.startsWith("/v1/messages")), "cờ messaging chưa đặt: không có mục Tin nhắn, #messages quay về Hôm nay, không yêu cầu nhắn tin nào");
  await off.context.close();

  const en = await t.open({ modules: { messaging: true }, locale: "en-US" });
  watch(en.page, "en");
  await signInAs(en.page, "dev_ops");
  await openMessages(en.page);
  await en.page.waitForSelector("form[data-msg-form=consent]");
  const english = await text(en.page, ".msg-root");
  ok(english.includes("Messaging with members of your workspace") && english.includes("for 30 days at most") && english.includes("Text version v1-2026-11-11.en") && !/[ăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i.test(english), "tiếng Anh: bước đồng ý dùng catalog en, phiên bản văn bản mang hậu tố .en");
  await en.page.check("form[data-msg-form=consent] input[name=agree]");
  await en.page.click("form[data-msg-form=consent] button[type=submit]");
  await en.page.waitForSelector("form[data-msg-form=device]");
  ok(/"text_version":"v1-2026-11-11\.en"/.test(wire.filter((w) => w.who === "en" && w.path === "/v1/consents").at(-1).body) && (await text(en.page, ".msg-step")).includes("What kind of device is this?"), "tiếng Anh: biên nhận ghi phiên bản .en; bước đăng ký thiết bị bằng tiếng Anh");
  await shot(en.page, "15-tieng-anh");

  ok(softErrors.length === 0, "trang của A và C không có lỗi JavaScript nào ngoài dòng «Failed to load resource» của bước mất mạng và của thiết bị bị gỡ" + (softErrors.length ? ": " + softErrors.join(" | ") : ""));
});
