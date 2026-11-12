// @ts-check
// Máy khách nhắn tin của một tài khoản trên thiết bị này (LNH-T30..T35). Không chạm DOM: màn hình Tin nhắn và phần «Thiết bị của
// tôi» đọc trạng thái ở đây và gọi các thao tác; kiểm thử Node (tests/msg-client.test.ts) chạy đúng mã này với máy chủ thật.
//
//   - Khóa riêng của thiết bị không xuất được và nằm trong kho IndexedDB (msg-store.js). Máy chủ chỉ nhận bản mã LNH-MSG-1.
//   - Khóa công khai của mọi điểm nhận tin được GHIM ở lần thấy đầu tiên; tập khóa máy chủ trả về được tính lại mã băm trước khi
//     dùng. Tập khóa của một hội thoại đổi thì bật cờ «danh sách thiết bị đã đổi»; một mã điểm nhận tin đổi khóa thì dừng gửi.
//   - Thăm dò bằng GET thường (LNH-T35): 3 giây khi một hội thoại đang mở, 15 giây khi không, lùi dần tới 60 giây sau 429. Nhịp do
//     bên gọi cấp (ctx.every của khung, tự dừng khi ẩn tab); không stream, không push.
//   - Tin đã nhận được lưu NGUYÊN DẠNG MÃ HÓA rồi mới xác nhận với máy chủ; chỉ mở khi hiển thị, bản rõ chỉ ở trong bộ nhớ.
//   - Gửi đi qua hộp gửi (msg-outbox.js): thân niêm phong một lần, lưu cùng Idempotency-Key trước lần thử đầu. Tệp này KHÔNG BAO
//     GIỜ tự gửi lại một POST: mất phản hồi thì tin ở «chưa rõ đã gửi hay chưa» cho tới khi nó trở về trong hộp thư của chính thiết
//     bị này, hoặc người dùng bấm thử lại (đúng khóa cũ, đúng byte cũ). Khóa mới chỉ sau lời từ chối dứt khoát KEYS_CHANGED.
//     Vì web/api.js tự thử lại một POST khi mất mạng, mọi yêu cầu nhắn tin đi bằng #http() ở dưới, cùng header xác thực và
//     workspace nhưng không thử lại.
import { base64url } from "./jcs.js";
import { generateEndpointKey, groupSafetyCode, keySetDigest, openMessage, safetyCode, sealMessage } from "./msg-crypto.js";
import { OUTBOX_RETRY_WINDOW_MS, emptyOutbox, outboxCanRetry, outboxNeedsReseal, outboxRequest, outboxSendable, outboxStep } from "./msg-outbox.js";
import { openMsgStore } from "./msg-store.js";

/** Nhịp thăm dò (LNH-T35). */
export const MSG_POLL = Object.freeze({ openMs: 3000, idleMs: 15000, maxMs: 60000 });
/** Phiên bản văn bản đồng ý của mục đích `messaging`; bản dịch thêm hậu tố `.<tag>` (LNH-T25). */
export const MSG_KINDS = Object.freeze(["PHONE", "TABLET", "LAPTOP", "DESKTOP", "OTHER"]);

/**
 * @typedef {import("./msg-store.js").MsgStore} MsgStore
 * @typedef {import("./msg-store.js").MsgStored} MsgStored
 * @typedef {import("./msg-store.js").MsgPin} MsgPin
 * @typedef {import("./msg-outbox.js").OutboxItem} OutboxItem
 * @typedef {{
 *   thread_id: string, state: "THREAD_REQUESTED" | "THREAD_ACTIVE" | "THREAD_CLOSED" | "THREAD_BLOCKED",
 *   peer: { user_id: string, name: string }, role: "REQUESTER" | "ADDRESSEE", can_request: boolean, key_set: string | null,
 *   last_seq: number, delivered_seq: number, read_seq: number, peer_delivered_seq: number, peer_read_seq: number, created_at: string,
 * }} MsgThread
 * @typedef {{ endpoint_id: string, kind: string, key_id: string, status: "ACTIVE" | "REVOKED", created_at: string, revoked_at: string | null }} MsgEndpoint
 * @typedef {{
 *   fetch(path: string, init: RequestInit): Promise<Response>,
 *   token(): string | null,
 *   workspace(): string,
 *   user: string,
 *   consented(): boolean,
 *   now(): number,
 *   changed(): void,
 *   incoming(): void,
 *   reauth?(): Promise<void>,
 * }} MsgHost
 *   `changed`: trạng thái đổi, giao diện nên vẽ lại. `incoming`: có tin mới của người kia ngoài hội thoại đang mở (giao diện chỉ
 *   báo «Bạn có tin nhắn mới», không tên, không nội dung). `reauth`: chỉ có ở bản chạy thử, lấy token mới trước khi thêm thiết bị.
 * @typedef {"SENDING" | "WAITING" | "SENT" | "DELIVERED" | "READ" | "UNCERTAIN" | "REJECTED" | "RECEIVED"} MsgBubbleStatus
 *   WAITING: tin xếp sau một tin «chưa rõ đã gửi hay chưa» của cùng hội thoại; nó chỉ đi khi tin trước có kết quả.
 * @typedef {{
 *   key: string, message_id: string | null, client_ref: string, seq: number | null, mine: boolean, sent_at: string | null,
 *   status: MsgBubbleStatus, text: string | null, problem: string | null, refusal: string | null, can_retry: boolean, can_discard: boolean,
 * }} MsgBubble
 */

