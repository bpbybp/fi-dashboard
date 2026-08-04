# RV-2 케이본드 호가 랭킹 스크리너 — Phase 0 감사 보고

작성일: 2026-08-04
상태: **승인 완료** (민수, 2026-08-04) — Phase 1 착수
대상 명령서: RV-2 케이본드 호가 랭킹 스크리너 (bpbybp/fi-dashboard)

---

## 1. 저장소 현황

`git fetch` 완료. `origin/main`과 **0/0 동기화** (커밋 `659821c`). 작업 트리에 추적 대상 변경 없음.

### 1.1 테스트 베이스라인 (`node --test`, 인자 없이 자동탐색)

| 실패 | 위치 | 성격 |
|---|---|---|
| `cp-q3c-hikes.test.mjs` | `_backup_untracked/` | 미추적 백업 디렉터리를 러너가 주워감 |
| `OO-1 Gate` | `tests/local/anchors.local.test.mjs` | 로컬 실데이터 앵커 드리프트 (61행 vs 기대 40행) |
| `OO-4 Gate` | `tests/local/anchors.local.test.mjs` | 로컬 실데이터 앵커 드리프트 (`liquidity` vs 기대 `period`) |
| `tools/test-phase3.js` | `tools/` | 테스트가 아닌 도구 파일을 러너가 주워감 |

명령서가 말한 **4건 pre-existing failure와 정확히 일치**. Phase 4에서는 이 4건 외 신규 실패만 확인한다.
3건은 테스트 로직 문제가 아니라 **러너 탐색 범위 문제**(`_backup_untracked/`, `tools/`)이며 별건 과제(§7).

---

## 2. Fenrir 이식성 — 이미 완료됨

명령서 §1.6이 예상한 "Fenrir trading-board 파서 참조 이식"은 **RV-1 Phase 2 커밋(`47a44ba`)에서 이미
수행되었고, 원본과 로직 diff가 0**임을 확인했다.

| bpbybp | Fenrir 원본 | 상태 |
|---|---|---|
| `js/rv-parser.js` (438줄) | `src/lib/parsers/kbond.js` (946줄) | 정규식·로직 동일. 차이는 주석/포맷 압축 + `matchIssuer` DI 주입 + `unparsed[]` 반환 추가 |
| `js/rv-abbrev.js` (37줄) | `issuer-abbreviations.js` (34줄) | **항목 완전 동일** (21항목). 주석만 추가 |
| `js/rv-matcher.js` (90줄) | `issuer-matcher.js` | 8단계 매칭 동일. Fenrir가 미배선한 abbreviation 단계까지 bpbybp는 배선함 |

→ **재이식 불필요.** RV-2는 이 3개 파일을 읽기 전용으로 import한다.

### 2.1 RV-2 요구 대비 실제 갭

| §1.3~1.5 요구 | 현황 | 조치 |
|---|---|---|
| 만기 (27.8.3 등) | ✅ `parseMaturity` 5패턴 | 재사용 |
| 등급 | ✅ `parseRating` | 재사용 |
| 민평 + 끝전 | ✅ `parseMinpyeong` | 재사용 |
| 딜러 전화번호 (중복제거 주 키) | ✅ `parseBroker` → `{broker, phone}` | 재사용 |
| 방향 팔자/사자/교체 | ✅ `parseSide` (교체→offer) | 재사용 |
| 오버N | ✅ `/오[버바]\s*(\d+\.?\d*)/` | 재사용 |
| 민평팔자 0bp | ✅ `spread_type='flat'` | 재사용 |
| 명시수익률 | ✅ `parseActualYield` | 재사용 |
| "+N원" 결측 | ✅ `spread_type='won'` 로 식별 가능 | `offset_bp=null` 매핑 |
| **언더N** | ❌ 없음 — 오버만 구현 | **rv2 계층에서 신규** (rv-parser 불변) |
| **체결마커 동/동통/대치** | ❌ 없음 (`거래완료`만 태그) | rv2 신규 |
| **수량 (100억, 50억\*5장)** | ❌ `volume: null` 하드코딩 | rv2 신규 |
| **offset_bp 산출** | ❌ §1.4 우선순위 레이어 자체가 부재 | rv2 신규 |

### 2.2 설계에 영향 주는 위험 3건

**(A) 사자 수요 패널(§3.3)이 현재 파서가 버리는 라인을 필요로 한다.**
`rv-parser.js:13`의 `NON_INDIVIDUAL_RE`가 `이내|이후|잔존|연내|N개월|N~N년`을 "일반관심"으로 제외한다.
그런데 §3.3이 집계하려는 "1.5년 특은 사자", "2~3년 매수관심"이 바로 이 패턴이다. RV-1에선 정확한
만기가 필수라 제외가 옳았지만, **RV-2에선 제외 대상이 곧 수요 신호**다.
→ **해결: rv2 프리패스가 버킷수요 레인으로 분기** (승인된 결정).

