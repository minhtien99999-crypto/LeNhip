// Sổ ghim văn bản đồng ý contracts/consent-texts.json (LNH-T25, LNH-F28): với mỗi mục đích × ngôn ngữ, phiên bản và mã băm
// của đúng văn bản mà giao diện hiện ra và băm vào biên nhận. Sinh từ MỌI tệp catalog đang có trên đĩa (phần lõi và các phần
// msg, social, dev), theo quy ước khóa ở web/shared/consent-text.js: thân nằm ở khóa khớp `(^|\.)consent\.<purpose_id>\.body$`,
// phần đầu chung (nếu có) ở `<tiền tố>consent.notice.head` của cùng tệp.
//
//   node scripts/make-consent-texts.ts            sinh lại tệp (giữ các dòng của phiên bản cũ, thêm dòng mới)
//   node scripts/make-consent-texts.ts --check    chỉ kiểm, không ghi; mã thoát 1 nếu tệp chưa khớp catalog
//
// Mỗi dòng: { purpose_id, locale, text_version, sha256 }. `sha256` là SHA-256 trên dạng JCS (RFC 8785) của văn bản, mã hóa
// base64url không đệm: đúng giá trị `text_hash` mà thiết bị gửi lên /v1/consents, nên so được trực tiếp với biên nhận.
// Văn bản = phần đầu + "\n" + thân khi bản gốc tiếng Việt có phần đầu, không thì chỉ có thân.
//
// Sổ chỉ được thêm: một dòng (purpose_id, locale, text_version) đã ghi thì mã băm của nó không đổi nữa. Sửa một văn bản đồng
// ý mà không đổi phiên bản trong CONSENT_TEXT_VERSIONS thì tệp này từ chối ghi và tests/i18n.test.ts hỏng. Dòng của phiên bản
// cũ được giữ lại để biên nhận cũ vẫn đối chiếu được với văn bản người dùng đã đọc.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LOCALES, PARTS, SOURCE_LOCALE } from "../web/shared/i18n.js";
import { CONSENT_BODY_KEY, CONSENT_TEXT_VERSIONS, composeConsentText, consentKeys, consentTextVersion } from "../web/shared/consent-text.js";
import { digestJcs } from "../web/shared/jcs.js";
import { parseStrictJson } from "../src/core/strict-json.ts";

export interface ConsentTextEntry {
  purpose_id: string;
  locale: string;
  text_version: string;
  sha256: string;
}

export const REGISTRY_URL = new URL("../contracts/consent-texts.json", import.meta.url);
const SHARED = new URL("../web/shared/", import.meta.url);
const FILE_PARTS = ["core", ...PARTS];
const PURPOSE_ORDER = Object.keys(CONSENT_TEXT_VERSIONS);
const LOCALE_ORDER = LOCALES.map((l) => l.tag);

/** Tên tệp catalog của một ngôn ngữ và một phần ("core" là phần lõi). */
export const catalogFile = (file: string, part: string) => `i18n-${file}${part === "core" ? "" : "-" + part}.js`;

/** Đọc một tệp catalog từ đĩa (JSON chặt sau `export default `); null khi tệp chưa có. */
export function readCatalog(name: string): Record<string, unknown> | null {
  const url = new URL(name, SHARED);
  if (!existsSync(url)) return null;
  const raw = readFileSync(url, "utf8");
  if (!raw.startsWith("export default ") || !raw.endsWith(";\n")) throw new Error(`${name}: phải có dạng "export default " + JSON + ";" + xuống dòng`);
  return parseStrictJson(raw.slice("export default ".length, -2)) as Record<string, unknown>;
}

/**
 * Văn bản đồng ý đang có trong các catalog trên đĩa, mỗi mục đích × ngôn ngữ một dòng. Ngôn ngữ thiếu thân (hoặc thiếu phần
 * đầu mà bản gốc có) thì không có dòng: lúc chạy giao diện hiện bản gốc tiếng Việt và ghi phiên bản tiếng Việt.
 * @param only chỉ xét một ngôn ngữ (biến LENHIP_I18N_ONLY của kiểm thử)
 */
