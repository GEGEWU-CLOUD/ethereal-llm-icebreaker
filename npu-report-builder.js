/**
 * NPU(昇腾) 压测报告生成器 (NpuReportBuilder)
 * 输入: npu_agent.parse_npu_artifacts() 的结构化 JSON
 * 输出: 自包含 HTML 报告 (SVG 曲线) + Markdown 报告
 */
class NpuReportBuilder {

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  fmt(v, suffix) {
    return (v == null || v === '') ? '-' : String(v) + (suffix || '');
  }

  svgLineChart({ title, unit, cards, pick, warnLine, warnLabel }) {
    const W = 920, H = 250, L = 46, R = 12, T = 14, B = 26;
    const colors = ['#16A34A', '#EA580C', '#2563EB', '#D97706', '#7C3AED', '#0891B2', '#db2777', '#65a30d', '#475569', '#f59e0b', '#14b8a6', '#a855f7'];
    let xMax = 0;
    for (const g of cards) for (const p of (g.series || [])) if (p.t > xMax) xMax = p.t;
    if (!xMax) xMax = 1;
    let lo = Infinity, hi = -Infinity;
    for (const g of cards) for (const p of (g.series || [])) {
      const v = pick(p); if (v == null) continue;
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.08 || 1; lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
    const sx = t => L + (t / xMax) * (W - L - R);
    const sy = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);

    let s = `<div class='chart-box'><div class='chart-title'>${this.esc(title)}${unit ? ' (' + this.esc(unit) + ')' : ''}</div><svg viewBox='0 0 ${W} ${H}' preserveAspectRatio='xMidYMid meet'>`;
    for (let i = 0; i <= 5; i++) {
      const v = lo + ((hi - lo) * i) / 5, y = sy(v);
      s += `<line x1='${L}' y1='${y}' x2='${W - R}' y2='${y}' stroke='#e5e7eb' stroke-width='1'/>`;
      s += `<text class='ax' x='${L - 6}' y='${y + 3}' text-anchor='end'>${Math.round(v)}</text>`;
    }
    for (let i = 0; i <= 6; i++) {
      const t = (xMax * i) / 6, x = sx(t);
      s += `<line x1='${x}' y1='${H - B}' x2='${x}' y2='${H - B + 4}' stroke='#9ca3af'/>`;
      s += `<text class='ax' x='${x}' y='${H - B + 15}' text-anchor='middle'>${Math.round(t / 60)}m</text>`;
    }
    s += `<line x1='${L}' y1='${H - B}' x2='${W - R}' y2='${H - B}' stroke='#9ca3af'/>`;
    if (warnLine != null && warnLine > lo && warnLine < hi) {
      const y = sy(warnLine);
      s += `<line x1='${L}' y1='${y}' x2='${W - R}' y2='${y}' stroke='#d97706' stroke-dasharray='6 4' stroke-width='1.4'/>`;
      s += `<text class='warn' x='${W - R - 4}' y='${y - 4}' text-anchor='end'>${this.esc(warnLabel || warnLine)}</text>`;
    }
    cards.forEach((g, gi) => {
      const pts = (g.series || []).map(p => ({ t: p.t, v: pick(p) })).filter(p => p.v != null);
      if (!pts.length) return;
      const color = colors[gi % colors.length];
      s += `<polyline points='${pts.map(p => `${sx(p.t).toFixed(1)},${sy(p.v).toFixed(1)}`).join(' ')}' fill='none' stroke='${color}' stroke-width='1.6'/>`;
    });
    s += `</svg><div class='legend'>`;
    cards.forEach((g, gi) => { s += `<i style='background:${colors[gi % colors.length]}'></i>NPU${g.index}`; });
    s += `</div></div>`;
    return s;
  }

