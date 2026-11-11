// Site gateway (SRS mục 5, 16, 23; EDGE01): kênh duy nhất tới hub, giữ credential vận hành, nhận permit có audience
// lenhip:site:<site>. Lệnh SET_ON/SET_OFF ánh xạ OnOff 0x0006 tại endpoint đã duyệt; ACK 3 giây; đọc mới tại 1/3/5/10 giây,
// max-age 2 giây; khóa chống lặp tại site là (site, device_binding_version, action_id).
import type { ActionRow } from "../server/machine.ts";
import type { Ctx } from "../server/context.ts";
import type { DispatchAdapter, Evidence, ExecResult, Precheck, Readback } from "../server/receiver.ts";
import { device, type DeviceRow } from "../server/authority.ts";
import { all, run, tx } from "../server/store.ts";
import { CMD_OFF, CMD_ON, GATEWAY_CLIENT, ONOFF_CLUSTER, type MockMatterHub } from "./matter-mock.ts";

export const siteAudience = (site: string) => `lenhip:site:${site}`;

export class SiteGatewayAdapter implements DispatchAdapter {
  readonly kind = "device.set_power" as const;
  readonly ackTimeoutMs: number;
  readonly unknownAfterMs: number;
  readonly readsAtMs: number[];
  private readonly ctx: Ctx;
  readonly hubs: Map<string, MockMatterHub>;
  /** Sổ chống lặp tại site: (site, binding, action_id) → digest và receipt. Nằm ở gateway, không ở máy chủ. */
  readonly siteKeys = new Map<string, { digest: string; receipt: string }>();

  constructor(ctx: Ctx, hubs: Map<string, MockMatterHub>) {
    this.ctx = ctx;
    this.hubs = hubs;
    this.ackTimeoutMs = ctx.config.edge.ackTimeoutMs;
    this.unknownAfterMs = ctx.config.edge.unknownAfterMs;
    this.readsAtMs = ctx.config.edge.readsAtMs;
  }

  audience(row: ActionRow) {
    return siteAudience(row.site_id as string);
  }
  servesAudience(aud: string) {
    return aud.startsWith("lenhip:site:") && this.hubs.has(aud.slice("lenhip:site:".length));
  }

  private target(row: ActionRow) {
    const p = JSON.parse(row.payload) as { command: "SET_ON" | "SET_OFF" };
    return p.command === "SET_ON";
  }

  private node(row: ActionRow) {
    const d = device(this.ctx, row.target_ref);
    const hub = this.hubs.get(row.site_id as string);
    // Binding phải đúng phiên bản trong permit: device_ref cũ trỏ node mới bị chặn (SRS mục 23).
    if (!d || !hub || d.status !== "ACTIVE" || d.binding_version !== row.target_binding_version) return null;
    return { d, hub };
  }

  private ev(data: Record<string, unknown>, observedAt: number): Evidence {
    return { grade: "DEVICE_REPORTED", source: `site:${data.site}`, observed_at: new Date(observedAt).toISOString(), data };
  }

  /** Đọc mới qua đúng node/endpoint/binding; cập nhật thẻ trạng thái hiện tại, không đổi lịch sử action. */
  async readFresh(row: ActionRow, notBefore: number | null) {
    const t = this.node(row);
    if (!t) return { kind: "unbound" as const };
    const r = await t.hub.read(GATEWAY_CLIENT, t.d.node_id, t.d.endpoint);
    if ("status" in r) return { kind: "unreadable" as const, status: r.status };
    const now = this.ctx.clock.now();
    const fresh = now - r.observedAt <= this.ctx.config.edge.maxAgeMs && (notBefore === null || r.observedAt >= notBefore);
    if (fresh) {
      tx(this.ctx.db, () => {
        run(this.ctx.db, `INSERT INTO device_status (device_ref, power, observed_at, source) VALUES (?, ?, ?, 'DEVICE_REPORTED')
          ON CONFLICT(device_ref) DO UPDATE SET power = excluded.power, observed_at = excluded.observed_at, source = excluded.source`,
          t.d.device_ref, r.value ? "ON" : "OFF", new Date(r.observedAt).toISOString());
      });
    }
    return { kind: fresh ? ("fresh" as const) : ("stale" as const), value: r.value, observedAt: r.observedAt, d: t.d };
  }

