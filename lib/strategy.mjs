import { ema, atr, rsi, macd, utBot, supertrend, sessionVwap, sma, adx, istDate } from "./indicators.mjs";

// Scores one stock's candles and returns a BUY / SELL setup, or null.
// Trigger: a fresh UT Bot flip. Confirmation: at least `minConfirm` of eight checks
// covering trend (Supertrend, VWAP, EMA 9/21), momentum (RSI, MACD, ADX, ROC) and volume.
export function evaluate(candles, opts = {}) {
  const { keyValue = 1, atrPeriod = 10, minConfirm = 6, lookback = 3, intraday = true } = opts;
  const { t, e, o, h, l, c, v } = candles;
  const n = c.length;
  if (n < 60) return null;

  const ut = utBot(h, l, c, keyValue, atrPeriod);
  const st = supertrend(h, l, c, 10, 3);
  const vwap = sessionVwap(h, l, c, v, t);
  const e9 = ema(c, 9);
  const e21 = ema(c, 21);
  const r = rsi(c, 14);
  const m = macd(c);
  const dmi = adx(h, l, c, 14);
  const volAvg = sma(v, 20);
  const a = atr(h, l, c, 14);

  const last = n - 1;
  const today = istDate(t[last]);
  const side = ut.dir[last];
  if (!side) return null;

  // Most recent UT Bot flip into the current direction.
  let flip = -1;
  for (let i = last; i > last - lookback && i > 0; i--) {
    if (ut.dir[i] === side && ut.dir[i - 1] === -side) { flip = i; break; }
  }
  if (flip < 0) return null;
  // Intraday setups must come from today's session, not yesterday's close.
  if (intraday && istDate(t[flip]) !== today) return null;

  const isBuy = side === 1;
  const dirOk = (x) => (isBuy ? x > 0 : x < 0);
  const price = c[last];
  const atrNow = a[last];

  // ---- Volume ----
  const volSpike = volAvg[flip] ? Math.max(v[flip], v[last]) / volAvg[flip] : 0;
  const rvol = intraday ? relativeVolume(t, v) : volAvg[last] ? v[last] / volAvg[last] : null;
  // Share of the last 20 candles' volume that traded on candles in the signal's direction.
  let withVol = 0, totVol = 0;
  for (let i = Math.max(0, n - 20); i < n; i++) {
    totVol += v[i];
    if (isBuy ? c[i] > o[i] : c[i] < o[i]) withVol += v[i];
  }
  const volPressure = totVol ? (withVol / totVol) * 100 : null;

  // ---- Momentum ----
  const rsiNow = r[last];
  const adxNow = dmi.adx[last];
  const diSpread = dmi.plusDI[last] - dmi.minusDI[last];
  const roc = c[last - 10] ? ((price - c[last - 10]) / c[last - 10]) * 100 : 0;
  const histRising = isBuy ? m.hist[last] > m.hist[last - 1] : m.hist[last] < m.hist[last - 1];

  const checks = [
    { name: "Supertrend", group: "trend", ok: st.dir[last] === side },
    { name: "VWAP", group: "trend", ok: dirOk(price - vwap[last]) },
    { name: "EMA 9/21", group: "trend", ok: dirOk(e9[last] - e21[last]) },
    { name: "RSI", group: "momentum", ok: isBuy ? rsiNow >= 50 && rsiNow <= 75 : rsiNow <= 50 && rsiNow >= 25 },
    { name: "MACD", group: "momentum", ok: dirOk(m.hist[last]) },
    { name: "ADX", group: "momentum", ok: adxNow >= 20 && dirOk(diSpread) },
    { name: "ROC", group: "momentum", ok: dirOk(roc) && histRising },
    { name: "Volume", group: "volume", ok: volSpike >= 1.2 && (rvol == null || rvol >= 1) },
  ];
  const score = checks.filter((x) => x.ok).length;
  if (score < minConfirm) return null;

  // ---- Momentum score (0–100) ----
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const momentum = Math.round(100 * (
    0.3 * clamp(((adxNow || 0) - 15) / 25) +
    0.25 * clamp(isBuy ? (rsiNow - 45) / 25 : (55 - rsiNow) / 25) +
    0.2 * clamp(Math.abs(diSpread) / 25) * (dirOk(diSpread) ? 1 : 0) +
    0.25 * clamp(((rvol ?? volSpike) - 0.8) / 1.7)
  ));

  // ---- Entry & exit plan ----
  // Stop = UT Bot trailing stop, widened to at least 1×ATR(14) or 0.3% of price.
  const risk = Math.max(Math.abs(price - ut.stop[last]), atrNow, price * 0.003);
  const stop = isBuy ? price - risk : price + risk;
  const t1 = isBuy ? price + 1.5 * risk : price - 1.5 * risk;
  const t2 = isBuy ? price + 3 * risk : price - 3 * risk;
  // Entry zone: from the signal close back toward EMA 9 (max 0.5×ATR). Better fills than chasing.
  const pullback = isBuy ? Math.max(e9[last], price - 0.5 * atrNow) : Math.min(e9[last], price + 0.5 * atrNow);
  const zone = isBuy ? [Math.min(pullback, price), price] : [price, Math.max(pullback, price)];
  // Chasing warning: price stretched more than 1.5×ATR away from EMA 9.
  const extended = Math.abs(price - e9[last]) > 1.5 * atrNow;
  const fading = isBuy
    ? rsiNow > 75 || (m.hist[last] < m.hist[last - 1] && m.hist[last - 1] < m.hist[last - 2])
    : rsiNow < 25 || (m.hist[last] > m.hist[last - 1] && m.hist[last - 1] > m.hist[last - 2]);

  return {
    side: isBuy ? "BUY" : "SELL",
    barsAgo: last - flip,
    score,
    maxScore: checks.length,
    entry: round(price),
    entryZone: zone.map(round),
    stopLoss: round(stop),
    target1: round(t1),
    target2: round(t2),
    riskPct: round((risk / price) * 100),
    trailingStop: round(ut.stop[last]),
    rsi: round(rsiNow),
    adx: round(adxNow),
    roc: round(roc),
    vwap: round(vwap[last]),
    volumeRatio: round(volSpike),
    rvol: round(rvol),
    volPressure: round(volPressure),
    momentum,
    extended,
    fading,
    checks: checks.map((x) => ({ name: x.name, group: x.group, ok: x.ok })),
    turnoverCr: round(avgTurnoverCr(t, c, v, intraday)),
    signalTime: t[flip],
    entryTime: e?.[last] ?? t[last],
    // Candles that start before 09:30 IST carry the opening gap and volatility.
    openingCandle: intraday && minuteOfDayIst(t[flip]) < 9 * 60 + 30,
    lastTime: t[last],
  };
}

