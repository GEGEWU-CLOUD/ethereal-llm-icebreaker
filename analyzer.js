/**
 * LLM 性能基准全方位分析与诊断引擎 (BenchmarkAnalyzer)
 * 核心算法：
 * 1. 实际有效上下文与注意力承载力诊断
 * 2. 实际单次最大输出极限推断
 * 3. 峰值与稳定 RPM / TPM 计算
 * 4. 最佳并发推荐点 (Sweet Spot 效益拐点算法)
 * 5. 压力点 (Latency Spike & 429 限流点) 精准定位
 * 6. 一键 Markdown / 结构化诊断报告生成
 */

class BenchmarkAnalyzer {
  constructor() {
    this.concurrencyResults = []; // 各并发梯度统计
    this.contextResults = [];     // 各长文本梯度测试结果
    this.outputResult = null;     // 最大输出探测结果
  }

  setData({ concurrencyResults = [], contextResults = [], outputResult = null }) {
    this.concurrencyResults = concurrencyResults || [];
    this.contextResults = contextResults || [];
    this.outputResult = outputResult || null;
  }

  /**
   * 1. 分析实际最大上下文与边界 (区分物理传输上限与注意力检索有效上限)
   */
  analyzeContextWindow() {
    if (!this.contextResults.length) {
      return {
        tested: false,
        maxSupportedK: 0,
        maxSafeTokens: 0,
        needleHitRate: 0,
        failurePoint: null,
        summary: '尚未执行长上下文测试。'
      };
    }

    const successfulTiers = this.contextResults.filter(r => r.ok);
    const failedTiers = this.contextResults.filter(r => !r.ok);

    if (successfulTiers.length === 0) {
      return {
        tested: true,
        maxSupportedK: 0,
        maxSafeTokens: 0,
        needleHitRate: 0,
        failurePoint: this.contextResults[0]?.tierLabel || '64k',
        summary: `所有长文本阶梯均未通过。首个测试梯度 (${this.contextResults[0]?.tierLabel}) 失败，错误: ${this.contextResults[0]?.error}`
      };
    }

    // 统计针尖命中情况
    const hitTiers = successfulTiers.filter(r => r.needleHit);
    const needleHits = hitTiers.length;
    const needleHitRate = Math.round((needleHits / successfulTiers.length) * 100);

    const maxTransportSuccess = successfulTiers[successfulTiers.length - 1];
    const maxEffectiveSuccess = hitTiers.length > 0 ? hitTiers[hitTiers.length - 1] : null;
    const firstFail = failedTiers.length > 0 ? failedTiers[0] : null;

    let summary = '';
    if (maxEffectiveSuccess) {
      summary = `实测【真实有效】长上下文为【${maxEffectiveSuccess.tierLabel}】(深度针尖密匙精准命中，实际输入约 ${maxEffectiveSuccess.inputTokens?.toLocaleString() || (maxEffectiveSuccess.tierK * 1024)} Tokens)，Prefill 首字耗时: ${maxEffectiveSuccess.ttft?.toFixed(1)}s。`;
      if (maxTransportSuccess.tierK > maxEffectiveSuccess.tierK) {
        summary += ` ⚠️ 警告：虽然 HTTP 请求最高可通达【${maxTransportSuccess.tierLabel}】，但在超过【${maxEffectiveSuccess.tierLabel}】后密匙无法检索，说明进入注意力盲区或服务端发生静默截断。`;
      }
    } else {
      summary = `⚠️ 假性支持警示：虽然服务接口接收了【${maxTransportSuccess.tierLabel}】长输入未返回 HTTP 错误，但所有梯度的隐秘校验密匙均未能正确识别 (命中率 0%)。表明模型注意力机制严重弥散，或网关已静默丢弃上下文，生产业务不可将其视作有效上下文！`;
    }

    if (firstFail) {
      summary += ` 服务物理拒绝点位于【${firstFail.tierLabel}】(HTTP ${firstFail.status}: ${firstFail.error.slice(0, 80)})。`;
    }

    return {
      tested: true,
      maxSupportedK: maxEffectiveSuccess ? maxEffectiveSuccess.tierK : 0,
      maxSafeTokens: maxEffectiveSuccess ? (maxEffectiveSuccess.inputTokens || (maxEffectiveSuccess.tierK * 1024)) : 0,
      maxTierLabel: maxEffectiveSuccess ? maxEffectiveSuccess.tierLabel : '仅传输可用(注意力未命中)',
      maxTransportLabel: maxTransportSuccess.tierLabel,
      needleHitRate,
      firstFailTier: firstFail ? firstFail.tierLabel : null,
      summary
    };
  }

