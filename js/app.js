/* ==========================================================================
   AlphaForge — application logic
   tab routing, cross-section analytics, risk stats and a fully
   client-side backtesting engine (no server required).
   ========================================================================== */
(function () {
  "use strict";

  var D = window.ALPHAFORGE;
  var AF = window.AF;
  var fmt = AF.fmt;
  var C = AF.colors;
  var clamp = AF.util.clamp;

  if (!D) {
    document.body.innerHTML =
      '<div style="padding:40px;font-family:monospace;color:#e7eaf6">' +
      "data.js failed to load — please regenerate the bundle.</div>";
    return;
  }

  /* ==================== derived data structures ======================= */
  var TICKERS = D.universe.map(function (u) { return u.ticker; });
  var N = TICKERS.length;
  var DAYS = D.dates.length;
  var BY_TICKER = {};
  D.universe.forEach(function (u) { BY_TICKER[u.ticker] = u; });

  // close[i] = array over tickers, aligned to TICKERS order
  var close = [];
  for (var i = 0; i < DAYS; i++) {
    var row = new Array(N);
    for (var t = 0; t < N; t++) row[t] = D.close[TICKERS[t]][i];
    close.push(row);
  }

  // daily simple returns r[i][t] (i>=1), null-safe
  var rets = [null];
  for (i = 1; i < DAYS; i++) {
    var r = new Array(N);
    for (t = 0; t < N; t++) {
      var a = close[i - 1][t], b = close[i][t];
      r[t] = a && b ? b / a - 1 : null;
    }
    rets.push(r);
  }

  // benchmark daily returns from bundled equity (base 100)
  var benchRets = [0];
  for (i = 1; i < DAYS; i++) {
    benchRets.push(D.benchmark[i] / D.benchmark[i - 1] - 1);
  }

  /* ==================== small helpers ================================ */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function mean(a) {
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != null && isFinite(a[i])) { s += a[i]; n++; }
    }
    return n ? s / n : null;
  }
  function std(a) {
    var m = mean(a);
    if (m == null) return null;
    var s = 0, n = 0;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != null && isFinite(a[i])) { s += (a[i] - m) * (a[i] - m); n++; }
    }
    return n > 1 ? Math.sqrt(s / (n - 1)) : 0;
  }
  function pctPositive(a) {
    var n = 0, p = 0;
    for (var i = 0; i < a.length; i++) {
      if (a[i] != null && isFinite(a[i])) { n++; if (a[i] > 0) p++; }
    }
    return n ? p / n : null;
  }

  var charts = {};   // id -> chart instance
  function chartOf(id, ctor, opts) {
    if (!charts[id]) charts[id] = new ctor($(id), opts || {});
    return charts[id];
  }

  /* ==================== factor score functions ======================= */
  // each fn(dayIdx) -> array of N scores (higher = better), nulls allowed
  function rollingVol(i, win) {
    var out = new Array(N);
    for (var t = 0; t < N; t++) {
      var vals = [];
      for (var k = i - win + 1; k <= i; k++) {
        if (k >= 1 && rets[k] && rets[k][t] != null) vals.push(rets[k][t]);
      }
      out[t] = vals.length >= Math.floor(win * 0.7) ? std(vals) : null;
    }
    return out;
  }

  function rsiAt(i, win) {
    var out = new Array(N);
    for (var t = 0; t < N; t++) {
      var up = 0, dn = 0, nu = 0, nd = 0;
      for (var k = i - win + 1; k <= i; k++) {
        if (k < 1 || !rets[k] || rets[k][t] == null || !rets[k - 1] || close[k - 1][t] == null) continue;
        var ch = close[k][t] - close[k - 1][t];
        if (ch > 0) { up += ch; nu++; }
        else if (ch < 0) { dn -= ch; nd++; }
      }
      if (nu + nd < win * 0.7) { out[t] = null; continue; }
      var au = nu ? up / Math.max(nu, 1) : 0;
      var ad = nd ? dn / Math.max(nd, 1) : 0;
      out[t] = ad === 0 ? 100 : 100 - 100 / (1 + au / ad);
    }
    return out;
  }

  var FACTOR_FNS = {
    momentum_12_1: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var a = i >= 252 ? close[i - 252][t] : null;
        var b = i >= 21 ? close[i - 21][t] : null;
        out[t] = a && b ? b / a - 1 : null;
      }
      return out;
    },
    momentum_6m: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var a = i >= 126 ? close[i - 126][t] : null;
        var b = close[i][t];
        out[t] = a && b ? b / a - 1 : null;
      }
      return out;
    },
    reversal_1m: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        var a = i >= 21 ? close[i - 21][t] : null;
        var b = close[i][t];
        out[t] = a && b ? -(b / a - 1) : null;
      }
      return out;
    },
    low_volatility: function (i) {
      var v = rollingVol(i, 20);
      for (var t = 0; t < N; t++) v[t] = v[t] == null ? null : -v[t];
      return v;
    },
    rsi_14: function (i) {
      var r = rsiAt(i, 14);
      for (var t = 0; t < N; t++) r[t] = r[t] == null ? null : -r[t];
      return r;
    },
    near_52w_high: function (i) {
      var out = new Array(N);
      for (var t = 0; t < N; t++) {
        if (!close[i][t]) { out[t] = null; continue; }
        var hi = -Infinity;
        for (var k = Math.max(0, i - 251); k <= i; k++) {
          if (close[k][t] != null) hi = Math.max(hi, close[k][t]);
        }
        out[t] = isFinite(hi) ? close[i][t] / hi - 1 : null;
      }
      return out;
    },
  };

  /* ==================== backtest engine ============================== */
  function runBacktest(signalKey, topN, rebalMonths, costBps) {
    var t0 = performance.now();
    // rebalance days: first trading day of every K-th month
    var rebalDays = [];
    var lastPeriod = -1;
    for (var i = 252; i < DAYS - 1; i++) {
      var ym = D.dates[i].slice(0, 7);
      var p = (parseInt(ym.slice(0, 4), 10) * 12 + parseInt(ym.slice(5, 7), 10));
      if (Math.floor(p / rebalMonths) !== lastPeriod) {
        rebalDays.push(i);
        lastPeriod = Math.floor(p / rebalMonths);
      }
    }
    if (!rebalDays.length) return null;

    var weights = new Array(N).fill(0); // current holdings weights (sum<=1)
    var holdingsTickers = [];
    var equity = [100], eqDates = [D.dates[rebalDays[0] - 1]];
    var portRets = [0];
    var nextRebal = 0;

    for (i = rebalDays[0]; i < DAYS; i++) {
      if (nextRebal < rebalDays.length && i === rebalDays[nextRebal]) {
        var scores;
        if (signalKey === "equal_weight") {
          scores = new Array(N).fill(0);
        } else {
          scores = FACTOR_FNS[signalKey](i);
        }
        var idx = [];
        for (var t = 0; t < N; t++) {
          if (scores[t] != null && rets[i] && rets[i][t] != null) idx.push(t);
        }
        idx.sort(function (a, b) { return scores[b] - scores[a]; });
        var pick = signalKey === "equal_weight" ? idx : idx.slice(0, topN);
        var wNew = new Array(N).fill(0);
        for (var p2 = 0; p2 < pick.length; p2++) wNew[pick[p2]] = 1 / pick.length;
        // turnover vs previous weights -> cost
        var turn = 0;
        for (t = 0; t < N; t++) turn += Math.abs(wNew[t] - weights[t]);
        var cost = (turn / 2) * (costBps / 10000);
        // rebalance day: old book earns the day, cost charged at close
        var drR = 0, wsumR = 0;
        if (rets[i]) {
          for (t = 0; t < N; t++) {
            if (weights[t] > 0 && rets[i][t] != null) { drR += weights[t] * rets[i][t]; wsumR += weights[t]; }
          }
        }
        var dayRet = wsumR > 0 ? drR / Math.max(wsumR, 0.999) : 0;
        var eq = equity[equity.length - 1] * (1 + dayRet) * (1 - cost);
        equity.push(eq);
        eqDates.push(D.dates[i]);
        portRets.push(eq / equity[equity.length - 2] - 1);
        weights = wNew;
        holdingsTickers = pick;
        nextRebal++;
        continue;
      }
      // normal day: portfolio return = sum(w * r)
      var dr = 0, wsum = 0;
      if (rets[i]) {
        for (t = 0; t < N; t++) {
          if (weights[t] > 0 && rets[i][t] != null) { dr += weights[t] * rets[i][t]; wsum += weights[t]; }
        }
      }
      var eq2 = equity[equity.length - 1] * (1 + (wsum > 0 ? dr / Math.max(wsum, 0.999) : dr));
      equity.push(eq2);
      eqDates.push(D.dates[i]);
      portRets.push(eq2 / equity[equity.length - 2] - 1);
    }

    // benchmark aligned to the exact same dates as the strategy
    var bench = [100];
    for (i = rebalDays[0]; i < DAYS; i++) {
      bench.push(bench[bench.length - 1] * (1 + benchRets[i]));
    }
    // benchmark daily returns (for alpha/beta vs strategy)
    var benchDaily = [];
    for (i = 1; i < bench.length; i++) {
      benchDaily.push(bench[i] / bench[i - 1] - 1);
    }

    var res = {
      dates: eqDates,
      equity: equity,
      benchmark: bench,
      benchDaily: benchDaily,
      rets: portRets,
      holdings: holdingsTickers,
      nDays: equity.length - 1,
      elapsed: performance.now() - t0,
    };
    res.metrics = perfMetrics(portRets.slice(1), benchDaily);
    return res;
  }

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

    // alpha/beta vs benchmark (daily OLS)
    var pairs = [];
    for (i = 0; i < n && i < br.length; i++) {
      if (r[i] != null && br[i] != null) pairs.push([br[i], r[i]]);
    }
    var alpha = null, beta = null;
    if (pairs.length > 60) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0, m = pairs.length;
      for (i = 0; i < m; i++) {
        sx += pairs[i][0]; sy += pairs[i][1];
        sxx += pairs[i][0] * pairs[i][0]; sxy += pairs[i][0] * pairs[i][1];
      }
      beta = (m * sxy - sx * sy) / (m * sxx - sx * sx);
      alpha = (sy - beta * sx) / m * 252;
    }

    return {
      cagr: cagr, vol: vol, sharpe: sharpe, sortino: sortino,
      maxdd: maxdd, calmar: calmar, winRate: pctPositive(r),
      alpha: alpha, beta: beta, totalReturn: eq - 1,
    };
  }

  /* ==================== header market strip ========================== */
  function renderMarketStrip() {
    var strip = $("market-strip");
    var lastB = D.benchmark[DAYS - 1], prevB = D.benchmark[DAYS - 2] || lastB;
    var chg = lastB / prevB - 1;
    var ov = D.overview;
    strip.innerHTML =
      '<span class="ms-item"><span class="ms-label">Universe Idx</span>' +
      '<span class="ms-val ' + (chg >= 0 ? "up" : "down") + '">' + fmt.num(lastB, 1) +
      " (" + fmt.pct(chg, 2) + ")</span></span>" +
      '<span class="ms-item"><span class="ms-label">Names</span><span class="ms-val">' + N + "</span></span>" +
      '<span class="ms-item"><span class="ms-label">11Y CAGR</span>' +
      '<span class="ms-val up">' + fmt.pctAbs(ov.universe_cagr, 1) + "</span></span>" +
      '<span class="ms-item"><span class="ms-label">Data</span><span class="ms-val">' + D.meta.built + "</span></span>";
    $("ft-date").textContent = D.meta.built;
  }

  /* ==================== OVERVIEW ===================================== */
  function renderOverview() {
    var ov = D.overview;
    var bestName = BY_TICKER[ov.best_ticker].name;
    $("ov-stats").innerHTML = "";
    var stats = [
      { label: "Universe", value: N + " names", sub: ov.n_sectors + " GICS sectors · S&P 500 mega-caps" },
      { label: "History", value: ov.n_days.toLocaleString() + " days", sub: ov.first_date + " → " + ov.last_date },
      { label: "Universe CAGR", value: fmt.pctAbs(ov.universe_cagr, 1), sub: "equal-weight, 11.7 years", cls: "up" },
      { label: "Best performer", value: ov.best_ticker, sub: bestName + " · " + fmt.pctAbs(ov.best_total_return, 0) + " since 2015", cls: "up" },
    ];
    stats.forEach(function (s) {
      var d = el("div", "stat");
      d.innerHTML = '<div class="stat-label">' + s.label + '</div>' +
        '<div class="stat-value ' + (s.cls || "") + '">' + s.value + "</div>" +
        '<div class="stat-sub">' + s.sub + "</div>";
      $("ov-stats").appendChild(d);
    });

    // benchmark index chart (downsample for speed)
    var step = Math.max(1, Math.floor(DAYS / 1200));
    var dates = [], bench = [];
    for (var i = 0; i < DAYS; i += step) {
      dates.push(D.dates[i]);
      bench.push(D.benchmark[i]);
    }
    dates.push(D.dates[DAYS - 1]);
    bench.push(D.benchmark[DAYS - 1]);
    chartOf("ov-benchmark", AF.LineChart, {
      yFmt: function (v) { return fmt.num(v, 0); },
      tipFmt: function (v) { return fmt.num(v, 1); },
    }).setData(dates, [
      { name: "equal-weight universe", data: bench, color: C.cyan, fill: "rgba(34,211,238,0.14)", width: 2 },
    ]);
    $("ov-bench-note").textContent =
      "An equal dollar in all 38 names in Jan 2015 grew to " + fmt.num(D.benchmark[DAYS - 1], 0) +
      " by " + D.meta.built + " — " + fmt.pctAbs(ov.universe_cagr, 1) +
      " annualized. All downstream analytics share this panel.";

    // 1-year return bars (top 10 + bottom 10 for readability)
    var all = TICKERS.map(function (tk) {
      var v = D.overview.year_return[tk];
      return {
        label: tk, value: v == null ? 0 : v, name: BY_TICKER[tk].name,
        tipRows: [["Company", BY_TICKER[tk].name], ["1Y return", fmt.pct(v)]],
      };
    }).sort(function (a, b) { return b.value - a.value; });
    var items = [];
    all.slice(0, 10).concat([{ divider: true }], all.slice(-10)).forEach(function (it) {
      if (it.divider) {
        items.push({ label: "···", value: 0, divider: true });
        return;
      }
      items.push(it);
    });
    chartOf("ov-yearret", AF.BarChartH, {}).setData({
      items: items,
      valueFmt: function (v) { return fmt.pct(v, 0); },
      colorize: function (v) { return v >= 0 ? C.up : C.down; },
    });

    // sector pills
    var counts = {};
    D.universe.forEach(function (u) { counts[u.sector] = (counts[u.sector] || 0) + 1; });
    var sg = $("ov-sectors");
    sg.innerHTML = "";
    Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (sec) {
      sg.appendChild(el("div", "sector-pill",
        '<span class="sp-name">' + sec + '</span><span class="sp-count">' + counts[sec] + "</span>"));
    });
  }

  /* ==================== CHARTS (candles) ============================= */
  var chartState = { ticker: "AAPL", rangeMonths: 24, ma: 20 };

  function renderChartsTab() {
    var sel = $("c-ticker");
    if (!sel.options.length) {
      D.universe.forEach(function (u) {
        var o = document.createElement("option");
        o.value = u.ticker;
        o.textContent = u.ticker + " — " + u.name;
        sel.appendChild(o);
      });
      sel.value = chartState.ticker;
      sel.addEventListener("change", function () {
        chartState.ticker = sel.value;
        drawCandles();
      });
      bindSeg("c-range", function (v) { chartState.rangeMonths = parseInt(v, 10); drawCandles(); });
      bindSeg("c-ma", function (v) { chartState.ma = parseInt(v, 10); drawCandles(); });
    }
    sel.value = chartState.ticker;
    drawCandles();
  }

  function bindSeg(id, cb) {
    var seg = $(id);
    Array.prototype.forEach.call(seg.querySelectorAll(".seg-btn"), function (btn) {
      btn.addEventListener("click", function () {
        Array.prototype.forEach.call(seg.querySelectorAll(".seg-btn"), function (b2) {
          b2.classList.remove("active");
        });
        btn.classList.add("active");
        cb(btn.getAttribute("data-v"));
      });
    });
  }

  function drawCandles() {
    var tk = chartState.ticker;
    var flat = D.candles[tk];
    var nDays = D.candle_dates.length;
    var cut;
    if (chartState.rangeMonths > 0) {
      var approx = Math.ceil(chartState.rangeMonths * 21);
      cut = Math.max(0, nDays - approx);
    } else {
      cut = 0;
    }
    var dates = D.candle_dates.slice(cut);
    var ohlcv = flat.slice(cut * 5);

    var mas = [];
    if (chartState.ma === 20) mas = [{ name: "MA20", window: 20, color: C.amber }];
    else if (chartState.ma === 50) mas = [{ name: "MA50", window: 50, color: C.violet }];

    chartOf("c-candles", AF.CandleChart).setData({
      dates: dates, ohlcv: ohlcv, mas: mas, ticker: tk,
    });

    // quote
    var cIdx = dates.length - 1;
    var o = ohlcv[(cIdx) * 5], c = ohlcv[cIdx * 5 + 3], v = ohlcv[cIdx * 5 + 4];
    var chg = o ? c / o - 1 : null;
    $("c-quote").innerHTML =
      '<span class="quote-price">$' + fmt.num(c, 2) + "</span>" +
      '<span class="quote-chg ' + (chg >= 0 ? "up" : "down") + '">' + fmt.pct(chg, 2) + " today</span>";

    // snapshot kv
    var full = D.close[tk];
    var lastPx = full[DAYS - 1];
    var yAgo = full[DAYS - 253] || full[0];
    var hi52 = -Infinity, lo52 = Infinity;
    for (var i = Math.max(0, DAYS - 253); i < DAYS; i++) {
      if (full[i] != null) { hi52 = Math.max(hi52, full[i]); lo52 = Math.min(lo52, full[i]); }
    }
    var r1y = lastPx / yAgo - 1;
    var v20 = rollingVol(DAYS - 1, 20)[TICKERS.indexOf(tk)];
    var rows = [
      ["Last close", "$" + fmt.num(lastPx, 2)],
      ["1Y return", fmt.pct(r1y, 1), r1y >= 0 ? "up" : "down"],
      ["52W high", "$" + fmt.num(hi52, 2)],
      ["52W low", "$" + fmt.num(lo52, 2)],
      ["% off 52W high", fmt.pct(lastPx / hi52 - 1, 1), "down"],
      ["Volatility 20D (ann.)", fmt.pctAbs(v20 * Math.sqrt(252), 1)],
      ["Sector", BY_TICKER[tk].sector, "", true],
      ["Industry", BY_TICKER[tk].industry, "", true],
    ];
    $("c-snap-name").textContent = BY_TICKER[tk].name;
    var kv = $("c-snapshot");
    kv.innerHTML = "";
    rows.forEach(function (r) {
      kv.appendChild(el("div", "k", r[0]));
      kv.appendChild(el("div", "v " + (r[2] || "") + (r[3] ? " v-text" : ""), String(r[1])));
    });

    // relative strength vs universe (1Y)
    var rDates = [], rel = [], base = null, baseU = null;
    for (i = DAYS - 253; i < DAYS; i += 1) {
      if (full[i] == null) continue;
      if (base == null) { base = full[i]; baseU = D.benchmark[i]; }
      rDates.push(D.dates[i]);
      rel.push(full[i] / base - (D.benchmark[i] / baseU));
    }
    chartOf("c-relative", AF.LineChart, {
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
      tipFmt: function (v) { return fmt.pct(v, 1); },
      zeroLine: true,
    }).setData(rDates, [
      { name: tk + " − universe (1Y)", data: rel, color: C.magenta, width: 1.8 },
    ]);
  }

  /* exports for part 2 */
  window.AF_APP = {
    D: D, $: $, el: el, fmt: fmt, C: C, clamp: clamp,
    TICKERS: TICKERS, N: N, DAYS: DAYS, BY_TICKER: BY_TICKER,
    close: close, rets: rets, benchRets: benchRets,
    mean: mean, std: std, pctPositive: pctPositive,
    charts: charts, chartOf: chartOf,
    FACTOR_FNS: FACTOR_FNS, rollingVol: rollingVol, rsiAt: rsiAt,
    runBacktest: runBacktest, perfMetrics: perfMetrics,
    renderMarketStrip: renderMarketStrip,
    renderOverview: renderOverview,
    renderChartsTab: renderChartsTab,
    bindSeg: bindSeg,
    chartState: chartState,
  };
})();

