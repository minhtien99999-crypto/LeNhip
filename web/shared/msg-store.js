// @ts-check
// Kho nhắn tin trên thiết bị (LNH-T31, LNH-T32), một cơ sở dữ liệu IndexedDB cho mỗi tài khoản: `lenhip.msg.v1.<sub>`.
//
//   kv        device   cặp khóa ECDH P-256 của trình duyệt này (khóa riêng KHÔNG xuất được), mã điểm nhận tin, loại máy
//             draftKey khóa AES-256-GCM không xuất được, chỉ để mã hóa bản nháp trong kho này
//             outbox   hộp gửi (web/shared/msg-outbox.js): thân đã niêm phong và Idempotency-Key của từng tin
//             settings lựa chọn trên thiết bị (chia sẻ «đã xem», mặc định tắt)
//   messages  phong bì đã nhận, GIỮ NGUYÊN dạng đã mã hóa cho thiết bị này; chỉ được mở khi hiển thị. Giữ tối đa 30 ngày.
//   peers     khóa công khai đã ghim của từng điểm nhận tin (của mình và của người kia). Ghim một lần, không bao giờ ghi đè.
//   threads   ghi chú theo hội thoại: tập khóa đã thấy, cờ «danh sách thiết bị đã đổi», tập khóa đã so mã an toàn, bản nháp.
//
// Không có bản rõ nào của tin nằm trong kho: tin đã nhận ở dạng phong bì, tin đang gửi ở dạng thân đã niêm phong, bản nháp được
// mã hóa bằng draftKey. Giới hạn nói rõ: khóa không xuất được qua API của trình duyệt, nhưng ai chiếm được hồ sơ trình duyệt đang
// mở khóa thì dùng được nó; kho khóa phần cứng thuộc app native (LNH-D20).
//
// Mọi quy tắc (ghim khóa, hạn 30 ngày, bản nháp) nằm ở lớp MsgStore và chạy trên một «backend» khóa–giá trị: idbBackend() trong
// trình duyệt, memoryBackend() trong kiểm thử Node (tests/msg-store.test.ts) và khi trình duyệt không có IndexedDB.
import { base64url } from "./jcs.js";
import { fromBase64url } from "./msg-crypto.js";
import { emptyOutbox, outboxStep } from "./msg-outbox.js";

/** Lịch sử trên thiết bị: 30 ngày kể từ lúc máy chủ nhận tin (LNH-T32). */
export const MSG_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;
const STORES = /** @type {const} */ (["kv", "messages", "peers", "threads"]);
const DB_VERSION = 1;

/** @typedef {(typeof STORES)[number]} StoreName */
/**
 * @typedef {{
 *   persistent: boolean,
 *   get(store: StoreName, key: string): Promise<any>,
 *   put(store: StoreName, key: string, value: unknown): Promise<void>,
 *   delete(store: StoreName, key: string): Promise<void>,
 *   all(store: StoreName): Promise<any[]>,
 *   clear(): Promise<void>,
 *   close(): void,
 * }} MsgBackend
 * @typedef {{ privateKey: CryptoKey, public_key: string, endpoint_id: string | null, kind: string | null, created_at: string | null }} MsgDevice
 * @typedef {{ endpoint_id: string, user_id: string, public_key: string }} MsgPin
 * @typedef {{
 *   message_id: string, thread_id: string, seq: number, sender_user: string, sender_endpoint: string, client_ref: string,
 *   iv: string, ct: string, enc: string, wrapped: string, sent_at: string,
 * }} MsgStored
 * @typedef {{
 *   thread_id: string, key_set: string | null, endpoints: MsgPin[], devices_changed: boolean, verified_key_set: string | null,
 *   draft: { iv: string, ct: string } | null,
 * }} MsgThreadNote
 */

