// Hộp gửi trên thiết bị (LNH-T34): bảng chuyển trạng thái theo contracts/fixtures/msg/outbox.json, và các bất biến «không tự gửi
// lại, UNCERTAIN chỉ thành SENT bằng bằng chứng, khóa mới chỉ sau KEYS_CHANGED» kiểm trên chuỗi sự kiện ngẫu nhiên có hạt cố định.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalize } from "../web/shared/jcs.js";
import {
  OUTBOX_MAX_RESEALS, OUTBOX_RETRY_WINDOW_MS, OUTBOX_RETRYABLE_REFUSALS, classifyResponse, emptyOutbox, outboxCanRetry, outboxNeedsReseal, outboxRequest, outboxSendable, outboxStep,
  type Outbox, type OutboxEvent, type OutboxItem,
} from "../web/shared/msg-outbox.js";

interface Step { event: Record<string, unknown>; error: string | null; items: Record<string, unknown>[]; sendable?: string[] }
const FIXTURE = JSON.parse(readFileSync(new URL("../contracts/fixtures/msg/outbox.json", import.meta.url), "utf8")) as {
  retry_window_ms: number; max_reseals: number; bodies: Record<string, Record<string, unknown>>; scenarios: { name: string; steps: Step[] }[];
};

const DAY = 86_400_000;

test("fixture hộp gửi: từng bước cho đúng mã lỗi, trạng thái, khóa và thân; sự kiện bị từ chối không đổi gì", () => {
  assert.equal(FIXTURE.retry_window_ms, OUTBOX_RETRY_WINDOW_MS);
  assert.equal(FIXTURE.retry_window_ms, 7 * DAY);
  assert.equal(FIXTURE.max_reseals, OUTBOX_MAX_RESEALS);
  assert.ok(FIXTURE.scenarios.length >= 10);
  const seenErrors = new Set<string>();
  for (const sc of FIXTURE.scenarios) {
    let outbox = emptyOutbox();
    sc.steps.forEach((step, i) => {
      const where = `${sc.name} · bước ${i + 1}`;
      const event = { ...step.event, ...(typeof step.event.body === "string" ? { body: FIXTURE.bodies[step.event.body] } : {}) } as unknown as OutboxEvent;
      const before = JSON.stringify(outbox);
      const out = outboxStep(outbox, event);
      assert.equal(JSON.stringify(outbox), before, `${where}: đối số bị sửa`);
      assert.equal(out.error, step.error, where);
      if (step.error) {
        seenErrors.add(step.error);
        assert.equal(out.outbox, outbox, `${where}: sự kiện bị từ chối phải trả lại đúng hộp gửi cũ`);
      }
      outbox = out.outbox;
      assert.equal(outbox.items.length, step.items.length, `${where}: số mục`);
      step.items.forEach((want, n) => {
        const got = outbox.items[n] as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(want)) {
          const expected = k === "body" ? canonicalize(FIXTURE.bodies[v as string]) : v;
          assert.deepEqual(got[k], expected, `${where}: mục ${n + 1}, trường ${k}`);
        }
      });
      if (step.sendable) assert.deepEqual(outboxSendable(outbox).map((x) => x.client_ref), step.sendable, `${where}: sendable`);
    });
  }
  for (const e of ["NOT_QUEUED", "NOT_SENDING", "NOT_RETRYABLE", "TOO_OLD", "HELD", "NEEDS_RESEAL", "NOT_RESEALABLE", "KEY_REUSED", "KEY_INVALID", "REF_MISMATCH", "DUPLICATE_REF", "UNKNOWN_REF", "BUSY"]) {
    assert.ok(seenErrors.has(e), `fixture chưa có ca cho lỗi ${e}`);
  }
});