/** Lỗi HTTP của một yêu cầu nhắn tin; `status` 0 là không có phản hồi (mất mạng, bị cắt). */
export class MsgHttpError extends Error {
  /** @param {number} status @param {string} code @param {any} [body] @param {string | null} [retryAfter] */
  constructor(status, code, body = null, retryAfter = null) {
    super(code);
    this.name = "MsgHttpError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/** Lỗi phía thiết bị, chỉ mang mã: NO_DEVICE, NOT_ACTIVE, STORAGE, KEY_SET_MISMATCH, KEY_CONFLICT và các mã của hộp gửi. */
export class MsgClientError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "MsgClientError";
    this.code = code;
  }
}

/** @param {number} n */
const randomB64 = (n) => base64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));
/** Khóa của một tin trên thiết bị: duy nhất theo UNIQUE(sender_endpoint, client_ref) của máy chủ. @param {string} endpoint @param {string} ref */
const keyOf = (endpoint, ref) => `${endpoint}:${ref}`;
/** @param {unknown} m @returns {m is MsgStored} */
const isEnvelope = (m) => {
  const x = /** @type {Record<string, unknown>} */ (m);
  return !!x && ["message_id", "thread_id", "sender_user", "sender_endpoint", "client_ref", "iv", "ct", "enc", "wrapped", "sent_at"].every((k) => typeof x[k] === "string") && Number.isInteger(x.seq);
};

/** Tài khoản này còn đồng ý `messaging` theo /v1/me hay không. @param {any} me */
export const messagingConsented = (me) => Array.isArray(me?.consents) && me.consents.some((/** @type {any} */ c) => c.purpose_id === "messaging" && c.choice === "GRANTED" && !c.withdrawn_at);

export class MsgClient {
  /** @param {MsgHost} host @param {MsgStore} [store] */
  constructor(host, store) {
    this.host = host;
    /** @type {MsgStore | null} */
    this.store = store ?? null;
    this.ready = false;
    /** Kho trên thiết bị không mở được: không dùng được nhắn tin trên trình duyệt này. */
    this.failed = false;
    this.stopped = false;
    /** Lời từ chối gần nhất của cổng máy chủ: CONSENT_REQUIRED, FORBIDDEN, MODULE_DISABLED, NOT_FOUND; null khi qua cổng. @type {string | null} */
    this.gate = null;
    this.online = true;
    /** @type {import("./msg-store.js").MsgDevice | null} */
    this.device = null;
    /** Thiết bị này vừa bị gỡ từ nơi khác (hoặc do rút đồng ý): dữ liệu nhắn tin trên máy đã được xóa. */
    this.revoked = false;
    /** @type {MsgThread[]} */
    this.threads = [];
    /** @type {MsgEndpoint[]} */
    this.endpoints = [];
    this.endpointLimit = 5;
    /** @type {{ user_id: string, name: string }[] | null} */
    this.people = null;
    this.settings = { share_read: false };
    this.outbox = emptyOutbox();
    /** Phong bì đã lưu theo hội thoại, xếp theo seq. @type {Map<string, MsgStored[]>} */
    this.byThread = new Map();
    /** Bản rõ đã mở, chỉ trong bộ nhớ của trang. @type {Map<string, { text?: string, problem?: string }>} */
    this.texts = new Map();
    /** Hội thoại đang mở trên màn hình: nhịp 3 giây và đánh dấu đã đọc. @type {string | null} */
    this.focus = null;
    /** Hội thoại có tập khóa không dùng được: mã lỗi. @type {Map<string, string>} */
    this.keyFault = new Map();
    /** @type {string | null} */
    this.etag = null;
    this.lastPollAt = 0;
    this.backoffMs = 0;
    /** @type {Promise<void> | null} */
    this.polling = null;
    /** @type {Promise<void> | null} */
    this.starting = null;
    this.pumpAgain = false;
    /** @type {Promise<void> | null} */
    this.pumpRun = null;
    this.notifying = false;
    /** @type {Map<string, number>} */
    this.readSent = new Map();
    this.prunedAt = 0;
  }

  // ── Khởi động và trạng thái ─────────────────────────────────────────────────────────────────────────────────────────────────

  start() {
    this.starting ??= (async () => {
      try {
        this.store ??= await openMsgStore(this.host.user);
        const now = this.host.now();
        await this.store.prune(now);
        this.prunedAt = now;
        this.device = await this.store.device();
        this.outbox = await this.store.outbox();
        await this.store.saveOutbox(this.outbox);
        this.settings = await this.store.settings();
        for (const m of await this.store.messages(now)) this.#index(m);
      } catch {
        this.failed = true;
      }
      this.ready = true;
      this.#changed();
    })();
    return this.starting;
  }

  stop() {
    this.stopped = true;
    this.focus = null;
    try {
      this.store?.backend.close();
    } catch {
      /* đã đóng */
    }
  }

  /** Trình duyệt này đã có điểm nhận tin đang dùng. */
  get registered() {
    return !!this.device?.endpoint_id;
  }

  /** Kho giữ được khóa qua lần nạp lại trang (có IndexedDB). */
  get persistent() {
    return this.store?.persistent === true;
  }

