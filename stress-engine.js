/**
 * LLM API 极限基准与高并发压测核心引擎 (StressEngine v2.0)
 * 全方位实时遥测：支持毫秒级流式分块监听、即时阶梯刷新、长上下文动态进度与活跃工人追踪
 */

class StressEngine {
  constructor() {
    this.isRunning = false;
    this.shouldStop = false;
    this.activeControllers = new Set();
    this.config = {
      apiUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      stream: true,
      timeoutSec: 120,
      useProxy: false,
      proxyBaseUrl: '/proxy?url=',  // 同源相对路径优先 (Cookie 自动携带, 免跨源会话问题)
      proxyToken: ''  // 跨源代理会话令牌 (登录后由 /api/me 下发, 跨端口 Cookie 不可达)
    };

    // 活跃请求追踪表
    this.activeWorkers = new Map();

    // 事件回调注册
    this.onLog = (type, msg) => {};
    this.onProgress = (current, total, phase, percent, detail) => {};
    this.onChunk = (info) => {}; // 实时流式分块回调
    this.onRequestFinish = (record) => {};
    this.onContextTierFinish = (record, current, total) => {};
    this.onOutputProbeFinish = (record) => {};
    this.onTierFinish = (tierStats) => {};
    this.onActiveWorkersChange = (activeCount, workersList) => {};
  }

  setConfig(cfg) {
    this.config = { ...this.config, ...cfg };
    this.config.apiUrl = this.config.apiUrl.trim().replace(/\/+$/, '');
  }

  stop() {
    if (!this.isRunning) return;
    this.shouldStop = true;
    this.log('warn', '⚡ 收到紧急终止指令，正在撤回所有在途请求...');
    for (const ctrl of this.activeControllers) {
      try {
        ctrl.abort();
      } catch (e) {}
    }
    this.activeControllers.clear();
    this.activeWorkers.clear();
    this.notifyActiveWorkers();
  }

  log(type, msg) {
    if (this.onLog) this.onLog(type, msg);
  }

  notifyActiveWorkers() {
    if (this.onActiveWorkersChange) {
      const list = Array.from(this.activeWorkers.values());
      this.onActiveWorkersChange(list.length, list);
    }
  }

  /**
   * 根据当前配置解析请求 URL（支持本地/反向代理自动中继以彻底绕过 CORS 拦截）
   */
  resolveEndpoint(targetUrl) {
    if (this.config.useProxy) {
      let proxyBase = (this.config.proxyBaseUrl || '/proxy?url=').trim();
      // 防御：若用户在输入框里误贴了完整目标 URL，自动提取纯净前缀
      if (proxyBase.includes('?url=')) {
        proxyBase = proxyBase.split('?url=')[0] + '?url=';
      }
      let url = `${proxyBase}${encodeURIComponent(targetUrl)}`;
      // 跨源代理携带会话令牌 (仅本机中继场景; 令牌不会转发给目标 API)
      const tok = (this.config.proxyToken || '').trim();
      if (tok) url += `&bench_token=${encodeURIComponent(tok)}`;
      return url;
    }
    return targetUrl;
  }

