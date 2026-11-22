const NIFTY_50 = [
  "RELIANCE.NS", "BHARTIARTL.NS", "HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS",
  "TCS.NS", "BAJFINANCE.NS", "LT.NS", "KOTAKBANK.NS", "HINDUNILVR.NS",
  "INFY.NS", "SUNPHARMA.NS", "TITAN.NS", "ADANIPORTS.NS", "M&M.NS",
  "AXISBANK.NS", "MARUTI.NS", "HCLTECH.NS", "ADANIENT.NS", "ULTRACEMCO.NS",
  "ITC.NS", "ETERNAL.NS", "JSWSTEEL.NS", "NTPC.NS", "BAJAJ-AUTO.NS",
  "BAJAJFINSV.NS", "ONGC.NS", "BEL.NS", "COALINDIA.NS", "POWERGRID.NS",
  "ASIANPAINT.NS", "TATASTEEL.NS", "SHRIRAMFIN.NS", "INDIGO.NS", "HINDALCO.NS",
  "GRASIM.NS", "EICHERMOT.NS", "SBILIFE.NS", "TECHM.NS", "TRENT.NS",
  "BSE.NS", "JIOFIN.NS", "HDFCLIFE.NS", "APOLLOHOSP.NS", "DRREDDY.NS",
  "CIPLA.NS", "TMPV.NS", "TATACONSUM.NS", "MAXHEALTH.NS", "INDUSINDBK.NS"
];

function calculateUTBot(closes, highs, lows, timestamps, keyValue = 1, atrPeriod = 10) {
  const tr = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
    } else {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      tr.push(Math.max(hl, hc, lc));
    }
  }

  // Wilder's Smoothing (RMA) for ATR
  const atr = new Array(closes.length).fill(0);
  let sum = 0;
  for (let i = 0; i < atrPeriod; i++) sum += tr[i];
  atr[atrPeriod - 1] = sum / atrPeriod;
  for (let i = atrPeriod; i < closes.length; i++) {
    atr[i] = (atr[i - 1] * (atrPeriod - 1) + tr[i]) / atrPeriod;
  }

  // UT Bot ATR Trailing Stop
  const stop = new Array(closes.length).fill(0);
  for (let i = atrPeriod; i < closes.length; i++) {
    const nLoss = keyValue * atr[i];
    const prevStop = stop[i - 1];
    const curr = closes[i];
    const prev = closes[i - 1];

    if (curr > prevStop && prev > prevStop) {
      stop[i] = Math.max(prevStop, curr - nLoss);
    } else if (curr < prevStop && prev < prevStop) {
      stop[i] = Math.min(prevStop, curr + nLoss);
    } else if (curr > prevStop) {
      stop[i] = curr - nLoss;
    } else {
      stop[i] = curr + nLoss;
    }
  }

  // Check last 2 completed intraday candles for a fresh Buy crossover
  const last = closes.length - 1;
  const prev = closes.length - 2;
  const prev2 = closes.length - 3;

  const freshBuy = closes[last] > stop[last] && closes[prev] <= stop[prev];
  const recentBuy = closes[prev] > stop[prev] && closes[prev2] <= stop[prev2];

  return {
    isBuy: freshBuy || recentBuy,
    status: freshBuy ? "NEW BUY" : "RECENT BUY (1 bar ago)",
    close: closes[last]?.toFixed(2),
    stop: stop[last]?.toFixed(2),
    candleTime: timestamps[last]
  };
}

async function scanStock(symbol, interval, keyValue, atrPeriod) {
  try {
    const url = `https://yahoo.com{encodeURIComponent(symbol)}?interval=${interval}&range=5d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;

    const quote = result.indicators.quote[0];
    const rawTs = result.timestamp || [];
    const closes = [], highs = [], lows = [], timestamps = [];

    for (let i = 0; i < quote.close.length; i++) {
      if (quote.close[i] != null && quote.high[i] != null && quote.low[i] != null) {
        closes.push(quote.close[i]);
        highs.push(quote.high[i]);
        lows.push(quote.low[i]);
        timestamps.push(rawTs[i]);
      }
    }

    if (closes.length <= atrPeriod + 5) return null;

    const signal = calculateUTBot(closes, highs, lows, timestamps, keyValue, atrPeriod);
    if (!signal.isBuy) return null;

    return {
      symbol: symbol.replace(".NS", ""),
      status: signal.status,
      close: signal.close,
      trailingStop: signal.stop,
      candleTime: signal.candleTime
    };
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  const params = event.queryStringParameters || {};
  const interval = ["5m", "15m", "1h"].includes(params.interval) ? params.interval : "5m";
  const keyValue = parseFloat(params.keyValue) || 1;
  const atrPeriod = parseInt(params.atrPeriod, 10) || 10;

  const results = await Promise.all(
    NIFTY_50.map((symbol) => scanStock(symbol, interval, keyValue, atrPeriod))
  );

  const buySignals = results.filter(Boolean);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      updatedAt: new Date().toISOString(),
      interval,
      scannedCount: NIFTY_50.length,
      buySignals
    })
  };
};
