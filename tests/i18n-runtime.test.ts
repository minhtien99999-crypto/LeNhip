// Runtime ngôn ngữ của LeNhip (LNH-T22, T27, T28, T29): chọn ngôn ngữ theo trình duyệt, số nhiều theo CLDR, thứ tự lùi khi
// thiếu khóa, định dạng giờ và thời lượng, dạng tệp catalog và bảng nạp cố định.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  LOCALES, PARTS, LOADERS, PLURAL_CATEGORIES, SOURCE_LOCALE, DEFAULT_LOCALE,
  negotiate, resolveLocale, isLocale, localeInfo, initI18n, setLocale, getLocale, loadLocale, hasMessage, t,
  formatNumber, formatDate, formatWeekday, formatTime24, formatDuration, formatList,
} from "../web/shared/i18n.js";
import { defaults, sanitizeSettings } from "../web/model.js";
import { parseStrictJson } from "../src/core/strict-json.ts";

const shared = new URL("../web/shared/", import.meta.url);
const plain = (s: string) => s.replace(/[  ]/g, " ");
/** Bảng nạp giả cho một ngôn ngữ: catalog nằm trong bộ nhớ, phần không nêu thì coi như chưa có tệp. */
const memory = (tag: string, core: Record<string, unknown>, parts: Record<string, Record<string, unknown>> = {}) => ({
  [tag]: Object.fromEntries(["core", ...PARTS].map((part) => {
    const data = part === "core" ? core : parts[part];
    return [part, data ? async () => ({ default: data as unknown }) : async () => Promise.reject(new Error("chưa có tệp"))];
  })),
});

test("LNH-T21: 13 ngôn ngữ, tiếng Việt là bản gốc, các bản khác là bản nháp", () => {
  assert.deepEqual(LOCALES.map((l) => l.tag), ["vi", "en", "fr", "zh-Hans", "ko", "ja", "es", "pt-BR", "it", "zh-Hant", "id", "ru", "de"]);
  for (const l of LOCALES) {
    assert.equal(l.file, l.tag.toLowerCase(), l.tag);
    assert.match(l.file, /^[a-z0-9-]+$/, "tên tệp phải thuộc mẫu shared/[a-z0-9-]+.js của máy chủ");
    assert.equal(l.dir, "ltr", l.tag);
    assert.equal(l.draft, l.tag !== "vi", l.tag);
    assert.ok(l.name.length > 0 && Intl.getCanonicalLocales(l.tag)[0] === l.tag, l.tag);
  }
  assert.deepEqual([...PARTS], ["msg", "social", "dev"]);
  assert.equal(SOURCE_LOCALE, "vi");
  assert.equal(DEFAULT_LOCALE, "en");
  assert.ok(isLocale("pt-BR") && !isLocale("pt") && !isLocale("auto") && !isLocale(null));
  assert.throws(() => localeInfo("xx"), RangeError);
});

test("LNH-T29: chọn ngôn ngữ theo trình duyệt, có xét hệ chữ; rác bị bỏ qua; không khớp thì tiếng Anh", () => {
  const table: [unknown, string][] = [
    [["vi-VN", "en-US"], "vi"],
    [["vi"], "vi"],
    [["en-GB"], "en"],
    [["fr-CA"], "fr"],
    [["zh-TW"], "zh-Hant"],
    [["zh-HK"], "zh-Hant"],
    [["zh-MO"], "zh-Hant"],
    [["zh-Hant"], "zh-Hant"],
    [["zh-Hant-CN"], "zh-Hant"],
    [["zh"], "zh-Hans"],
    [["zh-CN"], "zh-Hans"],
    [["zh-SG"], "zh-Hans"],
    [["zh-Hans-TW"], "zh-Hans"],
    [["pt"], "pt-BR"],
    [["pt-PT"], "pt-BR"],
    [["pt-BR"], "pt-BR"],
    [["es-MX"], "es"],
    [["es-419"], "es"],
    [["ko-KR"], "ko"],
    [["ja-JP"], "ja"],
    [["it-CH"], "it"],
    [["id-ID"], "id"],
    [["in"], "id"],
    [["ru-RU"], "ru"],
    [["de-AT"], "de"],
    [["nl-NL", "fr-BE", "de-DE"], "fr"],
    [["th-TH", "zh-TW", "zh-CN"], "zh-Hant"],
    [["th-TH"], "en"],
    [["ar", "hi", "ms"], "en"],
    [[], "en"],
    [undefined, "en"],
    [null, "en"],
    ["ja", "ja"],
    // Rác trong navigator.languages: bỏ qua từng phần tử, không ném lỗi.
    [["", "*", "pt_BR", "zh-CHS", 42, null, {}, "x".repeat(100), "-", "en--US", "ko-KR"], "ko"],
    [["*"], "en"],
    [["pt_BR"], "en"],
    [["../../etc/passwd", "__proto__", "constructor"], "en"],
  ];
  for (const [requested, expected] of table) assert.equal(negotiate(requested as never), expected, JSON.stringify(requested));

  assert.equal(resolveLocale("auto", ["ja-JP"]), "ja");
  assert.equal(resolveLocale("de", ["ja-JP"]), "de", "lựa chọn đã lưu thắng trình duyệt");
  assert.equal(resolveLocale("xx", ["ja-JP"]), "ja", "giá trị lạ được coi là auto");
  assert.equal(resolveLocale(undefined, ["zh-TW"]), "zh-Hant");
});

