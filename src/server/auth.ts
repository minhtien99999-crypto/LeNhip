// Xác thực OIDC bearer có audience của miền (SRS mục 12, 15). Token JWT ES256 của IAM (LeASO) được kiểm iss, aud, exp, nbf và chữ
// ký với bộ khóa được cấu hình; không tải khóa theo URL nằm trong token. Bản tham chiếu có issuer phát triển (LENHIP_DEV=1) để
// chạy thử không cần IAM thật; issuer này không bao giờ bật ở môi trường thật (main.ts từ chối nếu không chạy localhost).
import type { KeyObject } from "node:crypto";
import { b64url, es256Sign, es256Verify, fromB64urlStrict, generateEs256, publicJwk, type EcKeyPair } from "../core/crypto.ts";
import { ApiError } from "../core/errors.ts";
import { parseStrictJson } from "../core/strict-json.ts";

export interface Principal {
  sub: string;
  name: string;
  auth_time: number | null;
}

export class OidcVerifier {
  readonly issuer: string;
  readonly audience: string;
  private readonly keys: Map<string, KeyObject>;
  private readonly skewS: number;
  constructor(o: { issuer: string; audience: string; keys: Map<string, KeyObject>; skewS?: number }) {
    this.issuer = o.issuer;
    this.audience = o.audience;
    this.keys = o.keys;
    this.skewS = o.skewS ?? 30;
  }

  verify(authorization: string | undefined, nowMs: number): Principal {
    const fail = () => new ApiError(401, "UNAUTHENTICATED", { headers: { "WWW-Authenticate": 'Bearer realm="lenhip"' } });
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
    if (!m) throw fail();
    const [h, p, s] = m[1].split(".");
    try {
      const hb = fromB64urlStrict(h);
      const pb = fromB64urlStrict(p);
      const sig = fromB64urlStrict(s);
      if (!hb || !pb || !sig) throw fail();
      const header = parseStrictJson(hb.toString("utf8"), 4) as Record<string, unknown>;
      if (header.alg !== "ES256" || typeof header.kid !== "string" || Object.keys(header).some((k) => !["alg", "kid", "typ"].includes(k))) throw fail();
      const key = this.keys.get(header.kid);
      if (!key || !es256Verify(`${h}.${p}`, sig, key)) throw fail();
      const c = parseStrictJson(pb.toString("utf8"), 6) as Record<string, unknown>;
      const now = Math.floor(nowMs / 1000);
      const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
      if (c.iss !== this.issuer || !aud.includes(this.audience)) throw fail();
      if (typeof c.exp !== "number" || now > c.exp + this.skewS) throw fail();
      if (typeof c.nbf === "number" && now < c.nbf - this.skewS) throw fail();
      if (typeof c.sub !== "string" || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(c.sub)) throw fail();
      return { sub: c.sub, name: typeof c.name === "string" ? c.name.slice(0, 80) : c.sub, auth_time: typeof c.auth_time === "number" ? c.auth_time : null };
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw fail();
    }
  }
}

/** Issuer phát triển: chỉ để chạy thử cục bộ và kiểm thử. */
export class DevIssuer {
  readonly issuer: string;
  readonly audience: string;
  private readonly key: EcKeyPair;
  constructor(issuer: string, audience: string) {
    this.issuer = issuer;
    this.audience = audience;
    this.key = generateEs256(`dev-${Date.now().toString(36)}`);
  }
  keys() {
    return new Map([[this.key.kid, this.key.publicKey]]);
  }
  jwks() {
    return { keys: [{ ...publicJwk(this.key.publicKey), kid: this.key.kid, alg: "ES256", use: "sig" }] };
  }
  mint(sub: string, name: string, nowMs: number, opts: { ttlS?: number; authTime?: number; audience?: string } = {}) {
    const iat = Math.floor(nowMs / 1000);
    const h = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: this.key.kid }));
    const p = b64url(JSON.stringify({ iss: this.issuer, aud: opts.audience ?? this.audience, sub, name, iat, nbf: iat, exp: iat + (opts.ttlS ?? 900), auth_time: opts.authTime ?? iat }));
    return `${h}.${p}.${b64url(es256Sign(`${h}.${p}`, this.key.privateKey))}`;
  }
}
