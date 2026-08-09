// rv-parser.js — K-Bond 메신저 호가 파서. Fenrir src/lib/parsers/kbond.js 의 순수 함수 이식.
//   측정 도구용 vanilla ES module. 원본과의 차이(의도적 최소 변경):
//     1) `import { matchIssuer }` 제거 → parseKbondQuotes 3번째 인자로 매처 주입(DI).
//        (Fenrir는 kbond.js:864에서 2인자 호출로 abbreviation 단계 미배선 — bpbybp는 Phase 3에서 주입)
//     2) 파일 하단 자기테스트 블록 제거(Node 전용).
//     3) parseKbondQuotes 가 `unparsed[]`(제외/미파싱 라인 원문+사유)도 반환 — "라인 버리지 않는다" 요구.
//   그 외 파싱 로직·정규식은 원본과 동일(diff 용이).

// 메시지 시작 패턴: "이름 (HH:MM:SS) :"
const MESSAGE_START_RE = /^(.+?)\s*\((\d{2}:\d{2}:\d{2})\)\s*:\s*(.*)/;
const SYSTEM_MESSAGE_RE = /퇴장하였습니다|입장하였습니다/;
const CP_CD_RE = /\bCP\b|\bCD\b|알전단|\bCMA\b/i;
const NON_INDIVIDUAL_RE = /매수관심|사자관심|이내|이후|저쿠폰|잔존|연내|있나요|\d+년\s*말|\d+년\s*초|\d+개월|\d+\s*[~\-]\s*\d+\s*년/;

/** K-Bond 로그 원문 → 구조화 메시지 배열 */
export function parseKbondLog(rawText) {
  const lines = rawText.split('\n');
  const stats = { total_lines: lines.length, system_messages: 0, empty_lines: 0, merged_lines: 0, preprocessed_count: 0 };
  const merged = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { stats.empty_lines++; continue; }
    if (SYSTEM_MESSAGE_RE.test(trimmed)) { stats.system_messages++; continue; }
    if (MESSAGE_START_RE.test(trimmed)) {
      merged.push(trimmed);
    } else {
      if (merged.length > 0) {
        const isIndependentQuote = /^[0-9가-힣]/.test(trimmed) && /팔자|사자/.test(trimmed);
        const isBracketStart = /^[\[\(]/.test(trimmed);
        if (isIndependentQuote && !isBracketStart) {
          const prevMatch = merged[merged.length - 1].match(MESSAGE_START_RE);
          if (prevMatch) {
            merged.push(`${prevMatch[1]} (${prevMatch[2]}) : ${trimmed}`);
            stats.merged_lines++;
          } else { merged.push(trimmed); }
        } else {
          merged[merged.length - 1] += ' ' + trimmed;
          stats.merged_lines++;
        }
      } else { merged.push(trimmed); }
    }
  }

  const preprocessed = [];
  for (const line of merged) {
    const match = line.match(MESSAGE_START_RE);
    if (!match) continue;
    const trader_name = match[1].trim();
    const timestamp = match[2];
    const raw_content = match[3].trim();
    if (!raw_content) continue;
    preprocessed.push({
      timestamp, trader_name, raw_content,
      is_cp_cd: CP_CD_RE.test(raw_content),
      is_individual_bond: !NON_INDIVIDUAL_RE.test(raw_content),
    });
  }
  stats.preprocessed_count = preprocessed.length;
  return { preprocessed, stats };
}

function expandYear(yy) { return yy <= 50 ? 2000 + yy : 1900 + yy; }
function isValidDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}
function adjustConfidence(yy, baseConfidence) { return (yy >= 26 && yy <= 35) ? baseConfidence : 'low'; }