test("thiết lập giao diện có locale: mặc định auto, giá trị lạ bị bỏ", () => {
  assert.equal(defaults("A").locale, "auto");
  const base = defaults("A");
  assert.equal(sanitizeSettings({ ...base, locale: "zh-Hant" }).locale, "zh-Hant");
  for (const bad of ["zh", "EN", "../vi", "", 7, null, undefined, "__proto__"]) assert.equal(sanitizeSettings({ ...base, locale: bad }).locale, "auto", String(bad));
});

test("bảng nạp khớp đúng LOCALES × (lõi + PARTS) và mỗi mục trỏ đúng tên tệp", () => {
  assert.deepEqual(Object.keys(LOADERS).sort(), LOCALES.map((l) => l.tag).sort());
  for (const l of LOCALES) {
    assert.deepEqual(Object.keys(LOADERS[l.tag]).sort(), ["core", ...PARTS].sort(), l.tag);
    for (const part of ["core", ...PARTS]) {
      const file = `./i18n-${l.file}${part === "core" ? "" : "-" + part}.js`;
      const source = LOADERS[l.tag][part].toString().replace(/\s+/g, "");
      assert.equal(source, `()=>import("${file}")`, `${l.tag}/${part}`);
    }
  }
  // Tag đã lưu không bao giờ thành đường dẫn: runtime không có import() nào ngoài bảng nạp, và bảng chỉ có chuỗi cố định.
  const code = (file: string) => readFileSync(new URL(file, shared), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code("i18n.js"), /\bimport\s*\(/);
  assert.equal((code("i18n-loaders.js").match(/\bimport\s*\(/g) ?? []).length, LOCALES.length * (1 + PARTS.length));
  assert.doesNotMatch(code("i18n-loaders.js"), /\bimport\s*\((?!"\.\/i18n-[a-z0-9-]+\.js"\))/);
});

test("mỗi tệp catalog đúng dạng `export default <JSON chặt>;`, khóa phẳng có dấu chấm, không HTML", async () => {
  const expected = new Map<string, { tag: string; part: string }>();
  for (const l of LOCALES) for (const part of ["core", ...PARTS]) expected.set(`i18n-${l.file}${part === "core" ? "" : "-" + part}.js`, { tag: l.tag, part });
  const files = readdirSync(shared).filter((f) => /^i18n-.*\.js$/.test(f) && f !== "i18n-loaders.js").sort();
  // Tiếng Việt và tiếng Anh phải có đủ lõi và ba phần; ngôn ngữ khác có tệp nào thì kiểm tệp đó.
  for (const tag of ["vi", "en"]) for (const part of ["", "-msg", "-social", "-dev"]) assert.ok(files.includes(`i18n-${tag}${part}.js`), `thiếu i18n-${tag}${part}.js`);
  const keysOf = new Map<string, Set<string>>();
  for (const file of files) {
    const info = expected.get(file);
    assert.ok(info, `${file}: tên tệp không thuộc LOCALES × (lõi + PARTS)`);
    const raw = readFileSync(new URL(file, shared), "utf8");
    assert.ok(raw.startsWith("export default ") && raw.endsWith(";\n"), `${file}: phải là "export default " + JSON + ";" + xuống dòng`);
    const data = parseStrictJson(raw.slice("export default ".length, -2)) as Record<string, unknown>;
    assert.ok(data && typeof data === "object" && !Array.isArray(data), file);
    assert.deepEqual((await LOADERS[info.tag][info.part]()).default, data, `${file}: mô-đun khác nội dung JSON`);
    const keys = keysOf.get(info.tag) ?? new Set<string>();
    keysOf.set(info.tag, keys);
    const rules = new Set(new Intl.PluralRules(info.tag).resolvedOptions().pluralCategories);
    for (const [key, message] of Object.entries(data)) {
      assert.match(key, /^[a-z][a-z0-9]*(?:\.[A-Za-z0-9_]+)+$/, `${file}: khóa ${key}`);
      // Phần của mô-đun chỉ chứa khóa có tiền tố của nó; phần lõi không dùng các tiền tố đó.
      const prefix = key.slice(0, key.indexOf("."));
      if (info.part === "core") assert.ok(!PARTS.includes(prefix), `${file}: khóa ${key} thuộc phần ${prefix}`);
      else assert.equal(prefix, info.part, `${file}: khóa ${key} phải bắt đầu bằng ${info.part}.`);
      assert.ok(!keys.has(key), `${file}: khóa ${key} trùng với tệp khác của ${info.tag}`);
      keys.add(key);
      const branches = typeof message === "string" ? [message] : Object.values(message as Record<string, unknown>);
      if (typeof message !== "string") {
        assert.ok(message && typeof message === "object" && !Array.isArray(message), `${file}: ${key}`);
        const categories = Object.keys(message as object);
        assert.ok(categories.includes("other"), `${file}: ${key} thiếu nhánh other`);
        for (const c of categories) assert.ok(PLURAL_CATEGORIES.includes(c) && rules.has(c as Intl.LDMLPluralRule), `${file}: ${key} có nhánh ${c} không dùng trong ${info.tag}`);
      }
      // Tên thương hiệu giữ nguyên ở mọi ngôn ngữ.
      if (key === "brand.name") assert.equal(message, "LeNhip", file);
      for (const text of branches) {
        assert.equal(typeof text, "string", `${file}: ${key}`);
        assert.doesNotMatch(text as string, /[<>]|&[a-z#0-9]+;/i, `${file}: ${key} có HTML`);
        assert.equal((text as string).trim(), text, `${file}: ${key} có khoảng trắng đầu hoặc cuối`);
        assert.ok((text as string).length > 0, `${file}: ${key} rỗng`);
      }
    }
  }
  // Bản gốc là tập khóa chuẩn: không ngôn ngữ nào có khóa mà tiếng Việt không có; tiếng Anh hiện đủ mọi khóa.
  const source = keysOf.get("vi") as Set<string>;
  for (const [tag, keys] of keysOf) for (const key of keys) assert.ok(source.has(key), `${tag}: khóa ${key} không có trong bản tiếng Việt`);
  assert.deepEqual([...(keysOf.get("en") as Set<string>)].sort(), [...source].sort());
});

test("t(): chuỗi có {tên}; thiếu tham số thì ném lỗi; số được định dạng theo ngôn ngữ của thông điệp", async (ctx) => {
  ctx.mock.method(console, "warn", () => {});
  await loadLocale("de", memory("de", { "test.hello": "Hallo {name}!", "test.count": "{n} Schritte", "test.two": "{a} und {b} und {a}" }));
  await setLocale("de");
  assert.equal(t("test.hello", { name: "A" }), "Hallo A!");
  assert.equal(t("test.two", { a: "x", b: 2 }), "x und 2 und x");
  assert.equal(t("test.count", { n: 8432 }), "8.432 Schritte");
  assert.equal(t("test.count", { n: "8432" }), "8432 Schritte", "chuỗi được giữ nguyên");
  assert.throws(() => t("test.hello"), /thiếu tham số \{name\}/);
  assert.throws(() => t("test.hello", {}), /thiếu tham số \{name\}/);
  assert.throws(() => t("test.hello", { nam: "A" }), /thiếu tham số \{name\}/);
  assert.throws(() => t("test.two", { a: "x" }), /thiếu tham số \{b\}/);
  // Tham số không thừa kế từ prototype, và văn bản trả về là thuần (nơi gọi tự thoát ký tự).
  assert.throws(() => t("test.hello", Object.create({ name: "A" })), /thiếu tham số/);
  assert.equal(t("test.hello", { name: "<b>" }), "Hallo <b>!");
});

test("số nhiều theo CLDR của ngôn ngữ catalog: tiếng Nga 1, 2, 5, 21, 1,5; tiếng Pháp 0 là one; tiếng Nhật chỉ other", async (ctx) => {
  ctx.mock.method(console, "warn", () => {});
  await loadLocale("ru", memory("ru", { "test.steps": { one: "{n} шаг", few: "{n} шага", many: "{n} шагов", other: "{n} шага" } }));
  await setLocale("ru");
  assert.deepEqual([1, 2, 5, 21, 1.5, 0, 11, 22, 25, 101].map((n) => plain(t("test.steps", { n }))),
    ["1 шаг", "2 шага", "5 шагов", "21 шаг", "1,5 шага", "0 шагов", "11 шагов", "22 шага", "25 шагов", "101 шаг"]);
  assert.throws(() => t("test.steps"), /cần tham số số n/);
  assert.throws(() => t("test.steps", { n: "5" }), /cần tham số số n/);
  assert.throws(() => t("test.steps", { n: Number.NaN }), /cần tham số số n/);

  await loadLocale("fr", memory("fr", { "test.days": { one: "{n} jour", many: "{n} de jours", other: "{n} jours" } }));
  await setLocale("fr");
  assert.deepEqual([0, 1, 1.5, 2, 21].map((n) => plain(t("test.days", { n }))), ["0 jour", "1 jour", "1,5 jour", "2 jours", "21 jours"]);
  assert.equal(plain(t("test.days", { n: 1_000_000 })), "1 000 000 de jours");

  await loadLocale("ja", memory("ja", { "test.steps": { other: "{n} 歩" }, "test.partial": { one: "không dùng", other: "{n} 件" } }));
  await setLocale("ja");
  assert.deepEqual([0, 1, 2, 5].map((n) => t("test.steps", { n })), ["0 歩", "1 歩", "2 歩", "5 歩"]);
  assert.equal(t("test.partial", { n: 1 }), "1 件", "tiếng Nhật không có loại one");

  // Nhánh thiếu thì dùng other; thiếu cả other là lỗi của catalog.
  await loadLocale("es", memory("es", { "test.items": { other: "{n} elementos" }, "test.broken": { one: "{n} elemento" } }));
  await setLocale("es");
  assert.equal(t("test.items", { n: 1 }), "1 elementos");
  assert.equal(t("test.broken", { n: 1 }), "1 elemento");
  assert.throws(() => t("test.broken", { n: 2 }), /thiếu nhánh other/);
});

test("thứ tự lùi: ngôn ngữ đang chọn → tiếng Việt → trả lại khóa và cảnh báo một lần", async (ctx) => {
  const warn = ctx.mock.method(console, "warn", () => {});
  await loadLocale("it", memory("it", { "nav.messages": "Messaggi", "test.plural": { one: "{n} passo", other: "{n} passi" } }));
  await setLocale("it");
  assert.equal(getLocale(), "it");
  assert.equal(t("nav.messages"), "Messaggi");
  assert.equal(t("nav.connect"), "Kết nối", "khóa thiếu ở tiếng Ý lấy từ bản tiếng Việt");
  assert.ok(hasMessage("nav.connect") && !hasMessage("test.khong_co"));
  const before = warn.mock.callCount();
  assert.equal(t("test.khong_co"), "test.khong_co");
  assert.equal(t("test.khong_co", { n: 1 }), "test.khong_co");
  assert.equal(warn.mock.callCount(), before + 1, "mỗi khóa thiếu chỉ cảnh báo một lần");
  assert.match(String(warn.mock.calls.at(-1)?.arguments[0]), /thiếu khóa test\.khong_co/);
  // Khóa trùng tên thuộc tính có sẵn của đối tượng không được coi là có.
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(t(key), key);

  await setLocale("vi");
  assert.equal(t("nav.messages"), "Tin nhắn");
  assert.equal(t("brand.name"), "LeNhip");
});

test("ngôn ngữ chưa có tệp catalog: không ném lỗi, lùi về tiếng Việt theo từng tệp, ghi nhận một lần", async (ctx) => {
  const warn = ctx.mock.method(console, "warn", () => {});
  // Chỉ có phần lõi; ba phần msg, social, dev chưa có tệp.
  await loadLocale("ko", memory("ko", { "nav.messages": "메시지" }));
  const afterFirst = warn.mock.callCount();
  assert.equal(afterFirst, 1, "một dòng cảnh báo cho cả ngôn ngữ");
  assert.match(String(warn.mock.calls[0].arguments[0]), /i18n-ko-dev\.js, i18n-ko-msg\.js, i18n-ko-social\.js/);
  await loadLocale("ko", memory("ko", { "nav.messages": "메시지" }));
  assert.equal(warn.mock.callCount(), afterFirst, "nạp lại không cảnh báo lần nữa");
  await setLocale("ko");
  assert.equal(t("nav.messages"), "메시지");
  assert.equal(t("connect.title"), "Kết nối");

  // Tệp hỏng (không phải đối tượng) và ngôn ngữ không có trong bảng nạp cũng chỉ lùi về tiếng Việt.
  await loadLocale("es", { es: { core: async () => ({ default: [] as unknown }), msg: async () => ({ default: null as unknown }), social: async () => ({ default: "x" as unknown }), dev: async () => { throw new Error("hỏng"); } } });
  await setLocale("es");
  assert.equal(t("nav.messages"), "Tin nhắn");
  await loadLocale("id", {});
  await setLocale("id");
  assert.equal(t("nav.connect"), "Kết nối");

  // Bảng nạp thật, trên một bản runtime mới (chưa nạp gì): ngôn ngữ nào chưa có tệp trên đĩa thì import() bị từ chối, runtime
  // vẫn chạy bằng tiếng Việt và cảnh báo đúng một lần cho ngôn ngữ đó; ngôn ngữ đã có đủ tệp thì không cảnh báo.
  const fresh = (await import(String(new URL("../web/shared/i18n.js?ban-moi", import.meta.url)))) as typeof import("../web/shared/i18n.js");
  for (const l of LOCALES) {
    const files = ["", ...PARTS.map((p) => "-" + p)].map((suffix) => `i18n-${l.file}${suffix}.js`);
    const missing = files.filter((f) => !existsSync(new URL(f, shared)));
    const before = warn.mock.callCount();
    assert.equal(await fresh.setLocale(l.tag), l.tag);
    assert.equal(await fresh.setLocale(l.tag), l.tag);
    assert.equal(fresh.t("brand.name"), "LeNhip");
    assert.equal(warn.mock.callCount() - before, missing.length ? 1 : 0, l.tag);
    if (missing.length) for (const f of missing) assert.ok(String(warn.mock.calls.at(-1)?.arguments[0]).includes(f), `${l.tag}: cảnh báo phải nêu ${f}`);
    if (missing.includes(files[0])) assert.equal(fresh.t("nav.messages"), "Tin nhắn", l.tag);
  }
  assert.equal(getLocale(), "id", "bản runtime mới không đổi ngôn ngữ của bản đang dùng");
  await assert.rejects(() => setLocale("xx"), RangeError);
  await assert.rejects(() => setLocale("__proto__"), RangeError);
  await assert.rejects(() => loadLocale("../vi"), RangeError);

  assert.equal(await initI18n("auto", ["en-US"]), "en");
  assert.equal(await initI18n("vi", ["en-US"]), "vi");
  assert.equal(await initI18n("khong-hop-le", ["zh-TW"]), "zh-Hant");
  assert.equal(await initI18n("auto", []), "en");
  await setLocale("vi");
});

test("LNH-T27: giờ luôn HH:MM 24 giờ; thời lượng dựng từ NumberFormat đơn vị và ListFormat", async (ctx) => {
  ctx.mock.method(console, "warn", () => {});
  // Node 22 chưa có Intl.DurationFormat: runtime không được gọi nó.
  assert.doesNotMatch(readFileSync(new URL("i18n.js", shared), "utf8"), /new\s+Intl\.DurationFormat|Intl\.DurationFormat\s*\(/);
  const at = "2026-11-11T07:05:00Z"; // 14:05 giờ Việt Nam, 23:05 hôm trước ở Los Angeles
  for (const tag of ["vi", "en", "ko"]) {
    await setLocale(tag);
    assert.equal(formatTime24(at, "Asia/Ho_Chi_Minh"), "14:05", tag);
    assert.equal(formatTime24(at, "UTC"), "07:05", tag);
    assert.equal(formatTime24(Date.parse(at), "America/Los_Angeles"), "23:05", tag);
    assert.equal(formatTime24(new Date("2026-11-10T17:00:00Z"), "Asia/Ho_Chi_Minh"), "00:00", "nửa đêm là 00:00, không phải 24:00");
    assert.match(formatTime24(at), /^\d{2}:\d{2}$/);
  }
  assert.throws(() => formatTime24("không phải giờ"), RangeError);

  await setLocale("vi");
  assert.equal(plain(formatDuration(450)), "7 giờ 30 phút");
  assert.equal(plain(formatDuration(432)), "7 giờ 12 phút");
  assert.equal(plain(formatDuration(60)), "1 giờ");
  assert.equal(plain(formatDuration(29)), "29 phút");
  assert.equal(plain(formatDuration(0)), "0 phút");
  assert.equal(plain(formatDuration(89.6)), "1 giờ 30 phút", "làm tròn tới phút");
  assert.equal(plain(formatDuration(1505)), "25 giờ 5 phút");
  await setLocale("en");
  assert.equal(plain(formatDuration(450)), "7 hr 30 min");
  assert.equal(plain(formatDuration(60)), "1 hr");
  assert.equal(plain(formatDuration(1)), "1 min");
  assert.equal(plain(formatDuration(450, { unit: "long", list: "long" })), "7 hours, 30 minutes");
  assert.equal(plain(formatDuration(61, { unit: "long", list: "long" })), "1 hour, 1 minute");
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "60"]) assert.throws(() => formatDuration(bad as number), RangeError, String(bad));
  // Cùng một công thức với Intl ở mọi ngôn ngữ: so với kết quả Intl tính tại chỗ, không chép cứng chuỗi của từng ngôn ngữ.
  for (const l of LOCALES) {
    await setLocale(l.tag);
    const hour = new Intl.NumberFormat(l.tag, { style: "unit", unit: "hour", unitDisplay: "short" }).format(7);
    const minute = new Intl.NumberFormat(l.tag, { style: "unit", unit: "minute", unitDisplay: "short" }).format(30);
    assert.equal(formatDuration(450), new Intl.ListFormat(l.tag, { type: "unit", style: "narrow" }).format([hour, minute]), l.tag);
  }
  await setLocale("vi");
});

test("số, ngày, thứ và danh sách theo ngôn ngữ đang chọn", async () => {
  await setLocale("vi");
  assert.equal(formatNumber(8432), "8.432");
  assert.equal(plain(formatDate("2026-11-11")), "11 thg 11, 2026");
  assert.equal(formatWeekday("2026-11-11"), "Thứ Tư");
  assert.equal(formatWeekday("2026-11-15", "short"), "CN");
  assert.equal(formatList(["A", "B", "C"]), "A, B và C");
  await setLocale("en");
  assert.equal(formatNumber(8432), "8,432");
  assert.equal(formatNumber(0.856, { style: "percent", maximumFractionDigits: 1 }), "85.6%");
  assert.equal(formatDate("2026-11-11"), "Nov 11, 2026");
  assert.equal(formatWeekday("2026-11-11"), "Wednesday");
  assert.equal(formatList(["A", "B", "C"]), "A, B, and C");
  assert.equal(formatList(["A", "B"], { type: "disjunction" }), "A or B");
  // Ngày theo lịch in đúng ngày đó ở mọi múi; thời điểm thì theo múi được truyền.
  const instant = "2026-11-10T18:30:00Z"; // đã sang 11/11 ở Việt Nam, còn 10/11 ở Los Angeles
  assert.equal(formatDate("2026-11-11", { dateStyle: "medium", timeZone: "America/Los_Angeles" }), "Nov 11, 2026");
  assert.equal(formatDate(instant, { dateStyle: "medium", timeZone: "Asia/Ho_Chi_Minh" }), "Nov 11, 2026");
  assert.equal(formatDate(instant, { dateStyle: "medium", timeZone: "America/Los_Angeles" }), "Nov 10, 2026");
  assert.equal(formatWeekday(instant, "long", "Asia/Ho_Chi_Minh"), "Wednesday");
  assert.equal(formatWeekday(instant, "long", "America/Los_Angeles"), "Tuesday");
  assert.throws(() => formatDate("11/11"), RangeError);
  await setLocale("vi");
});
