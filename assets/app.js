const $ = (id) => document.getElementById(id);
const DATA_URL = 'data/derived/universal_ridge_radar.json';
const MANIFEST_URL = 'data/derived/manifest.json';
const REFRESH_POLL_MS = 60 * 1000;

const state = {
  bundle: null,
  manifest: null,
  lastBundleId: null,
  feedKey: null,
  chartTab: 'phase',
  tab: 'phase',
  domain: 'all',
  chart: null,
  refreshTimer: null,
  isRefreshing: false,
  defaultChartNarrative: '',
};

function fmt(x, n = 1) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return Number(x).toFixed(n);
}
function intfmt(x) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  return Math.round(Number(x)).toString();
}
function pct(x) { return `${fmt(x, 0)}%`; }
function signed(x, n = 1) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return '—';
  const v = Number(x);
  return `${v > 0 ? '+' : ''}${v.toFixed(n)}`;
}
function dateShort(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function stateClass(s) { return `state-${String(s || 'NA').toUpperCase()}`; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clamp(x, lo = 0, hi = 100) { return Math.max(lo, Math.min(hi, Number(x || 0))); }
function feed() {
  const feeds = filteredFeeds();
  return feeds.find(f => f.key === state.feedKey) || feeds[0] || null;
}
function allFeeds() { return (state.bundle && state.bundle.feeds) ? state.bundle.feeds : []; }
function filteredFeeds() {
  const feeds = allFeeds();
  return state.domain === 'all' ? feeds : feeds.filter(f => f.domain === state.domain);
}
function panel(title, hint, body) {
  return `<section class="subpanel"><h3>${esc(title)}</h3><div class="hint">${esc(hint || '')}</div>${body}</section>`;
}
function tableWrap(html) { return `<div class="table-wrap">${html}</div>`; }
function currentOf(f) { return f?.current || {}; }
function componentsOf(f) { return f?.current?.components || f?.components || {}; }
function colorByState(s) {
  const k = String(s || '').toUpperCase();
  if (k === 'CRITICAL') return '#ff6b6b';
  if (k === 'FRAGILE') return '#ff9a4a';
  if (k === 'WATCH') return '#ffd166';
  if (k === 'STABLE') return '#79e39c';
  return '#8fb4c4';
}
function shortLabel(f) {
  if (!f) return '';
  if (f.short_label) return String(f.short_label);
  const label = String(f.label || f.key || 'feed');
  const m = label.match(/^[A-Z0-9]{2,8}/);
  if (m) return m[0];
  return label.split(/\s+/).slice(0, 2).join(' ');
}
function reachBand(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 'unknown reach';
  if (v >= 70) return 'strong retained coherence';
  if (v >= 55) return 'usable retained coherence';
  if (v >= 40) return 'weakening reach';
  return 'low reach / poor propagation';
}
function dustBand(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 'unknown dust';
  if (v < 40) return 'contained residual noise';
  if (v < 60) return 'noisy but controlled dust';
  if (v < 75) return 'elevated residual contradiction';
  return 'severe dust pressure';
}
function velocityBand(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 'unknown reach velocity';
  if (v <= -10) return 'fast reach deterioration';
  if (v <= -4) return 'reach is shrinking';
  if (v >= 6) return 'reach is repairing';
  if (v >= 2) return 'mild reach recovery';
  return 'reach velocity is flat';
}
function phaseEnglish(reach, dust, dReach, scale = null) {
  const r = Number(reach), d = Number(dust), v = Number(dReach);
  if (r >= 60 && d < 55 && v > -4) return 'Stable geometry: coherence still propagates and dust is not overwhelming the ridge.';
  if (r >= 60 && d >= 55) return 'Watch geometry: the system still has reach, but contradictory residual motion is accumulating.';
  if (r < 60 && d >= 55) return 'Fragile geometry: reach is fading while dust remains elevated; this is the transition quadrant.';
  if (r < 45 && d >= 70) return 'Critical geometry: low coherence and high residual contradiction coincide.';
  if (v <= -8) return 'Velocity warning: the absolute reach may not be low yet, but it is deteriorating quickly.';
  if (scale !== null && Number(scale) >= 67) return 'Multi-scale warning: more than one horizon confirms the same reach-down / dust-up direction.';
  return 'Neutral geometry: no single structural warning dominates.';
}
function explainScore(c) {
  const comp = c.components || {};
  const parts = [];
  if (comp.coherence !== undefined) parts.push(`coherence ${fmt(comp.coherence, 0)}`);
  if (comp.persistence !== undefined) parts.push(`persistence ${fmt(comp.persistence, 0)}`);
  if (comp.residual_pressure !== undefined) parts.push(`residual ${fmt(comp.residual_pressure, 0)}`);
  if (comp.volatility_pressure !== undefined) parts.push(`vol ${fmt(comp.volatility_pressure, 0)}`);
  if (comp.reversal_pressure !== undefined) parts.push(`reversals ${fmt(comp.reversal_pressure, 0)}`);
  return parts.length ? parts.join(' · ') : 'components unavailable in this bundle';
}
function setChartNarrative(html) {
  const el = $('chartNarrative');
  if (!el) return;
  el.innerHTML = html;
}
function restoreChartNarrative() {
  setChartNarrative(esc(state.defaultChartNarrative || 'Hover points and lines for structural narration.'));
}
function pointNarrativeFromRow(f, row) {
  if (!row) return '';
  const text = phaseEnglish(row.reach, row.dust, row.d_reach, row.scale_agreement);
  return `<b>${esc(f.label)} · ${esc(dateShort(row.ts))}</b> — Reach ${fmt(row.reach, 1)} (${esc(reachBand(row.reach))}), dust ${fmt(row.dust, 1)} (${esc(dustBand(row.dust))}), dReach ${signed(row.d_reach, 2)} (${esc(velocityBand(row.d_reach))}), risk ${fmt(row.risk, 1)}. ${esc(text)}`;
}
function currentNarrative(f) {
  const c = currentOf(f);
  return `<b>${esc(f.label)}</b> — ${esc(c.state || 'NA')}. Reach ${fmt(c.reach, 1)} (${esc(reachBand(c.reach))}); dust ${fmt(c.dust, 1)} (${esc(dustBand(c.dust))}); dReach ${signed(c.d_reach, 2)} (${esc(velocityBand(c.d_reach))}); risk ${fmt(c.risk, 1)}. ${esc(phaseEnglish(c.reach, c.dust, c.d_reach, c.scale_agreement))}`;
}
function tooltipBox(lines) {
  return `<div style="max-width:360px;white-space:normal;line-height:1.25">${lines.filter(Boolean).join('<br>')}</div>`;
}

async function init() {
  $('themeBtn').addEventListener('click', () => {
    document.documentElement.classList.toggle('light');
    document.documentElement.classList.toggle('dark');
    $('themeBtn').textContent = document.documentElement.classList.contains('light') ? 'Light' : 'Dark';
    setTimeout(resizeChart, 80);
  });
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    if (state.tab === 'timeseries') state.chartTab = 'ridge';
    if (state.tab === 'phase') state.chartTab = 'phase';
    if (state.tab === 'multiscale') state.chartTab = 'signals';
    syncChartTabs();
    render();
  }));
  document.querySelectorAll('.chart-tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.chartTab = btn.dataset.chart;
    drawChart();
  }));
  $('feedSelect').addEventListener('change', e => { state.feedKey = e.target.value; render(); });
  $('viewSelect').addEventListener('change', render);
  $('domainSelect').addEventListener('change', e => { state.domain = e.target.value; populateFeedSelect(); render(); });
  window.addEventListener('resize', resizeChart);
  await loadBundle({ initial: true });
  startDataRefreshPoll();
}

