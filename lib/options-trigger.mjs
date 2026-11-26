// Live CE / PE trigger engine for option buyers.
// Routine: wait for the opening range (first 15 minutes by default), then watch the entry timeframe
// (5m by default). BUY CE when price breaks above the opening-range high, BUY PE when it breaks below
// the low, and only when enough trend/momentum indicators agree. Once in, exit early as soon as
// several indicators turn against the trade, or on the stop, Target 2 or 3:15 pm.
// All triggers are on the UNDERLYING (stock / index price). Option premiums are estimated separately.

import { ema, atr, rsi, macd, utBot, supertrend, sessionVwap, istDate } from "./indicators.mjs";

const IST = 19800;
const OPEN_MIN = 9 * 60 + 15;
const NO_ENTRY_MIN = 14 * 60 + 45;
const SQUARE_OFF_MIN = 15 * 60 + 15;
const minOfDay = (ts) => Math.floor(((ts + IST) % 86400) / 60);
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// Direction of a higher-timeframe series at time ts (the last HTF candle that started at or before ts).
function dirAt(htf, ts) {
  if (!htf) return 0;
  let lo = 0, hi = htf.t.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (htf.t[m] <= ts) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 ? htf.dir[k] : 0;
}

export function htfDirections(k, keyValue, atrPeriod) {
  if (!k || k.c.length < 30) return null;
  const ut = utBot(k.h, k.l, k.c, keyValue, atrPeriod);
  const st = supertrend(k.h, k.l, k.c, 10, 3);
  return { t: k.t, dir: ut.dir, st: st.dir };
}

