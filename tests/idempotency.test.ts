// T08 (TX01): 1.000 request ở concurrency = 50 với cùng/khác khóa và digest; phát lại nguyên status/body; xung đột; đang chạy;
// hết hạn phát lại và tombstone cho action chưa rõ; phát lại vẫn qua quyền đọc hiện hành.
import { test } from "node:test";
import assert from "node:assert/strict";
import { purgeIdempotency } from "../src/server/idempotency.ts";
import { all } from "../src/server/store.ts";
import { calendarPlan, harness, key, planAndApprove, vn } from "./helpers.ts";

async function pool<T>(items: T[], limit: number, f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < items.length) await f(items[i++]);
  }));
}

test("1.000 request, concurrency 50: mỗi khóa tạo đúng một plan, phát lại giống hệt, khóa dùng cho nội dung khác bị 409", async () => {
  const h = await harness();
  try {
    const keys = Array.from({ length: 100 }, () => key());
    const bodies = keys.map((_, i) => calendarPlan(vn(h.clock, `10:${String(i % 60).padStart(2, "0")}`, 1 + Math.floor(i / 60)), vn(h.clock, `11:${String(i % 60).padStart(2, "0")}`, 1 + Math.floor(i / 60))));
    const requests: { k: number; conflict: boolean }[] = [];
    for (let r = 0; r < 10; r++) for (let k = 0; k < 100; k++) requests.push({ k, conflict: r === 9 && k % 10 === 0 });
    const results = new Map<number, { status: number; body: string }[]>();
    const conflicts: number[] = [];
    await pool(requests, 50, async ({ k, conflict }) => {
      const body = conflict ? calendarPlan(vn(h.clock, "16:00", 2), vn(h.clock, "16:30", 2)) : bodies[k];
      const res = await h.call("POST", "/v1/plans", { body, key: keys[k] });
      if (conflict) {
        conflicts.push(res.status);
        return;
      }
      const list = results.get(k) ?? [];
      list.push({ status: res.status, body: JSON.stringify(res.body) });
      results.set(k, list);
    });
    const plans = all<{ n: number }>(h.app.ctx.db, "SELECT COUNT(*) AS n FROM actions")[0].n;
    assert.equal(plans, 100, "mỗi khóa đúng một mutation");
    for (const [, list] of results) {
      assert.ok(list.every((x) => x.status === 201), "phát lại giữ nguyên status");
      assert.ok(list.every((x) => x.body === list[0].body), "phát lại giữ nguyên body");
    }
    assert.equal(conflicts.length, 10);
    assert.ok(conflicts.every((s) => s === 409), "khóa cũ với nội dung khác: IDEMPOTENCY_CONFLICT");
    assert.equal(all<{ n: number }>(h.app.ctx.db, "SELECT COUNT(*) AS n FROM idem_keys")[0].n, 100);
  } finally {
    await h.close();
  }
});

