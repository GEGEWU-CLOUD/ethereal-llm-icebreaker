#!/usr/bin/env bash
###############################################################################
# 昇腾 NPU 服务器压测脚本 (IceBreaker)
#   基线健康检查 (npu-smi) → ascend-dmi 满载压测 + 遥测采样 → 峰值汇总 + 压测后复查
#   无 ascend-dmi 时仅做基线检查并给出 MindX ToolBox 安装指引 (不算失败)
# 运行: bash npu_check.sh [压测秒数, 默认 1800]
# 产物: npucheck_*/REPORT_*.txt + npu_telemetry.csv + npu_burn.log
# 退出码: 0=通过  1=有告警(WARN/仅基线)  2=有失败(FAIL)
###############################################################################
set -uo pipefail

BURN_SECONDS="${1:-1800}"
SAMPLE_INTERVAL=5
NPU_TEMP_WARN=80

TS="$(date +%Y%m%d_%H%M%S)"
WORKDIR="$(pwd)/npucheck_${TS}"
mkdir -p "$WORKDIR"
REPORT_TXT="${WORKDIR}/REPORT_${TS}.txt"
TELE_CSV="${WORKDIR}/npu_telemetry.csv"
BURN_LOG="${WORKDIR}/npu_burn.log"

WARN_ITEMS=0; FAIL_ITEMS=0; PASS_COUNT=0
log(){ echo -e "$*" | tee -a "$REPORT_TXT"; }
sect(){ log ""; log "=== $* ==="; }
pass(){ PASS_COUNT=$((PASS_COUNT+1)); log "  [PASS] $*"; }
warn(){ WARN_ITEMS=$((WARN_ITEMS+1)); log "  [WARN] $*"; }
fail(){ FAIL_ITEMS=$((FAIL_ITEMS+1)); log "  [FAIL] $*"; }

echo "timestamp,npu_idx,temp_c,pwr_w,util_pct,mem_used_mib,sm_clk_mhz,throttle_hex" > "$TELE_CSV"

log "############################################################"
log "#        昇腾 NPU 服务器压测报告 (IceBreaker)"
log "#        生成时间: $(date -Is)"
log "#        主机名  : $(hostname)"
log "############################################################"

command -v npu-smi >/dev/null 2>&1 || { log "[FAIL] 未检测到 npu-smi (非昇腾机器或驱动未装)"; exit 2; }

