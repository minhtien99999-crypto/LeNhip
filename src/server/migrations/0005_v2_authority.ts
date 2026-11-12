// Migration 0005 (V1.0.1, SRS V2.0): mở rộng từ vựng của Authority cho các mô-đun của V2.0.
//   grants.scope        thêm 'inbox.connect' (nguồn Microsoft 365 chỉ đọc của Hộp tổng hợp), 'home.hub' (Le‑NodeHome, HaaS),
//                       'measurements.record' (Le‑NodeHealth), 'sim.run' (danh tính lab của cổng mô phỏng Le‑ORION)
//   consents.purpose_id thêm 'inbox_mail', 'home_hub', 'measurements'
// Cùng cách dựng lại bảng như 0002 (SQLite không sửa được CHECK tại chỗ): chép mọi hàng kèm rowid, giữ thứ tự, dựng lại chỉ mục.
// 0004 vẫn dành cho mạng xã hội; 0005 chỉ dựa vào lược đồ tới hết 0003.
// Đã phát hành thì không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0005: Migration = {
  id: "0005_v2_authority",
  sha256: "48448c35003a474460c62773636a6c27b167bc8b5c3886e30206ba3d3a640787",
  sql: `
CREATE TABLE grants_v3 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('calendar.block','home.control','robot.simulate','messaging.use','social.post','inbox.connect','home.hub','measurements.record','sim.run')),
  resource TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT
);
INSERT INTO grants_v3 (rowid, id, workspace_id, user_id, scope, resource, status, created_at, revoked_at, revoked_by)
  SELECT rowid, id, workspace_id, user_id, scope, resource, status, created_at, revoked_at, revoked_by FROM grants ORDER BY rowid;
DROP TABLE grants;
ALTER TABLE grants_v3 RENAME TO grants;
CREATE INDEX grants_member ON grants(workspace_id, user_id);
CREATE TABLE consents_v3 (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  purpose_id TEXT NOT NULL CHECK (purpose_id IN ('calendar_link','home_control','beta_telemetry','messaging','social_post','inbox_mail','home_hub','measurements')),
  text_version TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('GRANTED','DECLINED')),
  at TEXT NOT NULL,
  withdrawn_at TEXT
);
INSERT INTO consents_v3 (rowid, id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at, withdrawn_at)
  SELECT rowid, id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at, withdrawn_at FROM consents ORDER BY rowid;
DROP TABLE consents;
ALTER TABLE consents_v3 RENAME TO consents;
CREATE INDEX consents_member ON consents(workspace_id, user_id, purpose_id);
`,
};
