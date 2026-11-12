// Kiểm hợp đồng và truy vết (chạy trong CI): OpenAPI (lõi + mảnh của mô-đun) ↔ route của máy chủ, từ vựng cờ/mục đích/quyền ↔
// mã, bảng trạng thái theo từng máy ↔ sự kiện dùng trong mã, fixture ↔ thuật toán, ma trận truy vết REQ/TEST và hàng ngoài SRS ↔
// tệp có thật, mã băm tài liệu nguồn, mã LNH-* ↔ bản rà soát hoặc bản thiết kế.
//   node scripts/check-contracts.ts            kiểm, in một dòng tóm tắt
//   node scripts/check-contracts.ts --bundle   kiểm rồi in OpenAPI đã ghép (một tài liệu cho bên sinh client)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseStrictJson } from "../src/core/strict-json.ts";
import { ROUTES } from "../src/server/api.ts";
import { GRANT_SCOPES, KINDS, PURPOSES } from "../src/server/authority.ts";
import { MODULE_NAMES } from "../src/server/control.ts";
import { ACTION_STATES, machineOf, parseTransitions, TRANSITIONS } from "../src/server/machine.ts";
import { MODULES } from "../src/server/modules.ts";
import { fragmentFiles, loadOpenApi } from "../src/server/openapi.ts";
import { computeHealthDays } from "../web/shared/sleep.js";
import { canonicalize } from "../web/shared/jcs.js";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const errors: string[] = [];
const fail = (m: string) => errors.push(m);
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

// 1. OpenAPI ↔ route. Hợp đồng là bản đã ghép: contracts/openapi.json cộng contracts/openapi/<mô-đun>.json (src/server/openapi.ts).
const api = loadOpenApi() as any;
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
const codeOps = new Set<string>();
for (const r of ROUTES) {
  const k = `${r.method} ${r.path}`;
  if (codeOps.has(k)) fail(`máy chủ khai ${k} hai lần`);
  codeOps.add(k);
  const s = specOps.get(k);
  if (!s) fail(`máy chủ có ${k} nhưng OpenAPI không có`);
  else if (r.method === "POST" && s.schema !== r.schema) fail(`${k}: schema thân ${r.schema} ≠ OpenAPI ${s.schema}`);
  if (r.method === "POST" && (!r.schema || !Object.hasOwn(api.components.schemas, r.schema))) fail(`${k}: POST phải có schema thân có tên trong components.schemas`);
  if (r.method === "POST" && !r.readable) fail(`${k}: POST phải có readable (phát lại idempotent vẫn qua quyền đọc hiện hành)`);
}
for (const k of specOps.keys()) if (!codeOps.has(k)) fail(`OpenAPI có ${k} nhưng máy chủ không có`);
for (const [name, schema] of Object.entries<any>(api.components.schemas)) {
  if (schema.type === "object" && schema.additionalProperties !== false && !["Metrics", "Flags"].includes(name)) fail(`schema ${name} thiếu additionalProperties=false`);
}

// 1b. Từ vựng dùng chung giữa hợp đồng và mã: cờ mô-đun, mục đích đồng ý, phạm vi quyền, loại tác vụ.
const S = api.components.schemas;
const vocab = (what: string, got: unknown, want: readonly string[]) => {
  if (!Array.isArray(got) || !same(got, want)) fail(`OpenAPI ${what}: ${JSON.stringify(got)} ≠ mã ${JSON.stringify(want)}`);
};
vocab("Me.modules.required", S.Me.properties.modules.required, MODULE_NAMES);
vocab("Me.modules.properties", Object.keys(S.Me.properties.modules.properties), MODULE_NAMES);
vocab("FlagUpdate.module", S.FlagUpdate.properties.module.enum, MODULE_NAMES);
vocab("ConsentCreate.purpose_id", S.ConsentCreate.properties.purpose_id.enum, [...PURPOSES, "health_local"]);
const withdraw = api.paths["/v1/consents/{purpose_id}/withdraw"].post.parameters.find((p: { name?: string }) => p.name === "purpose_id");
vocab("withdraw purpose_id", withdraw?.schema?.enum, PURPOSES);
vocab("Me.grants.scope", S.Me.properties.grants.items.properties.scope.enum, GRANT_SCOPES);
const kinds = [...KINDS, ...MODULES.flatMap((m) => (m.kinds ?? []).map((k) => k.kind))];
vocab("PlanInput.mapping", Object.keys(S.PlanInput.discriminator.mapping), kinds);
vocab("ActionPayload.mapping", Object.keys(S.ActionPayload.discriminator.mapping), kinds);
vocab("Plan.kind", S.Plan.properties.kind.enum, kinds);
vocab("Action.kind", S.Action.properties.kind.enum, kinds);
for (const m of MODULES) {
  for (const k of m.kinds ?? []) {
    if (!GRANT_SCOPES.includes(k.scope)) fail(`mô-đun ${m.name}: ${k.kind} dùng quyền lạ ${k.scope}`);
    if (k.purpose !== null && !PURPOSES.includes(k.purpose)) fail(`mô-đun ${m.name}: ${k.kind} dùng mục đích lạ ${k.purpose}`);
    if (!MODULE_NAMES.includes(k.module)) fail(`mô-đun ${m.name}: ${k.kind} dùng cờ lạ ${k.module}`);
  }
}