npu_health(){ npu-smi info -t health -i "$1" 2>/dev/null | awk -F: '/Health/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }
npu_temp(){   npu-smi info -t temp  -i "$1" 2>/dev/null | awk -F: '/NPU Temperature/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }
npu_power(){  npu-smi info -t power -i "$1" 2>/dev/null | awk -F: '/Real-time Power/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }
npu_hbm(){    npu-smi info -t usages -i "$1" 2>/dev/null | awk -F: '/HBM Usage Rate/{gsub(/^ +| +$/,"",$2); print $2; exit}'; }

N=$(npu-smi info -l 2>/dev/null | grep -c "NPU ID" || true)
MODEL=$(npu-smi info 2>/dev/null | grep -oE '910[A-Z0-9]*|310P[0-9]*' | sort -u | paste -sd, -)

sect "1. NPU 基础信息"
log "  NPU 数量  : ${N}"
log "  型号      : ${MODEL:-未知}"
[ "${N}" -gt 0 ] && pass "识别到 ${N} 张 NPU (${MODEL:-型号未知})" || { fail "未识别到 NPU"; exit 2; }

sect "2. 压测前基线检查"
log "  卡  健康  温度℃  功耗W  HBM%"
BASELINE_BAD=0
for i in $(seq 0 $((N-1))); do
  h=$(npu_health "$i"); t=$(npu_temp "$i"); p=$(npu_power "$i"); m=$(npu_hbm "$i")
  log "  $i   ${h:-?}   ${t:-?}   ${p:-?}   ${m:-?}"
  if [ "${h:-}" != "OK" ]; then fail "NPU ${i} 健康状态异常: ${h:-读取失败}"; BASELINE_BAD=1; fi
done
[ "${BASELINE_BAD}" -eq 1 ] && { log ""; log ">>> 上架结论: 不通过 (FAIL，基线健康异常) <<<"; log "产物目录: ${WORKDIR}"; exit 2; }
pass "全部 ${N} 卡健康 OK"

# ---- 探测 ascend-dmi ----
dmi=""
for cand in "$(command -v ascend-dmi 2>/dev/null || true)" \
            /usr/local/Ascend/toolbox/latest/Ascend-DMI/bin/ascend-dmi \
            /usr/local/Ascend/toolbox/*/Ascend-DMI/bin/ascend-dmi; do
  [ -x "$cand" ] && { dmi=$cand; break; }
done

if [ -z "$dmi" ]; then
  warn "未找到 ascend-dmi，本次仅基线检查，未执行满载压测"
  log ""
  log "  安装指引 (MindX ToolBox 提供 ascend-dmi，不在 CANN 内):"
  log "    1) 安装 CANN toolkit (与驱动配套版本)"
  log "    2) 安装 MindX ToolBox: /usr/local/Ascend/toolbox/latest/Ascend-DMI/bin/ascend-dmi"
  log "    3) 或在 IceBreaker 平台 NPU 工作台点「安装 MindX ToolBox」自动安装"
  log ""
  log "=== 3. 汇总 ==="
  log "  通过项(PASS): ${PASS_COUNT}"
  log "  告警项(WARN): ${WARN_ITEMS}"
  log "  失败项(FAIL): ${FAIL_ITEMS}"
  log "  >>> 上架结论: 有条件通过 (WARN，仅基线检查，未满载压测) <<<"
  log "  产物目录: ${WORKDIR}"
  exit 1
fi

# ---- 遥测采样器 (输出与 GPU 遥测同构的 CSV, HBM% 作为利用率列) ----
SAMPLER=""
cleanup(){ [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null; }
trap cleanup EXIT INT TERM
(
  while :; do
    STAMP=$(date +%Y/%m/%d\ %H:%M:%S)
    for i in $(seq 0 $((N-1))); do
      echo "${STAMP}, ${i}, $(npu_temp "$i"), $(npu_power "$i"), $(npu_hbm "$i" | tr -d '%'), , , 0x0"
    done >> "$TELE_CSV" 2>/dev/null
    sleep "${SAMPLE_INTERVAL}"
  done
) & SAMPLER=$!

sect "3. NPU 满载压测 (ascend-dmi, ${BURN_SECONDS}s)"
log "  压测启动: $(date -Is)"
"$dmi" -f -d 0 -t "${BURN_SECONDS}" > "$BURN_LOG" 2>&1
DMI_RC=$?
kill "$SAMPLER" 2>/dev/null; SAMPLER=""
log "  压测结束: $(date -Is)"
[ "${DMI_RC}" -ne 0 ] && warn "ascend-dmi 返回码 ${DMI_RC}，请检查 ${BURN_LOG}" || pass "ascend-dmi 压测执行完成"

sect "4. 压测峰值统计 (温度/功耗峰值, 采样数)"
log "  卡   峰值温度℃   峰值功耗W   采样数"
awk -F', *' 'NR>1 && NF>=3 { i=$2+0
  if (!(i in mt) || $3+0>mt[i]) mt[i]=$3+0
  if (!(i in mp) || $4+0>mp[i]) mp[i]=$4+0
  n[i]++ }
  END { for (i in mt) printf "  %-4d %-10.0f %-10.0f %d\n", i, mt[i], mp[i], n[i] }' "$TELE_CSV" | sort -n -k1 | tee -a "$REPORT_TXT"
for i in $(seq 0 $((N-1))); do
  TMAX=$(awk -F', *' -v c="$i" 'NR>1 && $2+0==c && $3+0>m{m=$3+0} END{printf "%.0f", m+0}' "$TELE_CSV")
  [ -n "$TMAX" ] && [ "$TMAX" -ge "${NPU_TEMP_WARN}" ] && warn "NPU ${i} 峰值温度 ${TMAX}℃ ≥ ${NPU_TEMP_WARN}℃ (关注散热)"
done

sect "5. 压测后健康复查"
AFTER_BAD=0
for i in $(seq 0 $((N-1))); do
  h=$(npu_health "$i"); t=$(npu_temp "$i")
  log "  NPU ${i} 健康 ${h:-?} 温度 ${t:-?}℃"
  [ "${h:-}" != "OK" ] && { fail "NPU ${i} 压测后健康异常: ${h:-?}"; AFTER_BAD=1; }
done
[ "${AFTER_BAD}" -eq 0 ] && pass "压测后全部 ${N} 卡健康 OK"

sect "6. 汇总"
log "  通过项(PASS): ${PASS_COUNT}"
log "  告警项(WARN): ${WARN_ITEMS}"
log "  失败项(FAIL): ${FAIL_ITEMS}"
if [ "${FAIL_ITEMS}" -gt 0 ]; then
  VERDICT="不通过 (FAIL)"; RC=2
elif [ "${WARN_ITEMS}" -gt 0 ]; then
  VERDICT="有条件通过 (WARN，需复核)"; RC=1
else
  VERDICT="通过 (PASS)"; RC=0
fi
log "  >>> 上架结论: ${VERDICT} <<<"
log ""
log "  产物目录: ${WORKDIR}"
log "    - 文本报告 : ${REPORT_TXT}"
log "    - 遥测数据 : ${TELE_CSV}"
log "    - 压测日志 : ${BURN_LOG}"
exit ${RC}