// candles: entry-timeframe candles (may include the still-forming candle when live).
// opts: { orMinutes, minConfirm, exitCount, keyValue, atrPeriod, isIndex, live, nowSec, htf }
export function runSession(candles, opts) {
  const { orMinutes = 15, minConfirm = 5, exitCount = 2, keyValue = 2, atrPeriod = 14, isIndex = false, live = true, nowSec = Math.floor(Date.now() / 1000), htf = null } = opts;
  const { t, e, h, l, c, v } = candles;
  const n = c.length;
  if (n < 40) return { error: "Not enough candle history." };

  const ut = utBot(h, l, c, keyValue, atrPeriod);
  const st = supertrend(h, l, c, 10, 3);
  const vw = sessionVwap(h, l, c, v, t);
  const e9 = ema(c, 9), e21 = ema(c, 21);
  const rs = rsi(c, 14);
  const m = macd(c);
  const a = atr(h, l, c, 14);

  const last = n - 1;
  const sessionDate = istDate(t[last]);
  let s0 = last;
  while (s0 > 0 && istDate(t[s0 - 1]) === sessionDate) s0--;
  const dayStart = t[s0] - ((t[s0] + IST) % 86400); // 00:00 IST in UTC seconds
  const orStart = dayStart + OPEN_MIN * 60;
  const orEnd = orStart + orMinutes * 60;
  const forming = live && e[last] > nowSec; // last candle still trading

  // Opening range.
  let orHigh = -Infinity, orLow = Infinity, first = -1;
  for (let i = s0; i <= last; i++) {
    if (t[i] < orEnd) { orHigh = Math.max(orHigh, h[i]); orLow = Math.min(orLow, l[i]); }
    else if (first < 0) first = i;
  }
  const orComplete = Number.isFinite(orHigh) && (first >= 0 || nowSec >= orEnd);
  const or = Number.isFinite(orHigh) ? { high: r2(orHigh), low: r2(orLow), start: orStart, end: orEnd, complete: orComplete } : null;

  const checks = (i, side) => {
    const ok = (x) => (side === 1 ? x > 0 : x < 0);
    const list = [
      { name: "UT Bot", ok: ut.dir[i] === side },
      { name: "Supertrend", ok: st.dir[i] === side },
      { name: "EMA 9/21", ok: ok(e9[i] - e21[i]) },
      { name: "RSI", ok: side === 1 ? rs[i] >= 50 && rs[i] <= 80 : rs[i] <= 50 && rs[i] >= 20 },
      { name: "MACD", ok: ok(m.hist[i]) },
      { name: "Higher TF", ok: htf ? dirAt(htf, t[i]) === side : false },
    ];
    // Yahoo has no volume for indices, so VWAP is meaningless there.
    if (!isIndex) list.splice(2, 0, { name: "VWAP", ok: ok(c[i] - vw[i]) });
    return list;
  };
  // Indicators that have turned AGAINST an open trade (checked on closed candles).
  const against = (i, side) => {
    const bad = (x) => (side === 1 ? x < 0 : x > 0);
    const list = [];
    if (ut.dir[i] === -side) list.push("UT Bot flipped");
    if (st.dir[i] === -side) list.push("Supertrend flipped");
    if (!isIndex && bad(c[i] - vw[i])) list.push("Back through VWAP");
    if (bad(e9[i] - e21[i])) list.push("EMA 9/21 crossed");
    if (side === 1 ? rs[i] < 45 : rs[i] > 55) list.push(side === 1 ? "RSI under 45" : "RSI over 55");
    if (bad(m.hist[i])) list.push("MACD turned");
    return list;
  };

  const trades = [];
  let pos = null;
  const blocked = { 1: false, [-1]: false }; // after an exit, a side needs a reset before re-entry
  const maxChecks = checks(last, 1).length;
  const end = forming ? last : last - (e[last] > nowSec ? 1 : 0); // never use a forming candle in close mode

  if (orComplete && first >= 0) {
    for (let i = first; i <= end; i++) {
      const isForming = forming && i === last;
      const mod = minOfDay(t[i]);
      if (pos) {
        const p = pos, side = p.side;
        let exit = null;
        if (side === 1 ? l[i] <= p.stop : h[i] >= p.stop) {
          exit = { price: p.stop, reason: p.t1Hit ? "Exit at cost after Target 1" : "Stop loss hit" };
        } else {
          if (!p.t1Hit && (side === 1 ? h[i] >= p.t1 : l[i] <= p.t1)) { p.t1Hit = true; p.t1Time = t[i]; p.stop = p.entry; }
          if (side === 1 ? h[i] >= p.t2 : l[i] <= p.t2) exit = { price: p.t2, reason: "Target 2 hit" };
        }
        if (!exit && !isForming) {
          const bad = against(i, side);
          p.warnings = bad;
          if (bad.length >= exitCount) exit = { price: c[i], reason: `Early exit: ${bad.join(" + ")}` };
          else if (mod >= SQUARE_OFF_MIN) exit = { price: c[i], reason: "Time exit (3:15 pm)" };
        }
        if (isForming) p.warnings = against(i - 1, side);
        if (exit) {
          Object.assign(p, { open: false, exit: r2(exit.price), exitTime: isForming ? nowSec : e[i], reason: exit.reason, pnlPts: r2(side * (exit.price - p.entry)) });
          blocked[side] = true;
          pos = null;
        } else {
          p.ltp = r2(c[i]);
          p.pnlPts = r2(side * (c[i] - p.entry));
        }
        continue;
      }
      // Re-entry on a side needs the price back inside the opening range, or a fresh UT Bot flip
      // into that side, so one choppy move doesn't fire trade after trade. Max 3 trades per side.
      for (const s of [1, -1]) {
        if (blocked[s] && ((c[i] <= orHigh && c[i] >= orLow) || (ut.dir[i] === s && ut.dir[i - 1] === -s))) blocked[s] = false;
      }
      if (mod >= NO_ENTRY_MIN) continue;
      const side = c[i] > orHigh ? 1 : c[i] < orLow ? -1 : 0;
      if (!side || blocked[side] || trades.filter((x) => x.side === side).length >= 3) continue;
      const ch = checks(i, side);
      const score = ch.filter((x) => x.ok).length;
      if (score < minConfirm) continue;
      const entry = c[i];
      const atrI = a[i] || entry * 0.004;
      // Stop: the tightest of the opposite OR side, 1.5×ATR and the UT Bot trailing stop; at least 0.5×ATR away.
      const cands = [side === 1 ? orLow : orHigh, entry - side * 1.5 * atrI];
      if (ut.stop[i] != null && side * (entry - ut.stop[i]) > 0) cands.push(ut.stop[i]);
      let stop = side === 1 ? Math.max(...cands) : Math.min(...cands);
      if (side * (entry - stop) < 0.5 * atrI) stop = entry - side * 0.5 * atrI;
      const risk = Math.abs(entry - stop);
      pos = {
        side, type: side === 1 ? "CE" : "PE", open: true, live: isForming,
        entryTime: isForming ? nowSec : e[i], candleTime: t[i], entry: r2(entry), stop: r2(stop), initialStop: r2(stop),
        t1: r2(entry + side * risk), t2: r2(entry + side * 2 * risk), riskPts: r2(risk),
        score, maxScore: ch.length, checks: ch, t1Hit: false, warnings: [], ltp: r2(entry), pnlPts: 0,
      };
      trades.push(pos);
    }
  }

  const ltp = c[last];
  const ready = (side) => { const ch = checks(last, side); return { score: ch.filter((x) => x.ok).length, max: ch.length, checks: ch }; };
  const open = trades.find((x) => x.open) || null;
  let status;
  if (!or) status = "NO_SESSION";
  else if (!orComplete) status = "OPENING_RANGE";
  else if (open) status = open.type === "CE" ? "IN_CE" : "IN_PE";
  else if (minOfDay(t[last]) >= NO_ENTRY_MIN || (!forming && nowSec > dayStart + SQUARE_OFF_MIN * 60)) status = "DONE";
  else status = "ARMED";

  return {
    sessionDate, status, ltp: r2(ltp), forming, or, maxChecks, minConfirm,
    readiness: { CE: ready(1), PE: ready(-1) },
    trades, atr: r2(a[last]),
    lastCandle: t[last],
  };
}
