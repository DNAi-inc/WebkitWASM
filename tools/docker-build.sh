#!/usr/bin/env bash
# Linux ARM64 builder on this Mac. Use Docker-local storage for compiler I/O;
# source edits and the delivered engine remain in the standalone host checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${BIB_BUILD_CONTAINER:-webkit-wasm-test-builder}"
VOLUME="${BIB_BUILD_VOLUME:-webkit-wasm-test-workspace}"
JOBS="${BIB_JOBS:-3}"
[[ "$JOBS" =~ ^[1-4]$ ]] || { echo 'BIB_JOBS must be 1–4'; exit 1; }
mkdir -p "$ROOT/build"
docker info > /dev/null
docker build -f "$ROOT/tools/Dockerfile.build" -t webkit-wasm-test-build:local "$ROOT"
if docker container inspect "$CONTAINER" > /dev/null 2>&1; then
  source_root=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/source"}}{{.Source}}{{end}}{{end}}' "$CONTAINER")
  volume_name=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Name}}{{end}}{{end}}' "$CONTAINER")
  [[ "$source_root" == "$ROOT" && "$volume_name" == "$VOLUME" ]] || { echo "Container $CONTAINER belongs to another workspace."; exit 1; }
  docker start "$CONTAINER" > /dev/null
else
  docker volume create --label app=webkit-wasm-test "$VOLUME" > /dev/null
  docker run -d --name "$CONTAINER" --init --cpus "$JOBS" --memory 6g --memory-swap 7g \
    --mount "type=volume,source=$VOLUME,target=/workspace" \
    --mount "type=bind,source=$ROOT,target=/source" \
    -e "BIB_JOBS=$JOBS" -e "EMCC_CORES=$JOBS" -e "CMAKE_BUILD_PARALLEL_LEVEL=$JOBS" \
    webkit-wasm-test-build:local sleep infinity > /dev/null
fi
docker exec -u root "$CONTAINER" chown 501:20 /workspace
# Export even a failed build's diagnostics, without copying compiler objects
# or replacing unrelated host files. Never delete the persistent build volume.
export_results() {
  local result=$?
  docker exec "$CONTAINER" bash -lc '
    mkdir -p /source/build
    find /workspace/build -maxdepth 1 -name "*.log" -type f -exec cp -f {} /source/build/ \;
    if [ "$1" = 0 ] && [ -d /workspace/build/webcore/bin ]; then
      mkdir -p /source/build/webcore/bin
      rsync -a /workspace/build/webcore/bin/ /source/build/webcore/bin/
    fi
  ' -- "$result"
}
trap export_results EXIT
docker exec -e "BIB_LINK_OPT=${BIB_LINK_OPT:-3}" "$CONTAINER" flock -n /workspace/.build.lock bash -lc '
  set -e
  export BIB_JOBS="$1" EMCC_CORES="$1" CMAKE_BUILD_PARALLEL_LEVEL="$1"
  rsync -a --exclude /build --exclude /third_party --exclude /node_modules --exclude /.git --exclude .DS_Store /source/ /workspace/
  mkdir -p build
  bash tools/bootstrap.sh > build/bootstrap.log 2>&1
  bash tools/build-webcore.sh
' -- "$JOBS"