/** 만기일 추출 → { date:'YYYY-MM-DD', confidence, matched_text } | null */
export function parseMaturity(content) {
  if (!content || typeof content !== 'string') return null;

  const reYMDDay = /(\d{2})\.(\d{1,2})\.(\d{1,2})\([월화수목금토일]\)/;
  const m1 = content.match(reYMDDay);
  if (m1) {
    const [matched, yyStr, mStr, dStr] = m1;
    const yy = parseInt(yyStr, 10), year = expandYear(yy), month = parseInt(mStr, 10), day = parseInt(dStr, 10);
    if (isValidDate(year, month, day)) return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, confidence: adjustConfidence(yy, 'high'), matched_text: matched };
  }
  const reYMD = /(?<![가-힣a-zA-Z0-9])(\d{2})\.(\d{1,2})\.(\d{1,2})(?!\()/;
  const m2 = content.match(reYMD);
  if (m2) {
    const yy = parseInt(m2[1], 10), year = expandYear(yy), month = parseInt(m2[2], 10), day = parseInt(m2[3], 10);
    if (isValidDate(year, month, day)) return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, confidence: adjustConfidence(yy, 'high'), matched_text: m2[0] };
  }
  const reYMDSpace = /^(\d{2})\s+(\d{1,2})\s+(\d{1,2})(?:\s|$)/;
  const m3 = content.match(reYMDSpace);
  if (m3) {
    const yy = parseInt(m3[1], 10), year = expandYear(yy), month = parseInt(m3[2], 10), day = parseInt(m3[3], 10);
    if (isValidDate(year, month, day)) return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, confidence: adjustConfidence(yy, 'medium'), matched_text: m3[0].trimEnd() };
  }
  const reYMDKorean = /(\d{2})년\s*(\d{1,2})월\s*(\d{1,2})일/;
  const m4 = content.match(reYMDKorean);
  if (m4) {
    const yy = parseInt(m4[1], 10), year = expandYear(yy), month = parseInt(m4[2], 10), day = parseInt(m4[3], 10);
    if (isValidDate(year, month, day)) return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, confidence: adjustConfidence(yy, 'medium'), matched_text: m4[0] };
  }
  const reMD = /^(\d{1,2})\.(\d{1,2})(?:\s|$)/;
  const m5 = content.match(reMD);
  if (m5) {
    const month = parseInt(m5[1], 10), day = parseInt(m5[2], 10);
    if (isValidDate(2026, month, day)) return { date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, confidence: 'low', matched_text: m5[0].trimEnd() };
  }
  return null;
}

/** 매도/매수 방향 → 'offer'|'bid'|'interest'|null */
export function parseSide(content) {
  if (!content || typeof content !== 'string') return null;
  if (/거래완료/.test(content)) return null;
  if (/교체/.test(content)) return 'offer';
  if (/팔자|매도|\(팔\)/.test(content)) return 'offer';
  if (/사자|매수|\(사\)/.test(content)) return 'bid';
  if (/관심/.test(content)) return 'interest';
  return null;
}

/** 민평 수익률·끝전 → { yield, kkeutjeon } | null */
export function parseMinpyeong(content) {
  if (!content || typeof content !== 'string') return null;
  let yieldMatch = content.match(/민평\s*:\s*(\d+\.?\d*)%?/);
  if (!yieldMatch) yieldMatch = content.match(/민\.?\s*(\d+\.?\d*)/);
  if (!yieldMatch) return null;
  const yieldVal = parseFloat(yieldMatch[1]);
  if (isNaN(yieldVal)) return null;

  let kkeutjeon = null;
  let kkMatch = content.match(/끝전\s*:\s*(\d+\.?\d*)/);
  if (!kkMatch) {
    kkMatch = content.match(/끝\s*\.(\d+)/);
    if (kkMatch) kkeutjeon = parseFloat('0.' + kkMatch[1]);
  } else { kkeutjeon = parseFloat(kkMatch[1]); }
  if (kkeutjeon === null) {
    const afterYield = content.slice(yieldMatch.index + yieldMatch[0].length);
    const implicitKk = afterYield.match(/^[\s,/]+\.(\d+)/);
    if (implicitKk) kkeutjeon = parseFloat('0.' + implicitKk[1]);
  }
  if (kkeutjeon === null) {
    const separateKk = content.match(/\(\.(\d+)\)/);
    if (separateKk) kkeutjeon = parseFloat('0.' + separateKk[1]);
  }
  return { yield: yieldVal, kkeutjeon };
}

/**
 * 스프레드 → { type, value } | null
 *
 * ── B-6 수정 (2026-08-05) ────────────────────────────────────────────────
 * 이전에는 마지막에 `if (/팔자|사자/) return {type:'flat', value:0}` 폴백이 있었다.
 * 그 결과 **레벨을 전혀 제시하지 않은 호가**("27.5.4 지에스리테일34-2 (민 3.802) 팔자")
 * 까지 "민평에 판다(0bp)"로 확정됐고, rv-engine.quoteYield 가 이를 `y = 민평` 으로
 * 채택해 원괴리 0 으로 횡단면에 유입시켰다. 2026-08-05 샘플 실측으로 이것이 전체 호가의
 * 54.8% (1,959/3,579)였음이 확인됐다 — 버킷 중앙값(시장 베타 근사)이 0쪽으로 끌린다.
 *
 * **폴백을 없애는 것이 아니라, flat 을 명시 표현일 때만 확정한다.** 레벨이 없으면
 * 0bp 가 아니라 **모른다(null)** 이다. RV-2 가 이미 쓰는 규약(RV2_FLAT_RE)의 역이식이며,
 * 명시 flat 정규식도 RV-2 와 동일 범위로 맞춘다(`민평 팔자` 형태 포함).
 * 참조: rv2-phase0-report.md §7 B-6, js/rv2-parser.js RV2_FLAT_RE.
 */
