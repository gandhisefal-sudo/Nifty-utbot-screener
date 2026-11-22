import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { NSE_EQUITIES } from "../../lib/nse-equities.mjs";

// Stock news from public feeds, rated positive/negative per NSE stock by Claude.
// Results are cached at the CDN for 10 minutes, so the AI runs at most ~6 times an hour.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
export const FEEDS = [
  { source: "NSE announcements", url: "https://archives.nseindia.com/content/RSS/Online_announcements.xml", official: true },
  { source: "Economic Times", url: "https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms" },
  { source: "Economic Times", url: "https://economictimes.indiatimes.com/markets/stocks/earnings/rssfeeds/2143429.cms" },
  { source: "Business Standard", url: "https://www.business-standard.com/rss/markets-106.rss" },
  { source: "Livemint", url: "https://www.livemint.com/rss/markets" },
  { source: "Google News", url: "https://news.google.com/rss/search?q=(NSE%20OR%20Sensex%20OR%20Nifty)%20shares%20stock%20when:1d&hl=en-IN&gl=IN&ceid=IN:en" },
];
// Look back to the previous trading session: 24h on Tue–Fri, 72h on weekends and Mondays.
const maxAgeHours = (now) => ([0, 1, 6].includes(new Date(now + 19800e3).getUTCDay()) ? 72 : 24);
const MAX_ITEMS = 120;
const BATCH = 30; // items per AI request; batches run in parallel to keep the response fast

const decode = (s = "") => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ").trim();
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]);

// NSE's feed uses "14-Nov-2026 02:37:11" (IST); the others use RFC 822 dates.
function parseDate(s) {
  const m = s.match(/^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (m) return Date.parse(`${m[2]} ${m[1]} ${m[3]} ${m[4]}:${m[5]}:${m[6]} GMT+0530`);
  return Date.parse(s);
}

export async function readFeed(feed) {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
      let title = tag(it, "title");
      // Google News appends " - Publisher" to titles.
      const publisher = feed.source === "Google News" ? title.match(/ - ([^-]+)$/)?.[1] : null;
      if (publisher) title = title.slice(0, -publisher.length - 3);
      return {
        title,
        summary: tag(it, "description").slice(0, 300),
        link: tag(it, "link"),
        time: parseDate(tag(it, "pubDate")) || null,
        source: publisher ? `${publisher} (Google News)` : feed.source,
        official: !!feed.official,
      };
    }).filter((x) => x.title);
  } catch {
    return [];
  }
}

