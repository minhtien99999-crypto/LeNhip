// Hợp đồng API đã ghép: contracts/openapi.json (lõi) cộng các mảnh contracts/openapi/<mô-đun>.json. Mỗi mô-đun thêm thao tác và
// schema của mình bằng một tệp mảnh riêng, không sửa tệp lõi; máy chủ kiểm thân yêu cầu và scripts/check-contracts.ts đối chiếu
// route trên bản đã ghép. Một mảnh chỉ được THÊM: trùng đường dẫn, schema, tham số hay response đã có là lỗi, máy chủ không chạy.
// Sửa thứ đã có (thêm giá trị vào một enum của lõi, thêm ánh xạ vào PlanInput…) vẫn làm trong contracts/openapi.json.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Schema } from "../core/schema.ts";
import { parseStrictJson } from "../core/strict-json.ts";

export interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema>; parameters?: Record<string, unknown>; responses?: Record<string, unknown> } & Record<string, unknown>;
  [k: string]: unknown;
}

const SECTIONS = ["schemas", "parameters", "responses"] as const;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Ghép các mảnh vào bản lõi (không sửa đối số). `name` chỉ dùng để báo lỗi. */
export function mergeOpenApi(core: OpenApiDoc, fragments: { name: string; doc: unknown }[]): OpenApiDoc {
  const out: OpenApiDoc = { ...core, paths: { ...core.paths }, components: { ...core.components } };
  for (const s of SECTIONS) if (core.components[s]) out.components[s] = { ...core.components[s] } as never;
  for (const { name, doc } of fragments) {
    const bad = (why: string) => new Error(`mảnh OpenAPI ${name}: ${why}`);
    if (!isObject(doc)) throw bad("phải là một đối tượng JSON");
    for (const k of Object.keys(doc)) if (k !== "paths" && k !== "components") throw bad(`chỉ được có paths và components, không có ${k}`);
    const paths = doc.paths ?? {};
    const components = doc.components ?? {};
    if (!isObject(paths) || !isObject(components)) throw bad("paths và components phải là đối tượng");
    for (const [path, item] of Object.entries(paths)) {
      if (!/^\/v[12]\//.test(path)) throw bad(`đường dẫn ${path} phải nằm dưới /v1/ hoặc /v2/`);
      if (Object.hasOwn(out.paths, path)) throw bad(`đường dẫn ${path} đã có`);
      if (!isObject(item)) throw bad(`đường dẫn ${path} phải là đối tượng`);
      out.paths[path] = item;
    }
    for (const [section, entries] of Object.entries(components)) {
      if (!(SECTIONS as readonly string[]).includes(section)) throw bad(`components chỉ được có ${SECTIONS.join(", ")}, không có ${section}`);
      if (!isObject(entries)) throw bad(`components.${section} phải là đối tượng`);
      const target = (out.components[section] ??= {}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(entries)) {
        if (Object.hasOwn(target, key)) throw bad(`components.${section}.${key} đã có`);
        target[key] = value;
      }
    }
  }
  return out;
}

const CORE = new URL("../../contracts/openapi.json", import.meta.url);
const FRAGMENTS = new URL("../../contracts/openapi/", import.meta.url);

/** Tên các tệp mảnh hiện có, theo thứ tự ghép (bảng chữ cái). */
export function fragmentFiles(): string[] {
  if (!existsSync(FRAGMENTS)) return [];
  const files = readdirSync(FRAGMENTS).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) if (!/^[a-z][a-z0-9-]{1,31}\.json$/.test(f)) throw new Error(`mảnh OpenAPI ${f}: tên tệp phải là <mô-đun>.json, chữ thường`);
  return files;
}

/** Đọc bằng bộ phân tích chặt: một khóa trùng (ví dụ sau khi gộp hai nhánh cùng thêm một schema) là lỗi, không âm thầm lấy bản sau. */
const readJson = (url: URL) => parseStrictJson(readFileSync(url, "utf8"), 64);

export function loadOpenApi(): OpenApiDoc {
  return mergeOpenApi(readJson(CORE) as OpenApiDoc, fragmentFiles().map((f) => ({ name: f, doc: readJson(new URL(f, FRAGMENTS)) })));
}