/** Kho trong bộ nhớ: cùng giao diện với IndexedDB, mất khi đóng trang. */
export function memoryBackend() {
  /** @type {Map<string, Map<string, any>>} */
  const data = new Map(STORES.map((s) => [s, new Map()]));
  /** @param {StoreName} store */
  const of = (store) => /** @type {Map<string, any>} */ (data.get(store));
  /** @type {MsgBackend} */
  const backend = {
    persistent: false,
    get: async (store, key) => of(store).get(key),
    put: async (store, key, value) => void of(store).set(key, value),
    delete: async (store, key) => void of(store).delete(key),
    all: async (store) => [...of(store).values()],
    clear: async () => {
      for (const m of data.values()) m.clear();
    },
    close() {},
  };
  return backend;
}

/**
 * Kho IndexedDB. Mỗi lần ghi là một giao dịch `durability: "strict"` và chỉ trả về sau khi giao dịch hoàn tất: thiết bị chỉ xác
 * nhận «đã lưu» với máy chủ sau thời điểm đó.
 * @param {string} name
 * @returns {Promise<MsgBackend>}
 */
export function idbBackend(name) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      for (const s of STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("IndexedDB bị chặn bởi một tab khác"));
    open.onsuccess = () => {
      const db = open.result;
      // Một tab khác nâng phiên bản hoặc xóa kho: nhường, tab này sẽ mở lại ở lần nạp trang kế tiếp.
      db.onversionchange = () => db.close();
      /**
       * @template T
       * @param {StoreName | readonly StoreName[]} stores
       * @param {IDBTransactionMode} mode
       * @param {(tx: IDBTransaction) => IDBRequest<T> | null} run
       * @returns {Promise<T | undefined>}
       */
      const tx = (stores, mode, run) => new Promise((done, fail) => {
        const t = db.transaction(/** @type {string[]} */ ([stores].flat()), mode, { durability: mode === "readwrite" ? "strict" : "default" });
        const req = run(t);
        t.oncomplete = () => done(req ? req.result : undefined);
        t.onabort = t.onerror = () => fail(t.error ?? req?.error ?? new Error("giao dịch IndexedDB bị hủy"));
      });
      resolve({
        persistent: true,
        get: (store, key) => tx(store, "readonly", (t) => t.objectStore(store).get(key)),
        put: async (store, key, value) => void (await tx(store, "readwrite", (t) => t.objectStore(store).put(value, key))),
        delete: async (store, key) => void (await tx(store, "readwrite", (t) => t.objectStore(store).delete(key))),
        all: async (store) => (await tx(store, "readonly", (t) => t.objectStore(store).getAll())) ?? [],
        clear: async () => void (await tx(STORES, "readwrite", (t) => {
          for (const s of STORES) t.objectStore(s).clear();
          return null;
        })),
        close: () => db.close(),
      });
    };
  });
}

/** Tên cơ sở dữ liệu của một tài khoản trên thiết bị này. @param {string} sub */
export const msgDbName = (sub) => `lenhip.msg.v1.${sub}`;

/**
 * Tin đã quá hạn giữ trên thiết bị.
 * @param {{ sent_at: string }} message
 * @param {number} now mili giây theo đồng hồ máy chủ
 */
export const expired = (message, now) => !(Date.parse(message.sent_at) > now - MSG_HISTORY_MS);

/**
 * So một tập khóa máy chủ vừa trả với các khóa đã ghim. Khóa đã ghim không bao giờ bị thay: một mã điểm nhận tin xuất hiện lại
 * với khóa khác hoặc người khác là xung đột (máy chủ, hoặc ai đó giữa đường, đang tráo khóa) và không được dùng.
 * @param {ReadonlyMap<string, MsgPin>} pinned
 * @param {readonly MsgPin[]} entries
 * @returns {{ add: MsgPin[], conflicts: string[] }}
 */
