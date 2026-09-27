// admin-ui.js — 로컬 데이터 공장. CSV 업로드 → 파싱 → 저장 이력과 병합 → 미리보기 → data/*.js export.
// calc.js/chart.js/series-config.js를 조회 페이지와 공유 (로직 중복 없음).
// API 키 없음 (순수 파일 변환) — 공개 레포에 올려도 무방하나, 커밋은 나만.
//
// 원칙: 저장된 data/{id}.js 이력이 기준, CSV 는 증분. 저장 이력을 못 읽으면 미리보기·export 를
// 막는다 — CSV 만으로 파일을 재생성하면 장기 이력이 업로드 구간으로 대체된다(과거 사고).

import { buildForecast, MIN_SEASONAL_SAMPLES } from './calc.js';
import { renderYoyChart, renderMmChart } from './chart.js';
import { parseKosisCsv, matchRow } from './csv-parse.js';
import { SERIES_CONFIG, ALL_SERIES_IDS, getConfig, getSeriesData } from './series-config.js';
import { mergeSeries } from './series-merge.js';
import { buildDataFileContent } from './data-file.js';

const DATA_DIR = 'data';

const state = {
  parsed: null,        // parseKosisCsv 결과
  selectedRowIdx: -1,  // 선택된 데이터 행
  matchMode: null,     // 'auto' | 'manual' — 미리보기에 매칭 행과 함께 표시
  seriesId: 'kr-cpi-headline',
  // 저장 이력 로드 상태: status 'loading' | 'ok' | 'error'
  existing: { id: null, status: 'loading', meta: null, series: null, error: '' },
  merged: null,        // mergeSeries 결과 — export 는 이것만 쓴다
};

function fmt(v, d = 2) {
  return (typeof v !== 'number' || !Number.isFinite(v)) ? '—' : v.toFixed(d);
}
function fmtSigned(v, d = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(d);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// ── 저장 이력 로드: data/{id}.js 를 동적 <script> 로 → getSeriesData ──
function loadExisting(seriesId) {
  state.existing = { id: seriesId, status: 'loading', meta: null, series: null, error: '' };
  const src = `${DATA_DIR}/${seriesId}.js`;
  const done = (data, error) => {
    if (state.existing.id !== seriesId) return; // 로드 중 시리즈가 바뀜
    state.existing = error
      ? { id: seriesId, status: 'error', meta: null, series: null, error }
      : { id: seriesId, status: 'ok', meta: data.meta, series: data.series, error: '' };
    renderPreview();
  };
  // 이전 등록값을 이번 로드 성공으로 오인하지 않도록 지우고 로드.
  if (window.FENRIR_SERIES) delete window.FENRIR_SERIES[seriesId];
  const el = document.createElement('script');
  el.src = `${src}?t=${Date.now()}`; // 캐시 우회 — 방금 커밋한 파일을 기준으로
  el.onload = () => {
    el.remove();
    const data = getSeriesData(seriesId);
    if (!Array.isArray(data?.series) || data.series.length === 0) done(null, `${src} 에 ${seriesId} 이력이 없음`);
    else done(data, '');
  };
  el.onerror = () => { el.remove(); done(null, `${src} 로드 실패`); };
  document.head.appendChild(el);
}

// ── CSV 로드 ──
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseKosisCsv(String(reader.result));
      state.parsed = parsed;
      // 현재 seriesId의 힌트로 자동 매칭 시도
      autoMatch();
      renderRows();
      renderPreview();
      setStatus(`파싱 완료 — ${parsed.rows.length}개 행, 기간 ${parsed.periods[0]} ~ ${parsed.periods[parsed.periods.length - 1]}`, 'ok');
    } catch (err) {
      state.parsed = null;
      setStatus('파싱 실패: ' + err.message, 'bad');
      renderRows();
      renderPreview();
    }
  };
  reader.onerror = () => setStatus('파일 읽기 실패', 'bad');
  reader.readAsText(file, 'utf-8');
}