// 2. Bảng trạng thái theo từng máy ↔ sự kiện dùng trong mã. Máy tác vụ: `from` là một trong 12 trạng thái tác vụ. Máy khác: một
// tiền tố trạng thái riêng (THREAD_…), nạp bằng transitionsFor(); cạnh của nó phải dẫn mã LNH-T ở cột ref.
const rows = parseTransitions();
const machines = new Map<string, number>();
const seen = new Set<string>();
for (const t of rows) {
  let from: string;
  let to: string;
  try {
    from = machineOf(t.from);
    to = machineOf(t.to);
  } catch (e) {
    fail(`bảng trạng thái: ${(e as Error).message}`);
    continue;
  }
  if (from !== to) fail(`bảng trạng thái: cạnh ${t.from} → ${t.to} nối hai máy khác nhau`);
  if (from !== "") {
    if (!/^[A-Z][A-Z0-9]*_$/.test(from) || ACTION_STATES.some((s) => s.startsWith(from))) fail(`bảng trạng thái: tiền tố máy ${from} không hợp lệ hoặc trùng trạng thái tác vụ`);
    if (!/LNH-T\d{2}/.test(t.ref)) fail(`bảng trạng thái: cạnh ${t.from} --${t.event}--> ${t.to} của máy ${from} phải dẫn mã LNH-T ở cột ref`);
  }
  if (!/^[a-z][a-z_]*$/.test(t.event) || !/^[A-Z][A-Z_]*$/.test(t.actor)) fail(`bảng trạng thái: sự kiện hoặc actor sai dạng ở ${t.from} ${t.event} ${t.actor}`);
  const key = `${t.from}|${t.event}|${t.actor}`;
  if (seen.has(key)) fail(`bảng trạng thái: hai hàng cho ${key}`);
  seen.add(key);
  machines.set(from, (machines.get(from) ?? 0) + 1);
}
if ((machines.get("") ?? 0) !== TRANSITIONS.length) fail("bảng trạng thái: số cạnh của máy tác vụ khác với bảng mã đã nạp");
const otherEdges = rows.length - TRANSITIONS.length;
const events = new Set(rows.map((t) => t.event));
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

// 4. Ma trận truy vết. `requirements` là đúng 33 REQ của SRS V1.1; `tests` là các ca T của SRS; `additions` là các hàng ngoài SRS
// của V1.0.0 (contracts/README.md), chia nhóm theo mô-đun.
const trace = parseStrictJson(read("contracts/traceability.json"), 16) as any;
const REQS = ["OWN01", "MOB01", "ARC01", "X01", "OBS01", "H01", "H02", "H03", "PRIV01", "LEG01", "PRIV02", "INC01", "MED01", "AI01", "RET01", "DR01", "SEC01", "UX01", "ACC01", "REC01", "POL01", "API01", "TX01", "PER01", "ST01", "CAL01", "EDGE01", "MG01", "PIL01", "KPI01", "REL01", "PLAN01", "IP01"];
const STATUS = new Set(["CODE_REFERENCE", "PARTIAL", "NATIVE_APP", "INFRA", "G0_DECISION"]);
const have = new Set(trace.requirements.map((r: { req: string }) => r.req));
for (const r of REQS) if (!have.has(r)) fail(`truy vết thiếu REQ ${r}`);
for (const r of trace.requirements) {
  if (!REQS.includes(r.req)) fail(`REQ ${r.req} không có trong SRS V1.1: hàng ngoài SRS đặt ở additions.<nhóm> (contracts/README.md)`);
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
const ADDITION_KEYS = ["id", "title", "decisions", "status", "code", "tests", "remaining"];
const additionIds = new Set<string>();
const isPaths = (v: unknown): v is string[] => Array.isArray(v) && v.every((p) => typeof p === "string");
if (typeof trace.additions !== "object" || trace.additions === null || Array.isArray(trace.additions)) fail("truy vết: thiếu additions (đối tượng nhóm → danh sách hàng ngoài SRS)");
else {
  for (const [group, list] of Object.entries<any>(trace.additions)) {
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(group) || !Array.isArray(list)) {
      fail(`truy vết: nhóm additions.${group} phải có tên chữ thường và là một danh sách`);
      continue;
    }
    for (const a of list) {
      const id = String(a?.id);
      if (typeof a !== "object" || a === null || !/^V[12]-[A-Z][A-Z0-9]{1,5}\d{2}$/.test(id)) {
        fail(`truy vết: additions.${group} có hàng sai mã (cần dạng V1-<MÃ><nn> hoặc V2-<MÃ><nn>, ví dụ V1-MSG01, V2-INB01): ${id}`);
        continue;
      }
      if (additionIds.has(id)) fail(`hàng ngoài SRS ${id} có hai lần`);
      additionIds.add(id);
      for (const k of Object.keys(a)) if (!ADDITION_KEYS.includes(k)) fail(`hàng ngoài SRS ${id}: khóa lạ ${k}`);
      if (typeof a.title !== "string" || a.title.length < 3) fail(`hàng ngoài SRS ${id}: thiếu title`);
      if (!Array.isArray(a.decisions) || !a.decisions.length || !a.decisions.every((d: unknown) => typeof d === "string" && /^LNH-T\d{2}$/.test(d))) fail(`hàng ngoài SRS ${id}: decisions phải dẫn ít nhất một mã LNH-T`);
      if (!STATUS.has(a.status)) fail(`hàng ngoài SRS ${id}: trạng thái lạ ${a.status}`);
      if (!isPaths(a.code) || !isPaths(a.tests)) fail(`hàng ngoài SRS ${id}: code và tests phải là danh sách đường dẫn`);
      else {
        for (const p of [...a.code, ...a.tests]) if (!existsSync(new URL(p, root))) fail(`hàng ngoài SRS ${id}: không có tệp ${p}`);
        if (a.status === "CODE_REFERENCE" && (!a.code.length || !a.tests.length)) fail(`hàng ngoài SRS ${id}: CODE_REFERENCE cần ít nhất một tệp mã và một tệp kiểm thử`);
      }
      if (a.status !== "CODE_REFERENCE" && !a.remaining) fail(`hàng ngoài SRS ${id}: thiếu phần còn lại`);
    }
  }
}

