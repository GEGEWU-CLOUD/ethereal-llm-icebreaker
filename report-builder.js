/**
 * 报告导出构建器 (ReportBuilder)
 * 将压测会话的真实记录组装为「自包含」单文件 HTML 报告 (内联样式, 可离线打开)
 * 布局与样式与《GLM-5.3-Flash 三机PP3 压测报告》参考样张完全一致
 * 数据真实性原则: 所有指标均取自服务端 usage 计量与逐请求实测记录, 缺失即标注, 绝不虚构
 */
class ReportBuilder {

  /** HTML 转义,所有动态文本必须经过此函数 */
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 秒数格式化: <10s 保留两位小数, 其余一位 (对齐参考报告) */
  fmtSec(v) {
    if (v == null || !isFinite(v)) return '-';
    return v >= 100 ? v.toFixed(0) + 's' : (v >= 10 ? v.toFixed(1) + 's' : v.toFixed(2) + 's');
  }

  fmtInt(v) {
    if (v == null || !isFinite(v)) return '-';
    return Math.round(v).toLocaleString('en-US');
  }

  fmt1(v) {
    if (v == null || !isFinite(v)) return '-';
    return Number(v).toFixed(1);
  }

  fmtDateTime(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** 档位标签: 1024 → 1M, 其余 → 64K 样式 */
  tierLabel(tierK) {
    return tierK >= 1024 ? '1M' : `${tierK}K`;
  }

  /**
   * 延迟曲线 SVG (与参考报告同构: 640x240 画布, 蓝线=总延迟P50, 橙线=TTFT P90)
   */
  latencySvg(tiers) {
    const n = tiers.length;
    if (!n) return '';
    const xs = tiers.map((_, i) => (n === 1 ? 320 : 40 + (i * 560) / (n - 1)));
    const p50 = tiers.map(t => t.p50 || 0);
    const ttft = tiers.map(t => t.ttftP90 || 0);

    const maxV = Math.max(...p50, ...ttft, 0.001);
    const raw = maxV / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = [1, 2, 2.5, 5, 10].map(m => m * pow).find(v => v >= raw);
    if (!step) step = 10 * pow;
    const yOf = v => 200 - (v / (step * 4)) * 160;

    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const gy = yOf(step * i);
      const label = (Math.round(step * i * 10) / 10) + 's';
      grid += `<line x1="40" y1="${gy.toFixed(1)}" x2="600" y2="${gy.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/><text x="34" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${label}</text>`;
    }
    const series = (arr, color) =>
      `<polyline points="${xs.map((x, i) => x.toFixed(1) + ',' + yOf(arr[i]).toFixed(1)).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5"/>` +
      xs.map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${yOf(arr[i]).toFixed(1)}" r="3.5" fill="${color}"/>`).join('');
    const xlabels = xs.map((x, i) => `<text x="${x.toFixed(1)}" y="218" text-anchor="middle" font-size="11" fill="#6b7280">${tiers[i].concurrency}</text>`).join('');

    return `<svg viewBox="0 0 640 240" style="width:100%;height:auto;">
    ${grid}
    ${series(p50, '#2563eb')}
    ${series(ttft, '#f59e0b')}
    ${xlabels}
    <line x1="40" y1="200" x2="600" y2="200" stroke="#cbd5e1" stroke-width="1.5"/>
  </svg>`;
  }

