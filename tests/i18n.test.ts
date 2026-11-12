// Catalog ngôn ngữ của LeNhip (LNH-T21..LNH-T29): mọi tệp catalog đang có trên đĩa phải cùng tập khóa, cùng tham số và đủ
// nhánh số nhiều so với bản gốc tiếng Việt; không HTML, không ký tự điều khiển hướng chữ; tên thương hiệu giữ nguyên; không
// để sót chữ tiếng Việt chưa dịch; nhãn điều hướng vừa ngân sách chiều dài. Kèm theo: mã nguồn giao diện không còn câu chữ
// nào ngoài catalog, mọi mã lỗi và mã trạng thái của hợp đồng có câu, văn bản đồng ý khớp sổ ghim (LNH-T25).
//
// Chỉ kiểm một ngôn ngữ (người dịch làm song song trên cùng một cây, không vướng tệp dở dang của nhau):
//   LENHIP_I18N_ONLY=fr node --test tests/i18n.test.ts tests/i18n-runtime.test.ts
// Khi đó phần văn bản đồng ý chỉ đối chiếu các dòng đã có trong sổ; chạy `node scripts/make-consent-texts.ts` một lần sau khi
// mọi bản dịch xong để thêm dòng mới.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import {
  LOCALES, PARTS, SOURCE_LOCALE, LOADERS, LANGUAGE_WORD,
  setLocale, loadLocale, getLocale, hasCatalog, hasMessage, hasSourceMessage, messageLocale,
  t, tParts, tSource, localizeStatic, formatDuration, formatDurationParts, formatWeekdayCompact,
} from "../web/shared/i18n.js";
import { CONSENT_BODY_KEY, CONSENT_TEXT_VERSIONS, composeConsentText, consentKeys, consentReceipt, consentText, consentTextVersion } from "../web/shared/consent-text.js";
import { sleepMessage, sleepSentence, COMPLETED_DAYS, MIN_OBSERVED_DAYS } from "../web/shared/sleep.js";
import { digestJcs } from "../web/shared/jcs.js";
import { THEMES, SettingsFileError, defaults, sanitizeSettings } from "../web/model.js";
import { ApiError } from "../web/api.js";
import { MESSAGES } from "../src/core/errors.ts";
import { parseStrictJson } from "../src/core/strict-json.ts";
import { catalogFile, currentConsentTexts, entryId, formatRegistry, mergeRegistry, readCatalog, readRegistry, REGISTRY_URL } from "../scripts/make-consent-texts.ts";

/** Đặt true sau khi dịch xong: mọi ngôn ngữ trong LOCALES phải có đủ phần lõi và các phần (13 × 4 tệp). */
const REQUIRE_ALL_LOCALES = true;
/** LENHIP_I18N_ONLY=<tag>: chỉ kiểm tệp của một ngôn ngữ. */
const ONLY = process.env.LENHIP_I18N_ONLY || null;

const web = new URL("../web/", import.meta.url);
const FILE_PARTS = ["core", ...PARTS];
const plain = (s: string) => s.replace(/[  ]/g, " ");
type Message = string | Record<string, string>;
type Catalog = Record<string, Message>;

/** Tên thương hiệu và tên riêng không dịch: số lần xuất hiện trong bản dịch phải bằng trong bản gốc. */
const BRANDS = ["LeNhip", "LeLe", "LeDB", "LeTRON", "LeASO"];
const KEPT_TERMS = [...BRANDS, "Le-ORION", "Microsoft 365", "HealthKit", "Health Connect", "HealthSource", "LNH-SLEEP-1", "OIDC", "Outlook", "Titanium", "X-LeNhip-Workspace", "Idempotency-Key", "application/json"];
/** Khóa lõi được phép giống hệt bản tiếng Việt (tên riêng, tiêu đề lịch cố định). Giá trị không có chữ cái thì tự được phép. */
const SAME_AS_SOURCE = new Set(["brand.name", "theme.titanium.name", "house.robot.heading", "calendar.title.PERSONAL_TIME"]);
/** Khóa PHẢI giống hệt bản tiếng Việt ở mọi ngôn ngữ: tiêu đề máy chủ ghi vào lịch (LNH-T26). */
const MUST_EQUAL_SOURCE = ["calendar.title.PERSONAL_TIME", "brand.name"];
/** Chữ cái chỉ tiếng Việt dùng trong 13 ngôn ngữ của LeNhip: gặp trong catalog khác nghĩa là còn chữ chưa dịch. */
const VIETNAMESE_ONLY = /[ĂăĐđĨĩŨũƠơƯưẠ-ỹ]/u;
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SCRIPT: Record<string, { need?: RegExp; forbid?: RegExp; name: string }> = {
  "zh-Hans": { need: /\p{Script=Han}/u, forbid: /[們這說時為會設數據區開關]/u, name: "chữ Hán giản thể" },
  "zh-Hant": { need: /\p{Script=Han}/u, forbid: /[们这说时为会设数据区开关]/u, name: "chữ Hán phồn thể" },
  ja: { need: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, name: "kana hoặc kanji" },
  ko: { need: /\p{Script=Hangul}/u, name: "Hangul" },
  ru: { need: /\p{Script=Cyrillic}/u, name: "chữ Kirin" },
};
const CJK = new Set(["zh-Hans", "zh-Hant", "ja", "ko"]);
const OTHER_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}]/u;

const info = (tag: string) => LOCALES.find((l) => l.tag === tag)!;
/**
 * Phần catalog của V1.0.1 chờ dịch: với ngôn ngữ ngoài tiếng Việt và tiếng Anh, tệp `export default {};` của các phần này được
 * coi như chưa có (runtime lùi về tiếng Việt). Bỏ phần khỏi danh sách ngay khi bản dịch của nó vào repo.
 */
