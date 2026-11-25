// Batch quotes from Yahoo Finance's spark endpoint (up to 20 NSE symbols per call).
// Returns [{ symbol, meta }] where meta has regularMarketPrice, chartPreviousClose, regularMarketVolume, etc.
export async function sparkBatch(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols.map((s) => encodeURIComponent(s + ".NS")).join(",")}&range=1d&interval=1d`;
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(url.replace("query1", host), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      return (data.spark?.result || []).map((r) => ({ symbol: r.symbol.replace(/\.NS$/, ""), meta: r.response?.[0]?.meta })).filter((x) => x.meta);
    } catch {}
  }
  return [];
}

// Quotes for many symbols, 20 per call with `concurrency` calls in flight.
export async function sparkMany(symbols, concurrency = 10) {
  const batches = [];
  for (let i = 0; i < symbols.length; i += 20) batches.push(symbols.slice(i, i + 20));
  const quotes = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < batches.length) quotes.push(...(await sparkBatch(batches[next++])));
  }));
  return quotes;
}
