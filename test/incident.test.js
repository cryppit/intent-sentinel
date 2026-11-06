import test from "node:test";
import assert from "node:assert/strict";
import { readIdentifier, incidentId } from "../src/incident.js";

const NEAR_TX = "9poz2Ntoi16oaJZjyWub2QR8yLWveaYSPpGayDLHapvR";
const SOL_TX = "3hd4Kzyd7VHQbNpgWamqznJtm9cTyAVhYVA751B8XUtPXQ4M1YpZBNx1gWnHuT1LEW11kttjRAK5geWRgKw7ppE5";

test("a pasted hash is cleaned", () => {
  const a = readIdentifier("  0XABC" + "0".repeat(61) + " ");
  assert.deepEqual(a, { kind: "evm-tx", value: "0xabc" + "0".repeat(61) });
});
test("an explorer link gives its hash", () =>
  assert.equal(readIdentifier("https://etherscan.io/tx/0x" + "a".repeat(64)).value, "0x" + "a".repeat(64)));
test("a NEAR hash keeps its case", () =>
  assert.deepEqual(readIdentifier(NEAR_TX), { kind: "near-tx", value: NEAR_TX }));
test("a NEAR explorer link gives its hash", () =>
  assert.equal(readIdentifier(`https://nearblocks.io/txns/${NEAR_TX}`).value, NEAR_TX));
test("a Solana signature is known by length", () => assert.equal(readIdentifier(SOL_TX).kind, "solana-tx"));
test("bare 64 hex stays open until a chain answers", () =>
  assert.deepEqual(readIdentifier("AB".repeat(32)), { kind: "hex-tx", value: "ab".repeat(32) }));
test("omni ids read as chain:nonce", () =>
  assert.deepEqual(readIdentifier("Near:563760"), { kind: "omni-transfer", value: "near:563760" }));
test("an EVM address is a deposit address, lower-cased", () =>
  assert.deepEqual(readIdentifier("0x" + "A".repeat(40)), { kind: "deposit-address", value: "0x" + "a".repeat(40) }));
test("a NEAR account is a deposit address", () => assert.equal(readIdentifier("abc.near").kind, "deposit-address"));
test("a testnet account is refused in plain words", () => assert.match(readIdentifier("abc.testnet").error, /testnet/i));
test("nonsense gives an error, not a case", () => assert.ok(readIdentifier("hello there").error));
test("an empty paste gives an error", () => assert.ok(readIdentifier("   ").error));
test("same ids in any order give one incident", async () =>
  assert.equal(await incidentId(["b", "a"]), await incidentId(["a", "b", "a"])));
test("incident ids carry the prefix", async () => assert.match(await incidentId(["a"]), /^iv1_[0-9a-f]{64}$/));
