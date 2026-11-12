// @ts-check
// Máy khách đồng bộ bản nháp và phiên thiết bị (SRS V2.0 mục 03; N20‑SYNC; LNH-T63, LNH-T64; ca X01, X02).
//
// Giữ trên thiết bị (nói rõ ở giao diện, khóa catalog brief.sync.local):
//   - localStorage `lenhip.sync.v1.<workspace>.<người dùng>`: phiên của thiết bị này (mã phiên và bí mật 32 byte), bản nháp giữ khung
//     giờ (mã tiêu đề, giờ bắt đầu, giờ kết thúc, múi giờ) và việc cá nhân (dòng chữ người dùng gõ, đã xong, ngày hạn), cùng hàng đợi
//     sửa nháp của chúng. Không có số liệu sức khỏe.
//   - Chỉ trong bộ nhớ của trang: nháp phản hồi Hộp tổng hợp và việc cá nhân tạo từ một mục của Hộp tổng hợp (tiêu đề email, nội
//     dung chia sẻ là dữ liệu của người khác, không phải chữ người dùng gõ).
// Hàng đợi chỉ chứa thao tác sửa nháp; xác nhận một tác vụ thật vẫn đi ctx.propose (plan → xem lại → 120 giây) và cần mạng.
// Gửi lại sau mất mạng dùng lại đúng Idempotency-Key của thao tác; máy khách không bao giờ tự sửa base_revision để «thắng» xung đột:
// 409 REVISION_CONFLICT giữ cả hai bản cho người dùng chọn.
//
// Phần thuần (reduce*, mergeServer, filterStored) không chạm DOM hay mạng: tests/sync.test.ts kiểm trên Node.

export const SYNC_POLL_MS = 15000;
export const SYNC_PURPOSES = Object.freeze(["calendar_block", "inbox_reply", "personal_task"]);
/** Loại máy người dùng chọn được trên web. WATCH có trong hợp đồng nhưng không đăng ký từ trình duyệt: chưa có ứng dụng đồng hồ. */
export const SYNC_KINDS = Object.freeze(["PHONE", "TABLET", "LAPTOP", "DESKTOP", "OTHER"]);
/** Mục đích có snapshot được lưu xuống localStorage (không nhạy cảm). */
export const STORED_PURPOSES = Object.freeze(["calendar_block", "personal_task"]);

const b64url = (/** @type {Uint8Array} */ b) => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const random = (/** @type {number} */ n) => {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
};
export const newKey = () => b64url(random(32));
export const newDraftId = () => "drf_" + b64url(random(16));

// ── Trạng thái thuần ──────────────────────────────────────────────────────────────────────────────────────────────────────────
//
// state = { drafts: { [id]: Entry }, queue: Op[] }
//   Entry = { draft_id, purpose, revision (revision máy chủ đã biết; 0 = chưa lên máy chủ), snapshot (bản trên máy này),
//             updated_at, conflict: null | { theirs: SyncDraft } }
//   Op    = { op: "create" | "revise" | "discard", draft_id, purpose, snapshot, key, sending }
// Mỗi bản nháp có tối đa một thao tác chưa gửi (gộp lại), cộng một thao tác đang gửi. base_revision lấy lúc gửi từ entry.revision,
// và entry.revision chỉ đổi theo phản hồi của chính thao tác đó: bản mới hơn từ máy khác không bao giờ được nhận thầm khi máy này
// còn sửa đổi chưa gửi.

/** @typedef {{ drafts: Record<string, any>, queue: any[] }} SyncState */

/** @returns {SyncState} */
export const emptyState = () => ({ drafts: {}, queue: [] });

const clone = (/** @type {SyncState} */ s) => ({ drafts: { ...s.drafts }, queue: s.queue.slice() });
const pendingOf = (/** @type {SyncState} */ s, /** @type {string} */ id) => s.queue.findIndex((o) => o.draft_id === id && !o.sending);

