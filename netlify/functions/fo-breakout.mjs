import { getToday } from "../../lib/candles.mjs";

// GET /api/fo-breakout?symbols=RELIANCE,SBIN,NIFTY,...   (up to 50 per call)
// Opening-range breakout on the latest session, for every F&O stock / index the page asks for:
//   1. The first 15-minute candle (9:15–9:30) sets the range: its high and low.
//   2. The first 5-minute candle after it (9:30–9:35) is the trigger candle.
//      Close ABOVE the 15m high -> bullish trigger; close BELOW the 15m low -> bearish trigger.
//   3. If that candle closes inside the range, the first later 5m close outside it is reported as a
//      "later breakout" (until 2:45 pm).
// Candles are Yahoo Finance 5-minute candles (anchored at 9:15 IST, like NSE / TradingView).

const IST = 19800;
const OPEN = 9 * 60 + 15, OR_END = 9 * 60 + 30, LAST_ENTRY = 14 * 60 + 45, CLOSE = 15 * 60 + 30;
const MAX = 50;
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const minOf = (ts) => Math.floor(((ts + IST) % 86400) / 60);
const dayOf = (ts) => Math.floor((ts + IST) / 86400);
const isoDay = (ts) => new Date((ts + IST) * 1000).toISOString().slice(0, 10);

function analyse(bars, quote, nowSec) {
  if (!bars.length) return { status: "NO_DATA" };
  const day = dayOf(bars[bars.length - 1].t);
  const today = bars.filter((b) => dayOf(b.t) === day && minOf(b.t) >= OPEN && minOf(b.t) < CLOSE);
  const done = (b) => nowSec >= b.t + 300;
  const ltp = quote.ltp ?? today.at(-1)?.c;
  const prev = quote.prevClose;
  const base = {
    date: isoDay(bars[bars.length - 1].t), ltp: r2(ltp), prevClose: r2(prev),
    chg: prev ? r2(((ltp - prev) / prev) * 100) : null, pts: prev ? r2(ltp - prev) : null,
    dayHigh: r2(quote.dayHigh), dayLow: r2(quote.dayLow),
  };
  const or = today.filter((b) => minOf(b.t) < OR_END);
  if (!or.length) return { ...base, status: "WAIT_15M" };
  const high = Math.max(...or.map((b) => b.h)), low = Math.min(...or.map((b) => b.l));
  const orVol = or.reduce((a, b) => a + b.v, 0);
  const range = { high: r2(high), low: r2(low), open: r2(or[0].o), close: r2(or.at(-1).c), rangePct: r2(((high - low) / low) * 100) };
  const orDone = or.length >= 3 && done(or.at(-1)) || today.some((b) => minOf(b.t) >= OR_END);
  if (!orDone) return { ...base, range, status: "WAIT_15M" };

  const after = today.filter((b) => minOf(b.t) >= OR_END);
  const first = after[0];
  const side = (c) => (c > high ? "BULL" : c < low ? "BEAR" : null);
  const gap = (c, s) => r2(s === "BULL" ? ((c - high) / high) * 100 : ((low - c) / low) * 100);
  const res = { ...base, range };

  // No 9:30 candle yet (Yahoo hasn't published it): judge the forming candle from the live price.
  if (!first) return { ...res, status: "WAIT_5M", forming: side(ltp) };
  if (!done(first)) {
    return { ...res, status: "WAIT_5M", candle: { t: first.t, o: r2(first.o), h: r2(first.h), l: r2(first.l), c: r2(first.c) }, forming: side(first.c) };
  }
  const s1 = side(first.c);
  res.candle = { t: first.t, o: r2(first.o), h: r2(first.h), l: r2(first.l), c: r2(first.c), volX: orVol ? r2(first.v / (orVol / 3)) : null };
  if (s1) {
    res.status = s1;
    res.trigger = { side: s1, t: first.t + 300, price: r2(first.c), beyondPct: gap(first.c, s1), first: true };
  } else {
    res.status = "INSIDE";
    // First later 5m close outside the range, up to the last entry time.
    const later = after.slice(1).find((b) => done(b) && minOf(b.t) + 5 <= LAST_ENTRY && side(b.c));
    if (later) {
      const s = side(later.c);
      res.trigger = { side: s, t: later.t + 300, price: r2(later.c), beyondPct: gap(later.c, s), first: false, volX: orVol ? r2(later.v / (orVol / 3)) : null };
    } else {
      const last = after.at(-1);
      if (!done(last)) res.forming = side(last.c);
    }
  }
  if (res.trigger) {
    const t = res.trigger;
    const since = after.filter((b) => b.t + 300 > t.t);
    const best = t.side === "BULL" ? Math.max(t.price, ...since.map((b) => b.h)) : Math.min(t.price, ...since.map((b) => b.l));
    t.movePct = r2(t.side === "BULL" ? ((ltp - t.price) / t.price) * 100 : ((t.price - ltp) / t.price) * 100);
    t.bestPct = r2(t.side === "BULL" ? ((best - t.price) / t.price) * 100 : ((t.price - best) / t.price) * 100);
    // Back inside / through the other side of the 15m range since the trigger.
    t.failed = t.side === "BULL" ? ltp < low : ltp > high;
    t.backInside = !t.failed && (t.side === "BULL" ? ltp <= high : ltp >= low);
  }
  return res;
}

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const symbols = [...new Set((p.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-]{1,20}$/.test(s)))].slice(0, MAX);
  if (!symbols.length) return Response.json({ error: "Pass ?symbols=RELIANCE,SBIN,..." }, { status: 400 });
  const nowSec = Math.floor(Date.now() / 1000);
  const results = {};
  let next = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (next < symbols.length) {
      const sym = symbols[next++];
      try {
        const { bars, quote } = await getToday(sym, "5m");
        results[sym] = analyse(bars, quote, nowSec);
      } catch {
        results[sym] = { status: "NO_DATA" };
      }
    }
  }));
  return Response.json({ updatedAt: new Date().toISOString(), nowSec, results }, {
    headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "public, max-age=15, stale-while-revalidate=10" },
  });
};

export const config = { path: "/api/fo-breakout" };
