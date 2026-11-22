// Technical indicators used by the intraday scanner.
// All functions take plain arrays and return arrays aligned to the input.

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

export function trueRange(highs, lows, closes) {
  return closes.map((_, i) =>
    i === 0
      ? highs[i] - lows[i]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]))
  );
}

// Wilder's smoothed ATR (RMA)
export function atr(highs, lows, closes, period) {
  const tr = trueRange(highs, lows, closes);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const start = line.findIndex((v) => v != null);
  const sig = new Array(closes.length).fill(null);
  if (start >= 0) {
    const e = ema(line.slice(start), signal);
    e.forEach((v, j) => (sig[start + j] = v));
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

// UT Bot alert (ATR trailing stop). dir: 1 = long, -1 = short.
export function utBot(highs, lows, closes, keyValue = 1, atrPeriod = 10) {
  const a = atr(highs, lows, closes, atrPeriod);
  const stop = new Array(closes.length).fill(null);
  const dir = new Array(closes.length).fill(0);
  // Mirrors the TradingView "UT Bot Alerts" script: the stop starts from nz(prev, 0)
  // on the first bar where ATR is available.
  for (let i = atrPeriod - 1; i < closes.length; i++) {
    const nLoss = keyValue * a[i];
    const prevStop = stop[i - 1] ?? 0;
    const c = closes[i], p = i > 0 ? closes[i - 1] : c;
    if (c > prevStop && p > prevStop) stop[i] = Math.max(prevStop, c - nLoss);
    else if (c < prevStop && p < prevStop) stop[i] = Math.min(prevStop, c + nLoss);
    else if (c > prevStop) stop[i] = c - nLoss;
    else stop[i] = c + nLoss;
    dir[i] = c > stop[i] ? 1 : -1;
  }
  return { stop, dir };
}

// Supertrend. dir: 1 = up, -1 = down.
export function supertrend(highs, lows, closes, period = 10, multiplier = 3) {
  const a = atr(highs, lows, closes, period);
  const n = closes.length;
  const line = new Array(n).fill(null);
  const dir = new Array(n).fill(0);
  let upper = null, lower = null;
  for (let i = period - 1; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const bu = hl2 + multiplier * a[i];
    const bl = hl2 - multiplier * a[i];
    const prevClose = closes[i - 1] ?? closes[i];
    upper = upper == null || bu < upper || prevClose > upper ? bu : upper;
    lower = lower == null || bl > lower || prevClose < lower ? bl : lower;
    const prevDir = dir[i - 1] || 1;
    let d = prevDir;
    if (prevDir === -1 && closes[i] > upper) d = 1;
    else if (prevDir === 1 && closes[i] < lower) d = -1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

// Session VWAP, resetting each IST trading day.
export function sessionVwap(highs, lows, closes, volumes, timestamps) {
  const out = new Array(closes.length).fill(null);
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < closes.length; i++) {
    const d = istDate(timestamps[i]);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const v = volumes[i] || 0;
    pv += tp * v; vol += v;
    out[i] = vol > 0 ? pv / vol : tp;
  }
  return out;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function istDate(ts) {
  return new Date((ts + 19800) * 1000).toISOString().slice(0, 10);
}

// ADX / +DI / -DI (Wilder, 14) — trend strength and direction, as on TradingView.
export function adx(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = trueRange(highs, lows, closes);
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1], down = lows[i - 1] - lows[i];
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const rma = (arr) => {
    const out = new Array(n).fill(null);
    if (n <= period) return out;
    let sum = 0;
    for (let i = 1; i <= period; i++) sum += arr[i];
    out[period] = sum / period;
    for (let i = period + 1; i < n; i++) out[i] = (out[i - 1] * (period - 1) + arr[i]) / period;
    return out;
  };
  const atrS = rma(tr), pS = rma(plusDM), mS = rma(minusDM);
  const plusDI = atrS.map((a, i) => (a ? (100 * pS[i]) / a : null));
  const minusDI = atrS.map((a, i) => (a ? (100 * mS[i]) / a : null));
  const dx = plusDI.map((p, i) => (p == null ? null : p + minusDI[i] === 0 ? 0 : (100 * Math.abs(p - minusDI[i])) / (p + minusDI[i])));
  const out = new Array(n).fill(null);
  const start = period * 2 - 1;
  if (n > start) {
    let sum = 0;
    for (let i = period; i <= start; i++) sum += dx[i];
    out[start] = sum / period;
    for (let i = start + 1; i < n; i++) out[i] = (out[i - 1] * (period - 1) + dx[i]) / period;
  }
  return { adx: out, plusDI, minusDI };
}
