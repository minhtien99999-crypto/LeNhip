// Hub giả lập tại site (SRS mục 23): Home Assistant Green + Matter server, đèn Wi-Fi có OnOff cluster 0x0006. Chỉ nhận lệnh từ
// danh tính gateway LeNhip (ACL), có reset (node mới), firmware đổi, thao tác tay, mất ACK, đọc trạng thái cũ từ cache.
// Đây không phải thiết bị thật; chứng nhận CSA của sản phẩm thật được kiểm ở G0 (LNH-D07).

export const ONOFF_CLUSTER = 0x0006;
export const CMD_OFF = 0x00;
export const CMD_ON = 0x01;
export const GATEWAY_CLIENT = "lenhip-gateway";

interface Node {
  nodeId: string;
  endpoint: number;
  onOff: boolean;
  online: boolean;
  firmware: string;
  changedAt: number;
  aclClients: Set<string>;
}

export class MockMatterHub {
  readonly site: string;
  private readonly now: () => number;
  readonly nodes = new Map<string, Node>();
  /** dropAck: phản hồi không về; applyCommands=false: lệnh không làm đổi trạng thái thiết bị (mất trên đường hoặc bị bỏ qua). */
  faults = { dropAck: false, ackDelayMs: 0, commandStatus: "SUCCESS" as "SUCCESS" | "FAILURE", staleReadAgeMs: 0, applyCommands: true };
  commands: { nodeId: string; command: number; client: string; at: number }[] = [];
  private pending: (() => void)[] = [];

  constructor(site: string, now: () => number) {
    this.site = site;
    this.now = now;
  }

  addNode(nodeId: string, endpoint = 1, on = false, firmware = "1.0.0") {
    this.nodes.set(nodeId, { nodeId, endpoint, onOff: on, online: true, firmware, changedAt: this.now(), aclClients: new Set([GATEWAY_CLIENT]) });
  }

  release() {
    for (const p of this.pending.splice(0)) p();
  }

  /** Invoke Matter OnOff On/Off. Trả status như Interaction Model; ACL chặn mọi client khác gateway. */
  invoke(client: string, nodeId: string, endpoint: number, cluster: number, command: number): Promise<{ status: "SUCCESS" | "FAILURE" | "UNSUPPORTED_CLUSTER" | "ACCESS_DENIED" | "NOT_FOUND" }> {
    const n = this.nodes.get(nodeId);
    if (!n || !n.online || n.endpoint !== endpoint) return Promise.resolve({ status: "NOT_FOUND" });
    if (!n.aclClients.has(client)) return Promise.resolve({ status: "ACCESS_DENIED" });
    if (cluster !== ONOFF_CLUSTER || (command !== CMD_ON && command !== CMD_OFF)) return Promise.resolve({ status: "UNSUPPORTED_CLUSTER" });
    this.commands.push({ nodeId, command, client, at: this.now() });
    if (this.faults.commandStatus === "FAILURE") return Promise.resolve({ status: "FAILURE" });
    if (this.faults.applyCommands) {
      n.onOff = command === CMD_ON;
      n.changedAt = this.now();
    }
    if (this.faults.dropAck) return new Promise(() => undefined);
    if (this.faults.ackDelayMs > 0) return new Promise((resolve) => this.pending.push(() => resolve({ status: "SUCCESS" })));
    return Promise.resolve({ status: "SUCCESS" });
  }

  /** Đọc attribute OnOff (0x0000). staleReadAgeMs giả lập hub trả giá trị cache cũ. */
  read(client: string, nodeId: string, endpoint: number): Promise<{ value: boolean; observedAt: number } | { status: "NOT_FOUND" | "ACCESS_DENIED" | "OFFLINE" }> {
    const n = this.nodes.get(nodeId);
    if (!n || n.endpoint !== endpoint) return Promise.resolve({ status: "NOT_FOUND" });
    if (!n.aclClients.has(client)) return Promise.resolve({ status: "ACCESS_DENIED" });
    if (!n.online) return Promise.resolve({ status: "OFFLINE" });
    const age = this.faults.staleReadAgeMs;
    return Promise.resolve({ value: n.onOff, observedAt: this.now() - age });
  }

  /** Đặt trạng thái thật của đèn (kiểm thử: điều operator quan sát được tại site). */
  setPower(nodeId: string, on: boolean) {
    const n = this.nodes.get(nodeId);
    if (n) {
      n.onOff = on;
      n.changedAt = this.now();
    }
  }

  /** Người dùng bật/tắt bằng công tắc thật. */
  manualToggle(nodeId: string) {
    const n = this.nodes.get(nodeId);
    if (n) {
      n.onOff = !n.onOff;
      n.changedAt = this.now();
    }
  }

  /** Factory reset: node cũ biến mất, thiết bị xuất hiện lại với node ID mới chưa có ACL. */
  factoryReset(nodeId: string, newNodeId: string) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    this.nodes.delete(nodeId);
    this.nodes.set(newNodeId, { ...n, nodeId: newNodeId, onOff: false, aclClients: new Set() });
  }

  /** Rời site: xóa fabric và ACL. */
  removeFabric(nodeId: string) {
    this.nodes.delete(nodeId);
  }

  setOnline(nodeId: string, online: boolean) {
    const n = this.nodes.get(nodeId);
    if (n) n.online = online;
  }
}