function cacheBust(url) {
  const sep = String(url).includes('?') ? '&' : '?';
  return `${url}${sep}v=${Date.now()}`;
}
async function fetchJsonNoStore(url) {
  const resp = await fetch(cacheBust(url), { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } });
  if (!resp.ok) throw new Error(`${url} not found (${resp.status})`);
  return resp.json();
}
async function fetchManifest() { return fetchJsonNoStore(MANIFEST_URL); }
function manifestBundleId(m) { return m?.bundle_sha256 || m?.build_id || m?.generated_at || null; }
function currentBundleId(bundle, manifest) { return manifestBundleId(manifest) || bundle?.generated_at || null; }

async function loadBundle(options = {}) {
  const initial = options.initial !== false;
  const prevDomain = state.domain;
  const prevFeed = state.feedKey;
  try {
    const manifest = options.manifest || await fetchManifest().catch(() => null);
    const dataUrl = manifest?.bundle_url || DATA_URL;
    const nextBundle = await fetchJsonNoStore(dataUrl);
    state.bundle = nextBundle;
    state.manifest = manifest;
    state.lastBundleId = currentBundleId(nextBundle, manifest);
    if (!initial) { state.domain = prevDomain; state.feedKey = prevFeed; }
    $('notice').textContent = `Raw live bundle loaded. Data-only refresh is active; static UI wiring is not reloaded. Latest: ${dateShort(nextBundle.generated_at)}.`;
    $('notice').className = 'notice';
    populateSelectors();
    render();
  } catch (err) {
    if (state.bundle) {
      $('notice').textContent = `Keeping current data; refresh check failed: ${err.message}`;
      $('notice').className = 'notice warn';
      return;
    }
    $('notice').textContent = `No raw-live bundle available yet: ${err.message}. Run the GitHub Action or scripts/build_universal_radar.py.`;
    $('notice').className = 'notice bad';
    $('generatedAt').textContent = 'none';
    $('mode').textContent = 'no bundle';
    $('globalState').textContent = 'NO DATA';
    $('kpis').innerHTML = emptyKpis();
    $('workspace').innerHTML = panel('Deployment step', 'first build required', `<div class="small-story"><div class="callout">This repo intentionally ships without fake sample data. The first workflow run writes <b>data/derived/universal_ridge_radar.json</b> and <b>data/derived/manifest.json</b> from raw public feeds.</div><div class="callout">Local test: <code>pip install -r requirements.txt</code> then <code>python scripts/build_universal_radar.py</code>.</div></div>`);
  }
}

