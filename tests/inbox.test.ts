// Hộp tổng hợp (SRS V2.0 mục 04, 11, 12, 14; N20‑INB; LNH-T65): cổng, nhập phần người dùng chọn và loại trùng, máy trạng thái INBOX_,
// phân trang theo con trỏ, nguồn Outlook giả lập (Mail.ReadBasic), X03 (token bị thu hồi khi đang phân trang), X04 (tiêu đề chứa chỉ
// dẫn giả), phát lại idempotent, dọn theo hạn, rút đồng ý, xuất và xóa dữ liệu, restore rồi nạp sổ thu hồi, quét byte tìm thân thư.
// Người dùng là các tài khoản thử tổng hợp; hộp thư là dữ liệu tổng hợp của src/adapters/outlook-mock.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DAY, MINUTE } from "../src/core/clock.ts";
import { SchemaSet } from "../src/core/schema.ts";
import { INJECTED_SUBJECT, SYNTHETIC_BODY_MARKER } from "../src/adapters/outlook-mock.ts";
import { exportInboxFor, INBOX_LIMITS, outlookAccount, outlookFor, syncSource } from "../src/server/inbox.ts";
import { loadOpenApi } from "../src/server/openapi.ts";
import { applyRevocations, backupLedger, restoreLedgerFile } from "../src/server/recovery.ts";
import { withdrawConsent } from "../src/server/authority.ts";
import { all, one } from "../src/server/store.ts";
import { harness, key, WS, type Harness } from "./helpers.ts";

const SCHEMAS = new SchemaSet(loadOpenApi().components.schemas);
const count = (h: Harness, table: string, where = "1 = 1", ...args: string[]) => (one<{ n: number }>(h.app.ctx.db, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args) as { n: number }).n;
const consent = (h: Harness, sub: string, choice: "GRANTED" | "DECLINED" = "GRANTED") =>
  h.call("POST", "/v1/consents", { sub, body: { purpose_id: "inbox_mail", text_version: "v1-2026-11-12", text_hash: "A".repeat(43), choice } });
const list = async (h: Harness, sub = "dev_a", q = "") => (await h.call("GET", `/v2/inbox/items${q}`, { sub })).body;
const importText = (h: Harness, text: string, sub = "dev_a", more: Record<string, unknown> = {}, k?: string) =>
  h.call("POST", "/v2/inbox/imports", { sub, key: k, body: { kind: "TEXT", text, purpose: "REFERENCE", storage: "WORKSPACE", ...more } });
const outlookItems = (h: Harness, sub = "dev_a") => all<{ id: string; state: string; display_summary: string; source_link: string | null; sender: string | null }>(h.app.ctx.db,
  "SELECT id, state, display_summary, source_link, sender FROM inbox_items WHERE owner = ? AND source_kind = 'OUTLOOK_MAIL' ORDER BY observed_at", sub);
/** Nối nguồn giả lập cho một người (đồng ý inbox_mail rồi connect). */
async function connected(h: Harness, sub = "dev_a") {
  assert.equal((await consent(h, sub)).status, 201);
  const r = await h.call("POST", "/v2/inbox/sources/outlook/connect", { sub });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return one<{ id: string }>(h.app.ctx.db, "SELECT id FROM inbox_sources WHERE owner = ? AND status = 'CONNECTED'", sub)!.id;
}
const outlookSource = (body: { sources: { kind: string }[] }) => body.sources.find((s) => s.kind === "OUTLOOK_MAIL") as Record<string, unknown>;

