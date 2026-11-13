#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Windows .exe 一键打包脚本 (PyInstaller onefile)
产出: dist/LLM-Benchmark-Server.exe —— 双击即启动完整服务(静态前端+登录鉴权+CORS代理), 零运行时依赖。
用法:
    python build_exe.py            # 缺少 PyInstaller 时自动 pip 安装; 建议 Python 3.10+ (命令: py -3.12 build_exe.py)
兼容说明:
    - 打包工作目录固定使用系统临时目录 (ASCII 路径), 规避中文项目路径下
      PyInstaller win32ctypes 'EndUpdateResource 拒绝访问' 的已知问题
    --add-data 源一律使用绝对路径 (specpath 变更后相对路径会失效)
    - users.json 不会打进 exe (运行时生成在 exe 旁边, data_root() 定位), 升级替换 exe 不丢账号
"""

import os
import sys
import glob
import shutil
import tempfile
import subprocess

ROOT = os.path.dirname(os.path.abspath(__file__))
EXE_NAME = "LLM-Benchmark-Server"

STATIC_FILES = [
    "index.html", "login.html", "style.css", "favicon.svg",
    "app.js", "analyzer.js", "charts.js", "stress-engine.js", "report-builder.js",
    "gpu-report-builder.js", "npu-report-builder.js", "gpu_check.sh", "npu_check.sh", "torch_wrapper.sh", "06-stress-test.sh",
]

VENDOR_FILES = glob.glob(os.path.join(ROOT, "vendor", "*"))


def main():
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print("[!] 未安装 PyInstaller, 正在安装: pip install pyinstaller")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller"])

    for f in STATIC_FILES:
        if not os.path.exists(os.path.join(ROOT, f)):
            raise SystemExit(f"[x] 缺少静态资源: {f}")
    if not VENDOR_FILES:
        raise SystemExit("[x] vendor/ 目录为空, 请先放入 chart.umd.min.js 与 html2pdf.bundle.min.js")

    # ASCII 安全的构建目录 (规避中文路径下 win32ctypes 资源写入被拒)
    build_root = os.path.join(tempfile.gettempdir(), "llm-bench-pyinstaller")
    dist_dir = os.path.join(build_root, "dist")
    work_dir = os.path.join(build_root, "work")
    shutil.rmtree(build_root, ignore_errors=True)

    sep = ";" if sys.platform.startswith("win") else ":"
    add_data_args = []
    for f in STATIC_FILES:
        add_data_args += ["--add-data", os.path.join(ROOT, f) + sep + "."]
    for f in VENDOR_FILES:
        add_data_args += ["--add-data", f + sep + "vendor"]

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
        "--name", EXE_NAME,
        "--noconfirm",
        "--clean",
        "--distpath", dist_dir,
        "--workpath", work_dir,
        "--specpath", work_dir,
    ] + add_data_args + [os.path.join(ROOT, "server.py")]

    print("[*] 构建目录: " + build_root)
    print("[*] 即将执行:")
    print("    " + " ".join(cmd))
    subprocess.check_call(cmd)

    # 拷贝产物回项目 dist/
    final_dir = os.path.join(ROOT, "dist")
    os.makedirs(final_dir, exist_ok=True)
    src_exe = os.path.join(dist_dir, EXE_NAME + ".exe")
    dst_exe = os.path.join(final_dir, EXE_NAME + ".exe")
    shutil.copy2(src_exe, dst_exe)

    print()
    print("=" * 60)
    print(f"  [√] 打包完成: dist/{EXE_NAME}.exe  ({os.path.getsize(dst_exe) / 1048576:.1f} MB)")
    print("  [√] 双击运行即可, 默认访问 http://127.0.0.1:8765")
    print("  [√] 首次运行会在 exe 同目录生成 users.json (默认 admin/admin123)")
    print("=" * 60)


if __name__ == "__main__":
    main()