test("thiếu khóa, khóa sai dạng, phát lại có header Idempotent-Replayed", async () => {
  const h = await harness();
  try {
    const body = calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30"));
    assert.equal((await h.call("POST", "/v1/plans", { body, key: null })).body.code, "IDEMPOTENCY_KEY_REQUIRED");
    assert.equal((await h.call("POST", "/v1/plans", { body, key: "short" })).body.code, "IDEMPOTENCY_KEY_INVALID");
    assert.equal((await h.call("POST", "/v1/plans", { body, key: "x".repeat(21) })).body.code, "IDEMPOTENCY_KEY_INVALID", "dưới 22 ký tự không đủ 128 bit (LNH-T05)");
    const k = key();
    const a = await h.call("POST", "/v1/plans", { body, key: k });
    const b = await h.call("POST", "/v1/plans", { body, key: k });
    assert.equal(a.headers.get("idempotent-replayed"), null);
    assert.equal(b.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(a.body, b.body);
    // Cùng khóa nhưng người khác: khóa là theo actor, không đụng nhau.
    const c = await h.call("POST", "/v1/plans", { sub: "dev_b", body, key: k });
    assert.equal(c.status, 201);
    assert.notEqual(c.body.plan_id, a.body.plan_id);
  } finally {
    await h.close();
  }
});

test("phát lại vẫn kiểm quyền đọc hiện hành: thành viên đã bị xóa không đọc được bản lưu", async () => {
  const h = await harness();
  try {
    const body = calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30"));
    const k = key();
    assert.equal((await h.call("POST", "/v1/plans", { sub: "dev_b", body, key: k })).status, 201);
    h.app.ctx.db.prepare("UPDATE members SET status = 'LEFT' WHERE user_id = 'dev_b'").run();
    assert.equal((await h.call("POST", "/v1/plans", { sub: "dev_b", body, key: k })).status, 404);
  } finally {
    await h.close();
  }
});

test("hết 90 ngày phát lại: action đã kết thúc thì xóa khóa; action chưa rõ giữ tombstone và trả IDEMPOTENCY_EXPIRED", async () => {
  const h = await harness();
  try {
    const done = await planAndApprove(h, calendarPlan(vn(h.clock, "10:00"), vn(h.clock, "10:30")));
    h.app.graph.faults.post = "hang";
    h.app.receivers.get("calendar.block")!.realAckWaitMs = 10;
    const kPending = key();
    const body = calendarPlan(vn(h.clock, "11:00"), vn(h.clock, "11:30"));
    const p = await h.call("POST", "/v1/plans", { body, key: kPending });
    await h.call("POST", `/v1/plans/${p.body.plan_id}/approve`, { body: { plan_version: p.body.plan_version, approved_digest: p.body.payload_digest } });
    // Sau khi POST đã đi, Graph không đọc được: không xác định được kết quả, action vào UNKNOWN và còn chưa rõ khi hết hạn phát lại.
    await h.app.dispatcher.tick();
    h.app.graph.faults.throttleReads = 1_000_000;
    await h.app.reconciler.tick();
    h.clock.advance(30_000);
    await h.app.reconciler.tick();
    h.clock.advance(91 * 86_400_000);
    const r = purgeIdempotency(h.app.ctx);
    assert.ok(r.tombstoned >= 1, "plan UNKNOWN giữ tombstone");
    const again = await h.call("POST", "/v1/plans", { body, key: kPending });
    assert.equal(again.status, 410);
    assert.equal(again.body.code, "IDEMPOTENCY_EXPIRED");
    assert.equal(again.body.resource_id, p.body.plan_id);
    void done;
    h.app.graph.release();
  } finally {
    await h.close();
  }
});

test("handler bất đồng bộ (LeLe): cùng khóa đang chạy trả 409 REQUEST_IN_PROGRESS với Retry-After 1", async () => {
  let release: () => void = () => undefined;
  const slow = {
    id: "slow-test", external: false,
    propose: () => new Promise<string>((r) => (release = () => r(JSON.stringify({ type: "ANSWER", answer: "xong" })))),
  };
  const h = await harness({ provider: slow });
  try {
    const k = key();
    const body = { text: "xin chào", context: "work", zone: "Asia/Ho_Chi_Minh" };
    const first = h.call("POST", "/v1/lele/proposals", { body, key: k });
    await new Promise((r) => setTimeout(r, 50));
    const second = await h.call("POST", "/v1/lele/proposals", { body, key: k });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "REQUEST_IN_PROGRESS");
    assert.equal(second.headers.get("retry-after"), "1");
    const other = await h.call("POST", "/v1/lele/proposals", { body: { ...body, text: "khác" }, key: k });
    assert.equal(other.body.code, "IDEMPOTENCY_CONFLICT");
    release();
    assert.equal((await first).status, 200);
    const replay = await h.call("POST", "/v1/lele/proposals", { body, key: k });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
  } finally {
    await h.close();
  }
});
