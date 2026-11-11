// Sinh bộ fixture dùng chung cho iOS, Android và máy chủ: contracts/fixtures/sleep/*.json và jcs-vectors.json.
// Mỗi fixture giữ đầu vào, kết quả đầy đủ của bản tham chiếu (expected) và các phép kiểm lấy thẳng từ SRS (checks).
// tests/sleep.test.ts kiểm cả hai; chạy lại script này chỉ khi đổi fixture có chủ đích (đổi thuật toán là phiên bản mới).
//   node scripts/make-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { computeHealthDays } from "../web/shared/sleep.js";
import type { SleepInput } from "../web/shared/sleep.js";
import { SLEEP_CASES } from "./fixture-cases.ts";
import { canonicalize } from "../web/shared/jcs.js";

const root = new URL("../contracts/fixtures/", import.meta.url);
mkdirSync(new URL("sleep/", root), { recursive: true });

for (const fx of SLEEP_CASES) {
  const cases = fx.cases.map((c: { input: SleepInput; checks: unknown[] }) => ({
    input: c.input,
    checks: c.checks,
    expected: computeHealthDays(c.input),
  }));
  const doc = { id: fx.id, algorithm_version: "LNH-SLEEP-1", title: fx.title, srs: fx.srs, cases };
  writeFileSync(new URL(`sleep/${fx.id}.json`, root), JSON.stringify(doc, null, 2) + "\n");
}

// JCS: đầu vào là văn bản JSON thô để giữ nguyên cách viết số (1E30, 4.50) cho các bộ phân tích của từng ngôn ngữ.
const JCS = [
  {
    name: "rfc8785-3.2.2",
    note: "Ví dụ của RFC 8785 mục 3.2.2: số theo ECMAScript, chuỗi theo JSON.stringify, khóa xếp theo UTF-16",
    input_json: '{\n  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n  "literals": [null, true, false]\n}',
  },
  {
    name: "rfc8785-3.2.3-sorting",
    note: "Thứ tự khóa theo đơn vị mã UTF-16 (RFC 8785 mục 3.2.3)",
    input_json: '{\n  "\\u20ac": "Euro Sign",\n  "\\r": "Carriage Return",\n  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n  "1": "One",\n  "\\ud83d\\ude00": "Emoji: Grinning Face",\n  "\\u0080": "Control",\n  "\\u00f6": "Latin Small Letter O With Diaeresis"\n}',
  },
  {
    name: "numbers-edge",
    note: "-0 in là 0; 1e21 in dạng mũ; 1e-7 in dạng mũ; số nguyên lớn an toàn giữ nguyên",
    input_json: '[-0, 0.0, 1e21, 1e20, 1e-7, 0.000001, 9007199254740991, -1.5e-10, 100]',
  },
  {
    name: "nested-unicode",
    note: "Chuỗi tiếng Việt có dấu giữ nguyên byte UTF-8, không thoát; khóa lồng nhau xếp ở mọi tầng",
    input_json: '{"z":{"b":[1,{"y":"Thời gian cá nhân","x":true}],"a":"Đèn bàn"},"a":null}',
  },
  {
    name: "calendar-payload",
    note: "ActionPayload của calendar.block: chỉ phần preview được băm (SRS mục 14)",
    input_json: JSON.stringify({
      kind: "calendar.block", schema_version: 1, workspace_id: "ws_demo",
      target: { type: "calendar", calendar_ref: "primary", account: "cal_7d2c" },
      start: "2026-11-11T08:00:00.000Z", end: "2026-11-11T08:30:00.000Z", zone: "Asia/Ho_Chi_Minh",
      title_code: "PERSONAL_TIME", visibility: "private", show_as: "busy", target_binding_version: 1,
    }),
  },
  {
    name: "device-payload",
    note: "ActionPayload của device.set_power: site, target_binding_version và command",
    input_json: JSON.stringify({
      kind: "device.set_power", schema_version: 1, workspace_id: "ws_demo",
      target: { type: "device", site: "site_hn01", device_ref: "dev_lamp_01" }, command: "SET_ON", target_binding_version: 3,
    }),
  },
].map((v) => {
  const canonical = canonicalize(JSON.parse(v.input_json));
  const sha = createHash("sha256").update(canonical, "utf8").digest("base64url");
  return { ...v, canonical, sha256_b64url: sha };
});
writeFileSync(new URL("jcs-vectors.json", root), JSON.stringify({ scheme: "RFC 8785", digest: "SHA-256, base64url không padding", vectors: JCS }, null, 2) + "\n");
console.log(`đã ghi ${SLEEP_CASES.length} fixture giấc ngủ và ${JCS.length} vector JCS`);
