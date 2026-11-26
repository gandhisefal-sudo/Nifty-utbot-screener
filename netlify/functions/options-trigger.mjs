import { getCandles, INDEX_YAHOO } from "../../lib/candles.mjs";
import { runSession, htfDirections } from "../../lib/options-trigger.mjs";
import { getSession, impliedVol, bsPrice, bsDelta, yearsTo } from "../../lib/nse-fo.mjs";

// GET /api/options-trigger?symbols=NIFTY,BANKNIFTY,RELIANCE&expiry=nearest|monthly|nextMonthly
//     &strike=atm|itm1|otm1&tf=5m&or=15&mode=live|close&minConfirm=5&exitCount=2&keyValue=2&atrPeriod=14
// GET /api/options-trigger?list=1   -> every F&O symbol with its expiries
// Live CE / PE buy triggers (opening-range break + indicator confirmation) and early exits, with the
// option contract to buy and its estimated premium. Triggers use the live underlying price; option
// premiums are ESTIMATES (Black-Scholes from the live price and last session's implied volatility),
// because NSE's live option chain isn't open to automated access.

const MAX_SYMBOLS = 8;
const HTF = { "3m": "15m", "5m": "15m", "15m": "1h" };
const IST = 19800;
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// Expiry list with weekly / monthly labels. Monthly = the last expiry of its calendar month.
function labelExpiries(expiries, todayIso) {
  const list = expiries.filter((x) => x >= todayIso).sort();
  return list.map((x) => ({ date: x, monthly: !list.some((y) => y > x && y.slice(0, 7) === x.slice(0, 7)) }));
}
function pickExpiry(labels, which) {
  if (!labels.length) return null;
  if (which === "nearest") return labels[0];
  const monthly = labels.filter((x) => x.monthly);
  if (which === "nextMonthly") return monthly[1] || monthly[0] || labels[0];
  return monthly[0] || labels[0];
}

// Years from a moment (unix seconds) to 3:30 pm IST on expiry day; at least ~1 trading hour.
function yearsLeft(expiry, ts) {
  const close = Date.parse(`${expiry}T10:00:00Z`) / 1000; // 15:30 IST
  return Math.max(3600, close - ts) / (365 * 86400);
}

function contractFor(u, sess, expiry, spotRef, call, strikeMode) {
  const chain = u.options.get(expiry);
  if (!chain || !chain.size) return null;
  const strikes = [...chain.keys()].filter((k) => chain.get(k)[call ? "CE" : "PE"]).sort((a, b) => a - b);
  if (!strikes.length) return null;
  let ai = 0;
  strikes.forEach((k, i) => { if (Math.abs(k - spotRef) < Math.abs(strikes[ai] - spotRef)) ai = i; });
  // ITM for a call = lower strike, for a put = higher strike.
  const shift = strikeMode === "itm1" ? (call ? -1 : 1) : strikeMode === "otm1" ? (call ? 1 : -1) : 0;
  const k = strikes[Math.min(strikes.length - 1, Math.max(0, ai + shift))];
  const leg = chain.get(k)[call ? "CE" : "PE"];
  // Implied volatility at last session's close; fall back to the ATM strike's, then a typical level.
  let iv = impliedVol(leg.close, u.spot, k, yearsTo(sess.date, expiry), call);
  if (!iv) {
    const atm = chain.get(strikes[ai])[call ? "CE" : "PE"];
    iv = atm && impliedVol(atm.close, u.spot, strikes[ai], yearsTo(sess.date, expiry), call);
  }
  const ivUsed = iv || (u.type === "index" ? 14 : 30);
  return { strike: k, iv: ivUsed, ivEstimated: !iv, prevClose: leg.close, oi: leg.oi, vol: leg.vol };
}

function premium(spot, c, expiry, ts, call) {
  const T = yearsLeft(expiry, ts);
  const v = c.iv / 100;
  return { price: r2(Math.max(0.05, bsPrice(spot, c.strike, T, v, call))), delta: r2(bsDelta(spot, c.strike, T, v, call)) };
}

// Adds the option contract and estimated premiums (entry, stop, targets, now) to a trade or trigger level.
function optionPlan(u, sess, expiry, call, strikeMode, levels, nowSec, symbol) {
  const c = contractFor(u, sess, expiry.date, levels.entry, call, strikeMode);
  if (!c) return null;
  const at = (spot, ts = levels.ts ?? nowSec) => premium(spot, c, expiry.date, ts, call);
  const entry = at(levels.entry);
  const out = {
    name: `${symbol} ${expiry.date} ${c.strike} ${call ? "CE" : "PE"}`, expiry: expiry.date, monthly: expiry.monthly,
    strike: c.strike, type: call ? "CE" : "PE", lot: u.lot, iv: c.iv, ivEstimated: c.ivEstimated,
    prevClose: c.prevClose, oi: c.oi, entry: entry.price, delta: entry.delta,
    capitalPerLot: r2(entry.price * u.lot),
  };
  if (levels.stop != null) out.stop = at(levels.stop).price;
  if (levels.t1 != null) out.t1 = at(levels.t1).price;
  if (levels.t2 != null) out.t2 = at(levels.t2).price;
  if (levels.now != null) out.now = premium(levels.now, c, expiry.date, nowSec, call).price;
  if (levels.exit != null) out.exit = at(levels.exit, levels.exitTs).price;
  return out;
}

const json = (body, status = 200) => Response.json(body, {
  status,
  headers: status === 200 ? { "Cache-Control": "no-store", "Netlify-CDN-Cache-Control": "public, max-age=10" } : { "Cache-Control": "no-store" },
});

