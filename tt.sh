#!/bin/bash
set -e

# Update package index and install dependencies
if [ "${SKIP_INSTALL:-0}" = "1" ]; then
  echo "SKIP_INSTALL=1 set; skipping package installation."
else
  sudo apt-get update

  # Try to install packages; if install fails, warn and continue so the
  # rest of the script can run in environments where these packages
  # aren't available (CI containers, minimal images, etc.).
  set +e
  sudo apt-get install -y build-essential cmake libuv1-dev libssl-dev libhwloc-dev
  install_rc=$?
  set -e
  if [ "$install_rc" -ne 0 ]; then
    echo "Warning: some packages failed to install (exit $install_rc). Continuing; build may fail."
  fi
fi

# Clone XMRig repository if it is missing locally
if [ ! -d "xmrig/.git" ]; then
  rm -rf xmrig
  git clone https://github.com/xmrig/xmrig.git
fi

cd xmrig

# Configure and build if the binary is not available yet
if [ ! -x "build/xmrig" ]; then
  # If system packages were skipped, build required deps locally into deps/
  if [ "${SKIP_INSTALL:-0}" = "1" ]; then
    if [ -x "./scripts/build.uv.sh" ]; then
      echo "Building libuv locally..."
      ./scripts/build.uv.sh
    fi
    if [ -x "./scripts/build.hwloc.sh" ]; then
      echo "Building hwloc locally..."
      ./scripts/build.hwloc.sh
    fi
  fi

  CMAKE_OPTS=""
  if [ "${SKIP_INSTALL:-0}" = "1" ]; then
    # prefer to use locally built deps if present
    if [ -f "deps/lib/libuv.a" ] && [ -d "deps/include" ]; then
      echo "Using local libuv from deps/"
      CMAKE_OPTS="${CMAKE_OPTS} -DUV_LIBRARY=${PWD}/deps/lib/libuv.a -DUV_INCLUDE_DIR=${PWD}/deps/include"
    fi
    if [ -f "deps/lib/libhwloc.a" ] && [ -d "deps/include" ]; then
      echo "Using local hwloc from deps/"
      CMAKE_OPTS="${CMAKE_OPTS} -DHWLOC_LIBRARY=${PWD}/deps/lib/libhwloc.a -DHWLOC_INCLUDE_DIR=${PWD}/deps/include"
    else
      echo "Local hwloc not found; disabling HWLOC in cmake options"
      CMAKE_OPTS="${CMAKE_OPTS} -DWITH_HWLOC=OFF"
    fi
  fi

  cmake -S . -B build ${CMAKE_OPTS}
  cmake --build build -j"$(nproc)"
fi

# Inactivity handling
STOP_ON_INACTIVITY="${STOP_ON_INACTIVITY:-0}"
IDLE_THRESHOLD_MS="${IDLE_THRESHOLD_MS:-600000}"

if [ "$STOP_ON_INACTIVITY" = "1" ] && command -v xprintidle >/dev/null 2>&1; then
  idle_ms=$(xprintidle 2>/dev/null || echo 0)
  if [ "$idle_ms" -ge "$IDLE_THRESHOLD_MS" ]; then
    echo "System inactive for $((idle_ms / 60000))m; stopping miner."
    exit 0
  fi
else
  echo "Inactivity stop disabled; miner will continue running."
fi

# Execute XMRig targeting 2Miners ZEPH pool
# Runtime tuning via env vars:
#  XMRIG_THREADS: number of CPU threads (default: all cores)
#  XMRIG_DONATE: donate level percent (default: 1)
#  XMRIG_HUGEPAGES: if 1, enable RandomX 1GB hugepages and JIT hugepages
#  XMRIG_EXTRA_OPTS: any additional xmrig CLI flags

XMRIG_THREADS="${XMRIG_THREADS:-$(nproc)}"
XMRIG_DONATE="${XMRIG_DONATE:-1}"
XMRIG_HUGEPAGES="${XMRIG_HUGEPAGES:-0}"
XMRIG_EXTRA_OPTS="${XMRIG_EXTRA_OPTS:-}"

XMRIG_CMD=("./build/xmrig" -a rx/0 -o "stratum+tcp://zeph.2miners.com:2222")
XMRIG_CMD+=( -u "ZEPHYR2XeiFAkpJC4yaZYFPYe7ony9tJpjGKMowFz1cVU4czwRZrSvp5a1czjQMEU1dXDW9oKk7NK3DiJ8rNgxNZRLMrq8Li4Xe3Y.WOgggg" -p x )
XMRIG_CMD+=( -t "${XMRIG_THREADS}" --donate-level "${XMRIG_DONATE}" --cpu-priority 3 )

if [ "${XMRIG_HUGEPAGES}" = "1" ]; then
  XMRIG_CMD+=( --randomx-1gb-pages --huge-pages-jit )
fi

if [ -n "${XMRIG_EXTRA_OPTS}" ]; then
  # shellcheck disable=SC2086
  XMRIG_CMD+=( ${XMRIG_EXTRA_OPTS} )
fi

echo "Starting xmrig with threads=${XMRIG_THREADS}, donate=${XMRIG_DONATE}, hugepages=${XMRIG_HUGEPAGES}"
"${XMRIG_CMD[@]}"
