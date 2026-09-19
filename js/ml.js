/* ==========================================================================
   QuantPulse — machine-learning lab engine (from scratch, zero dependencies)
   --------------------------------------------------------------------------
   Cross-sectional return prediction on the 38-name universe:

     • 9 price/volume features computed from the merged close history
       (volume-trend is deliberately excluded: the bundle ships candle
       volume for the recent years only, and requiring it would cut the
       sample by two-thirds),
     • features are winsorised and z-scored cross-sectionally each month,
     • targets are the next 21 trading days' returns,
     • four models implemented from scratch on Float32Array maths:
         - Ridge regression      (closed form, Cholesky-style elimination)
         - Elastic Net           (coordinate descent down a lambda path)
         - Neural network (MLP)  (one hidden layer, ReLU, Adam, mini-batch)
         - Gradient boosting     (histogram regression trees, depth-limited)
       plus an equal-weight ensemble of the four,
     • PURGED WALK-FORWARD evaluation: at every month-end the model is
       retrained on the trailing window; training rows whose 21-day label
       has not fully realised before the test date are embargoed, so no
       label information can leak into a live prediction,
     • permutation feature importance measured out-of-sample on the last
       twelve test months.

   A seeded PRNG makes every run reproducible. All results are cached and
   invalidated when new sessions merge into the panel.
   ========================================================================== */