export const EXPLICIT_FLAT_RE = /민평?\s*(?:팔자|사자)|플랫|\bflat\b|\.\.(?:팔자|사자)/i;

export function parseSpread(content) {
  if (!content || typeof content !== 'string') return null;
  const wonMatch = content.match(/([+-]?\d+\.?\d*)원/);
  if (wonMatch) return { type: 'won', value: parseFloat(wonMatch[1]) };
  const bpMatch = content.match(/([+-]?\d+\.?\d*)\s*(?:bp|비피)/i);
  if (bpMatch) return { type: 'bp', value: parseFloat(bpMatch[1]) };
  const overMatch = content.match(/오[버바]\s*(\d+\.?\d*)/);
  if (overMatch) return { type: 'bp', value: parseFloat(overMatch[1]) };
  if (EXPLICIT_FLAT_RE.test(content)) return { type: 'flat', value: 0 };
  const absMatch = content.match(/(\d+\.\d+)%?\s*(?:팔자|사자)|(?:팔자|사자)\s*(\d+\.\d+)%/);
  if (absMatch) return { type: 'absolute', value: parseFloat(absMatch[1] || absMatch[2]) };
  return null; // 레벨 없음 = 미상. 0bp 로 단정하지 않는다(B-6).
}

/** 신용등급 → string | null */
export function parseRating(content) {
  if (!content || typeof content !== 'string') return null;
  const ratingRe = /(?:^|[\s,(/])((AAA|AA[+\-0]?|A[0+\-]|A[23][+\-]?|BBB[+\-]?|BB[+\-]?|B[+\-]?))(?:[\s,)/]|$)/;
  const m = content.match(ratingRe);
  if (!m) return null;
  let rating = m[1];
  if (rating === 'AA') rating = 'AA0';
  if (rating === 'A') return null;
  return rating;
}

/** 실제 제시 수익률(민평과 별개) → number | null */
export function parseActualYield(content) {
  if (!content || typeof content !== 'string') return null;
  const cleaned = content.replace(/[(\[](민|민평)[^)\]]*[)\]]/g, '');
  let m = cleaned.match(/(?:팔자|사자|매도|매수)\s+(\d+\.\d+)%?/);
  if (m) return parseFloat(m[1]);
  m = cleaned.match(/(\d+\.\d+)%?\s+(?:팔자|사자|매도|매수)/);
  if (m) return parseFloat(m[1]);
  return null;
}