// 5. Tài liệu nguồn không sửa
for (const s of trace.sources) {
  const got = createHash("sha256").update(readFileSync(new URL(s.path, root))).digest("hex");
  if (got !== s.sha256) fail(`tài liệu nguồn ${s.path} đã đổi (${got.slice(0, 12)} ≠ ${s.sha256.slice(0, 12)})`);
}
const listed = new Set<string>(trace.sources.map((s: { path: string }) => s.path));
for (const f of readdirSync(new URL("docs/source/", root))) if (!listed.has(`docs/source/${f}`)) fail(`tài liệu nguồn docs/source/${f} chưa có mã băm trong traceability.json`);

// 6. Mã LNH-* nhắc trong mã và hợp đồng đều được định nghĩa (một hàng bảng `| LNH-Xnn |`) ở bản rà soát SRS V1.1, bản thiết
// kế V1.0.0 hoặc bản rà soát SRS V2.0, và mỗi mã chỉ được định nghĩa một lần (hai nhánh làm song song không được lấy cùng một số).
const DEFINING_DOCS = ["docs/RA_SOAT_LENHIP_V1_1.md", "docs/THIET_KE_V1_0_0.md", "docs/RA_SOAT_LENHIP_V2_0.md"];
const defined = new Map<string, string>();
for (const doc of DEFINING_DOCS) {
  for (const m of read(doc).matchAll(/^\|\s*LNH-([TQDF]\d{2})\s*\|/gm)) {
    if (defined.has(m[1])) fail(`mã LNH-${m[1]} được định nghĩa hai lần (${defined.get(m[1])} và ${doc})`);
    defined.set(m[1], doc);
  }
}
const refs = new Set<string>();
const scanRefs = (dir: string) => {
  for (const f of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    if (f.isDirectory()) scanRefs(`${dir}${f.name}/`);
    else if (/\.(ts|js|csv|json)$/.test(f.name)) for (const m of read(`${dir}${f.name}`).matchAll(/LNH-([TQDF]\d{2})/g)) refs.add(m[1]);
  }
};
for (const d of ["src/", "web/", "contracts/"]) scanRefs(d);
for (const r of refs) if (!defined.has(r)) fail(`mã nhắc LNH-${r} nhưng không có hàng định nghĩa trong ${DEFINING_DOCS.join(" hay ")}`);

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join("\n"));
  process.exit(1);
}
if (process.argv.includes("--bundle")) console.log(JSON.stringify(api, null, 2));
else {
  console.log(
    `hợp đồng khớp: ${specOps.size} thao tác API (${fragmentFiles().length} mảnh mô-đun), ${TRANSITIONS.length} cạnh máy tác vụ, ${otherEdges} cạnh máy khác, ` +
    `${REQS.length} REQ, ${additionIds.size} hàng ngoài SRS, ${tcases.size} ca, ${refs.size} mã tham chiếu`,
  );
}
