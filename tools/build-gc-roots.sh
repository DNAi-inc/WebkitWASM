#!/usr/bin/env bash
# Build the pinned native post-link tool. This is not an Asyncify/JIT change.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/third_party/binaryen-gc"
BUILD="$ROOT/build/binaryen-gc"
PIN=b9c72894fba2ee5bef8e4002fb176c1917a556ad
PATCH="$ROOT/src/patches/binaryen-gc-roots.patch"
mkdir -p "$SOURCE" "$ROOT/build"
if [ ! -d "$SOURCE/.git" ]; then
  git -C "$SOURCE" init -q
  git -C "$SOURCE" remote add origin https://github.com/WebAssembly/binaryen.git
fi
if ! git -C "$SOURCE" cat-file -e "${PIN}^{commit}" 2>/dev/null; then
  git -C "$SOURCE" fetch --depth 1 origin "$PIN"
fi
if ! git -C "$SOURCE" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$SOURCE" checkout -q --detach "$PIN"
fi
[ "$(git -C "$SOURCE" rev-parse HEAD)" = "$PIN" ] || {
  echo 'GC tool checkout has a different revision; preserve it and resolve explicitly.' >&2; exit 1;
}
if git -C "$SOURCE" apply --check "$PATCH" >/dev/null 2>&1; then
  git -C "$SOURCE" apply "$PATCH"
elif ! git -C "$SOURCE" apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  echo 'GC tool patch does not match the pinned source.' >&2; exit 1
fi
# O1 is for this native build tool only; WebKit's objects remain Release O3.
cmake -S "$SOURCE" -B "$BUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_FLAGS_RELEASE='-O1 -DNDEBUG' -DBUILD_TESTS=OFF \
  -DBUILD_LLVM_DWARF=ON -DBYN_ENABLE_LTO=OFF -DENABLE_WERROR=OFF \
  > "$ROOT/build/binaryen-gc-configure.log" 2>&1
cmake --build "$BUILD" --target wasm-opt -j "${BIB_JOBS:-3}" \
  > "$ROOT/build/binaryen-gc-build.log" 2>&1
"$BUILD/bin/wasm-opt" --help > "$ROOT/build/binaryen-gc-help.log"
rg -q -- '--spill-jsc-roots' "$ROOT/build/binaryen-gc-help.log"
echo 'GC root post-link tool: OK'
