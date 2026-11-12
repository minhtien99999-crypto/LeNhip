// Migration 0003 (V1.0.0): nhắn tin 1:1 và «Thiết bị của tôi» (LNH-T30..T36). Chỉ thêm bảng mới, không dựa vào 0004 và không có
// khóa ngoại nào trỏ vào bảng của sổ tác vụ.
//   msg_endpoints  điểm nhận tin = một trình duyệt đã đăng ký (LNH-T30): loại máy do người dùng chọn và khóa công khai P-256.
//                  Không có tên máy, user agent hay địa chỉ. key_id = SHA-256 của khóa; một khóa chỉ đăng ký một lần mỗi workspace.
//   msg_threads    hội thoại 1:1, mỗi cặp người một hàng (user_lo < user_hi). state theo 10 cạnh THREAD_* của
//                  contracts/state_transitions.csv (LNH-T33). journal_seq: số thứ tự dòng chặn/bỏ chặn mới nhất của sổ thu hồi đã
//                  áp vào hàng này, để nạp lại sau restore đúng thứ tự và lặp lại an toàn.
//   msg_marks      mốc theo người: đã tới thiết bị (delivered_seq), đã đọc (read_seq, riêng tư) và đã đọc có chia sẻ
//                  (read_shared_seq, chỉ tăng khi người đọc bật chia sẻ; LNH-T35). Mốc chỉ tăng.
//   msg_messages   một tin: siêu dữ liệu và bản mã LNH-MSG-1 (iv, ct). Máy chủ không có bản rõ và không có khóa nội dung. iv, ct
//                  bị xóa (NULL) ngay khi không còn phong bì nào chờ giao; cả hàng bị xóa sau 30 ngày (LNH-T32).
//                  UNIQUE(sender_endpoint, client_ref) là lớp chống gửi trùng thứ hai sau Idempotency-Key (LNH-T34).
//                  delivered_at: lần đầu một thiết bị của người nhận xác nhận đã lưu.
//   msg_envelopes  khóa nội dung đã niêm phong cho từng điểm nhận tin (HPKE). Xóa khi thiết bị đó xác nhận đã lưu, khi điểm nhận
//                  tin bị gỡ, hoặc cùng tin sau 30 ngày: máy chủ là hộp thư, không phải kho.
//   msg_reports    báo cáo không kèm nội dung: ai báo ai, hội thoại, tin (nếu chọn), một trong ba lý do.
// Đã phát hành cùng bản này: không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0003: Migration = {
  id: "0003_messaging",
  sha256: "a6b8d20257c18be08ff86dfef464d07e480c3f64a932c66d5a2cef9393d99361",
  sql: `
CREATE TABLE msg_endpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('PHONE','TABLET','LAPTOP','DESKTOP','OTHER')),
  public_key TEXT NOT NULL,
  key_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (workspace_id, key_id)
);
CREATE INDEX msg_endpoints_member ON msg_endpoints(workspace_id, user_id, status);
CREATE TABLE msg_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_lo TEXT NOT NULL,
  user_hi TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('THREAD_REQUESTED','THREAD_ACTIVE','THREAD_CLOSED','THREAD_BLOCKED')),
  requested_by TEXT NOT NULL,
  blocked_by TEXT,
  reopen_by TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  journal_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (user_lo < user_hi),
  UNIQUE (workspace_id, user_lo, user_hi)
);
CREATE INDEX msg_threads_hi ON msg_threads(workspace_id, user_hi);
CREATE TABLE msg_marks (
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  read_seq INTEGER NOT NULL DEFAULT 0,
  read_shared_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);
CREATE TABLE msg_messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  sender_user TEXT NOT NULL,
  sender_endpoint TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  iv TEXT,
  ct TEXT,
  sent_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (thread_id, seq),
  UNIQUE (sender_endpoint, client_ref)
);
CREATE INDEX msg_messages_sent ON msg_messages(sent_at);
CREATE INDEX msg_messages_sender ON msg_messages(workspace_id, sender_user, sent_at);
CREATE TABLE msg_envelopes (
  message_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  enc TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  PRIMARY KEY (message_id, endpoint_id)
);
CREATE INDEX msg_envelopes_endpoint ON msg_envelopes(endpoint_id);
CREATE TABLE msg_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  reporter TEXT NOT NULL,
  reported TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('SPAM','HARASSMENT','OTHER')),
  at TEXT NOT NULL
);
CREATE INDEX msg_reports_workspace ON msg_reports(workspace_id, at);
`,
};
