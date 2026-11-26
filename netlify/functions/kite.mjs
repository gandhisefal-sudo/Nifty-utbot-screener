import * as K from "../../lib/kite.mjs";

// /api/kite/login      -> redirects to Zerodha's login page
// /api/kite/callback   -> Kite redirects here after login; stores the access token in an httpOnly cookie
// /api/kite/status     -> { configured, connected, user }
// /api/kite/logout     -> ends the Kite session and clears the cookie (POST)
// /api/kite/quote      -> live premiums for option contracts + live spot (POST JSON)
// /api/kite/positions  -> today's NFO positions
// /api/kite/order      -> places ONE limit order the user confirmed on the page (POST JSON)

const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...K.noStore, ...extra } });
const redirect = (to, cookie) => new Response(null, { status: 302, headers: { Location: to, ...K.noStore, ...(cookie ? { "Set-Cookie": cookie } : {}) } });
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

function kiteFail(e, clear) {
  // TokenException = expired / revoked login: clear the cookie so the page asks to reconnect.
  if (e?.type === "TokenException") return json({ error: "Your Kite login has expired. Connect Kite again.", reconnect: true }, 401, { "Set-Cookie": K.clearCookie() });
  return json({ error: e?.message || "Kite request failed." }, e?.status && e.status < 500 ? 400 : 502, clear ? { "Set-Cookie": K.clearCookie() } : {});
}

async function readJson(req) {
  if (!(req.headers.get("content-type") || "").includes("application/json")) return null;
  try { return await req.json(); } catch { return null; }
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.replace(/^\/api\/kite\/?/, "").replace(/\/$/, "");

  if (action === "status") {
    if (!K.configured()) return json({ configured: false, connected: false });
    const token = K.readToken(req);
    if (!token) return json({ configured: true, connected: false });
    try {
      const p = await K.profile(token);
      return json({ configured: true, connected: true, user: { name: p.user_shortname || p.user_name, id: p.user_id } });
    } catch (e) {
      return json({ configured: true, connected: false, error: e.type === "TokenException" ? "Kite login expired." : e.message }, 200, e.type === "TokenException" ? { "Set-Cookie": K.clearCookie() } : {});
    }
  }

  if (!K.configured()) return json({ error: "Kite isn't set up on this site yet (API key and secret missing)." }, 503);

  if (action === "login") return redirect(K.loginUrl());

  if (action === "callback") {
    const rt = url.searchParams.get("request_token");
    if (url.searchParams.get("status") !== "success" || !rt || !/^[A-Za-z0-9]+$/.test(rt)) return redirect("/?kite=cancelled#otBox");
    try {
      const s = await K.createSession(rt);
      return redirect("/?kite=connected#otBox", K.tokenCookie(s.access_token));
    } catch (e) {
      return redirect(`/?kite=error&msg=${encodeURIComponent(e.message).slice(0, 200)}#otBox`);
    }
  }

  const token = K.readToken(req);
  if (!token) return json({ error: "Not connected to Kite.", reconnect: true }, 401);

  if (action === "logout") {
    if (req.method !== "POST" || !K.sameOrigin(req)) return json({ error: "Bad request." }, 403);
    try { await K.invalidate(token); } catch {}
    return json({ ok: true }, 200, { "Set-Cookie": K.clearCookie() });
  }

  if (action === "quote") {
    if (req.method !== "POST" || !K.sameOrigin(req)) return json({ error: "Bad request." }, 403);
    const body = await readJson(req);
    const contracts = Array.isArray(body?.contracts) ? body.contracts.slice(0, 200) : [];
    const spots = Array.isArray(body?.spots) ? body.spots.filter((s) => /^[A-Z0-9&\-]{1,20}$/.test(s)).slice(0, 50) : [];
    let inst;
    try { inst = await K.instruments(); } catch (e) { return json({ error: e.message }, 502); }
    const resolved = {};
    for (const c of contracts) {
      const key = `${String(c.name).toUpperCase()}|${c.expiry}|${Number(c.strike)}|${c.type}`;
      const row = inst.byKey.get(key);
      if (row) resolved[key] = row;
    }
    const ids = [...new Set([...Object.values(resolved).map((r) => `NFO:${r.tradingsymbol}`), ...spots.map(K.spotId)])];
    if (!ids.length) return json({ options: {}, spots: {} });
    let q;
    try { q = await K.quotes(token, ids); } catch (e) { return kiteFail(e); }
    const options = {};
    for (const [key, row] of Object.entries(resolved)) {
      const d = q[`NFO:${row.tradingsymbol}`];
      if (!d) continue;
      const bid = d.depth?.buy?.find((x) => x.price > 0)?.price ?? null, ask = d.depth?.sell?.find((x) => x.price > 0)?.price ?? null;
      options[key] = { tradingsymbol: row.tradingsymbol, lot: row.lot, tick: row.tick, ltp: d.last_price, bid, ask, oi: d.oi, volume: d.volume, prevClose: d.ohlc?.close ?? null, time: d.last_trade_time || d.timestamp };
    }
    const spotOut = {};
    for (const s of spots) {
      const d = q[K.spotId(s)];
      if (d) spotOut[s] = { ltp: d.last_price, chg: d.ohlc?.close ? r2(((d.last_price - d.ohlc.close) / d.ohlc.close) * 100) : null };
    }
    return json({ at: new Date().toISOString(), options, spots: spotOut });
  }

  if (action === "positions") {
    try {
      const p = await K.positions(token);
      const net = (p.net || []).filter((x) => x.exchange === "NFO").map((x) => ({ tradingsymbol: x.tradingsymbol, product: x.product, quantity: x.quantity, avg: x.average_price, ltp: x.last_price, pnl: r2(x.pnl) }));
      return json({ positions: net });
    } catch (e) { return kiteFail(e); }
  }

  if (action === "order") {
    if (req.method !== "POST" || !K.sameOrigin(req)) return json({ error: "Bad request." }, 403);
    const b = await readJson(req);
    if (!b) return json({ error: "Bad request." }, 400);
    let inst;
    try { inst = await K.instruments(); } catch (e) { return json({ error: e.message }, 502); }
    const row = inst.bySymbol.get(String(b.tradingsymbol || ""));
    if (!row) return json({ error: "Unknown option contract." }, 400);
    const side = b.side === "SELL" ? "SELL" : b.side === "BUY" ? "BUY" : null;
    const product = b.product === "NRML" ? "NRML" : "MIS";
    const lots = parseInt(b.lots, 10);
    const price = Math.round(Number(b.price) / row.tick) * row.tick;
    if (!side) return json({ error: "Side must be BUY or SELL." }, 400);
    if (!(lots >= 1 && lots <= 50)) return json({ error: "Lots must be between 1 and 50." }, 400);
    if (!(price > 0)) return json({ error: "Enter a limit price." }, 400);
    try {
      const d = await K.placeOrder(token, {
        tradingsymbol: row.tradingsymbol, exchange: "NFO", transaction_type: side, order_type: "LIMIT",
        quantity: String(lots * row.lot), product, validity: "DAY", price: price.toFixed(2), tag: "optrigger",
      });
      return json({ ok: true, orderId: d.order_id, tradingsymbol: row.tradingsymbol, side, quantity: lots * row.lot, price: r2(price), product });
    } catch (e) { return kiteFail(e); }
  }

  return json({ error: "Unknown Kite action." }, 404);
};

export const config = { path: "/api/kite/*" };
