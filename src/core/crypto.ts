// Băm, mã hóa base64url và ký ES256 (JOSE: r||s 64 byte). Khóa riêng của issuer chỉ nằm trong KMS ở môi trường thật; bản
// tham chiếu giữ nó trong bộ nhớ tiến trình hoặc tệp có quyền 0600, không ghi log, không vào fixture.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { canonicalize } from "../../web/shared/jcs.js";

export const b64url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");

/** Giải base64url chặt: đúng bảng chữ, không padding, mã hóa lại phải ra đúng chuỗi (chặn bit thừa). */
export function fromB64urlStrict(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest();
export const sha256b64 = (data: string | Uint8Array) => b64url(sha256(data));

/** SHA-256 trên UTF-8 của JCS, base64url không padding. */
export const digestJcs = (value: unknown) => sha256b64(Buffer.from(canonicalize(value), "utf8"));

export const uuid = () => randomUUID();
export const randomKey = (bytes = 32) => b64url(randomBytes(bytes));

/** Mã hỗ trợ đọc được qua điện thoại, ngẫu nhiên, không suy ra được ID tác vụ. */
export function supportCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return `LNH-${s.slice(0, 4)}-${s.slice(4)}`;
}

export interface EcKeyPair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateEs256(kid: string): EcKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, privateKey, publicKey };
}

export const publicJwk = (k: KeyObject) => k.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
export const publicKeyFromJwk = (jwk: { kty: string; crv: string; x: string; y: string }) => {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error("chỉ nhận khóa EC P-256");
  return createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
};
export const privateKeyFromPem = (pem: string) => createPrivateKey(pem);

export const es256Sign = (data: string, key: KeyObject) => sign("sha256", Buffer.from(data, "ascii"), { key, dsaEncoding: "ieee-p1363" });
export const es256Verify = (data: string, sig: Uint8Array, key: KeyObject) => {
  if (sig.length !== 64) return false;
  try {
    return verify("sha256", Buffer.from(data, "ascii"), { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
};

/** JWS Compact với header bảo vệ cho trước (đã chuẩn hóa thứ tự trường khi tạo). */
export function jwsCompact(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject) {
  const h = b64url(JSON.stringify(header));
  const p = b64url(canonicalize(payload));
  const input = `${h}.${p}`;
  return `${input}.${b64url(es256Sign(input, key))}`;
}

/** cnf.x5t#S256: SHA-256 của chứng chỉ DER của mTLS client, base64url. */
export const certThumbprint = (der: Uint8Array) => sha256b64(der);