  buildHtmlReport(parsed) {
    const esc = this.esc.bind(this);
    const m = parsed.meta || {}, sm = parsed.summary || {}, burn = parsed.burn || {};
    const cards = parsed.npus || [];
    const dateStr = (m.generatedAt || new Date().toISOString()).slice(0, 10);
    const badgeCls = parsed.verdictCls === 'pass' ? '' : ' badge-warn';
    const sampleCnt = cards.length ? (cards[0].sampleCount || 0) : 0;

    const kpi = (v, l, cls) => `<div class="tile"><div class="k">${esc(l)}</div><div class="v" style="color:${cls === 'ok' ? '#0ca30c' : cls === 'hot' ? '#fab219' : cls === 'bad' ? '#d03b3b' : cls === 'info' ? '#2a78d6' : '#0b0b0b'}">${esc(v)}</div></div>`;

    const cardRows = cards.map(g => {
      const ok = (parsed.verdictCls !== 'fail');
      return `<tr><td class='c'>NPU${g.index}</td>` +
        `<td class='c'>${this.fmt(g.tmax, '°C')}</td>` +
        `<td class='c'>${this.fmt(g.pmax, 'W')}</td>` +
        `<td class='c'>${this.fmt(g.hbmMax, '%')}</td>` +
        `<td class='c'>${(g.sampleCount || 0)}</td>` +
        `<td class='c'><span class='tag ${ok ? 'tag-pass' : 'tag-warn'}'>${ok ? '✅ 正常' : '❌ 异常'}</span></td></tr>`;
    }).join('');

    const chartTemp = this.svgLineChart({ title: '全卡温度曲线', unit: '°C', cards, pick: p => p.temp, warnLine: 80, warnLabel: '80°C 告警线' });
    const chartPwr = this.svgLineChart({ title: '全卡功耗曲线', unit: 'W', cards, pick: p => p.pwr });

    const clsName = { real: '真实观察', false: '误报', env: '环境限制/待复核', fail: '失败项' };
    const adjCards = (parsed.adjudications || []).map(a => {
      const cm = clsName[a.cls] || clsName.env;
      const color = a.cls === 'fail' ? '#EA580C' : (a.cls === 'real' ? '#b45309' : '#6b7280');
      return `<div class='warn-item'><h4>${a.level === 'FAIL' ? '✗' : '⑂'} ${esc(a.text)}</h4>` +
        `<p><span class='cls' style='color:${color}'>${esc(cm)}。</span>${esc(a.note)}</p></div>`;
    }).join('') || "<p>无 WARN 项。</p>";

    const recRows = (parsed.recommendations || []).map((r, i) =>
      `<tr><td class='c'>${i + 1}</td><td>${esc(r.text)}</td><td class='c'><span class='tag ${r.prio === '高' ? 'tag-warn' : 'tag-pass'}'>${esc(r.prio)}</span></td></tr>`).join('');

    const hostDesc = [m.hostname, (m.hostIps || []).join(','), m.model ? '· ' + m.model : ''].filter(Boolean).join(' ');

    return `<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>NPU 服务器压力测试报告 · ${esc(dateStr)}</title><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: #f9f9f7; color: #0b0b0b;
    font: 14px/1.65 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }
  header {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 24px; flex-wrap: wrap; margin-bottom: 8px;
  }
  h1 { font-size: 24px; font-weight: 650; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { color: #52514e; font-size: 13px; font-variant-numeric: tabular-nums; }
  .verdict {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 16px; border-radius: 999px;
    border: 1px solid rgba(11,11,11,.10); background: #fcfcfb;
    font-weight: 600; font-size: 14px; white-space: nowrap;
  }
  .tiles {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
    gap: 12px; margin: 24px 0 32px;
  }
  .tile {
    background: #fcfcfb; border: 1px solid rgba(11,11,11,.10);
    border-radius: 12px; padding: 16px 18px;
  }
  .tile .k { color: #52514e; font-size: 12px; letter-spacing: .02em; margin-bottom: 8px; }
  .tile .v { font-size: 26px; font-weight: 640; line-height: 1.15; letter-spacing: -0.02em; }
  .tile .v small { font-size: 13px; font-weight: 500; color: #52514e; margin-left: 3px; }
  .tile .n { color: #898781; font-size: 11.5px; margin-top: 6px; }
  section {
    background: #fcfcfb; border: 1px solid rgba(11,11,11,.10);
    border-radius: 14px; padding: 20px 22px 16px; margin-bottom: 20px;
  }
  .sec-head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; flex-wrap: wrap; margin-bottom: 14px;
  }
  h2 { font-size: 15px; font-weight: 640; margin: 0; letter-spacing: .01em; }
  .sec-note { color: #898781; font-size: 12px; }
  .chart-box { margin: 14px 0 4px; }
  .chart-title { font-size: 13.5px; font-weight: 600; color: #52514e; margin-bottom: 6px; }
  svg { width: 100%; height: auto; background: #fcfcfb; border: 1px solid #e1e0d9; border-radius: 10px; display: block; }
  .axis-txt { fill: #898781; font-size: 11px; font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; font-size: 11.5px; color: #52514e; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: baseline; }
  .tbl-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid #e1e0d9; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  thead th { color: #52514e; font-weight: 560; font-size: 11.5px; border-bottom: 1px solid #c3c2b7; background: transparent; }
  tbody tr:last-child td { border-bottom: none; }
  td.ok { color: #0ca30c; font-weight: 600; }
  td.bad { color: #d03b3b; font-weight: 600; }
  .hi { color: #d03b3b; font-weight: 600; }
  .warn-item {
    border: 1px solid #e1e0d9; background: #fcfcfb;
    border-radius: 10px; padding: 14px 16px; margin-bottom: 10px;
  }
  .warn-item h4 { font-size: 13px; margin: 0 0 4px; color: #0b0b0b; font-weight: 600; }
  .warn-item p { font-size: 12.5px; color: #52514e; margin: 0; }
  .warn-item .cls { font-weight: 700; }
  .tag { display: inline-block; padding: 1px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; white-space: nowrap; }
  .tag-pass { background: #dcfce7; color: #15803d; }
  .tag-warn { background: #fef3c7; color: #b45309; }
  .chk { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 6px; }
  .chk .item { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border: 1px solid #e1e0d9; border-radius: 10px; }
  .chk .ico { flex: none; width: 18px; height: 18px; border-radius: 50%; background: #0ca30c; color: #fff; font-size: 12px; line-height: 18px; text-align: center; font-weight: 700; margin-top: 1px; }
  .chk .t { font-weight: 580; font-size: 13px; }
  .chk .d { color: #898781; font-size: 11.5px; margin-top: 2px; }
  footer { color: #898781; font-size: 11.5px; line-height: 1.9; margin-top: 28px; padding-top: 16px; border-top: 1px solid #e1e0d9; }
  @media (max-width: 640px) { body { padding: 20px 14px 48px; } h1 { font-size: 20px; } }
  @media print { body { background: #fff; } section { border: 1px solid #e1e0d9; } }
</style></head><body><div class='wrap'>
<header>
    <div>
      <h1>NPU 服务器压力测试报告${burn.dmiMissing ? ' (仅基线检查)' : (m.durationSec ? ' (' + Math.round(m.durationSec / 60) + ' 分钟满载)' : '')}</h1>
<div class='sub'>主机: ${esc(hostDesc)}</div>
<div class='meta'>
<span>NPU: ${esc(m.npuCount || cards.length || '-')} × ${esc(m.model || '昇腾')}</span>
<span>依据: npu_check.sh (健康基线${burn.dmiMissing ? '' : ' + ascend-dmi 满载'} + 遥测采样)</span>
${m.burnStart ? `<span>压测窗口(北京时间): ${esc(m.burnStart)} – ${esc((m.burnEnd || '').split(' ').pop() || '')}(${m.durationSec}s, 采样 ${sampleCnt} 次/卡)</span>` : ''}
</div>
</div>
    <div class="verdict" style="gap:8px">
      <span style="width:9px;height:9px;border-radius:50%;background:${parsed.verdictCls === 'pass' ? '#0ca30c' : parsed.verdictCls === 'warn' ? '#fab219' : '#d03b3b'};display:inline-block"></span>
      ${esc(parsed.verdict)}
    </div>
  </header>

<div class='tiles'>
${kpi(cards.length ? (burn.passCount + ' PASS') : '-', '健康检查通过项', 'ok')}
${kpi(sm.tmaxAll != null ? Math.round(sm.tmaxAll) + '°C' : '-', '最高温度' + (sm.tmaxCard != null ? '(NPU' + sm.tmaxCard + ')' : ''), (sm.tmaxAll || 0) >= 80 ? 'hot' : 'info')}
${kpi(sm.pmaxAll != null ? Math.round(sm.pmaxAll) + ' W' : '-', '峰值功耗', 'info')}
${kpi(burn.dmiMissing ? '未安装' : '已安装', 'MindX ToolBox', burn.dmiMissing ? 'hot' : 'ok')}
</div>

<section><h2>一、逐卡遥测统计</h2>
<table><tr><th class='c'>NPU</th><th class='c'>温度峰值</th><th class='c'>功耗峰值</th><th class='c'>HBM 峰值</th><th class='c'>采样数</th><th class='c'>判定</th></tr>${cardRows}</table>
${!burn.dmiMissing ? chartTemp + chartPwr : '<p style="font-size:12.5px;color:#6b7280;margin-top:10px">未安装 MindX ToolBox, 无满载遥测曲线。</p>'}
</section>

<section><h2>二、脚本 WARN/FAIL 甄别 (自动规则)</h2>${adjCards}</section>

<section><h2>三、结论与建议</h2>
<p style='font-size:14px'><b>综合结论: ${esc(parsed.verdict)}。</b>脚本原始结论: ${esc(burn.scriptVerdict || '-')}(PASS=${burn.passCount || 0} / WARN=${burn.warnCount || 0} / FAIL=${burn.failCount || 0})。</p>
<table><tr><th class='c'>#</th><th>建议</th><th class='c'>优先级</th></tr>${recRows}</table>
</section>

<footer>来源: ${m.source === 'ssh' ? 'SSH 自动执行' : '手动上传产物'}${m.remoteDir ? ' · 产物: ' + esc(m.remoteDir) : ''} · 由 IceBreaker 自动生成 · ${esc(dateStr)}</footer>
</div></body></html>`;
  }