export function pinDecision(pinned, entries) {
  /** @type {MsgPin[]} */
  const add = [];
  /** @type {string[]} */
  const conflicts = [];
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.endpoint_id)) {
      conflicts.push(e.endpoint_id);
      continue;
    }
    seen.add(e.endpoint_id);
    const have = pinned.get(e.endpoint_id);
    if (!have) add.push({ endpoint_id: e.endpoint_id, user_id: e.user_id, public_key: e.public_key });
    else if (have.public_key !== e.public_key || have.user_id !== e.user_id) conflicts.push(e.endpoint_id);
  }
  return { add, conflicts };
}

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });

export class MsgStore {
  /** @param {MsgBackend} backend */
  constructor(backend) {
    this.backend = backend;
    /** Thiết bị giữ được khóa qua lần nạp lại trang hay không. */
    this.persistent = backend.persistent;
    /** @type {Map<string, MsgPin>} */
    this.pins = new Map();
    /** @type {Map<string, MsgThreadNote>} */
    this.notes = new Map();
    /** @type {CryptoKey | null} */
    this.draftKey = null;
  }

  /** Nạp phần luôn cần trong bộ nhớ: khóa đã ghim và ghi chú hội thoại. */
  async load() {
    for (const p of /** @type {MsgPin[]} */ (await this.backend.all("peers"))) this.pins.set(p.endpoint_id, p);
    for (const n of /** @type {MsgThreadNote[]} */ (await this.backend.all("threads"))) this.notes.set(n.thread_id, n);
    return this;
  }

  // ── Thiết bị này ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<MsgDevice | null>} */
  async device() {
    return (await this.backend.get("kv", "device")) ?? null;
  }

  /** @param {MsgDevice} device */
  async saveDevice(device) {
    await this.backend.put("kv", "device", device);
  }

  /** Xóa mọi thứ nhắn tin của tài khoản này trên thiết bị này: khóa, lịch sử, khóa đã ghim, bản nháp, hộp gửi. */
  async wipe() {
    await this.backend.clear();
    this.pins.clear();
    this.notes.clear();
    this.draftKey = null;
  }

  // ── Khóa đã ghim ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Ghim các khóa chưa từng thấy; không ghi đè khóa đã ghim.
   * @param {readonly MsgPin[]} entries
   * @returns {Promise<{ added: string[], conflicts: string[] }>}
   */
  async pin(entries) {
    const { add, conflicts } = pinDecision(this.pins, entries);
    for (const p of add) {
      await this.backend.put("peers", p.endpoint_id, p);
      this.pins.set(p.endpoint_id, p);
    }
    return { added: add.map((p) => p.endpoint_id), conflicts };
  }

  /** @param {string} endpointId */
  pinned(endpointId) {
    return this.pins.get(endpointId) ?? null;
  }

  // ── Phong bì đã nhận ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Lưu các phong bì vừa lấy từ hộp thư, nguyên dạng đã mã hóa. Chỉ sau khi hàm này trả về thiết bị mới xác nhận với máy chủ.
   * @param {readonly MsgStored[]} messages
   */
  async putMessages(messages) {
    for (const m of messages) {
      await this.backend.put("messages", m.message_id, {
        message_id: m.message_id, thread_id: m.thread_id, seq: m.seq, sender_user: m.sender_user, sender_endpoint: m.sender_endpoint, client_ref: m.client_ref,
        iv: m.iv, ct: m.ct, enc: m.enc, wrapped: m.wrapped, sent_at: m.sent_at,
      });
    }
  }

  /** Mọi phong bì còn trong hạn, cũ trước. @param {number} now @returns {Promise<MsgStored[]>} */
  async messages(now) {
    const rows = /** @type {MsgStored[]} */ (await this.backend.all("messages"));
    return rows.filter((m) => !expired(m, now)).sort((a, b) => (a.thread_id === b.thread_id ? a.seq - b.seq : a.thread_id < b.thread_id ? -1 : 1));
  }

  /** Xóa phong bì quá 30 ngày. @param {number} now @returns {Promise<string[]>} mã các tin đã xóa */
  async prune(now) {
    const old = /** @type {MsgStored[]} */ (await this.backend.all("messages")).filter((m) => expired(m, now));
    for (const m of old) await this.backend.delete("messages", m.message_id);
    return old.map((m) => m.message_id);
  }

