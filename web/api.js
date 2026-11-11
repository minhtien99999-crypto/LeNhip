// @ts-check
// Client của API /v1 (SRS mục 15–16). Mỗi POST mang Idempotency-Key 32 byte ngẫu nhiên; mất mạng thì thử lại đúng một lần với
// cùng khóa (không tạo khóa mới để chữa timeout). Token chỉ giữ trong sessionStorage của phiên; app native dùng OIDC code + PKCE.

export class ApiError extends Error {
  /** @param {number} status @param {any} body */
  constructor(status, body) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.code ?? (status === 0 ? "OFFLINE" : "ERROR");
    this.body = body;
  }
}

export function newKey() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class Api {
  constructor() {
    /** @type {string | null} */
    this.token = null;
    this.ws = "ws_demo";
    this.dev = false;
    /** Độ lệch đồng hồ máy chủ − máy khách (mili giây), ước từ header Date. */
    this.offsetMs = 0;
    /** @type {{ sub: string, name: string }[]} */
    this.devUsers = [];
  }

  serverNow() {
    return Date.now() + this.offsetMs;
  }

  async init() {
    try {
      const r = await fetch("/dev/users", { headers: { Accept: "application/json" } });
      if (r.ok) {
        this.dev = true;
        this.devUsers = (await r.json()).users;
      }
    } catch {
      this.dev = false;
    }
    return this.dev;
  }

  /** Bản chạy thử: lấy token của tài khoản thử (máy chủ chỉ bật khi LENHIP_DEV=1 trên localhost). @param {string} sub */
  async login(sub) {
    const r = await fetch("/dev/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sub }) });
    if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => null));
    this.token = (await r.json()).token;
    try {
      sessionStorage.setItem("lenhip.session", JSON.stringify({ sub, token: this.token }));
    } catch {
      /* phiên không lưu được thì chỉ giữ trong bộ nhớ */
    }
    return this.token;
  }

  restoreSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem("lenhip.session") ?? "null");
      if (s && typeof s.token === "string") {
        this.token = s.token;
        return /** @type {string} */ (s.sub);
      }
    } catch {
      /* không có phiên */
    }
    return null;
  }

  /**
   * @param {"GET" | "POST"} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ key?: string }} [o]
   */
  async req(method, path, body, o = {}) {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json", "X-LeNhip-Workspace": this.ws };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const key = method === "POST" ? o.key ?? newKey() : null;
    if (key) headers["Idempotency-Key"] = key;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const once = async () => {
      const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const date = Date.parse(r.headers.get("Date") ?? "");
      if (!Number.isNaN(date)) this.offsetMs = date - Date.now();
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new ApiError(r.status, data);
      return data;
    };
    try {
      return await once();
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (method !== "POST") throw new ApiError(0, { code: "OFFLINE", message: "Không kết nối được máy chủ LeNhip." });
      try {
        return await once();
      } catch (e2) {
        if (e2 instanceof ApiError) throw e2;
        throw new ApiError(0, { code: "OFFLINE", message: "Không kết nối được máy chủ LeNhip." });
      }
    }
  }

  /** @param {string} path */
  get(path) {
    return this.req("GET", path);
  }
  /** @param {string} path @param {unknown} [body] @param {{ key?: string }} [o] */
  post(path, body, o) {
    return this.req("POST", path, body ?? {}, o);
  }
}