/** 발행사명 + 종목코드 → { issuer_raw, bond_code } | null */
export function parseIssuerRaw(content, maturityMatchedText) {
  if (!content || typeof content !== 'string') return null;
  let text = content;
  if (maturityMatchedText) text = text.replace(maturityMatchedText, '');

  text = text.replace(/\[[^\]]*(?:\d{2,4}-\d{3,4}|\b증권\b|FICC|매크로|투자|CMS|채권|채금|증금)[^\]]*\]/g, '');
  text = text.replace(/\((?!민)(?!민평)[^)]*(?:\d{3,4}-\d{3,4}|\b증권\b|FICC|매크로|투자|CMS)[^)]*\)/g, '');
  text = text.replace(/[(\[]\s*민평?\s*[^)\]]*[)\]]/g, '');
  text = text.replace(/\([^)]*민\s*\d[^)]*\)/g, '');
  text = text.replace(/\[[^\]]*민\s*\d[^\]]*\]/g, '');
  text = text.replace(/\[\d+\.?\d*억\]/g, '');
  text = text.replace(/\[자투리\]/g, '');
  text = text.replace(/\s*(팔자|사자|매도|매수|관심|교체|거래완료)\s*/g, ' ');
  text = text.replace(/\(사\)|\(팔\)/g, '');
  text = text.replace(/\(수반\)|\(교체\)/g, '');
  text = text.replace(/\(수\d+\)/g, '');
  text = text.replace(/\(,\s*[월화수목금토일]\)/g, '');
  text = text.replace(/<[^>]*(?:\d{2,4}-\d{3,4}|증권|FICC|매크로|투자|CMS)[^>]*>/g, '');
  text = text.replace(/\s*\S+님이\s+(?:입장하셨습니다|입장하였습니다|퇴장하였습니다)\.?\s*/g, ' ');
  text = text.replace(/[+-]?\d+\.?\d*\s*(?:원|bp|비피)/gi, '');
  text = text.replace(/오[버바]\s*\d+\.?\d*/g, '');
  text = text.replace(/플랫|flat/gi, '');
  text = text.replace(/\d+\.\d+(?:\/\d+\.\d+)?%/g, '');
  text = text.replace(/\d+\.\d+\/\d+\.\d+/g, '');
  text = text.replace(/\d+\.\d+\/\s*$/g, '');
  text = text.replace(/\d+억(?:\*\d+)?/g, '');
  text = text.replace(/\([월화수목금토일]\)/g, '');
  text = text.replace(/끝전?\s*[:.]\s*\d+\.?\d*/g, '');
  text = text.replace(/[,\s]+(?:AAA|AA[+\-0]?|A[0+\-]|BBB[+\-]?)(?=[\s,)/]|$)/g, '');
  text = text.replace(/\((?:AAA|AA[+\-0]?|A[0+\-]|BBB[+\-]?|aa[+\-0]?|a[0+\-]|bbb[+\-]?)\)/gi, '');
  text = text.replace(/\s*민평?\s*:\s*\d+\.?\d*%?/g, '');
  text = text.replace(/(?:^|\s)금(?:\s|$)/g, ' ');
  text = text.trim();
  text = text.replace(/\(\s*\)/g, '').trim();
  if (!text) return null;

  let bond_code = null;
  const tildeCode = text.match(/[~～]([A-Z]?\d+)/);
  if (tildeCode) {
    bond_code = tildeCode[1];
    text = text.replace(tildeCode[0], '').trim();
    text = text.replace(/\(\s*\)/g, '').trim();
  }
  if (!bond_code) {
    const hyphenCode = text.match(/(\d+-\d+)(?:\([^)]*\))*\s*$/);
    if (hyphenCode) {
      bond_code = hyphenCode[1];
      const codeIdx = text.indexOf(bond_code);
      const beforeCode = text.slice(0, codeIdx).trim();
      const afterCode = text.slice(codeIdx + bond_code.length).trim();
      text = beforeCode;
      if (afterCode) {
        const suffix = afterCode.match(/^(\([^)]*\))+/);
        if (suffix) text = beforeCode + bond_code + suffix[0];
      }
    }
  }
  if (!bond_code) {
    const numCode = text.match(/^(.+?[가-힣])(\d{2,})(?:\([^)]*\))*$/);
    if (numCode) { text = numCode[1]; bond_code = numCode[2]; }
  }
  text = text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\(\s*\)/g, '').trim();
  if (!text) return null;

  const ISSUER_PARENS_TOKENS = new Set(['상', '후', '지', '녹', '중앙회', '은행', '이중상환', '할']);
  const isIssuerParen = (inner) => {
    if (ISSUER_PARENS_TOKENS.has(inner)) return true;
    if (/^[상후지]\/[상후지]$/.test(inner)) return true;
    if (/이자/.test(inner)) return true;
    return false;
  };

  let cutPos = -1;
  const parenRe = /\(([^)]*)\)/g;
  let pm;
  while ((pm = parenRe.exec(text)) !== null) {
    const inner = pm[1].trim();
    if (isIssuerParen(inner)) continue;
    if (/^(?:AAA|AA[+\-0]?|A[0+\-]|BBB[+\-]?|BB[+\-]?|B[+\-]?)$/i.test(inner)) { cutPos = pm.index; break; }
    if (/^민/.test(inner)) { cutPos = pm.index; break; }
    if (/^끝/.test(inner)) { cutPos = pm.index; break; }
    if (/^\.\d+$/.test(inner) || /^\d+\.\d+$/.test(inner)) { cutPos = pm.index; break; }
    if (/^,\s*[월화수목금토일]$/.test(inner)) { cutPos = pm.index; break; }
    if (/^KR\d/.test(inner)) { cutPos = pm.index; break; }
    if (inner.length > 10 && /[,，]/.test(inner) && /확약|담보|사업|시설/.test(inner)) { cutPos = pm.index; break; }
    if (/^녹색/.test(inner)) { cutPos = pm.index; break; }
    if (/^DE\d/.test(inner)) { cutPos = pm.index; break; }
  }
  if (cutPos >= 0) text = text.slice(0, cutPos).trim();

  text = text.replace(/\.\.+.*$/, '').trim();
  text = text.replace(/\s+민\.?\s*\d+\.\d+.*$/, '').trim();
  text = text.replace(/\s+끝전?\.?\d+.*$/, '').trim();
  text = text.replace(/\s+\d+\.\d+\s*$/, '').trim();
  text = text.replace(/\s+\.\d+\s*$/, '').trim();
  text = text.replace(/\s*(?:수반|교체)\s*$/, '').trim();
  text = text.replace(/\s*\/민.*$/, '').trim();
  text = text.replace(/'\s*$/, '').trim();
  text = text.replace(/\s+다마\s*$/, '').trim();
  text = text.replace(/\)\s*$/, (mm, offset) => {
    const before = text.slice(0, offset);
    const openCount = (before.match(/\(/g) || []).length;
    const closeCount = (before.match(/\)/g) || []).length;
    return openCount > closeCount ? ')' : '';
  }).trim();
  text = text.replace(/\(\s*\)/g, '').trim();
  if (!text) return null;

  return { issuer_raw: text, bond_code };
}

