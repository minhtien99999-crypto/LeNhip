// Điểm vào của bản trình diễn trong trình duyệt: cài bản giả của API (backend.js) rồi dải «Bản trình diễn» cố định ở đầu trang.
// Nạp TRƯỚC app.js (index.html của dist-demo đặt thẻ script này trước). Không gọi mạng, không gửi gì ra khỏi trang.
//
// Dải thông báo: chữ tiếng Việt, tiếng Anh khi ngôn ngữ giao diện không phải tiếng Việt (đọc thuộc tính lang mà app.js đặt).
// Nó chiếm chỗ của riêng mình ở đầu trang (trang được đẩy xuống đúng chiều cao của dải), nên không che thanh dưới của điện thoại,
// thông báo nổi hay nút của hộp thoại (hộp thoại nằm ở lớp trên cùng của trình duyệt).
import { installDemo, STORE_KEY } from "./backend.js";

const backend = installDemo(window);

// Trang được bọc trong khung của nơi phát hành (không có <html>, <body> của riêng nó): đặt lại các thuộc tính mà index.html gốc có.
document.documentElement.setAttribute("translate", "no");
if (!document.documentElement.lang) document.documentElement.lang = "vi";
document.body.classList.add("i18n-pending");
document.body.dataset.demo = "true";

const TEXT = {
  vi: {
    label: "Bản trình diễn",
    note: "Bản trình diễn chạy trong trình duyệt · không có máy chủ · mọi kết quả là mô phỏng · dữ liệu chỉ lưu trên trình duyệt này",
    reset: "Đặt lại bản trình diễn",
    confirm: "Bấm lần nữa để xóa dữ liệu của bản trình diễn",
    step: { survey: "LeLS: khảo sát và báo giá (mô phỏng)", install: "LeLS: lắp hub (mô phỏng)", suspend: "LeLS: tạm ngừng (mô phỏng)", resume: "LeLS: mở lại (mô phỏng)", return_hub: "LeLS: thu hub về (mô phỏng)" },
    done: { survey: "LeLS đã khảo sát: có báo giá để bạn xem.", install: "LeLS đã lắp hub, serial {serial}. Nhập serial này để xác nhận.", suspend: "LeLS đã tạm ngừng dịch vụ.", resume: "LeLS đã mở lại dịch vụ.", return_hub: "LeLS đã thu hub về." },
    region: "Thông tin bản trình diễn",
  },
  en: {
    label: "Demo",
    note: "In-browser demo · no server · every result is simulated · data stays in this browser only",
    reset: "Reset demo",
    confirm: "Click again to erase the demo data",
    step: { survey: "LeLS: survey and quote (simulated)", install: "LeLS: install hub (simulated)", suspend: "LeLS: suspend (simulated)", resume: "LeLS: resume (simulated)", return_hub: "LeLS: collect hub (simulated)" },
    done: { survey: "LeLS surveyed the home: a quote is ready to review.", install: "LeLS installed the hub, serial {serial}. Enter this serial to confirm.", suspend: "LeLS suspended the service.", resume: "LeLS resumed the service.", return_hub: "LeLS collected the hub." },
    region: "Demo information",
  },
};
const text = () => (/^vi\b/i.test(document.documentElement.lang || "vi") ? TEXT.vi : TEXT.en);

const ribbon = document.createElement("aside");
ribbon.className = "demo-ribbon";
ribbon.id = "demo-ribbon";
ribbon.innerHTML =
  '<span class="demo-ribbon-tag"></span><span class="demo-ribbon-note"></span>' +
  '<span class="demo-ribbon-actions"><button type="button" class="demo-ribbon-button" data-demo="step" hidden></button>' +
  '<button type="button" class="demo-ribbon-button" data-demo="reset"></button></span>' +
  '<span class="demo-ribbon-status" role="status" aria-live="polite"></span>';
document.body.prepend(ribbon);

let arming = 0;
let stepCode = null;
let status = "";
function paint() {
  const t = text();
  ribbon.setAttribute("aria-label", t.region);
  ribbon.lang = t === TEXT.vi ? "vi" : "en";
  ribbon.querySelector(".demo-ribbon-tag").textContent = t.label;
  ribbon.querySelector(".demo-ribbon-note").textContent = t.note;
  ribbon.querySelector('[data-demo="reset"]').textContent = arming ? t.confirm : t.reset;
  const step = ribbon.querySelector('[data-demo="step"]');
  step.hidden = !stepCode;
  if (stepCode) step.textContent = t.step[stepCode];
  ribbon.querySelector(".demo-ribbon-status").textContent = status;
}

/** Người đang đăng nhập trong trang (app.js giữ phiên trong sessionStorage). */
function currentSub() {
  try {
    return JSON.parse(sessionStorage.getItem("lenhip.session") ?? "null")?.sub ?? null;
  } catch {
    return null;
  }
}

async function refreshStep() {
  const sub = currentSub();
  const next = sub ? await backend.controls.homeNextLabel(sub) : null;
  if (next !== stepCode) {
    stepCode = next;
    paint();
  }
}

/**
 * Cho các phần đang thăm dò của ứng dụng chạy ngay một nhịp (như khi tab hiện lại), để bước vừa làm hiện ra mà không chờ 10 giây.
 * Không đổi gì của ứng dụng: chỉ phát lại hai sự kiện mà app.js đã nghe.
 */
function nudge() {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
  delete document.hidden;
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("online"));
}

/** Xóa kho tin nhắn trên trình duyệt (IndexedDB `lenhip.msg.v1.<tài khoản>`) của các tài khoản thử; chờ tối đa 1,5 giây. */
function dropMessageStores() {
  const names = ["dev_a", "dev_b", "dev_ops"].map((sub) => `lenhip.msg.v1.${sub}`);
  return Promise.race([
    Promise.all(names.map((name) => new Promise((resolve) => {
      try {
        const r = indexedDB.deleteDatabase(name);
        r.onsuccess = r.onerror = r.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }))),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}

async function resetAll() {
  backend.reset();
  await dropMessageStores();
  for (const area of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      for (const k of Object.keys(area ?? {})) if (k.startsWith("lenhip.") || k === STORE_KEY) area.removeItem(k);
    } catch {
      /* bộ nhớ bị chặn: không có gì để xóa */
    }
  }
  location.reload();
}

ribbon.addEventListener("click", async (e) => {
  const button = /** @type {HTMLElement} */ (e.target).closest?.("button[data-demo]");
  if (!button) return;
  if (button.dataset.demo === "reset") {
    if (arming) return void resetAll();
    arming = window.setTimeout(() => {
      arming = 0;
      paint();
    }, 5000);
    paint();
    return;
  }
  const sub = currentSub();
  if (!sub) return;
  const r = await backend.controls.homeNext(sub);
  status = r ? text().done[r.event].replace("{serial}", r.serial ?? "") : "";
  await refreshStep();
  paint();
  nudge();
});

// Chiều cao của dải (đổi theo bề ngang, cỡ chữ) đẩy trang xuống đúng chừng đó.
const setHeight = () => document.documentElement.style.setProperty("--demo-ribbon-block", Math.ceil(ribbon.getBoundingClientRect().height) + "px");
if (typeof ResizeObserver === "function") new ResizeObserver(setHeight).observe(ribbon);
setHeight();
new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
paint();
window.setInterval(() => void refreshStep(), 1500);