test("phân loại phản hồi: chỉ 2xx và DUPLICATE_MESSAGE là đã lưu; 5xx, REQUEST_IN_PROGRESS và phản hồi lạ là chưa rõ, không phải lỗi", () => {
  assert.equal(classifyResponse(201, undefined), "STORED");
  assert.equal(classifyResponse(200, undefined), "STORED");
  assert.equal(classifyResponse(409, "DUPLICATE_MESSAGE"), "STORED");
  assert.equal(classifyResponse(409, "KEYS_CHANGED"), "KEYS_CHANGED");
  for (const [status, c] of [[400, "SCHEMA_INVALID"], [401, "UNAUTHENTICATED"], [403, "FORBIDDEN"], [403, "CONSENT_REQUIRED"], [404, "NOT_FOUND"], [409, "RECIPIENT_UNAVAILABLE"], [409, "IDEMPOTENCY_CONFLICT"], [413, "BODY_TOO_LARGE"], [429, "RATE_LIMITED"]] as const) {
    assert.equal(classifyResponse(status, c), "REFUSED", `${status} ${c}`);
  }
  for (const [status, c] of [[500, "INTERNAL"], [502, undefined], [503, "MODULE_DISABLED"], [504, undefined], [409, "REQUEST_IN_PROGRESS"], [410, "IDEMPOTENCY_EXPIRED"], [0, undefined], [302, undefined], [101, undefined], [Number.NaN, undefined], [200.5, undefined]] as const) {
    assert.equal(classifyResponse(status, c), "UNKNOWN", `${status} ${c}`);
  }
  assert.deepEqual([...OUTBOX_RETRYABLE_REFUSALS], ["RATE_LIMITED", "UNAUTHENTICATED", "RECIPIENT_UNAVAILABLE"]);
});

const body = (ref: string, n = 1) => ({ client_ref: ref, sender_endpoint: "mep_a", key_set: `KS${n}`, iv: `IV${n}`, ct: `CT${n}`, envelopes: [{ endpoint_id: "mep_a", enc: "E", wrapped: "W" }] });
const keyOf = (n: number) => `key-${String(n).padStart(24, "0")}`;
const apply = (o: Outbox, e: OutboxEvent) => outboxStep(o, e).outbox;
const only = (o: Outbox): OutboxItem => {
  assert.equal(o.items.length, 1);
  return o.items[0];
};

test("yêu cầu của một mục: cùng đường dẫn, cùng khóa, cùng byte ở mọi lần thử; thân không phụ thuộc thứ tự khóa của đối tượng đầu vào", () => {
  const ref = "ref-0000000000000000000001";
  let o = apply(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "th_1", idem_key: keyOf(1), body: body(ref), at: 0 });
  const first = outboxRequest(only(o));
  assert.equal(first.path, "/v1/messages/threads/th_1/messages");
  assert.equal(first.key, keyOf(1));
  assert.deepEqual(first.body, body(ref));
  o = apply(o, { type: "attempt", client_ref: ref });
  o = apply(o, { type: "lost", client_ref: ref });
  assert.equal(outboxCanRetry(o, ref, 5 * DAY), true);
  assert.equal(outboxCanRetry(o, ref, 7 * DAY), true);
  assert.equal(outboxCanRetry(o, ref, 7 * DAY + 1), false);
  assert.equal(outboxCanRetry(o, "ref-khac", 0), false);
  o = apply(o, { type: "retry", client_ref: ref, at: 5 * DAY });
  const second = outboxRequest(only(o));
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second.body), JSON.stringify(first.body), "đúng các byte cũ");
  // Thân được giữ ở dạng chuẩn nên hai đối tượng cùng nội dung, khác thứ tự khóa, là một.
  const b = body(ref);
  const reordered = Object.fromEntries(Object.entries(b).reverse());
  const o2 = apply(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "th_1", idem_key: keyOf(1), body: reordered, at: 0 });
  assert.equal(only(o2).body, only(apply(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "th_1", idem_key: keyOf(1), body: b, at: 0 })).body);
  // Thân của tin khác, thân không phải đối tượng, khóa sai dạng: không vào được hộp gửi.
  assert.equal(outboxStep(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "th_1", idem_key: keyOf(1), body: body("ref-khac"), at: 0 }).error, "REF_MISMATCH");
  assert.equal(outboxStep(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "th_1", idem_key: keyOf(1), body: [] as never, at: 0 }).error, "REF_MISMATCH");
  assert.equal(outboxStep(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "th_1", idem_key: "ngắn", body: body(ref), at: 0 }).error, "KEY_INVALID");
  assert.equal(outboxStep(emptyOutbox(), { type: "enqueue", client_ref: ref, thread_id: "", idem_key: keyOf(1), body: body(ref), at: 0 }).error, "BAD_EVENT");
  assert.equal(outboxStep(emptyOutbox(), { type: "bay" } as never).error, "BAD_EVENT");
  assert.equal(outboxStep(emptyOutbox(), null as never).error, "BAD_EVENT");
  assert.equal(outboxStep(o, { type: "retry", client_ref: ref, at: Number.NaN }).error, "NOT_RETRYABLE", "đang SENDING");
});

