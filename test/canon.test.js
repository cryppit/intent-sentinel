import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/canon.js";

test("key order never changes the bytes", () =>
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}'));
test("a float is refused", () => assert.throws(() => canonicalJson({ a: 1.5 })));
test("an unsafe integer is refused", () => assert.throws(() => canonicalJson({ a: 2 ** 60 })));
test("an undefined field is left out", () => assert.equal(canonicalJson({ a: undefined, b: "x" }), '{"b":"x"}'));
test("sha256 matches the known digest of abc", async () =>
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
