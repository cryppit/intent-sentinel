# Intent Sentinel

Paste one id from a stuck cross-chain swap. See what each step proves, and who has to act next.

Built at NEAR HACKATHON for the `security`, `open` and `defi` tracks. Live page: https://cryppit.github.io/intent-sentinel/

Our other, independent NEAR HACKATHON entry (rule Q-015) is **Where's My ZEC** (https://github.com/cryppit/wheres-my-zec),
which tells ZEC users where their coins went and, for stuck Omni bridge deposits, reads the refund deadline from NEAR's
Zcash light client. It links here for NEAR Intents swaps; the code bases are separate.

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
Only an Omni relayer (the bridge's operator) can approve Near:563760 for payout. Will it?
What to ask an Omni relayer: whether they will process this transfer, and when.

  Omni bridge: started, not finished (proven)
```

This is [Near-One/omni-bridge #665](https://github.com/Near-One/omni-bridge/issues/665): 0.02 ETH sent with `fee: "0"`. The approval step (`sign_transfer`) is `#[trusted_relayer]`, so only the bridge's relayer can run it and the sender can't finish it.

**3. Replay one where nothing is left to do**

```sh
node cli.js replay refund-5btc
```

You should see `Nobody needs to act`, `Amounts match at NEAR Intents`, and exit code 0. The NEAR ledger balances exactly: 500,014,578 in and out.

**4. Read a case live from public chains**

```sh
node cli.js check Near:563760
```

You should see the same answer as step 2, unless the transfer has moved since. Run it twice with `--json` and the fingerprint matches, because a verdict's time comes from the chain and not the clock. A new chain event or a 1Click claim changes the fingerprint. A source that can't be read gives exit code 3 and `We can't give an answer yet`, never a clean verdict.

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

You should see the verdict, the proven evidence, a timeline and the open question. Exit codes let an agent gate on the answer before it retries or spends: `0` nothing to do, `2` someone must act, `3` not enough evidence (also a valid ID that can't be checked on its own, such as a payout no record leads back from), `1` bad input.

**7. Build a day's root**

`pins/2026-11-06/` holds the three recorded cases' packets exactly as they were pinned on 6 Nov 2026.

```sh
node cli.js root pins/2026-11-06 --day 2026-11-06 --account sentinel.cryppit.testnet
```

You should see `root 88c6743c…71ccae` and the `near` command that pinned it. The tool prints that command and never runs it.

**8. Check a packet against the real pin on NEAR**

```sh
node cli.js prove pins/2026-11-06 refund-5btc > proof.json
node cli.js verify pins/2026-11-06/refund-5btc.json proof.json --account sentinel.cryppit.testnet --day 2026-11-06
```

You should see `the verdict is in the pinned root`, read by a public view call on NEAR testnet. Change any value in the packet and run `verify` again: it fails. The `near` CLI shows the same pin directly:

```sh
near contract call-function as-read-only sentinel.cryppit.testnet get_pin json-args '{"day":"2026-11-06"}' network-config testnet now
```

## How NEAR fits

- It reads NEAR Intents orders on `intents.near`, through FastNEAR and public RPCs. A payout through the HOT bridge to an EVM chain is proven from chain data: the nonce HOT logs when it burns the token on NEAR, `usedNonces` on HOT's payout contract, and the `withdraw` call itself, even when it's nested inside another call. HOT payouts to TON and Stellar are proven when HOT's indexer names the payout transaction and the chain read matches; when it names none, they stay unproven. A HOT payout of a TON token, such as USDT on TON, is proven when the transaction HOT names shows the receiver's own token wallet taking in exactly the amount HOT burned on NEAR, from HOT's token wallet, finished and not failed (read on toncenter).
- You can paste the payout transaction, the money arriving, which is the hash people most often hold. For a HOT payout, HOT's indexer names the NEAR transaction behind it, and the case is read from there. For a payout sent by NEAR Intents' own payout wallets, no public record leads back to the order, so it says so in plain words and asks for the transaction that sent the money, or the deposit address.
- An account used for several swaps shows one of them and says which. An account with too many transactions to read (thousands) can still be checked through one pasted withdrawal: its payout is checked on its own, and the case says the rest of the account wasn't read.
- Since 27 Oct 2026, 1Click swaps settle on NEAR's private shard. The case shows that step as `NOT_VISIBLE` ("settled privately") and never guesses what happened inside it. If the money came back out to a proven payout, the case is done. If it went in less than an hour ago, NEAR Intents is still settling it. If it never came back, only NEAR Intents and the signed-in owner can see it, so the owner is told to ask NEAR Intents support.
- It reads Omni bridge transfers from the bridge's indexer, which can lag, then checks the chain: the destination contract on EVM chains, or the finishing transaction on Solana, Bitcoin and NEAR. Without a chain read, a status stays `REPORTED`. A Fast Transfer, where a relayer pays the recipient before the bridge finishes, counts as finished, so nobody is told to act on a paid transfer; it's proven when its transaction moved the token to the recipient.
- Each day's evidence packets form an RFC 6962 Merkle root that can be pinned on NEAR. With a packet and its proof from `node cli.js prove`, anyone can check by a public view call that it existed unchanged that day: `node cli.js verify`. A changed verdict or changed evidence fails.
- An agent can read a verdict before it retries a swap or re-sends funds.

## How a verdict is made

1. `src/adapters/` read public sources into legs and evidence.
2. `src/rules.js` runs fixed rules in a fixed order. No LLM decides anything. A proven payout on one leg never closes a case while another leg is open or unproven. Some rules, such as the Chainflip ones, wait for adapters that don't exist yet. A payout not seen yet within an hour of the credit (three hours for Bitcoin and Zcash) reads as probably still on its way, with "check again in a few minutes". It is still not proven, so the case stays open.
3. `src/verdict.js` builds the verdict and its hash. `computedAt` is the latest chain event, not the clock.

Every fact has an evidence class:

| Class | Meaning |
|---|---|
| `PROVEN` | A chain transaction, receipt or contract view shows it |
| `REPORTED` | A provider said so |
| `INFERRED` | The facts line up, but nothing proves the link |
| `UNKNOWN` | Someone has to answer |
| `NOT_VISIBLE` | A confidential leg, which only its owner can read |

## Privacy

Nothing goes to a Cryppit server: the page is static, and what you paste goes from your browser to about 70 public services. They are blockchain servers (some run by community volunteers, such as `rpc.intea.rs` and `rpc.shitzuapes.xyz`, which see the order's NEAR Intents account), bridge records and block explorers. They also see the addresses and transactions the swap leads to.

- Any address you paste goes to 1Click (`1click.chaindefuser.com/v0/status`), not only a deposit address: a `0x…`, `bc1…` or `T…` address, or a `.near` name, even if it's your own wallet.
- The swap's NEAR withdrawal transactions, and a pasted transaction that may be a payout, go to NEAR Intents' bridge records, `bridge.chaindefuser.com` and `bridge-indexer.chaindefuser.com`, on the same web domain as 1Click.
- Every service sees your IP address, and the `Origin` header tells it the request came from this site. `no-referrer` only removes the `Referer` header.
- The page has no tracking and saves nothing in your browser, and its reads ask the browser not to keep answers in its cache. Use a VPN or Tor if that matters to you.

## Limits

- It covers NEAR Intents orders and Omni transfers. It doesn't yet trace Chainflip's payout side, so such a leg stays unknown.
- A confidential leg is never guessed at, and private halves are never paired by amount or time.
- Zcash payouts to a shielded address (`u1…`, `zs…`) are private by design. The bridge names a Zcash transaction, and the amount it put into the shielded pool is checked against the withdrawal, but who received it can't be seen. So the payout stays "likely, not proven" and the case ends with "not enough evidence".
- An Omni transfer to Solana or Bitcoin is read through the bridge's indexer. When the indexer is slow or has no record yet, there's no other read, so the payout stays unproven until the indexer catches up.
- A pasted payout transaction leads back to its order only for HOT payouts. For other bridges it's recognised by the public payout wallet that sent it (NEAR Intents' on EVM chains, Bitcoin, TRON and Solana, HOT's on EVM chains and Solana); a payout from any other wallet isn't recognised.
- A deposit or swap transaction from an account with thousands of transactions can't be matched to one swap; the case asks for the withdrawal or the deposit address instead.
- Some payouts aren't proven yet: HOT payouts to Gonka and to Solana, a second withdrawal to a NEAR account in the same order, and tokens the tracer doesn't recognise (for example USDC and USDT on Sui and Aptos). A HOT payout on TON or Stellar is proven only when HOT's indexer names the transaction. These stay unproven, never paid.
- XRP Ledger and Sui deposit transactions aren't searchable yet. Paste the NEAR transaction or the deposit address instead.
- 1Click status is a claim, held in memory only. For a deposit address it also finds the NEAR order, and the case then rests on what the chain shows. Only the claim's category is kept. Every NEAR order read also fetches 1Click's public token list, which carries nothing about the order.
- Solana reads try two browser-friendly public endpoints first, then `api.mainnet-beta`, which refuses web pages. An empty answer only counts as missing if every endpoint answered.
- Amounts are checked on the NEAR ledger only, and only with no swap. Otherwise the case says they weren't checked.
- A failed lookup is reported as that. It never reads as success.
- It names who acts next, not who is to blame.

## The pin contract

`anchor/contract/` is the Rust contract a daily root is pinned to. It uses no near-sdk, it only accepts closed UTC days, and only its own account can pin.

To check that the deployed contract is exactly the binary committed here, download it and compare. No build is needed:

```sh
near contract download-wasm regular sentinel.cryppit.testnet save-to-file deployed.wasm network-config testnet now
cmp deployed.wasm anchor/contract/res/station_anchor.wasm && echo identical
```

NEAR reports the code hash `3QSdwkCACfL4aUB86WubohbgXNGhQgVa9whBu7dmGADx` for the account: the sha256 of that file, written in base58.

To check the binary against this source, run the tests and rebuild:

```sh
cd anchor/contract
cargo test
./build.sh --check
```

`build.sh --check` gives the same code hash only when it builds in the same folder layout as the original build. Rust writes the source paths of the crates it compiles into the binary (for panic messages), so a build in another folder makes the same code with different path text and a different hash. It needs the toolchain in `rust-toolchain.toml`.

This build is deployed on NEAR testnet at `sentinel.cryppit.testnet` (deploy transaction [`FqrARU6H…`](https://explorer.testnet.near.org/transactions/FqrARU6HjDUsHk1qUzz4CFRLiWM5P7y72j3kjioZPHSC)), and NEAR reports the same code hash for it. The first pin is 6 Nov 2026 (pin transaction [`GW6MLNNS…`](https://explorer.testnet.near.org/transactions/GW6MLNNSiztTC11haCkzyK2wy62JwtRKsu2zbh6gdAi9)): root `88c6743c2cfa00d7bfd01a34b24dd59a7142deac90159b46d57118914671ccae`, 3 packets, block 276,738,185.

The account is locked. Its full-access key was deleted on 8 Nov 2026, so nobody, Cryppit included, can redeploy the contract, change it or move its funds. The only key left can call `pin` on this account and nothing else, with a 0.5 NEAR gas allowance. To check:

```sh
near account list-keys sentinel.cryppit.testnet network-config testnet now
```

## What existed before, and what is new

Per NEAR HACKATHON Q-002, Q-003 and Q-005:

- **Existing, declared baseline:** `vendor/wms-core.mjs`, the order tracer from [Where's My Swap](https://github.com/cryppit/wheres-my-swap) at `76cac26` (MIT). `anchor/contract/`, the pin contract, written 3 to 14 Oct 2026 for Cryppit's earlier NEAR anchor work, and now published under MIT. In this repo its source metadata points here and it has been rebuilt, with no change to its rules. The Merkle tree design comes from the same work.
- **New in this repo:** everything else, including the identifiers, evidence model, rules, verdict and hash, adapters, case builder, evidence packet, daily root, CLI, page and recorded cases.

AI coding tools were used to build it, under the founder's direction.

## Licence

MIT. See `LICENSE` and `NOTICE.md`.