  buildMarkdownReport(parsed) {
    const m = parsed.meta || {}, sm = parsed.summary || {}, burn = parsed.burn || {};
    const cards = parsed.npus || [];
    const L = [];
    L.push(`# NPU 服务器压力测试报告${burn.dmiMissing ? ' (仅基线检查)' : ''}`, '');
    L.push(`- **主机**: ${[m.hostname, (m.hostIps || []).join('/'), m.sshHost ? 'SSH: ' + m.sshHost + (m.sshPort && m.sshPort !== 22 ? ':' + m.sshPort : '') : '', m.model ? m.model : ''].filter(Boolean).join(' · ')}`);
    L.push(`- **NPU**: ${m.npuCount || cards.length || '?'} × ${m.model || '昇腾'}`);
    L.push(`- **压测窗口(北京时间)**: ${m.burnStart || '?'} – ${m.burnEnd || '?'}(${m.durationSec || '?'} 秒, 采样 ${cards[0] ? cards[0].sampleCount : 0} 次/卡)`);
    L.push(`- **MindX ToolBox**: ${burn.dmiMissing ? '**未安装 (仅基线检查)**' : '已安装 (ascend-dmi 满载)'}`);
    L.push(`- **综合结论**: **${parsed.verdict}** | 脚本原始结论: ${burn.scriptVerdict || '-'}(PASS=${burn.passCount || 0} / WARN=${burn.warnCount || 0} / FAIL=${burn.failCount || 0})`, '');
    L.push('## 一、逐卡遥测统计', '', '| NPU | 温度峰值 | 功耗峰值 | HBM峰值 | 采样数 |', '|---|---|---|---|---|');
    for (const g of cards) {
      L.push(`| NPU${g.index} | ${this.fmt(g.tmax, '°C')} | ${this.fmt(g.pmax, 'W')} | ${this.fmt(g.hbmMax, '%')} | ${g.sampleCount || 0} |`);
    }
    L.push('', '## 二、脚本 WARN/FAIL 甄别 (自动规则)', '', '| 项 | 甄别 | 说明 |', '|---|---|---|');
    const clsName = { real: '真实观察', false: '误报', env: '环境限制/待复核', fail: '失败项' };
    for (const a of (parsed.adjudications || [])) {
      L.push(`| ${a.level === 'FAIL' ? '✗' : '⑂'} ${a.text} | **${clsName[a.cls] || a.cls}** | ${a.note} |`);
    }
    if (!(parsed.adjudications || []).length) L.push('| (无) | — | 无 WARN/FAIL 项 |');
    L.push('', '## 三、结论与建议', '', `**${parsed.verdict}**`, '');
    (parsed.recommendations || []).forEach((r, i) => L.push(`${i + 1}. **(${r.prio})** ${r.text}`));
    L.push('', `*由 IceBreaker 自动生成 · ${m.generatedAt || ''}*`);
    return L.join('\n');
  }

  buildFilename(parsed, ext) {
    const m = (parsed && parsed.meta) || {};
    const base = (m.hostIps && m.hostIps.length)
      ? m.hostIps.join('-')
      : (m.sshHost || m.hostname || 'server');
    const safe = String(base).replace(/[^0-9A-Za-z.\-]/g, '').slice(0, 60) || 'server';
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `NPU服务器压力测试报告_${safe}_${d}.${ext}`;
  }
}

window.npuReportBuilder = new NpuReportBuilder();
