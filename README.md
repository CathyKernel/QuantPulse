# QuantPulse · Live US Equity Quant Terminal

A **live-updating, zero-build quantitative research terminal** covering 38 US
mega-cap equities across all 11 GICS sectors with **11.7+ years of real daily
market data** (Jan 2015 → snapshot, split-adjusted, via Yahoo Finance) — plus a
**Netlify serverless function** that streams fresh quotes so the dashboard
never goes stale.

Everything — live merging, charting, factor analytics, machine learning,
backtesting and risk statistics — runs **in your browser**. No build step, no
API keys, no tracking, no ML libraries.

## What's new vs. a static bundle

| Capability | How it works |
|------------|--------------|
| **Real-time data** | `netlify/functions/quotes.js` fetches Yahoo Finance server-side (no CORS) and returns compact JSON. The client polls every 15–60s, merges **completed sessions** into the analytics history, and carries today's session as a **forming bar** (live price line, never contaminating backtests). |
| **Graceful degradation** | If the function is unreachable (e.g. opened as a plain static site), the app badges itself **SNAPSHOT** and keeps every feature on the bundled data. |
| **Pro charting** | Candlestick / line / area charts with **wheel zoom, drag pan, pinch zoom, full crosshair with axis tags**, OHLC legend readout, SMA 20/50/200 + EMA 50 + Bollinger overlays, **Volume / RSI-14 / MACD panels**, log scale, **1D-5m and 5D-15m intraday**, peer comparison and relative strength. |
| **Live screener** | Sortable 38-name cross-section: price, day/1W/1M/3M/YTD/1Y returns, 20D vol, RSI-14, % off 52W high, volume ratio 20/120, 30-day sparklines. Search + sector filter, click-through to the Terminal. |
| **Factor lab** | 7 classic factors + a composite (average z-score): live cross-sections, client-recomputed **rank-IC history with t-stats**, **quintile spreads (Q1−Q5)**, 36-month **factor correlation matrix**. IC history auto-extends as live sessions merge. |
| **Backtester** | Position-based engine with **daily weight drift**, long-only & **long-short** books, turnover-based costs, 12 performance metrics (Sharpe, Sortino, Calmar, alpha/beta, skew, turnover…), monthly heatmap, live holdings, **CSV export**. |
| **ML lab** | Four models written **from scratch** on `Float32Array` maths — **ridge regression** (closed form), **elastic net** (coordinate descent down a lambda path), a one-hidden-layer **neural network** (ReLU + Adam, mini-batch) and **gradient boosting** (histogram regression trees) — plus their equal-weight ensemble. Nine z-scored features predict next-month returns through a **purged walk-forward** protocol (training rows whose 21-day label overlaps the test date are embargoed), evaluated with out-of-sample rank ICs, quintile spreads, hit rates, **permutation feature importance**, a model scoreboard against the no-ML composite baseline, and strategy backtests on the same position engine as the Backtest tab. Seeded RNG → every run is reproducible; a full 4-model benchmark trains in ~12 s in the browser. |

## Deploy to Netlify (drag & drop)

The bundle is intentionally deployable as-is:

