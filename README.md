# BTC Race Bot — Slow Trend Rider (CBBTC/USDC)

[![bounty](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/Nadanese93/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/Nadanese93/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A bot that races a BTC trading bot live for 24 hours on make.fun
(`btc-race-24h-20261123-0511`). It trades Coinbase Wrapped BTC (CBBTC)
against USDC, minute by minute, in the `agent-fun/bars-replay/v1`
protocol: one `hello`, one `batch` per 1-minute `bar`, one `reply` with
`orders` per batch. Long only, at most 1 open position, $1,000 USDC start.

## Strategy: slow trend rider

The dev window (1,440 1-minute bars, +3.64% drift, ~8 bps/min noise,
~26 bps per full round trip in fee + slippage + impact) punishes every
fast signal: plain EMA 5/13, 8/21 and 12/26 crosses lose $95–$147 on
whipsaw, and RSI mean-reversion loses $23–$36. The only structures that
survive are slow, confirmed trends with few trades. This bot trades
exactly two of them, full size:

- **Entry — either signal, flat only:**
  - *EMA cross with hysteresis:* EMA(20) crosses above EMA(60) ×
    (1 + 0.3%). The 0.3% band is what kills the whipsaw: without it
    the same cross loses money.
  - *Donchian breakout:* close breaks above the highest high of the
    previous 60 bars **and** the 60-bar return is above +0.5%.
  - After a stop-loss exit, no re-entry for 180 bars (cooldown).
- **Exit — long only, full position:**
  - Hard stop at entry −1.5% (entry = actual fill price from the
    batch's fills), or
  - EMA(20) crossing back below EMA(60) × (1 − 0.3%).
- **Sizing:** buy spends 100% of cash; sell sells the whole position.
  `max_slippage_bps` is 100 on every order.
- **Guards:** no trading during warm-up batches; entries need 62 bars
  of history; orders never exceed the caps; nothing is written to disk
  while running.

Indicator history (EMAs and the 60-bar high/close rings) is updated on
**every** bar before any decision — including warm-up bars, bars while
flat-but-waiting, and bars while holding — so the breakout lookback
always spans the true previous 60 bars.

## Dev-window result (official `grade-local`, `--driver process`)

Docker is not available in this environment, so the grade ran on the
process driver (same harness, same scorer, unisolated):

| metric | value |
| --- | --- |
| Net PnL (dev) | **+29,501,082 micro-USDC = +$29.50** (+2.95%) |
| Trades | 1 (buy at bar 86 on the breakout, held to the end) |
| Max drawdown | 1.98% (guardrail: ≤ 25%) |
| Fees | $0.81 |
| Rejected orders | 0 |
| `result_sha256` | `ce66e304348fd3b5294bea68ea424b0efb1c53987df4b9c12dfc984eec29eb8d` |
| `action_log_sha256` | `9064e301baa1d80ffeac5f5bbf825787074eac9ec1d00bbb98c50cdf1b39ff86` |

Two separate `grade-local` runs produce byte-identical
`result_sha256` / `action_log_sha256`: the bot is fully deterministic
(every decision is a pure function of the bars; no clock, no env, no
files, no randomness). The dev gate (net PnL > $0) passes with a
comfortable buffer. Buy-and-hold on the same window makes +$32.17, so
this bot captures ~92% of it while carrying a real entry rule, a
stop-loss, and an exit — protection a plain hold does not have if the
race window trends down (on the time-reversed dev window this bot
loses $18.00 vs buy-and-hold's −$37.84).

## How to run

```sh
# Grade locally (needs the kit next to this repo):
node <kit>/cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

The entrypoint is `main.ts`, run by the grader as `node /bot/main.ts`
(Node 22 type stripping, erasable syntax only). It speaks
`agent-fun/bars-replay/v1` through the vendored SDK shim in
`vendor/makefun-bars.ts` (a byte-for-byte copy of the kit's
`sdk/makefun-bars.ts`).

## Files

- `main.ts` — the bot (written from scratch in this session).
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK shim, copied
  byte-for-byte (excluded from authorship counts).
- `README.md` — this file.
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`).
- `.makefun/owner.json` — claim file for the entry wallet.
