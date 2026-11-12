// Migration (REL01): 0001 đã phát hành không đổi một byte; từ 0002 mỗi migration là một tệp có mã băm khóa; nâng cấp một sổ do
// 0001 tạo ra lên 0002 giữ nguyên mọi hàng, chỉ mục và hành vi khóa ngoại, và mở thêm từ vựng của V1.0.0 (LNH-T36, LNH-T45).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GRANT_SCOPES, PURPOSES } from "../src/server/authority.ts";
import { ALL_MIGRATIONS, migrate, openLedger, type Db, type Migration } from "../src/server/store.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "lenhip-mig-"));

/** Một sổ như bản 0.1.0 để lại: chỉ có 0001. */
function ledgerAt0001(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  migrate(db, ALL_MIGRATIONS.slice(0, 1));
  return db;
}

const dump = (db: Db, table: string) => db.prepare(`SELECT rowid AS rowid_, * FROM ${table} ORDER BY rowid`).all();
const indexes = (db: Db, table: string) => (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name).sort();

test("migration đã phát hành giữ đúng mã băm; danh sách tăng dần, không trùng số, mỗi mục tự khóa bằng sha256", () => {
  // Hai giá trị này là của bản đã phát hành. Kiểm thử đỏ ở đây nghĩa là ai đó đã sửa một migration cũ: hoàn lại và thêm migration mới.
  const released: Record<string, string> = {
    "0001_ledger": "15490e1db0354166bbfb7b7ee9e37ea8b9466bfef0dd6d663a76bed6d0ac0ccb",
    "0002_v1_authority": "8971cbaf5ca61d1f7aca317c0e3b752635f4830221d50850628ad61c711fba39",
  };
  for (const [id, digest] of Object.entries(released)) {
    const m = ALL_MIGRATIONS.find((x) => x.id === id);
    assert.ok(m, id);
    assert.equal(sha(m.sql), digest, `${id} đã bị sửa`);
  }
  assert.deepEqual(ALL_MIGRATIONS.slice(0, 2).map((m) => m.id), Object.keys(released));
  const ids = ALL_MIGRATIONS.map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids.map((i) => i.slice(0, 4))).size, ids.length);
  for (const m of ALL_MIGRATIONS) assert.equal(m.sha256, sha(m.sql), m.id);
});

