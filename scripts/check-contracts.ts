// Kiểm hợp đồng và truy vết (chạy trong CI): OpenAPI ↔ route của máy chủ, bảng trạng thái ↔ sự kiện dùng trong mã, fixture ↔
// thuật toán, ma trận truy vết REQ/TEST ↔ tệp có thật, mã băm tài liệu nguồn.
//   node scripts/check-contracts.ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { ROUTES } from "../src/server/api.ts";
import { TRANSITIONS } from "../src/server/machine.ts";
import { computeHealthDays } from "../web/shared/sleep.js";
import { canonicalize } from "../web/shared/jcs.js";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const errors: string[] = [];
const fail = (m: string) => errors.push(m);

// 1. OpenAPI ↔ route
const api = JSON.parse(read("contracts/openapi.json"));
const specOps = new Map<string, { schema: string | null; idem: boolean }>();
for (const [path, item] of Object.entries<Record<string, any>>(api.paths)) {
  for (const [method, op] of Object.entries<any>(item)) {
    const params = (op.parameters ?? []).map((p: { $ref?: string }) => p.$ref);
    const ref = op.requestBody?.content?.["application/json"]?.schema?.$ref as string | undefined;
    specOps.set(`${method.toUpperCase()} ${path}`, { schema: ref ? ref.split("/").pop()! : null, idem: params.includes("#/components/parameters/IdempotencyKey") });
    if (method === "post" && !params.includes("#/components/parameters/IdempotencyKey")) fail(`OpenAPI: POST ${path} thiếu Idempotency-Key`);
    if (!params.includes("#/components/parameters/Workspace")) fail(`OpenAPI: ${method.toUpperCase()} ${path} thiếu X-LeNhip-Workspace`);
  }
}
const codeOps = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
for (const k of specOps.keys()) if (!codeOps.has(k)) fail(`OpenAPI có ${k} nhưng máy chủ không có`);
for (const r of ROUTES) {
  const k = `${r.method} ${r.path}`;
  const s = specOps.get(k);
  if (!s) fail(`máy chủ có ${k} nhưng OpenAPI không có`);
  else if (r.method === "POST" && s.schema !== r.schema) fail(`${k}: schema thân ${r.schema} ≠ OpenAPI ${s.schema}`);
}
for (const [name, schema] of Object.entries<any>(api.components.schemas)) {
  if (schema.type === "object" && schema.additionalProperties !== false && !["Metrics", "Flags"].includes(name)) fail(`schema ${name} thiếu additionalProperties=false`);
}

// 2. Bảng trạng thái ↔ sự kiện dùng trong mã
const events = new Set(TRANSITIONS.map((t) => t.event));
let source = "";
const scan = (dir: string) => {
  for (const f of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    if (f.isDirectory()) scan(`${dir}${f.name}/`);
    else if (f.name.endsWith(".ts")) source += read(`${dir}${f.name}`);
  }
};
scan("src/");
for (const m of source.matchAll(/event:\s*"([a-z_]+)"/g)) if (!events.has(m[1])) fail(`mã dùng sự kiện ${m[1]} không có trong state_transitions.csv`);
for (const e of events) if (!source.includes(`"${e}"`)) fail(`sự kiện ${e} trong bảng chưa có mã phát sinh`);

// 3. Fixture ↔ thuật toán; vector JCS
const fdir = "contracts/fixtures/sleep/";
for (const f of readdirSync(new URL(fdir, root)).filter((x) => x.endsWith(".json"))) {
  const fx = JSON.parse(read(fdir + f));
  for (const [i, c] of fx.cases.entries()) {
    if (canonicalize(computeHealthDays(c.input)) !== canonicalize(c.expected)) fail(`fixture ${f} ca ${i}: kết quả khác expected`);
  }
}
for (const v of JSON.parse(read("contracts/fixtures/jcs-vectors.json")).vectors) {
  if (canonicalize(JSON.parse(v.input_json)) !== v.canonical) fail(`JCS ${v.name}: dạng chuẩn khác`);
  if (createHash("sha256").update(v.canonical, "utf8").digest("base64url") !== v.sha256_b64url) fail(`JCS ${v.name}: digest khác`);
}

// 4. Ma trận truy vết
const trace = JSON.parse(read("contracts/traceability.json"));
const REQS = ["OWN01", "MOB01", "ARC01", "X01", "OBS01", "H01", "H02", "H03", "PRIV01", "LEG01", "PRIV02", "INC01", "MED01", "AI01", "RET01", "DR01", "SEC01", "UX01", "ACC01", "REC01", "POL01", "API01", "TX01", "PER01", "ST01", "CAL01", "EDGE01", "MG01", "PIL01", "KPI01", "REL01", "PLAN01", "IP01"];
const STATUS = new Set(["CODE_REFERENCE", "PARTIAL", "NATIVE_APP", "INFRA", "G0_DECISION"]);
const have = new Set(trace.requirements.map((r: { req: string }) => r.req));
for (const r of REQS) if (!have.has(r)) fail(`truy vết thiếu REQ ${r}`);
for (const r of trace.requirements) {
  if (!STATUS.has(r.status)) fail(`REQ ${r.req}: trạng thái lạ ${r.status}`);
  for (const p of [...(r.code ?? []), ...(r.tests ?? [])]) if (!existsSync(new URL(p, root))) fail(`REQ ${r.req}: không có tệp ${p}`);
  if (r.status !== "CODE_REFERENCE" && !r.remaining) fail(`REQ ${r.req}: thiếu phần còn lại`);
}
const tcases = new Set(trace.tests.map((t: { id: string }) => t.id));
for (let i = 1; i <= 22; i++) {
  const id = `T${String(i).padStart(2, "0")}`;
  if (!tcases.has(id)) fail(`truy vết thiếu ca ${id}`);
}
for (const t of trace.tests) {
  if (t.on_target !== "NOT_EXECUTED") fail(`ca ${t.id}: chưa chạy trên đích thì on_target phải là NOT_EXECUTED`);
  for (const p of t.reference_tests ?? []) if (!existsSync(new URL(p, root))) fail(`ca ${t.id}: không có tệp ${p}`);
}

// 5. Tài liệu nguồn không sửa
for (const s of trace.sources) {
  const got = createHash("sha256").update(readFileSync(new URL(s.path, root))).digest("hex");
  if (got !== s.sha256) fail(`tài liệu nguồn ${s.path} đã đổi (${got.slice(0, 12)} ≠ ${s.sha256.slice(0, 12)})`);
}

// 6. Mã tham chiếu LNH-* trong mã đều có trong bản rà soát
const review = read("docs/RA_SOAT_LENHIP_V1_1.md");
const refs = new Set<string>();
const scanRefs = (dir: string) => {
  for (const f of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    if (f.isDirectory()) scanRefs(`${dir}${f.name}/`);
    else if (/\.(ts|js|csv|json)$/.test(f.name)) for (const m of read(`${dir}${f.name}`).matchAll(/LNH-([TQDF]\d{2})/g)) refs.add(m[1]);
  }
};
for (const d of ["src/", "web/", "contracts/"]) scanRefs(d);
for (const r of refs) if (!new RegExp(`\\bLNH-${r}\\b`).test(review)) fail(`mã nhắc LNH-${r} nhưng bản rà soát không có`);

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
console.log(`hợp đồng khớp: ${specOps.size} thao tác API, ${TRANSITIONS.length} cạnh trạng thái, ${REQS.length} REQ, ${tcases.size} ca, ${refs.size} mã tham chiếu`);
