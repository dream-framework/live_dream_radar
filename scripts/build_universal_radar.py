#!/usr/bin/env python3
"""Build Universal DREAM/S2 Ridge-Dust Radar bundle from raw live public feeds.

Policy:
- no synthetic/demo/manufactured source data
- no silent fallback to fabricated values
- each feed either fetches primary-source observations or is marked failed
- all ridge/reach/dust fields are derived diagnostics from raw observations
"""

from __future__ import annotations

import csv
import io
import json
import hashlib
import math
import os
import sys
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd
import requests
import yaml

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "config" / "feeds.yml"
USER_AGENT = "UniversalRidgeDustRadar/1.0 raw-live research app"


class BuildError(Exception):
    pass


@dataclass
class FetchResult:
    feed: dict[str, Any]
    frame: pd.DataFrame
    source_url: str
    raw_rows: int


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: pd.Timestamp | datetime | None) -> str | None:
    if dt is None or pd.isna(dt):
        return None
    if isinstance(dt, pd.Timestamp):
        if dt.tzinfo is None:
            dt = dt.tz_localize("UTC")
        else:
            dt = dt.tz_convert("UTC")
        return dt.isoformat()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def read_config(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def http_get(url: str, timeout: int = 30) -> requests.Response:
    resp = requests.get(url, timeout=timeout, headers={"User-Agent": USER_AGENT})
    resp.raise_for_status()
    return resp


def to_numeric_series(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s.astype(str).str.replace(",", "", regex=False).str.strip(), errors="coerce")


def find_col(cols: list[str], candidates: list[str]) -> str | None:
    norm = {c.lower().strip().replace("_", " "): c for c in cols}
    for cand in candidates:
        key = cand.lower().strip().replace("_", " ")
        if key in norm:
            return norm[key]
    for cand in candidates:
        key = cand.lower().strip().replace("_", " ")
        for c in cols:
            cc = c.lower().strip().replace("_", " ")
            if key in cc or cc in key:
                return c
    return None


def flexible_csv_frames(text: str, max_skip: int = 12) -> list[pd.DataFrame]:
    out: list[pd.DataFrame] = []
    for skip in range(max_skip + 1):
        try:
            df = pd.read_csv(io.StringIO(text), skiprows=skip)
        except Exception:
            continue
        if df.shape[0] >= 2 and df.shape[1] >= 2:
            df.columns = [str(c).strip() for c in df.columns]
            out.append(df)
    return out


def adapter_ieso_demand_csv(feed: dict[str, Any]) -> FetchResult:
    url = feed["url"]
    text = http_get(url).text
    frames = flexible_csv_frames(text)
    value_col: str | None = None
    time_col: str | None = None
    hour_col: str | None = None
    chosen: pd.DataFrame | None = None

    candidates = feed.get("value_column_candidates") or ["Ontario Demand", "Market Demand", "Demand"]
    for df in frames:
        cols = list(df.columns)
        v = find_col(cols, candidates)
        d = find_col(cols, ["Date", "Delivery Date", "Market Date", "Datetime", "Time Stamp", "Timestamp"])
        h = find_col(cols, ["Hour", "HE", "Delivery Hour"])
        if v and d:
            chosen, value_col, time_col, hour_col = df, v, d, h
            break

    if chosen is None or value_col is None or time_col is None:
        raise BuildError("Could not locate IESO date/hour/value columns in Demand CSV")

    dates = pd.to_datetime(chosen[time_col], errors="coerce")
    if hour_col:
        hr = pd.to_numeric(chosen[hour_col], errors="coerce")
        # IESO reports commonly use hour-ending 1..24. Convert to hour-start offset.
        hour_offset = hr.fillna(1).clip(lower=1, upper=24).astype(int) - 1
        ts = dates + pd.to_timedelta(hour_offset, unit="h")
    else:
        ts = dates

    vals = to_numeric_series(chosen[value_col])
    out = pd.DataFrame({"ts": ts, "value": vals}).dropna()
    out["ts"] = pd.to_datetime(out["ts"], utc=True, errors="coerce")
    out = out.dropna().sort_values("ts")
    if out.empty:
        raise BuildError("IESO Demand CSV parsed but produced no numeric observations")
    return FetchResult(feed, out, url, int(len(chosen)))


def adapter_nyiso_pal_integrated_csv(feed: dict[str, Any]) -> FetchResult:
    url_template = feed["url_template"]
    days_back = int(feed.get("days_back", 14))
    rows: list[pd.DataFrame] = []
    tried: list[str] = []
    today = now_utc().date()
    for offset in range(days_back - 1, -1, -1):
        d = today - timedelta(days=offset)
        url = url_template.format(yyyymmdd=d.strftime("%Y%m%d"))
        tried.append(url)
        try:
            text = http_get(url, timeout=20).text
        except Exception:
            continue
        try:
            df = pd.read_csv(io.StringIO(text))
        except Exception:
            continue
        if df.empty:
            continue
        df.columns = [str(c).strip().strip('"') for c in df.columns]
        tcol = find_col(list(df.columns), ["Time Stamp", "Timestamp", "Time"])
        vcol = find_col(list(df.columns), ["Integrated Load", "Load"])
        if not tcol or not vcol:
            continue
        ts = pd.to_datetime(df[tcol], errors="coerce")
        vals = to_numeric_series(df[vcol])
        part = pd.DataFrame({"ts": ts, "value": vals}).dropna()
        rows.append(part)

    if not rows:
        raise BuildError("No NYISO palIntegrated CSV files could be fetched/parsed")
    all_rows = pd.concat(rows, ignore_index=True)
    all_rows["ts"] = pd.to_datetime(all_rows["ts"], utc=True, errors="coerce")
    all_rows = all_rows.dropna()
    # Sum zones into one system-level load per timestamp.
    grouped = all_rows.groupby("ts", as_index=False)["value"].sum().sort_values("ts")
    return FetchResult(feed, grouped, url_template, int(len(all_rows)))


def adapter_usgs_earthquake_geojson(feed: dict[str, Any]) -> FetchResult:
    url = feed["url"]
    data = http_get(url).json()
    features = data.get("features") or []
    rows = []
    for f in features:
        props = f.get("properties") or {}
        mag = props.get("mag")
        t_ms = props.get("time")
        if mag is None or t_ms is None:
            continue
        try:
            magf = float(mag)
            ts = pd.to_datetime(int(t_ms), unit="ms", utc=True)
        except Exception:
            continue
        # Physical-style aggregation from raw magnitude; log compression happens after hourly sum.
        energy_proxy = 10 ** (1.5 * magf) if math.isfinite(magf) else 0.0
        rows.append({"ts": ts.floor("h"), "count": 1, "max_mag": magf, "energy_proxy": energy_proxy})
    if not rows:
        raise BuildError("USGS GeoJSON contained no usable magnitude/time events")
    df = pd.DataFrame(rows)
    g = df.groupby("ts", as_index=False).agg(count=("count", "sum"), max_mag=("max_mag", "max"), energy_proxy=("energy_proxy", "sum"))
    g["value"] = np.log10(g["energy_proxy"].astype(float) + 1.0) + 0.25 * g["count"].astype(float)
    out = g[["ts", "value"]].sort_values("ts")
    return FetchResult(feed, out, url, int(len(features)))


def json_table_to_frame(data: Any) -> pd.DataFrame:
    """Normalize NOAA/SWPC JSON products.

    SWPC products are not completely uniform: some endpoints are
    array tables such as [[header...], [row...]], while others are
    arrays of objects such as [{"time_tag": ..., "Kp": ...}].
    Both are raw primary-source observations; this function only
    normalizes the wire shape into a DataFrame.
    """
    if not isinstance(data, list) or not data:
        raise BuildError("JSON table is empty or not a list")

    if all(isinstance(row, dict) for row in data):
        df = pd.DataFrame(data)
        df.columns = [str(c).strip() for c in df.columns]
        return df

    header = data[0]
    rows = data[1:]
    if isinstance(header, dict):
        df = pd.DataFrame(data)
        df.columns = [str(c).strip() for c in df.columns]
        return df
    if not isinstance(header, list):
        raise BuildError("JSON table first row is not a header list or object row")
    return pd.DataFrame(rows, columns=[str(h).strip() for h in header])


def adapter_noaa_swpc_solar_wind_plasma(feed: dict[str, Any]) -> FetchResult:
    url = feed["url"]
    data = http_get(url).json()
    df = json_table_to_frame(data)
    tcol = find_col(list(df.columns), ["time_tag", "time", "timestamp"])
    field = str(feed.get("value_field") or "speed")
    field_candidates = [field, field.replace("_", " ")]
    # NOAA has been migrating RTSW plasma fields from speed/density to
    # proton_speed/proton_density. Accept both names without fabricating data.
    if field.lower() == "speed":
        field_candidates += ["proton_speed", "proton speed"]
    if field.lower() == "density":
        field_candidates += ["proton_density", "proton density"]
    vcol = find_col(list(df.columns), field_candidates)
    if not tcol or not vcol:
        raise BuildError(f"NOAA plasma JSON missing time or value field {field}")
    ts = pd.to_datetime(df[tcol], utc=True, errors="coerce")
    vals = to_numeric_series(df[vcol])
    out = pd.DataFrame({"ts": ts, "value": vals}).dropna().sort_values("ts")
    return FetchResult(feed, out, url, int(len(df)))


def adapter_noaa_swpc_planetary_kp(feed: dict[str, Any]) -> FetchResult:
    url = feed["url"]
    data = http_get(url).json()
    df = json_table_to_frame(data)
    tcol = find_col(list(df.columns), ["time_tag", "time", "timestamp"])
    vcol = find_col(list(df.columns), ["Kp", "kp_index", "kp", "estimated_kp"])
    if not tcol or not vcol:
        raise BuildError("NOAA Kp JSON missing time or Kp field")
    ts = pd.to_datetime(df[tcol], utc=True, errors="coerce")
    vals = to_numeric_series(df[vcol])
    out = pd.DataFrame({"ts": ts, "value": vals}).dropna().sort_values("ts")
    return FetchResult(feed, out, url, int(len(df)))


def adapter_yahoo_chart_index(feed: dict[str, Any]) -> FetchResult:
    """Fetch public market-index observations from Yahoo Finance chart JSON.

    This is a public vendor feed, not an exchange-primary feed. The adapter uses
    quote.close only, not adjusted close, and does not manufacture missing bars.
    """

    symbol = str(feed.get("symbol") or "").strip()

    if not symbol:
        raise BuildError("Yahoo chart feed missing symbol")

    period = str(feed.get("range") or "max")
    interval = str(feed.get("interval") or "1d")
    encoded = requests.utils.quote(symbol, safe="")
    url = feed.get("url") or (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
        f"?range={period}&interval={interval}&includePrePost=false&events=history"
    )

    data = http_get(url, timeout=30).json()
    chart = data.get("chart") or {}
    errors = chart.get("error")

    if errors:
        raise BuildError(f"Yahoo chart error for {symbol}: {errors}")

    results = chart.get("result") or []

    if not results:
        raise BuildError(f"Yahoo chart returned no result for {symbol}")

    result = results[0]
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []

    if not timestamps or not closes:
        raise BuildError(f"Yahoo chart missing timestamps/close for {symbol}")

    n = min(len(timestamps), len(closes))
    ts = pd.to_datetime(timestamps[:n], unit="s", utc=True, errors="coerce")
    vals = pd.to_numeric(pd.Series(closes[:n]), errors="coerce")
    out = pd.DataFrame({"ts": ts, "value": vals}).dropna().sort_values("ts")

    if out.empty:
        raise BuildError(f"Yahoo chart parsed but produced no numeric observations for {symbol}")

    return FetchResult(feed, out, url, int(n))


ADAPTERS: dict[str, Callable[[dict[str, Any]], FetchResult]] = {
    "ieso_demand_csv": adapter_ieso_demand_csv,
    "nyiso_pal_integrated_csv": adapter_nyiso_pal_integrated_csv,
    "usgs_earthquake_geojson": adapter_usgs_earthquake_geojson,
    "noaa_swpc_solar_wind_plasma": adapter_noaa_swpc_solar_wind_plasma,
    "noaa_swpc_planetary_kp": adapter_noaa_swpc_planetary_kp,
    "yahoo_chart_index": adapter_yahoo_chart_index,
}


def rolling_percent_rank(s: pd.Series, window: int) -> pd.Series:
    def pct(a: np.ndarray) -> float:
        if len(a) == 0 or np.isnan(a[-1]):
            return np.nan
        valid = a[~np.isnan(a)]
        if len(valid) == 0:
            return np.nan
        return float((valid <= a[-1]).mean() * 100.0)
    return s.rolling(window=max(5, int(window)), min_periods=max(5, min(int(window)//3, 20))).apply(pct, raw=True)


def rolling_corr(a: pd.Series, b: pd.Series, window: int) -> pd.Series:
    return a.rolling(window=window, min_periods=max(10, window // 3)).corr(b).replace([np.inf, -np.inf], np.nan)


def safe_clip(s: pd.Series | np.ndarray | float, lo: float = 0.0, hi: float = 100.0):
    return np.clip(s, lo, hi)


def scale_0_100_from_z(z: pd.Series, center: float = 0.0, spread: float = 2.0) -> pd.Series:
    return pd.Series(100.0 / (1.0 + np.exp(-(z - center) / max(spread, 1e-6))), index=z.index)


def resample_series(df: pd.DataFrame, rule: str, fill_zero: bool = False, limit: int = 6) -> pd.Series:
    x = df.copy()
    x["ts"] = pd.to_datetime(x["ts"], utc=True, errors="coerce")
    x["value"] = pd.to_numeric(x["value"], errors="coerce")
    x = x.dropna().drop_duplicates(subset=["ts"], keep="last").sort_values("ts").set_index("ts")
    if x.empty:
        raise BuildError("No observations after timestamp/value normalization")
    agg = x["value"].resample(rule).mean()
    if fill_zero:
        agg = agg.fillna(0.0)
    else:
        agg = agg.ffill(limit=limit)
    return agg.dropna()


def choose_analysis_signal(raw: pd.Series) -> pd.Series:
    x = raw.astype(float)
    if x.min() >= 0 and x.quantile(0.95) > 0 and (x.quantile(0.99) / max(x.quantile(0.50), 1e-9)) > 5:
        return np.log1p(x)
    return x.copy()


def ewm_median_ridge(x: pd.Series, spans: list[int]) -> pd.Series:
    ridges = []
    for span in spans:
        span = max(2, int(span))
        ridges.append(x.ewm(span=span, adjust=False, min_periods=max(2, min(span, 10))).mean())
    return pd.concat(ridges, axis=1).median(axis=1)


def rolling_lambda_q(y: pd.Series, spans: list[int]) -> tuple[pd.Series, pd.Series]:
    """Estimate the retained coherence scale robustly.

    Earlier builds used DataFrame.idxmax(axis=1). Pandas raises
    "Encountered all NA values" for early rows where every rolling
    correlation is still unavailable. That made valid live feeds fail
    before enough rolling history had accumulated. Here we choose the
    best finite score row-by-row and leave early rows as NaN; downstream
    code forward-fills and then falls back to the median configured span.
    """
    clean_spans = [max(2, int(s)) for s in spans]
    score_cols = []
    for span in clean_spans:
        r = y.ewm(span=span, adjust=False, min_periods=max(5, min(span, 20))).mean()
        win = max(30, min(300, span * 3))
        score_cols.append(rolling_corr(y, r, win).rename(str(span)))

    if not score_cols:
        fallback = pd.Series(float("nan"), index=y.index)
        return fallback, fallback.copy()

    scores = pd.concat(score_cols, axis=1)
    arr = scores.to_numpy(dtype=float)
    span_arr = np.array(clean_spans, dtype=float)
    best_span_vals = np.full(len(scores), np.nan, dtype=float)
    best_corr_vals = np.full(len(scores), np.nan, dtype=float)

    for i, row in enumerate(arr):
        finite = np.isfinite(row)
        if finite.any():
            j = int(np.nanargmax(row[finite]))
            finite_idx = np.flatnonzero(finite)[j]
            best_span_vals[i] = span_arr[finite_idx]
            best_corr_vals[i] = row[finite_idx]

    best_span = pd.Series(best_span_vals, index=y.index)
    fallback_span = float(np.median(span_arr))
    best_span = best_span.ffill().bfill().fillna(fallback_span)
    best_corr = pd.Series(best_corr_vals, index=y.index)
    return best_span, best_corr


def compute_diagnostics(result: FetchResult, analysis: dict[str, Any]) -> dict[str, Any]:
    feed = result.feed
    min_points = int(analysis.get("min_points", 40))
    resample_rule = str(feed.get("resample") or "1h")
    fill_zero = feed.get("adapter") == "usgs_earthquake_geojson"
    raw = resample_series(result.frame, resample_rule, fill_zero=fill_zero, limit=int(analysis.get("resample_limit", 6)))
    if len(raw) < min_points:
        raise BuildError(f"Not enough observations after resampling: {len(raw)} < {min_points}")

    y = choose_analysis_signal(raw)
    ridge_spans = [int(v) for v in analysis.get("ridge_spans", [5, 20, 60, 250])]
    ridge_y = ewm_median_ridge(y, ridge_spans)
    ridge_raw = ewm_median_ridge(raw, ridge_spans)
    resid = y - ridge_y
    resid_std = resid.rolling(window=min(max(20, len(y)//10), 250), min_periods=10).std().replace(0, np.nan)
    dust_z = (resid / resid_std).replace([np.inf, -np.inf], np.nan)
    abs_dust_z = dust_z.abs()

    dy = y.diff()
    vol = dy.rolling(window=min(60, max(10, len(y)//8)), min_periods=8).std()
    vol_pct = rolling_percent_rank(vol, min(250, max(30, len(y)//2))).fillna(50)
    abs_resid_pct = rolling_percent_rank(abs_dust_z, min(250, max(30, len(y)//2))).fillna(50)

    signs = np.sign(dy.fillna(0.0))
    reversal = (signs * signs.shift(1) < 0).astype(float)
    reversal_rate = reversal.rolling(window=min(30, max(8, len(y)//10)), min_periods=5).mean() * 100.0
    reversal_pressure = rolling_percent_rank(reversal_rate, min(250, max(30, len(y)//2))).fillna(50)

    innov = dy / vol.replace(0, np.nan)
    innov_pressure = rolling_percent_rank(innov.abs(), min(250, max(30, len(y)//2))).fillna(50)

    dust_index = safe_clip(0.45 * abs_resid_pct + 0.25 * vol_pct + 0.20 * reversal_pressure + 0.10 * innov_pressure)

    lambda_q, lambda_corr = rolling_lambda_q(y, ridge_spans)
    lambda_flicker = rolling_percent_rank(lambda_q.diff().abs().rolling(12, min_periods=4).mean(), min(250, max(30, len(y)//2))).fillna(50)

    coherence = rolling_percent_rank(lambda_corr, min(250, max(30, len(y)//2))).fillna(50)
    same_dir = ((np.sign(dy) == np.sign(ridge_y.diff())).astype(float)).rolling(30, min_periods=8).mean() * 100.0
    persistence = same_dir.fillna(50)
    # Reach is explicit retained coherence: local fit quality, directional persistence,
    # and resistance to dust. It is not a price/ridge support line.
    reach = pd.Series(safe_clip(0.50 * coherence + 0.25 * persistence + 0.25 * (100 - dust_index)), index=y.index)
    reach_velocity = reach.diff().rolling(5, min_periods=2).mean().fillna(0.0)
    reach_accel = reach_velocity.diff().rolling(5, min_periods=2).mean().fillna(0.0)

    # Deterioration pressure converts negative reach velocity into a percentile-like
    # warning term. This catches cases where reach is still high but eroding quickly.
    reach_decay = (-reach_velocity).clip(lower=0).rolling(12, min_periods=4).mean()
    deterioration_pressure = rolling_percent_rank(reach_decay, min(250, max(30, len(y)//2))).fillna(50)

    # Risk is a structural diagnostic, not a forecast: residual contradiction,
    # low reach, reach deterioration, and lambda-scale flicker.
    risk = pd.Series(safe_clip(
        0.35 * dust_index +
        0.25 * (100 - reach) +
        0.20 * deterioration_pressure +
        0.20 * lambda_flicker
    ), index=y.index)

    scale_windows = [int(v) for v in analysis.get("scale_windows", [20, 60, 250])]
    scale_rows = []
    for w in scale_windows:
        if len(y) < max(12, w // 2):
            continue
        r_recent = reach.tail(w)
        d_recent = pd.Series(dust_index, index=y.index).tail(w)
        if len(r_recent) < 5:
            continue
        rv = float(r_recent.iloc[-1] - r_recent.iloc[max(0, len(r_recent)//2 - 1)])
        dv = float(d_recent.iloc[-1] - d_recent.iloc[max(0, len(d_recent)//2 - 1)])
        scale_rows.append({
            "window": w,
            "reach": round(float(r_recent.iloc[-1]), 2),
            "dust": round(float(d_recent.iloc[-1]), 2),
            "d_reach": round(rv, 2),
            "d_dust": round(dv, 2),
            "confirming": bool(rv < 0 and dv > 0),
        })
    if scale_rows:
        scale_agreement = 100.0 * sum(1 for r in scale_rows if r["confirming"]) / len(scale_rows)
    else:
        scale_agreement = 0.0

    current = {
        "raw_value": float(raw.iloc[-1]),
        "ridge_value": float(ridge_raw.iloc[-1]),
        "reach": float(reach.iloc[-1]),
        "dust": float(pd.Series(dust_index, index=y.index).iloc[-1]),
        "dust_z": float(dust_z.iloc[-1]) if pd.notna(dust_z.iloc[-1]) else None,
        "risk": float(risk.iloc[-1]),
        "d_reach": float(reach_velocity.iloc[-1]),
        "dd_reach": float(reach_accel.iloc[-1]),
        "lambda_q": float(lambda_q.iloc[-1]) if pd.notna(lambda_q.iloc[-1]) else None,
        "lambda_flicker": float(lambda_flicker.iloc[-1]) if pd.notna(lambda_flicker.iloc[-1]) else None,
        "scale_agreement": float(scale_agreement),
        "components": {
            "coherence": float(coherence.iloc[-1]) if pd.notna(coherence.iloc[-1]) else None,
            "persistence": float(persistence.iloc[-1]) if pd.notna(persistence.iloc[-1]) else None,
            "anti_dust": float((100 - pd.Series(dust_index, index=y.index)).iloc[-1]),
            "residual_pressure": float(abs_resid_pct.iloc[-1]) if pd.notna(abs_resid_pct.iloc[-1]) else None,
            "volatility_pressure": float(vol_pct.iloc[-1]) if pd.notna(vol_pct.iloc[-1]) else None,
            "reversal_pressure": float(reversal_pressure.iloc[-1]) if pd.notna(reversal_pressure.iloc[-1]) else None,
            "innovation_pressure": float(innov_pressure.iloc[-1]) if pd.notna(innov_pressure.iloc[-1]) else None,
            "deterioration_pressure": float(deterioration_pressure.iloc[-1]) if pd.notna(deterioration_pressure.iloc[-1]) else None,
        },
    }

    state = phase_state(current["reach"], current["dust"], current["d_reach"], current["scale_agreement"])
    current["state"] = state

    tail_n = int(analysis.get("series_tail_points", 1200))
    series_df = pd.DataFrame({
        "ts": raw.index,
        "raw": raw.values,
        "ridge": ridge_raw.reindex(raw.index).values,
        "reach": reach.reindex(raw.index).values,
        "dust": pd.Series(dust_index, index=y.index).reindex(raw.index).values,
        "risk": risk.reindex(raw.index).values,
        "lambda_q": lambda_q.reindex(raw.index).values,
        "lambda_flicker": lambda_flicker.reindex(raw.index).values,
        "d_reach": reach_velocity.reindex(raw.index).values,
        "dd_reach": reach_accel.reindex(raw.index).values,
        "dust_z": dust_z.reindex(raw.index).values,
    }).tail(tail_n)

    series = []
    for _, row in series_df.iterrows():
        series.append({
            "ts": iso(row["ts"]),
            "raw": finite_round(row["raw"], 4),
            "ridge": finite_round(row["ridge"], 4),
            "reach": finite_round(row["reach"], 2),
            "dust": finite_round(row["dust"], 2),
            "risk": finite_round(row["risk"], 2),
            "lambda_q": finite_round(row["lambda_q"], 2),
            "lambda_flicker": finite_round(row["lambda_flicker"], 2),
            "d_reach": finite_round(row["d_reach"], 3),
            "dd_reach": finite_round(row["dd_reach"], 3),
            "dust_z": finite_round(row["dust_z"], 3),
        })

    phase_tail = []
    for item in series[-int(analysis.get("phase_tail_points", 80)):]:
        if item["reach"] is not None and item["dust"] is not None:
            phase_tail.append({"ts": item["ts"], "reach": item["reach"], "dust": item["dust"], "risk": item["risk"]})

    latest_ts = raw.index[-1]
    age_hours = max(0.0, (pd.Timestamp(now_utc()) - latest_ts).total_seconds() / 3600.0)

    return {
        "key": feed["key"],
        "label": feed.get("label", feed["key"]),
        "domain": feed.get("domain", "unknown"),
        "owner": feed.get("owner", "unknown"),
        "metric": feed.get("metric", "value"),
        "unit": feed.get("unit", ""),
        "cadence": feed.get("cadence", "unknown"),
        "source_url": result.source_url,
        "source_type": feed.get("source_type", "unknown"),
        "source_tier": feed.get("source_tier", "primary_public"),
        "notes": feed.get("notes", ""),
        "raw_rows": result.raw_rows,
        "points": int(len(raw)),
        "latest_ts": iso(latest_ts),
        "age_hours": round(age_hours, 2),
        "current": {k: finite_round(v, 3) if isinstance(v, float) else v for k, v in current.items()},
        "scales": scale_rows,
        "series": series,
        "phase_tail": phase_tail,
        "narrative": make_narrative(feed, current, scale_rows, age_hours),
    }


def finite_round(x: Any, ndigits: int) -> float | None:
    try:
        xf = float(x)
    except Exception:
        return None
    if not math.isfinite(xf):
        return None
    return round(xf, ndigits)


def phase_state(reach: float, dust: float, d_reach: float, scale_agreement: float) -> str:
    # Phase logic is intentionally geometric. Critical requires both low reach and
    # high dust. Watch can be triggered by high dust, low reach, fast reach decay,
    # or multi-scale confirmation even before absolute collapse.
    if reach < 35 and dust > 70:
        return "CRITICAL"
    if (reach < 50 and dust > 60) or (d_reach < -10 and dust > 58) or (scale_agreement >= 67 and dust > 58):
        return "FRAGILE"
    if dust > 58 or reach < 58 or d_reach < -5 or scale_agreement >= 67:
        return "WATCH"
    return "STABLE"


def make_narrative(feed: dict[str, Any], current: dict[str, Any], scales: list[dict[str, Any]], age_hours: float) -> str:
    state = str(current.get("state"))
    r = current.get("reach")
    d = current.get("dust")
    dr = current.get("d_reach")
    acc = current.get("dd_reach")
    risk = current.get("risk")
    confirm = current.get("scale_agreement")
    comp = current.get("components") or {}
    label = feed.get("label", feed.get("key", "feed"))

    if r >= 70:
        reach_text = "coherent structure still propagates well"
    elif r >= 55:
        reach_text = "coherent structure is present but not especially deep"
    elif r >= 40:
        reach_text = "reach is weakening"
    else:
        reach_text = "reach is low; coherent propagation is poor"

    if d < 40:
        dust_text = "residual contradiction is contained"
    elif d < 60:
        dust_text = "dust is noisy but controlled"
    elif d < 75:
        dust_text = "dust is elevated and should be watched"
    else:
        dust_text = "dust is severe"

    if dr <= -10:
        velocity_text = "reach is deteriorating quickly"
    elif dr <= -5:
        velocity_text = "reach is shrinking"
    elif dr >= 6:
        velocity_text = "reach is repairing"
    else:
        velocity_text = "reach velocity is roughly flat"

    if state == "STABLE":
        lead = "Stable phase: reach holds and dust is not overwhelming the ridge."
    elif state == "WATCH":
        lead = "Watch phase: either dust is rising, reach is shrinking, or multi-scale confirmation is appearing."
    elif state == "FRAGILE":
        lead = "Fragile phase: reach-down and dust-up are starting to confirm together."
    else:
        lead = "Critical phase: low reach and high dust coincide."

    return (
        f"{label}: {state}. {lead} Reach {r:.1f}: {reach_text}; dust {d:.1f}: {dust_text}; "
        f"dReach {dr:.2f}, ddReach {acc:.2f}: {velocity_text}; risk {risk:.1f}; scale confirmation {confirm:.0f}%. "
        f"Math components: coherence {comp.get('coherence', float('nan')):.0f}, persistence {comp.get('persistence', float('nan')):.0f}, "
        f"residual pressure {comp.get('residual_pressure', float('nan')):.0f}, reversal pressure {comp.get('reversal_pressure', float('nan')):.0f}. "
        f"Latest raw observation age {age_hours:.1f}h. Structural diagnostic only; not a forecast or operating instruction."
    )


def build(config_path: Path) -> dict[str, Any]:
    cfg = read_config(config_path)
    analysis = cfg.get("analysis") or {}
    feeds = [f for f in (cfg.get("feeds") or []) if f.get("enabled", True)]
    built: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []

    for feed in feeds:
        key = feed.get("key", "unknown")
        adapter_name = feed.get("adapter")
        adapter = ADAPTERS.get(adapter_name)
        if adapter is None:
            failed.append({"key": key, "reason": f"No adapter registered: {adapter_name}"})
            continue
        try:
            fetched = adapter(feed)
            diag = compute_diagnostics(fetched, analysis)
            built.append(diag)
            print(f"OK {key}: {diag['points']} points, state={diag['current']['state']}, latest={diag['latest_ts']}")
        except Exception as e:
            failed.append({"key": key, "reason": str(e)})
            print(f"FAIL {key}: {e}", file=sys.stderr)

    min_success = int(cfg.get("min_successful_feeds", 1))
    if len(built) < min_success:
        raise BuildError(f"Only {len(built)} feeds succeeded; minimum is {min_success}. Failures: {failed}")

    states = [b["current"]["state"] for b in built]
    state_rank = {"STABLE": 0, "WATCH": 1, "FRAGILE": 2, "CRITICAL": 3}
    global_state = max(states, key=lambda s: state_rank.get(str(s), -1)) if states else "NO_DATA"
    leaders = sorted(built, key=lambda b: b["current"].get("risk") or 0, reverse=True)[:8]

    payload = {
        "schema": "universal_ridge_dust_radar.v1",
        "generated_at": iso(now_utc()),
        "mode": "raw_live_public_sources_only",
        "policy": {
            "no_synthetic_data": True,
            "no_demo_fallback": True,
            "source_rule": "public raw observations only; market indices use public vendor close data, not adjusted close; derived diagnostics are explicitly computed after fetch",
        },
        "analysis": analysis,
        "global": {
            "state": global_state,
            "feed_count": len(built),
            "failed_count": len(failed),
            "states": {s: states.count(s) for s in ["STABLE", "WATCH", "FRAGILE", "CRITICAL"]},
            "median_reach": finite_round(np.nanmedian([b["current"].get("reach") for b in built]), 2),
            "median_dust": finite_round(np.nanmedian([b["current"].get("dust") for b in built]), 2),
            "median_risk": finite_round(np.nanmedian([b["current"].get("risk") for b in built]), 2),
            "leaders": [{"key": b["key"], "label": b["label"], "state": b["current"]["state"], "risk": b["current"].get("risk"), "reach": b["current"].get("reach"), "dust": b["current"].get("dust")} for b in leaders],
        },
        "feeds": built,
        "failures": failed,
        "source_manifest": [{
            "key": b["key"],
            "label": b["label"],
            "owner": b["owner"],
            "domain": b["domain"],
            "source_url": b["source_url"],
            "source_type": b["source_type"],
            "source_tier": b.get("source_tier", "primary_public"),
            "raw_rows": b["raw_rows"],
            "points": b["points"],
            "latest_ts": b["latest_ts"],
        } for b in built],
        "optional_keyed_sources": cfg.get("optional_keyed_sources", []),
    }
    return payload


def main() -> int:
    config_path = Path(os.environ.get("RIDGE_RADAR_CONFIG", str(DEFAULT_CONFIG)))
    if not config_path.is_absolute():
        config_path = ROOT / config_path
    try:
        payload = build(config_path)
        cfg = read_config(config_path)
        out_path = ROOT / str(cfg.get("output", "data/derived/universal_ridge_radar.json"))
        out_path.parent.mkdir(parents=True, exist_ok=True)

        # Write the data bundle atomically. The frontend wiring is static; only this
        # data file and the tiny manifest below change on each workflow refresh.
        bundle_text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
        bundle_sha = hashlib.sha256(bundle_text.encode("utf-8")).hexdigest()
        tmp = out_path.with_suffix(".json.tmp")
        tmp.write_text(bundle_text, encoding="utf-8")
        tmp.replace(out_path)

        manifest = {
            "schema": "universal_ridge_dust_radar_manifest.v1",
            "generated_at": payload.get("generated_at"),
            "build_id": bundle_sha[:16],
            "bundle_sha256": bundle_sha,
            "bundle_url": str(out_path.relative_to(ROOT)).replace("\\", "/"),
            "mode": payload.get("mode"),
            "global_state": payload.get("global", {}).get("state"),
            "feed_count": payload.get("global", {}).get("feed_count"),
            "failed_count": payload.get("global", {}).get("failed_count"),
        }
        manifest_path = out_path.parent / "manifest.json"
        manifest_tmp = manifest_path.with_suffix(".json.tmp")
        manifest_tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        manifest_tmp.replace(manifest_path)

        print(f"WROTE {out_path.relative_to(ROOT)}")
        print(f"WROTE {manifest_path.relative_to(ROOT)} build_id={manifest['build_id']}")
        return 0
    except Exception as e:
        print(f"LIVE RAW BUILD FAILED: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