function startDataRefreshPoll() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(checkForDataRefresh, REFRESH_POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForDataRefresh(); });
}
async function checkForDataRefresh() {
  if (state.isRefreshing || document.hidden) return;
  state.isRefreshing = true;
  try {
    const manifest = await fetchManifest();
    const nextId = manifestBundleId(manifest);
    if (!nextId || nextId === state.lastBundleId) return;
    await loadBundle({ initial: false, manifest });
    $('notice').textContent = `Updated data bundle ${manifest.build_id || ''} at ${dateShort(manifest.generated_at)}. UI wiring stayed static.`;
    $('notice').className = 'notice';
  } catch (err) {
    if (state.bundle) {
      $('notice').textContent = `Data refresh watch active. Last bundle: ${dateShort(state.bundle.generated_at)}.`;
      $('notice').className = 'notice';
    }
  } finally { state.isRefreshing = false; }
}

function populateSelectors() {
  const domains = Array.from(new Set(allFeeds().map(f => f.domain || 'unknown'))).sort();
  const validDomains = ['all', ...domains];
  if (!validDomains.includes(state.domain)) state.domain = 'all';
  $('domainSelect').innerHTML = `<option value="all">All domains</option>` + domains.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  $('domainSelect').value = state.domain;
  populateFeedSelect();
}
function populateFeedSelect() {
  const feeds = filteredFeeds();
  const prevFeed = state.feedKey;
  $('feedSelect').innerHTML = feeds.map(f => `<option value="${esc(f.key)}">${esc(f.label)} · ${esc(f.domain)}</option>`).join('');
  if (feeds.some(f => f.key === prevFeed)) state.feedKey = prevFeed;
  else state.feedKey = feeds[0]?.key || null;
  $('feedSelect').value = state.feedKey || '';
}
function syncChartTabs() {
  document.querySelectorAll('.chart-tab').forEach(b => b.classList.toggle('active', b.dataset.chart === state.chartTab));
}

function render() {
  if (!state.bundle) return;
  const b = state.bundle;
  const f = feed();
  $('generatedAt').textContent = dateShort(b.generated_at);
  $('mode').textContent = (b.mode || '').replaceAll('_', ' ');
  $('globalState').textContent = b.global?.state || '—';
  renderKpis(f);
  renderSelected(f);
  renderWorkspace(f);
  drawChart();
}
function emptyKpis() {
  return ['State', 'Reach', 'Dust', 'dReach', 'lambda_q', 'Scale confirm', 'Freshness'].map(x => `<div class="kpi-card"><span>${x}</span><b>—</b><em>no bundle</em></div>`).join('');
}
function renderKpis(f) {
  const g = state.bundle.global || {};
  const c = currentOf(f);
  const cards = [
    ['Global state', g.state || '—', `${g.feed_count || 0} live feeds / ${g.failed_count || 0} failed`],
    ['Selected state', c.state || '—', f ? f.label : 'no selected feed'],
    ['Reach', fmt(c.reach, 1), reachBand(c.reach)],
    ['Dust', fmt(c.dust, 1), `${dustBand(c.dust)}; z ${fmt(c.dust_z, 2)}`],
    ['dReach', signed(c.d_reach, 2), `${velocityBand(c.d_reach)}; accel ${signed(c.dd_reach, 2)}`],
    ['lambda_q', fmt(c.lambda_q, 1), `scale flicker ${fmt(c.lambda_flicker, 1)}`],
    ['Scale confirm', pct(c.scale_agreement), `latest age ${fmt(f?.age_hours, 1)}h`],
  ];
  $('kpis').innerHTML = cards.map(([a, b, c]) => `<div class="kpi-card"><span>${esc(a)}</span><b>${esc(b)}</b><em>${esc(c)}</em></div>`).join('');
}
function renderSelected(f) {
  if (!f) { $('selectedName').textContent = 'No feed'; return; }
  const c = currentOf(f);
  const comp = c.components || {};
  $('selectedName').textContent = f.label;
  $('selectedSource').textContent = `${f.owner} · ${f.metric} · ${f.unit}`;
  $('selectedState').textContent = c.state || '—';
  $('selectedState').className = `pill ${stateClass(c.state)}`;
  $('currentRead').innerHTML = [
    ['Raw / ridge', fmt(c.raw_value, 2), `${f.unit}; ridge ${fmt(c.ridge_value, 2)}`],
    ['Reach', fmt(c.reach, 1), reachBand(c.reach)],
    ['Dust', fmt(c.dust, 1), `${dustBand(c.dust)}; z ${fmt(c.dust_z, 2)}`],
    ['Risk', fmt(c.risk, 1), phaseEnglish(c.reach, c.dust, c.d_reach, c.scale_agreement)],
    ['Coherence', fmt(comp.coherence, 0), `persistence ${fmt(comp.persistence, 0)}`],
    ['Multi-scale', pct(c.scale_agreement), `${velocityBand(c.d_reach)}`],
  ].map(([a, b, c]) => `<div class="metric-tile"><span>${esc(a)}</span><b>${esc(b)}</b><p>${esc(c)}</p></div>`).join('');
  $('narrative').innerHTML = `<b>Narrate.</b> ${esc(f.narrative || '')}<br><br><b>Math read:</b> ${esc(explainScore(c))}.<br><br><b>Global leaders:</b> ${leaderSentence()}`;
}
function leaderSentence() {
  const leaders = state.bundle.global?.leaders || [];
  if (!leaders.length) return 'none';
  return leaders.map(x => `${esc(x.label)} ${esc(x.state)} risk ${fmt(x.risk, 0)} reach ${fmt(x.reach, 0)} dust ${fmt(x.dust, 0)}`).join(' / ');
}

