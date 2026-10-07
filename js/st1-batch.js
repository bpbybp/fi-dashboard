// st1-batch.js — ST-1 일괄 붙여넣기 파서.
//
// 정체: 메신저·채팅창에서 **여러 줄을 통째로** 복사해 온 텍스트 → 후보 행 N개.
//       한 줄 파싱은 `parseQuoteLine`(js/st1-parser.js)을 그대로 쓰고, 여기서는
//       그 앞뒤의 **채팅 문법**만 다룬다. 파서 본체는 건드리지 않는다.
//
// ── 채팅 문법 (실제 호가창에서 온 형태) ────────────────────────────────────
//   황인우(09:09:17) : 10/16 현대차증권 CP 50*2 3.07% 매도     ← 화자·시각 접두, MM/DD 만기, 50*2억
//   [익발] 하나은행 예담                                         ← 헤더(문맥). 금리·만기 없음
//   27/1/11 - 3.79% 매출                                         ← 발행사 없음 → 헤더를 상속
//   익발) 우리예담 (iM)                                          ← 괄호 = 경유 메모
//   27.2.5(금) 3.84% (실효3.889%)                                ← 요일·실효금리 괄호
//   iM뱅크: 1년 FRN 3.63%(1개월CD+50bp)                          ← 테너 만기, FRN 기준금리
//   SC제일은행 1년 FRN (KOFR + 52bp)에 500억 체결, 추가중입니다  ← 금리 없이 스프레드만
//
// ── 문맥(헤더) 규칙 ──────────────────────────────────────────────────────
//   금리·만기가 없고 종류 토큰(예담·CP…)이나 발행 태그(익발·당발)가 있는 줄 = 헤더.
//   헤더 뒤의 **발행사 없는 줄**은 헤더의 발행사·종류·등급을 물려받는다.
//   발행사가 있는 줄·화자 접두가 붙은 줄이 오면 문맥은 끊긴다(다른 사람의 다른 얘기다).
//
// ── FRN ─────────────────────────────────────────────────────────────────
//   FRN 의 금리는 **현재 쿠폰**이라 고정금리 커브에 섞으면 안 된다. 행에 `rate_type:'frn'`
//   과 `ref`(예: "1개월CD+50bp")를 남기고, 커브 적합(js/st1-curve.js)은 이 행을 뺀다.
//
// ── 순수 함수만 ─────────────────────────────────────────────────────────
//   DOM·localStorage 0. 기준일(date)을 인자로 받는다 — MM/DD·테너 만기의 연도 추론이
//   기준일에 묶이므로 "오늘"을 몰래 읽으면 테스트가 날짜에 따라 깨진다.

import { parseQuoteLine, todayLocal, dedupeKey, BOND_KIND } from './st1-parser.js';

const pad2 = (n) => String(n).padStart(2, '0');

/** 채팅 화자·시각 접두 — "황인우(09:09:17) : " · "황인우 (09:09) :". */
const SPEAKER_RE = /^\s*([^\s():：]{1,12})\s*\(\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*\)\s*[:：]?\s*/;

/** 발행 태그 — "[익발]" · "익발)" · "(당발)". 결제 시점이지 발행사가 아니다. */
const TAG_RE = /^\s*[[(（]?\s*(익발|당발|익일발행|당일발행|선발)\s*[\])）]?\s*/;

/** 괄호 묶음 하나. 중첩은 다루지 않는다(호가창에 안 나온다). */
const PAREN_RE = /[(（]([^()（）]*)[)）]/g;

/** 기준금리+스프레드 — "1개월CD+50bp" · "KOFR + 52bp" · "CD+50". */
const REF_RE = /(?:\d+\s*(?:개월|M)\s*)?(?:CD|KOFR|CP|MMF|콜)\s*[+＋-]\s*\d+(?:\.\d+)?\s*(?:bp)?/i;

const FRN_RE = /(?<![A-Za-z])FRN(?![A-Za-z])/i;