/** 태그 추출 → string[] */
export function parseTags(content) {
  if (!content || typeof content !== 'string') return [];
  const tags = [];
  if (/수반/.test(content)) tags.push('suban');
  if (/교체/.test(content)) tags.push('replace');
  if (/거래완료/.test(content)) tags.push('completed');
  if (/\(녹\)|녹채/.test(content)) tags.push('green');
  if (/ESG/i.test(content)) tags.push('esg');
  if (/조건부/.test(content)) tags.push('conditional');
  if (/후순위|\(후\)/.test(content)) tags.push('subordinated');
  if (/신종/.test(content)) tags.push('perpetual');
  return tags;
}

/** 브로커·전화번호 → { broker, phone } */
export function parseBroker(content) {
  if (!content || typeof content !== 'string') return { broker: null, phone: null };
  const bracketMatches = [...content.matchAll(/\[([^\]]+)\]/g)];
  const parenMatches = [...content.matchAll(/\(([^)]+)\)/g)];
  const candidates = [];
  for (const m of bracketMatches) candidates.push(m[1]);
  for (const m of parenMatches) {
    const inner = m[1];
    if (/^민/.test(inner) || /^민평/.test(inner)) continue;
    if (/^[월화수목금토일]$/.test(inner)) continue;
    if (/^(?:AAA|AA[+\-0]?|A[0+\-]|BBB[+\-]?)$/.test(inner.trim())) continue;
    if (/^\d{2}\.\d{1,2}\.\d{1,2}/.test(inner)) continue;
    if (/^[후상사팔녹]$/.test(inner.trim())) continue;
    if (/^\.\d+$/.test(inner.trim())) continue;
    if (/\d{2,4}-\d{3,4}/.test(inner) || /증권|FICC|투자|매크로|증금|CMS/.test(inner)) candidates.push(inner);
  }
  if (candidates.length === 0) return { broker: null, phone: null };
  const raw = candidates[candidates.length - 1].trim();
  const phoneMatch = raw.match(/(\d{2,4}-\d{3,4}-\d{4}|\d{3,4}-\d{4})/);
  const phone = phoneMatch ? phoneMatch[1] : null;
  let broker = phone ? raw.replace(phone, '').trim() : raw.trim();
  if (!broker) broker = null;
  return { broker, phone };
}

/**
 * 통합 파서: rawText → { quotes, stats, unparsed }
 * @param {string} rawText
 * @param {Array} [aliases=[]] IssuerAlias 배열 (비면 issuer_canonical 전부 null)
 * @param {Function|null} [matchIssuerFn=null] 매처 주입 (Phase 3). (raw, aliases, abbreviations) → {canonical,match_type}|null
 * @param {Object} [abbreviations={}] 축약어 사전 (matchIssuerFn 3번째 인자로 전달)
 */