const PENDING_PARTS = new Set(["brief", "inbox", "homehub", "meas", "sim"]);
const load = (tag: string, part: string) => {
  const data = readCatalog(catalogFile(info(tag).file, part)) as Catalog | null;
  if (data && PENDING_PARTS.has(part) && tag !== SOURCE_LOCALE && tag !== "en" && Object.keys(data).length === 0) return null;
  return data;
};
const branches = (m: Message) => (typeof m === "string" ? [m] : Object.values(m));
const names = (text: string) => new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]));
/** Bỏ tham số và tên riêng để xét phần chữ thật sự cần dịch. */
const wording = (text: string, extra: string[] = []) => [...KEPT_TERMS, ...extra].reduce((s, term) => s.split(term).join(" "), text.replace(PLACEHOLDER, " "));
const count = (text: string, term: string) => text.split(term).length - 1;
const graphemes = (text: string, tag: string) => [...new Intl.Segmenter(tag, { granularity: "grapheme" }).segment(text)].length;

if (ONLY) assert.ok(LOCALES.some((l) => l.tag === ONLY), `LENHIP_I18N_ONLY=${ONLY} không phải tag trong LOCALES (${LOCALES.map((l) => l.tag).join(", ")})`);
const checked = LOCALES.filter((l) => l.tag !== SOURCE_LOCALE && (!ONLY || l.tag === ONLY));

test("LNH-T21: tiếng Việt và tiếng Anh đủ tệp; ngôn ngữ khác có tệp nào kiểm tệp đó", () => {
  for (const part of FILE_PARTS) assert.ok(load("vi", part), `thiếu ${catalogFile("vi", part)}`);
  const need = REQUIRE_ALL_LOCALES ? LOCALES.map((l) => l.tag) : ["en"];
  for (const tag of need) {
    if (ONLY && tag !== ONLY) continue;
    for (const part of FILE_PARTS) assert.ok(existsSync(new URL("shared/" + catalogFile(info(tag).file, part), web)), `thiếu ${catalogFile(info(tag).file, part)}`);
  }
  if (ONLY && ONLY !== SOURCE_LOCALE) assert.ok(load(ONLY, "core"), `LENHIP_I18N_ONLY=${ONLY}: chưa có ${catalogFile(info(ONLY).file, "core")}`);
});

