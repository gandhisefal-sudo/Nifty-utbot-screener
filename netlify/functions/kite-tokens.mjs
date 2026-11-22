// Maps NSE symbols to Zerodha Kite instrument tokens (needed for Kite chart links),
// from Kite's public instrument list. Cached for a day at the CDN.
export default async () => {
  try {
    const res = await fetch("https://api.kite.trade/instruments/NSE", { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tokens = {};
    for (const line of (await res.text()).split(/\r?\n/).slice(1)) {
      const cols = line.split(",");
      // instrument_token, exchange_token, tradingsymbol, ... segment, exchange (last two columns)
      if (cols.length < 12 || cols[cols.length - 2] !== "NSE") continue;
      tokens[cols[2]] = Number(cols[0]);
    }
    return Response.json({ tokens }, {
      headers: { "Cache-Control": "public, max-age=3600", "Netlify-CDN-Cache-Control": "public, max-age=86400" },
    });
  } catch {
    return Response.json({ tokens: {} }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};

export const config = { path: "/api/kite-tokens" };
