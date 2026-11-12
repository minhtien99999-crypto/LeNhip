// Cờ mô-đun của V1.0.0 (LNH-F27, LNH-T36, LNH-T45, LNH-T53): messaging, social và trackers tắt cho tới khi được đặt rõ là bật;
// bốn cờ của 0.1.0 giữ nguyên cách đọc. Dữ liệu mẫu của chế độ dev bật sẵn ba cờ mới.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMAS, createApp } from "../src/server/app.ts";
import { ManualClock } from "../src/core/clock.ts";
import { ControlStore, LEGACY_MODULES, MODULE_NAMES, OPT_IN_MODULES } from "../src/server/control.ts";
import { harness, T0 } from "./helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "lenhip-flags-"));

test("control store mới: ba mô-đun của V1.0.0 tắt khi chưa đặt, chỉ bật khi đặt rõ true; bốn mô-đun cũ bật như trước", () => {
  const dir = tmp();
  try {
    const path = join(dir, "control.json");
    const c = new ControlStore(path);
    assert.deepEqual([...MODULE_NAMES], ["calendar", "home", "robot", "lele", "messaging", "social", "trackers"]);
    for (const m of LEGACY_MODULES) assert.equal(c.moduleOn(m), true, m);
    for (const m of OPT_IN_MODULES) assert.equal(c.moduleOn(m), false, m);
    assert.deepEqual(c.modules(), { calendar: true, home: true, robot: true, lele: true, messaging: false, social: false, trackers: false });
    c.setModule("2026-11-11T02:00:00.000Z", "ops_1", "messaging", true, "mở thử nhắn tin");
    assert.equal(c.moduleOn("messaging"), true);
    assert.equal(c.moduleOn("social"), false);
    c.setModule("2026-11-11T02:01:00.000Z", "ops_1", "messaging", false, "tắt lại");
    assert.equal(c.moduleOn("messaging"), false);
    // Bền qua khởi động lại.
    c.setModule("2026-11-11T02:02:00.000Z", "ops_1", "trackers", true, "mở thử");
    const again = new ControlStore(path);
    assert.deepEqual(again.modules(), { calendar: true, home: true, robot: true, lele: true, messaging: false, social: false, trackers: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control.json của 0.1.0 (không có ba khóa mới, hoặc thiếu cả khóa cũ): cờ mới đọc là tắt, cờ cũ thiếu vẫn đọc là bật", () => {
  const dir = tmp();
  try {
    const path = join(dir, "control.json");
    const old = { recovery_epoch: 3, dispatch: { locked: false, reason: null, since: null }, modules: { calendar: true, home: false, robot: true, lele: true }, sites: {}, receivers_allowlist: null, history: [] };
    writeFileSync(path, JSON.stringify(old));
    const c = new ControlStore(path);
    assert.deepEqual(c.modules(), { calendar: true, home: false, robot: true, lele: true, messaging: false, social: false, trackers: false });
    assert.equal(c.get().recovery_epoch, 3);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), old, "đọc không ghi lại tệp cũ");
    writeFileSync(path, JSON.stringify({ ...old, modules: { home: false } }));
    const sparse = new ControlStore(path);
    assert.deepEqual(sparse.modules(), { calendar: true, home: false, robot: true, lele: true, messaging: false, social: false, trackers: false });
    // Giá trị không phải true (kể cả chuỗi) không bật được mô-đun mới.
    writeFileSync(path, JSON.stringify({ ...old, modules: { ...old.modules, social: "true", messaging: 1, trackers: null } }));
    const odd = new ControlStore(path);
    for (const m of OPT_IN_MODULES) assert.equal(odd.moduleOn(m), false, m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("không có dữ liệu mẫu thì ba cờ mới tắt; dữ liệu mẫu của chế độ dev bật sẵn, kể cả trên thư mục dữ liệu cũ, nhưng không bật lại cờ đã tắt rõ", () => {
  const dir = tmp();
  try {
    const clock = new ManualClock(T0);
    let app = createApp({ dataDir: dir, clock });
    assert.deepEqual(app.ctx.control.modules(), { calendar: true, home: true, robot: true, lele: true, messaging: false, social: false, trackers: false });
    app.close();
    // Cùng thư mục dữ liệu (đã có control.json không có ba khóa mới), nay chạy với dữ liệu mẫu.
    app = createApp({ dataDir: dir, clock, dev: true, seed: true });
    assert.deepEqual(app.ctx.control.modules(), { calendar: true, home: true, robot: true, lele: true, messaging: true, social: true, trackers: true });
    assert.equal(app.ctx.control.get().history.filter((x) => x.by === "dev-seed").length, 3);
    app.ctx.control.setModule(new Date(clock.now()).toISOString(), "ops_1", "social", false, "tắt để kiểm");
    app.close();
    app = createApp({ dataDir: dir, clock, dev: true, seed: true });
    assert.equal(app.ctx.control.moduleOn("social"), false, "cờ vận hành viên đã tắt thì dữ liệu mẫu không bật lại");
    assert.equal(app.ctx.control.moduleOn("messaging"), true);
    assert.equal(app.ctx.control.get().history.filter((x) => x.by === "dev-seed").length, 3, "không ghi lại ở lần khởi động sau");
    app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API: Me.modules và cờ vận hành có đủ bảy mô-đun; bật/tắt mô-đun mới qua POST /v1/ops/flags", async () => {
  const h = await harness();
  try {
    const me = await h.call("GET", "/v1/me");
    assert.deepEqual(SCHEMAS.validate("Me", me.body), []);
    assert.deepEqual(me.body.modules, { calendar: true, home: true, robot: true, lele: true, messaging: true, social: true, trackers: true });
    for (const m of OPT_IN_MODULES) {
      const off = await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: m, enabled: false, reason: "kiểm kill switch" } });
      assert.equal(off.status, 200, m);
      assert.deepEqual(SCHEMAS.validate("Flags", off.body), []);
      assert.equal(off.body.modules[m], false);
    }
    assert.deepEqual((await h.call("GET", "/v1/me")).body.modules, { calendar: true, home: true, robot: true, lele: true, messaging: false, social: false, trackers: false });
    const flags = await h.call("GET", "/v1/ops/flags", { sub: "dev_ops" });
    assert.deepEqual(Object.keys(flags.body.modules).sort(), [...MODULE_NAMES].sort(), "vận hành thấy cả cờ chưa từng đặt");
    assert.equal((await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "messaging", enabled: true, reason: "mở lại" } })).body.modules.messaging, true);
    assert.equal((await h.call("POST", "/v1/ops/flags", { sub: "dev_a", body: { module: "social", enabled: true, reason: "không có vai trò" } })).status, 403);
    assert.equal((await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "health", enabled: true, reason: "mô-đun lạ" } })).status, 400);
    assert.equal((await h.call("POST", "/v1/ops/flags", { sub: "dev_ops", body: { module: "social", site: "site_lab01", enabled: true, reason: "cờ site chỉ của home" } })).status, 400);
  } finally {
    await h.close();
  }
});