test("cổng: người ngoài workspace 404, cờ inbox tắt 503, thiếu quyền inbox.connect 403, chưa đồng ý inbox_mail 403, đăng nhập cũ 401; mục của người khác là 404", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("GET", "/v2/inbox/items", { ws: "ws_khac" })).status, 404);
    const own = await importText(h, "Ghi chú của A");
    assert.equal(own.status, 201);
    assert.deepEqual(SCHEMAS.validate("InboxImportResult", own.body), []);
    const ref = own.body.item_ref as string;
    for (const op of ["save", "done"]) assert.equal((await h.call("POST", `/v2/inbox/items/${ref}/${op}`, { sub: "dev_b" })).status, 404, `dev_b ${op} mục của A`);
    assert.equal((await list(h, "dev_b")).items.length, 0);

    assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect", { sub: "dev_ops" })).body.code, "FORBIDDEN", "dev_ops không có quyền inbox.connect");
    assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).body.code, "CONSENT_REQUIRED");
    assert.equal((await consent(h, "dev_a")).status, 201);
    const stale = await h.call("POST", "/v2/inbox/sources/outlook/connect", { headers: { Authorization: `Bearer ${h.token("dev_a", { authTime: Math.floor(h.clock.now() / 1000) - 400 })}` } });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.code, "REAUTH_REQUIRED");
    const ok = await h.call("POST", "/v2/inbox/sources/outlook/connect");
    assert.equal(ok.status, 201);
    assert.deepEqual(SCHEMAS.validate("InboxSourceStatus", ok.body), []);
    assert.equal(ok.body.simulated, true);
    assert.equal(ok.body.status, "CONNECTED");
    assert.ok(!JSON.stringify(ok.body).includes(outlookFor(h.app.ctx).tokens.values().next().value as string), "phản hồi không có token");
    assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).status, 200, "đã nối thì trả trạng thái hiện có");

    assert.equal((await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "inbox", enabled: false, reason: "kiểm kill switch" } })).status, 200);
    for (const [m, p, body] of [["GET", "/v2/inbox/items", undefined], ["POST", "/v2/inbox/imports", { kind: "TEXT", text: "x", purpose: "REFERENCE", storage: "WORKSPACE" }], ["POST", `/v2/inbox/items/${ref}/save`, undefined], ["POST", "/v2/inbox/sources/outlook/connect", undefined]] as const) {
      const r = await h.call(m, p, { body });
      assert.equal(r.status, 503, `${m} ${p}`);
      assert.equal(r.body.code, "MODULE_DISABLED");
    }
    await h.app.tick();
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 0, "cờ tắt: không đọc nguồn nữa và xóa phần dẫn xuất");
  } finally {
    await h.close();
  }
});

