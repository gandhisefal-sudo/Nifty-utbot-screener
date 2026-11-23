import { getSessions, getDeals, getPositioning, INSTITUTIONAL } from "../../lib/nse-daily.mjs";
import { NSE_EQUITIES } from "../../lib/nse-equities.mjs";

// GET /api/premarket            -> watchlist for the next session, built from NSE's end-of-day files
// GET /api/premarket?live=1     -> live "volume shocks": stocks trading far above their normal volume right now
//
// Nobody can see institutional orders before they are placed. What can be seen early is the footprint
// big money leaves: unusual volume, high delivery (shares actually taken home, not day-traded),
// tight ranges near a breakout, and disclosed bulk/block deals.

const BASELINE_DAYS = 15;
// Listed companies only: the bhavcopy's EQ series also contains ETFs, whose volume spikes are just fund flows.
const COMPANIES = new Set(NSE_EQUITIES.map((s) => s.symbol));
const r2 = (x) => Math.round(x * 100) / 100;
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
// Typical volume uses the median, so one earlier spike day doesn't hide the next one.
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function analyse(symbol, hist, dealInfo) {
  const L = hist[hist.length - 1];
  const base = hist.slice(0, -1);
  if (base.length < 5 || !L.vol || !L.prev) return null;
  const avgVol = median(base.map((b) => b.vol));
  const avgDeliv = median(base.map((b) => b.deliv));
  const avgDelPct = avg(base.map((b) => b.delivPct));
  const avgTurn = avg(base.map((b) => b.turnoverCr));
  const avgRange = avg(base.map((b) => (b.h - b.l) / (b.prev || b.c)));
  if (!avgVol || !avgRange) return null;

  const volX = L.vol / avgVol;
  const delX = avgDeliv ? L.deliv / avgDeliv : 0;
  const chg = ((L.c - L.prev) / L.prev) * 100;
  const closePos = L.h > L.l ? (L.c - L.l) / (L.h - L.l) : 0.5;
  const rangeX = (L.h - L.l) / L.prev / avgRange;
  const hiN = Math.max(...base.map((b) => b.h));
  const loN = Math.min(...base.map((b) => b.l));
  // Quiet accumulation: the last 3 sessions all busier than the earlier baseline, with little price change.
  const last3 = hist.slice(-3), older = hist.slice(0, -3);
  const olderVol = median(older.map((b) => b.vol));
  const busy3 = olderVol ? last3.filter((b) => b.vol >= 1.3 * olderVol).length : 0;
  const chg3 = ((L.c - last3[0].prev) / last3[0].prev) * 100;
  const delivRising = last3.every((b) => b.delivPct >= avgDelPct);

  const tags = [];
  let score = 0;
  const add = (key, label, pts, tip) => { tags.push({ key, label, tip }); score += pts; };
  if (volX >= 3) add("spike", `🔥 Volume ${r2(volX)}×`, Math.min(volX, 10), "Last session traded at least 3× its usual volume. Heavy volume often continues the next day.");
  if (delX >= 2.5 && L.delivPct >= 45 && chg >= 0) add("delivery", "🏦 Delivery buying", 4, "Delivery volume (shares bought and held, not day-traded) jumped and price closed up. This is the usual footprint of funds building a position.");
  if (L.c > hiN && volX >= 1.5 && closePos >= 0.6) add("breakout", `📈 ${BASELINE_DAYS}-day breakout`, 4, `Closed above the highest price of the previous ${base.length} sessions on above-average volume.`);
  else if (L.c >= hiN * 0.97 && rangeX <= 0.8 && L.c > L.prev * 0.995) add("near", "⏳ Coiled near high", 2.5, "Within 3% of the recent high, in a tight range. A breakout above the high on volume is the trigger to watch.");
  if (busy3 === 3 && Math.abs(chg3) < 4 && delivRising) add("buildup", "🧱 Quiet build-up", 3, "3 busy sessions in a row with high delivery but little price change. Someone may be accumulating before a move.");
  if (volX >= 2.5 && chg <= -2 && L.delivPct >= 40) add("distribution", "⚠ Heavy selling", 3, "High volume and high delivery on a falling day. Large holders may be exiting.");
  if (dealInfo?.instBuyCr) add("deal", `🤝 Institution bought ₹${r2(dealInfo.instBuyCr)} Cr`, 3 + Math.min(dealInfo.instBuyCr / 20, 4), dealInfo.buyers.join("; "));
  if (dealInfo?.instSellCr) add("dealsell", `🤝 Institution sold ₹${r2(dealInfo.instSellCr)} Cr`, 1.5, dealInfo.sellers.join("; "));
  if (!tags.length) return null;

  const bias = tags.some((t) => t.key === "distribution" || t.key === "dealsell") && !tags.some((t) => ["delivery", "breakout", "deal"].includes(t.key))
    ? "bearish" : chg >= 0 || tags.some((t) => t.key === "deal") ? "bullish" : "mixed";
  return {
    symbol, close: L.c, chg: r2(chg), vol: L.vol, avgVol: Math.round(avgVol), volX: r2(volX),
    delivPct: r2(L.delivPct), avgDelivPct: r2(avgDelPct), delX: r2(delX), turnoverCr: r2(L.turnoverCr), avgTurnoverCr: r2(avgTurn),
    high: L.h, low: L.l, recentHigh: hiN, recentLow: loN, closePos: r2(closePos), score: r2(score), bias, tags,
  };
}