function renderWorkspace(f) {
  if (state.tab === 'phase') return renderPhaseWorkspace(f);
  if (state.tab === 'timeseries') return renderTimeseriesWorkspace(f);
  if (state.tab === 'multiscale') return renderMultiscaleWorkspace(f);
  if (state.tab === 'sources') return renderSourcesWorkspace(f);
  if (state.tab === 'failures') return renderFailuresWorkspace(f);
}
function renderPhaseWorkspace(f) {
  $('workspace').innerHTML = `<div class="workspace-grid two">${panel('System phase matrix', 'hover chart circles for English state read', tableWrap(phaseTable()))}${panel('Interpretation', 'Reach ↓ + Dust ↑ is the transition geometry', story(f))}</div>`;
}
function renderTimeseriesWorkspace(f) {
  $('workspace').innerHTML = `<div class="workspace-grid three">${panel('Recent observations', 'raw value and retained ridge', tableWrap(seriesTable(f, 12)))}${panel('Risk leaders', 'highest current risk', tableWrap(leaderTable()))}${panel('Feed manifest', 'current selected source', sourceCard(f))}</div>`;
}
function renderMultiscaleWorkspace(f) {
  $('workspace').innerHTML = `<div class="workspace-grid three">${panel('Selected multi-scale read', 'same feed, multiple horizons', tableWrap(scalesTable(f)))}${panel('Cross-feed confirmation', 'fragile/watch sorted first', tableWrap(phaseTable(true)))}${panel('Method', 'what is computed', methodText())}</div>`;
}
function renderSourcesWorkspace() {
  $('workspace').innerHTML = `<div class="workspace-grid two">${panel('Raw source manifest', 'primary/public endpoints actually used', tableWrap(sourceTable()))}${panel('Policy', 'what is excluded', policyText())}</div>`;
}
function renderFailuresWorkspace() {
  $('workspace').innerHTML = `<div class="workspace-grid two">${panel('Failed feeds', 'hard failures, no fabricated fallback', tableWrap(failureTable()))}${panel('Keyed optional sources', 'not enabled by default', optionalSources())}</div>`;
}

