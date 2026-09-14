#!/usr/bin/env bash
# diffusion-step.sh — inflation-diffusion 워크플로 국가 스텝 래퍼.
#   fetch 스크립트를 실행하고 결과를 step output(result)으로 기록한다.
#     new        : 스크립트 성공 + 데이터 파일 변경(신규 포함)
#     unchanged  : 스크립트 성공 + 변경 없음
#     failed:사유 : 스크립트 실패 (스텝도 실패로 남김 → continue-on-error로 다음 스텝 계속)
#   skipped(시크릿 부재)는 워크플로 yml에서 직접 기록.
#
# usage: bash scripts/ci/diffusion-step.sh <data-file> <node-script>
set -uo pipefail

data_file="$1"
script="$2"
out="${GITHUB_OUTPUT:-/dev/null}"
log="$(mktemp)"

node "$script" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}

if [ "$code" -ne 0 ]; then
  # fetcher main()의 "[tag] 실패: 메시지" 첫 줄을 사유로. 없으면 마지막 비어있지 않은 줄.
  reason="$(grep -F '실패:' "$log" | tail -n 1 | sed 's/^.*실패: *//')"
  [ -z "$reason" ] && reason="$(grep -v '^[[:space:]]*$' "$log" | tail -n 1)"
  [ -z "$reason" ] && reason="exit ${code}"
  reason="$(printf '%s' "$reason" | tr -d '\r\n')"
  echo "result=failed:${reason}" >> "$out"
  echo "::error title=${data_file}::$(printf '%s' "$reason" | sed 's/%/%25/g')"
  exit "$code"
fi

if [ -n "$(git status --porcelain -- "$data_file")" ]; then
  echo "result=new" >> "$out"
else
  echo "result=unchanged" >> "$out"
fi