function autoMatch() {
  if (!state.parsed) return;
  const cfg = getConfig(state.seriesId);
  const row = matchRow(state.parsed, cfg?.kosis_hint);
  state.selectedRowIdx = row ? state.parsed.rows.indexOf(row) : -1;
  state.matchMode = row ? 'auto' : null;
}

// ── 행 목록 렌더 ──
function renderRows() {
  const el = document.getElementById('rows');
  if (!state.parsed) {
    el.innerHTML = '<div class="empty">CSV를 올리면 감지된 데이터 행이 여기 표시됩니다.</div>';
    return;
  }
  el.innerHTML = state.parsed.rows.map((row, i) => `
    <label class="row-opt ${i === state.selectedRowIdx ? 'selected' : ''}">
      <input type="radio" name="rowsel" value="${i}" ${i === state.selectedRowIdx ? 'checked' : ''} />
      <span class="ro-account">${row.account || '(무명)'}</span>
      <span class="ro-meta">${row.unit || '—'} · ${row.transform || '—'}</span>
      <span class="ro-count">${row.points.length}개월</span>
    </label>`).join('');

  el.querySelectorAll('input[name=rowsel]').forEach((inp) => {
    inp.addEventListener('change', () => {
      state.selectedRowIdx = Number(inp.value);
      state.matchMode = 'manual';
      renderRows();
      renderPreview();
    });
  });
}

// 업로드(CSV 선택 행) — 증분일 뿐, 그대로 calc/export 에 쓰지 않는다.
function selectedUpload() {
  if (!state.parsed || state.selectedRowIdx < 0) return null;
  return state.parsed.rows[state.selectedRowIdx].points;
}

function setExport(enabled, reason) {
  document.getElementById('export-btn').disabled = !enabled;
  const r = document.getElementById('export-reason');
  r.textContent = reason || '';
  r.className = 'status ' + (reason ? 'bad' : '');
}

// "시리즈 ← 매칭된 CSV 행: <원문 행명>" — 수동 선택 시 엉뚱한 행을 눈으로 잡기 위해 항상 표시.
function matchLine() {
  const row = state.parsed?.rows[state.selectedRowIdx];
  if (!row) return '';
  const mode = state.matchMode === 'manual' ? '수동 선택' : '자동 매칭';
  return `<div class="pv-match"><b>${esc(state.seriesId)}</b> ← 매칭된 CSV 행: <b>${esc(row.account || '(무명)')}</b>
    <span class="${state.matchMode === 'manual' ? 'manual' : ''}">(${mode})</span></div>`;
}

function blockPreview(el, msg) {
  state.merged = null;
  el.innerHTML = `${matchLine()}<div class="pv-block">${esc(msg)}</div>`;
  setExport(false, msg);
}

