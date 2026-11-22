import { NSE_LISTS } from "../../lib/nse-lists.mjs";

const FILES = {
  nifty50: "ind_nifty50list.csv",
  nifty100: "ind_nifty100list.csv",
  nifty200: "ind_nifty200list.csv",
  nifty500: "ind_nifty500list.csv",
};

// Pulls the index constituents straight from NSE's published CSV files,
// falling back to a bundled snapshot if NSE is unreachable.
async function fetchFromNse(index) {
  const res = await fetch(`https://archives.nseindia.com/content/indices/${FILES[index]}`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).replace(/^﻿/, "").trim().split(/\r?\n/);
  const header = lines.shift().split(",").map((s) => s.trim());
  const iName = header.indexOf("Company Name"), iInd = header.indexOf("Industry"), iSym = header.indexOf("Symbol");
  if (iSym < 0) throw new Error("unexpected CSV");
  const stocks = lines.map((line) => {
    const cols = line.split(",");
    return { symbol: cols[iSym]?.trim(), name: cols[iName]?.trim(), industry: cols[iInd]?.trim() };
  }).filter((s) => s.symbol);
  if (stocks.length < 40) throw new Error("too few rows");
  return stocks;
}

export default async (req) => {
  const index = new URL(req.url).searchParams.get("index");
  const key = FILES[index] ? index : "nifty50";
  let stocks, source;
  try {
    stocks = await fetchFromNse(key);
    source = "nseindia (live)";
  } catch {
    stocks = NSE_LISTS[key];
    source = "nseindia (snapshot)";
  }
  return Response.json({ index: key, source, count: stocks.length, stocks }, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
};

export const config = { path: "/api/universe" };
