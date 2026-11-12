// Migration 0007 (V1.0.1): Hộp tổng hợp (SRS V2.0 mục 04, 11, 12; N20‑INB; LNH-T65). Chỉ thêm bảng mới, chỉ dựa vào lược đồ tới
// hết 0005, không khóa ngoại nào trỏ vào bảng của sổ tác vụ.
//   inbox_items    một mục của Hộp tổng hợp. source_kind SHARED: phần người dùng tự chọn (dán, chia sẻ vào); OUTLOOK_MAIL: một thư
//                  đọc qua nguồn Microsoft 365 chỉ đọc (ở bản này là nguồn giả lập). Chỉ có trường Mail.ReadBasic cho phép: tiêu
//                  đề (display_summary), người gửi, thời điểm nhận, liên kết đã kiểm; không có cột nào cho thân thư, đoạn xem trước
//                  hay tệp đính kèm. source_ref: mã băm để loại mục trùng theo nguồn (UNIQUE theo chủ, loại nguồn, source_ref).
//                  connection_id: kết nối nguồn đã đọc ra mục (OUTLOOK_MAIL); quyền đọc mục phụ thuộc kết nối đó còn hiệu lực.
//                  state theo các cạnh INBOX_* của contracts/state_transitions.csv; INBOX_HIDDEN là mục bị chặn vì mất quyền nguồn.
//   inbox_sources  kết nối nguồn của một người. Không có cột token: token chỉ nằm trong bộ nhớ của bộ nối (adapter). cursor là con
//                  trỏ mờ của nguồn để đồng bộ tiếp, không phải bí mật. Mỗi người tối đa một kết nối CONNECTED cho mỗi loại nguồn.
// Đã phát hành cùng bản này: không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0007: Migration = {
  id: "0007_inbox",
  sha256: "95b5afb04518c3652fa0a40c557cd181e9543205c5e6b13d46babbb1252a0751",
  sql: `
CREATE TABLE inbox_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('SHARED','OUTLOOK_MAIL')),
  source_ref TEXT NOT NULL,
  connection_id TEXT,
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('REFERENCE','FOLLOW_UP')),
  observed_at TEXT NOT NULL,
  display_summary TEXT NOT NULL CHECK (length(display_summary) BETWEEN 1 AND 280),
  sender TEXT CHECK (sender IS NULL OR length(sender) <= 160),
  source_link TEXT CHECK (source_link IS NULL OR (substr(source_link, 1, 8) = 'https://' AND length(source_link) <= 2048)),
  state TEXT NOT NULL CHECK (state IN ('INBOX_NEW','INBOX_SAVED','INBOX_SNOOZED','INBOX_DONE','INBOX_HIDDEN')),
  snooze_until TEXT,
  hidden_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, owner, source_kind, source_ref)
);
CREATE INDEX inbox_items_owner ON inbox_items(workspace_id, owner, observed_at, id);
CREATE INDEX inbox_items_connection ON inbox_items(connection_id);
CREATE TABLE inbox_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('OUTLOOK_MAIL')),
  simulated INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('CONNECTED','REVOKED','EXPIRED','DISCONNECTED')),
  cursor TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  connected_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE UNIQUE INDEX inbox_sources_live ON inbox_sources(workspace_id, owner, kind) WHERE status = 'CONNECTED';
CREATE INDEX inbox_sources_owner ON inbox_sources(workspace_id, owner);
`,
};
