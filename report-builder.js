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

    const kpi = (label, value, sub) => `
      <div class="kpi">
        <div class="kpi-label">${esc(label)}</div>
        <div class="kpi-value">${esc(value)}</div>
        <div class="kpi-sub">${esc(sub || '')}</div>
      </div>`;

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
  :root {
    --black: #0A0A0A; --panel: #161616; --line: #2A2A2A;
    --white: #FFFFFF; --gray: #8A8A8A; --dim: #5A5A5A;
    --red: #16A34A; --green: #35C46E; --amber: #F5A623; --blue: #3B9EFF;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 32px 40px;
    background: var(--black); color: #DDDDDD;
    font-family: "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 13px; line-height: 1.65;
  }
  .rpt-head { border-bottom: 2px solid var(--red); padding-bottom: 16px; margin-bottom: 20px; }
  .rpt-head h1 { margin: 0 0 8px; font-size: 21px; color: var(--white); letter-spacing: 0.5px; }
  .rpt-head .meta { color: var(--gray); font-size: 12px; }
  .rpt-head .meta b { color: #DDDDDD; font-weight: 600; }
  .kpi-grid {
    display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 20px;
  }
  .kpi {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px 14px;
  }
  .kpi-label { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi-value { font-size: 19px; font-weight: 700; color: var(--white); margin: 3px 0 2px; }
  .kpi-sub { font-size: 11px; color: var(--gray); }
  .section { margin-bottom: 20px; page-break-inside: avoid; }
  .section h2 {
    font-size: 14px; color: var(--white);
    border-left: 3px solid var(--red); padding-left: 10px; margin: 0 0 10px;
  }
  .chart-img {
    width: 100%; max-width: 900px; border: 1px solid var(--line);
    border-radius: 10px; background: var(--panel); display: block;
  }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 10px; overflow: hidden; }
  th, td { padding: 8px 10px; text-align: center; border-bottom: 1px solid var(--line); font-size: 12px; }
  th { background: #1E1E1E; color: var(--gray); font-weight: 600; white-space: nowrap; }
  td.ok { color: var(--green); font-weight: 600; }
  td.warn { color: var(--amber); }
  td.bad { color: #EA580C; font-weight: 600; }
  .diag {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px; margin-bottom: 12px;
  }
  .diag h3 { margin: 0 0 6px; font-size: 13px; color: var(--white); }
  .diag p { margin: 0; color: #C9C9C9; font-size: 12.5px; }
  .rpt-foot { margin-top: 24px; color: var(--dim); font-size: 11px; text-align: center; border-top: 1px solid var(--line); padding-top: 14px; }
  @media print { body { background: #fff; color: #222; } }
</style>
</head>
<body>
  <div class="rpt-head">
    <h1>📊 大语言模型 API 全方位性能压力与极限基准评测报告</h1>
    <div class="meta">
      测试对象: <b>${esc(modelName)}</b> &nbsp;|&nbsp; 报告生成: ${esc(dateStr)}
      ${meta.startedAt ? '&nbsp;|&nbsp; 压测开始: ' + esc(meta.startedAt) : ''}
      ${meta.totalRequests ? '&nbsp;|&nbsp; 总请求量: <b>' + esc(meta.totalRequests.toLocaleString()) + '</b>' : ''}
      ${meta.wallClockSec ? '&nbsp;|&nbsp; 总耗时: ' + esc(meta.wallClockSec) + 's' : ''}
    </div>
  </div>

  <div class="kpi-grid">
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

  <div class="section">
    <h2>各并发档位性能实测阶梯表</h2>
    <table>
      <thead><tr>
        <th>并发</th><th>采样数</th><th>成功率</th><th>RPS</th><th>TPM</th><th>生成TPS</th>
        <th>TTFT P90</th><th>P50</th><th>P90</th><th>P99</th><th>TPOT</th><th>429</th><th>评级</th>
      </tr></thead>
      <tbody>${tierRows || '<tr><td colspan="13">暂无并发压测数据</td></tr>'}</tbody>
    </table>
  </div>

  ${contextResults.length ? `
  <div class="section">
    <h2>长上下文阶梯极限测试表</h2>
    <table>
      <thead><tr>
        <th>梯度</th><th>注入 Tokens</th><th>状态码</th><th>TTFT</th><th>总耗时</th><th>针尖探针</th><th>判定</th>
      </tr></thead>
      <tbody>${ctxRows}</tbody>
    </table>
  </div>` : ''}

  <div class="section">
    <h2>深度诊断结论</h2>
    <div class="diag">
      <h3>💡 最佳并发推荐点 (Sweet Spot)</h3>
      <p>${reasonText}</p>
    </div>
    <div class="diag">
      <h3>🚨 压力点与瓶颈定位 (Bottlenecks)</h3>
      <p>${pressureText}</p>
    </div>
  </div>

  <div class="rpt-foot">由 IceBreaker 生成 · 数据仅代表测试时刻状态</div>
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