/** "50*2" · "50x2" · "50×2" — 억 단위 묶음. 곱해서 "100억" 으로 바꾼다. */
const AMOUNT_MUL_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*[*xX×]\s*(\d+)(?![\d.%])/;

/** 연도 없는 만기 — "10/16". 앞 숫자가 월(1–12)일 때만. "27/3"(연/월)은 파서 몫이다. */
const MD_SLASH_RE = /(?<![\d./-])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d]|\s*[./-]\s*\d)/;
/** 연도 없는 만기(한글) — "10월 16일". 앞에 "년" 이 없을 때만(있으면 파서가 읽는다). */
const MD_KO_RE = /(?<!년\s*)(?<![\d])(\d{1,2})\s*월\s*(\d{1,2})\s*일/;

/** 테너 — "1년" · "6개월" · "3M". 뒤에 "N월" 이 붙으면 "27년 3월" 의 일부라 테너가 아니다. */
const TENOR_RE = /(?<![\d.])(\d{1,2})\s*(개월|년|M|Y)(?![A-Za-z가-힣])(?!\s*\d{1,2}\s*월)/;

/**
 * 거래 동사·잡음 — 발행사 잔여물로 새는 것들. **통째 단어만** 지운다
 * (조사 글자 단위 제거 금지 — 파서 STOPWORD_RE 와 같은 원칙).
 */
const NOISE_RE = /발행\s*확정|추가\s*중(?:입니다)?|입니다|매도|매수|매출|체결|거래|확정|발행|호가|bid|offer|ask/gi;

/** 은행 이름 꼬리. 예담 발행사 보정·FRN 섹터 추론에 쓴다. */
const BANK_TAIL_RE = /(은행|뱅크|Bank)$/i;

/** 예담 헤더의 약칭 → 정식 은행명. 사전에 없으면 "은행" 만 붙인다. */
const BANK_ALIAS = {
  iM: 'iM뱅크', IM: 'iM뱅크', 아이엠: 'iM뱅크', 대구: 'iM뱅크',
  국민: 'KB국민은행', KB: 'KB국민은행', 기업: 'IBK기업은행', IBK: 'IBK기업은행',
  농협: 'NH농협은행', NH: 'NH농협은행', SC: 'SC제일은행', 제일: 'SC제일은행',
};

/** "기준일 + n개월" → YY.MM.DD. 말일 넘침은 그 달 말일로 접는다(1/31 + 1M = 2/28). */
function addMonths(base, n) {
  const [y, m, d] = base.split('-').map(Number);
  const t = (m - 1) + n;
  const yy = y + Math.floor(t / 12);
  const mm = (t % 12) + 1;
  const last = new Date(yy, mm, 0).getDate();
  return `${pad2(yy % 100)}.${pad2(mm)}.${pad2(Math.min(d, last))}`;
}

/** 연도 없는 월·일 → YY.MM.DD. 기준일 이전이면 다음 해(만기는 과거일 수 없다). */
function inferYear(base, mo, d) {
  const [y, bm, bd] = base.split('-').map(Number);
  const yy = (mo < bm || (mo === bm && d < bd)) ? y + 1 : y;
  return `${pad2(yy % 100)}.${pad2(mo)}.${pad2(d)}`;
}

/** 발행사 잔여물 청소 — 숫자·구두점만 남은 토막, 홀로 남은 조사 "에". */
function cleanIssuer(s) {
  if (!s) return null;
  const toks = String(s).replace(/[:：,]/g, ' ').split(/\s+/)
    .filter((t) => t && !/^[\d.\-–—~+]+$/.test(t) && !/^(에|로|으로|은|는|이|가)$/.test(t));
  return toks.join(' ').trim() || null;
}

/** 예담 발행사 보정 — "우리" → "우리은행", "iM" → "iM뱅크". */
function bankName(issuer) {
  if (!issuer || BANK_TAIL_RE.test(issuer)) return issuer;
  return BANK_ALIAS[issuer] ?? `${issuer}은행`;
}

