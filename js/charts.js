/* ==========================================================================
   AlphaForge — zero-dependency canvas chart engine
   Hand-rolled candlesticks, lines, bars, scatters and heatmaps with
   HiDPI support, responsive redraws and crosshair tooltips.
   ========================================================================== */
(function () {
  "use strict";

  /* ----------------------------- palette ------------------------------ */
  var C = {
    text: "#e7eaf6",
    dim: "#9aa1c4",
    faint: "rgba(154,161,196,0.55)",
    grid: "rgba(255,255,255,0.055)",
    axis: "rgba(255,255,255,0.10)",
    up: "#34d399",
    down: "#fb7185",
    cyan: "#22d3ee",
    violet: "#a78bfa",
    magenta: "#f472b6",
    amber: "#fbbf24",
    blue: "#60a5fa",
  };
  var SERIES8 = [C.cyan, C.violet, C.magenta, C.amber, C.up, C.blue, "#f97316", "#4ade80"];

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
      if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
      if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
      if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return v.toFixed(0);
    },
    date: function (iso) { return iso; },
    monthShort: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  };

  /* ----------------------------- helpers ------------------------------ */
  function niceTicks(min, max, target) {
    if (!isFinite(min) || !isFinite(max) || min === max) {
      return [min, max];
    }
    var span = max - min;
    var step0 = span / Math.max(2, target);
    var mag = Math.pow(10, Math.floor(Math.log(step0) / Math.LN10));
    var norm = step0 / mag;
    var step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    step *= mag;
    var ticks = [];
    var start = Math.ceil(min / step) * step;
    for (var v = start; v <= max + step * 1e-9; v += step) ticks.push(v);
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
  function hideTooltip() {
    if (tipEl) tipEl.classList.add("hidden");
  }
  function ttRow(k, v, cls) {
    return '<div class="tt-row"><span class="k">' + htmlEscape(k) +
      '</span><span class="v ' + (cls || "") + '">' + v + "</span></div>";
  }
  function ttTitle(t) { return '<div class="tt-title">' + htmlEscape(t) + "</div>"; }

  /* ============================ BaseChart ============================= */
  var BaseChart = {
    init: function (el) {
      this.el = el;
      this.canvas = document.createElement("canvas");
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
      el.innerHTML = "";
      el.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.pad = { l: 56, r: 16, t: 12, b: 26 };
      this._drawn = false;
      var self = this;
      if (typeof ResizeObserver !== "undefined") {
        this._ro = new ResizeObserver(function () {
          if (self._drawn) self.draw();
        });
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

    gridAndAxes: function (ctx, f, ticks, y0, mapY, fmtFn, logish) {
      var ctx2 = ctx;
      ctx2.strokeStyle = C.grid;
      ctx2.lineWidth = 1;
      ctx2.fillStyle = C.dim;
      ctx2.font = "10.5px " + FONT_MONO;
      ctx2.textAlign = "right";
      ctx2.textBaseline = "middle";
      for (var i = 0; i < ticks.length; i++) {
        var t = ticks[i];
        var y = mapY(t);
        if (y < f.y - 1 || y > f.y + f.h + 1) continue;
        ctx2.beginPath();
        ctx2.moveTo(f.x, Math.round(y) + 0.5);
        ctx2.lineTo(f.x + f.w, Math.round(y) + 0.5);
        ctx2.stroke();
        ctx2.fillText(fmtFn(t), f.x - 8, y);
      }
      // baseline
      ctx2.strokeStyle = C.axis;
      ctx2.beginPath();
      ctx2.moveTo(f.x + 0.5, f.y + 0.5);
      ctx2.lineTo(f.x + f.w + 0.5, f.y + 0.5);
      ctx2.lineTo(f.x + f.w + 0.5, f.y + f.h + 0.5);
      ctx2.stroke();
      void y0; void logish;
    },

    xDateLabels: function (ctx, f, dates, n) {
      var ctx2 = ctx;
      ctx2.fillStyle = C.dim;
      ctx2.font = "10.5px " + FONT_MONO;
      ctx2.textAlign = "center";
      ctx2.textBaseline = "top";
      var count = Math.max(2, Math.min(n || 6, Math.floor(f.w / 68)));
      var step = Math.max(1, Math.floor(dates.length / count));
      for (var i = step; i < dates.length - 1; i += step) {
        var x = f.x + (i / (dates.length - 1)) * f.w;
        var d = dates[i];
        var label = d.slice(0, 7);
        ctx2.fillText(label, x, f.y + f.h + 8);
      }
    },

    legend: function (ctx, f, entries) {
      var ctx2 = ctx;
      ctx2.font = "11px " + FONT_UI;
      ctx2.textBaseline = "middle";
      var x = f.x + 4;
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        ctx2.fillStyle = e.color;
        ctx2.fillRect(x, f.y - 2, 14, 3);
        ctx2.fillStyle = C.dim;
        ctx2.textAlign = "left";
        ctx2.fillText(e.label, x + 19, f.y);
        x += 19 + ctx2.measureText(e.label).width + 18;
      }
    },

    destroy: function () {
      if (this._ro) this._ro.disconnect();
    },
  };

  var FONT_MONO = "'SF Mono','Cascadia Code',Consolas,'Liberation Mono',monospace";
  var FONT_UI = "Inter,-apple-system,'Segoe UI',Roboto,sans-serif";

  /* ============================ LineChart ============================= */
  /* options: { series:[{name,data,color,fill,width,dash}], dates,
               yFmt, log, zeroLine, areaFill }                          */
  function LineChart(el, opts) {
    this.init(el);
    this.opts = opts || {};
    var self = this;
    this._hover = null;
    this.canvas.addEventListener("mousemove", function (e) {
      var r = self.canvas.getBoundingClientRect();
      self._mx = e.clientX - r.left;
      self._my = e.clientY - r.top;
      self._client = { x: e.clientX, y: e.clientY };
      if (self._drawn) self.draw(true);
    });
    this.canvas.addEventListener("mouseleave", function () {
      self._hover = null;
      hideTooltip();
      if (self._drawn) self.draw();
    });
  }
  LineChart.prototype = Object.create(BaseChart);

  LineChart.prototype.setData = function (dates, series) {
    this.dates = dates;
    this.series = series;
    this.draw();
  };

  LineChart.prototype._yRange = function () {
    var lo = Infinity, hi = -Infinity;
    for (var s = 0; s < this.series.length; s++) {
      var d = this.series[s].data;
      for (var i = 0; i < d.length; i++) {
        var v = d[i];
        if (v != null && isFinite(v)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (lo === hi) { lo -= 1; hi += 1; }
    if (this.opts.log) lo = Math.max(lo, 0.01);
    var pad = (hi - lo) * 0.06;
    return [lo - pad, hi + pad];
  };

  LineChart.prototype._mapY = function (v, f, lo, hi) {
    if (this.opts.log) {
      var lv = Math.log(Math.max(v, 0.01)), ll = Math.log(Math.max(lo, 0.01)), lh = Math.log(hi);
      return f.y + f.h - ((lv - ll) / (lh - ll)) * f.h;
    }
    return f.y + f.h - ((v - lo) / (hi - lo)) * f.h;
  };

  LineChart.prototype._tickVals = function (lo, hi) {
    if (this.opts.log) {
      var out = [], exps = [];
      var e0 = Math.floor(Math.log(lo) / Math.LN10), e1 = Math.ceil(Math.log(hi) / Math.LN10);
      for (var e = e0; e <= e1; e++) exps.push(Math.pow(10, e));
      for (var i = 2; i < exps.length; i += 2) out.push(exps[i]);
      if (!out.length && exps.length) out = [exps[0], exps[exps.length - 1]];
      return out;
    }
    return niceTicks(lo, hi, 5);
  };

  LineChart.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.series) return;
    var f = this.frame();
    var self = this;

    var range = this._yRange();
    var lo = range[0], hi = range[1];
    var mapY = function (v) { return self._mapY(v, f, lo, hi); };
    var n = this.dates.length;

    this.gridAndAxes(ctx, f, this._tickVals(lo, hi), 0, mapY,
      this.opts.yFmt ? this.opts.yFmt : function (t) { return fmt.num(t, Math.abs(hi) < 10 ? 1 : 0); });

    this.xDateLabels(ctx, f, this.dates, 6);

    if (this.opts.zeroLine && lo < 0 && hi > 0) {
      var zy = mapY(0);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(f.x, zy + 0.5);
      ctx.lineTo(f.x + f.w, zy + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // hover crosshair
    var hoverIdx = -1;
    if (hoverOnly && this._mx != null && this._mx >= f.x && this._mx <= f.x + f.w) {
      hoverIdx = Math.round(((this._mx - f.x) / f.w) * (n - 1));
      hoverIdx = clamp(hoverIdx, 0, n - 1);
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
      for (var i = 0; i < ser.data.length; i++) {
        var v = ser.data[i];
        if (v == null || !isFinite(v)) { started = false; continue; }
        var x = f.x + (i / (n - 1)) * f.w;
        var y = mapY(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (ser.fill) {
        ctx.lineTo(f.x + f.w, f.y + f.h);
        ctx.lineTo(f.x, f.y + f.h);
        ctx.closePath();
        var g = ctx.createLinearGradient(0, f.y, 0, f.y + f.h);
        g.addColorStop(0, ser.fill);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fill();
      }
    }

    if (hoverIdx >= 0) {
      var hx = f.x + (hoverIdx / (n - 1)) * f.w;
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx + 0.5, f.y);
      ctx.lineTo(hx + 0.5, f.y + f.h);
      ctx.stroke();
      var html = ttTitle(this.dates[hoverIdx]);
      for (var s2 = 0; s2 < this.series.length; s2++) {
        var val = this.series[s2].data[hoverIdx];
        html += ttRow(this.series[s2].name,
          val == null ? "–" : (this.opts.tipFmt ? this.opts.tipFmt(val) : fmt.num(val)),
          val != null && this.opts.colorize ? (val >= 0 ? "up-tt" : "down-tt") : "");
      }
      tooltip(html, this._client.x, this._client.y);
    }

    if (this.opts.legend !== false) {
      this.legend(ctx, f, this.series.map(function (s3) {
        return { label: s3.name, color: s3.color };
      }));
    }
  };

  /* ============================ CandleChart =========================== */
  /* data: { dates, ohlcv (flat [o,h,l,c,v]*n), mas: [{name, window, color}],
            ticker, name }                                              */
  function CandleChart(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.pad = { l: 56, r: 58, t: 14, b: 26 };
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
  CandleChart.prototype = Object.create(BaseChart);

  CandleChart.prototype.setData = function (data) {
    this.data = data;
    this.draw();
  };

  CandleChart.prototype._ma = function (closes, window) {
    var out = [];
    var sum = 0;
    for (var i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= window) sum -= closes[i - window];
      out.push(i >= window - 1 ? sum / window : null);
    }
    return out;
  };

  CandleChart.prototype.draw = function (hoverOnly) {
    var ctx = this.begin();
    if (!ctx || !this.data) return;
    var d = this.data;
    var n = d.dates.length;
    if (!n) return;
    var f = this.frame();
    var volH = Math.round(f.h * 0.22);
    var priceH = f.h - volH - 14;
    var pf = { x: f.x, y: f.y, w: f.w, h: priceH };
    var vf = { x: f.x, y: f.y + priceH + 14, w: f.w, h: volH };
    var self = this;

    // unpack ohlcv
    var o = [], h = [], l = [], c = [], v = [];
    for (var i = 0; i < n; i++) {
      var b = i * 5;
      o.push(d.ohlcv[b]); h.push(d.ohlcv[b + 1]); l.push(d.ohlcv[b + 2]);
      c.push(d.ohlcv[b + 3]); v.push(d.ohlcv[b + 4]);
    }
    var maSeries = [];
    for (var m = 0; m < (d.mas || []).length; m++) {
      maSeries.push({ name: d.mas[m].name, color: d.mas[m].color, data: this._ma(c, d.mas[m].window) });
    }

    var lo = Infinity, hi = -Infinity, vmax = 0;
    for (i = 0; i < n; i++) {
      if (l[i] != null) lo = Math.min(lo, l[i]);
      if (h[i] != null) hi = Math.max(hi, h[i]);
      if (v[i] != null) vmax = Math.max(vmax, v[i]);
    }
    for (m = 0; m < maSeries.length; m++) {
      for (i = 0; i < n; i++) {
        var mv = maSeries[m].data[i];
        if (mv != null) { lo = Math.min(lo, mv); hi = Math.max(hi, mv); }
      }
    }
    var pad = (hi - lo) * 0.07;
    lo -= pad; hi += pad;

    var mapY = function (val) { return pf.y + pf.h - ((val - lo) / (hi - lo)) * pf.h; };
    var mapVY = function (val) { return vf.y + vf.h - (val / (vmax || 1)) * vf.h; };

    // price grid + right-side price axis
    this.gridAndAxes(ctx, pf, niceTicks(lo, hi, 5), 0, mapY, function (t) { return fmt.num(t, hi > 500 ? 0 : 2); });
    ctx.fillStyle = C.dim;
    ctx.font = "10.5px " + FONT_MONO;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var volTicks = niceTicks(0, vmax, 2);
    ctx.fillText("Vol " + fmt.compact(vmax), vf.x + 6, vf.y + 7);

    this.xDateLabels(ctx, f, d.dates, 7);

    // hover index
    var hoverIdx = -1;
    if (hoverOnly && this._mx != null && this._mx >= f.x && this._mx <= f.x + f.w) {
      hoverIdx = Math.round(((this._mx - f.x) / f.w) * (n - 1));
      hoverIdx = clamp(hoverIdx, 0, n - 1);
    }

    // last price line
    if (c[n - 1] != null) {
      var ly = mapY(c[n - 1]);
      ctx.strokeStyle = c[n - 1] >= (o[n - 1] || c[n - 1]) ? "rgba(52,211,153,0.5)" : "rgba(251,113,133,0.5)";
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(f.x, ly + 0.5);
      ctx.lineTo(f.x + f.w, ly + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      // price tag on right gutter
      ctx.fillStyle = c[n - 1] >= (o[n - 1] || 0) ? C.up : C.down;
      ctx.fillRect(f.x + f.w + 2, ly - 9, this.pad.r - 6, 18);
      ctx.fillStyle = "#06121a";
      ctx.font = "bold 10.5px " + FONT_MONO;
      ctx.textAlign = "center";
      ctx.fillText(fmt.num(c[n - 1], 2), f.x + f.w + 2 + (this.pad.r - 6) / 2, ly);
    }

    // candles
    var cw = Math.max(1.5, Math.min(13, (f.w / n) * 0.72));
    for (i = 0; i < n; i++) {
      if (c[i] == null) continue;
      var x = f.x + ((i + 0.5) / n) * f.w;
      var up = c[i] >= o[i];
      var col = up ? C.up : C.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      // wick
      ctx.beginPath();
      ctx.moveTo(x, mapY(h[i]));
      ctx.lineTo(x, mapY(l[i]));
      ctx.stroke();
      // body
      var yTop = mapY(Math.max(o[i], c[i]));
      var yBot = mapY(Math.min(o[i], c[i]));
      var bh = Math.max(1, yBot - yTop);
      if (up) {
        ctx.globalAlpha = 0.92;
        ctx.fillRect(x - cw / 2, yTop, cw, bh);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillRect(x - cw / 2, yTop, cw, bh);
      }
      // volume
      var vx = x, vw = Math.max(1, cw * 0.8);
      ctx.globalAlpha = 0.45;
      ctx.fillRect(vx - vw / 2, mapVY(v[i]), vw, vf.y + vf.h - mapVY(v[i]));
      ctx.globalAlpha = 1;
    }

    // moving averages
    for (m = 0; m < maSeries.length; m++) {
      ctx.strokeStyle = maSeries[m].color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      var st = false;
      for (i = 0; i < n; i++) {
        var val2 = maSeries[m].data[i];
        if (val2 == null) { st = false; continue; }
        var px2 = f.x + ((i + 0.5) / n) * f.w;
        var py2 = mapY(val2);
        if (!st) { ctx.moveTo(px2, py2); st = true; } else ctx.lineTo(px2, py2);
      }
      ctx.stroke();
    }

    // crosshair + tooltip
    if (hoverIdx >= 0) {
      var hxx = f.x + ((hoverIdx + 0.5) / n) * f.w;
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hxx + 0.5, f.y);
      ctx.lineTo(hxx + 0.5, f.y + f.h);
      ctx.stroke();
      var chg = o[hoverIdx] != null ? c[hoverIdx] / o[hoverIdx] - 1 : null;
      var html = ttTitle(d.ticker + " · " + d.dates[hoverIdx]);
      html += ttRow("Open", fmt.num(o[hoverIdx]));
      html += ttRow("High", fmt.num(h[hoverIdx]));
      html += ttRow("Low", fmt.num(l[hoverIdx]));
      html += ttRow("Close", fmt.num(c[hoverIdx]), chg >= 0 ? "up-tt" : "down-tt");
      html += ttRow("Change", fmt.pct(chg), chg >= 0 ? "up-tt" : "down-tt");
      html += ttRow("Volume", v[hoverIdx] == null ? "–" : fmt.compact(v[hoverIdx] * 1000));
      for (m = 0; m < maSeries.length; m++) {
        html += ttRow(maSeries[m].name, fmt.num(maSeries[m].data[hoverIdx]));
      }
      tooltip(html, this._client.x, this._client.y);
    }

    this.legend(ctx, pf, (d.mas || []).map(function (mm) {
      return { label: mm.name, color: mm.color };
    }));
    void self;
  };

  /* ============================ BarChartH ============================= */
  /* data: { items: [{label, value, meta}], valueFmt, colorize, title } */
  function BarChartH(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.pad = { l: 10, r: 52, t: 10, b: 24 };
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

  BarChartH.prototype.setData = function (data) {
    this.data = data;
    this.draw();
  };

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

    // zero axis
    ctx.strokeStyle = C.axis;
    ctx.beginPath();
    ctx.moveTo(zeroX + 0.5, f2.y);
    ctx.lineTo(zeroX + 0.5, f2.y + f2.h);
    ctx.stroke();

    // x ticks
    ctx.fillStyle = C.dim;
    ctx.font = "10px " + FONT_MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xticks = niceTicks(-mag, mag, 4);
    for (i = 0; i < xticks.length; i++) {
      var tx = mapX(xticks[i]);
      ctx.fillText(vf(xticks[i]), tx, f2.y + f2.h + 6);
    }

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
      // rounded bar
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
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // labels
      ctx.globalAlpha = 1;
      ctx.font = (isHover ? "bold " : "") + "10.5px " + FONT_MONO;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = isHover ? C.text : C.dim;
      ctx.fillText(it.label, f2.x - 8, y + barH / 2);
      // value tag
      ctx.textAlign = "left";
      var tagX = mapX(it.value) + (it.value >= 0 ? 6 : -6);
      ctx.textAlign = it.value >= 0 ? "left" : "right";
      ctx.fillStyle = C.faint;
      ctx.fillText(vf(it.value), tagX, y + barH / 2);
    }

    if (hoverIdx >= 0) {
      var hv = items[hoverIdx];
      var html = ttTitle(hv.label + (hv.name ? " · " + hv.name : ""));
      if (hv.tipRows) {
        for (var r = 0; r < hv.tipRows.length; r++) {
          html += ttRow(hv.tipRows[r][0], hv.tipRows[r][1]);
        }
      } else {
        html += ttRow("Value", vf(hv.value));
      }
      tooltip(html, this._client.x, this._client.y);
    }
  };

  /* ============================ ICChart =============================== */
  /* data: { labels, ic, cum } — monthly IC bars + cumulative IC line    */
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

  ICChart.prototype.setData = function (data) {
    this.data = data;
    this.draw();
  };

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
    var cumPad = (cumHi - cumLo) * 0.08;
    cumLo -= cumPad; cumHi += cumPad;

    var mapY = function (v) { return f.y + f.h - ((v - icLo) / (icHi - icLo)) * f.h; };
    var mapY2 = function (v) { return f.y + f.h - ((v - cumLo) / (cumHi - cumLo)) * f.h; };
    var mapX = function (idx) { return f.x + ((idx + 0.5) / n) * f.w; };

    // grid (left axis = IC)
    this.gridAndAxes(ctx, f, niceTicks(icLo, icHi, 4), 0, mapY, function (t) { return t.toFixed(2); });
    // right axis labels (cumulative)
    ctx.fillStyle = C.violet;
    ctx.font = "10.5px " + FONT_MONO;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var cts = niceTicks(cumLo, cumHi, 4);
    for (i = 0; i < cts.length; i++) {
      ctx.fillText(cts[i].toFixed(1), f.x + f.w + 8, mapY2(cts[i]));
    }

    // x labels (years)
    ctx.fillStyle = C.dim;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var lastYear = "";
    for (i = 0; i < n; i += Math.max(1, Math.floor(n / 12))) {
      var yr = d.labels[i].slice(0, 4);
      if (yr !== lastYear) {
        ctx.fillText(yr, mapX(i), f.y + f.h + 8);
        lastYear = yr;
      }
    }

    // zero line
    var zy = mapY(0);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(f.x, zy + 0.5);
    ctx.lineTo(f.x + f.w, zy + 0.5);
    ctx.stroke();

    // bars
    var bw = Math.max(1, Math.min(7, (f.w / n) * 0.7));
    for (i = 0; i < n; i++) {
      if (d.ic[i] == null) continue;
      var x = mapX(i);
      var y0 = mapY(Math.max(0, d.ic[i]));
      var y1 = mapY(Math.min(0, d.ic[i]));
      ctx.fillStyle = d.ic[i] >= 0 ? "rgba(34,211,238,0.75)" : "rgba(251,113,133,0.75)";
      ctx.fillRect(x - bw / 2, y0, bw, Math.max(1, y1 - y0));
    }

    // cumulative line
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

    // hover
    var hoverIdx = -1;
    if (hoverOnly && this._mx != null && this._mx >= f.x && this._mx <= f.x + f.w) {
      hoverIdx = clamp(Math.floor(((this._mx - f.x) / f.w) * n), 0, n - 1);
    }
    if (hoverIdx >= 0) {
      var hx = mapX(hoverIdx);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.moveTo(hx + 0.5, f.y);
      ctx.lineTo(hx + 0.5, f.y + f.h);
      ctx.stroke();
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
  /* data: { points:[{x,y,label,name,color,size}], xLabel, yLabel,
             regression, xFmt, yFmt }                                    */
  function ScatterChart(el, opts) {
    this.init(el);
    this.opts = opts || {};
    this.pad = { l: 56, r: 20, t: 14, b: 34 };
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

  ScatterChart.prototype.setData = function (data) {
    this.data = data;
    this.draw();
  };

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
    var self = this;
    var mapX = function (v) { return f.x + ((v - xlo) / (xhi - xlo)) * f.w; };
    var mapY = function (v) { return f.y + f.h - ((v - ylo) / (yhi - ylo)) * f.h; };
    var xF = d.xFmt || function (v) { return fmt.num(v, 2); };
    var yF = d.yFmt || function (v) { return fmt.num(v, 2); };

    this.gridAndAxes(ctx, f, niceTicks(ylo, yhi, 5), 0, mapY, function (t) { return yF(t); });

    // x ticks
    ctx.fillStyle = C.dim;
    ctx.font = "10.5px " + FONT_MONO;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    var xticks = niceTicks(xlo, xhi, 6);
    for (i = 0; i < xticks.length; i++) {
      ctx.fillText(xF(xticks[i]), mapX(xticks[i]), f.y + f.h + 8);
    }
    // axis titles
    if (d.xLabel) {
      ctx.fillStyle = C.faint;
      ctx.font = "10.5px " + FONT_UI;
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

    // zero lines if in range
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.setLineDash([4, 4]);
    if (xlo < 0 && xhi > 0) {
      ctx.beginPath(); ctx.moveTo(mapX(0) + 0.5, f.y); ctx.lineTo(mapX(0) + 0.5, f.y + f.h); ctx.stroke();
    }
    if (ylo < 0 && yhi > 0) {
      ctx.beginPath(); ctx.moveTo(f.x, mapY(0) + 0.5); ctx.lineTo(f.x + f.w, mapY(0) + 0.5); ctx.stroke();
    }
    ctx.setLineDash([]);

    // regression line
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

    // hover: nearest point
    var hoverIdx = -1, bestD = 18 * 18;
    if (hoverOnly && this._mx != null) {
      for (i = 0; i < pts.length; i++) {
        if (pts[i].x == null || pts[i].y == null) continue;
        var dx = mapX(pts[i].x) - this._mx, dy = mapY(pts[i].y) - this._my;
        var dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; hoverIdx = i; }
      }
    }

    // points
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
      if (isHover) {
        ctx.shadowColor = p.color || C.cyan;
        ctx.shadowBlur = 14;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      // label hot names
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
      if (hp.tipRows) {
        for (var r2 = 0; r2 < hp.tipRows.length; r2++) {
          html2 += ttRow(hp.tipRows[r2][0], hp.tipRows[r2][1]);
        }
      }
      tooltip(html2, this._client.x, this._client.y);
    }
    void self;
  };

  /* ============================ Heatmap =============================== */
  /* data: { mode:"corr", labels, matrix }
     or    { mode:"monthly", rows (years), cols (month names), matrix } */
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

  Heatmap.prototype.setData = function (data) {
    this.data = data;
    this.draw();
  };

  function corrColor(v) {
    // -1 -> warm red, 0 -> deep indigo, +1 -> cyan
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
    // monthly return: -8% red -> 0 dark -> +8% green
    var t = clamp(v / 0.08, -1, 1);
    if (t < 0) {
      var k = -t;
      return "rgba(251," + Math.round(113 + 60 * (1 - k)) + "," + Math.round(133 + 60 * (1 - k)) + "," + (0.25 + 0.7 * k).toFixed(2) + ")";
    }
    return "rgba(52," + Math.round(211 - 80 * (1 - t)) + "," + Math.round(153 - 60 * (1 - t)) + "," + (0.2 + 0.75 * t).toFixed(2) + ")";
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

    // hover cell
    var hovR = -1, hovC = -1;
    if (hoverOnly && this._mx != null && this._my != null) {
      var cx = Math.floor((this._mx - f.x) / cellW);
      var cy = Math.floor((this._my - f.y) / cellH);
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) { hovC = cx; hovR = cy; }
    }

    // labels
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

    // cells
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
        // value text in large cells
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
      if (isCorr) {
        html += ttRow("Correlation", hv == null ? "–" : hv.toFixed(3));
      } else {
        html += ttRow("Return", fmt.pct(hv), hv >= 0 ? "up-tt" : "down-tt");
      }
      tooltip(html, this._client.x, this._client.y);
    }
  };

  /* exports */
  window.AF = window.AF || {};
  window.AF.fmt = fmt;
  window.AF.colors = C;
  window.AF.SERIES8 = SERIES8;
  window.AF.util = { niceTicks: niceTicks, clamp: clamp, tooltip: tooltip, hideTooltip: hideTooltip, ttRow: ttRow, ttTitle: ttTitle, htmlEscape: htmlEscape };
  window.AF.BaseChart = BaseChart;
  window.AF.LineChart = LineChart;
  window.AF.CandleChart = CandleChart;
  window.AF.BarChartH = BarChartH;
  window.AF.ICChart = ICChart;
  window.AF.ScatterChart = ScatterChart;
  window.AF.Heatmap = Heatmap;
})();
