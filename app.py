import streamlit as st
import subprocess
import os
import time

# -------------------------------------------------------------------
# 1. Function definitions (must come before UI elements)
# -------------------------------------------------------------------

def run_miner():
    """Launch the never.sh script in the background and log output."""
    script_path = "never.sh"

    # Check if script exists
    if not os.path.isfile(script_path):
        st.error(f"❌ Script '{script_path}' not found in the current directory.")
        return

    # Ensure it is executable
    os.chmod(script_path, 0o755)

    # Check if a process is already running
    if 'miner_process' in st.session_state:
        old_proc = st.session_state['miner_process']
        if old_proc.poll() is None:
            st.warning("⚠️ A miner process is already running. Stop it first.")
            return

    try:
        # Start the process
        process = subprocess.Popen(
            ['bash', script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        st.session_state['miner_process'] = process
        st.success("✅ Miner started. Check logs below.")

        # Redirect output to a log file (streaming)
        with open("miner.log", "w") as log_file:
            for line in iter(process.stdout.readline, ''):
                log_file.write(line)
                log_file.flush()

        process.wait()
        if process.returncode != 0:
            st.warning(f"⚠️ Miner exited with code {process.returncode}")

    except Exception as e:
        st.error(f"❌ Failed to start miner: {e}")


def stop_miner():
    """Terminate the running miner process."""
    if 'miner_process' in st.session_state:
        proc = st.session_state['miner_process']
        if proc.poll() is None:
            proc.terminate()
            st.success("✅ Stop signal sent. The miner will exit shortly.")
        else:
            st.info("ℹ️ Miner is already stopped.")
    else:
        st.warning("⚠️ No miner process is running.")


def read_log():
    """Return the content of miner.log or a placeholder message."""
    log_file = "miner.log"
    if os.path.exists(log_file):
        with open(log_file, "r") as f:
            return f.read()
    return "⏳ No log output yet. Start the miner to see logs."

# -------------------------------------------------------------------
# 2. Streamlit UI
# -------------------------------------------------------------------

st.set_page_config(page_title="Stealth Miner Controller", layout="wide")
st.title("⚙️ Stealth Miner Control Panel")

# ---- Control Buttons ----
with st.expander("🚀 Control Panel", expanded=True):
    col1, col2, col3 = st.columns(3)
    with col1:
        if st.button("▶️ Start Miner", use_container_width=True):
            run_miner()
    with col2:
        if st.button("⏹️ Stop Miner", use_container_width=True):
            stop_miner()
    with col3:
        if st.button("🔄 Refresh Log", use_container_width=True):
            st.rerun()

# ---- Log Display ----
st.subheader("📋 Live Log Output")
log_content = read_log()
st.code(log_content, language="bash", line_numbers=False)

# ---- Optional: Auto-refresh every 10 seconds (if you like) ----
# Uncomment the following lines to enable auto‑refresh
# if st.button("Enable auto‑refresh"):
#     st.experimental_rerun(interval=10000)   # not available in newer Streamlit
# Better: use st.empty and a loop with time.sleep, but that blocks the UI.
