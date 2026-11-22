import { ema, atr, rsi, macd, utBot, supertrend, sessionVwap, sma, istDate } from "./indicators.mjs";

// Scores one stock's candles and returns a BUY / SELL signal, or null.
// A signal is triggered by a fresh UT Bot flip on the current session and must be
// confirmed by at least `minConfirm` of six other indicators.
export function evaluate(candles, opts = {}) {
  const { keyValue = 1, atrPeriod = 10, minConfirm = 5, lookback = 3, intraday = true } = opts;
  const { t, o, h, l, c, v } = candles;
  const n = c.length;
  if (n < 60) return null;

  const ut = utBot(h, l, c, keyValue, atrPeriod);
  const st = supertrend(h, l, c, 10, 3);
  const vwap = sessionVwap(h, l, c, v, t);
  const e9 = ema(c, 9);
  const e21 = ema(c, 21);
  const r = rsi(c, 14);
  const m = macd(c);
  const volAvg = sma(v, 20);
  const a = atr(h, l, c, 14);

  const last = n - 1;
  const today = istDate(t[last]);
  const side = ut.dir[last];
  if (!side) return null;

  // Find the most recent UT Bot flip into the current direction.
  let flip = -1;
  for (let i = last; i > last - lookback && i > 0; i--) {
    if (ut.dir[i] === side && ut.dir[i - 1] === -side) { flip = i; break; }
  }
  if (flip < 0) return null;
  // Intraday setups must come from today's session, not yesterday's close.
  if (intraday && istDate(t[flip]) !== today) return null;

  const isBuy = side === 1;
  const price = c[last];
  const rsiNow = r[last];
  const volRatio = volAvg[flip] ? Math.max(v[flip], v[last]) / volAvg[flip] : 0;

  const checks = [
    { name: "Supertrend", ok: st.dir[last] === side, value: st.line[last] },
    { name: "VWAP", ok: isBuy ? price > vwap[last] : price < vwap[last], value: vwap[last] },
    { name: "EMA 9/21", ok: isBuy ? e9[last] > e21[last] : e9[last] < e21[last], value: e9[last] },
    { name: "RSI", ok: isBuy ? rsiNow >= 50 && rsiNow <= 75 : rsiNow <= 50 && rsiNow >= 25, value: rsiNow },
    { name: "MACD", ok: isBuy ? m.hist[last] > 0 : m.hist[last] < 0, value: m.hist[last] },
    { name: "Volume", ok: volRatio >= 1.2, value: volRatio },
  ];
  const score = checks.filter((x) => x.ok).length;
  if (score < minConfirm) return null;

  // Stop loss = UT Bot trailing stop, widened to at least 1×ATR(14) or 0.3% of price
  // so it doesn't sit inside normal candle noise.
  const risk = Math.max(Math.abs(price - ut.stop[last]), a[last], price * 0.003);
  const stop = isBuy ? price - risk : price + risk;
  const t1 = isBuy ? price + 1.5 * risk : price - 1.5 * risk;
  const t2 = isBuy ? price + 3 * risk : price - 3 * risk;

  return {
    side: isBuy ? "BUY" : "SELL",
    barsAgo: last - flip,
    score,
    entry: round(price),
    stopLoss: round(stop),
    target1: round(t1),
    target2: round(t2),
    riskPct: round((risk / price) * 100),
    trailingStop: round(ut.stop[last]),
    rsi: round(rsiNow),
    vwap: round(vwap[last]),
    volumeRatio: round(volRatio),
    checks: checks.map((x) => ({ name: x.name, ok: x.ok })),
    signalTime: t[flip],
    // Candles that start before 09:30 IST carry the opening gap and volatility.
    openingCandle: intraday && minuteOfDayIst(t[flip]) < 9 * 60 + 30,
    lastTime: t[last],
  };
}

function minuteOfDayIst(ts) {
  return Math.floor(((ts + 19800) % 86400) / 60);
}

function round(x) {
  return x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100;
}