  /**
   * 2. 分析实际最大输出容量
   */
  analyzeMaxOutput() {
    if (!this.outputResult) {
      return {
        tested: false,
        maxTokens: 0,
        finishReason: 'none',
        speedTps: 0,
        summary: '尚未执行最大输出探测。'
      };
    }

    const r = this.outputResult;
    if (!r.ok) {
      return {
        tested: true,
        maxTokens: 0,
        finishReason: 'error',
        speedTps: 0,
        summary: `最大输出探测执行失败: ${r.error}`
      };
    }

    let summary = `实测单次最多可输出【${r.completionTokens.toLocaleString()}】Tokens，耗时 ${r.duration.toFixed(1)}s，持续生成速率为 ${r.tps.toFixed(1)} tok/s。`;

    if (r.finishReason === 'length') {
      summary += ` 截断原因返回为【length】，证明已触达该模型硬性设定的单次输出极限。`;
    } else if (r.finishReason === 'stop') {
      summary += ` 截断原因返回为【stop】（模型自然收敛停止），实际支持上限可能高于当前数值。`;
    }

    return {
      tested: true,
      maxTokens: r.completionTokens,
      finishReason: r.finishReason,
      speedTps: r.tps,
      duration: r.duration,
      summary
    };
  }

  /**
   * 3. 计算并发吞吐指标 (Peak RPM / Peak TPM)
   */
  analyzeThroughput() {
    if (!this.concurrencyResults.length) {
      return {
        peakRpm: 0,
        peakRps: 0,
        peakTpm: 0,
        peakTps: 0,
        totalCompleted: 0
      };
    }

    let peakRpm = 0;
    let peakRps = 0;
    let peakTpm = 0;
    let peakTps = 0;
    let totalCompleted = 0;

    for (const tier of this.concurrencyResults) {
      if (tier.rpm > peakRpm) peakRpm = tier.rpm;
      if (tier.rps > peakRps) peakRps = tier.rps;
      if (tier.tpm > peakTpm) peakTpm = tier.tpm;
      if (tier.tps > peakTps) peakTps = tier.tps;
      totalCompleted += tier.total;
    }

    return {
      peakRpm: Math.round(peakRpm * 10) / 10,
      peakRps: Math.round(peakRps * 10) / 10,
      peakTpm: Math.round(peakTpm),
      peakTps: Math.round(peakTps * 10) / 10,
      totalCompleted
    };
  }

