// Robot mock (SRS mục 04, 20; G3): adapter độc lập, trust root và namespace riêng ("sim"), mọi bằng chứng là SIMULATED và không
// vào số liệu tác động thật. Không có đường nào tới robot thật trong bản này.
import type { ActionRow } from "../server/machine.ts";
import type { Ctx } from "../server/context.ts";
import type { DispatchAdapter, ExecResult, Precheck, Readback } from "../server/receiver.ts";

export const ROBOT_AUDIENCE = "lenhip:robot-sim";

export class RobotSimAdapter implements DispatchAdapter {
  readonly kind = "robot.simulate" as const;
  readonly ackTimeoutMs: number;
  readonly unknownAfterMs: number;
  readonly readsAtMs = [0, 5_000];
  private readonly ctx: Ctx;
  readonly runs = new Map<string, string[]>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.ackTimeoutMs = ctx.config.robot.ackTimeoutMs;
    this.unknownAfterMs = ctx.config.robot.unknownAfterMs;
  }
  audience() {
    return ROBOT_AUDIENCE;
  }
  servesAudience(aud: string) {
    return aud === ROBOT_AUDIENCE;
  }
  async precheck(): Promise<Precheck> {
    return { result: "CLEAR" };
  }
  async execute(row: ActionRow): Promise<ExecResult> {
    const id = `sim-${row.action_id}`;
    this.runs.set(id, ["Nhận nhiệm vụ tại bàn làm việc", "Di chuyển tới điểm bàn giao", "Ghi nhận kết quả quan sát"]);
    return { result: "ACK", provider_ref: id };
  }
  async readback(row: ActionRow): Promise<Readback> {
    const id = row.provider_ref ?? `sim-${row.action_id}`;
    const steps = this.runs.get(id);
    if (!steps) return { result: "UNDETERMINED", note: "chưa có lượt mô phỏng" };
    return {
      result: "MATCH", outcome: "SIMULATED",
      evidence: { grade: "SIMULATED", source: "sim:robot", observed_at: new Date(this.ctx.clock.now()).toISOString(), data: { run: id, steps } },
    };
  }
}
