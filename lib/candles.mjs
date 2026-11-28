// Fetches NSE candles and resamples them to TradingView-style timeframes.
// NSE session: 09:15–15:30 IST. Intraday candles are anchored at 09:15, as on TradingView.

const IST = 19800;
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;

// target timeframe -> [Yahoo base interval, history range, minutes per candle]
export const TIMEFRAMES = {
  "1m": ["1m", "5d", 1],
  "2m": ["1m", "5d", 2],
  "3m": ["1m", "5d", 3],
  "5m": ["5m", "1mo", 5],
  "10m": ["5m", "1mo", 10],
  "15m": ["15m", "1mo", 15],
  "30m": ["15m", "1mo", 30],
  "45m": ["15m", "1mo", 45],
  "1h": ["1h", "3mo", 60],
  "75m": ["15m", "1mo", 75],
  "2h": ["1h", "6mo", 120],
  "4h": ["1h", "6mo", 240],
  "1d": ["1d", "1y", 0],
  "1wk": ["1wk", "5y", 0],
};

export const isIntraday = (tf) => TIMEFRAMES[tf][2] > 0;

// F&O indices -> Yahoo Finance index symbols (stocks are SYMBOL.NS).
export const INDEX_YAHOO = { NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", FINNIFTY: "NIFTY_FIN_SERVICE.NS", MIDCPNIFTY: "NIFTY_MID_SELECT.NS", NIFTYNXT50: "^NSMIDCP" };

async function fetchYahoo(symbol, interval, range) {
  const path = `/v8/finance/chart/${encodeURIComponent(INDEX_YAHOO[symbol] || symbol + ".NS")}?interval=${interval}&range=${range}`;
  let res;
  // Try the second Yahoo host if the first one is rate-limiting or failing.
  for (const host of ["query1", "query2"]) {
    res = await fetch(`https://${host}.finance.yahoo.com${path}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
    if (res.ok) break;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const result = data.chart?.result?.[0];
  const q = result?.indicators?.quote?.[0];
  if (!q || !result.timestamp) throw new Error("no data");
  const bars = [];
  result.timestamp.forEach((ts, i) => {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null || q.open[i] == null) return;
    bars.push({ t: ts, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  });
  return { bars: /^\d+[mh]$/.test(interval) ? dropClosingPrint(bars) : bars, quote: toQuote(result.meta) };
}

// Yahoo adds NSE's official closing price (the 3:00–3:30 pm weighted average) as a flat
// one-price candle at about 15:28. It isn't a real trade, and TradingView doesn't draw it,
// so it would shift the last candle's close, RSI, MACD and UT Bot away from TradingView.
// It is recognised as the day's last candle, starting at or after 15:15, with open = high = low = close.
function dropClosingPrint(bars) {
  const day = (b) => Math.floor((b.t + IST) / 86400);
  return bars.filter((b, i) => {
    const min = Math.floor(((b.t + IST) % 86400) / 60);
    const lastOfDay = i === bars.length - 1 || day(bars[i + 1]) !== day(b);
    return !(lastOfDay && min >= 15 * 60 + 15 && b.o === b.h && b.h === b.l && b.l === b.c);
  });
}

// Live quote from Yahoo's chart metadata (last traded price, day change, day range, day volume).
function toQuote(m = {}) {
  const prev = m.previousClose ?? m.chartPreviousClose;
  const ltp = m.regularMarketPrice;
  return {
    ltp,
    changePct: m.regularMarketChangePercent ?? (prev ? ((ltp - prev) / prev) * 100 : null),
    prevClose: prev,
    dayHigh: m.regularMarketDayHigh,
    dayLow: m.regularMarketDayLow,
    dayVolume: m.regularMarketVolume,
    time: m.regularMarketTime,
  };
}

// Latest session's raw candles at one Yahoo interval (e.g. today's 5-minute candles, incl. the forming one).
export async function getToday(symbol, interval = "5m") {
  return fetchYahoo(symbol, interval, "1d");
}

// Live quote plus today's 1-minute candles, used to track open trades.
export async function getLive(symbol) {
  return fetchYahoo(symbol, "1m", "1d");
}

// Groups base bars into N-minute candles anchored at 09:15 IST each day.
// The last candle of the day is cut at 15:30, like TradingView (e.g. 75m -> five candles, 4h -> 09:15 & 13:15).
function resample(bars, minutes, nowSec, confirmedOnly) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const local = b.t + IST;
    const dayStart = local - (local % 86400);
    const minOfDay = Math.floor((local % 86400) / 60);
    if (minOfDay < OPEN_MIN || minOfDay >= CLOSE_MIN) continue;
    const slot = Math.floor((minOfDay - OPEN_MIN) / minutes);
    const start = dayStart + (OPEN_MIN + slot * minutes) * 60 - IST;
    const end = Math.min(start + minutes * 60, dayStart + CLOSE_MIN * 60 - IST);
    if (!cur || cur.t !== start) {
      cur = { t: start, end, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v;
    }
  }
  if (confirmedOnly && out.length && out[out.length - 1].end > nowSec) out.pop();
  return out;
}

export async function getCandles(symbol, tf, { confirmedOnly = true, now = Date.now() } = {}) {
  const [base, range, minutes] = TIMEFRAMES[tf];
  const nowSec = Math.floor(now / 1000);
  let { bars, quote } = await fetchYahoo(symbol, base, range);

  if (minutes > 0) {
    bars = resample(bars, minutes, nowSec, confirmedOnly);
  } else if (confirmedOnly && bars.length) {
    // Daily/weekly: drop the candle that is still forming (today / this week).
    const last = bars[bars.length - 1];
    const local = last.t + IST;
    const dayStart = local - (local % 86400) - IST;
    const closesAt = dayStart + (tf === "1wk" ? 4 * 86400 : 0) + CLOSE_MIN * 60;
    if (nowSec < closesAt) bars.pop();
  }

  // e = time each candle closes (when a signal on it is confirmed and the trade can be entered).
  const out = { t: [], e: [], o: [], h: [], l: [], c: [], v: [], quote };
  for (const b of bars) {
    out.t.push(b.t); out.o.push(b.o); out.h.push(b.h); out.l.push(b.l); out.c.push(b.c); out.v.push(b.v);
    out.e.push(b.end ?? b.t);
  }
  return out;
}
