// @ts-check
// Hộp gửi tin nhắn trên thiết bị (LNH-T34): một bộ rút gọn thuần (không I/O, không đồng hồ, không ngẫu nhiên), để giao diện, kho
// IndexedDB và kiểm thử dùng chung một bảng chuyển trạng thái. Trạng thái này chỉ sống trên thiết bị nên không nằm trong
// contracts/state_transitions.csv; hợp đồng của nó là contracts/fixtures/msg/outbox.json.
//
//   QUEUED ──attempt──▶ SENDING ──response──▶ SENT | REJECTED | UNCERTAIN | QUEUED (cần niêm phong lại)
//
// Quy tắc không được phá:
//   1. Một tin = một client_ref. Thân yêu cầu được niêm phong MỘT lần và lưu cùng Idempotency-Key trước lần thử đầu.
//   2. Không tự gửi lại. `attempt` (tự động) chỉ chạy một lần cho mỗi khóa. Sau khi mất phản hồi, tin ở UNCERTAIN cho tới khi có
//      bằng chứng; thời gian trôi qua không đổi gì (UNCERTAIN không bao giờ tự thành REJECTED).
//   3. UNCERTAIN → SENT chỉ bằng bằng chứng: tin trở về trong hộp thư của chính thiết bị này (`evidence`), hoặc người dùng bấm
//      thử lại (`retry`) và đúng khóa cũ với đúng các byte cũ được trả 201 hoặc DUPLICATE_MESSAGE.
//   4. Khóa mới chỉ sau một lời từ chối dứt khoát KEYS_CHANGED (`reseal`), giữ nguyên client_ref; không có đường nào từ
//      UNCERTAIN tới một khóa mới.
//   5. Quá 7 ngày kể từ lúc tạo thì không thử lại được nữa (máy chủ chỉ giữ dấu chống lặp 30 ngày); tin vẫn ở UNCERTAIN.
//   6. Trong một hội thoại, tin sau chờ tin trước có kết quả, để thứ tự không đảo.

import { canonicalize } from "./jcs.js";

export const OUTBOX_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Số lần niêm phong lại liên tiếp tối đa của một tin; quá số này tin thành REJECTED thay vì quay vòng mãi. */
export const OUTBOX_MAX_RESEALS = 3;

/** Lời từ chối dứt khoát (chắc chắn chưa lưu) mà người dùng có thể bấm thử lại với đúng khóa và đúng byte cũ. */
export const OUTBOX_RETRYABLE_REFUSALS = Object.freeze(["RATE_LIMITED", "UNAUTHENTICATED", "RECIPIENT_UNAVAILABLE"]);

const KEY_RE = /^[A-Za-z0-9_-]{22,128}$/;

/**
 * @typedef {"QUEUED" | "SENDING" | "SENT" | "REJECTED" | "UNCERTAIN"} OutboxState
 * @typedef {{
 *   client_ref: string,
 *   thread_id: string,
 *   state: OutboxState,
 *   idem_key: string,
 *   body: string,
 *   created_at: number,
 *   attempts: number,
 *   reseals: number,
 *   used_keys: string[],
 *   needs_reseal: boolean,
 *   message_id: string | null,
 *   seq: number | null,
 *   sent_at: string | null,
 *   evidence: null | "RECEIPT" | "DUPLICATE" | "INBOX",
 *   refusal: null | { status: number, code: string, retryable: boolean },
 * }} OutboxItem
 *   `body` là dạng JCS của thân yêu cầu: đúng các byte được gửi ở mọi lần thử với `idem_key` này.
 * @typedef {{ items: OutboxItem[] }} Outbox
 * @typedef {
 *   | { type: "enqueue", client_ref: string, thread_id: string, idem_key: string, body: Record<string, unknown>, at: number }
 *   | { type: "attempt", client_ref: string }
 *   | { type: "response", client_ref: string, status: number, code?: string, message_id?: string, seq?: number, sent_at?: string, resource_id?: string }
 *   | { type: "lost", client_ref: string }
 *   | { type: "resume" }
 *   | { type: "retry", client_ref: string, at: number }
 *   | { type: "evidence", client_ref: string, message_id: string, seq?: number, sent_at?: string }
 *   | { type: "reseal", client_ref: string, idem_key: string, body: Record<string, unknown> }
 *   | { type: "discard", client_ref: string }
 * } OutboxEvent
 *   attempt: lần gửi đầu, tự động. response/lost: kết quả của lần gửi đang chạy. resume: sau khi nạp lại trang. retry và discard:
 *   chỉ khi người dùng bấm. evidence: hộp thư của chính thiết bị này trả về tin có sender_endpoint của nó và client_ref này.
 */

/** @returns {Outbox} */
export function emptyOutbox() {
  return { items: [] };
}