test("nhập phần người dùng chọn: chỉ lưu đúng chuỗi đã chuẩn hóa, kiểm loại, cỡ và liên kết; loại trùng; phát lại idempotent", async () => {
  const h = await harness();
  try {
    const r = await importText(h, "  Đọc lại\n\nbiên bản   họp  ");
    assert.equal(r.status, 201);
    assert.equal(r.body.result, "STORED");
    assert.equal(r.body.item.display_summary, "Đọc lại biên bản họp");
    assert.equal(r.body.item.state, "NEW");
    assert.equal(r.body.item.source_kind, "SHARED");
    const dup = await importText(h, "Đọc lại biên bản họp");
    assert.equal(dup.status, 200);
    assert.equal(dup.body.result, "DUPLICATE");
    assert.equal(dup.body.item_ref, r.body.item_ref);
    assert.equal(count(h, "inbox_items"), 1);

    const url = await h.call("POST", "/v2/inbox/imports", { body: { kind: "URL", url: "https://example.org/bai-viet?id=7", purpose: "FOLLOW_UP", storage: "WORKSPACE" } });
    assert.equal(url.status, 201);
    assert.equal(url.body.item.source_link, "https://example.org/bai-viet?id=7");
    assert.equal(url.body.item.display_summary, "https://example.org/bai-viet?id=7");
    assert.equal(url.body.item.purpose, "FOLLOW_UP");

    const bad = async (body: Record<string, unknown>, status: number, code: string) => {
      const res = await h.call("POST", "/v2/inbox/imports", { body: { purpose: "REFERENCE", storage: "WORKSPACE", ...body } });
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(res.body.code, code, JSON.stringify(body));
    };
    await bad({ kind: "TEXT", text: "a".repeat(281) }, 422, "INBOX_CONTENT_INVALID");
    await bad({ kind: "TEXT", text: "   " }, 422, "INBOX_CONTENT_INVALID");
    await bad({ kind: "TEXT", text: "đảo‮hướng" }, 422, "INBOX_CONTENT_INVALID");
    await bad({ kind: "TEXT", text: "điều\u0007khiển" }, 422, "INBOX_CONTENT_INVALID");
    await bad({ kind: "URL" }, 422, "INBOX_LINK_INVALID");
    for (const u of ["http://example.org/x", "javascript:alert(1)//", "https://nguoi:matkhau@example.org/", "https://localhost/x", "data:text/html,abc"]) await bad({ kind: "URL", url: u }, 422, "INBOX_LINK_INVALID");
    await bad({ kind: "TEXT", text: "x", storage: "DEVICE" }, 400, "SCHEMA_INVALID");
    await bad({ kind: "TEXT", text: "x", body_html: "<b>x</b>" }, 400, "SCHEMA_INVALID");
    assert.equal(count(h, "inbox_items"), 2, "không lưu gì của yêu cầu sai");

    const k = key();
    const first = await importText(h, "Mua vé tàu", "dev_a", {}, k);
    const again = await importText(h, "Mua vé tàu", "dev_a", {}, k);
    assert.equal(again.status, 201);
    assert.equal(again.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(again.body, first.body);
    assert.equal((await importText(h, "Mua vé máy bay", "dev_a", {}, k)).status, 409, "cùng khóa, khác nội dung");
    assert.equal((await importText(h, "Mua vé tàu", "dev_b", {}, k)).status, 201, "khóa của người khác không đụng nhau");
    assert.equal(count(h, "inbox_items", "owner = 'dev_b'"), 1);
  } finally {
    await h.close();
  }
});

test("máy trạng thái INBOX_: Lưu, Để sau tới giờ thì quay lại Mới, Xong; cạnh không có thì 409; phát lại trả bản cũ", async () => {
  const h = await harness();
  try {
    const ref = (await importText(h, "Gọi lại cho phòng kỹ thuật")).body.item_ref as string;
    const k = key();
    const saved = await h.call("POST", `/v2/inbox/items/${ref}/save`, { key: k });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.state, "SAVED");
    assert.deepEqual(SCHEMAS.validate("InboxItem", saved.body), []);
    const replay = await h.call("POST", `/v2/inbox/items/${ref}/save`, { key: k });
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.deepEqual(replay.body, saved.body);
    const twice = await h.call("POST", `/v2/inbox/items/${ref}/save`);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.code, "INVALID_TRANSITION");

    for (const until of [new Date(h.clock.now() - MINUTE).toISOString(), new Date(h.clock.now() + 31 * DAY).toISOString()]) {
      const r = await h.call("POST", `/v2/inbox/items/${ref}/snooze`, { body: { until } });
      assert.equal(r.status, 422, until);
      assert.equal(r.body.code, "INBOX_SNOOZE_INVALID");
    }
    assert.equal((await h.call("POST", `/v2/inbox/items/${ref}/snooze`, { body: { until: "ngày mai" } })).status, 400);
    const until = new Date(h.clock.now() + 2 * 3600_000).toISOString();
    const snoozed = await h.call("POST", `/v2/inbox/items/${ref}/snooze`, { body: { until: until.replace("Z", "+00:00") } });
    assert.equal(snoozed.status, 200);
    assert.equal(snoozed.body.state, "SNOOZED");
    assert.equal(snoozed.body.snooze_until, until);
    assert.deepEqual((await list(h, "dev_a", "?state=SNOOZED")).items.map((i: { item_ref: string }) => i.item_ref), [ref]);
    assert.equal((await list(h, "dev_a", "?state=NEW")).items.length, 0);

    h.clock.advance(2 * 3600_000 - 1000);
    await h.app.tick();
    assert.equal((await list(h, "dev_a", "?state=SNOOZED")).items.length, 1, "chưa tới giờ");
    h.clock.advance(2000);
    await h.app.tick();
    const woke = (await list(h, "dev_a", "?state=NEW")).items;
    assert.equal(woke.length, 1, "tới giờ thì quay lại «Mới»");
    assert.equal(woke[0].snooze_until, null);

    const done = await h.call("POST", `/v2/inbox/items/${ref}/done`);
    assert.equal(done.body.state, "DONE");
    assert.equal((await list(h)).items.length, 0, "mặc định chỉ hiện Mới, Đã lưu, Để sau");
    assert.equal((await list(h, "dev_a", "?state=DONE")).items.length, 1);
    const later = new Date(h.clock.now() + 3600_000).toISOString();
    assert.equal((await h.call("POST", `/v2/inbox/items/${ref}/snooze`, { body: { until: later } })).status, 409, "mục đã xong không để sau được");

    h.clock.advance(INBOX_LIMITS.doneRetentionMs + 1000);
    await h.app.tick();
    assert.equal(count(h, "inbox_items"), 0, "mục đã xong bị xóa sau 30 ngày");
    assert.equal(count(h, "idem_keys", "resource_type = 'inbox_item' AND resource_id = ?", ref), 0, "cùng dấu chống lặp của nó");
  } finally {
    await h.close();
  }
});