/** Sửa (hoặc tạo) một bản nháp trên máy này. @param {SyncState} state @param {{ draft_id: string, purpose: string, snapshot: any, at?: string }} d @returns {SyncState} */
export function reduceEdit(state, d, key = newKey()) {
  const { draft_id, purpose, snapshot, at } = d;
  const s = clone(state);
  const cur = s.drafts[draft_id];
  if (cur && cur.purpose !== purpose) throw new Error("bản nháp đổi mục đích");
  s.drafts[draft_id] = { draft_id, purpose, revision: cur?.revision ?? 0, snapshot, updated_at: at ?? cur?.updated_at ?? null, conflict: cur?.conflict ?? null };
  const i = pendingOf(s, draft_id);
  if (i >= 0) {
    if (s.queue[i].op === "discard") return state; // đã bỏ trên máy này: không sửa tiếp
    s.queue[i] = { ...s.queue[i], snapshot, key };
  } else if (!cur?.conflict) {
    const inflight = s.queue.some((o) => o.draft_id === draft_id && o.sending);
    s.queue.push({ op: !cur || (cur.revision === 0 && !inflight) ? "create" : "revise", draft_id, purpose, snapshot, key, sending: false });
  }
  return s;
}

/** Bỏ một bản nháp. Bản chưa từng lên máy chủ thì chỉ cần quên nó. @param {SyncState} state @param {string} draft_id @returns {SyncState} */
export function reduceDiscard(state, draft_id, key = newKey()) {
  const s = clone(state);
  const cur = s.drafts[draft_id];
  if (!cur) return state;
  const i = pendingOf(s, draft_id);
  const inflight = s.queue.some((o) => o.draft_id === draft_id && o.sending);
  if (i >= 0 && s.queue[i].op === "create" && !inflight) {
    s.queue.splice(i, 1);
    delete s.drafts[draft_id];
    return s;
  }
  if (i >= 0) s.queue.splice(i, 1);
  s.queue.push({ op: "discard", draft_id, purpose: cur.purpose, snapshot: null, key, sending: false });
  s.drafts[draft_id] = { ...cur, conflict: null, discarding: true };
  return s;
}

/** Thao tác tiếp theo cần gửi (theo thứ tự hàng đợi, bỏ qua bản nháp đang có thao tác đang gửi). @param {SyncState} state @returns {any} */
export function nextOp(state) {
  const busy = new Set(state.queue.filter((o) => o.sending).map((o) => o.draft_id));
  return state.queue.find((o) => !o.sending && !busy.has(o.draft_id)) ?? null;
}

/** @param {SyncState} state @param {any} op @returns {SyncState} */
export function reduceSending(state, op) {
  const s = clone(state);
  s.queue = s.queue.map((o) => (o === op || (o.key === op.key && o.draft_id === op.draft_id) ? { ...o, sending: true } : o));
  return s;
}

/** Máy chủ đã nhận thao tác (phản hồi SyncDraftRef). @param {SyncState} state @param {any} op @param {any} ref @returns {SyncState} */
export function reduceAck(state, op, ref) {
  const s = clone(state);
  s.queue = s.queue.filter((o) => !(o.key === op.key && o.draft_id === op.draft_id));
  const cur = s.drafts[op.draft_id];
  if (ref.state === "DISCARDED") delete s.drafts[op.draft_id];
  else if (cur) {
    s.drafts[op.draft_id] = { ...cur, revision: ref.revision, updated_at: ref.updated_at };
    // Một thao tác sửa sau lệnh tạo vẫn đang chờ: nó là revise trên revision vừa nhận.
    s.queue = s.queue.map((o) => (o.draft_id === op.draft_id && o.op === "create" ? { ...o, op: "revise" } : o));
  }
  return s;
}

