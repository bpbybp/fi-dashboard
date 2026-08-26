# fi-dashboard

무빌드 정적 데이터 대시보드 (GitHub Pages). 채권·금리·물가 측정 모듈 모음.
설계 원칙: **측정/해석 분리**(도구는 계산, 판단은 사람) · 무빌드(Plotly vendor + 바닐라 ES module) ·
Actions 주간 fetch → JSON 커밋 → 클라이언트 렌더 · 다크 테마.
화면 공용 규칙은 [`DESIGN.md`](DESIGN.md), 모듈 목록은 [`js/nav.js`](js/nav.js) 단일 근원.

데이터 파이프라인 공통: Node 내장 fetch만(무의존), `meta.updated` = **최신 관측일(vintage, wall-clock 아님)**
→ 데이터 불변 시 파일 byte-불변 → 워크플로 diff-skip 정확. 로컬 테스트 `node --test`(인자 없이 자동탐색).

## 모듈 (발췌)

| 모듈 | 화면 | 소스 |
|---|---|---|
| 물가전망 / US 물가전망 / 물가확산 | inflation-*.html | FRED·BLS·BEA·ECOS |
| Taylor 압력 | taylor.html | ECOS |
| 국민소득 갭 (GG-1) | gg1-income-gap.html | ECOS |
| 연간 GDP 환산기 (GA-1) | gdp-annual.html | (입력형·순수 산술) |
| Curve Phase (CP) | curve-phase.html | ECOS + FRED |
| **Global Curve Compare (GC)** | curve-phase.html 内 섹션 | FRED + MOF + ECOS |
| 커브 구간 RV (CRV-1) | crv1.html | 시가평가 3사평균 국고채권 (`data/ktb-curve.js`) |
| Curve RV / US Credit Spread / RV 스크리너 / On·Off / 캐리 / 레짐 | 각 *.html | FRED·ECOS·클라이언트 |

---

## Global Curve Compare (GC)

KR 커브 움직임이 **글로벌 텀프리미엄 동조**인지, **국내 고유 수급 요인**인지 분리 관찰.
KR·US·JP의 **3/10·10/30 스프레드**를 나란히 비교한다. bpbybp = 측정 — 판단 문구·시그널 엔진 없음, 레벨·z·변화폭만.

### 데이터 소스 (원금리 3Y/10Y/30Y, 국가별 파일 분리 `data/gc/{us,jp,kr}.json`)

| 국가 | 소스 | 시리즈 | 인증 | 파서 특이사항 |
|---|---|---|---|---|
| US | FRED | DGS3 / DGS10 / DGS30 | `FRED_API_KEY` | 결측일 `.` 스킵 |
| JP | 재무성(MOF) `jgbcm_all.csv`+`jgbcm.csv` | 3年/10年/30年 | 불필요(공개) | **Shift-JIS 디코딩** + **연호 파싱**(S=1925+N·H=1988+N·R=2018+N) |
| KR | ECOS 817Y002 | 3Y `010200000` / 10Y `010210000` / 30Y `010230000` | `ECOS_API_KEY` | — |

- **파이프라인**: `scripts/gc/fetch-{us,jp,kr}.mjs` (+ `gc-config.mjs`·`gc-io.mjs`·`gc-jp.mjs`).
  워크플로 `.github/workflows/gc-fetch.yml` — 주 1회(수 22:20 UTC), 소스별 스텝 `continue-on-error`로 **실패 격리**(일부 실패해도 나머지 커밋).
- **계산 레이어**(클라이언트): `js/gc/gc-calc.js` (순수 함수). **UI**: `js/gc/gc-ui.js` — curve-phase 페이지 내 섹션, cp-ui 무영향.
- **스프레드**: `s310=(y10−y3)×100`, `s1030=(y30−y10)×100` (bp, 소수 1자리).
- **z250**: 각 스프레드·각국 독립, 트레일링 250 표본, 모집단 표준편차(÷n, `us-credit-spread` 규약 일치), 소수 2자리.
- **Δ1w/Δ1m**: 5/21 **영업일**(자국 행 인덱스) 전 대비, bp.

### 방법론 결정사항 (변경 시 명령서 개정 필요)

- **z250 윈도우 = 250 영업일 고정, 각국 자체 시리즈 기준.** 근거: JP YCC 해제 전후 레짐 구간 혼입 왜곡 방지 —
  장기(전이력) 윈도우 사용 금지. **표본 < 250이면 z=null**(부분 윈도우 금지), 표준편차 0이면 null.
  차트 z250 모드에서 미산출 구간은 **공백**(0·보간으로 그리지 않음).
- **vintage 방식.** `meta.updated` = 최신 관측일(wall-clock 아님). 데이터 불변 시 파일 불변 → Actions diff-skip 정확.
  (명령서 §4 예시의 fetch-일자 표기는 이 vintage 방식으로 개정된 것으로 간주 — 결정 승인 완료.)
- **불변(immutable) append.** 기존 마지막 날짜 **이후** 행만 추가, 중복일 skip, **소스가 과거치를 사후 정정해도 덮어쓰지 않음**
  (first-print 고정). 최초 backfill 5년, 이후 증분. 국가별 파일 분리로 한 소스 장애가 전체를 막지 않음.
- **국가 간 날짜 미정렬 원칙.** 정렬·병합하지 않고 시리즈별 독립 plot. 결측일 **line skip**(보간 금지 — 과거 AU 보간 이슈 재발 방지).
  국가별 최신일이 다를 수 있음(예: KR/JP 수요일, US 화요일 — FRED 일별 CMT ~1일 지연). cron `20 22 * * 3`에서 KR 수·US 화 vintage 포착 확인(2026-07-23 CI 실측).
- **30Y null 게이트 정정 이력.** 원 게이트 문구 "30Y는 2012-09-11(발행개시) 이전 null 정상"은 **전이력 모듈(CP, `KR_START=2004`)에만 해당**.
  GC는 5년 backfill이라 창 전체가 2012-09 이후 → **KR 30Y null 0%**가 올바른 기대치(2026-07-23 CI 실측: 1226행 중 30Y null 0%). GC 게이트는 "30Y null 0% 확인"으로 정정 적용.