// ---- Matching company names to NSE symbols ----
const SYMBOLS = new Set(NSE_EQUITIES.map((s) => s.symbol));
const norm = (s) => s.toLowerCase().replace(/&/g, " and ").replace(/\b(limited|ltd|the|india|co|company|corporation|corp|inc)\b\.?/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
const BY_NAME = new Map(NSE_EQUITIES.map((s) => [norm(s.name), s.symbol]));
function resolveSymbol(symbol, company) {
  const sym = (symbol || "").toUpperCase().replace(/\.NS$/, "").trim();
  if (SYMBOLS.has(sym)) return sym;
  const n = norm(company || "");
  if (!n) return null;
  if (BY_NAME.has(n)) return BY_NAME.get(n);
  // Unique prefix match, e.g. "Tata Motors Passenger Vehicles" -> full listed name.
  const hits = [...BY_NAME.keys()].filter((k) => k.startsWith(n + " ") || n.startsWith(k + " "));
  return hits.length === 1 ? BY_NAME.get(hits[0]) : null;
}

// ---- Rating with Claude ----
const Rating = z.object({
  ratings: z.array(z.object({
    id: z.number().int(),
    company: z.string().describe("Listed Indian company the item is mainly about, or empty if none"),
    symbol: z.string().describe("Its NSE trading symbol, e.g. RELIANCE, M&M, BAJAJ-AUTO; empty if unsure or not listed"),
    sentiment: z.enum(["positive", "negative", "neutral"]),
    impact: z.enum(["high", "medium", "low"]),
    category: z.enum(["results", "order_win", "deal_or_merger", "dividend_buyback_bonus", "rating_or_target", "management", "regulatory_or_legal", "fundraise_or_stake", "product_or_expansion", "macro_or_sector", "routine_filing", "other"]),
    reason: z.string().describe("One short sentence on why this is likely to move the stock up or down"),
  })),
});

const SYSTEM = `You rate news for Indian stock traders. For each numbered item, identify the single NSE-listed company it is mainly about and judge the likely short-term (same or next session) effect on that stock's price.
- sentiment: positive if the news is likely to push the price up, negative if down, neutral if it should not matter much or the direction is unclear. Judge against what traders would expect: results that miss expectations are negative even if profit grew.
- impact: high for surprises that commonly move a stock several percent (big results beat/miss, large orders relative to company size, mergers, regulatory bans, fraud, rating changes by major brokers); low for routine filings (trading window closure, investor meet intimation, compliance certificates, newspaper ads) and general market commentary.
- Items about the overall market, indices, IPOs not yet listed, or foreign companies: leave company and symbol empty and use category macro_or_sector or other.
Rate every item exactly once, using its id.`;

async function rate(items) {
  const client = new Anthropic();
  const batches = [];
  for (let i = 0; i < items.length; i += BATCH) batches.push(i);
  const results = await Promise.allSettled(batches.map(async (start) => {
    const batch = items.slice(start, start + BATCH);
    const got = await rateBatch(client, batch, start);
    // Retry once for any items the model skipped.
    const have = new Set(got.map((r) => r.id));
    const missing = batch.map((_, i) => start + i).filter((id) => !have.has(id));
    if (!missing.length) return got;
    const retry = await rateBatch(client, missing.map((id) => items[id]), 0, missing).catch(() => []);
    return got.concat(retry);
  }));
  results.filter((r) => r.status === "rejected").forEach((r) => console.error("news batch failed", r.reason?.status, String(r.reason?.message).slice(0, 300)));
  const ok = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  if (!ok.length) throw results.find((r) => r.status === "rejected")?.reason || new Error("no ratings");
  return ok;
}

async function rateBatch(client, items, offset, ids = items.map((_, i) => offset + i)) {
  const list = items.map((it, i) => `[${ids[i]}] (${it.source}) ${it.title}${it.summary && it.summary !== it.title ? ` — ${it.summary}` : ""}`).join("\n");
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    output_config: { effort: "low", format: zodOutputFormat(Rating) },
    system: SYSTEM,
    messages: [{ role: "user", content: `${list}\n\nThere are ${items.length} items. Return exactly ${items.length} ratings, one for each id: ${ids.join(", ")}.` }],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new Error(`rating failed: ${response.stop_reason}`);
  return response.parsed_output.ratings;
}

export default async () => {
  const now = Date.now();
  const seen = new Set();
  const items = (await Promise.all(FEEDS.map(readFeed))).flat()
    .filter((x) => !x.time || now - x.time < maxAgeHours(now) * 3600e3)
    // Drop auto-generated price pages that aren't news.
    .filter((x) => !/share price live updates|stock price history|stock price today live/i.test(x.title))
    .filter((x) => { const k = (x.title + " " + x.summary).toLowerCase().slice(0, 160); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.official - a.official) || (b.time || 0) - (a.time || 0))
    .slice(0, MAX_ITEMS);

  if (!items.length) return Response.json({ error: "No news could be loaded right now." }, { status: 502, headers: { "Cache-Control": "no-store" } });

  let ratings;
  try {
    ratings = await rate(items);
  } catch (err) {
    console.error("news rating failed", err?.status, err?.message);
    return Response.json({ error: "News rating is unavailable right now. Try again in a few minutes." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const byId = new Map(ratings.map((r) => [r.id, r]));
  const news = items.map((it, i) => {
    const r = byId.get(i);
    if (!r) return null;
    return { ...it, ...r, id: undefined, symbol: resolveSymbol(r.symbol, r.company) };
  }).filter(Boolean).sort((a, b) => (b.time || 0) - (a.time || 0));

  return Response.json(
    { updatedAt: new Date(now).toISOString(), count: news.length, news },
    {
      headers: {
        "Cache-Control": "public, max-age=120",
        "Netlify-CDN-Cache-Control": "public, max-age=600, stale-while-revalidate=120",
        // Ignore query strings in the cache key, so nobody can force fresh (paid) AI runs.
        "Netlify-Vary": "query=v",
      },
    }
  );
};

export const config = { path: "/api/news" };
