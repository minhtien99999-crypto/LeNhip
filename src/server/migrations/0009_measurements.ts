// Migration 0009 (V1.0.1, SRS V2.0 mục 08 và 11, N20‑MEAS, LNH-T67): bản ghi phép đo huyết áp của Le‑NodeHealth, tách khỏi Home,
// Work, nhật ký hỗ trợ và mọi bảng của lõi.
//   meas_adapters     danh tính adapter được duyệt (bản này chỉ có adapter mô phỏng, do dữ liệu mẫu dev tạo; chưa có quy trình duyệt thật)
//   meas_mappings     ánh xạ máy đo + hồ sơ trên máy → người được đo, chỉ có hiệu lực khi chính người đó xác nhận (MEASMAP_)
//   meas_observations phép đo đã gán cho một người
//   meas_quarantine   phép đo bị cách ly: thiếu người đo, ánh xạ chưa xác nhận, hai hồ sơ mâu thuẫn, trùng khóa khác nội dung (MEAS_)
//   meas_source_keys  khóa nguồn đã nhận theo adapter: đối soát trùng
//   meas_tombstones   khóa chống trùng của phép đo đã xóa: nhập lại qua bất kỳ kênh nào không làm nó sống lại (chỉ mã băm)
//   meas_shares       grant chia sẻ có mục đích, phạm vi, hạn, thu hồi (MEASSHARE_)
//   meas_access       nhật ký xem, xuất, chia sẻ, thu hồi của chủ dữ liệu: không có giá trị đo
// Chỉ dựa vào lược đồ tới hết 0005. Đã phát hành thì không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0009: Migration = {
  id: "0009_measurements",
  sha256: "87a2301f1326fa8369a7e770d8c9d8b3ec6d37384aca7695d2a8050131741931",
  sql: `
CREATE TABLE meas_adapters (
  adapter_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  principal_sub TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('PHONE_GATEWAY','PARTNER_CLOUD')),
  trust TEXT NOT NULL CHECK (trust IN ('SIMULATED')),
  status TEXT NOT NULL CHECK (status IN ('APPROVED','SUSPENDED')),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  last_seen_at TEXT,
  UNIQUE (workspace_id, principal_sub)
);
CREATE TABLE meas_mappings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  user_slot INTEGER NOT NULL CHECK (user_slot BETWEEN 0 AND 8),
  subject TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('MEASMAP_PROPOSED','MEASMAP_CONFIRMED','MEASMAP_REJECTED','MEASMAP_REVOKED')),
  proposed_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX meas_mappings_device ON meas_mappings(workspace_id, device_ref, state);
CREATE INDEX meas_mappings_subject ON meas_mappings(workspace_id, subject);
CREATE TABLE meas_observations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  user_slot INTEGER,
  measured_at TEXT NOT NULL,
  zone TEXT,
  measured_instant TEXT NOT NULL,
  received_at TEXT NOT NULL,
  systolic INTEGER NOT NULL,
  diastolic INTEGER NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('mmHg')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('VALID','QUESTIONABLE')),
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX meas_observations_subject ON meas_observations(workspace_id, subject, measured_instant);
CREATE INDEX meas_observations_dedupe ON meas_observations(workspace_id, dedupe_key);
CREATE TABLE meas_quarantine (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  user_slot INTEGER,
  measured_at TEXT NOT NULL,
  zone TEXT,
  measured_instant TEXT NOT NULL,
  received_at TEXT NOT NULL,
  systolic INTEGER,
  diastolic INTEGER,
  unit TEXT NOT NULL CHECK (unit IN ('mmHg')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('VALID','QUESTIONABLE')),
  dedupe_key TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('SUBJECT_MISSING','MAPPING_UNCONFIRMED','PROFILE_CONFLICT','AMBIGUOUS_USER','SOURCE_CONFLICT')),
  mapping_id TEXT,
  candidates TEXT NOT NULL,
  answers TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('MEAS_QUARANTINED','MEAS_ASSIGNED','MEAS_DISCARDED','MEAS_EXPIRED')),
  observation_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX meas_quarantine_state ON meas_quarantine(workspace_id, state);
CREATE TABLE meas_source_keys (
  workspace_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('OBSERVATION','QUARANTINE')),
  record_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, adapter_id, source_key)
);
CREATE TABLE meas_tombstones (
  workspace_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, dedupe_key)
);
CREATE TABLE meas_shares (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  grantee TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('FAMILY_CARE','PROFESSIONAL_REVIEW')),
  data_from TEXT NOT NULL,
  data_until TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('MEASSHARE_ACTIVE','MEASSHARE_REVOKED','MEASSHARE_EXPIRED')),
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX meas_shares_owner ON meas_shares(workspace_id, owner);
CREATE INDEX meas_shares_grantee ON meas_shares(workspace_id, grantee);
CREATE TABLE meas_access (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('SHARE_VIEWED','EXPORTED','SHARE_CREATED','SHARE_REVOKED','SHARE_ENDED','MAPPING_CONFIRMED','MAPPING_REJECTED','DELETED')),
  ref TEXT,
  at TEXT NOT NULL
);
CREATE INDEX meas_access_owner ON meas_access(workspace_id, owner, at);
`,
};