test("người dùng thử lại sau lời từ chối tạm thời: RECIPIENT_UNAVAILABLE và 401 thử lại được, 404 thì không; tin đang giữ chỗ không cho tin sau vượt", () => {
  const r1 = "ref-0000000000000000000001";
  const r2 = "ref-0000000000000000000002";
  let o = apply(emptyOutbox(), { type: "enqueue", client_ref: r1, thread_id: "th_1", idem_key: keyOf(1), body: body(r1), at: 0 });
  o = apply(o, { type: "enqueue", client_ref: r2, thread_id: "th_1", idem_key: keyOf(2), body: body(r2), at: 1 });
  o = apply(o, { type: "attempt", client_ref: r1 });
  o = apply(o, { type: "response", client_ref: r1, status: 409, code: "RECIPIENT_UNAVAILABLE" });
  assert.equal(o.items[0].state, "REJECTED");
  assert.equal(o.items[0].refusal?.retryable, true);
  // Tin trước đã bị từ chối dứt khoát nên không còn giữ tin sau.
  assert.deepEqual(outboxSendable(o).map((x) => x.client_ref), [r2]);
  o = apply(o, { type: "attempt", client_ref: r2 });
  o = apply(o, { type: "lost", client_ref: r2 });
  assert.equal(outboxCanRetry(o, r1, 10), true);
  assert.equal(outboxCanRetry(o, r2, 10), true);
  o = apply(o, { type: "retry", client_ref: r1, at: 10 });
  assert.equal(o.items[0].state, "SENDING");
  o = apply(o, { type: "response", client_ref: r1, status: 401, code: "UNAUTHENTICATED" });
  assert.equal(o.items[0].refusal?.retryable, true);
  o = apply(o, { type: "retry", client_ref: r1, at: 20 });
  o = apply(o, { type: "response", client_ref: r1, status: 404, code: "NOT_FOUND" });
  assert.deepEqual(o.items[0].refusal, { status: 404, code: "NOT_FOUND", retryable: false });
  assert.equal(outboxCanRetry(o, r1, 30), false);
  // Phản hồi 4xx không có mã: vẫn là từ chối dứt khoát, mã ghi theo trạng thái HTTP.
  const o3 = apply(apply(apply(emptyOutbox(), { type: "enqueue", client_ref: r1, thread_id: "th_1", idem_key: keyOf(1), body: body(r1), at: 0 }), { type: "attempt", client_ref: r1 }), { type: "response", client_ref: r1, status: 418 });
  assert.deepEqual(only(o3).refusal, { status: 418, code: "HTTP_418", retryable: false });
  // Chờ niêm phong lại cũng giữ chỗ.
  let o4 = apply(emptyOutbox(), { type: "enqueue", client_ref: r1, thread_id: "th_1", idem_key: keyOf(1), body: body(r1), at: 0 });
  o4 = apply(o4, { type: "enqueue", client_ref: r2, thread_id: "th_1", idem_key: keyOf(2), body: body(r2), at: 1 });
  o4 = apply(o4, { type: "attempt", client_ref: r1 });
  o4 = apply(o4, { type: "response", client_ref: r1, status: 409, code: "KEYS_CHANGED" });
  assert.deepEqual(outboxNeedsReseal(o4).map((x) => x.client_ref), [r1]);
  assert.deepEqual(outboxSendable(o4), []);
  assert.equal(outboxStep(o4, { type: "attempt", client_ref: r2 }).error, "HELD");
});