export default async (req) => {
  const p = new URL(req.url).searchParams;
  let sess = null;
  try { sess = await getSession(); } catch {}
  const todayIso = new Date(Date.now() + IST * 1000).toISOString().slice(0, 10);

  if (p.get("list") === "1") {
    if (!sess) return json({ error: "Couldn't load NSE's F&O list right now." }, 502);
    const rows = [...sess.underlyings.values()].map((u) => ({ symbol: u.symbol, type: u.type, lot: u.lot }))
      .sort((a, b) => (a.type === b.type ? a.symbol.localeCompare(b.symbol) : a.type === "index" ? -1 : 1));
    return Response.json({ date: sess.date, rows }, { headers: { "Cache-Control": "public, max-age=3600", "Netlify-CDN-Cache-Control": "public, max-age=3600" } });
  }

  const tf = HTF[p.get("tf")] ? p.get("tf") : "5m";
  const orMinutes = [5, 15, 30].includes(parseInt(p.get("or"), 10)) ? parseInt(p.get("or"), 10) : 15;
  const live = p.get("mode") !== "close";
  const expiryMode = ["nearest", "monthly", "nextMonthly"].includes(p.get("expiry")) ? p.get("expiry") : "monthly";
  const strikeMode = ["atm", "itm1", "otm1"].includes(p.get("strike")) ? p.get("strike") : "atm";
  const keyValue = Math.min(Math.max(parseFloat(p.get("keyValue")) || 2, 0.1), 10);
  const atrPeriod = Math.min(Math.max(parseInt(p.get("atrPeriod"), 10) || 14, 1), 100);
  const mc = parseInt(p.get("minConfirm"), 10);
  const ec = parseInt(p.get("exitCount"), 10);
  const exitCount = Number.isNaN(ec) ? 2 : Math.min(Math.max(ec, 1), 6);
  const symbols = [...new Set((p.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9&\-]{1,20}$/.test(s)))].slice(0, MAX_SYMBOLS);
  if (!symbols.length) return json({ error: "Pass ?symbols=NIFTY,BANKNIFTY,..." }, 400);

  const nowSec = Math.floor(Date.now() / 1000);
  const results = {};
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const u = sess?.underlyings.get(symbol);
      const isIndex = u ? u.type === "index" : !!INDEX_YAHOO[symbol];
      const [k, hk, h1] = await Promise.all([
        getCandles(symbol, tf, { confirmedOnly: !live }),
        getCandles(symbol, HTF[tf], { confirmedOnly: !live }).catch(() => null),
        tf === "15m" ? null : getCandles(symbol, "1h", { confirmedOnly: !live }).catch(() => null),
      ]);
      const htf = htfDirections(hk, keyValue, atrPeriod);
      const maxChecks = isIndex ? 6 : 7;
      const minConfirm = Number.isNaN(mc) ? maxChecks - 2 : Math.min(Math.max(mc, 0), maxChecks);
      const r = runSession(k, { orMinutes, minConfirm, exitCount, keyValue, atrPeriod, isIndex, live, nowSec, htf });
      if (r.error) { results[symbol] = { error: r.error }; return; }
      const ltp = k.quote?.ltp ?? r.ltp;

      // Multi-timeframe trend: UT Bot and Supertrend direction now on each timeframe.
      const mtf = [];
      const addTf = (label, d) => { if (d) mtf.push({ tf: label, ut: d.dir[d.dir.length - 1], st: d.st[d.st.length - 1] }); };
      addTf(tf, htfDirections(k, keyValue, atrPeriod));
      addTf(HTF[tf], htf);
      if (h1) addTf("1h", htfDirections(h1, keyValue, atrPeriod));

      // Option overlay.
      let expiry = null, options = null;
      if (u && u.options.size) {
        const labels = labelExpiries([...u.options.keys()], todayIso);
        expiry = pickExpiry(labels, expiryMode);
        if (expiry) {
          options = { expiries: labels, expiry };
          for (const tr of r.trades) {
            tr.option = optionPlan(u, sess, expiry, tr.side === 1, strikeMode, {
              entry: tr.entry, stop: tr.initialStop, t1: tr.t1, t2: tr.t2, ts: tr.entryTime,
              now: tr.open ? ltp : null, exit: tr.exit, exitTs: tr.exitTime,
            }, nowSec, symbol);
          }
          if (r.or) {
            // Ready-made orders for the next trigger on each side, priced at the trigger level.
            const risk = Math.max(r.atr || 0, ltp * 0.002);
            options.pending = {
              CE: optionPlan(u, sess, expiry, true, strikeMode, { entry: r.or.high, stop: Math.max(r.or.low, r.or.high - 1.5 * risk), t1: r.or.high + risk, ts: nowSec }, nowSec, symbol),
              PE: optionPlan(u, sess, expiry, false, strikeMode, { entry: r.or.low, stop: Math.min(r.or.high, r.or.low + 1.5 * risk), t1: r.or.low - risk, ts: nowSec }, nowSec, symbol),
            };
          }
        }
      }
      results[symbol] = { symbol, type: isIndex ? "index" : "stock", lot: u?.lot ?? null, fno: !!u, quote: k.quote, ltp: r2(ltp), mtf, options, ...r };
    } catch {
      results[symbol] = { error: "No live data for this symbol right now." };
    }
  }));

  return json({ updatedAt: new Date().toISOString(), nowSec, foDate: sess?.date ?? null, tf, htf: HTF[tf], orMinutes, mode: live ? "live" : "close", expiryMode, strikeMode, exitCount, results });
};

export const config = { path: "/api/options-trigger" };