**(B) `입장하셨습니다`가 시스템 메시지 필터에 없다.**
`SYSTEM_MESSAGE_RE = /퇴장하였습니다|입장하였습니다/` — 명령서 §1.2가 명시한 존댓말형은 미매칭.
단순 누락이 아니라 **실질 오염**이다: `parseKbondLog`의 멀티라인 병합(`rv-parser.js:38`)이 이 라인을
직전 호가 메시지에 붙여버린다. (`parseIssuerRaw:205`의 제거 로직은 그 밴드에이드.)
→ **해결: rv2 프리패스가 `parseKbondLog` 호출 이전, 원문 라인 단위로 제거** (승인된 결정).

**(C) 중복 제거 의미론이 RV-1과 정반대다.**
RV-1 `accumulate()`는 동일 키를 **덮어쓴다**(`rv-screener-ui.js:213`). RV-2 §1.7은 레벨 변경 시
**append**(observations 배열 = v2 수명주기 데이터). 키도 다르다(RV-1: issuer+code+만기+side /
RV-2: 전화번호+종목+side+offset).
→ **저장 계층 재사용 불가, Phase 3에서 신규 작성.**

---

## 3. 페이지 배치 — 신규 페이지 (승인됨)

**결정: 신규 `rv2-quote-rank.html` + `js/rv2-*.js`.** 근거:

1. **데이터 소스가 완전히 다름.** RV-1은 인포맥스 4788 민평 xlsx 업로드가 전제(SheetJS 의존).
   RV-2는 민평이 호가 라인 안에 있어 업로드가 없다. 공유 상태 0.
2. **테마 충돌.** §3.5는 KB CI 라이트를 요구하는데 `rv-screener.html`은 다크 전용(`--bg:#0d1117`).
   라이트 선례는 `curve-phase.html`/`onoff-spread.html`의 `[data-cp-theme='light']` 토큰 세트.
3. **저장 스키마 충돌** (§2.2-C).
4. 확장 선례(README:40의 GC → curve-phase 내 섹션)는 데이터 도메인이 같았기 때문. 여기선 다르다.

### 3.1 파서 방식 — 프리패스 + 위임 래퍼 (승인됨)

`rv-parser.js`에는 **테스트가 하나도 없다**(`tests/`에 `rv-calc`, `rv-curves`만 존재). 직접 수정은
RV-1 회귀 위험이 크다. → `js/rv2-parser.js`가 래퍼가 되고, **`rv-parser` 호출 이전에 프리패스**를 둔다:

```
원문 텍스트
  └─ [rv2 프리패스] 라인 단위 사전 분류
       ├─ 시스템메시지(입장하셨습니다 포함) → 폐기·카운트만      ← 2.2-(B) 해결
       ├─ (나머지 → parseKbondLog 로 멀티라인 병합)
       │    └─ [메시지 단위 분류]
       │         ├─ 개별호가   → rv-parser 추출기 위임 + rv2 증강(offset_bp·수량·체결마커)
       │         ├─ 버킷수요   → rv2 자체 수요 파서                ← 2.2-(A) 해결
       │         └─ 미분류     → 원문 보존
```

`rv-parser.js`는 **불변**. 언더N의 RV-1 측 갭은 별건 과제로 분리(§7).

---

## 4. 불변 파일 리스트 (명시 선언)

RV-2 작업 중 **`git diff`가 비어 있어야 하는 파일**:

- `js/rv-parser.js`, `js/rv-matcher.js`, `js/rv-abbrev.js` — 읽기 전용 import만
- `js/rv-engine.js`, `js/rv-cross.js`, `js/rv-screener-ui.js`, `rv-screener.html` — RV-1 전체
- `js/rv-calc.js`, `js/rv-backtest.js`, `js/rv-chart.js`, `js/rv-curves.js`, `js/rv-heatmap.js`,
  `js/rv-ui.js`, `curve-rv.html` — 별개 Curve RV 모듈
- 그 외 모든 `*.html`, `js/curve-phase/`, `js/gc/`, `data/`, `tools/`(신규 마스킹 스크립트 제외),
  기존 `tests/*.test.mjs`
- `DESIGN.md`, `README.md`

**변경 허용 파일** (신규 7 + 수정 2):

| 구분 | 파일 | Phase |
|---|---|---|
| 신규 | `tools/mask-kbond-sample.mjs` | 0 |
| 신규 | `js/rv2-parser.js` | 1 |
| 신규 | `tests/rv2-parser.test.mjs` | 1 |
| 신규 | `tests/fixtures/kbond-sample.masked.txt` | 1 |
| 신규 | `js/rv2-buckets.js` | 2 |
| 신규 | `tests/rv2-buckets.test.mjs` | 2 |
| 신규 | `rv2-quote-rank.html`, `js/rv2-ui.js` | 3 |
| 수정 | `js/nav.js` | 3 — **NAV_ITEMS에 1줄 추가. 이것이 유일한 기존 코드 파일 변경** |
| 수정 | `.gitignore` | 0 — 원문 샘플 보관 경로 제외 |