/** Bộ sinh số giả ngẫu nhiên có hạt (mulberry32): chuỗi sự kiện lặp lại được ở mọi lần chạy. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("bất biến trên 400 chuỗi sự kiện ngẫu nhiên: không POST nào tự phát sinh sau UNCERTAIN, khóa và thân chỉ đổi bằng reseal sau KEYS_CHANGED, client_ref không đổi", () => {
  const refs = ["ref-0000000000000000000001", "ref-0000000000000000000002", "ref-0000000000000000000003"];
  const threads = ["th_1", "th_1", "th_2"];
  const responses: [number, string | undefined][] = [[201, undefined], [409, "DUPLICATE_MESSAGE"], [409, "KEYS_CHANGED"], [409, "REQUEST_IN_PROGRESS"], [429, "RATE_LIMITED"], [403, "FORBIDDEN"], [500, "INTERNAL"], [503, undefined], [404, "NOT_FOUND"]];
  const walked = new Set<string>();
  for (let seed = 1; seed <= 400; seed++) {
    const rand = rng(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    let outbox = emptyOutbox();
    let now = 0;
    let keys = 0;
    /** Lời từ chối KEYS_CHANGED gần nhất chưa được niêm phong lại, theo client_ref. */
    const keysChanged = new Set<string>();
    /** Mỗi (client_ref, khóa) đã được gửi tự động bao nhiêu lần. */
    const automatic = new Map<string, number>();
    for (let step = 0; step < 60; step++) {
      // Phần lớn các bước cách nhau vài giờ; thỉnh thoảng nhảy nhiều ngày để chạm hạn 7 ngày.
      now += Math.floor(rand() * (rand() < 0.1 ? 4 * DAY : DAY / 8));
      const ref = pick(refs);
      const kind = pick(["enqueue", "attempt", "attempt", "response", "response", "lost", "resume", "retry", "evidence", "reseal", "discard", "time"] as const);
      let event: OutboxEvent | null = null;
      if (kind === "enqueue") event = { type: "enqueue", client_ref: ref, thread_id: threads[refs.indexOf(ref)], idem_key: keyOf(++keys), body: body(ref, keys), at: now };
      else if (kind === "attempt") event = { type: "attempt", client_ref: ref };
      else if (kind === "response") {
        const [status, c] = pick(responses);
        event = { type: "response", client_ref: ref, status, code: c, message_id: "msg_1", seq: 1, sent_at: "2026-11-11T02:00:00.000Z", resource_id: "msg_1" };
      } else if (kind === "lost") event = { type: "lost", client_ref: ref };
      else if (kind === "resume") event = { type: "resume" };
      else if (kind === "retry") event = { type: "retry", client_ref: ref, at: now };
      else if (kind === "evidence") event = { type: "evidence", client_ref: ref, message_id: "msg_1" };
      else if (kind === "reseal") event = { type: "reseal", client_ref: ref, idem_key: keyOf(++keys), body: body(ref, keys) };
      else if (kind === "discard") event = { type: "discard", client_ref: ref };
      if (!event) continue; // «time»: chỉ thời gian trôi, không có sự kiện nào; trạng thái không thể đổi vì không ai gọi bộ rút gọn

      const prev = new Map(outbox.items.map((x) => [x.client_ref, x]));
      const out = outboxStep(outbox, event);
      outbox = out.outbox;
      const where = `hạt ${seed}, bước ${step}, ${event.type}`;
      for (const item of outbox.items) {
        const was = prev.get(item.client_ref);
        assert.ok(item.used_keys.includes(item.idem_key), where);
        assert.equal(new Set(item.used_keys).size, item.used_keys.length, `${where}: một khóa không bao giờ được dùng lại cho thân khác`);
        assert.equal(JSON.parse(item.body).client_ref, item.client_ref, `${where}: client_ref của thân`);
        if (!was || was === item) continue;
        walked.add(`${was.state}>${item.state}:${event.type}`);
        const changedRequest = was.idem_key !== item.idem_key || was.body !== item.body;
        if (changedRequest) {
          assert.equal(event.type, "reseal", `${where}: khóa hoặc thân đổi ngoài reseal`);
          assert.ok(keysChanged.has(item.client_ref), `${where}: reseal mà không có KEYS_CHANGED trước đó`);
          assert.equal(was.state, "QUEUED", where);
          assert.notEqual(was.idem_key, item.idem_key, `${where}: thân mới phải đi cùng khóa mới`);
        }
        if (was.state === "UNCERTAIN" && item.state !== "UNCERTAIN") {
          assert.ok((item.state === "SENT" && event.type === "evidence") || (item.state === "SENDING" && event.type === "retry"), `${where}: UNCERTAIN → ${item.state} bằng ${event.type}`);
          if (event.type === "retry") assert.ok(now - item.created_at <= 7 * DAY, `${where}: thử lại quá 7 ngày`);
        }
        if (item.state === "SENT" && was.state !== "SENT") {
          assert.ok(event.type === "evidence" || (event.type === "response" && was.state === "SENDING" && classifyResponse(event.status, event.code) === "STORED"), `${where}: SENT không có bằng chứng`);
          assert.ok(item.evidence, where);
        }
        if (item.state === "SENDING" && was.state !== "SENDING") {
          assert.ok(event.type === "attempt" || event.type === "retry", where);
          if (event.type === "attempt") {
            const k = `${item.client_ref}|${item.idem_key}`;
            automatic.set(k, (automatic.get(k) ?? 0) + 1);
            assert.equal(automatic.get(k), 1, `${where}: gửi tự động hai lần với cùng một khóa`);
            assert.equal(was.state, "QUEUED", where);
          }
        }
        if (item.state === "REJECTED" && was.state !== "REJECTED") assert.ok(event.type === "response" && was.state === "SENDING", `${where}: REJECTED chỉ từ một phản hồi`);
      }
      if (out.error === null && event.type === "response" && event.status === 409 && event.code === "KEYS_CHANGED") keysChanged.add(event.client_ref);
      if (out.error === null && (event.type === "reseal" || event.type === "discard")) keysChanged.delete(event.client_ref);
      // Trong một hội thoại không bao giờ có hai tin cùng đang gửi.
      for (const th of new Set(threads)) assert.ok(outbox.items.filter((x) => x.thread_id === th && x.state === "SENDING").length <= 1, `${where}: hai tin cùng gửi trong ${th}`);
    }
  }
  // Chuỗi ngẫu nhiên phải thật sự đi qua mọi cạnh của bảng, nếu không các bất biến ở trên chưa được thử.
  for (const edge of [
    "QUEUED>SENDING:attempt", "SENDING>SENT:response", "SENDING>UNCERTAIN:lost", "SENDING>UNCERTAIN:response", "SENDING>UNCERTAIN:resume", "SENDING>REJECTED:response",
    "SENDING>QUEUED:response", "QUEUED>QUEUED:reseal", "UNCERTAIN>SENDING:retry", "UNCERTAIN>SENT:evidence", "REJECTED>SENDING:retry", "REJECTED>SENT:evidence", "QUEUED>SENT:evidence",
  ]) assert.ok(walked.has(edge), `chưa đi qua cạnh ${edge}`);
  assert.deepEqual([...walked].filter((e) => e.startsWith("UNCERTAIN>")).sort(), ["UNCERTAIN>SENDING:retry", "UNCERTAIN>SENT:evidence"], "từ UNCERTAIN chỉ có hai lối ra");
});
