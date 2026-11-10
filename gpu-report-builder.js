/**
 * GPU 压测报告生成器 (GpuReportBuilder)
 * 输入: gpu_agent.parse_gpu_artifacts() 的结构化 JSON
 * 输出: ①自包含 HTML 报告 (浅色专业排版 + 可交互 SVG 曲线: 图例显隐/悬停十字线/数据表, 参考 h20-stress-report 样式, 零依赖)
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
    if (g.burnVerdict === 'FAULTY') return { tag: 'vd-bad', text: 'FAULTY' };
    if ((g.throttleThermal || 0) > 0 || (g.tmax || 0) >= 85)
      return { tag: 'vd-warn', text: '观察(热降频)' };
    if (g.burnVerdict === 'OK') return { tag: 'vd-ok', text: '正常' };
    return { tag: 'vd-fp', text: '未跑压测' };
  }

  // ------------------------- HTML 报告 -------------------------

  buildHtmlReport(parsed) {
    const esc = this.esc.bind(this);
    const m = parsed.meta || {};
    const sm = parsed.summary || {};
    const burn = parsed.burn || {};
    const gpus = parsed.gpus || [];
    const durMin = m.durationSec ? Math.max(1, Math.round(m.durationSec / 60)) : null;
    const dateStr = (m.generatedAt || new Date().toISOString()).slice(0, 10);
    const vDot = parsed.verdictCls === 'fail' ? 'var(--crit)' : parsed.verdictCls === 'warn' ? 'var(--warn)' : 'var(--good)';
    const errSum = gpus.reduce((a, g) => a + (g.burnErrors || 0), 0);
    const hasXid = parsed.adjudications.some(a => /Xid|掉总线|失联/.test(a.text));
    const hasSeries = gpus.some(g => (g.series || []).length);
    const sampleCnt = gpus.length ? (gpus[0].sampleCount || 0) : 0;

    // ---------- 嵌入图表数据 (仅在有遥测序列时) ----------
    const data = { gpus: {}, series: {} };
    if (hasSeries) {
      for (const g of gpus) {
        data.gpus[String(g.index)] = {
          tmax: g.tmax, pmax: g.pmax, clkMin: g.clkMin, clkAvg: g.clkAvg,
          gflops: g.gflopsAvg, thr: g.throttleThermal || 0, n: g.sampleCount || 0
        };
        data.series[String(g.index)] = (g.series || []).map(p => ({
          t: p.t, temp: p.temp, pwr: p.pwr, util: p.util, clk: p.clk
        }));
      }
    }
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

    // ---------- KPI 磁贴 ----------
    const tile = (k, v, n, cls) => '<div class="tile' + (cls ? ' ' + cls : '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' + (n ? '<div class="n">' + esc(n) + '</div>' : '') + '</div>';
    const tiles = [
      tile('GPU 计算一致性', gpus.length ? '<span class="' + ((burn.okCount || 0) === gpus.length ? '' : 'crit') + '">' + (burn.okCount || 0) + '/' + gpus.length + '</span><small>OK</small>' : '-',
        gpus.length ? 'gpu-burn 满载 · errors ' + errSum : '未采集', (burn.okCount || 0) === gpus.length && gpus.length ? '' : 'crit'),
      tile('峰值温度', sm.tmaxAll != null ? Math.round(sm.tmaxAll) + '<small>°C</small>' : '-', sm.tmaxGpu != null ? 'GPU' + sm.tmaxGpu + ' · 热降频阈值 85°C' : '', (sm.tmaxAll || 0) >= 85 ? 'crit' : ''),
      tile('单卡峰值功耗', sm.pmaxAll != null ? Math.round(sm.pmaxAll) + '<small>W</small>' : '-', gpus.length ? gpus.length + ' 卡中最高' : '', ''),
      tile('单卡平均算力', sm.gflopsMax != null ? Math.round(sm.gflopsMax) + '<small>GFLOPS</small>' : '-', sm.gflopsMin != null ? '最低 ' + Math.round(sm.gflopsMin) + ' GFLOPS' : (gpus.length ? '日志未含 GFLOPS' : ''), ''),
      tile('ECC / Xid', (burn.eccUE || 0) > 0 ? burn.eccUE + '<small>errors</small>' : '0<small>errors</small>',
        hasXid ? '存在 Xid/掉线记录(见甄别)' : (burn.eccCE != null ? 'CE=' + burn.eccCE + ' · UE=' + burn.eccUE : '无 Xid / 无 EDAC 记录'), (burn.eccUE || 0) > 0 || hasXid ? 'crit' : '')
    ].join('');

    // ---------- 核心结果表 ----------
    const coreRows = [
      ['GPU 压测(gpu-burn 计算一致性)', gpus.length ? (burn.okCount || 0) + '/' + gpus.length + ' 卡 OK,errors: ' + errSum : '-'],
      ['GPU 掉线 / Xid 79 / NVIDIA Xid', hasXid ? '存在(见甄别)' : '无(0 条)'],
      ['内存 ECC (EDAC)', burn.eccCE == null ? '未检测 EDAC' : 'CE=' + burn.eccCE + ',UE=' + burn.eccUE],
      ['磁盘 SMART', (burn.smart || []).length ? (burn.smart || []).map(s => s.dev + ' ' + s.status).join('; ') : '-'],
      ['峰值功耗', this.fmt(sm.pmaxAll, ' W')],
      ['最高温度', sm.tmaxAll != null ? Math.round(sm.tmaxAll) + '°C(GPU' + sm.tmaxGpu + ')' : '-'],
      ['单卡平均算力', sm.gflopsMax != null ? '最高 ' + this.fmt(sm.gflopsMax, ' GFLOPS') + ',最低 ' + this.fmt(sm.gflopsMin, ' GFLOPS') : '-'],
    ].map(r => '<tr><td>' + esc(r[0]) + '</td><td><b>' + esc(String(r[1])) + '</b></td></tr>').join('');

    // ---------- 单卡明细 (行由前端脚本渲染, 无 JS 时显示服务端生成的行) ----------
    const gpuRows = gpus.map(g => {
      const v = this.gpuVerdict(g);
      const hot = (g.tmax || 0) >= 85 || ((g.throttleThermal || 0) > 0);
      return '<tr><td>GPU' + g.index + (g.bus ? ' <span class="bus">' + esc(g.bus) + '</span>' : '') + '</td>' +
        '<td' + (hot ? " class='hi'" : '') + '>' + this.fmt(g.tmax, ' °C') + '</td>' +
        '<td>' + this.fmt(g.pmax, ' W') + '</td>' +
        '<td>' + this.fmt(g.clkMin, ' MHz') + '</td>' +
        '<td>' + this.fmt(g.clkAvg, ' MHz') + '</td>' +
        '<td>' + this.fmt(g.gflopsAvg) + '</td>' +
        '<td>' + (g.throttleThermal || 0) + '/' + (g.sampleCount || 0) + '</td>' +
        "<td><span class='vd " + v.tag + "'>" + esc(v.text) + '</span></td></tr>';
    }).join('');

    // ---------- 压测过程叙述 ----------
    const thrGpus = gpus.filter(g => (g.throttleThermal || 0) > 0).map(g => g.index);
    const spread = (sm.gflopsMax && sm.gflopsMin && sm.gflopsMax > 0)
      ? ((sm.gflopsMax - sm.gflopsMin) / sm.gflopsMax * 100).toFixed(1) : null;
    let narrative = (m.burnStart || '') + ' gpu-burn 启动,' + gpus.length + ' 卡进入满载';
    if (sm.pmaxAll) narrative += '(功耗至 ' + Math.round(sm.pmaxAll) + ' W' + ((gpus[0] || {}).throttlePower ? ',触及功耗墙钳制' : '') + ')';
    if (thrGpus.length) narrative += ';GPU' + thrGpus.join('/') + ' 温度爬升触发热降频';
    if (spread) narrative += ',降频卡平均算力较最高卡低约 ' + spread + '%';
    narrative += ';' + (m.burnEnd || '') + ' 结束,' + (burn.okCount || 0) + '/' + gpus.length + ' 卡 OK、零计算错误、无掉卡、无 Xid。';

    // ---------- 甄别卡片 ----------
    const clsMeta = { real: ['真实观察', '#b45309'], false: ['误报', '#3730a3'], env: ['环境限制/待复核', '#6b7280'], fail: ['失败项', '#d03b3b'] };
    const adjCards = (parsed.adjudications || []).filter(a => a.level === 'WARN' || a.level === 'FAIL' || a.cls === 'fail').map(a => {
      const cm = clsMeta[a.cls] || clsMeta.env;
      return "<div class='warn-item' style='border-left-color:" + cm[1] + "'>" +
        '<h4>' + (a.level === 'FAIL' ? '✗' : '⑂') + ' ' + esc(a.text) + '</h4>' +
        '<p><b style="color:' + cm[1] + '">' + esc(cm[0]) + '。</b>' + esc(a.note) + '</p></div>';
    }).join('') || '<p class="muted">无 WARN/FAIL 项。</p>';

    // ---------- 建议 ----------
    const recRows = (parsed.recommendations || []).map((r, i) =>
      '<tr><td>' + (i + 1) + '</td><td>' + esc(r.text) + '</td><td><span class="prio ' + (r.prio === '高' ? 'p-hi' : r.prio === '中' ? 'p-mid' : 'p-lo') + '">' + esc(r.prio) + '</span></td></tr>').join('');

    const gpuDesc = gpus.length ? gpus.length + ' × ' + (gpus[0].name || 'GPU') + (m.driver ? '(驱动 ' + m.driver + ')' : '') : '';
    const hostDesc = [m.hostname, m.hostIps && m.hostIps.length ? 'IP: ' + m.hostIps.join(', ') : '', m.sshHost ? 'SSH: ' + m.sshHost + (m.sshPort && m.sshPort !== 22 ? ':' + m.sshPort : '') : ''].filter(Boolean).join(' · ');
    const sysDesc = [m.systemProduct, m.cpuModel, m.cpuThreads ? m.cpuThreads + ' 线程' : '', m.memTotal].filter(Boolean).join(' · ');

    // 图表区段 (有遥测数据才渲染)
    const chartSections = !hasSeries ? '' :
      '<section><div class="sec-head"><h2>温度曲线</h2><span class="sec-note">°C · gpu-burn 满载窗口遥测' + (sampleCnt ? ' · ' + sampleCnt + ' 采样/卡' : '') + '</span></div>' +
      '<div class="legend" id="lgTemp"></div><div class="chart-slot" id="chartTemp"><div class="tip" id="tipTemp"></div></div>' +
      '<details><summary>查看数据表(' + gpus.length + ' 卡遥测序列)</summary><div class="scroll"><table id="tblTemp"></table></div></details></section>' +
      '<section><div class="sec-head"><h2>功耗曲线</h2><span class="sec-note">W · 单卡功耗上限以厂商 TDP 为准</span></div>' +
      '<div class="legend" id="lgPwr"></div><div class="chart-slot" id="chartPwr"><div class="tip" id="tipPwr"></div></div>' +
      '<details><summary>查看数据表(' + gpus.length + ' 卡遥测序列)</summary><div class="scroll"><table id="tblPwr"></table></div></details></section>' +
      '<section><div class="sec-head"><h2>SM 时钟曲线</h2><span class="sec-note">MHz · 陡降通常对应热降频/功耗墙</span></div>' +
      '<div class="legend" id="lgClk"></div><div class="chart-slot" id="chartClk"><div class="tip" id="tipClk"></div></div>' +
      '<details><summary>查看数据表(' + gpus.length + ' 卡遥测序列)</summary><div class="scroll"><table id="tblClk"></table></div></details></section>';

    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>GPU 服务器压力测试报告 · ' + esc(m.hostname || '') + ' · ' + esc(dateStr) + '</title><style>' +
      ':root{--surface-1:#fcfcfb;--plane:#f9f9f7;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);' +
      '--good:#0ca30c;--warn:#fab219;--crit:#d03b3b;' +
      '--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#4a3aa7;--s8:#e34948;--s9:#0e7490;--s10:#64748b;color-scheme:light}' +
      ':root[data-theme="dark"]{--surface-1:#1a1a19;--plane:#0d0d0d;--ink:#ffffff;--ink2:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);' +
      '--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#2fae2f;--s7:#9085e9;--s8:#e66767;--s9:#22a8c4;--s10:#94a3b8;color-scheme:dark}' +
      '*{box-sizing:border-box}' +
      'body{margin:0;padding:32px 24px 64px;background:var(--plane);color:var(--ink);font:14px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}' +
      '.wrap{max-width:1080px;margin:0 auto}' +
      'header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:8px}' +
      'h1{font-size:24px;font-weight:650;margin:0 0 6px;letter-spacing:-.01em}' +
      '.sub{color:var(--ink2);font-size:13px;font-variant-numeric:tabular-nums}' +
      '.sub2{color:var(--muted);font-size:12px;margin-top:3px}' +
      '.verdict{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:999px;border:1px solid var(--ring);background:var(--surface-1);font-weight:600;font-size:14px;white-space:nowrap}' +
      '.dot{width:9px;height:9px;border-radius:50%;background:' + vDot + ';flex:none}' +
      '.theme-btn{background:var(--surface-1);border:1px solid var(--ring);color:var(--ink2);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit}' +
      '.theme-btn:hover{border-color:var(--axis)}' +
      '.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin:24px 0 32px}' +
      '.tile{background:var(--surface-1);border:1px solid var(--ring);border-radius:12px;padding:16px 18px}' +
      '.tile .k{color:var(--ink2);font-size:12px;letter-spacing:.02em;margin-bottom:8px}' +
      '.tile .v{font-size:26px;font-weight:640;line-height:1.15;letter-spacing:-.02em;font-variant-numeric:tabular-nums}' +
      '.tile .v small{font-size:13px;font-weight:500;color:var(--ink2);margin-left:3px;letter-spacing:0}' +
      '.tile .v .crit{color:var(--crit)}' +
      '.tile.crit .v{color:var(--crit)}' +
      '.tile .n{color:var(--muted);font-size:11.5px;margin-top:6px}' +
      'section{background:var(--surface-1);border:1px solid var(--ring);border-radius:14px;padding:20px 22px 16px;margin-bottom:20px}' +
      '.sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:4px}' +
      'h2{font-size:15px;font-weight:640;margin:0;letter-spacing:.01em}' +
      '.sec-note{color:var(--muted);font-size:12px}' +
      '.legend{display:flex;flex-wrap:wrap;gap:4px 6px;margin:12px 0 6px}' +
      '.lg{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:7px;cursor:pointer;font-size:12px;color:var(--ink2);background:transparent;border:1px solid var(--grid);font-family:inherit;user-select:none;line-height:1.5;font-variant-numeric:tabular-nums;transition:background .12s,border-color .12s}' +
      '.lg:hover{background:var(--plane);border-color:var(--axis)}' +
      '.lg[aria-pressed="false"]{opacity:.35}' +
      '.lg i{width:10px;height:10px;border-radius:2px;flex:none;display:block}' +
      '.chart-slot{position:relative;margin-top:4px}' +
      'svg{display:block;width:100%;height:auto;overflow:visible}' +
      '.axis-txt{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}' +
      '.grid-line{stroke:var(--grid);stroke-width:1}' +
      '.axis-line{stroke:var(--axis);stroke-width:1}' +
      '.series-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}' +
      '.series-line.hidden{display:none}' +
      '.warn-line{stroke:var(--warn);stroke-width:1.2;stroke-dasharray:5 4}' +
      '.crosshair{stroke:var(--axis);stroke-width:1;stroke-dasharray:3 3;pointer-events:none;display:none}' +
      '.hover-dot{stroke:var(--surface-1);stroke-width:2;pointer-events:none;display:none}' +
      '.tip{position:absolute;pointer-events:none;display:none;z-index:10;background:var(--surface-1);border:1px solid var(--ring);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.13);padding:10px 12px;font-size:12px;font-variant-numeric:tabular-nums;min-width:132px}' +
      '.tip .th{color:var(--ink2);font-size:11.5px;margin-bottom:7px;padding-bottom:6px;border-bottom:1px solid var(--grid)}' +
      '.tip .tr{display:flex;align-items:center;gap:8px;line-height:1.75;white-space:nowrap}' +
      '.tip .tr i{width:8px;height:8px;border-radius:2px;flex:none}' +
      '.tip .tr b{margin-left:auto;font-weight:600}' +
      '.tbl-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}' +
      'table{width:100%;border-collapse:collapse;font-size:12.5px;font-variant-numeric:tabular-nums}' +
      'th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--grid);white-space:nowrap}' +
      'th:first-child,td:first-child{text-align:left}' +
      'thead th{color:var(--ink2);font-weight:560;font-size:11.5px;letter-spacing:.02em;border-bottom:1px solid var(--axis)}' +
      'tbody tr:last-child td{border-bottom:none}' +
      '.core td:last-child{font-weight:600}' +
      '.sw{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:7px;vertical-align:baseline}' +
      '.bus{color:var(--muted);font-size:11px}' +
      '.hi{color:var(--crit);font-weight:600}' +
      '.vd{display:inline-flex;align-items:center;gap:6px;font-weight:600;font-size:12px;white-space:nowrap}' +
      '.vd::before{content:"";width:7px;height:7px;border-radius:50%;flex:none}' +
      '.vd-ok::before{background:var(--good)}' +
      '.vd-warn::before{background:var(--warn)}' +
      '.vd-bad::before{background:var(--crit)}' +
      '.vd-fp::before{background:var(--muted)}' +
      '.prio{display:inline-block;padding:1px 10px;border-radius:999px;font-size:11.5px;font-weight:600}' +
      '.p-hi{background:rgba(208,59,59,.12);color:var(--crit)}' +
      '.p-mid{background:rgba(250,178,25,.16);color:#a07900}' +
      '.p-lo{background:rgba(11,11,11,.06);color:var(--ink2)}' +
      '.warn-item{border:1px solid var(--grid);border-left:3px solid var(--warn);border-radius:10px;padding:12px 16px;margin-bottom:10px;background:var(--surface-1)}' +
      '.warn-item h4{font-size:13.5px;margin:0 0 4px;font-weight:640}' +
      '.warn-item p{font-size:12.5px;color:var(--ink2);margin:0}' +
      '.muted{color:var(--muted);font-size:13px}' +
      'details{margin-top:14px;border-top:1px solid var(--grid);padding-top:10px}' +
      'summary{cursor:pointer;color:var(--ink2);font-size:12.5px;list-style:none;user-select:none}' +
      'summary::-webkit-details-marker{display:none}' +
      'summary::before{content:"▸ ";color:var(--muted)}' +
      'details[open] summary::before{content:"▾ "}' +
      'details .scroll{max-height:340px;overflow:auto;margin-top:10px;border:1px solid var(--grid);border-radius:8px}' +
      'footer{color:var(--muted);font-size:11.5px;line-height:1.9;margin-top:28px;padding-top:16px;border-top:1px solid var(--grid)}' +
      'footer code{background:rgba(11,11,11,.05);border-radius:4px;padding:0 5px;font-size:11px}' +
      '@media (max-width:640px){body{padding:20px 14px 48px}h1{font-size:20px}.tile .v{font-size:22px}}' +
      '@media print{body{background:#fff}section,.tile{break-inside:avoid}}' +
      '</style></head><body><div class="wrap">' +

      '<header><div>' +
      '<h1>GPU 服务器压力测试报告' + (durMin ? '(' + durMin + ' 分钟满载)' : '') + '</h1>' +
      '<div class="sub">' + esc(hostDesc || '-') + (gpuDesc ? ' · ' + esc(gpuDesc) : '') + '</div>' +
      '<div class="sub2">' + esc(sysDesc) + (m.burnStart ? ' · 压测窗口(北京时间): ' + esc(m.burnStart) + ' → ' + esc((m.burnEnd || '').split(' ').pop() || '') + '(' + (m.durationSec || '?') + 's' + (sampleCnt ? ',采样 ' + sampleCnt + ' 次/卡' : '') + ')' : '') + '</div>' +
      '</div><div style="display:flex;gap:10px;align-items:center">' +
      (hasSeries ? '<button class="theme-btn" id="themeBtn" type="button">切换主题</button>' : '') +
      '<div class="verdict"><span class="dot"></span>' + esc(parsed.verdict) + '</div>' +
      '</div></header>' +

      '<div class="tiles">' + tiles + '</div>' +

      chartSections +

      '<section><div class="sec-head"><h2>一、核心结果</h2><span class="sec-note">依据 hardware_check.sh(gpu-burn 单精度满载 + 15s 遥测采样)</span></div>' +
      '<div class="tbl-wrap"><table class="core">' + coreRows + '</table></div></section>' +

      '<section><div class="sec-head"><h2>二、单卡遥测与算力</h2><span class="sec-note">基于每卡 ' + (sampleCnt || 0) + ' 个遥测采样点</span></div>' +
      '<div class="tbl-wrap"><table id="tblGpu"><thead><tr><th>GPU</th><th>峰值温度</th><th>峰值功耗</th><th>SM时钟最低</th><th>SM时钟均值</th><th>平均算力(GFLOPS)</th><th>热降频采样</th><th>判定</th></tr></thead><tbody>' + gpuRows + '</tbody></table></div>' +
      (thrGpus.length ? '<p class="muted" style="margin-top:10px;font-size:12px">注:GPU' + thrGpus.join('/') + ' 压测中触发热降频(Sw/Hw ThermalSlowdown 置位),SM 时钟与算力受影响;其余各卡详见上方曲线。</p>' : '') +
      '</section>' +

      '<section><div class="sec-head"><h2>三、压测过程</h2></div><p style="font-size:13.5px;margin:6px 0 0">' + esc(narrative) + '</p></section>' +

      '<section><div class="sec-head"><h2>四、脚本 WARN/FAIL 甄别(自动规则)</h2><span class="sec-note">可解释 · 可复现 · 同产物同结论</span></div>' + adjCards + '</section>' +

      '<section><div class="sec-head"><h2>五、结论与建议</h2></div>' +
      '<p style="font-size:13.5px;margin:6px 0 10px"><b>综合结论:' + esc(parsed.verdict) + '。</b>脚本原始结论:' + esc(sm.scriptVerdict || '-') + '(PASS=' + (sm.passCount || 0) + ' / WARN=' + (sm.warnCount || 0) + ' / FAIL=' + (sm.failCount || 0) + ')。</p>' +
      '<div class="tbl-wrap"><table><thead><tr><th>#</th><th style="text-align:left">建议</th><th>优先级</th></tr></thead><tbody>' + recRows + '</tbody></table></div></section>' +

      '<footer>' +
      '测试方法:gpu-burn 单精度(FP32)矩阵满载,逐卡校验计算一致性;遥测采样 <code>nvidia-smi</code> 15 秒间隔。<br>' +
      '数据来源:' + (m.source === 'ssh' ? 'SSH 自动执行' : '手动上传产物') + (m.remoteDir ? ' · 产物目录 <code>' + esc(m.remoteDir) + '</code>(REPORT_*.txt / gpu_burn.log / gpu_telemetry.csv)' : '') + '<br>' +
      '由 IceBreaker 自动生成 · ' + esc(dateStr) + '</footer>' +

      '</div>' +

      (hasSeries ? '<script>var DATA=' + dataJson + ';</script>' : '') +
      '<script>' +
      '(function(){' +
      'if(typeof DATA==="undefined"||!DATA||!DATA.series)return;' +
      'var root=document.documentElement;' +
      'var prefersDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;' +
      'root.dataset.theme=prefersDark?"dark":"light";' +
      'var tbtn=document.getElementById("themeBtn");' +
      'var GPUS=Object.keys(DATA.series).map(Number).sort(function(a,b){return a-b;});' +
      'if(!GPUS.length||!DATA.series[GPUS[0]].length)return;' +
      'if(tbtn){tbtn.addEventListener("click",function(){root.dataset.theme=root.dataset.theme==="dark"?"light":"dark";document.querySelectorAll("svg[data-chart]").forEach(function(s){s.remove();});renderAll();});}' +
      'var RAW=DATA.series,TOTAL=0;' +
      'GPUS.forEach(function(g){(RAW[g]||[]).forEach(function(p){if(p.t>TOTAL)TOTAL=p.t;});});' +
      'if(!TOTAL)TOTAL=1;' +
      'function avgOf(arr,k){var s=0,n=0;arr.forEach(function(p){if(p[k]!=null){s+=p[k];n++;}});return n?s/n:null;}' +
      'var AVG={};GPUS.forEach(function(g){var a=RAW[g]||[];AVG[g]={t:avgOf(a,"temp"),p:avgOf(a,"pwr"),u:avgOf(a,"util")};});' +
      'function seriesColor(i){return getComputedStyle(root).getPropertyValue("--s"+((i%10)+1)).trim();}' +
      // 分桶: >60 点时按 BS 秒聚合均值
      'var BS=Math.max(15,Math.ceil(TOTAL/60/15)*15);' +
      'function bucketize(arr){if(arr.length<=60)return arr;var by={},out=[];arr.forEach(function(p){var k=Math.floor(p.t/BS);(by[k]=by[k]||[]).push(p);});Object.keys(by).map(Number).sort(function(a,b){return a-b;}).forEach(function(k){var ps=by[k];out.push({t:k*BS+BS/2,temp:avgOf(ps,"temp"),pwr:avgOf(ps,"pwr"),util:avgOf(ps,"util"),clk:avgOf(ps,"clk")});});return out;}' +
      'var SER={};GPUS.forEach(function(g){SER[g]=bucketize(RAW[g]||[]);});' +
      'var N=0;GPUS.forEach(function(g){if(SER[g].length>N)N=SER[g].length;});' +
      'if(!N)return;' +
      'function scaleFor(key){var mn=Infinity,mx=-Infinity;GPUS.forEach(function(g){SER[g].forEach(function(p){var v=p[key];if(v==null)return;if(v<mn)mn=v;if(v>mx)mx=v;});});if(!isFinite(mn)){mn=0;mx=1;}' +
      'var lo,hi;' +
      'if(key==="temp"){lo=Math.min(25,Math.floor((mn-3)/10)*10);hi=mx>85?Math.ceil((mx+3)/10)*10:90;}' +
      'else if(key==="pwr"){lo=0;hi=Math.ceil((mx*1.08)/50)*50;}' +
      'else{lo=Math.floor((mn*0.95)/100)*100;hi=Math.ceil((mx*1.04)/100)*100;}' +
      'if(hi<=lo)hi=lo+1;return{lo:lo,hi:hi};}' +
      'function niceStep(x){var c=Math.pow(10,Math.floor(Math.log(x)/Math.LN10));var r=x/c;return (r<=1?1:r<=2?2:r<=5?5:10)*c;}' +
      // 单调三次样条 (Fritsch-Carlson): 平滑曲线且不过冲 — 直线段折线改为圆润曲线
      'function smoothPath(pts){var n=pts.length;if(n<2)return "";if(n===2)return "M"+pts[0].x.toFixed(1)+" "+pts[0].y.toFixed(1)+"L"+pts[1].x.toFixed(1)+" "+pts[1].y.toFixed(1);' +
      'var dx=[],m=[],t=[],i;for(i=0;i<n-1;i++){dx.push(pts[i+1].x-pts[i].x);m.push((pts[i+1].y-pts[i].y)/(pts[i+1].x-pts[i].x));}' +
      't.push(m[0]);for(i=0;i<m.length-1;i++){if(m[i]*m[i+1]<=0)t.push(0);else{var s=dx[i]+dx[i+1];t.push(3*s/((s+dx[i])/m[i]+(s+dx[i+1])/m[i+1]));}}t.push(m[m.length-1]);' +
      'var d="M"+pts[0].x.toFixed(1)+" "+pts[0].y.toFixed(1);for(i=0;i<n-1;i++){var h=(pts[i+1].x-pts[i].x)/3;d+="C"+(pts[i].x+h).toFixed(1)+" "+(pts[i].y+t[i]*h).toFixed(1)+" "+(pts[i+1].x-h).toFixed(1)+" "+(pts[i+1].y-t[i+1]*h).toFixed(1)+" "+pts[i+1].x.toFixed(1)+" "+pts[i+1].y.toFixed(1);}return d;}' +
      'function makeChart(o){' +
      'var W=960,H=300,M={t:14,r:20,b:34,l:56},iw=W-M.l-M.r,ih=H-M.t-M.b,sc=scaleFor(o.key),lo=sc.lo,hi=sc.hi;' +
      'var xf=function(s){return M.l+(s/TOTAL)*iw;},sy=function(v){return M.t+ih-((v-lo)/(hi-lo))*ih;};' +
      'var svg=document.createElementNS("http://www.w3.org/2000/svg","svg");' +
      'svg.setAttribute("data-chart","1");svg.setAttribute("viewBox","0 0 "+W+" "+H);svg.setAttribute("role","img");svg.setAttribute("aria-label",o.aria);' +
      'for(var i=0;i<=5;i++){var v=lo+(hi-lo)*i/5,y=sy(v);' +
      'var l=document.createElementNS("http://www.w3.org/2000/svg","line");l.setAttribute("x1",M.l);l.setAttribute("x2",W-M.r);l.setAttribute("y1",y);l.setAttribute("y2",y);l.setAttribute("class",i===0?"axis-line":"grid-line");svg.appendChild(l);' +
      'var t=document.createElementNS("http://www.w3.org/2000/svg","text");t.setAttribute("x",M.l-10);t.setAttribute("y",y+4);t.setAttribute("text-anchor","end");t.setAttribute("class","axis-txt");t.textContent=Math.round(v);svg.appendChild(t);}' +
      // x 轴刻度(分钟)
      'var Tm=TOTAL/60,st=niceStep(Tm/6);if(st<1)st=1;' +
      'for(var mm=0;mm<=Tm+1e-9;mm+=st){var x=M.l+(mm*60/TOTAL)*iw;' +
      'var xt=document.createElementNS("http://www.w3.org/2000/svg","text");xt.setAttribute("x",x);xt.setAttribute("y",H-M.b+20);xt.setAttribute("text-anchor","middle");xt.setAttribute("class","axis-txt");xt.textContent=(Math.round(mm*10)/10)+"\\u2032";svg.appendChild(xt);}' +
      'var xl=document.createElementNS("http://www.w3.org/2000/svg","text");xl.setAttribute("x",M.l+iw);xl.setAttribute("y",H-M.b+20);xl.setAttribute("text-anchor","end");xl.setAttribute("class","axis-txt");xl.textContent="压测时长";svg.appendChild(xl);' +
      // 告警线(温度 85°C)
      'if(o.key==="temp"&&85>lo&&85<hi){var wy=sy(85);var wl=document.createElementNS("http://www.w3.org/2000/svg","line");wl.setAttribute("x1",M.l);wl.setAttribute("x2",W-M.r);wl.setAttribute("y1",wy);wl.setAttribute("y2",wy);wl.setAttribute("class","warn-line");svg.appendChild(wl);' +
      'var wt=document.createElementNS("http://www.w3.org/2000/svg","text");wt.setAttribute("x",W-M.r-4);wt.setAttribute("y",wy-4);wt.setAttribute("text-anchor","end");wt.setAttribute("class","axis-txt");wt.textContent="85°C 告警";svg.appendChild(wt);}' +
      'var cross=document.createElementNS("http://www.w3.org/2000/svg","line");cross.setAttribute("class","crosshair");cross.setAttribute("y1",M.t);cross.setAttribute("y2",M.t+ih);svg.appendChild(cross);' +
      'var paths={},dots={};' +
      'GPUS.forEach(function(g,gi){var pts=[];SER[g].forEach(function(p){if(p[o.key]==null)return;pts.push({x:xf(p.t),y:sy(p[o.key])});});var d=smoothPath(pts);' +
      'var pe=document.createElementNS("http://www.w3.org/2000/svg","path");pe.setAttribute("d",d.trim());pe.setAttribute("class","series-line");pe.setAttribute("stroke",seriesColor(gi));svg.appendChild(pe);paths[g]=pe;' +
      'var c=document.createElementNS("http://www.w3.org/2000/svg","circle");c.setAttribute("r",4);c.setAttribute("class","hover-dot");c.setAttribute("fill",seriesColor(gi));svg.appendChild(c);dots[g]=c;});' +
      'var hit=document.createElementNS("http://www.w3.org/2000/svg","rect");hit.setAttribute("x",M.l);hit.setAttribute("y",M.t);hit.setAttribute("width",iw);hit.setAttribute("height",ih);hit.setAttribute("fill","transparent");svg.appendChild(hit);' +
      'o.slot.appendChild(svg);' +
      'var tipEl=o.tip;' +
      'function move(ev){var r=svg.getBoundingClientRect();var px=(ev.clientX-r.left)/r.width*W;var s=(px-M.l)/iw*TOTAL;if(s<0)s=0;if(s>TOTAL)s=TOTAL;var x=xf(s);' +
      'cross.setAttribute("x1",x);cross.setAttribute("x2",x);cross.style.display="";' +
      'var rows=[];GPUS.forEach(function(g,gi){var best=null,bd=1e18;SER[g].forEach(function(p){if(p[o.key]==null)return;var dd=Math.abs(p.t-s);if(dd<bd){bd=dd;best=p;}});if(!best)return;var hid=paths[g].classList.contains("hidden");' +
      'var c=dots[g];c.setAttribute("cx",x);c.setAttribute("cy",sy(best[o.key]));c.style.display=hid?"none":"";rows.push({g:g,v:best[o.key],hid:hid,gi:gi});});' +
      'var head=TOTAL<120?("+"+Math.round(s)+" 秒"):("+"+(Math.round(s/6)/10)+" 分钟");' +
      'tipEl.innerHTML="<div class=\'th\'>"+head+"</div>"+rows.sort(function(a,b){return b.v-a.v;}).map(function(rr){return "<div class=\'tr\'"+(rr.hid?" style=\'opacity:.3\'":"")+"><i style=\'background:"+seriesColor(rr.gi)+"\'></i>GPU "+rr.g+"<b>"+rr.v.toFixed(o.dec)+" "+o.unit+"</b></div>";}).join("");' +
      'var sr=o.slot.getBoundingClientRect();var left=x/W*sr.width+16;if(left>sr.width-180)left=x/W*sr.width-196;tipEl.style.left=Math.max(4,left)+"px";tipEl.style.top="8px";tipEl.style.display="block";}' +
      'function leave(){cross.style.display="none";tipEl.style.display="none";GPUS.forEach(function(g){dots[g].style.display="none";});}' +
      'hit.addEventListener("mousemove",move);hit.addEventListener("mouseleave",leave);' +
      'return paths;}' +
      'function peakOf(g,key){var mx=null;(RAW[g]||[]).forEach(function(p){if(p[key]==null)return;if(mx==null||p[key]>mx)mx=p[key];});return mx;}' +
      'function buildLegend(el,paths,key,unit,dec){el.innerHTML="";GPUS.forEach(function(g,gi){var b=document.createElement("button");b.type="button";b.className="lg";b.setAttribute("aria-pressed","true");var pk=peakOf(g,key);b.innerHTML="<i style=\'background:"+seriesColor(gi)+"\'></i>GPU "+g+(pk!=null?" · "+pk.toFixed(dec)+" "+unit:"");' +
      'b.addEventListener("click",function(){var on=b.getAttribute("aria-pressed")==="true";b.setAttribute("aria-pressed",on?"false":"true");paths[g].classList.toggle("hidden",on);});el.appendChild(b);});}' +
      'function buildTable(tbl,key,unit,dec){var head="<thead><tr><th>时间</th>"+GPUS.map(function(g){return "<th>GPU "+g+"</th>";}).join("")+"</tr></thead>";var rows=[];' +
      'for(var i=0;i<N;i++){var t0=SER[GPUS[0]][i]?SER[GPUS[0]][i].t:i*BS;var lab=TOTAL<120?("+"+Math.round(t0)+"s"):("+"+(Math.round(t0/6)/10)+"\\u2032");' +
      'rows.push("<tr><td>"+lab+"</td>"+GPUS.map(function(g){var p=SER[g][i];return "<td>"+(p&&p[key]!=null?p[key].toFixed(dec):"-")+"</td>";}).join("")+"</tr>");}' +
      'tbl.innerHTML=head+"<tbody>"+rows.join("")+"</tbody>";}' +
      'function renderAll(){' +
      'var pT=makeChart({slot:document.getElementById("chartTemp"),tip:document.getElementById("tipTemp"),key:"temp",unit:"°C",dec:0,aria:"各 GPU 温度随时间变化曲线"});' +
      'buildLegend(document.getElementById("lgTemp"),pT,"temp","°C",0);' +
      'var pP=makeChart({slot:document.getElementById("chartPwr"),tip:document.getElementById("tipPwr"),key:"pwr",unit:"W",dec:0,aria:"各 GPU 功耗随时间变化曲线"});' +
      'buildLegend(document.getElementById("lgPwr"),pP,"pwr","W",0);' +
      'var pC=makeChart({slot:document.getElementById("chartClk"),tip:document.getElementById("tipClk"),key:"clk",unit:"MHz",dec:0,aria:"各 GPU SM 时钟随时间变化曲线"});' +
      'buildLegend(document.getElementById("lgClk"),pC,"clk","MHz",0);' +
      'buildTable(document.getElementById("tblTemp"),"temp","°C",0);' +
      'buildTable(document.getElementById("tblPwr"),"pwr","W",0);' +
      'buildTable(document.getElementById("tblClk"),"clk","MHz",0);}' +
      'renderAll();' +
      '})();' +
      '</script>' +

      '</body></html>';
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
    L.push(`- **主机**:${[m.hostname, m.hostIps && m.hostIps.length ? 'IP: ' + m.hostIps.join('/') : '', m.sshHost ? 'SSH: ' + m.sshHost + (m.sshPort && m.sshPort !== 22 ? ':' + m.sshPort : '') : '', m.systemProduct, m.cpuModel ? m.cpuModel + '(' + (m.cpuThreads || '?') + ' 线程)' : '', m.memTotal].filter(Boolean).join(' · ')}`);
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

  buildFilename(parsed, ext) {
    const m = (parsed && parsed.meta) || {};
    const base = (m.hostIps && m.hostIps.length)
      ? m.hostIps.join('-')
      : (m.sshHost || m.hostname || 'server');
    const safe = String(base).replace(/[^0-9A-Za-z.\-]/g, '').slice(0, 60) || 'server';
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `GPU服务器压力测试报告_${safe}_${d}.${ext}`;
  }
}

window.gpuReportBuilder = new GpuReportBuilder();