/**
 * Phân loại một phản hồi HTTP của lần gửi.
 *   STORED          máy chủ đã lưu (2xx, hoặc DUPLICATE_MESSAGE: client_ref này đã được lưu từ trước)
 *   KEYS_CHANGED    chắc chắn chưa lưu; phải niêm phong lại cho tập khóa mới
 *   REFUSED         chắc chắn chưa lưu
 *   UNKNOWN         không kết luận được (5xx, REQUEST_IN_PROGRESS, IDEMPOTENCY_EXPIRED, mã lạ ngoài 2xx/4xx)
 * @param {number} status
 * @param {string | undefined} code
 * @returns {"STORED" | "KEYS_CHANGED" | "REFUSED" | "UNKNOWN"}
 */
export function classifyResponse(status, code) {
  if (!Number.isInteger(status)) return "UNKNOWN";
  if (status >= 200 && status < 300) return "STORED";
  if (status === 409 && code === "DUPLICATE_MESSAGE") return "STORED";
  if (status === 409 && code === "KEYS_CHANGED") return "KEYS_CHANGED";
  if (status === 409 && code === "REQUEST_IN_PROGRESS") return "UNKNOWN";
  if (status === 410) return "UNKNOWN";
  if (status >= 400 && status < 500) return "REFUSED";
  return "UNKNOWN";
}

/**
 * @param {unknown} body
 * @param {string} clientRef
 * @returns {string | null} dạng JCS, hoặc null nếu thân không phải của tin này
 */
function sealedBody(body, clientRef) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  if (/** @type {Record<string, unknown>} */ (body).client_ref !== clientRef) return null;
  try {
    return canonicalize(body);
  } catch {
    return null;
  }
}

/**
 * Mục đứng trước `item` trong cùng hội thoại mà chưa có kết quả: tin sau phải chờ nó.
 * @param {Outbox} outbox
 * @param {OutboxItem} item
 */
function heldBy(outbox, item) {
  for (const other of outbox.items) {
    if (other === item) return null;
    if (other.thread_id === item.thread_id && (other.state === "QUEUED" || other.state === "SENDING" || other.state === "UNCERTAIN")) return other;
  }
  return null;
}

/**
 * @param {OutboxItem} item
 * @param {number} now
 */
const withinWindow = (item, now) => now - item.created_at <= OUTBOX_RETRY_WINDOW_MS;

/**
 * Áp một sự kiện. Không bao giờ ném lỗi và không sửa đối số: sự kiện không hợp lệ trả lại đúng hộp gửi cũ kèm mã lỗi.
 * @param {Outbox} outbox
 * @param {OutboxEvent} event
 * @returns {{ outbox: Outbox, error: null | string }}
 */
