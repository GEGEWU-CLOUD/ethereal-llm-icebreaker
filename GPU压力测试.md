# 硬件压力测试及脚本

以下代码复制粘贴，并生成脚本文件hardware_check.sh，上传到服务器/tmp目录下

```bash
#!/usr/bin/env bash
###############################################################################
# Ubuntu GPU 服务器标准上架硬件检测脚本
#
# 用途   : 新机/上架前的标准化硬件健康 + GPU 压力测试，自动生成检测报告。
# 适用   : Ubuntu 20.04 / 22.04 / 24.04，NVIDIA GPU 服务器。
# 运行   : sudo ./hardware_check.sh [GPU压测秒数，默认1800=30分钟]
#          例: sudo ./hardware_check.sh 3600   # 压测1小时
# 特性   : GPU 压测后台运行，全程采集温度/功耗/利用率遥测，
#          结束后只输出一份汇总报告 (REPORT_*.txt / REPORT_*.md)。
#
# 退出码 : 0=全部通过  1=有告警(WARN)  2=有失败(FAIL)
###############################################################################
set -u

#----------------------------------- 配置 ------------------------------------#
BURN_SECONDS="${1:-1800}"                 # GPU 压测时长(秒)，默认30分钟
TELE_INTERVAL=15                          # 遥测采样间隔(秒)
GPU_TEMP_WARN=85                          # GPU 温度告警阈值(℃)
GPU_TEMP_FAIL=90                          # GPU 温度失败阈值(℃)
GPU_BURN_REPO="https://github.com/wilicc/gpu-burn.git"

TS="$(date +%Y%m%d_%H%M%S)"
WORKDIR="$(pwd)/hwcheck_${TS}"
mkdir -p "$WORKDIR"
REPORT_TXT="${WORKDIR}/REPORT_${TS}.txt"
REPORT_MD="${WORKDIR}/REPORT_${TS}.md"
TELE_CSV="${WORKDIR}/gpu_telemetry.csv"
BURN_LOG="${WORKDIR}/gpu_burn.log"

# 检测结果累计
WARN_ITEMS=()
FAIL_ITEMS=()
PASS_COUNT=0

#--------------------------------- 工具函数 ----------------------------------#
log()  { echo -e "$*" | tee -a "$REPORT_TXT"; }
hr()   { log "------------------------------------------------------------"; }
sect() { log ""; log "=== $* ==="; }
pass() { PASS_COUNT=$((PASS_COUNT+1)); log "  [PASS] $*"; }
warn() { WARN_ITEMS+=("$*"); log "  [WARN] $*"; }
fail() { FAIL_ITEMS+=("$*"); log "  [FAIL] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# 静默安装依赖(不联网也不阻塞)
ensure_pkg() {
  local bin="$1" pkg="$2"
  have "$bin" && return 0
  if have apt-get; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg" >/dev/null 2>&1
  fi
  have "$bin"
}

#--------------------------------- 报告头 ------------------------------------#
log "############################################################"
log "#        Ubuntu 服务器上架硬件检测报告"
log "#        生成时间: $(date -Is)"
log "#        主机名  : $(hostname)"
log "############################################################"

#=============================== 1. 系统信息 =================================#
sect "1. 系统与固件信息"
log "  OS        : $(. /etc/os-release; echo "$PRETTY_NAME")"
log "  内核      : $(uname -r)"
log "  运行时长  : $(uptime -p 2>/dev/null)"
if have dmidecode; then
  log "  主板      : $(dmidecode -s baseboard-manufacturer 2>/dev/null) $(dmidecode -s baseboard-product-name 2>/dev/null)"
  log "  BIOS      : $(dmidecode -s bios-vendor 2>/dev/null) $(dmidecode -s bios-version 2>/dev/null) ($(dmidecode -s bios-release-date 2>/dev/null))"
  log "  整机型号  : $(dmidecode -s system-product-name 2>/dev/null)"
fi

#=============================== 2. CPU ======================================#
sect "2. CPU"
CPU_MODEL=$(lscpu | awk -F: '/Model name/{gsub(/^ +/,"",$2);print $2;exit}')
CPU_SOCKETS=$(lscpu | awk -F: '/Socket\(s\)/{gsub(/ /,"",$2);print $2}')
CPU_CORES=$(lscpu | awk -F: '/^Core\(s\) per socket/{gsub(/ /,"",$2);print $2}')
CPU_LOGICAL=$(nproc)
log "  型号      : ${CPU_MODEL}"
log "  插槽数    : ${CPU_SOCKETS}   每槽核心: ${CPU_CORES}   逻辑线程: ${CPU_LOGICAL}"
# CPU 温度
if ensure_pkg sensors lm-sensors; then
  CPU_TEMP=$(sensors 2>/dev/null | grep -iE "Tctl|Tdie|Package id 0" | grep -oE "\+[0-9.]+°C" | head -1)
  [ -n "${CPU_TEMP}" ] && log "  当前温度  : ${CPU_TEMP}"
fi
[ "${CPU_LOGICAL}" -gt 0 ] && pass "CPU 识别正常 (${CPU_LOGICAL} 线程)" || fail "CPU 信息读取异常"

#=============================== 3. 内存 =====================================#
sect "3. 内存"
MEM_TOTAL=$(free -h | awk '/^Mem:/{print $2}')
log "  总容量    : ${MEM_TOTAL}"
if have dmidecode; then
  DIMM_CNT=$(dmidecode -t memory 2>/dev/null | grep -c "^\s*Size: [0-9]")
  DIMM_INFO=$(dmidecode -t memory 2>/dev/null | grep -E "Size: [0-9]|Type:|Speed:" | grep -v "No Module" | head -3 | tr '\n' ' ')
  log "  已插条数  : ${DIMM_CNT}"
  log "  规格示例  : ${DIMM_INFO}"
fi
# ECC 错误检查 (EDAC)
ECC_CE=0; ECC_UE=0
if ls /sys/devices/system/edac/mc/mc*/ce_count >/dev/null 2>&1; then
  ECC_CE=$(cat /sys/devices/system/edac/mc/mc*/ce_count 2>/dev/null | awk '{s+=$1}END{print s+0}')
  ECC_UE=$(cat /sys/devices/system/edac/mc/mc*/ue_count 2>/dev/null | awk '{s+=$1}END{print s+0}')
  log "  ECC 可纠正错误(CE): ${ECC_CE}   不可纠正(UE): ${ECC_UE}"
  if [ "${ECC_UE}" -gt 0 ]; then
    fail "内存出现 ${ECC_UE} 个不可纠正 ECC 错误(UE)，疑似内存故障"
  elif [ "${ECC_CE}" -gt 0 ]; then
    warn "内存出现 ${ECC_CE} 个可纠正 ECC 错误(CE)，建议观察"
  else
    pass "内存 ECC 无错误"
  fi
else
  warn "未检测到 EDAC ECC 监控(可能非ECC内存或驱动未加载)"
fi

#=============================== 4. 磁盘 =====================================#
sect "4. 磁盘 / 存储"
log "$(lsblk -d -o NAME,SIZE,MODEL,ROTA,TYPE 2>/dev/null | sed 's/^/  /')"
log "  根分区使用:"
log "$(df -h / | sed 's/^/    /')"
ensure_pkg smartctl smartmontools
if have smartctl; then
  for dev in $(lsblk -dn -o NAME,TYPE | awk '$2=="disk"{print $1}'); do
    HEALTH=$(smartctl -H "/dev/${dev}" 2>/dev/null | grep -iE "overall-health|SMART Health Status" | awk -F: '{gsub(/^ +/,"",$2);print $2}')
    if echo "${HEALTH}" | grep -qiE "PASSED|OK"; then
      pass "磁盘 /dev/${dev} SMART 健康: ${HEALTH}"
    elif [ -n "${HEALTH}" ]; then
      fail "磁盘 /dev/${dev} SMART 异常: ${HEALTH}"
    else
      warn "磁盘 /dev/${dev} 无法读取 SMART(可能为RAID虚拟盘)"
    fi
  done
else
  warn "smartctl 不可用，跳过磁盘 SMART 检测"
fi

#=============================== 5. 网络 =====================================#
sect "5. 网络"
ensure_pkg ethtool ethtool
for nic in $(ip -br link 2>/dev/null | awk '$1!="lo" && $2=="UP"{print $1}'); do
  SPEED=$(ethtool "${nic}" 2>/dev/null | awk -F: '/Speed/{gsub(/^ +/,"",$2);print $2}')
  IPADDR=$(ip -4 -br addr show "${nic}" 2>/dev/null | awk '{print $3}')
  log "  ${nic}  状态:UP  速率:${SPEED:-?}  IP:${IPADDR:-无}"
done
UP_CNT=$(ip -br link 2>/dev/null | awk '$1!="lo" && $2=="UP"' | wc -l)
[ "${UP_CNT}" -gt 0 ] && pass "${UP_CNT} 个网卡 UP" || fail "无 UP 状态网卡"

#=============================== 6. GPU 基础 =================================#
sect "6. GPU 基础信息"
if ! have nvidia-smi; then
  fail "未检测到 nvidia-smi，NVIDIA 驱动未安装，跳过 GPU 检测"
  GPU_COUNT=0
else
  GPU_COUNT=$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | wc -l)
  DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)
  log "  GPU 数量  : ${GPU_COUNT}"
  log "  驱动版本  : ${DRIVER}"
  log "  GPU 列表  :"
  nvidia-smi --query-gpu=index,name,memory.total,pcie.link.gen.current,pcie.link.width.current --format=csv,noheader 2>/dev/null | sed 's/^/    GPU /' | tee -a "$REPORT_TXT"
  [ "${GPU_COUNT}" -gt 0 ] && pass "识别到 ${GPU_COUNT} 张 GPU" || fail "未识别到 GPU"

  # PCIe AER 错误 (链路质量)
  AER_TOTAL=$(dmesg 2>/dev/null | grep -ic "aer")
  if [ "${AER_TOTAL}" -gt 0 ]; then
    AER_TOP=$(dmesg -T 2>/dev/null | grep -i aer | grep -oE "[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-9]" | sort | uniq -c | sort -rn | head -3 | tr '\n' ';')
    warn "检测到 ${AER_TOTAL} 条 PCIe AER 事件，热点设备: ${AER_TOP} (需确认是否上电瞬态)"
  else
    pass "无 PCIe AER 错误"
  fi
fi

#=============================== 7. GPU 压测 =================================#
sect "7. GPU 压力测试 (gpu-burn, 后台运行 ${BURN_SECONDS}s)"
if [ "${GPU_COUNT}" -gt 0 ]; then
  # 准备 gpu-burn
  GB_DIR="$HOME/gpu-burn"
  CUDA_HOME=$(ls -d /usr/local/cuda* 2>/dev/null | sort -V | tail -1)
  export PATH="${CUDA_HOME}/bin:$PATH"
  if [ ! -x "${GB_DIR}/gpu_burn" ]; then
    ensure_pkg gcc gcc; ensure_pkg g++ g++; ensure_pkg make make; ensure_pkg git git
    [ -d "${GB_DIR}" ] || git clone "${GPU_BURN_REPO}" "${GB_DIR}" >/dev/null 2>&1
    # 探测 GPU 计算能力(取第一张)，Blackwell(50系)=120
    CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d '.')
    ( cd "${GB_DIR}" && make ${CC:+COMPUTE=$CC} >/dev/null 2>&1 )
  fi

  if [ ! -x "${GB_DIR}/gpu_burn" ]; then
    fail "gpu-burn 编译失败，无法执行 GPU 压测"
  else
    # 遥测采集器(后台)
    echo "timestamp,gpu_idx,temp_c,pwr_w,util_pct,mem_used_mib,sm_clk_mhz,throttle_hex" > "$TELE_CSV"
    touch "${WORKDIR}/.tele_running"
    (
      while [ -f "${WORKDIR}/.tele_running" ]; do
        nvidia-smi --query-gpu=timestamp,index,temperature.gpu,power.draw,utilization.gpu,memory.used,clocks.sm,clocks_event_reasons.active \
          --format=csv,noheader,nounits >> "$TELE_CSV" 2>/dev/null
        sleep "${TELE_INTERVAL}"
      done
    ) &
    TELE_PID=$!

    log "  压测启动: $(date -Is)，时长 ${BURN_SECONDS}s，单精度满载，后台执行..."
    log "  (脚本将在压测结束后汇总，请耐心等待)"
    # gpu-burn 前台阻塞(本脚本作为整体可后台运行)，单精度拉满功耗
    ( cd "${GB_DIR}" && stdbuf -oL ./gpu_burn "${BURN_SECONDS}" > "$BURN_LOG" 2>&1 )
    BURN_RC=$?

    rm -f "${WORKDIR}/.tele_running"; sleep 2; kill "$TELE_PID" 2>/dev/null

    # ---- 压测结果分析 ----
    log "  压测结束: $(date -Is)"
    # gpu-burn 结果行: "GPU 0: OK" / "FAULTY"
    BURN_RESULT=$(grep -aoE "GPU [0-9]+: (OK|FAULTY)" "$BURN_LOG" | sort -u)
    [ -n "${BURN_RESULT}" ] && log "$(echo "${BURN_RESULT}" | sed 's/^/    /')"
    FAULTY=$(echo "${BURN_RESULT}" | grep -ci "FAULTY")
    if [ "${FAULTY}" -gt 0 ]; then
      fail "GPU 压测发现 ${FAULTY} 张卡计算错误(FAULTY)，疑似硬件故障"
    fi

    # ---- 关键: 掉总线 / Xid 79 检测 (gpu-burn 可能误报掉线卡为OK，须独立核查) ----
    FELL=$(dmesg -T 2>/dev/null | grep -iE "fallen off the bus|Xid.*: 79" | grep -oE "PCI:[0-9a-f:]+|[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}" | sort -u | tr '\n' ' ')
    if [ -n "${FELL}" ]; then
      fail "检测到 GPU 掉总线(Xid 79 / fell off bus): ${FELL} — 该卡压测中失联，属严重硬件故障"
    fi
    # 压测后 GPU 可见数量核对 (掉线卡 nvidia-smi 会读不到)
    GPU_NOW=$(nvidia-smi --query-gpu=index --format=csv,noheader 2>/dev/null | wc -l)
    UNREACH=$(nvidia-smi --query-gpu=index --format=csv,noheader 2>&1 | grep -ciE "Unable|Unknown Error")
    if [ "${GPU_NOW}" -lt "${GPU_COUNT}" ] || [ "${UNREACH}" -gt 0 ]; then
      fail "压测后可见 GPU 数 ${GPU_NOW} < 压测前 ${GPU_COUNT}，有 GPU 失联(需排查PCIe/供电/插槽)"
    elif [ "${FAULTY}" -eq 0 ] && [ "${BURN_RC}" -eq 0 ]; then
      pass "GPU 压测通过 (${GPU_COUNT} 卡全部存活、无计算错误)"
    elif [ "${BURN_RC}" -ne 0 ]; then
      warn "GPU 压测返回码 ${BURN_RC}，请查看 ${BURN_LOG}"
    fi

    # ---- 遥测统计(每卡峰值温度/功耗/最低时钟) ----
    if [ -s "$TELE_CSV" ]; then
      log ""
      log "  各卡遥测峰值统计 (温度峰值/功耗峰值/最低SM时钟/采样数):"
      log "    GPU |  Tmax℃ | Pmax_W | ClkMin_MHz | 采样数"
      # 期望采样数(按时长估算)，用于识别中途掉线的卡
      EXP_SAMPLES=$(( BURN_SECONDS / TELE_INTERVAL ))
      for idx in $(seq 0 $((GPU_COUNT-1))); do
        STATS=$(awk -F, -v g="$idx" 'NR>1{for(i=1;i<=NF;i++)gsub(/^ +| +$/,"",$i)}
          NR>1 && $2==g {
          if($3+0>tmax)tmax=$3+0; if($4+0>pmax)pmax=$4+0;
          if(cmin==""||$7+0<cmin)cmin=$7+0; n++
        } END{printf "%6d | %6.0f | %10d | %6d", tmax,pmax,cmin,n}' "$TELE_CSV")
        TMAX=$(echo "$STATS" | awk '{print $1}')
        NSAMP=$(echo "$STATS" | awk '{print $NF}')
        log "    ${idx}  | ${STATS}"
        # 采样数骤降 => 该卡压测中途失联
        if [ -n "${NSAMP}" ] && [ "${EXP_SAMPLES}" -gt 10 ] && [ "${NSAMP}" -lt "$(( EXP_SAMPLES / 2 ))" ]; then
          fail "GPU ${idx} 遥测仅 ${NSAMP}/${EXP_SAMPLES} 次采样，压测中途失联(掉线/复位)"
        fi
        # 温度阈值判定
        if [ -n "${TMAX}" ] && [ "${TMAX}" -ge "${GPU_TEMP_FAIL}" ]; then
          fail "GPU ${idx} 峰值温度 ${TMAX}℃ ≥ ${GPU_TEMP_FAIL}℃ (散热不良/降频风险)"
        elif [ -n "${TMAX}" ] && [ "${TMAX}" -ge "${GPU_TEMP_WARN}" ]; then
          warn "GPU ${idx} 峰值温度 ${TMAX}℃ ≥ ${GPU_TEMP_WARN}℃ (偏高，关注散热)"
        fi
      done
      # 热降频检测 (throttle 含 HW thermal slowdown 位)
      THROTTLE_HIT=$(awk -F, 'NR>1{gsub(/^ +/,"",$2);gsub(/^ +/,"",$8)} NR>1 && $8 ~ /0x/ {v=strtonum($8); if(and(v,0x60)) print $2}' "$TELE_CSV" 2>/dev/null | sort -u | tr '\n' ' ')
      [ -n "${THROTTLE_HIT}" ] && warn "以下 GPU 压测中触发热降频: ${THROTTLE_HIT}"
    fi
  fi
else
  log "  跳过(无可用 GPU)"
fi

#=============================== 8. 内核错误日志 =============================#
sect "8. 内核严重日志 (err/crit)"
KERR=$(dmesg -T --level=err,crit,alert,emerg 2>/dev/null | grep -vi "aer" | tail -10)
if [ -n "${KERR}" ]; then
  log "$(echo "${KERR}" | sed 's/^/  /')"
  warn "存在内核 err/crit 级日志，请人工复核(见上)"
else
  pass "无内核严重错误日志"
fi
# XID (GPU 错误)
if have nvidia-smi; then
  XID=$(dmesg -T 2>/dev/null | grep -iE "NVRM.*Xid" | tail -5)
  if [ -n "${XID}" ]; then
    fail "检测到 NVIDIA Xid 错误(GPU硬件/驱动异常):"
    log "$(echo "${XID}" | sed 's/^/    /')"
  else
    pass "无 NVIDIA Xid 错误"
  fi
fi

#=============================== 9. 汇总 =====================================#
sect "9. 检测结论汇总"
log "  通过项(PASS): ${PASS_COUNT}"
log "  告警项(WARN): ${#WARN_ITEMS[@]}"
log "  失败项(FAIL): ${#FAIL_ITEMS[@]}"
hr
if [ "${#FAIL_ITEMS[@]}" -gt 0 ]; then
  log "  失败明细:"
  for i in "${FAIL_ITEMS[@]}"; do log "    ✗ $i"; done
fi
if [ "${#WARN_ITEMS[@]}" -gt 0 ]; then
  log "  告警明细:"
  for i in "${WARN_ITEMS[@]}"; do log "    ! $i"; done
fi
hr
if [ "${#FAIL_ITEMS[@]}" -gt 0 ]; then
  VERDICT="不通过 (FAIL)"; RC=2
elif [ "${#WARN_ITEMS[@]}" -gt 0 ]; then
  VERDICT="有条件通过 (WARN，需复核)"; RC=1
else
  VERDICT="通过 (PASS)"; RC=0
fi
log "  >>> 上架结论: ${VERDICT} <<<"
log ""
log "  完整产物目录: ${WORKDIR}"
log "    - 文本报告 : ${REPORT_TXT}"
log "    - GPU压测日志: ${BURN_LOG}"
log "    - 遥测数据 : ${TELE_CSV}"

#----------------------- 生成 Markdown 版报告 --------------------------------#
{
  echo "# 硬件上架检测报告"
  echo ""
  echo "- 主机: \`$(hostname)\`"
  echo "- 时间: $(date -Is)"
  echo "- 结论: **${VERDICT}**"
  echo "- 统计: PASS=${PASS_COUNT} / WARN=${#WARN_ITEMS[@]} / FAIL=${#FAIL_ITEMS[@]}"
  echo ""
  echo "详见同目录文本报告: \`$(basename "$REPORT_TXT")\`"
} > "$REPORT_MD"

echo ""
echo "检测完成，结论: ${VERDICT}"
echo "报告: ${REPORT_TXT}"
exit ${RC}
```

压测30分钟(默认)，后台运行，SSH断开也不停

nohup ./hardware_check.sh > hwcheck.out 2>&1 &

压测1小时

nohup ./hardware_check.sh 3600 > hwcheck.out 2>&1 &

报告只在跑完后生成,所以判断完成 = 看产物目录里有没有 REPORT_\*.txt:

看进程还在不在

pgrep -f hardware_check.sh

跑完后报告就在这个目录里

ls -t hwcheck_*/REPORT_*.txt | head -1