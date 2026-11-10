/**
 * 报告导出构建器 (ReportBuilder)
 * 将压测会话数据 + BenchmarkAnalyzer 五项分析结果 + 图表快照
 * 组装为「自包含」单文件 HTML 报告 (内联样式 / 图表 base64 内嵌 / 可离线打开)
 * 同一份 HTML 供 html2pdf.js 渲染导出 PDF
 */
class ReportBuilder {

  /** HTML 转义,所有动态文本必须经过此函数 */
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 构建完整自包含 HTML 报告
   * @param {Object} opts
   * @param {string} opts.modelName     模型标识 (含端点)
   * @param {Object} opts.analysis      BenchmarkAnalyzer 五项结果:
   *                                    { throughput, sweetSpot, pressure, context, maxOutput }
   * @param {Array}  opts.concurrencyResults  各并发档位 tierStats
   * @param {Array}  opts.contextResults      长上下文梯度记录 (可为空)
   * @param {Object} opts.charts        { latency, throughput, context, status } PNG dataURL (可缺省)
   * @param {Object} [opts.meta]        { totalRequests, wallClockSec, startedAt }
   */
  buildReportHtml({ modelName, analysis, concurrencyResults = [], contextResults = [], charts = {}, meta = {} }) {
    const esc = this.esc.bind(this);
    const a = analysis || {};
    const tp = a.throughput || {};
    const sw = a.sweetSpot || {};
    const pr = a.pressure || {};
    const ctx = a.context || {};
    const out = a.maxOutput || {};
    const dateStr = new Date().toLocaleString('zh-CN');

    const kpi = (label, value, sub, cls) =>
      `<div class="tile"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div><div class="n">${esc(sub || '')}</div></div>`;

    const chart = (title, dataUrl, alt) => dataUrl
      ? `<div class="section"><h2>${esc(title)}</h2><img class="chart-img" src="${dataUrl}" alt="${esc(alt || title)}"></div>`
      : '';

    const tierRows = concurrencyResults.map(t => `
      <tr>
        <td>${esc(t.concurrency)}</td>
        <td>${esc(t.total)}</td>
        <td class="${t.successRate >= 99.9 ? 'ok' : (t.successRate >= 95 ? 'warn' : 'bad')}">${t.successRate.toFixed(1)}%</td>
        <td>${t.rps.toFixed(2)}</td>
        <td>${Math.round(t.tpm).toLocaleString()}</td>
        <td>${t.tps.toFixed(1)}</td>
        <td>${(t.ttftP90 || t.avgTtft || 0).toFixed(2)}s</td>
        <td>${t.p50.toFixed(2)}s</td>
        <td>${t.p90.toFixed(2)}s</td>
        <td>${t.p99.toFixed(2)}s</td>
        <td>${(t.avgTpot || 0).toFixed(1)}ms</td>
        <td>${esc(t.rateLimit429Count)}</td>
        <td>${esc(t.grade)}</td>
      </tr>`).join('');

    const ctxRows = (contextResults || []).map(c => `
      <tr>
        <td>${esc(c.tierLabel)}</td>
        <td>~${(c.inputTokens || 0).toLocaleString()}</td>
        <td>${esc(c.status)}</td>
        <td>${c.ttft ? c.ttft.toFixed(2) + 's' : '-'}</td>
        <td>${c.duration ? c.duration.toFixed(2) + 's' : '-'}</td>
        <td class="${c.needleHit ? 'ok' : 'bad'}">${c.ok ? (c.needleHit ? '✅ 命中' : '❌ 未命中') : '-'}</td>
        <td>${c.ok ? '成功支持' : '超出上限/拒绝'}</td>
      </tr>`).join('');

    const reasonText = (sw.reason || '暂无数据').replace(/\n/g, '<br>');
    const pressureText = (pr.summary || '暂无数据').replace(/\n/g, '<br>');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>LLM API 性能压测报告 - ${esc(modelName)}</title>
<style>
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
  .sub b { color: #0b0b0b; font-weight: 600; }
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
  .chart-box img {
    width: 100%; max-width: 900px;
    border: 1px solid #e1e0d9; border-radius: 10px;
    background: #fcfcfb; display: block;
  }
  .chart-title { font-size: 13.5px; font-weight: 600; color: #52514e; margin-bottom: 6px; }
  .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid #e1e0d9; white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  thead th {
    color: #52514e; font-weight: 560; font-size: 11.5px;
    letter-spacing: .02em; border-bottom: 1px solid #c3c2b7;
    background: transparent;
  }
  tbody tr:last-child td { border-bottom: none; }
  td.ok { color: #0ca30c; font-weight: 600; }
  td.warn { color: #fab219; }
  td.bad { color: #d03b3b; font-weight: 600; }
  .hi { color: #d03b3b; font-weight: 600; }
  .diag {
    background: #fcfcfb; border: 1px solid #e1e0d9;
    border-radius: 10px; padding: 14px 16px; margin-bottom: 12px;
  }
  .diag h3 { margin: 0 0 6px; font-size: 13px; color: #0b0b0b; font-weight: 600; }
  .diag p { margin: 0; color: #52514e; font-size: 13px; line-height: 1.7; }
  .chk { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 6px; }
  .chk .item {
    display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 14px; border: 1px solid #e1e0d9; border-radius: 10px;
  }
  .chk .ico {
    flex: none; width: 18px; height: 18px; border-radius: 50%;
    background: #0ca30c; color: #fff; font-size: 12px;
    line-height: 18px; text-align: center; font-weight: 700; margin-top: 1px;
  }
  .chk .t { font-weight: 580; font-size: 13px; }
  .chk .d { color: #898781; font-size: 11.5px; margin-top: 2px; }
  footer {
    color: #898781; font-size: 11.5px; line-height: 1.9;
    margin-top: 28px; padding-top: 16px; border-top: 1px solid #e1e0d9;
  }
  @media (max-width: 640px) {
    body { padding: 20px 14px 48px; }
    h1 { font-size: 20px; }
    .tile .v { font-size: 22px; }
  }
  @media print { body { background: #fff; } section { border: 1px solid #e1e0d9; } }
</style>
</head>
<body>
  <div class="wrap">
  <header>
    <div>
      <h1>LLM API 性能压测报告</h1>
      <div class="sub">
        ${esc(modelName)} · ${esc(dateStr)}
        ${meta.totalRequests ? ' · ' + esc(meta.totalRequests.toLocaleString()) + ' 请求' : ''}
        ${meta.wallClockSec ? ' · ' + esc(meta.wallClockSec) + 's' : ''}
      </div>
    </div>
    <div class="verdict">
      <span style="width:9px;height:9px;border-radius:50%;background:${(pr.first429 || '无') !== '无 429' ? '#d03b3b' : '#0ca30c'};display:inline-block"></span>
      ${(pr.first429 || '无') !== '无 429' ? '有限流' : '压测通过'}
    </div>
  </header>

  <div class="tiles">
    ${kpi('峰值吞吐 RPM', tp.peakRpm ? Math.round(tp.peakRpm).toLocaleString() : '-', tp.peakRps ? tp.peakRps + ' req/s' : '')}
    ${kpi('峰值吞吐 TPM', tp.peakTpm ? Math.round(tp.peakTpm).toLocaleString() : '-', tp.peakTps ? tp.peakTps + ' tok/s' : '')}
    ${kpi('最佳并发', sw.bestConcurrency != null ? sw.bestConcurrency : '-', '评分 ' + (sw.score || '-'))}
    ${kpi('压力拐点', pr.stressConcurrency || '-', pr.first429 && pr.first429 !== '无 429' ? pr.first429 : '未触发限流')}
    ${kpi('最大单次输出', out.maxTokens ? out.maxTokens.toLocaleString() + ' tok' : '-', out.finishReason ? 'finish: ' + out.finishReason : '')}
    ${kpi('有效长上下文', ctx.maxTierLabel || '-', ctx.needleHitRate != null ? '探针命中 ' + ctx.needleHitRate + '%' : '')}
  </div>

  ${chart('延迟分布 (P50 / P90 / P99)', charts.latency)}
  ${chart('吞吐阶梯 (RPS / TPM 双轴)', charts.throughput)}
  ${charts.context ? chart('长上下文 Prefill 耗时曲线', charts.context) : ''}
  ${charts.status ? chart('状态码分布', charts.status) : ''}

  <section>
  <div class="sec-head"><h2>并发阶梯实测</h2><span class="sec-note">吞吐与延迟分布</span></div>
    <table>
      <thead><tr>
        <th>并发</th><th>采样数</th><th>成功率</th><th>RPS</th><th>TPM</th><th>生成TPS</th>
        <th>TTFT P90</th><th>P50</th><th>P90</th><th>P99</th><th>TPOT</th><th>429</th><th>评级</th>
      </tr></thead>
      <tbody>${tierRows || '<tr><td colspan="13">暂无并发压测数据</td></tr>'}</tbody>
    </table>
  </div>

  ${contextResults.length ? `
  <section>
  <div class="sec-head"><h2>长上下文极限探测</h2><span class="sec-note">针尖探针验证</span></div>
    <table>
      <thead><tr>
        <th>梯度</th><th>注入 Tokens</th><th>状态码</th><th>TTFT</th><th>总耗时</th><th>针尖探针</th><th>判定</th>
      </tr></thead>
      <tbody>${ctxRows}</tbody>
    </table>
  </div>` : ''}

  <section>
  <div class="sec-head"><h2>诊断结论</h2><span class="sec-note">Sweet Spot · 瓶颈定位</span></div>
    <div class="diag">
      <h3>💡 最佳并发推荐点 (Sweet Spot)</h3>
      <p>${reasonText}</p>
    </div>
    <div class="diag">
      <h3>🚨 压力点与瓶颈定位 (Bottlenecks)</h3>
      <p>${pressureText}</p>
    </div>
  </section>

  <footer>由 IceBreaker 生成 · 数据仅代表测试时刻状态</div>
</body>
</html>`;
  }

  /** 生成安全的下载文件名 */
  buildFilename(modelName, ext) {
    const safe = String(modelName || 'model').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').slice(0, 60);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `LLM-Benchmark-${safe}-${ts}.${ext}`;
  }
}

// 挂载全局实例
window.reportBuilder = new ReportBuilder();
