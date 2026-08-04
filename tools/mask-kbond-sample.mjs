// mask-kbond-sample.mjs — 케이본드 채팅 원문 → 커밋 가능한 마스킹 픽스처.
//
// 왜: RV-2 파서 테스트에는 실데이터 라인 이형이 필요하지만, 원문에는 발화자 실명과
//     딜러 전화번호가 들어 있어 그대로 커밋할 수 없다.
//     원문은 tests/fixtures/raw-kbond/ (gitignore), 결과물만 tests/fixtures/ 에 커밋한다.
//
// 마스킹 규약 (RV-2 Phase 0 승인):
//   - 발화자 실명 → `트레이더NN` (첫 등장 순 결정론적 번호. 랜덤·시각 의존 없음)
//   - 전화번호    → 더미. **자릿수 형태를 보존**해 rv-parser 의 parseBroker 정규식
//                   /(\d{2,4}-\d{3,4}-\d{4}|\d{3,4}-\d{4})/ 이 마스킹 후에도 매칭되게 한다.
//   - 브로커 회사·데스크명은 **보존**. 개인정보가 아니고 딜러태그 파싱 검증에 필요하다.
//   - 매핑표는 원문과 같은 gitignore 경로에 출력 — 커밋 금지.
//
// 사용:
//   node tools/mask-kbond-sample.mjs tests/fixtures/raw-kbond/2026-08-04.txt
//   node tools/mask-kbond-sample.mjs <입력> [출력] [--allow-residual]
//   (출력 기본값: tests/fixtures/kbond-sample.masked.txt)
//
// 종료 코드: 0 정상 / 1 입력 오류·검증 실패 / 2 잔여 실명 후보 발견(수동 확인 필요)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// rv-parser.js:10 과 동일한 메시지 시작 패턴 — 발화자 식별의 단일 근원.
const MESSAGE_START_RE = /^(.+?)\s*\((\d{2}:\d{2}:\d{2})\)\s*:\s*(.*)/;
// 입·퇴장 시스템 메시지의 이름 (존댓말형 '입장하셨습니다' 포함 — rv2 프리패스와 동일 범위)
const ENTER_LEAVE_RE = /(\S+?)님이\s*(?:입장|퇴장)하(?:셨|였)습니다/g;
// 전화번호 — parseBroker(rv-parser.js:333) 와 동일. 3파트를 먼저 잡아야 2파트가 앞을 갉지 않는다.
const PHONE_RE = /\d{2,4}-\d{3,4}-\d{4}|\d{3,4}-\d{4}/g;

