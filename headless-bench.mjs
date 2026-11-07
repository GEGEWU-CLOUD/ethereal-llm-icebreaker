#!/usr/bin/env node
/**
 * 无头压测驱动器 —— 直接加载本项目自带的 stress-engine.js + analyzer.js 原班引擎代码
 * 用途：在终端/CI 环境下对 OpenAI 兼容端点 (vLLM 等) 执行与浏览器端完全一致的全套压测
 *
 * 用法:
 *   node headless-bench.mjs --api http://172.26.1.14:8080/v1 --model deepseek-r1-distill-qwen-7b
 *   node headless-bench.mjs --quick          # 快速模式 (并发档位 1/5/10/20)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 解析命令行参数 ----------
const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const QUICK = args.includes('--quick');

const CFG = {
  api: getArg('api', 'http://172.26.1.14:8080/v1'),
  key: getArg('key', 'EMPTY'),
  model: getArg('model', 'deepseek-r1-distill-qwen-7b'),
  levels: QUICK ? [1, 5, 10, 20] : [1, 5, 10, 20, 50, 100],
  reqsPerLevel: parseInt(getArg('reqs', '20'), 10),
  maxOutputTokens: parseInt(getArg('maxout', '8192'), 10),
  ctxTiers: (getArg('ctx', QUICK ? '4,8' : '4,8,16,32')).split(',').map(Number),
  ctxMaxTokens: parseInt(getArg('ctxout', '512'), 10),
  timeoutSec: parseInt(getArg('timeout', '150'), 10)
};

// ---------- 加载项目原生引擎 (浏览器全局 window 垫片) ----------
globalThis.window = globalThis;
(0, eval)(readFileSync(path.join(__dirname, 'stress-engine.js'), 'utf-8'));
(0, eval)(readFileSync(path.join(__dirname, 'analyzer.js'), 'utf-8'));

const engine = window.stressEngine;
const analyzer = window.benchmarkAnalyzer;

engine.setConfig({
  apiUrl: CFG.api,
  apiKey: CFG.key,
  model: CFG.model,
  stream: true,
  timeoutSec: CFG.timeoutSec,
  useProxy: false
});

// ---------- 输出目录与日志 ----------
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.join(__dirname, 'bench-results');
mkdirSync(outDir, { recursive: true });
const logPath = path.join(outDir, `run-${stamp}.log`);
const logLines = [];
const writeLog = () => writeFileSync(logPath, logLines.join('\n'), 'utf-8');

let infoCount = 0;
engine.onLog = (type, msg) => {
  const line = `[${new Date().toLocaleTimeString()}][${type}] ${msg}`;
  logLines.push(line);
  // 终端只打关键日志，逐请求 info 只进文件
  if (type !== 'info') console.log(line);
  else if (++infoCount % 40 === 0) console.log(`    ... 已记录 ${infoCount} 条请求级日志(详见 ${path.basename(logPath)})`);
};

engine.onTierFinish = (t) => {
  console.log(`\n  ┌─ 并发 ${String(t.concurrency).padStart(3)} 档位完成 ─────────────────────────`);
  console.log(`  │ 成功率 ${t.successRate.toFixed(1)}% (${t.successCount}/${t.total}) | RPS ${t.rps.toFixed(2)} | RPM ${Math.round(t.rpm)}`);
  console.log(`  │ 生成 TPS ${t.tps.toFixed(1)} tok/s | TPM ${Math.round(t.tpm).toLocaleString()}`);
  console.log(`  │ TTFT  avg ${t.avgTtft.toFixed(2)}s / P90 ${t.ttftP90.toFixed(2)}s`);
  console.log(`  │ 延迟  P50 ${t.p50.toFixed(2)}s / P90 ${t.p90.toFixed(2)}s / P99 ${t.p99.toFixed(2)}s`);
  console.log(`  │ TPOT  avg ${t.avgTpot.toFixed(1)}ms / P90 ${t.tpotP90.toFixed(1)}ms | 429: ${t.rateLimit429Count} | 超时: ${t.timeoutCount}`);
  console.log(`  └─ 评级: ${t.grade}\n`);
};

const fmtPct = (p) => `${Math.round(p)}%`;
engine.onProgress = (cur, total, phase, percent) => {
  logLines.push(`[progress] ${phase} | ${cur}/${total} | 全局 ${fmtPct(pctSafe(percent))}`);
  writeLog();
};
const pctSafe = (v) => Math.max(0, Math.min(100, Number(v) || 0));

const stripContent = (rec) => rec && { ...rec, content: rec.content ? rec.content.slice(0, 120) + (rec.content.length > 120 ? '...(截断)' : '') : '' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 中断保护：Ctrl+C 时温和停止引擎并落盘
process.on('SIGINT', () => {
  console.log('\n收到中断，正在停止引擎并保存已得数据...');
  engine.stop();
});

// ---------- 主流程 ----------
(async () => {
  const t0 = Date.now();
  console.log('==================================================================');
  console.log(`  LLM API 无头压测 (复用本项目 StressEngine v2.0 原班引擎)`);
  console.log(`  目标: ${CFG.api}  模型: ${CFG.model}`);
  console.log(`  并发档位: [${CFG.levels.join(', ')}]  每档基础采样: ${CFG.reqsPerLevel}`);
  console.log(`  最大输出探测: ${CFG.maxOutputTokens} tok | 长上下文阶梯: [${CFG.ctxTiers.join(', ')}]k`);
  console.log('==================================================================\n');

  // 0. 元信息与连通性
  let modelMeta = null;
  try {
    const r = await fetch(`${CFG.api}/models`, { headers: { Authorization: `Bearer ${CFG.key}` } });
    const j = await r.json();
    modelMeta = (j.data || []).find((m) => m.id === CFG.model) || (j.data || [])[0] || null;
    console.log(`  模型列表: ${(j.data || []).map((m) => m.id).join(', ')}`);
    if (modelMeta?.max_model_len) console.log(`  max_model_len: ${modelMeta.max_model_len}`);
  } catch (e) {
    console.log(`  拉取模型列表失败: ${e.message}`);
  }

  console.log('\n▶ 阶段 0/4: 连通性验证 (Ping)');
  const ping = await engine.ping();
  console.log(`  ${ping.ok ? '✅' : '❌'} ${ping.message}`);
  if (!ping.ok) {
    writeLog();
    console.error('连接失败，终止。');
    process.exit(1);
  }

  // 1. 并发阶梯
  console.log(`\n▶ 阶段 1/4: 稳态并发阶梯压测 [${CFG.levels.join(' → ')}] (自动预热后开跑)`);
  const concurrencyResults = await engine.runConcurrencyLadder({
    levels: CFG.levels,
    reqsPerLevel: CFG.reqsPerLevel,
    promptType: 'short',
    enableWarmup: true
  });

  // 2. 最大输出探测
  console.log(`\n▶ 阶段 2/4: 单次最大输出探测 (申请 ${CFG.maxOutputTokens} tokens)`);
  const outputResult = await engine.probeMaxOutput({ targetMaxTokens: CFG.maxOutputTokens });
  console.log(`  ${outputResult.ok ? '✅' : '❌'} 实际输出 ${outputResult.completionTokens} tok | finish_reason=${outputResult.finishReason} | ${outputResult.tps.toFixed(1)} tok/s`);

  // 3. 长上下文阶梯 (针对 max_model_len=32k 调整梯度；复用引擎的探针文本生成与单请求执行)
  console.log(`\n▶ 阶段 3/4: 长上下文承载力探测 [${CFG.ctxTiers.join(', ')}k] + 针尖密匙校验`);
  const contextResults = [];
  for (let i = 0; i < CFG.ctxTiers.length; i++) {
    if (engine.shouldStop) break;
    const tierK = CFG.ctxTiers[i];
    const tierLabel = `${tierK}k`;
    const secret = `KEY-${Math.floor(Math.random() * 89999 + 10000)}`;
    const payload = engine.generateContextText(tierK, secret);
    const tierTimeout = Math.max(90, Math.min(360, tierK * 0.45) + CFG.ctxMaxTokens / 8);
    console.log(`  [${i + 1}/${CFG.ctxTiers.length}] ${tierLabel}: 注入 ~${payload.estimatedTokens.toLocaleString()} tokens, 输出上限 ${CFG.ctxMaxTokens} tok, 超时 ${Math.round(tierTimeout)}s`);

    const record = await engine.executeSingleRequest({
      messages: [{ role: 'user', content: payload.text }],
      maxTokens: CFG.ctxMaxTokens,
      tag: `context-${tierK}k`,
      customTimeout: tierTimeout,
      workerId: `ctx_${tierK}k`
    });
    const cleanContent = (record.content || '').replace(/\s+/g, '');
    record.needleHit = record.ok && cleanContent.includes(secret.replace(/\s+/g, ''));
    record.tierK = tierK;
    record.tierLabel = tierLabel;
    record.inputTokens = payload.estimatedTokens;
    contextResults.push(record);
    console.log(`    ${record.ok ? '✅ 200' : `❌ HTTP ${record.status}`} | TTFT(prefill) ${record.ttft.toFixed(2)}s | 总耗时 ${record.duration.toFixed(2)}s | 密匙 ${record.needleHit ? '✅ 命中' : '❌ 未命中'}${record.ok ? '' : ' | ' + record.error.slice(0, 100)}`);

    if (i < CFG.ctxTiers.length - 1 && !engine.shouldStop) await sleep(1500);
  }

  // 4. 分析与报告 (复用项目自带 BenchmarkAnalyzer)
  console.log('\n▶ 阶段 4/4: 生成诊断报告 (BenchmarkAnalyzer: Sweet Spot / 压力拐点)');
  analyzer.setData({ concurrencyResults, contextResults, outputResult });
  const modelName = `${CFG.model} @ ${CFG.api}`;
  const markdown = analyzer.generateMarkdownReport(modelName);

  const resultJson = {
    meta: {
      api: CFG.api,
      model: CFG.model,
      maxModelLen: modelMeta?.max_model_len || null,
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
      wallClockSec: Math.round((Date.now() - t0) / 1000),
      quick: QUICK
    },
    ping,
    concurrencyResults: concurrencyResults.map((t) => ({ ...t, records: t.records.map(stripContent) })),
    contextResults: contextResults.map(stripContent),
    outputResult: stripContent(outputResult),
    analysis: {
      throughput: analyzer.analyzeThroughput(),
      sweetSpot: analyzer.calculateSweetSpot(),
      pressure: analyzer.diagnosePressurePoints(),
      context: analyzer.analyzeContextWindow(),
      maxOutput: analyzer.analyzeMaxOutput()
    }
  };

  const jsonPath = path.join(outDir, `result-${stamp}.json`);
  const mdPath = path.join(outDir, `report-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(resultJson, null, 2), 'utf-8');
  writeFileSync(mdPath, markdown, 'utf-8');
  writeLog();

  console.log('\n====================== 终端速览 ======================');
  const tp = resultJson.analysis.throughput;
  const sw = resultJson.analysis.sweetSpot;
  const pr = resultJson.analysis.pressure;
  console.log(`  峰值吞吐: ${tp.peakRps} req/s (${tp.peakRpm} RPM) | 生成 ${tp.peakTps} tok/s (${tp.peakTpm.toLocaleString()} TPM)`);
  console.log(`  最佳并发: ${sw.bestConcurrency}  (评分 ${sw.score}, P90 ${sw.latency}ms, RPS ${sw.rps})`);
  console.log(`  压力拐点: ${pr.stressConcurrency} | 429: ${pr.first429}`);
  console.log(`  总请求量: ${tp.totalCompleted} | 总耗时: ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log('======================================================');
  console.log(`\n📄 完整报告: ${mdPath}`);
  console.log(`📦 原始数据: ${jsonPath}`);
  console.log(`📜 运行日志: ${logPath}\n`);
  process.exit(0);
})().catch((e) => {
  writeLog();
  console.error('压测执行异常:', e);
  process.exit(1);
});