1. Zip this folder (or push it to GitHub and connect it).
2. Drag & drop at **[app.netlify.com/drop](https://app.netlify.com/drop)** —
   `netlify.toml` pre-configures everything: static publish + the
   `quotes` function + the `/api/quotes` redirect.
3. Done. The header badge flips to **LIVE** within seconds.

> Netlify Functions (free tier includes 125k invocations/month) powers the
> live feed. The 20-second server-side cache keeps upstream request volume low
> when several clients poll at once.

Any other static host works too — you just lose live updates and the app
badges itself SNAPSHOT (everything else still runs).

## Run locally

```bash
cd quantpulse
python3 -m http.server 8080        # static only → SNAPSHOT mode
# or, with the live API mirrored locally:
node dev-server.js                 # optional helper (serves /api/quotes)
```

## Project structure

```
quantpulse/
├── index.html                    # single-page terminal shell
├── netlify.toml                  # publish + functions + /api redirect
├── netlify/functions/quotes.js   # live data proxy (Yahoo → JSON, cached)
├── css/style.css                 # dark terminal theme
└── js/
    ├── data.js                   # bundled market snapshot (~1.7 MB)
    ├── divs.js                   # bundled ex-dividend calendar since 2015
    ├── charts.js                 # zero-dependency canvas chart engine
    ├── live.js                   # polling, market clock, pub/sub, fallbacks
    ├── core.js                   # live-merge engine, factors, IC, backtest,
    │                             #   risk + price/total return basis switch
    ├── ml.js                     # from-scratch ML: ridge / elastic net / MLP /
    │                             #   gradient boosting, purged walk-forward
    └── app.js                    # 7 modules: Overview / Terminal / Screener /
                                  #   Factors / Backtest / ML Lab / Risk
```

## Data & methodology notes

- Prices are **split-adjusted daily OHLCV** from Yahoo Finance; volumes in the
  bundle are stored in thousands.
- Live merge rule: a bar dated today counts as completed only after 16:05 ET;
  earlier it is a forming overlay excluded from all analytics.
- **Ex-dividend-aware split detection**: the live feed carries Yahoo's split &
  dividend event calendar. When a split's ex-date falls after the snapshot,
  the ticker's entire bundled history is rescaled to the new share basis
  (prices × den/num, volumes × num/den) *before* returns are chained — a 10:1
  split never shows up as a fake −90% day, and split events that arrive after
  their bar has merged are repaired retroactively (including the equal-weight
  benchmark re-chain). Dividend ex-dates stay in the price chain (price-return
  convention) and are used to avoid mistaking an ex-div gap for a split;
  unexplained boundary gaps are re-checked against a 1-year event calendar,
  and when evidence is inconclusive the app **warns instead of guessing**.
  Only if the feed is down entirely can a strict open+close+volume heuristic
  apply an adjustment — always flagged `[unverified]`.
- Factors are computed client-side from the merged history (momentum 12-1/6M,
  1M reversal, 20D low vol, RSI-14 Cutler variant negated, 52W-high proximity,
  20/120D volume trend). Rank IC = Spearman ρ between month-end scores and the
  next 21 trading days' returns; the Factors tab shows live-recomputed ICs
  (falling back to the offline bundle where candle volume history is
  unavailable).
- Backtests charge `turnover × cost_bps` per rebalance, fill at the rebalance
  day's close, and model daily weight drift within holding periods. No
  borrow/financing or slippage.
- ML methodology: features are winsorised at ±3σ and z-scored within each
  month's cross-section; targets are next-21-trading-day returns; every
  month-end the model retrains on the trailing window (36/60/96 months) and
  scores the current cross-section strictly out-of-sample — training rows whose
  label window has not fully realised before the test date are **embargoed**
  (purged walk-forward, no leakage). Out-of-sample results on a 38-name
  mega-cap panel are honestly thin (OOS ICs of a few hundredths with
  t-stats under 1): the lab is a methodology showcase, not an alpha claim.
- **Return basis switch (PRICE / TOTAL)**: the header toggle selects the return
  convention for analytics. PRICE chains raw closes (cash dividends appear as
  ex-date price drops). TOTAL adds each cash dividend back on its ex-date —
  `(close + div) / prevClose − 1`, the standard approximation to a
  dividend-reinvested index — which is the honest view for high-yield names
  (e.g. PFE's 2015→2026 CAGR moves from ~7% to ~13% when its ~4-6% yield is
  counted). The basis propagates to risk statistics (vol, Sharpe, Sortino,
  VaR/CVaR, beta, correlations, drawdowns), backtests and their benchmark, IC /
  quintile forward returns, ML training targets, screener windows and the
  equal-weight universe index. Candlesticks, Terminal price charts and factor
  signals stay price-based (a candle cannot embed a cash payout; momentum-type
  signals are classically price-based). The dividend calendar (1,400+ ex-dates
  since 2015, bundled in `js/divs.js`) extends live as new ex-dates merge.
- The universe is a static demonstration panel, not a tradable index.

## License

MIT — see `LICENSE`.
