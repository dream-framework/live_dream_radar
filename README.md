# Universal Ridge / Dust Radar

A deployable GitHub Pages app for DREAM/S2-style structural diagnostics across raw live public datasets.

The app is intentionally **not** a finance-only crash predictor. It tracks a two-dimensional structural phase space:

- **Reach**: retained structure / coherence / persistence.
- **Dust**: residual pressure, reversals, volatility expansion, and innovation pressure.

The core transition geometry is:

```text
Reach down + Dust up = fragile/critical transition candidate
```

## Raw-data policy

This repo does **not** ship fake sample data. It does **not** use a synthetic/demo fallback. The build either fetches raw public observations from configured sources or records a feed failure.

Enabled default feeds use no API key:

| Feed | Source | Domain |
|---|---|---|
| IESO Ontario Demand | `reports-public.ieso.ca` public demand CSV | electrical grid |
| NYISO Integrated Real-Time Actual Load | `mis.nyiso.com` public CSV | electrical grid |
| USGS Global Earthquake Activity | USGS real-time GeoJSON | geophysical |
| NOAA Solar Wind Speed | NOAA SWPC JSON | space weather |
| NOAA Solar Wind Density | NOAA SWPC JSON | space weather |
| NOAA Planetary K Index | NOAA SWPC JSON | space weather |

Derived diagnostics are computed after fetch from those observations. They are not source data.

## Deploy from a separate repo

1. Create a new GitHub repository.
2. Copy this folder into it.
3. Commit and push to `main`.
4. In GitHub, enable **Settings → Pages → Deploy from branch → main / root**.
5. Go to **Actions → update-universal-ridge-radar → Run workflow**.
6. Open the Pages URL after the action commits `data/derived/universal_ridge_radar.json`.

The workflow also runs hourly:

```yaml
schedule:
  - cron: "17 * * * *"
```

## Local build

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python scripts/build_universal_radar.py
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## Add another raw live feed

Add a registry item in `config/feeds.yml` and implement an adapter in `scripts/build_universal_radar.py`. The adapter must return two columns:

```text
ts,value
```

where `ts` is a real observation timestamp and `value` is a real observed measurement.

Do not add a feed if the source is simulated, forecast-only, model-generated, marketing-normalized, or silently backfilled by a third party.

## Optional keyed sources

These are deliberately not enabled by default because they typically require credentials, tokens, or registration:

- PJM Data Miner 2
- ERCOT Public API
- ENTSO-E Transparency Platform
- some ISO New England web-services endpoints

They are good candidates once credentials are explicitly configured.


## Market-index feeds

This version includes global index feeds under `domain: market_indices` using the public Yahoo Finance chart JSON endpoint. These observations are not synthetic and use `quote.close`, not adjusted close. They are public vendor feeds, not exchange-primary tick feeds.

## Phase chart path

The cyan line in the Reach x Dust chart is the selected feed's chronological trajectory through phase space, old to latest. It is not a graph edge between hubs or a causal link between feeds.
