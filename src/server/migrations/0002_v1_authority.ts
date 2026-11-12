// Migration 0002 (V1.0.0): mở rộng từ vựng của Authority cho hai mô-đun mới (LNH-T36, LNH-T45).
//   grants.scope        thêm 'messaging.use' và 'social.post'
//   consents.purpose_id thêm 'messaging' và 'social_post'
// SQLite không sửa được CHECK tại chỗ nên hai bảng được dựng lại trong cùng giao dịch của migration: tạo bảng mới, chép mọi hàng
// kèm rowid (latestConsent xếp theo `at DESC, rowid DESC`), bỏ bảng cũ, đổi tên, dựng lại chỉ mục. Không bảng nào tham chiếu
// grants hay consents bằng khóa ngoại, nên foreign_keys=ON không bị ảnh hưởng. Chỉ thêm giá trị được chấp nhận: hàng cũ giữ nguyên.
// Đã phát hành: không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0002: Migration = {
  id: "0002_v1_authority",
  sha256: "8971cbaf5ca61d1f7aca317c0e3b752635f4830221d50850628ad61c711fba39",
  sql: `
CREATE TABLE grants_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('calendar.block','home.control','robot.simulate','messaging.use','social.post')),
  resource TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
INSERT INTO grants_v2 (rowid, id, workspace_id, user_id, scope, resource, status, created_at, revoked_at, revoked_by)
  SELECT rowid, id, workspace_id, user_id, scope, resource, status, created_at, revoked_at, revoked_by FROM grants ORDER BY rowid;
DROP TABLE grants;
ALTER TABLE grants_v2 RENAME TO grants;
CREATE INDEX grants_member ON grants(workspace_id, user_id);
CREATE TABLE consents_v2 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose_id TEXT NOT NULL CHECK (purpose_id IN ('calendar_link','home_control','beta_telemetry','messaging','social_post')),
  text_version TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('GRANTED','DECLINED')),
  at TEXT NOT NULL,
  withdrawn_at TEXT
);
INSERT INTO consents_v2 (rowid, id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at, withdrawn_at)
  SELECT rowid, id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at, withdrawn_at FROM consents ORDER BY rowid;
DROP TABLE consents;
ALTER TABLE consents_v2 RENAME TO consents;
CREATE INDEX consents_member ON consents(workspace_id, user_id, purpose_id);
`,
};