function phaseTable(sortRisk = false) {
  let rows = filteredFeeds().slice();
  rows.sort((a, b) => sortRisk ? ((b.current.risk || 0) - (a.current.risk || 0)) : ((b.current.dust || 0) - (a.current.dust || 0)));
  return `<table><thead><tr><th>Feed</th><th>Domain</th><th>State</th><th class="num">Reach</th><th class="num">Dust</th><th class="num">dReach</th><th class="num">Risk</th></tr></thead><tbody>${rows.map(f => `<tr><td>${esc(f.label)}</td><td>${esc(f.domain)}</td><td><span class="pill ${stateClass(f.current.state)}">${esc(f.current.state)}</span></td><td class="num">${fmt(f.current.reach, 0)}</td><td class="num">${fmt(f.current.dust, 0)}</td><td class="num ${f.current.d_reach < 0 ? 'bad' : 'good'}">${signed(f.current.d_reach, 1)}</td><td class="num">${fmt(f.current.risk, 0)}</td></tr>`).join('')}</tbody></table>`;
}
function leaderTable() {
  const rows = allFeeds().slice().sort((a, b) => (b.current.risk || 0) - (a.current.risk || 0)).slice(0, 10);
  return `<table><thead><tr><th>Feed</th><th>State</th><th class="num">Risk</th><th class="num">Reach</th><th class="num">Dust</th></tr></thead><tbody>${rows.map(f => `<tr><td>${esc(f.label)}</td><td><span class="pill ${stateClass(f.current.state)}">${esc(f.current.state)}</span></td><td class="num">${fmt(f.current.risk, 0)}</td><td class="num">${fmt(f.current.reach, 0)}</td><td class="num">${fmt(f.current.dust, 0)}</td></tr>`).join('')}</tbody></table>`;
}
function seriesTable(f, n = 12) {
  if (!f) return 'no feed';
  const rows = (f.series || []).slice(-n).reverse();
  return `<table><thead><tr><th>UTC</th><th class="num">Raw</th><th class="num">Ridge</th><th class="num">Reach</th><th class="num">Dust</th><th class="num">dReach</th></tr></thead><tbody>${rows.map(r => `<tr><td>${dateShort(r.ts)}</td><td class="num">${fmt(r.raw, 2)}</td><td class="num">${fmt(r.ridge, 2)}</td><td class="num">${fmt(r.reach, 0)}</td><td class="num">${fmt(r.dust, 0)}</td><td class="num ${r.d_reach < 0 ? 'bad' : 'good'}">${signed(r.d_reach, 1)}</td></tr>`).join('')}</tbody></table>`;
}
function scalesTable(f) {
  if (!f) return 'no feed';
  const rows = f.scales || [];
  return `<table><thead><tr><th>Window</th><th class="num">Reach</th><th class="num">Dust</th><th class="num">dReach</th><th class="num">dDust</th><th>Confirm</th></tr></thead><tbody>${rows.map(r => `<tr><td>${r.window}</td><td class="num">${fmt(r.reach, 1)}</td><td class="num">${fmt(r.dust, 1)}</td><td class="num ${r.d_reach < 0 ? 'bad' : 'good'}">${signed(r.d_reach, 1)}</td><td class="num ${r.d_dust > 0 ? 'bad' : 'good'}">${signed(r.d_dust, 1)}</td><td>${r.confirming ? 'yes' : 'no'}</td></tr>`).join('')}</tbody></table>`;
}
function sourceTable() {
  const rows = state.bundle.source_manifest || [];
  return `<table><thead><tr><th>Feed</th><th>Owner</th><th>Domain</th><th class="num">Rows</th><th>Latest</th><th>URL</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.label)}</td><td>${esc(r.owner)}</td><td>${esc(r.domain)}</td><td class="num">${r.raw_rows}</td><td>${dateShort(r.latest_ts)}</td><td><span class="source-url">${esc(r.source_url)}</span></td></tr>`).join('')}</tbody></table>`;
}
function failureTable() {
  const rows = state.bundle.failures || [];
  if (!rows.length) return '<div class="small-story"><div class="callout">No feed failures in this build.</div></div>';
  return `<table><thead><tr><th>Feed</th><th>Reason</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.key)}</td><td>${esc(r.reason)}</td></tr>`).join('')}</tbody></table>`;
}
function sourceCard(f) {
  if (!f) return 'no feed';
  return `<div class="small-story"><div class="callout"><b>${esc(f.owner)}</b><br>${esc(f.notes || '')}</div><div class="callout">Metric: ${esc(f.metric)} (${esc(f.unit)}). Raw rows fetched: ${esc(f.raw_rows)}. Points after resample: ${esc(f.points)}.</div><div class="callout"><span class="source-url">${esc(f.source_url)}</span></div></div>`;
}
function story(f) {
  if (!f) return 'no feed';
  const c = currentOf(f);
  return `<div class="small-story"><div class="callout">${currentNarrative(f)}</div><div class="callout"><b>Reach</b> measures retained coherent propagation. <b>Dust</b> measures contradictory residual pressure around the ridge. <b>dReach</b> is the deterioration/repair velocity.</div><div class="callout"><b>Quadrants:</b> high reach + low dust = stable; high reach + rising dust = watch; falling reach + rising dust = fragile; low reach + high dust = critical.</div></div>`;
}
function methodText() {
  return `<div class="small-story"><div class="callout"><b>Ridge:</b> median of multiple EWM retained paths over raw observations. For markets it may resemble support/resistance, but it is computed as retained structure, not a trade line.</div><div class="callout"><b>Dust index:</b> residual pressure + volatility expansion + reversal rate + innovation pressure.</div><div class="callout"><b>Reach:</b> coherence with retained path + directional persistence + inverse dust. Risk also includes reach deterioration and lambda_q flicker.</div><div class="callout"><b>Phase path:</b> the cyan line is the selected feed moving through Reach × Dust over time, old → now. It is not a graph edge between feeds/hubs.</div></div>`;
}
function policyText() {
  return `<div class="small-story"><div class="callout">No demo bundle is shipped. If live fetch fails, the build fails or records the failure.</div><div class="callout">Excluded by default: PJM, ERCOT, ENTSO-E, and some ISO-NE endpoints because direct API access may require registration, a token, or credentials.</div><div class="callout">Adding a feed means adding an adapter in scripts/build_universal_radar.py and a registry entry in config/feeds.yml. Market index feeds are public vendor close feeds; they are not synthetic and not adjusted close, but they are also not exchange-primary tick data.</div></div>`;
}
function optionalSources() {
  const rows = state.bundle.optional_keyed_sources || [];
  return `<div class="small-story">${rows.map(x => `<div class="callout">${esc(x)}</div>`).join('') || '<div class="callout">none listed</div>'}</div>`;
}

