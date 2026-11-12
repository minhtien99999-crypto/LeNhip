// Migration 0010 (V1.0.1, SRS V2.0 mục 09, N20‑SIM, LNH-T68): cổng mô phỏng Le‑ORION.
//   sim_labs  workspace được đăng ký làm tenant lab (bản này chỉ có lab của dữ liệu mẫu dev; chưa có quy trình đăng ký thật)
//   sim_runs  hàng đợi mô phỏng: một lượt chạy theo skill_ref và scene_version, luôn SIMULATED (SIMRUN_)
// Không bảng nào ở đây nối với actions, evidence hay thiết bị: kết quả mô phỏng không nâng mức xác minh của sự kiện vật lý.
// Chỉ dựa vào lược đồ tới hết 0005. Đã phát hành thì không sửa chuỗi sql; cần đổi thì thêm migration mới.
import type { Migration } from "../store.ts";

export const m0010: Migration = {
  id: "0010_sim",
  sha256: "9192d9ef1ca945812bd822a5ecdc09ec70ec4673e30856bb56f6d3eaa54ec64c",
  sql: `
CREATE TABLE sim_labs (
  workspace_id TEXT PRIMARY KEY,
  lab_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','CLOSED')),
  registered_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sim_runs (
  run_ref TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  lab_ref TEXT NOT NULL,
  actor TEXT NOT NULL,
  action_id TEXT NOT NULL UNIQUE,
  request_ref TEXT NOT NULL,
  skill_ref TEXT NOT NULL,
  scene_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('SIMRUN_QUEUED','SIMRUN_COMPLETED')),
  queued_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT,
  UNIQUE (workspace_id, actor, request_ref)
);
CREATE INDEX sim_runs_actor ON sim_runs(workspace_id, actor, queued_at);
CREATE INDEX sim_runs_queue ON sim_runs(state, queued_at);
`,
};
