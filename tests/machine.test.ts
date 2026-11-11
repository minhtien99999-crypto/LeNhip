// T07 (ST01, REC01): mọi cạnh hợp lệ và bất hợp lệ của bảng trạng thái, actor, CAS revision, sự kiện lặp, giữ kết quả cuối.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, getRow, lookup, TERMINAL, TRANSITIONS, type ActorKind, type State } from "../src/server/machine.ts";
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
