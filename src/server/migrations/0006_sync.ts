// Migration 0006 (V1.0.1, SRS V2.0 mục 03, 12; N20‑SYNC; LNH-T63, LNH-T64): bản nháp đồng bộ và phiên trên các thiết bị. Chỉ thêm
// bảng mới, chỉ dựa vào lược đồ tới hết 0005, không khóa ngoại nào trỏ vào bảng của sổ tác vụ.
//   sync_devices  một phiên = một trình duyệt đã đăng ký: loại máy do người dùng chọn, mã băm SHA-256 của bí mật thiết bị tự tạo
//                 (máy chủ không giữ bí mật), trạng thái theo máy SYNCDEV_ của contracts/state_transitions.csv, ngày thấy gần
//                 nhất (chỉ theo ngày). Không tên máy, user agent hay địa chỉ.
//   sync_drafts   bản nháp: mã do thiết bị tạo trong không gian tên của chủ (khóa chính gồm workspace và chủ), mục đích, revision,
//                 snapshot JSON theo schema đóng của mục đích (NULL ngay khi bỏ), trạng thái theo máy SYNCDRAFT_. Hàng đã bỏ bị
//                 xóa sau 30 ngày.
// Đã phát hành cùng bản này: không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0006: Migration = {
  id: "0006_sync",
  sha256: "0cd973da3aa4d6cb96deb0f4cbe72e6170ba5ccd6512f190c0bd38febc50a80b",
  sql: `
CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PHONE','TABLET','LAPTOP','DESKTOP','WATCH','OTHER')),
  secret_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('SYNCDEV_ACTIVE','SYNCDEV_REVOKED')),
  created_at TEXT NOT NULL,
  last_seen_day TEXT NOT NULL,
  revoked_at TEXT,
  CHECK ((state = 'SYNCDEV_REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX sync_devices_member ON sync_devices(workspace_id, user_id, state);
CREATE TABLE sync_drafts (
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('calendar_block','inbox_reply','personal_task')),
  state TEXT NOT NULL CHECK (state IN ('SYNCDRAFT_OPEN','SYNCDRAFT_DISCARDED')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  snapshot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  discarded_at TEXT,
  PRIMARY KEY (workspace_id, owner, draft_id),
  CHECK ((state = 'SYNCDRAFT_OPEN') = (snapshot IS NOT NULL AND discarded_at IS NULL))
);
CREATE INDEX sync_drafts_discarded ON sync_drafts(state, discarded_at);
`,
};