export async function currentConsentTexts(only?: string): Promise<ConsentTextEntry[]> {
  const source = LOCALES.find((l) => l.tag === SOURCE_LOCALE);
  if (!source) throw new Error("thiếu ngôn ngữ gốc");
  const out: ConsentTextEntry[] = [];
  const owner = new Map<string, string>();
  for (const part of FILE_PARTS) {
    const sourceName = catalogFile(source.file, part);
    const origin = readCatalog(sourceName);
    if (!origin) continue;
    for (const key of Object.keys(origin)) {
      const m = CONSENT_BODY_KEY.exec(key);
      if (!m) continue;
      const purpose = m[1];
      const prefix = key.slice(0, key.length - `consent.${purpose}.body`.length);
      const keys = consentKeys(purpose, prefix);
      if (owner.has(purpose)) throw new Error(`mục đích ${purpose} có văn bản đồng ý ở hai nơi: ${owner.get(purpose)} và ${sourceName}`);
      owner.set(purpose, sourceName);
      const withHead = Object.hasOwn(origin, keys.head);
      for (const locale of LOCALES) {
        if (only && locale.tag !== only) continue;
        const name = catalogFile(locale.file, part);
        const catalog = locale.tag === SOURCE_LOCALE ? origin : readCatalog(name);
        if (!catalog || !Object.hasOwn(catalog, keys.body) || (withHead && !Object.hasOwn(catalog, keys.head))) continue;
        const body = catalog[keys.body];
        const head = withHead ? catalog[keys.head] : "";
        if (typeof body !== "string" || typeof head !== "string") throw new Error(`${name}: văn bản đồng ý của ${purpose} phải là chuỗi, không phải thông điệp số nhiều`);
        out.push({ purpose_id: purpose, locale: locale.tag, text_version: consentTextVersion(purpose, locale.tag), sha256: await digestJcs(composeConsentText(head, body)) });
      }
    }
  }
  return sortEntries(out);
}

const rank = (list: string[], value: string) => (list.includes(value) ? list.indexOf(value) : list.length);
export function sortEntries(entries: ConsentTextEntry[]): ConsentTextEntry[] {
  return [...entries].sort((a, b) =>
    rank(PURPOSE_ORDER, a.purpose_id) - rank(PURPOSE_ORDER, b.purpose_id) || a.purpose_id.localeCompare(b.purpose_id) ||
    rank(LOCALE_ORDER, a.locale) - rank(LOCALE_ORDER, b.locale) || a.locale.localeCompare(b.locale) ||
    a.text_version.localeCompare(b.text_version));
}

export const entryId = (e: { purpose_id: string; locale: string; text_version: string }) => `${e.purpose_id}|${e.locale}|${e.text_version}`;

/** Đọc sổ đã ghi; [] khi chưa có tệp. */
export function readRegistry(): ConsentTextEntry[] {
  if (!existsSync(REGISTRY_URL)) return [];
  const data = parseStrictJson(readFileSync(REGISTRY_URL, "utf8"), 4);
  if (!Array.isArray(data)) throw new Error("contracts/consent-texts.json phải là một mảng");
  return data as ConsentTextEntry[];
}

/**
 * Ghép sổ đã ghi với văn bản hiện có: dòng cũ được giữ, dòng mới được thêm. `changed` là các dòng mà văn bản đã đổi trong
 * khi (purpose_id, locale, text_version) vẫn như cũ: cần đổi phiên bản trước khi ghi.
 */
export function mergeRegistry(recorded: ConsentTextEntry[], current: ConsentTextEntry[]) {
  const byId = new Map(recorded.map((e) => [entryId(e), e]));
  const changed: ConsentTextEntry[] = [];
  const added: ConsentTextEntry[] = [];
  for (const e of current) {
    const had = byId.get(entryId(e));
    if (!had) added.push(e);
    else if (had.sha256 !== e.sha256) changed.push(e);
  }
  return { entries: sortEntries([...recorded, ...added]), added, changed };
}

export const formatRegistry = (entries: ConsentTextEntry[]) => "[\n" + entries.map((e) => "  " + JSON.stringify({ purpose_id: e.purpose_id, locale: e.locale, text_version: e.text_version, sha256: e.sha256 })).join(",\n") + "\n]\n";

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  const recorded = readRegistry();
  const { entries, added, changed } = mergeRegistry(recorded, await currentConsentTexts());
  if (changed.length) {
    for (const e of changed) console.error(`✗ văn bản đồng ý ${e.purpose_id} (${e.locale}) đã đổi nhưng vẫn mang phiên bản ${e.text_version}`);
    console.error("Đổi phiên bản của mục đích đó trong CONSENT_TEXT_VERSIONS (web/shared/consent-text.js) rồi chạy lại.");
    process.exit(1);
  }
  const text = formatRegistry(entries);
  if (check) {
    if (!existsSync(REGISTRY_URL) || readFileSync(REGISTRY_URL, "utf8") !== text) {
      console.error(`✗ contracts/consent-texts.json chưa khớp catalog (${added.length} dòng mới): chạy node scripts/make-consent-texts.ts`);
      process.exit(1);
    }
    console.log(`sổ văn bản đồng ý khớp catalog: ${entries.length} dòng`);
  } else {
    writeFileSync(REGISTRY_URL, text);
    console.log(`đã ghi contracts/consent-texts.json: ${entries.length} dòng (${added.length} dòng mới)`);
  }
}
