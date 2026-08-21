@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  fi-dashboard 데이터 갱신 원클릭 (크레딧 스프레드 + on/off 세대/종목 통합) v2.1
REM  사용법: 만기확장/on-off xlsx를 레포 루트에 배치 후 더블클릭
REM  위치:  레포 루트에 두고 실행
REM
REM  v2 변경점:
REM   - 변경 감지를 git add 후 staged diff 로 판정
REM     (CRLF 줄바꿈 차이만 있는 유령 변경을 정규화 후 걸러냄)
REM   - 모듈별 경로 지정 커밋 (한 모듈 변경 없어도 다른 모듈 진행)
REM   - 데이터 갱신분이 없어도 미푸시 로컬 커밋이 있으면 푸시 수행
REM
REM  v2.1 변경점:
REM   - 메뉴 4 = on/off 커브 단면(onoff-bonds) 추가.
REM     세대 스키마(2, onoff-ktb3y)와 종목 스키마(4, onoff-bonds)는 병행 갱신한다.
REM   - 메뉴 3 이 '둘 다' -> '전체(1+2+4)' 로 확대. 1/2 의 동작은 그대로.
REM ============================================================

cd /d "%~dp0"

echo ============================================================
echo  fi-dashboard 데이터 갱신 원클릭
echo ============================================================
echo.
echo   1 = 크레딧 스프레드     (커브 RV + CS-1)
echo   2 = on/off 스프레드     (onoff-ktb3y)
echo   3 = 전체                (1 + 2 + 4 + 5)
echo   4 = on/off 커브 단면    (onoff-bonds)
echo   5 = KTB 커브 (국고 민평 커브)
echo.
set "MODE="
set /p MODE=선택 (1/2/3/4/5, 엔터=3): 
if "%MODE%"=="" set "MODE=3"
if "%MODE%"=="1" goto mode_ok
if "%MODE%"=="2" goto mode_ok
if "%MODE%"=="3" goto mode_ok
if "%MODE%"=="4" goto mode_ok
if "%MODE%"=="5" goto mode_ok
echo.
echo [실패] 잘못된 입력입니다. 1, 2, 3, 4, 5 중 하나를 입력하세요.
goto end_err

:mode_ok
set "DO_CURVE=0"
set "DO_ONOFF=0"
set "DO_BONDS=0"
set "DO_KTBC=0"
if "%MODE%"=="1" set "DO_CURVE=1"
if "%MODE%"=="2" set "DO_ONOFF=1"
if "%MODE%"=="4" set "DO_BONDS=1"
if "%MODE%"=="5" set "DO_KTBC=1"
if "%MODE%"=="3" set "DO_CURVE=1"
if "%MODE%"=="3" set "DO_ONOFF=1"
if "%MODE%"=="3" set "DO_BONDS=1"
if "%MODE%"=="3" set "DO_KTBC=1"

REM ---- [사전] .gitattributes 부트스트랩 (없을 때 1회만) ----
if exist ".gitattributes" goto attr_done
echo.
echo [사전] .gitattributes 없음 - 줄바꿈 규칙 생성 (CRLF rebase 오류 근본 방지)
(
echo * text=auto
echo *.js text eol=lf
echo *.mjs text eol=lf
echo *.json text eol=lf
echo *.html text eol=lf
echo *.css text eol=lf
echo *.md text eol=lf
echo *.yml text eol=lf
echo *.bat text eol=crlf
) > .gitattributes
git add .gitattributes
if errorlevel 1 goto git_fail
git commit -m "chore: .gitattributes 줄바꿈 규칙 추가 (CRLF rebase 오류 방지)"
if errorlevel 1 goto git_fail
:attr_done

REM ---- [1/6] 원격 동기화 ----
echo.
echo [1/6] 원격 동기화 (fetch + pull --rebase --autostash) ...
git fetch origin
if errorlevel 1 goto sync_fail
git pull --rebase --autostash origin main
if errorlevel 1 goto sync_fail

