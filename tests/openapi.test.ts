// Hợp đồng OpenAPI đã ghép (src/server/openapi.ts): mô-đun thêm thao tác và schema bằng tệp mảnh contracts/openapi/<mô-đun>.json;
// một mảnh chỉ được thêm, không được đè lên thứ đã có.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SchemaSet } from "../src/core/schema.ts";
import { fragmentFiles, loadOpenApi, mergeOpenApi, type OpenApiDoc } from "../src/server/openapi.ts";

const core = (): OpenApiDoc => ({
  openapi: "3.1.0",
  paths: { "/v1/me": { get: { operationId: "getMe" } } },
  components: {
    parameters: { Workspace: { name: "X-LeNhip-Workspace", in: "header" } },
    schemas: { Empty: { type: "object", additionalProperties: false, properties: {} } },
  },
});
const fragment = () => ({
  paths: { "/v1/fake/notes": { get: { operationId: "listFakeNotes" }, post: { operationId: "createFakeNote" } } },
  components: {
    schemas: { FakeNote: { type: "object", additionalProperties: false, required: ["label"], properties: { label: { type: "string", maxLength: 40 }, ref: { $ref: "#/components/schemas/Empty" } } } },
    parameters: { NoteId: { name: "note_id", in: "path" } },
  },
});

test("mergeOpenApi: mảnh thêm đường dẫn, schema và tham số; $ref trỏ được sang schema của lõi; bản lõi không bị sửa", () => {
  const base = core();
  const merged = mergeOpenApi(base, [{ name: "fake.json", doc: fragment() }, { name: "other.json", doc: { paths: { "/v1/other": { get: {} } } } }]);
  assert.deepEqual(Object.keys(merged.paths), ["/v1/me", "/v1/fake/notes", "/v1/other"]);
  assert.deepEqual(Object.keys(merged.components.schemas), ["Empty", "FakeNote"]);
  assert.deepEqual(Object.keys(merged.components.parameters ?? {}), ["Workspace", "NoteId"]);
  assert.equal(merged.openapi, "3.1.0");
  assert.deepEqual(base, core(), "đối số không bị sửa");
  const schemas = new SchemaSet(merged.components.schemas);
  assert.deepEqual(schemas.validate("FakeNote", { label: "ghi chú", ref: {} }), []);
  assert.equal(schemas.validate("FakeNote", { label: "ghi chú", reason_from_health: "ngủ kém" }).length, 1, "schema của mảnh cũng đóng");
  assert.deepEqual(mergeOpenApi(base, []), base);
});

test("mergeOpenApi: mảnh đè lên thứ đã có, ra ngoài /v1 hoặc mang khóa lạ đều bị từ chối", () => {
  const bad = (doc: unknown, more: { name: string; doc: unknown }[] = []) => () => mergeOpenApi(core(), [...more, { name: "bad.json", doc }]);
  assert.throws(bad({ paths: { "/v1/me": { post: {} } } }), /bad\.json: đường dẫn \/v1\/me đã có/);
  assert.throws(bad({ components: { schemas: { Empty: { type: "object" } } } }), /components\.schemas\.Empty đã có/);
  assert.throws(bad({ components: { parameters: { Workspace: {} } } }), /components\.parameters\.Workspace đã có/);
  assert.throws(bad(fragment(), [{ name: "fake.json", doc: fragment() }]), /đã có/, "hai mảnh cùng thêm một thứ");
  assert.throws(bad({ paths: { "/dev/x": { get: {} } } }), /\/v1\//);
  assert.throws(bad({ info: { title: "x" } }), /chỉ được có paths và components/);
  assert.throws(bad({ components: { securitySchemes: {} } }), /securitySchemes/);
  assert.throws(bad([]), /đối tượng JSON/);
  assert.throws(bad({ paths: [] }), /phải là đối tượng/);
  assert.throws(bad({ paths: { "/v1/x": "get" } }), /phải là đối tượng/);
});

test("loadOpenApi: bản đang phát hành ghép được, giữ nguyên mọi thứ của tệp lõi và không có khóa JSON trùng", () => {
  const merged = loadOpenApi();
  const raw = JSON.parse(readFileSync(new URL("../contracts/openapi.json", import.meta.url), "utf8")) as OpenApiDoc;
  for (const [path, item] of Object.entries(raw.paths)) assert.deepEqual(merged.paths[path], item, path);
  for (const [name, schema] of Object.entries(raw.components.schemas)) assert.deepEqual(merged.components.schemas[name], schema, name);
  assert.equal(merged.openapi, raw.openapi);
  assert.ok(Object.keys(merged.paths).length >= Object.keys(raw.paths).length);
  for (const f of fragmentFiles()) assert.match(f, /^[a-z][a-z0-9-]{1,31}\.json$/);
});
