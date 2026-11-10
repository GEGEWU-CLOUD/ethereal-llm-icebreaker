#!/usr/bin/env bash
# torch_wrapper.sh — 包装 06-stress-test.sh, 输出平台标准产物格式
# 用法: bash torch_wrapper.sh [压测秒数] [fp16|fp32]
# 环境变量: BURN_SECONDS / PRECISION (fp16 默认吞吐最高; fp32 与 gpu-burn 同口径)
# 产物: hwcheck_*/REPORT_*.txt + gpu_telemetry.csv + gpu_burn.log
set -uo pipefail

BURN_SECONDS="${1:-${BURN_SECONDS:-1800}}"
PRECISION="${2:-${PRECISION:-fp16}}"
case "$PRECISION" in fp16|fp32) ;; *) PRECISION="fp16" ;; esac
SAMPLE_INTERVAL=5

TS="$(date +%Y%m%d_%H%M%S)"
WORKDIR="$(pwd)/hwcheck_${TS}"
mkdir -p "$WORKDIR"
REPORT_TXT="${WORKDIR}/REPORT_${TS}.txt"
TELE_CSV="${WORKDIR}/gpu_telemetry.csv"
BURN_LOG="${WORKDIR}/gpu_burn.log"

echo "timestamp,gpu_idx,temp_c,pwr_w,util_pct,mem_used_mib,sm_clk_mhz,throttle_hex" > "$TELE_CSV"

WARN=0; FAIL=0; PASS=0
log(){ echo "$*" | tee -a "$REPORT_TXT"; }
sect(){ log ""; log "=== $* ==="; }
ok(){ PASS=$((PASS+1)); log "  [PASS] $*"; }
warn(){ WARN=$((WARN+1)); log "  [WARN] $*"; }
fail(){ FAIL=$((FAIL+1)); log "  [FAIL] $*"; }

log "############################################################"
log "#        GPU 服务器压测报告 (torch 引擎)"
log "#        生成时间: $(date -Is)"
log "#        主机名  : $(hostname)"
log "############################################################"

# ===== GPU 信息 =====
N=$(nvidia-smi -L 2>/dev/null | wc -l)
DRV=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
GPUS=$(nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null)

sect "1. 系统信息"
log "  OS        : $(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
log "  内核      : $(uname -r)"
log "  整机型号  : $(dmidecode -s system-product-name 2>/dev/null || echo 未知)"
log "  CPU       : $(lscpu 2>/dev/null | awk -F: '/Model name/{gsub(/^ +/,"",$2);print $2;exit}')"

sect "2. 内存"
log "  总容量    : $(free -h | awk '/^Mem:/{print $2}')"
ecc_ce=0; ecc_ue=0
if ls /sys/devices/system/edac/mc/mc*/ce_count >/dev/null 2>&1; then
  ecc_ce=$(cat /sys/devices/system/edac/mc/mc*/ce_count 2>/dev/null | awk '{s+=$1}END{print s+0}')
  ecc_ue=$(cat /sys/devices/system/edac/mc/mc*/ue_count 2>/dev/null | awk '{s+=$1}END{print s+0}')
  log "  ECC CE/UE : ${ecc_ce}/${ecc_ue}"
else
  log "  ECC       : 未检测到 EDAC"
fi

sect "3. GPU 基础信息"
log "  GPU 数量  : ${N}"
log "  驱动版本  : ${DRV}"
echo "$GPUS" | while IFS= read -r g; do log "  GPU $g"; done
[ "$N" -gt 0 ] && ok "识别到 ${N} 张 GPU" || { fail "未识别到 GPU"; exit 2; }

# ===== ECC / Xid 基线 =====
ecc_before=$(nvidia-smi --query-gpu=ecc.errors.uncorrected.volatile.total --format=csv,noheader,nounits 2>/dev/null | paste -sd, - || echo "n/a")
xid_before=$(dmesg 2>/dev/null | grep -c "Xid" || true)

# ===== 找 torch Python =====
PY=""
for cand in "${PYTHON:-}" /home/liantong/miniconda3/bin/python /opt/conda/bin/python "$(command -v python3)"; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  "$cand" -c 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)' >/dev/null 2>&1 && { PY=$cand; break; }
done
[ -z "$PY" ] && { fail "找不到带 CUDA torch 的 Python"; log "  检查过: miniconda, /opt/conda, 系统 python3"; exit 2; }
ok "找到 PyTorch: $PY ($($PY -c 'import torch;print(torch.__version__)' 2>/dev/null))"