function drawChart() {
  const f = feed();
  if (!f) return;
  if (!state.chart) state.chart = echarts.init($('mainChart'));
  state.chart.off('mouseover');
  state.chart.off('mouseout');
  state.chart.off('updateAxisPointer');
  if (state.chartTab === 'phase') drawPhase(f);
  if (state.chartTab === 'ridge') drawRidge(f);
  if (state.chartTab === 'signals') drawSignals(f);
  resizeChart();
}
function resizeChart() { if (state.chart) setTimeout(() => state.chart.resize(), 30); }
function seriesFor(f) {
  let s = (f.series || []).filter(r => r.ts);
  if ($('viewSelect').value === 'recent') s = s.slice(-260);
  return s;
}
function setDefaultNarrative(f) {
  state.defaultChartNarrative = f?.narrative || 'Hover points and lines for structural narration.';
  restoreChartNarrative();
}
function phaseTooltip(params, f) {
  const d = params.data || {};
  if (params.seriesName === 'Current feeds') {
    const x = d.feed;
    const c = x?.current || {};
    return tooltipBox([
      `<b>${esc(x?.label || params.name)}</b>`,
      `State: <b>${esc(c.state || 'NA')}</b>` ,
      `Reach ${fmt(c.reach, 1)} — ${esc(reachBand(c.reach))}`,
      `Dust ${fmt(c.dust, 1)} — ${esc(dustBand(c.dust))}`,
      `dReach ${signed(c.d_reach, 2)} — ${esc(velocityBand(c.d_reach))}`,
      `Risk ${fmt(c.risk, 1)} · scale confirmation ${pct(c.scale_agreement)}`,
      `<i>${esc(phaseEnglish(c.reach, c.dust, c.d_reach, c.scale_agreement))}</i>`
    ]);
  }
  if (params.seriesName === 'Selected path') {
    const r = d.row || {};
    return tooltipBox([
      `<b>${esc(f.label)} chronological path</b>`,
      `${esc(dateShort(r.ts))}`,
      `This line is not a hub-to-hub edge. It is the selected feed moving through Reach × Dust state space over time.`,
      `Reach ${fmt(r.reach, 1)} · Dust ${fmt(r.dust, 1)} · Risk ${fmt(r.risk, 1)}`,
      `dReach ${signed(r.d_reach, 2)} — ${esc(velocityBand(r.d_reach))}`,
      `<i>${esc(phaseEnglish(r.reach, r.dust, r.d_reach, r.scale_agreement))}</i>`
    ]);
  }
  return '';
}
function drawPhase(f) {
  $('chartTitle').textContent = 'Reach × Dust phase diagram';
  $('chartSubtitle').textContent = 'Circles are current live feeds. Cyan path is selected-feed chronology: old → now. It is not a hub-link graph.';
  setDefaultNarrative(f);
  const feeds = filteredFeeds();
  const all = feeds.map(x => ({
    name: x.label,
    feed: x,
    value: [clamp(x.current.reach), clamp(x.current.dust), clamp(x.current.risk)],
    itemStyle: { color: colorByState(x.current.state) },
  }));
  const rawTrail = (f.phase_tail || []);
  const trailTail = $('viewSelect').value === 'recent' ? rawTrail.slice(-24) : rawTrail.slice(-80);
  const trail = trailTail.map((p, i) => ({
    name: dateShort(p.ts),
    row: p,
    step: i,
    value: [clamp(p.reach), clamp(p.dust), clamp(p.risk)],
  }));
  const startPoint = trail[0] || null;
  const endPoint = trail[trail.length - 1] || null;
  const current = currentOf(f);
  const option = {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: { trigger: 'item', confine: true, formatter: p => phaseTooltip(p, f) },
    legend: { show: false },
    grid: { left: 48, right: 22, top: 26, bottom: 42 },
    xAxis: {
      name: 'Reach / retained coherence →', min: 0, max: 100,
      nameLocation: 'middle', nameGap: 28,
      axisLabel: { color: '#8fb4c4', fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(132,183,207,.35)' } },
      splitLine: { lineStyle: { color: 'rgba(132,183,207,.12)' } }
    },
    yAxis: {
      name: 'Dust / residual contradiction ↑', min: 0, max: 100,
      nameLocation: 'middle', nameGap: 34,
      axisLabel: { color: '#8fb4c4', fontSize: 10 },
      axisLine: { lineStyle: { color: 'rgba(132,183,207,.35)' } },
      splitLine: { lineStyle: { color: 'rgba(132,183,207,.12)' } }
    },
    graphic: [
      { type: 'text', left: '71%', top: '73%', style: { text: 'STABLE\nhigh reach / low dust', fill: 'rgba(206,255,216,.75)', font: '11px sans-serif', textAlign: 'center' } },
      { type: 'text', left: 58, top: 28, style: { text: 'Path direction: older observations → latest selected state. Circles are feeds; path is time, not edges.', fill: 'rgba(189,228,244,.72)', font: '10px sans-serif' } },
      { type: 'text', left: '70%', top: '24%', style: { text: 'WATCH\ncoherent but noisy', fill: 'rgba(255,238,185,.75)', font: '11px sans-serif', textAlign: 'center' } },
      { type: 'text', left: '24%', top: '23%', style: { text: 'FRAGILE / CRITICAL\nreach down + dust up', fill: 'rgba(255,170,170,.75)', font: '11px sans-serif', textAlign: 'center' } },
      { type: 'text', left: '23%', top: '73%', style: { text: 'DORMANT / DECOUPLED\nlow reach / low dust', fill: 'rgba(189,228,244,.55)', font: '11px sans-serif', textAlign: 'center' } },
    ],
    series: [
      {
        name: 'Phase zones', type: 'scatter', data: [], symbolSize: 0, silent: true,
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(0,0,0,0)' },
          data: [
            [{ xAxis: 55, yAxis: 0, itemStyle: { color: 'rgba(70,180,110,.10)' } }, { xAxis: 100, yAxis: 55 }],
            [{ xAxis: 55, yAxis: 55, itemStyle: { color: 'rgba(255,209,102,.10)' } }, { xAxis: 100, yAxis: 100 }],
            [{ xAxis: 0, yAxis: 55, itemStyle: { color: 'rgba(255,107,107,.11)' } }, { xAxis: 55, yAxis: 100 }],
            [{ xAxis: 0, yAxis: 0, itemStyle: { color: 'rgba(98,212,255,.05)' } }, { xAxis: 55, yAxis: 55 }],
          ]
        }
      },
      {
        name: 'Selected path', type: 'line', data: trail, encode: { x: 0, y: 1 },
        showSymbol: true, smooth: false, symbol: ['circle', 'arrow'], symbolSize: [5, 12],
        lineStyle: { width: 2.2, color: '#62d4ff', opacity: 0.60 },
        itemStyle: { color: '#62d4ff', opacity: 0.72 },
        emphasis: { focus: 'series' },
        z: 3,
      },
      {
        name: 'Path start', type: 'scatter', data: startPoint ? [startPoint] : [], encode: { x: 0, y: 1 },
        symbolSize: 8, itemStyle: { color: 'rgba(98,212,255,.45)' },
        label: { show: true, formatter: 'start', fontSize: 9, color: '#8fb4c4', position: 'left' },
        tooltip: { show: false }, z: 4,
      },
      {
        name: 'Path now', type: 'effectScatter', data: endPoint ? [endPoint] : [], encode: { x: 0, y: 1 },
        rippleEffect: { scale: 2.2, brushType: 'stroke' }, symbolSize: 13,
        itemStyle: { color: '#62d4ff' },
        label: { show: true, formatter: 'now', fontSize: 10, color: '#dff7ff', position: 'right' },
        tooltip: { show: false }, z: 5,
      },
      {
        name: 'Current feeds', type: 'scatter', data: all, encode: { x: 0, y: 1 },
        symbolSize: p => 10 + Math.min(22, (p[2] || 0) / 4),
        label: { show: true, formatter: p => shortLabel(p.data.feed), fontSize: 9, color: '#dff7ff', position: 'right' },
        emphasis: { scale: 1.35, label: { show: true } },
        z: 6,
      },
      {
        name: 'Selected current', type: 'effectScatter', data: [{ name: f.label, value: [current.reach, current.dust, current.risk], feed: f }],
        encode: { x: 0, y: 1 }, rippleEffect: { scale: 3, brushType: 'stroke' },
        symbolSize: 18, itemStyle: { color: colorByState(current.state) }, z: 7,
      }
    ]
  };
  state.chart.setOption(option, true);
  state.chart.on('mouseover', params => {
    if (params.seriesName === 'Current feeds' || params.seriesName === 'Selected current') {
      setChartNarrative(currentNarrative(params.data.feed));
    } else if (params.seriesName === 'Selected path') {
      setChartNarrative(pointNarrativeFromRow(f, params.data.row) + ' <b>Path note:</b> chronological movement old → now; not a link between hubs.');
    }
  });
  state.chart.on('mouseout', restoreChartNarrative);
}
function axisTooltip(params, f, mode) {
  const axis = Array.isArray(params) ? params : [params];
  const p0 = axis.find(p => p.dataIndex !== undefined) || axis[0];
  const s = seriesFor(f);
  const row = s[p0?.dataIndex];
  if (!row) return '';
  const header = `<b>${esc(f.label)} · ${esc(dateShort(row.ts))}</b>`;
  if (mode === 'ridge') {
    return tooltipBox([
      header,
      `Raw ${fmt(row.raw, 2)} ${esc(f.unit || '')} · retained ridge ${fmt(row.ridge, 2)}`,
      `Reach ${fmt(row.reach, 1)} (${esc(reachBand(row.reach))}) · Dust ${fmt(row.dust, 1)} (${esc(dustBand(row.dust))})`,
      `dReach ${signed(row.d_reach, 2)} (${esc(velocityBand(row.d_reach))}) · Risk ${fmt(row.risk, 1)}`,
      `<i>${esc(phaseEnglish(row.reach, row.dust, row.d_reach, row.scale_agreement))}</i>`,
    ]);
  }
  return tooltipBox([
    header,
    `Reach ${fmt(row.reach, 1)} · Dust ${fmt(row.dust, 1)} · Risk ${fmt(row.risk, 1)}`,
    `dReach ${signed(row.d_reach, 2)} · lambda_q ${fmt(row.lambda_q, 1)} · flicker ${fmt(row.lambda_flicker, 1)}`,
    `<i>${esc(phaseEnglish(row.reach, row.dust, row.d_reach, row.scale_agreement))}</i>`,
  ]);
}
function bindAxisNarration(f) {
  const s = seriesFor(f);
  state.chart.on('updateAxisPointer', ev => {
    const info = ev.axesInfo && ev.axesInfo[0];
    if (!info) return;
    const idx = info.value;
    const row = s[idx];
    if (row) setChartNarrative(pointNarrativeFromRow(f, row));
  });
  state.chart.on('mouseout', restoreChartNarrative);
}
function drawRidge(f) {
  $('chartTitle').textContent = `${f.label} ridge theater`;
  $('chartSubtitle').textContent = 'Raw observation, retained ridge, reach, and dust. Hover the line to translate math into English.';
  setDefaultNarrative(f);
  const s = seriesFor(f);
  const x = s.map(r => dateShort(r.ts));
  state.chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'cross' }, formatter: p => axisTooltip(p, f, 'ridge') },
    legend: { top: 0, textStyle: { color: '#8fb4c4' }, data: ['raw', 'ridge', 'reach', 'dust'] },
    grid: { left: 56, right: 56, top: 30, bottom: 32 },
    xAxis: { type: 'category', data: x, boundaryGap: false, axisLabel: { fontSize: 9, color: '#8fb4c4' }, axisLine: { lineStyle: { color: 'rgba(132,183,207,.35)' } } },
    yAxis: [
      { type: 'value', name: f.unit || 'raw', scale: true, axisLabel: { color: '#8fb4c4' }, splitLine: { lineStyle: { color: 'rgba(132,183,207,.12)' } } },
      { type: 'value', name: 'score', min: 0, max: 100, axisLabel: { color: '#8fb4c4' } }
    ],
    series: [
      { name: 'raw', type: 'line', data: s.map(r => r.raw), showSymbol: false, lineStyle: { width: 1.3, opacity: 0.78 } },
      { name: 'ridge', type: 'line', data: s.map(r => r.ridge), showSymbol: false, lineStyle: { width: 2.4 } },
      { name: 'reach', type: 'line', yAxisIndex: 1, data: s.map(r => r.reach), showSymbol: false, lineStyle: { width: 1.5 } },
      { name: 'dust', type: 'line', yAxisIndex: 1, data: s.map(r => r.dust), showSymbol: false, lineStyle: { width: 1.5 } },
    ]
  }, true);
  bindAxisNarration(f);
}
function drawSignals(f) {
  $('chartTitle').textContent = `${f.label} signal stack`;
  $('chartSubtitle').textContent = 'Reach velocity, dust, risk, lambda_q, and flicker. Hover for deterioration/repair narration.';
  setDefaultNarrative(f);
  const s = seriesFor(f);
  const x = s.map(r => dateShort(r.ts));
  state.chart.setOption({
    backgroundColor: 'transparent', animation: false,
    tooltip: { trigger: 'axis', confine: true, axisPointer: { type: 'cross' }, formatter: p => axisTooltip(p, f, 'signals') },
    legend: { top: 0, textStyle: { color: '#8fb4c4' }, data: ['reach', 'dust', 'risk', 'dReach', 'lambda_q'] },
    grid: { left: 56, right: 56, top: 30, bottom: 32 },
    xAxis: { type: 'category', data: x, boundaryGap: false, axisLabel: { fontSize: 9, color: '#8fb4c4' }, axisLine: { lineStyle: { color: 'rgba(132,183,207,.35)' } } },
    yAxis: [
      { type: 'value', name: 'score', min: 0, max: 100, axisLabel: { color: '#8fb4c4' }, splitLine: { lineStyle: { color: 'rgba(132,183,207,.12)' } } },
      { type: 'value', name: 'd / lambda', scale: true, axisLabel: { color: '#8fb4c4' } }
    ],
    series: [
      { name: 'reach', type: 'line', data: s.map(r => r.reach), showSymbol: false, lineStyle: { width: 1.5 } },
      { name: 'dust', type: 'line', data: s.map(r => r.dust), showSymbol: false, lineStyle: { width: 1.5 } },
      { name: 'risk', type: 'line', data: s.map(r => r.risk), showSymbol: false, lineStyle: { width: 1.7 } },
      { name: 'dReach', type: 'line', yAxisIndex: 1, data: s.map(r => r.d_reach), showSymbol: false, lineStyle: { width: 1.3 } },
      { name: 'lambda_q', type: 'line', yAxisIndex: 1, data: s.map(r => r.lambda_q), showSymbol: false, lineStyle: { width: 1.3 } },
    ]
  }, true);
  bindAxisNarration(f);
}

init();
