import streamlit as st
import subprocess
import sys
import os

# 页面标题
st.set_page_config(page_title="Stealth Miner Controller", layout="wide")
st.title("⚙️ Stealth Miner Control Panel")

# 使用 st.expander 创建一个可折叠的区域来放置控制按钮，让界面更整洁
with st.expander("🚀 控制面板", expanded=True):
    col1, col2, col3 = st.columns(3)

    with col1:
        # 启动矿机的按钮
        if st.button("▶️ 启动矿机", use_container_width=True):
            run_miner()

    with col2:
        # 停止矿机的按钮
        if st.button("⏹️ 停止矿机", use_container_width=True):
            stop_miner()

    with col3:
        # 刷新日志的按钮
        if st.button("🔄 刷新日志", use_container_width=True):
            st.rerun()

# 用于显示日志的区域
st.subheader("📋 实时运行日志")

# 创建一个占位符，用于动态更新日志内容
log_placeholder = st.empty()

# 检查日志文件是否存在，如果存在则读取并显示其内容
log_file_path = "miner.log"  # 假设脚本将输出重定向到此文件
if os.path.exists(log_file_path):
    with open(log_file_path, "r") as f:
        log_content = f.read()
    log_placeholder.code(log_content, language="bash")
else:
    log_placeholder.info("⏳ 矿机尚未启动或日志文件尚未生成...")


def run_miner():
    """在后台启动矿机脚本，并将输出重定向到日志文件"""
    script_path = "never.sh"  # 你的 Bash 脚本文件名

    # 检查脚本是否存在
    if not os.path.exists(script_path):
        st.error(f"❌ 错误: 找不到脚本文件 '{script_path}'。请确保它位于应用的同级目录下。")
        return

    # 确保脚本有执行权限
    os.chmod(script_path, 0o755)

    # 使用 subprocess.Popen 启动进程
    # 参数说明：
    #   - ['bash', script_path]: 使用 bash 执行脚本
    #   - stdout=subprocess.PIPE, stderr=subprocess.STDOUT: 捕获标准输出和错误
    #   - text=True: 以文本模式处理输出
    #   - bufsize=1: 行缓冲，便于实时读取
    try:
        process = subprocess.Popen(
            ['bash', script_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )

        # 将进程对象保存到 Streamlit 的 session_state 中，以便在其他地方（如停止功能）使用
        st.session_state['miner_process'] = process

        # 打开日志文件，准备写入
        with open("miner.log", "w") as log_file:
            # 实时读取进程的输出并写入日志文件
            for line in iter(process.stdout.readline, ''):
                log_file.write(line)
                log_file.flush()  # 立即刷新到磁盘

        # 等待进程结束
        process.wait()

        # 如果进程意外退出，显示提示
        if process.returncode != 0:
            st.warning(f"⚠️ 矿机进程已退出，返回码: {process.returncode}")

    except Exception as e:
        st.error(f"❌ 启动矿机时发生错误: {e}")


def stop_miner():
    """停止正在运行的矿机进程"""
    if 'miner_process' in st.session_state:
        process = st.session_state['miner_process']
        if process.poll() is None:  # 如果进程仍在运行
            process.terminate()  # 尝试优雅地终止
            st.success("✅ 已发送停止信号，矿机正在退出...")
        else:
            st.info("ℹ️ 矿机进程已经结束。")
    else:
        st.warning("⚠️ 没有正在运行的矿机进程。")