# ===== 遥测采样器 =====
SAMPLER=""
cleanup(){ [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null; }
trap cleanup EXIT INT TERM
(
  while :; do
    nvidia-smi --query-gpu=timestamp,index,temperature.gpu,power.draw,utilization.gpu,memory.used,clocks.sm,clocks_event_reasons.active \
      --format=csv,noheader,nounits 2>/dev/null | awk -F', *' \
      -v OFS=', ' \
      '{ts=$1; gsub(/ [-+0-9:.TZ]*$/, "", ts); print ts, $2, $3, $4, $5, $6, $7, $8}' >> "$TELE_CSV"
    sleep "$SAMPLE_INTERVAL"
  done
) & SAMPLER=$!

# ===== torch 满载压测 =====
sect "4. torch 满载压测 (${BURN_SECONDS}s · ${PRECISION})"
log "  计算精度  : ${PRECISION} (FP16 吞吐最高; FP32 与 gpu-burn 同口径)"
log "  压测启动: $(date -Is)"

cat > "${WORKDIR}/torch_burn.py" << 'PYEOF'
import sys, time, threading, torch
dur = float(sys.argv[1]); frac = float(sys.argv[2]) if len(sys.argv) > 2 else 0.55
prec = (sys.argv[3] if len(sys.argv) > 3 else 'fp16').lower()
DT = torch.float32 if prec == 'fp32' else torch.float16
BPE = 4 if prec == 'fp32' else 2          # 每元素字节数, 决定矩阵尺寸上限
torch.backends.cuda.matmul.allow_tf32 = True
res = {}

def burn(i, out):
    try:
        torch.cuda.set_device(i); dev = f"cuda:{i}"
        free, total = torch.cuda.mem_get_info(i)
        if free < 2 * 2 ** 30:
            raise RuntimeError(f"可用显存 {free/2**30:.0f}GiB, 不足以压测")
        n = max(4096, min(int((free * frac / (3 * BPE)) ** 0.5), 24576))
        a = torch.randn(n, n, device=dev, dtype=DT)
        b = torch.randn(n, n, device=dev, dtype=DT)
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
for i in sorted(res):
    r = res[i]
    if r.get('ok'):
        print(f"GPU {i}: OK  n={r['n']} iter={r['it']} {r['tflops']:.0f} TFLOPS ({prec.upper()})")
    else:
        print(f"GPU {i}: FAULTY  {r.get('err') or 'mismatch=' + str(r.get('bad'))}")
import sys; sys.exit(0 if all(r.get('ok') for r in res.values()) else 1)
PYEOF

"$PY" "${WORKDIR}/torch_burn.py" "$BURN_SECONDS" "0.55" "$PRECISION" > "$BURN_LOG" 2>&1
BURN_RC=$?

kill "$SAMPLER" 2>/dev/null; SAMPLER=""
log "  压测结束: $(date -Is)"
log "  GPU 结果:"
cat "$BURN_LOG" | while IFS= read -r line; do log "    $line"; done

FAULTY=$(grep -c "FAULTY" "$BURN_LOG" || true)
if [ "$FAULTY" -gt 0 ]; then
  fail "${FAULTY} 张卡计算错误(FAULTY)"
else
  ok "${N} 卡全部计算正确(OK)"
fi

# ===== Xid / ECC 检查 =====
sect "5. 压测后检查"
ecc_after=$(nvidia-smi --query-gpu=ecc.errors.uncorrected.volatile.total --format=csv,noheader,nounits 2>/dev/null | paste -sd, - || echo "n/a")
xid_after=$(dmesg 2>/dev/null | grep -c "Xid" || true)
if [ "$ecc_before" != "$ecc_after" ] 2>/dev/null; then
  fail "ECC 不可纠正错误增长: 前=[$ecc_before] 后=[$ecc_after]"
else
  ok "无新增 ECC 错误"
fi
if [ "${xid_after:-0}" -gt "${xid_before:-0}" ]; then
  fail "新增 Xid 错误"
else
  ok "无新增 Xid"
fi

# ===== 遥测峰值 =====
sect "6. 遥测峰值统计"
awk -F', *' 'NR>1 && NF>=6 {
  i=$2+0
  if (!(i in mt) || $3+0>mt[i]) mt[i]=$3+0
  if (!(i in mp) || $4+0>mp[i]) mp[i]=$4+0
  if (!(i in mc) || $7+0<mc[i]) mc[i]=$7+0
  n[i]++
  if (NF>=8 && $8 !~ /^0x0*$/) th[i]++
} END {
  printf "  %-4s %-9s %-9s %-9s %-8s %s\n", "GPU", "Tmax℃", "Pmax_W", "SM_Min", "采样", "降频"
  for (i in mt) printf "  %-4d %-9.0f %-9.0f %-9.0f %-8d %d\n", i, mt[i], mp[i], mc[i], n[i], th[i]+0
}' "$TELE_CSV" | sort -t' ' -k2 -n | tee -a "$REPORT_TXT"

# 温度判定
for i in $(seq 0 $((N-1))); do
  TMAX=$(awk -F', *' -v c="$i" 'NR>1 && $2+0==c && $3+0>m{m=$3+0} END{printf "%.0f", m+0}' "$TELE_CSV")
  [ -n "$TMAX" ] && [ "$TMAX" -ge 85 ] && warn "GPU ${i} 峰值温度 ${TMAX}℃ ≥ 85℃"
done

# ===== 汇总 =====
sect "7. 检测结论汇总"
log "  通过项(PASS): ${PASS}"
log "  告警项(WARN): ${WARN}"
log "  失败项(FAIL): ${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  VERDICT="不通过 (FAIL)"
elif [ "$WARN" -gt 0 ]; then
  VERDICT="有条件通过 (WARN)"
else
  VERDICT="通过 (PASS)"
fi
log "  >>> 上架结论: ${VERDICT} <<<"
log ""
log "  产物目录: ${WORKDIR}"

exit $([ "$FAIL" -gt 0 ] && echo 2 || [ "$WARN" -gt 0 ] && echo 1 || echo 0)
