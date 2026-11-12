// Sổ thực thi (execution ledger) của bản tham chiếu: SQLite một tệp, WAL, synchronous=FULL, mọi thay đổi trong giao dịch.
// SRS mục 21 (DR01) yêu cầu PostgreSQL synchronous replication hai miền lỗi ở môi trường thật; lớp này giữ đúng các bảng và
// bất biến để chuyển sang Postgres (docs/RA_SOAT_LENHIP_V1_1.md, LNH-D04). Migration chỉ thêm, có mã băm để chặn sửa ngầm.
// 0001 nằm nguyên trong tệp này (không sửa một byte nào); từ 0002 mỗi migration là một tệp trong ./migrations/, đăng ký bằng
// một dòng ở ./migrations/index.ts.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { LATER_MIGRATIONS } from "./migrations/index.ts";

export type Db = DatabaseSync;

/**
 * Một migration. `sha256` (hex của đúng chuỗi sql, UTF-8) khóa nội dung ngay trong mã: sql khác mã băm thì máy chủ không chạy.
 * Sau khi một migration đã chạy trên bất kỳ sổ nào còn giữ, không sửa nó nữa; cần đổi thì thêm migration mới.
 */
export interface Migration {
  id: string;
  sql: string;
  sha256: string;
}

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_ledger",
    sql: `
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  export_policy TEXT NOT NULL,
  export_policy_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  roles TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','LEFT')),
  authz_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('calendar.block','home.control','robot.simulate')),
  resource TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
CREATE INDEX grants_member ON grants(workspace_id, user_id);
CREATE TABLE control_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject TEXT,
  authz_version INTEGER,
  data TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE calendar_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider = 'MS365_GRAPH'),
  tenant_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  calendar_ref TEXT NOT NULL CHECK (calendar_ref = 'primary'),
  scope TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','UNLINKED')),
  linked_at TEXT NOT NULL,
  UNIQUE (workspace_id, user_id)
);
CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  managed INTEGER NOT NULL,
  max_devices INTEGER NOT NULL DEFAULT 3
);
CREATE TABLE devices (
  device_ref TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  site_id TEXT NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  fabric_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  endpoint INTEGER NOT NULL,
  clusters TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  firmware TEXT NOT NULL,
  certificate_id TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','QUARANTINED','DECOMMISSIONED')),
  commissioned_by TEXT NOT NULL,
  commissioned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE binding_tombstones (
  device_ref TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (device_ref, binding_version)
);
CREATE TABLE device_status (
  device_ref TEXT PRIMARY KEY,
  power TEXT NOT NULL CHECK (power IN ('ON','OFF')),
  observed_at TEXT NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE consents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose_id TEXT NOT NULL CHECK (purpose_id IN ('calendar_link','home_control','beta_telemetry')),
  text_version TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('GRANTED','DECLINED')),
  at TEXT NOT NULL,
  withdrawn_at TEXT
);
CREATE INDEX consents_member ON consents(workspace_id, user_id, purpose_id);
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  action_id TEXT UNIQUE,
  workspace_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  input TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  window_start TEXT,
  window_end TEXT,
  site_id TEXT,
  target_ref TEXT NOT NULL,
  authz_version INTEGER NOT NULL,
  export_policy_digest TEXT NOT NULL,
  target_binding_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  evidence_grade TEXT,
  dispatch_state TEXT NOT NULL DEFAULT 'NOT_CLAIMED',
  reconciliation_status TEXT,
  reason TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  event_created INTEGER,
  provider_ref TEXT,
  transaction_id TEXT,
  support_code TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  approval_deadline TEXT,
  authorized_at TEXT,
  dispatch_deadline TEXT,
  dispatch_claimed_at TEXT,
  claimed_revision INTEGER,
  first_io_at TEXT,
  acked_at TEXT,
  unknown_after TEXT,
  unknown_since TEXT,
  last_observed_at TEXT,
  terminal_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX actions_state ON actions(state);
CREATE INDEX actions_actor ON actions(workspace_id, actor, created_at);
CREATE INDEX actions_resource ON actions(resource_key, state);
CREATE TABLE checks (
  plan_id TEXT PRIMARY KEY REFERENCES actions(id),
  next_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_at TEXT,
  last_note TEXT
);
CREATE TABLE action_events (
  event_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES actions(id),
  seq INTEGER NOT NULL,
  from_state TEXT,
  event TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor TEXT,
  to_state TEXT NOT NULL,
  data TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (plan_id, seq)
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  grade TEXT NOT NULL CHECK (grade IN ('PROVIDER_READBACK','DEVICE_REPORTED','PHYSICAL_OBSERVED','SIMULATED')),
  result TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  late INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE INDEX evidence_plan ON evidence(plan_id);
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  receiver TEXT NOT NULL,
  provider_ref TEXT,
  digest TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('UNKNOWN_SLA','DISCREPANCY','RECOVERY')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','ACKNOWLEDGED','ESCALATED','MANUAL_REQUIRED','CLOSED')),
  support_code TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  ack_due_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  escalated_at TEXT,
  manual_required_at TEXT,
  closed_at TEXT,
  notes TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX tickets_plan ON tickets(plan_id);
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  plan_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE permit_jti (
  jti TEXT PRIMARY KEY,
  receiver TEXT NOT NULL,
  action_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  identity TEXT NOT NULL,
  action_revision INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  consumed_at TEXT NOT NULL
);
CREATE TABLE idem_keys (
  workspace_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status INTEGER,
  body TEXT,
  resource_type TEXT,
  resource_id TEXT,
  received_at TEXT NOT NULL,
  replay_until TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, actor, method, route, idem_key)
);
CREATE TABLE privacy_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  received_at TEXT NOT NULL,
  ack_due_at TEXT NOT NULL,
  target_due_at TEXT NOT NULL,
  legal_due_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE exports (
  token_hash TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  workspace_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  request_id TEXT,
  data TEXT NOT NULL
);
`,
  },
];