// Today's volume so far vs the average volume traded by the same time of day on previous sessions.
function relativeVolume(t, v) {
  const last = t.length - 1;
  const cutoff = minuteOfDayIst(t[last]);
  const byDay = new Map();
  for (let i = 0; i < t.length; i++) {
    if (minuteOfDayIst(t[i]) > cutoff) continue;
    const d = istDate(t[i]);
    byDay.set(d, (byDay.get(d) || 0) + v[i]);
  }
  const today = istDate(t[last]);
  const past = [...byDay.entries()].filter(([d]) => d !== today).slice(-10).map(([, x]) => x).filter((x) => x > 0);
  if (!past.length) return null;
  const avg = past.reduce((s, x) => s + x, 0) / past.length;
  return avg ? (byDay.get(today) || 0) / avg : null;
}

// Average daily traded value (₹ crore) over up to the last 20 complete sessions.
// Used to skip illiquid stocks, where intraday fills and stop losses are unreliable.
export function avgTurnoverCr(t, c, v, intraday = true) {
  const n = c.length;
  if (!intraday) {
    let sum = 0, k = 0;
    for (let i = Math.max(0, n - 20); i < n; i++) { sum += c[i] * v[i]; k++; }
    return k ? sum / k / 1e7 : 0;
  }
  const byDay = new Map();
  for (let i = 0; i < n; i++) {
    const d = istDate(t[i]);
    byDay.set(d, (byDay.get(d) || 0) + c[i] * v[i]);
  }
  const today = istDate(t[n - 1]);
  let days = [...byDay.entries()].filter(([d]) => d !== today).map(([, x]) => x);
  if (!days.length) days = [byDay.get(today) || 0];
  days = days.slice(-20);
  return days.reduce((s, x) => s + x, 0) / days.length / 1e7;
}

function minuteOfDayIst(ts) {
  return Math.floor(((ts + 19800) % 86400) / 60);
}

function round(x) {
  return x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100;
}

// Current UT Bot state for one stock, whatever the confirmations: direction, when the last
// flip happened, and the full setup evaluated from that flip. Used by "Check a stock".
export function utState(candles, opts = {}) {
  const { keyValue = 1, atrPeriod = 10 } = opts;
  const { t, h, l, c } = candles;
  const n = c.length;
  if (n < 60) return null;
  const ut = utBot(h, l, c, keyValue, atrPeriod);
  const last = n - 1;
  let flip = -1;
  for (let i = last; i > 0; i--) if (ut.dir[i] !== ut.dir[i - 1] && ut.dir[i - 1]) { flip = i; break; }
  // Closest the price came to flipping since the last signal (as % of price).
  let closest = Infinity, closestTime = null;
  for (let i = Math.max(flip, 1); i <= last; i++) {
    const gap = (Math.abs(c[i] - ut.stop[i]) / c[i]) * 100;
    if (gap < closest) { closest = gap; closestTime = t[i]; }
  }
  const setup = flip >= 0 ? evaluate(candles, { ...opts, minConfirm: 0, lookback: last - flip + 1, intraday: false }) : null;
  return {
    side: ut.dir[last] === 1 ? "BUY" : "SELL",
    lastFlipTime: flip >= 0 ? t[flip] : null,
    barsSinceFlip: flip >= 0 ? last - flip : null,
    close: round(c[last]),
    trailingStop: round(ut.stop[last]),
    closestGapPct: Number.isFinite(closest) ? round(closest) : null,
    closestTime,
    lastTime: t[last],
    setup,
  };
}
