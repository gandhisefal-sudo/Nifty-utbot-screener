import { NSE_LISTS } from "../../lib/nse-lists.mjs";
import { splitCsvLine } from "../../lib/nse-daily.mjs";

// GET /api/indices?period=1d|1w|1m
// NSE index heatmap: the main indices (Nifty 50, Bank Nifty) plus every NSE sectoral/thematic
// index, and a few "custom" sectors NSE has no index for (built from Nifty 500 stocks).
// - Index level and % change come from Yahoo Finance's index quotes.
// - Breadth (stocks up / down) comes from each index's constituents (NSE's constituent CSVs).
// - Custom sectors have no index level: their move is the equal-weighted average of their stocks.

const RANGES = { "1d": "1d", "1w": "5d", "1m": "1mo" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const r2 = (x) => Math.round(x * 100) / 100;

// group: "main" = headline indices, "sector" = sector tiles.
// csv: NSE constituent file; or `symbols` / `industry` to build constituents from the Nifty 500.
const INDICES = [
  { name: "NIFTY 50", yahoo: "^NSEI", csv: "ind_nifty50list", group: "main" },
  // BSE Sensex: 30 stocks (BSE publishes no simple CSV, so the list is kept here; all trade on NSE too).
  { name: "SENSEX", yahoo: "^BSESN", group: "main", symbols: ["ADANIPORTS", "ASIANPAINT", "AXISBANK", "BAJFINANCE", "BAJAJFINSV", "BEL", "BHARTIARTL", "HCLTECH", "HDFCBANK", "HINDUNILVR", "ICICIBANK", "INFY", "ITC", "KOTAKBANK", "LT", "M&M", "MARUTI", "NTPC", "POWERGRID", "RELIANCE", "SBIN", "SUNPHARMA", "TMPV", "TATASTEEL", "TCS", "TECHM", "TITAN", "TRENT", "ULTRACEMCO", "ETERNAL"] },
  { name: "BANK NIFTY", yahoo: "^NSEBANK", csv: "ind_niftybanklist", group: "main" },
  { name: "NIFTY PVT BANK", yahoo: "NIFTY_PVT_BANK.NS", csv: "ind_nifty_privatebanklist" },
  { name: "NIFTY PSU BANK", yahoo: "^CNXPSUBANK", csv: "ind_niftypsubanklist" },
  { name: "NIFTY FIN SERV", yahoo: "NIFTY_FIN_SERVICE.NS", csv: "ind_niftyfinancelist" },
  { name: "NIFTY IT", yahoo: "^CNXIT", csv: "ind_niftyitlist" },
  { name: "NIFTY FMCG", yahoo: "^CNXFMCG", csv: "ind_niftyfmcglist" },
  { name: "NIFTY PHARMA", yahoo: "^CNXPHARMA", csv: "ind_niftypharmalist" },
  { name: "NIFTY HEALTHCARE", yahoo: "NIFTY_HEALTHCARE.NS", csv: "ind_niftyhealthcarelist" },
  { name: "NIFTY AUTO", yahoo: "^CNXAUTO", csv: "ind_niftyautolist" },
  { name: "NIFTY METAL", yahoo: "^CNXMETAL", csv: "ind_niftymetallist" },
  { name: "NIFTY REALTY", yahoo: "^CNXREALTY", csv: "ind_niftyrealtylist" },
  { name: "NIFTY ENERGY", yahoo: "^CNXENERGY", csv: "ind_niftyenergylist" },
  { name: "NIFTY OIL & GAS", yahoo: "NIFTY_OIL_AND_GAS.NS", csv: "ind_niftyoilgaslist" },
  { name: "NIFTY MEDIA", yahoo: "^CNXMEDIA", csv: "ind_niftymedialist" },
  { name: "NIFTY INFRA", yahoo: "^CNXINFRA", csv: "ind_niftyinfralist" },
  { name: "NIFTY CONSUMPTION", yahoo: "^CNXCONSUM", csv: "ind_niftyconsumptionlist" },
  { name: "NIFTY CONSUMER DUR", yahoo: "NIFTY_CONSR_DURBL.NS", csv: "ind_niftyconsumerdurableslist" },
  { name: "NIFTY MNC", yahoo: "^CNXMNC", csv: "ind_niftymnclist" },
  { name: "NIFTY PSE", yahoo: "^CNXPSE", csv: "ind_niftypselist" },
  { name: "NIFTY CPSE", yahoo: "NIFTY_CPSE.NS", csv: "ind_niftycpselist" },
  { name: "NIFTY DEFENCE", yahoo: "NIFTY_IND_DEFENCE.NS", csv: "ind_niftyindiadefence_list" },
  { name: "NIFTY LOGISTICS", yahoo: "NIFTY_TRANS_LOGIS.NS", csv: "ind_niftytransportationandlogistics_list" },
  { name: "NIFTY DIGITAL", yahoo: "NIFTY_IND_DIGITAL.NS", csv: "ind_niftyindiadigital_list" },
  { name: "NIFTY MANUFACTURING", yahoo: "NIFTY_INDIA_MFG.NS", csv: "ind_niftyindiamanufacturing_list" },
  { name: "NIFTY TOURISM", yahoo: "NIFTY_IND_TOURISM.NS", csv: "ind_niftyindiatourism_list" },
  { name: "NIFTY EV & NEW AGE AUTO", yahoo: "NIFTY_EV.NS" }, // NSE has no public constituent file for this one
  { name: "NIFTY CHEMICALS", yahoo: "NIFTY_CHEMICALS.NS", industry: "Chemicals" },
  { name: "NIFTY CAPITAL MKT", yahoo: "NIFTY_CAPITAL_MKT.NS", symbols: ["BSE", "CDSL", "MCX", "ANGELONE", "CAMS", "KFINTECH", "IEX", "HDFCAMC", "NUVAMA", "MOTILALOFS", "360ONE", "NAM-INDIA", "ABSLAMC", "UTIAMC", "IIFL", "CRISIL", "ICRA"] },
  { name: "NIFTY MIDCAP 100", yahoo: "NIFTY_MIDCAP_100.NS", csv: "ind_niftymidcap100list" },
  { name: "NIFTY MIDCAP SELECT", yahoo: "NIFTY_MID_SELECT.NS", csv: "ind_niftymidcapselect_list" },
  // Custom sectors: NSE publishes no index for these, so they're built from Nifty 500 stocks.
  { name: "INSURANCE", custom: true, symbols: ["LICI", "SBILIFE", "HDFCLIFE", "ICICIGI", "ICICILIFE", "GICRE", "NIACL", "STARHEALTH", "CANHLIFE", "GODIGIT", "NIVABUPA", "MFSL"] },
  { name: "CEMENT", custom: true, industry: "Construction Materials" },
  { name: "CAPITAL GOODS", custom: true, industry: "Capital Goods" },
  { name: "POWER", custom: true, industry: "Power" },
  { name: "TELECOM", custom: true, industry: "Telecommunication" },
  { name: "CONSUMER SERVICES", custom: true, industry: "Consumer Services" },
  { name: "CONSTRUCTION", custom: true, industry: "Construction" },
  { name: "TEXTILES", custom: true, industry: "Textiles" },
  { name: "ELECTRONICS (EMS)", custom: true, symbols: ["DIXON", "KAYNES", "SYRMA", "AMBER", "PGEL", "CYIENTDLM", "AVALON", "SANMITINFRA", "HONAUT", "BEL", "DATAPATTNS"] },
];

// Constituent lists change rarely; keep them for a few hours in a warm function instance.
let csvCache = { at: 0, lists: {} };
async function constituents(file) {
  if (Date.now() - csvCache.at > 6 * 3600e3) csvCache = { at: Date.now(), lists: {} };
  if (csvCache.lists[file]) return csvCache.lists[file];
  try {
    const res = await fetch(`https://archives.nseindia.com/content/indices/${file}.csv`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const lines = (await res.text()).replace(/^﻿/, "").trim().split(/\r?\n/);
    const head = splitCsvLine(lines.shift()).map((h) => h.trim().toUpperCase());
    const [S, N] = ["SYMBOL", "COMPANY NAME"].map((h) => head.indexOf(h));
    if (S < 0) return null;
    const list = lines.map(splitCsvLine).map((r) => ({ symbol: r[S]?.trim(), name: r[N]?.trim() })).filter((s) => s.symbol);
    if (list.length) csvCache.lists[file] = list;
    return list.length ? list : null;
  } catch {
    return null;
  }
}

// Yahoo spark quotes for raw tickers (20 per call). Returns { ticker: { ltp, prev, time } }.
async function quotes(tickers, range) {
  const batches = [];
  for (let i = 0; i < tickers.length; i += 20) batches.push(tickers.slice(i, i + 20));
  const out = {};
  let next = 0;
  await Promise.all(Array.from({ length: 10 }, async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${b.map(encodeURIComponent).join(",")}&range=${range}&interval=1d`;
      for (const host of ["query1", "query2"]) {
        try {
          const res = await fetch(url.replace("query1", host), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
          if (!res.ok) continue;
          const data = await res.json();
          for (const r of data.spark?.result || []) {
            const resp = r.response?.[0], m = resp?.meta;
            const prev = m?.chartPreviousClose ?? m?.previousClose;
            // Some index tickers only carry today's bar on Yahoo, so their multi-day change would
            // really be a 1-day change; skip those for 1w / 1m.
            if (range !== "1d" && (resp?.timestamp?.length || 0) < 2) continue;
            if (m?.regularMarketPrice && prev) out[r.symbol] = { ltp: m.regularMarketPrice, prev, time: m.regularMarketTime || 0 };
          }
          break;
        } catch {}
      }
    }
  }));
  return out;
}

export default async (req) => {
  const p = new URL(req.url).searchParams;
  const period = RANGES[p.get("period")] ? p.get("period") : "1d";
  try {
    const n500 = NSE_LISTS.nifty500;
    const names = Object.fromEntries(n500.map((s) => [s.symbol, s.name]));
    const inN500 = new Set(n500.map((s) => s.symbol));

    // Resolve each index's constituents.
    const members = await Promise.all(INDICES.map(async (ix) => {
      if (ix.csv) {
        const list = await constituents(ix.csv);
        if (list) return list.map((s) => s.symbol);
      }
      if (ix.industry) return n500.filter((s) => s.industry === ix.industry).map((s) => s.symbol);
      if (ix.symbols) return ix.symbols.filter((s) => inN500.has(s) || !ix.custom);
      return [];
    }));
    members.forEach((list, i) => list.forEach((s) => s && !names[s] && (names[s] = s)));

    const stockSyms = [...new Set(members.flat())];
    const indexTickers = INDICES.filter((ix) => ix.yahoo).map((ix) => ix.yahoo);
    const q = await quotes([...indexTickers, ...stockSyms.map((s) => s + ".NS")], RANGES[period]);
    const stockQ = (s) => q[s + ".NS"];
    // Index levels for tickers whose multi-day history was missing (shown, but not used for % change).
    const missing = period === "1d" ? [] : indexTickers.filter((t) => !q[t]);
    const levels = missing.length ? await quotes(missing, "1d") : {};
    if (Object.keys(q).length < 20) throw new Error("quotes unavailable");

    let latest = 0;
    const rows = INDICES.map((ix, i) => {
      const stocks = members[i].map((s) => {
        const x = stockQ(s);
        return x && { symbol: s, name: names[s], chg: r2(((x.ltp - x.prev) / x.prev) * 100), ltp: r2(x.ltp) };
      }).filter(Boolean).sort((a, b) => b.chg - a.chg);
      const iq = ix.yahoo && q[ix.yahoo];
      const level = ix.yahoo && (iq || levels[ix.yahoo]);
      if (iq) latest = Math.max(latest, iq.time);
      const avg = stocks.length ? stocks.reduce((a, b) => a + b.chg, 0) / stocks.length : null;
      const chg = iq ? ((iq.ltp - iq.prev) / iq.prev) * 100 : avg;
      if (chg == null) return null;
      return {
        sector: ix.name, group: ix.group || "sector", custom: !!ix.custom, approx: !iq && !ix.custom,
        value: level ? r2(level.ltp) : null, chg: r2(chg), pts: iq ? r2(iq.ltp - iq.prev) : null, avg: avg == null ? null : r2(avg),
        count: stocks.length, adv: stocks.filter((x) => x.chg > 0).length, dec: stocks.filter((x) => x.chg < 0).length,
        stocks,
      };
    }).filter(Boolean);

    const main = rows.filter((r) => r.group === "main");
    const sectors = rows.filter((r) => r.group !== "main").sort((a, b) => b.chg - a.chg);
    return Response.json({
      updatedAt: new Date().toISOString(), period,
      asOf: latest ? new Date(latest * 1000).toISOString() : null,
      main, sectors,
    }, {
      headers: { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": `public, max-age=${period === "1d" ? 10 : 900}, stale-while-revalidate=${period === "1d" ? 5 : 60}` },
    });
  } catch {
    return Response.json({ error: "Couldn't load NSE index data right now. Try again in a minute." }, { status: 502 });
  }
};

export const config = { path: "/api/indices" };