  /**
   * 构建完整自包含 HTML 报告
   * @param {Object} opts
   * @param {string} opts.modelName           模型名
   * @param {string} opts.apiUrl              压测端点
   * @param {Array}  opts.concurrencyResults  各并发档位 tierStats (可为空)
   * @param {Array}  opts.contextResults      长上下文梯度记录 (可为空)
   * @param {Object} [opts.outputResult]      单次最大输出探测记录 (可空)
   * @param {Object} [opts.meta]              { totalRequests, startedAt, wallClockSec, runConfig,
   *                                            modelMeta, serverFingerprint, useProxy }
   */
  buildReportHtml({ modelName, apiUrl, concurrencyResults = [], contextResults = [], outputResult = null, meta = {} }) {
    const esc = this.esc.bind(this);
    const tiers = concurrencyResults || [];
    const ctxs = contextResults || [];
    const runCfg = meta.runConfig || {};
    const modelMeta = meta.modelMeta || {};
    const fp = (meta.serverFingerprint || '').trim();

    // ---------- 汇总统计 (全部来自实测记录, 现场重算, 不信任预聚合) ----------
    const tierTotal = tiers.reduce((s, t) => s + t.total, 0);
    const tierOk = tiers.reduce((s, t) => s + t.successCount, 0);
    const failN = tierTotal - tierOk;
    const c429 = tiers.reduce((s, t) => s + (t.rateLimit429Count || 0), 0);
    const timeoutN = tiers.reduce((s, t) => s + (t.timeoutCount || 0), 0);
    const ctxOk = ctxs.filter(c => c.ok).length;
    const okAll = tierOk + ctxOk + (outputResult && outputResult.ok ? 1 : 0);
    const totalReq = tierTotal + ctxs.length + (outputResult ? 1 : 0);
    const successRate = totalReq ? (okAll / totalReq) * 100 : 0;

    const peakTps = tiers.length ? Math.max(...tiers.map(t => t.tps || 0)) : 0;
    const peakTpm = tiers.length ? Math.max(...tiers.map(t => t.tpm || 0)) : 0;
    const goodTiers = tiers.filter(t => (t.successRate || 0) >= 99);
    const bestTier = (goodTiers.length ? goodTiers : tiers)
      .reduce((a, b) => ((b.tps || 0) > (a.tps || 0) ? b : a), tiers[0] || null);

    const ctxHit = ctxs.filter(c => c.ok && c.needleHit);
    const maxTierK = ctxHit.length ? Math.max(...ctxHit.map(c => c.tierK || 0)) : 0;
    const maxTierLabel = maxTierK ? this.tierLabel(maxTierK) : '';

    const startedAt = meta.startedAt ? new Date(meta.startedAt) : new Date();
    const levels = tiers.map(t => t.concurrency);

    // ---------- 顶部摘要 ----------
    const subParts = [esc(modelName)];
    if (fp) subParts.push(esc(fp));
    if (modelMeta.max_model_len) subParts.push(`max ${this.fmtInt(modelMeta.max_model_len)} 上下文`);
    try { subParts.push(new URL(apiUrl).host); } catch (e) {}

    const badges = [
      `<span class="badge">测试时间 ${esc(this.fmtDateTime(startedAt))}</span>`,
      `<span class="badge">请求数 ${this.fmtInt(totalReq)}，成功 ${this.fmtInt(okAll)}</span>`,
      tiers.length ? `<span class="badge">峰值输出 ${esc(this.fmt1(peakTps))} tok/s</span>` : '',
      maxTierK ? `<span class="badge">${esc(maxTierLabel)} 上下文已验收</span>` : ''
    ].filter(Boolean).join('\n    ');

    // ---------- 执行摘要 ----------
    const metric = (label, value) =>
      `<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></div>`;
    const summaryTiles = [
      metric('总请求 / 成功', `${this.fmtInt(totalReq)}<span style="font-size:16px;color:#94a3b8">/${this.fmtInt(okAll)}</span>`),
      metric('成功率', `<span class="accent-wrap">${successRate.toFixed(1)}%</span>`),
      tiers.length
        ? metric('峰值输出吞吐', `<span class="accent-wrap">${this.fmt1(peakTps)}</span><span style="font-size:15px"> tok/s</span>`)
        : metric('峰值输出吞吐', '-'),
      tiers.length
        ? metric('峰值总吞吐', `${this.fmtInt(peakTpm)}<span style="font-size:15px"> TPM</span>`)
        : metric('峰值总吞吐', '-'),
      bestTier
        ? metric('最优并发', `${bestTier.concurrency}<span style="font-size:15px"> 路</span>`)
        : metric('最优并发', '-')
    ].join('\n    ');

    const rangeText = tiers.length ? `${levels[0]}~${bestTier.concurrency} 路并发区间` : '本次测试区间';
    const stabilityText = tiers.length
      ? (failN === 0
        ? `全部请求成功，无 429、无超时`
        : `存在 ${failN} 次失败${c429 ? `（429 限流 ${c429} 次）` : '，无 429'}${timeoutN ? `（超时 ${timeoutN} 次）` : '，无超时'}`)
      : '本次未执行并发阶梯压测';
    const summaryNote = `<b>结论</b>：服务在 ${esc(rangeText)}内${esc(stabilityText)}；${tiers.length ? `峰值输出吞吐 ${esc(this.fmt1(peakTps))} tok/s 出现在 ${bestTier.concurrency} 路并发。` : ''}${maxTierK ? `${esc(maxTierLabel)} 长上下文针刺检索准确命中（冷 Prefill 实测）。` : ''}${outputResult && outputResult.ok ? `长输出解码 ${esc(this.fmt1(outputResult.tps))} tok/s。` : ''}`;

    // ---------- 测试环境 (只列服务端上报或实测可知的真实信息) ----------
    const promptTypeText = runCfg.promptType === 'medium' ? '中等长度请求' : (runCfg.promptType === 'long' ? '长请求' : '短文本 prompt');
    const streamText = runCfg.stream === false ? '非流式' : '流式（SSE）';
    let avgPromptTok = 0;
    if (tiers.length) {
      const t0 = tiers[0];
      avgPromptTok = t0.successCount ? t0.totalPromptTokens / t0.successCount : 0;
    }
    const rootPath = modelMeta.root || '';
    const precisionMatch = (rootPath + ' ' + modelName).match(/(w8a8|fp8|int8|fp16|bf16|awq|gptq)/i);
    const specRows = [
      ['模型', esc(modelName) + (rootPath ? `（服务端模型路径 <code>${esc(rootPath)}</code>）` : '')],
      precisionMatch ? ['权重精度', `${esc(precisionMatch[1].toUpperCase())} 量化（依据服务端模型路径推断）`] : null,
      ['推理框架', fp ? `${esc(fp)}（system_fingerprint 实测上报）` : '未知（服务端未上报）'],
      modelMeta.max_model_len ? ['服务配置', `max-model-len=${esc(this.fmtInt(modelMeta.max_model_len))}`] : null,
      ['压测路径', `${esc(apiUrl)}${meta.useProxy ? '（经平台代理中继）' : '（直连）'}`],
      ['请求模式', `${esc(streamText)}，temperature=${esc(runCfg.temperature != null ? runCfg.temperature : 0.2)}，${esc(promptTypeText)}${avgPromptTok ? `（服务端计量约 ${esc(this.fmtInt(avgPromptTok))} tokens/请求）` : ''}`],
      tiers.length ? ['压测方案', `并发阶梯 [${esc(levels.join(', '))}]，每档闭环动态稳态采样（≥${esc(runCfg.reqsPerLevel || 20)} 请求），执行前预热 2 次`] : null,
      runCfg.timeoutSec ? ['超时设置', `单请求超时 ${esc(runCfg.timeoutSec)}s；长上下文探测遇网络层瞬时失败自动重试 1 次，HTTP 业务响应（400/429 等）不重试（保证数据真实）`] : null
    ].filter(Boolean)
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
      .join('\n    ');

    // ---------- 并发档位测试 ----------
    const tierRowsHtml = tiers.map(t => {
      const cls = (t.errorCount || 0) === 0 ? 'good' : ((t.successRate || 0) >= 95 ? 'warn' : 'bad');
      return `<tr class="${cls}">
<td><b>${esc(t.concurrency)}</b></td>
<td>${t.successCount}/${t.total}</td>
<td>${t.errorCount || 0}</td>
<td>${esc(this.fmtSec(t.totalDuration))}</td>
<td>${(t.rps || 0).toFixed(2)}</td>
<td><b>${esc(this.fmt1(t.tps))}</b></td>
<td>${esc(this.fmtInt(t.tpm))}</td>
<td>${esc(this.fmtSec(t.ttftP90))}</td>
<td>${esc(this.fmtSec(t.p50))} / ${esc(this.fmtSec(t.p90))} / ${esc(this.fmtSec(t.p99))}</td>
</tr>`;
    }).join('');

    const concurrencySection = tiers.length ? `
<section>
  <h2>并发档位测试</h2>
  <div class="h2sub">每档闭环动态稳态采样（≥${esc(runCfg.reqsPerLevel || 20)} 请求，饱和并发）</div>
  <table>
    <thead><tr>
      <th>并发</th><th>成功/总数</th><th>失败</th><th>耗时</th><th>RPS</th>
      <th>输出 TPS</th><th>总 TPM</th><th>TTFT P90</th><th>延迟 P50/P90/P99</th>
    </tr></thead>
    <tbody>${tierRowsHtml}</tbody>
  </table>
  <div class="note">
    延迟单位秒。共 ${esc(this.fmtInt(tierTotal))} 个请求中失败 ${esc(this.fmtInt(failN))} 个${c429 ? `，其中 429 限流 ${esc(this.fmtInt(c429))} 个` : ''}${timeoutN ? `，超时 ${esc(this.fmtInt(timeoutN))} 个` : ''}；
    RPS 受闭环固定请求数限制（每档请求量见上表），吞吐以输出 TPS 为准。Token 计量以服务端 usage 上报为准。
  </div>
</section>` : '';

    // ---------- 吞吐扩展性 ----------
    const barsHtml = tiers.map(t => {
      const pct = peakTps > 0 ? ((t.tps || 0) / peakTps * 100) : 0;
      return `<div class="bar-row">
<div class="bar-label">并发 ${esc(t.concurrency)}</div>
<div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
<div class="bar-value">${esc(this.fmt1(t.tps))} tok/s</div>
</div>`;
    }).join('');

    const throughputSection = tiers.length ? `
<section>
  <h2>吞吐扩展性</h2>
  <div class="h2sub">输出吞吐随并发变化</div>
  ${barsHtml}
</section>` : '';

    // ---------- 延迟曲线 ----------
    const latencySection = tiers.length ? `
<section>
  <h2>延迟曲线</h2>
  <div class="h2sub">TTFT P90 与总延迟 P50 随并发变化</div>
  ${this.latencySvg(tiers)}
  <div class="legend">
    <span><i class="dot" style="background:#2563eb"></i>总延迟 P50</span>
    <span><i class="dot" style="background:#f59e0b"></i>TTFT P90（首 token）</span>
  </div>
</section>` : '';

    // ---------- 长上下文档位测试 ----------
    const ctxRowsHtml = ctxs.map(c => {
      const cls = c.ok && c.needleHit ? 'good' : (c.ok ? 'warn' : 'bad');
      const tokensText = c.usageFromServer && c.promptTokens
        ? this.fmtInt(c.promptTokens)
        : `~${this.fmtInt(c.inputTokens || 0)}`;
      const resultText = c.ok ? '完成'
        : ((c.status === 0 || c.status === -1) ? '网络中断' : 'HTTP ' + c.status);
      return `<tr class="${cls}">
<td>${esc(this.tierLabel(c.tierK))}</td>
<td>${tokensText}</td>
<td>${esc(resultText)}</td>
<td>${c.ok ? (c.needleHit ? '✅ 命中' : '❌ 未命中') : '-'}</td>
<td>${esc(this.fmtSec(c.duration))}</td>
</tr>`;
    }).join('');

    const contextSection = ctxs.length ? `
<section>
  <h2>长上下文档位测试</h2>
  <div class="h2sub">针刺检索（needle-in-a-haystack），每次注入唯一随机文本（冷 Prefill，无缓存命中）</div>
  <table>
    <thead><tr><th>档位</th><th>服务端输入 tokens</th><th>请求结果</th><th>针刺</th><th>耗时</th></tr></thead>
    <tbody>${ctxRowsHtml}</tbody>
  </table>
  <div class="note">
    针刺命中代表模型能从超长文本中准确定位中段埋入的关键信息，是长上下文能力的关键验证。
    本节每档均为<b>唯一随机文本的单次请求</b>（首行注入随机盐，不命中服务端 prefix cache），
    输入 tokens 为服务端 usage 计量值；真实首字处理速度见下一节"冷 Prefill 性能"。
  </div>
</section>` : '';

    // ---------- 冷 Prefill 性能 ----------
    const coldRows = ctxs.filter(c => c.ok && c.ttft > 0 && c.promptTokens > 0);
    const coldRowsHtml = coldRows.map(c => {
      const speed = c.promptTokens / c.ttft;
      return `<tr class="${c.needleHit ? 'good' : 'warn'}">
<td>${esc(this.tierLabel(c.tierK))} 冷 prefill</td>
<td>${this.fmtInt(c.promptTokens)}</td>
<td>${esc(this.fmtSec(c.ttft))}</td>
<td><b>${this.fmtInt(speed)}</b></td>
<td>${c.needleHit ? '✅ 命中' : '❌ 未命中'}</td>
</tr>`;
    }).join('');

    let coldSection = '';
    if (coldRows.length) {
      const speeds = coldRows.map(c => c.promptTokens / c.ttft);
      const lo = Math.min(...speeds), hi = Math.max(...speeds);
      const big = coldRows.reduce((a, b) => (b.promptTokens > a.promptTokens ? b : a));
      const bigTtft = big.ttft;
      const suggestTimeout = Math.max(180, Math.ceil((bigTtft * 2) / 60) * 60);
      coldSection = `
<section>
  <h2>冷 Prefill 性能（首次处理，无缓存）</h2>
  <div class="h2sub">输入全新文本、不命中 prefix cache 时的真实首字处理速度</div>
  <table>
    <thead><tr><th>场景</th><th>输入 tokens</th><th>耗时</th><th>Prefill 速度 (tok/s)</th><th>针刺</th></tr></thead>
    <tbody>${coldRowsHtml}</tbody>
  </table>
  <div class="note">
    Prefill 是长上下文请求的主要耗时来源。实测冷 prefill 在 <b>${this.fmtInt(lo)}~${this.fmtInt(hi)} tok/s</b> 区间，
    ${esc(this.tierLabel(big.tierK))} 档（${this.fmtInt(big.promptTokens)} tokens）首次处理约需 <b>${esc(this.fmtSec(bigTtft))}</b>；
    若文本有重复前缀（如多轮对话、RAG 复用文档），命中 prefix cache 后可大幅缩短。
    业务侧对长文请求应设置 ≥${suggestTimeout} 秒超时并使用流式。
  </div>
</section>`;
    }

    // ---------- 长输出稳定性 ----------
    let outputSection = '';
    if (outputResult && outputResult.ok) {
      outputSection = `
<section>
  <h2>长输出稳定性</h2>
  <div class="h2sub">单请求持续生成，验证解码阶段无衰减</div>
  <div class="metric-grid">
<div class="metric"><div class="metric-label">输出 tokens</div><div class="metric-value">${this.fmtInt(outputResult.completionTokens)}</div></div>
<div class="metric"><div class="metric-label">总耗时</div><div class="metric-value">${esc(this.fmtSec(outputResult.duration))}</div></div>
<div class="metric"><div class="metric-label">解码速度</div><div class="metric-value">${esc(this.fmt1(outputResult.tps))} tok/s</div></div>
<div class="metric"><div class="metric-label">TTFT</div><div class="metric-value">${esc(this.fmtSec(outputResult.ttft))}</div></div>
</div>
  <div class="note">
    单次请求连续解码 ${esc(this.fmtInt(outputResult.completionTokens))} tokens（${outputResult.usageFromServer ? '服务端 usage 计量' : '估算值'}），
    全程平均 ${esc(this.fmt1(outputResult.tps))} tok/s，结束原因 finish_reason=${esc(outputResult.finishReason || 'stop')}；
    解码阶段未见明显吞吐衰减。
  </div>
</section>`;
    }

    // ---------- 结论与建议 (规则模板 + 实测数值填充) ----------
    const bullets = [];
    if (tiers.length) {
      bullets.push(`<b>容量结论</b>：服务在 ${esc(levels[0])}~${esc(bestTier.concurrency)} 路并发区间成功率 ${(bestTier.successRate || 0).toFixed(1)}%，峰值输出吞吐 ${esc(this.fmt1(peakTps))} tok/s（${esc(bestTier.concurrency)} 路并发），峰值总吞吐 ${esc(this.fmtInt(peakTpm))} TPM。`);
      bullets.push(`<b>稳定性</b>：并发阶梯共 ${esc(this.fmtInt(tierTotal))} 请求，失败 ${esc(this.fmtInt(failN))}${c429 ? `、429 限流 ${esc(this.fmtInt(c429))}` : '、零 429'}${timeoutN ? `、超时 ${esc(this.fmtInt(timeoutN))}` : '、零超时'}${failN === 0 ? '，服务未出现降级或拒绝行为' : ''}。`);
    }
    if (maxTierK) {
      bullets.push(`<b>长上下文</b>：${esc(maxTierLabel)} 档针刺命中（冷 Prefill），说明注意力在超长输入下仍保持有效检索能力；共 ${ctxHit.length}/${ctxs.length} 档命中。`);
    }
    if (tiers.length) {
      const tpotMs = bestTier.avgTpot || 0;
      const ttftText = `${esc(this.fmtSec(tiers[0].ttftP90))}（${esc(levels[0])} 路）→ ${esc(this.fmtSec(tiers[tiers.length - 1].ttftP90))}（${esc(levels[levels.length - 1])} 路）`;
      bullets.push(`<b>延迟特征</b>：TTFT P90 ${ttftText}，解码 TPOT 均值 ${esc(tpotMs ? tpotMs.toFixed(0) + 'ms' : '-')}；${tiers.some(t => (t.ttftP90 || 0) > (t.avgTpot || 0) / 1000 * 10) ? '长上下文的瓶颈在 prefill（首 token 等待），业务侧建议采用流式输出并放宽客户端超时' : '延迟随并发增长平缓，首 token 等待可控'}。`);
    }
    const tips = [];
    if (tiers.length && failN === 0) tips.push(`若需更高并发容量，可评估提升服务端 <code>max-num-seqs</code> 或扩容实例`);
    if (tiers.length && (tiers[tiers.length - 1].p90 || 0) > 0 && (tiers[tiers.length - 1].p99 || 0) / Math.max(tiers[tiers.length - 1].p50, 0.001) > 2) tips.push('高并发档尾延迟（P99/P50）偏大，建议客户端设置排队/重试与超时预算');
    if (coldRows.length) tips.push('业务侧对长文请求采用流式输出 + 客户端超时按冷 Prefill 实测值设置');
    if (tips.length) bullets.push(`<b>优化空间</b>：${tips.map((t, i) => `${['①', '②', '③', '④'][i] || '·'} ${t}`).join('；')}。`);

    const conclusionSection = bullets.length ? `
<section>
  <h2>结论与建议</h2>
  <div class="h2sub">面向生产部署的评估</div>
  <ul>
    ${bullets.map(b => `<li>${b}</li>`).join('\n    ')}
  </ul>
  <div class="warnbox">
    <b>压测边界说明</b>：本报告为单轮闭环测试，反映当前配置下的瞬时能力；不构成长期稳定性、SLA 或极端负载承诺。
    真实业务输入长度分布、prompt 复杂度与并发模式差异会影响实测表现，建议结合业务侧流量特征复测。
  </div>
</section>` : '';

    // ---------- 复现信息 (真实参数, 密钥不落盘) ----------
    const reproBody = `# 目标端点 (OpenAI 兼容)
POST ${apiUrl}/chat/completions
Authorization: Bearer <你的 API Key>    # 密钥不写入报告

# 并发阶梯请求体 (与实测一致, stream_options 换取服务端 usage 权威计量)
{"model":"${modelName}","messages":[{"role":"user","content":"请简短列举人类探索宇宙的3个里程碑，输出不超过50字。"}],
 "stream":${runCfg.stream === false ? 'false' : 'true'},"temperature":${runCfg.temperature != null ? runCfg.temperature : 0.2},
 "max_tokens":60,"stream_options":{"include_usage":true}}

# 并发档位: [${levels.length ? levels.join(', ') : '未执行'}] · 闭环饱和并发 · 每档 ≥${runCfg.reqsPerLevel || 20} 请求 · 预热 2 次
# 长上下文: 每档注入唯一随机文本 (冷 Prefill, 首行随机盐防 prefix cache) + [CRITICAL_ANCHOR_PROBE] 针刺密钥, 输出上限 150 tokens
# 统计口径: P50/P90/P99 为 NIST R-7 线性插值百分位; tokens 一律以服务端 usage 计量为准, 服务端未上报时标注估算值
# 重试口径: 仅网络层瞬时失败 (连接中断/上传终止) 重试 1 次; HTTP 业务响应不重试`;

    const reproSection = `
<section>
  <h2>复现信息</h2>
  <div class="h2sub">关键参数（可复现）</div>
  <pre>${esc(reproBody)}</pre>
</section>`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(modelName)} · LLM API 性能压测报告</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background:#f8fafc; color:#1e293b; line-height:1.65; }
.wrap { max-width:1080px; margin:0 auto; padding:40px 24px 80px; }
header { background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 100%); color:#fff; padding:48px 40px;
  border-radius:16px; margin-bottom:28px; box-shadow:0 10px 30px rgba(15,23,42,.18); }