/** Mạng hỏng trước khi có phản hồi: thao tác ở lại hàng đợi với đúng khóa cũ, gửi lại khi có mạng. @param {SyncState} state @param {any} op @returns {SyncState} */
export function reduceOffline(state, op) {
  const s = clone(state);
  s.queue = s.queue.map((o) => (o.key === op.key && o.draft_id === op.draft_id ? { ...o, sending: false } : o));
  // Nếu trong lúc đó người dùng sửa tiếp, thao tác mới (cùng bản nháp) thay thao tác cũ chưa tới máy chủ: giữ một thao tác.
  const same = s.queue.filter((o) => o.draft_id === op.draft_id);
  if (same.length > 1 && same[0].op !== "discard" && same.at(-1).op !== "discard") {
    const last = same.at(-1);
    s.queue = s.queue.filter((o) => o.draft_id !== op.draft_id || o === last);
    s.queue = s.queue.map((o) => (o === last ? { ...last, op: same[0].op } : o));
  }
  return s;
}

/** 409 REVISION_CONFLICT: giữ bản trên máy này và bản mới nhất của máy chủ; không gửi gì thêm cho tới khi người dùng chọn. @param {SyncState} state @param {any} op @param {any} current @returns {SyncState} */
export function reduceConflict(state, op, current) {
  const s = clone(state);
  s.queue = s.queue.filter((o) => o.draft_id !== op.draft_id);
  const cur = s.drafts[op.draft_id];
  if (current.state === "DISCARDED" || current.snapshot === null) return reduceGone(s, op.draft_id);
  s.drafts[op.draft_id] = { ...(cur ?? { draft_id: op.draft_id, purpose: op.purpose, snapshot: current.snapshot }), discarding: false, conflict: { theirs: current, mine_op: op.op === "discard" ? "discard" : "edit" } };
  return s;
}

/** Bản nháp không còn trên máy chủ (đã bỏ ở máy khác, đã xóa, 404). @param {SyncState} state @param {string} draft_id @returns {SyncState} */
export function reduceGone(state, draft_id) {
  const s = clone(state);
  s.queue = s.queue.filter((o) => o.draft_id !== draft_id);
  delete s.drafts[draft_id];
  return s;
}

/** Người dùng chọn sau xung đột: "mine" gửi bản của máy này trên revision mới nhất; "theirs" nhận bản của máy chủ. @param {SyncState} state @param {string} draft_id @param {"mine" | "theirs"} choice @returns {SyncState} */
export function reduceResolve(state, draft_id, choice, key = newKey()) {
  const s = clone(state);
  const cur = s.drafts[draft_id];
  if (!cur?.conflict) return state;
  const theirs = cur.conflict.theirs;
  if (choice === "theirs") {
    s.drafts[draft_id] = { ...cur, revision: theirs.revision, snapshot: theirs.snapshot, updated_at: theirs.updated_at, conflict: null };
    return s;
  }
  s.drafts[draft_id] = { ...cur, revision: theirs.revision, conflict: null };
  if (cur.conflict.mine_op === "discard") return reduceDiscard(s, draft_id, key);
  s.queue.push({ op: "revise", draft_id, purpose: cur.purpose, snapshot: cur.snapshot, key, sending: false });
  return s;
}

/**
 * Ghép danh sách bản nháp đang mở của máy chủ. Bản không có thao tác chờ và không xung đột nhận bản của máy chủ; bản có thao tác chờ
 * giữ nguyên (lần gửi sẽ gặp 409 nếu máy khác đã sửa); bản đã lên máy chủ mà không còn trong danh sách thì đã bị bỏ ở nơi khác.
 * @param {SyncState} state @param {any[]} drafts @returns {SyncState}
 */
export function mergeServer(state, drafts) {
  const s = clone(state);
  const busy = new Set(s.queue.map((o) => o.draft_id));
  const seen = new Set();
  for (const d of drafts) {
    seen.add(d.draft_id);
    const cur = s.drafts[d.draft_id];
    if (cur && (busy.has(d.draft_id) || cur.conflict)) continue;
    s.drafts[d.draft_id] = { draft_id: d.draft_id, purpose: d.purpose, revision: d.revision, snapshot: d.snapshot, updated_at: d.updated_at, conflict: null };
  }
  for (const [id, e] of Object.entries(s.drafts)) if (!seen.has(id) && e.revision > 0 && !busy.has(id) && !e.conflict) delete s.drafts[id];
  return s;
}

