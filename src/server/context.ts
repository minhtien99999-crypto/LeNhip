// Ngữ cảnh dùng chung của máy chủ tham chiếu và các tham số thời gian của SRS (mục 11, 16, 17, 19, 20, 22, 23).
import type { Clock } from "../core/clock.ts";
import { DAY, HOUR, MINUTE, SECOND } from "../core/clock.ts";
import type { ControlStore } from "./control.ts";
import type { AppendJournal } from "./journal.ts";
import type { ServerModule } from "./modules.ts";
import type { Db } from "./store.ts";

export const CONFIG = {
  approvalWindowMs: 120 * SECOND, // SRS 11, 19: approvals hết 120 giây
  dispatchWindowMs: 120 * SECOND, // SRS 19: lease deadline 120 giây từ authorize
  permitLifetimeS: 30, // SRS 17: 0 < exp − iat ≤ 30
  skewMs: 2 * SECOND, // SRS 17: lệch đồng hồ tối đa 2 giây
  jtiRetentionMs: 24 * HOUR, // SRS 11: consumed jti giữ ít nhất 24 giờ sau exp
  idempotencyReplayMs: 90 * DAY, // SRS 16: replay 90 ngày
  draftTtlMs: 24 * HOUR, // SRS 11: draft hết 24 giờ
  calendar: { ackTimeoutMs: 10 * SECOND, unknownAfterMs: 30 * SECOND, horizonDays: 14, maxMinutes: 240, minLeadMs: MINUTE },
  edge: { ackTimeoutMs: 3 * SECOND, readsAtMs: [1 * SECOND, 3 * SECOND, 5 * SECOND, 10 * SECOND], unknownAfterMs: 10 * SECOND, maxAgeMs: 2 * SECOND },
  robot: { ackTimeoutMs: 5 * SECOND, unknownAfterMs: 15 * SECOND },
  unknown: {
    readsAtMs: [0, 5 * SECOND, 15 * SECOND, 30 * SECOND, 60 * SECOND], // SRS 20
    everyMs: 60 * SECOND,
    jitter: 0.1,
    ticketAfterMs: 5 * MINUTE,
    ackDueMs: 15 * MINUTE,
    escalateAfterMs: HOUR,
    manualAfterMs: 24 * HOUR,
  },
  exportLinkMs: 24 * HOUR, // SRS 09: link hết hạn 24 giờ
  reauthMaxAgeS: 300, // EXPORT/DELETE cần auth_time trong 5 phút (LNH-T15)
  maxBodyBytes: 64 * 1024,
  rateLimit: { perSecond: 5, burst: 40 }, // SRS mục 12: rate limit, timeout, queue cap
  leleInputBytes: 16 * 1024, // SRS 24
  leleOutputBytes: 8 * 1024,
  leleTimeoutMs: 15 * SECOND,
};

export type Config = typeof CONFIG;

export interface Ctx {
  db: Db;
  clock: Clock;
  control: ControlStore;
  /** Dispatch barrier: kho độc lập ghi trước mọi I/O. */
  barrier: AppendJournal;
  /** Sổ thu hồi độc lập: tombstone xóa, thu hồi quyền/đồng ý, đổi binding; nạp lại trước khi phục vụ bản restore. */
  revocations: AppendJournal;
  config: Config;
  /** Các mô-đun đã đăng ký của app này (src/server/modules.ts); lõi gọi hook của chúng qua đây. */
  modules: readonly ServerModule[];
}

export const nowIso = (ctx: Ctx) => new Date(ctx.clock.now()).toISOString();
