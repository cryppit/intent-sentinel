# Intent Sentinel

Paste one id from a stuck cross-chain swap. See what each step proves, and who has to act next.

Built at NEAR HACKATHON for the `security`, `open` and `defi` tracks. Live page: https://cryppit.github.io/intent-sentinel/

## The problem

A cross-chain swap crosses several systems, and each one shows only its own status. When money stalls, the user sees `FAILED` or nothing, and support teams pass the case around. None of the rails we surveyed says who has to act next.

Intent Sentinel reads the public chains and returns a case file:

- every step of the route, and what proves it;
- the one party who has to act next, and the question to ask them;
- a verdict with a hash. The same evidence gives the same bytes, so reading an unchanged case again gives the same hash.

It is read-only. It holds no keys, signs nothing and moves no funds. If a step can be finished, it describes the step and never runs it.

## Try it: no install, no keys

You need Node 22 or newer. There are no dependencies, so there's nothing to install.

**1. List the recorded cases**

```sh
node cli.js demo
```

You should see:

```text
omni-665
omni-666
refund-5btc
```

**2. Replay a stuck transfer, with no network**

```sh
node cli.js replay omni-665
```

You should see this, and exit code 2, meaning someone must act:

```text
Next to act: an Omni relayer.
Only an Omni relayer can run sign_transfer. Will it run for Near:563760?

  omni: started, not finished (proven)
```

This is [Near-One/omni-bridge #665](https://github.com/Near-One/omni-bridge/issues/665): 0.02 ETH sent with `fee: "0"`. `sign_transfer` is `#[trusted_relayer]`, so the sender can't finish it.

**3. Replay one where nothing is left to do**

```sh
node cli.js replay refund-5btc
```

You should see `Nobody needs to act`, `amounts on credit: balance`, and exit code 0. The NEAR ledger balances exactly: 500,014,578 in and out.

**4. Read a case live from public chains**

```sh
node cli.js check Near:563760
```

You should see the same answer as step 2, unless the transfer has moved since. Run it twice with `--json` and the verdict hash matches, because a verdict's time comes from the chain and not the clock. A new chain event or a 1Click claim changes the hash. A source that can't be read gives exit code 3 and `We can't give an answer yet`, never a clean verdict.

**5. Run the tests**

```sh
npm test
node scripts/check-page.mjs --live   # real Chrome, with the page served on port 5079
```

All tests should pass, with no network.

**6. Get the machine-readable packet**

```sh
node cli.js replay omni-665 --json
```

You should see the verdict, the proven evidence, a timeline and the open question. Exit codes let an agent gate on the answer before it retries or spends: `0` nothing to do, `2` someone must act, `3` not enough evidence, `1` bad input.

**7. Build a day's root**

```sh
node cli.js root fixtures --day 2026-11-06 --account sentinel.cryppit.testnet
```

You should see the Merkle root of the three packets and the `near` command to pin it. The tool prints that command and never runs it.

**8. Check it against the real pin**

These three recorded cases were pinned on NEAR testnet as the root for 6 Nov 2026. Read the pin back with a public view call. Its `merkle_root` should match the root step 7 printed, `88c6743c…71ccae`:

```sh
near contract call-function as-read-only sentinel.cryppit.testnet get_pin json-args '{"day":"2026-11-06"}' network-config testnet now
```

## How NEAR fits

- It reads NEAR Intents orders on `intents.near`, through FastNEAR and public RPCs.
- It reads Omni bridge transfers from the bridge's indexer, which can lag, then checks the chain: the destination contract on EVM chains, or the finishing transaction on Solana, Bitcoin and NEAR. Without a chain read, a status stays `REPORTED`.
- Each day's evidence packets form an RFC 6962 Merkle root that can be pinned on NEAR. With a packet and its proof from `node cli.js prove`, anyone can check by a public view call that it existed unchanged that day: `node cli.js verify`. A changed verdict or changed evidence fails.
- An agent can read a verdict before it retries a swap or re-sends funds.

## How a verdict is made

1. `src/adapters/` read public sources into legs and evidence.
2. `src/rules.js` runs fixed rules in a fixed order. No LLM decides anything. A proven payout on one leg never closes a case while another leg is open or unproven. Some rules, such as the Chainflip ones, wait for adapters that don't exist yet.
3. `src/verdict.js` builds the verdict and its hash. `computedAt` is the latest chain event, not the clock.

Every fact has an evidence class:

| Class | Meaning |
|---|---|
| `PROVEN` | A chain transaction, receipt or contract view shows it |
| `REPORTED` | A provider said so |
| `INFERRED` | The facts line up, but nothing proves the link |
| `UNKNOWN` | Someone has to answer |
| `NOT_VISIBLE` | A confidential leg, which only its owner can read |

## Limits

- It covers NEAR Intents orders and Omni transfers. It doesn't yet trace Chainflip's payout side, so such a leg stays unknown.
- A confidential leg is never guessed at, and private halves are never paired by amount or time.
- 1Click status is a claim, held in memory only. For a deposit address it also finds the NEAR order, and the case then rests on what the chain shows. Only the claim's category is kept. Every NEAR order read also fetches 1Click's public token list, which carries nothing about the order.
- Solana reads try two browser-friendly public endpoints first, then `api.mainnet-beta`, which refuses web pages. An empty answer only counts as missing if every endpoint answered.
- Amounts are checked on the NEAR ledger only, and only with no swap. Otherwise the case says they weren't checked.
- A failed lookup is reported as that. It never reads as success.
- It names who acts next, not who is to blame.

## The pin contract

`anchor/contract/` is the Rust contract a daily root is pinned to. It uses no near-sdk, it only accepts closed UTC days, and only its own account can pin. To check a deployed copy against this source:

```sh
cd anchor/contract
cargo test
./build.sh --check
```

`build.sh` prints the `code_hash`, which should match the code hash NEAR reports for the account. It needs the toolchain in `rust-toolchain.toml`. For this build the hash is `3QSdwkCACfL4aUB86WubohbgXNGhQgVa9whBu7dmGADx`.

This build is deployed on NEAR testnet at `sentinel.cryppit.testnet` (deploy transaction [`FqrARU6H…`](https://explorer.testnet.near.org/transactions/FqrARU6HjDUsHk1qUzz4CFRLiWM5P7y72j3kjioZPHSC)), and NEAR reports the same code hash for it. The first pin is 6 Nov 2026 (pin transaction [`GW6MLNNS…`](https://explorer.testnet.near.org/transactions/GW6MLNNSiztTC11haCkzyK2wy62JwtRKsu2zbh6gdAi9)): root `88c6743c2cfa00d7bfd01a34b24dd59a7142deac90159b46d57118914671ccae`, 3 packets, block 276,738,185.

## What existed before, and what is new

Per NEAR HACKATHON Q-002, Q-003 and Q-005:

- **Existing, declared baseline:** `vendor/wms-core.mjs`, the order tracer from [Where's My Swap](https://github.com/cryppit/wheres-my-swap) at `76cac26` (MIT). `anchor/contract/`, the pin contract, written 3 to 14 Oct 2026 for Cryppit's earlier NEAR anchor work, and now published under MIT. In this repo its source metadata points here and it has been rebuilt, with no change to its rules. The Merkle tree design comes from the same work.
- **New in this repo:** everything else, including the identifiers, evidence model, rules, verdict and hash, adapters, case builder, evidence packet, daily root, CLI, page and recorded cases.

AI coding tools were used to build it, under the founder's direction.

## Licence

MIT. See `LICENSE` and `NOTICE.md`.
