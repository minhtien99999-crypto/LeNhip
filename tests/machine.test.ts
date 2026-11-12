// T07 (ST01, REC01): mọi cạnh hợp lệ và bất hợp lệ của bảng trạng thái, actor, CAS revision, sự kiện lặp, giữ kết quả cuối.
// Bảng hợp đồng chứa nhiều máy: máy tác vụ giữ đúng 33 cạnh; máy khác nhận diện bằng tiền tố trạng thái (THREAD_…, LNH-T33).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_STATES, apply, getRow, indexTransitions, loadTransitions, lookup, machineOf, parseTransitions, TERMINAL, TRANSITIONS, transitionsFor, type ActorKind, type State,
} from "../src/server/machine.ts";
import { uuid } from "../src/core/crypto.ts";
import { run } from "../src/server/store.ts";
import { harness } from "./helpers.ts";

const STATES: State[] = ["DRAFT", "PENDING_APPROVAL", "AUTHORIZED", "DISPATCHING", "ACKED", "UNKNOWN", "VERIFIED", "FAILED", "CONFLICT", "REJECTED", "EXPIRED", "CANCELED"];
const ACTORS: ActorKind[] = ["API", "USER", "AUTHORITY", "SCHEDULER", "RECEIVER", "ADAPTER", "VERIFIER", "RECONCILER"];
const EVENTS = [...new Set(TRANSITIONS.map((t) => t.event))];

function insert(h: Awaited<ReturnType<typeof harness>>, state: State) {
  const id = `pl_${uuid()}`;
  const at = new Date(h.clock.now()).toISOString();
  run(h.app.ctx.db, `INSERT INTO actions (id, action_id, workspace_id, actor, kind, schema_version, input, payload, payload_digest, resource_key, target_ref, authz_version,
    export_policy_digest, target_binding_version, state, revision, created_at, updated_at) VALUES (?, ?, 'ws_demo', 'dev_a', 'robot.simulate', 1, '{}', '{}', 'd', 'r', 't', 1, 'p', 1, ?, 1, ?, ?)`,
    id, uuid(), state, at, at);
  return id;
}

test("bảng hợp đồng: máy tác vụ có đúng 33 cạnh; hàng của máy khác không lọt vào máy tác vụ", () => {
  // Thêm hay bớt một cạnh của máy tác vụ là đổi hợp đồng SRS mục 19: cần mã LNH-T trong tài liệu, rồi mới sửa con số này.
  assert.equal(TRANSITIONS.length, 33);
  assert.deepEqual([...ACTION_STATES], STATES);
  const all = parseTransitions();
  assert.deepEqual(all.filter((t) => machineOf(t.from) === "").map((t) => `${t.from}|${t.event}|${t.actor}|${t.to}`), TRANSITIONS.map((t) => `${t.from}|${t.event}|${t.actor}|${t.to}`));
  for (const t of all) assert.equal(machineOf(t.from), machineOf(t.to), `${t.from} → ${t.to} nằm trong một máy`);
});

test("transitionsFor: bảng của một máy khác theo tiền tố, đọc từ cùng tệp CSV mà không đụng máy tác vụ", () => {
  const csv = [
    "from,event,actor,to,guard,deadline,ref",
    "DRAFT,submit,API,PENDING_APPROVAL,schema hợp lệ,,SRS 19",
    'PENDING_APPROVAL,approve,API,AUTHORIZED,"cùng digest; còn trong 120 giây, chưa đổi quyền",approval_deadline,SRS 19',
    "THREAD_REQUESTED,accept,ADDRESSEE,THREAD_ACTIVE,cả hai qua cổng,,LNH-T33",
    'THREAD_REQUESTED,decline,ADDRESSEE,THREAD_CLOSED,"người nhận từ chối, ""không kèm chữ""",,LNH-T33',
    "",
    "THREAD_ACTIVE,block,MEMBER,THREAD_BLOCKED,,,LNH-T33",
    "VERIFIED,late_evidence,VERIFIER,VERIFIED,giữ kết quả đã chốt,,SRS 19",
    "DEVICE_PENDING,confirm,OWNER,DEVICE_ACTIVE,,,LNH-T30",
    "",
  ].join("\n");
  const thread = transitionsFor("THREAD_", csv);
  assert.deepEqual(thread.map((t) => `${t.from}|${t.event}|${t.actor}|${t.to}`), [
    "THREAD_REQUESTED|accept|ADDRESSEE|THREAD_ACTIVE", "THREAD_REQUESTED|decline|ADDRESSEE|THREAD_CLOSED", "THREAD_ACTIVE|block|MEMBER|THREAD_BLOCKED",
  ]);
  assert.equal(thread[1].guard, 'người nhận từ chối, "không kèm chữ"', "ô có dấu phẩy và ngoặc kép");
  assert.equal(thread[0].ref, "LNH-T33");
  const find = indexTransitions(thread);
  assert.equal(find("THREAD_REQUESTED", "accept", "ADDRESSEE")?.to, "THREAD_ACTIVE");
  assert.equal(find("THREAD_REQUESTED", "accept", "REQUESTER"), undefined, "sai actor");
  assert.equal(find("THREAD_BLOCKED", "accept", "ADDRESSEE"), undefined, "cạnh không có trong bảng");
  assert.equal(transitionsFor("DEVICE_", csv).length, 1);
  assert.deepEqual(transitionsFor("GROUP_", csv), [], "máy chưa có hàng nào");
  // Máy tác vụ của cùng tệp chỉ gồm hàng có trạng thái tác vụ.
  assert.deepEqual(loadTransitions(csv).map((t) => t.event), ["submit", "approve", "late_evidence"]);
  assert.equal(parseTransitions(csv).length, 7);
  assert.equal(machineOf("THREAD_ACTIVE"), "THREAD_");
  assert.equal(machineOf("PENDING_APPROVAL"), "", "trạng thái tác vụ có gạch dưới vẫn thuộc máy tác vụ");
  assert.throws(() => machineOf("LOOSE"), /không thuộc máy nào/);
  // Tiền tố sai dạng hoặc trùng đầu tên một trạng thái tác vụ bị từ chối; cạnh đi ra ngoài máy cũng vậy.
  assert.throws(() => transitionsFor("thread_", csv), /tiền tố/);
  assert.throws(() => transitionsFor("THREAD", csv), /tiền tố/);
  assert.throws(() => transitionsFor("PENDING_", csv), /trùng trạng thái/);
  assert.throws(() => transitionsFor("THREAD_", csv + "\nTHREAD_ACTIVE,close,MEMBER,VERIFIED,,,LNH-T33\n"), /ra ngoài máy THREAD_/);
  assert.throws(() => indexTransitions(transitionsFor("THREAD_", csv + "\nTHREAD_ACTIVE,block,MEMBER,THREAD_CLOSED,,,LNH-T33\n")), /hai hàng/);
  assert.throws(() => parseTransitions("from,event,actor,to\nA_X,go,API,A_Y\n"), /thiếu cột/);
  // Tệp hợp đồng thật hôm nay chưa có hàng THREAD_ nào bị thiếu cột hay ra ngoài máy.
  assert.doesNotThrow(() => transitionsFor("THREAD_"));
});

