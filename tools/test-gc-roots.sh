#!/usr/bin/env bash
# Runs with the pinned Emscripten SDK and the native GC post-link tool.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/third_party/emsdk/emsdk_env.sh" >/dev/null 2>&1
OPT="$ROOT/build/binaryen-gc/bin/wasm-opt"
RESULT="$ROOT/build/gc-roots-acceptance"
mkdir -p "$RESULT"
for mode in main pthread; do
  baseline="$RESULT/$mode/baseline"
  fixed="$RESULT/$mode/fixed"
  mkdir -p "$baseline" "$fixed"
  extra=()
  if [ "$mode" = pthread ]; then
    extra=(-pthread -sPROXY_TO_PTHREAD -sPTHREAD_POOL_SIZE=1)
  fi
  emcc -O3 -msimd128 --profiling-funcs "$ROOT/tools/gc-root-probe.c" \
    -sENVIRONMENT=node -sEXIT_RUNTIME=1 \
    -sEXPORTED_FUNCTIONS=_main,_emscripten_stack_get_current,_emscripten_stack_get_base \
    "${extra[@]}" -o "$baseline/probe.cjs"
  cp "$baseline/probe.cjs" "$fixed/probe.cjs"
  "$OPT" "$baseline/probe.wasm" --spill-jsc-roots -g --all-features -o "$fixed/probe.wasm"
  for kind in 0 1 2 3; do
    status=0
    node "$baseline/probe.cjs" "$kind" > "$RESULT/$mode/baseline-$kind.log" 2>&1 || status=$?
    [ "$status" = 1 ] || { echo "Expected a missing root in uninstrumented $mode/$kind baseline; got $status" >&2; exit 1; }
    node "$fixed/probe.cjs" "$kind" > "$RESULT/$mode/fixed-$kind.log" 2>&1
    rg -q "root_kind=$kind visible=1" "$RESULT/$mode/fixed-$kind.log"
    echo "PASS $mode/$kind: live root visible after post-link instrumentation"
  done
done

# Values held only between sibling/nested calls also need roots.
"$OPT" "$ROOT/tools/gc-operand-probe.wat" -g --all-features -o "$RESULT/operand-baseline.wasm"
"$OPT" "$ROOT/tools/gc-operand-probe.wat" --spill-jsc-roots -g --all-features -o "$RESULT/operand-fixed.wasm"
node "$ROOT/tools/gc-operand-probe.mjs" "$RESULT/operand-baseline.wasm" invisible
node "$ROOT/tools/gc-operand-probe.mjs" "$RESULT/operand-fixed.wasm" visible
echo 'PASS operand stack: nested-call result visible after preparation and spills'