/**
 * 한 줄 전처리. 채팅 문법을 걷어내 파서가 읽을 수 있는 한 줄과 부가정보로 나눈다.
 * @returns {{ text:string, speaker:string|null, tag:string|null, ref:string|null,
 *             frn:boolean, eff:number|null, notes:string[] }}
 */
export function preprocessLine(line, base) {
  let t = String(line ?? '');
  let speaker = null;
  let tag = null;
  let ref = null;
  let eff = null;
  const notes = [];

  const sp = t.match(SPEAKER_RE);
  if (sp) { speaker = sp[1]; t = t.slice(sp[0].length); }
  const tg = t.match(TAG_RE);
  if (tg) { tag = tg[1]; t = t.slice(tg[0].length); }

  // 괄호 — 내용으로 분류한다. (주) 는 법인격이라 남긴다(normalizeIssuer 가 처리).
  t = t.replace(PAREN_RE, (all, inner) => {
    const s = inner.trim();
    if (s === '주') return all;
    const e = s.match(/실효\s*(\d+(?:\.\d+)?)/);
    if (e) { eff = Number(e[1]); return ' '; }
    if (REF_RE.test(s)) { ref = ref ?? s.replace(/\s+/g, ''); return ' '; }
    if (/^[월화수목금토일]$/.test(s)) return ' ';
    if (s) notes.push(s);
    return ' ';
  });

  const r = t.match(REF_RE);
  if (r) { ref = ref ?? r[0].replace(/\s+/g, ''); t = t.replace(r[0], ' '); }

  const frn = FRN_RE.test(t);
  if (frn) t = t.replace(FRN_RE, ' ');

  t = t.replace(AMOUNT_MUL_RE, (_, a, b) => ` ${Number(a) * Number(b)}억 `);

  const md = t.match(MD_SLASH_RE) || t.match(MD_KO_RE);
  if (md) {
    const mo = Number(md[1]);
    const d = Number(md[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) t = t.replace(md[0], ` ${inferYear(base, mo, d)} `);
  }

  t = t.replace(NOISE_RE, ' ').replace(/\s+/g, ' ').trim();
  return { text: t, speaker, tag, ref, frn, eff, notes };
}

/**
 * 원장 이력에서 발행사+종류별 마지막 등급. 호가창은 등급을 거의 안 적는다.
 * @returns {Map<string,string>} `${issuer}|${kind}` → grade
 */
export function gradeHints(rows) {
  const out = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && r.issuer && r.grade) out.set(`${r.issuer}|${r.kind ?? ''}`, r.grade);
  }
  return out;
}

/**
 * 붙여넣은 텍스트 → 후보 목록.
 *
 * 후보는 **파서 행 모양 + 부가필드**다. 화면은 이것을 프리뷰처럼 고치게 한 뒤
 * `rowFromPreview` 로 저장 행을 다시 만든다(화면값이 이긴다 — 단건 입력과 같은 규약).
 *
 * @param {string} text
 * @param {{ date?:string, existing?:object[] }} [opts] existing = 화면 원장(중복·등급 힌트용)
 * @returns {{ candidates: object[], skipped: string[] }}
 *   candidate = { row, extras:{rate_type?,ref?,note?}, status, include }
 *   status: 'ok' | 'no_rate' | 'dup_batch' | 'dup_ledger'
 */