test("bảng hợp đồng: trạng thái kết thúc chỉ có late_evidence, mọi cạnh trỏ tới trạng thái hợp lệ", () => {
  for (const t of TRANSITIONS) {
    assert.ok(STATES.includes(t.from) && STATES.includes(t.to), `${t.from}→${t.to}`);
    assert.ok(ACTORS.includes(t.actor), t.actor);
    if (TERMINAL.has(t.from)) {
      assert.equal(t.event, "late_evidence");
      assert.equal(t.to, t.from, "late evidence giữ kết quả đã chốt");
    }
  }
  assert.deepEqual([...TERMINAL].sort(), ["CANCELED", "CONFLICT", "EXPIRED", "FAILED", "REJECTED", "VERIFIED"]);
});

test("mọi tổ hợp (trạng thái, sự kiện, actor): đúng bảng thì đi, ngoài bảng thì bị từ chối", async () => {
  const h = await harness();
  try {
    let accepted = 0;
    let rejected = 0;
    for (const s of STATES) {
      for (const ev of EVENTS) {
        for (const actor of ACTORS) {
          const id = insert(h, s);
          const t = lookup(s, ev, actor);
          const at = new Date(h.clock.now()).toISOString();
          if (t) {
            const r = apply(h.app.ctx.db, { planId: id, event: ev, actorKind: actor, at });
            assert.equal(r.row.state, t.to);
            assert.equal(r.row.revision, 2, "tăng revision đúng một lần");
            accepted++;
          } else {
            assert.throws(() => apply(h.app.ctx.db, { planId: id, event: ev, actorKind: actor, at }), /INVALID_TRANSITION|ACTION_FINAL|thao tác|kết quả cuối/);
            assert.equal(getRow(h.app.ctx.db, id)?.revision, 1, "không đổi khi bị từ chối");
            rejected++;
          }
        }
      }
    }
    assert.equal(accepted, TRANSITIONS.length);
    assert.equal(accepted + rejected, STATES.length * EVENTS.length * ACTORS.length);
  } finally {
    await h.close();
  }
});

test("CAS theo revision và sự kiện lặp cùng event_id trả bản đã biết", async () => {
  const h = await harness();
  try {
    const id = insert(h, "DISPATCHING");
    const at = new Date(h.clock.now()).toISOString();
    assert.throws(() => apply(h.app.ctx.db, { planId: id, event: "ack", actorKind: "ADAPTER", at, expectRevision: 7 }));
    const first = apply(h.app.ctx.db, { planId: id, event: "ack", actorKind: "ADAPTER", at, eventId: "ack:x", expectRevision: 1 });
    const again = apply(h.app.ctx.db, { planId: id, event: "ack", actorKind: "ADAPTER", at, eventId: "ack:x" });
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.row.revision, first.row.revision);
    assert.throws(() => apply(h.app.ctx.db, { planId: id, event: "ack", actorKind: "ADAPTER", at }), "ACKED không nhận ack mới");
  } finally {
    await h.close();
  }
});