test("bản gốc tiếng Việt: chuẩn NFC, nhánh số nhiều đúng loại của tiếng Việt, không ký tự lạ", () => {
  for (const part of FILE_PARTS) {
    const vi = load("vi", part)!;
    for (const [key, message] of Object.entries(vi)) {
      if (typeof message !== "string") assert.deepEqual(Object.keys(message), ["other"], `${key}: tiếng Việt chỉ có loại other`);
      for (const text of branches(message)) {
        assert.equal(text, text.normalize("NFC"), `${key}: phải ở dạng NFC`);
        assert.doesNotMatch(text, /[<>]|&[a-z#0-9]+;|[\u0000-\u0009\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁩﻿]/i, `${key}: có ký tự đánh dấu hoặc điều khiển`);
      }
    }
  }
});

for (const locale of checked) {
  for (const part of FILE_PARTS) {
    const name = catalogFile(locale.file, part);
    let data: Catalog | null;
    try {
      data = load(locale.tag, part);
    } catch (e) {
      // Tệp có nhưng không đọc được (đang viết dở, sai JSON): báo đúng tên tệp thay vì làm hỏng cả lượt kiểm.
      test(`${name}: đọc được như JSON chặt sau "export default "`, () => assert.fail(`${name}: ${(e as Error).message}`));
      continue;
    }
    if (!data) continue;
    const catalog: Catalog = data;
    test(`${name}: cùng khóa, cùng tham số, đủ nhánh số nhiều, không HTML, tên riêng giữ nguyên, không sót chữ tiếng Việt`, () => {
      const vi = load("vi", part)!;
      const calendarTitle = String(load("vi", "core")!["calendar.title.PERSONAL_TIME"]);
      assert.deepEqual(Object.keys(catalog).filter((k) => !Object.hasOwn(vi, k)), [], `${name}: khóa không có trong bản tiếng Việt`);
      assert.deepEqual(Object.keys(vi).filter((k) => !Object.hasOwn(catalog, k)), [], `${name}: thiếu khóa so với bản tiếng Việt`);
      const categories = new Intl.PluralRules(locale.tag).resolvedOptions().pluralCategories.slice().sort();
      const rule = SCRIPT[locale.tag];
      for (const [key, source] of Object.entries(vi)) {
        const message: Message = catalog[key];
        const where = `${name}: ${key}`;
        // Dạng: chuỗi ↔ chuỗi, số nhiều ↔ số nhiều (giao diện chỉ truyền `n` dạng số cho thông điệp số nhiều của bản gốc).
        assert.equal(typeof message, typeof source, `${where}: bản gốc là ${typeof source === "string" ? "chuỗi" : "thông điệp số nhiều"}`);
        if (typeof message !== "string") {
          assert.ok(message && !Array.isArray(message), where);
          // Đủ và đúng mọi loại CLDR của chính ngôn ngữ này (fr, es, pt-BR, it có cả many; ru có one, few, many, other).
          assert.deepEqual(Object.keys(message).sort(), categories, `${where}: cần đúng các nhánh ${categories.join(", ")}`);
        }
        const wanted = [...new Set(branches(source).flatMap((b) => [...names(b)]))].sort();
        const got = branches(message).map((b) => names(b));
        // Mỗi nhánh chỉ dùng tham số của bản gốc; gộp các nhánh phải dùng đủ. Chuỗi thường phải dùng đúng tập tham số.
        for (const set of got) for (const p of set) assert.ok(wanted.includes(p), `${where}: tham số lạ {${p}}`);
        assert.deepEqual([...new Set(got.flatMap((s) => [...s]))].sort(), wanted, `${where}: thiếu tham số so với bản gốc`);
        if (typeof message !== "string") assert.ok(names(message.other).size === wanted.length, `${where}: nhánh other phải có đủ tham số`);
        const sourceText = branches(source).join("\n");
        for (const text of branches(message)) {
          assert.equal(typeof text, "string", where);
          assert.ok(text.length > 0 && text.trim() === text, `${where}: rỗng hoặc có khoảng trắng đầu, cuối`);
          assert.equal(text, text.normalize("NFC"), `${where}: phải ở dạng NFC`);
          assert.doesNotMatch(text, /[<>]|&[a-z#0-9]+;/i, `${where}: có ký tự đánh dấu HTML`);
          assert.doesNotMatch(text, /[\u0000-\u0009\u000B-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁩﻿]/, `${where}: có ký tự điều khiển, ký tự ẩn hoặc ký tự điều khiển hướng chữ`);
          assert.doesNotMatch(text, /\{[^}]*\{|\{\s|\s\}|\$\{|%[sd]|\{\d+\}/, `${where}: cú pháp tham số lạ (chỉ dùng {tên})`);
          // Xuống dòng chỉ có ở tiêu đề mà bản gốc cũng xuống dòng (bản dịch tự chọn chỗ ngắt, tối đa hai chỗ).
          assert.ok((text.match(/\n/g) ?? []).length <= (sourceText.includes("\n") ? 2 : 0), `${where}: xuống dòng ở chỗ bản gốc không xuống dòng`);
          // Còn chữ tiếng Việt: chỉ tiêu đề lịch cố định được trích nguyên văn (LNH-T26).
          assert.doesNotMatch(text.split(calendarTitle).join(""), VIETNAMESE_ONLY, `${where}: còn chữ tiếng Việt chưa dịch`);
          const words = wording(text, [calendarTitle]);
          if (rule?.need && /\p{L}/u.test(words) && !(part === "core" && SAME_AS_SOURCE.has(key))) assert.match(text, rule.need, `${where}: không có ${rule.name}`);
          if (rule?.forbid) assert.doesNotMatch(text, rule.forbid, `${where}: có chữ của hệ chữ Hán kia`);
          if (!rule) assert.doesNotMatch(words, OTHER_SCRIPTS, `${where}: có chữ của hệ chữ khác`);
        }
        const text = branches(message).join("\n");
        for (const term of KEPT_TERMS) {
          // Tên riêng: nhánh số nhiều nhiều hơn bản gốc nên so theo từng nhánh với nhánh other của bản gốc.
          const expected = count(branches(source).at(-1)!, term);
          for (const b of branches(message)) assert.equal(count(b, term), expected, `${where}: «${term}» phải xuất hiện ${expected} lần như bản gốc`);
        }
        if (part === "core" && MUST_EQUAL_SOURCE.includes(key)) assert.deepEqual(message, source, `${where}: phải giữ nguyên như bản tiếng Việt`);
        // Giống hệt bản gốc: ở phần lõi phải nằm trong danh sách cho phép; ở mọi tệp, giá trị có chữ riêng của tiếng Việt là chưa dịch.
        else if (text === sourceText && /\p{L}/u.test(wording(text))) {
          if (part === "core") assert.ok(SAME_AS_SOURCE.has(key), `${where}: giống hệt bản tiếng Việt (chưa dịch?)`);
          else assert.doesNotMatch(text, VIETNAMESE_ONLY, `${where}: giống hệt bản tiếng Việt (chưa dịch?)`);
        }
      }
    });
  }
}

test("LNH-T28: nhãn điều hướng (khóa nav.<chữ thường>) dài tối đa 12 ký tự với chữ Latin và Kirin, 6 với chữ Hán, kana, Hangul", () => {
  const isLabel = (key: string) => /^nav\.[a-z]+$/.test(key);
  const vi = load("vi", "core")!;
  assert.deepEqual(Object.keys(vi).filter(isLabel).sort(), ["nav.connect", "nav.health", "nav.home", "nav.house", "nav.inbox", "nav.messages", "nav.more", "nav.services", "nav.work"]);
  for (const locale of LOCALES) {
    if (ONLY && locale.tag !== ONLY && locale.tag !== SOURCE_LOCALE) continue;
    const data = load(locale.tag, "core");
    if (!data) continue;
    const budget = CJK.has(locale.tag) ? 6 : 12;
    for (const [key, message] of Object.entries(data)) {
      if (!isLabel(key)) continue;
      assert.equal(typeof message, "string", `${locale.tag}: ${key}`);
      const length = graphemes(message as string, locale.tag);
      assert.ok(length <= budget, `${locale.tag}: ${key} = «${message}» dài ${length} ký tự, tối đa ${budget}`);
    }
  }
});

// ---------------------------------------------------------------- mã nguồn giao diện không còn câu chữ ngoài catalog
const SOURCE_FILES = ["app.js", "model.js", "api.js", "views/core.js"];
const NON_ASCII_LETTER = /[^\u0000-\u007F]/u;
const isLetterOutsideAscii = (text: string) => [...text].some((ch) => NON_ASCII_LETTER.test(ch) && /\p{L}/u.test(ch));
/** Chuỗi, phần chữ của template và biểu thức chính quy trong một tệp JS, kèm dòng; `dev` là đối số của `new …Error(...)`. */
function literals(file: string) {
  const text = readFileSync(new URL(file, web), "utf8");
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const out: { raw: string; value: string; line: number; dev: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) {
      const parent = node.parent;
      const dev = ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText(src));
      out.push({ raw: node.getText(src), value: node.text, line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1, dev });
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return { text, out };
}

test("mã nguồn giao diện: không chuỗi nào chứa chữ có dấu (câu chữ nằm ở catalog); lỗi không in message của máy chủ", () => {
  for (const file of SOURCE_FILES) {
    const { text, out } = literals(file);
    // Đối số của `new …Error(...)` là thông báo cho nhà phát triển (không bao giờ in ra giao diện) nên được viết tiếng Việt như
    // chú thích. Biểu thức chính quy cũng được xét: quy tắc so khớp của LeLe nằm ở bảng từ dùng chung (shared/lele-lexicon.js,
    // LNH-T24), không còn từ tiếng Việt nào dựng sẵn trong mã giao diện.
    const found = out.filter((l) => !l.dev && isLetterOutsideAscii(l.raw)).map((l) => `${file}:${l.line} ${l.raw.slice(0, 60)}`);
    assert.deepEqual(found, [], "còn chuỗi có chữ ngoài ASCII");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\b(?:e|e2|err|error|body)\??\.message\b/, `${file}: không đọc message của lỗi để hiển thị (LNH-T23)`);
    assert.doesNotMatch(code, /toLocale(?:String|DateString|TimeString)\(\s*["'`]/, `${file}: định dạng số và ngày đi qua shared/i18n.js, không ghi cứng ngôn ngữ`);
  }
  const app = readFileSync(new URL("app.js", web), "utf8");
  assert.doesNotMatch(app, /replace\(\/\(\\d\+\)/, "không đọc lại chuỗi thời lượng đã định dạng: dùng formatDurationParts");
  assert.doesNotMatch(app, /\.toUpperCase\(\)/, "chữ hoa do CSS hoặc toLocaleUpperCase theo ngôn ngữ");
});

/** Nút văn bản của index.html (bỏ chú thích, thẻ, và nội dung của script, style). */
function htmlTextNodes(html: string) {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/g, "").split(/<[^>]*>/).map((s) => s.trim()).filter(Boolean);
}

test("index.html: chữ lấy từ catalog qua data-i18n; nút văn bản chỉ còn tên thương hiệu và ký hiệu", async () => {
  const html = readFileSync(new URL("index.html", web), "utf8");
  assert.match(html, /<html lang="vi" dir="ltr" translate="no">/);
  assert.match(html, /<body class="i18n-pending">/);
  const allowed = new Set(["LeNhip", "by LeTRON", "··", "✕", "•", "↗"]);
  assert.deepEqual(htmlTextNodes(html).filter((text) => !allowed.has(text)), [], "nút văn bản ngoài danh sách cho phép");
  for (const m of html.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) assert.fail(`thuộc tính văn bản ghi cứng: ${m[0].trim()} (dùng data-i18n-attr)`);
  const vi = load("vi", "core")!;
  const keys = [...html.matchAll(/\sdata-i18n="([^"]+)"/g)].map((m) => m[1]);
  const pairs = [...html.matchAll(/\sdata-i18n-attr="([^"]+)"/g)].flatMap((m) => m[1].split(";").map((p) => p.trim()).filter(Boolean));
  assert.ok(keys.length >= 20 && pairs.length >= 8);
  for (const key of keys) assert.equal(typeof vi[key], "string", `data-i18n="${key}" không có trong catalog`);
  for (const pair of pairs) {
    const [attr, key] = pair.split(":").map((s) => s.trim());
    assert.ok(["aria-label", "title", "content"].includes(attr), pair);
    assert.equal(typeof vi[key], "string", `data-i18n-attr="${pair}" không có trong catalog`);
  }
  // Hai nút by LeTRON và chữ LeNhip ở chân trang được đánh dấu là chữ cố định, không dịch.
  assert.equal((html.match(/data-fixed/g) ?? []).length - 1, 3, "ba phần tử data-fixed (và một lần nhắc trong chú thích)");

  // localizeStatic: điền textContent và thuộc tính; từ chối thuộc tính không phải văn bản.
  await setLocale("vi");
  const node = (attrs: Record<string, string>) => ({ attrs: { ...attrs }, textContent: "", getAttribute(n: string) { return this.attrs[n] ?? null; }, setAttribute(n: string, v: string) { this.attrs[n] = v; } });
  const a = node({ "data-i18n": "nav.skipLink" });
  const b = node({ "data-i18n-attr": "aria-label:settings.open.label; title:settings.open.title" });
  const root = (list: ReturnType<typeof node>[]) => ({ querySelectorAll: (sel: string) => list.filter((n) => n.getAttribute(sel.slice(1, -1)) !== null) });
  localizeStatic(root([a, b]));
  assert.equal(a.textContent, "Đến nội dung chính");
  assert.deepEqual([b.attrs["aria-label"], b.attrs.title], ["Mở cá nhân hóa", "Cá nhân hóa"]);
  await setLocale("en");
  localizeStatic(root([a, b]));
  assert.equal(a.textContent, "Skip to main content");
  assert.equal(b.attrs.title, "Personalize");
  for (const bad of ["href:nav.home", "onclick:nav.home", "style:nav.home", "aria-label", ":nav.home", "title:"]) assert.throws(() => localizeStatic(root([node({ "data-i18n-attr": bad })])), /data-i18n-attr không hợp lệ/, bad);
  await setLocale("vi");
});

// ---------------------------------------------------------------- khóa dùng trong mã ↔ khóa của catalog
const KEY = /^[a-z][a-z0-9]*(?:\.[A-Za-z0-9_]+)+$/;
/** Chuỗi dạng khóa nhưng là mã của hợp đồng (loại tác vụ, quyền), không phải khóa catalog. */
const NOT_KEYS = new Set(["calendar.block", "device.set_power", "robot.simulate", "social.post", "messaging.use"]);
/** Họ khóa dựng lúc chạy từ mã của hợp đồng; từng họ có phép kiểm phủ riêng bên dưới. */
const DYNAMIC = ["state.", "outcome.", "reason.", "grade.", "error.", "lele.answer.", "theme.", "consent."];
/** Khóa của phần giữ chỗ trong khung giao diện: chỉ các tệp của nhánh tính năng dùng, hết dùng khi nhánh đó thay tệp giữ chỗ. */
const MAY_BE_UNUSED = new Set(["connect.sessions.title", "connect.social.title", "connect.endpoints.title", "connect.trackers.title", "nav.messages"]);

test("khóa: mọi khóa mã nguồn lõi nhắc tới đều có trong bản gốc; mọi khóa lõi đều được dùng", () => {
  const core = load("vi", "core")!;
  const all = new Set(FILE_PARTS.flatMap((part) => Object.keys(load("vi", part)!)));
  const namespaces = new Set(Object.keys(core).map((k) => k.slice(0, k.indexOf("."))));
  const used = new Set<string>();
  // Tệp của nhánh ngôn ngữ: mọi chuỗi dạng khóa có không gian tên của catalog lõi phải là khóa thật.
  for (const file of ["app.js", "views/core.js", "shared/sleep.js", "shared/consent-text.js"]) {
    for (const l of literals(file).out) {
      if (!KEY.test(l.value) || NOT_KEYS.has(l.value) || !namespaces.has(l.value.slice(0, l.value.indexOf(".")))) continue;
      used.add(l.value);
      assert.ok(Object.hasOwn(core, l.value), `${file}:${l.line} nhắc khóa ${l.value} không có trong i18n-vi.js`);
    }
  }
  const html = readFileSync(new URL("index.html", web), "utf8");
  for (const m of html.matchAll(/\sdata-i18n="([^"]+)"/g)) used.add(m[1]);
  for (const m of html.matchAll(/\sdata-i18n-attr="([^"]+)"/g)) for (const pair of m[1].split(";")) if (pair.includes(":")) used.add(pair.slice(pair.indexOf(":") + 1).trim());
  // Tệp của khung và của các nhánh tính năng: chỉ xét khóa truyền thẳng cho ctx.t / ctx.tSafe.
  for (const file of readdirSync(new URL("views/", web)).filter((f) => f.endsWith(".js"))) {
    const text = readFileSync(new URL("views/" + file, web), "utf8");
    for (const m of text.matchAll(/\bctx\.(?:t|tSafe)\(\s*"([^"]+)"/g)) {
      used.add(m[1]);
      // Chuỗi kết thúc bằng dấu chấm là họ khóa dựng lúc chạy ("social.status." + mã): bản gốc phải có ít nhất một khóa của họ đó.
      if (m[1].endsWith(".")) assert.ok([...all].some((k) => k.startsWith(m[1])), `views/${file}: họ khóa ctx.t("${m[1]}" + …) không có khóa nào trong bản gốc tiếng Việt`);
      else assert.ok(all.has(m[1]), `views/${file}: ctx.t("${m[1]}") không có trong bản gốc tiếng Việt`);
    }
  }
  const unused = Object.keys(core).filter((k) => !used.has(k) && !MAY_BE_UNUSED.has(k) && !DYNAMIC.some((p) => k.startsWith(p)));
  assert.deepEqual(unused, [], "khóa lõi không được mã nào dùng");
});

test("LNH-T23: mọi mã của hợp đồng có câu ở bản gốc: lỗi, trạng thái, kết quả, hạng bằng chứng, phong cách, mục đích", () => {
  const vi = load("vi", "core")!;
  const has = (key: string) => assert.ok(Object.hasOwn(vi, key), `thiếu khóa ${key}`);
  // Lỗi: mọi mã trong MESSAGES của máy chủ và OFFLINE của client; không khóa lỗi nào cho mã không tồn tại.
  const codes = [...Object.keys(MESSAGES), "OFFLINE"];
  for (const code of codes) has("error." + code);
  for (const key of ["error.generic", "error.genericWithId"]) has(key);
  const details: Record<string, string[]> = { SCHEMA_INVALID: ["WINDOW_TOO_LONG", "WORKSPACE_HEADER", "END_BEFORE_START"], UNSUPPORTED: ["BLOCK_TOO_LONG", "START_IN_PAST", "BEYOND_HORIZON"] };
  const expected = new Set(["error.generic", "error.genericWithId", ...codes.map((c) => "error." + c), ...Object.entries(details).flatMap(([c, list]) => list.map((d) => `error.${c}.${d}`))]);
  assert.deepEqual(Object.keys(vi).filter((k) => k.startsWith("error.")).sort(), [...expected].sort());
  // Câu chung nêu mã và mã yêu cầu; câu chi tiết có giới hạn dùng {n}.
  assert.deepEqual([...names(vi["error.genericWithId"] as string)].sort(), ["code", "request_id"]);
  for (const key of ["error.SCHEMA_INVALID.WINDOW_TOO_LONG", "error.UNSUPPORTED.BLOCK_TOO_LONG", "error.UNSUPPORTED.BEYOND_HORIZON"]) assert.deepEqual([...names((vi[key] as Record<string, string>).other)], ["n"], key);

  const api = parseStrictJson(readFileSync(new URL("../contracts/openapi.json", import.meta.url), "utf8"), 64) as { components: { schemas: Record<string, { properties: Record<string, { enum: (string | null)[] }> }> } };
  const action = api.components.schemas.Action.properties;
  const families: [string, (string | null)[]][] = [["state.", action.status.enum], ["outcome.", action.outcome.enum], ["grade.", action.evidence_grade.enum]];
  for (const [prefix, values] of families) {
    assert.deepEqual(Object.keys(vi).filter((k) => k.startsWith(prefix)).sort(), values.filter((v): v is string => v !== null).map((v) => prefix + v).sort(), `${prefix}* phải khớp enum của Action trong OpenAPI`);
  }
  assert.ok(Object.keys(vi).filter((k) => k.startsWith("reason.")).length >= 14);
  // Phong cách và mục đích đồng ý của lõi.
  assert.deepEqual(Object.keys(vi).filter((k) => /^theme\.[a-z]+\.name$/.test(k)).sort(), THEMES.map((th) => `theme.${th.id}.name`).sort());
  for (const th of THEMES) has(`theme.${th.id}.description`);
  for (const th of THEMES) assert.deepEqual(Object.keys(th).sort(), ["accent", "code", "colors", "id"], "THEMES không mang câu chữ");
  for (const purpose of ["health_local", "calendar_link", "home_control", "beta_telemetry"]) for (const leaf of ["title", "body"]) has(`consent.${purpose}.${leaf}`);
  has("consent.notice.head");
  has("lele.answer.fallback");
});

// ---------------------------------------------------------------- runtime: các hàm thêm ở nhánh ngôn ngữ
test("tParts, tSource, messageLocale, hasCatalog: từng phần của thông điệp, bản gốc, catalog cung cấp khóa", async (ctx) => {
  ctx.mock.method(console, "warn", () => {});
  await setLocale("en");
  assert.deepEqual(tParts("home.greeting", { name: "A" }), [{ type: "text", value: "Hello, " }, { type: "param", name: "name", value: "A" }, { type: "text", value: "." }]);
  assert.deepEqual(tParts("health.steps.value", { n: 8432 }), [{ type: "param", name: "n", value: "8,432" }, { type: "text", value: " steps" }]);
  assert.deepEqual(tParts("health.steps.value", { n: 1 }).at(-1), { type: "text", value: " step" });
  assert.deepEqual(tParts("test.khong_co"), [{ type: "text", value: "test.khong_co" }]);
  assert.throws(() => tParts("home.greeting"), /thiếu tham số \{name\}/);
  assert.equal(t("home.greeting", { name: "A" }), "Hello, A.");
  assert.equal(tSource("home.greeting", { name: "A" }), "Chào A.");
  assert.equal(tSource("health.steps.value", { n: 8432 }), "8.432 bước", "số định dạng theo ngôn ngữ của thông điệp gốc");
  assert.equal(tSource("test.khong_co"), "test.khong_co");
  assert.equal(messageLocale("nav.home"), "en");
  assert.equal(messageLocale("test.khong_co"), null);
  assert.ok(hasCatalog("en") && hasCatalog("en", "msg") && hasCatalog("vi") && !hasCatalog("xx"));
  assert.ok(hasSourceMessage("nav.home") && !hasSourceMessage("test.khong_co"));
  // Ngôn ngữ chỉ có một phần catalog: khóa thiếu lấy từ bản gốc và messageLocale nói rõ điều đó.
  await loadLocale("it", { it: { core: async () => ({ default: { "nav.home": "Oggi" } }) } } as never);
  await setLocale("it");
  assert.deepEqual([messageLocale("nav.home"), messageLocale("nav.work"), t("nav.work")], ["it", "vi", "Công việc"]);
  assert.ok(hasCatalog("it") && !hasCatalog("it", "msg"));
  assert.equal(LANGUAGE_WORD, "Language");
  await setLocale("vi");
});

test("LNH-T27: thời lượng theo từng phần ghép lại đúng bằng formatDuration; tên thứ gọn không nhập nhằng", async (ctx) => {
  ctx.mock.method(console, "warn", () => {}); // ngôn ngữ chưa có catalog vẫn định dạng được bằng Intl
  for (const l of LOCALES) {
    await setLocale(l.tag);
    for (const minutes of [0, 29, 60, 432, 450, 1505]) {
      const parts = formatDurationParts(minutes);
      assert.equal(parts.map((p) => p.value).join(""), formatDuration(minutes), `${l.tag} ${minutes}`);
      assert.ok(parts.some((p) => p.type === "number") && parts.some((p) => p.type === "unit"), `${l.tag} ${minutes}`);
      assert.equal(parts.filter((p) => p.type === "number").map((p) => p.value).join("|"), [Math.floor(minutes / 60), minutes % 60].filter((v, i) => v > 0 || (i === 1 && minutes < 60)).map((v) => new Intl.NumberFormat(l.tag).format(v)).join("|"), `${l.tag} ${minutes}`);
    }
    const week = ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"].map((d) => formatWeekdayCompact(d));
    assert.equal(new Set(week).size, 7, `${l.tag}: bảy tên thứ gọn phải khác nhau (${week.join(" ")})`);
  }
  await setLocale("vi");
  assert.deepEqual(formatDurationParts(432).filter((p) => p.type !== "literal"), [{ type: "number", value: "7" }, { type: "unit", value: "giờ" }, { type: "number", value: "12" }, { type: "unit", value: "phút" }]);
  assert.deepEqual(["2026-11-15", "2026-11-16", "2026-11-21"].map((d) => formatWeekdayCompact(d)), ["CN", "T2", "T7"], "tiếng Việt giữ nhãn cột của bản 0.1.0");
  await setLocale("en");
  assert.equal(formatWeekdayCompact("2026-11-16"), "Mon");
  assert.throws(() => formatDurationParts(-1), RangeError);
  await setLocale("vi");
});

test("câu về giấc ngủ: bản tiếng Việt dựng từ khóa và tham số trùng từng chữ với sleepSentence() của LNH-SLEEP-1", async () => {
  await setLocale("vi");
  const render = (summary: { sleep_observed_days: number; sleep_average_seconds: number | null }) => {
    const m = sleepMessage(summary);
    return t(m.key, m.durationMinutes === null ? m.params : { ...m.params, duration: formatDuration(m.durationMinutes) });
  };
  for (let days = 0; days <= COMPLETED_DAYS; days++) {
    for (const seconds of [null, 0, 59, 60, 1740, 3600, 25200, 25920, 27000, 27059, 36000, 86399]) {
      const summary = { sleep_observed_days: days, sleep_average_seconds: seconds };
      assert.equal(plain(render(summary)), sleepSentence(summary), JSON.stringify(summary));
    }
  }
  assert.deepEqual(sleepMessage({ sleep_observed_days: 3, sleep_average_seconds: null }), { key: "health.sleep.sentence.insufficient", params: { n: 3, total: COMPLETED_DAYS, min: MIN_OBSERVED_DAYS }, durationMinutes: null });
  assert.deepEqual(sleepMessage({ sleep_observed_days: 5, sleep_average_seconds: 25979 }), { key: "health.sleep.sentence.average", params: { n: 5 }, durationMinutes: 432 });
  await setLocale("en");
  assert.equal(plain(render({ sleep_observed_days: 5, sleep_average_seconds: 25920 })), "Across 5 days with data, the average sleep duration is 7 hr 12 min.");
  assert.match(render({ sleep_observed_days: 3, sleep_average_seconds: null }), /^Only 3 of 7 days .* at least 4 days/);
  await setLocale("vi");
});

test("tùy chọn giao diện và lỗi API không mang câu chữ: tên mặc định để trống, lỗi tệp mang khóa, ApiError mang mã", () => {
  assert.equal(defaults().name, "");
  assert.equal(sanitizeSettings({ ...defaults("A"), name: "  " }).name, "");
  assert.equal(sanitizeSettings({ ...defaults("A"), name: "Bạn" }).name, "", "tên mặc định cũ «Bạn» của 0.1.0 thành để trống: giao diện in common.you theo ngôn ngữ");
  assert.equal(sanitizeSettings({ ...defaults("A"), name: " Bạn A " }).name, "Bạn A");
  assert.throws(() => sanitizeSettings(null), (e: unknown) => e instanceof SettingsFileError && e.key === "settings.import.invalid");
  for (const key of ["settings.import.invalid", "settings.import.tooLarge", "settings.import.unsupported", "common.you"]) assert.ok(hasSourceMessage(key), key);

  const e = new ApiError(422, { code: "UNSUPPORTED", message: "Khung giờ dài tối đa 240 phút.", detail_code: "BLOCK_TOO_LONG", limit: 240, request_id: "req_1", retryable: false });
  assert.deepEqual([e.code, e.detail_code, e.limit, e.request_id, e.status], ["UNSUPPORTED", "BLOCK_TOO_LONG", 240, "req_1", 422]);
  assert.equal(e.message, "UNSUPPORTED (HTTP 422)", "Error.message là mã cho log, không phải câu của máy chủ");
  const old = new ApiError(400, { code: "SCHEMA_INVALID", message: "Giờ kết thúc phải sau giờ bắt đầu.", request_id: "req_2", retryable: false });
  assert.deepEqual([old.detail_code, old.limit], [null, null], "máy chủ chưa gửi mã chi tiết: client lùi về câu của mã");
  assert.deepEqual([new ApiError(0, { code: "OFFLINE" }).code, new ApiError(0, null).code, new ApiError(500, null).code, new ApiError(500, { limit: "9" }).limit], ["OFFLINE", "OFFLINE", "ERROR", null]);
});

// ---------------------------------------------------------------- văn bản đồng ý theo ngôn ngữ (LNH-T25, LNH-F28)
/** Mã băm mà bản 0.1.0 (commit 4b33ccc, web/app.js) gửi cho bốn mục đích: digestJcs(NOTICE_HEAD + "\n" + text), phiên bản v1-2026-11-11. */
const V0_1_0 = {
  health_local: "btXegqxR6BBYWFnwf0EAg8y-mQL3DbD6oXUP4r_gsFE",
  calendar_link: "_fo3rtoPRPfXXlyadl8Lkmpwh4P_srSBdd8W1LiedoQ",
  home_control: "N_b1B1VQqw-L89adKpZaq47OfK7hIufDP-I4iCnnWeA",
  beta_telemetry: "SnhbVdsdmKfXl0emCc-5dNSUqPGMnoJh2l1Ws8JDaVc",
};

test("LNH-T25: sổ ghim văn bản đồng ý khớp catalog; sửa văn bản mà không đổi phiên bản thì hỏng; bản tiếng Việt giữ mã băm của 0.1.0", async () => {
  const recorded = readRegistry();
  assert.ok(existsSync(REGISTRY_URL) && recorded.length > 0, "thiếu contracts/consent-texts.json: chạy node scripts/make-consent-texts.ts");
  const ids = new Set<string>();
  for (const e of recorded) {
    assert.deepEqual(Object.keys(e), ["purpose_id", "locale", "text_version", "sha256"]);
    assert.ok(Object.hasOwn(CONSENT_TEXT_VERSIONS, e.purpose_id) && LOCALES.some((l) => l.tag === e.locale), entryId(e));
    assert.match(e.text_version, /^[A-Za-z0-9._-]{1,32}$/);
    assert.match(e.sha256, /^[A-Za-z0-9_-]{43}$/, "sha256 là SHA-256 base64url không đệm, đúng dạng text_hash");
    assert.equal(e.text_version.endsWith("." + e.locale), e.locale !== "vi", `${entryId(e)}: bản dịch mang hậu tố .<tag>, bản tiếng Việt thì không`);
    assert.ok(!ids.has(entryId(e)), `dòng lặp ${entryId(e)}`);
    ids.add(entryId(e));
  }
  const current = await currentConsentTexts(ONLY ?? undefined);
  const { added, changed } = mergeRegistry(recorded, current);
  assert.deepEqual(changed.map(entryId), [], "văn bản đồng ý đã đổi mà phiên bản chưa đổi: đổi CONSENT_TEXT_VERSIONS (web/shared/consent-text.js) rồi chạy node scripts/make-consent-texts.ts");
  // Khi chỉ kiểm một ngôn ngữ, dòng chưa có trong sổ được bỏ qua (sổ sinh lại một lần sau khi dịch xong).
  if (!ONLY) {
    assert.deepEqual(added.map(entryId), [], "sổ thiếu dòng: chạy node scripts/make-consent-texts.ts");
    assert.equal(readFileSync(REGISTRY_URL, "utf8"), formatRegistry(mergeRegistry(recorded, current).entries), "sổ không đúng thứ tự hoặc định dạng: chạy node scripts/make-consent-texts.ts");
  }
  // Phép kiểm tự nó bắt được việc sửa văn bản: đổi một mã băm trong bản chép của sổ thì bị báo.
  const tampered = recorded.map((e, i) => (i === 0 ? { ...e, sha256: "A".repeat(43) } : e));
  if (!ONLY || ONLY === recorded[0].locale) assert.deepEqual(mergeRegistry(tampered, current).changed.map(entryId), [entryId(recorded[0])]);

  // Bản tiếng Việt: đúng phiên bản và mã băm mà 0.1.0 đã ghi vào biên nhận.
  for (const [purpose, hash] of Object.entries(V0_1_0)) {
    const row = recorded.find((e) => e.purpose_id === purpose && e.locale === "vi" && e.text_version === "v1-2026-11-11");
    assert.equal(row?.sha256, hash, `${purpose}: mã băm tiếng Việt khác bản 0.1.0`);
  }
  // Mọi tệp catalog: khóa thân văn bản đồng ý đúng quy ước, mục đích có phiên bản.
  for (const locale of LOCALES) {
    if (ONLY && locale.tag !== ONLY && locale.tag !== "vi") continue;
    for (const part of FILE_PARTS) {
      const data = load(locale.tag, part);
      for (const key of Object.keys(data ?? {})) {
        const m = CONSENT_BODY_KEY.exec(key);
        if (!m && /(?:^|\.)consent\.[^.]+\.body$/.test(key)) assert.fail(`${catalogFile(locale.file, part)}: ${key} không đúng dạng consent.<purpose_id>.body`);
        if (m) assert.ok(Object.hasOwn(CONSENT_TEXT_VERSIONS, m[1]), `${catalogFile(locale.file, part)}: mục đích ${m[1]} chưa có trong CONSENT_TEXT_VERSIONS`);
      }
    }
  }
});

test("LNH-T25: biên nhận ghi phiên bản và mã băm của văn bản đang hiện; thiếu bản dịch thì là bản gốc tiếng Việt", async (ctx) => {
  ctx.mock.method(console, "warn", () => {});
  assert.equal(consentTextVersion("calendar_link", "vi"), "v1-2026-11-11");
  assert.equal(consentTextVersion("calendar_link", "zh-Hant"), "v1-2026-11-11.zh-Hant");
  for (const l of LOCALES) for (const purpose of Object.keys(CONSENT_TEXT_VERSIONS)) assert.match(consentTextVersion(purpose, l.tag), /^[A-Za-z0-9._-]{1,32}$/);
  assert.throws(() => consentTextVersion("tracking", "vi"), RangeError);
  assert.deepEqual(consentKeys("messaging", "msg."), { head: "msg.consent.notice.head", title: "msg.consent.messaging.title", body: "msg.consent.messaging.body" });
  for (const bad of [["Messaging", ""], ["messaging", "msg"], ["messaging", "../"], ["", ""]]) assert.throws(() => consentKeys(bad[0], bad[1]), RangeError);
  assert.equal(composeConsentText("", "thân"), "thân");
  assert.equal(composeConsentText("đầu", "thân"), "đầu\nthân");

  await setLocale("vi");
  for (const [purpose, hash] of Object.entries(V0_1_0)) assert.deepEqual(await consentReceipt(purpose), { text_version: "v1-2026-11-11", text_hash: hash, locale: "vi" });
  const registry = readRegistry();
  await setLocale("en");
  for (const purpose of Object.keys(V0_1_0)) {
    const shown = consentText(purpose);
    const receipt = await consentReceipt(purpose);
    assert.deepEqual([shown.locale, shown.text_version, receipt.text_version], ["en", "v1-2026-11-11.en", "v1-2026-11-11.en"]);
    assert.equal(shown.text, t("consent.notice.head") + "\n" + t(`consent.${purpose}.body`), "văn bản băm = phần đầu + xuống dòng + thân của ngôn ngữ đang hiện");
    assert.equal(receipt.text_hash, await digestJcs(shown.text));
    if (!ONLY || ONLY === "en") assert.equal(registry.find((e) => e.purpose_id === purpose && e.locale === "en" && e.text_version === receipt.text_version)?.sha256, receipt.text_hash, "mã băm của thiết bị trùng sổ ghim");
  }
  // Ngôn ngữ thiếu thân, hoặc có thân mà thiếu phần đầu: hiện trọn bản gốc và ghi phiên bản tiếng Việt, không ghép hai ngôn ngữ.
  const partial = (core: Record<string, string>) => ({ es: { core: async () => ({ default: core }) } }) as never;
  const halves: Record<string, string>[] = [{ "consent.notice.head": "Aviso" }, { "consent.calendar_link.body": "Leer…" }];
  for (const core of halves) {
    await loadLocale("es", partial(core));
    await setLocale("es");
    assert.deepEqual(await consentReceipt("calendar_link"), { text_version: "v1-2026-11-11", text_hash: V0_1_0.calendar_link, locale: "vi" });
  }
  await loadLocale("es", partial({ "consent.notice.head": "Aviso", "consent.calendar_link.body": "Leer…", "consent.calendar_link.title": "Calendario" }));
  assert.deepEqual(consentText("calendar_link"), { purpose_id: "calendar_link", locale: "es", head: "Aviso", body: "Leer…", title: "Calendario", text: "Aviso\nLeer…", text_version: "v1-2026-11-11.es" });
  // Văn bản của một phần (mô-đun) chưa có trong bản gốc: báo lỗi rõ ràng thay vì băm chính tên khóa.
  assert.throws(() => consentText("messaging", "test."), /bản gốc thiếu khóa test\.consent\.messaging\.body/);
  assert.equal(getLocale(), "es");
  await setLocale("vi");
});

test("bảng nạp và catalog thật: mỗi ngôn ngữ có tệp lõi thì nạp được và trả đúng câu của mình", async (ctx) => {
  ctx.mock.method(console, "warn", () => {});
  for (const locale of LOCALES) {
    if (ONLY && locale.tag !== ONLY && locale.tag !== "vi") continue;
    const data = load(locale.tag, "core");
    if (!data) continue;
    assert.deepEqual((await LOADERS[locale.tag].core()).default, data, locale.tag);
    const fresh = (await import(String(new URL("../web/shared/i18n.js?kiem-" + locale.file, import.meta.url)))) as typeof import("../web/shared/i18n.js");
    await fresh.setLocale(locale.tag);
    assert.ok(fresh.hasCatalog(locale.tag), locale.tag);
    assert.equal(fresh.t("nav.home"), data["nav.home"], locale.tag);
    assert.equal(fresh.t("brand.name"), "LeNhip");
    // Mọi thông điệp dựng được với tham số của nó, kể cả mọi nhánh số nhiều.
    for (const [key, message] of Object.entries(data)) {
      const params = Object.fromEntries([...new Set(branches(message).flatMap((b) => [...names(b)]))].map((p) => [p, "x"]));
      for (const n of typeof message === "string" ? [undefined] : [0, 1, 2, 3, 5, 11, 21, 1.5, 1_000_000]) assert.ok(fresh.t(key, n === undefined ? params : { ...params, n }).length > 0, `${locale.tag}: ${key}`);
    }
  }
  assert.ok(hasMessage("nav.home"));
});