export function parseKbondQuotes(rawText, aliases = [], matchIssuerFn = null, abbreviations = {}) {
  const { preprocessed, stats: preStats } = parseKbondLog(rawText);
  const integrationStats = {
    total_lines: preStats.total_lines, preprocessed: preStats.preprocessed_count,
    excluded_cp_cd: 0, excluded_general_interest: 0, excluded_no_side: 0,
    quotes_total: 0, confidence: { high: 0, medium: 0, low: 0 },
  };
  const quotes = [];
  const unparsed = []; // bpbybp 추가: 제외/미파싱 라인 원문 보존

  for (const item of preprocessed) {
    if (item.is_cp_cd) {
      integrationStats.excluded_cp_cd++;
      unparsed.push({ raw: item.raw_content, trader_name: item.trader_name, timestamp: item.timestamp, reason: 'CP/CD 제외' });
      continue;
    }
    if (!item.is_individual_bond) {
      integrationStats.excluded_general_interest++;
      unparsed.push({ raw: item.raw_content, trader_name: item.trader_name, timestamp: item.timestamp, reason: '일반관심 제외' });
      continue;
    }
    const side = parseSide(item.raw_content);
    if (side === null) {
      integrationStats.excluded_no_side++;
      unparsed.push({ raw: item.raw_content, trader_name: item.trader_name, timestamp: item.timestamp, reason: '매수/매도 방향 없음' });
      continue;
    }

    const maturity = parseMaturity(item.raw_content);
    const maturityDate = maturity ? maturity.date : null;
    const maturityMatchedText = maturity ? maturity.matched_text : '';
    const minpyeong = parseMinpyeong(item.raw_content);
    const spread = parseSpread(item.raw_content);
    const rating = parseRating(item.raw_content);
    const actualYield = parseActualYield(item.raw_content);
    const issuerResult = parseIssuerRaw(item.raw_content, maturityMatchedText);
    const tags = parseTags(item.raw_content);
    const brokerResult = parseBroker(item.raw_content);

    const issuer_raw = issuerResult ? issuerResult.issuer_raw : null;
    const minpyeong_yield = minpyeong ? minpyeong.yield : null;

    let requiredCount = 0;
    if (maturityDate) requiredCount++;
    if (issuer_raw) requiredCount++;
    requiredCount++; // side present
    if (minpyeong_yield !== null) requiredCount++;

    let parse_confidence;
    if (requiredCount === 4 && maturity && maturity.confidence === 'high') parse_confidence = 'high';
    else if (requiredCount === 4) parse_confidence = 'medium';
    else if (requiredCount >= 3) parse_confidence = 'medium';
    else parse_confidence = 'low';

    // 발행사 canonical 매칭 — Phase 3에서 매처+aliases 주입 시에만 동작.
    const issuerRawStr = issuer_raw || '';
    let issuer_canonical = null;
    let match_type = null;
    if (issuerRawStr && aliases.length > 0 && typeof matchIssuerFn === 'function') {
      const matchResult = matchIssuerFn(issuerRawStr, aliases, abbreviations);
      if (matchResult) { issuer_canonical = matchResult.canonical; match_type = matchResult.match_type; }
    }

    quotes.push({
      timestamp: item.timestamp, trader_name: item.trader_name,
      broker: brokerResult.broker, broker_phone: brokerResult.phone,
      maturity_date: maturityDate, issuer_raw: issuerRawStr, issuer_canonical, match_type,
      bond_code: issuerResult ? issuerResult.bond_code : null,
      rating, side, minpyeong_yield,
      minpyeong_kkeutjeon: minpyeong ? minpyeong.kkeutjeon : null,
      spread_type: spread ? spread.type : null, spread_value: spread ? spread.value : null,
      actual_yield: actualYield, volume: null, tags,
      is_cp_cd: false, is_individual_bond: true,
      parse_confidence, unparsed_fragment: null, raw_line: item.raw_content,
    });
    integrationStats.confidence[parse_confidence]++;
  }

  integrationStats.quotes_total = quotes.length;
  if (aliases.length > 0) {
    let matchedCount = 0;
    const unmatchedFreq = {};
    for (const q of quotes) {
      if (q.issuer_canonical) matchedCount++;
      else if (q.issuer_raw) unmatchedFreq[q.issuer_raw] = (unmatchedFreq[q.issuer_raw] || 0) + 1;
    }
    integrationStats.matched_issuer_count = matchedCount;
    integrationStats.unmatched_issuers_sample = Object.entries(unmatchedFreq)
      .sort((a, b) => b[1] - a[1]).slice(0, 50).map(([raw, count]) => ({ raw, count }));
  }
  return { quotes, stats: integrationStats, unparsed };
}