// Share of a normal day's volume that has usually traded by this many minutes after 9:15 (NSE is busiest at the open and close).
const CURVE = [[0, 0], [5, 0.05], [15, 0.1], [30, 0.16], [60, 0.26], [120, 0.42], [180, 0.55], [240, 0.67], [300, 0.8], [345, 0.9], [375, 1]];
function expectedShare(min) {
  for (let i = 1; i < CURVE.length; i++) {
    const [m1, f1] = CURVE[i - 1], [m2, f2] = CURVE[i];
    if (min <= m2) return f1 + ((f2 - f1) * (min - m1)) / (m2 - m1);
  }
  return 1;
}

async function sparkBatch(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.map((s) => encodeURIComponent(s + ".NS")).join(",")}&range=1d&interval=1d`;
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(url.replace("query1", host), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      return (data.spark?.result || []).map((r) => ({ symbol: r.symbol.replace(/\.NS$/, ""), meta: r.response?.[0]?.meta })).filter((x) => x.meta);
    } catch {}
  }
  return [];
}

async function liveShocks(sessions, minTurnover) {
  const L = sessions[sessions.length - 1];
  const base = sessions.slice(-BASELINE_DAYS);
  const stats = Object.keys(L.stocks).filter((s) => COMPANIES.has(s)).map((symbol) => {
    const rows = base.map((s) => s.stocks[symbol]).filter(Boolean);
    return { symbol, avgVol: median(rows.map((r) => r.vol)), avgTurn: avg(rows.map((r) => r.turnoverCr)), n: rows.length };
  }).filter((s) => s.n >= 5 && s.avgVol > 0 && s.avgTurn >= minTurnover)
    .sort((a, b) => b.avgTurn - a.avgTurn).slice(0, 1500);
  const bySym = new Map(stats.map((s) => [s.symbol, s]));

  const batches = [];
  for (let i = 0; i < stats.length; i += 20) batches.push(stats.slice(i, i + 20).map((s) => s.symbol));
  const quotes = [];
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < batches.length) quotes.push(...(await sparkBatch(batches[next++])));
  }));

  const nowIst = new Date(Date.now() + 19800e3);
  const today = nowIst.toISOString().slice(0, 10);
  const minsIn = Math.min(Math.max(nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes() - 555, 0), 375);
  let sessionDate = null;
  const shocks = [];
  for (const { symbol, meta } of quotes) {
    const st = bySym.get(symbol);
    if (!st || !meta.regularMarketVolume || !meta.regularMarketTime) continue;
    const qDate = new Date(meta.regularMarketTime * 1000 + 19800e3).toISOString().slice(0, 10);
    if (!sessionDate || qDate > sessionDate) sessionDate = qDate;
    const isToday = qDate === today;
    // Before 9:15 the quote is still the last session's; compare it with a full day.
    const share = isToday ? Math.max(expectedShare(minsIn), 0.03) : 1;
    const rvol = meta.regularMarketVolume / (st.avgVol * share);
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const chg = meta.regularMarketChangePercent ?? (prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0);
    if (rvol < 2 && Math.abs(chg) < 5) continue;
    shocks.push({
      symbol, ltp: meta.regularMarketPrice, chg: r2(chg), dayVolume: meta.regularMarketVolume, avgVol: Math.round(st.avgVol),
      rvol: r2(rvol), valueCr: r2((meta.regularMarketVolume * meta.regularMarketPrice) / 1e7),
      dayHigh: meta.regularMarketDayHigh, dayLow: meta.regularMarketDayLow, time: meta.regularMarketTime, isToday,
    });
  }
  shocks.sort((a, b) => b.rvol - a.rvol);
  return { sessionDate, minutesIntoSession: minsIn, checked: quotes.length, shocks: shocks.slice(0, 150) };
}

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const minTurnover = Math.max(parseFloat(p.get("minTurnover")) || 1, 0);
  try {
    const sessions = await getSessions(BASELINE_DAYS + 1);
    if (sessions.length < 6) throw new Error("NSE files unavailable");

    if (p.get("live") === "1") {
      const live = await liveShocks(sessions, minTurnover);
      return Response.json({ updatedAt: new Date().toISOString(), baselineTo: sessions[sessions.length - 1].date, ...live }, {
        headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "public, max-age=60, stale-while-revalidate=30" },
      });
    }

    const [dealData, positioning] = await Promise.all([
      getDeals().catch(() => ({ date: null, deals: [], droppedIntraday: 0 })),
      getPositioning(sessions.map((s) => s.date)).catch(() => null),
    ]);
    const dealsBySym = {};
    for (const d of dealData.deals) {
      if (!INSTITUTIONAL.has(d.type)) continue;
      const x = (dealsBySym[d.symbol] ||= { instBuyCr: 0, instSellCr: 0, buyers: [], sellers: [] });
      const line = `${d.client} (${d.type}) ${d.side === "BUY" ? "bought" : "sold"} ${d.qty.toLocaleString("en-IN")} @ ₹${d.price}`;
      if (d.side === "BUY") { x.instBuyCr += d.valueCr; x.buyers.push(line); } else { x.instSellCr += d.valueCr; x.sellers.push(line); }
    }

    const L = sessions[sessions.length - 1];
    const watch = [];
    for (const symbol of Object.keys(L.stocks).filter((s) => COMPANIES.has(s) || dealsBySym[s])) {
      const hist = sessions.map((s) => s.stocks[symbol]).filter(Boolean);
      const a = analyse(symbol, hist, dealsBySym[symbol]);
      if (a && (a.avgTurnoverCr >= minTurnover || a.turnoverCr >= minTurnover * 3 || dealsBySym[symbol])) watch.push(a);
    }
    watch.sort((a, b) => b.score - a.score);

    return Response.json({
      updatedAt: new Date().toISOString(),
      sessionDate: L.date, baselineFrom: sessions[0].date, sessions: sessions.length,
      watch: watch.slice(0, 200), watchTotal: watch.length,
      deals: dealData, positioning,
    }, { headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "public, max-age=900, stale-while-revalidate=300" } });
  } catch (e) {
    return Response.json({ error: "Couldn't load NSE's end-of-day files right now. Try again in a minute." }, { status: 502 });
  }
};

export const config = { path: "/api/premarket" };
