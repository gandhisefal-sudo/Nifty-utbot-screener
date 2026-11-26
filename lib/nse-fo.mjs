// NSE futures & options (F&O) data from NSE's daily F&O bhavcopy (UDiFF format), published each
// evening after the close at nsearchives.nseindia.com. One file holds every futures and options
// contract on every F&O stock and index: prices, open interest (OI), OI change and volume.
// NSE's live option-chain API blocks automated/server access, so this is end-of-day data.

import { inflateRawSync } from "node:zlib";
import { splitCsvLine } from "./nse-daily.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const IST_MS = 19800e3;
const memo = new Map(); // date -> parsed session (past files never change)
let latest = null; // { at, date }

const r2 = (x) => Math.round(x * 100) / 100;

// Reads the first file out of a .zip (stored or deflated) using the central directory.
function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("bad zip");
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("bad zip directory");
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const off = buf.readUInt32LE(cd + 42);
  const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
  const data = buf.subarray(start, start + size);
  return (method === 0 ? data : inflateRawSync(data)).toString("utf8");
}

async function fetchBhav(iso) {
  const ymd = iso.replace(/-/g, "");
  for (const host of ["nsearchives", "archives"]) {
    try {
      const res = await fetch(`https://${host}.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`, {
        headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000),
      });
      if (res.status === 404) return null;
      if (!res.ok) continue;
      return unzipFirst(Buffer.from(await res.arrayBuffer()));
    } catch {}
  }
  throw new Error("NSE F&O file unreachable");
}

// Parses the bhavcopy into { date, underlyings: Map(symbol -> { symbol, type, lot, spot, futures[], options{expiry -> Map(strike -> {CE,PE})} }) }
function parse(text, date) {
  const lines = text.replace(/^﻿/, "").trim().split(/\r?\n/);
  const head = splitCsvLine(lines.shift());
  const ix = Object.fromEntries(head.map((h, i) => [h, i]));
  const unders = new Map();
  for (const line of lines) {
    const r = line.split(","); // UDiFF rows have no quoted commas
    const tp = r[ix.FinInstrmTp];
    if (!["IDF", "IDO", "STF", "STO"].includes(tp)) continue;
    const expiry = r[ix.XpryDt];
    if (expiry <= date) continue; // contracts expiring today are settled
    const sym = r[ix.TckrSymb];
    const n = (k) => { const x = parseFloat(r[ix[k]]); return Number.isFinite(x) ? x : 0; };
    let u = unders.get(sym);
    if (!u) unders.set(sym, u = { symbol: sym, type: tp[0] === "I" ? "index" : "stock", lot: n("NewBrdLotQty"), spot: n("UndrlygPric"), futures: [], options: new Map() });
    const close = n("ClsPric") || n("SttlmPric");
    const c = { close, prev: n("PrvsClsgPric"), settle: n("SttlmPric"), oi: n("OpnIntrst"), oiChg: n("ChngInOpnIntrst"), vol: n("TtlTradgVol"), valCr: n("TtlTrfVal") / 1e7 };
    if (tp.endsWith("F")) { u.futures.push({ expiry, ...c }); continue; }
    if (!u.options.has(expiry)) u.options.set(expiry, new Map());
    const chain = u.options.get(expiry);
    const strike = n("StrkPric");
    if (!chain.has(strike)) chain.set(strike, {});
    chain.get(strike)[r[ix.OptnTp]] = c;
  }
  for (const u of unders.values()) u.futures.sort((a, b) => a.expiry.localeCompare(b.expiry));
  return { date, underlyings: unders };
}

// Latest published F&O session (tries today, then back up to 10 days for weekends/holidays).
export async function getSession() {
  if (latest && Date.now() - latest.at < 10 * 60e3 && memo.has(latest.date)) return memo.get(latest.date);
  const today = new Date(Date.now() + IST_MS);
  for (let back = 0; back <= 10; back++) {
    const d = new Date(today.getTime() - back * 864e5);
    if ([0, 6].includes(d.getUTCDay())) continue;
    const iso = d.toISOString().slice(0, 10);
    if (memo.has(iso)) { latest = { at: Date.now(), date: iso }; return memo.get(iso); }
    const text = await fetchBhav(iso);
    if (!text) continue;
    const s = parse(text, iso);
    if (!s.underlyings.size) continue;
    memo.set(iso, s);
    latest = { at: Date.now(), date: iso };
    return s;
  }
  return null;
}

// ---- Analytics ----

// Price vs OI: the standard read of who is driving a futures move.
export function buildup(chgPct, oiChg) {
  if (!oiChg) return chgPct >= 0 ? "Neutral +" : "Neutral −";
  if (chgPct >= 0) return oiChg > 0 ? "Long buildup" : "Short covering";
  return oiChg > 0 ? "Short buildup" : "Long unwinding";
}

// Strike where option buyers in total lose the most (writers' pain is lowest) at expiry.
function maxPain(chain) {
  const strikes = [...chain.keys()].sort((a, b) => a - b);
  let best = null, bestPain = Infinity;
  for (const k of strikes) {
    let pain = 0;
    for (const [s, o] of chain) {
      if (o.CE && k > s) pain += (k - s) * o.CE.oi;
      if (o.PE && k < s) pain += (s - k) * o.PE.oi;
    }
    if (pain < bestPain) { bestPain = pain; best = k; }
  }
  return best;
}

