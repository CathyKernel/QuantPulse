/* ==========================================================================
   QuantPulse — application UI
   --------------------------------------------------------------------------
   Six research modules wired to a shared live-data pipeline:

     Overview   market pulse, live movers, sector breadth, universe index
     Terminal   pro candlestick charting (zoom/pan/crosshair, overlays,
                RSI/MACD panels, intraday, compare, relative strength)
     Screener   live sortable cross-section with sparklines
     Factors    live cross-sectional analytics: ranks, IC history, quintile
                spreads, factor correlation
     Backtest   position-based engine, long-only & long-short, costs
     Risk       vol / VaR / CVaR / drawdowns / correlation lab

   Every successful poll re-renders the active module; merged sessions
   extend the full analytics history.
   ========================================================================== */
(function () {
  "use strict";

  var core = QP.core, live = QP.live;
  var D = core.D, TICKERS = core.TICKERS, N = core.N, BY_TICKER = core.BY_TICKER;
  var S = core.state, DAYS = core.DAYS;
  var fmt = QP.fmt, C = QP.colors, clamp = QP.util.clamp;
  var CH = QP.charts;

  /* ------------------------------ helpers ------------------------------ */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  var charts = {};
  function chartOf(id, ctor, opts) {
    if (!charts[id]) charts[id] = new ctor($(id), opts || {});
    return charts[id];
  }
  function bindSeg(id, cb) {
    var seg = $(id);
    Array.prototype.forEach.call(seg.querySelectorAll(".seg-btn"), function (btn) {
      btn.addEventListener("click", function () {
        Array.prototype.forEach.call(seg.querySelectorAll(".seg-btn"), function (b2) { b2.classList.remove("active"); });
        btn.classList.add("active");
        cb(btn.getAttribute("data-v"));
      });
    });
  }
  function setSeg(id, val) {
    Array.prototype.forEach.call($(id).querySelectorAll(".seg-btn"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-v") === String(val));
    });
  }
  function toast(msg, cls) {
    var t = $("toast");
    if (!t) return;
    t.textContent = msg;
    t.className = "toast show " + (cls || "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast"; }, 4200);
  }

  /* --------------------------- live state ------------------------------ */
  var LV = {
    quotes: {},          // sym -> normalized live quote
    forming: {},         // sym -> forming bar for today's session
    updated: null,       // ISO timestamp from server
    mode: "connecting",  // live | snapshot | connecting
    lastBars: 0,         // count of merged extra sessions
  };

  function lastClose(tk) {
    var arr = D.close[tk];
    return arr[arr.length - 1];
  }
  function livePrice(tk) {
    var f = LV.forming[tk];
    if (f) return f.c;
    return lastClose(tk);
  }
  function dayChangePct(tk) {
    var f = LV.forming[tk];
    if (f && f.o != null) {
      // forming session: change vs previous close (= last merged close)
      var prev = lastClose(tk);
      return prev ? f.c / prev - 1 : null;
    }
    var r = S.rets[S.rets.length - 1];
    var t = TICKERS.indexOf(tk);
    return r ? r[t] : null;
  }
  function retOver(tk, backDays) {
    var arr = D.close[tk];
    var n = arr.length;
    var a = arr[Math.max(0, n - 1 - backDays)];
    var b = livePrice(tk);
    return a != null && b != null ? b / a - 1 : null;
  }
  function ytdReturn(tk) {
    var arr = D.close[tk];
    var year = D.dates[D.dates.length - 1].slice(0, 4);
    var a = null;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (D.dates[i].slice(0, 4) !== year) break;
      a = arr[i];
    }
    var b = livePrice(tk);
    return a != null && b != null ? b / a - 1 : null;
  }
  function fmtTime(iso) {
    if (!iso) return "–";
    try {
      return new Date(iso).toLocaleTimeString("en-US", { hour12: false });
    } catch (e) { return iso; }
  }

  /* ========================= header strip ============================== */
  function renderHeader() {
    var bench = D.benchmark;
    var lastB = bench[bench.length - 1];
    var forming = Object.keys(LV.forming).length > 0;
    var dayChg, idxVal;
    if (forming) {
      var chgs = [];
      TICKERS.forEach(function (tk) {
        var q = LV.quotes[tk];
        if (q && q.changePct != null) chgs.push(q.changePct);
      });
      var m = chgs.length ? core.stats.mean(chgs) : null;
      dayChg = m;
      idxVal = m != null ? lastB * (1 + m) : lastB;
    } else {
      idxVal = lastB;
      dayChg = bench.length > 1 ? lastB / bench[bench.length - 2] - 1 : 0;
    }
    var adv = 0, dec = 0;
    TICKERS.forEach(function (tk) {
      var c = dayChangePct(tk);
      if (c != null) { if (c > 0) adv++; else if (c < 0) dec++; }
    });

    var strip = $("market-strip");
    strip.innerHTML =
      '<span class="ms-item"><span class="ms-label">Universe Idx</span>' +
      '<span class="ms-val ' + (dayChg >= 0 ? "up" : "down") + '">' + fmt.num(idxVal, 1) +
      ' <small>(' + fmt.pct(dayChg, 2) + ')</small></span></span>' +
      '<span class="ms-item"><span class="ms-label">Breadth</span>' +
      '<span class="ms-val"><b class="up">' + adv + "</b> / <b class=\"down\">" + dec + "</b> adv/dec</span></span>" +
      '<span class="ms-item"><span class="ms-label">History</span><span class="ms-val">' +
      D.dates[0] + " → " + D.dates[D.dates.length - 1] + "</span></span>" +
      '<span class="ms-item"><span class="ms-label">Names</span><span class="ms-val">' + N + " · " + core.SECTOR_LIST.length + " sectors</span></span>";

    $("ft-date").textContent = D.dates[D.dates.length - 1] + (LV.lastBars ? " (+" + LV.lastBars + " live)" : "");
  }

  function renderClock() {
    var ms = live.marketStatus();
    var clock = live.etClock();
    var elClock = $("hd-clock"), elState = $("hd-state");
    if (elClock) elClock.textContent = clock.timeStr + " ET";
    if (elState) {
      elState.textContent = ms.label;
      elState.className = "hd-state " + ms.state;
    }
  }

  function renderStatusBadge() {
    var b = $("live-badge");
    var mode = LV.mode;
    var txt = mode === "live" ? "LIVE" : mode === "connecting" ? "CONNECTING" : "SNAPSHOT";
    b.textContent = txt;
    b.className = "live-badge " + mode;
    b.title = mode === "live"
      ? "Streaming quotes via Netlify function · updates every " + (live.state().intervalSec || 0) + "s"
      : "Live feed unavailable — running on the bundled snapshot. Deploy to Netlify (or run the local dev server) to enable live updates.";
    var upd = $("hd-updated");
    if (upd) {
      upd.textContent = LV.updated ? "updated " + fmtTime(LV.updated) : "—";
    }
  }

  /* ============================ tab routing ============================ */
  var TABS = ["overview", "terminal", "screener", "factors", "backtest", "ml", "risk"];
  var rendered = {};
  var RENDER = {};   // filled by each module below
  var activeTab = "overview";

  function activateTab(t) {
    activeTab = t;
    TABS.forEach(function (x) {
      $("panel-" + x).classList.toggle("hidden", x !== t);
      $("tab-" + x).setAttribute("aria-selected", x === t ? "true" : "false");
    });
    requestAnimationFrame(function () { renderTab(t, true); });
  }
  function renderTab(t, onShow) {
    if (!RENDER[t]) return;
    if (!rendered[t] || onShow) {
      rendered[t] = true;
      RENDER[t]();
    }
  }
  function rerenderActive() {
    if (RENDER[activeTab]) RENDER[activeTab]();
    renderHeader();
  }
  TABS.forEach(function (t) {
    $("tab-" + t).addEventListener("click", function () { activateTab(t); });
  });

  /* ============================ OVERVIEW =============================== */
  function universeCAGR() {
    var years = DAYS() / 252;
    return Math.pow(D.benchmark[D.benchmark.length - 1] / 100, 1 / years) - 1;
  }
  function bestPerformer() {
    var best = null;
    TICKERS.forEach(function (tk) {
      var arr = D.close[tk];
      var r = arr[arr.length - 1] / arr[0] - 1;
      if (arr[0] && (!best || r > best.r)) best = { tk: tk, r: r };
    });
    return best;
  }

  function drawOverview() {
    var ov = D.overview;
    var best = bestPerformer();
    var forming = Object.keys(LV.forming).length > 0;
    var adv = 0, dec = 0;
    TICKERS.forEach(function (tk) {
      var c = dayChangePct(tk);
      if (c != null) { if (c > 0) adv++; else if (c < 0) dec++; }
    });

    // stat cards
    var stats = [
      { label: "Live session", value: forming ? "In progress" : (live.marketStatus().label), sub: (adv + dec) + " of " + N + " names moving · " + (forming ? "updates every " + (live.state().intervalSec || 30) + "s" : "last session complete"), cls: forming ? "up" : "" },
      { label: "Universe", value: N + " mega-caps", sub: core.SECTOR_LIST.length + " GICS sectors · S&P 500 panel" },
      { label: "History", value: (DAYS() - 1).toLocaleString() + " sessions", sub: D.dates[0] + " → " + D.dates[D.dates.length - 1] },
      { label: "Universe CAGR", value: fmt.pctAbs(universeCAGR(), 1), sub: "equal-weight, " + (DAYS() / 252).toFixed(1) + " years", cls: "up" },
      { label: "Best since 2015", value: best.tk, sub: BY_TICKER[best.tk].name + " · " + fmt.pctAbs(best.r, 0) + " total", cls: "up" },
    ];
    var box = $("ov-stats");
    box.innerHTML = "";
    stats.forEach(function (s) {
      box.appendChild(el("div", "stat",
        '<div class="stat-label">' + s.label + '</div>' +
        '<div class="stat-value ' + (s.cls || "") + '">' + s.value + "</div>" +
        '<div class="stat-sub">' + s.sub + "</div>"));
    });

    // universe index (downsampled) + live point
    var step = Math.max(1, Math.floor(DAYS() / 1200));
    var dates = [], bench = [];
    for (var i = 0; i < DAYS(); i += step) {
      dates.push(D.dates[i]);
      bench.push(D.benchmark[i]);
    }
    dates.push(D.dates[DAYS() - 1]);
    bench.push(D.benchmark[D.benchmark.length - 1]);
    chartOf("ov-benchmark", CH.LineChart, {
      yFmt: function (v) { return fmt.num(v, 0); },
      tipFmt: function (v) { return fmt.num(v, 1); },
    }).setData(dates, [
      { name: "equal-weight universe (base 100)", data: bench, color: C.cyan, fill: "rgba(37,211,224,0.13)", width: 2 },
    ]);

    // live movers (day change)
    var movers = TICKERS.map(function (tk) {
      return {
        label: tk, name: BY_TICKER[tk].name,
        value: dayChangePct(tk) || 0,
        tipRows: [["Company", BY_TICKER[tk].name], ["Price", "$" + fmt.num(livePrice(tk), 2)], ["Day", fmt.pct(dayChangePct(tk), 2)]],
      };
    }).sort(function (a, b) { return b.value - a.value; });
    var top = movers.slice(0, 6);
    var bottom = movers.slice(-6).reverse();
    var items = top.concat([{ label: "···", value: 0, divider: true }], bottom);
    chartOf("ov-movers", CH.BarChartH, {}).setData({
      items: items,
      valueFmt: function (v) { return fmt.pct(v, 1); },
      colorize: function (v, idx, it) {
        return it.divider ? "rgba(255,255,255,0.12)" : (v >= 0 ? C.up : C.down);
      },
    });

    // sector performance (avg day change)
    var secPerf = core.SECTOR_LIST.map(function (sec) {
      var tks = TICKERS.filter(function (tk) { return BY_TICKER[tk].sector === sec; });
      var chgs = tks.map(dayChangePct).filter(function (v) { return v != null; });
      return { label: sec.replace("Information Technology", "Info Tech").replace("Communication Services", "Comm Svcs").replace("Consumer Discretionary", "Cons Disc").replace("Consumer Staples", "Cons Staples").replace("Financials", "Financials").replace("Health Care", "Healthcare"), full: sec, n: tks.length, v: core.stats.mean(chgs) };
    }).sort(function (a, b) { return b.v - a.v; });
    chartOf("ov-sectors", CH.BarChartH, {}).setData({
      items: secPerf.map(function (s) {
        return {
          label: s.label, value: s.v == null ? 0 : s.v,
          tipRows: [["Sector", s.full], ["Names", String(s.n)], ["Avg day", fmt.pct(s.v, 2)]],
        };
      }),
      valueFmt: function (v) { return fmt.pct(v, 2); },
      colorize: function (v) { return v >= 0 ? C.up : C.down; },
    });

    // trailing 1Y return bars
    var yr = TICKERS.map(function (tk) {
      return {
        label: tk, name: BY_TICKER[tk].name,
        value: retOver(tk, 252) || 0,
        tipRows: [["Company", BY_TICKER[tk].name], ["1Y return", fmt.pct(retOver(tk, 252), 1)]],
      };
    }).sort(function (a, b) { return b.value - a.value; });
    chartOf("ov-yearret", CH.BarChartH, {}).setData({
      items: yr.slice(0, 8).concat([{ label: "···", value: 0, divider: true }], yr.slice(-8)),
      valueFmt: function (v) { return fmt.pct(v, 0); },
      colorize: function (v, idx, it) { return it.divider ? "rgba(255,255,255,0.12)" : (v >= 0 ? C.cyan : C.magenta); },
    });

    void ov;
  }
  RENDER.overview = drawOverview;

  /* ============================ TERMINAL =============================== */
  var termState = {
    ticker: "AAPL",
    range: 504,                  // bars (2Y default)
    type: "candle",
    log: false,
    intraday: null,              // null | "1d" | "5d"
    overlays: { ma20: true, ma50: true, ma200: false, ema50: false, bb: false },
    panels: { vol: true, rsi: false, macd: false },
    peer: "",                    // compare-with ticker ("" = universe only)
    needRange: true,
    intradayBusy: false,
    lastIntradayKey: null,
  };
  var RANGE_BARS = { "1": 21, "3": 63, "6": 126, "12": 252, "24": 504, "36": 756, "0": 99999 };

  function candleSeries(tk) {
    // full daily candle series + live forming bar appended (never mutates the store)
    var dates = D.candle_dates;
    var flat = D.candles[tk];
    var forming = LV.forming[tk];
    var q = LV.quotes[tk];
    if (forming && forming.date > dates[dates.length - 1]) {
      dates = dates.concat([forming.date]);
      flat = flat.concat([forming.o, forming.h, forming.l, forming.c, forming.v != null ? Math.round(forming.v) : null]);
      return {
        dates: dates, ohlcv: flat, forming: dates.length - 1,
        live: { price: q ? q.price : forming.c, prevClose: lastClose(tk) },
      };
    }
    return { dates: dates, ohlcv: flat, forming: -1, live: null };
  }

  function drawTerminalQuoteBar() {
    var tk = termState.ticker;
    var u = BY_TICKER[tk];
    var q = LV.quotes[tk];
    var forming = LV.forming[tk];
    var px = forming ? forming.c : lastClose(tk);
    var prev = forming ? lastClose(tk) : (D.close[tk][D.close[tk].length - 2] || px);
    var chg = px != null && prev != null ? px - prev : null;
    var chgPct = chg != null && prev ? chg / prev : null;
    var cls = chg >= 0 ? "up" : "down";
    var o = forming ? forming.o : null;
    var h = forming ? forming.h : null;
    var l = forming ? forming.l : null;
    var v = forming ? forming.v : null;
    var elQ = $("t-quote");
    elQ.innerHTML =
      '<span class="q-name">' + u.name + '</span>' +
      '<span class="q-price ' + cls + '">$' + fmt.num(px, 2) + "</span>" +
      '<span class="q-chg ' + cls + '">' + (chg >= 0 ? "+" : "") + fmt.num(chg, 2) + " (" + fmt.pct(chgPct, 2) + ")</span>" +
      (forming && o != null ? '<span class="q-kv">O <b>' + fmt.num(o, 2) + "</b></span>" +
        '<span class="q-kv">H <b>' + fmt.num(h, 2) + "</b></span>" +
        '<span class="q-kv">L <b>' + fmt.num(l, 2) + "</b></span>" +
        '<span class="q-kv">VOL <b>' + (v != null ? fmt.compact(v * 1000) : "–") + "</b></span>" : "") +
      '<span class="q-kv q-time">' + (LV.updated ? "as of " + fmtTime(LV.updated) : "bundled close") + "</span>";
  }

  function drawTerminal() {
    var tk = termState.ticker;
    var st = termState;

    // controls init (once)
    if (!$("t-ticker").options.length) {
      D.universe.forEach(function (u) {
        var o = document.createElement("option");
        o.value = u.ticker;
        o.textContent = u.ticker + " — " + u.name;
        $("t-ticker").appendChild(o);
      });
      $("t-ticker").value = st.ticker;
      $("t-ticker").addEventListener("change", function () {
        st.ticker = this.value; st.needRange = true; st.lastIntradayKey = null; drawTerminal();
      });
      bindSeg("t-range", function (v) { st.range = parseInt(v, 10); st.intraday = null; st.needRange = true; setSeg("t-intraday", "off"); drawTerminal(); });
      bindSeg("t-intraday", function (v) {
        st.intraday = v === "off" ? null : v;
        st.needRange = true; st.lastIntradayKey = null;
        drawTerminal();
      });
      bindSeg("t-type", function (v) { st.type = v; applyChartOptions(); });
      $("t-log").addEventListener("click", function () {
        st.log = !st.log;
        this.classList.toggle("active", st.log);
        applyChartOptions();
      });
      // overlay + panel chips
      Array.prototype.forEach.call(document.querySelectorAll("#t-overlays .chip-btn"), function (b) {
        b.addEventListener("click", function () {
          var k = b.getAttribute("data-k");
          st.overlays[k] = !st.overlays[k];
          b.classList.toggle("active", st.overlays[k]);
          applyChartOptions();
        });
      });
      Array.prototype.forEach.call(document.querySelectorAll("#t-panels .chip-btn"), function (b) {
        b.addEventListener("click", function () {
          var k = b.getAttribute("data-k");
          st.panels[k] = !st.panels[k];
          b.classList.toggle("active", st.panels[k]);
          applyChartOptions();
        });
      });
      // peer compare select
      var peer = $("t-peer");
      var op = document.createElement("option");
      op.value = "";
      op.textContent = "vs Universe only";
      peer.appendChild(op);
      D.universe.forEach(function (u) {
        var o2 = document.createElement("option");
        o2.value = u.ticker;
        o2.textContent = u.ticker;
        peer.appendChild(o2);
      });
      peer.addEventListener("change", function () {
        st.peer = this.value;
        drawCompare();
      });
    }
    $("t-ticker").value = st.ticker;

    drawTerminalQuoteBar();

    /* ---- main chart ---- */
    if (st.intraday) {
      drawIntraday();
    } else {
      var ser = candleSeries(st.ticker);
      var chart = chartOf("t-candles", CH.CandleChart, chartOpts());
      chart.setData({
        dates: ser.dates, ohlcv: ser.ohlcv, ticker: st.ticker,
        name: BY_TICKER[st.ticker].name, forming: ser.forming, live: ser.live,
      });
      if (st.needRange) {
        chart.showRange(RANGE_BARS[String(st.range)] || 504);
        st.needRange = false;
      }
    }

    drawTerminalSnapshot();
    drawRelative();
    drawCompare();
  }
  RENDER.terminal = drawTerminal;

  function chartOpts() {
    return {
      type: termState.type, log: termState.log,
      overlays: Object.assign({}, termState.overlays),
      panels: Object.assign({}, termState.panels),
    };
  }
  function applyChartOptions() {
    if (termState.intraday) { drawIntraday(); return; }
    var chart = charts["t-candles"];
    if (chart) chart.setOptions(chartOpts());
  }

  function drawIntraday() {
    var st = termState;
    var tk = st.ticker;
    var range = st.intraday === "1d" ? "1d" : "5d";
    var interval = st.intraday === "1d" ? "5m" : "15m";
    var key = tk + "|" + range + "|" + interval;
    var note = $("t-intraday-note");
    if (!live.isLive()) {
      note.textContent = "Intraday requires the live endpoint — deploy on Netlify or run the local dev server.";
      note.classList.remove("hidden");
      return;
    }
    note.classList.add("hidden");
    if (st.intradayBusy && st.lastIntradayKey === key) return;
    st.intradayBusy = true;
    st.lastIntradayKey = key;
    note.textContent = "Loading intraday…";
    note.classList.remove("hidden");
    live.fetchSeries(tk, range, interval).then(function (data) {
      st.intradayBusy = false;
      if (st.intraday !== range && !(st.intraday === "5d" && range === "5d")) return;
      note.classList.add("hidden");
      var flat = [];
      for (var i = 0; i < data.ohlcv.length; i++) {
        var b = data.ohlcv[i];
        if (b[3] == null) continue;
        flat.push(b[0], b[1], b[2], b[3], b[4] != null ? Math.round(b[4] / 1000) : null);
      }
      var labels = [];
      for (i = 0; i < data.ohlcv.length; i++) if (data.ohlcv[i][3] != null) labels.push(data.labels[i] || data.dates[i]);
      var chart = chartOf("t-candles", CH.CandleChart, chartOpts());
      chart.setData({
        dates: labels, ohlcv: flat, ticker: tk,
        name: BY_TICKER[tk].name, forming: -1,
        intraday: true,
        live: { price: data.price, prevClose: data.previousClose },
      });
      if (st.needRange) {
        chart.showRange(labels.length);
        st.needRange = false;
      }
    }).catch(function () {
      st.intradayBusy = false;
      note.textContent = "Intraday data unavailable right now.";
      note.classList.remove("hidden");
    });
  }

  function drawTerminalSnapshot() {
    var tk = termState.ticker;
    var t = TICKERS.indexOf(tk);
    var lastIdx = DAYS() - 1;
    var px = livePrice(tk);
    var arr = D.close[tk];
    var hi52 = -Infinity, lo52 = Infinity;
    for (var i = Math.max(0, arr.length - 253); i < arr.length; i++) {
      if (arr[i] != null) { hi52 = Math.max(hi52, arr[i]); lo52 = Math.min(lo52, arr[i]); }
    }
    if (px != null) { hi52 = Math.max(hi52, px); lo52 = Math.min(lo52, px); }
    var vol20 = core.rollingVolAt(lastIdx, 20, t);
    var rsi = core.rsiCutlerAt(lastIdx, 14, t);
    // volume ratio from candles
    var candles = D.candles[tk];
    var cn = D.candle_dates.length;
    var v20 = null, v120 = null;
    if (cn >= 121) {
      var s1 = 0, n1 = 0, s2 = 0, n2 = 0;
      for (var k = cn - 20; k < cn; k++) { var vv = candles[k * 5 + 4]; if (vv != null) { s1 += vv; n1++; } }
      for (k = cn - 120; k < cn; k++) { vv = candles[k * 5 + 4]; if (vv != null) { s2 += vv; n2++; } }
      if (n1 && n2) { v20 = s1 / n1; v120 = s2 / n2; }
    }
    var risk = core.assetRisk()[t];
    var rows = [
      ["Last", "$" + fmt.num(px, 2), ""],
      ["1W / 1M", fmt.pct(retOver(tk, 5), 1) + " / " + fmt.pct(retOver(tk, 21), 1), "up"],
      ["3M / YTD", fmt.pct(retOver(tk, 63), 1) + " / " + fmt.pct(ytdReturn(tk), 1), "up"],
      ["1Y return", fmt.pct(retOver(tk, 252), 1), retOver(tk, 252) >= 0 ? "up" : "down"],
      ["52W high / low", fmt.num(hi52, 1) + " / " + fmt.num(lo52, 1)],
      ["vs 52W high", fmt.pct(px / hi52 - 1, 1), "down"],
      ["Vol 20D (ann.)", fmt.pctAbs(vol20 != null ? vol20 * Math.sqrt(252) : null, 1)],
      ["Volume 20/120", v20 && v120 ? (v20 / v120).toFixed(2) + "×" : "–"],
      ["RSI-14", rsi != null ? rsi.toFixed(1) : "–", rsi != null ? (rsi < 30 ? "up" : rsi > 70 ? "down" : "") : ""],
      ["Beta vs universe", fmt.num(risk.beta, 2)],
      ["Sharpe (full)", fmt.num(risk.sharpe, 2)],
      ["Max drawdown", fmt.pctAbs(risk.maxdd, 1), "down"],
    ];
    $("t-snap-name").textContent = BY_TICKER[tk].name;
    var kv = $("t-snapshot");
    kv.innerHTML = "";
    rows.forEach(function (r) {
      kv.appendChild(el("div", "k", r[0]));
      kv.appendChild(el("div", "v " + (r[2] || ""), String(r[1])));
    });
    var meta = $("t-snap-meta");
    meta.innerHTML = '<span class="pill">' + BY_TICKER[tk].sector + "</span>" +
      '<span class="pill pill-dim">' + BY_TICKER[tk].industry + "</span>";
  }

  function rangeStartIdx(tk) {
    var bars = RANGE_BARS[String(termState.range)] || 504;
    var arr = D.close[tk];
    return Math.max(0, arr.length - 1 - bars);
  }

  function drawRelative() {
    var tk = termState.ticker;
    var arr = D.close[tk];
    var start = rangeStartIdx(tk);
    var dates = [], rel = [];
    var basePx = null, baseB = null;
    for (var i = start; i < arr.length; i++) {
      if (arr[i] == null) continue;
      if (basePx == null) { basePx = arr[i]; baseB = D.benchmark[i]; }
      dates.push(D.dates[i]);
      rel.push(arr[i] / basePx - (D.benchmark[i] / baseB));
    }
    // live point
    var forming = LV.forming[tk];
    if (forming) {
      var lastPx = forming.c;
      rel.push(lastPx / basePx - (D.benchmark[D.benchmark.length - 1] / baseB));
      dates.push(forming.date);
    }
    chartOf("t-relative", CH.LineChart, {
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
      tipFmt: function (v) { return fmt.pct(v, 1); },
      zeroLine: true, legend: false,
    }).setData(dates, [
      { name: tk + " − universe (rel.)", data: rel, color: C.magenta, width: 1.8 },
    ]);
  }

  function drawCompare() {
    var tk = termState.ticker;
    var arr = D.close[tk];
    var start = rangeStartIdx(tk);
    var dates = [], a = [], b = [], p = [];
    var peer = termState.peer;
    var peerArr = peer ? D.close[peer] : null;
    var baseA = null, baseB = null, baseP = null;
    for (var i = start; i < arr.length; i++) {
      if (arr[i] == null) continue;
      if (baseA == null) { baseA = arr[i]; baseB = D.benchmark[i]; if (peerArr) baseP = peerArr[i]; }
      dates.push(D.dates[i]);
      a.push(100 * arr[i] / baseA);
      b.push(100 * D.benchmark[i] / baseB);
      p.push(peerArr && baseP && peerArr[i] != null ? 100 * peerArr[i] / baseP : null);
    }
    var forming = LV.forming[tk];
    if (forming) {
      dates.push(forming.date);
      a.push(100 * forming.c / baseA);
      b.push(b[b.length - 1]);
      p.push(peerArr && baseP && LV.forming[peer] ? 100 * LV.forming[peer].c / baseP : null);
    }
    var series = [
      { name: tk, data: a, color: C.cyan, width: 2 },
      { name: "Universe", data: b, color: C.violet, width: 1.4, dash: [5, 4] },
    ];
    if (peer) series.push({ name: peer, data: p, color: C.amber, width: 1.6 });
    chartOf("t-compare", CH.LineChart, {
      yFmt: function (v) { return fmt.num(v, 0); },
      tipFmt: function (v) { return fmt.num(v, 1); },
    }).setData(dates, series);
  }

  /* ============================ SCREENER =============================== */
  var scrState = { sortKey: "day", desc: true, search: "", sector: "" };

  function screenerRows() {
    var rows = [];
    for (var t = 0; t < N; t++) {
      var tk = TICKERS[t];
      var u = BY_TICKER[tk];
      var arr = D.close[tk];
      var px = livePrice(tk);
      // 52w high
      var hi52 = -Infinity;
      for (var i = Math.max(0, arr.length - 253); i < arr.length; i++) {
        if (arr[i] != null) hi52 = Math.max(hi52, arr[i]);
      }
      if (px != null) hi52 = Math.max(hi52, px);
      // vol ratio
      var candles = D.candles[tk], cn = D.candle_dates.length;
      var v20 = null, v120 = null;
      if (cn >= 121) {
        var s1 = 0, n1 = 0, s2 = 0, n2 = 0;
        for (var k = cn - 20; k < cn; k++) { var vv = candles[k * 5 + 4]; if (vv != null) { s1 += vv; n1++; } }
        for (k = cn - 120; k < cn; k++) { vv = candles[k * 5 + 4]; if (vv != null) { s2 += vv; n2++; } }
        if (n1 && n2) { v20 = s1 / n1; v120 = s2 / n2; }
      }
      rows.push({
        ticker: tk, name: u.name, sector: u.sector,
        price: px,
        day: dayChangePct(tk),
        w1: retOver(tk, 5), m1: retOver(tk, 21), m3: retOver(tk, 63),
        ytd: ytdReturn(tk), y1: retOver(tk, 252),
        vol: core.rollingVolAt(DAYS() - 1, 20, t),
        rsi: core.rsiCutlerAt(DAYS() - 1, 14, t),
        off52: hi52 > 0 && px ? px / hi52 - 1 : null,
        vratio: v20 && v120 ? v20 / v120 : null,
        spark: arr.slice(-30).concat(LV.forming[tk] ? [LV.forming[tk].c] : []),
      });
    }
    return rows;
  }

  function drawScreener() {
    // controls (once)
    if (!drawScreener.wired) {
      drawScreener.wired = true;
      $("scr-search").addEventListener("input", function () {
        scrState.search = this.value.toLowerCase();
        renderScreenerRows();
      });
      var secSel = $("scr-sector");
      core.SECTOR_LIST.forEach(function (s) {
        var o = document.createElement("option");
        o.value = s; o.textContent = s;
        secSel.appendChild(o);
      });
      secSel.addEventListener("change", function () {
        scrState.sector = this.value;
        renderScreenerRows();
      });
      Array.prototype.forEach.call($("scr-table").querySelectorAll("th[data-k]"), function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-k");
          if (scrState.sortKey === k) scrState.desc = !scrState.desc;
          else { scrState.sortKey = k; scrState.desc = true; }
          renderScreenerRows();
        });
        th.title = "Sort by " + th.textContent;
      });
    }
    renderScreenerRows();
  }
  RENDER.screener = drawScreener;

  function renderScreenerRows() {
    var rows = screenerRows();
    if (scrState.search) {
      rows = rows.filter(function (r) {
        return r.ticker.toLowerCase().indexOf(scrState.search) >= 0 ||
          r.name.toLowerCase().indexOf(scrState.search) >= 0;
      });
    }
    if (scrState.sector) rows = rows.filter(function (r) { return r.sector === scrState.sector; });
    rows.sort(function (a, b) {
      var av = a[scrState.sortKey], bv = b[scrState.sortKey];
      if (typeof av === "string") return scrState.desc ? bv.localeCompare(av) : av.localeCompare(bv);
      var an = av == null ? -Infinity : av, bn = bv == null ? -Infinity : bv;
      return scrState.desc ? bn - an : an - bn;
    });
    var tb = $("scr-table").querySelector("tbody");
    tb.innerHTML = "";
    var frag = document.createDocumentFragment();
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.className = "scr-row";
      var dayCls = r.day >= 0 ? "up" : "down";
      var html =
        '<td class="ticker-cell">' + r.ticker + "</td>" +
        '<td class="name-cell scr-name">' + r.name + "</td>" +
        '<td class="name-cell scr-sector">' + r.sector.replace("Information Technology", "Info Tech").replace("Communication Services", "Comm Svcs").replace("Consumer Discretionary", "Cons Disc").replace("Consumer Staples", "Cons Staples") + "</td>" +
        "<td>$" + fmt.num(r.price, 2) + "</td>" +
        '<td class="' + dayCls + '">' + fmt.pct(r.day, 2) + "</td>" +
        '<td class="' + (r.w1 >= 0 ? "up" : "down") + '">' + fmt.pct(r.w1, 1) + "</td>" +
        '<td class="' + (r.m1 >= 0 ? "up" : "down") + '">' + fmt.pct(r.m1, 1) + "</td>" +
        '<td class="' + (r.m3 >= 0 ? "up" : "down") + '">' + fmt.pct(r.m3, 1) + "</td>" +
        '<td class="' + (r.ytd >= 0 ? "up" : "down") + '">' + fmt.pct(r.ytd, 1) + "</td>" +
        '<td class="' + (r.y1 >= 0 ? "up" : "down") + '">' + fmt.pct(r.y1, 1) + "</td>" +
        "<td>" + fmt.pctAbs(r.vol != null ? r.vol * Math.sqrt(252) : null, 1) + "</td>" +
        "<td>" + (r.rsi != null ? r.rsi.toFixed(0) : "–") + "</td>" +
        '<td class="down">' + fmt.pct(r.off52, 1) + "</td>" +
        "<td>" + (r.vratio != null ? r.vratio.toFixed(2) + "×" : "–") + "</td>" +
        '<td class="scr-spark"><canvas></canvas></td>';
      tr.innerHTML = html;
      tr.addEventListener("click", function () {
        termState.ticker = r.ticker;
        termState.needRange = true;
        termState.lastIntradayKey = null;
        activateTab("terminal");
      });
      frag.appendChild(tr);
    });
    tb.appendChild(frag);
    // sparklines
    Array.prototype.forEach.call(tb.querySelectorAll("tr"), function (tr, i) {
      var r = rows[i];
      var cv = tr.querySelector("canvas");
      if (!cv) return;
      var trend = r.w1 != null ? r.w1 : 0;
      CH.drawSparkline(cv, r.spark, trend >= 0 ? C.up : C.down, { w: 92, h: 26 });
    });
    $("scr-count").textContent = rows.length + " of " + N + " names";
  }

  /* ============================ FACTORS ================================ */
  var facState = { key: "momentum_6m" };
  var FACTOR_ORDER = core.FACTOR_KEYS.concat(["composite"]);
  var FACTOR_NAMES = Object.assign({}, core.FACTOR_LABELS, { composite: "Composite (avg z)" });

  function drawFactors() {
    var chips = $("f-chips");
    if (!chips.childElementCount) {
      FACTOR_ORDER.forEach(function (key) {
        var b = el("button", "chip-btn" + (key === facState.key ? " active" : ""), FACTOR_NAMES[key]);
        b.addEventListener("click", function () {
          facState.key = key;
          Array.prototype.forEach.call(chips.children, function (c) { c.classList.remove("active"); });
          b.classList.add("active");
          drawFactorViews();
        });
        chips.appendChild(b);
      });
      // scoreboard rows
      var tb = $("f-summary").querySelector("tbody");
      tb.innerHTML = "";
      FACTOR_ORDER.forEach(function (key) {
        var s = core.icData(key).summary;
        var q = core.quintileSpread(key);
        var tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        tr.innerHTML =
          '<td class="name-cell f-name">' + FACTOR_NAMES[key] + "</td>" +
          '<td class="' + (s.mean >= 0 ? "pos" : "neg") + '">' + s.mean.toFixed(4) + "</td>" +
          "<td>" + s.ir.toFixed(2) + "</td>" +
          "<td>" + s.tstat.toFixed(1) + "</td>" +
          "<td>" + (s.hit * 100).toFixed(0) + "%</td>" +
          '<td class="' + (q.ls.meanMonthly >= 0 ? "pos" : "neg") + '">' + (q.ls.meanMonthly != null ? fmt.pct(q.ls.meanMonthly, 2) : "–") + "</td>" +
          "<td>" + s.n + "</td>";
        tr.addEventListener("click", function () {
          facState.key = key;
          Array.prototype.forEach.call(chips.children, function (c, i) {
            c.classList.toggle("active", FACTOR_ORDER[i] === key);
          });
          drawFactorViews();
        });
        tb.appendChild(tr);
      });
    }
    drawFactorViews();
  }
  RENDER.factors = drawFactors;

  function drawFactorViews() {
    var key = facState.key;
    var label = FACTOR_NAMES[key];
    var lastIdx = DAYS() - 1;
    var sc = core.scoresFor(key, lastIdx);

    // cross-section ranks
    var items = TICKERS.map(function (tk, t) {
      return { label: tk, value: sc[t], name: BY_TICKER[tk].name };
    }).filter(function (it) { return it.value != null; })
      .sort(function (a, b) { return b.value - a.value; });
    var top = items.slice(0, 10);
    var bottom = items.slice(-10);
    var rows = [];
    top.concat([{ divider: true }], bottom).forEach(function (it) {
      if (it.divider) { rows.push({ label: "···", value: 0, divider: true }); return; }
      it.tipRows = [["Company", it.name], ["Score", fmt.num(it.value, 3)], ["Sector", BY_TICKER[it.label].sector]];
      rows.push(it);
    });
    chartOf("f-ranks", CH.BarChartH, {}).setData({
      items: rows,
      valueFmt: function (v) { return fmt.num(v, 2); },
      colorize: function (v, idx, it) {
        return it.divider ? "rgba(255,255,255,0.12)" : (v >= 0 ? C.cyan : C.magenta);
      },
    });
    $("f-rank-hint").textContent = label + " · top & bottom 10 · as of " + D.dates[lastIdx];

    // scatter: score vs realized 1M return (descriptive)
    var pts = [];
    for (var t = 0; t < N; t++) {
      var tk = TICKERS[t];
      var pxNow = livePrice(tk);
      var arr = D.close[tk];
      var px21 = arr[arr.length - 22];
      if (sc[t] == null || !pxNow || !px21) continue;
      var r1m = pxNow / px21 - 1;
      pts.push({
        x: sc[t], y: r1m, label: tk, name: BY_TICKER[tk].name,
        color: core.SECTOR_COLORS[BY_TICKER[tk].sector],
        tipRows: [["Sector", BY_TICKER[tk].sector], ["Score", fmt.num(sc[t], 3)], ["1M return", fmt.pct(r1m, 1)]],
      });
    }
    chartOf("f-scatter", CH.ScatterChart, {}).setData({
      points: pts, xLabel: label, yLabel: "1M return", regression: true,
      xFmt: function (v) { return fmt.num(v, 1); },
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
    });

    // IC series
    var ic = core.icData(key);
    chartOf("f-ic-series", CH.ICChart).setData({
      labels: ic.labels, ic: ic.ic, cum: ic.cum,
    });
    $("f-ic-hint").textContent = label + " · IC " + ic.summary.mean.toFixed(3) +
      " · IR " + ic.summary.ir.toFixed(2) + " · hit " + (ic.summary.hit * 100).toFixed(0) +
      "% · t=" + ic.summary.tstat.toFixed(1);

    // quintile spread
    var q = core.quintileSpread(key);
    var qItems = q.slice(0, 5).map(function (qq) {
      return {
        label: "Q" + qq.q, value: qq.meanMonthly || 0,
        tipRows: [
          [qq.q === 1 ? "Top-score quintile" : qq.q === 5 ? "Bottom-score quintile" : "Quintile " + qq.q],
          ["Avg next-21d return", fmt.pct(qq.meanMonthly, 3)],
          ["Annualized", fmt.pctAbs(qq.ann, 1)],
          ["t-stat", qq.tstat != null ? qq.tstat.toFixed(2) : "–"],
          ["Months", String(qq.n)],
        ],
      };
    });
    qItems.push({
      label: "Q1−Q5", value: q.ls.meanMonthly || 0,
      tipRows: [["Long-short spread"], ["Avg monthly", fmt.pct(q.ls.meanMonthly, 3)], ["Annualized", fmt.pctAbs(Math.pow(1 + (q.ls.meanMonthly || 0), 12) - 1, 1)]],
    });
    chartOf("f-quintiles", CH.BarChartH, {}).setData({
      items: qItems,
      valueFmt: function (v) { return fmt.pct(v, 2); },
      colorize: function (v, idx) { return idx === 5 ? C.amber : (v >= 0 ? C.cyan : C.magenta); },
    });

    // factor correlation (7 basic factors, last 36 months)
    var keys7 = core.FACTOR_KEYS;
    var SHORT = {
      momentum_12_1: "Mom 12-1", momentum_6m: "Mom 6M", reversal_1m: "Reversal",
      low_volatility: "LowVol", rsi_14: "RSI", near_52w_high: "52W-Hi", volume_trend: "Volume",
    };
    var m = core.factorCorrMatrix(36);
    var shortLabs = keys7.map(function (k) { return SHORT[k] || k; });
    chartOf("f-corr", CH.Heatmap).setData({
      mode: "corr",
      labels: shortLabs,
      labelsTop: shortLabs,
      labelsLeft: shortLabs,
      matrix: m,
    });
  }

  /* ============================ BACKTEST =============================== */
  var btState = { strat: "momentum_6m", topN: 10, rebal: 1, cost: 10, mode: "long" };
  var STRATEGY_LABELS = Object.assign({}, core.FACTOR_LABELS, {
    composite: "Composite (avg z-score)",
    equal_weight: "Equal-Weight Universe",
  });

  function drawBacktest() {
    var sel = $("b-strat");
    if (!sel.options.length) {
      Object.keys(STRATEGY_LABELS).forEach(function (k) {
        var o = document.createElement("option");
        o.value = k;
        o.textContent = STRATEGY_LABELS[k];
        sel.appendChild(o);
      });
      sel.value = btState.strat;
      sel.addEventListener("change", function () { btState.strat = sel.value; runAndRenderBT(); });
      bindSeg("b-mode", function (v) { btState.mode = v; runAndRenderBT(); });
      bindSeg("b-topn", function (v) { btState.topN = parseInt(v, 10); runAndRenderBT(); });
      bindSeg("b-rebal", function (v) { btState.rebal = parseInt(v, 10); runAndRenderBT(); });
      bindSeg("b-cost", function (v) { btState.cost = parseInt(v, 10); runAndRenderBT(); });
      $("b-export").addEventListener("click", exportBacktestCSV);
    }
    sel.value = btState.strat;
    runAndRenderBT();
  }
  RENDER.backtest = drawBacktest;

  var lastBT = null;
  function runAndRenderBT() {
    var res = core.runBacktest({
      signal: btState.strat, topN: btState.topN,
      rebalMonths: btState.rebal, costBps: btState.cost, mode: btState.mode,
    });
    if (!res) return;
    lastBT = res;
    var label = STRATEGY_LABELS[btState.strat];
    var m = res.metrics;
    var bm = core.perfMetrics(res.benchDaily, res.benchDaily);

    var cards = [
      { l: "CAGR", v: fmt.pctAbs(m.cagr, 1), c: m.cagr >= bm.cagr ? "up" : "down" },
      { l: "vs Universe", v: fmt.pct(m.cagr - bm.cagr, 1), c: m.cagr >= bm.cagr ? "up" : "down" },
      { l: "Sharpe", v: m.sharpe == null ? "–" : m.sharpe.toFixed(2), c: m.sharpe >= 1 ? "up" : "" },
      { l: "Sortino", v: m.sortino == null ? "–" : m.sortino.toFixed(2), c: m.sortino >= 1.4 ? "up" : "" },
      { l: "Vol (ann.)", v: fmt.pctAbs(m.vol, 1) },
      { l: "Max DD", v: fmt.pctAbs(m.maxdd, 1), c: "down" },
      { l: "Calmar", v: m.calmar == null ? "–" : m.calmar.toFixed(2) },
      { l: "Win days", v: (m.winRate * 100).toFixed(0) + "%", c: m.winRate >= 0.5 ? "up" : "" },
      { l: "Alpha (ann.)", v: m.alpha == null ? "–" : fmt.pct(m.alpha, 1), c: m.alpha >= 0 ? "up" : "down" },
      { l: "Beta", v: m.beta == null ? "–" : m.beta.toFixed(2) },
      { l: "Turnover (ann.)", v: res.turnoverAnn.toFixed(1) + "×" },
      { l: "Skew", v: m.skew == null ? "–" : m.skew.toFixed(2), c: m.skew < 0 ? "down" : "" },
    ];
    var box = $("b-metrics");
    box.innerHTML = "";
    cards.forEach(function (cd) {
      box.appendChild(el("div", "bt-metric",
        '<div class="bm-label">' + cd.l + '</div>' +
        '<div class="bm-value ' + (cd.c || "") + '">' + cd.v + "</div>"));
    });
    $("b-eq-hint").textContent =
      label + " · " + (btState.mode === "longshort" ? "long-short top/bottom " + btState.topN : "long top " + btState.topN) +
      " · " + (btState.rebal === 1 ? "monthly" : "quarterly") + " · " + btState.cost + " bps" +
      " · " + res.dates[0] + " → " + res.dates[res.dates.length - 1] +
      " · " + res.elapsed.toFixed(0) + " ms";

    chartOf("b-equity", CH.LineChart, {
      log: true,
      yFmt: function (v) { return fmt.num(v, 0); },
      tipFmt: function (v) { return fmt.num(v, 1); },
    }).setData(res.dates, [
      { name: label, data: res.equity, color: C.cyan, width: 2 },
      { name: "equal-weight universe", data: res.benchmark, color: C.violet, width: 1.4, dash: [5, 4] },
    ]);

    var peak = -Infinity, dd = [];
    res.equity.forEach(function (v) { peak = Math.max(peak, v); dd.push(v / peak - 1); });
    chartOf("b-drawdown", CH.LineChart, {
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
      tipFmt: function (v) { return fmt.pct(v, 1); },
      legend: false,
    }).setData(res.dates, [
      { name: "drawdown", data: dd, color: C.down, fill: "rgba(244,83,107,0.16)", width: 1.6 },
    ]);

    // monthly heatmap from compounded monthly returns
    var years = [], seen = {};
    Object.keys(res.monthly).sort().forEach(function (k) {
      var y = k.slice(0, 4);
      if (!seen[y]) { seen[y] = true; years.push(y); }
    });
    var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var matrix = years.map(function (y) {
      var row = [];
      for (var mi = 0; mi < 12; mi++) {
        var key = y + "-" + String(mi + 1).padStart(2, "0");
        row.push(res.monthly[key] == null ? null : res.monthly[key] - 1);
      }
      return row;
    });
    chartOf("b-monthly", CH.Heatmap).setData({
      mode: "monthly", rows: years, cols: MONTHS, matrix: matrix,
    });
    $("b-monthly-note").textContent = "Best month " + fmt.pct(m.bestMonth, 1) +
      " · worst " + fmt.pct(m.worstMonth, 1) + " · " + matrix.length + " calendar years";

    // holdings table
    var tb = $("b-holdings").querySelector("tbody");
    tb.innerHTML = "";
    if (btState.strat === "equal_weight") {
      tb.innerHTML = '<tr><td colspan="6" class="bt-note">Equal-weight strategy holds all ' + N +
        " names at " + (100 / N).toFixed(2) + "% each.</td></tr>";
    } else {
      var uniq = [];
      var seenT = {};
      res.holdings.forEach(function (tIdx) {
        if (seenT[tIdx]) return;
        seenT[tIdx] = true;
        uniq.push(tIdx);
      });
      uniq.forEach(function (tIdx, i) {
        var tk = TICKERS[tIdx];
        var u = BY_TICKER[tk];
        var side = btState.mode === "longshort" ? (i < btState.topN ? "LONG" : "SHORT") : "LONG";
        var dc = dayChangePct(tk);
        tr3 = document.createElement("tr");
        tr3.innerHTML =
          "<td>" + (i + 1) + "</td>" +
          '<td class="ticker-cell">' + tk + "</td>" +
          '<td class="name-cell bt-h-name">' + u.name + "</td>" +
          '<td class="name-cell bt-h-sector">' + u.sector.replace("Information Technology", "Info Tech").replace("Communication Services", "Comm Svcs").replace("Consumer Discretionary", "Cons Disc").replace("Consumer Staples", "Cons Staples") + "</td>" +
          '<td class="' + (side === "LONG" ? "pos" : "neg") + '">' + side + " " + (100 / (btState.mode === "longshort" ? btState.topN : uniq.length)).toFixed(1) + "%</td>" +
          "<td>$" + fmt.num(livePrice(tk), 2) + "</td>" +
          '<td class="' + (dc >= 0 ? "up" : "down") + '">' + fmt.pct(dc, 2) + "</td>";
        tb.appendChild(tr3);
      });
    }
  }
  var tr3;

  function exportBacktestCSV() {
    if (!lastBT) return;
    var rows = [["date", "equity", "benchmark", "daily_return"]];
    for (var i = 0; i < lastBT.dates.length; i++) {
      rows.push([
        lastBT.dates[i],
        lastBT.equity[i].toFixed(4),
        lastBT.benchmark[i].toFixed(4),
        lastBT.rets[i] != null ? lastBT.rets[i].toFixed(6) : "",
      ]);
    }
    var csv = rows.map(function (r) { return r.join(","); }).join("\n");
    var blob = new Blob([csv], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "quantpulse-backtest-" + btState.strat + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast("Backtest equity curve exported as CSV");
  }

  /* ============================== RISK ================================= */
  var riskState = { sortKey: "vol", desc: true, lookback: 504, ticker: "AAPL" };

  function drawRisk() {
    if (!drawRisk.wired) {
      drawRisk.wired = true;
      var sel = $("r-ticker");
      D.universe.forEach(function (u) {
        var o = document.createElement("option");
        o.value = u.ticker; o.textContent = u.ticker;
        sel.appendChild(o);
      });
      sel.value = riskState.ticker;
      sel.addEventListener("change", function () {
        riskState.ticker = this.value;
        drawRiskCharts();
      });
      bindSeg("r-lookback", function (v) {
        riskState.lookback = parseInt(v, 10);
        drawRiskHeatmap();
      });
      Array.prototype.forEach.call($("r-table").querySelectorAll("th[data-k]"), function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-k");
          if (riskState.sortKey === k) riskState.desc = !riskState.desc;
          else { riskState.sortKey = k; riskState.desc = true; }
          renderRiskTable();
        });
      });
    }
    sel = $("r-ticker");
    if (sel && sel.value !== riskState.ticker) sel.value = riskState.ticker;

    var risks = core.assetRisk();
    var avgVol = core.stats.mean(risks.map(function (r) { return r.vol; }));
    var avgSharpe = core.stats.mean(risks.map(function (r) { return r.sharpe; }));
    var worst = risks.reduce(function (a, b) { return a.maxdd < b.maxdd ? a : b; });
    var best = risks.slice().sort(function (a, b) { return b.sharpe - a.sharpe; })[0];
    var box = $("r-stats");
    box.innerHTML = "";
    [
      { label: "Average volatility", value: fmt.pctAbs(avgVol, 1), sub: "annualized, full sample" },
      { label: "Average Sharpe", value: avgSharpe.toFixed(2), sub: "daily data · rf = 0", cls: "up" },
      { label: "Deepest drawdown", value: fmt.pctAbs(worst.maxdd, 1), sub: worst.ticker + " · peak to trough", cls: "down" },
      { label: "Best Sharpe", value: best.ticker, sub: fmt.num(best.sharpe, 2) + " · " + best.name, cls: "up" },
    ].forEach(function (s) {
      box.appendChild(el("div", "stat",
        '<div class="stat-label">' + s.label + '</div>' +
        '<div class="stat-value ' + (s.cls || "") + '">' + s.value + "</div>" +
        '<div class="stat-sub">' + s.sub + "</div>"));
    });

    drawRiskHeatmap();
    renderRiskTable();
    drawRiskCharts();
  }
  RENDER.risk = drawRisk;

  function drawRiskHeatmap() {
    chartOf("r-heatmap", CH.Heatmap).setData({
      mode: "corr", labels: TICKERS, matrix: core.corrMatrix(riskState.lookback),
    });
  }

  function ddColor(dd) {
    var t = Math.min(1, Math.max(0, (-dd - 0.1) / 0.6));
    return "rgb(" + Math.round(37 + t * 207) + "," + Math.round(211 - 104 * t) + "," + Math.round(224 - 101 * t) + ")";
  }

  function renderRiskTable() {
    var risks = core.assetRisk();
    var tb = $("r-table").querySelector("tbody");
    tb.innerHTML = "";
    risks.slice().sort(function (a, b) {
      var av = a[riskState.sortKey], bv = b[riskState.sortKey];
      var cmp = (typeof av === "string") ? av.localeCompare(bv) : av - bv;
      return riskState.desc ? -cmp : cmp;
    }).forEach(function (r) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td class="ticker-cell">' + r.ticker + "</td>" +
        "<td>" + fmt.pctAbs(r.vol, 1) + "</td>" +
        "<td>" + fmt.num(r.sharpe, 2) + "</td>" +
        "<td>" + fmt.num(r.sortino, 2) + "</td>" +
        '<td class="neg">' + fmt.pctAbs(r.maxdd, 1) + "</td>" +
        '<td class="neg">' + fmt.pctAbs(r.var95, 1) + "</td>" +
        '<td class="neg">' + fmt.pctAbs(r.cvar95, 1) + "</td>" +
        "<td>" + fmt.num(r.beta, 2) + "</td>" +
        '<td class="' + (r.cagr >= 0 ? "up" : "down") + '">' + fmt.pctAbs(r.cagr, 1) + "</td>";
      tb.appendChild(tr);
    });
  }

  function drawRiskCharts() {
    var tk = riskState.ticker;
    // risk / return scatter
    var pts = core.assetRisk().map(function (r) {
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
    chartOf("r-scatter", CH.ScatterChart, {}).setData({
      points: pts, xLabel: "volatility (ann.)", yLabel: "CAGR",
      xFmt: function (v) { return fmt.pctAbs(v, 0); },
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
    });

    // rolling vol (60d ann.)
    var rv = core.rollingVolSeries(tk, 60) || [];
    var rvU = core.rollingVolSeries("__universe__", 60);
    if (!rvU) {
      // universe rolling vol from benchmark returns
      rvU = [];
      var win = 60;
      for (var i = win + 1; i < DAYS(); i++) {
        var vals = S.benchRets.slice(i - win + 1, i + 1);
        var sd = core.stats.std(vals);
        if (sd != null) rvU.push({ date: D.dates[i], vol: sd * Math.sqrt(252) });
      }
    }
    var lastRV = rv.length ? rv[rv.length - 1].date : null;
    var lastIdxU = lastRV ? rvU.findIndex(function (x) { return x.date === lastRV; }) : rvU.length - 1;
    chartOf("r-rolling", CH.LineChart, {
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
      tipFmt: function (v) { return fmt.pctAbs(v, 1); },
    }).setData(rv.map(function (x) { return x.date; }), [
      { name: tk + " 60D vol", data: rv.map(function (x) { return x.vol; }), color: C.cyan, width: 1.7 },
      { name: "Universe 60D vol", data: rvU.slice(0, lastIdxU + 1).map(function (x) { return x.vol; }), color: C.violet, width: 1.3, dash: [4, 4] },
    ]);

    // underwater plot
    var uw = core.underwaterSeries(tk) || [];
    chartOf("r-underwater", CH.LineChart, {
      yFmt: function (v) { return fmt.pctAbs(v, 0); },
      tipFmt: function (v) { return fmt.pct(v, 1); },
      legend: false,
    }).setData(uw.map(function (x) { return x.date; }), [
      { name: "drawdown", data: uw.map(function (x) { return x.dd; }), color: C.down, fill: "rgba(244,83,107,0.15)", width: 1.4 },
    ]);

    // return distribution histogram
    var t = TICKERS.indexOf(tk);
    var rs = [];
    for (var i2 = 1; i2 < DAYS(); i2++) {
      if (S.rets[i2] && S.rets[i2][t] != null) rs.push(S.rets[i2][t]);
    }
    var sorted = rs.slice().sort(function (a, b) { return a - b; });
    var k = Math.floor(sorted.length * 0.05);
    var var95 = sorted[k];
    var tail = sorted.slice(0, k + 1);
    var cvar95 = tail.reduce(function (s, v) { return s + v; }, 0) / tail.length;
    drawHistogram($("r-histogram"), rs, var95, cvar95);
  }

  function drawHistogram(canvas, values, var95, cvar95) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.parentElement.clientWidth || 480;
    var h = canvas.parentElement.clientHeight || 260;
    if (w < 10) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;

    var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
    var bins = 41;
    var counts = new Array(bins).fill(0);
    var step = (hi - lo) / bins || 1;
    values.forEach(function (v) {
      var b = clamp(Math.floor((v - lo) / step), 0, bins - 1);
      counts[b]++;
    });
    var maxC = Math.max.apply(null, counts);
    var pad = { l: 34, r: 10, t: 18, b: 24 };
    var plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
    var mapX = function (v) { return pad.l + ((v - lo) / (hi - lo || 1)) * plotW; };
    var mapY = function (c) { return pad.t + plotH - (c / maxC) * plotH; };

    ctx.font = "10px " + "'SF Mono',Consolas,monospace";
    ctx.textBaseline = "middle";
    // y ticks
    ctx.fillStyle = C.dim;
    ctx.textAlign = "right";
    for (var c = 0; c <= maxC; c += Math.ceil(maxC / 3)) {
      var y = mapY(c);
      ctx.fillText(String(c), pad.l - 6, y);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.beginPath(); ctx.moveTo(pad.l, y + 0.5); ctx.lineTo(w - pad.r, y + 0.5); ctx.stroke();
    }
    // bars
    for (var b2 = 0; b2 < bins; b2++) {
      var v0 = lo + b2 * step;
      var x = mapX(v0);
      var bw = Math.max(1, plotW / bins - 1);
      var inVaR = v0 <= var95;
      ctx.fillStyle = inVaR ? "rgba(244,83,107,0.75)" : "rgba(37,211,224,0.6)";
      var yTop = mapY(counts[b2]);
      ctx.fillRect(x, yTop, bw, pad.t + plotH - yTop);
    }
    // VaR / CVaR lines
    [[var95, "VaR 95", C.down], [cvar95, "CVaR 95", C.magenta]].forEach(function (m) {
      var x = mapX(m[0]);
      ctx.strokeStyle = m[2];
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(x + 0.5, pad.t); ctx.lineTo(x + 0.5, pad.t + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = m[2];
      ctx.textAlign = x < w - 60 ? "left" : "right";
      ctx.fillText(m[1] + " " + fmt.pctAbs(m[0], 1), x + (x < w - 60 ? 5 : -5), pad.t + 8);
    });
    // x labels
    ctx.fillStyle = C.dim;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    [-0.04, -0.02, 0, 0.02, 0.04].forEach(function (v) {
      if (v > lo && v < hi) ctx.fillText(fmt.pctAbs(v, 1), mapX(v), pad.t + plotH + 6);
    });
    ctx.textAlign = "left";
    ctx.fillText("daily returns distribution", pad.l, 4);
  }

  /* ============================== ML LAB ================================ */
  var mlState = {
    model: "ridge", window: 60, mode: "long", topN: 10, cost: 10,
    running: false, handle: null, result: null, compare: {},
  };
  var mlBT = null;

  function mlDisplayKey(res) {
    return res.model === "all" ? "ensemble" : (res.model === "ensemble" ? "ensemble" : res.model);
  }

  function drawML() {
    if (!drawML.wired) {
      drawML.wired = true;
      $("ml-model").addEventListener("change", function () {
        mlState.model = this.value;
        startMLRun(false);
      });
      bindSeg("ml-window", function (v) {
        mlState.window = parseInt(v, 10);
        startMLRun(false);
      });
      $("ml-run").addEventListener("click", function () {
        // force a fresh retrain of the selected model
        QP.ml.invalidate();
        mlState.result = null;
        startMLRun(false, { manual: true });
      });
      $("ml-compare").addEventListener("click", function () { startMLRun(true); });
      bindSeg("ml-mode", function (v) { mlState.mode = v; renderMLBacktest(); renderMLPicks(); });
      bindSeg("ml-topn", function (v) { mlState.topN = parseInt(v, 10); renderMLBacktest(); });
      bindSeg("ml-cost", function (v) { mlState.cost = parseInt(v, 10); renderMLBacktest(); });
      $("ml-csv").addEventListener("click", exportMLCSV);
    }
    $("ml-model").value = mlState.model;
    setSeg("ml-window", mlState.window);
    setSeg("ml-mode", mlState.mode);
    setSeg("ml-topn", mlState.topN);
    setSeg("ml-cost", mlState.cost);
    if (!mlState.result && !mlState.running) startMLRun(false);
    else if (mlState.result) renderMLResults();
  }
  RENDER.ml = drawML;

  function mlSetBusy(busy, note) {
    mlState.running = busy;
    ["ml-model", "ml-run", "ml-compare"].forEach(function (id) { $(id).disabled = busy; });
    $("ml-window").querySelectorAll(".seg-btn").forEach(function (b) { b.disabled = busy; });
    $("ml-progress-bar").style.width = busy ? "0%" : "0%";
    if (!busy) $("ml-progress").classList.remove("active");
    if (note != null) $("ml-status").textContent = note;
  }

  /* Ridge retrains in ~0.1s; without a floor the busy state flashes by
     invisibly and the button looks dead. Keep it on screen briefly. */
  var ML_MIN_BUSY_MS = 750;
  var mlRunSeq = 0;

  function flashMLStats() {
    var box = $("ml-stats");
    if (!box) return;
    box.classList.remove("ml-flash");
    void box.offsetWidth;                            // restart the animation
    box.classList.add("ml-flash");
  }

  function startMLRun(all, opts) {
    opts = opts || {};
    var manual = !!opts.manual;
    if (mlState.handle) mlState.handle.cancel();
    var seq = ++mlRunSeq;
    var modelKey = all ? "all" : mlState.model;
    mlSetBusy(true, all ? "benchmarking every model…" : (manual ? "retraining…" : "training…"));
    $("ml-progress").classList.add("active");
    var t0 = Date.now();
    mlState.handle = QP.ml.run({
      model: modelKey,
      trainMonths: mlState.window,
      onProgress: function (p) {
        $("ml-progress-bar").style.width = (p * 100).toFixed(0) + "%";
        $("ml-status").textContent = (all ? "benchmarking " : "walk-forward ") + (p * 100).toFixed(0) + "% · " + modelKey;
      },
      onDone: function (res) {
        var elapsed = (Date.now() - t0) / 1000;
        var hold = Math.max(0, ML_MIN_BUSY_MS - (Date.now() - t0));
        setTimeout(function () {
          if (seq !== mlRunSeq) return;              // a newer run owns the UI now
          if (res && res.error) {
            mlSetBusy(false, res.error);
            toast(res.error, "err");
            return;
          }
          mlSetBusy(false, (manual ? "retrained" : "done") + " in " + elapsed.toFixed(1) + "s");
          mlState.result = res;
          // harvest scoreboard rows from whatever this run produced
          Object.keys(res.perModel).forEach(function (m) {
            if (!res.perModel[m] || !res.perModel[m].icData) return;
            mlState.compare[m + "|" + res.trainMonths] = {
              model: m, window: res.trainMonths,
              summary: res.perModel[m].icData.summary,
              quintiles: res.perModel[m].quintiles,
              ms: m === "composite" ? 0 : res.ms,
            };
          });
          renderMLResults();
          if (manual) {
            var mk = res.model === "all" ? "ensemble" : res.model;
            toast((QP.ml.MODEL_LABELS[mk] || mk) + " retrained in " + elapsed.toFixed(1) +
                  "s · seeded RNG — identical results by design", "ok");
            flashMLStats();
          }
        }, hold);
      },
    });
  }

  function renderMLResults() {
    var res = mlState.result;
    if (!res) return;
    var mk = mlDisplayKey(res);
    var label = QP.ml.MODEL_LABELS[mk] || mk;
    var pm = res.perModel[mk];
    if (!pm) return;
    var s = pm.icData.summary;
    var qs = pm.quintiles;
    var lsm = qs[0].meanMonthly != null && qs[4].meanMonthly != null ? qs[0].meanMonthly - qs[4].meanMonthly : null;

    var cards = [
      { l: "OOS rank IC", v: s.mean != null ? s.mean.toFixed(4) : "–", c: s.mean > 0 ? "up" : "down" },
      { l: "IC IR", v: s.ir != null ? s.ir.toFixed(2) : "–" },
      { l: "t-stat", v: s.tstat != null ? s.tstat.toFixed(2) : "–", c: s.tstat >= 1 ? "up" : "" },
      { l: "Hit rate", v: s.hit != null ? (s.hit * 100).toFixed(0) + "%" : "–", c: s.hit >= 0.5 ? "up" : "" },
      { l: "Q1−Q5 / mo", v: lsm != null ? fmt.pct(lsm, 2) : "–", c: lsm > 0 ? "up" : "down" },
      { l: "Test months", v: String(s.n), sub: res.trainMonths + "M window · " + res.testMonthIdx.length + " scored" },
      { l: "Runtime", v: (res.ms / 1000).toFixed(1) + "s", sub: "browser-side · seeded & reproducible" },
    ];
    var box = $("ml-stats");
    box.innerHTML = "";
    cards.forEach(function (cd) {
      box.appendChild(el("div", "stat",
        '<div class="stat-label">' + cd.l + '</div>' +
        '<div class="stat-value ' + (cd.c || "") + '">' + cd.v + "</div>" +
        (cd.sub ? '<div class="stat-sub">' + cd.sub + "</div>" : "")));
    });

    $("ml-ic-hint").textContent = label + " · " + res.trainMonths + "M training window";
    chartOf("ml-ic", CH.ICChart).setData({ labels: pm.icData.labels, ic: pm.icData.ic, cum: pm.icData.cum });

    var qItems = qs.slice(0, 5).map(function (qq) {
      return {
        label: "Q" + qq.q, value: qq.meanMonthly || 0,
        tipRows: [
          [qq.q === 1 ? "Top-prediction quintile" : qq.q === 5 ? "Bottom-prediction quintile" : "Quintile " + qq.q],
          ["Avg next-21d return", fmt.pct(qq.meanMonthly, 3)],
          ["Stock-months", String(qq.n)],
        ],
      };
    });
    qItems.push({
      label: "Q1−Q5", value: lsm || 0,
      tipRows: [["Long-short spread"], ["Avg monthly", fmt.pct(lsm, 3)]],
    });
    chartOf("ml-quintiles", CH.BarChartH, {}).setData({
      items: qItems,
      valueFmt: function (v) { return fmt.pct(v, 2); },
      colorize: function (v, idx) { return idx === 5 ? C.amber : (v >= 0 ? C.cyan : C.magenta); },
    });

    // feature importance
    var imp = res.importance && res.importance[mk];
    if (imp && imp.length) {
      var impItems = imp.map(function (it) {
        return {
          label: it.label, value: it.value,
          tipRows: [["Feature", it.label], ["Mean OOS IC drop", it.value.toFixed(4)]],
        };
      });
      chartOf("ml-importance", CH.BarChartH, { labelW: 112 }).setData({
        items: impItems,
        valueFmt: function (v) { return v.toFixed(3); },
        colorize: function (v, idx) { return idx === 0 ? C.amber : C.violet; },
      });
    }

    renderMLScoreboard();
    renderMLBacktest();
    renderMLPicks();
  }

  function renderMLScoreboard() {
    var tb = $("ml-compare-table").querySelector("tbody");
    tb.innerHTML = "";
    var rows = [];
    Object.keys(mlState.compare).forEach(function (k) {
      var r = mlState.compare[k];
      if (r.window === mlState.window) rows.push(r);
    });
    var ORDER = ["ridge", "enet", "mlp", "gbm", "ensemble", "composite"];
    rows.sort(function (a, b) { return ORDER.indexOf(a.model) - ORDER.indexOf(b.model); });
    if (!rows.length) {
      tb.innerHTML = '<tr><td colspan="7" class="bt-note">No models scored yet for this window — hit “Benchmark all”.</td></tr>';
      return;
    }
    rows.forEach(function (r) {
      var s = r.summary;
      var q0 = r.quintiles[0].meanMonthly, q4 = r.quintiles[4].meanMonthly;
      var ls = q0 != null && q4 != null ? q0 - q4 : null;
      var isML = r.model !== "composite";
      var tr = document.createElement("tr");
      if (r.model === mlDisplayKey(mlState.result || { model: "" })) tr.style.color = C.text;
      tr.innerHTML =
        "<td class='name-cell'>" + (QP.ml.MODEL_LABELS[r.model] || r.model) + "</td>" +
        '<td class="' + (s.mean >= 0 ? "pos" : "neg") + '">' + s.mean.toFixed(4) + "</td>" +
        "<td>" + (s.ir != null ? s.ir.toFixed(2) : "–") + "</td>" +
        "<td>" + (s.tstat != null ? s.tstat.toFixed(2) : "–") + "</td>" +
        "<td>" + (s.hit != null ? (s.hit * 100).toFixed(0) + "%" : "–") + "</td>" +
        '<td class="' + ((ls || 0) >= 0 ? "pos" : "neg") + '">' + (ls != null ? fmt.pct(ls, 2) : "–") + "</td>" +
        "<td>" + (isML ? (r.ms / 1000).toFixed(1) + "s" : "–") + "</td>";
      tb.appendChild(tr);
    });
  }

  function renderMLBacktest() {
    var res = mlState.result;
    if (!res) return;
    var mk = mlDisplayKey(res);
    var bt = core.runBacktest({
      signalFn: QP.ml.signalFnFor(res, mk),
      startIdx: res.firstTestIdx,
      topN: mlState.topN, rebalMonths: 1, costBps: mlState.cost, mode: mlState.mode,
    });
    if (!bt) return;
    mlBT = bt;
    var m = bt.metrics;
    var bm = core.perfMetrics(bt.benchDaily, bt.benchDaily);
    var label = QP.ml.MODEL_LABELS[mk] || mk;

    var cards = [
      { l: "CAGR", v: fmt.pctAbs(m.cagr, 1), c: m.cagr >= bm.cagr ? "up" : "down" },
      { l: "vs Universe", v: fmt.pct(m.cagr - bm.cagr, 1), c: m.cagr >= bm.cagr ? "up" : "down" },
      { l: "Sharpe", v: m.sharpe == null ? "–" : m.sharpe.toFixed(2), c: m.sharpe >= 1 ? "up" : "" },
      { l: "Max DD", v: fmt.pctAbs(m.maxdd, 1), c: "down" },
      { l: "Alpha (ann.)", v: m.alpha == null ? "–" : fmt.pct(m.alpha, 1), c: m.alpha >= 0 ? "up" : "down" },
      { l: "Beta", v: m.beta == null ? "–" : m.beta.toFixed(2) },
      { l: "Turnover (ann.)", v: bt.turnoverAnn.toFixed(1) + "×" },
    ];
    var box = $("ml-bt-metrics");
    box.innerHTML = "";
    cards.forEach(function (cd) {
      box.appendChild(el("div", "bt-metric",
        '<div class="bm-label">' + cd.l + '</div>' +
        '<div class="bm-value ' + (cd.c || "") + '">' + cd.v + "</div>"));
    });

    $("ml-bt-hint").textContent =
      label + " · " + (mlState.mode === "longshort" ? "long-short top/bottom " + mlState.topN : "long top " + mlState.topN) +
      " · monthly · " + mlState.cost + " bps · OOS only";

    chartOf("ml-equity", CH.LineChart, {
      log: true,
      yFmt: function (v) { return fmt.num(v, 0); },
      tipFmt: function (v) { return fmt.num(v, 1); },
    }).setData(bt.dates, [
      { name: label + " (OOS)", data: bt.equity, color: C.cyan, width: 2 },
      { name: "equal-weight universe", data: bt.benchmark, color: C.violet, width: 1.4, dash: [5, 4] },
    ]);

    $("ml-bt-note").textContent =
      "Every position is taken on a prediction made BEFORE the month began — walk-forward scores feed the same " +
      "position engine as the Backtest tab (" + bt.dates[0] + " → " + bt.dates[bt.dates.length - 1] +
      ", " + bt.nDays.toLocaleString() + " sessions, " + bt.elapsed.toFixed(0) + " ms).";
  }

  function renderMLPicks() {
    var res = mlState.result;
    if (!res) return;
    var mk = mlDisplayKey(res);
    var kLast = res.testKs[res.testKs.length - 1];
    var pred = res.predLookup[mk][kLast];
    var mo = QP.ml.dataset().months[kLast];
    var zs = QP.ml.zscoreArr(pred);
    var items = [];
    for (var t = 0; t < N; t++) {
      if (pred[t] == null) continue;
      items.push({ t: t, z: zs[t], p: pred[t] });
    }
    items.sort(function (a, b) { return b.z - a.z; });
    var top = items.slice(0, 10);
    var bot = mlState.mode === "longshort" ? items.slice(-10).reverse() : [];

    $("ml-picks-hint").textContent =
      QP.ml.MODEL_LABELS[mk] + " · scored " + mo.label + " · out-of-sample";

    var tb = $("ml-holdings").querySelector("tbody");
    tb.innerHTML = "";
    var rank = 0;
    top.concat(bot).forEach(function (it) {
      rank++;
      var tk = TICKERS[it.t];
      var u = BY_TICKER[tk];
      var dc = dayChangePct(tk);
      var side = mlState.mode === "longshort" ? (rank <= 10 ? "LONG" : "SHORT") : "LONG";
      var tr2 = document.createElement("tr");
      tr2.innerHTML =
        "<td>" + rank + "</td>" +
        '<td class="ticker-cell">' + tk + "</td>" +
        '<td class="name-cell bt-h-name">' + u.name + "</td>" +
        '<td class="name-cell bt-h-sector">' + u.sector.replace("Information Technology", "Info Tech").replace("Communication Services", "Comm Svcs").replace("Consumer Discretionary", "Cons Disc").replace("Consumer Staples", "Cons Staples") + "</td>" +
        '<td class="' + (it.z >= 0 ? "pos" : "neg") + '">' + (it.z != null ? it.z.toFixed(2) : "–") + "</td>" +
        '<td class="' + (it.p >= 0 ? "pos" : "neg") + '">' + (mk === "ensemble" ? "–" : fmt.pct(it.p, 2)) + "</td>" +
        '<td class="' + (dc >= 0 ? "up" : "down") + '">' + fmt.pct(dc, 2) + "</td>";
      tb.appendChild(tr2);
    });
  }

  function exportMLCSV() {
    if (!mlBT) return;
    var rows = [["date", "equity", "benchmark", "daily_return"]];
    for (var i = 0; i < mlBT.dates.length; i++) {
      rows.push([
        mlBT.dates[i],
        mlBT.equity[i].toFixed(4),
        mlBT.benchmark[i].toFixed(4),
        mlBT.rets[i] != null ? mlBT.rets[i].toFixed(6) : "",
      ]);
    }
    var csv = rows.map(function (r) { return r.join(","); }).join("\n");
    var blob = new Blob([csv], { type: "text/csv" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "quantpulse-ml-" + (mlState.result ? mlDisplayKey(mlState.result) : "model") + ".csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast("ML equity curve exported as CSV");
  }

  /* ========================= live data wiring =========================== */
  var lastRenderAt = 0;
  function onLiveQuotes(ev) {
    LV.quotes = ev.quotes;
    LV.updated = ev.fetchedAt;
    var mergeRes = core.mergeLiveQuotes(ev.quotes, {
      todayStr: live.etTodayStr(),
      afterClose: live.todayBarCompleted(),
    });
    var hadNew = mergeRes.appended.length > 0;
    LV.forming = mergeRes.forming;
    if (hadNew) {
      LV.lastBars += mergeRes.appended.length;
      // everything derived changed: force re-render of every module on next visit
      Object.keys(rendered).forEach(function (k) { rendered[k] = false; });
      // ML caches are stale too — dataset and trained models must be rebuilt
      if (QP.ml) {
        QP.ml.invalidate();
        mlState.result = null;
        mlState.compare = {};
      }
      toast("Live update: merged " + mergeRes.appended.join(", ") + " — analytics extended", "ok");
    }
    // throttle active-tab refresh to once per 1.5s
    var now = Date.now();
    if (now - lastRenderAt > 1500) {
      lastRenderAt = now;
      rerenderActive();
    } else if (hadNew) {
      setTimeout(function () {
        lastRenderAt = Date.now();
        rerenderActive();
      }, 1500 - (now - lastRenderAt));
    }
  }

  QP.live.on("quotes", onLiveQuotes);
  QP.live.on("status", function (mode) {
    LV.mode = mode;
    renderStatusBadge();
    if (mode === "snapshot") {
      var strip = $("hd-note");
      if (strip) strip.classList.remove("hidden");
    } else {
      var s2 = $("hd-note");
      if (s2) s2.classList.add("hidden");
    }
  });

  /* ============================ methodology ============================ */
  function wireMethodology() {
    $("ft-methodology").addEventListener("click", function (e) {
      e.preventDefault();
      $("modal-methodology").classList.add("open");
    });
    $("modal-close").addEventListener("click", function () {
      $("modal-methodology").classList.remove("open");
    });
    $("modal-methodology").addEventListener("click", function (e) {
      if (e.target === this) this.classList.remove("open");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") $("modal-methodology").classList.remove("open");
    });
  }

  /* =============================== boot ================================ */
  wireMethodology();
  renderHeader();
  renderClock();
  renderStatusBadge();
  setInterval(renderClock, 1000);
  activateTab("overview");

  // refresh controls
  $("hd-refresh").addEventListener("click", function () {
    live.refresh();
    toast("Refreshing live quotes…");
  });
  $("hd-interval").addEventListener("change", function () {
    live.setInterval(parseInt(this.value, 10));
    toast(this.value === "0" ? "Auto-refresh paused — use the refresh button" : "Auto-refresh: every " + this.value + "s", "ok");
  });

  live.start();
})();