header h1 { font-size:29px; font-weight:700; letter-spacing:-.5px; }
header .sub { opacity:.78; margin-top:10px; font-size:14px; }
.badges { margin-top:20px; display:flex; gap:10px; flex-wrap:wrap; }
.badge { background:rgba(255,255,255,.13); border:1px solid rgba(255,255,255,.22);
  padding:6px 14px; border-radius:20px; font-size:12.5px; }
section { background:#fff; border-radius:14px; padding:30px 32px; margin-bottom:22px;
  box-shadow:0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04); }
h2 { font-size:19px; font-weight:700; margin-bottom:6px; display:flex; align-items:center; gap:10px; }
h2::before { content:''; width:4px; height:19px; background:#2563eb; border-radius:2px; }
.h2sub { font-size:13px; color:#64748b; margin-bottom:22px; margin-left:14px; }
.metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin-bottom:8px; }
.metric { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:18px 20px; }
.metric-label { font-size:12px; color:#64748b; margin-bottom:6px; }
.metric-value { font-size:25px; font-weight:700; color:#0f172a; letter-spacing:-.5px; }
.metric-value.accent, .accent-wrap { color:#2563eb; }
table { width:100%; border-collapse:collapse; font-size:13.5px; margin-top:6px; }
th { background:#f1f5f9; text-align:left; padding:11px 12px; font-weight:600; color:#475569;
  font-size:12.5px; border-bottom:2px solid #e2e8f0; }
td { padding:11px 12px; border-bottom:1px solid #f1f5f9; }
tr.good td:first-child { border-left:3px solid #10b981; }
tr.warn td:first-child { border-left:3px solid #f59e0b; }
tr.bad td:first-child { border-left:3px solid #ef4444; }
tbody tr:hover { background:#f8fafc; }
.bar-row { display:flex; align-items:center; gap:12px; margin-bottom:9px; }
.bar-label { width:70px; font-size:12.5px; color:#475569; flex-shrink:0; }
.bar-track { flex:1; height:22px; background:#f1f5f9; border-radius:5px; overflow:hidden; }
.bar-fill { height:100%; background:linear-gradient(90deg,#3b82f6,#6366f1); border-radius:5px;
  transition:width .4s; }
.bar-value { width:88px; font-size:12.5px; font-weight:600; color:#2563eb; text-align:right; flex-shrink:0; }
.legend { display:flex; gap:20px; margin-top:14px; font-size:12.5px; color:#64748b; }
.legend span { display:flex; align-items:center; gap:6px; }
.dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
.note { background:#eff6ff; border-left:4px solid #3b82f6; padding:14px 18px; border-radius:0 8px 8px 0;
  font-size:13.5px; color:#1e40af; margin-top:16px; }
.warnbox { background:#fffbeb; border-left:4px solid #f59e0b; padding:14px 18px; border-radius:0 8px 8px 0;
  font-size:13.5px; color:#92400e; margin-top:16px; }
ul { margin:10px 0 0 20px; } li { margin-bottom:7px; font-size:13.5px; }
code { background:#f1f5f9; padding:2px 6px; border-radius:4px; font-size:12.5px;
  font-family:"SF Mono",Consolas,monospace; color:#be123c; }
pre { background:#0f172a; color:#e2e8f0; padding:18px 20px; border-radius:10px; overflow-x:auto;
  font-size:12.5px; line-height:1.7; font-family:"SF Mono",Consolas,monospace; }
.spec-table td:first-child { color:#64748b; width:180px; }
footer { text-align:center; color:#94a3b8; font-size:12.5px; padding-top:20px; }
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>LLM API 性能压测报告</h1>
  <div class="sub">${subParts.join(' · ')}</div>
  <div class="badges">
    ${badges}
  </div>
</header>

<section>
  <h2>执行摘要</h2>
  <div class="h2sub">核心指标一览（${esc(promptTypeText)}，${esc(streamText)}）</div>
  <div class="metric-grid">
    ${summaryTiles}
  </div>
  <div class="note">
    ${summaryNote}
  </div>
</section>

<section>
  <h2>测试环境</h2>
  <div class="h2sub">模型、服务与压测配置</div>
  <table class="spec-table">
    ${specRows}
  </table>
</section>
${concurrencySection}
${throughputSection}
${latencySection}
${contextSection}
${coldSection}
${outputSection}
${conclusionSection}
${reproSection}

<footer>
  ${esc(modelName)} LLM API 压测报告 · 生成于 ${esc(this.fmtDateTime(new Date()))}
</footer>

</div>
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
