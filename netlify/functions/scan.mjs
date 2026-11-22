import { evaluate } from "../../lib/strategy.mjs";
import { getCandles, TIMEFRAMES, isIntraday } from "../../lib/candles.mjs";

const MAX_SYMBOLS = 60;

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const interval = TIMEFRAMES[p.get("interval")] ? p.get("interval") : "5m";
  const confirmedOnly = p.get("live") !== "1";
  const keyValue = Math.min(Math.max(parseFloat(p.get("keyValue")) || 1, 0.1), 10);
  const atrPeriod = Math.min(Math.max(parseInt(p.get("atrPeriod"), 10) || 10, 1), 100);
  const mc = parseInt(p.get("minConfirm"), 10);
  const minConfirm = Number.isNaN(mc) ? 5 : Math.min(Math.max(mc, 0), 6);
  const symbols = (p.get("symbols") || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-]{1,20}$/.test(s))
    .slice(0, MAX_SYMBOLS);

  if (!symbols.length) return Response.json({ error: "Pass ?symbols=RELIANCE,TCS,..." }, { status: 400 });

  const failed = [];
  const signals = [];
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const candles = await getCandles(symbol, interval, { confirmedOnly });
      const sig = evaluate(candles, { keyValue, atrPeriod, minConfirm, intraday: isIntraday(interval) });
      if (sig) signals.push({ symbol, ...sig });
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
