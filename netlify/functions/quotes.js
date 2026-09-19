/* ==========================================================================
   QuantPulse — Netlify Function: live market data proxy
   --------------------------------------------------------------------------
   Fetches up-to-date OHLCV series + latest quotes from Yahoo Finance's
   public chart endpoint (server-side, so no CORS problems) and returns a
   compact JSON payload the dashboard merges onto its bundled snapshot.

   GET /api/quotes?symbols=AAPL,MSFT&range=1mo&interval=1d

   Response:
   {
     ok: true,
     fetchedAt: "2026-09-19T12:00:00.000Z",
     quotes: {
       AAPL: {
         price, previousClose, change, changePct,        // latest quote
         dayOpen, dayHigh, dayLow, volume,                // session stats
         marketTime,                                      // epoch s of last trade
         dates:  ["2026-09-14", ...],                     // exchange-local dates
         ohlcv:  [[o, h, l, c, v], ...]                   // v = RAW shares
       }, ...
     },
     failed: ["TICKER", ...]                              // symbols that errored
   }

   Notes
   - Volume is returned in RAW shares; the client converts to the
     thousands unit used by the bundled data store.
   - A 20-second in-memory cache per (symbols|range|interval) key keeps
     upstream request volume low when several clients poll at once.
   - Runs on the Netlify Functions runtime (Node 18+, native fetch).
   ========================================================================== */

const UPSTREAMS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) QuantPulse/2.0";
const CACHE_TTL_MS = 20 * 1000;
const FETCH_TIMEOUT_MS = 9000;
const MAX_SYMBOLS = 60;

// Default universe (38 US mega caps) — used when no ?symbols= is given.
const DEFAULT_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AVGO", "ADBE", "CRM", "GOOGL", "META", "NFLX", "DIS",
  "AMZN", "TSLA", "HD", "MCD", "WMT", "PG", "KO", "COST", "JPM", "V",
  "GS", "BLK", "UNH", "JNJ", "LLY", "PFE", "XOM", "CVX", "COP", "BA",
  "CAT", "HON", "LIN", "SHW", "NEE", "DUK", "PLD", "AMT",
];

const RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "ytd", "max"]);
const INTERVALS = new Set(["1d", "1h", "30m", "15m", "5m", "2m"]);

/* --------------------------- module-level cache ------------------------- */
const cache = new Map(); // key -> { at, payload }
if (!globalThis.__qpQuoteCache) globalThis.__qpQuoteCache = cache;

/* ------------------------------ helpers --------------------------------- */
const json = (status, body, extraHeaders) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...(extraHeaders || {}),
  },
  body: JSON.stringify(body),
});

function parseSymbols(qs) {
  const raw = (qs.symbols || "").toUpperCase();
  if (!raw) return DEFAULT_SYMBOLS.slice();
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  const valid = list.filter(s => /^[A-Z0-9.\-=^]{1,10}$/.test(s));
  return valid.slice(0, MAX_SYMBOLS);
}

// Exchange-local date (America/New_York) for an epoch-seconds timestamp.
const etDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const etDateTimeFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
function etDate(epochSec) {
  return etDateFmt.format(new Date(epochSec * 1000)); // YYYY-MM-DD
}

async function fetchChart(symbol, range, interval) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  let lastErr = null;
  for (const base of UPSTREAMS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(base + path, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`upstream ${res.status}`); continue; }
      const j = await res.json();
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.meta) { lastErr = new Error("bad payload"); continue; }
      return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
    }
  }
  throw lastErr || new Error("fetch failed");
}

function normalize(result, interval) {
  const meta = result.meta || {};
  const ts = result.timestamp || [];
  const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const adj = (result.indicators && result.indicators.adjclose && result.indicators.adjclose[0]) || null;
  const n = ts.length;
  const intraday = interval !== "1d";
  const dates = new Array(n);
  const labels = new Array(n);
  const ohlcv = new Array(n);
  for (let i = 0; i < n; i++) {
    dates[i] = etDate(ts[i]);
    labels[i] = intraday
      ? etDateTimeFmt.format(new Date(ts[i] * 1000)).replace(",", "")
      : dates[i];
    const c = adj && adj[i] != null ? adj[i] : q.close[i];
    ohlcv[i] = [q.open[i], q.high[i], q.low[i], c, q.volume[i]];
  }
  const price = meta.regularMarketPrice != null ? meta.regularMarketPrice : (n ? q.close[n - 1] : null);
  const prevClose = meta.chartPreviousClose != null ? meta.chartPreviousClose
    : n > 1 ? q.close[n - 2] : null;
  const change = price != null && prevClose != null ? price - prevClose : null;
  return {
    price,
    previousClose: prevClose,
    change,
    changePct: change != null && prevClose ? change / prevClose : null,
    dayOpen: n ? q.open[n - 1] : null,
    dayHigh: n ? q.high[n - 1] : null,
    dayLow: n ? q.low[n - 1] : null,
    volume: n ? q.volume[n - 1] : null,
    marketTime: meta.regularMarketTime || null,
    currency: meta.currency || "USD",
    dates,
    labels,
    ohlcv,
  };
}

/* ------------------------------- handler -------------------------------- */
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const symbols = parseSymbols(qs);
  const range = RANGES.has(qs.range) ? qs.range : "1mo";
  const interval = INTERVALS.has(qs.interval) ? qs.interval : "1d";

  if (!symbols.length) return json(400, { ok: false, error: "no valid symbols" });

  const key = symbols.join(",") + "|" + range + "|" + interval;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return json(200, hit.payload, { "X-QP-Cache": "hit" });
  }

  const quotes = {};
  const failed = [];
  const results = await Promise.allSettled(symbols.map(s => fetchChart(s, range, interval)));
  results.forEach((r, i) => {
    const sym = symbols[i];
    if (r.status === "fulfilled") {
      try { quotes[sym] = normalize(r.value, interval); } catch { failed.push(sym); }
    } else failed.push(sym);
  });

  const okCount = Object.keys(quotes).length;
  if (!okCount) {
    return json(502, { ok: false, error: "upstream unavailable", failed });
  }

  const payload = { ok: true, fetchedAt: new Date().toISOString(), range, interval, quotes, failed };
  cache.set(key, { at: Date.now(), payload });
  return json(200, payload, { "X-QP-Cache": "miss" });
};
