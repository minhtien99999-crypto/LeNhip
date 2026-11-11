// T14 (phần máy chủ/web): vector JCS RFC 8785 và digest SHA-256 base64url dùng chung với Swift/Kotlin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalize, digestJcs, base64url } from "../web/shared/jcs.js";

const vectors = JSON.parse(readFileSync(new URL("../contracts/fixtures/jcs-vectors.json", import.meta.url), "utf8")).vectors as {
  name: string; input_json: string; canonical: string; sha256_b64url: string;
}[];

test("đầu ra RFC 8785 mục 3.2.2 và 3.2.3 đúng như văn bản RFC", () => {
  const byName = Object.fromEntries(vectors.map((v) => [v.name, v]));
  assert.equal(
    byName["rfc8785-3.2.2"].canonical,
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
  assert.equal(
    byName["rfc8785-3.2.3-sorting"].canonical,
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

for (const v of vectors) {
  test(`vector ${v.name}: dạng chuẩn và digest`, async () => {
    const value = JSON.parse(v.input_json);
    assert.equal(canonicalize(value), v.canonical);
    assert.equal(createHash("sha256").update(v.canonical, "utf8").digest("base64url"), v.sha256_b64url);
    assert.equal(await digestJcs(value), v.sha256_b64url);
  });
}

test("từ chối giá trị không phải dữ liệu JSON", () => {
  for (const bad of [NaN, Infinity, undefined, () => 1, 10n, new Date(0), new Map(), { a: undefined }, "\ud800", { "\udc00": 1 }]) {
    assert.throws(() => canonicalize(bad), TypeError);
  }
  let deep: unknown = 1;
  for (let i = 0; i < 70; i++) deep = [deep];
  assert.throws(() => canonicalize(deep), TypeError);
});

test("base64url không padding", () => {
  assert.equal(base64url(new Uint8Array([251, 255])), "-_8");
  assert.equal(base64url(new Uint8Array([])), "");
});
