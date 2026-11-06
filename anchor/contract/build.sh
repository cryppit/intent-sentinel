#!/usr/bin/env bash
# Build the anchor contract and copy it to res/station_anchor.wasm, the file that is deployed and committed.
# Prints its sha256 and the base58 code hash NEAR reports for the account (view_account .code_hash), so anyone can
# check that the deployed contract is this source: rebuild with the same toolchain (rust-toolchain.toml) and compare.
#
#   anchor/contract/build.sh           build, copy, print the hashes
#   anchor/contract/build.sh --check   build and fail if res/station_anchor.wasm differs (the committed binary is stale)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
cargo build --offline --release --target wasm32v1-none --locked
out=target/wasm32v1-none/release/station_anchor.wasm
if [ "${1:-}" = "--check" ]; then
  cmp -s "$out" res/station_anchor.wasm || { echo "res/station_anchor.wasm is stale: run anchor/contract/build.sh" >&2; exit 1; }
else
  mkdir -p res && cp "$out" res/station_anchor.wasm
fi
node -e '
const { createHash } = require("node:crypto");
const b = require("node:fs").readFileSync("res/station_anchor.wasm");
const d = createHash("sha256").update(b).digest();
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let n = BigInt("0x" + d.toString("hex")), s = "";
while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
for (const x of d) { if (x !== 0) break; s = "1" + s; }
console.log(`res/station_anchor.wasm  ${b.length} bytes\nsha256     ${d.toString("hex")}\ncode_hash  ${s}`);'