// Black-Scholes implied volatility (annualised %) by bisection; null when it can't be solved.
const ncdf = (x) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
export function bsPrice(S, K, T, v, call, r = 0.065) {
  const d1 = (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
  const d2 = d1 - v * Math.sqrt(T);
  return call ? S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2) : K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
}
export function impliedVol(price, S, K, T, call) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const intrinsic = Math.max(0, call ? S - K : K - S);
  if (price <= intrinsic + 0.01) return null;
  let lo = 0.01, hi = 4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, mid, call) > price) hi = mid; else lo = mid;
  }
  const v = (lo + hi) / 2;
  return v > 3.9 ? null : r2(v * 100);
}
// Option delta (Black-Scholes).
export function bsDelta(S, K, T, v, call, r = 0.065) {
  const d1 = (Math.log(S / K) + (r + (v * v) / 2) * T) / (v * Math.sqrt(T));
  return call ? ncdf(d1) : ncdf(d1) - 1;
}
export const yearsTo = (date, expiry) => Math.max(0.5, (new Date(`${expiry}T10:00:00Z`) - new Date(`${date}T10:00:00Z`)) / 864e5) / 365;

// Summary of one expiry's option chain: PCR, max pain, biggest call/put OI strikes, ATM strike and IV.
export function chainStats(u, expiry, date) {
  const chain = u.options.get(expiry);
  if (!chain || !chain.size) return null;
  let ceOi = 0, peOi = 0, ceOiChg = 0, peOiChg = 0, callWall = null, putWall = null;
  for (const [k, o] of chain) {
    if (o.CE) { ceOi += o.CE.oi; ceOiChg += o.CE.oiChg; if (!callWall || o.CE.oi > callWall.oi) callWall = { strike: k, oi: o.CE.oi }; }
    if (o.PE) { peOi += o.PE.oi; peOiChg += o.PE.oiChg; if (!putWall || o.PE.oi > putWall.oi) putWall = { strike: k, oi: o.PE.oi }; }
  }
  const strikes = [...chain.keys()].sort((a, b) => a - b);
  const atm = strikes.reduce((b, k) => (Math.abs(k - u.spot) < Math.abs(b - u.spot) ? k : b), strikes[0]);
  const T = yearsTo(date, expiry);
  const a = chain.get(atm);
  const ivs = [a.CE && impliedVol(a.CE.close, u.spot, atm, T, true), a.PE && impliedVol(a.PE.close, u.spot, atm, T, false)].filter((x) => x);
  return {
    expiry, ceOi, peOi, ceOiChg, peOiChg,
    pcr: ceOi ? r2(peOi / ceOi) : null,
    maxPain: maxPain(chain), callWall: callWall?.strike ?? null, putWall: putWall?.strike ?? null,
    atm, atmIv: ivs.length ? r2(ivs.reduce((s, x) => s + x, 0) / ivs.length) : null,
  };
}

// One row per F&O underlying, based on the near-month future and nearest option expiry.
export function summaryRow(u, date) {
  const f = u.futures[0];
  const optExp = [...u.options.keys()].sort()[0];
  const st = optExp ? chainStats(u, optExp, date) : null;
  const futOi = u.futures.reduce((s, x) => s + x.oi, 0);
  const futOiChg = u.futures.reduce((s, x) => s + x.oiChg, 0);
  const chg = f && f.prev ? r2(((f.close - f.prev) / f.prev) * 100) : 0;
  const prevOi = futOi - futOiChg;
  return {
    symbol: u.symbol, type: u.type, lot: u.lot, spot: u.spot,
    futExpiry: f?.expiry ?? null, fut: f?.close ?? null, futChg: chg,
    basis: f ? r2(f.close - u.spot) : null, basisPct: f && u.spot ? r2(((f.close - u.spot) / u.spot) * 100) : null,
    futOi, futOiChg, futOiChgPct: prevOi > 0 ? r2((futOiChg / prevOi) * 100) : null,
    futVol: u.futures.reduce((s, x) => s + x.vol, 0), futValCr: r2(u.futures.reduce((s, x) => s + x.valCr, 0)),
    buildup: f ? buildup(chg, futOiChg) : null,
    optExpiry: st?.expiry ?? null, pcr: st?.pcr ?? null, maxPain: st?.maxPain ?? null,
    callWall: st?.callWall ?? null, putWall: st?.putWall ?? null, atmIv: st?.atmIv ?? null,
  };
}

// Full option chain for one expiry, plus every futures contract.
export function chainDetail(u, expiry, date) {
  const expiries = [...u.options.keys()].sort();
  const exp = expiries.includes(expiry) ? expiry : expiries[0];
  const chain = u.options.get(exp) || new Map();
  const T = exp ? yearsTo(date, exp) : 0;
  const leg = (o, k, call) => o && {
    ltp: o.close, chg: o.prev ? r2(o.close - o.prev) : null, oi: o.oi, oiChg: o.oiChg, vol: o.vol,
    iv: impliedVol(o.close, u.spot, k, T, call),
  };
  const rows = [...chain.keys()].sort((a, b) => a - b).map((k) => ({ strike: k, ce: leg(chain.get(k).CE, k, true), pe: leg(chain.get(k).PE, k, false) }));
  return {
    symbol: u.symbol, type: u.type, lot: u.lot, spot: u.spot, date, expiries, expiry: exp ?? null,
    stats: exp ? chainStats(u, exp, date) : null,
    futures: u.futures.map((f) => {
      const chg = f.prev ? r2(((f.close - f.prev) / f.prev) * 100) : 0;
      return { expiry: f.expiry, close: f.close, chg, oi: f.oi, oiChg: f.oiChg, vol: f.vol, valCr: r2(f.valCr), basis: r2(f.close - u.spot), buildup: buildup(chg, f.oiChg) };
    }),
    rows,
  };
}
