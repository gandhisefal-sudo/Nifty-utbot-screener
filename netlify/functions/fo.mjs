import { getSession, summaryRow, chainDetail } from "../../lib/nse-fo.mjs";
import { sparkMany } from "../../lib/yahoo.mjs";

// GET /api/fo                      -> every F&O stock and index: near-month future, OI buildup, PCR, max pain, IV
// GET /api/fo?symbol=NIFTY&expiry= -> option chain for one underlying + all its futures contracts
// F&O numbers are from NSE's end-of-day F&O file; "live" spot prices come from Yahoo Finance.

const INDEX_YAHOO = { NIFTY: "^NSEI", BANKNIFTY: "^NSEBANK", FINNIFTY: "NIFTY_FIN_SERVICE.NS", MIDCPNIFTY: "NIFTY_MID_SELECT.NS", NIFTYNXT50: "^NSMIDCP" };
const r2 = (x) => Math.round(x * 100) / 100;

async function indexQuotes() {
  const syms = Object.values(INDEX_YAHOO);
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${syms.map(encodeURIComponent).join(",")}&range=1d&interval=1d`;
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(url.replace("query1", host), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      const bySym = Object.fromEntries((data.spark?.result || []).map((r) => [r.symbol, r.response?.[0]?.meta]).filter((x) => x[1]));
      return Object.fromEntries(Object.entries(INDEX_YAHOO).map(([k, y]) => [k, bySym[y]]).filter((x) => x[1]));
    } catch {}
  }
  return {};
}

async function liveSpot(rows) {
  const stocks = rows.filter((r) => r.type === "stock").map((r) => r.symbol);
  const [sq, iq] = await Promise.all([sparkMany(stocks).catch(() => []), indexQuotes().catch(() => ({}))]);
  const metas = { ...Object.fromEntries(sq.map((q) => [q.symbol, q.meta])), ...iq };
  let asOf = 0;
  const out = {};
  for (const [sym, m] of Object.entries(metas)) {
    const ltp = m.regularMarketPrice, prev = m.chartPreviousClose ?? m.previousClose;
    if (!ltp) continue;
    out[sym] = { ltp: r2(ltp), chg: prev ? r2(((ltp - prev) / prev) * 100) : null, pts: prev ? r2(ltp - prev) : null };
    asOf = Math.max(asOf, (m.regularMarketTime || 0) * 1000);
  }
  return { spot: out, asOf: asOf || null };
}

const json = (body, status = 200, maxAge = 60) => Response.json(body, {
  status,
  headers: status === 200
    ? { "Cache-Control": "public, max-age=30", "Netlify-CDN-Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=60` }
    : { "Cache-Control": "no-store" },
});

export default async (req) => {
  const q = new URL(req.url).searchParams;
  let s;
  try { s = await getSession(); } catch (e) { return json({ error: `Couldn't reach NSE's F&O file (${e.message}). Try again in a minute.` }, 502); }
  if (!s) return json({ error: "No NSE F&O file was found for the last 10 days." }, 404);

  const symbol = (q.get("symbol") || "").toUpperCase().trim();
  if (symbol) {
    const u = s.underlyings.get(symbol);
    if (!u) return json({ error: `${symbol} has no futures & options on NSE.` }, 404);
    const detail = chainDetail(u, q.get("expiry"), s.date);
    const { spot, asOf } = await liveSpot([{ symbol, type: u.type }]);
    return json({ ...detail, live: spot[symbol] || null, liveAsOf: asOf });
  }

  const rows = [...s.underlyings.values()].map((u) => summaryRow(u, s.date))
    .sort((a, b) => (a.type === b.type ? b.futValCr - a.futValCr : a.type === "index" ? -1 : 1));
  const { spot, asOf } = await liveSpot(rows);
  for (const r of rows) r.live = spot[r.symbol] || null;
  return json({ date: s.date, count: rows.length, rows, liveAsOf: asOf });
};

export const config = { path: "/api/fo" };