REM ---- [2/6] 데이터 변환 ----
echo.
echo [2/6] 데이터 변환 ...
if "%DO_CURVE%"=="0" goto conv_onoff
echo   - 커브 RV: convert + backtest
call node tools\update-curve-data.mjs
if errorlevel 1 goto curve_conv_fail
echo   - CS-1 크레딧 섹터 스프레드: yield 시트 변환
node tools\build-cs1.mjs
if errorlevel 1 goto cs1_conv_fail
:conv_onoff
if "%DO_ONOFF%"=="0" goto conv_bonds
echo   - on/off 스프레드(세대): xlsx 변환 + 구조 검증
node tools\convert-onoff.mjs
if errorlevel 1 goto onoff_conv_fail

:conv_bonds
if "%DO_BONDS%"=="0" goto detect
echo   - on/off 커브 단면(종목): xlsx 변환 + 구조 검증
node tools\convert-onoff-bonds.mjs
if errorlevel 1 goto bonds_conv_fail

if "%DO_KTBC%"=="0" goto conv_ktbc_done
if not exist "_local\curve-data.xlsx" (
    echo   KTB 커브: _local\curve-data.xlsx 없음 - 건너뜀
    set "DO_KTBC=0"
    goto conv_ktbc_done
)
echo   - KTB 커브(국고 민평): xlsx 변환
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\convert-curve.ps1"
if errorlevel 1 goto ktbc_conv_fail
:conv_ktbc_done

REM ---- [3/6] 변경 감지 (add 후 staged diff 판정 = 줄바꿈 정규화 반영) ----
:detect
echo.
echo [3/6] 변경 감지 + 기준일 추출 ...
set "CURVE_CHANGED=0"
set "ONOFF_CHANGED=0"
set "BONDS_CHANGED=0"
set "CURVE_DATE="
set "ONOFF_DATE="
set "BONDS_DATE="
set "KTBC_CHANGED=0"
set "KTBC_DATE="

if "%DO_CURVE%"=="0" goto detect_onoff
git add data/credit-spread.js data/curve-rv-backtest.js data/cs1/spreads.json 2>nul
git diff --cached --quiet -- data/credit-spread.js data/curve-rv-backtest.js data/cs1/spreads.json
if not errorlevel 1 (
    echo   크레딧 스프레드: 변경 없음 - 이미 최신 또는 줄바꿈 차이만 존재
    goto detect_onoff
)
set "CURVE_CHANGED=1"
git --no-pager diff --cached --stat -- data/credit-spread.js data/curve-rv-backtest.js data/cs1/spreads.json
node -e "const m=require('fs').readFileSync('data/credit-spread.js','utf8').match(/last_updated[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2})/);process.stdout.write(m?m[1]:'')" > "%TEMP%\curve_rv_date.txt"
set /p CURVE_DATE=<"%TEMP%\curve_rv_date.txt"
if "%CURVE_DATE%"=="" goto curve_date_fail
echo   크레딧 스프레드: %CURVE_DATE% 갱신분 감지

:detect_onoff
if "%DO_ONOFF%"=="0" goto detect_bonds
git add data/onoff-ktb3y.js 2>nul
git diff --cached --quiet -- data/onoff-ktb3y.js
if not errorlevel 1 (
    echo   on/off 스프레드: 변경 없음 - 이미 최신 또는 줄바꿈 차이만 존재
    goto detect_bonds
)
set "ONOFF_CHANGED=1"
for /f "usebackq delims=" %%D in (`node -e "global.window={};const fs=require('fs');eval(fs.readFileSync('data/onoff-ktb3y.js','utf8'));process.stdout.write(window.ONOFF_KTB3Y.updated)"`) do set "ONOFF_DATE=%%D"
if not defined ONOFF_DATE goto onoff_date_fail
echo   on/off 스프레드: !ONOFF_DATE! 갱신분 감지

:detect_bonds
if "%DO_BONDS%"=="0" goto detect_ktbc
git add data/onoff-bonds.js 2>nul
git diff --cached --quiet -- data/onoff-bonds.js
if not errorlevel 1 (
    echo   on/off 커브 단면: 변경 없음 - 이미 최신 또는 줄바꿈 차이만 존재
    goto detect_ktbc
)
set "BONDS_CHANGED=1"
for /f "usebackq delims=" %%D in (`node -e "global.window={};const fs=require('fs');eval(fs.readFileSync('data/onoff-bonds.js','utf8'));process.stdout.write(window.ONOFF_BONDS.updated)"`) do set "BONDS_DATE=%%D"
if not defined BONDS_DATE goto bonds_date_fail
echo   on/off 커브 단면: !BONDS_DATE! 갱신분 감지

