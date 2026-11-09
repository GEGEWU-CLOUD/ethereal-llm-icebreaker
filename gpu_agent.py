#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GPU 服务器压测编排与产物解析模块
- parse_gpu_artifacts(): 纯函数,解析 gpu_check.sh 三件产物 → 结构化 JSON (SSH/手动两种模式共用)
- GpuJobPool: 多台服务器并发 SSH 编排 (paramiko 可选依赖,未安装时优雅降级)
"""

import io
import os
import re
import csv
import time
import shlex
import threading
import datetime
import secrets

# ================================ 产物解析器 ================================

_TS_PATTERNS = ["%Y/%m/%d %H:%M:%S.%f", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"]


def _try_float(v):
    try:
        return float(str(v).strip())
    except Exception:
        return None


def _parse_ts(s):
    s = (s or "").strip()
    # 兼容 ISO "T" 分隔 (date -Is 输出)
    if "T" in s[:12]:
        s = s.replace("T", " ", 1)
    for p in _TS_PATTERNS:
        try:
            return datetime.datetime.strptime(s, p)
        except Exception:
            pass
    return None


_BEIJING_TZ = datetime.timezone(datetime.timedelta(hours=8))

def _apply_offset(dt, offset_raw):
    """给 naive datetime 加上 date -Is 的时区偏移 (如 +00:00 / +08:00)"""
    if dt is None or not offset_raw:
        return None
    try:
        sign = 1 if offset_raw[0] == '+' else -1
        digits = offset_raw[1:].replace(':', '')
        hh = int(digits[:2]); mm = int(digits[2:4] or 0)
        return dt.replace(tzinfo=datetime.timezone(sign * datetime.timedelta(hours=hh, minutes=mm)))
    except Exception:
        return None

def _to_beijing(ts_raw, offset_raw):
    """date -Is 输出 (服务器本地时间+偏移) → 北京时间字符串; 无偏移时原样返回"""
    if not ts_raw:
        return None
    aware = _apply_offset(_parse_ts(ts_raw), offset_raw)
    if aware is None:
        return ts_raw
    return aware.astimezone(_BEIJING_TZ).strftime('%Y-%m-%d %H:%M:%S')

def _thin(series, max_points=200):
    n = len(series)
    if n <= max_points:
        return series
    stride = -(-n // max_points)
    out = series[::stride]
    if out and out[-1] != series[-1]:
        out.append(series[-1])
    return out


def parse_telemetry(csv_text):
    """gpu_telemetry.csv → {gpuIdx: {stats, series}}"""
    result = {}
    rows = []
    try:
        reader = csv.reader(io.StringIO(csv_text or ""))
        header = next(reader, None)
        for row in reader:
            if not row or len(row) < 8:
                continue
            rows.append([c.strip() for c in row])
    except Exception:
        return result

    base_ts = None
    for r in rows:
        t = _parse_ts(r[0])
        if t:
            base_ts = t
            break

    grouped = {}
    for i, r in enumerate(rows):
        idx = r[1]
        temp, pwr, util, mem, clk = (_try_float(r[2]), _try_float(r[3]), _try_float(r[4]),
                                     _try_float(r[5]), _try_float(r[6]))
        thr_raw = r[7] or "0x0"
        try:
            thr = int(thr_raw, 16) if thr_raw.lower().startswith("0x") else int(float(thr_raw))
        except Exception:
            thr = 0
        t = _parse_ts(r[0])
        tsec = (t - base_ts).total_seconds() if (t and base_ts) else i * 15
        g = grouped.setdefault(idx, {
            "temps": [], "pwrs": [], "utils": [], "clks": [], "thrs": [],
            "series": [], "mems": []
        })
        g["temps"].append(temp); g["pwrs"].append(pwr); g["utils"].append(util)
        g["clks"].append(clk); g["thrs"].append(thr); g["mems"].append(mem)
        g["series"].append({"t": round(tsec, 1), "temp": temp, "pwr": pwr,
                            "util": util, "clk": clk, "thr": thr})

    for idx, g in grouped.items():
        temps = [x for x in g["temps"] if x is not None]
        pwrs = [x for x in g["pwrs"] if x is not None]
        clks = [x for x in g["clks"] if x is not None]
        thrs = g["thrs"]
        n = len(g["series"])
        result[idx] = {
            "sampleCount": n,
            "tmax": max(temps) if temps else None,
            "pmax": max(pwrs) if pwrs else None,
            "clkMin": min(clks) if clks else None,
            "clkAvg": round(sum(clks) / len(clks), 1) if clks else None,
            # 0x60 = SwThermalSlowdown|HwThermalSlowdown; 0x4 = SwPowerCap (功耗墙)
            "throttleThermal": sum(1 for v in thrs if v & 0x60),
            "throttlePower": sum(1 for v in thrs if v & 0x4),
            "memMaxMiB": max((x for x in g["mems"] if x is not None), default=None),
            "series": _thin(g["series"])
        }
    return result


def parse_burn_log(log_text):
    """gpu_burn.log → {gpuIdx: {verdict, errors, gflopsAvg, bus}}"""
    result = {}
    text = log_text or ""
    gflops = {}
    for m in re.finditer(r"GPU\s*(\d+)\s*\(([^)]*)\)\s*[:：]\s*([\d.]+)\s*GFLOPS", text, re.I):
        idx, bus, val = m.group(1), m.group(2).strip(), _try_float(m.group(3))
        if val is not None:
            d = gflops.setdefault(idx, {"vals": [], "bus": bus or None})
            d["vals"].append(val)
            if bus and not d["bus"]:
                d["bus"] = bus
    for m in re.finditer(r"GPU\s*(\d+)\s*\(([^)]*)\)\s*[:：]\s*(OK|FAULTY)\s*(.*)", text, re.I):
        idx = m.group(1)
        rest = m.group(4) or ""
        em = re.search(r"(\d+)\s*errors?", rest, re.I)
        result.setdefault(idx, {})
        result[idx].update({"verdict": m.group(3).upper(), "errors": int(em.group(1)) if em else 0,
                            "bus": m.group(2).strip() or None})
    # 兜底: REPORT 里的 "GPU 0: OK" 行
    return result, gflops


def parse_report_txt(txt):
    """REPORT_*.txt → 基础事实 + PASS/WARN/FAIL 条目"""
    info = {"passItems": [], "warnItems": [], "failItems": [], "smart": [], "gpus": []}
    lines = (txt or "").splitlines()
    cur_sect = ""
    for ln in lines:
        m = re.match(r"^=== (.+) ===\s*$", ln.strip())
        if m:
            cur_sect = m.group(1)
            continue
        s = ln.strip()
        pm = re.match(r"^\[(PASS|WARN|FAIL)\]\s*(.+)$", s)
        if pm:
            key = {"PASS": "passItems", "WARN": "warnItems", "FAIL": "failItems"}[pm.group(1)]
            info[key].append(pm.group(2).strip())
            continue
        # ECC 行 (键在冒号左侧被 kv 切分, 整行匹配)
        em = re.search(r"可纠正错误\(CE\)\s*[:：]?\s*(\d+)\s+不可纠正\(UE\)\s*[:：]?\s*(\d+)", s)
        if em:
            info["eccCE"] = int(em.group(1)); info["eccUE"] = int(em.group(2))
        # 键值行 "  KEY : value"
        kv = re.match(r"^([A-Za-z\u4e00-\u9fa5][\w \u4e00-\u9fa5（）()/-]*?)\s*[:：]\s*(.+)$", s)
        if kv:
            k, v = kv.group(1).strip(), kv.group(2).strip()
            if cur_sect.startswith("1."):
                if k.startswith("OS"): info["os"] = v
                elif k.startswith("内核"): info["kernel"] = v
                elif k.startswith("整机型号"): info["systemProduct"] = v
                elif k.startswith("主板"): info["baseboard"] = v
            elif cur_sect.startswith("2."):
                if k.startswith("型号"): info["cpuModel"] = v
                elif k.startswith("插槽数"): info["cpuSockets"] = v
                elif k.startswith("逻辑线程"): info["cpuThreads"] = v
            elif cur_sect.startswith("3."):
                if k.startswith("总容量"): info["memTotal"] = v
                elif k.startswith("ECC"):
                    mm = re.search(r"CE\)?[:：]?\s*(\d+)\s+.*UE\)?[:：]?\s*(\d+)", v)
                    if mm:
                        info["eccCE"] = int(mm.group(1)); info["eccUE"] = int(mm.group(2))
            elif cur_sect.startswith("6."):
                if k.startswith("GPU 数量"): info["gpuCount"] = int(_try_float(v) or 0)
                elif k.startswith("驱动版本"): info["driver"] = v
                elif k.startswith("主机名"): info["hostname"] = v
        # GPU 列表行: "GPU 0, NVIDIA GeForce RTX 4090, 24564 MiB, 4, 16"
        gm = re.match(r"^GPU\s*(\d+),\s*(.+?),\s*([\d]+)\s*MiB", s)
        if gm and cur_sect.startswith("6."):
            info["gpus"].append({"index": int(gm.group(1)), "name": gm.group(2).strip(),
                                 "memMiB": int(gm.group(3))})
        if s.startswith("GPU ") and cur_sect.startswith("7."):
            bm = re.match(r"^GPU\s*(\d+)[:：]\s*(OK|FAULTY)", s, re.I)
            if bm:
                info.setdefault("burnVerdicts", {})[bm.group(1)] = bm.group(2).upper()
        if "压测启动" in s:
            mm = re.search(r"(\d{4}[-/]\d{2}[-/]\d{2}[T ][\d:.]+)([+-]\d{2}:?\d{2})?", s)
            if mm: info["burnStart"] = mm.group(1); info["burnStartTz"] = mm.group(2)
        if "压测结束" in s:
            mm = re.search(r"(\d{4}[-/]\d{2}[-/]\d{2}[T ][\d:.]+)([+-]\d{2}:?\d{2})?", s)
            if mm: info["burnEnd"] = mm.group(1); info["burnEndTz"] = mm.group(2)
        if "上架结论" in s:
            info["scriptVerdict"] = s.split("上架结论")[-1].strip(" :>：<")
        am = re.search(r"检测到\s*(\d+)\s*条 PCIe AER", s)
        if am:
            info["aerCount"] = int(am.group(1))
        # 遥测统计表行: "0  |  70 |   450 | 2175 |  42"
        tm = re.match(r"^(\d+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*(\d+)\s*$", s)
        if tm and cur_sect.startswith("7."):
            info.setdefault("teleSummary", {})[tm.group(1)] = {
                "tmax": float(tm.group(2)), "pmax": float(tm.group(3)),
                "clkMin": float(tm.group(4)), "samples": int(tm.group(5))}
        am = re.search(r"检测到\s*(\d+)\s*条 PCIe AER", s)
        if am:
            info["aerCount"] = int(am.group(1))

    # SMART 结果从判定条目中提取 (脚本以 [PASS]/[FAIL]/[WARN] 行输出)
    for it in info["passItems"] + info["failItems"] + info["warnItems"]:
        sm = re.match(r"^磁盘\s+(\S+)\s+SMART\s+(健康|异常)[:：]?\s*(.*)$", it)
        if sm:
            info["smart"].append({"dev": sm.group(1), "status": sm.group(2),
                                  "detail": sm.group(3).strip()})
        elif "SMART" in it and "无法" in it:
            info["smart"].append({"dev": "-", "status": "无法读取", "detail": it})
    return info


# ------------------------------ 自动甄别规则 ------------------------------

_KNOWN_NOISE_KERNEL = re.compile(r"SGX disabled by BIOS|nouveau.*unknown chipset|unknown chipset.*nouveau", re.I)
_AER_FALSE = re.compile(r"_OSC|does not support|ACPI", re.I)


def adjudicate(warn_items, fail_items, kernel_lines=None, aer_lines=None, telemetry=None):
    """把脚本的 WARN/FAIL 逐条分类: real(真实观察) / false(误报) / env(环境限制) / fail(失败)"""
    results = []
    for it in fail_items:
        results.append({"level": "FAIL", "text": it, "cls": "fail",
                        "note": "脚本判定失败项,需排查处理"})
    for it in warn_items:
        low = it.lower()
        if "aer" in low:
            if aer_lines is not None:
                if aer_lines and all(_AER_FALSE.search(x) for x in aer_lines):
                    cls, note = "false", "复核 dmesg 原文:均为 ACPI _OSC 能力协商消息,仅因包含 \"AER\" 子串被 grep 命中,并非真实 AER 错误事件"
                elif not aer_lines:
                    cls, note = "env", "未采集到 dmesg AER 样本,无法自动甄别,请人工复核"
                else:
                    cls, note = "real", "dmesg 中存在非 _OSC 协商类 AER 消息,疑似真实链路错误事件,需人工复核"
            else:
                cls, note = "env", "未采集 dmesg 样本(手动模式可附上),请人工复核"
        elif "内核" in it and ("err" in low or "crit" in low):
            if kernel_lines is not None:
                if kernel_lines and all(_KNOWN_NOISE_KERNEL.search(x) for x in kernel_lines):
                    cls, note = "false", "复核日志原文:均为已知无害输出(SGX disabled by BIOS / nouveau unknown chipset 开源驱动探测),与压测无关"
                elif not kernel_lines:
                    cls, note = "env", "未采集到内核日志样本,请人工复核"
                else:
                    cls, note = "real", "存在非已知噪声的内核 err/crit 日志,需人工复核"
            else:
                cls, note = "env", "未采集内核日志样本,请人工复核"
        elif "热降频" in it:
            cls, note = "real", "压测中触发软件/硬件热降频,存在性能损失,建议关注该卡散热条件"
        elif "峰值温度" in it:
            cls, note = "real", "峰值温度达到告警阈值,散热偏弱,建议复验并检查风扇/散热器贴合"
        elif "smart" in low and ("无法" in it or "raid" in low):
            cls, note = "env", "SMART 无法读取多为 RAID 虚拟盘/权限限制,不影响压测结论"
        elif "edac" in low or "ecc 监控" in low:
            cls, note = "env", "未检测到 EDAC(可能非 ECC 内存或驱动未加载),跳过 ECC 判定"
        elif "返回码" in it:
            cls, note = "env", "gpu-burn 返回码非零,请查看 gpu_burn.log 人工复核"
        else:
            cls, note = "env", "自动规则未覆盖,请人工复核"
        results.append({"level": "WARN", "text": it, "cls": cls, "note": note})
    return results


def parse_gpu_artifacts(report_txt, telemetry_csv, burn_log, enrich=None):
    """总入口:三件产物(+可选 enrich) → 报告用的结构化 JSON"""
    enrich = enrich or {}
    rep = parse_report_txt(report_txt)
    tele = parse_telemetry(telemetry_csv)
    burn_verdicts, burn_gflops = parse_burn_log(burn_log)
    if not burn_verdicts and rep.get("burnVerdicts"):
        burn_verdicts = {k: {"verdict": v, "errors": 0, "bus": None}
                         for k, v in rep["burnVerdicts"].items()}

    # GPU 维表: REPORT 列表 + enrich(nvidia-smi bus/name/driver) + burn log bus (键统一为 str)
    gpus = {}
    for g in rep.get("gpus", []):
        gpus[str(g["index"])] = dict(g)
    for row in enrich.get("gpuQuery", []):
        # ["0", "NVIDIA GeForce RTX 4090", "00000000:67:00.0", "550.54.15"]
        idx = str(row[0]).strip()
        d = gpus.setdefault(idx, {"index": int(_try_float(idx) or 0)})
        d["name"] = d.get("name") or (row[1].strip() if len(row) > 1 else "")
        d["bus"] = (row[2].strip() if len(row) > 2 else "") or d.get("bus")
        d["driver"] = (row[3].strip() if len(row) > 3 else "") or d.get("driver") or rep.get("driver")
    for idx, d in burn_gflops.items():
        g = gpus.setdefault(idx, {"index": int(_try_float(idx) or 0)})
        if d.get("bus") and not g.get("bus"):
            g["bus"] = d["bus"]
    for idx in set(gpus.keys()) | set(tele.keys()) | set(burn_verdicts.keys()):
        g = gpus.setdefault(str(idx), {"index": int(_try_float(idx) or 0)})
        bv = burn_verdicts.get(str(idx), {}) or {}
        t = tele.get(str(idx), {}) or {}
        gf = burn_gflops.get(str(idx), {}) or {}
        ts = rep.get("teleSummary", {}).get(str(idx), {}) or {}
        g["burnVerdict"] = bv.get("verdict") or rep.get("burnVerdicts", {}).get(str(idx))
        g["burnErrors"] = bv.get("errors", 0)
        vals = gf.get("vals", [])
        g["gflopsAvg"] = round(sum(vals) / len(vals), 0) if vals else None
        g["tmax"] = t.get("tmax", ts.get("tmax"))
        g["pmax"] = t.get("pmax", ts.get("pmax"))
        g["clkMin"] = t.get("clkMin", ts.get("clkMin"))
        g["clkAvg"] = t.get("clkAvg")
        g["throttleThermal"] = t.get("throttleThermal", 0)
        g["throttlePower"] = t.get("throttlePower", 0)
        g["sampleCount"] = t.get("sampleCount", ts.get("samples", 0))
        g["series"] = t.get("series", [])

    gpu_list = sorted(gpus.values(), key=lambda g: g["index"])

    # 内核 err/crit 样本 (优先 enrich; 否则从 REPORT 第8节提取原始日志行)
    kernel_lines = enrich.get("kernelErrLines")
    if kernel_lines is None:
        kernel_lines = _extract_section_lines(report_txt, "8.", exclude_marks=("[PASS]", "[WARN]", "[FAIL]", "===", "压测启动", "压测结束"))
        kernel_lines = [x for x in kernel_lines if x.strip()][:10]
    # AER 原文样本仅来自 enrich (SSH 采集或手动附上); REPORT 内无 dmesg 原文, 缺省走"待人工复核"
    aer_lines = enrich.get("dmesgAer")
    if aer_lines is None:
        aer_lines = None

    adj = adjudicate(rep.get("warnItems", []), rep.get("failItems", []),
                     kernel_lines=kernel_lines, aer_lines=aer_lines, telemetry=tele)
    real_obs = [a for a in adj if a["cls"] == "real"]
    fails = [a for a in adj if a["cls"] == "fail"]

    if fails:
        verdict, verdictCls = "不通过 (FAIL)", "fail"
    elif real_obs:
        verdict, verdictCls = "通过(附 {} 项观察)".format(len(real_obs)), "warn"
    else:
        verdict, verdictCls = "通过", "pass"

    # 聚合指标
    all_tmax = [g["tmax"] for g in gpu_list if g.get("tmax") is not None]
    all_pmax = [g["pmax"] for g in gpu_list if g.get("pmax") is not None]
    all_gf = [g["gflopsAvg"] for g in gpu_list if g.get("gflopsAvg")]
    ok_cnt = sum(1 for g in gpu_list if g.get("burnVerdict") == "OK")
    faulty_cnt = sum(1 for g in gpu_list if g.get("burnVerdict") == "FAULTY")

    # 压测窗口时长
    duration = None
    t1 = _apply_offset(_parse_ts(rep.get("burnStart") or ""), rep.get("burnStartTz"))
    t2 = _apply_offset(_parse_ts(rep.get("burnEnd") or ""), rep.get("burnEndTz"))
    if t1 and t2:
        duration = int((t2 - t1).total_seconds())

    # 建议 (规则生成)
    recs = []
    throttle_gpus = [g["index"] for g in gpu_list if (g.get("throttleThermal") or 0) > 0]
    hot_gpus = [g["index"] for g in gpu_list if (g.get("tmax") or 0) >= 85]
    if fails:
        recs.append({"prio": "高", "text": "存在 FAIL 项: " + "; ".join(f["text"] for f in fails) + " — 按 FAIL 明细逐项排查后再行上架"})
    if hot_gpus or throttle_gpus:
        recs.append({"prio": "中", "text": "GPU{} 散热偏弱(峰值温度≥85℃或触发热降频):择机执行更长时长标准压测复验;若 Tmax ≥ 85℃ 建议检查风扇转速与散热器贴合,必要时与其他槽位对调验证".format(",".join(sorted(set([str(i) for i in hot_gpus + throttle_gpus]))))})
    if len(all_gf) >= 2 and max(all_gf) > 0 and (max(all_gf) - min(all_gf)) / max(all_gf) > 0.05:
        recs.append({"prio": "低", "text": "各卡平均算力差异约 {:.1f}%,业务侧评估是否将低算力卡纳入调度权重考虑".format((max(all_gf) - min(all_gf)) / max(all_gf) * 100)})
    recs.append({"prio": "中", "text": "上架后将温度/降频/Xid 纳入例行监控,以本次数据为基线"})

    return {
        "meta": {
            "hostname": enrich.get("hostname") or rep.get("hostname"),
            "ip": enrich.get("ip"),
            "hostIps": enrich.get("hostIps") or [],
            "sshHost": enrich.get("sshHost"),
            "sshPort": enrich.get("sshPort"),
            "systemProduct": rep.get("systemProduct"),
            "cpuModel": rep.get("cpuModel"),
            "cpuThreads": rep.get("cpuThreads"),
            "memTotal": rep.get("memTotal"),
            "os": rep.get("os"),
            "driver": enrich.get("driver") or rep.get("driver"),
            "gpuCount": len(gpu_list) or rep.get("gpuCount", 0),
            "burnStart": _to_beijing(rep.get("burnStart"), rep.get("burnStartTz")),
            "burnEnd": _to_beijing(rep.get("burnEnd"), rep.get("burnEndTz")),
            "durationSec": duration,
            "source": enrich.get("source", "manual"),
            "remoteDir": enrich.get("remoteDir"),
            "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        },
        "burn": {
            "okCount": ok_cnt,
            "faultyCount": faulty_cnt,
            "totalGpus": len(gpu_list),
            "eccCE": rep.get("eccCE"),
            "eccUE": rep.get("eccUE"),
            "smart": rep.get("smart", []),
            "aerCount": rep.get("aerCount"),
            "xid": not any("Xid" in w for w in rep.get("failItems", [])) and "无 NVIDIA Xid 错误" in "\n".join(rep.get("passItems", [])),
        },
        "summary": {
            "tmaxAll": max(all_tmax) if all_tmax else None,
            "tmaxGpu": (max(gpu_list, key=lambda g: g.get("tmax") or 0)["index"] if all_tmax else None),
            "pmaxAll": max(all_pmax) if all_pmax else None,
            "gflopsMax": max(all_gf) if all_gf else None,
            "gflopsMin": min(all_gf) if all_gf else None,
            "passCount": len(rep.get("passItems", [])),
            "warnCount": len(rep.get("warnItems", [])),
            "failCount": len(rep.get("failItems", [])),
            "scriptVerdict": rep.get("scriptVerdict"),
        },
        "gpus": gpu_list,
        "adjudications": adj,
        "recommendations": recs,
        "verdict": verdict,
        "verdictCls": verdictCls,
        "kernelErrLines": kernel_lines,
        "aerLines": aer_lines,
        "raw": {"reportHead": "\n".join((report_txt or "").splitlines()[:12])}
    }


def _extract_section_lines(txt, sect_prefix, exclude_marks=()):
    """提取 REPORT 某 section 的正文行(排除小标题与结论行)"""
    out, inside = [], False
    for ln in (txt or "").splitlines():
        m = re.match(r"^=== (.+) ===\s*$", ln.strip())
        if m:
            if m.group(1).startswith(sect_prefix):
                inside = True
                continue
            if inside:
                break
            continue
        if inside:
            s = ln.rstrip()
            if not s.strip():
                continue
            if any(mk in s for mk in exclude_marks):
                continue
            out.append(s.strip())
    return out


# ================================ SSH 编排 (多任务池) ================================

def _try_import_paramiko():
    import paramiko
    return paramiko


class GpuJob:
    """单台服务器的 GPU 压测任务 (独立 SSH 会话 + 状态机)"""

    def __init__(self, job_id, script_path, tarball_path, cfg):
        self.id = job_id
        self.script_path = script_path
        self.tarball_path = tarball_path
        self.cfg = dict(cfg)          # host/port/username/password/keyPath/burnSeconds
        self.use_sudo = bool(cfg.get("useSudo"))        # 显式 sudo 提权开关 (界面控制)
        self._lock = threading.RLock()
        self._ssh = None
        self._sftp = None
        self._cfg_pw = self.cfg.get("password") or ""   # 仅内存
        _port = int(cfg.get("port") or 22)
        _host_label = "{}:{}".format(cfg.get("host"), _port) if _port != 22 else cfg.get("host")
        self.state = {
            "phase": "connecting",     # connecting|uploading|running|collecting|done|error|stopped
            "host": _host_label, "username": cfg.get("username"),
            "burnSeconds": int(cfg.get("burnSeconds", 1800)),
            "remoteDir": None, "startedAt": time.time(), "endedAt": None,
            "error": None, "result": None, "live": [], "progress": 0, "stage": "connecting",
        }

    # ---------- 基础 ----------

    def snapshot(self, with_result=False):
        with self._lock:
            st = dict(self.state)
            if not with_result:
                st.pop("result", None)   # 轮询不携带大结果体
            st["id"] = self.id
            st["elapsed"] = int(time.time() - st["startedAt"]) if st.get("startedAt") else 0
            st["hasResult"] = bool(self.state.get("result"))
            if st.get("phase") == "running" and not st.get("stage"):
                st["stage"] = "preparing"
            return st

    def _set(self, **kw):
        with self._lock:
            self.state.update(kw)

    def _exec(self, cmd, timeout=12):
        """远端命令执行 (带硬超时: recv_exit_status 可能无限阻塞, 必须强制限时)"""
        with self._lock:
            if not self._ssh:
                raise RuntimeError("SSH 会话不存在")
            stdin, stdout, stderr = self._ssh.exec_command(cmd, timeout=timeout)
            chan = stdout.channel
            if not chan.status_event.wait(timeout + 3):
                try:
                    chan.close()
                except Exception:
                    pass
                raise TimeoutError("远端命令超时({}s): {}".format(timeout, cmd[:60]))
            rc = chan.exit_status
            return rc, stdout.read().decode("utf-8", "replace"), stderr.read().decode("utf-8", "replace")

    def _sudo_prefix(self):
        """sudo 提权前缀: 开关关→直连; 开+密码→sudo -S; 开+无密码→免密 sudo(NOPASSWD)"""
        if not self.use_sudo:
            return ""
        pw = self._cfg_pw or ""
        if not pw:
            return "sudo "
        return "printf '%s\\n' {} | sudo -S -p '' ".format(shlex.quote(pw))
    # ---------- 文件传输 (SFTP 优先, sshd 禁用 sftp 子系统时自动降级 exec+base64) ----------

    def _upload_file(self, local_path, remote_path, mode=None):
        """上传本地文件到远端; 返回 True/False 表示是否走的 sftp"""
        try:
            sftp = self._sftp or (self._ssh.open_sftp() if self._ssh else None)
        except Exception:
            sftp = None
        if sftp is not None:
            try:
                sftp.put(local_path, remote_path)
                if mode is not None:
                    sftp.chmod(remote_path, mode)
                with self._lock:
                    self._sftp = sftp
                return True
            except Exception:
                pass   # sftp 失败 (如子系统被禁用), 走降级路径
        # 降级: exec + base64 分块写入
        import base64 as _b64
        data = _b64.b64encode(open(local_path, "rb").read()).decode("ascii")
        size = os.path.getsize(local_path)
        rq = shlex.quote(remote_path)
        self._exec("rm -f {r}".format(r=rq))
        CH = 48000
        chunks = [data[i:i + CH] for i in range(0, len(data), CH)] or [""]
        for i, chunk in enumerate(chunks):
            op = ">" if i == 0 else ">>"
            self._exec("printf '%s' '{c}' | base64 -d {op} {r}".format(c=chunk, op=op, r=rq), timeout=60)
        if mode is not None:
            self._exec("chmod {m:o} {r}".format(m=mode, r=rq))
        _, out, _ = self._exec("stat -c %s {r} 2>/dev/null || wc -c < {r}".format(r=rq))
        if out.strip() != str(size):
            raise RuntimeError("exec 降级上传校验失败: {r} (期望 {n} 字节, 实得 {g})".format(
                r=remote_path, n=size, g=out.strip() or "?"))
        return False

    def _download_file(self, remote_path):
        """读取远端文本文件; sftp 优先, 失败降级 exec+base64"""
        sftp = self._sftp
        if sftp is not None:
            try:
                with sftp.open(remote_path, "r") as f:
                    return f.read().decode("utf-8", "replace")
            except Exception:
                pass
        rc, out, _ = self._exec("base64 -w0 {r} 2>/dev/null".format(r=shlex.quote(remote_path)), timeout=120)
        import base64 as _b64
        return _b64.b64decode(out.strip() or "").decode("utf-8", "replace")

    # ---------- 生命周期 ----------

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            paramiko = _try_import_paramiko()
        except ImportError:
            self._set(phase="error", error="后端未安装 paramiko (pip install paramiko),无法 SSH 自动执行;可使用手动上传产物模式")
            return
        self._paramiko = paramiko
        last_err = None
        for attempt in (1, 2):
            try:
                self._run_once()
                return
            except paramiko.AuthenticationException:
                self._set(phase="error", error="SSH 认证失败: 用户名/密码/密钥不匹配")
                self._close()
                return
            except Exception as e:
                last_err = e
                if attempt == 1:
                    # 瞬时故障自愈: NAT 限流/链路抖动 (如 Channel closed / Connection reset) 等 3s 重试一次
                    with self._lock:
                        self.state["lastPollError"] = "启动瞬时失败({}), 3 秒后自动重试…".format(str(e))[:120]
                    self._set(phase="connecting")
                    self._close()
                    time.sleep(3)
                    continue
        self._set(phase="error", error="SSH 连接/启动失败(已自动重试 1 次): {}".format(last_err))
        self._close()

    def _run_once(self):
        paramiko = self._paramiko   # 由 _run 注入
        self._cfg_pw = self.cfg.get("password") or ""   # 重试时恢复凭据 (_close 会清)
        cfg = self.cfg
        cfg = self.cfg
        try:
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            kwargs = {"hostname": cfg["host"], "port": int(cfg.get("port", 22)),
                      "username": cfg.get("username"), "timeout": 15,
                      "allow_agent": False, "look_for_keys": False}
            if cfg.get("keyPath"):
                kwargs["key_filename"] = cfg["keyPath"]
            else:
                kwargs["password"] = cfg.get("password")
            ssh.connect(**kwargs)
            with self._lock:
                self._ssh = ssh

            self._set(phase="uploading")
            remote_dir = "/tmp/gpubench_{}_{}".format(
                datetime.datetime.now().strftime("%Y%m%d_%H%M%S"), self.id[-6:])
            self._exec("mkdir -p {}".format(shlex.quote(remote_dir)))
            # 上传: sftp 优先, sshd 禁用 sftp 子系统 (open_sftp 即 Channel closed) 时自动降级 exec+base64
            via_sftp = self._upload_file(self.script_path, remote_dir + "/gpu_check.sh", mode=0o755)
            if self.tarball_path:
                self._upload_file(self.tarball_path, remote_dir + "/gpu-burn.tar.gz")
            self._set(remoteDir=remote_dir,
                      lastNote=("传输方式: sftp" if via_sftp else "传输方式: exec+base64 (该机 sshd 未启用 sftp)"))

            sudo = self._sudo_prefix()
            launch = ("cd {d} && {sudo}bash -c 'nohup bash {d}/gpu_check.sh {sec} > {d}/hwcheck.out 2>&1 &'"
                      ).format(d=shlex.quote(remote_dir), sudo=sudo, sec=int(cfg.get("burnSeconds", 1800)))
            rc, out, err = self._exec(launch, timeout=20)
            time.sleep(2)
            rc2, out2, _ = self._exec("pgrep -fc 'gpu_check[.]sh' || true")
            if rc2 == 0 and out2.strip() in ("", "0"):
                self._set(phase="error", error="远端压测进程启动失败: " + (err.strip() or out.strip() or "未知原因")[:200])
                self._close()
                return
            self._set(phase="running", stage="preparing")
            self._start_refresher()
        except Exception:
            raise   # 交由 _run 重试壳统一处理

    def status(self):
        """HTTP 轮询入口: 只读内存快照, 立即返回 (远端刷新由后台 refresher 线程负责, 请求线程永不阻塞)"""
        return self.snapshot()

    def _start_refresher(self):
        """启动后台状态刷新线程 (每个任务一个, 5s 一轮; 终态自动退出)"""
        def loop():
            fail_streak = 0
            while True:
                with self._lock:
                    phase = self.state.get("phase")
                if phase not in ("running", "collecting"):
                    return
                try:
                    self._refresh_once()
                    fail_streak = 0
                except Exception as e:
                    fail_streak += 1
                    with self._lock:
                        self.state["lastPollError"] = str(e)[:200]
                    if fail_streak >= 10:
                        self._set(phase="error",
                                  error="远端状态轮询连续失败(可能 SSH 中断): " + str(e)[:150])
                        self._close()
                        return
                time.sleep(5)
        threading.Thread(target=loop, daemon=True).start()

    def _refresh_once(self):
        """单轮远端状态刷新 (仅由 refresher 线程调用)"""
        if True:
            _, pg, _ = self._exec("pgrep -f 'gpu_check[.]sh' >/dev/null && echo RUN || echo EXIT")
            running = pg.strip().endswith("RUN")
            remote_dir = self.state.get("remoteDir") or ""
            _, ls_out, _ = self._exec(
                "ls -t {d}/hwcheck_*/REPORT_*.txt 2>/dev/null | head -1".format(d=remote_dir))
            report_path = ls_out.strip().splitlines()[0] if ls_out.strip() else None

            live = []
            if report_path:
                hw_dir = os.path.dirname(report_path)
                _, tl, _ = self._exec(
                    "tail -n 60 {h}/gpu_telemetry.csv 2>/dev/null".format(h=shlex.quote(hw_dir)))
                latest = {}
                for ln in (tl or "").strip().splitlines():
                    parts = [p.strip() for p in ln.split(",")]
                    if len(parts) >= 5 and parts[1].isdigit():
                        latest[parts[1]] = parts
                for idx, p in sorted(latest.items(), key=lambda kv: int(kv[0])):
                    live.append({"index": int(idx), "temp": _try_float(p[2]),
                                 "pwr": _try_float(p[3]), "util": _try_float(p[4]),
                                 "clk": _try_float(p[6]) if len(p) > 6 else None})

            elapsed = int(time.time() - (self.state.get("startedAt") or time.time()))
            total = max(1, self.state.get("burnSeconds", 1))
            # 阶段感知: 烧卡段前有硬件巡检(prep), 烧完脚本还要收尾(finalize); progress 不再假装卡 99%
            if live:
                stage = "burning" if elapsed <= total + 15 else "finalizing"
                progress = min(95, int(elapsed / total * 100)) if elapsed <= total else 96
            else:
                stage = "preparing"      # 硬件巡检 / gpu-burn 编译阶段, 遥测尚未出现
                progress = min(5, int(elapsed / total * 100))
            self._set(live=live, progress=progress, stage=stage)

            if report_path and not running:
                with self._lock:
                    # 仅 running 态可进入收集: 防止锁外慢命令期间收集已完成(done)被重复触发
                    # 的竞态 (二次 _collect 会因会话已关而误报 error, 覆盖成功结果)
                    if self.state.get("phase") == "running":
                        self._set(phase="collecting")
                        threading.Thread(target=self._collect, args=(report_path,), daemon=True).start()
            elif not running and not report_path and self.state.get("phase") == "running":
                if elapsed > 30:
                    _, out_chk, _ = self._exec("cat {d}/hwcheck.out 2>/dev/null | tail -5".format(d=remote_dir))
                    self._set(phase="error",
                              error="远端压测进程已退出但未生成报告。hwcheck.out 尾部: " + (out_chk.strip()[-300:] or "(空)"))
                    self._close()

    def _collect(self, report_path):
        try:
            st = self.state
            cfg_pw = self._cfg_pw or ""
            hw_dir = os.path.dirname(report_path)
            if self._ssh is None and self._sftp is None:
                raise RuntimeError("SSH 会话已关闭")

            def get(remote):
                return self._download_file(remote)

            report_txt = get(report_path)
            telemetry_csv = get(hw_dir + "/gpu_telemetry.csv")
            burn_log = get(hw_dir + "/gpu_burn.log")

            sudo = self._sudo_prefix()
            _, host_out, _ = self._exec("hostname")
            _, ips_out, _ = self._exec("hostname -I 2>/dev/null || hostname --all-ip-addresses 2>/dev/null")
            host_ips = [x for x in (ips_out or "").split() if x]
            _, gq, _ = self._exec("nvidia-smi --query-gpu=index,name,pci.bus_id,driver_version --format=csv,noheader 2>/dev/null")
            _, aer, _ = self._exec("{s}dmesg 2>/dev/null | grep -i aer | tail -8".format(s=sudo))
            gpu_query = [[c.strip() for c in ln.split(",")] for ln in gq.strip().splitlines() if ln.strip()]

            parsed = parse_gpu_artifacts(
                report_txt, telemetry_csv, burn_log,
                enrich={
                    "source": "ssh", "hostname": host_out.strip(),
                    "hostIps": host_ips,
                    "sshHost": self.cfg.get("host"), "sshPort": int(self.cfg.get("port") or 22),
                    "gpuQuery": gpu_query, "driver": gpu_query[0][3] if gpu_query else None,
                    "dmesgAer": [x for x in aer.strip().splitlines() if x.strip()],
                    "remoteDir": hw_dir,
                })
            parsed["jobId"] = self.id
            self._set(phase="done", result=parsed, progress=100, endedAt=time.time())
        except Exception as e:
            self._set(phase="error", error="产物收集/解析失败: {}".format(e)[:300])
        finally:
            self._close()

    def stop(self):
        try:
            sudo = self._sudo_prefix()
            self._exec("{s}pkill -f 'gpu_check[.]sh' 2>/dev/null; {s}pkill -f 'gpu_burn[.]*' 2>/dev/null; true".format(s=sudo))
        except Exception:
            pass
        self._set(phase="stopped", endedAt=time.time())
        self._close()
        return True, "已发送停止指令"

    def _close(self):
        with self._lock:
            for attr in ("_sftp", "_ssh"):
                obj = getattr(self, attr, None)
                if obj is not None:
                    try:
                        obj.close()
                    except Exception:
                        pass
                setattr(self, attr, None)
            self._cfg_pw = None


class GpuJobPool:
    """多台服务器并发压测任务池 (机器数不设上限; 同一机器同时只允许一个在途任务)"""

    MAX_ACTIVE = None      # None = 不限制并发机器数
    KEEP_DONE = 60         # 保留最近 N 个已完成任务的结果

    def __init__(self, script_path):
        self.script_path = script_path
        base = os.path.dirname(script_path)
        candidates = [
            os.path.join(base, "gpu-burn.tar.gz"),
            os.path.join(base, "vendor", "gpu-burn.tar.gz"),
            os.path.join(os.path.dirname(base), "vendor", "gpu-burn.tar.gz"),
        ]
        self.tarball_path = next((p for p in candidates if os.path.exists(p)), None)
        self._lock = threading.Lock()
        self._jobs = {}     # id -> GpuJob (插入序)

    def start_job(self, cfg):
        _ACTIVE = ("connecting", "uploading", "running", "collecting")
        with self._lock:
            # 同一台机器(host+port)只允许一个在途任务, 重复启动直接拒绝
            _hp = (str(cfg.get("host") or "").strip(), int(cfg.get("port") or 22))
            for j in self._jobs.values():
                if j.state.get("phase") in _ACTIVE:
                    jp = (str(j.cfg.get("host") or "").strip(), int(j.cfg.get("port") or 22))
                    if jp == _hp:
                        return None, "该机器({}:{})已有进行中的压测任务, 请等待完成或先停止".format(_hp[0], _hp[1])
            if self.MAX_ACTIVE is not None:
                active = sum(1 for j in self._jobs.values() if j.state.get("phase") in _ACTIVE)
                if active >= self.MAX_ACTIVE:
                    return None, "并发任务已达上限 ({})，请等待现有任务结束".format(self.MAX_ACTIVE)
            job_id = "j{}{}".format(datetime.datetime.now().strftime("%H%M%S"),
                                    secrets.token_hex(3))
            job = GpuJob(job_id, self.script_path, self.tarball_path, cfg)
            self._jobs[job_id] = job
            # 清理过旧的已完成任务
            done_ids = [k for k, v in self._jobs.items() if v.state.get("phase") in ("done", "error", "stopped")]
            for k in (done_ids[:-self.KEEP_DONE] if len(done_ids) > self.KEEP_DONE else []):
                self._jobs.pop(k, None)
        job.start()
        return job_id, "started"

    def status_all(self):
        with self._lock:
            jobs = list(self._jobs.values())
        return [j.status() for j in jobs]

    def stop_job(self, job_id=None):
        if job_id:
            with self._lock:
                job = self._jobs.get(job_id)
            if not job:
                return False, "任务不存在: {}".format(job_id)
            return job.stop()
        with self._lock:
            jobs = list(self._jobs.values())
        stopped = 0
        for j in jobs:
            if j.state.get("phase") in ("connecting", "uploading", "running", "collecting"):
                j.stop()
                stopped += 1
        return True, "已向 {} 个任务发送停止指令".format(stopped)

    def get_result(self, job_id=None):
        if job_id:
            with self._lock:
                job = self._jobs.get(job_id)
            if not job:
                return None, "任务不存在: {}".format(job_id)
        else:
            # 兼容: 无 jobId 时返回最近一个有结果的
            with self._lock:
                jobs = list(self._jobs.values())
            job = next((j for j in reversed(jobs) if j.state.get("result")), None)
            if not job:
                return None, "暂无结果"
        snap = job.snapshot(with_result=True)
        if snap.get("result"):
            return snap["result"], None
        return None, "该任务暂无结果 (phase={})".format(snap.get("phase"))