  /**
   * Đọc trạng thái hiện tại của các đèn đang hoạt động để cập nhật thẻ trạng thái (observed_at, độ cũ). Chỉ đọc, không phát lệnh,
   * không ghi vào lịch sử action.
   */
  async pollStatus() {
    const now = this.ctx.clock.now();
    for (const d of all<DeviceRow>(this.ctx.db, "SELECT * FROM devices WHERE status = 'ACTIVE'")) {
      const hub = this.hubs.get(d.site_id);
      if (!hub) continue;
      const r = await hub.read(GATEWAY_CLIENT, d.node_id, d.endpoint);
      if ("status" in r || now - r.observedAt > this.ctx.config.edge.maxAgeMs) continue;
      run(this.ctx.db, `INSERT INTO device_status (device_ref, power, observed_at, source) VALUES (?, ?, ?, 'DEVICE_REPORTED')
        ON CONFLICT(device_ref) DO UPDATE SET power = excluded.power, observed_at = excluded.observed_at, source = excluded.source`,
        d.device_ref, r.value ? "ON" : "OFF", new Date(r.observedAt).toISOString());
    }
  }

  async precheck(row: ActionRow): Promise<Precheck> {
    const r = await this.readFresh(row, null);
    if (r.kind === "unbound") return { result: "UNAVAILABLE", reason: "BINDING_CHANGED", evidence: this.ev({ site: row.site_id, bound: false }, this.ctx.clock.now()) };
    if (r.kind === "unreadable") return { result: "UNAVAILABLE", reason: `DEVICE_${r.status}`, evidence: this.ev({ site: row.site_id, status: r.status }, this.ctx.clock.now()) };
    if (r.kind === "fresh" && r.value === this.target(row)) {
      return { result: "ALREADY_IN_STATE", evidence: this.ev({ site: row.site_id, power: r.value ? "ON" : "OFF", node: r.d.node_id, binding: r.d.binding_version }, r.observedAt) };
    }
    return { result: "CLEAR" };
  }

  async execute(row: ActionRow): Promise<ExecResult> {
    const key = `${row.site_id}|${row.target_binding_version}|${row.action_id}`;
    const seen = this.siteKeys.get(key);
    if (seen) {
      // Bản tin trùng: cùng digest trả receipt cũ, không phát lệnh mới; khác digest từ chối.
      if (seen.digest === row.payload_digest) return { result: "ACK", provider_ref: seen.receipt };
      return { result: "NO_EFFECT", reason: "SITE_KEY_DIGEST_MISMATCH", evidence: this.ev({ site: row.site_id, duplicate: true }, this.ctx.clock.now()) };
    }
    const t = this.node(row);
    if (!t) return { result: "NO_EFFECT", reason: "BINDING_CHANGED", evidence: this.ev({ site: row.site_id, bound: false }, this.ctx.clock.now()) };
    const receipt = `site-rc-${row.action_id}`;
    this.siteKeys.set(key, { digest: row.payload_digest, receipt });
    const r = await t.hub.invoke(GATEWAY_CLIENT, t.d.node_id, t.d.endpoint, ONOFF_CLUSTER, this.target(row) ? CMD_ON : CMD_OFF);
    if (r.status === "SUCCESS") return { result: "ACK", provider_ref: receipt };
    return { result: "NO_EFFECT", reason: `DEVICE_${r.status}`, evidence: this.ev({ site: row.site_id, status: r.status }, this.ctx.clock.now()) };
  }

  async readback(row: ActionRow): Promise<Readback> {
    const notBefore = row.first_io_at ? Date.parse(row.first_io_at) : null;
    const r = await this.readFresh(row, notBefore);
    if (r.kind === "unbound") return { result: "UNDETERMINED", note: "binding đã đổi" };
    if (r.kind === "unreadable") return { result: "UNDETERMINED", note: r.status };
    if (r.kind === "stale") return { result: "UNDETERMINED", note: "trạng thái cũ hơn max-age hoặc trước lệnh" };
    if (r.value === this.target(row)) {
      return { result: "MATCH", evidence: this.ev({ site: row.site_id, power: r.value ? "ON" : "OFF", node: r.d.node_id, binding: r.d.binding_version }, r.observedAt), outcome: "APPLIED" };
    }
    return { result: "UNDETERMINED", note: "thiết bị chưa báo trạng thái đích" };
  }
}