---

## 5. 샘플 라인 분류표 (§5-5)

**작성 대기 중** — 마스킹된 샘플 확보 후 이 절에 삽입한다.

마스킹 규약 (승인됨):
- 발화자 실명 → 익명 치환 (`트레이더01` 형태, 결정론적·안정 매핑)
- 전화번호 → 더미 (`000-0001` 형태, 원본별 안정 매핑)
- 브로커 **회사·데스크명은 보존** — 딜러태그 파싱 검증에 필요하고 개인정보가 아님
- 원문은 `tests/fixtures/raw-kbond/` (gitignore)에 보관, **마스킹 결과물만 커밋**
- 매핑표는 원문과 같은 gitignore 경로에 출력, 커밋 금지

---

## 6. 확정된 결정 항목

| # | 항목 | 확정값 | 비고 |
|---|---|---|---|
| 1 | 표본 가드 n | **8** (상수화) | 리프 버킷(섹터×등급×RWA)은 일상적으로 n<8이 되어 **롤업이 예외가 아닌 기본**이 될 소지가 있다. **샘플 실측 후 재조정 여지** |
| 2 | MAD 계수 k | **2.5** (상수화) | 소표본 강건성. 평균±표준편차 금지 |
| 3 | 페이지 배치 | **신규 `rv2-quote-rank.html`** | §3 |
| 4 | "수금채" 귀속 | **수협은행** | 이식된 `rv-abbrev.js`가 `"수금": "수협은행"`, `"수금(중앙회)": "수협중앙회"`로 확정하고 `"수출입": "한국수출입은행"`은 별도 항목. `rv2-buckets` 상수에 **수협은행의 섹터 귀속을 명시**한다 |
| 5 | 교체 호가 | **추가 작업 없음** | `parseSide`가 이미 교체→`offer`, `parseTags`가 `'replace'` 태그. 명령서 기본안과 일치 |
| 6 | 사자 만기 격자 | **연 단위 6버킷**: `~1y / 1–2 / 2–3 / 3–5 / 5–10 / 10y+` | 채팅 원문이 "1.5년", "2~3년"처럼 연 단위로 말한다. Z/S/C/L 매핑은 bpbybp 범위 아님(Fenrir 소관) |

### 6.1 명령서 §1.4 규칙 1의 부호 예시 불일치 — 정정 기록

명령서 §1.4 규칙 1은 공식과 예시가 서로 어긋난다.

- 공식: `offset_bp = (호가수익률 − 민평수익률) × 100`
- 예시: `"+0.5원 3.608 팔자 (민 3.610)" → +0.2bp`
- 실제: `(3.608 − 3.610) × 100 = −0.2bp`

**공식이 옳다.** `+0.5원`은 가격이 높다 = 수익률이 낮다 = **비싸게 내놓은 오퍼**이므로, §1.4가 굵게
명시한 부호 규약("+오프셋 = 민평 대비 높은 수익률 = 싸게 나온 오퍼")과 §3.2의 랭킹 의미론
(offset_bp 내림차순 = 싸게 나온 순), 그리고 규칙 2(언더N = −N)와 모두 **음수여야 일관된다**.

→ 구현은 **공식을 따르고**, 예시의 부호는 오기로 간주한다. 코드 주석·테스트·UI 범례에 규약을 명시.

---

## 7. 백로그 (이번 범위 제외 — 별건 과제)

| # | 항목 | 근거 |
|---|---|---|
| B-1 | **RV-1 `parseSpread` 언더N 미구현** | `rv-parser.js:148-161`이 `오버/오바`만 처리. `"언더4 팔자"`는 마지막 폴백에 걸려 **`flat 0`으로 오인**된다(민평 대비 −4bp를 0bp로 읽음). RV-1 출력이 바뀌므로 분리. 선행 조건: `rv-parser.js` 테스트 신설 |
| B-2 | **미추적 잔여물 5건 정리** | `_backup_untracked/`, `t`, `e -Force _backup_untracked...`(잘못된 PowerShell 명령이 파일명이 된 것), `taylor-module-handoff.md`, `update-curve-rv.bat` |
| B-3 | **테스트 러너 탐색 범위** | `node --test`가 `_backup_untracked/`·`tools/test-phase3.js`를 주워 실패 3건 생성. B-2 해결 시 2건 자동 소멸, `tools/test-phase3.js`는 개명 또는 `tests/`로 이전 필요 |
| B-4 | **`rv-parser.js` 멀티라인 병합의 시스템메시지 오염** | §2.2-B. RV-2는 프리패스로 우회하지만 RV-1은 여전히 노출. B-1과 함께 처리 |