// ── 미리보기 (저장 이력 + 업로드 병합 → calc 로 실제 전망 계산) ──
function renderPreview() {
  const el = document.getElementById('preview');
  state.merged = null;
  const upload = selectedUpload();
  if (!upload) {
    el.innerHTML = '<div class="empty">행을 선택하면 전망 미리보기가 계산됩니다.</div>';
    setExport(false, '');
    return;
  }

  const ex = state.existing;
  const src = `${DATA_DIR}/${state.seriesId}.js`;
  if (ex.status === 'loading') return blockPreview(el, `기존 이력 로드 중… (${src})`);
  if (ex.status !== 'ok') return blockPreview(el, `미리보기 차단 — ${ex.error}. 저장 이력 없이 업로드만으로는 진행하지 않습니다.`);

  let merge;
  try {
    merge = mergeSeries(ex.series, upload);
  } catch (err) {
    return blockPreview(el, `병합 중단 — ${err.message}`);
  }

  const cfg = getConfig(state.seriesId) || {};
  const scenario = { series_id: state.seriesId, scenario_id: 'base', label: 'Base', mm_overrides: [], last_edited: new Date().toISOString() };
  const meta = { series_id: state.seriesId, window_years: 10, notes: '', comparison_label: '' };
  let result;
  try {
    result = buildForecast(merge.series, scenario, meta, 12, cfg.value_type || 'index', cfg.frequency || 'monthly');
  } catch (err) {
    return blockPreview(el, `전망 계산 중단 — ${err.message}`);
  }
  state.merged = merge;

  const insufficient = result.guide.insufficient_months ?? [];
  setExport(insufficient.length === 0, insufficient.length
    ? `export 불가 — 달력월 표본 ${MIN_SEASONAL_SAMPLES}개 미만: ${insufficient.map((m) => `${m.month}월(${m.samples})`).join(', ')}`
    : '');

  const { stats, warnings } = merge;
  const lastIdx = result.index_history[result.index_history.length - 1];
  const lastYy = result.yoy_history[result.yoy_history.length - 1];
  const endYy = result.yoy_forecast[result.yoy_forecast.length - 1];

  el.innerHTML = `${matchLine()}
    <div class="pv-stats">
      <div class="pv-stat"><div class="l">데이터 포인트</div><div class="m">${merge.series.length}</div>
        <div class="sub">기존 ${stats.kept + stats.revised} · 신규 ${stats.added} · 개정 ${stats.revised}</div></div>
      <div class="pv-stat"><div class="l">최신 실측</div><div class="m">${fmt(lastIdx?.value)}<span>${lastIdx?.period ?? ''}</span></div></div>
      <div class="pv-stat"><div class="l">최신 y-y</div><div class="m">${fmtSigned(lastYy?.value)}%</div></div>
      <div class="pv-stat"><div class="l">전망 종점 y-y</div><div class="m">${fmtSigned(endYy?.value)}%<span>${endYy?.period ?? ''}</span></div></div>
    </div>
    ${warnings.length ? `<ul class="pv-warn">${warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul>` : ''}
    <div class="pv-charts">
      <div class="pv-chart" id="pv-yoy"></div>
      <div class="pv-chart" id="pv-mm"></div>
    </div>`;

  renderYoyChart(document.getElementById('pv-yoy'), result, { yyMonths: 60 });
  renderMmChart(document.getElementById('pv-mm'), result);
}

// ── export: data/{seriesId}.js 생성(data-file.js 직렬화) → 다운로드 ──
function exportData() {
  const merge = state.merged;
  if (!merge || state.existing.status !== 'ok') return;
  const content = buildDataFileContent(state.seriesId, merge.series, state.existing.meta);
  const blob = new Blob([content], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.seriesId}.js`;
  a.click();
  URL.revokeObjectURL(url);
  const { kept, added, revised } = merge.stats;
  setStatus(`다운로드: ${state.seriesId}.js (${merge.series.length}개월 = 기존 ${kept + revised} + 신규 ${added}, 개정 ${revised}) → data/ 폴더에 넣고 커밋하세요.`, 'ok');
}

function setStatus(msg, kind) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + (kind || '');
}

// ── 초기화 ──
export function initAdmin() {
  // 시리즈 선택 드롭다운
  const sel = document.getElementById('series-select');
  sel.innerHTML = ALL_SERIES_IDS.map((id) =>
    `<option value="${id}">${id} — ${SERIES_CONFIG[id].display_name}</option>`).join('');
  sel.value = state.seriesId;
  sel.addEventListener('change', () => {
    state.seriesId = sel.value;
    loadExisting(state.seriesId);
    autoMatch();
    renderRows();
    renderPreview();
  });

  // 파일 입력
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  });

  // 드래그앤드롭
  const drop = document.getElementById('dropzone');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  document.getElementById('export-btn').addEventListener('click', exportData);

  loadExisting(state.seriesId);
  renderRows();
  renderPreview();
}
