// Nhận diện LeNhip V1.0.0 (LNH-T20, LNH-F25, LNH-F29, LNH-T50): chữ LeNhip theo từng phong cách là đúng bản vẽ của gói
// nhận diện, đọc được trên nền của phong cách đó; icon ứng dụng là I01, đủ cỡ, nằm trong vùng an toàn của icon maskable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { inflateRawSync, inflateSync } from "node:zlib";
import { THEMES } from "../web/model.js";
import { WORDMARK_THEMES, wordmark, wordmarkCode } from "../web/shared/brand.js";

const web = new URL("../web/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, web));
const text = (path: string) => read(path).toString("utf8");

// ---------------------------------------------------------------- đọc tệp trong gói ZIP gốc (chỉ đọc như dữ liệu)
function zipEntries(zip: Buffer): Map<string, Buffer> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "không thấy mục lục ZIP");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50, "mục lục ZIP hỏng");
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + packed);
    if (!name.endsWith("/")) out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
const pkg = zipEntries(readFileSync(new URL("../docs/source/LeNhip_05_Logo_05_Icon.zip", import.meta.url)));
const SOURCE: Record<string, string> = {
  orbit: "LeNhip_Nhan_Dien/Logo/SVG/LeNhip_L01_Quy_Dao.svg",
  night: "LeNhip_Nhan_Dien/Logo/SVG/LeNhip_L02_Khong_Gian_Dem.svg",
  calm: "LeNhip_Nhan_Dien/Logo/SVG/LeNhip_L03_Nhip_An.svg",
  flow: "LeNhip_Nhan_Dien/Logo/SVG/LeNhip_L04_Dong_Thoi_Gian.svg",
  titanium: "LeNhip_Nhan_Dien/Logo/SVG/LeNhip_L05_Titanium.svg",
};
const sourceSvg = (theme: string) => {
  const file = pkg.get(SOURCE[theme]);
  assert.ok(file, `gói nhận diện thiếu ${SOURCE[theme]}`);
  return file.toString("utf8");
};

