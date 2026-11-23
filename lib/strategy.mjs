import { ema, atr, rsi, macd, utBot, supertrend, sessionVwap, sma, adx, istDate } from "./indicators.mjs";

// Scores one stock's candles and returns a BUY / SELL setup, or null.
// Trigger: a fresh UT Bot flip. Confirmation: at least `minConfirm` of eight checks
// covering trend (Supertrend, VWAP, EMA 9/21), momentum (RSI, MACD, ADX, ROC) and volume.
export function evaluate(candles, opts = {}) {
  const { keyValue = 1, atrPeriod = 10, minConfirm = 6, lookback = 3, intraday = true, sameDayTargets = intraday } = opts;
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
  // Confirmations and the trade plan are taken from the SIGNAL candle (as an alert at that candle's
  // close would have shown them), so an older signal keeps the entry, stop and targets it had then.
  const f = flip;
  const price = c[f];
  const atrNow = a[f];

  // ---- Volume ----
  const volSpike = volAvg[f] ? v[f] / volAvg[f] : 0;
  const rvol = intraday ? relativeVolume(t, v) : volAvg[last] ? v[last] / volAvg[last] : null;
  // Share of the 20 candles up to the signal that traded on candles in the signal's direction.
  let withVol = 0, totVol = 0;
  for (let i = Math.max(0, f - 19); i <= f; i++) {
    totVol += v[i];
    if (isBuy ? c[i] > o[i] : c[i] < o[i]) withVol += v[i];
  }
  const volPressure = totVol ? (withVol / totVol) * 100 : null;

  // ---- Momentum (at the signal candle) ----
  const rsiNow = r[f];
  const adxNow = dmi.adx[f];
  const diSpread = dmi.plusDI[f] - dmi.minusDI[f];
  const roc = c[f - 10] ? ((price - c[f - 10]) / c[f - 10]) * 100 : 0;
  const histRising = isBuy ? m.hist[f] > m.hist[f - 1] : m.hist[f] < m.hist[f - 1];

  const checks = [
    { name: "Supertrend", group: "trend", ok: st.dir[f] === side },
    { name: "VWAP", group: "trend", ok: dirOk(price - vwap[f]) },
    { name: "EMA 9/21", group: "trend", ok: dirOk(e9[f] - e21[f]) },
    { name: "RSI", group: "momentum", ok: isBuy ? rsiNow >= 50 && rsiNow <= 75 : rsiNow <= 50 && rsiNow >= 25 },
    { name: "MACD", group: "momentum", ok: dirOk(m.hist[f]) },
    { name: "ADX", group: "momentum", ok: adxNow >= 20 && dirOk(diSpread) },
    { name: "ROC", group: "momentum", ok: dirOk(roc) && histRising },
    { name: "Volume", group: "volume", ok: volSpike >= 1.2 && (f !== last || rvol == null || rvol >= 1) },
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

  // ---- Entry & exit plan (from the signal candle) ----
  const plan = planAt(ut, a, c, f, isBuy);
  const { stop, t1, t2, risk } = plan;
  // Entry zone: from the signal close back toward EMA 9 (max 0.5×ATR). Better fills than chasing.
  const pullback = isBuy ? Math.max(e9[f], price - 0.5 * atrNow) : Math.min(e9[f], price + 0.5 * atrNow);
  const zone = isBuy ? [Math.min(pullback, price), price] : [price, Math.max(pullback, price)];
  // Chasing warning (now): the latest price is stretched more than 1.5×ATR away from EMA 9.
  const extended = Math.abs(c[last] - e9[last]) > 1.5 * a[last];
  const fading = isBuy
    ? r[last] > 75 || (m.hist[last] < m.hist[last - 1] && m.hist[last - 1] < m.hist[last - 2])
    : r[last] < 25 || (m.hist[last] > m.hist[last - 1] && m.hist[last - 1] > m.hist[last - 2]);
  // What has happened since the signal on these candles (stop first if one candle hits both).
  const sinceSignal = walk(h, l, t, f, last, isBuy, plan, false);
  // How long targets have usually taken on this stock and timeframe, from its past UT Bot signals.
  const timing = targetTiming(ut, a, h, l, c, t, last, sameDayTargets);

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
    currentPrice: round(c[last]),
    barsSinceSignal: last - f,
    sinceSignal,
    timing,
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
    entryTime: e?.[f] ?? t[f],
    // Candles that start before 09:30 IST carry the opening gap and volatility.
    openingCandle: intraday && minuteOfDayIst(t[flip]) < 9 * 60 + 30,
    lastTime: t[last],
  };
}