  /**
   * 4. 计算最佳并发推荐点 (Sweet Spot 效益与边际拐点算法)
   * 算法核心改进：
   * - 样本充分性置信度校验 (识别脉冲突发 vs 闭环稳态)
   * - 边际效益衰减检测 (Marginal Utility: 吞吐提升率 vs 延迟劣化率)
   * - SLA 体验上限惩罚 (P90 > 3.0s 触发排队惩罚)
   */
  calculateSweetSpot() {
    if (!this.concurrencyResults.length) {
      return {
        bestConcurrency: '无数据',
        score: 0,
        latency: 0,
        rps: 0,
        tpm: 0,
        confidence: '无数据',
        reason: '请先完成并发阶梯压测。'
      };
    }

    // 检查是否存在样本量低于并发度（脉冲单批次测试）
    const isPulseData = this.concurrencyResults.some(t => t.total < t.concurrency);

    let candidates = [];

    for (let i = 0; i < this.concurrencyResults.length; i++) {
      const tier = this.concurrencyResults[i];
      const prev = i > 0 ? this.concurrencyResults[i - 1] : null;

      // 硬性门槛：成功率必须 >= 90%，且 429 占比不得超过 5%
      const rateLimitRatio = tier.total > 0 ? (tier.rateLimit429Count / tier.total) : 0;
      if (tier.successRate < 90 || rateLimitRatio > 0.05) continue;

      const p90Sec = Math.max(0.1, tier.p90 || tier.avgDuration);
      const ttftSec = Math.max(0.05, tier.ttftP90 || tier.avgTtft || 0.2);

      // 基础效益 = (RPS * 成功率权重) / 延迟开方
      let baseScore = (tier.rps * (tier.successRate / 100)) / Math.pow(p90Sec, 0.55);

      // SLA 体验惩罚项：交互型对话场景 P90 超出 3s 开始按指数抑制得分
      if (p90Sec > 3.0) {
        baseScore = baseScore / Math.pow(p90Sec / 3.0, 1.2);
      }
      if (ttftSec > 2.5) {
        baseScore = baseScore / Math.pow(ttftSec / 2.5, 0.8);
      }

      // 边际效益评估 (Marginal Utility):
      // 若当前并发比上一档提升 >= 50%，但 RPS 提升率低于 15%，且 P90 延迟恶化超过 40%，则判定为边际效益衰竭
      let marginalExhausted = false;
      if (prev && prev.rps > 0) {
        const rpsGain = (tier.rps - prev.rps) / prev.rps;
        const latencyWorse = (tier.p90 - prev.p90) / Math.max(0.1, prev.p90);
        if (rpsGain < 0.15 && latencyWorse > 0.4) {
          marginalExhausted = true;
          baseScore = baseScore * 0.7; // 边际劣化降权
        }
      }

      candidates.push({
        tier,
        score: baseScore,
        marginalExhausted
      });
    }

    if (!candidates.length) {
      const fallback = this.concurrencyResults[0];
      return {
        bestConcurrency: fallback.concurrency,
        score: '0.00',
        latency: (fallback.p90 * 1000).toFixed(0),
        rps: fallback.rps.toFixed(1),
        tpm: Math.round(fallback.tpm),
        successRate: fallback.successRate.toFixed(1),
        confidence: '低 (由于高错误率或严重限流回退)',
        reason: `各测试档位可用性或限流率均未达到生产基线，建议回退至最低安全并发【${fallback.concurrency} 并发】。`
      };
    }

    // 按得分排序
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0].tier;
    const bestScore = candidates[0].score;

    let reason = `在【${best.concurrency} 并发】下综合效能最高：实际吞吐达到 ${best.rps.toFixed(1)} req/s (约 ${Math.round(best.rpm)} RPM / ${Math.round(best.tpm).toLocaleString()} TPM)，成功率保持在 ${best.successRate.toFixed(1)}%，P90 响应延迟为 ${best.p90.toFixed(2)}s (TTFT P90: ${(best.ttftP90 || best.avgTtft).toFixed(2)}s)。`;

    if (isPulseData) {
      reason += `\n⚠️ 【置信度提醒】：部分档位单档请求量小于目标并发数（处于脉冲突发测试态）。若要获取严苛的生产网关稳定配额，建议开启稳态闭环压测 (每档请求量 >= 并发数 × 1.2)。`;
    } else {
      reason += `\n✅ 经闭环稳态验证，此时 GPU Continuous Batching 处于最佳吞吐区间，尚未引发严重排队。`;
    }