:detect_ktbc
if "%DO_KTBC%"=="0" goto confirm
git add data/ktb-curve.js 2>nul
git diff --cached --quiet -- data/ktb-curve.js
if not errorlevel 1 (
    echo   KTB 커브: 변경 없음 - 이미 최신 또는 줄바꿈 차이만 존재
    goto confirm
)
set "KTBC_CHANGED=1"
for /f "usebackq delims=" %%D in (`node -e "global.window={};const fs=require('fs');eval(fs.readFileSync('data/ktb-curve.js','utf8'));const r=window.KTB_CURVE.rows;process.stdout.write(r[r.length-1][0])"`) do set "KTBC_DATE=%%D"
if not defined KTBC_DATE goto ktbc_date_fail
echo   KTB 커브: !KTBC_DATE! 갱신분 감지

REM ---- [4/6] 커밋 확인 ----
:confirm
if "%CURVE_CHANGED%"=="1" goto confirm_show
if "%ONOFF_CHANGED%"=="1" goto confirm_show
if "%BONDS_CHANGED%"=="1" goto confirm_show
if "%KTBC_CHANGED%"=="1" goto confirm_show
goto no_data_change

:confirm_show
echo.
echo [4/6] 커밋 예정:
if "%CURVE_CHANGED%"=="1" echo   - data: 크레딧 스프레드 데이터 !CURVE_DATE! 갱신
if "%ONOFF_CHANGED%"=="1" echo   - data: on/off 스프레드 !ONOFF_DATE! 갱신
if "%BONDS_CHANGED%"=="1" echo   - data: on/off 커브 단면 !BONDS_DATE! 갱신
if "%KTBC_CHANGED%"=="1" echo   - data: 국고 민평 커브 !KTBC_DATE! 갱신
set "CONFIRM="
set /p CONFIRM=커밋 + 푸시 진행? (Y/N): 
if /i "!CONFIRM!"=="Y" goto do_commit
git reset -q -- data/credit-spread.js data/curve-rv-backtest.js data/cs1/spreads.json data/onoff-ktb3y.js data/onoff-bonds.js data/ktb-curve.js
echo 중단 - 커밋하지 않았습니다. 스테이징 해제, 변경은 워킹트리에 남아있습니다.
goto end_ok

REM ---- [5/6] 커밋 (경로 지정으로 모듈별 분리) ----
:do_commit
echo.
echo [5/6] 커밋 ...
if "%CURVE_CHANGED%"=="0" goto commit_onoff
git commit -m "data: 크레딧 스프레드 데이터 !CURVE_DATE! 갱신" -- data/credit-spread.js data/curve-rv-backtest.js data/cs1/spreads.json
if errorlevel 1 goto git_fail
:commit_onoff
if "%ONOFF_CHANGED%"=="0" goto commit_bonds
git commit -m "data: on/off 스프레드 !ONOFF_DATE! 갱신" -- data/onoff-ktb3y.js
if errorlevel 1 goto git_fail
:commit_bonds
if "%BONDS_CHANGED%"=="0" goto commit_ktbc
git commit -m "data: on/off 커브 단면 !BONDS_DATE! 갱신" -- data/onoff-bonds.js
if errorlevel 1 goto git_fail
:commit_ktbc
if "%KTBC_CHANGED%"=="0" goto push_step
git commit -m "data: 국고 민평 커브 !KTBC_DATE! 갱신" -- data/ktb-curve.js
if errorlevel 1 goto git_fail
goto push_step

REM ---- 데이터 갱신분 없음: 미푸시 커밋만 확인 ----
:no_data_change
echo.
echo 데이터 갱신분 없음 - 새로 커밋할 내용이 없습니다.
goto push_step

REM ---- [6/6] 동기화 + 푸시 (미푸시 로컬 커밋 있으면 무조건 수행) ----
:push_step
set "AHEAD=0"
for /f "usebackq delims=" %%A in (`git rev-list --count origin/main..HEAD`) do set "AHEAD=%%A"
if not "%AHEAD%"=="0" goto do_push
echo.
echo [6/6] 푸시할 커밋 없음 - 로컬과 원격이 일치합니다. 종료.
goto end_ok

