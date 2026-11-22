import { getLive } from "../../lib/candles.mjs";

const MAX_TRADES = 60;

// Follows a trade minute by minute from its entry time using today's 1-minute candles.
// Plan: stop loss until Target 1; after Target 1 the stop moves to entry (breakeven) and the
// rest rides to Target 2. If a candle touches both stop and target, the stop is assumed first.
function track(bars, trade) {
  const { side, entry, stop, t1, t2, from } = trade;
  const isBuy = side === "BUY";
  const hitUp = (b, x) => (isBuy ? b.h >= x : b.l <= x);
  const hitDown = (b, x) => (isBuy ? b.l <= x : b.h >= x);
  let status = "OPEN", at = null, best = entry;
  for (const b of bars) {
    if (b.t < from) continue;
    best = isBuy ? Math.max(best, b.h) : Math.min(best, b.l);
    if (status === "OPEN") {
      if (hitDown(b, stop)) { status = "SL HIT"; at = b.t; break; }
      if (hitUp(b, t1)) { status = "T1 HIT"; at = b.t; }
    }
    if (status === "T1 HIT") {
      if (hitUp(b, t2)) { status = "T2 HIT"; at = b.t; break; }
      if (b.t !== at && hitDown(b, entry)) { status = "T1 HIT · EXIT AT COST"; at = b.t; break; }
    }
  }
  const bestMovePct = ((isBuy ? best - entry : entry - best) / entry) * 100;
  return { status, statusTime: at, bestMovePct: Math.round(bestMovePct * 100) / 100 };
}

// GET /api/live?trades=SYM,side,entry,stop,t1,t2,fromTs;SYM,...
// or  /api/live?symbols=SYM,SYM  (quotes only)
export default async (req) => {
  const p = new URL(req.url).searchParams;
  const num = (x) => (Number.isFinite(parseFloat(x)) ? parseFloat(x) : null);
  const trades = (p.get("trades") || "").split(";").map((row) => {
    const [symbol, side, entry, stop, t1, t2, from] = row.split(",");
    return { symbol: symbol?.trim().toUpperCase(), side, entry: num(entry), stop: num(stop), t1: num(t1), t2: num(t2), from: num(from) || 0 };
  }).filter((x) => x.symbol && /^[A-Z0-9&\-]{1,20}$/.test(x.symbol) && ["BUY", "SELL"].includes(x.side) && x.entry && x.stop && x.t1 && x.t2);
  const plain = (p.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-]{1,20}$/.test(s));
  const items = [...trades, ...plain.map((symbol) => ({ symbol }))].slice(0, MAX_TRADES);
  if (!items.length) return Response.json({ error: "Pass ?trades= or ?symbols=" }, { status: 400 });

  const results = {};
  await Promise.all(items.map(async (item) => {
    try {
      const { bars, quote } = await getLive(item.symbol);
      results[item.symbol] = { quote, ...(item.side ? track(bars, item) : {}) };
    } catch {
      results[item.symbol] = { error: true };
    }
  }));

  return Response.json({ updatedAt: new Date().toISOString(), results }, {
    headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "public, max-age=10" },
  });
};

export const config = { path: "/api/live" };
