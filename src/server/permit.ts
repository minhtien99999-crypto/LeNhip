// LNH-PERMIT-1 (SRS mục 17): JWS Compact, ba phần base64url không padding, header bảo vệ duy nhất {alg: ES256, typ:
// lnh-permit+jwt, kid}. Chặn alg khác, header thừa (crit, jku, x5u, b64...), khóa JSON trùng. Payload là JCS. Thứ tự kiểm:
// cú pháp → trust và chữ ký → thời gian → audience/issuer/danh tính mTLS; digest, target, phiên bản và epoch do receiver kiểm
// tiếp với sổ và Authority.
import type { KeyObject } from "node:crypto";
import { canonicalize } from "../../web/shared/jcs.js";
import { b64url, certThumbprint, es256Sign, es256Verify, fromB64urlStrict, uuid, type EcKeyPair } from "../core/crypto.ts";
import { JsonError, parseStrictJson } from "../core/strict-json.ts";

export const PERMIT_TYP = "lnh-permit+jwt";

export interface PermitClaims {
  iss: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  action_id: string;
  action_revision: number;
  workspace_id: string;
  site: string | null;
  target: string;
  target_binding_version: number;
  payload_digest: string;
  authz_version: number;
  export_policy_digest: string;
  recovery_epoch: number;
  cnf: { "x5t#S256": string };
}

const CLAIM_TYPES: Record<keyof PermitClaims, string> = {
  iss: "string", aud: "string", iat: "int", nbf: "int", exp: "int", jti: "uuid", action_id: "uuid", action_revision: "int",
  workspace_id: "string", site: "string|null", target: "string", target_binding_version: "int", payload_digest: "digest",
  authz_version: "int", export_policy_digest: "digest", recovery_epoch: "int", cnf: "cnf",
};

export type PermitCode =
  | "PERMIT_SYNTAX" | "PERMIT_HEADER" | "PERMIT_UNTRUSTED_KEY" | "PERMIT_SIGNATURE" | "PERMIT_LIFETIME" | "PERMIT_NOT_YET_VALID"
  | "PERMIT_EXPIRED" | "PERMIT_ISSUER" | "PERMIT_AUDIENCE" | "PERMIT_IDENTITY" | "PERMIT_DIGEST" | "PERMIT_TARGET"
  | "PERMIT_STALE" | "PERMIT_EPOCH" | "PERMIT_REPLAY" | "PERMIT_REVISION" | "CLOCK_SKEW" | "DISPATCH_CLOSED";

