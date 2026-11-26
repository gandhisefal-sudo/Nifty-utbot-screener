// Zerodha Kite Connect helpers.
// The user's Kite access token lives ONLY in an httpOnly, SameSite=Strict cookie in their own browser.
// The server never stores it, so a visitor without that cookie can't read data or place orders.

import { createHash } from "node:crypto";

const API = "https://api.kite.trade";
export const COOKIE = "kite_at";

export const apiKey = () => process.env.KITE_API_KEY || "";
export const apiSecret = () => process.env.KITE_API_SECRET || "";
export const configured = () => !!(apiKey() && apiSecret());

export const loginUrl = () => `https://kite.zerodha.com/connect/login?v=3&api_key=${encodeURIComponent(apiKey())}`;

export function readToken(req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)kite_at=([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// Kite tokens expire at 6:00 am IST the next day; the cookie expires with it.
export function tokenCookie(token) {
  const now = Date.now();
  let exp = new Date(now);
  exp.setUTCHours(0, 30, 0, 0); // 06:00 IST
  if (exp.getTime() <= now) exp = new Date(exp.getTime() + 864e5);
  const maxAge = Math.max(60, Math.floor((exp.getTime() - now) / 1000));
  return `${COOKIE}=${token}; Path=/api/kite; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/api/kite; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export class KiteError extends Error {
  constructor(message, status, type) { super(message); this.status = status; this.type = type; }
}

async function call(path, { token, method = "GET", form } = {}) {
  const headers = { "X-Kite-Version": "3" };
  if (token) headers.Authorization = `token ${apiKey()}:${token}`;
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const res = await fetch(API + path, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, signal: AbortSignal.timeout(10000) });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || body?.status !== "success") {
    throw new KiteError(body?.message || `Kite error (HTTP ${res.status})`, res.status, body?.error_type);
  }
  return body.data;
}

export function createSession(requestToken) {
  const checksum = createHash("sha256").update(apiKey() + requestToken + apiSecret()).digest("hex");
  return call("/session/token", { method: "POST", form: { api_key: apiKey(), request_token: requestToken, checksum } });
}
export const invalidate = (token) => call(`/session/token?api_key=${encodeURIComponent(apiKey())}&access_token=${encodeURIComponent(token)}`, { token, method: "DELETE" });
export const profile = (token) => call("/user/profile", { token });
export const quotes = (token, ids) => call(`/quote?${ids.map((i) => `i=${encodeURIComponent(i)}`).join("&")}`, { token });
export const positions = (token) => call("/portfolio/positions", { token });
export const orders = (token) => call("/orders", { token });
export const placeOrder = (token, o) => call("/orders/regular", { token, method: "POST", form: o });

// ---- NFO instrument list (public, ~3 MB; refreshed every few hours) ----
let inst = null; // { at, byKey: Map("NAME|YYYY-MM-DD|strike|CE"), bySymbol: Map }
export async function instruments() {
  if (inst && Date.now() - inst.at < 4 * 3600e3) return inst;
  const res = await fetch(`${API}/instruments/NFO`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Kite instrument list HTTP ${res.status}`);
  const byKey = new Map(), bySymbol = new Map();
  for (const line of (await res.text()).split(/\r?\n/).slice(1)) {
    const c = line.split(",");
    if (c.length < 12 || c[10] !== "NFO-OPT") continue;
    const row = { tradingsymbol: c[2], name: c[3].replace(/"/g, ""), expiry: c[5], strike: Number(c[6]), tick: Number(c[7]) || 0.05, lot: Number(c[8]), type: c[9] };
    byKey.set(`${row.name}|${row.expiry}|${row.strike}|${row.type}`, row);
    bySymbol.set(row.tradingsymbol, row);
  }
  inst = { at: Date.now(), byKey, bySymbol };
  return inst;
}

// Kite's spot instrument for an F&O underlying.
const INDEX_SPOT = { NIFTY: "NSE:NIFTY 50", BANKNIFTY: "NSE:NIFTY BANK", FINNIFTY: "NSE:NIFTY FIN SERVICE", MIDCPNIFTY: "NSE:NIFTY MID SELECT", NIFTYNXT50: "NSE:NIFTY NEXT 50" };
export const spotId = (sym) => INDEX_SPOT[sym] || `NSE:${sym}`;

// Same-origin check for state-changing requests (on top of the SameSite=Strict cookie).
export function sameOrigin(req) {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try { return new URL(origin).host === new URL(req.url).host; } catch { return false; }
}

export const noStore = { "Cache-Control": "no-store, private" };