/** Phần được ghi xuống localStorage: chỉ hai mục đích không nhạy cảm, không có cờ đang gửi. @param {SyncState} state @returns {SyncState} */
export function filterStored(state) {
  // Mục từ Hộp tổng hợp (tiêu đề email, nội dung chia sẻ: không do người dùng gõ) chỉ ở trong bộ nhớ của trang.
  const keep = (/** @type {string} */ p, /** @type {any} */ snap) => STORED_PURPOSES.includes(p) && snap?.kind !== "inbox_item";
  const drafts = Object.fromEntries(Object.entries(state.drafts).filter(([, e]) => keep(e.purpose, e.snapshot)));
  const ids = new Set(Object.keys(drafts));
  return { drafts, queue: state.queue.filter((o) => ids.has(o.draft_id) && keep(o.purpose, o.snapshot)).map((o) => ({ ...o, sending: false })) };
}

/** Bản nháp đang hiện (không tính bản đang bỏ), mới sửa trước. @param {SyncState} state @returns {any[]} */
export const visibleDrafts = (state) =>
  Object.values(state.drafts).filter((e) => !e.discarding).sort((a, b) => String(b.updated_at ?? "~").localeCompare(String(a.updated_at ?? "~")) || a.draft_id.localeCompare(b.draft_id));
export const isQueued = (/** @type {SyncState} */ state, /** @type {string} */ id) => state.queue.some((o) => o.draft_id === id);

// ── Máy khách theo tài khoản ──────────────────────────────────────────────────────────────────────────────────────────────────

export class SyncHttpError extends Error {
  /** @param {number} status @param {any} body */
  constructor(status, body) {
    super(`${body?.code ?? "ERROR"} (HTTP ${status})`);
    this.status = status;
    this.code = typeof body?.code === "string" ? body.code : status === 0 ? "OFFLINE" : "ERROR";
    this.body = body;
  }
}

const storageGet = (/** @type {string} */ k) => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "null");
  } catch {
    return null;
  }
};
const storageSet = (/** @type {string} */ k, /** @type {unknown} */ v) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* không lưu được thì chỉ giữ trong bộ nhớ */
  }
};

export class SyncClient {
  /** @param {{ api: any, user: string, now: () => number, changed: () => void, revoked: () => void, reauth: () => Promise<void> }} host */
  constructor(host) {
    this.host = host;
    this.storeKey = `lenhip.sync.v1.${host.api.ws}.${host.user}`;
    const saved = storageGet(this.storeKey);
    /** @type {string | null} */
    this.credential = typeof saved?.credential === "string" ? saved.credential : null;
    this.state = saved?.state ? { drafts: saved.state.drafts ?? {}, queue: saved.state.queue ?? [] } : emptyState();
    /** "unknown" | "none" | "active" | "revoked" */
    this.device = this.credential ? "active" : "none";
    this.loaded = false;
    this.online = true;
    this.devices = null;
    this.timer = 0;
    this.flushing = null;
    this.version = 0;
  }

  get deviceId() {
    return this.credential ? this.credential.split(".")[0] : null;
  }

  save() {
    storageSet(this.storeKey, this.device === "revoked" ? null : { credential: this.credential, state: filterStored(this.state) });
  }

  /** @param {SyncState} next */
  set(next) {
    if (next === this.state) return;
    this.state = next;
    this.version++;
    this.save();
    this.host.changed();
  }

