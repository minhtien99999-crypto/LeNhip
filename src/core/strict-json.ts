// Bộ phân tích JSON chặt (RFC 8259): từ chối khóa trùng ở mọi tầng, surrogate lẻ, lồng quá sâu. Dùng cho thân yêu cầu API,
// header và payload của permit (SRS mục 15, 17: "Chặn ... duplicate key").

export class JsonError extends Error {
  readonly code: "DUPLICATE_KEY" | "SCHEMA_INVALID";
  constructor(code: "DUPLICATE_KEY" | "SCHEMA_INVALID", message: string) {
    super(message);
    this.code = code;
  }
}

const WS = new Set([0x20, 0x09, 0x0a, 0x0d]);

export function parseStrictJson(text: string, maxDepth = 32): unknown {
  let i = 0;
  const fail = (msg: string): never => {
    throw new JsonError("SCHEMA_INVALID", `JSON không hợp lệ tại ${i}: ${msg}`);
  };
  const skip = () => {
    while (i < text.length && WS.has(text.charCodeAt(i))) i++;
  };
  const value = (depth: number): unknown => {
    if (depth > maxDepth) fail("lồng quá sâu");
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      const out: Record<string, unknown> = Object.create(null);
      const seen = new Set<string>();
      skip();
      if (text[i] === "}") {
        i++;
        return Object.assign({}, out);
      }
      for (;;) {
        skip();
        if (text[i] !== '"') fail("cần khóa chuỗi");
        const key = str();
        if (seen.has(key)) throw new JsonError("DUPLICATE_KEY", `khóa trùng: ${key.slice(0, 40)}`);
        seen.add(key);
        skip();
        if (text[i] !== ":") fail("cần ':'");
        i++;
        out[key] = value(depth + 1);
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          break;
        }
        fail("cần ',' hoặc '}'");
      }
      return Object.assign({}, out);
    }
    if (c === "[") {
      i++;
      const out: unknown[] = [];
      skip();
      if (text[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value(depth + 1));
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          break;
        }
        fail("cần ',' hoặc ']'");
      }
      return out;
    }
    if (c === '"') return str();
    if (c === "t" && text.startsWith("true", i)) return (i += 4), true;
    if (c === "f" && text.startsWith("false", i)) return (i += 5), false;
    if (c === "n" && text.startsWith("null", i)) return (i += 4), null;
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) return fail("giá trị không hợp lệ");
    i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) fail("số vượt phạm vi");
    return n;
  };
  const str = (): string => {
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("chuỗi chưa đóng");
      const ch = text.charCodeAt(i);
      if (ch === 0x22) {
        i++;
        break;
      }
      if (ch < 0x20) fail("ký tự điều khiển trong chuỗi");
      if (ch === 0x5c) {
        const e = text[i + 1];
        i += 2;
        if (e === "u") {
          const hex = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("\\u không hợp lệ");
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          const map: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (!(e in map)) fail("escape không hợp lệ");
          out += map[e];
        }
        continue;
      }
      out += text[i];
      i++;
    }
    const wf = (out as unknown as { isWellFormed?: () => boolean }).isWellFormed;
    if (wf && !wf.call(out)) fail("chuỗi có surrogate lẻ");
    return out;
  };
  const result = value(0);
  skip();
  if (i !== text.length) fail("dư ký tự sau giá trị");
  return result;
}
