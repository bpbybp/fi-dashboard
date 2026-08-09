// nav.js — 공통 상단 내비게이션. 모듈 목록(NAV_ITEMS)을 단일 근원으로 정의하고
// 페이지 상단에 바를 자동 렌더(현재 페이지 활성 표시). index.html은 NAV_ITEMS로 카드도 구성.
// 다크 테마 CSS 변수(--bg/--panel/--accent…)는 각 페이지가 이미 정의 → 스타일만 자가 주입.
// ES module: 각 페이지에서 <script type="module" src="js/nav.js"> 한 줄로 삽입(기존 로직 무손상).

export const NAV_ITEMS = [
  { id: 'home', title: '홈', file: 'index.html', desc: '모듈 허브' },
  { id: 'inflation', title: '물가전망', file: 'inflation-forecast.html', desc: 'KR CPI 시즈널 m-m 추정 → y-y 시나리오' },
  { id: 'us-inflation', title: 'US 물가전망', file: 'us-inflation.html', desc: 'US CPI/PCE 헤드라인·근원(FRED SA) 시즈널 m-m → y-y 시나리오' },
  { id: 'diffusion', title: '물가 확산', file: 'inflation-diffusion.html', desc: '물가가 얼마나 넓게 오르나 — 오르는 품목 비율(미국 CPI·PCE)로 sticky/착시 판별' },
  { id: 'taylor', title: 'Taylor 압력', file: 'taylor.html', desc: '수정 Taylor 적정금리 − 기준금리 갭 vs 국고 3년 (ECOS 근원CPI·GDP·기준금리)' },
  { id: 'gg1', title: '국민소득 갭', file: 'gg1-income-gap.html', desc: '교역조건(수출가격÷수입가격)이 국민소득(GDI)에 얹는 %p — 갭 프록시·β 회귀 (ECOS)' },
  { id: 'ga1', title: '연간 GDP 환산', file: 'gdp-annual.html', desc: '분기 전기비(계절조정) 실적 체인 + 잔여분기 시나리오로 연간 GDP 성장률 순수 산술 환산 (입력형·외부 fetch 없음)' },
  { id: 'curve-rv', title: 'Curve RV', file: 'curve-rv.html', desc: '크레딧 스프레드 섹터×만기 상대가치 (캐리·롤·percentile·백테스트)' },
  { id: 'curve-phase', title: 'Curve Phase', file: 'curve-phase.html', desc: '커브 국면 — 프라이싱 갭·r* 재조정·텀프리미엄 3변수로 플랫/스팁 국면 판별 (ECOS+FRED, KR 주력·US 참고)' },
  { id: 'us-credit-spread', title: 'US Credit Spread', file: 'us-credit-spread.html', desc: '미국 IG·HY·등급별 OAS + 파생 스프레드(BBB−A·A−AA·장기−전체) z250 — 하이퍼스케일러 발행압력 측정 (FRED BAML)' },
  { id: 'rv-screener', title: 'RV 스크리너', file: 'rv-screener.html', desc: 'K본드 호가 vs 민평 그리드 상대가치 — 발행사 커브 보간·횡단면 조정괴리로 수급 이상치 판별 (클라이언트 온리)' },
  { id: 'onoff', title: 'On/Off 스프레드', file: 'onoff-spread.html', desc: '국고 3년 지표물 커브조정 상대가치 — 세대 이벤트타임 비교' },
  { id: 'onoff-curve', title: 'On/Off 커브 단면', file: 'onoff-curve.html', desc: '국고 2·3년 종목 단위 잔존만기 커브 — 지표물이 경과물 커브에서 벗어난 폭(bp) 측정 (판정·밴드 없음)' },
  { id: 'carry', title: '캐리 손익분기', file: 'carry-breakeven.html', desc: '레버리지 캐리 vs 금리·스프레드 확대 — 손익분기·시나리오 기대값 (입력형)' },
  { id: 'rg-regime', title: '레짐 판단', file: 'rg-regime.html', desc: '전향적 레짐 히트맵 — 금리·스프레드 방향 확률 → 9셀 결합확률 + 플레이북 (입력형)' },
];

const CSS = `
#site-nav { border-bottom: 1px solid var(--border, #21262d); margin-bottom: 22px; }
#site-nav .inner { max-width: 1180px; margin: 0 auto; display: flex; align-items: center; gap: 18px;
  padding: 2px 0 12px; flex-wrap: nowrap; white-space: nowrap; overflow-x: auto; }
#site-nav .brand { font-size: 14px; font-weight: 700; color: var(--text, #e6edf3); text-decoration: none;
  letter-spacing: -0.01em; flex-shrink: 0; }
#site-nav .links { display: flex; gap: 6px; flex-wrap: nowrap; }
#site-nav .links a { font-size: 12.5px; color: var(--muted, #8b949e); text-decoration: none;
  padding: 5px 11px; border-radius: 6px; white-space: nowrap; transition: background .12s, color .12s; }
#site-nav .links a:hover { background: var(--panel-2, #1c2128); color: var(--text, #e6edf3); }
#site-nav .links a.active { background: var(--accent, #58a6ff); color: #08111f; font-weight: 600; }
`;

function currentFile() {
  const p = (location.pathname.split('/').pop() || '').trim();
  return p === '' ? 'index.html' : p;
}

// 현재 파일명 → 활성 모듈 id (매칭 없으면 home)
export function activeId() {
  const f = currentFile();
  const item = NAV_ITEMS.find(i => i.file === f);
  return item ? item.id : 'home';
}

export function renderNav(active = activeId()) {
  if (!document.getElementById('site-nav-style')) {
    const st = document.createElement('style');
    st.id = 'site-nav-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  let bar = document.getElementById('site-nav');
  if (!bar) {
    bar = document.createElement('nav');
    bar.id = 'site-nav';
    document.body.insertBefore(bar, document.body.firstChild);
  }
  const links = NAV_ITEMS.map(i =>
    `<a href="${i.file}"${i.id === active ? ' class="active"' : ''}>${i.title}</a>`).join('');
  bar.innerHTML = `<div class="inner">
    <a class="brand" href="index.html">FI Dashboard</a>
    <div class="links">${links}</div>
  </div>`;
}

// 자동 렌더
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => renderNav());
} else {
  renderNav();
}
