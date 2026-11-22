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
const UNIVERSES = [...Object.keys(INDEX_FILES), "nonNifty", "allEq"];

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

export default async (req) => {
  const index = new URL(req.url).searchParams.get("index");
  const key = UNIVERSES.includes(index) ? index : "nifty50";
  let result;

  if (INDEX_FILES[key]) {
    result = await getIndex(key);
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
