/* ==========================================================================
   QuantPulse — live market data manager
   --------------------------------------------------------------------------
   Transport + polling + market clock. The analytics merge itself lives in
   core.js (it owns the data structures); this module:

     • polls the /api/quotes serverless function (Netlify) with fallbacks,
     • keeps a per-ticker live quote store (price, change, session stats),
     • tracks connection mode  (live | snapshot)  and exposes a pub/sub,
     • computes the US equity session clock in America/New_York,
     • fetches on-demand intraday series for the terminal chart.

   Everything degrades gracefully: if the function is unreachable (e.g. the
   bundle is opened as a plain static site), the app simply stays on its
   bundled snapshot and shows a "snapshot" badge.
   ========================================================================== */
(function () {
  "use strict";

  var QP = (window.QP = window.QP || {});

  /* ------------------------------ config ------------------------------- */
  var API_PATHS = ["/api/quotes", "/.netlify/functions/quotes"];
  var DEFAULT_INTERVAL_SEC = 30;
  var ERROR_BACKOFF = [15, 30, 60, 120]; // seconds between retries while failing

  /* ------------------------------- state ------------------------------- */
  var S = {
    mode: "connecting",        // connecting | live | snapshot
    intervalSec: DEFAULT_INTERVAL_SEC,
    lastSuccess: null,         // epoch ms
    lastAttempt: null,
    errorCount: 0,
    quotes: {},                // SYM -> normalized quote (see normalizeQuote)
    fetchedAt: null,           // server timestamp of last payload
    tick: 0,
  };

  /* ------------------------------- pub/sub ----------------------------- */
  var subs = { quotes: [], status: [], intraday: [] };
  function on(topic, cb) {
    if (subs[topic]) subs[topic].push(cb);
    return function () { off(topic, cb); };
  }
  function off(topic, cb) {
    if (!subs[topic]) return;
    var i = subs[topic].indexOf(cb);
    if (i >= 0) subs[topic].splice(i, 1);
  }
  function emit(topic, arg) {
    (subs[topic] || []).slice().forEach(function (cb) {
      try { cb(arg); } catch (e) { console.error("[live] subscriber error", e); }
    });
  }

  /* --------------------------- market clock ---------------------------- */
  // All session logic uses America/New_York (exchange time), computed from
  // the client clock. US federal holidays are not modelled — the label is
  // an approximation; live quotes remain authoritative for prices.
  var etFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  function etParts() {
    var parts = {};
    etFmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
    var wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
    return {
      year: +parts.year, month: +parts.month, day: +parts.day,
      hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second,
      weekday: wd, // 0 = Mon … 6 = Sun
      dateStr: parts.year + "-" + parts.month + "-" + parts.day,
      timeStr: ("0" + (parts.hour % 24)).slice(-2) + ":" + parts.minute + ":" + parts.second,
    };
  }
  function minutesOf(p) { return p.hour * 60 + p.minute + p.second / 60; }

  function marketStatus() {
    var p = etParts();
    var m = minutesOf(p);
    var wd = p.weekday;
    if (wd >= 5) return { state: "closed", label: "Weekend · US markets closed" };
    if (m < 4 * 60) return { state: "closed", label: "Closed · opens 4:00 pre-market" };
    if (m < 9 * 60 + 30) return { state: "pre", label: "Pre-market" };
    if (m < 16 * 60) return { state: "open", label: "US markets open" };
    if (m < 20 * 60) return { state: "post", label: "After hours" };
    return { state: "closed", label: "US markets closed" };
  }
  // A bar dated today counts as *completed* once the session has ended
  // (16:05 ET guard) — until then it is a forming/live bar.
  function todayBarCompleted() {
    var p = etParts();
    if (p.weekday >= 5) return true;          // weekend: today has no bar
    return minutesOf(p) >= 16 * 60 + 5;
  }
  function etTodayStr() { return etParts().dateStr; }

  /* --------------------------- fetch & poll ---------------------------- */
  var apiBase = null;   // resolved on first success
  var timer = null;
  var inFlight = false; // guards against overlapping polls (slow request +
                        // visibilitychange/refresh/timer all able to fire it)

  function urlFor(base, params) {
    var qs = Object.keys(params)
      .map(function (k) { return k + "=" + encodeURIComponent(params[k]); })
      .join("&");
    return base + "?" + qs;
  }

  function fetchJSON(url, timeoutMs) {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timerId = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs || 12000);
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .finally(function () { clearTimeout(timerId); });
  }

  // Try each API path until one works, then stick with it.
  function fetchQuotes(params) {
    var bases = apiBase ? [apiBase] : API_PATHS.slice();
    var idx = 0;
    function attempt() {
      if (idx >= bases.length) return Promise.reject(new Error("live endpoint unavailable"));
      return fetchJSON(urlFor(bases[idx], params), 14000).then(
        function (j) { apiBase = bases[idx]; return j; },
        function (e) { idx++; return attempt(); }
      );
    }
    return attempt();
  }

  function normalizeQuote(sym, q) {
    var price = q.price;
    var prev = q.previousClose;
    var chg = q.change != null ? q.change : (price != null && prev != null ? price - prev : null);
    return {
      ticker: sym,
      price: price,
      prevClose: prev,
      change: chg,
      changePct: chg != null && prev ? chg / prev : null,
      dayOpen: q.dayOpen, dayHigh: q.dayHigh, dayLow: q.dayLow,
      volume: q.volume,               // raw shares (latest bar)
      marketTime: q.marketTime,
      dates: q.dates || [],            // exchange-local dates
      labels: q.labels || q.dates || [], // display labels (datetime for intraday)
      ohlcv: q.ohlcv || [],            // aligned [o,h,l,c,v] (v raw shares)
      splits: q.splits || [],          // corporate actions: [date, num, den]
      dividends: q.dividends || [],    // [date, amount] — used by the
    };                                 // ex-dividend-aware split detector
  }

  function poll() {
    if (inFlight) return;               // a fetch is still outstanding
    inFlight = true;
    S.lastAttempt = Date.now();
    var params = { range: "1mo", interval: "1d" };
    fetchQuotes(params).then(function (j) {
      inFlight = false;
      if (!j || !j.ok || !j.quotes) throw new Error("bad payload");
      S.errorCount = 0;
      S.lastSuccess = Date.now();
      S.fetchedAt = j.fetchedAt;
      var quotes = {};
      Object.keys(j.quotes).forEach(function (sym) {
        quotes[sym] = normalizeQuote(sym, j.quotes[sym]);
      });
      S.quotes = quotes;
      S.tick++;
      if (S.mode !== "live") { S.mode = "live"; emit("status", S.mode); }
      emit("quotes", { quotes: quotes, fetchedAt: j.fetchedAt, failed: j.failed || [] });
      scheduleNext();
    }).catch(function (err) {
      inFlight = false;
      S.errorCount++;
      // emit only on the actual transition — like the success path — so
      // repeated failures do not re-trigger status subscribers pointlessly
      if (S.mode !== "snapshot") { S.mode = "snapshot"; emit("status", S.mode); }
      scheduleNext(true);
    });
  }

  function scheduleNext(isError) {
    clearTimeout(timer);
    if (S.intervalSec <= 0) return;                 // manual mode
    var delay;
    if (isError) {
      var bi = Math.min(S.errorCount - 1, ERROR_BACKOFF.length - 1);
      delay = ERROR_BACKOFF[Math.max(0, bi)] * 1000;
    } else {
      delay = S.intervalSec * 1000;
    }
    timer = setTimeout(function () {
      if (document.hidden) { scheduleNext(isError); return; } // skip while hidden, keep the error-backoff rhythm
      poll();
    }, delay);
  }

  /* ------------------------- intraday requests -------------------------- */
  // QP.live.fetchSeries("AAPL", "1d", "5m") -> Promise<{dates, ohlcv, meta}>
  var seriesCache = new Map(); // key -> {at, data}
  function fetchSeries(symbol, range, interval) {
    var key = symbol + "|" + range + "|" + interval;
    var hit = seriesCache.get(key);
    if (hit && Date.now() - hit.at < 15000) return Promise.resolve(hit.data);
    return fetchQuotes({ symbols: symbol, range: range, interval: interval }).then(function (j) {
      var q = j.quotes && j.quotes[symbol];
      if (!q) throw new Error("no data for " + symbol);
      var data = {
        symbol: symbol,
        dates: q.dates || [],
        labels: q.labels || q.dates || [],
        ohlcv: q.ohlcv || [],
        price: q.price, previousClose: q.previousClose,
        marketTime: q.marketTime,
        splits: q.splits || [],
        dividends: q.dividends || [],
      };
      seriesCache.set(key, { at: Date.now(), data: data });
      return data;
    });
  }

  /* ------------------------------- public ------------------------------- */
  QP.live = {
    state: function () { return S; },
    on: on, off: off,
    marketStatus: marketStatus,
    etTodayStr: etTodayStr,
    etClock: etParts,
    todayBarCompleted: todayBarCompleted,
    fetchSeries: fetchSeries,
    refresh: poll,
    setInterval: function (sec) {
      S.intervalSec = sec;
      clearTimeout(timer);
      if (sec > 0) scheduleNext();
      emit("status", S.mode);
    },
    quote: function (sym) { return S.quotes[sym] || null; },
    isLive: function () { return S.mode === "live"; },

    start: function () {
      // kick off immediately, then on the schedule
      poll();
      // re-poll when the tab becomes visible again
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden && S.intervalSec > 0) {
          if (!S.lastSuccess || Date.now() - S.lastSuccess > S.intervalSec * 1000) poll();
        }
      });
    },
  };
})();
