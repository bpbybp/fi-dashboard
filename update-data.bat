@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  fi-dashboard 데이터 갱신 원클릭 (커브 RV + on/off 통합)
REM  사용법: 만기확장/on-off xlsx를 레포 루트에 배치 후 더블클릭
REM  위치:  레포 루트에 두고 실행
REM
REM  기존 update-curve-rv.bat / update-onoff.bat 대체.
REM  개선점:
REM   - 작업 전 원격 동기화 (pull --rebase --autostash)
REM   - 커밋 후 푸시 직전에도 --autostash 로 CRLF 유령 변경에 견고
REM   - .gitattributes 없으면 1회 자동 생성 (줄바꿈 LF 고정 = 근본 해결)
REM ============================================================

cd /d "%~dp0"

echo ============================================================
echo  fi-dashboard 데이터 갱신 원클릭
echo ============================================================
echo.
echo   1 = 커브 RV          (credit-spread + curve-rv-backtest)
echo   2 = on/off 스프레드  (onoff-ktb3y)
echo   3 = 둘 다
echo.
set "MODE="
set /p MODE=선택 (1/2/3, 엔터=3): 
if "%MODE%"=="" set "MODE=3"
if "%MODE%"=="1" goto mode_ok
if "%MODE%"=="2" goto mode_ok
if "%MODE%"=="3" goto mode_ok
echo.
echo [실패] 잘못된 입력입니다. 1, 2, 3 중 하나를 입력하세요.
goto end_err

:mode_ok
set "DO_CURVE=0"
set "DO_ONOFF=0"
if "%MODE%"=="1" set "DO_CURVE=1"
if "%MODE%"=="2" set "DO_ONOFF=1"
if "%MODE%"=="3" set "DO_CURVE=1"
if "%MODE%"=="3" set "DO_ONOFF=1"

REM ---- [사전] .gitattributes 부트스트랩 (없을 때 1회만) ----
set "ATTR_NEW=0"
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
set "ATTR_NEW=1"
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
:conv_onoff
if "%DO_ONOFF%"=="0" goto detect
echo   - on/off: xlsx 변환 + 구조 검증
node tools\convert-onoff.mjs
if errorlevel 1 goto onoff_conv_fail

REM ---- [3/6] 변경 감지 + 기준일 추출 ----
:detect
echo.
echo [3/6] 변경 감지 + 기준일 추출 ...
set "CURVE_CHANGED=0"
set "ONOFF_CHANGED=0"
set "CURVE_DATE="
set "ONOFF_DATE="

if "%DO_CURVE%"=="0" goto detect_onoff
git status --porcelain data/credit-spread.js data/curve-rv-backtest.js | findstr . >nul
if errorlevel 1 (
    echo   커브 RV: 변경 없음 - 이미 최신
    goto detect_onoff
)
set "CURVE_CHANGED=1"
git --no-pager diff --stat data/credit-spread.js data/curve-rv-backtest.js
node -e "const m=require('fs').readFileSync('data/credit-spread.js','utf8').match(/last_updated[^0-9]*([0-9]{4}-[0-9]{2}-[0-9]{2})/);process.stdout.write(m?m[1]:'')" > "%TEMP%\curve_rv_date.txt"
set /p CURVE_DATE=<"%TEMP%\curve_rv_date.txt"
if "%CURVE_DATE%"=="" goto curve_date_fail
echo   커브 RV: %CURVE_DATE% 갱신분 감지

:detect_onoff
if "%DO_ONOFF%"=="0" goto confirm
git status --porcelain data/onoff-ktb3y.js | findstr . >nul
if errorlevel 1 (
    echo   on/off: 변경 없음 - 이미 최신
    goto confirm
)
set "ONOFF_CHANGED=1"
for /f "usebackq delims=" %%D in (`node -e "global.window={};const fs=require('fs');eval(fs.readFileSync('data/onoff-ktb3y.js','utf8'));process.stdout.write(window.ONOFF_KTB3Y.updated)"`) do set "ONOFF_DATE=%%D"
if not defined ONOFF_DATE goto onoff_date_fail
echo   on/off: !ONOFF_DATE! 갱신분 감지

REM ---- [4/6] 커밋 확인 ----
:confirm
if "%CURVE_CHANGED%"=="1" goto confirm_show
if "%ONOFF_CHANGED%"=="1" goto confirm_show
goto nothing

:confirm_show
echo.
echo [4/6] 커밋 예정:
if "%CURVE_CHANGED%"=="1" echo   - data: 커브 RV 데이터 !CURVE_DATE! 갱신
if "%ONOFF_CHANGED%"=="1" echo   - data: on/off 스프레드 !ONOFF_DATE! 갱신
set "CONFIRM="
set /p CONFIRM=커밋 + 푸시 진행? (Y/N): 
if /i "!CONFIRM!"=="Y" goto do_commit
echo 중단 - 커밋하지 않았습니다. 변경은 워킹트리에 남아있습니다.
if "%ATTR_NEW%"=="1" echo   ^(참고^) .gitattributes 커밋은 로컬에 있음 - 다음 푸시 때 함께 반영됩니다.
goto end_ok

REM ---- [5/6] 커밋 (모듈별 개별 커밋) ----
:do_commit
echo.
echo [5/6] 커밋 ...
if "%CURVE_CHANGED%"=="0" goto commit_onoff
git add data/credit-spread.js data/curve-rv-backtest.js
if errorlevel 1 goto git_fail
git commit -m "data: 커브 RV 데이터 !CURVE_DATE! 갱신"
if errorlevel 1 goto git_fail
:commit_onoff
if "%ONOFF_CHANGED%"=="0" goto push_step
git add data/onoff-ktb3y.js
if errorlevel 1 goto git_fail
git commit -m "data: on/off 스프레드 !ONOFF_DATE! 갱신"
if errorlevel 1 goto git_fail

REM ---- [6/6] 동기화 + 푸시 ----
:push_step
echo.
echo [6/6] 원격 동기화 + 푸시 ...
git pull --rebase --autostash origin main
if errorlevel 1 goto rebase_fail
git push origin main
if errorlevel 1 goto push_fail

echo.
echo ============================================================
if "%CURVE_CHANGED%"=="1" echo  [완료] 커브 RV !CURVE_DATE! 배포됨
if "%ONOFF_CHANGED%"=="1" echo  [완료] on/off !ONOFF_DATE! 배포됨
echo  브라우저에서 해당 페이지 확인 권장.
echo ============================================================

REM 줄바꿈 변환 잔상 안내 (내용 diff가 아닌 경우가 대부분)
git status --porcelain | findstr . >nul
if not errorlevel 1 (
    echo.
    echo   ^(참고^) 워킹트리에 잔여 변경 표시가 있습니다.
    echo   줄바꿈 변환 잔상일 가능성이 높습니다. 필요 시 git status로 확인하세요.
)
goto end_ok

REM ---- 변경 없음 ----
:nothing
echo.
echo 갱신분 없음 - 데이터가 이미 최신입니다. 커밋하지 않고 종료합니다.
if "%ATTR_NEW%"=="0" goto end_ok
echo .gitattributes 커밋만 푸시합니다 ...
git pull --rebase --autostash origin main
if errorlevel 1 goto rebase_fail
git push origin main
if errorlevel 1 goto push_fail
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