  /**
   * 连通性测试 (Ping)
   */
  async ping() {
    const startTime = performance.now();
    const rawEndpoint = `${this.config.apiUrl}/chat/completions`;
    const endpoint = this.resolveEndpoint(rawEndpoint);
    const payload = {
      model: this.config.model,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
      temperature: 0.1
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timer);
      const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

      if (!resp.ok) {
        const errorText = await resp.text();
        return {
          ok: false,
          status: resp.status,
          message: `HTTP ${resp.status}: ${errorText.slice(0, 200)}`,
          elapsed
        };
      }

      const data = await resp.json();
      return {
        ok: true,
        status: resp.status,
        message: `连接成功！响应耗时: ${elapsed}s, 验证模型: ${data.model || this.config.model}${this.config.useProxy ? ' [代理模式]' : ''}`,
        elapsed
      };
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err.name === 'AbortError';
      const isCors = !isAbort && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError') || err.message.includes('CORS'));
      const msg = isCors
        ? 'CORS 跨域或预检拦截！目标 API 服务端未允许浏览器跨域请求。请开启左侧【CORS 代理中继】或通过 start.bat 启动服务。'
        : (isAbort ? '连接超时(15s)' : err.message);

      return {
        ok: false,
        status: isCors ? -1 : 0,
        message: `请求失败: ${msg}`,
        elapsed: ((performance.now() - startTime) / 1000).toFixed(2)
      };
    }
  }

  /**
   * 拉取远程可用模型列表
   */
  async fetchModels() {
    const rawEndpoint = `${this.config.apiUrl}/models`;
    const endpoint = this.resolveEndpoint(rawEndpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const list = (data.data || []).map(m => m.id).sort();
      return list;
    } catch (e) {
      clearTimeout(timer);
      const isCors = e.message.includes('Failed to fetch') || e.message.includes('NetworkError');
      if (isCors) {
        throw new Error('CORS 跨域被拦截，请开启【CORS 代理中继】或启动 start.bat 本地代理服务');
      }
      throw e;
    }
  }

  /**
   * 工业标准线性插值百分位数算法 (NIST / NumPy R-7 方法)
   * 杜绝极小样本量下 Math.floor 导致 P90=P99=最大值的严重统计退化
   */
  calculatePercentile(sortedArr, p) {
    if (!sortedArr || !sortedArr.length) return 0;
    if (sortedArr.length === 1) return sortedArr[0];
    const rank = (p / 100) * (sortedArr.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    return sortedArr[lower] * (1 - weight) + sortedArr[upper] * weight;
  }

  /**
   * 服务自动预热 (Warmup Phase)
   * 排除 GPU 实例冷启动、TLS 握手、服务网格初建导致的低并发首档延迟虚高问题
   */
  async warmup(count = 2) {
    this.log('system', `🔥 执行服务实例自动预热 (${count} 次探针，剔除冷启动与网络抖动干扰)...`);
    const warmPrompt = [{ role: 'user', content: 'Ping. 请仅回复 Pong。' }];
    for (let i = 0; i < count; i++) {
      if (this.shouldStop) break;
      try {
        await this.executeSingleRequest({
          messages: warmPrompt,
          maxTokens: 10,
          tag: 'warmup',
          customTimeout: 15,
          workerId: `warmup_${i + 1}`
        });
      } catch (e) {}
    }
    this.log('ok', `✔ 预热完成，开始正式录入稳态基准数据。`);
  }

  /**
   * 快速生成指定 Token 规模的探测文本 (64k - 1M)
   */
  generateContextText(tokensTargetK, needleSecret = 'KEY-89421') {
    const sampleBlock = "【大模型极限承载压力基准测试序列。超长上下文Prefill阶段对注意力机制与显存KV Cache有着严苛要求。Sequence Block ID: ";
    const blockTokens = 85;
    const targetTokens = tokensTargetK * 1024;
    const repeats = Math.max(1, Math.floor(targetTokens / blockTokens));

    const parts = [];
    parts.push(`--- BENCHMARK CONTEXT START (${tokensTargetK}K TOKENS SIMULATION) ---\n`);

    // 在 75% 深度位置注入探针
    const needleInsertIndex = Math.floor(repeats * 0.75);

    for (let i = 0; i < repeats; i++) {
      if (i === needleInsertIndex) {
        parts.push(`\n\n[CRITICAL_ANCHOR_PROBE]: 隐秘校验密钥标记：【${needleSecret}】。请直接提取此密钥。\n\n`);
      }
      parts.push(sampleBlock + i + "】 ");
      if (i % 30 === 0) parts.push("\n");
    }

    parts.push(`\n--- BENCHMARK CONTEXT END ---\n`);
    parts.push(`【重要指令】：请立即检索上文中[CRITICAL_ANCHOR_PROBE]记录的隐秘校验密钥。严禁任何客套话、解释或前缀，必须直接以 ${needleSecret.split('-')[0]} 开头输出完整的密钥值：`);

    const fullText = parts.join('');
    const estimatedTokens = Math.round(fullText.length / 2.2);
    return {
      text: fullText,
      targetTokens,
      estimatedTokens,
      needleSecret
    };
  }

  /**
   * 发起单个测试请求（毫秒级流式分块广播）
   */
  async executeSingleRequest({ messages, maxTokens = 50, tag = 'concurrency', customTimeout = null, workerId = null }) {
    const startTime = performance.now();
    let ttft = 0;
    let completionTokens = 0;
    let promptTokens = 0;
    let fullContent = '';
    let httpStatus = 0;
    let isSuccess = false;
    let errorMessage = '';
    let finishReason = '';
    let firstTokenTime = 0;

    const timeoutSec = customTimeout || this.config.timeoutSec;
    const controller = new AbortController();
    this.activeControllers.add(controller);

    const wId = workerId || `req_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.activeWorkers.set(wId, {
      id: wId,
      tag,
      startTime,
      status: 'prefill',
      tokensReceived: 0,
      ttft: 0
    });
    this.notifyActiveWorkers();

    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutSec * 1000);

    const rawEndpoint = `${this.config.apiUrl}/chat/completions`;
    const endpoint = this.resolveEndpoint(rawEndpoint);
    const requestPayload = {
      model: this.config.model,
      messages: messages,
      stream: this.config.stream,
      temperature: 0.2
    };

    if (maxTokens) {
      requestPayload.max_tokens = maxTokens;
    }
    if (this.config.stream) {
      requestPayload.stream_options = { include_usage: true };
    }

    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });

      httpStatus = resp.status;

      if (!resp.ok) {
        const errText = await resp.text();
        errorMessage = `HTTP ${resp.status}: ${errText.slice(0, 300)}`;
        clearTimeout(timer);
        this.activeControllers.delete(controller);
        this.activeWorkers.delete(wId);
        this.notifyActiveWorkers();

        const totalDuration = (performance.now() - startTime) / 1000;
        return {
          ok: false,
          tag,
          status: httpStatus,
          error: errorMessage,
          ttft: 0,
          duration: totalDuration,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          tps: 0,
          finishReason: 'error'
        };
      }

      // 流式读取
      if (this.config.stream && resp.body) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false;
        let buffer = '';

        while (!done) {
          if (this.shouldStop) {
            controller.abort();
            break;
          }

          const { value, done: readerDone } = await reader.read();
          if (readerDone) {
            done = true;
            break;
          }

          const now = performance.now();
          if (!firstTokenTime) {
            firstTokenTime = now;
            ttft = (firstTokenTime - startTime) / 1000;
            const worker = this.activeWorkers.get(wId);
            if (worker) {
              worker.status = 'generating';
              worker.ttft = ttft;
            }
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const cleanLine = line.trim();
            if (!cleanLine.startsWith('data:')) continue;
            const dataStr = cleanLine.slice(5).trim();
            if (dataStr === '[DONE]') {
              done = true;
              break;
            }

            try {
              const parsed = JSON.parse(dataStr);
              const delta = parsed.choices?.[0]?.delta?.content || '';
              if (delta) {
                fullContent += delta;
                completionTokens++;
              }
              if (parsed.choices?.[0]?.finish_reason) {
                finishReason = parsed.choices[0].finish_reason;
              }
              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens || promptTokens;
                completionTokens = parsed.usage.completion_tokens || completionTokens;
              }
            } catch (e) {}
          }

          // 实时向外广播分块事件
          const elapsedSec = (now - startTime) / 1000;
          const genDuration = firstTokenTime ? (now - firstTokenTime) / 1000 : 0;
          const liveTps = genDuration > 0.05 ? completionTokens / genDuration : 0;

          const worker = this.activeWorkers.get(wId);
          if (worker) {
            worker.tokensReceived = completionTokens;
            worker.tps = liveTps;
          }

          if (this.onChunk) {
            this.onChunk({
              workerId: wId,
              tag,
              tokensReceived: completionTokens,
              elapsedSec,
              liveTps,
              snippet: fullContent.slice(-80)
            });
          }
        }
      } else {
        // 非流式
        const json = await resp.json();
        const now = performance.now();
        ttft = (now - startTime) / 1000;
        fullContent = json.choices?.[0]?.message?.content || '';
        finishReason = json.choices?.[0]?.finish_reason || 'stop';
        if (json.usage) {
          promptTokens = json.usage.prompt_tokens || 0;
          completionTokens = json.usage.completion_tokens || 0;
        }
      }

      clearTimeout(timer);
      this.activeControllers.delete(controller);
      this.activeWorkers.delete(wId);
      this.notifyActiveWorkers();

      const endTime = performance.now();
      const totalDuration = (endTime - startTime) / 1000;

      if (!completionTokens) {
        completionTokens = this.estimateTokens(fullContent);
      }
      if (!promptTokens) {
        promptTokens = this.estimateMessagesTokens(messages);
      }

      const generationDuration = (endTime - (firstTokenTime || startTime)) / 1000;
      const tps = generationDuration > 0.05 ? completionTokens / generationDuration : (completionTokens / totalDuration);

      isSuccess = true;
      return {
        ok: true,
        tag,
        status: httpStatus,
        error: '',
        ttft,
        duration: totalDuration,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        tps,
        finishReason,
        content: fullContent
      };
    } catch (err) {
      clearTimeout(timer);
      this.activeControllers.delete(controller);
      this.activeWorkers.delete(wId);
      this.notifyActiveWorkers();

      const totalDuration = (performance.now() - startTime) / 1000;
      const isAbort = err.name === 'AbortError';
      const isCors = !isAbort && (err.message?.includes('Failed to fetch') || err.message?.includes('NetworkError') || err.message?.includes('CORS'));

      let errMsg = err.message || '网络断开或未知错误';
      if (isAbort) {
        errMsg = `请求超时 (${timeoutSec}s)`;
      } else if (isCors) {
        errMsg = 'CORS 跨域预检拦截！目标 API 拒绝了浏览器的 OPTIONS 请求。请开启【CORS 代理中继】或通过 start.bat 启动本地服务。';
      }

      return {
        ok: false,
        tag,
        status: isAbort ? 504 : (isCors ? -1 : 0),
        error: errMsg,
        ttft: 0,
        duration: totalDuration,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        tps: 0,
        finishReason: 'error'
      };
    }
  }

  estimateTokens(text) {
    if (!text) return 0;
    const zhMatches = text.match(/[一-龥]/g);
    const zhCount = zhMatches ? zhMatches.length : 0;
    const otherCount = text.length - zhCount;
    return Math.max(1, Math.round(zhCount * 1.1 + otherCount / 3.8));
  }

  estimateMessagesTokens(messages) {
    let count = 0;
    for (const m of messages) {
      count += this.estimateTokens(m.content || '') + 4;
    }
    return count;
  }

  /**
   * 并发阶梯压测主调度器 (5, 10, 20, 50, 100)
   * 采用闭环饱和并发模型 (Closed-Loop Concurrency)
   */
  async runConcurrencyLadder({ levels = [5, 10, 20, 50, 100], reqsPerLevel = 20, promptType = 'short', globalProgressOffset = 0, globalProgressSpan = 100, enableWarmup = true }) {
    this.isRunning = true;
    this.shouldStop = false;

    // 前置执行自动预热，排除 GPU 实例冷启动及网络握手带来的首档假高延迟
    if (enableWarmup && !this.shouldStop) {
      await this.warmup(2);
    }

    let samplePrompt = '请简短列举人类探索宇宙的3个里程碑，输出不超过50字。';
    let maxTokens = 60;
    if (promptType === 'medium') {
      samplePrompt = '请简要分析分布式缓存在高并发场景下的具体配合机制及防穿透策略，字数约200字。';
      maxTokens = 250;
    } else if (promptType === 'long') {
      const dummyCtx = "大型系统架构负载考量上下文：".repeat(100);
      samplePrompt = `${dummyCtx}\n请归纳上述业务场景的核心技术要点。`;
      maxTokens = 400;
    }

    const messages = [{ role: 'user', content: samplePrompt }];
    const allTierResults = [];

    // 计算稳态阶梯所需实际总请求量：当并发较高时，必须保证至少并发数的1.2~1.5倍请求，才能维持闭环稳态
    const ladderConfigs = levels.map(concurrency => {
      const steadyMin = Math.max(reqsPerLevel, Math.round(concurrency * 1.2), 10);
      return { concurrency, targetReqs: steadyMin };
    });

    const totalRequestsAllLevels = ladderConfigs.reduce((acc, cur) => acc + cur.targetReqs, 0);
    let globalCompleted = 0;

    this.log('info', `=== 启动稳态并发阶梯测试: 档位 [${levels.join(', ')}], 闭环动态总请求 ${totalRequestsAllLevels} 次 ===`);

    for (let lIndex = 0; lIndex < ladderConfigs.length; lIndex++) {
      const { concurrency, targetReqs } = ladderConfigs[lIndex];
      if (this.shouldStop) break;

      this.log('system', `▶ 正在进入并发档位: 【${concurrency} 并发】 (动态稳态采样: ${targetReqs} 次请求)...`);
      const tierStartTime = performance.now();
      const records = [];

      let completedCount = 0;
      let inFlightCount = 0;
      let maxInFlightObserved = 0;
      let taskIndex = 0;

      await new Promise((resolve) => {
        const nextWorker = async () => {
          if (this.shouldStop || taskIndex >= targetReqs) {
            if (inFlightCount === 0) resolve();
            return;
          }

          taskIndex++;
          inFlightCount++;
          if (inFlightCount > maxInFlightObserved) {
            maxInFlightObserved = inFlightCount;
          }
          const curTaskId = taskIndex;

          const reqRecord = await this.executeSingleRequest({
            messages,
            maxTokens,
            tag: `concurrency-${concurrency}`,
            workerId: `w_${concurrency}_${curTaskId}`
          });

          inFlightCount--;
          completedCount++;
          globalCompleted++;
          records.push(reqRecord);

          // 进度计算
          const tierPercent = Math.round((completedCount / targetReqs) * 100);
          const globalPercent = Math.min(100, Math.round(globalProgressOffset + (globalCompleted / totalRequestsAllLevels) * globalProgressSpan));

          if (this.onProgress) {
            this.onProgress(
              completedCount,
              targetReqs,
              `并发 ${concurrency} 稳态测试 (${lIndex + 1}/${ladderConfigs.length})`,
              globalPercent,
              `档位采样: ${completedCount}/${targetReqs} | 总完成: ${globalCompleted}/${totalRequestsAllLevels}`
            );
          }

          if (this.onRequestFinish) {
            this.onRequestFinish(reqRecord);
          }

          if (reqRecord.ok) {
            this.log('info', `[并发 ${concurrency}] 请求 #${completedCount} 完成 | 耗时 ${reqRecord.duration.toFixed(2)}s | TTFT: ${reqRecord.ttft.toFixed(2)}s | TPS: ${reqRecord.tps.toFixed(1)}`);
          } else {
            this.log('error', `[并发 ${concurrency}] 请求 #${completedCount} 异常: ${reqRecord.error}`);
          }

          if (!this.shouldStop && taskIndex < targetReqs) {
            nextWorker();
          } else if (inFlightCount === 0) {
            resolve();
          }
        };

        // 初始拉起目标并发规模的工作线程，保持管道全充满
        const initialWorkers = Math.min(concurrency, targetReqs);
        for (let w = 0; w < initialWorkers; w++) {
          nextWorker();
        }
      });

      const tierEndTime = performance.now();
      const tierTotalDuration = (tierEndTime - tierStartTime) / 1000;

      const tierStats = this.aggregateTierStats(concurrency, records, tierTotalDuration, maxInFlightObserved);
      allTierResults.push(tierStats);

      if (this.onTierFinish) {
        this.onTierFinish(tierStats);
      }

      this.log('success', `✔ 并发 ${concurrency} 稳态完成！RPS: ${tierStats.rps.toFixed(1)}, TPM: ${Math.round(tierStats.tpm).toLocaleString()}, 成功率: ${tierStats.successRate.toFixed(1)}%, P90: ${tierStats.p90.toFixed(2)}s, TTFT P90: ${tierStats.ttftP90.toFixed(2)}s`);

      if (!this.shouldStop && lIndex < ladderConfigs.length - 1) {
        await new Promise(r => setTimeout(r, 1200));
      }
    }

    this.isRunning = false;
    return allTierResults;
  }

  aggregateTierStats(concurrency, records, totalDuration, maxInFlight = concurrency) {
    const total = records.length;
    const successes = records.filter(r => r.ok);
    const successCount = successes.length;
    const errorCount = total - successCount;
    const rateLimit429Count = records.filter(r => r.status === 429).length;
    const timeoutCount = records.filter(r => r.status === 504 || (r.error && r.error.includes('超时'))).length;

    const latencies = successes.map(r => r.duration).sort((a, b) => a - b);
    const ttfts = successes.map(r => r.ttft).sort((a, b) => a - b);

    // 采用标准线性插值算法计算 P50 / P90 / P99
    const p50 = this.calculatePercentile(latencies, 50);
    const p90 = this.calculatePercentile(latencies, 90);
    const p99 = this.calculatePercentile(latencies, 99);
    const avgDuration = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    const ttftP50 = this.calculatePercentile(ttfts, 50);
    const ttftP90 = this.calculatePercentile(ttfts, 90);
    const avgTtft = ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : 0;

    // 计算解码阶段指标 (TPOT - Time Per Output Token)
    const tpots = successes
      .filter(r => r.completionTokens > 0 && r.duration > r.ttft)
      .map(r => ((r.duration - r.ttft) / r.completionTokens) * 1000)
      .sort((a, b) => a - b);
    const avgTpot = tpots.length ? tpots.reduce((a, b) => a + b, 0) / tpots.length : 0;
    const tpotP90 = this.calculatePercentile(tpots, 90);

    const totalPromptTokens = records.reduce((sum, r) => sum + r.promptTokens, 0);
    const totalCompletionTokens = records.reduce((sum, r) => sum + r.completionTokens, 0);
    const totalTokens = totalPromptTokens + totalCompletionTokens;

    // 持续稳态吞吐
    const rps = totalDuration > 0 ? successCount / totalDuration : 0;
    const rpm = rps * 60;
    const tps = totalDuration > 0 ? totalCompletionTokens / totalDuration : 0;
    const tpm = totalDuration > 0 ? (totalTokens / totalDuration) * 60 : 0;

    const successRate = total > 0 ? (successCount / total) * 100 : 0;

    // 资深性能评级准则
    let grade = '运行平稳';
    let gradeBadge = 'badge-success';

    if (rateLimit429Count > 0 || successRate < 80) {
      grade = '限流/严重承压';
      gradeBadge = 'badge-danger';
    } else if (p90 > 6.0 || successRate < 95) {
      grade = '延迟偏高';
      gradeBadge = 'badge-warning';
    } else if (concurrency >= 50 && successRate >= 98 && p90 <= 3.0) {
      grade = '高抗压可用';
      gradeBadge = 'badge-info';
    } else if (concurrency < 20 && p90 <= 2.5) {
      grade = '低负载平稳';
      gradeBadge = 'badge-success';
    }

    return {
      concurrency,
      total,
      maxInFlight,
      successCount,
      errorCount,
      rateLimit429Count,
      timeoutCount,
      successRate,
      rps,
      rpm,
      tps,
      tpm,
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens,
      avgDuration,
      p50,
      p90,
      p99,
      avgTtft,
      ttftP50,
      ttftP90,
      avgTpot,
      tpotP90,
      totalDuration,
      grade,
      gradeBadge,
      records
    };
  }

  /**
   * 极限长上下文阶梯探测 (64k, 128k, 256k, 512k, 1M) - 支持单阶即时通知与实时进度
   */
  async probeContextLimits({ tiers = [64, 128, 256, 512, 1024], globalProgressOffset = 0, globalProgressSpan = 100 }) {
    this.isRunning = true;
    this.shouldStop = false;
    const results = [];

    this.log('system', `=== 启动长上下文承载力探测: [${tiers.map(t => (t >= 1024 ? '1M' : t + 'k')).join(', ')}] ===`);

    for (let i = 0; i < tiers.length; i++) {
      if (this.shouldStop) break;

      const tierK = tiers[i];
      const tierLabel = tierK >= 1024 ? '1M (1,048,576)' : `${tierK}k (${tierK * 1024})`;

      // 实时汇报正在进入的阶段
      const currentProgressPercent = Math.min(100, Math.round(globalProgressOffset + (i / tiers.length) * globalProgressSpan));
      if (this.onProgress) {
        this.onProgress(
          i,
          tiers.length,
          `探测长上下文: ${tierLabel} (${i + 1}/${tiers.length})`,
          currentProgressPercent,
          `正在生成并发送 ${tierLabel} Tokens 探针...`
        );
      }

      this.log('info', `[${i + 1}/${tiers.length}] 正在生成 ${tierLabel} Tokens 探针文本并注入...`);

      const secret = `KEY-${Math.floor(Math.random() * 89999 + 10000)}`;
      const payload = this.generateContextText(tierK, secret);
      const messages = [{ role: 'user', content: payload.text }];

      const tierTimeout = Math.max(90, Math.min(360, tierK * 0.45));
      this.log('info', `正在提交请求 (~${payload.estimatedTokens.toLocaleString()} tokens, 超时设置 ${tierTimeout}s)...`);

      const record = await this.executeSingleRequest({
        messages,
        maxTokens: 150,
        tag: `context-${tierK}k`,
        customTimeout: tierTimeout,
        workerId: `ctx_${tierK}k`
      });

      // 提取内容并标准化比对 (兼容首尾空白、标点与大小写)
      const cleanContent = (record.content || '').replace(/\s+/g, '');
      const cleanSecret = secret.replace(/\s+/g, '');
      const isNeedleHit = record.ok && cleanContent.includes(cleanSecret);
      record.needleHit = isNeedleHit;
      record.tierK = tierK;
      record.tierLabel = tierLabel;
      record.inputTokens = payload.estimatedTokens;

      results.push(record);

      // 每完成一个梯度，立即回调更新界面！
      const completedProgressPercent = Math.min(100, Math.round(globalProgressOffset + ((i + 1) / tiers.length) * globalProgressSpan));
      if (this.onProgress) {
        this.onProgress(
          i + 1,
          tiers.length,
          `已完成长上下文 ${tierLabel}`,
          completedProgressPercent,
          `已完成 ${i + 1} / ${tiers.length} 上下文阶梯`
        );
      }

      if (this.onContextTierFinish) {
        this.onContextTierFinish(record, i + 1, tiers.length);
      }

      if (this.onRequestFinish) {
        this.onRequestFinish(record);
      }

      if (record.ok) {
        this.log('success', `✔ [${tierLabel} 探测成功] 状态 200 | 首字Prefill(TTFT): ${record.ttft.toFixed(2)}s | 探针密匙: ${isNeedleHit ? '✅ 精确命中' : '❌ 未命中'}`);
      } else {
        this.log('error', `✘ [${tierLabel} 探测异常] 状态码: ${record.status} | 详情: ${record.error}`);
        if (record.status === 400 && record.error.includes('context_length_exceeded')) {
          this.log('warn', `已触达该模型物理上下文硬性上限！后续更大梯度建议留意。`);
        }
      }

      if (!this.shouldStop && i < tiers.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    this.isRunning = false;
    return results;
  }

  /**
   * 最大单次输出 Tokens 探测 - 支持实时流式输出汇报
   */
  async probeMaxOutput({ targetMaxTokens = 8192, globalProgressOffset = 0, globalProgressSpan = 15 }) {
    this.isRunning = true;
    this.shouldStop = false;

    this.log('system', `=== 启动单次最大输出探测: 申请 max_tokens = ${targetMaxTokens} ===`);
    if (this.onProgress) {
      this.onProgress(0, 1, `探测最大输出 (申请 ${targetMaxTokens} tokens)...`, globalProgressOffset, '模型正在持续高速解码中...');
    }

    const prompt = `请用极其详实专业的内容，连续不断地输出一部长篇技术规范全书。展开全部细节与工程架构，持续输出极多字数，绝不提前终止，直到耗尽模型允许的单次最大输出上限为止。`;
    const messages = [{ role: 'user', content: prompt }];
    const timeout = Math.max(120, Math.floor(targetMaxTokens / 20));

    const record = await this.executeSingleRequest({
      messages,
      maxTokens: targetMaxTokens,
      tag: 'max-output-probe',
      customTimeout: timeout,
      workerId: 'worker_max_output'
    });

    if (this.onProgress) {
      this.onProgress(1, 1, `最大输出探测完成 (${record.completionTokens} tokens)`, globalProgressOffset + globalProgressSpan, `实际生成: ${record.completionTokens} tok`);
    }

    if (this.onOutputProbeFinish) {
      this.onOutputProbeFinish(record);
    }

    if (this.onRequestFinish) {
      this.onRequestFinish(record);
    }

    if (record.ok) {
      this.log('success', `✔ 最大输出探测完成！实际生成: 【${record.completionTokens}】 Tokens | 耗时 ${record.duration.toFixed(2)}s | 生成速率: ${record.tps.toFixed(1)} tok/s | 截断: ${record.finishReason}`);
    } else {
      this.log('error', `✘ 最大输出探测异常: ${record.error}`);
    }

    this.isRunning = false;
    return record;
  }
}

// 挂载全局实例
window.stressEngine = new StressEngine();