:do_push
echo.
echo [6/6] 원격 동기화 + 푸시 (미푸시 커밋 %AHEAD%건) ...
git pull --rebase --autostash origin main
if errorlevel 1 goto rebase_fail
git push origin main
if errorlevel 1 goto push_fail

echo.
echo ============================================================
if "%CURVE_CHANGED%"=="1" echo  [완료] 크레딧 스프레드 !CURVE_DATE! 배포됨
if "%ONOFF_CHANGED%"=="1" echo  [완료] on/off 스프레드 !ONOFF_DATE! 배포됨
if "%BONDS_CHANGED%"=="1" echo  [완료] on/off 커브 단면 !BONDS_DATE! 배포됨
if "%KTBC_CHANGED%"=="1" echo  [완료] 국고 민평 커브 !KTBC_DATE! 배포됨
if "%CURVE_CHANGED%"=="0" if "%ONOFF_CHANGED%"=="0" if "%BONDS_CHANGED%"=="0" if "%KTBC_CHANGED%"=="0" echo  [완료] 기존 미푸시 커밋 %AHEAD%건 배포됨
echo  브라우저에서 해당 페이지 확인 권장.
echo ============================================================

git status --porcelain | findstr . >nul
if not errorlevel 1 (
    echo.
    echo   ^(참고^) 워킹트리에 잔여 변경 표시가 있습니다.
    echo   대부분 줄바꿈 잔상이지만, 다른 모듈의 실제 변경일 수도 있으니 git status 확인.
)
goto end_ok

REM ---- 실패 처리 ----
:sync_fail
echo.
echo [실패] 원격 동기화 실패 - 네트워크 또는 충돌 확인.
echo         git status 로 상태 확인 후 재시도하세요.
goto end_err

:curve_conv_fail
echo.
echo [실패] update-curve-data.mjs 비정상 종료 - 위 오류 확인. 커밋하지 않았습니다.
goto end_err

:cs1_conv_fail
echo.
echo [실패] build-cs1.mjs 비정상 종료 - 위 오류 확인. 커밋하지 않았습니다.
echo        data/cs1/spreads.json 은 갱신되지 않았습니다.
goto end_err

:onoff_conv_fail
echo.
echo [실패] convert-onoff.mjs 변환/구조 검증 실패 - 위 오류 확인. 커밋하지 않았습니다.
goto end_err

:curve_date_fail
echo.
echo [실패] credit-spread.js 에서 last_updated 추출 불가 - 파일 형식 확인 필요.
goto end_err

:onoff_date_fail
echo.
echo [실패] onoff-ktb3y.js 에서 updated 날짜 추출 불가 - 파일 형식 확인 필요.
goto end_err

:bonds_conv_fail
echo.
echo [실패] convert-onoff-bonds.mjs 변환/구조 검증 실패 - 위 오류 확인. 커밋하지 않았습니다.
echo         (축소 감지 가드에 걸린 경우 종목 수/최고 일자 메시지 확인)
goto end_err

:ktbc_conv_fail
echo.
echo [실패] convert-curve.ps1 변환 실패 - 위 오류 확인. 커밋하지 않았습니다.
echo         (컬럼 불일치/데이터 0건이면 _local\curve-data.xlsx 시트 구조 확인)
goto end_err

:bonds_date_fail
echo.
echo [실패] onoff-bonds.js 에서 updated 날짜 추출 불가 - 파일 형식 확인 필요.
goto end_err

:ktbc_date_fail
echo.
echo [실패] ktb-curve.js 에서 마지막 행 날짜 추출 불가 - 파일 형식 확인 필요.
goto end_err

:git_fail
echo.
echo [실패] git add/commit 실패 - 위 메시지 확인.
goto end_err

:rebase_fail
echo.
echo [실패] rebase 실패 - 수동 해결 필요. 커밋은 로컬에 있음.
echo         해결 후: git push origin main
goto end_err

:push_fail
echo.
echo [실패] 푸시 실패 - 네트워크/인증 확인. 커밋은 로컬에 있음.
echo         재시도: git push origin main
goto end_err

:end_ok
echo.
pause
exit /b 0

:end_err
echo.
pause
exit /b 1
