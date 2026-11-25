import { NSE_LISTS } from "../../lib/nse-lists.mjs";
import { getSessions, splitCsvLine } from "../../lib/nse-daily.mjs";
import { sparkMany } from "../../lib/yahoo.mjs";

// GET /api/sectors?period=1d|1w|1m
// Sector heatmap built from the Nifty 500, grouped by NSE's sector ("industry") classification.
// - 1d: live day change from Yahoo quotes; falls back to NSE's last end-of-day file if quotes fail.
// - 1w / 1m: close-to-close change over the last 5 / 21 NSE sessions (end-of-day files).
// A sector's move is the equal-weighted average of its stocks' moves, so it shows how the
// typical stock in the sector did (not just the few heavyweights).

const PERIODS = { "1d": 1, "1w": 5, "1m": 21 };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const r2 = (x) => Math.round(x * 100) / 100;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function nifty500() {
  try {
    const res = await fetch("https://archives.nseindia.com/content/indices/ind_nifty500list.csv", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const lines = (await res.text()).replace(/^﻿/, "").trim().split(/\r?\n/);
    const head = splitCsvLine(lines.shift()).map((h) => h.toUpperCase());
    const [S, N, I] = ["SYMBOL", "COMPANY NAME", "INDUSTRY"].map((h) => head.indexOf(h));
    const stocks = lines.map(splitCsvLine).map((r) => ({ symbol: r[S], name: r[N], industry: r[I] })).filter((s) => s.symbol && s.industry);
    if (stocks.length < 400) throw new Error("too few rows");
    return stocks;
  } catch {
    return NSE_LISTS.nifty500;
  }
}

// Live (or latest) day change per symbol from Yahoo.
async function liveChanges(symbols) {
  const quotes = await sparkMany(symbols);
  const out = {};
  let latest = 0;
  for (const { symbol, meta } of quotes) {
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    const ltp = meta.regularMarketPrice;
    if (!ltp || !prev) continue;
    out[symbol] = { chg: ((ltp - prev) / prev) * 100, ltp };
    latest = Math.max(latest, meta.regularMarketTime || 0);
  }
  return { changes: out, asOf: latest ? new Date(latest * 1000).toISOString() : null };
}

// Close-to-close change over `n` sessions from NSE's end-of-day files.
async function eodChanges(n) {
  const sessions = await getSessions(n + 1);
  if (sessions.length < 2) throw new Error("NSE files unavailable");
  const L = sessions[sessions.length - 1];
  const F = n === 1 ? null : sessions[Math.max(sessions.length - 1 - n, 0)];
  const out = {};
  for (const [symbol, x] of Object.entries(L.stocks)) {
    const base = F ? F.stocks[symbol]?.c : x.prev;
    if (base && x.c) out[symbol] = { chg: ((x.c - base) / base) * 100, ltp: x.c };
  }
  return { changes: out, from: F?.date || sessions[sessions.length - 2].date, to: L.date };
}

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const period = PERIODS[p.get("period")] ? p.get("period") : "1d";
  try {
    const universe = await nifty500();
    let data, source;
    if (period === "1d") {
      data = await liveChanges(universe.map((s) => s.symbol));
      source = "live";
      if (Object.keys(data.changes).length < universe.length * 0.5) {
        data = await eodChanges(1);
        source = "eod";
      }
    } else {
      data = await eodChanges(PERIODS[period]);
      source = "eod";
    }

    const groups = new Map();
    for (const s of universe) {
      const c = data.changes[s.symbol];
      if (!c) continue;
      const g = groups.get(s.industry) || [];
      g.push({ symbol: s.symbol, name: s.name, chg: r2(c.chg), ltp: c.ltp });
      groups.set(s.industry, g);
    }
    const sectors = [...groups].map(([sector, stocks]) => {
      stocks.sort((a, b) => b.chg - a.chg);
      const chgs = stocks.map((x) => x.chg);
      return {
        sector, count: stocks.length,
        chg: r2(chgs.reduce((a, b) => a + b, 0) / chgs.length), median: r2(median(chgs)),
        adv: chgs.filter((x) => x > 0).length, dec: chgs.filter((x) => x < 0).length,
        stocks,
      };
    }).sort((a, b) => b.chg - a.chg);
    const all = sectors.flatMap((s) => s.stocks.map((x) => x.chg));

    return Response.json({
      updatedAt: new Date().toISOString(), period, source,
      asOf: data.asOf || null, from: data.from || null, to: data.to || null,
      market: { count: all.length, chg: r2(all.reduce((a, b) => a + b, 0) / (all.length || 1)), adv: all.filter((x) => x > 0).length, dec: all.filter((x) => x < 0).length },
      sectors,
    }, {
      headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": `public, max-age=${source === "live" ? 60 : 900}, stale-while-revalidate=60` },
    });
  } catch {
    return Response.json({ error: "Couldn't load sector data right now. Try again in a minute." }, { status: 502 });
  }
};

export const config = { path: "/api/sectors" };
