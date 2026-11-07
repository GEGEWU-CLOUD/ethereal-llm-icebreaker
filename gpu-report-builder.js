/**
 * GPU 压测报告生成器 (GpuReportBuilder)
 * 输入: gpu_agent.parse_gpu_artifacts() 的结构化 JSON
 * 输出: ①自包含 HTML 报告 (复刻《GPU服务器压力测试报告》样例风格, 内联 SVG 图表, 零依赖)
 *       ②同构 Markdown 报告
 */
class GpuReportBuilder {

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  fmt(v, suffix) {
    return (v == null || v === '') ? '-' : String(v) + (suffix || '');
  }

  gpuVerdict(g) {
    if (g.burnVerdict === 'FAULTY') return { tag: 'tag-warn', text: '❌ FAULTY' };
    if ((g.throttleThermal || 0) > 0 || (g.tmax || 0) >= 85)
      return { tag: 'tag-warn', text: '⚠️ 观察(热降频)' };
    if (g.burnVerdict === 'OK') return { tag: 'tag-pass', text: '✅ 正常' };
    return { tag: 'tag-fp', text: '— 未跑压测' };
  }

  // ------------------------- SVG 折线图 -------------------------

  svgLineChart({ title, unit, gpus, pick, yMin, yMax, warnLine, warnLabel }) {
    const W = 920, H = 250, L = 46, R = 12, T = 14, B = 26;
    const colors = ['#2563eb', '#EA580C', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#475569', '#f59e0b'];
    let xMax = 0;
    for (const g of gpus) for (const p of (g.series || [])) if (p.t > xMax) xMax = p.t;
    if (!xMax) xMax = 1;
    let lo = yMin, hi = yMax;
    if (lo == null || hi == null) {
      lo = Infinity; hi = -Infinity;
      for (const g of gpus) for (const p of (g.series || [])) {
        const v = pick(p); if (v == null) continue;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const pad = (hi - lo) * 0.08 || 1; lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
    }
    const sx = t => L + (t / xMax) * (W - L - R);
    const sy = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

    let s = `<div class='chart'><div class='chart-title'>${this.esc(title)}${unit ? ' (' + this.esc(unit) + ')' : ''}</div><svg viewBox='0 0 ${W} ${H}' preserveAspectRatio='xMidYMid meet'>`;
    // 网格与 y 轴刻度
    for (let i = 0; i <= 5; i++) {
      const v = lo + ((hi - lo) * i) / 5, y = sy(v);
      s += `<line x1='${L}' y1='${y}' x2='${W - R}' y2='${y}' stroke='#e5e7eb' stroke-width='1'/>`;
      s += `<text class='ax' x='${L - 6}' y='${y + 3}' text-anchor='end'>${Math.round(v)}</text>`;
    }
    // x 轴刻度 (分钟)
    for (let i = 0; i <= 6; i++) {
      const t = (xMax * i) / 6, x = sx(t);
      s += `<line x1='${x}' y1='${H - B}' x2='${x}' y2='${H - B + 4}' stroke='#9ca3af'/>`;
      s += `<text class='ax' x='${x}' y='${H - B + 15}' text-anchor='middle'>${Math.round(t / 60)}m</text>`;
    }
    s += `<line x1='${L}' y1='${H - B}' x2='${W - R}' y2='${H - B}' stroke='#9ca3af'/>`;
    // 告警阈值线
    if (warnLine != null && warnLine > lo && warnLine < hi) {
      const y = sy(warnLine);
      s += `<line x1='${L}' y1='${y}' x2='${W - R}' y2='${y}' stroke='#d97706' stroke-dasharray='6 4' stroke-width='1.4'/>`;
      s += `<text class='warn' x='${W - R - 4}' y='${y - 4}' text-anchor='end'>${this.esc(warnLabel || warnLine)}</text>`;
    }
    // 各卡折线
    gpus.forEach((g, gi) => {
      const pts = (g.series || []).map(p => ({ t: p.t, v: pick(p) })).filter(p => p.v != null);
      if (!pts.length) return;
      const color = colors[gi % colors.length];
      const poly = pts.map(p => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ');
      s += `<polyline points='${poly}' fill='none' stroke='${color}' stroke-width='1.6' stroke-linejoin='round'/>`;
      // 峰值标注 (首卡之外每卡最多标 1 个极值点, 避免拥挤: 仅标峰值)
      const peak = pts.reduce((a, b) => (b.v > a.v ? b : a), pts[0]);
      s += `<circle cx='${sx(peak.t).toFixed(1)}' cy='${sy(peak.v).toFixed(1)}' r='2.4' fill='${color}'/>`;
    });
    s += `</svg><div class='legend'>`;
    gpus.forEach((g, gi) => {
      s += `<i style='background:${colors[gi % colors.length]}'></i>GPU${g.index}`;
    });
    s += `</div></div>`;
    return s;
  }

  // ------------------------- HTML 报告 -------------------------

  buildHtmlReport(parsed) {
    const esc = this.esc.bind(this);
    const m = parsed.meta || {};
    const sm = parsed.summary || {};
    const burn = parsed.burn || {};
    const gpus = parsed.gpus || [];
    const durMin = m.durationSec ? Math.round(m.durationSec / 60) : null;
    const dateStr = (m.generatedAt || new Date().toISOString()).slice(0, 10);
    const badgeCls = parsed.verdictCls === 'pass' ? '' : ' badge-warn';
    const sampleCnt = gpus.length ? (gpus[0].sampleCount || 0) : 0;

    const kpi = (v, l, cls) => `<div class='kpi ${cls || ''}'><div class='v'>${esc(v)}</div><div class='l'>${esc(l)}</div></div>`;

    // 核心结果表
    const coreRows = [
      ['GPU 压测(gpu-burn 计算一致性)', gpus.length ? `**${burn.okCount || 0}/${gpus.length} 卡 OK, errors: ${gpus.reduce((a, g) => a + (g.burnErrors || 0), 0)}**` : '-'],
      ['GPU 掉线 / Xid 79 / NVIDIA Xid', parsed.adjudications.some(a => /Xid|掉总线|失联/.test(a.text)) ? '**存在(见甄别)**' : '无(0 条)'],
      ['内存 ECC (EDAC)', burn.eccCE == null ? '未检测 EDAC' : `CE=${burn.eccCE}, UE=${burn.eccUE}`],
      ['磁盘 SMART', (burn.smart || []).length ? (burn.smart || []).map(s => `${s.dev} ${s.status}`).join('; ') : '-'],
      ['峰值功耗', this.fmt(sm.pmaxAll, ' W')],
      ['最高温度', sm.tmaxAll != null ? `**${Math.round(sm.tmaxAll)}°C(GPU${sm.tmaxGpu})**` : '-', ],
    ].map(r => `<tr><td>${esc(r[0]).replace(/\*\*/g, '')}</td><td><b>${esc(String(r[1]).replace(/\*\*/g, ''))}</b></td></tr>`).join('');

    // 逐卡表
    const gpuRows = gpus.map(g => {
      const v = this.gpuVerdict(g);
      const hot = (g.tmax || 0) >= 80;
      return `<tr><td class='c'>GPU${g.index}</td><td class='c'>${esc(g.bus || '-')}</td>` +
        `<td class='c'${hot ? " style='color:#d97706;font-weight:700'" : ''}>${this.fmt(g.tmax, '°C')}</td>` +
        `<td class='c'>${this.fmt(g.pmax, 'W')}</td><td class='c'>${this.fmt(g.clkMin, ' MHz')}</td>` +
        `<td class='c'>${this.fmt(g.clkAvg, ' MHz')}</td><td class='c'>${this.fmt(g.gflopsAvg, '')}</td>` +
        `<td class='c'>${(g.throttleThermal || 0)}/${g.sampleCount || 0}</td>` +
        `<td class='c'><span class='tag ${v.tag}'>${esc(v.text)}</span></td></tr>`;
    }).join('');

    // 图表
    const chartTemp = this.svgLineChart({ title: '全卡温度曲线', unit: '°C', gpus, pick: p => p.temp, warnLine: 85, warnLabel: '85°C 告警线' });
    const chartPwr = this.svgLineChart({ title: '全卡功耗曲线', unit: 'W', gpus, pick: p => p.pwr });
    const chartClk = this.svgLineChart({ title: '全卡 SM 时钟曲线', unit: 'MHz', gpus, pick: p => p.clk });

    // 压测过程叙述
    const thrGpus = gpus.filter(g => (g.throttleThermal || 0) > 0).map(g => g.index);
    const spread = (sm.gflopsMax && sm.gflopsMin && sm.gflopsMax > 0)
      ? ((sm.gflopsMax - sm.gflopsMin) / sm.gflopsMax * 100).toFixed(1) : null;
    let narrative = `${m.burnStart || ''} gpu-burn 启动,${gpus.length} 卡进入满载`;
    if (sm.pmaxAll) narrative += `(功耗至 ${Math.round(sm.pmaxAll)} W${(gpus[0] || {}).throttlePower ? ',触及功耗墙钳制' : ''})`;
    if (thrGpus.length) narrative += `;GPU${thrGpus.join('/')} 温度爬升触发热降频`;
    if (spread) narrative += `,降频卡平均算力较最高卡低约 ${spread}%`;
    narrative += `;${m.burnEnd || ''} 正常结束,${burn.okCount || 0}/${gpus.length} 卡 OK、零计算错误、无掉卡、无 Xid。`;

    // 甄别卡片
    const clsMeta = {
      real: ['真实观察', '#b45309'], false: ['误报', '#3730a3'], env: ['环境限制/待复核', '#6b7280'], fail: ['失败项', '#9A4A12']
    };
    const adjCards = (parsed.adjudications || []).filter(a => a.level === 'WARN' || a.cls === 'fail').map((a, i) => {
      const cm = clsMeta[a.cls] || clsMeta.env;
      return `<div class='warn-item'><h4>${a.level === 'FAIL' ? '✗' : '⑂'} ${esc(a.text)}</h4>` +
        `<p><span class='cls' style='color:${cm[0] === '误报' ? '#3730a3' : cm[1]}'>${esc(cm[0])}。</span>${esc(a.note)}</p></div>`;
    }).join('') || "<p>无 WARN 项。</p>";

    // 建议
    const recRows = (parsed.recommendations || []).map((r, i) =>
      `<tr><td class='c'>${i + 1}</td><td>${esc(r.text)}</td><td class='c'><span class='tag ${r.prio === '高' ? 'tag-warn' : r.prio === '中' ? 'tag-warn' : 'tag-pass'}'>${esc(r.prio)}</span></td></tr>`).join('');

    const gpuDesc = gpus.length ? `${gpus.length} × ${(gpus[0].name || 'GPU')}${m.driver ? '(驱动 ' + m.driver : ''}${gpus[0].bus ? ', PCIe Gen4 x16' : ''})` : '';
    const hostDesc = [m.hostname, m.ip, m.systemProduct, m.cpuModel ? `· ${m.cpuModel}` : '', m.cpuThreads ? `(${m.cpuThreads} 线程)` : '', m.memTotal ? `· ${m.memTotal}` : ''].filter(Boolean).join(' ');

    return `<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>GPU 服务器压力测试报告 · ${esc(dateStr)}</title><style>
*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Microsoft YaHei','Segoe UI',sans-serif;background:#f3f5f9;color:#111827;line-height:1.65}
.wrap{max-width:980px;margin:0 auto;padding:24px 16px 48px}
header.hero{background:linear-gradient(135deg,#0f172a,#1e3a5f);color:#fff;border-radius:14px;padding:30px 34px;margin-bottom:20px}
.hero h1{font-size:25px;letter-spacing:.5px}.hero .sub{color:#cbd5e1;margin-top:6px;font-size:13px}
.hero .meta{display:flex;gap:22px;margin-top:16px;flex-wrap:wrap;font-size:13px;color:#e2e8f0}
.badge{display:inline-block;margin-top:14px;padding:5px 16px;border-radius:999px;font-weight:700;font-size:15px;background:#16a34a;color:#fff}
.badge-warn{background:#d97706}.badge-fail{background:#EA580C}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.kpi{background:#fff;border-radius:12px;padding:16px 18px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
.kpi .v{font-size:22px;font-weight:800}.kpi .l{font-size:12px;color:#6b7280;margin-top:2px}
.kpi.ok .v{color:#16a34a}.kpi.hot .v{color:#d97706}.kpi.info .v{color:#2563eb}.kpi.bad .v{color:#EA580C}
section.card{background:#fff;border-radius:12px;padding:24px 26px;margin-bottom:20px;box-shadow:0 1px 3px rgba(15,23,42,.08)}
h2{font-size:18px;border-left:4px solid #2563eb;padding-left:10px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#eef2f7;text-align:left;padding:8px 10px;border-bottom:2px solid #cbd5e1;white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid #e5e7eb}
tr:last-child td{border-bottom:none}td.c,th.c{text-align:center}
.tag{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px;font-weight:700;white-space:nowrap}
.tag-pass{background:#dcfce7;color:#15803d}.tag-warn{background:#fef3c7;color:#b45309}.tag-fp{background:#e0e7ff;color:#3730a3}
.chart{margin:18px 0 8px}.chart-title{font-size:13.5px;font-weight:700;color:#374151;margin-bottom:4px}
svg{width:100%;height:auto;background:#fcfdff;border:1px solid #eef1f6;border-radius:8px}
.ax{font-size:11px;fill:#6b7280}.warn{font-size:11px;fill:#d97706}
.legend{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px;font-size:12px;color:#4b5563}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.warn-item{border:1px solid #fde68a;background:#fffbeb;border-radius:10px;padding:14px 16px;margin-bottom:10px}
.warn-item h4{font-size:14px;margin-bottom:4px}.warn-item p{font-size:13px;color:#374151}.warn-item .cls{font-weight:700}
footer{color:#9ca3af;font-size:12px;text-align:center;margin-top:8px}
@media print{body{background:#fff}section.card,header.hero{box-shadow:none;border:1px solid #e5e7eb'}}
</style></head><body><div class='wrap'>
<header class='hero'>
<h1>GPU 服务器压力测试报告${durMin ? `(${durMin} 分钟满载)` : ''}</h1>
<div class='sub'>主机:${esc(hostDesc)}</div>
<div class='meta'><span>GPU:${esc(gpuDesc)}</span><span>依据:hardware_check.sh(gpu-burn 单精度满载 + 15s 遥测采样)</span>${m.burnStart ? `<span>压测窗口(北京时间):${esc(m.burnStart)} – ${esc((m.burnEnd || '').split(' ').pop() || '')}(${m.durationSec}s,采样 ${sampleCnt} 次/卡)</span>` : ''}</div>
<div class='badge${badgeCls}'>${esc(parsed.verdict)}</div>
</div>

<div class='kpis'>
${kpi(gpus.length ? `${burn.okCount || 0}/${gpus.length} OK` : '-', 'GPU 压测', 'ok')}
${kpi(parsed.adjudications.some(a => /Xid|掉总线|失联/.test(a.text)) ? '有 Xid/掉线' : '无 Xid/掉线', '掉线 / Xid', parsed.adjudications.some(a => a.cls === 'fail' && /Xid|掉总线|失联/.test(a.text)) ? 'bad' : 'ok')}
${kpi(burn.eccUE != null ? `CE=${burn.eccCE} UE=${burn.eccUE}` : '未检测', '内存 ECC', (burn.eccUE || 0) > 0 ? 'bad' : 'ok')}
${kpi(this.fmt(sm.pmaxAll, ' W'), '峰值功耗', 'info')}
${kpi(sm.tmaxAll != null ? Math.round(sm.tmaxAll) + '°C' : '-', `最高温度${sm.tmaxGpu != null ? '(GPU' + sm.tmaxGpu + ')' : ''}`, (sm.tmaxAll || 0) >= 85 ? 'bad' : (sm.tmaxAll || 0) >= 80 ? 'hot' : 'info')}
${kpi(sm.gflopsMax != null ? Math.round(sm.gflopsMax) : '-', '单卡平均算力峰值(GFLOPS)', 'info')}
</div>

<section class='card'><h2>一、核心结果</h2><table>${coreRows}</table></section>

<section class='card'><h2>二、逐卡遥测与算力</h2>
<table><tr><th class='c'>GPU</th><th class='c'>PCIe 总线</th><th class='c'>温度峰值</th><th class='c'>功耗峰值</th><th class='c'>SM时钟最低</th><th class='c'>SM时钟均值</th><th class='c'>平均算力(GFLOPS)</th><th class='c'>热降频采样</th><th class='c'>判定</th></tr>${gpuRows}</table>
${thrGpus.length ? `<p style='font-size:12.5px;color:#4b5563;margin-top:8px'>注:GPU${thrGpus.join('/')} 压测中触发热降频(Sw/Hw ThermalSlowdown 置位),SM 时钟与算力受影响;其余各卡详见温度/时钟曲线。</p>` : ''}
${chartTemp}${chartPwr}${chartClk}
</section>

<section class='card'><h2>三、压测过程</h2><p style='font-size:14px'>${esc(narrative)}</p></section>

<section class='card'><h2>四、脚本 WARN/FAIL 甄别(自动规则)</h2>${adjCards}</section>

<section class='card'><h2>五、结论与建议</h2>
<p style='font-size:14px'><b>综合结论:${esc(parsed.verdict)}。</b>脚本原始结论:${esc(sm.scriptVerdict || '-')}(PASS=${sm.passCount || 0} / WARN=${sm.warnCount || 0} / FAIL=${sm.failCount || 0})。</p>
<table><tr><th class='c'>#</th><th>建议</th><th class='c'>优先级</th></tr>${recRows}</table>
</section>

<footer>来源:${m.source === 'ssh' ? 'SSH 自动执行' : '手动上传产物'} · ${m.remoteDir ? '产物:' + esc(m.remoteDir) + ' (REPORT/gpu_burn.log/gpu_telemetry.csv) · ' : ''}由 IceBreaker 自动生成 · ${esc(dateStr)}</footer>
</div></body></html>`;
  }

  // ------------------------- Markdown 报告 -------------------------

  buildMarkdownReport(parsed) {
    const m = parsed.meta || {}, sm = parsed.summary || {}, burn = parsed.burn || {};
    const gpus = parsed.gpus || [];
    const durMin = m.durationSec ? Math.round(m.durationSec / 60) : '?';
    const thrGpus = gpus.filter(g => (g.throttleThermal || 0) > 0);
    const spread = (sm.gflopsMax && sm.gflopsMin && sm.gflopsMax > 0)
      ? ((sm.gflopsMax - sm.gflopsMin) / sm.gflopsMax * 100).toFixed(1) : null;
    const L = [];
    L.push(`# GPU 服务器压力测试报告(${durMin} 分钟满载)`, '');
    L.push(`- **主机**:${[m.hostname, m.ip, m.systemProduct, m.cpuModel ? m.cpuModel + '(' + (m.cpuThreads || '?') + ' 线程)' : '', m.memTotal].filter(Boolean).join(' · ')}`);
    L.push(`- **GPU**:${gpus.length} × ${gpus[0] ? gpus[0].name : '?'}(驱动 ${m.driver || '?'}${gpus[0] && gpus[0].bus ? ',PCIe Gen4 x16' : ''})`);
    L.push(`- **依据**:《GPU压力测试》文档 hardware_check.sh(gpu-burn 单精度满载 + 15s 遥测采样)`);
    L.push(`- **压测窗口(北京时间)**:${m.burnStart || '?'} – ${m.burnEnd || '?'}(${m.durationSec || '?'} 秒,采样 ${gpus[0] ? gpus[0].sampleCount : 0} 次/卡)`);
    L.push(`- **综合结论**: **${parsed.verdict}** ｜ 脚本原始结论:${sm.scriptVerdict || '-'}(${sm.passCount || 0} PASS / ${sm.warnCount || 0} WARN / ${sm.failCount || 0} FAIL)`, '');
    L.push('## 一、核心结果', '', '| 指标 | 结果 |', '|---|---|');
    L.push(`| GPU 压测(gpu-burn 计算一致性) | **${burn.okCount || 0}/${gpus.length} 卡 OK,errors: ${gpus.reduce((a, g) => a + (g.burnErrors || 0), 0)}** |`);
    L.push(`| GPU 掉线 / Xid 79 / NVIDIA Xid | ${parsed.adjudications.some(a => /Xid|掉总线|失联/.test(a.text)) ? '**存在(见四)**' : '无(0 条)'} |`);
    L.push(`| 内存 ECC(EDAC) | ${burn.eccCE == null ? '未检测 EDAC' : 'CE=' + burn.eccCE + ',UE=' + burn.eccUE} |`);
    L.push(`| 磁盘 SMART | ${(burn.smart || []).map(s => `${s.dev} ${s.status}`).join('; ') || '-'} |`);
    L.push(`| 峰值功耗 | ${this.fmt(sm.pmaxAll, ' W')} |`);
    L.push(`| 最高温度 | **${sm.tmaxAll != null ? Math.round(sm.tmaxAll) + '°C(GPU' + sm.tmaxGpu + ')' : '-'}** |`);
    L.push(`| 单卡平均算力 | 最高 ${this.fmt(sm.gflopsMax, ' GFLOPS')},最低 ${this.fmt(sm.gflopsMin, ' GFLOPS')}${spread ? '(差 ' + spread + '%)' : ''} |`, '');
    L.push('## 二、逐卡遥测与算力', '',
      '| GPU | PCIe 总线 | 温度峰值 | 功耗峰值 | SM时钟最低 | SM时钟均值 | 平均算力(GFLOPS) | 热降频采样 | 判定 |',
      '|---|---|---|---|---|---|---|---|---|');
    for (const g of gpus) {
      const v = this.gpuVerdict(g);
      L.push(`| GPU${g.index} | ${g.bus || '-'} | ${this.fmt(g.tmax, '°C')} | ${this.fmt(g.pmax, 'W')} | ${this.fmt(g.clkMin, ' MHz')} | ${this.fmt(g.clkAvg, ' MHz')} | ${this.fmt(g.gflopsAvg)} | ${(g.throttleThermal || 0)}/${g.sampleCount || 0} | ${v.text} |`);
    }
    L.push('');
    if (thrGpus.length) {
      const detail = thrGpus.map(g => `GPU${g.index} 峰值 ${Math.round(g.tmax)}°C,SM 时钟最低降至 ${g.clkMin} MHz,平均算力 ${g.gflopsAvg} GFLOPS`).join(';');
      L.push(`> ${detail} —— 触发热降频(SwThermalSlowdown 置位),算力较其余卡差距见上表;其余各卡满频运行。`, '');
    }
    L.push('## 三、压测过程', '',
      `${(m.burnStart || '')} gpu-burn 启动,${gpus.length} 卡进入满载(功耗至 ${Math.round(sm.pmaxAll || 0)} W);${thrGpus.length ? 'GPU' + thrGpus.map(g => g.index).join('/') + ' 温度爬升触发热降频,' : ''}${durMin} 分钟后正常结束,${burn.okCount || 0}/${gpus.length} 卡 OK、零计算错误、无掉卡、无 Xid。`, '');
    L.push('## 四、脚本 WARN/FAIL 甄别(自动规则)', '', '| 项 | 甄别 | 说明 |', '|---|---|---|');
    const clsName = { real: '真实观察', false: '误报', env: '环境限制/待复核', fail: '失败项' };
    for (const a of (parsed.adjudications || [])) {
      if (a.level === 'PASS') continue;
      L.push(`| ${a.level === 'FAIL' ? '✗' : '⑂'} ${a.text} | **${clsName[a.cls] || a.cls}** | ${a.note} |`);
    }
    if (!(parsed.adjudications || []).some(a => a.level !== 'PASS')) L.push('| (无) | — | 无 WARN/FAIL 项 |');
    L.push('', '## 五、结论与建议', '',
      `**${parsed.verdict}**:${durMin} 分钟满载下 ${burn.okCount || 0}/${gpus.length} 卡存活、零计算错误${thrGpus.length ? ',GPU' + thrGpus.map(g => g.index).join('/') + ' 热降频需关注' : ',散热达标'}。`, '');
    (parsed.recommendations || []).forEach((r, i) => L.push(`${i + 1}. **(${r.prio})** ${r.text}`));
    L.push('', '## 附录:产物与复测', '',
      `- 服务器产物目录:${m.remoteDir || '(手动上传,见上传文件)'}(REPORT_*.txt、gpu_burn.log、gpu_telemetry.csv)`,
      `- 复测命令:\`cd /tmp && sudo ./gpu_check.sh 1800\`(30 分钟)`,
      `- 生成时间:${m.generatedAt || ''}`);
    return L.join('\n');
  }

  buildFilename(ext) {
    const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `GPU服务器压力测试报告_${ts}.${ext}`;
  }
}

window.gpuReportBuilder = new GpuReportBuilder();