export class PermitError extends Error {
  readonly code: PermitCode;
  constructor(code: PermitCode, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

type KeyState = { key: KeyObject; status: "ACTIVE" | "RETIRED" | "REVOKED"; notAfterMs: number | null };

/** Bộ khóa công khai được quản lý của receiver: kid chỉ chọn khóa P-256 có sẵn, không tải URL trong token. */
export class TrustStore {
  private readonly keys = new Map<string, KeyState>();
  add(kid: string, key: KeyObject) {
    this.keys.set(kid, { key, status: "ACTIVE", notAfterMs: null });
  }
  /** Rotation: giữ khóa cũ tới khi permit cuối cùng hết hiệu lực (exp + skew). */
  retire(kid: string, notAfterMs: number) {
    const k = this.keys.get(kid);
    if (k) Object.assign(k, { status: "RETIRED", notAfterMs });
  }
  revoke(kid: string) {
    const k = this.keys.get(kid);
    if (k) k.status = "REVOKED";
  }
  get(kid: string, nowMs: number): KeyObject | null {
    const k = this.keys.get(kid);
    if (!k || k.status === "REVOKED") return null;
    if (k.status === "RETIRED" && k.notAfterMs !== null && nowMs > k.notAfterMs) return null;
    return k.key;
  }
}

export class PermitIssuer {
  readonly iss: string;
  private key: EcKeyPair;
  constructor(iss: string, key: EcKeyPair) {
    this.iss = iss;
    this.key = key;
  }
  get kid() {
    return this.key.kid;
  }
  get publicKey() {
    return this.key.publicKey;
  }
  rotate(next: EcKeyPair) {
    const old = this.key;
    this.key = next;
    return old;
  }
  issue(c: Omit<PermitClaims, "iss" | "iat" | "nbf" | "exp" | "jti">, nowMs: number, lifetimeS: number): { token: string; claims: PermitClaims } {
    const iat = Math.floor(nowMs / 1000);
    const claims: PermitClaims = { ...c, iss: this.iss, iat, nbf: iat, exp: iat + lifetimeS, jti: uuid() };
    const header = b64url(JSON.stringify({ alg: "ES256", typ: PERMIT_TYP, kid: this.key.kid }));
    const payload = b64url(canonicalize(claims));
    const input = `${header}.${payload}`;
    return { token: `${input}.${b64url(es256Sign(input, this.key.privateKey))}`, claims };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

function parsePart(part: string, code: PermitCode): Record<string, unknown> {
  const buf = fromB64urlStrict(part);
  if (!buf || !buf.length) throw new PermitError(code, "base64url");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new PermitError(code, "utf-8");
  }
  let v: unknown;
  try {
    v = parseStrictJson(text, 8);
  } catch (e) {
    throw new PermitError(code, e instanceof JsonError ? e.code : "json");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PermitError(code, "không phải đối tượng");
  return v as Record<string, unknown>;
}

function checkClaims(p: Record<string, unknown>): PermitClaims {
  const keys = Object.keys(p).sort();
  const want = Object.keys(CLAIM_TYPES).sort();
  if (keys.join(",") !== want.join(",")) throw new PermitError("PERMIT_SYNTAX", "tập trường payload");
  for (const [k, t] of Object.entries(CLAIM_TYPES)) {
    const v = p[k];
    const ok =
      t === "string" ? typeof v === "string" && v.length > 0 && v.length <= 200
      : t === "int" ? Number.isSafeInteger(v) && (v as number) >= 0
      : t === "uuid" ? typeof v === "string" && UUID.test(v)
      : t === "digest" ? typeof v === "string" && DIGEST.test(v)
      : t === "string|null" ? v === null || (typeof v === "string" && v.length > 0 && v.length <= 200)
      : t === "cnf" ? !!v && typeof v === "object" && Object.keys(v as object).join() === "x5t#S256" && typeof (v as Record<string, unknown>)["x5t#S256"] === "string" && DIGEST.test((v as Record<string, string>)["x5t#S256"])
      : false;
    if (!ok) throw new PermitError("PERMIT_SYNTAX", k);
  }
  return p as unknown as PermitClaims;
}

export interface VerifyOptions {
  trust: TrustStore;
  issuer: string;
  /** Audience của receiver này: một chuỗi, hoặc phép kiểm khi receiver phục vụ một họ audience (mỗi site một audience). */
  audience: string | ((aud: string) => boolean);
  nowMs: number;
  skewMs: number;
  maxLifetimeS: number;
  peerCertDer: Uint8Array;
}

export function verifyPermit(token: string, o: VerifyOptions): PermitClaims {
  // 1. Cú pháp: đúng ba phần compact; header chỉ có alg, typ, kid; payload là JCS.
  if (typeof token !== "string" || token.length > 4096) throw new PermitError("PERMIT_SYNTAX", "độ dài");
  const parts = token.split(".");
  if (parts.length !== 3) throw new PermitError("PERMIT_SYNTAX", "không phải JWS compact");
  const header = parsePart(parts[0], "PERMIT_HEADER");
  if (Object.keys(header).sort().join(",") !== "alg,kid,typ") throw new PermitError("PERMIT_HEADER", "trường header");
  if (header.alg !== "ES256") throw new PermitError("PERMIT_HEADER", "alg");
  if (header.typ !== PERMIT_TYP) throw new PermitError("PERMIT_HEADER", "typ");
  if (typeof header.kid !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(header.kid)) throw new PermitError("PERMIT_HEADER", "kid");
  const payload = parsePart(parts[1], "PERMIT_SYNTAX");
  const payloadText = Buffer.from(parts[1], "base64url").toString("utf8");
  if (canonicalize(payload) !== payloadText) throw new PermitError("PERMIT_SYNTAX", "payload không ở dạng JCS");
  const claims = checkClaims(payload);
  const sig = fromB64urlStrict(parts[2]);
  if (!sig || sig.length !== 64) throw new PermitError("PERMIT_SYNTAX", "chữ ký");
  // 2. Trust và chữ ký.
  const key = o.trust.get(header.kid, o.nowMs);
  if (!key) throw new PermitError("PERMIT_UNTRUSTED_KEY");
  if (!es256Verify(`${parts[0]}.${parts[1]}`, sig, key)) throw new PermitError("PERMIT_SIGNATURE");
  // 3. Thời gian: 0 < exp − iat ≤ 30, nbf = iat, lệch tối đa skew.
  const life = claims.exp - claims.iat;
  if (!(life > 0 && life <= o.maxLifetimeS) || claims.nbf !== claims.iat) throw new PermitError("PERMIT_LIFETIME");
  if (o.nowMs < claims.iat * 1000 - o.skewMs) throw new PermitError("PERMIT_NOT_YET_VALID");
  if (o.nowMs > claims.exp * 1000 + o.skewMs) throw new PermitError("PERMIT_EXPIRED");
  // 4. Issuer, audience và danh tính mTLS (cnf.x5t#S256 của chứng chỉ client đã trình).
  if (claims.iss !== o.issuer) throw new PermitError("PERMIT_ISSUER");
  if (typeof o.audience === "string" ? claims.aud !== o.audience : !o.audience(claims.aud)) throw new PermitError("PERMIT_AUDIENCE");
  if (claims.cnf["x5t#S256"] !== certThumbprint(o.peerCertDer)) throw new PermitError("PERMIT_IDENTITY");
  return claims;
}