/** 원문 → { text, nameMap, phoneMap, residual } (순수 함수: 파일 IO 없음, 테스트 가능) */
export function maskKbondText(rawText) {
  const lines = String(rawText ?? '').split('\n');

  // ── 1단계: 실명 수집 (발화자 + 입·퇴장 메시지). 첫 등장 순서 = 번호 순서. ──
  const names = [];
  const seenName = new Set();
  const addName = (n) => {
    const t = String(n ?? '').trim();
    // 시각·숫자·빈 토큰은 이름이 아니다. 1자 이름은 오탐 위험이 커 제외한다.
    if (t.length < 2 || /^\d/.test(t)) return;
    if (!seenName.has(t)) { seenName.add(t); names.push(t); }
  };
  for (const line of lines) {
    const m = line.trim().match(MESSAGE_START_RE);
    if (m) addName(m[1]);
    for (const e of line.matchAll(ENTER_LEAVE_RE)) addName(e[1]);
  }
  // 긴 이름부터 치환 — "김진"이 "김진우"의 앞부분을 갉아먹는 것을 막는다.
  const byLength = [...names].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const nameMap = new Map();
  names.forEach((n, i) => nameMap.set(n, `트레이더${String(i + 1).padStart(2, '0')}`));

  // ── 2단계: 전화번호 수집 → 자릿수 형태 보존 더미 ──
  const phones = [];
  const seenPhone = new Set();
  for (const line of lines) {
    for (const p of line.matchAll(PHONE_RE)) {
      if (!seenPhone.has(p[0])) { seenPhone.add(p[0]); phones.push(p[0]); }
    }
  }
  const phoneMap = new Map();
  phones.forEach((p, i) => {
    const seq = String(1001 + i); // 4자리 유지
    // 파트 수를 보존: 'AAA-BBBB' → '000-NNNN', 'AA-BBB-CCCC' → '00-000-NNNN'
    const parts = p.split('-');
    const dummy = parts.map((seg, j) =>
      (j === parts.length - 1 ? seq.slice(-seg.length).padStart(seg.length, '0') : '0'.repeat(seg.length))
    ).join('-');
    phoneMap.set(p, dummy);
  });

  // ── 3단계: 치환 (전화번호 먼저 — 이름 치환이 숫자 문맥을 흔들지 않도록) ──
  let out = String(rawText ?? '');
  for (const p of [...phones].sort((a, b) => b.length - a.length)) {
    out = out.split(p).join(phoneMap.get(p));
  }
  for (const n of byLength) {
    out = out.split(n).join(nameMap.get(n));
  }

  // ── 4단계: 검증 — 원본 실명·번호가 한 건이라도 남으면 실패로 본다 ──
  const leaked = [];
  for (const n of names) if (out.includes(n)) leaked.push({ kind: 'name', value: n });
  for (const p of phones) if (out.includes(p)) leaked.push({ kind: 'phone', value: p });

  // ── 5단계: 잔여 실명 후보 — 딜러태그 [] () 안의 2~4자 한글 토큰.
  //    회사·데스크명(증권·투자·채권·팀 …)이 아니면서 마스킹되지 않은 것 = 사람 이름일 수 있다.
  const DESK_WORDS = /증권|은행|투자|채권|금융|매크로|팀|본부|파트|영업|법인|중개|캐피탈|자산|운용|신탁|리테일|세일즈|딜링|FICC|CMS|증금|공사|생명|화재|보험/;
  const residual = new Set();
  for (const tag of out.matchAll(/[[(]([^\])]+)[\])]/g)) {
    for (const tok of tag[1].split(/[\s,/·]+/)) {
      const t = tok.trim();
      if (!/^[가-힣]{2,4}$/.test(t)) continue;
      if (DESK_WORDS.test(t)) continue;
      if (t.startsWith('트레이더')) continue;
      residual.add(t);
    }
  }

  return { text: out, nameMap, phoneMap, leaked, residual: [...residual].sort() };
}

// ── CLI ──────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const allowResidual = args.includes('--allow-residual');
  const positional = args.filter((a) => !a.startsWith('--'));
  const input = positional[0];
  const output = positional[1] || 'tests/fixtures/kbond-sample.masked.txt';

  if (!input) {
    console.error('사용법: node tools/mask-kbond-sample.mjs <입력> [출력] [--allow-residual]');
    console.error('  입력 원문은 tests/fixtures/raw-kbond/ (gitignore) 에 두세요.');
    process.exit(1);
  }
  if (!existsSync(input)) {
    console.error(`입력 파일 없음: ${input}`);
    process.exit(1);
  }

  const raw = readFileSync(input, 'utf8');
  const { text, nameMap, phoneMap, leaked, residual } = maskKbondText(raw);

  if (leaked.length) {
    console.error('❌ 마스킹 검증 실패 — 원본 값이 결과물에 남아 있습니다. 커밋하지 마세요:');
    for (const l of leaked.slice(0, 20)) console.error(`   [${l.kind}] ${l.value}`);
    process.exit(1);
  }

  writeFileSync(output, text, 'utf8');
  // 매핑표는 원문과 같은 gitignore 경로에 — 커밋 금지
  const mapPath = join(dirname(input), basename(input).replace(/\.[^.]+$/, '') + '.mapping.json');
  writeFileSync(mapPath, JSON.stringify({
    input, output,
    names: Object.fromEntries(nameMap),
    phones: Object.fromEntries(phoneMap),
  }, null, 2), 'utf8');

  console.log(`✅ 마스킹 완료 → ${output}`);
  console.log(`   발화자 ${nameMap.size}명 · 전화번호 ${phoneMap.size}건 치환`);
  console.log(`   매핑표 → ${mapPath} (gitignore 경로 · 커밋 금지)`);

  if (residual.length) {
    console.warn('');
    console.warn(`⚠️  딜러태그 안에 마스킹되지 않은 한글 토큰 ${residual.length}건 — 사람 이름인지 수동 확인 필요:`);
    console.warn('   ' + residual.join(', '));
    console.warn('   회사·데스크명이면 무시하고 --allow-residual 로 다시 실행하세요.');
    if (!allowResidual) process.exit(2);
  }
}