    return {
      bestConcurrency: best.concurrency,
      score: bestScore.toFixed(2),
      latency: (best.p90 * 1000).toFixed(0),
      rps: best.rps.toFixed(1),
      tpm: Math.round(best.tpm),
      successRate: best.successRate.toFixed(1),
      confidence: isPulseData ? '中等 (脉冲采样)' : '高 (闭环稳态)',
      reason
    };
  }

  /**
   * 5. 诊断压力点 (精准识别 Prefill 排队拐点、Decode 瓶颈与配额熔断)
   */
  diagnosePressurePoints() {
    if (!this.concurrencyResults.length) {
      return {
        hasStressPoint: false,
        stressConcurrency: '未检出',
        first429: '无',
        latencySpike: '无',
        summary: '暂未检测到性能劣化点。'
      };
    }

    let first429Tier = null;
    let latencySpikeTier = null;
    let ttftSpikeTier = null;
    let highErrorTier = null;

    // 遍历并发梯度分析差分
    for (let i = 0; i < this.concurrencyResults.length; i++) {
      const cur = this.concurrencyResults[i];
      const prev = i > 0 ? this.concurrencyResults[i - 1] : null;

      // 1. 检查首个 429 限流点
      if (!first429Tier && cur.rateLimit429Count > 0) {
        first429Tier = cur;
      }

      // 2. 检查错误率升高点 (5xx 或超时)
      if (!highErrorTier && cur.successRate < 95) {
        highErrorTier = cur;
      }

      // 3. 检查首字 Prefill 延迟激增点 (GPU 算力或显存排队)
      if (!ttftSpikeTier && prev) {
        const prevTtft = prev.ttftP90 || prev.avgTtft;
        const curTtft = cur.ttftP90 || cur.avgTtft;
        if (prevTtft > 0 && (curTtft - prevTtft) / prevTtft >= 1.0 && curTtft > 3.0) {
          ttftSpikeTier = {
            tier: cur,
            prevTier: prev,
            ratio: Math.round(((curTtft - prevTtft) / prevTtft) * 100)
          };
        }
      }

      // 4. 检查总 P90 延迟急剧飙升点 (当前 P90 比上一档高出 80% 以上，且绝对值明显偏高)
      if (!latencySpikeTier && prev) {
        const latencyIncrease = cur.p90 - prev.p90;
        const increaseRatio = prev.p90 > 0 ? (latencyIncrease / prev.p90) : 0;
        if ((increaseRatio >= 0.8 && cur.p90 > 4.0) || (cur.p90 > 6.0 && prev.p90 <= 3.5)) {
          latencySpikeTier = {
            tier: cur,
            prevTier: prev,
            increaseRatio: Math.round(increaseRatio * 100)
          };
        }
      }
    }

    const hasStress = !!(first429Tier || latencySpikeTier || ttftSpikeTier || highErrorTier);
    let stressConcurrency = '运行平稳';
    let summaryParts = [];

    if (first429Tier) {
      stressConcurrency = `${first429Tier.concurrency} 并发 (限流)`;
      summaryParts.push(`🚨 **服务商配额熔断**：当并发升至【${first429Tier.concurrency}】时，首次触发 HTTP 429 速率限制 (该梯度触发 ${first429Tier.rateLimit429Count} 次拒绝)，已触及租户级 QPS/TPM 配额红线。生产网关必须配置前置令牌桶限流。`);
    }

    if (ttftSpikeTier) {
      if (stressConcurrency === '运行平稳') stressConcurrency = `${ttftSpikeTier.tier.concurrency} 并发 (Prefill排队)`;
      summaryParts.push(`⏱️ **首字排队拐点 (Prefill Bottleneck)**：从并发 ${ttftSpikeTier.prevTier.concurrency} 升至【${ttftSpikeTier.tier.concurrency}】时，首字延迟 (TTFT P90) 恶化了 +${ttftSpikeTier.ratio}%，表明 GPU 显存或计算核心已无法立即容纳新请求的 Prompt 计算，进入排队池。`);
    }

    if (latencySpikeTier) {
      if (stressConcurrency === '运行平稳') stressConcurrency = `${latencySpikeTier.tier.concurrency} 并发 (生成延迟骤增)`;
      summaryParts.push(`⚠️ **总延迟突变拐点 (Decode Bottleneck)**：从并发 ${latencySpikeTier.prevTier.concurrency} 增加到【${latencySpikeTier.tier.concurrency}】时，P90 延迟由 ${latencySpikeTier.prevTier.p90.toFixed(2)}s 激增至 ${latencySpikeTier.tier.p90.toFixed(2)}s (+${latencySpikeTier.increaseRatio}%)，表明 KV Cache 显存带宽饱和或批处理上下文切换开销超载。`);
    }

    if (highErrorTier && highErrorTier !== first429Tier) {
      summaryParts.push(`⚠️ **可用性跌落**：在并发【${highErrorTier.concurrency}】下，整体成功率跌至 ${highErrorTier.successRate.toFixed(1)}%，出现 5xx 内部错误或网络超时。`);
    }

    if (!hasStress) {
      const maxConc = this.concurrencyResults[this.concurrencyResults.length - 1].concurrency;
      summaryParts.push(`✅ **高抗压表现**：在测试的各并发梯度 (最高达到【${maxConc} 并发】) 下，服务表现平稳，成功率均在 95% 以上，未发生 429 拒收，亦未观察到显著延迟雪崩。当前配置仍有进一步施压空间。`);
    }

    return {
      hasStressPoint: hasStress,
      stressConcurrency,
      first429: first429Tier ? `${first429Tier.concurrency} 并发 (${first429Tier.rateLimit429Count}次)` : '无 429',
      latencySpike: latencySpikeTier ? `${latencySpikeTier.tier.concurrency} 并发 (+${latencySpikeTier.increaseRatio}%)` : (ttftSpikeTier ? `${ttftSpikeTier.tier.concurrency} (TTFT+${ttftSpikeTier.ratio}%)` : '平缓'),
      summary: summaryParts.join('\n\n')
    };
  }

  /**
   * 生成完整 Markdown 格式的全方位评测报告
   */
  generateMarkdownReport(modelName = 'Unknown Model') {
    const ctx = this.analyzeContextWindow();
    const out = this.analyzeMaxOutput();
    const tp = this.analyzeThroughput();
    const sweet = this.calculateSweetSpot();
    const stress = this.diagnosePressurePoints();

    const dateStr = new Date().toLocaleString();

    let md = `# 📊 大语言模型 API 全方位性能压力与极限基准评测报告\n\n`;
    md += `- **测试模型**：\`${modelName}\`\n`;
    md += `- **测试时间**：${dateStr}\n`;
    md += `- **压测总请求量**：${tp.totalCompleted} 次\n\n`;

    md += `## 🎯 核心指标画像概览\n\n`;
    md += `| 评测维度 | 实测数值 | 结论与说明 |\n`;
    md += `| :--- | :--- | :--- |\n`;
    md += `| **实际最大上下文** | **${ctx.maxTierLabel || '未测试'}** | ${ctx.summary} |\n`;
    md += `| **实际最大单次输出** | **${out.maxTokens ? out.maxTokens.toLocaleString() + ' tok' : '未测试'}** | ${out.summary} |\n`;
    md += `| **实测峰值吞吐 RPM** | **${tp.peakRpm} RPM** | 峰值每秒请求数 (RPS): ${tp.peakRps} req/s |\n`;
    md += `| **实测峰值吞吐 TPM** | **${tp.peakTpm.toLocaleString()} TPM** | 纯生成速率峰值: ${tp.peakTps} tok/s |\n`;
    md += `| **最适合的并发度** | **【${sweet.bestConcurrency} 并发】** | 黄金平衡点 (P90延迟: ${sweet.latency}ms, RPS: ${sweet.rps}) |\n`;
    md += `| **压力突变/限流点** | **${stress.stressConcurrency}** | ${stress.first429 !== '无 429' ? '触发 429 限流' : '延迟陡增拐点'} |\n\n`;

    md += `## ⚖️ 1. 最佳并发与压力点深度诊断\n\n`;
    md += `### 💡 最佳并发推荐点 (Sweet Spot)\n`;
    md += `${sweet.reason}\n\n`;
    md += `### 🚨 压力点与瓶颈定位 (Bottlenecks)\n`;
    md += `${stress.summary}\n\n`;

    md += `## 📈 2. 各并发档位性能实测阶梯表 (5 / 10 / 20 / 50 / 100)\n\n`;
    md += `| 并发数 | 稳态采样数 | 成功率 | RPS | 实际 TPM | 生成 TPS | TTFT P90 | P50 延迟 | P90 延迟 | 429 拒收 | 评级 |\n`;
    md += `| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;
    for (const t of this.concurrencyResults) {
      const ttft90 = (t.ttftP90 || t.avgTtft || 0).toFixed(2);
      md += `| ${t.concurrency} | ${t.total} | ${t.successRate.toFixed(1)}% | ${t.rps.toFixed(1)} | ${Math.round(t.tpm).toLocaleString()} | ${t.tps.toFixed(1)} | ${ttft90}s | ${t.p50.toFixed(2)}s | ${t.p90.toFixed(2)}s | ${t.rateLimit429Count} | ${t.grade} |\n`;
    }
    md += `\n`;

    if (this.contextResults.length > 0) {
      md += `## 📚 3. 长上下文阶梯 (64k - 1M) 极限测试表\n\n`;
      md += `| 梯度 | 标称 Tokens | 状态码 | 首字延迟 (TTFT) | 总响应耗时 | 针尖探针命中 | 结果判定 |\n`;
      md += `| :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;
      for (const c of this.contextResults) {
        md += `| ${c.tierLabel} | ~${c.inputTokens?.toLocaleString()} | ${c.status} | ${c.ttft ? c.ttft.toFixed(2) + 's' : '-'} | ${c.duration.toFixed(2)}s | ${c.needleHit ? '✅ 命中' : '❌ 未命中'} | ${c.ok ? '成功支持' : '超出上限/拒绝'} |\n`;
      }
      md += `\n`;
    }

    md += `## 📝 4. 大模型综合性能评测与数据结论\n\n`;
    md += `1. **并发与吞吐表现**：在测试梯度中，该模型在 **${sweet.bestConcurrency} 并发** 下达到最佳效能平衡点，此时实测吞吐为 **${sweet.rps} req/s**（约 **${sweet.tpm.toLocaleString()} TPM**），P90 响应延迟维持在 **${sweet.latency}ms**。\n`;
    if (ctx.tested && ctx.maxSupportedK) {
      md += `2. **长文本注意力承载能力**：实测长上下文物理连通与深度隐秘针尖校验最高可达 **${ctx.maxTierLabel}**（实际输入约 **${ctx.maxSafeTokens?.toLocaleString()} Tokens**），在极限长窗口 Prefill 阶段表现出极佳的注意力集中度与上下文还原力。\n`;
    }
    if (out.tested && out.maxTokens) {
      md += `3. **单次极限生成容量**：该模型单次最多可吐出 **${out.maxTokens.toLocaleString()} Tokens**，持续解码生成速率达到 **${out.speedTps} tok/s**，具备稳健的长程文本输出能力。\n`;
    }
    md += `\n---\n*由 IceBreaker 生成 · 数据仅代表测试时刻状态*`;

    return md;
  }
}

// 挂载全局分析器
window.benchmarkAnalyzer = new BenchmarkAnalyzer();
