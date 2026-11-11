// Bộ kiểm JSON Schema (phần con của 2020-12 mà contracts/openapi.json dùng): $ref nội bộ, type, enum, const, properties,
// required, additionalProperties, items, minItems/maxItems, minLength/maxLength, pattern, minimum/maximum, oneOf có
// discriminator, format date-time và iana-zone. Máy chủ kiểm thân yêu cầu bằng chính tài liệu OpenAPI, để hợp đồng và
// mã không lệch nhau (SRS mục 15: "OpenAPI 3.1 ... là hợp đồng để sinh client/validator").
import { isValidZone, parseInstant } from "../../web/shared/zone.js";

export type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  format?: string;
  oneOf?: Schema[];
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  description?: string;
  examples?: unknown[];
};

export interface SchemaIssue {
  path: string;
  rule: string;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

export class SchemaSet {
  private readonly schemas: Record<string, Schema>;
  private readonly patterns = new Map<string, RegExp>();
  constructor(schemas: Record<string, Schema>) {
    this.schemas = schemas;
  }

  has(name: string) {
    return name in this.schemas;
  }

  validate(name: string, value: unknown): SchemaIssue[] {
    const issues: SchemaIssue[] = [];
    this.check({ $ref: `#/components/schemas/${name}` }, value, "", issues, 0);
    return issues;
  }

  private resolve(ref: string): Schema {
    const m = /^#\/components\/schemas\/([A-Za-z0-9_]+)$/.exec(ref);
    const s = m && this.schemas[m[1]];
    if (!s) throw new Error(`schema không tồn tại: ${ref}`);
    return s;
  }

  private re(p: string) {
    let r = this.patterns.get(p);
    if (!r) this.patterns.set(p, (r = new RegExp(p, "u")));
    return r;
  }

  private check(s: Schema, v: unknown, path: string, out: SchemaIssue[], depth: number): void {
    if (depth > 40) {
      out.push({ path, rule: "depth" });
      return;
    }
    if (s.$ref) return this.check(this.resolve(s.$ref), v, path, out, depth + 1);
    if (s.oneOf) return this.oneOf(s, v, path, out, depth);
    if (s.type) {
      const t = typeOf(v);
      const allowed = Array.isArray(s.type) ? s.type : [s.type];
      const ok = allowed.some((a) => a === t || (a === "number" && t === "integer"));
      if (!ok) {
        out.push({ path, rule: `type:${allowed.join("|")}` });
        return;
      }
    }
    if (s.const !== undefined && v !== s.const) out.push({ path, rule: "const" });
    if (s.enum && !s.enum.includes(v as never)) out.push({ path, rule: "enum" });
    if (typeof v === "string") {
      const len = [...v].length;
      if (s.minLength !== undefined && len < s.minLength) out.push({ path, rule: "minLength" });
      if (s.maxLength !== undefined && len > s.maxLength) out.push({ path, rule: "maxLength" });
      if (s.pattern && !this.re(s.pattern).test(v)) out.push({ path, rule: "pattern" });
      if (s.format === "date-time" && Number.isNaN(parseInstant(v))) out.push({ path, rule: "format:date-time" });
      if (s.format === "date-time-utc" && (!v.endsWith("Z") || Number.isNaN(parseInstant(v)))) out.push({ path, rule: "format:date-time-utc" });
      if (s.format === "iana-zone" && !isValidZone(v)) out.push({ path, rule: "format:iana-zone" });
    }
    if (typeof v === "number") {
      if (s.minimum !== undefined && v < s.minimum) out.push({ path, rule: "minimum" });
      if (s.maximum !== undefined && v > s.maximum) out.push({ path, rule: "maximum" });
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) out.push({ path, rule: "minItems" });
      if (s.maxItems !== undefined && v.length > s.maxItems) out.push({ path, rule: "maxItems" });
      if (s.items) v.forEach((x, i) => this.check(s.items as Schema, x, `${path}/${i}`, out, depth + 1));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      for (const r of s.required ?? []) if (!(r in o)) out.push({ path: `${path}/${r}`, rule: "required" });
      for (const [k, x] of Object.entries(o)) {
        const p = s.properties?.[k];
        if (p) this.check(p, x, `${path}/${k}`, out, depth + 1);
        else if (s.additionalProperties === false) out.push({ path: `${path}/${k}`, rule: "additionalProperties" });
        else if (s.additionalProperties && typeof s.additionalProperties === "object") this.check(s.additionalProperties, x, `${path}/${k}`, out, depth + 1);
      }
    }
  }

  private oneOf(s: Schema, v: unknown, path: string, out: SchemaIssue[], depth: number) {
    const d = s.discriminator;
    if (d && v && typeof v === "object" && !Array.isArray(v)) {
      const tag = (v as Record<string, unknown>)[d.propertyName];
      const ref = typeof tag === "string" ? d.mapping?.[tag] : undefined;
      if (!ref) {
        out.push({ path: `${path}/${d.propertyName}`, rule: "discriminator" });
        return;
      }
      this.check({ $ref: ref }, v, path, out, depth + 1);
      return;
    }
    const matches = (s.oneOf ?? []).filter((x) => {
      const tmp: SchemaIssue[] = [];
      this.check(x, v, path, tmp, depth + 1);
      return tmp.length === 0;
    });
    if (matches.length !== 1) out.push({ path, rule: "oneOf" });
  }
}
