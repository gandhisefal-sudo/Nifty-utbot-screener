import { NSE_LISTS } from "../../lib/nse-lists.mjs";
import { NSE_EQUITIES } from "../../lib/nse-equities.mjs";

const BASE = "https://archives.nseindia.com/content";
const INDEX_FILES = {
  nifty50: "indices/ind_nifty50list.csv",
  nifty100: "indices/ind_nifty100list.csv",
  nifty200: "indices/ind_nifty200list.csv",
  nifty500: "indices/ind_nifty500list.csv",
};
const EQUITY_FILE = "equities/EQUITY_L.csv";
const UNIVERSES = [...Object.keys(INDEX_FILES), "nonNifty", "allEq", "fno"];
const FNO_FILE = "fo/fo_mktlots.csv";

// Minimal CSV parser that handles quoted fields with commas.
function parseCsv(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, "").trim().split(/\r?\n/)) {
    const cols = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { cols.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  const header = rows.shift().map((h) => h.trim().toUpperCase());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

async function fetchCsv(path) {
  const res = await fetch(`${BASE}/${path}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseCsv(await res.text());
}

// Index constituents from NSE, falling back to the bundled snapshot.
async function getIndex(key) {
  try {
    const stocks = (await fetchCsv(INDEX_FILES[key]))
      .map((r) => ({ symbol: r["SYMBOL"], name: r["COMPANY NAME"], industry: r["INDUSTRY"] }))
      .filter((s) => s.symbol);
    if (stocks.length < 40) throw new Error("too few rows");
    return { stocks, live: true };
  } catch {
    return { stocks: NSE_LISTS[key], live: false };
  }
}

// Every NSE equity in the EQ series (the only series that can be traded intraday).
async function getAllEquities() {
  try {
    const stocks = (await fetchCsv(EQUITY_FILE))
      .filter((r) => r["SERIES"] === "EQ")
      .map((r) => ({ symbol: r["SYMBOL"], name: r["NAME OF COMPANY"] }))
      .filter((s) => s.symbol);
    if (stocks.length < 1000) throw new Error("too few rows");
    return { stocks, live: true };
  } catch {
    return { stocks: NSE_EQUITIES, live: false };
  }
}

// Stocks with futures & options on NSE, from NSE's F&O lot-size file (rows after the
// "Derivatives on Individual Securities" header; the rows above it are indices).
async function getFnoStocks() {
  const res = await fetch(`https://nsearchives.nseindia.com/content/${FNO_FILE}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/);
  const start = lines.findIndex((l) => /^Derivatives on Individual Securities/i.test(l));
  if (start < 0) throw new Error("unexpected file");
  return lines.slice(start + 1).map((l) => l.split(",").map((x) => x.trim()))
    .filter((c) => c[1]).map((c) => ({ symbol: c[1], name: c[0], lot: Number(c[2]) || null }));
}

export default async (req) => {
  const index = new URL(req.url).searchParams.get("index");
  const key = UNIVERSES.includes(index) ? index : "nifty50";
  let result;

  if (INDEX_FILES[key]) {
    result = await getIndex(key);
  } else if (key === "fno") {
    const [fno, n500] = await Promise.all([getFnoStocks().catch(() => null), getIndex("nifty500")]);
    const industry = new Map(n500.stocks.map((s) => [s.symbol, s.industry]));
    // If NSE's file is unreachable, fall back to the Nifty 200 (almost all of it is in F&O).
    result = fno && fno.length > 100
      ? { stocks: fno.map((s) => ({ ...s, industry: industry.get(s.symbol) })), live: n500.live }
      : { ...(await getIndex("nifty200")), live: false };
  } else {
    const [all, n500] = await Promise.all([getAllEquities(), getIndex("nifty500")]);
    const industry = new Map(n500.stocks.map((s) => [s.symbol, s.industry]));
    const stocks = key === "nonNifty"
      ? all.stocks.filter((s) => !industry.has(s.symbol))
      : all.stocks.map((s) => ({ ...s, industry: industry.get(s.symbol) }));
    result = { stocks, live: all.live && n500.live };
  }

  return Response.json(
    { index: key, source: result.live ? "nseindia (live)" : "nseindia (snapshot)", count: result.stocks.length, stocks: result.stocks },
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
};

export const config = { path: "/api/universe" };