  /** Gọi /v2 với phiên của thiết bị: header X-LeNhip-Device và tham số device (máy chủ tham chiếu đọc tham số). */
  /** @param {"GET" | "POST"} method @param {string} path @param {unknown} [body] @param {string} [key] @returns {Promise<any>} */
  async req(method, path, body, key) {
    const api = this.host.api;
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json", "X-LeNhip-Workspace": api.ws };
    if (api.token) headers.Authorization = `Bearer ${api.token}`;
    let url = path;
    if (this.credential) {
      headers["X-LeNhip-Device"] = this.credential;
      url += (path.includes("?") ? "&" : "?") + "device=" + encodeURIComponent(this.credential);
    }
    if (method === "POST") {
      headers["Idempotency-Key"] = key ?? newKey();
      headers["Content-Type"] = "application/json";
    }
    let r;
    try {
      r = await fetch(url, { method, headers, body: method === "POST" ? JSON.stringify(body ?? {}) : undefined });
    } catch {
      this.online = false;
      throw new SyncHttpError(0, { code: "OFFLINE" });
    }
    this.online = true;
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const e = new SyncHttpError(r.status, data);
      if (e.code === "DEVICE_REVOKED") this.onRevoked();
      else if (e.code === "DEVICE_REQUIRED" && this.credential) this.forgetDevice();
      throw e;
    }
    return data;
  }

  /** Phiên này bị thu hồi ở thiết bị khác: xóa phiên, bản nháp và hàng đợi khỏi trang và khỏi bộ nhớ của trình duyệt (X02). */
  onRevoked() {
    if (this.device === "revoked") return;
    this.device = "revoked";
    this.credential = null;
    this.state = emptyState();
    this.version++;
    storageSet(this.storeKey, null);
    this.host.revoked();
    this.host.changed();
  }

  forgetDevice() {
    this.credential = null;
    this.device = "none";
    this.state = emptyState();
    this.version++;
    this.save();
    this.host.changed();
  }

  /** Đăng ký trình duyệt này làm một phiên. Bí mật sinh trên máy, máy chủ chỉ nhận mã băm. */
  /** @param {string} kind */
  async register(kind) {
    const secret = random(32);
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", secret));
    const body = { kind, secret_hash: b64url(hash) };
    const key = newKey();
    await this.host.reauth();
    const d = await this.req("POST", "/v2/devices", body, key);
    this.credential = `${d.device_id}.${b64url(secret)}`;
    this.device = "active";
    this.save();
    this.version++;
    await this.refresh();
    this.host.changed();
    return d;
  }

  async listDevices() {
    const r = await this.req("GET", "/v2/devices");
    this.devices = r.devices;
    return r;
  }

  /** @param {string} deviceId */
  async revoke(deviceId) {
    const r = await this.req("POST", `/v2/devices/${encodeURIComponent(deviceId)}/revoke`, {});
    await this.listDevices();
    this.version++;
    this.host.changed();
    return r;
  }

  /** Gửi hàng đợi rồi đọc danh sách của máy chủ. Lỗi mạng: dừng, giữ hàng đợi. */
  async refresh() {
    if (this.device !== "active") return;
    await this.flush();
    try {
      const r = await this.req("GET", "/v2/sync/drafts");
      this.loaded = true;
      this.set(mergeServer(this.state, r.drafts));
    } catch (e) {
      if (!(e instanceof SyncHttpError)) throw e;
    }
  }

  flush() {
    if (!this.flushing) this.flushing = this.flushLoop().finally(() => (this.flushing = null));
    return this.flushing;
  }

  async flushLoop() {
    for (let guard = 0; guard < 100 && this.device === "active"; guard++) {
      const op = nextOp(this.state);
      if (!op) return;
      this.set(reduceSending(this.state, op));
      const base = this.state.drafts[op.draft_id]?.revision ?? 0;
      try {
        let ref;
        if (op.op === "create") ref = await this.req("POST", "/v2/sync/drafts", { draft_id: op.draft_id, purpose: op.purpose, snapshot: op.snapshot }, op.key);
        else if (op.op === "revise") ref = await this.req("POST", `/v2/sync/drafts/${op.draft_id}/revisions`, { purpose: op.purpose, base_revision: base, snapshot: op.snapshot }, op.key);
        else ref = await this.req("POST", `/v2/sync/drafts/${op.draft_id}/discard`, { base_revision: base }, op.key);
        this.set(reduceAck(this.state, op, ref));
      } catch (e) {
        if (!(e instanceof SyncHttpError)) throw e;
        if (e.status === 0 || e.status === 429 || e.status >= 500 || e.status === 401) {
          // Không biết máy chủ đã nhận chưa: giữ đúng khóa, gửi lại khi có mạng (cùng khóa và cùng nội dung trả kết quả đã ghi).
          this.set(reduceOffline(this.state, op));
          return;
        }
        if (e.code === "REVISION_CONFLICT" && e.body?.current) this.set(reduceConflict(this.state, op, e.body.current));
        else if (e.code === "DEVICE_REVOKED" || e.code === "DEVICE_REQUIRED") return;
        else this.set(reduceGone(this.state, op.draft_id));
        if (e.code !== "REVISION_CONFLICT") this.lastError = e.code;
      }
    }
  }

  /** @param {{ draft_id: string, purpose: string, snapshot: any }} draft */
  edit(draft) {
    this.set(reduceEdit(this.state, { ...draft, at: new Date(this.host.now()).toISOString() }));
    void this.flush();
  }

  /** @param {string} id */
  discard(id) {
    this.set(reduceDiscard(this.state, id));
    void this.flush();
  }

  /** @param {string} id @param {"mine" | "theirs"} choice */
  resolve(id, choice) {
    this.set(reduceResolve(this.state, id, choice));
    void this.flush();
  }

  /** Đọc lại một bản nháp ngay trước khi dùng nó cho một tác vụ thật: phiên phải còn dùng và revision phải khớp. */
  /** @param {string} id */
  async check(id) {
    const d = await this.req("GET", `/v2/sync/drafts/${encodeURIComponent(id)}`);
    return d;
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      if (!document.hidden) void this.refresh();
    };
    this.timer = Number(setInterval(tick, SYNC_POLL_MS));
    this.onOnline = () => void this.refresh();
    window.addEventListener("online", this.onOnline);
    void this.refresh();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    if (this.onOnline) window.removeEventListener("online", this.onOnline);
  }
}