test("phân trang theo con trỏ mờ: trang có giới hạn, không trùng, không sót, mới nhất trước; con trỏ sai hay khác bộ lọc là 400", async () => {
  const h = await harness();
  try {
    const refs: string[] = [];
    for (let i = 0; i < 25; i++) {
      refs.push((await importText(h, `Mục số ${i}`)).body.item_ref);
      h.clock.advance(1000);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await h.call("GET", `/v2/inbox/items?limit=10${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(r.status, 200);
      assert.deepEqual(SCHEMAS.validate("InboxPage", r.body), []);
      assert.ok(r.body.items.length <= 10);
      seen.push(...r.body.items.map((i: { item_ref: string }) => i.item_ref));
      cursor = r.body.next_cursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, [...refs].reverse());
    assert.equal((await list(h)).items.length, INBOX_LIMITS.pageDefault);
    const first = (await list(h, "dev_a", "?limit=5")).next_cursor as string;
    assert.equal((await h.call("GET", `/v2/inbox/items?state=SAVED&cursor=${first}`)).status, 400, "con trỏ gắn với bộ lọc");
    assert.equal((await h.call("GET", "/v2/inbox/items?cursor=AAAAAAAAAAAA")).status, 400);
    assert.equal((await h.call("GET", "/v2/inbox/items?limit=51")).status, 400);
    assert.equal((await h.call("GET", "/v2/inbox/items?state=HIDDEN")).status, 400);
    const other = await h.call("GET", `/v2/inbox/items?limit=5&cursor=${first}`, { sub: "dev_b" });
    assert.equal(other.body.items.length, 0, "con trỏ của người khác không mở được mục của họ");
  } finally {
    await h.close();
  }
});

test("nguồn Outlook giả lập: chỉ trường Mail.ReadBasic, đồng bộ theo con trỏ có giới hạn mỗi lượt, loại trùng theo nguồn, liên kết không phải https bị bỏ", async () => {
  const h = await harness();
  try {
    await connected(h);
    const mock = outlookFor(h.app.ctx).outlook;
    await h.app.tick();
    assert.equal(mock.calls.listMessages, INBOX_LIMITS.syncPagesPerTick, "tối đa ba trang mỗi lượt");
    // Hộp thư tổng hợp có 23 thư, trong đó một thư lặp lại: 22 mục.
    assert.equal(outlookItems(h).length, 22);
    const body = await list(h, "dev_a", "?limit=50");
    assert.deepEqual(SCHEMAS.validate("InboxPage", body), []);
    assert.equal(outlookSource(body).status, "CONNECTED");
    assert.ok(outlookSource(body).last_sync_at);
    const mail = body.items.filter((i: { source_kind: string }) => i.source_kind === "OUTLOOK_MAIL");
    assert.equal(mail.length, 22);
    for (const i of mail) {
      assert.deepEqual(Object.keys(i).sort(), ["display_summary", "item_ref", "observed_at", "purpose", "sender", "snooze_until", "source_kind", "source_link", "state", "updated_at"]);
      assert.ok(i.source_link === null || i.source_link.startsWith("https://outlook.office365.com/"), i.source_link);
      assert.ok(i.sender.endsWith("@contoso.example>"));
    }
    assert.equal(mail.filter((i: { source_link: string | null }) => i.source_link === null).length, 1, "thư có liên kết http không có «Mở bản gốc»");

    const account = outlookAccount(WS, "dev_a");
    mock.deliver(account, "Thư mới sau lượt đồng bộ đầu", h.clock.now());
    await h.app.tick();
    assert.equal(outlookItems(h).length, 23, "lượt sau đọc tiếp từ con trỏ, không đọc lại từ đầu");
    assert.equal(mock.calls.listMessages, INBOX_LIMITS.syncPagesPerTick + 1);
  } finally {
    await h.close();
  }
});

test("X03: token bị thu hồi khi đang phân trang thì dừng đọc, ghi trạng thái nguồn, mục của nguồn biến khỏi danh sách; kết nối lại thì hiện lại; hết hạn cũng vậy", async () => {
  const h = await harness();
  try {
    await connected(h);
    const rt = outlookFor(h.app.ctx);
    rt.outlook.fault(outlookAccount(WS, "dev_a"), { revokeAfterPages: 1 }, h.clock.now());
    await importText(h, "Mục tự chia sẻ vẫn còn");
    await h.app.tick();
    assert.equal(rt.outlook.calls.listMessages, 2, "trang 1 đọc được, trang 2 bị từ chối thì dừng");
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 10);
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL' AND state <> 'INBOX_HIDDEN'"), 0, "mục đã đọc trước khi bị thu hồi cũng bị ẩn");
    const body = await list(h);
    assert.deepEqual(body.items.map((i: { source_kind: string }) => i.source_kind), ["SHARED"]);
    assert.equal(outlookSource(body).status, "REVOKED");
    assert.equal(outlookSource(body).last_error, "TOKEN_REVOKED");
    assert.equal(rt.tokens.size, 0, "token bị quên");
    const hidden = outlookItems(h)[0].id;
    assert.equal((await h.call("POST", `/v2/inbox/items/${hidden}/save`)).status, 404);
    await h.app.tick();
    assert.equal(rt.outlook.calls.listMessages, 2, "không đọc thêm sau khi bị thu hồi");

    // Kết nối lại trong 7 ngày: thư cũ hiện lại ở «Mới» (source_restored), không nhân đôi.
    assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).status, 201);
    await h.app.tick();
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 22);
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL' AND state = 'INBOX_NEW'"), 22);

    // Hết hạn token: như thu hồi; quá 7 ngày thì mục ẩn bị xóa.
    h.clock.advance(61 * MINUTE);
    rt.outlook.deliver(outlookAccount(WS, "dev_a"), "Thư tới sau khi token hết hạn", h.clock.now());
    await h.app.tick();
    assert.equal(outlookSource(await list(h)).status, "EXPIRED");
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL' AND state <> 'INBOX_HIDDEN'"), 0);
    assert.equal(count(h, "inbox_items", "display_summary = 'Thư tới sau khi token hết hạn'"), 0, "không có mục vượt quyền");
    h.clock.advance(INBOX_LIMITS.hiddenRetentionMs + 1000);
    await h.app.tick();
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 0);

    // Khởi động lại: token chỉ ở trong bộ nhớ nên kết nối thành EXPIRED ở lượt kế tiếp.
    assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).status, 201);
    await h.restart();
    await h.app.tick();
    assert.equal(outlookSource(await list(h)).last_error, "TOKEN_MISSING");
  } finally {
    await h.close();
  }
});

test("X03: đồng ý inbox_mail bị rút trong lúc chờ nguồn trả lời thì trang đó không được ghi và phần dẫn xuất bị xóa", async () => {
  const h = await harness();
  try {
    const id = await connected(h);
    const mock = outlookFor(h.app.ctx).outlook;
    const real = mock.listMessages.bind(mock);
    let calls = 0;
    mock.listMessages = async (...args) => {
      const page = await real(...args);
      if (++calls === 2) withdrawConsent(h.app.ctx, WS, "dev_a", "inbox_mail", null);
      return page;
    };
    const out = await syncSource(h.app.ctx, id);
    assert.equal(out.pages, 1);
    assert.equal(out.stopped, "PERMISSION");
    assert.equal(calls, 2);
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 0, "trang 1 đã ghi cũng bị xóa khi rút đồng ý");
    assert.equal(one<{ status: string }>(h.app.ctx.db, "SELECT status FROM inbox_sources WHERE id = ?", id)?.status, "DISCONNECTED");
    assert.equal(outlookSource(await list(h)).permission, "CONSENT_REQUIRED");
  } finally {
    await h.close();
  }
});

test("X04: tiêu đề chứa chỉ dẫn giả được lưu và trả ra nguyên văn như dữ liệu; không tạo kế hoạch, tác vụ, quyền hay lời gọi ra ngoài; LeLe không có đường tới Hộp tổng hợp", async () => {
  const h = await harness();
  try {
    await connected(h);
    const before = { actions: count(h, "actions"), grants: count(h, "grants"), consents: count(h, "consents") };
    await h.app.tick();
    const body = await list(h, "dev_a", "?limit=50");
    const injected = body.items.filter((i: { display_summary: string }) => i.display_summary === INJECTED_SUBJECT);
    assert.equal(injected.length, 1, "nguyên văn, không cắt, không làm sạch nghĩa");
    assert.deepEqual({ actions: count(h, "actions"), grants: count(h, "grants"), consents: count(h, "consents") }, before);
    assert.equal(outlookFor(h.app.ctx).outlook.calls.listMessages, 3, "lời gọi duy nhất tới nguồn là đọc thư");
    assert.equal(injected[0].state, "NEW");
    const inboxSrc = readFileSync(new URL("../src/server/inbox.ts", import.meta.url), "utf8");
    const leleSrc = readFileSync(new URL("../src/server/lele.ts", import.meta.url), "utf8");
    assert.ok(!/from "\.\/lele\.ts"/.test(inboxSrc), "inbox.ts không nạp lele.ts");
    assert.ok(!/inbox/i.test(leleSrc), "lele.ts không nhắc tới Hộp tổng hợp");
  } finally {
    await h.close();
  }
});

test("rút quyền: ngắt kết nối, rút đồng ý, thu hồi quyền inbox.connect hay RESTRICT đều dừng đọc và xóa mục dẫn xuất từ Outlook; phần tự chia sẻ giữ nguyên", async () => {
  const h = await harness();
  try {
    await connected(h);
    await importText(h, "Mục tự chia sẻ");
    await h.app.tick();
    const ref = outlookItems(h)[0].id;
    await h.call("POST", `/v2/inbox/items/${ref}/save`);
    assert.ok(count(h, "idem_keys", "route = ?", `/v2/inbox/items/${ref}/save`) === 1);
    const d = await h.call("POST", "/v2/inbox/sources/outlook/disconnect");
    assert.equal(d.status, 200);
    assert.equal(d.body.status, "DISCONNECTED");
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 0);
    assert.equal(count(h, "idem_keys", "route = ?", `/v2/inbox/items/${ref}/save`), 0, "dấu chống lặp của mục đã xóa");
    assert.equal(count(h, "inbox_items", "source_kind = 'SHARED'"), 1);
    assert.equal(outlookFor(h.app.ctx).tokens.size, 0);

    assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).status, 201);
    await h.app.tick();
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 22);
    assert.equal((await h.call("POST", "/v1/consents/inbox_mail/withdraw")).status, 200);
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 0, "rút đồng ý: xóa ngay trong cùng giao dịch");
    const calls = outlookFor(h.app.ctx).outlook.calls.listMessages;
    await h.app.tick();
    assert.equal(outlookFor(h.app.ctx).outlook.calls.listMessages, calls, "không đọc thêm");

    await consent(h, "dev_a");
    assert.equal((await h.call("POST", "/v2/inbox/sources/outlook/connect")).status, 201);
    await h.app.tick();
    const grant = ((await h.call("GET", "/v1/me")).body.grants as { id: string; scope: string }[]).find((g) => g.scope === "inbox.connect")!;
    assert.equal((await h.call("POST", `/v1/grants/${grant.id}/revoke`)).status, 200);
    assert.equal((await list(h)).items.filter((i: { source_kind: string }) => i.source_kind === "OUTLOOK_MAIL").length, 0, "danh sách lọc ngay theo quyền hiện hành");
    await h.app.tick();
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 0, "lượt kế tiếp xóa phần dẫn xuất");
    assert.equal(count(h, "inbox_sources", "status = 'CONNECTED'"), 0);

    // RESTRICT của dev_b: rút mọi đồng ý, Outlook của dev_b bị xóa.
    await connected(h, "dev_b");
    await h.app.tick();
    assert.equal(count(h, "inbox_items", "owner = 'dev_b' AND source_kind = 'OUTLOOK_MAIL'"), 22);
    assert.equal((await h.call("POST", "/v1/privacy/requests", { sub: "dev_b", body: { type: "RESTRICT" } })).status, 202);
    assert.equal(count(h, "inbox_items", "owner = 'dev_b' AND source_kind = 'OUTLOOK_MAIL'"), 0);
  } finally {
    await h.close();
  }
});

test("xuất và xóa dữ liệu: tệp xuất chỉ có siêu dữ liệu; DELETE xóa hết của người đó; restore bản cũ rồi nạp sổ thu hồi thì lần ngắt kết nối vẫn còn hiệu lực", async () => {
  const h = await harness();
  try {
    await connected(h);
    const shared = await importText(h, "Ghi chú riêng XK-91-KHONG-XUAT", "dev_a", { url: "https://example.org/xk91" });
    await h.app.tick();
    const ex = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
    assert.equal(ex.status, 202, JSON.stringify(ex.body));
    const file = (await h.call("GET", ex.body.export.path)).body;
    const part = file.modules.inbox;
    assert.deepEqual(part, JSON.parse(JSON.stringify(exportInboxFor(h.app.ctx, WS, "dev_a"))));
    assert.equal(part.items.length, 23);
    assert.deepEqual(Object.keys(part.items[0]).sort(), ["created_at", "has_link", "item_ref", "observed_at", "purpose", "source_kind", "state"]);
    const text = JSON.stringify(file);
    for (const needle of ["XK-91-KHONG-XUAT", "example.org/xk91", INJECTED_SUBJECT, "contoso.example", "outlook.office365.com", SYNTHETIC_BODY_MARKER]) assert.ok(!text.includes(needle), `tệp xuất không có ${needle}`);

    // Restore: sao lưu khi còn kết nối, ngắt kết nối, chép đè bản cũ, nạp sổ thu hồi.
    const backup = join(h.dir, "truoc-khi-ngat.db");
    backupLedger(h.app.ctx, backup);
    await h.call("POST", "/v2/inbox/sources/outlook/disconnect");
    h.app.close();
    restoreLedgerFile(backup, join(h.dir, "ledger.db"));
    await h.restart();
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 22, "bản cũ còn mục Outlook");
    assert.ok(applyRevocations(h.app.ctx).applied >= 1);
    assert.equal(count(h, "inbox_items", "source_kind = 'OUTLOOK_MAIL'"), 0, "nạp lại lần ngắt kết nối");
    assert.equal(count(h, "inbox_sources", "status = 'CONNECTED'"), 0);
    applyRevocations(h.app.ctx);
    assert.equal(count(h, "inbox_items", "source_kind = 'SHARED'"), 1, "lặp lại an toàn; phần tự chia sẻ còn nguyên");

    await importText(h, "Mục của B", "dev_b");
    assert.equal((await h.call("POST", "/v1/privacy/requests", { body: { type: "DELETE" } })).status, 202);
    assert.equal(count(h, "inbox_items", "owner = 'dev_a'") + count(h, "inbox_sources", "owner = 'dev_a'"), 0);
    assert.equal(count(h, "idem_keys", "actor = 'dev_a' AND substr(route, 1, 10) = '/v2/inbox/'"), 0);
    assert.equal(count(h, "idem_keys", "resource_id = ?", shared.body.item_ref), 0);
    assert.equal(count(h, "inbox_items", "owner = 'dev_b'"), 1, "dữ liệu của người khác giữ nguyên");
  } finally {
    await h.close();
  }
});

test("quét byte: thân thư, đoạn xem trước và tệp đính kèm của hộp thư giả lập không nằm trong sổ, WAL, sổ thu hồi, phản hồi API hay hợp đồng", async () => {
  const h = await harness();
  try {
    await connected(h);
    await h.app.tick();
    const responses = [JSON.stringify(await list(h, "dev_a", "?limit=50")), JSON.stringify((await h.call("POST", "/v2/inbox/sources/outlook/connect")).body)];
    const ex = await h.call("POST", "/v1/privacy/requests", { body: { type: "EXPORT" } });
    responses.push(JSON.stringify((await h.call("GET", ex.body.export.path)).body));
    backupLedger(h.app.ctx, join(h.dir, "backup.db"));
    for (const r of responses) {
      assert.ok(!r.includes(SYNTHETIC_BODY_MARKER), "phản hồi không có thân thư");
      for (const k of ["body", "bodyPreview", "attachments", "hasAttachments", "uniqueBody", "token", "cursor"]) assert.ok(!r.includes(`"${k}"`), `phản hồi không có trường ${k}`);
    }
    for (const table of ["inbox_items", "inbox_sources"]) {
      const cols = all<{ name: string }>(h.app.ctx.db, `PRAGMA table_info(${table})`).map((c) => c.name);
      for (const k of ["body", "body_preview", "preview", "attachments", "token"]) assert.ok(!cols.includes(k), `${table} không có cột ${k}`);
    }
    const files = readdirSync(h.dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => join(f.parentPath, f.name));
    assert.ok(files.length >= 3);
    const hits = files.filter((f) => {
      const buf = readFileSync(f);
      return buf.includes(Buffer.from(SYNTHETIC_BODY_MARKER, "utf8")) || buf.includes(Buffer.from(SYNTHETIC_BODY_MARKER, "utf16le"));
    });
    assert.deepEqual(hits, [], "thân thư không nằm trong tệp nào máy chủ ghi ra");
    const token = [...outlookFor(h.app.ctx).tokens.values()][0];
    assert.ok(token);
    assert.deepEqual(files.filter((f) => readFileSync(f).includes(Buffer.from(token, "utf8"))), [], "token không nằm trong tệp nào");
    const contract = readFileSync(new URL("../contracts/openapi/inbox.json", import.meta.url), "utf8");
    for (const k of ["bodyPreview", "attachments", "\"body\""]) assert.ok(!contract.includes(k), `hợp đồng không có ${k}`);
  } finally {
    await h.close();
  }
});
