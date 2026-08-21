// test-curve-rv-ui.js — 커브 RV Phase 2 스모크 + 스크린샷 대체 (node, DOM 무관).
//   게이트 2(히트맵/드릴다운/스테일 조립) + 게이트 3(상위5·하위5·스테일 셀 표).
// 실행: node tools/test-curve-rv-ui.js

const assert = require('node:assert/strict');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = join(__dirname, '..');
const f = (x, d = 0) => (x == null || !Number.isFinite(x) ? '—' : (x >= 0 && d === 0 ? '+' : '') + x.toFixed(d));

async function main() {
  globalThis.window = {};
  await import(pathToFileURL(join(ROOT, 'data', 'credit-spread.js')).href);
  const H = await import(pathToFileURL(join(ROOT, 'js', 'rv-heatmap.js')).href);
  const DATA = globalThis.window.FENRIR_SERIES['credit-spread'];
  let pass = 0, fail = 0;
  const t = (n, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log(`  ✗ ${n}: ${e.message}`); } };

  console.log('════ 게이트 2: 히트맵/드릴다운/스테일 스모크 ════');
  const credit = DATA.meta.sectors.filter(s => s !== '국고채권');
  // 행수는 데이터에서 파생한다 — 시리즈가 추가되면(2026-08 산금·중금) 상수는 깨지지만
  // "국고 1 + 숨김 제외 크레딧" 이라는 불변식은 그대로 참이다. 검사할 값은 후자다.
  const shownCredit = credit.filter(s => !H.HIDDEN_SECTORS.includes(s));
  t(`excess 히트맵 차원 = (1+${shownCredit.length})×10, 10년·BBB+ 제외`, () => {
    const hd = H.buildHeatmap(DATA, { mode: 'excess', horizonMonths: 1 });
    assert.equal(hd.rows.length, 1 + shownCredit.length); // 국고 + 크레딧(숨김 섹터 제외)
    assert.equal(hd.cols.length, 10);
    assert.ok(!hd.cols.includes('10년'), '10년 표시 제외');
    assert.ok(!hd.rows.includes('회사채BBB+'), 'BBB+ 표시 제외');
    assert.equal(hd.rows[0], '국고채권');
    assert.ok(hd.value.slice(1).flat().some(v => v != null), 'excess 값 존재');
  });
  t('pctile 히트맵 %ile ∈ [0,100]', () => {
    const hd = H.buildHeatmap(DATA, { mode: 'pctile', horizonMonths: 1 });
    for (const v of hd.value.slice(1).flat()) if (v != null) assert.ok(v >= 0 && v <= 100);
  });
  t('호라이즌 3·6개월 조립', () => {
    for (const hz of [3, 6]) { const hd = H.buildHeatmap(DATA, { mode: 'excess', horizonMonths: hz }); assert.ok(hd.value.flat().some(v => v != null)); }
  });
  t('국고 행 zColor=null(무채색)', () => {
    const hd = H.buildHeatmap(DATA, { mode: 'excess', horizonMonths: 1 });
    assert.ok(hd.zColor[0].every(z => z == null));
  });
  let staleCells = [];
  t('스테일 셀이 실제로 존재(저등급 장기 예상)', () => {
    const hd = H.buildHeatmap(DATA, { mode: 'excess', horizonMonths: 1 });
    for (let r = 1; r < hd.rows.length; r++) for (let c = 0; c < hd.cols.length; c++)
      if (hd.stale[r][c]) staleCells.push(`${hd.rows[r]} ${hd.cols[c]}`);
    assert.ok(staleCells.length > 0, '스테일 셀 0개 — 표시 로직 확인 필요');
  });
  t('드릴다운: 3 호라이즌 + 히스토리 + 스테일', () => {
    const d = H.buildDrilldown(DATA, '공사채AAA', '3년');
    assert.equal(d.horizons.length, 3);
    assert.ok(Number.isFinite(d.spreadBp) && d.history.dates.length > 200);
    const dk = H.buildDrilldown(DATA, '국고채권', '3년'); // 국고 참조행도 동작
    assert.ok(dk.isKtb && Number.isFinite(dk.horizons[0].carry));
  });
  console.log(`게이트 2: pass ${pass} / fail ${fail}\n`);

  // ── 게이트 3: 스크린샷 대체 표 (excess h=1개월, 최신일) — 스테일·carryOnly 순위 제외 ──
  const hd = H.buildHeatmap(DATA, { mode: 'excess', horizonMonths: 1 });
  const ranked = [], excluded = [];
  for (let r = 1; r < hd.rows.length; r++) for (let c = 0; c < hd.cols.length; c++) {
    const v = hd.value[r][c];
    if (v == null || !Number.isFinite(v)) continue;
    const cell = { sec: hd.rows[r], mat: hd.cols[c], v, stale: hd.stale[r][c], co: hd.carryOnly[r][c] };
    if (cell.stale || cell.co) excluded.push(cell); else ranked.push(cell); // full-excess만 순위
  }
  const sorted = [...ranked].sort((a, b) => b.v - a.v);
  console.log('════ 게이트 3: 스크린샷 대체 (최신 ' + DATA.meta.last_updated + ', 1개월 기대수익 bp · 스테일/carryOnly 순위 제외) ════');
  console.log('▶ 상위 5셀 (초록):');
  sorted.slice(0, 5).forEach(x => console.log(`   ${x.sec} ${x.mat}: ${f(x.v)}bp`));
  console.log('▶ 하위 5셀 (무채색/적색):');
  sorted.slice(-5).reverse().forEach(x => console.log(`   ${x.sec} ${x.mat}: ${f(x.v)}bp`));
  console.log(`▶ 순위 제외 셀 ${excluded.length}개 (값 회색 표시만): 스테일 ${excluded.filter(x=>x.stale).length} / carryOnly† ${excluded.filter(x=>x.co).length}`);
  console.log('   스테일: ' + staleCells.join(', '));
  console.log('   carryOnly(†): ' + excluded.filter(x=>x.co).map(x=>`${x.sec} ${x.mat}`).slice(0,12).join(', ') + (excluded.filter(x=>x.co).length>12?' …':''));

  // 확인 포인트: 공사채AAA 2년이 1.5년 험프로 낮은 순위인지
  const gsRank = sorted.findIndex(x => x.sec === '공사채AAA' && x.mat === '2년');
  const gs2 = ranked.find(x => x.sec === '공사채AAA' && x.mat === '2년');
  console.log(`▶ 확인 포인트 — 공사채AAA 2년: ${f(gs2?.v)}bp · 순위 ${gsRank + 1}/${ranked.length} (하위권일수록 험프 영향 확인)`);

  // ── 색 분포 집계 (5단계 이산 · COLOR_STEPS 튜닝용). zColor→excessBand. 국고행 제외. ──
  const dist = { g1: 0, g2: 0, g3: 0, flat: 0, neg: 0, excluded: 0 };
  let poolN = 0;
  for (let r = 1; r < hd.rows.length; r++) for (let c = 0; c < hd.cols.length; c++) {
    const v = hd.value[r][c];
    if (v == null || !Number.isFinite(v)) continue; // 빈 셀(무데이터) 제외
    const band = H.excessBand(hd.zColor[r][c]);
    if (band == null) { dist.excluded++; continue; } // 스테일/carryOnly (zColor=null)
    dist[band]++; poolN++;
  }
  const pctOf = (n) => poolN ? ` (${(100 * n / poolN).toFixed(0)}%)` : '';
  console.log(`\n════ 색 분포 (COLOR_STEPS ${JSON.stringify(H.COLOR_STEPS)} · 순위 풀 ${poolN}셀) ════`);
  console.log(`▶ 진초록 상위10%(테두리): ${dist.g1}${pctOf(dist.g1)}  ← 126×10%≈12~13 기대`);
  console.log(`▶ 중간초록 10~25%: ${dist.g2}${pctOf(dist.g2)}`);
  console.log(`▶ 연초록 25~50%: ${dist.g3}${pctOf(dist.g3)}`);
  console.log(`▶ 무채색 하위50%: ${dist.flat}${pctOf(dist.flat)}`);
  console.log(`▶ 적색 음수: ${dist.neg}${pctOf(dist.neg)}`);
  console.log(`▶ 순위 제외(스테일/carryOnly, 회색만): ${dist.excluded}`);

  // ── 분해 표시 on: 셀 2줄 텍스트 샘플 5개 (상위 테두리 g1 셀 포함) ──
  const hdD = H.buildHeatmap(DATA, { mode: 'excess', horizonMonths: 1, decompose: true });
  const pick = [];
  // 1) g1(상위10% 테두리) 셀 하나
  outer: for (let r = 1; r < hdD.rows.length; r++) for (let c = 0; c < hdD.cols.length; c++)
    if (H.excessBand(hdD.zColor[r][c]) === 'g1') { pick.push({ r, c, tag: 'g1·테두리' }); break outer; }
  // 2) carryOnly(†) 셀 하나 (2줄=캐리만)
  co: for (let r = 1; r < hdD.rows.length; r++) for (let c = 0; c < hdD.cols.length; c++)
    if (hdD.carryOnly[r][c]) { pick.push({ r, c, tag: 'carryOnly†' }); break co; }
  // 3) 스테일 셀 하나 (2줄 생략=null 확인)
  stl: for (let r = 1; r < hdD.rows.length; r++) for (let c = 0; c < hdD.cols.length; c++)
    if (hdD.stale[r][c]) { pick.push({ r, c, tag: '스테일(2줄생략)' }); break stl; }
  // 4~5) 롤다운 부호 다른 일반 셀 2개 (양/음)
  for (const wantNeg of [false, true]) {
    gen: for (let r = 1; r < hdD.rows.length; r++) for (let c = 0; c < hdD.cols.length; c++) {
      const t2 = hdD.text2[r][c];
      if (!t2 || t2 === '캐리만' || hdD.stale[r][c]) continue;
      const isNeg = t2.slice(1).includes('−'); // 연결부호가 − (롤다운 음수)
      if (isNeg === wantNeg && !pick.some(p => p.r === r && p.c === c)) { pick.push({ r, c, tag: wantNeg ? '롤다운 음수' : '롤다운 양수' }); break gen; }
    }
  }
  console.log('\n════ 분해 표시 on: 셀 2줄 텍스트 샘플 (1줄=기대수익 / 2줄=캐리±롤다운) ════');
  pick.slice(0, 5).forEach(({ r, c, tag }) =>
    console.log(`   ${hdD.rows[r]} ${hdD.cols[c]} [${tag}]: 1줄 "${hdD.text[r][c]}" / 2줄 ${hdD.text2[r][c] == null ? '(없음)' : `"${hdD.text2[r][c]}"`}`));

  // ── 순위 기준 비교: 절대 bp ↔ 변동성 조정 상위 11셀 (250d 스테일 비율 컬럼 포함) ──
  const sr1 = (x) => (x == null ? '  —' : `${Math.round(x)}%`.padStart(3)); // 250d 스테일 비율
  const top11 = (basis) => {
    const hb = H.buildHeatmap(DATA, { mode: 'excess', horizonMonths: 1, rankBasis: basis });
    const cells = [];
    for (let r = 1; r < hb.rows.length; r++) for (let c = 0; c < hb.cols.length; c++) {
      const z = hb.zColor[r][c]; // null=제외, -1=음수
      if (z == null || z < 0) continue;
      cells.push({ sec: hb.rows[r], mat: hb.cols[c], v: hb.value[r][c], rv: hb.rankVal[r][c], sr: hb.staleRatio250[r][c] });
    }
    return cells.sort((a, b) => b.rv - a.rv).slice(0, 11);
  };
  const absT = top11('absolute'), volT = top11('vol_adjusted');
  const secN = (arr) => new Set(arr.map(x => x.sec)).size;
  const matN = (arr) => new Set(arr.map(x => x.mat)).size;
  console.log(`\n════ 순위 기준 비교: 상위 11셀 (신뢰도 게이트 STALE_HEAVY_RATIO=${H.STALE_HEAVY_RATIO}% 적용) ════`);
  console.log(`   #  │ 절대 bp 기준 (스테일%)             │ 변동성 조정 기준 base/σ (스테일%)`);
  console.log(`   ───┼───────────────────────────────────┼──────────────────────────────────`);
  for (let i = 0; i < 11; i++) {
    const a = absT[i], v = volT[i];
    const aStr = a ? `${a.sec} ${a.mat} ${f(a.v)}bp [${sr1(a.sr)}]` : '';
    const vStr = v ? `${v.sec} ${v.mat} ${f(v.v)}bp ÷σ=${v.rv.toFixed(2)} [${sr1(v.sr)}]` : '';
    console.log(`   ${String(i + 1).padStart(2)} │ ${aStr.padEnd(33)} │ ${vStr}`);
  }
  console.log(`   → 다양성: 절대 ${secN(absT)}섹터·${matN(absT)}만기 vs 변동성 조정 ${secN(volT)}섹터·${matN(volT)}만기`);
  console.log(`   → 변동성 조정 상위 11셀 최대 스테일 비율: ${Math.max(...volT.map(x => x.sr ?? 0)).toFixed(0)}% (게이트 ${H.STALE_HEAVY_RATIO}% 미만이어야 정상)`);

  console.log('');
  console.log(fail === 0 ? '✅ 게이트 2 전 통과' : `⛔ 게이트 2 실패 ${fail}건`);
  if (fail) process.exit(1);
}
main().catch(e => { console.error('실패:', e.stack || e.message); process.exit(1); });