export function parseBatch(text, opts = {}) {
  const date = opts.date || todayLocal();
  const existing = Array.isArray(opts.existing) ? opts.existing : [];
  const hints = gradeHints(existing);
  const ledgerKeys = new Set(existing.map(dedupeKey));
  const batchKeys = new Set();
  const candidates = [];
  const skipped = [];
  let ctx = null; // { issuer, kind, sector, grade, header, notes, tag, speaker }

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const pre = preprocessLine(line, date);
    if (pre.speaker) ctx = null; // 화자가 바뀌면(또는 새 메시지면) 앞 문맥은 끝났다

    let p = parseQuoteLine(pre.text, { date });
    if (p.maturity_ym == null) {
      const tn = pre.text.match(TENOR_RE);
      if (tn) {
        const n = Number(tn[1]) * (/^(년|Y)$/.test(tn[2]) ? 12 : 1);
        const t2 = pre.text.replace(tn[0], ` ${addMonths(date, n)} `);
        p = parseQuoteLine(t2, { date });
      }
    }
    let issuer = cleanIssuer(p.issuer);
    const hasQuote = p.rate != null || p.maturity_ym != null || pre.ref != null;

    // ── 헤더: 시세가 없고 종류·태그가 있는 줄 ──
    if (!hasQuote) {
      if ((p.kind || pre.tag) && (issuer || p.kind)) {
        ctx = {
          issuer: p.kind === '예담' ? bankName(issuer) : issuer,
          kind: p.kind, sector: p.sector, grade: p.grade,
          header: line, notes: pre.notes, tag: pre.tag, speaker: pre.speaker,
        };
      } else {
        skipped.push(line);
      }
      continue;
    }

    // ── 시세 줄 ──
    let kind = p.kind;
    let sector = p.sector;
    let grade = p.grade;
    let header = null;
    let notes = [...pre.notes];
    let tag = pre.tag;
    let speaker = pre.speaker;
    if (!issuer && ctx) {
      issuer = ctx.issuer;
      kind = kind ?? ctx.kind;
      sector = sector ?? ctx.sector;
      grade = grade ?? ctx.grade;
      header = ctx.header;
      notes = [...ctx.notes, ...notes];
      tag = tag ?? ctx.tag;
      speaker = speaker ?? ctx.speaker;
    } else {
      ctx = null; // 제 발행사를 가진 줄 — 문맥 끊김
    }
    if (kind === '예담') issuer = bankName(issuer);
    if (pre.frn && kind == null) {
      kind = BOND_KIND;
      sector = issuer && BANK_TAIL_RE.test(issuer) ? '은행채' : null;
    }

    const flags = [...p.flags.filter((f) => f !== 'no_issuer' && f !== 'kind_inferred')];
    if (!issuer) flags.push('no_issuer');
    if (!grade && issuer) {
      const h = hints.get(`${issuer}|${kind ?? ''}`);
      if (h) { grade = h; flags.push('grade_from_ledger'); }
    }
    if (header) flags.push('from_header');

    const noteParts = [];
    if (tag) noteParts.push(tag);
    noteParts.push(...notes);
    if (pre.eff != null) noteParts.push(`실효 ${pre.eff}%`);

    const row = {
      date,
      issuer,
      issuer_raw: issuer,
      kind: kind ?? null,
      sector: kind === BOND_KIND ? (sector ?? null) : null,
      grade: grade ?? null,
      maturity_ym: p.maturity_ym,
      maturity_date: p.maturity_date,
      rate: p.rate,
      amount: p.amount,
      source: speaker,
      raw: header ? `${header} | ${line}` : line,
      flags,
    };
    const extras = {};
    if (pre.frn) extras.rate_type = 'frn';
    if (pre.ref) extras.ref = pre.ref;
    if (noteParts.length) extras.note = noteParts.join(' · ');

    const key = dedupeKey(row);
    let status = row.rate == null ? 'no_rate' : 'ok';
    if (ledgerKeys.has(key)) status = 'dup_ledger';
    else if (batchKeys.has(key)) status = 'dup_batch';
    batchKeys.add(key);
    // 기본 체크: 금리가 있거나(FRN 이면 스프레드라도) 있고, 중복이 아닐 때.
    const include = (status === 'ok') || (status === 'no_rate' && !!extras.ref);
    candidates.push({ row, extras, status, include });
  }
  return { candidates, skipped };
}