/** @type {Map<string, SyncClient>} */
const CLIENTS = new Map();

/**
 * Máy khách của tài khoản đang đăng nhập; null khi chưa có /v1/me hoặc cờ `sync` tắt (LNH-T61).
 * @param {any} ctx  ctx của khung giao diện
 * @param {{ revoked?: () => void }} [o]
 * @returns {SyncClient | null}
 */
export function getSyncClient(ctx, o = {}) {
  const sub = ctx?.me?.user?.id;
  const id = typeof sub === "string" && sub && ctx.modules.sync === true ? `${ctx.api.ws}.${sub}` : null;
  // Đổi tài khoản hoặc cờ tắt: dừng máy khách cũ, bản nháp của người cũ rời bộ nhớ của trang.
  for (const [k, c] of CLIENTS) {
    if (k === id) continue;
    c.stop();
    CLIENTS.delete(k);
  }
  if (!id) return null;
  let client = CLIENTS.get(id);
  if (!client) {
    client = new SyncClient({
      api: ctx.api,
      user: sub,
      now: () => ctx.now(),
      changed: () => ctx.rerender(),
      revoked: () => REVOKED_HANDLERS.forEach((fn) => fn(ctx)),
      // Bản chạy thử: lấy token mới (auth_time mới) trước khi đăng ký phiên. Với IAM thật máy chủ trả REAUTH_REQUIRED.
      reauth: async () => {
        if (ctx.api.dev) await ctx.api.login(sub);
      },
    });
    CLIENTS.set(id, client);
    client.start();
  }
  return client;
}

/** @type {Set<(ctx: any) => void>} */
const REVOKED_HANDLERS = new Set();
/** Giao diện đăng ký hàm hiện màn hình «Phiên này đã bị thu hồi». @param {(ctx: any) => void} fn */
export const onSyncRevoked = (fn) => void REVOKED_HANDLERS.add(fn);
