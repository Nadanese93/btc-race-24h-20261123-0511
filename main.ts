// BTC race bot: slow trend rider for CBBTC/USDC, 1-minute bars.
//
// Strategy (designed from the dev-window data, 1440 bars, +3.64% drift,
// ~8 bps/min noise, ~26 bps full round-trip cost):
//   * 1-minute noise dominates, so every fast signal whipsaws itself to
//     death. This bot only trades slow, confirmed trend:
//     - EMA(20) vs EMA(60) of closes with a 0.3% hysteresis band, and
//     - a 60-bar Donchian breakout (close above the last 60 highs) with
//       a 60-bar return above +0.5%.
//   * Entry (flat only): either signal fires -> buy 100% of cash.
//     After a stop-loss exit, no re-entry for 180 bars (cooldown).
//   * Exit (long only): hard stop at entry - 1.5%, or EMA(20) crossing
//     back below EMA(60) x (1 - 0.3%). Sell the full position.
//   * One position max, full size, max_slippage_bps 100.
//   * Fully deterministic: every decision is a pure function of the bars
//     in the hello/batch stream. No clock, no env, no files, no random.
//
// Wire: agent-fun/bars-replay/v1 via the vendored SDK shim (hello, batch,
// orders, bar). One reply per batch, echoing its seq.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Indicator periods (in 1-minute bars).
const FAST_PERIOD = 20;
const SLOW_PERIOD = 60;
const BAND_BPS = 30; // 0.3% hysteresis band on the EMA cross.
const BREAKOUT_BARS = 60; // Donchian lookback.
const BREAKOUT_RET_BPS = 50; // 0.5% minimum 60-bar return for a breakout.
const STOP_BPS = 150; // 1.5% hard stop below the entry fill price.
const COOLDOWN_BARS = 180; // bars to wait after a stop-loss exit.
const MAX_SLIPPAGE_BPS = 100;

let barsSeen = 0;
let emaFast: number | null = null;
let emaSlow: number | null = null;
let prevFast: number | null = null;
let prevSlow: number | null = null;
// Ring buffers of raw closes/highs (numbers; raw price units, scale cancels).
const closes: number[] = [];
const highs: number[] = [];
let entryPrice: number | null = null; // raw fill price of the open position.
let lastStopBar = -1_000_000;

function pushRing(buf: number[], v: number, cap: number): void {
  buf.push(v);
  if (buf.length > cap) buf.shift();
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    // Fold fills first: a buy fill sets our entry price for the stop.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL || f.status !== 'filled') continue;
      if (f.side === 'buy') {
        entryPrice = Number(f.price);
      } else if (f.side === 'sell') {
        entryPrice = null;
      }
    }
    if (bar === undefined) return [];
    if (state.warmingUp) {
      // Warm-up bars build history but cannot trade; still update indicators.
    }

    const close = Number(bar.c);
    const high = Number(bar.h);
    barsSeen += 1;

    // Update EMAs from the previous values (seed on the first bar).
    prevFast = emaFast;
    prevSlow = emaSlow;
    if (emaFast === null) {
      emaFast = close;
    } else {
      const kFast = 2 / (FAST_PERIOD + 1);
      emaFast = close * kFast + emaFast * (1 - kFast);
    }
    if (emaSlow === null) {
      emaSlow = close;
    } else {
      const kSlow = 2 / (SLOW_PERIOD + 1);
      emaSlow = close * kSlow + emaSlow * (1 - kSlow);
    }

    // Indicator history is updated on EVERY bar, before any decision or
    // gate: the breakout lookback must span the previous 60 bars even
    // while flat-but-waiting, warming up, or holding a position.
    pushRing(highs, high, BREAKOUT_BARS + 1);
    pushRing(closes, close, BREAKOUT_BARS + 1);

    const pos = state.positions.get(SYMBOL);
    const qty = pos?.qty ?? 0n;
    const bandUp = emaSlow * (1 + BAND_BPS / 10_000);
    const bandDown = emaSlow * (1 - BAND_BPS / 10_000);

    if (qty > 0n) {
      // --- In a position: exits only. ---
      if (entryPrice !== null && close <= entryPrice * (1 - STOP_BPS / 10_000)) {
        lastStopBar = state.seq;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      if (
        prevFast !== null &&
        prevSlow !== null &&
        emaFast < bandDown &&
        prevFast >= prevSlow * (1 - BAND_BPS / 10_000)
      ) {
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // --- Flat: entries only. ---
    if (state.warmingUp) return [];
    if (barsSeen < SLOW_PERIOD + 2) return [];
    if (state.seq - lastStopBar < COOLDOWN_BARS) return [];

    const emaCrossUp =
      prevFast !== null &&
      prevSlow !== null &&
      emaFast > bandUp &&
      prevFast <= prevSlow * (1 + BAND_BPS / 10_000);

    let breakout = false;
    // Lookback is the previous 60 bars: everything in the ring except
    // the bar just pushed.
    if (highs.length > BREAKOUT_BARS) {
      const prevHigh = Math.max(...highs.slice(0, highs.length - 1));
      const close60ago = closes[closes.length - 1 - BREAKOUT_BARS];
      const ret60 = close / close60ago - 1;
      breakout = close > prevHigh && ret60 > BREAKOUT_RET_BPS / 10_000;
    }

    if (emaCrossUp || breakout) {
      const cash = state.cash;
      if (cash <= 0n) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