/** Mã băm đã phát hành của 0001 (bản 0.1.0, commit 4b33ccc). Chuỗi sql ở trên phải cho đúng giá trị này. */
const LEDGER_0001_SHA256 = "15490e1db0354166bbfb7b7ee9e37ea8b9466bfef0dd6d663a76bed6d0ac0ccb";

/** Mọi migration theo thứ tự áp dụng: 0001 ở trên, rồi các tệp trong ./migrations/. */
export const ALL_MIGRATIONS: readonly Migration[] = [{ ...MIGRATIONS[0], sha256: LEDGER_0001_SHA256 }, ...LATER_MIGRATIONS];

export function openLedger(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/** Áp các migration chưa chạy, theo thứ tự của danh sách. `list` chỉ truyền khi kiểm thử nâng cấp từ một bản cũ. */
export function migrate(db: Db, list: readonly Migration[] = ALL_MIGRATIONS) {
  let last = "";
  for (const m of list) {
    if (!/^\d{4}_[a-z0-9_]+$/.test(m.id)) throw new Error(`migration ${m.id}: tên phải có dạng NNNN_ten`);
    if (m.id.slice(0, 4) <= last) throw new Error(`migration ${m.id}: số phải tăng dần và không trùng`);
    last = m.id.slice(0, 4);
  }
  db.exec("CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const done = new Map((db.prepare("SELECT id, digest FROM migrations").all() as { id: string; digest: string }[]).map((r) => [r.id, r.digest]));
  for (const m of list) {
    const digest = createHash("sha256").update(m.sql).digest("hex");
    if (m.sha256 !== digest) throw new Error(`migration ${m.id}: nội dung khác mã băm đã khóa (sql hiện có sha256 ${digest})`);
    const prev = done.get(m.id);
    if (prev) {
      if (prev !== digest) throw new Error(`migration ${m.id} đã phát hành bị sửa`);
      continue;
    }
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO migrations (id, digest, applied_at) VALUES (?, ?, ?)").run(m.id, digest, new Date().toISOString());
    });
  }
}

const depth = new WeakMap<Db, number>();

/** Giao dịch đồng bộ. Không bao giờ await bên trong: SQLite giữ khóa ghi tới khi COMMIT. Gọi lồng thì chạy trong giao dịch ngoài. */
export function tx<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec((e as { commit?: boolean } | null)?.commit === true ? "COMMIT" : "ROLLBACK");
    throw e;
  } finally {
    depth.set(db, 0);
  }
}

export const one = <T>(db: Db, sql: string, ...args: (string | number | null)[]) => db.prepare(sql).get(...args) as T | undefined;
export const all = <T>(db: Db, sql: string, ...args: (string | number | null)[]) => db.prepare(sql).all(...args) as T[];
export const run = (db: Db, sql: string, ...args: (string | number | null)[]) => db.prepare(sql).run(...args);

export function audit(db: Db, at: string, e: { workspace_id?: string | null; actor: string; action: string; target?: string | null; request_id?: string | null; data?: Record<string, unknown> }) {
  run(db, "INSERT INTO audit (at, workspace_id, actor, action, target, request_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    at, e.workspace_id ?? null, e.actor, e.action, e.target ?? null, e.request_id ?? null, JSON.stringify(e.data ?? {}));
}

/** Sao lưu nhất quán (VACUUM INTO) cho diễn tập khôi phục. */
export function backupTo(db: Db, path: string) {
  db.prepare("VACUUM INTO ?").run(path);
}