(function () {
  "use strict";

  var core = QP.core;
  var stats = core.stats;
  var spearman = stats.spearman, mean = stats.mean, std = stats.std;

  /* ------------------------------ seeded RNG --------------------------- */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var rng = mulberry32(20260919);
  function randInt(n) { return Math.floor(rng() * n); }

  /* ============================ features ================================ */
  var FEATURES = [
    { key: "mom_12_1", label: "Momentum 12-1" },
    { key: "mom_6m",   label: "Momentum 6M" },
    { key: "mom_3m",   label: "Momentum 3M" },
    { key: "rev_1m",   label: "1M Reversal" },
    { key: "low_vol20", label: "Low Vol 20D" },
    { key: "low_vol60", label: "Low Vol 60D" },
    { key: "rsi_14",   label: "RSI-14 (neg.)" },
    { key: "near_52w", label: "52W-High Proximity" },
    { key: "rel_1y",   label: "Relative Strength 1Y" },
  ];
  var FEAT_IDX = {};
  FEATURES.forEach(function (f, i) { FEAT_IDX[f.key] = i; });
  var D_FEATS = FEATURES.length;

  function retOverDays(i, back, t) {
    var S = core.state;
    var a = i >= back ? S.closeMat[i - back][t] : null;
    var b = S.closeMat[i][t];
    return a != null && b ? b / a - 1 : null;
  }
  function volOverDays(i, win, t) {
    var v = core.rollingVolAt(i, win, t);
    return v == null ? null : -v;                 // higher = quieter
  }
  function near52w(i, t) {
    var S = core.state;
    var cur = S.closeMat[i][t];
    if (cur == null) return null;
    var hi = -Infinity;
    for (var k = Math.max(0, i - 251); k <= i; k++) {
      var px = S.closeMat[k][t];
      if (px != null && px > hi) hi = px;
    }
    return isFinite(hi) && hi > 0 ? cur / hi - 1 : null;
  }

  /* raw features for one day index -> [ticker] value (nulls allowed) */
  var RAW_FNS = {
    mom_12_1: function (i) {
      var S = core.state, out = new Array(core.N);
      for (var t = 0; t < core.N; t++) {
        var a = i >= 252 ? S.closeMat[i - 252][t] : null;
        var b = i >= 21 ? S.closeMat[i - 21][t] : null;
        out[t] = a != null && b ? b / a - 1 : null;
      }
      return out;
    },
    mom_6m: function (i) {
      var out = new Array(core.N);
      for (var t = 0; t < core.N; t++) out[t] = retOverDays(i, 126, t);
      return out;
    },
    mom_3m: function (i) {
      var out = new Array(core.N);
      for (var t = 0; t < core.N; t++) out[t] = retOverDays(i, 63, t);
      return out;
    },
    rev_1m: function (i) {
      var out = new Array(core.N);
      for (var t = 0; t < core.N; t++) {
        var r = retOverDays(i, 21, t);
        out[t] = r == null ? null : -r;
      }
      return out;
    },
    low_vol20: function (i) {
      var out = new Array(core.N);
      for (var t = 0; t < core.N; t++) out[t] = volOverDays(i, 20, t);
      return out;
    },
    low_vol60: function (i) {
      var out = new Array(core.N);
      for (var t = 0; t < core.N; t++) out[t] = volOverDays(i, 60, t);
      return out;
    },
    rsi_14: function (i) {
      var out = new Array(core.N);
      for (var t = 0; t < core.N; t++) {
        var v = core.rsiCutlerAt(i, 14, t);
        out[t] = v == null ? null : -v;
      }
      return out;
    },
    near_52w: function (i) {
      var out = new Array(core.N);
      for (var t = 0; t < core.N; t++) out[t] = near52w(i, t);
      return out;
    },
    rel_1y: function (i) {
      var rs = [];
      for (var t = 0; t < core.N; t++) rs.push(retOverDays(i, 252, t));
      var m = mean(rs);
      return rs.map(function (r) { return r != null && m != null ? r - m : null; });
    },
  };

  function winsorZ(vals, minCount) {
    // winsorise at ±3 sigma, then cross-sectional z-score
    var ok = vals.filter(function (v) { return v != null && isFinite(v); });
    if (ok.length < minCount) return null;
    var m = mean(ok), sd = std(ok);
    if (!sd) return null;
    var lo = m - 3 * sd, hi = m + 3 * sd;
    return vals.map(function (v) {
      if (v == null || !isFinite(v)) return null;
      var c = Math.min(hi, Math.max(lo, v));
      return (c - m) / sd;
    });
  }

  /* ============================ dataset ================================= */
  /* month-end panel: for every usable month-end day index we store the
     z-scored feature matrix [ticker][feature] and the next-21d return.   */
  var dsCache = null;
  function dataset() {
    if (dsCache) return dsCache;
    var S = core.state, N = core.N, DAYS = core.DAYS();
    var months = [];
    var minCount = Math.floor(N * 0.75);
    for (var m = 0; m < S.monthEnds.length; m++) {
      var i = S.monthEnds[m];
      if (i < 260) continue;                          // need 252d + slack
      // features
      var X = [];                                     // [t][d]
      for (var t = 0; t < N; t++) X.push(new Array(D_FEATS));
      var colOK = true;
      for (var f = 0; f < D_FEATS; f++) {
        var z = winsorZ(RAW_FNS[FEATURES[f].key](i), minCount);
        if (!z) { colOK = false; break; }
        for (t = 0; t < N; t++) X[t][f] = z[t];
      }
      if (!colOK) continue;
      // target: next 21 trading days
      var y = new Array(N);
      var hasTarget = false;
      for (t = 0; t < N; t++) {
        var a = S.closeMat[i][t], b = i + 21 < DAYS ? S.closeMat[i + 21][t] : null;
        y[t] = a != null && b != null ? b / a - 1 : null;
        if (y[t] != null) hasTarget = true;
      }
      months.push({ i: i, label: core.D.dates[i].slice(0, 7), X: X, y: y, hasTarget: hasTarget });
    }
    dsCache = { months: months, d: D_FEATS };
    return dsCache;
  }

  /* flatten training rows from a set of months (purge already applied
     by the caller); returns {X: Float32Array(n*d), y: Float32Array(n),
     n, d} restricted to tickers with full features + known label       */
  function flattenRows(monthArr) {
    var N = core.N, d = D_FEATS;
    var rows = [];
    for (var k = 0; k < monthArr.length; k++) {
      var mo = monthArr[k];
      for (var t = 0; t < N; t++) {
        if (mo.y[t] == null) continue;
        var ok = true;
        for (var f = 0; f < d; f++) if (mo.X[t][f] == null) { ok = false; break; }
        if (!ok) continue;
        rows.push({ t: t, mo: mo });
      }
    }
    var n = rows.length;
    var X = new Float32Array(n * d), y = new Float32Array(n);
    for (var r = 0; r < n; r++) {
      var xr = rows[r].mo.X[rows[r].t];
      for (f = 0; f < d; f++) X[r * d + f] = xr[f];
      y[r] = rows[r].mo.y[rows[r].t];
    }
    return { X: X, y: y, n: n, d: d };
  }

  /* ============================= models ================================= */
  /* ---- Ridge regression (closed form) --------------------------------- */
  function solveLin(A, b, n) {
    // gaussian elimination with partial pivoting; A is n×n, modified in place
    var x = new Float64Array(n);
    for (var col = 0; col < n; col++) {
      var piv = col, best = Math.abs(A[col * n + col]);
      for (var r = col + 1; r < n; r++) {
        var v = Math.abs(A[r * n + col]);
        if (v > best) { best = v; piv = r; }
      }
      if (best < 1e-12) continue;
      if (piv !== col) {
        for (var c = 0; c < n; c++) { var tmp = A[col * n + c]; A[col * n + c] = A[piv * n + c]; A[piv * n + c] = tmp; }
        tmp = b[col]; b[col] = b[piv]; b[piv] = tmp;
      }
      var d = A[col * n + col];
      for (r = col + 1; r < n; r++) {
        var f = A[r * n + col] / d;
        if (!f) continue;
        for (c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
        b[r] -= f * b[col];
      }
    }
    for (var i = n - 1; i >= 0; i--) {
      var s = b[i];
      for (var j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
      x[i] = Math.abs(A[i * n + i]) < 1e-12 ? 0 : s / A[i * n + i];
    }
    return x;
  }

  function fitRidge(rows, opts) {
    var d = rows.d, n = rows.n;
    var lambda = (opts && opts.lambda) || 25;
    var A = new Float64Array(d * d), b = new Float64Array(d);
    var ym = 0;
    for (var i = 0; i < n; i++) ym += rows.y[i];
    ym /= n || 1;
    var X = rows.X, y = rows.y;
    for (i = 0; i < n; i++) {
      var yc = y[i] - ym, base = i * d;
      for (var j = 0; j < d; j++) {
        var xj = X[base + j];
        b[j] += xj * yc;
        for (var k = j; k < d; k++) A[j * d + k] += xj * X[base + k];
      }
    }
    for (j = 0; j < d; j++) {
      for (k = 0; k < j; k++) A[j * d + k] = A[k * d + j];
      A[j * d + j] += lambda;
    }
    var w = solveLin(A, b, d);
    return {
      kind: "ridge",
      predict: function (xrow) {
        var s = ym;
        for (var j = 0; j < d; j++) s += w[j] * xrow[j];
        return s;
      },
    };
  }

  /* ---- Elastic Net (coordinate descent down a lambda path) ------------ */
  function fitEnet(rows, opts) {
    var d = rows.d, n = rows.n;
    var alpha = (opts && opts.alpha) != null ? opts.alpha : 0.5;
    var X = rows.X, y = rows.y;
    // column scaling (features are ~N(0,1) but be safe)
    var mu = new Float64Array(d), sd = new Float64Array(d), ym = 0;
    for (var i = 0; i < n; i++) ym += y[i];
    ym /= n || 1;
    for (var j = 0; j < d; j++) {
      var s = 0;
      for (i = 0; i < n; i++) s += X[i * d + j];
      mu[j] = s / n;
      var s2 = 0;
      for (i = 0; i < n; i++) { var dv = X[i * d + j] - mu[j]; s2 += dv * dv; }
      sd[j] = Math.sqrt(s2 / (n || 1)) || 1;
    }
    var Z = new Float64Array(n * d), yc = new Float64Array(n);
    for (i = 0; i < n; i++) {
      yc[i] = y[i] - ym;
      for (j = 0; j < d; j++) Z[i * d + j] = (X[i * d + j] - mu[j]) / sd[j];
    }
    // lambda path
    var lamMax = 0;
    for (j = 0; j < d; j++) {
      var dot = 0;
      for (i = 0; i < n; i++) dot += Z[i * d + j] * yc[i];
      lamMax = Math.max(lamMax, Math.abs(dot) / (n || 1));
    }
    if (!(lamMax > 0)) lamMax = 1e-4;
    var w = new Float64Array(d);
    var r = new Float64Array(n);                       // residual y - Zw
    for (i = 0; i < n; i++) r[i] = yc[i];
    var path = [];
    for (var p = 0; p < 15; p++) path.push(lamMax * (0.72 * (1 - p / 15) + 0.05));
    for (p = 0; p < path.length; p++) {
      var lam = path[p];
      for (var sweep = 0; sweep < 40; sweep++) {
        var maxDelta = 0;
        for (j = 0; j < d; j++) {
          var rho = 0, z2 = 0;
          for (i = 0; i < n; i++) { var zj = Z[i * d + j]; rho += zj * (r[i] + zj * w[j]); z2 += zj * zj; }
          var denom = z2 / (n || 1) + lam * (1 - alpha);
          var raw = rho / (n || 1);
          var wj = Math.abs(raw) <= lam * alpha ? 0 : (raw - Math.sign(raw) * lam * alpha) / denom;
          var dw = wj - w[j];
          if (dw) {
            for (i = 0; i < n; i++) r[i] -= dw * Z[i * d + j];
            w[j] = wj;
            if (Math.abs(dw) > maxDelta) maxDelta = Math.abs(dw);
          }
        }
        if (maxDelta < 1e-7) break;
      }
    }
    return {
      kind: "enet",
      predict: function (xrow) {
        var s = ym;
        for (var j = 0; j < d; j++) s += (w[j] / sd[j]) * (xrow[j] - mu[j]);
        return s;
      },
    };
  }

  /* ---- Neural network: d -> h(ReLU) -> 1, Adam ------------------------ */
  function fitMLP(rows, opts) {
    var d = rows.d, n = rows.n;
    var H = (opts && opts.hidden) || 8;
    var EPOCHS = (opts && opts.epochs) || 90;
    var BATCH = (opts && opts.batch) || 128;
    var LR = 0.012, L2 = 1e-4;
    var X = rows.X, y = rows.y;
    // standardise target
    var ym = 0;
    for (var i = 0; i < n; i++) ym += y[i];
    ym /= n || 1;
    var ys = 0;
    for (i = 0; i < n; i++) { var dv0 = y[i] - ym; ys += dv0 * dv0; }
    var ysd = Math.sqrt(ys / (n || 1)) || 1;
    var T = new Float32Array(n);
    for (i = 0; i < n; i++) T[i] = (y[i] - ym) / ysd;

    var W1 = new Float32Array(H * d), b1 = new Float32Array(H);
    var W2 = new Float32Array(H), b2 = 0;
    for (i = 0; i < H * d; i++) W1[i] = (rng() * 2 - 1) * Math.sqrt(2 / d);
    for (i = 0; i < H; i++) { W2[i] = (rng() * 2 - 1) / Math.sqrt(H); b1[i] = 0; }

    var nP = H * d + H + H + 1;
    var mAdam = new Float32Array(nP), vAdam = new Float32Array(nP);
    var gW1 = new Float32Array(H * d), gb1 = new Float32Array(H), gW2 = new Float32Array(H);
    var hid = new Float32Array(H), hidP = new Float32Array(H);
    var order = [];
    for (i = 0; i < n; i++) order.push(i);
    var tAdam = 0;
    var OFF = { w1: 0, b1: H * d, w2: H * d + H, b2: H * d + H + H };

    function upd(arr, gArr, len, off, scale, noL2) {
      for (var q = 0; q < len; q++) {
        var g = gArr[q] / scale + (noL2 ? 0 : L2 * arr[q]);
        var mi = off + q;
        mAdam[mi] = 0.9 * mAdam[mi] + 0.1 * g;
        vAdam[mi] = 0.999 * vAdam[mi] + 0.001 * g * g;
        arr[q] -= lrT * mAdam[mi] / (Math.sqrt(vAdam[mi]) + 1e-8);
      }
    }
    var b2Box = [0], gb2Box = [0], lrT = 0;

    for (var ep = 0; ep < EPOCHS; ep++) {
      // seeded shuffle
      for (i = n - 1; i > 0; i--) { var jx = randInt(i + 1); var tv = order[i]; order[i] = order[jx]; order[jx] = tv; }
      for (var start = 0; start < n; start += BATCH) {
        var bn = Math.min(BATCH, n - start);
        gW1.fill(0); gb1.fill(0); gW2.fill(0); gb2Box[0] = 0;
        for (var bi = 0; bi < bn; bi++) {
          var r = order[start + bi], base = r * d;
          // forward
          for (var h = 0; h < H; h++) {
            var s = b1[h];
            for (var f2 = 0; f2 < d; f2++) s += W1[h * d + f2] * X[base + f2];
            hid[h] = s > 0 ? s : 0; hidP[h] = s;       // activation + pre-activation
          }
          var out = b2;
          for (h = 0; h < H; h++) out += W2[h] * hid[h];
          var err = out - T[r];
          // backward
          for (h = 0; h < H; h++) {
            var g2 = err * W2[h] * (hidP[h] > 0 ? 1 : 0);
            gW2[h] += err * hid[h];
            gb1[h] += g2;
            var w1b = h * d;
            for (f2 = 0; f2 < d; f2++) gW1[w1b + f2] += g2 * X[base + f2];
          }
          gb2Box[0] += err;
        }
        // adam step
        tAdam++;
        lrT = LR * Math.sqrt(1 - Math.pow(0.999, tAdam)) / (1 - Math.pow(0.9, tAdam));
        upd(W1, gW1, H * d, OFF.w1, bn, false);
        upd(b1, gb1, H, OFF.b1, bn, false);
        upd(W2, gW2, H, OFF.w2, bn, false);
        upd(b2Box, gb2Box, 1, OFF.b2, bn, true);
        b2 = b2Box[0];
      }
    }
    return {
      kind: "mlp",
      predict: function (xrow) {
        var s2 = 0;
        for (var h = 0; h < H; h++) {
          var s = b1[h];
          for (var f2 = 0; f2 < d; f2++) s += W1[h * d + f2] * xrow[f2];
          var a = s > 0 ? s : 0;
          s2 += W2[h] * a;
        }
        return (s2 + b2) * ysd + ym;                   // de-standardise
      },
    };
  }

  /* ---- Gradient boosting (histogram regression trees) ----------------- */
  function fitGBM(rows, opts) {
    var d = rows.d, n = rows.n;
    var NTREES = (opts && opts.trees) || 60;
    var LR_ = 0.08, MAXDEPTH = 3, MINLEAF = Math.max(24, Math.floor(n * 0.02));
    var BINS = 24, SUB = 0.8;
    var X = rows.X, y = rows.y;
    // quantile bin edges per feature
    var edges = [];
    for (var j = 0; j < d; j++) {
      var col = [];
      for (var i = 0; i < n; i++) col.push(X[i * d + j]);
      col.sort(function (a, b) { return a - b; });
      var e = [];
      for (var q = 1; q < BINS; q++) e.push(col[Math.floor(q * n / BINS)]);
      edges.push(e);
    }
    // bin the matrix once
    var B = new Uint8Array(n * d);
    for (i = 0; i < n; i++) {
      for (j = 0; j < d; j++) {
        var v = X[i * d + j], b = 0;
        var ej = edges[j];
        while (b < ej.length && v > ej[b]) b++;
        B[i * d + j] = b;
      }
    }
    var ym = 0;
    for (i = 0; i < n; i++) ym += y[i];
    ym /= n || 1;
    var pred = new Float64Array(n).fill(ym);
    var resid = new Float64Array(n);
    for (i = 0; i < n; i++) resid[i] = y[i] - ym;
    var trees = [];
    var gain = new Float64Array(d);

    function buildNode(rowIdx, depth) {
      // histogram split search
      var best = null;
      var totR = 0, totC = 0;
      for (var q = 0; q < rowIdx.length; q++) { totR += resid[rowIdx[q]]; totC++; }
      var parentScore = totR * totR / (totC || 1);
      for (var f = 0; f < d; f++) {
        var cnt = new Int32Array(BINS + 1), sum = new Float64Array(BINS + 1);
        for (q = 0; q < rowIdx.length; q++) {
          var r0 = rowIdx[q];
          var b = B[r0 * d + f];
          cnt[b]++; sum[b] += resid[r0];
        }
        var cl = 0, rl = 0;
        for (b = 0; b < BINS; b++) {
          cl += cnt[b]; rl += sum[b];
          var cr = totC - cl, rr = totR - rl;
          if (cl < MINLEAF || cr < MINLEAF) continue;
          var sc = rl * rl / cl + rr * rr / cr;
          if (!best || sc > best.score) {
            best = { score: sc, feat: f, bin: b, gainV: sc - parentScore };
          }
        }
      }
      if (!best || depth >= MAXDEPTH) {
        return { leaf: true, value: totR / (totC || 1) };
      }
      var left = [], right = [];
      for (q = 0; q < rowIdx.length; q++) {
        var r1 = rowIdx[q];
        (B[r1 * d + best.feat] <= best.bin ? left : right).push(r1);
      }
      if (!left.length || !right.length) return { leaf: true, value: totR / (totC || 1) };
      gain[best.feat] += best.gainV;
      return {
        leaf: false, feat: best.feat, bin: best.bin,
        left: buildNode(left, depth + 1), right: buildNode(right, depth + 1),
      };
    }
    function treePredictFlat(node, X, base) {
      while (!node.leaf) node = X[base + node.feat] > node.bin ? node.right : node.left;
      return node.value;
    }
    function treePredictRow(node, xrow) {
      while (!node.leaf) node = xrow[node.feat] > node.bin ? node.right : node.left;
      return node.value;
    }

    var subN = Math.floor(n * SUB);
    for (var tr = 0; tr < NTREES; tr++) {
      var rowIdx = [];
      for (i = 0; i < subN; i++) rowIdx.push(randInt(n));
      var root = buildNode(rowIdx, 0);
      trees.push(root);
      for (i = 0; i < n; i++) {
        var p = LR_ * treePredictFlat(root, X, i * d);
        pred[i] += p;
        resid[i] -= p;
      }
    }
    return {
      kind: "gbm",
      predict: function (xrow) {
        var s = ym;
        for (var t2 = 0; t2 < trees.length; t2++) s += LR_ * treePredictRow(trees[t2], xrow);
        return s;
      },
      gain: gain,
    };
  }

  /* ====================== walk-forward evaluation ======================= */
  var MODEL_KEYS = ["ridge", "enet", "mlp", "gbm"];
  var MODEL_LABELS = {
    ridge: "Ridge Regression", enet: "Elastic Net", mlp: "Neural Net (MLP)",
    gbm: "Gradient Boosting", ensemble: "Ensemble (all four)", composite: "Composite (7-factor)",
  };
  var FITTERS = { ridge: fitRidge, enet: fitEnet, mlp: fitMLP, gbm: fitGBM };

  var resultCache = {};
  var runToken = 0;

  function invalidate() {
    dsCache = null;
    resultCache = {};
  }

  /* which models must be fitted for the requested selection? */
  function requiredFits(sel) {
    if (sel === "all" || sel === "ensemble") return MODEL_KEYS.slice();
    return [sel];
  }
  function produced(sel) {
    var out = requiredFits(sel).slice();
    if (sel === "all" || sel === "ensemble") out.push("ensemble");
    out.push("composite");
    return out;
  }

  function zscoreArr(a) {
    var ok = [];
    for (var i = 0; i < a.length; i++) if (a[i] != null && isFinite(a[i])) ok.push(a[i]);
    var m = mean(ok), sd = std(ok);
    if (!sd) sd = 1;
    return a.map(function (v) { return v != null && isFinite(v) ? (v - m) / sd : null; });
  }

  function summarizeIC(labels, icArr) {
    var vals = [];
    for (var i = 0; i < icArr.length; i++) if (icArr[i] != null && isFinite(icArr[i])) vals.push(icArr[i]);
    var mn = mean(vals), sd = std(vals);
    var cum = [], run = 0;
    for (i = 0; i < icArr.length; i++) {
      if (icArr[i] == null) { cum.push(null); continue; }
      run += icArr[i]; cum.push(run);
    }
    return {
      labels: labels, ic: icArr, cum: cum,
      summary: {
        mean: mn, std: sd,
        ir: sd ? mn / sd : null,
        tstat: sd && vals.length ? mn / (sd / Math.sqrt(vals.length)) : null,
        hit: vals.length ? vals.filter(function (v) { return v > 0; }).length / vals.length : null,
        n: vals.length,
      },
    };
  }

  function quintilesFromPreds(predsByMonth, monthsMeta) {
    var sums = [0, 0, 0, 0, 0], cnts = [0, 0, 0, 0, 0];
    predsByMonth.forEach(function (pm) {
      var items = [];
      for (var t = 0; t < core.N; t++) {
        if (pm.pred[t] != null && pm.y[t] != null) items.push({ s: pm.pred[t], r: pm.y[t] });
      }
      if (items.length < 10) return;
      items.sort(function (a, b) { return b.s - a.s; });
      var q = Math.floor(items.length / 5);
      for (var k = 0; k < items.length; k++) {
        var qi = Math.min(4, Math.floor(k / q));
        sums[qi] += items[k].r; cnts[qi]++;
      }
    });
    return sums.map(function (s, qi) {
      return { q: qi + 1, meanMonthly: cnts[qi] ? s / cnts[qi] : null, n: cnts[qi] };
    });
  }

  /* cfg: {model, trainMonths, onProgress, onDone}                        */
  function run(cfg) {
    var sel = cfg.model || "ridge";
    var trainMonths = cfg.trainMonths || 60;
    var cacheKey = sel + "|" + trainMonths;
    if (resultCache[cacheKey]) { cfg.onDone(resultCache[cacheKey]); return { cancel: function () {} }; }

    var token = ++runToken;
    rng = mulberry32(20260919);                       // reset: every run is reproducible
    var ds = dataset();
    var months = ds.months;
    if (months.length < trainMonths + 14) {
      cfg.onDone({ error: "Not enough history for a " + trainMonths + "-month training window." });
      return { cancel: function () {} };
    }

    // test months: k such that at least `trainMonths` training months with
    // realised labels exist strictly before the test date (purged).
    var testKs = [];
    for (var k = 0; k < months.length; k++) {
      var Ti = months[k].i;
      var usable = 0, cutoff = 0;
      for (var j = k - 1; j >= 0; j--) {
        if (months[j].i + 21 <= Ti && months[j].hasTarget) {
          usable++;
          if (usable === 1) cutoff = j;
          if (usable >= trainMonths) break;
        }
      }
      if (usable >= trainMonths) testKs.push(k);
    }
    if (testKs.length < 12) {
      cfg.onDone({ error: "Walk-forward leaves fewer than 12 test months — pick a shorter training window." });
      return { cancel: function () {} };
    }

    var fits = requiredFits(sel);
    var outputs = produced(sel);
    var preds = {}; outputs.forEach(function (m) { preds[m] = {}; });
    var latestFits = {}; fits.forEach(function (m) { latestFits[m] = []; });
    var ms0 = (typeof performance !== "undefined" ? performance.now() : Date.now());

    var pos = 0;
    function step() {
      if (token !== runToken) return;                  // superseded
      var t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
      while (pos < testKs.length) {
        var k = testKs[pos];
        var mo = months[k], Ti = mo.i;
        // training window (purged)
        var window = [];
        for (var j = k - 1; j >= 0; j--) {
          if (months[j].i + 21 <= Ti && months[j].hasTarget) {
            window.push(months[j]);
            if (window.length >= trainMonths) break;
          }
        }
        var rows = flattenRows(window);
        var fitted = {};
        fits.forEach(function (mk) {
          try { fitted[mk] = FITTERS[mk](rows, {}); } catch (e) { fitted[mk] = null; }
        });
        // per-model predictions for this test month
        var zAcc = new Array(core.N).fill(0), zCnt = new Array(core.N).fill(0);
        fits.forEach(function (mk) {
          var p = new Array(core.N).fill(null);
          if (fitted[mk]) {
            for (var t = 0; t < core.N; t++) {
              var xr = mo.X[t], ok = true;
              for (var f = 0; f < ds.d; f++) if (xr[f] == null) { ok = false; break; }
              if (!ok) continue;
              var v = fitted[mk].predict(xr);
              if (v != null && isFinite(v)) p[t] = v;
            }
          }
          preds[mk][k] = p;
          var zp = zscoreArr(p);
          for (t = 0; t < core.N; t++) {
            if (zp[t] != null) { zAcc[t] += zp[t]; zCnt[t]++; }
          }
          // keep the last 12 fits for OOS permutation importance
          latestFits[mk].push({ k: k, fit: fitted[mk] });
          if (latestFits[mk].length > 12) latestFits[mk].shift();
        });
        if (preds.ensemble) {
          var pe = new Array(core.N).fill(null);
          for (var t2 = 0; t2 < core.N; t2++) {
            pe[t2] = zCnt[t2] === fits.length ? zAcc[t2] / zCnt[t2] : null;
          }
          preds.ensemble[k] = pe;
        }
        preds.composite[k] = core.scoresFor("composite", Ti);

        pos++;
        var now = (typeof performance !== "undefined" ? performance.now() : Date.now());
        if (now - t0 > 60 && pos < testKs.length) {    // yield to the UI
          if (cfg.onProgress) cfg.onProgress(pos / testKs.length);
          setTimeout(step, 0);
          return;
        }
      }
      if (cfg.onProgress) cfg.onProgress(1);
      finish();
    }

    function finish() {
      var ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - ms0;
      var labels = [], byModel = {};
      outputs.forEach(function (m) { byModel[m] = { ic: [], predByMonth: [] }; });
      testKs.forEach(function (k) {
        var mo = months[k];
        labels.push(mo.label);
        outputs.forEach(function (m) {
          byModel[m].predByMonth.push({ pred: preds[m][k], y: mo.y });
          var ic = mo.hasTarget ? spearman(preds[m][k], mo.y) : null;
          byModel[m].ic.push(ic);
        });
      });
      var res = {
        model: sel, trainMonths: trainMonths, testKs: testKs, ms: ms,
        firstTestIdx: months[testKs[0]].i,
        lastTestIdx: months[testKs[testKs.length - 1]].i,
        predLookup: preds,                             // model -> k -> [N]
        testMonthIdx: testKs.map(function (k) { return months[k].i; }),
        perModel: {},
      };
      outputs.forEach(function (m) {
        var q = quintilesFromPreds(byModel[m].predByMonth, months);
        byModel[m].quintiles = q;
        byModel[m].icData = summarizeIC(labels, byModel[m].ic);
        res.perModel[m] = byModel[m];
      });
      // OOS permutation importance for fitted models (last 12 test months)
      res.importance = {};
      var importSel = (sel === "all" || sel === "ensemble") ? MODEL_KEYS : [sel];
      importSel.forEach(function (mk) {
        try {
          res.importance[mk] = permutationImportance(ds, latestFits[mk], preds, mk);
        } catch (e) { res.importance[mk] = null; }
      });
      if (sel === "all" || sel === "ensemble") {
        // ensemble importance needs all four fits per month — approximate by
        // averaging the four models' importance vectors
        var acc = {};
        MODEL_KEYS.forEach(function (mk) {
          (res.importance[mk] || []).forEach(function (it) {
            acc[it.key] = (acc[it.key] || 0) + it.value;
          });
        });
        res.importance.ensemble = Object.keys(acc).map(function (key) {
          var fi = FEAT_IDX[key];
          return {
            key: key,
            label: fi != null ? FEATURES[fi].label : key,   // keep labels for the chart
            value: acc[key] / MODEL_KEYS.length,
          };
        }).sort(function (a, b) { return b.value - a.value; });
      }
      resultCache[cacheKey] = res;
      cfg.onDone(res);
    }

    setTimeout(step, 0);
    return {
      cancel: function () { if (token === runToken) runToken++; },
    };
  }

  /* -------- OOS permutation importance (last 12 test months) ---------- */
  function permutationImportance(ds, stored, preds, modelKey) {
    if (!stored || stored.length < 3) return null;
    var d = ds.d, SHUF = 8;
    var acc = new Array(d).fill(0), accN = 0;
    stored.forEach(function (st) {
      if (!st.fit) return;
      var mo = ds.months[st.k];
      if (!mo.hasTarget) return;
      var base = spearman(preds[modelKey][st.k], mo.y);
      if (base == null) return;
      for (var f = 0; f < d; f++) {
        var drops = [];
        for (var s = 0; s < SHUF; s++) {
          var cols = [];
          for (var t = 0; t < core.N; t++) {
            var xr = mo.X[t].slice();
            if (xr[f] == null) { cols.push(null); continue; }
            cols.push(xr);
          }
          // shuffle non-null entries of feature f
          var idxs = [];
          for (t = 0; t < core.N; t++) if (cols[t] && cols[t][f] != null) idxs.push(t);
          for (var a = idxs.length - 1; a > 0; a--) {
            var b = randInt(a + 1);
            var tv = cols[idxs[a]][f];
            cols[idxs[a]][f] = cols[idxs[b]][f];
            cols[idxs[b]][f] = tv;
          }
          var p = new Array(core.N).fill(null);
          for (t = 0; t < core.N; t++) {
            if (!cols[t]) continue;
            var ok = true;
            for (var f2 = 0; f2 < d; f2++) if (cols[t][f2] == null) { ok = false; break; }
            if (!ok) continue;
            var v = st.fit.predict(cols[t]);
            if (v != null && isFinite(v)) p[t] = v;
          }
          var ic = spearman(p, mo.y);
          if (ic != null) drops.push(base - ic);
        }
        if (drops.length) acc[f] += Math.max(0, mean(drops));
      }
      accN++;
    });
    if (!accN) return null;
    return acc.map(function (v, f) {
      return { key: FEATURES[f].key, label: FEATURES[f].label, value: v / accN };
    }).sort(function (a, b) { return b.value - a.value; });
  }

  /* ---------- backtest bridge ------------------------------------------ */
  /* Returns signalFn(dayIdx) backed by the walk-forward predictions of
     `modelKey`: the scores from the latest month-end at or before dayIdx. */
  function signalFnFor(res, modelKey) {
    var idx = res.testMonthIdx;                        // ascending day indices
    var preds = res.predLookup[modelKey];
    var ks = res.testKs;
    return function (dayIdx) {
      var lo = 0, hi = idx.length - 1, best = -1;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (idx[mid] <= dayIdx) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (best < 0) return new Array(core.N).fill(null);
      return preds[ks[best]] || new Array(core.N).fill(null);
    };
  }

  /* ============================ exports ================================= */
  window.QP = window.QP || {};
  QP.ml = {
    FEATURES: FEATURES, MODEL_KEYS: MODEL_KEYS, MODEL_LABELS: MODEL_LABELS,
    dataset: dataset, run: run, invalidate: invalidate, zscoreArr: zscoreArr,
    signalFnFor: signalFnFor,
  };
})();