// ---------------------------------------------------------------- màu và tương phản
const shapes = (svg: string) => svg.match(/<(?:path|circle|rect|ellipse|polygon)\b[^>]*>/g) ?? [];
const inks = (svg: string) => [...new Set([...svg.matchAll(/\b(?:fill|stroke)="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1].toUpperCase()))].sort();
function luminance(hex: string) {
  const [r, g, b] = (hex.slice(1).match(/../g) as string[]).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Token nền của một phong cách, đọc từ web/styles.css (Quỹ đạo là mặc định trên `body`). */
function themeTokens(theme: string) {
  const css = text("styles.css");
  const rule = theme === "orbit" ? /(?:^|\})body\{([^}]*)\}/m.exec(css) : new RegExp(`body\\[data-theme=${theme}\\]\\{([^}]*)\\}`).exec(css);
  assert.ok(rule, `styles.css thiếu token của phong cách ${theme}`);
  const token = (name: string) => {
    const m = new RegExp(`--${name}:#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])`).exec(rule[1]);
    assert.ok(m, `phong cách ${theme} thiếu --${name} dạng #rgb hoặc #rrggbb`);
    return "#" + (m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1]);
  };
  return { bg: token("bg"), surface: token("surface") };
}

test("mỗi phong cách có chữ LeNhip riêng theo gói nhận diện, tên truy cập là LeNhip", () => {
  assert.deepEqual([...WORDMARK_THEMES], THEMES.map((t) => t.id));
  assert.deepEqual(THEMES.map((t) => wordmarkCode(t.id)), ["L01", "L02", "L03", "L04", "L05"]);
  for (const { id } of THEMES) {
    const svg = wordmark(id);
    assert.match(svg, /^<svg class="brand-wordmark" data-wordmark="L0[1-5]" viewBox="[\d. ]+" preserveAspectRatio="xMinYMid meet" role="img" aria-label="LeNhip" focusable="false">/, id);
    assert.ok(svg.endsWith("</svg>"), id);
    assert.equal(svg.match(/<svg\b/g)?.length, 1, id);
    // Chỉ là hình vẽ: không chữ, không ảnh, không liên kết, không mã, không kiểu ngoài.
    assert.doesNotMatch(svg, /<(?:script|style|image|use|a|text|title|foreignObject)\b|\bon\w+=|href=|url\(/i, id);
  }
  assert.equal(wordmark("khong-co"), wordmark("orbit"), "phong cách lạ dùng L01");
  assert.match(wordmark("night", { label: false }), /aria-hidden="true"/);
  assert.doesNotMatch(wordmark("night", { label: false }), /role="img"/);
  assert.match(wordmark("calm", { label: 'Le"Nhip<' }), /aria-label="LeNhip"/, "tên truy cập không chèn được thuộc tính");
});

test("bản vẽ không bị sửa: từng đường và từng màu khớp tệp SVG gốc trong docs/source", () => {
  for (const { id } of THEMES) {
    const ours = wordmark(id);
    const source = sourceSvg(id);
    assert.deepEqual(shapes(ours), shapes(source), `${id}: đường vẽ khác tệp gốc`);
    assert.deepEqual(inks(ours), inks(source), `${id}: màu khác tệp gốc`);
    // Thân SVG chép nguyên: phần sau <title> của tệp gốc nằm trọn trong bản của ứng dụng.
    const body = /<\/title>(.*)<\/svg>\s*$/s.exec(source)?.[1];
    assert.ok(body && ours.includes(body), `${id}: thân SVG không khớp tệp gốc`);
    // Khung nhìn đã cắt vẫn nằm trong khung gốc.
    const [x, y, w, h] = (/viewBox="([\d. ]+)"/.exec(ours)?.[1] ?? "").split(" ").map(Number);
    const [, , sw, sh] = (/viewBox="([\d. ]+)"/.exec(source)?.[1] ?? "").split(" ").map(Number);
    assert.ok(x >= 0 && y >= 0 && x + w <= sw && y + h <= sh && w > 300 && h === 124, `${id}: khung nhìn ${x} ${y} ${w} ${h}`);
  }
  assert.deepEqual(inks(wordmark("orbit")), ["#12394A", "#A86610"]);
  assert.deepEqual(inks(wordmark("titanium")), ["#65F0EC", "#EFF4F7"]);
});

test("LNH-F25: mọi màu của chữ đạt tương phản từ 3:1 trên nền và trên bề mặt của phong cách", () => {
  for (const { id } of THEMES) {
    const { bg, surface } = themeTokens(id);
    for (const ink of inks(wordmark(id))) {
      assert.ok(contrast(ink, bg) >= 3, `${id}: ${ink} trên --bg ${bg} = ${contrast(ink, bg).toFixed(2)}`);
      assert.ok(contrast(ink, surface) >= 3, `${id}: ${ink} trên --surface ${surface} = ${contrast(ink, surface).toFixed(2)}`);
    }
  }
  // Lý do phải đổi bản vẽ theo phong cách: chữ L01 trên hai nền tối không đọc được.
  for (const dark of ["night", "titanium"]) {
    const { bg, surface } = themeTokens(dark);
    assert.ok(contrast("#12394A", bg) < 3 && contrast("#12394A", surface) < 3, `L01 trên ${dark}`);
  }
});

// ---------------------------------------------------------------- icon ứng dụng
function png(path: string) {
  const data = read(path);
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path}: không phải PNG`);
  assert.equal(data.subarray(12, 16).toString("latin1"), "IHDR", path);
  return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20), depth: data[24], colorType: data[25], interlace: data[28] };
}
/** Giải mã PNG 8 bit RGB/RGBA không xen kẽ thành mảng điểm ảnh RGB. */
function pixels(path: string) {
  const { data, width, height, depth, colorType, interlace } = png(path);
  assert.ok(depth === 8 && (colorType === 2 || colorType === 6) && interlace === 0, `${path}: chỉ đọc PNG 8 bit RGB/RGBA`);
  const bpp = colorType === 2 ? 3 : 4;
  const idat: Buffer[] = [];
  for (let at = 8; at < data.length; ) {
    const length = data.readUInt32BE(at);
    if (data.subarray(at + 4, at + 8).toString("latin1") === "IDAT") idat.push(data.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const value = raw[y * (stride + 1) + 1 + i];
      const left = i >= bpp ? out[y * stride + i - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else assert.equal(filter, 0, `${path}: bộ lọc PNG lạ`);
      out[y * stride + i] = (value + predicted) & 0xff;
    }
  }
  return { width, height, at: (x: number, y: number) => [out[y * stride + x * bpp], out[y * stride + x * bpp + 1], out[y * stride + x * bpp + 2]] };
}

test("icon ứng dụng là I01: SVG đúng tệp gốc, PNG đủ cỡ, trang và manifest trỏ đúng tệp", () => {
  assert.deepEqual(read("icon.svg"), pkg.get("LeNhip_Nhan_Dien/Icon/SVG/LeNhip_I01_Tim_Quy_Dao.svg"), "web/icon.svg khác I01 của gói nhận diện");
  assert.ok(read("icon.svg").length < 1024);
  for (const [file, size] of [["icons/icon-512.png", 512], ["icons/icon-192.png", 192], ["icons/apple-touch-icon.png", 180], ["icons/favicon-48.png", 48], ["icons/favicon-32.png", 32]] as const) {
    const { width, height } = png(file);
    assert.deepEqual([width, height], [size, size], file);
  }
  const html = text("index.html");
  assert.match(html, /<html lang="vi" dir="ltr" translate="no">/);
  assert.match(html, /<link rel="icon" href="\.\/icon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="icon" href="\.\/icons\/favicon-32\.png" type="image\/png" sizes="32x32">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\.\/icons\/apple-touch-icon\.png">/);
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.json">/);
  // Không tài nguyên của bên thứ ba trên trang: mọi href/src đều tương đối (CSP không đổi).
  for (const m of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) assert.match(m[1], /^(?:\.\/|#)/, `đường dẫn không tương đối: ${m[1]}`);
});

test("LNH-T50: manifest của bản cài được, chưa có service worker", () => {
  const manifest = JSON.parse(text("manifest.json")) as {
    name: string; short_name: string; start_url: string; scope: string; display: string; background_color: string; theme_color: string; lang: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };
  assert.equal(manifest.name, "LeNhip");
  assert.equal(manifest.short_name, "LeNhip");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.background_color, "#12394A");
  assert.equal(manifest.theme_color, "#12394A");
  assert.equal(manifest.lang, "vi");
  assert.deepEqual(manifest.icons.map((i) => `${i.sizes} ${i.purpose}`).sort(), ["192x192 any", "192x192 maskable", "512x512 any", "512x512 maskable"]);
  for (const icon of manifest.icons) {
    assert.match(icon.src, /^icons\/[a-z0-9-]+\.png$/, "tên tệp icon phải thuộc mẫu máy chủ phục vụ");
    assert.equal(icon.type, "image/png");
    const { width, height } = png(icon.src);
    assert.equal(`${width}x${height}`, icon.sizes, icon.src);
  }
  // LNH-F29: icon hình tim là nhận diện, không kèm tuyên bố về tim mạch hay chẩn đoán; không thêm khẩu hiệu vào manifest.
  assert.doesNotMatch(JSON.stringify(manifest), /tim mạch|nhịp tim|chẩn đoán|điều trị|cardiac|heart|diagnos/i);
  assert.equal(existsSync(new URL("sw.js", web)), false, "bản này chưa có service worker (LNH-T50, LNH-D18)");
  assert.doesNotMatch(text("app.js") + text("index.html"), /serviceWorker/);
});

test("icon maskable: nét vẽ I01 nằm trong vùng an toàn (hình tròn bán kính 40 % cạnh), phần ngoài là nền #12394A", () => {
  const background = [0x12, 0x39, 0x4a];
  for (const file of ["icons/icon-192.png", "icons/icon-512.png"]) {
    const image = pixels(file);
    const center = (image.width - 1) / 2;
    const safe = image.width * 0.4;
    let outside = 0;
    let inkInside = 0;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const far = Math.max(...image.at(x, y).map((v, i) => Math.abs(v - background[i])));
        if (Math.hypot(x - center, y - center) > safe) {
          if (far > 6) outside++;
        } else if (far > 60) inkInside++;
      }
    }
    assert.equal(outside, 0, `${file}: có ${outside} điểm ảnh ngoài vùng an toàn không phải màu nền`);
    assert.ok(inkInside > image.width * image.width * 0.03, `${file}: không thấy nét vẽ trong vùng an toàn`);
  }
});