export function outboxStep(outbox, event) {
  /** @param {string} error */
  const refuse = (error) => ({ outbox, error });
  /**
   * @param {OutboxItem} item
   * @param {Partial<OutboxItem>} patch
   */
  const update = (item, patch) => ({ outbox: { items: outbox.items.map((x) => (x === item ? { ...x, ...patch } : x)) }, error: null });
  if (typeof event !== "object" || event === null) return refuse("BAD_EVENT");

  if (event.type === "resume") {
    // Trang vừa nạp lại: lần gửi đang chạy đã mất cùng trang cũ, không ai còn chờ phản hồi của nó.
    if (!outbox.items.some((x) => x.state === "SENDING")) return { outbox, error: null };
    return { outbox: { items: outbox.items.map((x) => (x.state === "SENDING" ? { ...x, state: /** @type {OutboxState} */ ("UNCERTAIN") } : x)) }, error: null };
  }

  if (typeof event.client_ref !== "string" || !event.client_ref) return refuse("BAD_EVENT");
  const item = outbox.items.find((x) => x.client_ref === event.client_ref);

  if (event.type === "enqueue") {
    if (item) return refuse("DUPLICATE_REF");
    if (typeof event.thread_id !== "string" || !event.thread_id || !Number.isFinite(event.at)) return refuse("BAD_EVENT");
    if (typeof event.idem_key !== "string" || !KEY_RE.test(event.idem_key)) return refuse("KEY_INVALID");
    const body = sealedBody(event.body, event.client_ref);
    if (body === null) return refuse("REF_MISMATCH");
    /** @type {OutboxItem} */
    const created = {
      client_ref: event.client_ref, thread_id: event.thread_id, state: "QUEUED", idem_key: event.idem_key, body, created_at: event.at, attempts: 0, reseals: 0,
      used_keys: [event.idem_key], needs_reseal: false, message_id: null, seq: null, sent_at: null, evidence: null, refusal: null,
    };
    return { outbox: { items: [...outbox.items, created] }, error: null };
  }

  if (!item) return refuse("UNKNOWN_REF");

  switch (event.type) {
    case "attempt": {
      if (item.state !== "QUEUED") return refuse("NOT_QUEUED");
      if (item.needs_reseal) return refuse("NEEDS_RESEAL");
      if (heldBy(outbox, item)) return refuse("HELD");
      return update(item, { state: "SENDING", attempts: item.attempts + 1 });
    }
    case "response": {
      if (item.state !== "SENDING") return refuse("NOT_SENDING");
      const kind = classifyResponse(event.status, event.code);
      if (kind === "STORED") {
        const duplicate = event.status === 409;
        return update(item, {
          state: "SENT", evidence: duplicate ? "DUPLICATE" : "RECEIPT", refusal: null,
          message_id: (duplicate ? event.resource_id : event.message_id) ?? null, seq: duplicate ? null : event.seq ?? null, sent_at: duplicate ? null : event.sent_at ?? null,
        });
      }
      if (kind === "KEYS_CHANGED") {
        if (item.reseals >= OUTBOX_MAX_RESEALS) return update(item, { state: "REJECTED", refusal: { status: 409, code: "KEYS_CHANGED", retryable: false } });
        return update(item, { state: "QUEUED", needs_reseal: true });
      }
      if (kind === "REFUSED") {
        const code = typeof event.code === "string" && event.code ? event.code : `HTTP_${event.status}`;
        return update(item, { state: "REJECTED", refusal: { status: event.status, code, retryable: OUTBOX_RETRYABLE_REFUSALS.includes(code) } });
      }
      return update(item, { state: "UNCERTAIN" });
    }
    case "lost": {
      if (item.state !== "SENDING") return refuse("NOT_SENDING");
      return update(item, { state: "UNCERTAIN" });
    }
    case "retry": {
      const retryable = item.state === "UNCERTAIN" || (item.state === "REJECTED" && item.refusal?.retryable === true);
      if (!retryable) return refuse("NOT_RETRYABLE");
      if (!Number.isFinite(event.at)) return refuse("BAD_EVENT");
      if (!withinWindow(item, event.at)) return refuse("TOO_OLD");
      if (heldBy(outbox, item)) return refuse("HELD");
      // Đúng khóa cũ, đúng các byte cũ: máy chủ phát lại bản đã lưu hoặc lưu đúng một lần.
      return update(item, { state: "SENDING", attempts: item.attempts + 1, refusal: null });
    }
    case "evidence": {
      if (typeof event.message_id !== "string" || !event.message_id) return refuse("BAD_EVENT");
      if (item.state === "SENT") return update(item, { message_id: item.message_id ?? event.message_id, seq: item.seq ?? event.seq ?? null, sent_at: item.sent_at ?? event.sent_at ?? null });
      // Bằng chứng thắng mọi trạng thái khác: tin đã nằm ở máy chủ.
      return update(item, { state: "SENT", evidence: "INBOX", needs_reseal: false, refusal: null, message_id: event.message_id, seq: event.seq ?? null, sent_at: event.sent_at ?? null });
    }
    case "reseal": {
      if (item.state !== "QUEUED" || !item.needs_reseal) return refuse("NOT_RESEALABLE");
      if (typeof event.idem_key !== "string" || !KEY_RE.test(event.idem_key)) return refuse("KEY_INVALID");
      if (item.used_keys.includes(event.idem_key)) return refuse("KEY_REUSED");
      const body = sealedBody(event.body, item.client_ref);
      if (body === null) return refuse("REF_MISMATCH");
      return update(item, { idem_key: event.idem_key, body, needs_reseal: false, reseals: item.reseals + 1, used_keys: [...item.used_keys, event.idem_key] });
    }
    case "discard": {
      if (item.state === "SENDING") return refuse("BUSY");
      return { outbox: { items: outbox.items.filter((x) => x !== item) }, error: null };
    }
    default:
      return refuse("BAD_EVENT");
  }
}

/**
 * Các tin được phép gửi lần đầu ngay bây giờ: nhiều nhất một tin cho mỗi hội thoại, theo thứ tự xếp hàng.
 * @param {Outbox} outbox
 * @returns {OutboxItem[]}
 */
export function outboxSendable(outbox) {
  return outbox.items.filter((x) => x.state === "QUEUED" && !x.needs_reseal && !heldBy(outbox, x));
}

/**
 * Các tin đang chờ thiết bị niêm phong lại sau KEYS_CHANGED.
 * @param {Outbox} outbox
 * @returns {OutboxItem[]}
 */
export function outboxNeedsReseal(outbox) {
  return outbox.items.filter((x) => x.state === "QUEUED" && x.needs_reseal);
}

/**
 * Người dùng có thể bấm thử lại tin này lúc `now` hay không.
 * @param {Outbox} outbox
 * @param {string} clientRef
 * @param {number} now
 */
export function outboxCanRetry(outbox, clientRef, now) {
  const item = outbox.items.find((x) => x.client_ref === clientRef);
  if (!item) return false;
  const retryable = item.state === "UNCERTAIN" || (item.state === "REJECTED" && item.refusal?.retryable === true);
  return retryable && withinWindow(item, now) && !heldBy(outbox, item);
}

/**
 * Yêu cầu HTTP của một mục: cùng đường dẫn, cùng khóa và cùng thân ở mọi lần thử cho tới khi niêm phong lại.
 * @param {OutboxItem} item
 * @returns {{ path: string, key: string, body: Record<string, unknown> }}
 */
export function outboxRequest(item) {
  return { path: `/v1/messages/threads/${item.thread_id}/messages`, key: item.idem_key, body: JSON.parse(item.body) };
}
