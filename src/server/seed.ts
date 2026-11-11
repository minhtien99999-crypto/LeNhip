// Dữ liệu tổng hợp cho chạy thử và kiểm thử (SRS mục 10: dev dùng dữ liệu tổng hợp, fixture và thiết bị lab). Không có người
// thật: ba tài khoản thử, một site lab, hai đèn, lịch Microsoft 365 giả lập. Không bao giờ chạy trên dữ liệu thật.
import { digestJcs, uuid } from "../core/crypto.ts";
import { zonedToInstant, localDate } from "../../web/shared/zone.js";
import { type Ctx, nowIso } from "./context.ts";
import { DEFAULT_EXPORT_POLICY } from "./authority.ts";
import type { MockGraph } from "../adapters/graph-mock.ts";
import type { MockMatterHub } from "../adapters/matter-mock.ts";
import { one, run, tx } from "./store.ts";

export const DEMO_WS = "ws_demo";
export const DEMO_SITE = "site_lab01";
export const DEV_USERS = [
  { sub: "dev_a", name: "Thử nghiệm A", roles: ["MEMBER"] },
  { sub: "dev_b", name: "Thử nghiệm B", roles: ["MEMBER"] },
  { sub: "dev_ops", name: "Vận hành LeDB (thử)", roles: ["MEMBER", "LEDB_OPERATOR", "SITE_OPERATOR", "INCIDENT_LEAD", "WORKSPACE_ADMIN"] },
];
export const DEMO_DEVICES = [
  { device_ref: "dev_lamp_01", name: "Đèn bàn", node: "0x0000000000000A01" },
  { device_ref: "dev_lamp_02", name: "Đèn trần", node: "0x0000000000000A02" },
];

export function seedDemo(ctx: Ctx) {
  if (one(ctx.db, "SELECT 1 FROM workspaces WHERE id = ?", DEMO_WS)) return false;
  const at = nowIso(ctx);
  tx(ctx.db, () => {
    run(ctx.db, "INSERT INTO workspaces (id, name, export_policy, export_policy_digest, created_at) VALUES (?, ?, ?, ?, ?)",
      DEMO_WS, "LeDB · Dogfood (dữ liệu tổng hợp)", JSON.stringify(DEFAULT_EXPORT_POLICY), digestJcs(DEFAULT_EXPORT_POLICY), at);
    for (const u of DEV_USERS) {
      run(ctx.db, "INSERT INTO members (workspace_id, user_id, display_name, roles, status) VALUES (?, ?, ?, ?, 'ACTIVE')", DEMO_WS, u.sub, u.name, JSON.stringify(u.roles));
    }
    const grant = (user: string, scope: string, resource: string | null) =>
      run(ctx.db, "INSERT INTO grants (id, workspace_id, user_id, scope, resource, status, created_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)", `gr_${uuid()}`, DEMO_WS, user, scope, resource, at);
    grant("dev_a", "calendar.block", null);
    grant("dev_a", "home.control", DEMO_SITE);
    grant("dev_a", "robot.simulate", null);
    grant("dev_b", "calendar.block", null);
    grant("dev_ops", "calendar.block", null);
    grant("dev_ops", "home.control", DEMO_SITE);
    for (const u of ["dev_a", "dev_b", "dev_ops"]) {
      run(ctx.db, "INSERT INTO calendar_links (id, workspace_id, user_id, provider, tenant_id, object_id, calendar_ref, scope, binding_version, status, linked_at) VALUES (?, ?, ?, 'MS365_GRAPH', ?, ?, 'primary', 'Calendars.ReadWrite', 1, 'ACTIVE', ?)",
        `cal_${u}`, DEMO_WS, u, "tenant-synthetic-0001", `object-${u}`, at);
    }
    run(ctx.db, "INSERT INTO sites (id, workspace_id, name, managed, max_devices) VALUES (?, ?, ?, 1, 3)", DEMO_SITE, DEMO_WS, "Phòng thử nghiệm LeDB");
    for (const d of DEMO_DEVICES) {
      run(ctx.db, `INSERT INTO devices (device_ref, workspace_id, site_id, name, fabric_id, node_id, endpoint, clusters, capabilities, vendor_id, product_id, firmware, certificate_id,
        binding_version, status, commissioned_by, commissioned_at, updated_at) VALUES (?, ?, ?, ?, 'fabric-lab-01', ?, 1, '[6]', '["SET_POWER"]', '0x115A', '0x004B', '1.0.0', 'CSA261ZFMAT51979-24', 1, 'ACTIVE', 'dev_ops', ?, ?)`,
        d.device_ref, DEMO_WS, DEMO_SITE, d.name, d.node, at, at);
    }
  });
  return true;
}

/** Thiết bị và lịch giả lập tương ứng với dữ liệu tổng hợp. */
export function seedMocks(ctx: Ctx, graph: MockGraph, hubs: Map<string, MockMatterHub>, makeHub: (site: string) => MockMatterHub) {
  if (!hubs.has(DEMO_SITE)) {
    const hub = makeHub(DEMO_SITE);
    for (const d of DEMO_DEVICES) {
      const row = one<{ node_id: string }>(ctx.db, "SELECT node_id FROM devices WHERE device_ref = ?", d.device_ref);
      hub.addNode(row?.node_id ?? d.node, 1, d.device_ref === "dev_lamp_01");
    }
    hubs.set(DEMO_SITE, hub);
  }
  // Hai cuộc họp mỗi ngày làm việc trong 14 ngày tới (09:00–09:30 và 14:00–14:30 giờ Việt Nam), như lịch minh họa của gói giao diện.
  const zone = "Asia/Ho_Chi_Minh";
  const today = localDate(ctx.clock.now(), zone);
  for (const u of ["dev_a", "dev_b", "dev_ops"]) {
    const account = `cal_${u}`;
    if (graph.events(account).length) continue;
    for (let i = -1; i < 14; i++) {
      const day = new Date(Date.parse(today + "T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10);
      const wd = new Date(day + "T00:00:00Z").getUTCDay();
      if (wd === 0 || wd === 6) continue;
      for (const [s, e] of [["09:00", "09:30"], ["14:00", "14:30"]]) {
        graph.addMeeting(account, new Date(zonedToInstant(day, s, zone)).toISOString(), new Date(zonedToInstant(day, e, zone)).toISOString());
      }
    }
  }
}

/** Kiểm thử: cấp đồng ý cho một người (đi đúng đường recordConsent ở API trong kiểm thử API). */
export function grantConsentsDirect(ctx: Ctx, user: string, purposes: string[]) {
  const at = nowIso(ctx);
  for (const p of purposes) {
    run(ctx.db, "INSERT INTO consents (id, workspace_id, user_id, purpose_id, text_version, text_hash, choice, at) VALUES (?, ?, ?, ?, 'v1', ?, 'GRANTED', ?)",
      `cs_${uuid()}`, DEMO_WS, user, p, "A".repeat(43), at);
  }
}
