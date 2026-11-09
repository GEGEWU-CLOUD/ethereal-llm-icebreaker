#!/usr/bin/env bash
# 第6步：算力压力测试（可选）
#   NVIDIA -> 优先 gpu-burn 满载；没有 CUDA toolkit 时自动退到 torch 满载 + 结果校验
#   昇腾   -> npu-smi 基线检查；有 ascend-dmi 则压测并采样峰值
# 用法：bash 06-stress-test.sh
#       BURN_SECONDS=600 bash 06-stress-test.sh
#       SAMPLE_INTERVAL=2 bash 06-stress-test.sh        # 采样更密
#       INSTALL_TOOLKIT=1 bash 06-stress-test.sh        # 缺 CUDA toolkit 时尝试 apt 装 libcublas-dev
#       FORCE=1 bash 06-stress-test.sh                  # 卡上已有进程时仍强行压测（会抢显存）
set -uo pipefail

BURN_SECONDS=${BURN_SECONDS:-1800}
SAMPLE_INTERVAL=${SAMPLE_INTERVAL:-5}
STAMP=$(date +%Y%m%d-%H%M%S)
LOGDIR=/root/stress-logs
REPORT="$LOGDIR/stress-report-$STAMP.log"
rc=0
SAMPLER=""

mkdir -p "$LOGDIR" 2>/dev/null || LOGDIR=/tmp
[[ -d $LOGDIR ]] || { LOGDIR=/tmp; REPORT="/tmp/stress-report-$STAMP.log"; }
exec > >(tee -a "$REPORT") 2>&1

