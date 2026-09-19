/* ==========================================================================
   QuantPulse — zero-dependency canvas chart engine
   --------------------------------------------------------------------------
   Hand-rolled, terminal-grade charting with HiDPI rendering:
     • CandleChart — candlesticks / line / area with wheel zoom, drag pan,
       pinch zoom, full crosshair, axis tags, OHLC legend readout,
       SMA/EMA/Bollinger overlays, volume / RSI / MACD sub-panels,
       log scale and a live price track with forming candle.
     • LineChart, BarChartH, ICChart, ScatterChart, Heatmap, Sparkline
   ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------- palette ------------------------------ */
  var C = {
    text: "#e8ecf8",
    dim: "#98a0c2",
    faint: "rgba(152,160,194,0.55)",
    grid: "rgba(255,255,255,0.05)",
    axis: "rgba(255,255,255,0.10)",
    up: "#22c38f",
    down: "#f4536b",
    cyan: "#25d3e0",
    violet: "#a78bfa",
    magenta: "#f472b6",
    amber: "#f5b942",
    blue: "#5fa8f5",
    live: "#25d3e0",
  };
  var SERIES8 = [C.cyan, C.violet, C.magenta, C.amber, C.up, C.blue, "#f97316", "#4ade80"];

  var FONT_MONO = "'SF Mono','Cascadia Code',Consolas,'Liberation Mono',monospace";
  var FONT_UI = "Inter,-apple-system,'Segoe UI',Roboto,sans-serif";

  /* ----------------------------- format ------------------------------- */
  var fmt = {
    num: function (v, d) {
      if (v == null || !isFinite(v)) return "–";
      return v.toLocaleString("en-US", {
        minimumFractionDigits: d == null ? 2 : d,
        maximumFractionDigits: d == null ? 2 : d,
      });
    },
    pct: function (v, d) {
      if (v == null || !isFinite(v)) return "–";
      return (v >= 0 ? "+" : "") + (v * 100).toFixed(d == null ? 1 : d) + "%";
    },
    pctAbs: function (v, d) {
      if (v == null || !isFinite(v)) return "–";
      return (v * 100).toFixed(d == null ? 1 : d) + "%";
    },
    compact: function (v) {
      if (v == null || !isFinite(v)) return "–";
      var a = Math.abs(v);
      if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
      if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
      if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return v.toFixed(0);
    },
  };

  /* ----------------------------- helpers ------------------------------ */
  function niceTicks(min, max, target) {
    if (!isFinite(min) || !isFinite(max) || min === max) return [min, max];
    var span = max - min;
    var step0 = span / Math.max(2, target);
    var mag = Math.pow(10, Math.floor(Math.log(step0) / Math.LN10));
    var norm = step0 / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var ticks = [];
    var start = Math.ceil(min / step) * step;
    for (var v = start; v <= max + step * 1e-9; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return ticks;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function htmlEscape(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  /* ----------------------------- tooltip ------------------------------ */
  var tipEl = null;
  function tooltip(html, x, y) {
    if (!tipEl) tipEl = document.getElementById("tooltip");
    if (!tipEl) return;
    tipEl.innerHTML = html;
    tipEl.classList.remove("hidden");
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var px = clamp(x + 16, 6, window.innerWidth - w - 8);
    var py = clamp(y - h - 12, 6, window.innerHeight - h - 6);
    if (py < 6) py = y + 18;
    tipEl.style.left = px + "px";
    tipEl.style.top = py + "px";
  }
  function hideTooltip() { if (tipEl) tipEl.classList.add("hidden"); }
  function ttRow(k, v, cls) {
    return '<div class="tt-row"><span class="k">' + htmlEscape(k) +
      '</span><span class="v ' + (cls || "") + '">' + v + "</span></div>";
  }
  function ttTitle(t) { return '<div class="tt-title">' + htmlEscape(t) + "</div>"; }

  /* ============================ indicators ============================ */
  function sma(arr, win) {
    var out = new Array(arr.length).fill(null);
    var sum = 0, cnt = 0;
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v != null) { sum += v; cnt++; }
      if (i >= win) {
        var old = arr[i - win];
        if (old != null) { sum -= old; cnt--; }
      }
      if (i >= win - 1 && cnt >= win * 0.99) out[i] = sum / win;
    }
    return out;
  }
  function ema(arr, win) {
    var out = new Array(arr.length).fill(null);
    var k = 2 / (win + 1), prev = null, seed = 0, seen = 0;
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null) continue;
      if (prev == null) {
        seed += v; seen++;
        if (seen === win) { prev = seed / win; out[i] = prev; }
      } else {
        prev = prev + k * (v - prev);
        out[i] = prev;
      }
    }
    return out;
  }
  function stdevWin(arr, win) {
    var out = new Array(arr.length).fill(null);
    for (var i = win - 1; i < arr.length; i++) {
      var ok = true, m = 0;
      for (var j = i - win + 1; j <= i; j++) { if (arr[j] == null) { ok = false; break; } m += arr[j]; }
      if (!ok) continue;
      m /= win;
      var s = 0;
      for (j = i - win + 1; j <= i; j++) s += (arr[j] - m) * (arr[j] - m);
      out[i] = Math.sqrt(s / win);
    }
    return out;
  }
  function bollinger(arr, win, mult) {
    var mid = sma(arr, win), sd = stdevWin(arr, win);
    var up = new Array(arr.length).fill(null), lo = new Array(arr.length).fill(null);
    for (var i = 0; i < arr.length; i++) {
      if (mid[i] == null || sd[i] == null) continue;
      up[i] = mid[i] + mult * sd[i];
      lo[i] = mid[i] - mult * sd[i];
    }
    return { mid: mid, up: up, lo: lo };
  }
  function rsiWilder(arr, win) {
    var out = new Array(arr.length).fill(null);
    var aG = null, aL = null, cnt = 0, g = 0, l = 0;
    for (var i = 1; i < arr.length; i++) {
      if (arr[i - 1] == null || arr[i] == null) continue;
      var ch = arr[i] - arr[i - 1];
      if (aG == null) {
        cnt++;
        if (ch > 0) g += ch; else l -= ch;
        if (cnt === win) { aG = g / win; aL = l / win; out[i] = aL === 0 ? 100 : 100 - 100 / (1 + aG / aL); }
      } else {
        aG = (aG * (win - 1) + Math.max(ch, 0)) / win;
        aL = (aL * (win - 1) + Math.max(-ch, 0)) / win;
        out[i] = aL === 0 ? 100 : 100 - 100 / (1 + aG / aL);
      }
    }
    return out;
  }
  function macdCalc(arr, fast, slow, sig) {
    var ef = ema(arr, fast), es = ema(arr, slow);
    var line = new Array(arr.length).fill(null);
    for (var i = 0; i < arr.length; i++) {
      if (ef[i] != null && es[i] != null) line[i] = ef[i] - es[i];
    }
    var valid = line.filter(function (v) { return v != null; });
    var sigOnValid = ema(valid, sig);
    var signal = new Array(arr.length).fill(null);
    var hist = new Array(arr.length).fill(null);
    var vi = 0;
    for (i = 0; i < arr.length; i++) {
      if (line[i] == null) continue;
      signal[i] = sigOnValid[vi];
      if (signal[i] != null) hist[i] = line[i] - signal[i];
      vi++;
    }
    return { line: line, signal: signal, hist: hist };
  }

  /* ============================ BaseChart ============================= */
  var BaseChart = {
    /* default padding — subclasses override via their prototype `pad` */
    pad: { l: 52, r: 60, t: 14, b: 26 },

    init: function (el) {
      this.el = el;
      this.canvas = document.createElement("canvas");
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      el.innerHTML = "";
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this._drawn = false;
      var self = this;
      if (typeof ResizeObserver !== "undefined") {
        this._ro = new ResizeObserver(function () { if (self._drawn) self.draw(); });
        this._ro.observe(el);
      }
    },
    begin: function () {
      var dpr = window.devicePixelRatio || 1;
      var w = this.el.clientWidth || 300;
      var h = this.el.clientHeight || 200;
      if (w < 10 || h < 10) return null;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      var ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      this.w = w; this.h = h;
      this._drawn = true;
      return ctx;
    },
    frame: function () {
      var p = this.pad;
      return { x: p.l, y: p.t, w: this.w - p.l - p.r, h: this.h - p.t - p.b };
    },
    gridAndAxes: function (ctx, f, ticks, mapY, fmtFn) {
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.fillStyle = C.dim;
      ctx.font = "10px " + FONT_MONO;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (var i = 0; i < ticks.length; i++) {
        var y = mapY(ticks[i]);
        if (y < f.y - 1 || y > f.y + f.h + 1) continue;
        ctx.beginPath();
        ctx.moveTo(f.x, Math.round(y) + 0.5);
        ctx.lineTo(f.x + f.w, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillText(fmtFn(ticks[i]), f.x - 6, y);
      }
      ctx.strokeStyle = C.axis;
      ctx.beginPath();
      ctx.moveTo(f.x + 0.5, f.y + 0.5);
      ctx.lineTo(f.x + f.w + 0.5, f.y + 0.5);
      ctx.lineTo(f.x + f.w + 0.5, f.y + f.h + 0.5);
      ctx.stroke();
    },
    // right-side price tag (used for last price / crosshair / live price)
    axisTag: function (ctx, f, y, text, bg, fg) {
      var w = this.pad.r - 6;
      var x = f.x + f.w + 2;
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y - 9, w, 18, 3) : ctx.rect(x, y - 9, w, 18);
      ctx.fill();
      ctx.fillStyle = fg || "#06121a";
      ctx.font = "bold 10px " + FONT_MONO;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x + w / 2, y);
    },
    // bottom date tag for the crosshair
    dateTag: function (ctx, f, x, text) {
      ctx.font = "10px " + FONT_MONO;
      var tw = ctx.measureText(text).width + 12;
      var tx = clamp(x - tw / 2, f.x, f.x + f.w - tw);
      var y = f.y + f.h + 3;
      ctx.fillStyle = "rgba(20,24,44,0.92)";
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(tx, y, tw, 16, 3) : ctx.rect(tx, y, tw, 16);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = C.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, tx + tw / 2, y + 8);
    },
    legend: function (ctx, f, entries) {
      ctx.font = "10.5px " + FONT_UI;
      ctx.textBaseline = "middle";
      var x = f.x + 4;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (i > 0) x += 14;
        ctx.fillStyle = e.color;
        ctx.fillRect(x, f.y - 2, 12, 3);
        ctx.fillStyle = C.dim;
        ctx.textAlign = "left";
        ctx.fillText(e.label, x + 16, f.y);
        x += 16 + ctx.measureText(e.label).width + 6;
      }
    },
    destroy: function () { if (this._ro) this._ro.disconnect(); },
  };

  /* ============================ CandleChart =========================== */
  /* data:   { dates, ohlcv(flat [o,h,l,c,v]*n, v in thousands), ticker,
               name, forming (index of live forming bar or -1),
               live: {price, prevClose} | null, intraday: bool }
     opts:   { type:"candle"|"line"|"area", log, overlays:{ma20,ma50,ma200,
               ema50,bb}, panels:{vol,rsi,macd} }                        */
  function CandleChart(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.view = null;         // {i0, i1}
    this._hover = null;       // {idx, x, y, panelIdx}
    this._drag = null;
    this._pinch = null;
    this._raf = 0;
    var self = this;
    this.canvas.addEventListener("mousemove", function (e) {
      var r = self.canvas.getBoundingClientRect();
      self._mx = e.clientX - r.left;
      self._my = e.clientY - r.top;
      self._client = { x: e.clientX, y: e.clientY };
      if (self._drag) {
        self.panByPixels(e.clientX - self._drag.x, self._drag.i0, self._drag.i1);
        return;
      }
      if (self._drawn) self.requestDraw(true);
    });
    this.canvas.addEventListener("mouseleave", function () {
      self._hover = null;
      hideTooltip();
      if (self._legendEl && !self._drag) self._legendEl.innerHTML = "";
      if (self._drawn && !self._drag) self.requestDraw();
    });
    this.canvas.addEventListener("mousedown", function (e) {
      if (!self.view) return;
      self._drag = { x: e.clientX, i0: self.view.i0, i1: self.view.i1 };
      self.canvas.style.cursor = "grabbing";
    });
    window.addEventListener("mouseup", function () {
      self._drag = null;
      self.canvas.style.cursor = "crosshair";
    });
    this.canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      if (!self.data) return;
      var dir = e.deltaY > 0 ? 1 : -1;   // wheel down = zoom out
      self.zoom(dir, e.clientX - self.canvas.getBoundingClientRect().left);
    }, { passive: false });
    this.canvas.addEventListener("dblclick", function () { self.resetView(); });
    // touch: 1-finger pan, 2-finger pinch
    this.canvas.addEventListener("touchstart", function (e) {
      if (!self.data) return;
      if (e.touches.length === 1) {
        self._pinch = { mode: "pan", x: e.touches[0].clientX, i0: self.view.i0, i1: self.view.i1 };
      } else if (e.touches.length >= 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX;
        self._pinch = { mode: "pinch", d: Math.abs(dx), i0: self.view.i0, i1: self.view.i1 };
      }
    }, { passive: true });
    this.canvas.addEventListener("touchmove", function (e) {
      if (!self._pinch || !self.data) return;
      if (self._pinch.mode === "pan" && e.touches.length === 1) {
        e.preventDefault();
        var dxPix = e.touches[0].clientX - self._pinch.x;
        self.panByPixels(dxPix, self._pinch.i0, self._pinch.i1);
      } else if (self._pinch.mode === "pinch" && e.touches.length >= 2) {
        e.preventDefault();
        var d2 = Math.abs(e.touches[0].clientX - e.touches[1].clientX);
        if (d2 > 4 && self._pinch.d > 4) {
          var factor = d2 / self._pinch.d;
          var span = self._pinch.i1 - self._pinch.i0;
          var newSpan = clamp(Math.round(span / factor), 15, self.data.dates.length);
          self.setView(self._pinch.i0, self._pinch.i0 + newSpan);
        }
      }
    }, { passive: false });
    this.canvas.addEventListener("touchend", function () { self._pinch = null; });
  }
  CandleChart.prototype = Object.create(BaseChart);
  CandleChart.prototype.pad = { l: 8, r: 62, t: 26, b: 26 };

  CandleChart.prototype.setData = function (data) {
    var hadView = !!(this.view && this.data);
    var atRight = !hadView || this.atRightEdge();
    var span = hadView ? this.view.i1 - this.view.i0 : null;
    this.data = data;
    this._ind = null;
    var n = data.dates.length;
    if (!hadView || span == null) {
      this.resetView();
    } else if (atRight) {
      this.view = { i0: Math.max(0, n - 1 - span), i1: n - 1 };
      this.requestDraw();
    } else {
      this.view = { i0: clamp(this.view.i0, 0, Math.max(0, n - 2)), i1: clamp(this.view.i1, 1, n - 1) };
      this.requestDraw();
    }
  };
  CandleChart.prototype.showRange = function (bars) {
    if (!this.data) return;
    var n = this.data.dates.length;
    var span = Math.min(bars, n);
    this.setView(n - span, n - 1);
  };
  CandleChart.prototype.setOptions = function (opts) {
    this.opts = Object.assign({}, this.opts, opts);
    this._ind = null;
    this.requestDraw();
  };
  CandleChart.prototype.resetView = function () {
    if (!this.data) return;
    var n = this.data.dates.length;
    var init = Math.min(n, Math.max(60, Math.round(n * 0.35)));
    this.view = { i0: Math.max(0, n - init), i1: n - 1 };
    this.requestDraw();
  };
  CandleChart.prototype.atRightEdge = function () {
    return !this.view || !this.data || this.view.i1 >= this.data.dates.length - 2;
  };
  CandleChart.prototype.setView = function (i0, i1) {
    var n = this.data.dates.length;
    var span = clamp(i1 - i0, 10, n);
    i0 = clamp(Math.round(i0), 0, n - span);
    this.view = { i0: i0, i1: Math.min(n - 1, i0 + span) };
    this.requestDraw();
  };
  CandleChart.prototype.zoom = function (dir, cursorX) {
    if (!this.data || !this.view) return;
    var f = this.frame();
    var n = this.data.dates.length;
    var v = this.view;
    var span = v.i1 - v.i0;
    var rel = clamp((cursorX - f.x) / Math.max(1, f.w), 0, 1);
    var focus = v.i0 + span * rel;
    var factor = dir > 0 ? 1.25 : 0.8;
    var newSpan = clamp(Math.round(span * factor), 15, n);
    var i0 = Math.round(focus - (focus - v.i0) * (newSpan / span));
    this.setView(i0, i0 + newSpan);
  };
  CandleChart.prototype.panByPixels = function (dxPix, baseI0, baseI1) {
    if (!this.data) return;
    var f = this.frame();
    var span = baseI1 - baseI0;
    if (span <= 0) return;
    var perPx = span / Math.max(1, f.w);
    var dIdx = Math.round(dxPix * perPx);
    this.setView(baseI0 - dIdx, baseI1 - dIdx);
  };
  CandleChart.prototype.requestDraw = function (hover) {
    var self = this;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(function () { self._raf = 0; self.draw(hover); });
  };

  CandleChart.prototype._computeIndicators = function () {
    if (this._ind) return this._ind;
    var d = this.data;
    var n = d.dates.length;
    var closes = new Array(n);
    for (var i = 0; i < n; i++) closes[i] = d.ohlcv[i * 5 + 3];
    var ind = { sma20: null, sma50: null, sma200: null, ema50: null, bbUp: null, bbLo: null, bbMid: null, rsi: null, macd: null, volMa: null };
    var o = this.opts.overlays || {};
    if (o.ma20) ind.sma20 = sma(closes, 20);
    if (o.ma50) ind.sma50 = sma(closes, 50);
    if (o.ma200) ind.sma200 = sma(closes, 200);
    if (o.ema50) ind.ema50 = ema(closes, 50);
    if (o.bb) {
      var bb = bollinger(closes, 20, 2);
      ind.bbUp = bb.up; ind.bbLo = bb.lo; ind.bbMid = bb.mid;
    }
    var p = this.opts.panels || {};
    if (p.rsi) ind.rsi = rsiWilder(closes, 14);
    if (p.macd) ind.macd = macdCalc(closes, 12, 26, 9);
    var vols = new Array(n);
    for (i = 0; i < n; i++) vols[i] = d.ohlcv[i * 5 + 4];
    ind.volMa = sma(vols, 20);
    this._ind = ind;
    return ind;
  };

  CandleChart.prototype._panelLayout = function () {
    var f = this.frame();
    var p = this.opts.panels || {};
    var panels = [{ id: "price", h: 0 }, { id: "vol", h: Math.round(f.h * 0.16) }];
    if (p.rsi) panels.push({ id: "rsi", h: Math.round(f.h * 0.13) });
    if (p.macd) panels.push({ id: "macd", h: Math.round(f.h * 0.15) });
    var totalExtra = 0;
    panels.slice(1).forEach(function (x) { totalExtra += x.h + 8; });
    panels[0].h = Math.max(80, f.h - totalExtra);
    var y = f.y;
    panels.forEach(function (pn) {
      pn.y = y; pn.x = f.x; pn.w = f.w;
      y += pn.h + 8;
    });
    return panels;
  };

  CandleChart.prototype._xOf = function (i, view, f) {
    var span = Math.max(1, view.i1 - view.i0);
    return f.x + ((i - view.i0) / span) * f.w;
  };

  CandleChart.prototype._dateLabel = function (iso) {
    if (!iso) return "";
    if (this.data.intraday) {
      // intraday labels: "2026-09-19 14:30" -> "14:30" (date shown in tag)
      var t = iso.length > 16 ? iso.slice(12, 17) : "";
      return t || (iso.length > 10 ? iso.slice(11, 16) : "") || iso.slice(5);
    }
    return iso.length > 7 ? iso.slice(0, 7) : iso;
  };

  CandleChart.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.data) return;
    var d = this.data;
    var n = d.dates.length;
    if (!n) return;
    if (!this.view) this.resetView();
    var view = this.view;
    if (view.i1 >= n) view.i1 = n - 1;
    var ind = this._computeIndicators();
    var f = this.frame();
    var self = this;

    var panels = this._panelLayout();
    var price = panels[0], vol = panels[1];
    var i0 = view.i0, i1 = view.i1;

    /* ---- visible slices ---- */
    var o = [], h = [], l = [], c = [], v = [];
    for (var i = i0; i <= i1; i++) {
      var b = i * 5;
      o.push(d.ohlcv[b]); h.push(d.ohlcv[b + 1]); l.push(d.ohlcv[b + 2]);
      c.push(d.ohlcv[b + 3]); v.push(d.ohlcv[b + 4]);
    }
    var live = d.live || null;

    /* ---- price scale ---- */
    var lo = Infinity, hi = -Infinity;
    for (i = 0; i < c.length; i++) {
      if (l[i] != null) lo = Math.min(lo, l[i]);
      if (h[i] != null) hi = Math.max(hi, h[i]);
    }
    var ovLists = [ind.sma20, ind.sma50, ind.sma200, ind.ema50, ind.bbUp, ind.bbLo];
    ovLists.forEach(function (arr) {
      if (!arr) return;
      for (var k = i0; k <= i1; k++) {
        if (arr[k] != null) { lo = Math.min(lo, arr[k]); hi = Math.max(hi, arr[k]); }
      }
    });
    if (live && live.price != null) { lo = Math.min(lo, live.price); hi = Math.max(hi, live.price); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    var isLog = !!this.opts.log;
    if (isLog) lo = Math.max(lo, 0.01);
    var padP = (hi - lo) * 0.06;
    lo -= padP; hi += padP;
    if (isLog) lo = Math.max(lo, 0.01);

    function mapPrice(val) {
      if (isLog) {
        var lv = Math.log(Math.max(val, 0.01)), ll = Math.log(Math.max(lo, 0.01)), lh = Math.log(hi);
        return price.y + price.h - ((lv - ll) / (lh - ll)) * price.h;
      }
      return price.y + price.h - ((val - lo) / (hi - lo)) * price.h;
    }
    function invPrice(y) {
      var t = (price.y + price.h - y) / price.h;
      if (isLog) {
        var ll = Math.log(Math.max(lo, 0.01)), lh = Math.log(hi);
        return Math.exp(ll + t * (lh - ll));
      }
      return lo + t * (hi - lo);
    }
    var span = Math.max(1, i1 - i0);
    var xOf = function (i2) { return f.x + ((i2 - i0) / span) * f.w; };

    /* ---- grid + y axis (price) ---- */
    var priceDecimals = hi > 500 ? 0 : hi > 50 ? 1 : 2;
    var ticks = isLog ? this._logTicks(lo, hi) : niceTicks(lo, hi, 6);
    this.gridAndAxes(ctx, price, ticks, mapPrice, function (t) { return fmt.num(t, priceDecimals); });

    /* ---- volume panel scale ---- */
    var vmax = 0;
    for (i = 0; i < v.length; i++) if (v[i] != null) vmax = Math.max(vmax, v[i]);
    if (ind.volMa) for (i = i0; i <= i1; i++) if (ind.volMa[i] != null) vmax = Math.max(vmax, ind.volMa[i]);
    var mapVol = function (val) { return vol.y + vol.h - (val / (vmax || 1)) * vol.h * 0.92; };

    /* ---- x axis labels ---- */
    this._drawXAxis(ctx, f, i0, i1, xOf);

    /* ---- prev close reference (live session) ---- */
    if (live && live.prevClose != null && live.prevClose >= lo && live.prevClose <= hi) {
      var py = mapPrice(live.prevClose);
      ctx.strokeStyle = "rgba(152,160,194,0.4)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(f.x, py + 0.5); ctx.lineTo(f.x + f.w, py + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    }

    /* ---- Bollinger band fill ---- */
    if (ind.bbUp && ind.bbLo) {
      ctx.beginPath();
      var started = false;
      for (i = i0; i <= i1; i++) {
        if (ind.bbUp[i] == null) { continue; }
        var bx = xOf(i), by = mapPrice(ind.bbUp[i]);
        if (!started) { ctx.moveTo(bx, by); started = true; } else ctx.lineTo(bx, by);
      }
      for (i = i1; i >= i0; i--) {
        if (ind.bbLo[i] == null) continue;
        ctx.lineTo(xOf(i), mapPrice(ind.bbLo[i]));
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(167,139,250,0.07)";
      ctx.fill();
    }

    /* ---- price series ---- */
    var type = this.opts.type || "candle";
    if (type === "candle") {
      var cw = Math.max(1, Math.min(13, (f.w / (i1 - i0 + 1)) * 0.68));
      var bwHalf = Math.max(0.5, cw / 2);
      for (i = i0; i <= i1; i++) {
        var bi = i * 5;
        if (c[i - i0] == null) continue;
        var x = xOf(i);
        var up = c[i - i0] >= o[i - i0];
        var col = up ? C.up : C.down;
        var isForming = d.forming === i;
        ctx.globalAlpha = isForming ? 0.75 : 1;
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.min(1.4, Math.max(0.8, cw * 0.14));
        ctx.beginPath();
        ctx.moveTo(x, mapPrice(h[i - i0]));
        ctx.lineTo(x, mapPrice(l[i - i0]));
        ctx.stroke();
        var yTop = mapPrice(Math.max(o[i - i0], c[i - i0]));
        var yBot = mapPrice(Math.min(o[i - i0], c[i - i0]));
        var bh = Math.max(1, yBot - yTop);
        ctx.fillStyle = col;
        if (up) { ctx.globalAlpha = isForming ? 0.55 : 0.9; }
        ctx.fillRect(x - bwHalf, yTop, cw, bh);
        ctx.globalAlpha = 1;
        if (isForming) {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.strokeRect(x - bwHalf - 0.5, yTop - 0.5, cw + 1, bh + 1);
        }
      }
    } else {
      // line / area
      var drawLine = function (color, width, fill) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        var st = false;
        for (var i2 = i0; i2 <= i1; i2++) {
          if (c[i2 - i0] == null) { st = false; continue; }
          var px = xOf(i2), py2 = mapPrice(c[i2 - i0]);
          if (!st) { ctx.moveTo(px, py2); st = true; } else ctx.lineTo(px, py2);
        }
        ctx.stroke();
        if (fill) {
          ctx.lineTo(xOf(i1), price.y + price.h);
          ctx.lineTo(xOf(i0), price.y + price.h);
          ctx.closePath();
          var g = ctx.createLinearGradient(0, price.y, 0, price.y + price.h);
          g.addColorStop(0, fill);
          g.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = g;
          ctx.fill();
        }
      };
      drawLine(C.cyan, 1.8, type === "area" ? "rgba(37,211,224,0.16)" : null);
    }

    /* ---- overlays ---- */
    function drawSeries(arr, color, width, dash) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      var st = false;
      for (var i2 = i0; i2 <= i1; i2++) {
        if (arr[i2] == null) { st = false; continue; }
        var px = xOf(i2), py2 = mapPrice(arr[i2]);
        if (!st) { ctx.moveTo(px, py2); st = true; } else ctx.lineTo(px, py2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ind.bbUp) drawSeries(ind.bbUp, "rgba(167,139,250,0.75)", 1);
    if (ind.bbLo) drawSeries(ind.bbLo, "rgba(167,139,250,0.75)", 1);
    if (ind.bbMid) drawSeries(ind.bbMid, "rgba(167,139,250,0.35)", 1, [4, 4]);
    if (ind.sma20) drawSeries(ind.sma20, C.amber, 1.4);
    if (ind.sma50) drawSeries(ind.sma50, C.violet, 1.4);
    if (ind.sma200) drawSeries(ind.sma200, C.blue, 1.4);
    if (ind.ema50) drawSeries(ind.ema50, "#f97316", 1.4, [6, 3]);

    /* ---- last / live price line + tag ---- */
    var lastIdx = i1;
    var lastClose = c[c.length - 1];
    var lastUp = lastClose >= o[o.length - 1];
    if (d.forming === i1 && live && live.price != null) {
      lastClose = live.price;
      lastUp = live.prevClose != null ? live.price >= live.prevClose : lastUp;
    }
    if (lastClose != null) {
      var ly = mapPrice(lastClose);
      ctx.strokeStyle = lastUp ? "rgba(34,195,143,0.55)" : "rgba(244,83,107,0.55)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(f.x, ly + 0.5); ctx.lineTo(f.x + f.w, ly + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      this.axisTag(ctx, f, clamp(ly, price.y + 9, price.y + price.h - 9),
        fmt.num(lastClose, priceDecimals), lastUp ? C.up : C.down);
      // pulsing live dot
      if (live && live.price != null && d.forming === i1) {
        var dotX = xOf(i1);
        var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 450);
        ctx.beginPath();
        ctx.arc(dotX, ly, 4 + pulse * 5, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(37,211,224," + (0.22 * (1 - pulse)).toFixed(2) + ")";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(dotX, ly, 3, 0, Math.PI * 2);
        ctx.fillStyle = lastUp ? C.up : C.down;
        ctx.fill();
        this._livePulse = true;
      } else this._livePulse = false;
    }

    /* ---- volume panel ---- */
    ctx.fillStyle = C.dim;
    ctx.font = "9.5px " + FONT_MONO;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("VOLUME " + (vmax ? fmt.compact(vmax * 1000) : "–"), vol.x + 4, vol.y + 2);
    var vw = Math.max(1, Math.min(13, (f.w / (i1 - i0 + 1)) * 0.6));
    for (i = i0; i <= i1; i++) {
      if (v[i - i0] == null) continue;
      var vx = xOf(i);
      var vUp = c[i - i0] >= o[i - i0];
      var isForming2 = d.forming === i;
      ctx.globalAlpha = isForming2 ? 0.4 : (vUp ? 0.5 : 0.55);
      ctx.fillStyle = vUp ? C.up : C.down;
      var vy = mapVol(v[i - i0]);
      ctx.fillRect(vx - vw / 2, vy, vw, vol.y + vol.h - vy);
    }
    ctx.globalAlpha = 1;
    if (ind.volMa) {
      ctx.strokeStyle = "rgba(245,185,66,0.8)";
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      var st2 = false;
      for (i = i0; i <= i1; i++) {
        if (ind.volMa[i] == null) { st2 = false; continue; }
        var px3 = xOf(i), py3 = mapVol(ind.volMa[i]);
        if (!st2) { ctx.moveTo(px3, py3); st2 = true; } else ctx.lineTo(px3, py3);
      }
      ctx.stroke();
    }

    /* ---- RSI panel ---- */
    var rsiPanel = panels.find(function (p2) { return p2.id === "rsi"; });
    if (rsiPanel && ind.rsi) {
      var mapR = function (val) { return rsiPanel.y + rsiPanel.h - (val / 100) * rsiPanel.h; };
      [30, 50, 70].forEach(function (lvl) {
        var y = mapR(lvl);
        ctx.strokeStyle = lvl === 50 ? "rgba(255,255,255,0.07)" : "rgba(255,255,255,0.12)";
        ctx.setLineDash(lvl === 50 ? [] : [3, 4]);
        ctx.beginPath();
        ctx.moveTo(rsiPanel.x, y + 0.5); ctx.lineTo(rsiPanel.x + rsiPanel.w, y + 0.5); ctx.stroke();
        ctx.setLineDash([]);
      });
      ctx.fillStyle = C.dim;
      ctx.font = "9.5px " + FONT_MONO;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("RSI 14", rsiPanel.x + 4, rsiPanel.y + 2);
      ctx.textAlign = "right";
      ctx.fillText("70", rsiPanel.x - 6, mapR(70) - 5);
      ctx.fillText("30", rsiPanel.x - 6, mapR(30) - 5);
      ctx.strokeStyle = C.violet;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      var st3 = false;
      for (i = i0; i <= i1; i++) {
        if (ind.rsi[i] == null) { st3 = false; continue; }
        var px4 = xOf(i), py4 = mapR(ind.rsi[i]);
        if (!st3) { ctx.moveTo(px4, py4); st3 = true; } else ctx.lineTo(px4, py4);
      }
      ctx.stroke();
    }

    /* ---- MACD panel ---- */
    var macdPanel = panels.find(function (p2) { return p2.id === "macd"; });
    if (macdPanel && ind.macd) {
      var mLo = 0, mHi = 0;
      for (i = i0; i <= i1; i++) {
        if (ind.macd.line[i] != null) { mLo = Math.min(mLo, ind.macd.line[i]); mHi = Math.max(mHi, ind.macd.line[i]); }
        if (ind.macd.hist[i] != null) { mLo = Math.min(mLo, ind.macd.hist[i]); mHi = Math.max(mHi, ind.macd.hist[i]); }
        if (ind.macd.signal[i] != null) { mLo = Math.min(mLo, ind.macd.signal[i]); mHi = Math.max(mHi, ind.macd.signal[i]); }
      }
      var mPad = (mHi - mLo) * 0.1 || 0.1; mLo -= mPad; mHi += mPad;
      var mapM = function (val) { return macdPanel.y + macdPanel.h - ((val - mLo) / (mHi - mLo)) * macdPanel.h; };
      ctx.fillStyle = C.dim;
      ctx.font = "9.5px " + FONT_MONO;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("MACD 12·26·9", macdPanel.x + 4, macdPanel.y + 2);
      var zy = mapM(0);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath(); ctx.moveTo(macdPanel.x, zy + 0.5); ctx.lineTo(macdPanel.x + macdPanel.w, zy + 0.5); ctx.stroke();
      var hw = Math.max(1, vw * 0.7);
      for (i = i0; i <= i1; i++) {
        if (ind.macd.hist[i] == null) continue;
        var hx = xOf(i);
        var hy = mapM(ind.macd.hist[i]);
        ctx.fillStyle = ind.macd.hist[i] >= 0 ? "rgba(34,195,143,0.55)" : "rgba(244,83,107,0.55)";
        ctx.fillRect(hx - hw / 2, Math.min(zy, hy), hw, Math.max(1, Math.abs(hy - zy)));
      }
      ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.2;
      ctx.beginPath();
      var st4 = false;
      for (i = i0; i <= i1; i++) {
        if (ind.macd.line[i] == null) { st4 = false; continue; }
        var px5 = xOf(i), py5 = mapM(ind.macd.line[i]);
        if (!st4) { ctx.moveTo(px5, py5); st4 = true; } else ctx.lineTo(px5, py5);
      }
      ctx.stroke();
      ctx.strokeStyle = C.amber;
      ctx.beginPath();
      st4 = false;
      for (i = i0; i <= i1; i++) {
        if (ind.macd.signal[i] == null) { st4 = false; continue; }
        var px6 = xOf(i), py6 = mapM(ind.macd.signal[i]);
        if (!st4) { ctx.moveTo(px6, py6); st4 = true; } else ctx.lineTo(px6, py6);
      }
      ctx.stroke();
    }

    /* ---- crosshair ---- */
    if (hoverOnly && this._mx != null && this._mx >= f.x && this._mx <= f.x + f.w) {
      var hIdx = Math.round(i0 + ((this._mx - f.x) / f.w) * span);
      hIdx = clamp(hIdx, i0, i1);
      var hx = xOf(hIdx);
      ctx.strokeStyle = "rgba(255,255,255,0.30)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(hx + 0.5, f.y);
      ctx.lineTo(hx + 0.5, f.y + f.h);
      ctx.stroke();
      // horizontal line inside the hovered panel
      var hoverPanel = panels.find(function (p2) { return self._my >= p2.y && self._my <= p2.y + p2.h; }) || price;
      var hy2 = clamp(this._my, hoverPanel.y, hoverPanel.y + hoverPanel.h);
      ctx.beginPath();
      ctx.moveTo(f.x, hy2 + 0.5);
      ctx.lineTo(f.x + f.w, hy2 + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      // tags
      var tagVal = null;
      if (hoverPanel.id === "price") tagVal = invPrice(hy2);
      else if (hoverPanel.id === "vol") tagVal = ((vol.y + vol.h - hy2) / (vol.h * 0.92)) * (vmax || 0);
      else if (hoverPanel.id === "rsi" && ind.rsi) tagVal = ((rsiPanel.y + rsiPanel.h - hy2) / rsiPanel.h) * 100;
      else if (hoverPanel.id === "macd" && ind.macd) {
        var mLo2 = 0, mHi2 = 0;
        for (var k = i0; k <= i1; k++) {
          if (ind.macd.line[k] != null) { mLo2 = Math.min(mLo2, ind.macd.line[k]); mHi2 = Math.max(mHi2, ind.macd.line[k]); }
          if (ind.macd.hist[k] != null) { mLo2 = Math.min(mLo2, ind.macd.hist[k]); mHi2 = Math.max(mHi2, ind.macd.hist[k]); }
        }
        tagVal = mLo2 + ((macdPanel.y + macdPanel.h - hy2) / macdPanel.h) * (mHi2 - mLo2);
      }
      if (tagVal != null) {
        var tagTxt = hoverPanel.id === "price" ? fmt.num(tagVal, priceDecimals)
          : hoverPanel.id === "vol" ? fmt.compact(Math.max(0, tagVal) * 1000)
          : hoverPanel.id === "rsi" ? tagVal.toFixed(0)
          : tagVal.toFixed(2);
        this.axisTag(ctx, f, hy2, tagTxt, "rgba(232,236,248,0.9)", "#0c0f22");
      }
      this.dateTag(ctx, f, hx, this._fullDateLabel(d.dates[hIdx]));
      this._hover = { idx: hIdx };
      this._renderLegend(hIdx);
    } else if (!hoverOnly) {
      this._hover = null;
      this._renderLegend(i1);
    }

    /* ---- live pulse animation loop ---- */
    if (this._livePulse && !this._pulseTimer) {
      var self2 = this;
      this._pulseTimer = true;
      (function pulse() {
        if (!self2._livePulse) { self2._pulseTimer = false; return; }
        self2.requestDraw();
        requestAnimationFrame(pulse);
      })();
    }
  };

  CandleChart.prototype._logTicks = function (lo, hi) {
    var out = [];
    var e0 = Math.floor(Math.log(lo) / Math.LN10), e1 = Math.ceil(Math.log(hi) / Math.LN10);
    for (var e = e0; e <= e1; e++) {
      var v = Math.pow(10, e);
      if (v >= lo * 0.99 && v <= hi * 1.01) out.push(v);
      var v2 = v * 5;
      if (v2 >= lo && v2 <= hi && (hi / lo) < 30) out.push(v2);
    }
    return out.length ? out : [lo, hi];
  };

  CandleChart.prototype._fullDateLabel = function (iso) {
    if (!iso) return "";
    if (this.data.intraday && iso.length > 10) {
      // accept "2026-09-19 14:30" and "2026-09-19, 14:30"
      var hm = iso.length >= 16 ? iso.slice(-5) : "";
      return iso.slice(0, 10) + " " + hm + " ET";
    }
    return iso;
  };

  CandleChart.prototype._drawXAxis = function (ctx, f, i0, i1, xOf) {
    var d = this.data;
    var span = i1 - i0 + 1;
    ctx.fillStyle = C.dim;
    ctx.font = "10px " + FONT_MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var maxLabels = Math.max(2, Math.floor(f.w / 72));
    var step = Math.max(1, Math.ceil(span / maxLabels));
    var lastLabel = "";
    for (var i = i0 + Math.floor(step / 2); i <= i1; i += step) {
      var lb = this._dateLabel(d.dates[i]);
      if (lb === lastLabel) continue;
      ctx.fillText(lb, xOf(i), f.y + f.h + 6);
      lastLabel = lb;
    }
  };

  /* HTML legend overlay (OHLC readout, TradingView style) */
  CandleChart.prototype._renderLegend = function (idx) {
    if (!this._legendEl) {
      this._legendEl = document.createElement("div");
      this._legendEl.className = "ohlc-legend";
      this.el.appendChild(this._legendEl);
    }
    var d = this.data;
    if (!d || idx == null) { this._legendEl.innerHTML = ""; return; }
    var b = idx * 5;
    var O = d.ohlcv[b], H = d.ohlcv[b + 1], L = d.ohlcv[b + 2], Cl = d.ohlcv[b + 3], V = d.ohlcv[b + 4];
    var live = d.live;
    if (d.forming === idx && live && live.price != null) Cl = live.price;
    var chg = O != null && Cl != null ? Cl / O - 1 : null;
    var upCls = chg != null && chg >= 0 ? "up" : "down";
    var html = '<span class="lg-sym">' + htmlEscape(d.ticker || "") + "</span>" +
      '<span class="lg-date">' + htmlEscape(this._fullDateLabel(d.dates[idx]) || "") + "</span>";
    if (O != null) {
      html += '<span class="lg-kv">O <b class="' + upCls + '">' + fmt.num(O) + "</b></span>" +
        '<span class="lg-kv">H <b class="' + upCls + '">' + fmt.num(H) + "</b></span>" +
        '<span class="lg-kv">L <b class="' + upCls + '">' + fmt.num(L) + "</b></span>" +
        '<span class="lg-kv">C <b class="' + upCls + '">' + fmt.num(Cl) + "</b></span>" +
        '<span class="lg-kv">' + (chg >= 0 ? "+" : "") + (chg * 100).toFixed(2) + '%</span>' +
        '<span class="lg-kv">VOL <b>' + (V == null ? "–" : fmt.compact(V * 1000)) + "</b></span>";
    }
    var ind = this._ind;
    if (ind) {
      if (ind.sma20 && ind.sma20[idx] != null) html += '<span class="lg-kv ma-ma20">MA20 ' + fmt.num(ind.sma20[idx]) + "</span>";
      if (ind.sma50 && ind.sma50[idx] != null) html += '<span class="lg-kv ma-ma50">MA50 ' + fmt.num(ind.sma50[idx]) + "</span>";
      if (ind.sma200 && ind.sma200[idx] != null) html += '<span class="lg-kv ma-ma200">MA200 ' + fmt.num(ind.sma200[idx]) + "</span>";
      if (ind.ema50 && ind.ema50[idx] != null) html += '<span class="lg-kv ma-ema50">EMA50 ' + fmt.num(ind.ema50[idx]) + "</span>";
      if (ind.rsi && ind.rsi[idx] != null) html += '<span class="lg-kv ma-rsi">RSI ' + ind.rsi[idx].toFixed(1) + "</span>";
      if (ind.macd && ind.macd.line[idx] != null) html += '<span class="lg-kv ma-macd">MACD ' + ind.macd.line[idx].toFixed(2) + "</span>";
    }
    if (d.forming === idx) html += '<span class="lg-live">● LIVE</span>';
    this._legendEl.innerHTML = html;
  };

  /* ============================ LineChart ============================= */
  /* opts: { yFmt, tipFmt, log, zeroLine, legend, colorize, axisTag:true } */
  function LineChart(el, opts) {
    this.init(el);
    this.opts = opts || {};
    var self = this;
    this.canvas.addEventListener("mousemove", function (e) {
      var r = self.canvas.getBoundingClientRect();
      self._mx = e.clientX - r.left;
      self._my = e.clientY - r.top;
      self._client = { x: e.clientX, y: e.clientY };
      if (self._drawn) self.draw(true);
    });
    this.canvas.addEventListener("mouseleave", function () {
      hideTooltip();
      if (self._drawn) self.draw();
    });
  }
  LineChart.prototype = Object.create(BaseChart);
  LineChart.prototype.pad = { l: 52, r: 56, t: 16, b: 26 };

  LineChart.prototype.setData = function (dates, series) {
    this.dates = dates;
    this.series = series;
    this._xy = null;
    this.draw();
  };

  LineChart.prototype._calc = function () {
    if (this._xy) return this._xy;
    var f = this.frame();
    var lo = Infinity, hi = -Infinity;
    for (var s = 0; s < this.series.length; s++) {
      var d = this.series[s].data;
      for (var i = 0; i < d.length; i++) {
        var v = d[i];
        if (v != null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    if (this.opts.log) lo = Math.max(lo, 0.01);
    var pad = (hi - lo) * 0.06;
    lo -= pad; hi += pad;
    if (this.opts.log) lo = Math.max(lo, 0.01);
    var self = this;
    var n = this.dates.length;
    var mapX = function (i) { return f.x + (i / Math.max(1, n - 1)) * f.w; };
    var mapY = this.opts.log
      ? function (v) {
          var lv = Math.log(Math.max(v, 0.01)), ll = Math.log(Math.max(lo, 0.01)), lh = Math.log(hi);
          return f.y + f.h - ((lv - ll) / (lh - ll)) * f.h;
        }
      : function (v) { return f.y + f.h - ((v - lo) / (hi - lo)) * f.h; };
    this._xy = { f: f, lo: lo, hi: hi, mapX: mapX, mapY: mapY, n: n };
    return this._xy;
  };

  LineChart.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.dates) return;
    var self = this;
    var xy = this._calc();
    var f = xy.f, mapX = xy.mapX, mapY = xy.mapY, n = xy.n;
    var yF = this.opts.yFmt || function (t) { return fmt.num(t, Math.abs(xy.hi) < 10 ? 1 : 0); };

    var ticks = this.opts.log ? this._logTicks(xy.lo, xy.hi) : niceTicks(xy.lo, xy.hi, 5);
    this.gridAndAxes(ctx, f, ticks, mapY, yF);
    this._drawXAxis(ctx, f, n, mapX);

    if (this.opts.zeroLine && xy.lo < 0 && xy.hi > 0) {
      var zy = mapY(0);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(f.x, zy + 0.5); ctx.lineTo(f.x + f.w, zy + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    }

    // hover index
    var hoverIdx = -1;
    if (hoverOnly && this._mx != null && this._mx >= f.x && this._mx <= f.x + f.w) {
      hoverIdx = clamp(Math.round(((this._mx - f.x) / f.w) * (n - 1)), 0, n - 1);
    }

    // series
    for (var s = 0; s < this.series.length; s++) {
      var ser = this.series[s];
      ctx.strokeStyle = ser.color;
      ctx.lineWidth = ser.width || 1.8;
      if (ser.dash) ctx.setLineDash(ser.dash);
      ctx.lineJoin = "round";
      ctx.beginPath();
      var started = false;
      var lastX = null, lastY = null;
      for (var i = 0; i < ser.data.length; i++) {
        var v = ser.data[i];
        if (v == null || !isFinite(v)) { started = false; continue; }
        var x = mapX(i), y = mapY(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        lastX = x; lastY = y;
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (ser.fill) {
        ctx.lineTo(lastX != null ? lastX : f.x, f.y + f.h);
        ctx.lineTo(f.x, f.y + f.h);
        ctx.closePath();
        var g = ctx.createLinearGradient(0, f.y, 0, f.y + f.h);
        g.addColorStop(0, ser.fill);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fill();
      }
      // end dot
      if (ser.endDot !== false && lastX != null) {
        ctx.beginPath();
        ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
        ctx.fillStyle = ser.color;
        ctx.fill();
      }
      // hover dots
      if (hoverIdx >= 0 && ser.data[hoverIdx] != null) {
        var hx = mapX(hoverIdx), hy = mapY(ser.data[hoverIdx]);
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#0c0f22";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(hx, hy, 4, 0, Math.PI * 2);
        ctx.strokeStyle = ser.color;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // crosshair + tags + tooltip
    if (hoverIdx >= 0) {
      var hxx = mapX(hoverIdx);
      ctx.strokeStyle = "rgba(255,255,255,0.26)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(hxx + 0.5, f.y); ctx.lineTo(hxx + 0.5, f.y + f.h); ctx.stroke();
      if (this._my != null && this._my >= f.y && this._my <= f.y + f.h) {
        ctx.beginPath(); ctx.moveTo(f.x, this._my + 0.5); ctx.lineTo(f.x + f.w, this._my + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        var yVal = xy.lo + ((f.y + f.h - this._my) / f.h) * (xy.hi - xy.lo);
        if (this.opts.log) {
          var ll = Math.log(Math.max(xy.lo, 0.01)), lh = Math.log(xy.hi);
          yVal = Math.exp(ll + ((f.y + f.h - this._my) / f.h) * (lh - ll));
        }
        this.axisTag(ctx, f, this._my, yF(yVal), "rgba(232,236,248,0.9)", "#0c0f22");
      }
      ctx.setLineDash([]);
      this.dateTag(ctx, f, hxx, String(this.dates[hoverIdx]));
      var html = ttTitle(this.dates[hoverIdx]);
      for (var s2 = 0; s2 < this.series.length; s2++) {
        var val = this.series[s2].data[hoverIdx];
        html += ttRow(this.series[s2].name,
          val == null ? "–" : (this.opts.tipFmt ? this.opts.tipFmt(val) : fmt.num(val)),
          this.opts.colorize && val != null ? (val >= 0 ? "up-tt" : "down-tt") : "");
      }
      tooltip(html, this._client.x, this._client.y);
    }

    if (this.opts.legend !== false && this.series.length > 1) {
      this.legend(ctx, f, this.series.map(function (s3) {
        return { label: s3.name, color: s3.color };
      }));
    }
  };
  LineChart.prototype._logTicks = function (lo, hi) {
    var out = [], e0 = Math.floor(Math.log(lo) / Math.LN10), e1 = Math.ceil(Math.log(hi) / Math.LN10);
    for (var e = e0; e <= e1; e++) {
      var v = Math.pow(10, e);
      if (v >= lo * 0.99 && v <= hi * 1.01) out.push(v);
    }
    return out.length ? out : [lo, hi];
  };
  LineChart.prototype._drawXAxis = function (ctx, f, n, mapX) {
    ctx.fillStyle = C.dim;
    ctx.font = "10px " + FONT_MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var count = Math.max(2, Math.min(6, Math.floor(f.w / 76)));
    var step = Math.max(1, Math.floor(n / count));
    var lastLb = "";
    for (var i = step; i < n - 1; i += step) {
      var d = String(this.dates[i]);
      var lb = d.length > 7 ? d.slice(0, 7) : d;
      if (lb === lastLb) continue;
      ctx.fillText(lb, mapX(i), f.y + f.h + 6);
      lastLb = lb;
    }
  };

  /* ============================ BarChartH ============================= */
  /* data: { items: [{label, value, tipRows}], valueFmt, colorize }        */
  function BarChartH(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.pad = { l: 10, r: 56, t: 10, b: 24 };
    var self = this;
    this.canvas.addEventListener("mousemove", function (e) {
      var r = self.canvas.getBoundingClientRect();
      self._mx = e.clientX - r.left;
      self._my = e.clientY - r.top;
      self._client = { x: e.clientX, y: e.clientY };
      if (self._drawn) self.draw(true);
    });
    this.canvas.addEventListener("mouseleave", function () {
      hideTooltip();
      if (self._drawn) self.draw();
    });
  }
  BarChartH.prototype = Object.create(BaseChart);

  BarChartH.prototype.setData = function (data) { this.data = data; this.draw(); };

  BarChartH.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.data) return;
    var items = this.data.items;
    var n = items.length;
    if (!n) return;
    var f = this.frame();
    var labelW = Math.min(64, Math.max(38, f.w * 0.09));
    var f2 = { x: f.x + labelW, y: f.y, w: f.w - labelW, h: f.h };

    var lo = 0, hi = 0;
    for (var i = 0; i < n; i++) {
      lo = Math.min(lo, items[i].value);
      hi = Math.max(hi, items[i].value);
    }
    if (lo === 0 && hi === 0) hi = 1;
    var mag = Math.max(Math.abs(lo), Math.abs(hi)) * 1.12;
    lo = Math.min(lo, 0) === 0 ? -0.001 : -mag;
    hi = Math.max(hi, 0) === 0 ? 0.001 : mag;

    var rowH = f2.h / n;
    var barH = Math.max(2, Math.min(18, rowH * 0.66));
    var mapX = function (v) { return f2.x + f2.w / 2 + (v / (hi - lo)) * f2.w * 0.98; };
    var zeroX = mapX(0);
    var vf = this.data.valueFmt || function (v) { return fmt.num(v); };

    ctx.strokeStyle = C.axis;
    ctx.beginPath();
    ctx.moveTo(zeroX + 0.5, f2.y); ctx.lineTo(zeroX + 0.5, f2.y + f2.h); ctx.stroke();

    ctx.fillStyle = C.dim;
    ctx.font = "10px " + FONT_MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xticks = niceTicks(-mag, mag, 4);
    for (i = 0; i < xticks.length; i++) ctx.fillText(vf(xticks[i]), mapX(xticks[i]), f2.y + f2.h + 6);

    var hoverIdx = -1;
    if (hoverOnly && this._my != null && this._my >= f2.y && this._my <= f2.y + f2.h) {
      hoverIdx = clamp(Math.floor((this._my - f2.y) / rowH), 0, n - 1);
    }

    for (i = 0; i < n; i++) {
      var it = items[i];
      var y = f2.y + i * rowH + (rowH - barH) / 2;
      var x0 = Math.min(zeroX, mapX(it.value));
      var w = Math.max(1.5, Math.abs(mapX(it.value) - zeroX));
      var color = this.data.colorize ? this.data.colorize(it.value, i, it) : (it.value >= 0 ? C.cyan : C.magenta);
      var isHover = i === hoverIdx;
      ctx.globalAlpha = hoverIdx >= 0 && !isHover ? 0.35 : 1;
      ctx.fillStyle = color;
      var rr = Math.min(4, barH / 2);
      ctx.beginPath();
      ctx.moveTo(x0, y + rr);
      ctx.quadraticCurveTo(x0, y, x0 + rr, y);
      ctx.lineTo(Math.max(x0 + rr, x0 + w - rr), y);
      ctx.quadraticCurveTo(x0 + w, y, x0 + w, y + rr);
      ctx.lineTo(x0 + w, y + barH - rr);
      ctx.quadraticCurveTo(x0 + w, y + barH, Math.max(x0 + rr, x0 + w - rr), y + barH);
      ctx.lineTo(x0 + rr, y + barH);
      ctx.quadraticCurveTo(x0, y + barH, x0, y + barH - rr);
      ctx.closePath();
      ctx.fill();
      if (isHover) {
        ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;
      ctx.font = (isHover ? "bold " : "") + "10px " + FONT_MONO;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = isHover ? C.text : C.dim;
      ctx.fillText(it.label, f2.x - 8, y + barH / 2);
      ctx.textAlign = it.value >= 0 ? "left" : "right";
      ctx.fillStyle = C.faint;
      ctx.fillText(vf(it.value), mapX(it.value) + (it.value >= 0 ? 6 : -6), y + barH / 2);
    }

    if (hoverIdx >= 0) {
      var hv = items[hoverIdx];
      var html = ttTitle(hv.label + (hv.name ? " · " + hv.name : ""));
      if (hv.tipRows) {
        for (var r = 0; r < hv.tipRows.length; r++) html += ttRow(hv.tipRows[r][0], hv.tipRows[r][1]);
      } else html += ttRow("Value", vf(hv.value));
      tooltip(html, this._client.x, this._client.y);
    }
  };

  /* ============================ ICChart =============================== */
  /* data: { labels, ic, cum }                                             */
  function ICChart(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.pad = { l: 46, r: 52, t: 14, b: 26 };
    var self = this;
    this.canvas.addEventListener("mousemove", function (e) {
      var r = self.canvas.getBoundingClientRect();
      self._mx = e.clientX - r.left;
      self._client = { x: e.clientX, y: e.clientY };
      if (self._drawn) self.draw(true);
    });
    this.canvas.addEventListener("mouseleave", function () {
      hideTooltip();
      if (self._drawn) self.draw();
    });
  }
  ICChart.prototype = Object.create(BaseChart);

  ICChart.prototype.setData = function (data) { this.data = data; this.draw(); };

  ICChart.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.data) return;
    var d = this.data;
    var n = d.ic.length;
    if (!n) return;
    var f = this.frame();

    var icLo = 0, icHi = 0, cumLo = 0, cumHi = 0;
    for (var i = 0; i < n; i++) {
      if (d.ic[i] != null) { icLo = Math.min(icLo, d.ic[i]); icHi = Math.max(icHi, d.ic[i]); }
      if (d.cum[i] != null) { cumLo = Math.min(cumLo, d.cum[i]); cumHi = Math.max(cumHi, d.cum[i]); }
    }
    var icPad = Math.max(0.05, Math.max(-icLo, icHi) * 1.15);
    icLo = -icPad; icHi = icPad;
    var cumPad = (cumHi - cumLo) * 0.08 || 0.1;
    cumLo -= cumPad; cumHi += cumPad;

    var mapY = function (v) { return f.y + f.h - ((v - icLo) / (icHi - icLo)) * f.h; };
    var mapY2 = function (v) { return f.y + f.h - ((v - cumLo) / (cumHi - cumLo)) * f.h; };
    var mapX = function (idx) { return f.x + ((idx + 0.5) / n) * f.w; };

    this.gridAndAxes(ctx, f, niceTicks(icLo, icHi, 4), mapY, function (t) { return t.toFixed(2); });
    ctx.fillStyle = C.violet;
    ctx.font = "10px " + FONT_MONO;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var cts = niceTicks(cumLo, cumHi, 4);
    for (i = 0; i < cts.length; i++) ctx.fillText(cts[i].toFixed(1), f.x + f.w + 8, mapY2(cts[i]));

    ctx.fillStyle = C.dim;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var lastYear = "";
    for (i = 0; i < n; i += Math.max(1, Math.floor(n / 12))) {
      var yr = d.labels[i].slice(0, 4);
      if (yr !== lastYear) { ctx.fillText(yr, mapX(i), f.y + f.h + 8); lastYear = yr; }
    }

    var zy = mapY(0);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath(); ctx.moveTo(f.x, zy + 0.5); ctx.lineTo(f.x + f.w, zy + 0.5); ctx.stroke();

    var bw = Math.max(1, Math.min(7, (f.w / n) * 0.7));
    for (i = 0; i < n; i++) {
      if (d.ic[i] == null) continue;
      var x = mapX(i);
      var y0 = mapY(Math.max(0, d.ic[i]));
      var y1 = mapY(Math.min(0, d.ic[i]));
      ctx.fillStyle = d.ic[i] >= 0 ? "rgba(37,211,224,0.75)" : "rgba(244,83,107,0.75)";
      ctx.fillRect(x - bw / 2, y0, bw, Math.max(1, y1 - y0));
    }

    ctx.strokeStyle = C.violet;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    var st = false;
    for (i = 0; i < n; i++) {
      if (d.cum[i] == null) { st = false; continue; }
      var px = mapX(i), py = mapY2(d.cum[i]);
      if (!st) { ctx.moveTo(px, py); st = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();

    var hoverIdx = -1;
    if (hoverOnly && this._mx != null && this._mx >= f.x && this._mx <= f.x + f.w) {
      hoverIdx = clamp(Math.floor(((this._mx - f.x) / f.w) * n), 0, n - 1);
    }
    if (hoverIdx >= 0) {
      var hx = mapX(hoverIdx);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath(); ctx.moveTo(hx + 0.5, f.y); ctx.lineTo(hx + 0.5, f.y + f.h); ctx.stroke();
      var html = ttTitle(d.labels[hoverIdx]);
      html += ttRow("Monthly IC", d.ic[hoverIdx] == null ? "–" : d.ic[hoverIdx].toFixed(4),
        d.ic[hoverIdx] >= 0 ? "up-tt" : "down-tt");
      html += ttRow("Cumulative", d.cum[hoverIdx] == null ? "–" : d.cum[hoverIdx].toFixed(2));
      tooltip(html, this._client.x, this._client.y);
    }

    this.legend(ctx, f, [
      { label: "monthly rank IC", color: C.cyan },
      { label: "cumulative IC (right)", color: C.violet },
    ]);
  };

  /* ============================ ScatterChart ========================== */
  /* data: { points, xLabel, yLabel, regression, xFmt, yFmt }              */
  function ScatterChart(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.pad = { l: 52, r: 20, t: 14, b: 34 };
    var self = this;
    this.canvas.addEventListener("mousemove", function (e) {
      var r = self.canvas.getBoundingClientRect();
      self._mx = e.clientX - r.left;
      self._my = e.clientY - r.top;
      self._client = { x: e.clientX, y: e.clientY };
      if (self._drawn) self.draw(true);
    });
    this.canvas.addEventListener("mouseleave", function () {
      hideTooltip();
      if (self._drawn) self.draw();
    });
  }
  ScatterChart.prototype = Object.create(BaseChart);

  ScatterChart.prototype.setData = function (data) { this.data = data; this.draw(); };

  ScatterChart.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.data) return;
    var d = this.data;
    var pts = d.points;
    if (!pts.length) return;
    var f = this.frame();

    var xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    var i;
    for (i = 0; i < pts.length; i++) {
      if (pts[i].x == null || pts[i].y == null) continue;
      xlo = Math.min(xlo, pts[i].x); xhi = Math.max(xhi, pts[i].x);
      ylo = Math.min(ylo, pts[i].y); yhi = Math.max(yhi, pts[i].y);
    }
    var xpad = (xhi - xlo) * 0.08 || 0.1, ypad = (yhi - ylo) * 0.08 || 0.1;
    xlo -= xpad; xhi += xpad; ylo -= ypad; yhi += ypad;
    var mapX = function (v) { return f.x + ((v - xlo) / (xhi - xlo)) * f.w; };
    var mapY = function (v) { return f.y + f.h - ((v - ylo) / (yhi - ylo)) * f.h; };
    var xF = d.xFmt || function (v) { return fmt.num(v, 2); };
    var yF = d.yFmt || function (v) { return fmt.num(v, 2); };

    this.gridAndAxes(ctx, f, niceTicks(ylo, yhi, 5), mapY, yF);
    ctx.fillStyle = C.dim;
    ctx.font = "10px " + FONT_MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xticks = niceTicks(xlo, xhi, 6);
    for (i = 0; i < xticks.length; i++) ctx.fillText(xF(xticks[i]), mapX(xticks[i]), f.y + f.h + 8);
    if (d.xLabel) {
      ctx.fillStyle = C.faint;
      ctx.font = "10px " + FONT_UI;
      ctx.textAlign = "right";
      ctx.fillText(d.xLabel, f.x + f.w, f.y + f.h + 22);
    }
    if (d.yLabel) {
      ctx.save();
      ctx.translate(12, f.y + f.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(d.yLabel, 0, 0);
      ctx.restore();
    }

    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.setLineDash([4, 4]);
    if (xlo < 0 && xhi > 0) { ctx.beginPath(); ctx.moveTo(mapX(0) + 0.5, f.y); ctx.lineTo(mapX(0) + 0.5, f.y + f.h); ctx.stroke(); }
    if (ylo < 0 && yhi > 0) { ctx.beginPath(); ctx.moveTo(f.x, mapY(0) + 0.5); ctx.lineTo(f.x + f.w, mapY(0) + 0.5); ctx.stroke(); }
    ctx.setLineDash([]);

    if (d.regression) {
      var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (i = 0; i < pts.length; i++) {
        if (pts[i].x == null || pts[i].y == null) continue;
        sx += pts[i].x; sy += pts[i].y; sxx += pts[i].x * pts[i].x; sxy += pts[i].x * pts[i].y; m++;
      }
      if (m > 2) {
        var slope = (m * sxy - sx * sy) / (m * sxx - sx * sx);
        var intercept = (sy - slope * sx) / m;
        ctx.strokeStyle = "rgba(244,114,182,0.65)";
        ctx.lineWidth = 1.4;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        ctx.moveTo(mapX(xlo + xpad), mapY(slope * (xlo + xpad) + intercept));
        ctx.lineTo(mapX(xhi - xpad), mapY(slope * (xhi - xpad) + intercept));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    var hoverIdx = -1, bestD = 18 * 18;
    if (hoverOnly && this._mx != null) {
      for (i = 0; i < pts.length; i++) {
        if (pts[i].x == null || pts[i].y == null) continue;
        var dx = mapX(pts[i].x) - this._mx, dy = mapY(pts[i].y) - this._my;
        var dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; hoverIdx = i; }
      }
    }

    for (i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p.x == null || p.y == null) continue;
      var px = mapX(p.x), py = mapY(p.y);
      var rad = p.size || 5;
      var isHover = i === hoverIdx;
      ctx.globalAlpha = hoverIdx >= 0 && !isHover ? 0.3 : 0.95;
      ctx.fillStyle = p.color || C.cyan;
      ctx.beginPath();
      ctx.arc(px, py, isHover ? rad + 2.5 : rad, 0, Math.PI * 2);
      ctx.fill();
      if (isHover) { ctx.shadowColor = p.color || C.cyan; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0; }
      if (p.tag) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = C.dim;
        ctx.font = "10px " + FONT_MONO;
        ctx.textAlign = "left";
        ctx.fillText(p.tag, px + rad + 4, py + 3);
      }
      ctx.globalAlpha = 1;
    }

    if (hoverIdx >= 0) {
      var hp = pts[hoverIdx];
      var html2 = ttTitle(hp.label + (hp.name ? " · " + hp.name : ""));
      html2 += ttRow(d.xLabel || "x", xF(hp.x));
      html2 += ttRow(d.yLabel || "y", yF(hp.y));
      if (hp.tipRows) for (var r2 = 0; r2 < hp.tipRows.length; r2++) html2 += ttRow(hp.tipRows[r2][0], hp.tipRows[r2][1]);
      tooltip(html2, this._client.x, this._client.y);
    }
  };

  /* ============================ Heatmap =============================== */
  /* data: { mode:"corr", labels, matrix } or { mode:"monthly", rows, cols, matrix } */
  function Heatmap(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.pad = { l: 44, r: 8, t: 26, b: 30 };
    var self = this;
    this.canvas.addEventListener("mousemove", function (e) {
      var r = self.canvas.getBoundingClientRect();
      self._mx = e.clientX - r.left;
      self._my = e.clientY - r.top;
      self._client = { x: e.clientX, y: e.clientY };
      if (self._drawn) self.draw(true);
    });
    this.canvas.addEventListener("mouseleave", function () {
      hideTooltip();
      if (self._drawn) self.draw();
    });
  }
  Heatmap.prototype = Object.create(BaseChart);

  Heatmap.prototype.setData = function (data) { this.data = data; this.draw(); };

  function corrColor(v) {
    var t = clamp(v, -1, 1);
    if (t < 0) {
      var k = -t;
      return "rgba(" + Math.round(251 - 150 * (1 - k)) + "," +
        Math.round(113 - 90 * (1 - k)) + "," + Math.round(133 - 90 * (1 - k)) + "," +
        (0.25 + 0.75 * k).toFixed(2) + ")";
    }
    var k2 = t;
    return "rgba(" + Math.round(34 + 20 * (1 - k2)) + "," +
      Math.round(211 - 60 * (1 - k2)) + "," + Math.round(238 - 30 * (1 - k2)) + "," +
      (0.2 + 0.8 * k2).toFixed(2) + ")";
  }
  function retColor(v) {
    var t = clamp(v / 0.08, -1, 1);
    if (t < 0) {
      var k = -t;
      return "rgba(244," + Math.round(83 + 60 * (1 - k)) + "," + Math.round(107 + 60 * (1 - k)) + "," + (0.25 + 0.7 * k).toFixed(2) + ")";
    }
    return "rgba(34," + Math.round(195 - 80 * (1 - t)) + "," + Math.round(143 - 60 * (1 - t)) + "," + (0.2 + 0.75 * t).toFixed(2) + ")";
  }

  Heatmap.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.data) return;
    var d = this.data;
    var rows = d.matrix.length, cols = rows ? d.matrix[0].length : 0;
    if (!rows || !cols) return;
    var f = this.frame();
    var isCorr = d.mode === "corr";
    var colorFn = isCorr ? corrColor : retColor;

    var cellW = f.w / cols, cellH = f.h / rows;
    var labTop = d.labelsTop || (isCorr ? d.labels : d.cols);
    var labLeft = d.labelsLeft || (isCorr ? d.labels : d.rows);

    var hovR = -1, hovC = -1;
    if (hoverOnly && this._mx != null && this._my != null) {
      var cx = Math.floor((this._mx - f.x) / cellW);
      var cy = Math.floor((this._my - f.y) / cellH);
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) { hovC = cx; hovR = cy; }
    }

    ctx.font = "9.5px " + FONT_MONO;
    ctx.textBaseline = "middle";
    var skipX = Math.ceil(34 / Math.max(8, cellW));
    var skipY = Math.ceil(22 / Math.max(8, cellH));
    ctx.fillStyle = C.dim;
    ctx.textAlign = "center";
    for (var cTop = 0; cTop < labTop.length; cTop += skipX) {
      ctx.save();
      ctx.translate(f.x + (cTop + 0.5) * cellW, f.y - 8);
      if (isCorr && cellW < 26) ctx.rotate(-Math.PI / 3);
      ctx.fillText(labTop[cTop], 0, 0);
      ctx.restore();
    }
    ctx.textAlign = "right";
    for (var rLeft = 0; rLeft < labLeft.length; rLeft += skipY) {
      ctx.fillText(labLeft[rLeft], f.x - 6, f.y + (rLeft + 0.5) * cellH);
    }

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var v = d.matrix[r][c];
        var x = f.x + c * cellW, y = f.y + r * cellH;
        var isHov = r === hovR && c === hovC;
        var isCross = isCorr && (r === hovR || c === hovC) && v != null;
        if (v == null) {
          ctx.fillStyle = "rgba(255,255,255,0.03)";
          ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
          continue;
        }
        ctx.fillStyle = colorFn(v);
        ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        if (isCross) {
          ctx.fillStyle = "rgba(255,255,255,0.10)";
          ctx.fillRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
        }
        if (isHov) {
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.75, y + 0.75, cellW - 1.5, cellH - 1.5);
        }
        if (cellW > 34 && cellH > 16) {
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.font = "9px " + FONT_MONO;
          ctx.textAlign = "center";
          ctx.fillText(isCorr ? v.toFixed(2) : (v >= 0 ? "+" : "") + (v * 100).toFixed(0),
            x + cellW / 2, y + cellH / 2);
        }
      }
    }

    if (hovR >= 0 && hovC >= 0) {
      var hv = d.matrix[hovR][hovC];
      var html = ttTitle(labLeft[hovR] + " × " + labTop[hovC]);
      if (isCorr) html += ttRow("Correlation", hv == null ? "–" : hv.toFixed(3));
      else html += ttRow("Return", fmt.pct(hv), hv >= 0 ? "up-tt" : "down-tt");
      tooltip(html, this._client.x, this._client.y);
    }
  };

  /* ============================ Sparkline ============================= */
  /* draws a tiny trend line into a canvas element                        */
  function drawSparkline(canvas, values, color, opts) {
    opts = opts || {};
    var dpr = window.devicePixelRatio || 1;
    var w = opts.w || canvas.clientWidth || 90;
    var h = opts.h || canvas.clientHeight || 26;
    if (w < 4 || h < 4) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var vals = values.filter(function (v) { return v != null; });
    if (vals.length < 2) return;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (lo === hi) { lo -= 1; hi += 1; }
    var n = values.length;
    var mapX = function (i) { return (i / (n - 1)) * (w - 4) + 2; };
    var mapY = function (v) { return h - 3 - ((v - lo) / (hi - lo)) * (h - 6); };
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    var st = false;
    for (var i = 0; i < n; i++) {
      if (values[i] == null) { st = false; continue; }
      var x = mapX(i), y = mapY(values[i]);
      if (!st) { ctx.moveTo(x, y); st = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    // end dot
    var lastIdx = n - 1;
    while (lastIdx >= 0 && values[lastIdx] == null) lastIdx--;
    if (lastIdx >= 0) {
      ctx.beginPath();
      ctx.arc(mapX(lastIdx), mapY(values[lastIdx]), 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
  }

  /* exports */
  window.QP = window.QP || {};
  window.QP.fmt = fmt;
  window.QP.colors = C;
  window.QP.SERIES8 = SERIES8;
  window.QP.charts = {
    BaseChart: BaseChart, LineChart: LineChart, CandleChart: CandleChart,
    BarChartH: BarChartH, ICChart: ICChart, ScatterChart: ScatterChart,
    Heatmap: Heatmap, drawSparkline: drawSparkline,
    indicators: { sma: sma, ema: ema, rsiWilder: rsiWilder, bollinger: bollinger },
  };
  window.QP.util = { niceTicks: niceTicks, clamp: clamp, tooltip: tooltip, hideTooltip: hideTooltip, ttRow: ttRow, ttTitle: ttTitle, htmlEscape: htmlEscape };
})();