// Stop = UT Bot trailing stop, widened to at least 1×ATR(14) or 0.3% of price.
// Target 1 = 1.5× risk, Target 2 = 3× risk.
function planAt(ut, a, c, i, isBuy) {
  const price = c[i];
  const risk = Math.max(Math.abs(price - ut.stop[i]), a[i] || 0, price * 0.003);
  const k = isBuy ? 1 : -1;
  return { price, risk, stop: price - k * risk, t1: price + k * 1.5 * risk, t2: price + k * 3 * risk };
}

// Follows a plan candle by candle after candle i. Intraday trades end at the session close.
function walk(h, l, t, i, last, isBuy, plan, sameDayOnly) {
  const up = (j, x) => (isBuy ? h[j] >= x : l[j] <= x);
  const down = (j, x) => (isBuy ? l[j] <= x : h[j] >= x);
  let status = "OPEN", t1At = null, endAt = null;
  for (let j = i + 1; j <= last; j++) {
    if (sameDayOnly && istDate(t[j]) !== istDate(t[i])) { if (status === "OPEN") status = "EXPIRED"; break; }
    if (status === "OPEN") {
      if (down(j, plan.stop)) { status = "SL HIT"; endAt = j; break; }
      if (up(j, plan.t1)) { status = "T1 HIT"; t1At = j; }
    }
    if (status === "T1 HIT") {
      if (up(j, plan.t2)) { status = "T2 HIT"; endAt = j; break; }
      if (j !== t1At && down(j, plan.price)) { status = "T1 HIT · EXIT AT COST"; endAt = j; break; }
    }
  }
  return {
    status,
    t1Candles: t1At != null ? t1At - i : null,
    t2Candles: status === "T2 HIT" ? endAt - i : null,
    t1Time: t1At != null ? t[t1At] : null,
    endTime: endAt != null ? t[endAt] : null,
  };
}

// Replays every earlier UT Bot flip in the loaded history with the same plan and reports how often
// and how quickly Target 1 / Target 2 were reached. Intraday trades must finish the same day.
function targetTiming(ut, a, h, l, c, t, last, intraday) {
  const t1 = [], t2 = [];
  let trades = 0, sl = 0;
  for (let i = 30; i < last; i++) {
    if (!ut.dir[i] || ut.dir[i] === ut.dir[i - 1] || !ut.dir[i - 1]) continue;
    const isBuy = ut.dir[i] === 1;
    const w = walk(h, l, t, i, last, isBuy, planAt(ut, a, c, i, isBuy), intraday);
    if (w.status === "OPEN") continue; // still running, no result yet
    trades++;
    if (w.status === "SL HIT") sl++;
    if (w.t1Candles != null) t1.push(w.t1Candles);
    if (w.t2Candles != null) t2.push(w.t2Candles);
  }
  const med = (x) => { if (!x.length) return null; const s = [...x].sort((p, q) => p - q); return s[s.length >> 1]; };
  return {
    trades,
    t1HitPct: trades ? Math.round((t1.length / trades) * 100) : null,
    t2HitPct: trades ? Math.round((t2.length / trades) * 100) : null,
    slHitPct: trades ? Math.round((sl / trades) * 100) : null,
    t1MedianCandles: med(t1),
    t2MedianCandles: med(t2),
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
  const setup = flip >= 0 ? evaluate(candles, { ...opts, minConfirm: 0, lookback: last - flip + 1, intraday: false, sameDayTargets: !!opts.intraday }) : null;
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
