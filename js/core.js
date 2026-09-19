/* ==========================================================================
   QuantPulse — analytics core
   --------------------------------------------------------------------------
   Owns the data structures and every quantitative routine:

     • derived matrices (close / returns / benchmark),
     • the LIVE MERGE engine that folds fresh Yahoo bars onto the bundled
       snapshot (completed bars extend history; today's session is kept as
       a "forming" overlay excluded from analytics),
     • 7 cross-sectional factors + composite, computed client-side,
     • rank-IC history (bundled base, client-recomputed tail, live
       extension) + quintile spreads + factor correlation,
     • a position-based backtesting engine (long-only & long-short,
       drift-aware weights, transaction costs),
     • risk analytics (vol, Sharpe, Sortino, VaR/CVaR, beta, drawdowns).

   All heavy results are cached and invalidated when new bars merge.
   ========================================================================== */
(function () {
  "use strict";

  var D = window.QP_DATA;
  if (!D) {
    document.body.innerHTML = '<div style="padding:40px;font-family:monospace;color:#e8ecf8">' +
      "data.js failed to load — please regenerate the bundle.</div>";
    return;
  }

  var QP = (window.QP = window.QP || {});
  var mean = function (a) {
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) { s += a[i]; n++; }
    return n ? s / n : null;
  };
  var std = function (a) {
    var m = mean(a);
    if (m == null) return null;
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  };
  function pctPositive(a) {
    var n = 0, p = 0;
    for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) { n++; if (a[i] > 0) p++; }
    return n ? p / n : null;
  }
  function pearson(x, y) {
    var sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0, n = 0;
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] == null || y[i] == null || !isFinite(x[i]) || !isFinite(y[i])) continue;
      sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; n++;
    }
    if (n < 3) return null;
    var num = n * sxy - sx * sy;
    var den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    return den === 0 ? null : num / den;
  }
  function rankArr(arr) {
    var idx = arr.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return a[0] - b[0]; });
    var r = new Array(arr.length);
    var i = 0;
    while (i < idx.length) {
      var j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      var avg = (i + j) / 2 + 1;
      for (var k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  }
  function spearman(x, y) {
    var pts = [];
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] != null && y[i] != null && isFinite(x[i]) && isFinite(y[i])) pts.push([x[i], y[i]]);
    }
    if (pts.length < 5) return null;
    return pearson(rankArr(pts.map(function (p) { return p[0]; })), rankArr(pts.map(function (p) { return p[1]; })));
  }

  /* ========================== base structures ========================== */
  var TICKERS = D.universe.map(function (u) { return u.ticker; });
  var N = TICKERS.length;
  var BY_TICKER = {};
  D.universe.forEach(function (u) { BY_TICKER[u.ticker] = u; });

  var SECTOR_LIST = [];
  var SECTOR_COLORS = {};
  D.universe.forEach(function (u) {
    if (!(u.sector in SECTOR_COLORS)) {
      SECTOR_COLORS[u.sector] = QP.SERIES8[SECTOR_LIST.length % QP.SERIES8.length];
      SECTOR_LIST.push(u.sector);
    }
  });

  // mutable derived state
  var S = {
    closeMat: [],       // [day][ticker] closes
    rets: [],           // [day][ticker] daily returns (rets[0] = null)
    benchRets: [],      // [day] equal-weight universe daily returns
    monthEnds: [],      // indices of month-end days (+ last bar = partial month)
    dateIdx: {},        // "YYYY-MM-DD" -> index in D.dates
    candleIdx: {},      // "YYYY-MM-DD" -> index in D.candle_dates
  };

  function rebuildDerived() {
    var DAYS = D.dates.length;
    S.closeMat = [];
    for (var i = 0; i < DAYS; i++) {
      var row = new Array(N);
      for (var t = 0; t < N; t++) row[t] = D.close[TICKERS[t]][i];
      S.closeMat.push(row);
    }
    S.rets = [null];
    for (i = 1; i < DAYS; i++) {
      var r = new Array(N);
      for (t = 0; t < N; t++) {
        var a = S.closeMat[i - 1][t], b = S.closeMat[i][t];
        r[t] = a && b ? b / a - 1 : null;
      }
      S.rets.push(r);
    }
    S.benchRets = [0];
    for (i = 1; i < DAYS; i++) {
      S.benchRets.push(D.benchmark[i] / D.benchmark[i - 1] - 1);
    }
    S.dateIdx = {};
    D.dates.forEach(function (d, i) { S.dateIdx[d] = i; });
    S.candleIdx = {};
    D.candle_dates.forEach(function (d, i) { S.candleIdx[d] = i; });
    S.monthEnds = [];
    for (i = 1; i < DAYS; i++) {
      if (D.dates[i].slice(0, 7) !== D.dates[i - 1].slice(0, 7)) S.monthEnds.push(i - 1);
    }
    if (S.monthEnds[S.monthEnds.length - 1] !== DAYS - 1) S.monthEnds.push(DAYS - 1);
    invalidateCaches();
  }

  var DAYS = function () { return D.dates.length; };

  /* ================= corporate actions: split detection ================= */
  /* Ex-dividend-aware split detection at the live-merge boundary.

     Why: the bundled snapshot is frozen on the share basis of its build
     date, while every live bar arrives on the CURRENT basis. When a stock
     splits between the two, the raw chain shows a fake ±ratio% return at
     the boundary (e.g. −50% for a 2:1) that would poison returns, factors,
     backtests and risk stats. Cash dividends, by contrast, are *real*
     price returns under the documented raw-chain convention and must NOT
     be "corrected" — but their ex-date gaps look split-like, so the
     detector factors them out before judging a gap.

     Layers (per ticker, every merge):
       1. AUTHORITATIVE — Yahoo split events newer than the snapshot are
          applied directly: history is rescaled to the new basis (prices ×
          den/num, volumes × num/den) so the boundary return is continuous.
          Events dated ON the last merged bar are cross-checked against that
          bar's realised return: a split-like jump means the event arrived
          late (bar merged undetected) → repair everything except that bar;
          a normal return means the bundle already reflects it → no-op.
       2. SUSPECT — boundary gaps beyond ±20% that no split event and no
          cash dividend explains are handed to the caller for escalation
          (it re-fetches a 1y window whose event calendar is wider).
       3. RESOLUTION — with the 1y events: apply if a split is on record;
          warn (never silently adjust) if prices look like a split but no
          event backs it. Without any feed (API down): a strict client-side
          heuristic (clean ratio on open AND close + corroborating share
          volume, short span only) may apply an *unverified* adjustment.

     Idempotency: a per-ticker registry of applied events plus the fact
     that a rescaled boundary no longer gaps keep repeated polls safe.   */

  var HEUR_RATIOS = [2, 2.5, 3, 4, 5, 6, 7, 8, 10, 15, 20]; // split multiples
  var HEUR_TOL = 0.05;        // relative tolerance, open & close ratio match
  var HEUR_VOL_BAND = [0.3, 4.0]; // volume ratio vs expected num/den
  var GAP_SUSPECT = 0.20;     // |boundary gap| beyond this → investigate
  var DIV_EXPLAINS_TOL = 0.05; // residual after dividend factored out
  var WARN_GAP = 0.35;        // unexplained gap beyond this → user warning
  var EVENT_MISMATCH = 0.10;  // event ratio vs observed gap tolerance
  var LATE_RET_TOL = 0.08;    // last-bar return vs event ratio tolerance

  var SPLIT_APPLIED = {};     // tk -> [{date, ratio, mode}] registry
  var SPLIT_LOG = [];         // applied splits (reporting/UI)

  function round4(x) { return Math.round(x * 1e4) / 1e4; }
  function calDaysBetween(a, b) {
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  }
  // cash dividends with date in (afterDate, uptoDate]
  function dividendSum(dividends, afterDate, uptoDate) {
    var s = 0;
    if (!dividends) return 0;
    for (var i = 0; i < dividends.length; i++) {
      var d = dividends[i][0];
      if (d > afterDate && d <= uptoDate && dividends[i][1] > 0) s += dividends[i][1];
    }
    return s;
  }
  // first payload bar after the snapshot (completed or forming)
  function firstNewBar(q, lastDate) {
    if (!q || !q.dates || !q.ohlcv) return null;
    for (var i = 0; i < q.dates.length; i++) {
      if (q.dates[i] > lastDate) {
        var b = q.ohlcv[i];
        return { date: q.dates[i], o: b ? b[0] : null, c: b ? b[3] : null, v: b ? b[4] : null };
      }
    }
    return null;
  }
  function avgRecentVolumeK(tk, nBars) {
    var cd = D.candles[tk];
    if (!cd || !cd.length) return null;
    var M = cd.length / 5, vals = [];
    for (var b = Math.max(0, M - nBars); b < M; b++) {
      var v = cd[b * 5 + 4];
      if (v != null) vals.push(v);
    }
    return vals.length ? mean(vals) : null; // thousands of shares
  }
  // observed price ratio (dividend-factored) → split params, or null
  function matchHeurRatio(x) {
    for (var i = 0; i < HEUR_RATIOS.length; i++) {
      var R = HEUR_RATIOS[i];
      if (Math.abs(x - 1 / R) / (1 / R) <= HEUR_TOL) return { num: R, den: 1, priceFactor: 1 / R };
      if (Math.abs(x - R) / R <= HEUR_TOL) return { num: 1, den: R, priceFactor: R }; // reverse
    }
    return null;
  }
  function ratioLabel(num, den) {
    function gcd(a, b) { return b ? gcd(b, a % b) : a; }
    var g = gcd(Math.round(num), Math.round(den)) || 1;
    return (Math.round(num) / g) + ":" + (Math.round(den) / g);
  }
  // Rescale bundled history for tk to a new share basis. Bars dated ON or
  // AFTER the split ex-date (cutIdx / cutCandleIdx) already carry the new
  // basis — live bars arrive post-split and the ex-date bar itself opened on
  // the new basis — so only the earlier history is rescaled. cut == null →
  // ex-date is still in the future → rescale everything.
  function rescaleHistory(tk, priceFactor, volFactor, cutIdx, cutCandleIdx) {
    var cl = D.close[tk];
    var stopClose = cutIdx != null ? cutIdx : cl.length;
    for (var i = 0; i < stopClose; i++) if (cl[i] != null) cl[i] = round4(cl[i] * priceFactor);
    var cd = D.candles[tk];
    if (cd && cd.length) {
      var M = cd.length / 5, stopBar = cutCandleIdx != null ? cutCandleIdx : M;
      for (var b = 0; b < stopBar; b++) {
        for (var j = 0; j < 4; j++) {
          var ci = b * 5 + j;
          if (cd[ci] != null) cd[ci] = round4(cd[ci] * priceFactor);
        }
        var vi = b * 5 + 4;
        if (cd[vi] != null) cd[vi] = Math.round(cd[vi] * volFactor);
      }
    }
  }
  function registerSplit(tk, date, ratio, mode) {
    (SPLIT_APPLIED[tk] = SPLIT_APPLIED[tk] || []).push({ date: date, ratio: ratio, mode: mode });
  }
  function applySplit(tk, info) {
    // info: {date, num, den, source, verified, repair}
    if (!(info.num > 0) || !(info.den > 0)) return null;
    var priceFactor = info.den / info.num;
    if (!isFinite(priceFactor) || priceFactor < 0.02 || priceFactor > 50) return null;
    var cutIdx = S.dateIdx ? S.dateIdx[info.date] : null;          // ex-date in history?
    var cutCandle = S.candleIdx ? S.candleIdx[info.date] : null;
    rescaleHistory(tk, priceFactor, info.num / info.den, cutIdx, cutCandle);
    var rec = {
      ticker: tk, date: info.date, ratio: ratioLabel(info.num, info.den),
      priceFactor: priceFactor, source: info.source, verified: !!info.verified,
      repair: !!info.repair,
    };
    registerSplit(tk, info.date, rec.ratio, info.source + (info.repair ? "-repair" : ""));
    SPLIT_LOG.push(rec);
    return rec;
  }
  // Post-application hygiene for the async escalation path: refresh every
  // derived matrix, and when the split ex-date already sits inside history
  // (repair), re-chain the equal-weight benchmark from that day onward.
  function finalizeSplitApplication() {
    var repaired = SPLIT_LOG[SPLIT_LOG.length - 1];
    var exIdx = repaired ? S.dateIdx[repaired.date] : null;
    rebuildDerived();
    if (exIdx != null) {
      rebuildBenchmarkFrom(exIdx);
      rebuildDerived();
    }
  }
  function inRegistry(tk, date, ratio) {
    return (SPLIT_APPLIED[tk] || []).some(function (a) { return a.date === date && a.ratio === ratio; });
  }

  /* Authoritative event handling. Accepts:
       events       [[date, num, den], ...] from the payload
       gapSource    quote/series object for boundary validation
       maxDate      acceptance cutoff for future-dated events (ET today)
     Returns {status: "apply"|"unconfirmed"|"none", rec?, lateIdx?} */
  function handleEventSplits(tk, events, gapSource, lastDate, dividends, maxDate) {
    var sorted = (events || []).slice().sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
    var out = { status: "none", rec: null, repairFromIdx: null };
    var lastIdx = D.dates.length - 1;
    for (var e = 0; e < sorted.length; e++) {
      var d = sorted[e][0], num = +sorted[e][1], den = +sorted[e][2];
      if (!(num > 0) || !(den > 0)) continue;
      var label = ratioLabel(num, den);
      if (inRegistry(tk, d, label)) continue;     // already handled
      if (d > maxDate) continue;                  // not effective yet
      var priceFactor = den / num;
      if (!isFinite(priceFactor) || priceFactor < 0.02 || priceFactor > 50) continue;

      if (d <= lastDate) {
        // Event dated INSIDE the merged history: either its bar merged before
        // the event propagated (late arrival → repair everything strictly
        // BEFORE the ex-date, re-chain the benchmark) or the basis is already
        // continuous (bundle built post-split → no-op, mark seen).
        var exIdx = S.dateIdx ? S.dateIdx[d] : null;
        if (exIdx == null || exIdx < 1) continue;      // ex-date bar not merged yet
        var c1 = D.close[tk][exIdx], c0 = D.close[tk][exIdx - 1];
        var ret = c0 != null && c1 != null ? c1 / c0 - 1 : null;
        var divAdj = Math.max(0.05, 1 - dividendSum(dividends, D.dates[exIdx - 1], d) / (c0 || 1));
        if (ret != null && Math.abs((1 + ret) / (priceFactor * divAdj) - 1) <= LATE_RET_TOL) {
          var rec = applySplit(tk, { date: d, num: num, den: den, source: "event", verified: true, repair: true });
          if (rec) {
            out.status = "apply"; out.rec = rec; out.repairFromIdx = exIdx;
            console.warn("[splits] " + tk + " " + rec.ratio + " event arrived after its bar merged — history repaired");
          }
        } else {
          registerSplit(tk, d, label, "reflected"); // already continuous; mark seen
        }
        continue;
      }

      // d > lastDate: split effective after the snapshot — apply, validating
      // against the boundary gap when one is visible.
      var info = { date: d, num: num, den: den, source: "event", verified: true };
      var gap = firstNewBar(gapSource, lastDate);
      var prevClose = D.close[tk][lastIdx];
      if (!gap || gap.c == null || !(prevClose > 0)) {
        var rec2 = applySplit(tk, info);          // deferred validation
        if (rec2) { out.status = "apply"; out.rec = rec2; }
        continue;
      }
      var divSum = dividendSum(dividends, lastDate, gap.date);
      var expected = priceFactor * Math.max(0.05, 1 - divSum / prevClose);
      var closeMismatch = Math.abs(gap.c / prevClose / expected - 1);
      if (closeMismatch <= EVENT_MISMATCH) {
        var rec3 = applySplit(tk, info);
        if (rec3) { out.status = "apply"; out.rec = rec3; }
        continue;
      }
      // close deviates — a same-day market move? let the OPEN corroborate
      if (gap.o != null && Math.abs(gap.o / prevClose / expected - 1) <= EVENT_MISMATCH * 1.5) {
        info.verified = false;
        var rec4 = applySplit(tk, info);
        if (rec4) {
          out.status = "apply"; out.rec = rec4;
          console.warn("[splits] " + tk + " " + label + " applied — close deviates " +
            (closeMismatch * 100).toFixed(1) + "% from the clean ratio (market move?)");
        }
        continue;
      }
      console.warn("[splits] " + tk + " split event " + label + " not confirmed by prices (gap off " +
        (closeMismatch * 100).toFixed(0) + "%) — not adjusted");
      out.status = "unconfirmed";
      out.ratio = label;
    }
    return out;
  }

  /* Merge-time scan: authoritative events + boundary-gap suspects. */
  function detectSplits(quotes, etInfo) {
    var report = { splits: [], suspects: [], benchmarkRebuildFrom: null };
    var lastDate = D.dates[D.dates.length - 1];
    var lastIdx = D.dates.length - 1;
    TICKERS.forEach(function (tk) {
      var q = quotes[tk];
      if (!q) return;
      var prevClose = D.close[tk][lastIdx];
      if (!(prevClose > 0)) return;

      var ev = handleEventSplits(tk, q.splits, q, lastDate, q.dividends, etInfo.todayStr);
      if (ev.status === "apply" && ev.rec) {
        report.splits.push(ev.rec);
        if (ev.repairFromIdx != null && report.benchmarkRebuildFrom == null) report.benchmarkRebuildFrom = ev.repairFromIdx;
        return;
      }
      if (ev.status === "unconfirmed") {
        report.suspects.push({ ticker: tk, date: lastDate, unconfirmedEvent: ev.ratio });
        return;
      }

      // boundary gap analysis (no split event claims the gap)
      var gap = firstNewBar(q, lastDate);
      if (!gap || gap.c == null) return;
      var observed = gap.c / prevClose;
      if (Math.abs(observed - 1) < GAP_SUSPECT) return;   // ordinary move
      var divSum = dividendSum(q.dividends, lastDate, gap.date);
      var divFactor = Math.max(0.05, 1 - divSum / prevClose);
      if (Math.abs(observed / divFactor - 1) < DIV_EXPLAINS_TOL) return; // ex-div drop — expected
      report.suspects.push({
        ticker: tk, date: gap.date, prevClose: prevClose,
        newClose: gap.c, newOpen: gap.o, newVolume: gap.v,
        observed: observed, divSum: divSum,
        spanDays: calDaysBetween(lastDate, gap.date),
      });
    });
    return report;
  }

  /* Escalation resolver: re-checks a suspect against a 1-year window
     (series = {splits, dividends, ...} from the wider fetch). Pass
     series = null when the feed is unavailable → strict client-side
     heuristic as the last resort. */
  function resolveSuspectedSplit(sus, series, todayStr) {
    var tk = sus.ticker;
    var lastDate = D.dates[D.dates.length - 1];
    var lastIdx = D.dates.length - 1;
    var prevClose = D.close[tk][lastIdx];
    var out = { applied: false, ticker: tk, split: null, warning: null };
    if (!(prevClose > 0)) return out;

    if (series) {
      var ev = handleEventSplits(tk, series.splits, series, lastDate, series.dividends, todayStr);
      if (ev.status === "apply" && ev.rec) {
        finalizeSplitApplication();
        out.applied = true; out.split = ev.rec;
        return out;
      }
      if (ev.status === "unconfirmed") {
        out.warning = "split event " + ev.ratio + " on record but not confirmed by prices — history NOT adjusted";
        return out;
      }
    }

    // re-check the dividend explanation with the wider window
    var divSum = series ? dividendSum(series.dividends, lastDate, sus.date) : (sus.divSum || 0);
    var divFactor = Math.max(0.05, 1 - divSum / prevClose);
    var splitOnly = (sus.observed != null ? sus.observed : (sus.newClose / sus.prevClose)) / divFactor;
    if (Math.abs(splitOnly - 1) < DIV_EXPLAINS_TOL) return out;  // dividend explains it

    if (sus.unconfirmedEvent) {
      out.warning = "split event " + sus.unconfirmedEvent + " unconfirmed — history NOT adjusted, verify manually";
      return out;
    }

    var m = matchHeurRatio(splitOnly);
    if (m && (sus.spanDays == null || sus.spanDays <= 15)) {
      var openOK = sus.newOpen != null && Math.abs(sus.newOpen / sus.prevClose / m.priceFactor - 1) <= HEUR_TOL;
      var volOK = false;
      if (sus.newVolume != null && sus.newVolume > 0) {
        var avgV = avgRecentVolumeK(tk, 5);
        if (avgV > 0) {
          var vr = (sus.newVolume / 1000) / avgV;      // new bar vs bundled basis
          var expectV = 1 / m.priceFactor;             // ≈ num/den
          volOK = vr >= expectV * HEUR_VOL_BAND[0] && vr <= expectV * HEUR_VOL_BAND[1];
        }
      }
      if (!series && openOK && volOK) {
        // feed unavailable but evidence is strong — apply, clearly unverified
        var rec = applySplit(tk, {
          date: sus.date, num: m.num, den: m.den,
          source: "heuristic", verified: false,
        });
        if (rec) {
          finalizeSplitApplication();
          out.applied = true; out.split = rec;
          console.warn("[splits] " + tk + " " + rec.ratio + " applied by unverified heuristic (feed unavailable) — verify manually");
          return out;
        }
      }
      if (m && (series || !openOK || !volOK)) {
        out.warning = "price gap matches a " + ratioLabel(m.num, m.den) +
          " split but " + (series ? "no split event is on record" : "evidence is inconclusive") +
          " — history NOT adjusted, verify manually";
        return out;
      }
    }
    var rawGap = (sus.observed != null ? sus.observed : sus.newClose / sus.prevClose) - 1;
    if (Math.abs(rawGap) > WARN_GAP) {
      out.warning = (rawGap > 0 ? "+" : "") + (rawGap * 100).toFixed(1) +
        "% price gap unexplained by any split or dividend — check data";
    }
    return out;
  }

  // rebuild the equal-weight benchmark from a day index onward (used after
  // a late split repair changes historical returns)
  function rebuildBenchmarkFrom(dayIdx) {
    for (var i = Math.max(1, dayIdx); i < D.dates.length; i++) {
      var rets = S.rets[i] || [], vals = [];
      for (var t = 0; t < N; t++) if (rets[t] != null) vals.push(rets[t]);
      var mr = mean(vals);
      D.benchmark[i] = D.benchmark[i - 1] * (mr != null ? 1 + mr : 1);
    }
  }

  /* ============================ live merge ============================= */
  /* quotes: { SYM: {price, prevClose, ..., dates: [...], ohlcv: [[o,h,l,c,v], ...],
                     splits: [[d,num,den],...], dividends: [[d,amount],...]} }
     Returns { appended: [dates], forming: {SYM: {o,h,l,c,v,date}},
               splits: [applied split records],
               suspects: [gaps needing escalation],
               benchmarkRebuildFrom: dayIdx|null }                            */
  function mergeLiveQuotes(quotes, etInfo) {
    var etToday = etInfo.todayStr;
    var afterClose = etInfo.afterClose;
    var lastDate = D.dates[D.dates.length - 1];
    var appended = [];
    var forming = {};

    // 0) ex-dividend-aware split detection: rescale any ticker whose share
    //    basis changed after the snapshot BEFORE returns are chained, so the
    //    merge below computes continuous returns on the new basis.
    var splitReport = detectSplits(quotes, etInfo);

    // 1) collect candidate completed bars (dates after the bundled snapshot)
    var cand = {}; // date -> {SYM: bar}
    Object.keys(quotes).forEach(function (sym) {
      var q = quotes[sym];
      if (!q.dates || !q.ohlcv) return;
      for (var i = 0; i < q.dates.length; i++) {
        var d = q.dates[i];
        if (d <= lastDate) continue;                      // history stays bundled
        var isCompleted = d < etToday || (d === etToday && afterClose);
        if (!isCompleted) continue;                       // forming session
        if (!cand[d]) cand[d] = {};
        cand[d][sym] = q.ohlcv[i];
      }
    });

    // 2) accept dates covered by a majority of the universe
    var newDates = Object.keys(cand).sort();
    newDates.forEach(function (d) {
      if (Object.keys(cand[d]).length < N * 0.6) return;
      appended.push(d);
      D.dates.push(d);
      D.candle_dates.push(d);
      var rets = [];
      for (var t = 0; t < N; t++) {
        var tk = TICKERS[t];
        var bar = cand[d][tk] || null;
        var px = bar ? bar[3] : null;
        var prevPx = D.close[tk][D.dates.length - 2];
        D.close[tk].push(px);
        // candle arrays (thousands for volume)
        if (bar) {
          D.candles[tk].push(bar[0], bar[1], bar[2], bar[3], bar[4] != null ? Math.round(bar[4] / 1000) : null);
        } else {
          D.candles[tk].push(null, null, null, null, null);
        }
        if (px != null && prevPx != null) rets.push(px / prevPx - 1);
      }
      var mr = mean(rets);
      var prevB = D.benchmark[D.benchmark.length - 1];
      D.benchmark.push(mr != null ? prevB * (1 + mr) : prevB);
    });

    // 3) forming bars (today's session, not yet closed)
    if (!afterClose) {
      Object.keys(quotes).forEach(function (sym) {
        var q = quotes[sym];
        if (!q.dates || !q.ohlcv) return;
        var d = q.dates[q.dates.length - 1];
        if (d !== etToday) return;
        var bar = q.ohlcv[q.ohlcv.length - 1];
        if (!bar || bar[3] == null) return;
        forming[sym] = {
          date: d,
          o: bar[0], h: bar[1], l: bar[2],
          c: q.price != null ? q.price : bar[3],   // freshest trade
          v: bar[4] != null ? bar[4] / 1000 : null,
          live: true,
        };
      });
    }

    if (appended.length || splitReport.splits.length) {
      rebuildDerived();
      // a late split repair rewrites a realised historical return — the
      // equal-weight benchmark must be re-chained from that day onward
      if (splitReport.benchmarkRebuildFrom != null) {
        rebuildBenchmarkFrom(splitReport.benchmarkRebuildFrom);
        rebuildDerived();
      }
    }
    return {
      appended: appended,
      forming: forming,
      splits: splitReport.splits,
      suspects: splitReport.suspects,
    };
  }

  /* ============================ factors ================================ */
  // Each fn(dayIdx) -> array of N scores (higher = better). nulls allowed.
  function volAvgAt(i, win, t) {
    var tk = TICKERS[t];
    var ci = S.candleIdx[D.dates[i]];
    if (ci == null) return null;
    var arr = D.candles[tk];
    var s = 0, n = 0;
    for (var k = ci - win + 1; k <= ci; k++) {
      if (k < 0) continue;
      var v = arr[k * 5 + 4];
      if (v != null) { s += v; n++; }
    }
    return n >= win * 0.7 ? s / n : null;
  }
  function rollingVolAt(i, win, t) {
    var vals = [];
    for (var k = i - win + 1; k <= i; k++) {
      if (k >= 1 && S.rets[k] && S.rets[k][t] != null) vals.push(S.rets[k][t]);
    }
    return vals.length >= Math.floor(win * 0.7) ? std(vals) : null;
  }
  function rsiCutlerAt(i, win, t) {
    var up = 0, dn = 0, cnt = 0;
    for (var k = i - win + 1; k <= i; k++) {
      if (k < 1) continue;
      var a = S.closeMat[k - 1][t], b = S.closeMat[k][t];
      if (a == null || b == null) continue;
      var ch = b - a;
      if (ch > 0) up += ch; else dn -= ch;
      cnt++;
    }
    if (cnt < win * 0.7) return null;
    var aG = up / win, aL = dn / win;
    return aL === 0 ? 100 : 100 - 100 / (1 + aG / aL);
  }

  var FACTOR_LABELS = {
    momentum_12_1: "Momentum 12-1",
    momentum_6m: "Momentum 6M",
    reversal_1m: "1M Reversal",
    low_volatility: "Low Volatility",
    rsi_14: "RSI-14 Oversold",
    near_52w_high: "52W High Proximity",
    volume_trend: "Volume Trend 20/120",
  };

  var FACTOR_FNS = {
    momentum_12_1: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var a = i >= 252 ? S.closeMat[i - 252][t] : null;
        var b = i >= 21 ? S.closeMat[i - 21][t] : null;
        out[t] = a && b ? b / a - 1 : null;
      }
      return out;
    },
    momentum_6m: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var a = i >= 126 ? S.closeMat[i - 126][t] : null;
        var b = S.closeMat[i][t];
        out[t] = a && b ? b / a - 1 : null;
      }
      return out;
    },
    reversal_1m: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var a = i >= 21 ? S.closeMat[i - 21][t] : null;
        var b = S.closeMat[i][t];
        out[t] = a && b ? -(b / a - 1) : null;
      }
      return out;
    },
    low_volatility: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var v = rollingVolAt(i, 20, t);
        out[t] = v == null ? null : -v;
      }
      return out;
    },
    rsi_14: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var v = rsiCutlerAt(i, 14, t);
        out[t] = v == null ? null : -v;
      }
      return out;
    },
    near_52w_high: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var cur = S.closeMat[i][t];
        if (cur == null) { out[t] = null; continue; }
        var hi = -Infinity;
        for (var k = Math.max(0, i - 251); k <= i; k++) {
          if (S.closeMat[k][t] != null) hi = Math.max(hi, S.closeMat[k][t]);
        }
        out[t] = isFinite(hi) ? cur / hi - 1 : null;
      }
      return out;
    },
    volume_trend: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var a = volAvgAt(i, 20, t), b = volAvgAt(i, 120, t);
        out[t] = a != null && b != null ? a / b - 1 : null;
      }
      return out;
    },
  };
  var FACTOR_KEYS = Object.keys(FACTOR_FNS);

  // composite: average cross-sectional z-score of all available factors
  function compositeScores(i) {
    var z = new Array(N).fill(0);
    var cnt = new Array(N).fill(0);
    FACTOR_KEYS.forEach(function (k) {
      var sc = FACTOR_FNS[k](i);
      var vals = sc.filter(function (v) { return v != null; });
      if (vals.length < N * 0.6) return;
      var m = mean(vals), sd = std(vals);
      if (!sd) return;
      for (var t = 0; t < N; t++) {
        if (sc[t] == null) continue;
        z[t] += (sc[t] - m) / sd;
        cnt[t]++;
      }
    });
    for (var t = 0; t < N; t++) z[t] = cnt[t] ? z[t] / cnt[t] : null;
    return z;
  }
  function scoresFor(key, i) {
    if (key === "composite") return compositeScores(i);
    return FACTOR_FNS[key](i);
  }

  /* ======================= IC history + summary ======================== */
  var icCache = {};
  function invalidateCaches() {
    icCache = {};
    quintCache = {};
    factorCorrCache = null;
    riskCache = null;
  }

  function computeICAt(i, key) {
    var sc = scoresFor(key, i);
    var fwd = new Array(N);
    for (var t = 0; t < N; t++) {
      var a = S.closeMat[i][t], b = i + 21 < DAYS() ? S.closeMat[i + 21][t] : null;
      fwd[t] = a != null && b != null ? b / a - 1 : null;
    }
    return spearman(sc, fwd);
  }

  // IC series: labels from month-ends; client-computed where possible,
  // falling back to the bundled offline series (needed for volume_trend
  // before 2023 — the bundle ships only 3y of candle volume data).
  function icData(key) {
    if (icCache[key]) return icCache[key];
    var bundled = D.factors.ic_history[key] || [];
    var bundledDates = D.factors.ic_dates || [];
    var labels = [], ic = [];
    for (var m = 0; m < S.monthEnds.length; m++) {
      var i = S.monthEnds[m];
      var lab = D.dates[i].slice(0, 7);
      labels.push(lab);
      var val = null;
      if (i + 21 < DAYS()) val = computeICAt(i, key);       // full forward window
      if (val == null) {
        var bi = bundledDates.indexOf(lab);
        if (bi >= 0) val = bundled[bi];                     // offline fallback
      }
      ic.push(val);
    }
    // summary
    var vals = ic.filter(function (v) { return v != null; });
    var mn = mean(vals), sd = std(vals);
    var cum = [], run = 0;
    ic.forEach(function (v) {
      if (v == null) { cum.push(null); return; }
      run += v; cum.push(run);
    });
    var out = {
      labels: labels, ic: ic, cum: cum,
      summary: {
        mean: mn, std: sd,
        ir: sd ? mn / sd : null,
        tstat: sd && vals.length ? mn / (sd / Math.sqrt(vals.length)) : null,
        hit: pctPositive(vals),
        n: vals.length,
      },
    };
    icCache[key] = out;
    return out;
  }

  /* ========================= quintile spread =========================== */
  var quintCache = {};
  function quintileSpread(key) {
    if (quintCache[key]) return quintCache[key];
    var sums = [0, 0, 0, 0, 0], cnts = [0, 0, 0, 0, 0], pairs = [[], [], [], [], []];
    for (var m = 0; m < S.monthEnds.length; m++) {
      var i = S.monthEnds[m];
      if (i + 21 >= DAYS()) break;
      var sc = scoresFor(key, i);
      var items = [];
      for (var t = 0; t < N; t++) {
        var a = S.closeMat[i][t], b = S.closeMat[i + 21][t];
        if (sc[t] != null && a != null && b != null) items.push({ t: t, s: sc[t], r: b / a - 1 });
      }
      if (items.length < 10) continue;
      items.sort(function (x, y) { return y.s - x.s; });
      var q = Math.floor(items.length / 5);
      for (var k = 0; k < items.length; k++) {
        var qi = Math.min(4, Math.floor(k / q));            // 0 = best (top scores)
        pairs[qi].push(items[k].r);
        sums[qi] += items[k].r; cnts[qi]++;
      }
    }
    var out = pairs.map(function (arr, qi) {
      var mn = mean(arr);
      var sd = std(arr);
      return {
        q: qi + 1,
        meanMonthly: mn,
        ann: mn != null ? Math.pow(1 + mn, 12) - 1 : null,
        tstat: sd && arr.length ? mn / (sd / Math.sqrt(arr.length)) : null,
        n: arr.length,
      };
    });
    out.ls = {
      meanMonthly: out[0].meanMonthly != null && out[4].meanMonthly != null ? out[0].meanMonthly - out[4].meanMonthly : null,
      label: "Q1 − Q5",
    };
    quintCache[key] = out;
    return out;
  }

  /* ======================== factor correlation ========================= */
  var factorCorrCache = null;
  function factorCorrMatrix(lookbackMonths) {
    if (factorCorrCache && factorCorrCache.lookback === lookbackMonths) return factorCorrCache.m;
    var nM = lookbackMonths || 36;
    var scoreMats = {}; // key -> [month][ticker]
    FACTOR_KEYS.forEach(function (k) { scoreMats[k] = []; });
    var useEnds = S.monthEnds.slice(-nM - 1);
    useEnds.forEach(function (i) {
      FACTOR_KEYS.forEach(function (k) { scoreMats[k].push(scoresFor(k, i)); });
    });
    var m = [];
    for (var a = 0; a < FACTOR_KEYS.length; a++) {
      var row = [];
      for (var b = 0; b < FACTOR_KEYS.length; b++) {
        if (a === b) { row.push(1); continue; }
        var xs = [], ys = [];
        for (var mi = 0; mi < useEnds.length; mi++) {
          var sa = scoreMats[FACTOR_KEYS[a]][mi];
          var sb = scoreMats[FACTOR_KEYS[b]][mi];
          for (var t = 0; t < N; t++) {
            if (sa[t] != null && sb[t] != null) { xs.push(sa[t]); ys.push(sb[t]); }
          }
        }
        row.push(spearman(xs, ys));
      }
      m.push(row);
    }
    factorCorrCache = { lookback: nM, m: m };
    return m;
  }

  /* ========================= backtest engine =========================== */
  function perfMetrics(r, br) {
    var n = r.length;
    var ann = Math.sqrt(252);
    var mu = mean(r) || 0;
    var sd = std(r) || 0;
    var cagr = Math.pow(1 + mu, 252) - 1;
    var vol = sd * ann;
    var sharpe = sd > 0 ? (mu * 252) / (sd * ann) : null;

    var downs = r.filter(function (v) { return v < 0; });
    var dsd = downs.length ? Math.sqrt(downs.reduce(function (s, v) { return s + v * v; }, 0) / downs.length) * ann : 0;
    var sortino = dsd > 0 ? (mu * 252) / dsd : null;

    var eq = 1, peak = 1, maxdd = 0;
    for (var i = 0; i < n; i++) {
      eq *= 1 + r[i];
      peak = Math.max(peak, eq);
      maxdd = Math.min(maxdd, eq / peak - 1);
    }
    var calmar = maxdd < 0 ? cagr / -maxdd : null;

    // skew
    var skew = null;
    if (sd > 0 && n > 2) {
      var m3 = 0;
      for (i = 0; i < n; i++) m3 += Math.pow(r[i] - mu, 3);
      skew = (m3 / n) / Math.pow(sd, 3);
    }

    // alpha/beta vs benchmark (daily OLS)
    var alpha = null, beta = null;
    if (br) {
      var pairs = [];
      for (i = 0; i < n && i < br.length; i++) {
        if (r[i] != null && br[i] != null) pairs.push([br[i], r[i]]);
      }
      if (pairs.length > 60) {
        var sx = 0, sy = 0, sxx = 0, sxy = 0, m = pairs.length;
        for (i = 0; i < m; i++) {
          sx += pairs[i][0]; sy += pairs[i][1];
          sxx += pairs[i][0] * pairs[i][0]; sxy += pairs[i][0] * pairs[i][1];
        }
        beta = (m * sxy - sx * sy) / (m * sxx - sx * sx);
        alpha = ((sy - beta * sx) / m) * 252;
      }
    }
    return {
      cagr: cagr, vol: vol, sharpe: sharpe, sortino: sortino,
      maxdd: maxdd, calmar: calmar, winRate: pctPositive(r),
      alpha: alpha, beta: beta, skew: skew, totalReturn: eq - 1,
    };
  }

  /* cfg: {signal, signalFn, startIdx, topN, rebalMonths, costBps, mode: "long"|"longshort"}
     signalFn(dayIdx) -> array of N scores lets external models (e.g. the ML lab)
     drive the same position engine; startIdx postpones the first rebalance.  */
  function runBacktest(cfg) {
    var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    var DAYS_ = DAYS();
    var rebalDays = [];
    var lastPeriod = -1;
    var startIdx = 252;
    if (cfg.startIdx) startIdx = Math.max(startIdx, cfg.startIdx);
    if (cfg.signal === "volume_trend") {
      // needs 120d of candle volume before the first rebalance
      var firstCandleDate = D.candle_dates[0];
      var firstCandleIdx = S.dateIdx[firstCandleDate] || 0;
      startIdx = Math.max(startIdx, firstCandleIdx + 121);
    }
    for (var i = startIdx; i < DAYS_ - 1; i++) {
      var ym = D.dates[i].slice(0, 7);
      var p = parseInt(ym.slice(0, 4), 10) * 12 + parseInt(ym.slice(5, 7), 10);
      if (Math.floor(p / cfg.rebalMonths) !== lastPeriod) {
        rebalDays.push(i);
        lastPeriod = Math.floor(p / cfg.rebalMonths);
      }
    }
    if (!rebalDays.length) return null;

    var weights = new Array(N).fill(0);   // drifted weights (sum |w| ≈ 1)
    var holdingsTickers = [];
    var equity = [100], eqDates = [D.dates[rebalDays[0] - 1]];
    var portRets = [0];
    var turnoverTotal = 0, nRebal = 0;
    var nextRebal = 0;
    var monthly = {}; // "YYYY-MM" -> compounded return

    for (i = rebalDays[0]; i < DAYS_; i++) {
      if (nextRebal < rebalDays.length && i === rebalDays[nextRebal]) {
        var scores;
        if (cfg.signalFn) {
          scores = cfg.signalFn(i);
        } else if (cfg.signal === "equal_weight") {
          scores = new Array(N).fill(0);
        } else {
          scores = scoresFor(cfg.signal, i);
        }
        var idx = [];
        for (var t = 0; t < N; t++) {
          if (scores[t] != null && S.rets[i] && S.rets[i][t] != null) idx.push(t);
        }
        idx.sort(function (a, b) { return scores[b] - scores[a]; });
        var pick;
        var wNew = new Array(N).fill(0);
        if (cfg.signal === "equal_weight") {
          pick = idx;
          for (var p2 = 0; p2 < pick.length; p2++) wNew[pick[p2]] = 1 / pick.length;
        } else if (cfg.mode === "longshort") {
          var top = idx.slice(0, cfg.topN);
          var bot = idx.slice(-cfg.topN).reverse();
          pick = top.concat(bot);
          for (p2 = 0; p2 < top.length; p2++) wNew[top[p2]] = 0.5 / top.length;
          for (p2 = 0; p2 < bot.length; p2++) wNew[bot[p2]] -= 0.5 / bot.length;
        } else {
          pick = idx.slice(0, cfg.topN);
          for (p2 = 0; p2 < pick.length; p2++) wNew[pick[p2]] = 1 / pick.length;
        }
        // turnover vs drifted weights -> cost
        var turn = 0;
        for (t = 0; t < N; t++) turn += Math.abs(wNew[t] - weights[t]);
        turnoverTotal += turn; nRebal++;
        var cost = (turn / 2) * (cfg.costBps / 10000);

        // day's return on the OLD book, then switch at the close
        var drR = 0;
        if (S.rets[i]) {
          for (t = 0; t < N; t++) {
            if (weights[t] !== 0 && S.rets[i][t] != null) drR += weights[t] * S.rets[i][t];
          }
        }
        var dayNet = drR - cost;
        var eq = equity[equity.length - 1] * (1 + dayNet);
        equity.push(eq); eqDates.push(D.dates[i]);
        portRets.push(dayNet);
        var ymR = D.dates[i].slice(0, 7);
        monthly[ymR] = (monthly[ymR] == null ? 1 : monthly[ymR]) * (1 + dayNet);
        weights = wNew;
        holdingsTickers = pick;
        nextRebal++;
        continue;
      }
      // normal day: portfolio return = sum(w_drifted * r), then drift weights
      var dr = 0;
      if (S.rets[i]) {
        for (t = 0; t < N; t++) {
          if (weights[t] !== 0 && S.rets[i][t] != null) dr += weights[t] * S.rets[i][t];
        }
      }
      var eq2 = equity[equity.length - 1] * (1 + dr);
      equity.push(eq2); eqDates.push(D.dates[i]);
      portRets.push(dr);
      var ymN = D.dates[i].slice(0, 7);
      monthly[ymN] = (monthly[ymN] == null ? 1 : monthly[ymN]) * (1 + dr);
      // drift
      if (1 + dr !== 0) {
        for (t = 0; t < N; t++) {
          var rt = S.rets[i] ? S.rets[i][t] : null;
          if (weights[t] !== 0 && rt != null) weights[t] = weights[t] * (1 + rt) / (1 + dr);
        }
      }
    }

    // benchmark aligned to the same dates
    var bench = [100];
    for (i = rebalDays[0]; i < DAYS_; i++) {
      bench.push(bench[bench.length - 1] * (1 + S.benchRets[i]));
    }
    var benchDaily = [];
    for (i = 1; i < bench.length; i++) benchDaily.push(bench[i] / bench[i - 1] - 1);

    var res = {
      dates: eqDates, equity: equity, benchmark: bench, benchDaily: benchDaily,
      rets: portRets, holdings: holdingsTickers,
      nDays: equity.length - 1,
      turnoverAnn: nRebal ? (turnoverTotal / nRebal) * (12 / cfg.rebalMonths) : 0,
      monthly: monthly,
      elapsed: (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
    };
    res.metrics = perfMetrics(portRets.slice(1), benchDaily);
    // monthly returns for the heatmap + best/worst
    var mRets = Object.keys(monthly).sort().map(function (k) { return monthly[k] - 1; });
    res.metrics.bestMonth = mRets.length ? Math.max.apply(null, mRets) : null;
    res.metrics.worstMonth = mRets.length ? Math.min.apply(null, mRets) : null;
    return res;
  }

  /* ============================ risk lab =============================== */
  var riskCache = null;
  function assetRisk() {
    if (riskCache) return riskCache;
    var DAYS_ = DAYS();
    var out = [];
    for (var t = 0; t < N; t++) {
      var rs = [];
      for (var i = 1; i < DAYS_; i++) {
        if (S.rets[i] && S.rets[i][t] != null) rs.push(S.rets[i][t]);
      }
      var m = perfMetrics(rs, S.benchRets.slice(1));
      var sorted = rs.slice().sort(function (a, b) { return a - b; });
      var k = Math.floor(sorted.length * 0.05);
      var var95 = sorted[k];
      var tail = sorted.slice(0, k + 1);
      var cvar95 = tail.reduce(function (s, v) { return s + v; }, 0) / tail.length;
      out.push({
        ticker: TICKERS[t], name: BY_TICKER[TICKERS[t]].name,
        vol: m.vol, sharpe: m.sharpe, sortino: m.sortino, maxdd: m.maxdd,
        var95: var95, cvar95: cvar95, beta: m.beta, cagr: m.cagr,
        skew: m.skew,
      });
    }
    riskCache = out;
    return out;
  }

  function corrMatrix(lookbackDays) {
    var DAYS_ = DAYS();
    var window = Math.min(lookbackDays, DAYS_ - 1);
    var series = [];
    for (var t = 0; t < N; t++) {
      var arr = [];
      for (var i = DAYS_ - window; i < DAYS_; i++) {
        arr.push(S.rets[i] && S.rets[i][t] != null ? S.rets[i][t] : null);
      }
      series.push(arr);
    }
    var m = [];
    for (var a = 0; a < N; a++) {
      var row = [];
      for (var b = 0; b < N; b++) row.push(pearson(series[a], series[b]));
      m.push(row);
    }
    return m;
  }

  function rollingVolSeries(tk, win) {
    var t = TICKERS.indexOf(tk);
    if (t < 0) return null;
    var out = [];
    for (var i = win + 1; i < DAYS(); i++) {
      var v = rollingVolAt(i, win, t);
      if (v != null) out.push({ date: D.dates[i], vol: v * Math.sqrt(252) });
    }
    return out;
  }
  function underwaterSeries(tk) {
    var t = TICKERS.indexOf(tk);
    if (t < 0) return null;
    var out = [], peak = -Infinity;
    for (var i = 0; i < DAYS(); i++) {
      var px = S.closeMat[i][t];
      if (px == null) continue;
      peak = Math.max(peak, px);
      out.push({ date: D.dates[i], dd: px / peak - 1 });
    }
    return out;
  }

  /* ============================ exports ================================ */
  QP.core = {
    D: D, TICKERS: TICKERS, N: N, BY_TICKER: BY_TICKER,
    SECTOR_LIST: SECTOR_LIST, SECTOR_COLORS: SECTOR_COLORS,
    FACTOR_KEYS: FACTOR_KEYS, FACTOR_LABELS: FACTOR_LABELS,
    FACTOR_FNS: FACTOR_FNS, composite: compositeScores, scoresFor: scoresFor,
    state: S, DAYS: DAYS,
    mergeLiveQuotes: mergeLiveQuotes, rebuildDerived: rebuildDerived,
    resolveSuspectedSplit: resolveSuspectedSplit, splitLog: function () { return SPLIT_LOG.slice(); },
    icData: icData, quintileSpread: quintileSpread, factorCorrMatrix: factorCorrMatrix,
    runBacktest: runBacktest, perfMetrics: perfMetrics, assetRisk: assetRisk,
    corrMatrix: corrMatrix, rollingVolSeries: rollingVolSeries, underwaterSeries: underwaterSeries,
    rsiCutlerAt: rsiCutlerAt, rollingVolAt: rollingVolAt,
    stats: { mean: mean, std: std, spearman: spearman, pearson: pearson, pctPositive: pctPositive },
  };

  rebuildDerived();
})();
