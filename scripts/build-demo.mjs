// Dựng bản trình diễn tĩnh của LeNhip vào dist-demo/ (hoặc thư mục truyền vào): chạy hoàn toàn trong trình duyệt, không máy chủ.
//   node scripts/build-demo.mjs [thư-mục-đích]
// - Chép mọi tệp của web/ mà ứng dụng nạp (màn hình, mã dùng chung, catalog, icon), trừ index.html và manifest.json.
// - Chép demo/backend.js, demo/boot.js, demo/demo.css vào demo/; đường import ../web/shared/ đổi thành ../shared/ cho đúng bố cục mới.
// - Viết index.html sẵn cho nơi phát hành bọc trang trong khung riêng: không <!doctype>, <html>, <head>, <body>; có <title>, <meta>,
//   <link> và nội dung thân; không liên kết manifest (không cài như ứng dụng, không service worker); demo/boot.js nạp trước app.js.
// - In danh sách tệp và tổng dung lượng. Không tải gì từ mạng, không thêm phụ thuộc.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TITLE = "LeNhip 1.0.1";

/** Dựng vào `out`; trả danh sách { path, bytes } đã ghi. */
export function buildDemo(out = join(ROOT, "dist-demo")) {
  const web = join(ROOT, "web");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(web, out, { recursive: true, filter: (src) => !["index.html", "manifest.json"].includes(relative(web, src)) });

  mkdirSync(join(out, "demo"), { recursive: true });
  const backend = readFileSync(join(ROOT, "demo", "backend.js"), "utf8");
  const rewritten = backend.replaceAll('"../web/shared/', '"../shared/');
  if (/from "\.\.\/web\//.test(rewritten)) throw new Error("demo/backend.js còn đường import tới ../web/ chưa đổi được");
  writeFileSync(join(out, "demo", "backend.js"), rewritten);
  for (const f of ["boot.js", "demo.css"]) cpSync(join(ROOT, "demo", f), join(out, "demo", f));

  writeFileSync(join(out, "index.html"), demoIndex(readFileSync(join(web, "index.html"), "utf8")));
  return listFiles(out);
}

/** index.html của bản trình diễn từ index.html của web/: bỏ khung tài liệu và manifest, thêm tiêu đề, CSS và script của bản trình diễn. */
export function demoIndex(html) {
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1];
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(html)?.[1];
  if (!head || !body) throw new Error("web/index.html không có <head> hoặc <body> như mong đợi");
  const headPart = head
    .replace(/<link rel="manifest"[^>]*>\n?/, "")
    .replace(/<title[^>]*>[^<]*<\/title>/, `<title>${TITLE}</title>`)
    .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="LeNhip 1.0.1 chạy trong trình duyệt, không máy chủ: mọi kết quả là mô phỏng.">')
    .replace('<link rel="stylesheet" href="./styles.css">', '<link rel="stylesheet" href="./styles.css">\n<link rel="stylesheet" href="./demo/demo.css">');
  if (/rel="manifest"/.test(headPart) || !headPart.includes(TITLE)) throw new Error("không đổi được phần đầu của index.html");
  const bodyPart = body.replace('<script type="module" src="./app.js"></script>', '<script type="module" src="./demo/boot.js"></script>\n<script type="module" src="./app.js"></script>');
  if (!bodyPart.includes("./demo/boot.js")) throw new Error("không chèn được demo/boot.js trước app.js");
  const out = `<!-- LeNhip 1.0.1 · bản trình diễn trong trình duyệt (scripts/build-demo.mjs). Không có máy chủ: demo/boot.js trả lời /dev, /v1, /v2 ngay trong trang. -->\n${headPart.trim()}\n${bodyPart.trim()}\n`;
  if (/<!doctype|<\/?(html|head|body)[\s>]/i.test(out)) throw new Error("index.html của bản trình diễn còn thẻ khung tài liệu");
  return out;
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: relative(dir, p).split("\\").join("/"), bytes: statSync(p).size });
    }
  };
  walk(dir);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? join(ROOT, "dist-demo"));
  const files = buildDemo(out);
  for (const f of files) console.log(`${String(f.bytes).padStart(9)}  ${f.path}`);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  console.log(`\n${files.length} tệp, ${(total / 1024 / 1024).toFixed(2)} MB (${total} byte) trong ${relative(process.cwd(), out) || "."}`);
  if (total > 16 * 1024 * 1024) {
    console.error("vượt 16 MB");
    process.exit(1);
  }
}