  // ── Ghi chú hội thoại và bản nháp ───────────────────────────────────────────────────────────────────────────────────────────

  /** @param {string} threadId @returns {MsgThreadNote} */
  note(threadId) {
    return this.notes.get(threadId) ?? { thread_id: threadId, key_set: null, endpoints: [], devices_changed: false, verified_key_set: null, draft: null };
  }

  /** @param {string} threadId @param {Partial<MsgThreadNote>} patch */
  async saveNote(threadId, patch) {
    const next = { ...this.note(threadId), ...patch, thread_id: threadId };
    this.notes.set(threadId, next);
    await this.backend.put("threads", threadId, next);
    return next;
  }

  async #key() {
    if (this.draftKey) return this.draftKey;
    let key = /** @type {CryptoKey | undefined} */ (await this.backend.get("kv", "draftKey"));
    if (!key) {
      key = /** @type {CryptoKey} */ (await globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
      await this.backend.put("kv", "draftKey", key);
    }
    this.draftKey = key;
    return key;
  }

  /** Lưu bản nháp của một hội thoại ở dạng đã mã hóa; chuỗi rỗng thì xóa. @param {string} threadId @param {string} text */
  async setDraft(threadId, text) {
    if (!text) {
      if (this.note(threadId).draft) await this.saveNote(threadId, { draft: null });
      return;
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(threadId) }, await this.#key(), te.encode(text)));
    await this.saveNote(threadId, { draft: { iv: base64url(iv), ct: base64url(ct) } });
  }

  /** Bản nháp đã lưu; không mở được (kho hỏng, khóa mất) thì coi như không có. @param {string} threadId @returns {Promise<string>} */
  async draft(threadId) {
    const d = this.note(threadId).draft;
    if (!d) return "";
    try {
      return td.decode(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(d.iv), additionalData: te.encode(threadId) }, await this.#key(), fromBase64url(d.ct)));
    } catch {
      return "";
    }
  }

  // ── Hộp gửi và lựa chọn ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Hộp gửi đã lưu. Trang vừa nạp lại nên mọi lần gửi đang chạy đã mất cùng trang cũ: chúng thành «chưa rõ đã gửi hay chưa»
   * (sự kiện resume), không bao giờ được gửi lại tự động.
   * @returns {Promise<import("./msg-outbox.js").Outbox>}
   */
  async outbox() {
    const saved = await this.backend.get("kv", "outbox");
    const outbox = saved && Array.isArray(saved.items) ? { items: saved.items } : emptyOutbox();
    return outboxStep(outbox, { type: "resume" }).outbox;
  }

  /** @param {import("./msg-outbox.js").Outbox} outbox */
  async saveOutbox(outbox) {
    await this.backend.put("kv", "outbox", { items: outbox.items });
  }

  /** @returns {Promise<{ share_read: boolean }>} */
  async settings() {
    const s = await this.backend.get("kv", "settings");
    return { share_read: s?.share_read === true };
  }

  /** @param {{ share_read: boolean }} settings */
  async saveSettings(settings) {
    await this.backend.put("kv", "settings", { share_read: settings.share_read === true });
  }
}

/**
 * Mở kho của một tài khoản. Trình duyệt không có IndexedDB (hoặc từ chối mở) thì dùng kho trong bộ nhớ và `persistent` là false:
 * giao diện phải nói rõ và không đăng ký thiết bị, vì khóa sẽ mất khi đóng trang.
 * @param {string} sub
 * @param {MsgBackend} [backend]
 */
export async function openMsgStore(sub, backend) {
  let b = backend;
  if (!b) {
    try {
      b = typeof indexedDB === "undefined" ? memoryBackend() : await idbBackend(msgDbName(sub));
    } catch {
      b = memoryBackend();
    }
  }
  return new MsgStore(b).load();
}
