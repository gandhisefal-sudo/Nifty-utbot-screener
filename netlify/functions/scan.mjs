import { evaluate, utState } from "../../lib/strategy.mjs";
import { getCandles, TIMEFRAMES, isIntraday } from "../../lib/candles.mjs";
import { utBot, supertrend } from "../../lib/indicators.mjs";

// Higher timeframe used to confirm each signal's direction (roughly 3–5× the scanned one).
export const HIGHER_TF = { "1m": "5m", "2m": "10m", "3m": "15m", "5m": "15m", "10m": "30m", "15m": "1h", "30m": "2h", "45m": "4h", "1h": "4h", "75m": "1d", "2h": "1d", "4h": "1d", "1d": "1wk" };

// UT Bot and Supertrend direction on the higher timeframe.
async function higherTf(symbol, interval, opts) {
  const tf = HIGHER_TF[interval];
  if (!tf) return null;
  try {
    const k = await getCandles(symbol, tf, { confirmedOnly: opts.confirmedOnly });
    if (k.c.length < 30) return null;
    const ut = utBot(k.h, k.l, k.c, opts.keyValue, opts.atrPeriod);
    const st = supertrend(k.h, k.l, k.c, 10, 3);
    const last = k.c.length - 1;
    const side = (d) => (d === 1 ? "BUY" : d === -1 ? "SELL" : null);
    return { tf, ut: side(ut.dir[last]), supertrend: side(st.dir[last]) };
  } catch {
    return null;
  }
}

const MAX_SYMBOLS = 60;

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const interval = TIMEFRAMES[p.get("interval")] ? p.get("interval") : "5m";
  const confirmedOnly = p.get("live") !== "1";
  const keyValue = Math.min(Math.max(parseFloat(p.get("keyValue")) || 2, 0.1), 10);
  const atrPeriod = Math.min(Math.max(parseInt(p.get("atrPeriod"), 10) || 14, 1), 100);
  const mc = parseInt(p.get("minConfirm"), 10);
  const minConfirm = Number.isNaN(mc) ? 6 : Math.min(Math.max(mc, 0), 8);
  // How many candles back a UT Bot flip may be and still count as a signal (default: last 3).
  const lookback = Math.min(Math.max(parseInt(p.get("lookback"), 10) || 3, 1), 50);
  const inspect = p.get("inspect") === "1";
  // Skip stocks whose average daily traded value is below this (₹ crore). 0 = no filter.
  const minTurnover = Math.max(parseFloat(p.get("minTurnover")) || 0, 0);
  const symbols = (p.get("symbols") || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-]{1,20}$/.test(s))
    .slice(0, MAX_SYMBOLS);

  if (!symbols.length) return Response.json({ error: "Pass ?symbols=RELIANCE,TCS,..." }, { status: 400 });

  if (inspect) {
    const states = {};
    await Promise.all(symbols.slice(0, 5).map(async (symbol) => {
      try {
        const candles = await getCandles(symbol, interval, { confirmedOnly });
        const htf = await higherTf(symbol, interval, { confirmedOnly, keyValue, atrPeriod });
        states[symbol] = { ...utState(candles, { keyValue, atrPeriod, intraday: isIntraday(interval) }), htf, quote: candles.quote };
      } catch {
        states[symbol] = { error: "No data for this symbol. Use the NSE symbol, e.g. NESTLEIND." };
      }
    }));
    return Response.json({ interval, confirmedOnly, states }, { headers: { "Cache-Control": "no-store" } });
  }

  const failed = [];
  const signals = [];
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const candles = await getCandles(symbol, interval, { confirmedOnly });
      const sig = evaluate(candles, { keyValue, atrPeriod, minConfirm, lookback, intraday: isIntraday(interval) });
      if (sig && sig.turnoverCr >= minTurnover) {
        // Only stocks with a signal need the extra higher-timeframe fetch.
        const htf = await higherTf(symbol, interval, { confirmedOnly, keyValue, atrPeriod });
        if (htf) htf.agrees = htf.ut === sig.side && htf.supertrend === sig.side;
        signals.push({ symbol, ...sig, htf, quote: candles.quote });
      }
    } catch {
      failed.push(symbol);
    }
  }));

  return Response.json(
    { updatedAt: new Date().toISOString(), interval, confirmedOnly, scanned: symbols.length, failed, signals },
    { headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "public, max-age=30" } }
  );
};

export const config = { path: "/api/scan" };