test("0002: nâng cấp sổ của 0001 có sẵn dữ liệu giữ nguyên hàng, rowid và chỉ mục; nhận quyền và mục đích mới; khóa ngoại vẫn chạy", () => {
  const dir = tmp();
  const path = join(dir, "ledger.db");
  try {
    const old = ledgerAt0001(path);
    assert.throws(() => old.prepare("INSERT INTO grants (id, workspace_id, user_id, scope, status, created_at) VALUES ('g_new', 'ws_demo', 'u1', 'messaging.use', 'ACTIVE', 't')").run(), /CHECK/, "0001 chưa nhận quyền mới");
    assert.throws(() => old.prepare("INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES ('c_new', 'ws_demo', 'u1', 'social_post', 'v1', 'h', 'GRANTED', 't')").run(), /CHECK/);
    old.exec(`
      INSERT INTO workspaces (id, name, export_policy, export_policy_digest, created_at) VALUES ('ws_demo', 'Thử', '{}', 'd', '2026-11-01T00:00:00.000Z');
      INSERT INTO members (workspace_id, user_id, display_name, roles, status) VALUES ('ws_demo', 'u1', 'Thử nghiệm A', '["MEMBER"]', 'ACTIVE');
      INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES ('g1', 'ws_demo', 'u1', 'calendar.block', NULL, 'ACTIVE', '2026-11-01T00:00:00.000Z');
      INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at, revoked_at, revoked_by) VALUES ('g2', 'ws_demo', 'u1', 'home.control', 'site_lab01', 'REVOKED', '2026-11-01T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'u1');
      INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES ('g3', 'ws_demo', 'u2', 'robot.simulate', NULL, 'ACTIVE', '2026-11-03T00:00:00.000Z');
      INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES ('c1', 'ws_demo', 'u1', 'calendar_link', 'v1', 'hash-1', 'GRANTED', '2026-11-01T00:00:00.000Z');
      INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES ('c2', 'ws_demo', 'u1', 'calendar_link', 'v1', 'hash-1', 'DECLINED', '2026-11-01T00:00:00.000Z');
      INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at, withdrawn_at) VALUES ('c3', 'ws_demo', 'u1', 'home_control', 'v2', 'hash-2', 'GRANTED', '2026-11-02T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
      INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES ('c4', 'ws_demo', 'u2', 'beta_telemetry', 'v1', 'hash-3', 'GRANTED', '2026-11-03T00:00:00.000Z');
      DELETE FROM grants WHERE id = 'g1';
      INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES ('g4', 'ws_demo', 'u1', 'calendar.block', NULL, 'ACTIVE', '2026-11-05T00:00:00.000Z');
    `);
    const grantsBefore = dump(old, "grants");
    const consentsBefore = dump(old, "consents");
    assert.equal(grantsBefore.length, 3);
    assert.equal(consentsBefore.length, 4);
    assert.deepEqual(indexes(old, "grants").filter((n) => !n.startsWith("sqlite_")), ["grants_member"]);
    old.close();

    const db = openLedger(path);
    try {
      assert.deepEqual((db.prepare("SELECT id FROM migrations ORDER BY id").all() as { id: string }[]).map((r) => r.id).slice(0, 2), ["0001_ledger", "0002_v1_authority"]);
      assert.deepEqual(dump(db, "grants"), grantsBefore, "mọi hàng quyền, kể cả rowid và hàng đã thu hồi");
      assert.deepEqual(dump(db, "consents"), consentsBefore, "mọi biên nhận đồng ý, kể cả rowid và hàng đã rút");
      assert.deepEqual(indexes(db, "grants").filter((n) => !n.startsWith("sqlite_")), ["grants_member"]);
      assert.deepEqual(indexes(db, "consents").filter((n) => !n.startsWith("sqlite_")), ["consents_member"]);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v2'").all(), [], "không còn bảng tạm");
      // Hai biên nhận cùng thời điểm: bản ghi sau (rowid lớn hơn) vẫn là bản mới nhất, như latestConsent đọc.
      const latest = db.prepare("SELECT id FROM consents WHERE workspace_id = 'ws_demo' AND user_id = 'u1' AND purpose_id = 'calendar_link' ORDER BY at DESC, rowid DESC LIMIT 1").get() as { id: string };
      assert.equal(latest.id, "c2");
      // Khóa chính và CHECK cũ còn nguyên.
      assert.throws(() => db.prepare("INSERT INTO grants (id, workspace_id, user_id, scope, status, created_at) VALUES ('g2', 'ws_demo', 'u1', 'calendar.block', 'ACTIVE', 't')").run(), /UNIQUE|PRIMARY/);
      assert.throws(() => db.prepare("INSERT INTO grants (id, workspace_id, user_id, scope, status, created_at) VALUES ('g9', 'ws_demo', 'u1', 'calendar.block', 'PAUSED', 't')").run(), /CHECK/);
      assert.throws(() => db.prepare("INSERT INTO grants (id, workspace_id, user_id, scope, status, created_at) VALUES ('g9', 'ws_demo', 'u1', 'health.read', 'ACTIVE', 't')").run(), /CHECK/);
      assert.throws(() => db.prepare("INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES ('c9', 'ws_demo', 'u1', 'health_local', 'v1', 'h', 'GRANTED', 't')").run(), /CHECK/, "sức khỏe vẫn không vào sổ");
      assert.throws(() => db.prepare("INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES ('c9', 'ws_demo', 'u1', 'messaging', 'v1', 'h', 'MAYBE', 't')").run(), /CHECK/);
      // Từ vựng trong mã khớp CHECK của sổ: mọi quyền và mục đích đã khai đều ghi được.
      GRANT_SCOPES.forEach((scope, i) => db.prepare("INSERT INTO grants (id, workspace_id, user_id, scope, status, created_at) VALUES (?, 'ws_demo', 'u3', ?, 'ACTIVE', 't')").run(`gs_${i}`, scope));
      PURPOSES.forEach((purpose, i) => db.prepare("INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES (?, 'ws_demo', 'u3', ?, 'v1', 'h', 'GRANTED', 't')").run(`cp_${i}`, purpose));
      // Khóa ngoại: không có vi phạm, và ràng buộc ở các bảng khác vẫn được thi hành trên cùng kết nối.
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
      assert.throws(() => db.prepare("INSERT INTO members (workspace_id, user_id, display_name, roles, status) VALUES ('ws_none', 'u9', 'x', '[]', 'ACTIVE')").run(), /FOREIGN KEY/);
    } finally {
      db.close();
    }
    // Mở lại: không chạy lại, không đổi gì.
    const again = openLedger(path);
    try {
      assert.equal(dump(again, "grants").length, 3 + GRANT_SCOPES.length);
      assert.equal((again.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n, ALL_MIGRATIONS.length);
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("khóa migration: sql khác mã băm khai trong mã, sửa migration đã chạy, sai thứ tự hay trùng số đều làm máy chủ không chạy; lỗi giữa chừng thì rollback", () => {
  const dir = tmp();
  try {
    const mk = (id: string, sql: string, lock = sha(sql)): Migration => ({ id, sql, sha256: lock });
    const base = ALL_MIGRATIONS.slice(0, 2);
    const fresh = () => new DatabaseSync(join(dir, `${Math.random().toString(36).slice(2)}.db`));

    let db = fresh();
    assert.throws(() => migrate(db, [...base, mk("0003_x", "CREATE TABLE x (id TEXT);", "0".repeat(64))]), /0003_x: nội dung khác mã băm đã khóa/);
    assert.throws(() => db.prepare("SELECT 1 FROM x").get(), /no such table/, "migration sai mã băm không được áp dụng");
    db.close();

    db = fresh();
    migrate(db, [...base, mk("0003_x", "CREATE TABLE x (id TEXT);")]);
    assert.throws(() => migrate(db, [...base, mk("0003_x", "CREATE TABLE x (id TEXT, more TEXT);")]), /0003_x đã phát hành bị sửa/);
    db.close();

    db = fresh();
    assert.throws(() => migrate(db, [...base, mk("0004_b", "CREATE TABLE b (id TEXT);"), mk("0003_a", "CREATE TABLE a (id TEXT);")]), /tăng dần/);
    assert.throws(() => migrate(db, [...base, mk("0003_a", "CREATE TABLE a (id TEXT);"), mk("0003_b", "CREATE TABLE b (id TEXT);")]), /tăng dần/);
    assert.throws(() => migrate(db, [...base, mk("3_a", "CREATE TABLE a (id TEXT);")]), /NNNN_ten/);
    db.close();

    // 0003 và 0004 độc lập: sổ đã chạy 0004 trước (nhánh khác) vẫn nhận 0003 sau.
    db = fresh();
    const m3 = mk("0003_a", "CREATE TABLE a (id TEXT);");
    const m4 = mk("0004_b", "CREATE TABLE b (id TEXT);");
    migrate(db, [...base, m4]);
    migrate(db, [...base, m3, m4]);
    assert.deepEqual((db.prepare("SELECT id FROM migrations ORDER BY id").all() as { id: string }[]).map((r) => r.id), ["0001_ledger", "0002_v1_authority", "0003_a", "0004_b"]);
    db.close();

    db = fresh();
    assert.throws(() => migrate(db, [...base, mk("0003_bad", "CREATE TABLE ok_first (id TEXT); CREATE TABLE grants (id TEXT);")]), /already exists/);
    assert.throws(() => db.prepare("SELECT 1 FROM ok_first").get(), /no such table/, "câu lệnh trước đó trong cùng migration cũng bị hoàn lại");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM migrations").get() as { n: number }).n, 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