/* ==========================================================================
   AlphaForge — part 2: factors, backtest & risk modules + tab routing
   ========================================================================== */
(function () {
  "use strict";
  var APP = window.AF_APP;
  var AF = window.AF;
  var D = APP.D, $ = APP.$, el = APP.el, fmt = APP.fmt, C = APP.C;
  var TICKERS = APP.TICKERS, N = APP.N, DAYS = APP.DAYS, BY_TICKER = APP.BY_TICKER;
  var close = APP.close, rets = APP.rets, benchRets = APP.benchRets;
  var chartOf = APP.chartOf, bindSeg = APP.bindSeg;

  var SECTOR_COLORS = {};
  var sectorList = [];
  D.universe.forEach(function (u) {
    if (!(u.sector in SECTOR_COLORS)) {
      SECTOR_COLORS[u.sector] = AF.SERIES8[sectorList.length % 8];
      sectorList.push(u.sector);
    }
  });

  /* ==================== FACTORS ====================================== */
  var factorState = { key: "momentum_6m" };

  function renderFactorsTab() {
    var chips = $("f-chips");
    if (!chips.childElementCount) {
      Object.keys(D.factors.meta).forEach(function (key) {
        var b = el("button", "chip" + (key === factorState.key ? " active" : ""),
          D.factors.meta[key]);
        b.addEventListener("click", function () {
          factorState.key = key;
          Array.prototype.forEach.call(chips.children, function (c) {
            c.classList.remove("active");
          });
          b.classList.add("active");
          drawFactorViews();
        });
        chips.appendChild(b);
      });
      // summary table (static, click row to select)
      var tb = $("f-summary").querySelector("tbody");
      tb.innerHTML = "";
      Object.keys(D.factors.meta).forEach(function (key) {
        var s = D.factors.ic_summary[key];
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td class=\"ticker-cell\">" + D.factors.meta[key] + "</td>" +
          "<td class=\"" + (s.ic_mean >= 0 ? "pos" : "neg") + "\">" + s.ic_mean.toFixed(4) + "</td>" +
          "<td>" + s.ic_ir.toFixed(2) + "</td>" +
          "<td>" + (s.hit_rate * 100).toFixed(0) + "%</td>" +
          "<td>" + s.n_months + "</td>";
        tr.style.cursor = "pointer";
        tr.addEventListener("click", function () {
          factorState.key = key;
          Array.prototype.forEach.call(chips.children, function (c, i) {
            c.classList.toggle("active", Object.keys(D.factors.meta)[i] === key);
          });
          drawFactorViews();
        });
        tb.appendChild(tr);
      });
    }
    drawFactorViews();
  }

  function drawFactorViews() {
    var key = factorState.key;
    var label = D.factors.meta[key];
    var latest = D.factors.latest[key];

    // ranks: top10 + bottom10
    var items = TICKERS.map(function (tk) {
      return { label: tk, value: latest[tk], name: BY_TICKER[tk].name };
    }).filter(function (it) { return it.value != null; })
      .sort(function (a, b) { return b.value - a.value; });
    var top = items.slice(0, 10);
    var bottom = items.slice(-10).reverse();
    var shown = bottom.concat([{ divider: true }], top).reverse();
    // display: top block first (from bottom of canvas upward is natural for H bars)
    var rows = [];
    top.concat([{ divider: true }], bottom).forEach(function (it) {
      if (it.divider) {
        rows.push({ label: "···", value: 0, divider: true });
        return;
      }
      it.tipRows = [["Company", it.name], ["Score", fmt.num(it.value, 3)]];
      rows.push(it);
    });
    chartOf("f-ranks", AF.BarChartH, {}).setData({
      items: rows,
      valueFmt: function (v) { return fmt.num(v, 2); },
      colorize: function (v, idx, it) {
        if (it.divider) return "rgba(255,255,255,0.15)";
        return v >= 0 ? C.cyan : C.magenta;
      },
    });
    $("f-rank-hint").textContent = label + " · top & bottom 10";

    // scatter: score vs realized 1M return
    var pts = [];
    for (var t = 0; t < N; t++) {
      var tk = TICKERS[t];
      var pxNow = close[DAYS - 1][t], px21 = close[DAYS - 22] && close[DAYS - 22][t];
      if (latest[tk] == null || !pxNow || !px21) continue;
      pts.push({
        x: latest[tk],
        y: pxNow / px21 - 1,
        label: tk,
        name: BY_TICKER[tk].name,
        color: SECTOR_COLORS[BY_TICKER[tk].sector],
        tipRows: [
          ["Sector", BY_TICKER[tk].sector],
          ["Score", fmt.num(latest[tk], 3)],
          ["1M return", fmt.pct(pxNow / px21 - 1, 1)],
        ],
      });
    }
    chartOf("f-scatter", AF.ScatterChart, { }).setData({
      points: pts,
      xLabel: label,
      yLabel: "1M return",
      regression: true,
      xFmt: function (v) { return fmt.num(v, 1); },
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
    });

    // IC series
    var ic = D.factors.ic_history[key];
    var cum = [];
    var run = 0;
    ic.forEach(function (v) {
      if (v == null) { cum.push(null); return; }
      run += v;
      cum.push(run);
    });
    chartOf("f-ic-series", AF.ICChart).setData({
      labels: D.factors.ic_dates, ic: ic, cum: cum,
    });
    var s = D.factors.ic_summary[key];
    $("f-ic-hint").textContent = label + " · IC " + s.ic_mean.toFixed(3) +
      " · IR " + s.ic_ir.toFixed(2) + " · hit " + (s.hit_rate * 100).toFixed(0) + "%";
  }

  /* ==================== BACKTEST ===================================== */
  var btState = { strat: "momentum_6m", topN: 10, rebal: 1, cost: 10 };

  var STRATEGY_LABELS = {
    momentum_12_1: "Momentum 12-1",
    momentum_6m: "Momentum 6M",
    reversal_1m: "1M Reversal",
    low_volatility: "Low Volatility 20D",
    rsi_14: "RSI-14 Oversold",
    near_52w_high: "52W High Proximity",
    equal_weight: "Equal-Weight Universe",
  };

  function renderBacktestTab() {
    var sel = $("b-strat");
    if (!sel.options.length) {
      Object.keys(STRATEGY_LABELS).forEach(function (k) {
        var o = document.createElement("option");
        o.value = k;
        o.textContent = STRATEGY_LABELS[k];
        sel.appendChild(o);
      });
      sel.value = btState.strat;
      sel.addEventListener("change", function () {
        btState.strat = sel.value;
        runAndRender();
      });
      bindSeg("b-topn", function (v) { btState.topN = parseInt(v, 10); runAndRender(); });
      bindSeg("b-rebal", function (v) { btState.rebal = parseInt(v, 10); runAndRender(); });
      bindSeg("b-cost", function (v) { btState.cost = parseInt(v, 10); runAndRender(); });
    }
    sel.value = btState.strat;
    runAndRender();
  }

  var lastBT = null;
  function runAndRender() {
    var res = APP.runBacktest(btState.strat, btState.topN, btState.rebal, btState.cost);
    if (!res) return;
    lastBT = res;

    var label = STRATEGY_LABELS[btState.strat];
    var m = res.metrics;
    var bm = APP.perfMetrics(res.benchDaily, res.benchDaily);

    // metric cards
    var cards = [
      { l: "CAGR", v: fmt.pctAbs(m.cagr, 1), c: m.cagr >= bm.cagr ? "up" : "down" },
      { l: "vs Universe", v: fmt.pct(m.cagr - bm.cagr, 1), c: m.cagr >= bm.cagr ? "up" : "down" },
      { l: "Sharpe", v: m.sharpe == null ? "–" : m.sharpe.toFixed(2), c: m.sharpe >= 1 ? "up" : "neutral" },
      { l: "Sortino", v: m.sortino == null ? "–" : m.sortino.toFixed(2), c: m.sortino >= 1.4 ? "up" : "neutral" },
      { l: "Vol (ann.)", v: fmt.pctAbs(m.vol, 1), c: "neutral" },
      { l: "Max DD", v: fmt.pctAbs(m.maxdd, 1), c: "down" },
      { l: "Calmar", v: m.calmar == null ? "–" : m.calmar.toFixed(2), c: "neutral" },
      { l: "Win days", v: (m.winRate * 100).toFixed(0) + "%", c: m.winRate >= 0.5 ? "up" : "neutral" },
      { l: "Alpha (ann.)", v: m.alpha == null ? "–" : fmt.pct(m.alpha, 1), c: m.alpha >= 0 ? "up" : "down" },
      { l: "Beta", v: m.beta == null ? "–" : m.beta.toFixed(2), c: "neutral" },
    ];
    var box = $("b-metrics");
    box.innerHTML = "";
    cards.forEach(function (cd) {
      box.appendChild(el("div", "bt-metric",
        '<div class="bm-label">' + cd.l + '</div>' +
        '<div class="bm-value ' + cd.c + '">' + cd.v + "</div>"));
    });
    $("b-eq-hint").textContent =
      label + " · top " + btState.topN + " · " + (btState.rebal === 1 ? "monthly" : "quarterly") +
      " · " + btState.cost + " bps · computed in " + res.elapsed.toFixed(0) + " ms";

    // equity curves (log)
    chartOf("b-equity", AF.LineChart, {
      log: true,
      yFmt: function (v) { return fmt.num(v, 0); },
      tipFmt: function (v) { return fmt.num(v, 1); },
    }).setData(res.dates, [
      { name: label, data: res.equity, color: C.cyan, width: 2 },
      { name: "equal-weight universe", data: res.benchmark, color: C.violet, width: 1.4, dash: [5, 4] },
    ]);

    // drawdown
    var peak = -Infinity, dd = [];
    res.equity.forEach(function (v) {
      peak = Math.max(peak, v);
      dd.push(v / peak - 1);
    });
    chartOf("b-drawdown", AF.LineChart, {
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
      tipFmt: function (v) { return fmt.pct(v, 1); },
      legend: false,
    }).setData(res.dates, [
      { name: "drawdown", data: dd, color: C.down, fill: "rgba(251,113,133,0.18)", width: 1.6 },
    ]);

    // monthly heatmap: compound daily returns into calendar months
    var monthly = {};
    for (var i = 1; i < res.dates.length; i++) {
      var ym = res.dates[i].slice(0, 7);
      if (!(ym in monthly)) monthly[ym] = 1;
      monthly[ym] *= 1 + res.rets[i];
    }
    var years = [], seen = {};
    Object.keys(monthly).forEach(function (k) {
      var y = k.slice(0, 4);
      if (!seen[y]) { seen[y] = true; years.push(y); }
    });
    years.sort();
    var matrix = [], MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    years.forEach(function (y) {
      var row = [];
      for (var mi = 0; mi < 12; mi++) {
        var key = y + "-" + String(mi + 1).padStart(2, "0");
        row.push(monthly[key] == null ? null : monthly[key] - 1);
      }
      matrix.push(row);
    });
    chartOf("b-monthly", AF.Heatmap).setData({
      mode: "monthly", rows: years, cols: MONTHS, matrix: matrix,
    });

    // holdings table
    var tb = $("b-holdings").querySelector("tbody");
    tb.innerHTML = "";
    if (btState.strat === "equal_weight") {
      tb.innerHTML = '<tr><td colspan="5" style="text-align:left;font-family:Inter;color:#9aa1c4">' +
        "Equal-weight strategy holds all " + N + " names at " +
        (100 / N).toFixed(2) + "% each.</td></tr>";
    } else {
      res.holdings.forEach(function (tIdx, i) {
        var u = BY_TICKER[TICKERS[tIdx]];
        var tr = document.createElement("tr");
        tr.innerHTML = "<td>" + (i + 1) + '</td><td class="ticker-cell">' + u.ticker +
          '</td><td class="name-cell" style="text-align:left">' + u.name +
          '</td><td class="name-cell" style="text-align:left">' + u.sector +
          "</td><td>" + (100 / res.holdings.length).toFixed(1) + "%</td>";
        tb.appendChild(tr);
      });
    }
  }

  /* ==================== RISK ========================================= */
  var riskSort = { key: "vol", desc: true };

  function computeAssetRisk() {
    var out = [];
    for (var t = 0; t < N; t++) {
      var rs = [];
      for (var i = 1; i < DAYS; i++) {
        if (rets[i] && rets[i][t] != null) rs.push(rets[i][t]);
      }
      var m = APP.perfMetrics(rs, benchRets.slice(1));
      var sorted = rs.slice().sort(function (a, b) { return a - b; });
      var k = Math.floor(sorted.length * 0.05);
      var var95 = sorted[k];
      var tail = sorted.slice(0, k + 1);
      var cvar95 = tail.reduce(function (s, v) { return s + v; }, 0) / tail.length;
      out.push({
        ticker: TICKERS[t], name: BY_TICKER[TICKERS[t]].name,
        vol: m.vol, sharpe: m.sharpe, maxdd: m.maxdd,
        var95: var95, cvar95: cvar95, beta: m.beta,
        cagr: m.cagr,
      });
    }
    return out;
  }

  function renderRiskTab() {
    var risks = computeAssetRisk();

    // headline stats
    var avgVol = APP.mean(risks.map(function (r) { return r.vol; }));
    var avgSharpe = APP.mean(risks.map(function (r) { return r.sharpe; }));
    var worstDD = Math.min.apply(null, risks.map(function (r) { return r.maxdd; }));
    var bestSharpe = risks.slice().sort(function (a, b) { return b.sharpe - a.sharpe; })[0];
    $("r-stats").innerHTML = "";
    [
      { label: "Average volatility", value: fmt.pctAbs(avgVol, 1), sub: "annualized, full sample" },
      { label: "Average Sharpe", value: avgSharpe.toFixed(2), sub: "daily data, rf = 0", cls: "up" },
      { label: "Deepest drawdown", value: fmt.pctAbs(worstDD, 1), sub: risks.reduce(function (a, b) { return a.maxdd < b.maxdd ? a : b; }).ticker + " suffered the worst peak-to-trough", cls: "down" },
      { label: "Best Sharpe", value: bestSharpe.ticker, sub: fmt.num(bestSharpe.sharpe, 2) + " · " + bestSharpe.name, cls: "up" },
    ].forEach(function (s) {
      $("r-stats").appendChild(el("div", "stat",
        '<div class="stat-label">' + s.label + '</div>' +
        '<div class="stat-value ' + (s.cls || "") + '">' + s.value + "</div>" +
        '<div class="stat-sub">' + s.sub + "</div>"));
    });

    // correlation heatmap (last 2 years)
    var window = Math.min(504, DAYS - 1);
    var series = [];
    for (var t = 0; t < N; t++) {
      var arr = [];
      for (var i = DAYS - window; i < DAYS; i++) {
        arr.push(rets[i] && rets[i][t] != null ? rets[i][t] : null);
      }
      series.push(arr);
    }
    var matrix = [];
    for (var a = 0; a < N; a++) {
      var row = [];
      for (var b = 0; b < N; b++) {
        row.push(corr(series[a], series[b]));
      }
      matrix.push(row);
    }
    chartOf("r-heatmap", AF.Heatmap).setData({
      mode: "corr", labels: TICKERS, matrix: matrix,
    });

    // risk/return scatter
    var pts = risks.map(function (r) {
      return {
        x: r.vol, y: r.cagr, label: r.ticker, name: r.name,
        color: ddColor(r.maxdd),
        tag: (r.sharpe > 1.1 || r.maxdd < -0.6) ? r.ticker : null,
        tipRows: [
          ["Vol (ann.)", fmt.pctAbs(r.vol, 1)],
          ["CAGR", fmt.pctAbs(r.cagr, 1)],
          ["Max DD", fmt.pctAbs(r.maxdd, 1)],
          ["Sharpe", fmt.num(r.sharpe, 2)],
        ],
      };
    });
    chartOf("r-scatter", AF.ScatterChart, {}).setData({
      points: pts,
      xLabel: "volatility (ann.)",
      yLabel: "CAGR",
      xFmt: function (v) { return fmt.pctAbs(v, 0); },
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
    });

    renderRiskTable(risks);
  }

  function ddColor(dd) {
    // shallow dd (-10%) -> cyan, deep dd (-70%) -> magenta
    var t = Math.min(1, Math.max(0, (-dd - 0.1) / 0.6));
    var rC = Math.round(34 + t * 210), gC = Math.round(211 - t * 98), bC = Math.round(238 - t * 105);
    return "rgb(" + rC + "," + gC + "," + bC + ")";
  }

  function corr(x, y) {
    var sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0, n = 0;
    for (var i = 0; i < x.length; i++) {
      if (x[i] == null || y[i] == null) continue;
      sx += x[i]; sy += y[i]; sxy += x[i] * y[i];
      sxx += x[i] * x[i]; syy += y[i] * y[i]; n++;
    }
    if (n < 30) return null;
    var num = n * sxy - sx * sy;
    var den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    return den === 0 ? null : num / den;
  }

  function renderRiskTable(risks) {
    var tb = $("r-table").querySelector("tbody");
    var render = function () {
      var rows = risks.slice().sort(function (a, b) {
        var av = a[riskSort.key], bv = b[riskSort.key];
        var cmp = (typeof av === "string") ? av.localeCompare(bv) : av - bv;
        return riskSort.desc ? -cmp : cmp;
      });
      tb.innerHTML = "";
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          '<td class="ticker-cell">' + r.ticker + "</td>" +
          "<td>" + fmt.pctAbs(r.vol, 1) + "</td>" +
          "<td>" + fmt.num(r.sharpe, 2) + "</td>" +
          '<td class="neg">' + fmt.pctAbs(r.maxdd, 1) + "</td>" +
          '<td class="neg">' + fmt.pctAbs(r.var95, 1) + "</td>" +
          '<td class="neg">' + fmt.pctAbs(r.cvar95, 1) + "</td>" +
          "<td>" + fmt.num(r.beta, 2) + "</td>";
        tb.appendChild(tr);
      });
    };
    if (!renderRiskTable.wired) {
      Array.prototype.forEach.call($("r-table").querySelectorAll("th"), function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-k");
          if (riskSort.key === k) riskSort.desc = !riskSort.desc;
          else { riskSort.key = k; riskSort.desc = true; }
          render();
        });
      });
      renderRiskTable.wired = true;
    }
    render();
  }

  /* ==================== TAB ROUTING ================================== */
  var rendered = {};
  var TAB_RENDER = {
    "panel-overview": APP.renderOverview,
    "panel-charts": APP.renderChartsTab,
    "panel-factors": renderFactorsTab,
    "panel-backtest": renderBacktestTab,
    "panel-risk": renderRiskTab,
  };
  var TAB_REDRAW = {
    "panel-overview": APP.renderOverview,
    "panel-charts": APP.renderChartsTab,
    "panel-factors": drawFactorViews,
    "panel-backtest": runAndRender,
    "panel-risk": renderRiskTab,
  };

  function activateTab(panelId) {
    ["overview", "charts", "factors", "backtest", "risk"].forEach(function (t) {
      $("panel-" + t).classList.toggle("hidden", "panel-" + t !== panelId);
      $("tab-" + t).setAttribute("aria-selected", "panel-" + t === panelId ? "true" : "false");
    });
    if (!rendered[panelId]) {
      rendered[panelId] = true;
      (TAB_RENDER[panelId] || function () {})();
    } else {
      // panels were display:none -> canvases need a redraw with real size
      requestAnimationFrame(function () { (TAB_REDRAW[panelId] || function () {})(); });
    }
  }

  ["overview", "charts", "factors", "backtest", "risk"].forEach(function (t) {
    $("tab-" + t).addEventListener("click", function () { activateTab("panel-" + t); });
  });

  /* ==================== BOOT ========================================= */
  APP.renderMarketStrip();
  activateTab("panel-overview");
})();
