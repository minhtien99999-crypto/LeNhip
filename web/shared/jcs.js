// @ts-check
// RFC 8785 JSON Canonicalization Scheme (JCS), dùng chung cho máy chủ và web. App iOS/Android chạy cùng bộ vector
// trong contracts/fixtures/jcs-vectors.json (SRS mục 16, 17; T14).
//
// Quy tắc: khóa đối tượng xếp theo đơn vị mã UTF-16, số theo cách in của ECMAScript (JSON.stringify), chuỗi theo
// JSON.stringify của ECMAScript. Từ chối số không hữu hạn, chuỗi có surrogate lẻ, undefined, hàm, BigInt và đối tượng
// không phải đối tượng thuần: một giá trị không phải dữ liệu JSON không có dạng chuẩn để băm.

const MAX_DEPTH = 64;

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  return write(value, 0);
}

/**
 * @param {string} s
 * @returns {boolean}
 */
export function isWellFormed(s) {
  const f = /** @type {any} */ (String.prototype).isWellFormed;
  if (typeof f === "function") return f.call(s);
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/**
 * @param {unknown} v
 * @param {number} depth
 * @returns {string}
 */
function write(v, depth) {
  if (depth > MAX_DEPTH) throw new TypeError("JCS: lồng quá sâu");
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("JCS: số phải hữu hạn");
      return JSON.stringify(v);
    case "string":
      if (!isWellFormed(v)) throw new TypeError("JCS: chuỗi có surrogate lẻ");
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return "[" + v.map((x) => write(x, depth + 1)).join(",") + "]";
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("JCS: chỉ nhận đối tượng thuần");
      const o = /** @type {Record<string, unknown>} */ (v);
      const keys = Object.keys(o).sort();
      let out = "{";
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!isWellFormed(k)) throw new TypeError("JCS: khóa có surrogate lẻ");
        if (o[k] === undefined) throw new TypeError("JCS: giá trị undefined ở khóa " + k);
        out += (i ? "," : "") + JSON.stringify(k) + ":" + write(o[k], depth + 1);
      }
      return out + "}";
    }
    default:
      throw new TypeError("JCS: kiểu không phải JSON: " + typeof v);
  }
}

/**
 * base64url không padding.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * SHA-256 trên byte UTF-8 của dạng JCS, base64url không padding (payload_digest, request digest).
 * Dùng WebCrypto, chạy được trong trình duyệt và Node.
 * @param {unknown} value
 * @returns {Promise<string>}
 */
export async function digestJcs(value) {
  const data = new TextEncoder().encode(canonicalize(value));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(hash));
}
