# QuantPulse · Live US Equity Quant Terminal

A **live-updating, zero-build quantitative research terminal** covering 38 US
mega-cap equities across all 11 GICS sectors with **11.7+ years of real daily
market data** (Jan 2015 → snapshot, split-adjusted, via Yahoo Finance) — plus a
**Netlify serverless function** that streams fresh quotes so the dashboard
never goes stale.

Everything — live merging, charting, factor analytics, backtesting and risk
statistics — runs **in your browser**. No build step, no API keys, no tracking.

## What's new vs. a static bundle

| Capability | How it works |
|------------|--------------|
| **Real-time data** | `netlify/functions/quotes.js` fetches Yahoo Finance server-side (no CORS) and returns compact JSON. The client polls every 15–60s, merges **completed sessions** into the analytics history, and carries today's session as a **forming bar** (live price line, never contaminating backtests). |
| **Graceful degradation** | If the function is unreachable (e.g. opened as a plain static site), the app badges itself **SNAPSHOT** and keeps every feature on the bundled data. |
| **Pro charting** | Candlestick / line / area charts with **wheel zoom, drag pan, pinch zoom, full crosshair with axis tags**, OHLC legend readout, SMA 20/50/200 + EMA 50 + Bollinger overlays, **Volume / RSI-14 / MACD panels**, log scale, **1D-5m and 5D-15m intraday**, peer comparison and relative strength. |
| **Live screener** | Sortable 38-name cross-section: price, day/1W/1M/3M/YTD/1Y returns, 20D vol, RSI-14, % off 52W high, volume ratio 20/120, 30-day sparklines. Search + sector filter, click-through to the Terminal. |
| **Factor lab** | 7 classic factors + a composite (average z-score): live cross-sections, client-recomputed **rank-IC history with t-stats**, **quintile spreads (Q1−Q5)**, 36-month **factor correlation matrix**. IC history auto-extends as live sessions merge. |
| **Backtester** | Position-based engine with **daily weight drift**, long-only & **long-short** books, turnover-based costs, 12 performance metrics (Sharpe, Sortino, Calmar, alpha/beta, skew, turnover…), monthly heatmap, live holdings, **CSV export**. |
| **Risk lab** | Per-asset vol / Sharpe / Sortino / max DD / VaR 95 / CVaR 95 / beta, 38×38 correlation heatmap (selectable lookback), risk-return map, rolling 60D vol, underwater plots, return distribution with VaR/CVaR markers. |

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
    ├── charts.js                 # zero-dependency canvas chart engine
    ├── live.js                   # polling, market clock, pub/sub, fallbacks
    ├── core.js                   # live-merge engine, factors, IC, backtest, risk
    └── app.js                    # 6 modules: Overview / Terminal / Screener /
                                  #   Factors / Backtest / Risk
```

## Data & methodology notes

- Prices are **split-adjusted daily OHLCV** from Yahoo Finance; volumes in the
  bundle are stored in thousands.
- Live merge rule: a bar dated today counts as completed only after 16:05 ET;
  earlier it is a forming overlay excluded from all analytics.
- Factors are computed client-side from the merged history (momentum 12-1/6M,
  1M reversal, 20D low vol, RSI-14 Cutler variant negated, 52W-high proximity,
  20/120D volume trend). Rank IC = Spearman ρ between month-end scores and the
  next 21 trading days' returns; the Factors tab shows live-recomputed ICs
  (falling back to the offline bundle where candle volume history is
  unavailable).
- Backtests charge `turnover × cost_bps` per rebalance, fill at the rebalance
  day's close, and model daily weight drift within holding periods. No
  borrow/financing or slippage.
- The universe is a static demonstration panel, not a tradable index.

## License

MIT — see `LICENSE`.