cleanup() { [[ -n $SAMPLER ]] && kill "$SAMPLER" 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "[INFO] $(date -Is)  压测时长 ${BURN_SECONDS}s  采样间隔 ${SAMPLE_INTERVAL}s"
echo "[INFO] 报告：$REPORT"

# ============================ 昇腾 ============================
if ! command -v nvidia-smi >/dev/null 2>&1; then
    command -v npu-smi >/dev/null 2>&1 || { echo "[FAIL] 没有 nvidia-smi / npu-smi，先做第2步"; exit 1; }

    npu_health() { npu-smi info -t health  -i "$1" 2>/dev/null | awk -F: '/Health/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }
    npu_temp()   { npu-smi info -t temp    -i "$1" 2>/dev/null | awk -F: '/NPU Temperature/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }
    npu_power()  { npu-smi info -t power   -i "$1" 2>/dev/null | awk -F: '/Real-time Power/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }
    npu_hbm()    { npu-smi info -t usages  -i "$1" 2>/dev/null | awk -F: '/HBM Usage Rate/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }

    n=$(npu-smi info -l 2>/dev/null | grep -c "NPU ID" || true)
    model=$(npu-smi info 2>/dev/null | grep -oE '910[A-Z0-9]*|310P[0-9]*' | sort -u | paste -sd, -)
    echo "[OK] ${n} 张 NPU，型号 ${model}"

    echo
    echo "==== 压测前基线 ===="
    printf '%-4s %-6s %-6s %-8s %-6s\n' 卡 健康 温度 功耗W HBM%
    for i in $(seq 0 $((n - 1))); do
        h=$(npu_health "$i"); t=$(npu_temp "$i"); p=$(npu_power "$i"); m=$(npu_hbm "$i")
        printf '%-4s %-6s %-6s %-8s %-6s\n' "$i" "${h:-?}" "${t:-?}" "${p:-?}" "${m:-?}"
        if [[ ${h:-} != OK ]]; then
            echo "[FAIL] NPU ${i} 健康状态异常：${h:-读取失败}"
            rc=1
        fi
    done
    [[ $rc -eq 0 ]] || { echo "[FAIL] 有卡不健康，先排查再压测"; exit 1; }

    dmi=""
    for cand in "$(command -v ascend-dmi 2>/dev/null || true)" \
                /usr/local/Ascend/toolbox/latest/Ascend-DMI/bin/ascend-dmi \
                /usr/local/Ascend/toolbox/*/Ascend-DMI/bin/ascend-dmi; do
        if [[ -x $cand ]]; then dmi=$cand; break; fi
    done

    if [[ -z $dmi ]]; then
        cat <<'TIP'

[SKIP] 未找到 ascend-dmi，本次只做了基线检查，没有压测。

ascend-dmi 不在 CANN toolkit 里，它随 MindX ToolBox 安装，
路径一般是 /usr/local/Ascend/toolbox/latest/Ascend-DMI/bin/ascend-dmi。

1) CANN toolkit（ToolBox 的前置依赖）
   下载 https://www.hiascend.com/developer/download ，选与驱动配套的 CANN 社区版
     sudo apt install -y gcc g++ make python3 python3-pip
     chmod +x Ascend-cann-toolkit_*_linux-aarch64.run
     ./Ascend-cann-toolkit_*_linux-aarch64.run --install

2) MindX ToolBox（提供 ascend-dmi）
   同页面选 MindX DL / ToolBox，版本与 CANN 配套
     chmod +x Ascend-mindx-toolbox_*_linux-aarch64.run
     ./Ascend-mindx-toolbox_*_linux-aarch64.run --install

3) 加载环境后重跑本脚本
     source /usr/local/Ascend/ascend-toolkit/set_env.sh
TIP
        exit 0
    fi

    echo
    echo "[DO] ${dmi} 压测 ${BURN_SECONDS}s，期间每 ${SAMPLE_INTERVAL}s 采样"
    samples=$(mktemp)
    (
        while :; do
            for i in $(seq 0 $((n - 1))); do
                echo "$i $(npu_temp "$i") $(npu_power "$i")"
            done
            sleep "$SAMPLE_INTERVAL"
        done
    ) >"$samples" 2>/dev/null &
    SAMPLER=$!

    "$dmi" -f -d 0 -t "$BURN_SECONDS" || { echo "[WARN] ascend-dmi 返回非 0，确认参数：${dmi} -h"; rc=1; }

    kill "$SAMPLER" 2>/dev/null; SAMPLER=""

    echo
    echo "==== 压测峰值 ===="
    awk '{ if ($2+0 > t[$1]) t[$1]=$2+0; if ($3+0 > p[$1]) p[$1]=$3+0; n[$1]++ }
         END { printf "%-4s %-8s %-8s %-6s\n", "卡", "温度℃", "功耗W", "采样";
               for (i in t) printf "%-4s %-8.0f %-8.0f %-6d\n", i, t[i], p[i], n[i] }' "$samples" | sort -n
    rm -f "$samples"

    echo
    echo "==== 压测后状态 ===="
    for i in $(seq 0 $((n - 1))); do
        h=$(npu_health "$i")
        printf 'NPU %s 健康 %s 温度 %s℃\n' "$i" "${h:-?}" "$(npu_temp "$i")"
        [[ ${h:-} == OK ]] || rc=1
    done

    [[ $rc -eq 0 ]] && echo "[OK] 压测完成，全部卡健康"
    exit $rc
fi

# ============================ NVIDIA ============================
n=$(nvidia-smi -L | wc -l)
drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
echo "[OK] ${n} 张卡，驱动 ${drv:-?}，压测前状态："
nvidia-smi --query-gpu=index,name,temperature.gpu,power.draw --format=csv,noheader

# ---- 占用检查：卡上有服务在跑就别压 ----
apps=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null || true)
if [[ -n ${apps// /} ]]; then
    echo
    echo "[WARN] 卡上已有进程占用显存/算力："
    echo "$apps" | sed 's/^/       /' | head -10
    used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | sort -rn | head -1)
    tot=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | sort -rn | head -1)
    echo "[WARN] 单卡已用 ${used} MiB / ${tot} MiB，此时压测：结果没参考价值，还可能把业务打挂。"
    if [[ ${FORCE:-0} != 1 ]]; then
        echo "[FAIL] 已中止。先停掉服务再跑；确实要硬压请加 FORCE=1"
        exit 1
    fi
    echo "[WARN] FORCE=1，继续压测"
fi

# ---- 采样字段：按驱动支持能力自动裁剪 ----
QFIELDS="index,temperature.gpu,power.draw,clocks.sm,utilization.gpu,memory.used"
nf=6
if nvidia-smi --query-gpu="$QFIELDS,clocks_event_reasons.active,ecc.errors.uncorrected.volatile.total" --format=csv,noheader >/dev/null 2>&1; then
    QFIELDS="$QFIELDS,clocks_event_reasons.active,ecc.errors.uncorrected.volatile.total"; nf=8
elif nvidia-smi --query-gpu="$QFIELDS,clocks_event_reasons.active" --format=csv,noheader >/dev/null 2>&1; then
    QFIELDS="$QFIELDS,clocks_event_reasons.active"; nf=7
fi

ecc_before=$(nvidia-smi --query-gpu=ecc.errors.uncorrected.volatile.total --format=csv,noheader,nounits 2>/dev/null | paste -sd, - || echo "n/a")
xid_before=$(dmesg 2>/dev/null | grep -c "Xid" || true)
echo "[INFO] 压测前：uncorrected ECC=[${ecc_before}]  历史 Xid 数=${xid_before}"

# ---- 选压测引擎：gpu-burn > torch ----
GB="$HOME/gpu-burn/gpu_burn"
toolkit=""
for c in "${CUDA_HOME:-}" /usr/local/cuda /usr/local/cuda-*; do
    [[ -n $c && -f $c/include/cublas_v2.h ]] && { toolkit=$c; break; }
done

if [[ -x $GB ]]; then
    echo "[OK] 复用已有 $GB"
elif [[ -n $toolkit ]]; then
    echo "[DO] 编译 gpu-burn（CUDAPATH=$toolkit）"
    for p in gcc g++ make git; do command -v "$p" >/dev/null || apt-get install -y "$p"; done
    [[ -d $HOME/gpu-burn ]] || git clone --depth 1 https://github.com/wilicc/gpu-burn.git "$HOME/gpu-burn"
    cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '.' || true)
    make -C "$HOME/gpu-burn" CUDAPATH="$toolkit" COMPUTE="${cc:-89}" || { echo "[WARN] gpu-burn 编译失败，改用 torch"; GB=""; }
else
    echo "[WARN] 未装 CUDA toolkit（缺 cublas_v2.h），gpu-burn 编不了"
    if [[ ${INSTALL_TOOLKIT:-0} == 1 ]]; then
        echo "[DO] INSTALL_TOOLKIT=1，尝试安装 libcublas-dev"
        apt-get update -qq && apt-get install -y libcublas-dev || echo "[WARN] 安装失败"
        for c in /usr/local/cuda /usr/local/cuda-*; do [[ -f $c/include/cublas_v2.h ]] && toolkit=$c; done
        if [[ -n $toolkit ]]; then
            [[ -d $HOME/gpu-burn ]] || git clone --depth 1 https://github.com/wilicc/gpu-burn.git "$HOME/gpu-burn"
            cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '.' || true)
            make -C "$HOME/gpu-burn" CUDAPATH="$toolkit" COMPUTE="${cc:-89}" && GB="$HOME/gpu-burn/gpu_burn"
        fi
    fi
    [[ -x $GB ]] || echo "[INFO] 改用 torch 满载自检（不需要 CUDA toolkit）"
fi

# ---- 采样器 ----
SAMPLES="$LOGDIR/samples-$STAMP.csv"
: >"$SAMPLES"
( while :; do
    nvidia-smi --query-gpu="$QFIELDS" --format=csv,noheader,nounits >>"$SAMPLES" 2>/dev/null || true
    sleep "$SAMPLE_INTERVAL"
  done ) &
SAMPLER=$!

# ---- 执行压测 ----
echo
if [[ -x $GB ]]; then
    echo "[DO] gpu-burn 满载 ${BURN_SECONDS}s"
    "$GB" "$BURN_SECONDS" 2>&1 | tee "$LOGDIR/gpu-burn-$STAMP.log" || true
    burnlog=$(cat "$LOGDIR/gpu-burn-$STAMP.log")
    if grep -q "FAULTY" <<<"$burnlog"; then
        echo "[FAIL] 有卡计算错误"; rc=1
    fi
    grep -E "GPU [0-9]+: OK" <<<"$burnlog" || true
else
    PY=""
    for cand in "${PYTHON:-}" /home/liantong/miniconda3/bin/python /opt/conda/bin/python "$(command -v python3)"; do
        [[ -n $cand && -x $cand ]] || continue
        "$cand" -c 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)' >/dev/null 2>&1 && { PY=$cand; break; }
    done
    [[ -n $PY ]] || { echo "[FAIL] 找不到带 CUDA 版 torch 的 Python，装 CUDA toolkit 或指定 PYTHON=/path/python"; exit 1; }
    echo "[DO] torch 满载 ${BURN_SECONDS}s（$PY，torch $("$PY" -c 'import torch;print(torch.__version__)' 2>/dev/null)）"
    cat >"$LOGDIR/torch_burn.py" <<'PYEOF'
import sys, time, threading, torch
dur = float(sys.argv[1]); frac = float(sys.argv[2]) if len(sys.argv) > 2 else 0.55
torch.backends.cuda.matmul.allow_tf32 = True
res = {}

def burn(i, out):
    try:
        torch.cuda.set_device(i); dev = f"cuda:{i}"
        free, total = torch.cuda.mem_get_info(i)
        if free < 4 * 2 ** 30:
            raise RuntimeError(f"可用显存只有 {free/2**30:.0f}GiB，压测无意义（卡被占用？）")
        n = max(4096, min(int((free * frac / 6) ** 0.5), 24576))
        a = torch.randn(n, n, device=dev, dtype=torch.float16)
        b = torch.randn(n, n, device=dev, dtype=torch.float16)
        ref = (a @ b).sum().item()
        it = bad = 0; t0 = time.time(); flops = 2 * n ** 3
        while time.time() - t0 < dur:
            s = (a @ b).sum().item(); it += 1
            if abs(s - ref) > 1e-4 * max(1.0, abs(ref)):
                bad += 1
        el = time.time() - t0
        out[i] = dict(n=n, it=it, bad=bad, tflops=flops * it / el / 1e12, ok=(bad == 0))
    except Exception as e:
        out[i] = dict(ok=False, err=repr(e)[:200])

ths = [threading.Thread(target=burn, args=(i, res)) for i in range(torch.cuda.device_count())]
[t.start() for t in ths]; [t.join() for t in ths]
ok = True
for i in sorted(res):
    r = res[i]
    if r.get("ok"):
        print(f"GPU {i}: OK  n={r['n']} iter={r['it']} {r['tflops']:.0f} TFLOPS")
    else:
        ok = False
        print(f"GPU {i}: FAULTY  {r.get('err') or ('mismatch=' + str(r.get('bad')))}")
sys.exit(0 if ok else 1)
PYEOF
    "$PY" "$LOGDIR/torch_burn.py" "$BURN_SECONDS" || { echo "[FAIL] torch 压测报错（看上面的 FAULTY 行）"; rc=1; }
fi

sleep 2
cleanup; SAMPLER=""

# ---- 结果汇总 ----
echo
echo "==== 峰值/降频（基于每 ${SAMPLE_INTERVAL}s 采样，共 $(wc -l <"$SAMPLES") 条）===="
printf '%-4s %-9s %-9s %-9s %-8s %s\n' 卡 峰值温度 峰值功耗 平均功耗 最低SM 降频采样
awk -F', *' -v nf="$nf" '
  NF>=6 { i=$1+0
    if (!(i in mt) || $2+0 > mt[i]) mt[i]=$2+0
    sp[i]+=$3+0; if ($3+0 > mp[i]) mp[i]=$3+0; c[i]++
    if (!(i in mc) || $4+0 < mc[i]) mc[i]=$4+0
    if (nf>=7 && $7 !~ /^0x0*$/) th[i]++
  }
  END {
    for (i in mt)
      printf "%-4s %-9.0f %-9.0f %-9.0f %-8.0f %s\n", i, mt[i], mp[i], sp[i]/c[i], mc[i], (th[i]+0 ? th[i] " 次" : "-")
  }' "$SAMPLES" | sort -k1,1n

echo
echo "==== 压测后 ===="
printf '%-4s %-9s %-9s %s\n' 卡 温度 功耗W SM频率
nvidia-smi --query-gpu=index,temperature.gpu,power.draw,clocks.sm --format=csv,noheader

ecc_after=$(nvidia-smi --query-gpu=ecc.errors.uncorrected.volatile.total --format=csv,noheader,nounits 2>/dev/null | paste -sd, - || echo "n/a")
xid_after=$(dmesg 2>/dev/null | grep -c "Xid" || true)
echo "[INFO] uncorrected ECC: 前=[${ecc_before}] 后=[${ecc_after}]"
if [[ "$ecc_before" != "$ecc_after" ]]; then echo "[FAIL] ECC 不可纠正错误有增长"; rc=1; fi
if [[ ${xid_after:-0} -gt ${xid_before:-0} ]]; then
    echo "[FAIL] 新增 Xid（GPU 侧报错），最近几条："
    dmesg | grep "Xid" | tail -5
    rc=1
else
    echo "[OK] 无新增 Xid"
fi
if dmesg | grep -qiE "fallen off the bus"; then echo "[FAIL] 检测到 GPU 掉总线"; rc=1; fi

limit=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits 2>/dev/null | sort -rn | head -1)
peak=$(awk -F', *' 'NF>=6{if($3+0>m)m=$3+0} END{print m+0}' "$SAMPLES")
if [[ -n ${limit:-} && -n ${peak:-} ]] && awk -v p="$peak" -v l="$limit" 'BEGIN{exit !(p < l*0.7)}'; then
    echo "[WARN] 峰值功耗 ${peak}W 只有限额 ${limit}W 的 $(awk -v p="$peak" -v l="$limit" 'BEGIN{printf "%.0f", p*100/l}')%，可能没真正打满（算力/带宽瓶颈或共享卡）"
fi

echo
[[ $rc -eq 0 ]] && echo "[OK] 压测通过（$(date +%H:%M:%S)，报告 $REPORT）" || echo "[FAIL] 压测异常，详见 $REPORT"
exit $rc