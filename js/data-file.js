// data-file.js — data/{seriesId}.js 직렬화 (admin export · 일회성 스크립트 공용). DOM 무관 순수 모듈.
// 저장 파일과 같은 형식({"k": v, ...}, ", " 구분)으로 써서 diff 가 추가·개정 달만 드러나게 한다.

import { getConfig } from './series-config.js';

export function pyJson(obj) {
  return '{' + Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ') + '}';
}

// headerLines: 파일 상단 주석(‘// ’ 제외 본문) 배열. 생략 시 admin 기본 문구.
export function buildDataFileContent(seriesId, series, baseMeta, headerLines) {
  const cfg = getConfig(seriesId) || {};
  const meta = {
    series_id: seriesId,
    display_name: cfg.display_name || seriesId,
    source: cfg.source || 'manual',
    unit: cfg.unit || '',
    value_type: cfg.value_type || 'index',
    frequency: cfg.frequency || 'monthly',
    ...(baseMeta || {}), // 저장 meta 의 추가 필드(kosis_account 등) 보존
    last_updated: series[series.length - 1]?.period || '',
  };
  const sorted = [...series].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  const header = headerLines ?? [
    `${meta.display_name} (${meta.source.toUpperCase()}, ${meta.unit})`,
    `admin 도구 생성 — ${new Date().toISOString().slice(0, 10)}. 저장 이력 + 업로드 병합. 레지스트리 자기등록 (file:// 호환).`,
  ];
  let out = header.map((l) => `// ${l}\n`).join('');
  out += `window.FENRIR_SERIES = window.FENRIR_SERIES || {};\n`;
  out += `window.FENRIR_SERIES[${JSON.stringify(seriesId)}] = {\n`;
  out += `  meta: ${pyJson(meta)},\n`;
  out += `  series: [${sorted.map(pyJson).join(', ')}]\n`;
  out += `};\n`;
  return out;
}