  #changed() {
    if (this.notifying || this.stopped) return;
    this.notifying = true;
    // Gộp nhiều thay đổi trong một lượt xử lý thành một lần vẽ lại, và không bao giờ vẽ lại ngay giữa một thao tác.
    queueMicrotask(() => {
      this.notifying = false;
      if (!this.stopped) this.host.changed();
    });
  }

  #need() {
    const d = this.device;
    if (!this.store || !d || !d.endpoint_id) throw new MsgClientError("NO_DEVICE");
    return { store: this.store, device: /** @type {import("./msg-store.js").MsgDevice & { endpoint_id: string }} */ (d) };
  }

  /** @param {string} threadId */
  thread(threadId) {
    return this.threads.find((t) => t.thread_id === threadId) ?? null;
  }

  /** @param {MsgThread} t */
  #upsert(t) {
    const i = this.threads.findIndex((x) => x.thread_id === t.thread_id);
    if (i < 0) this.threads = [...this.threads, t];
    else this.threads = this.threads.map((x, n) => (n === i ? t : x));
  }

  /** @param {MsgStored} m @returns {boolean} true nếu là tin chưa có trên thiết bị */
  #index(m) {
    const list = this.byThread.get(m.thread_id) ?? [];
    if (list.some((x) => x.message_id === m.message_id)) return false;
    list.push(m);
    list.sort((a, b) => a.seq - b.seq);
    this.byThread.set(m.thread_id, list);
    return true;
  }

  // ── HTTP không tự gửi lại ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Một yêu cầu, một lần. `body` là chuỗi thì được gửi đúng từng byte (thân đã niêm phong của hộp gửi).
   * @param {"GET" | "POST"} method @param {string} path @param {unknown} [body] @param {string} [key]
   * @returns {Promise<any>}
   */
  async #http(method, path, body, key) {
    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json", "X-LeNhip-Workspace": this.host.workspace() };
    const token = this.host.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    /** @type {string | undefined} */
    let payload;
    if (method === "POST") {
      headers["Idempotency-Key"] = key ?? randomB64(32);
      headers["Content-Type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body ?? {});
    }
    /** @type {Response} */
    let res;
    try {
      res = await this.host.fetch(path, { method, headers, body: payload });
    } catch {
      throw new MsgHttpError(0, "OFFLINE");
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new MsgHttpError(res.status, typeof data?.code === "string" ? data.code : `HTTP_${res.status}`, data, res.headers.get("Retry-After"));
    return data;
  }

  /** Ghi nhận một lỗi của máy chủ vào trạng thái chung. Trả true nếu lỗi đã được xử lý ở đây. @param {unknown} e */
  async #fault(e) {
    if (!(e instanceof MsgHttpError)) return false;
    if (e.status === 0) {
      this.online = false;
      return true;
    }
    this.online = true;
    if (e.status === 429) {
      // Lùi dần: gấp đôi tới 60 giây, không ngắn hơn Retry-After của máy chủ.
      const asked = Number(e.retryAfter) * 1000;
      this.backoffMs = Math.min(MSG_POLL.maxMs, Math.max(this.backoffMs * 2, MSG_POLL.openMs * 2, Number.isFinite(asked) ? asked : 0));
      return true;
    }
    if (e.status === 403 || e.status === 503) {
      this.gate = e.code;
      return true;
    }
    if (e.status === 404) {
      await this.#checkRevoked();
      return true;
    }
    return false;
  }

  /** Hộp thư trả 404: hỏi lại danh sách thiết bị của mình. Thiết bị này không còn ACTIVE thì xóa dữ liệu nhắn tin trên máy. */
  async #checkRevoked() {
    try {
      const list = await this.#http("GET", "/v1/messages/endpoints");
      // Danh sách thiết bị trả 200 nghĩa là tài khoản qua được cổng; 404 lúc nãy là của riêng thiết bị hoặc hội thoại.
      this.gate = null;
      this.#setEndpoints(list);
      const mine = this.endpoints.find((x) => x.endpoint_id === this.device?.endpoint_id);
      if (this.device?.endpoint_id && (!mine || mine.status !== "ACTIVE")) await this.#forget(true);
    } catch (e) {
      if (e instanceof MsgHttpError && e.status === 404) this.gate = "NOT_FOUND";
      else if (e instanceof MsgHttpError && (e.status === 403 || e.status === 503)) this.gate = e.code;
      else if (e instanceof MsgHttpError && e.status === 0) this.online = false;
    }
  }

  /** @param {any} list */
  #setEndpoints(list) {
    if (Array.isArray(list?.endpoints)) this.endpoints = list.endpoints;
    if (Number.isInteger(list?.limit)) this.endpointLimit = list.limit;
  }

  /** Bỏ mọi dữ liệu nhắn tin của tài khoản này trên thiết bị. @param {boolean} revoked */
  async #forget(revoked) {
    await this.store?.wipe();
    this.device = null;
    this.revoked = revoked;
    this.outbox = emptyOutbox();
    this.byThread.clear();
    this.texts.clear();
    this.keyFault.clear();
    this.readSent.clear();
    this.threads = [];
    this.etag = null;
  }

  // ── Thăm dò hộp thư ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Thăm dò ngay ở nhịp kế tiếp (sau một thao tác của người dùng). */
  poke() {
    this.lastPollAt = 0;
  }

  /** Khoảng chờ hiện hành giữa hai lần thăm dò. */
  interval() {
    return Math.max(this.focus ? MSG_POLL.openMs : MSG_POLL.idleMs, this.backoffMs);
  }

  /** Bên gọi cấp nhịp (mỗi giây, chỉ khi tab đang hiện); hàm này tự quyết đã tới lúc thăm dò hay chưa. @param {number} [clock] */
  async tick(clock = Date.now()) {
    if (!this.ready || this.stopped || this.failed) return;
    if (clock - this.lastPollAt < this.interval()) return;
    this.lastPollAt = clock;
    await this.poll();
  }

  poll() {
    this.polling ??= this.#poll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  async #poll() {
    if (!this.ready || this.stopped || this.failed || !this.store) return;
    // Chưa đồng ý thì không gọi máy chủ; chưa đăng ký thiết bị thì chưa có hộp thư nào để hỏi.
    if (!this.host.consented() || !this.device?.endpoint_id) return;
    const endpoint = this.device.endpoint_id;
    await this.#prune();
    try {
      for (let page = 0; page < 4; page++) {
        const box = await this.#http("GET", `/v1/messages/inbox?endpoint=${endpoint}${this.etag ? `&etag=${this.etag}` : ""}`);
        this.online = true;
        this.gate = null;
        this.backoffMs = 0;
        if (!box || box.changed !== true) break;
        const acked = await this.#absorb(box, endpoint);
        // Còn phong bì chưa xác nhận được thì không giữ etag: lần sau máy chủ phải trả lại chúng để xác nhận lại.
        this.etag = acked && typeof box.etag === "string" ? box.etag : null;
        if (!acked || box.more !== true) break;
      }
    } catch (e) {
      if (!(await this.#fault(e))) console.error(e);
    }
    await this.#syncKeys();
    await this.pump();
    if (this.focus) await this.markRead(this.focus);
    this.#changed();
  }

  /**
   * Máy chủ báo (qua key_set của hội thoại trong hộp thư) rằng tập khóa khác với tập thiết bị này đã kiểm: lấy lại khóa, tự tính
   * lại mã băm, ghim khóa mới và bật cờ «danh sách thiết bị đã đổi». Hội thoại đang có lỗi khóa thì chờ người dùng bấm kiểm lại.
   */
  async #syncKeys() {
    if (!this.store || !this.registered) return;
    for (const t of this.threads) {
      if (t.state !== "THREAD_ACTIVE" || !t.key_set || this.keyFault.has(t.thread_id) || this.store.note(t.thread_id).key_set === t.key_set) continue;
      try {
        await this.ensureKeys(t.thread_id);
      } catch (e) {
        if (e instanceof MsgHttpError && e.status === 0) this.online = false;
      }
    }
  }

  /**
   * Nhận một trang hộp thư: lưu phong bì nguyên dạng mã hóa, RỒI MỚI xác nhận với máy chủ.
   * @param {any} box @param {string} endpoint @returns {Promise<boolean>} false nếu còn phong bì chưa xác nhận được
   */
  async #absorb(box, endpoint) {
    const store = /** @type {MsgStore} */ (this.store);
    if (Array.isArray(box.threads)) this.threads = box.threads;
    this.#setEndpoints(box);
    /** @type {MsgStored[]} */
    const fresh = (Array.isArray(box.messages) ? box.messages : []).filter(isEnvelope);
    if (!fresh.length) return true;
    await store.putMessages(fresh);
    let arrived = false;
    for (const m of fresh) {
      const isNew = this.#index(m);
      if (isNew && m.sender_user !== this.host.user && m.thread_id !== this.focus) arrived = true;
      // Bằng chứng cho hộp gửi: tin của chính thiết bị này đã nằm ở máy chủ.
      if (m.sender_endpoint === endpoint) {
        const r = outboxStep(this.outbox, { type: "evidence", client_ref: m.client_ref, message_id: m.message_id, seq: m.seq, sent_at: m.sent_at });
        if (!r.error) this.outbox = r.outbox;
      }
    }
    await this.#settle();
    try {
      await this.#http("POST", "/v1/messages/ack", { endpoint_id: endpoint, message_ids: fresh.map((m) => m.message_id) });
    } catch (e) {
      // Xác nhận chưa tới: phong bì đã nằm an toàn trên thiết bị, lần thăm dò sau sẽ xác nhận lại.
      if (!(await this.#fault(e))) console.error(e);
      if (arrived) this.host.incoming();
      return false;
    }
    if (arrived) this.host.incoming();
    return true;
  }

  /** Trang mở lâu: mỗi giờ bỏ các phong bì đã quá 30 ngày khỏi kho và khỏi bộ nhớ (LNH-T32). */
  async #prune() {
    const now = this.host.now();
    if (!this.store || now - this.prunedAt < 3_600_000) return;
    this.prunedAt = now;
    const gone = new Set(await this.store.prune(now));
    if (!gone.size) return;
    for (const [threadId, list] of this.byThread) this.byThread.set(threadId, list.filter((m) => !gone.has(m.message_id)));
  }

  /** Tin đã gửi xong và đã có bản trong kho thì rời hộp gửi. */
  async #settle() {
    const mine = this.device?.endpoint_id;
    if (!mine || !this.store) return;
    for (const item of this.outbox.items) {
      if (item.state !== "SENT") continue;
      if (!(this.byThread.get(item.thread_id) ?? []).some((m) => m.sender_endpoint === mine && m.client_ref === item.client_ref)) continue;
      const r = outboxStep(this.outbox, { type: "discard", client_ref: item.client_ref });
      if (!r.error) this.outbox = r.outbox;
    }
    await this.store.saveOutbox(this.outbox);
  }

  // ── Thiết bị của tôi ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Đăng ký trình duyệt này làm một điểm nhận tin với loại máy do người dùng chọn. Khóa được tạo và lưu trước khi gọi máy chủ:
   * mất phản hồi thì đăng ký lại đúng khóa đó vẫn ra cùng một điểm nhận tin.
   * @param {string} kind
   */
  async registerDevice(kind) {
    if (!this.store || !this.ready || this.failed || !this.store.persistent) throw new MsgClientError("STORAGE");
    if (!MSG_KINDS.includes(kind)) throw new MsgClientError("KIND");
    for (let round = 0; round < 2; round++) {
      let d = this.device;
      if (!d) {
        const k = await generateEndpointKey();
        d = { privateKey: k.privateKey, public_key: k.public_key, endpoint_id: null, kind: null, created_at: null };
        await this.store.saveDevice(d);
        this.device = d;
      }
      await this.host.reauth?.();
      try {
        const r = await this.#http("POST", "/v1/messages/endpoints", { public_key: d.public_key, kind });
        d = { ...d, endpoint_id: r.endpoint_id, kind: r.kind, created_at: r.created_at };
        await this.store.saveDevice(d);
        await this.store.pin([{ endpoint_id: r.endpoint_id, user_id: this.host.user, public_key: d.public_key }]);
        this.device = d;
        this.revoked = false;
        this.gate = null;
        this.etag = null;
        this.poke();
        this.#changed();
        return d;
      } catch (e) {
        // Khóa này đã bị gỡ từ trước (hoặc không còn là của mình): bỏ nó, tạo khóa mới và thử đúng một lần nữa.
        if (round === 0 && e instanceof MsgHttpError && e.status === 409 && !d.endpoint_id) {
          await this.#forget(false);
          continue;
        }
        throw e;
      }
    }
    throw new MsgClientError("NO_DEVICE");
  }

  async loadEndpoints() {
    try {
      this.#setEndpoints(await this.#http("GET", "/v1/messages/endpoints"));
      this.online = true;
      this.gate = null;
      const mine = this.endpoints.find((x) => x.endpoint_id === this.device?.endpoint_id);
      if (this.device?.endpoint_id && (!mine || mine.status !== "ACTIVE")) await this.#forget(true);
    } catch (e) {
      if (!(await this.#fault(e))) throw e;
    }
    this.#changed();
  }

  /** Gỡ một thiết bị của mình. Gỡ chính thiết bị này thì xóa luôn khóa và lịch sử trên máy. @param {string} endpointId */
  async revokeEndpoint(endpointId) {
    await this.#http("POST", `/v1/messages/endpoints/${endpointId}/revoke`, {});
    if (endpointId === this.device?.endpoint_id) await this.#forget(false);
    this.etag = null;
    try {
      this.#setEndpoints(await this.#http("GET", "/v1/messages/endpoints"));
    } catch {
      /* danh sách sẽ được nạp lại ở lần thăm dò sau */
    }
    this.poke();
    this.#changed();
  }

  // ── Người và hội thoại ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async loadPeople() {
    try {
      const r = await this.#http("GET", "/v1/messages/people");
      this.people = Array.isArray(r?.people) ? r.people : [];
    } catch (e) {
      if (!(await this.#fault(e))) throw e;
    }
    this.#changed();
  }

  /** Gửi lời mời (không kèm chữ) hoặc mời lại. @param {string} peer */
  async invite(peer) {
    const t = await this.#http("POST", "/v1/messages/threads", { peer });
    this.#upsert(t);
    this.etag = null;
    this.poke();
    this.#changed();
    return /** @type {MsgThread} */ (t);
  }

  /** @param {string} threadId @param {"accept" | "decline" | "withdraw" | "block" | "unblock"} op */
  async threadOp(threadId, op) {
    const t = await this.#http("POST", `/v1/messages/threads/${threadId}/${op}`, {});
    this.#upsert(t);
    this.etag = null;
    this.poke();
    this.#changed();
    return /** @type {MsgThread} */ (t);
  }

  /** Báo cáo không kèm nội dung. @param {string} threadId @param {"SPAM" | "HARASSMENT" | "OTHER"} reason */
  async report(threadId, reason) {
    await this.#http("POST", "/v1/messages/reports", { thread_id: threadId, reason });
  }

  // ── Khóa của hội thoại ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Lấy tập khóa hiện hành của hội thoại, tự tính lại mã băm, kiểm với khóa đã ghim rồi mới dùng.
   * @param {string} threadId
   * @returns {Promise<{ endpoints: MsgPin[], key_set: string }>}
   */
  async ensureKeys(threadId) {
    const { store, device } = this.#need();
    const ks = await this.#http("GET", `/v1/messages/threads/${threadId}/keys`);
    /** @param {string} code @returns {never} */
    const refuse = (code) => {
      this.keyFault.set(threadId, code);
      this.#changed();
      throw new MsgClientError(code);
    };
    /** @type {MsgPin[]} */
    const endpoints = Array.isArray(ks?.endpoints) ? ks.endpoints : [];
    let digest = "";
    try {
      digest = await keySetDigest(threadId, endpoints);
    } catch {
      refuse("KEY_SET_MISMATCH");
    }
    const peer = this.thread(threadId)?.peer.user_id;
    const users = new Set(endpoints.map((x) => x.user_id));
    const own = endpoints.find((x) => x.endpoint_id === device.endpoint_id);
    // Máy chủ phải trả đúng mã băm của danh sách nó gửi, danh sách chỉ gồm hai người của hội thoại, và có đúng khóa của thiết bị này.
    if (digest !== ks.key_set || !own || own.public_key !== device.public_key || own.user_id !== this.host.user) refuse("KEY_SET_MISMATCH");
    if (users.size !== 2 || (peer && !users.has(peer))) refuse("KEY_SET_MISMATCH");
    const pinned = await store.pin(endpoints);
    if (pinned.conflicts.length) refuse("KEY_CONFLICT");
    const note = store.note(threadId);
    await store.saveNote(threadId, { key_set: digest, endpoints, devices_changed: note.devices_changed || (note.key_set !== null && note.key_set !== digest) });
    this.keyFault.delete(threadId);
    if (pinned.added.length) for (const [k, v] of this.texts) if (v.problem === "UNKNOWN_SENDER") this.texts.delete(k);
    return { endpoints, key_set: digest };
  }

  /** Ghi chú trên thiết bị của một hội thoại (tập khóa đã thấy, cờ thiết bị đã đổi…). @param {string} threadId */
  note(threadId) {
    return this.store ? this.store.note(threadId) : null;
  }

  /** @param {string} threadId */
  async dismissDevicesChanged(threadId) {
    await this.store?.saveNote(threadId, { devices_changed: false });
    this.#changed();
  }

  /**
   * Mã an toàn 30 chữ số của hội thoại, tính từ tập khóa hiện hành của hai người.
   * @param {string} threadId
   */
  async safety(threadId) {
    const { store } = this.#need();
    const t = this.thread(threadId);
    if (!t) throw new MsgClientError("NOT_ACTIVE");
    const ks = await this.ensureKeys(threadId);
    const code = await safetyCode(this.host.user, t.peer.user_id, ks.endpoints);
    return {
      code, groups: groupSafetyCode(code), verified: store.note(threadId).verified_key_set === ks.key_set,
      mine: ks.endpoints.filter((x) => x.user_id === this.host.user).length, theirs: ks.endpoints.filter((x) => x.user_id === t.peer.user_id).length,
    };
  }

  /** Người dùng xác nhận đã so mã an toàn với người kia cho đúng tập khóa hiện hành. @param {string} threadId */
  async confirmSafety(threadId) {
    const { store } = this.#need();
    await store.saveNote(threadId, { verified_key_set: store.note(threadId).key_set, devices_changed: false });
    this.#changed();
  }

  // ── Gửi ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Niêm phong một tin cho tập khóa đã kiểm của hội thoại, xếp vào hộp gửi (đã lưu) rồi mới thử gửi.
   * @param {string} threadId @param {string} text
   * @returns {Promise<string>} client_ref của tin
   */
  async send(threadId, text) {
    const { store, device } = this.#need();
    const t = this.thread(threadId);
    if (t?.state !== "THREAD_ACTIVE") throw new MsgClientError("NOT_ACTIVE");
    // Máy chủ đã nói hiện không gửi được tới người kia (không còn thiết bị, mất quyền…): không niêm phong, không gọi máy chủ.
    if (t.key_set === null) throw new MsgClientError("RECIPIENT_UNAVAILABLE");
    if (this.keyFault.has(threadId)) throw new MsgClientError(/** @type {string} */ (this.keyFault.get(threadId)));
    let note = store.note(threadId);
    if (!note.key_set || !note.endpoints.length || note.key_set !== t.key_set) {
      try {
        await this.ensureKeys(threadId);
      } catch (e) {
        // Mất mạng mà đã có tập khóa đã kiểm: niêm phong bằng tập đó. Nếu nó đã cũ, máy chủ từ chối dứt khoát (KEYS_CHANGED).
        if (!(e instanceof MsgHttpError && e.status === 0 && note.key_set && note.endpoints.length)) throw e;
      }
      note = store.note(threadId);
    }
    const ref = randomB64(18);
    const body = await sealMessage({ text, thread_id: threadId, client_ref: ref, key_set: /** @type {string} */ (note.key_set), sender: device, recipients: note.endpoints });
    const r = outboxStep(this.outbox, { type: "enqueue", client_ref: ref, thread_id: threadId, idem_key: randomB64(32), body: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (body)), at: this.host.now() });
    if (r.error) throw new MsgClientError(r.error);
    this.outbox = r.outbox;
    this.texts.set(keyOf(device.endpoint_id, ref), { text });
    await store.saveOutbox(this.outbox);
    this.#changed();
    void this.pump();
    return ref;
  }

  /**
   * Gửi LẦN ĐẦU các tin đang xếp hàng (mỗi hội thoại một tin một lúc) và niêm phong lại các tin bị KEYS_CHANGED. Tin đã thử một
   * lần không bao giờ đi qua đây lần nữa: chỉ retry() của người dùng gửi lại.
   * @returns {Promise<void>}
   */
  pump() {
    this.pumpAgain = true;
    // .finally chạy sau khi phép gán xong, kể cả khi vòng lặp không có gì để làm và kết thúc ngay.
    this.pumpRun ??= this.#pumpLoop().finally(() => {
      this.pumpRun = null;
    });
    return this.pumpRun;
  }

  async #pumpLoop() {
    while (this.pumpAgain && !this.stopped && this.registered) {
      this.pumpAgain = false;
      for (let guard = 0; guard < 64; guard++) {
        let progressed = false;
        for (const item of outboxNeedsReseal(this.outbox)) progressed = (await this.#reseal(item)) || progressed;
        const next = outboxSendable(this.outbox)[0];
        if (next) {
          await this.#attempt(next.client_ref, false);
          progressed = true;
        }
        if (!progressed) break;
      }
    }
  }

  /** Người dùng bấm «Thử lại»: đúng Idempotency-Key cũ, đúng các byte cũ. @param {string} clientRef */
  async retry(clientRef) {
    if (!outboxCanRetry(this.outbox, clientRef, this.host.now())) return;
    await this.#attempt(clientRef, true);
    await this.pump();
  }

  /** Người dùng bỏ một tin chưa gửi được. @param {string} clientRef */
  async discard(clientRef) {
    const r = outboxStep(this.outbox, { type: "discard", client_ref: clientRef });
    if (r.error) return;
    this.outbox = r.outbox;
    await this.store?.saveOutbox(this.outbox);
    this.#changed();
    void this.pump();
  }

  /** @param {string} clientRef @param {boolean} byUser */
  async #attempt(clientRef, byUser) {
    const { store } = this.#need();
    const started = outboxStep(this.outbox, byUser ? { type: "retry", client_ref: clientRef, at: this.host.now() } : { type: "attempt", client_ref: clientRef });
    if (started.error) return;
    this.outbox = started.outbox;
    // «Đang gửi» nằm trên đĩa trước khi gọi mạng: trang bị đóng giữa chừng thì lần mở sau thấy «chưa rõ đã gửi hay chưa».
    await store.saveOutbox(this.outbox);
    this.#changed();
    const item = /** @type {OutboxItem} */ (this.outbox.items.find((x) => x.client_ref === clientRef));
    const req = outboxRequest(item);
    /** @type {import("./msg-outbox.js").OutboxEvent} */
    let event;
    try {
      const res = await this.#http("POST", req.path, item.body, req.key);
      event = { type: "response", client_ref: clientRef, status: 201, message_id: res?.message_id, seq: res?.seq, sent_at: res?.sent_at };
    } catch (e) {
      if (!(e instanceof MsgHttpError)) throw e;
      if (e.status === 0) this.online = false;
      event = e.status === 0 ? { type: "lost", client_ref: clientRef } : { type: "response", client_ref: clientRef, status: e.status, code: e.code, resource_id: e.body?.resource_id };
    }
    const done = outboxStep(this.outbox, event);
    if (!done.error) this.outbox = done.outbox;
    await store.saveOutbox(this.outbox);
    this.poke();
    this.#changed();
  }

  /** Sau KEYS_CHANGED (chắc chắn chưa lưu): lấy lại khóa, niêm phong lại với khóa idempotency mới, giữ client_ref. @param {OutboxItem} item */
  async #reseal(item) {
    try {
      const { store, device } = this.#need();
      const text = await this.#ownText(item);
      const ks = await this.ensureKeys(item.thread_id);
      const body = await sealMessage({ text, thread_id: item.thread_id, client_ref: item.client_ref, key_set: ks.key_set, sender: device, recipients: ks.endpoints });
      const r = outboxStep(this.outbox, { type: "reseal", client_ref: item.client_ref, idem_key: randomB64(32), body: /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (body)) });
      if (r.error) return false;
      this.outbox = r.outbox;
      await store.saveOutbox(this.outbox);
      return true;
    } catch (e) {
      if (e instanceof MsgHttpError && e.status === 0) this.online = false;
      return false;
    }
  }

  /** Bản rõ của một tin trong hộp gửi: mở phong bì thiết bị này đã tự niêm phong cho chính nó. @param {OutboxItem} item */
  async #ownText(item) {
    const { device } = this.#need();
    const key = keyOf(device.endpoint_id, item.client_ref);
    const cached = this.texts.get(key)?.text;
    if (typeof cached === "string") return cached;
    const body = JSON.parse(item.body);
    const env = body.envelopes.find((/** @type {any} */ e) => e.endpoint_id === device.endpoint_id);
    const opened = await openMessage({
      thread_id: item.thread_id, message: { client_ref: body.client_ref, sender_endpoint: body.sender_endpoint, iv: body.iv, ct: body.ct, enc: env.enc, wrapped: env.wrapped },
      recipient: device, sender_public_key: device.public_key,
    });
    this.texts.set(key, { text: opened.text });
    return opened.text;
  }

  // ── Hiển thị ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Mở các tin của một hội thoại bằng khóa của thiết bị này và khóa ĐÃ GHIM của thiết bị gửi. Bản rõ chỉ nằm trong bộ nhớ.
   * @param {string} threadId
   * @returns {Promise<boolean>} true nếu có tin vừa được mở (giao diện nên vẽ lại)
   */
  async decrypt(threadId) {
    const d = this.device;
    if (!this.store || !d?.endpoint_id) return false;
    let opened = false;
    let asked = false;
    for (const m of this.byThread.get(threadId) ?? []) {
      const key = keyOf(m.sender_endpoint, m.client_ref);
      if (this.texts.has(key)) continue;
      let pin = this.store.pinned(m.sender_endpoint);
      if (!pin && !asked) {
        // Thiết bị gửi chưa từng thấy: hỏi tập khóa hiện hành của hội thoại một lần rồi ghim.
        asked = true;
        try {
          await this.ensureKeys(threadId);
        } catch {
          /* hội thoại đã đóng hoặc mất mạng: tin này chưa mở được */
        }
        pin = this.store.pinned(m.sender_endpoint);
      }
      if (!pin) {
        this.texts.set(key, { problem: "UNKNOWN_SENDER" });
      } else if (pin.user_id !== m.sender_user) {
        this.texts.set(key, { problem: "OPEN_FAILED" });
      } else {
        try {
          this.texts.set(key, { text: (await openMessage({ thread_id: m.thread_id, message: m, recipient: d, sender_public_key: pin.public_key })).text });
        } catch {
          this.texts.set(key, { problem: "OPEN_FAILED" });
        }
      }
      opened = true;
    }
    for (const item of this.outbox.items) {
      if (item.thread_id !== threadId || this.texts.has(keyOf(d.endpoint_id, item.client_ref))) continue;
      try {
        await this.#ownText(item);
      } catch {
        this.texts.set(keyOf(d.endpoint_id, item.client_ref), { problem: "OPEN_FAILED" });
      }
      opened = true;
    }
    return opened;
  }

  /**
   * Các bong bóng của một hội thoại: tin đã lưu trên thiết bị theo seq, rồi các tin còn trong hộp gửi. Trạng thái theo bằng chứng.
   * @param {string} threadId
   * @returns {MsgBubble[]}
   */
  timeline(threadId) {
    const t = this.thread(threadId);
    const me = this.host.user;
    const now = this.host.now();
    /** @type {MsgBubble[]} */
    const out = [];
    const have = new Set();
    /** @param {number | null} seq @returns {MsgBubbleStatus} */
    const proven = (seq) => (t && seq !== null && seq <= t.peer_read_seq ? "READ" : t && seq !== null && seq <= t.peer_delivered_seq ? "DELIVERED" : "SENT");
    for (const m of this.byThread.get(threadId) ?? []) {
      const key = keyOf(m.sender_endpoint, m.client_ref);
      have.add(key);
      const mine = m.sender_user === me;
      const c = this.texts.get(key);
      out.push({
        key, message_id: m.message_id, client_ref: m.client_ref, seq: m.seq, mine, sent_at: m.sent_at, status: mine ? proven(m.seq) : "RECEIVED",
        text: c?.text ?? null, problem: c?.problem ?? null, refusal: null, can_retry: false, can_discard: false,
      });
    }
    const endpoint = this.device?.endpoint_id;
    if (!endpoint) return out;
    for (const item of this.outbox.items) {
      const key = keyOf(endpoint, item.client_ref);
      if (item.thread_id !== threadId || have.has(key)) continue;
      const c = this.texts.get(key);
      const tooOld = now - item.created_at > OUTBOX_RETRY_WINDOW_MS;
      /** @type {MsgBubbleStatus} */
      let status = "SENDING";
      let refusal = null;
      let canDiscard = false;
      if (item.state === "SENT") status = proven(item.seq);
      else if (item.state === "UNCERTAIN") {
        status = "UNCERTAIN";
        canDiscard = tooOld;
      } else if (item.state === "REJECTED") {
        status = "REJECTED";
        refusal = item.refusal?.code ?? null;
        canDiscard = true;
      } else if (item.state === "QUEUED" && item.needs_reseal && t?.state !== "THREAD_ACTIVE") {
        // Bị từ chối dứt khoát (KEYS_CHANGED) rồi hội thoại đóng: chắc chắn chưa lưu và không còn nơi để gửi.
        status = "REJECTED";
        refusal = "RECIPIENT_UNAVAILABLE";
        canDiscard = true;
      } else if (item.state === "QUEUED" && this.outbox.items.some((x) => x.thread_id === threadId && x.state === "UNCERTAIN" && x.created_at <= item.created_at && x !== item)) {
        status = "WAITING";
        canDiscard = true;
      }
      out.push({
        key, message_id: item.message_id, client_ref: item.client_ref, seq: item.seq, mine: true, sent_at: item.sent_at ?? new Date(item.created_at).toISOString(), status,
        text: c?.text ?? null, problem: c?.problem ?? null, refusal, can_retry: outboxCanRetry(this.outbox, item.client_ref, now), can_discard: canDiscard,
      });
    }
    return out;
  }

  /** Số tin của người kia chưa đọc trong một hội thoại, theo những gì thiết bị này đang giữ. @param {string} threadId */
  unreadOf(threadId) {
    const t = this.thread(threadId);
    if (!t) return 0;
    return (this.byThread.get(threadId) ?? []).filter((m) => m.sender_user !== this.host.user && m.seq > t.read_seq).length;
  }

  /** Số cho huy hiệu: tin chưa đọc cộng lời mời đang chờ mình trả lời. Không tên, không nội dung. */
  unread() {
    let n = 0;
    for (const t of this.threads) n += this.unreadOf(t.thread_id) + (t.state === "THREAD_REQUESTED" && t.role === "ADDRESSEE" ? 1 : 0);
    return n;
  }

  /**
   * Đánh dấu đã đọc tới tin mới nhất thiết bị này đang giữ. Người kia chỉ thấy «đã xem» khi lựa chọn chia sẻ đang bật (mặc định tắt).
   * @param {string} threadId
   */
  async markRead(threadId) {
    const list = this.byThread.get(threadId) ?? [];
    const top = list.length ? list[list.length - 1].seq : 0;
    if (!this.registered || !this.unreadOf(threadId) || this.readSent.get(threadId) === top) return;
    try {
      const t = await this.#http("POST", `/v1/messages/threads/${threadId}/read`, { through_seq: top, share: this.settings.share_read });
      this.readSent.set(threadId, top);
      this.#upsert(t);
      this.etag = null;
      this.#changed();
    } catch (e) {
      if (!(await this.#fault(e))) this.readSent.set(threadId, top);
    }
  }

  /** @param {boolean} share */
  async setShareRead(share) {
    this.settings = { share_read: share === true };
    await this.store?.saveSettings(this.settings);
    this.#changed();
  }

  /** @param {string} threadId */
  draft(threadId) {
    return this.store ? this.store.draft(threadId) : Promise.resolve("");
  }

  /** @param {string} threadId @param {string} text */
  async setDraft(threadId, text) {
    try {
      await this.store?.setDraft(threadId, text);
    } catch {
      /* bản nháp không lưu được thì vẫn còn trong ô soạn */
    }
  }
}

/** Máy khách đang chạy theo tài khoản. @type {Map<string, MsgClient>} */
const CLIENTS = new Map();

/**
 * Máy khách của tài khoản đang đăng nhập, dựng từ `ctx` của khung giao diện (web/views/index.js). Trả null khi chưa có /v1/me.
 * @param {any} ctx
 * @returns {MsgClient | null}
 */
export function getMsgClient(ctx) {
  const sub = ctx?.me?.user?.id;
  if (typeof sub !== "string" || !sub) return null;
  let client = CLIENTS.get(sub);
  if (!client) {
    client = new MsgClient({
      fetch: (path, init) => fetch(path, init),
      token: () => ctx.api.token,
      workspace: () => ctx.api.ws,
      user: sub,
      consented: () => ctx.me?.user?.id === sub && messagingConsented(ctx.me),
      now: () => ctx.now(),
      changed: () => ctx.rerender(),
      // Không tên, không nội dung (LNH-T35).
      incoming: () => ctx.toast(ctx.t("msg.toast.new")),
      // Bản chạy thử: lấy token mới (auth_time mới) trước khi thêm thiết bị, như app.js làm trước khi xuất dữ liệu. Web chưa có
      // đăng nhập thật; với IAM thật máy chủ trả REAUTH_REQUIRED và giao diện nói người dùng đăng nhập lại.
      reauth: async () => {
        if (ctx.api.dev) await ctx.api.login(sub);
      },
    });
    CLIENTS.set(sub, client);
    void client.start();
  }
  return client;
}

/** Dừng và bỏ máy khách của một tài khoản (đổi tài khoản, mô-đun tắt): bản rõ đã mở rời bộ nhớ. @param {string} sub */
export function dropMsgClient(sub) {
  CLIENTS.get(sub)?.stop();
  CLIENTS.delete(sub);
}
