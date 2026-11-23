// End-of-day NSE data from archives.nseindia.com (published each evening after the close):
// - sec_bhavdata_full: every stock's volume, traded value and DELIVERY quantity/percentage
// - bulk.csv / block.csv: large deals (>0.5% of shares, or ₹10 cr+ block window) with the client name
// - fao_participant_oi: open interest held by FII, DII, Pro and Client in F&O
// Files for past dates never change, so they are kept in memory while the function instance is warm.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const BASE = "https://archives.nseindia.com";
const IST_MS = 19800e3;
const memo = new Map();

const pad = (n) => String(n).padStart(2, "0");
const ddmmyyyy = (d) => `${pad(d.getUTCDate())}${pad(d.getUTCMonth() + 1)}${d.getUTCFullYear()}`;
const todayIst = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);

function splitCsvLine(line) {
  const cols = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { cols.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

async function fetchText(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Cached fetch: past dates are cached for good (including "no file" for holidays); today's only when found.
async function cached(key, isToday, load) {
  if (memo.has(key)) return memo.get(key);
  const value = await load();
  if (value || !isToday) memo.set(key, value);
  return value;
}

// One trading day's bhavcopy: { SYMBOL: { o,h,l,c,prev,vol,deliv,delivPct,turnoverCr } } for the EQ series.
function parseBhav(text) {
  const lines = text.trim().split(/\r?\n/);
  const head = splitCsvLine(lines.shift()).map((h) => h.toUpperCase());
  const ix = (n) => head.indexOf(n);
  const [S, SE, P, O, H, L, C, V, T, D, DP] = ["SYMBOL", "SERIES", "PREV_CLOSE", "OPEN_PRICE", "HIGH_PRICE", "LOW_PRICE", "CLOSE_PRICE", "TTL_TRD_QNTY", "TURNOVER_LACS", "DELIV_QTY", "DELIV_PER"].map(ix);
  const out = {};
  for (const line of lines) {
    const r = splitCsvLine(line);
    if (r[SE] !== "EQ") continue;
    const num = (i) => { const x = parseFloat(r[i]); return Number.isFinite(x) ? x : 0; };
    out[r[S]] = { o: num(O), h: num(H), l: num(L), c: num(C), prev: num(P), vol: num(V), deliv: num(D), delivPct: num(DP), turnoverCr: num(T) / 100 };
  }
  return out;
}

// Most recent `count` trading sessions, newest last: [{ date: "2026-11-20", stocks }]
export async function getSessions(count = 16) {
  const today = todayIst();
  const days = [];
  for (let back = 0; days.length < count + 8 && back < 40; back++) {
    const d = new Date(Date.parse(today) - back * 86400e3);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    days.push(d);
  }
  const loaded = await Promise.all(days.map(async (d) => {
    const iso = d.toISOString().slice(0, 10);
    try {
      const stocks = await cached(`bhav:${iso}`, iso === today, async () => {
        const t = await fetchText(`/products/content/sec_bhavdata_full_${ddmmyyyy(d)}.csv`);
        return t ? parseBhav(t) : null;
      });
      return stocks && Object.keys(stocks).length > 500 ? { date: iso, stocks } : null;
    } catch {
      return null;
    }
  }));
  return loaded.filter(Boolean).slice(0, count).reverse();
}

// ---- Bulk & block deals ----
// HFT / proprietary desks buy and sell the same shares within the day; their deals say nothing
// about where a stock is heading, so clients whose buys and sells roughly cancel are dropped.
const PROP = /ALPHAGREP|QE SECURITIES|NK SECURITIES|IMC INDIA|GRAVITON|JUNOMONETA|HRTI|TOWER RESEARCH|JANE STREET|CITADEL|MANSI SHARE|SILVERLEAF|PACE STOCK|DOLAT|IRAGE|MUSIGMA|PLUTUS|NUVAMA WEALTH|ARIHANT CAPITAL|SHARE INDIA/;
export function classifyClient(name) {
  const n = name.toUpperCase();
  if (/MUTUAL FUND|\bMF\b|ASSET MANAGEMENT|\bAMC\b|TRUSTEE/.test(n)) return "Mutual fund";
  if (/INSURANCE|LIFE INS|\bLIC\b|ASSURANCE/.test(n)) return "Insurance";
  if (PROP.test(n)) return "Prop / HFT";
  if (/\b(PTE|LLC|PLC|SICAV|L\.?P\.?|INC|S\.A\.?|GMBH|AG|MASTER|OFFSHORE|MAURITIUS|SINGAPORE|CAYMAN|LUXEMBOURG|IRELAND|NORGES|GOVERNMENT OF|MONETARY AUTHORITY|INVESTMENT AUTHORITY|SOCIETE GENERALE|MORGAN STANLEY|GOLDMAN|CITIGROUP|BNP PARIBAS|VANGUARD|ISHARES|ABU DHABI|EMERGING MARKETS)\b/.test(n)) return "Foreign investor (FPI)";
  if (/\bFUND\b|\bFUNDS\b|CAPITAL|INVESTMENT|VENTURES|ADVISORS|PORTFOLIO|AIF/.test(n)) return "Fund / investment firm";
  return "Other (individual / company)";
}
export const INSTITUTIONAL = new Set(["Mutual fund", "Insurance", "Foreign investor (FPI)", "Fund / investment firm"]);

const parseDealDate = (s) => { const t = Date.parse(`${s} 00:00 GMT`); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : s; };

async function readDeals(kind) {
  const text = await fetchText(`/content/equities/${kind}.csv`);
  if (!text) return [];
  const lines = text.trim().split(/\r?\n/);
  lines.shift();
  return lines.map(splitCsvLine).filter((r) => r.length >= 7 && r[1]).map((r) => ({
    kind, date: parseDealDate(r[0]), symbol: r[1].toUpperCase(), name: r[2], client: r[3],
    side: r[4].toUpperCase(), qty: parseFloat(r[5]) || 0, price: parseFloat(r[6]) || 0,
  }));
}

// Latest session's deals, netted per stock + client.
export async function getDeals() {
  const rows = (await Promise.all(["bulk", "block"].map((k) => readDeals(k).catch(() => [])))).flat();
  const groups = new Map();
  for (const d of rows) {
    const key = `${d.symbol}|${d.client}`;
    const g = groups.get(key) || { symbol: d.symbol, name: d.name, client: d.client, date: d.date, kinds: new Set(), buy: 0, sell: 0, buyVal: 0, sellVal: 0 };
    g.kinds.add(d.kind);
    if (d.side.startsWith("B")) { g.buy += d.qty; g.buyVal += d.qty * d.price; } else { g.sell += d.qty; g.sellVal += d.qty * d.price; }
    groups.set(key, g);
  }
  const deals = [];
  let droppedIntraday = 0;
  for (const g of groups.values()) {
    const net = g.buy - g.sell;
    // Bought and sold about the same amount on the same day = intraday trading, not a position.
    if (Math.abs(net) < 0.25 * Math.max(g.buy, g.sell)) { droppedIntraday++; continue; }
    const side = net > 0 ? "BUY" : "SELL";
    const qty = Math.abs(net);
    const price = side === "BUY" ? g.buyVal / g.buy : g.sellVal / g.sell;
    deals.push({
      symbol: g.symbol, name: g.name, client: g.client, date: g.date, type: classifyClient(g.client),
      kind: [...g.kinds].join(" + "), side, qty, price: Math.round(price * 100) / 100, valueCr: Math.round((qty * price) / 1e5) / 100,
    });
  }
  deals.sort((a, b) => b.valueCr - a.valueCr);
  return { date: rows[0]?.date || null, deals, droppedIntraday };
}

// ---- FII / DII / Pro / Client positioning in F&O ----
async function participantOi(date) {
  const iso = date;
  const d = new Date(`${iso}T00:00:00Z`);
  return cached(`poi:${iso}`, iso === todayIst(), async () => {
    const t = await fetchText(`/content/nsccl/fao_participant_oi_${ddmmyyyy(d)}.csv`);
    if (!t) return null;
    const lines = t.trim().split(/\r?\n/);
    const hi = lines.findIndex((l) => /^"?Client Type/i.test(l));
    if (hi < 0) return null;
    const head = splitCsvLine(lines[hi]).map((h) => h.replace(/"/g, "").trim().toLowerCase());
    const out = {};
    for (const line of lines.slice(hi + 1)) {
      const r = splitCsvLine(line).map((x) => x.replace(/"/g, ""));
      if (!r[0] || /total/i.test(r[0])) continue;
      const v = (name) => parseFloat(r[head.indexOf(name)]) || 0;
      out[r[0].toUpperCase()] = {
        idxFutLong: v("future index long"), idxFutShort: v("future index short"),
        stkFutLong: v("future stock long"), stkFutShort: v("future stock short"),
        idxCallLong: v("option index call long"), idxCallShort: v("option index call short"),
        idxPutLong: v("option index put long"), idxPutShort: v("option index put short"),
      };
    }
    return Object.keys(out).length ? out : null;
  });
}

export async function getPositioning(sessionDates) {
  // The F&O file can appear a little later than the bhavcopy, so fall back a session if needed.
  const tried = sessionDates.slice(-3);
  const found = (await Promise.all(tried.map((d) => participantOi(d).catch(() => null))))
    .map((data, i) => ({ date: tried[i], data })).filter((x) => x.data);
  if (!found.length) return null;
  const last = found[found.length - 1].data, prev = found[found.length - 2]?.data;
  const dates = found.slice(-2).map((x) => x.date);
  const rows = ["FII", "DII", "PRO", "CLIENT"].filter((k) => last[k]).map((k) => {
    const x = last[k], p = prev?.[k];
    const idxNet = x.idxFutLong - x.idxFutShort;
    const stkNet = x.stkFutLong - x.stkFutShort;
    // Options: long calls + short puts are bullish bets; long puts + short calls are bearish.
    const optNet = x.idxCallLong - x.idxCallShort - (x.idxPutLong - x.idxPutShort);
    return {
      who: k === "PRO" ? "Pro (brokers' own trading)" : k === "CLIENT" ? "Retail & other clients" : k,
      idxLongPct: Math.round((x.idxFutLong / (x.idxFutLong + x.idxFutShort || 1)) * 1000) / 10,
      idxNet, idxNetChange: p ? idxNet - (p.idxFutLong - p.idxFutShort) : null,
      stkNet, stkNetChange: p ? stkNet - (p.stkFutLong - p.stkFutShort) : null,
      optNet, optNetChange: p ? optNet - (p.idxCallLong - p.idxCallShort - (p.idxPutLong - p.idxPutShort)) : null,
    };
  });
  return { date: dates[dates.length - 1], prevDate: prev ? dates[0] : null, rows };
}
