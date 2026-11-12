// Migration 0008 (V1.0.1, SRS V2.0 mục 06–07): Le‑NodeHome và gói thuê HaaS (N20‑HOME, N20‑HAAS, LNH-T66). Chỉ thêm bảng mới,
// chỉ dựa vào lược đồ tới hết 0005, không khóa ngoại nào trỏ vào bảng của sổ tác vụ.
//   home_subscriptions  một đăng ký HaaS của một chủ hộ. state theo các cạnh HAAS_* của contracts/state_transitions.csv.
//                       site_ref là mã địa điểm do chủ hộ chọn, không phải địa chỉ. Báo giá khảo sát (quote_vnd) chủ hộ phải nhận.
//                       binding_version tăng mỗi lần lắp hoặc đổi hub; hub_id là danh tính hub đang dùng. revision cho khóa lạc quan.
//   home_steps          lịch sử từng bước (sự kiện, loại người làm, thời điểm) để chủ hộ thấy danh sách bước.
//   home_hubs           danh tính hub (mô phỏng ở bản tham chiếu): serial, firmware, camera đã lắp, khóa HMAC giữ ở máy chủ,
//                       binding_version lúc lắp, lần liên lạc cuối (heartbeat). REVOKED khi đổi hub hoặc chấm dứt.
//   home_cameras        trạng thái vận hành của từng camera (trực tuyến hay không, thời điểm quan sát), không hình ảnh.
//   home_events         sự kiện tối thiểu từ hub: loại, camera, thời điểm quan sát, cờ đến trễ, clip_ref mờ (không phải URL).
//                       Không ảnh, video, âm thanh, khuôn mặt hay danh tính. UNIQUE(hub, camera, epoch, event_id) chống trùng (X05).
//   home_view_grants    quyền xem tạm thời chủ hộ cấp cho vận hành LeLS theo ticket: có hạn, thu hồi được, đếm số lần dùng (X06).
// Đã phát hành thì không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0008: Migration = {
  id: "0008_home",
  sha256: "8323187fc066db885dea5b137b802475c4cff60f063bb41791c796e7a9014345",
  sql: `
CREATE TABLE home_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  site_ref TEXT NOT NULL,
  package_code TEXT NOT NULL,
  contact_grant TEXT NOT NULL,
  terms_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('HAAS_REQUESTED','HAAS_SURVEYED','HAAS_ACCEPTED','HAAS_INSTALLED','HAAS_ACTIVE','HAAS_SUSPENDED','HAAS_TERMINATED','HAAS_RETURNED')),
  camera_count INTEGER,
  quote_vnd INTEGER,
  quote_accepted_at TEXT,
  binding_version INTEGER NOT NULL DEFAULT 0,
  hub_id TEXT,
  reason_code TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX home_subscriptions_owner ON home_subscriptions(workspace_id, owner_id);
CREATE TABLE home_steps (
  subscription_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  from_state TEXT,
  event TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('OWNER','LELS','SYSTEM')),
  to_state TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, seq)
);
CREATE TABLE home_hubs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  serial TEXT NOT NULL,
  firmware TEXT NOT NULL,
  cameras TEXT NOT NULL,
  hmac_key TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX home_hubs_subscription ON home_hubs(subscription_id);
CREATE TABLE home_cameras (
  hub_id TEXT NOT NULL,
  camera_ref TEXT NOT NULL,
  online INTEGER NOT NULL,
  observed_at TEXT,
  PRIMARY KEY (hub_id, camera_ref)
);
CREATE TABLE home_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  hub_id TEXT NOT NULL,
  camera_ref TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('PERSON_IN_ZONE','CAMERA_OFFLINE','CAMERA_ONLINE','HUB_OFFLINE_RECOVERED')),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  late INTEGER NOT NULL,
  binding_version INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  clip_ref TEXT,
  UNIQUE (hub_id, camera_ref, epoch, event_id)
);
CREATE INDEX home_events_subscription ON home_events(subscription_id, observed_at);
CREATE TABLE home_view_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  ticket_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);
CREATE INDEX home_view_grants_subscription ON home_view_grants(subscription_id);
`,
};
