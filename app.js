/**
 * 主页面控制器与交互调度 (Application Controller v2.5 - 清爽浅色风格)
 * 实时遥测：秒表走动、即时追加表格、流式速率与精准全景进度
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM 节点引用
  const apiUrlInput = document.getElementById('apiUrl');
  const apiKeyInput = document.getElementById('apiKey');
  const modelNameInput = document.getElementById('modelName');
  const streamModeSelect = document.getElementById('streamMode');
  const reqTimeoutInput = document.getElementById('reqTimeout');
  const btnToggleKey = document.getElementById('btnToggleKey');
  const presetSelect = document.getElementById('presetSelect');
  const btnFetchModels = document.getElementById('btnFetchModels');
  const modelSelect = document.getElementById('modelSelect');
  const btnTestConnection = document.getElementById('btnTestConnection');
  const connResult = document.getElementById('connResult');

  const proxyNodeSelect = document.getElementById('proxyNodeSelect');

  // CORS 跨域代理控制元素
  const enableCorsProxy = document.getElementById('enableCorsProxy');
  const proxyBaseUrlInput = document.getElementById('proxyBaseUrl');
  const proxyUrlWrap = document.getElementById('proxyUrlWrap');
  const corsStatusTag = document.getElementById('corsStatusTag');
  const corsAlertBanner = document.getElementById('corsAlertBanner');
  const btnQuickEnableProxy = document.getElementById('btnQuickEnableProxy');
  const btnCloseCorsBanner = document.getElementById('btnCloseCorsBanner');

  // 控制按钮与状态
  const btnStartBenchmark = document.getElementById('btnStartBenchmark');
  const btnStopBenchmark = document.getElementById('btnStopBenchmark');
  const systemStatusBadge = document.getElementById('systemStatusBadge');
  const progressSection = document.getElementById('progressSection');
  const progressBarFill = document.getElementById('progressBarFill');
  const progressPhaseText = document.getElementById('progressPhaseText');
  const progressPercentText = document.getElementById('progressPercentText');
  const progressSubText = document.getElementById('progressSubText');

  // 实时遥测 Strip 节点
  const hudDot = document.getElementById('hudDot');
  const hudStateText = document.getElementById('hudStateText');
  const hudTimer = document.getElementById('hudTimer');
  const hudTokenCount = document.getElementById('hudTokenCount');
  const hudLiveSpeed = document.getElementById('hudLiveSpeed');
  const hudActiveWorkers = document.getElementById('hudActiveWorkers');

  // KPI 元素
  const valRpm = document.getElementById('valRpm');
  const valRps = document.getElementById('valRps');
  const valCompletedReqs = document.getElementById('valCompletedReqs');
  const valTpm = document.getElementById('valTpm');
  const valTps = document.getElementById('valTps');
  const valTokenRatio = document.getElementById('valTokenRatio');
  const valMaxContext = document.getElementById('valMaxContext');
  const valSafeContext = document.getElementById('valSafeContext');
  const val1MStatus = document.getElementById('val1MStatus');
  const valMaxOutput = document.getElementById('valMaxOutput');
  const valFinishReason = document.getElementById('valFinishReason');
  const valOutSpeed = document.getElementById('valOutSpeed');
  const valBestConcurrency = document.getElementById('valBestConcurrency');
  const valBestScore = document.getElementById('valBestScore');
  const valBestLatency = document.getElementById('valBestLatency');
  const valStressPoint = document.getElementById('valStressPoint');
  const valFirst429 = document.getElementById('valFirst429');
  const valLatencySpike = document.getElementById('valLatencySpike');

  // 诊断报告元素
  const reportConclusion = document.getElementById('reportConclusion');
  const reportSweetSpot = document.getElementById('reportSweetSpot');
  const reportStressPoint = document.getElementById('reportStressPoint');
  const reportContextOutput = document.getElementById('reportContextOutput');
  const reportStatusTag = document.getElementById('reportStatusTag');

  // 终端日志
  const terminalLog = document.getElementById('terminalLog');
  const btnClearLogs = document.getElementById('btnClearLogs');
  const autoScrollLogs = document.getElementById('autoScrollLogs');

  // 表格
  const tableConcurrencyBody = document.querySelector('#tableConcurrencyResults tbody');
  const tableContextBody = document.querySelector('#tableContextResults tbody');

  // 导出按钮
  const btnExportJson = document.getElementById('btnExportJson');
  const btnExportReport = document.getElementById('btnExportReport');

  // 当前测试会话聚合数据
  const currentSessionData = {
    concurrencyTiers: [],
    contextTiers: [],
    outputResult: null,
    allRawRecords: []
  };

  // ============ 项目内弹窗系统 (替代原生 alert / confirm) ============

  (function initToasts() {
    const wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  })();

  const TOAST_ICO = { ok: '✓', error: '✕', warn: '!', info: 'i' };

  /**
   * 项目内通知: uiToast(message, type='info', duration=3800)
   * type: ok | error | warn | info; duration 毫秒, 0=不自动消失
   */
  function uiToast(message, type = 'info', duration = 3800) {
    const wrap = document.querySelector('.toast-wrap');
    if (!wrap) { console.log('[toast]', type, message); return; }
    // 同文本去重: 已在显示的同类提示重置计时即可
    for (const el of Array.from(wrap.children)) {
      if (el.dataset.msg === String(message)) { el.remove(); break; }
    }
    const box = document.createElement('div');
    box.className = 'toast t-' + (TOAST_ICO[type] ? type : 'info');
    box.dataset.msg = String(message);
    const ico = document.createElement('span');
    ico.className = 't-ico'; ico.textContent = TOAST_ICO[type] || 'i';
    const body = document.createElement('div');
    body.innerHTML = String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/\n/g, '<br>');
    const close = document.createElement('button');
    close.className = 't-close'; close.textContent = '✕'; close.title = '关闭';
    const kill = () => {
      if (!box.isConnected) return;
      box.classList.add('t-out');
      setTimeout(() => box.remove(), 200);
    };
    close.addEventListener('click', kill);
    box.append(ico, body, close);
    wrap.appendChild(box);
    while (wrap.children.length > 5) wrap.firstElementChild.remove();
    if (duration > 0) setTimeout(kill, duration);
  }

  /**
   * 项目内确认框: const yes = await uiConfirm('确定停止全部?')
   */
  function uiConfirm(message, okText = '确定', cancelText = '取消') {
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'modal-dlg';
      dlg.innerHTML =
        '<div class="modal-title">请确认</div>' +
        '<div style="font-size:13px;line-height:1.7;margin:6px 0 16px;">' +
        String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') +
        '</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button type="button" class="btn btn-outline btn-sm" data-r="0">' + cancelText + '</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-r="1">' + okText + '</button></div>';
      const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-r]');
        if (b) done(b.dataset.r === '1');
      });
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
      document.body.appendChild(dlg);
      dlg.showModal();
    });
  }

  // 秒表计时器状态
  let benchmarkStartTime = 0;
  let timerInterval = null;

  // ============ 昼夜主题 ============
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (window.chartManager && window.chartManager.applyTheme) {
      window.chartManager.applyTheme(theme === 'dark');
    }
  }
  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('bench_theme'); } catch (e) {}
    const theme = (saved === 'dark' || saved === 'light')
      ? saved
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(theme);
  })();
  document.getElementById('btnThemeToggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('bench_theme', next); } catch (e) {}
    applyTheme(next);
    appendLog('system', next === 'dark' ? '已切换到夜间模式。' : '已切换到白天模式。');
  });

  // 初始化图表
  window.chartManager.initCharts();

  // 从本地存储还原配置
  loadSavedSettings();

  // ============ 顶层模式切换: LLM API 压测 / GPU 服务器压测 ============
  let currentBenchMode = 'llm';

  const launcherView = document.getElementById('launcherView');
  const workspaceView = document.getElementById('workspaceView');
  const wsModeLabel = document.getElementById('wsModeLabel');

  function switchBenchMode(mode) {
    if (mode !== 'llm' && mode !== 'gpu' && mode !== 'npu') mode = 'llm';
    currentBenchMode = mode;
    wsModeLabel.textContent = mode === 'gpu' ? 'GPU 服务器压测工作台'
      : (mode === 'npu' ? 'NPU 服务器压测工作台' : 'LLM API 压测工作台');
    document.querySelectorAll('[data-mode]').forEach(el => {
      el.hidden = (el.getAttribute('data-mode') !== mode);
    });
  }

  /** 进入指定工作台 (从入口卡片或模式按钮) */
  function enterWorkspace(mode) {
    switchBenchMode(mode);
    launcherView.hidden = true;
    workspaceView.hidden = false;
    window.scrollTo(0, 0);
    appendLog('system', mode === 'gpu'
      ? '已进入【GPU 服务器压测】工作台。'
      : (mode === 'npu' ? '已进入【NPU 服务器压测】工作台。' : '已进入【LLM API 压测】工作台。'));
  }

  /** 返回入口选择页 */
  function showLauncher() {
    workspaceView.hidden = true;
    launcherView.hidden = false;
    window.scrollTo(0, 0);
  }

  document.querySelectorAll('.launch-card').forEach(card => {
    card.addEventListener('click', () => enterWorkspace(card.getAttribute('data-launch')));
  });
  document.getElementById('btnBackLauncher').addEventListener('click', showLauncher);

  // 登录态守卫: 通过服务 (http/https) 部署时校验会话, 未登录跳转登录页; file:// 直开时跳过守卫
  const userChip = document.getElementById('userChip');
  const userChipName = document.getElementById('userChipName');
  const btnLogout = document.getElementById('btnLogout');
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    fetch('/api/me').then(r => r.json()).then(d => {
      if (d && d.ok) {
        userChipName.textContent = d.username;
        userChip.classList.remove('hidden');
        btnLogout.classList.remove('hidden');
        const btnCp = document.getElementById('btnChangePass');
        if (btnCp) btnCp.classList.remove('hidden');
        // 跨源代理会话令牌 (浏览器跨端口 fetch 带不上 Cookie, 代理凭 bench_token 放行)
        if (d.proxyToken) {
          window.__benchProxyToken = d.proxyToken;
          applyEngineConfig();
        }
      } else {
        location.replace('/login.html');
      }
    }).catch(() => { /* 网络异常时不拦截本地使用 */ });
  }
  // 修改密码弹窗
  const dlgCp = document.getElementById('dlgChangePass');
  document.getElementById('btnChangePass').addEventListener('click', () => {
    document.getElementById('cpUser').textContent = userChipName.textContent || '-';
    document.getElementById('cpError').classList.add('hidden');
    document.getElementById('formChangePass').reset();
    dlgCp.showModal();
  });
  document.getElementById('cpCancel').addEventListener('click', () => dlgCp.close());
  document.getElementById('formChangePass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('cpError');
    const btn = document.getElementById('cpSubmit');
    const new1 = document.getElementById('cpNew').value;
    const new2 = document.getElementById('cpNew2').value;
    errBox.classList.add('hidden');
    if (new1 !== new2) {
      errBox.textContent = '两次输入的新密码不一致';
      errBox.classList.remove('hidden');
      return;
    }
    btn.disabled = true; btn.textContent = '提交中…';
    try {
      const r = await fetch('/api/change-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          oldPassword: document.getElementById('cpOld').value,
          newPassword: new1
        })
      });
      const d = await r.json();
      if (d.ok) {
        dlgCp.close();
        appendLog('ok', '密码修改成功, 下次登录请使用新密码。');
        uiToast('密码修改成功!下次登录请使用新密码。', 'ok', 4200);      } else {
        errBox.textContent = d.error || '修改失败';
        errBox.classList.remove('hidden');
      }
    } catch (err) {
      errBox.textContent = '请求失败: ' + err.message;
      errBox.classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = '确认修改';
    }
  });

  btnLogout.addEventListener('click', async () => {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (e) {}
    location.replace('/login.html');
  });

  // 绑定引擎事件
  window.stressEngine.onLog = (type, msg) => {
    appendLog(type, msg);
  };

  // 实时流式分块事件监听
  window.stressEngine.onChunk = ({ tag, tokensReceived, elapsedSec, liveTps }) => {
    hudTokenCount.innerHTML = `${tokensReceived.toLocaleString()} <small>tok</small>`;
    hudLiveSpeed.innerHTML = `${liveTps.toFixed(1)} <small>tok/s</small>`;
  };

  // 活跃工作池变化监听
  window.stressEngine.onActiveWorkersChange = (count) => {
    hudActiveWorkers.innerHTML = `${count} <small>活跃</small>`;
  };

  // 进度条与状态刷新
  window.stressEngine.onProgress = (curr, total, phase, percent, detail) => {
    progressSection.classList.remove('hidden');
    progressPhaseText.textContent = phase;
    progressPercentText.textContent = `${percent}%`;
    progressBarFill.style.width = `${percent}%`;
    progressSubText.textContent = detail || `完成 ${curr} / ${total}`;
    hudStateText.textContent = phase;
  };

  // 单次请求完成时
  window.stressEngine.onRequestFinish = (record) => {
    currentSessionData.allRawRecords.push(record);
    valCompletedReqs.textContent = `已测: ${currentSessionData.allRawRecords.length}`;
  };

  // 长上下文单梯度完成时（即刻追加插入表格，无需等待全部阶梯结束！）
  window.stressEngine.onContextTierFinish = (record, current, total) => {
    currentSessionData.contextTiers.push(record);
    updateContextOutputTable();
    window.chartManager.updateContextCharts(currentSessionData.contextTiers);
    updateLiveAnalysis();
    appendLog('ok', `[即时推送] ${record.tierLabel} 上下文数据已完成渲染入库 (耗时 ${record.duration.toFixed(2)}s)`);
  };

  // 最大输出探测完成时即刻刷新
  window.stressEngine.onOutputProbeFinish = (record) => {
    currentSessionData.outputResult = record;
    updateContextOutputTable();
    updateLiveAnalysis();
  };

  // 并发梯度单档完成时
  window.stressEngine.onTierFinish = (tierStats) => {
    currentSessionData.concurrencyTiers.push(tierStats);
    updateConcurrencyTable(currentSessionData.concurrencyTiers);
    window.chartManager.updateConcurrencyCharts(currentSessionData.concurrencyTiers);
    updateLiveAnalysis();
  };

  // 1. 下拉预设快速切换
  if (presetSelect) {
    presetSelect.addEventListener('change', () => {
      const selected = presetSelect.options[presetSelect.selectedIndex];
      const url = selected.getAttribute('data-url');
      const model = selected.getAttribute('data-model');
      if (url) apiUrlInput.value = url;
      if (model) modelNameInput.value = model;
      saveSettings();
      appendLog('info', `已加载预设服务商: ${selected.text} -> ${url}`);
    });
  }

  // 2. 显示/隐藏 API Key
  btnToggleKey.addEventListener('click', () => {
    apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  });

  // 3. 配置持久化
  // 3. 配置持久化与 CORS 代理联动
  [apiUrlInput, apiKeyInput, modelNameInput, streamModeSelect, reqTimeoutInput, proxyBaseUrlInput].forEach(el => {
    if (el) el.addEventListener('change', saveSettings);
  });

  if (proxyNodeSelect) {
    proxyNodeSelect.addEventListener('change', () => {
      const val = proxyNodeSelect.value;
      if (val !== 'custom') {
        proxyBaseUrlInput.value = val;
      }
      applyEngineConfig();
      saveSettings();
      appendLog('info', `已切换 CORS 代理中继节点: ${val}`);
    });
  }

  if (enableCorsProxy) {
    enableCorsProxy.addEventListener('change', () => {
      const active = enableCorsProxy.checked;
      if (proxyUrlWrap) {
        proxyUrlWrap.classList.toggle('hidden', !active);
      }
      if (corsStatusTag) {
        corsStatusTag.textContent = active ? '已开启' : '未开启';
        corsStatusTag.className = `cors-tag ${active ? 'active' : ''}`;
      }
      applyEngineConfig();
      saveSettings();
      appendLog('info', active ? '⚡ CORS 跨域代理中继已启用 (所有请求将穿透 OPTIONS 预检直达目标)' : 'CORS 代理中继已关闭 (直连目标 API)');
    });
  }

  // 快捷开启代理横幅
  if (btnQuickEnableProxy) {
    btnQuickEnableProxy.addEventListener('click', () => {
      if (enableCorsProxy) {
        enableCorsProxy.checked = true;
        enableCorsProxy.dispatchEvent(new Event('change'));
      }
      if (corsAlertBanner) {
        corsAlertBanner.classList.add('hidden');
      }
    });
  }

  if (btnCloseCorsBanner) {
    btnCloseCorsBanner.addEventListener('click', () => {
      if (corsAlertBanner) corsAlertBanner.classList.add('hidden');
    });
  }

  // 自动探测本地 server.py 代理可用性
  checkLocalProxyHealth();

  async function checkLocalProxyHealth() {
    try {
      const res = await fetch('http://127.0.0.1:8765/health', { method: 'GET' });
      if (res.ok) {
        appendLog('ok', '✔ 检测到本地反向代理服务 (http://127.0.0.1:8765) 已在线！');
        if (enableCorsProxy && !enableCorsProxy.checked) {
          enableCorsProxy.checked = true;
          enableCorsProxy.dispatchEvent(new Event('change'));
        }
      }
    } catch (e) {
      // 若处于 file:// 打开且未开启代理，则预警
      if (window.location.protocol === 'file:') {
        appendLog('warn', '⚠️ 当前以 file:// 协议运行，建议使用 start.bat 启动服务或使用免后端公共中继，彻底避免 CORS 跨域拦截。');
        if (corsAlertBanner) corsAlertBanner.classList.remove('hidden');
      }
    }
  }

  // 4. Ping 连通性测试
  btnTestConnection.addEventListener('click', async () => {
    applyEngineConfig();
    if (!apiKeyInput.value.trim()) {
      showConnResult(false, '请先填写 API Key 才能进行握手测试！');
      return;
    }

    connResult.className = 'conn-box';
    connResult.textContent = '正在向目标大模型发送握手测试探针...';
    connResult.classList.remove('hidden');

    const res = await window.stressEngine.ping();
    showConnResult(res.ok, res.message);
    if (!res.ok && (res.status === -1 || res.message.includes('CORS') || res.message.includes('预检'))) {
      if (corsAlertBanner) corsAlertBanner.classList.remove('hidden');
    }
  });

  function showConnResult(ok, msg) {
    connResult.className = `conn-box ${ok ? 'success' : 'error'}`;
    connResult.textContent = msg;
    connResult.classList.remove('hidden');
  }

  // 5. 拉取远程模型列表
  btnFetchModels.addEventListener('click', async () => {
    applyEngineConfig();
    if (!apiKeyInput.value.trim()) {
      uiToast('请先输入 API Key', 'warn', 4200);      return;
    }

    btnFetchModels.textContent = '获取中...';
    btnFetchModels.disabled = true;

    try {
      const models = await window.stressEngine.fetchModels();
      modelSelect.innerHTML = '<option value="">-- 选择拉取的模型 --</option>';
      models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === modelNameInput.value) opt.selected = true;
        modelSelect.appendChild(opt);
      });
      modelSelect.classList.remove('hidden');
      appendLog('ok', `成功从服务端同步 ${models.length} 个可用模型。`);
    } catch (err) {
      appendLog('err', `拉取模型失败: ${err.message}`);
    } finally {
      btnFetchModels.textContent = '获取列表';
      btnFetchModels.disabled = false;
    }
  });

  modelSelect.addEventListener('change', () => {
    if (modelSelect.value) {
      modelNameInput.value = modelSelect.value;
      saveSettings();
    }
  });

  // 6. 测试方案模式选项卡切换
  const segBtns = document.querySelectorAll('.seg-btn');
  const tabViews = document.querySelectorAll('.tab-view');
  segBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      segBtns.forEach(b => b.classList.remove('active'));
      tabViews.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      document.getElementById(targetId)?.classList.add('active');
    });
  });

  // 底部统计区已改为直接平铺展示，无需 Tab 绑定

  // 7. 启动测试核心调度
  btnStartBenchmark.addEventListener('click', async () => {
    applyEngineConfig();
    if (!apiKeyInput.value.trim()) {
      uiToast('请先填写 API Key 才能开始压测！', 'warn', 4200);      apiKeyInput.focus();
      return;
    }

    const activeTab = document.querySelector('.seg-btn.active')?.getAttribute('data-tab');

    // 状态初始化与秒表开跑
    setRunState(true);
    resetBenchmarkSession();
    startLiveTimer();

    appendLog('sys', `\n🚀 ============ 启动大模型基准测试流水线 [${new Date().toLocaleTimeString()}] ============`);
    appendLog('sys', `目标模型: ${modelNameInput.value} | 接口地址: ${apiUrlInput.value}`);

    try {
      if (activeTab === 'tab-full') {
        const reqCountPerLevel = Number(document.querySelector('input[name="fullReqCount"]:checked')?.value || 20);

        // 阶段 1: 最大输出探测 (0% -> 15%)
        hudStateText.textContent = '阶段 1/3: 正在探测单次最大输出上限...';
        appendLog('info', '>>> 进入阶段 1/3: 探测模型单次最大输出容量与解码速率 <<<');
        await window.stressEngine.probeMaxOutput({
          targetMaxTokens: 8192,
          globalProgressOffset: 0,
          globalProgressSpan: 15
        });

        // 阶段 2: 极限长上下文注入 (15% -> 45%)
        if (!window.stressEngine.shouldStop) {
          hudStateText.textContent = '阶段 2/3: 探测长上下文 (64k, 128k, 256k, 512k, 1M)...';
          appendLog('info', '>>> 进入阶段 2/3: 长上下文阶梯极限探测与针尖密匙识别 <<<');
          await window.stressEngine.probeContextLimits({
            tiers: [64, 128, 256, 512, 1024],
            globalProgressOffset: 15,
            globalProgressSpan: 30
          });
        }

        // 阶段 3: 并发阶梯压测 (45% -> 100%)
        if (!window.stressEngine.shouldStop) {
          hudStateText.textContent = '阶段 3/3: 执行并发阶梯压测 (5, 10, 20, 50, 100)...';
          appendLog('info', '>>> 进入阶段 3/3: 并发阶梯压力测试 (5, 10, 20, 50, 100 并发) <<<');
          await window.stressEngine.runConcurrencyLadder({
            levels: [5, 10, 20, 50, 100],
            reqsPerLevel: reqCountPerLevel,
            promptType: 'short',
            globalProgressOffset: 45,
            globalProgressSpan: 55
          });
        }

      } else if (activeTab === 'tab-concurrency') {
        const selectedLevels = Array.from(document.querySelectorAll('input[name="concurrencyLevel"]:checked'))
          .map(el => Number(el.value));
        if (selectedLevels.length === 0) {
          uiToast('请至少勾选一个并发等级！', 'warn', 4200);          setRunState(false);
          return;
        }
        const reqs = Number(document.getElementById('requestsPerLevel').value || 20);
        const promptType = document.getElementById('promptSizeConcurrency').value;

        await window.stressEngine.runConcurrencyLadder({
          levels: selectedLevels,
          reqsPerLevel: reqs,
          promptType,
          globalProgressOffset: 0,
          globalProgressSpan: 100
        });

      } else if (activeTab === 'tab-context') {
        const selectedTiers = Array.from(document.querySelectorAll('input[name="contextTier"]:checked'))
          .map(el => Number(el.value));
        if (selectedTiers.length === 0) {
          uiToast('请至少勾选一个长上下文梯度！', 'warn', 4200);          setRunState(false);
          return;
        }

        await window.stressEngine.probeContextLimits({
          tiers: selectedTiers,
          globalProgressOffset: 0,
          globalProgressSpan: 100
        });

      } else if (activeTab === 'tab-output') {
        const targetTokens = Number(document.getElementById('outputTargetTokens').value || 8192);
        await window.stressEngine.probeMaxOutput({
          targetMaxTokens: targetTokens,
          globalProgressOffset: 0,
          globalProgressSpan: 100
        });
      }

      appendLog('ok', `✔ 评测任务执行完毕！全方位分析与诊断报告已同步就绪。`);
      hudStateText.textContent = '测试任务顺利执行完成';
      progressBarFill.style.width = '100%';
      progressPercentText.textContent = '100%';
    } catch (err) {
      appendLog('err', `压测过程发生异常中断: ${err.message}`);
      hudStateText.textContent = `异常中断: ${err.message}`;
    } finally {
      stopLiveTimer();
      setRunState(false);
      updateLiveAnalysis(true);
    }
  });

  // 8. 紧急终止按钮
  btnStopBenchmark.addEventListener('click', () => {
    window.stressEngine.stop();
    btnStopBenchmark.disabled = true;
    btnStopBenchmark.textContent = '正在取消中...';
    hudStateText.textContent = '用户触发终止，等待任务排空...';
    appendLog('warn', '用户触发强制终止流程...');
  });

  // 秒表计时器
  function startLiveTimer() {
    benchmarkStartTime = performance.now();
    timerInterval = setInterval(() => {
      const elapsed = (performance.now() - benchmarkStartTime) / 1000;
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toFixed(1).padStart(4, '0');
      hudTimer.textContent = `${mins}:${secs}`;
    }, 100);
  }

  function stopLiveTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  // 9. 更新实时诊断分析报告与 KPI
  function updateLiveAnalysis(isFinal = false) {
    window.benchmarkAnalyzer.setData({
      concurrencyResults: currentSessionData.concurrencyTiers,
      contextResults: currentSessionData.contextTiers,
      outputResult: currentSessionData.outputResult
    });

    const ctx = window.benchmarkAnalyzer.analyzeContextWindow();
    const out = window.benchmarkAnalyzer.analyzeMaxOutput();
    const tp = window.benchmarkAnalyzer.analyzeThroughput();
    const sweet = window.benchmarkAnalyzer.calculateSweetSpot();
    const stress = window.benchmarkAnalyzer.diagnosePressurePoints();

    // 更新 KPI 顶部卡片
    valRpm.textContent = tp.peakRpm ? tp.peakRpm.toFixed(1) : '0.0';
    valRps.textContent = tp.peakRps ? tp.peakRps.toFixed(1) : '0.0';
    valTpm.textContent = tp.peakTpm ? Math.round(tp.peakTpm).toLocaleString() : '0';
    valTps.textContent = tp.peakTps ? tp.peakTps.toFixed(1) : '0.0';

    if (currentSessionData.concurrencyTiers.length > 0) {
      const lastTier = currentSessionData.concurrencyTiers[currentSessionData.concurrencyTiers.length - 1];
      const ratio = lastTier.totalCompletionTokens > 0
        ? (lastTier.totalPromptTokens / lastTier.totalCompletionTokens).toFixed(1)
        : '-';
      valTokenRatio.textContent = ratio !== '-' ? `${ratio} : 1` : '-';
    }

    if (ctx.tested) {
      valMaxContext.textContent = ctx.maxTierLabel || '不支持';
      valSafeContext.textContent = `${ctx.maxTierLabel} (~${ctx.maxSafeTokens?.toLocaleString()} tok)`;
      const tier1M = currentSessionData.contextTiers.find(c => c.tierK >= 1024);
      val1MStatus.textContent = tier1M ? (tier1M.ok ? '支持 1M' : `失败(${tier1M.status})`) : '未测';
    }

    if (out.tested) {
      valMaxOutput.textContent = out.maxTokens ? `${out.maxTokens.toLocaleString()} tok` : '0 tok';
      valFinishReason.textContent = out.finishReason;
      valOutSpeed.textContent = out.speedTps ? out.speedTps.toFixed(1) : '-';
    }

    if (sweet.bestConcurrency !== '无数据') {
      valBestConcurrency.textContent = `${sweet.bestConcurrency} 并发`;
      valBestScore.textContent = `${sweet.score} 分`;
      valBestLatency.textContent = `${sweet.latency}`;
    }

    if (stress.hasStressPoint) {
      valStressPoint.textContent = stress.stressConcurrency;
      valFirst429.textContent = stress.first429;
      valLatencySpike.textContent = stress.latencySpike;
    } else if (currentSessionData.concurrencyTiers.length > 0) {
      valStressPoint.textContent = '未触发瓶颈';
      valFirst429.textContent = '无 429';
      valLatencySpike.textContent = '延迟平稳';
    }

    // 更新诊断报告文本
    reportStatusTag.textContent = isFinal ? '评测已完成 (最终报告)' : '实时动态分析中...';
    reportConclusion.innerHTML = `
      <p>针对模型 <strong>${modelNameInput.value}</strong> 综合评测概览：</p>
      <ul>
        <li><strong>吞吐上限</strong>：实测峰值达到 <span class="diag-highlight">${tp.peakRpm} RPM</span> 与 <span class="diag-highlight">${tp.peakTpm.toLocaleString()} TPM</span>。</li>
        <li><strong>上下文规模</strong>：${ctx.summary}</li>
        <li><strong>输出上限</strong>：${out.summary}</li>
        <li><strong>工程建议</strong>：${sweet.reason}</li>
      </ul>
    `;

    reportSweetSpot.innerHTML = `
      <p><strong>最佳并发度推荐：<span class="diag-success">${sweet.bestConcurrency} 并发</span></strong></p>
      <p style="margin-top:6px;">${sweet.reason}</p>
      <p style="font-size:11px; color:#64748b; margin-top:5px;">* 加权考量实际 RPS 增益、P90 延迟劣化及请求成功率，为生产网关最推荐的并发限制值。</p>
    `;

    reportStressPoint.innerHTML = `
      <p><strong>系统压力与瓶颈点：<span class="${stress.hasStressPoint ? 'diag-danger' : 'diag-success'}">${stress.stressConcurrency}</span></strong></p>
      <div style="margin-top:6px; white-space: pre-line;">${stress.summary}</div>
    `;

    reportContextOutput.innerHTML = `
      <p><strong>长上下文 (64k-1M) 承载力：</strong> ${ctx.summary}</p>
      <p style="margin-top:8px;"><strong>单次最大输出极限：</strong> ${out.summary}</p>
    `;
  }

  // 10. 表格渲染函数
  function updateConcurrencyTable(tiers) {
    if (!tiers.length) {
      tableConcurrencyBody.innerHTML = '<tr class="empty-row"><td colspan="12">暂无压测数据</td></tr>';
      return;
    }

    tableConcurrencyBody.innerHTML = tiers.map((t, idx) => `
      <tr class="${idx === tiers.length - 1 ? 'row-fresh-flash' : ''}">
        <td><strong>并发 ${t.concurrency}</strong></td>
        <td>${t.total}</td>
        <td><span class="${t.successRate >= 95 ? 'diag-success' : 'diag-danger'}">${t.successRate.toFixed(1)}%</span></td>
        <td>${t.rps.toFixed(1)}</td>
        <td>${Math.round(t.tpm).toLocaleString()}</td>
        <td>${t.tps.toFixed(1)}</td>
        <td>${t.avgTtft.toFixed(2)}s / ${(t.ttftP90 || t.avgTtft).toFixed(2)}s</td>
        <td>${t.p50.toFixed(2)}s</td>
        <td>${t.p90.toFixed(2)}s</td>
        <td>${t.p99.toFixed(2)}s</td>
        <td>${t.rateLimit429Count > 0 ? `<span class="badge badge-danger">${t.rateLimit429Count}</span>` : '0'}</td>
        <td><span class="badge ${t.gradeBadge}">${t.grade}</span></td>
      </tr>
    `).join('');
  }

  function updateContextOutputTable() {
    const list = [];
    if (currentSessionData.outputResult) {
      const o = currentSessionData.outputResult;
      list.push(`
        <tr>
          <td><span class="badge badge-info">输出极限探测</span></td>
          <td>申请 ${document.getElementById('outputTargetTokens')?.value || 8192}</td>
          <td>~20</td>
          <td><strong>${o.completionTokens}</strong></td>
          <td>${o.ttft ? o.ttft.toFixed(2) + 's' : '-'}</td>
          <td>${o.duration.toFixed(2)}s</td>
          <td>${o.tps.toFixed(1)} tok/s</td>
          <td>${o.status}</td>
          <td><span class="badge ${o.finishReason === 'length' ? 'badge-warning' : 'badge-success'}">${o.finishReason}</span></td>
          <td>${o.ok ? (o.finishReason === 'length' ? '触碰硬性输出上限' : '正常完成输出') : '生成异常'}</td>
        </tr>
      `);
    }

    currentSessionData.contextTiers.forEach((c, idx) => {
      const isLatest = idx === currentSessionData.contextTiers.length - 1;
      list.push(`
        <tr class="${isLatest ? 'row-fresh-flash' : ''}">
          <td><span class="badge badge-success">长上下文注入</span></td>
          <td><strong>${c.tierLabel}</strong></td>
          <td>~${c.inputTokens?.toLocaleString()}</td>
          <td>${c.completionTokens || 0}</td>
          <td>${c.ttft ? c.ttft.toFixed(2) + 's' : '-'}</td>
          <td>${c.duration.toFixed(2)}s</td>
          <td>${c.tps ? c.tps.toFixed(1) + ' tok/s' : '-'}</td>
          <td>${c.status}</td>
          <td>${c.finishReason || '-'}</td>
          <td>
            <span class="badge ${c.ok ? 'badge-success' : 'badge-danger'}">
              ${c.ok ? (c.needleHit ? '✅ 成功且命中密匙' : '接收成功(密匙未命中)') : '❌ 拒绝/超上下文'}
            </span>
          </td>
        </tr>
      `);
    });

    if (list.length === 0) {
      tableContextBody.innerHTML = '<tr class="empty-row"><td colspan="10">暂无长文本探测数据</td></tr>';
    } else {
      tableContextBody.innerHTML = list.join('');
    }
  }

  // 11. 导出与报告复制
  btnExportJson.addEventListener('click', () => {
    const exportData = {
      model: modelNameInput.value,
      apiUrl: apiUrlInput.value,
      timestamp: new Date().toISOString(),
      concurrencyTiers: currentSessionData.concurrencyTiers,
      contextTiers: currentSessionData.contextTiers,
      outputResult: currentSessionData.outputResult,
      rawCount: currentSessionData.allRawRecords.length
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LLM-Benchmark-${modelNameInput.value.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    appendLog('ok', '测试原始数据已成功导出为 JSON 文件。');
  });

  btnExportReport.addEventListener('click', async () => {
    window.benchmarkAnalyzer.setData({
      concurrencyResults: currentSessionData.concurrencyTiers,
      contextResults: currentSessionData.contextTiers,
      outputResult: currentSessionData.outputResult
    });

    const reportMd = window.benchmarkAnalyzer.generateMarkdownReport(modelNameInput.value);

    try {
      await navigator.clipboard.writeText(reportMd);
      uiToast('已将完整的全方位压测诊断分析报告 (Markdown 格式) 复制到剪贴板！', 'ok', 4200);      appendLog('ok', '全方位评测报告 Markdown 已成功复制到剪贴板。');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = reportMd;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      uiToast('已将完整的全方位压测诊断分析报告 (Markdown 格式) 复制到剪贴板！', 'ok', 4200);    }
  });

  // 11b. HTML / PDF 报告导出
  const btnExportHtml = document.getElementById('btnExportHtml');
  const btnExportPdf = document.getElementById('btnExportPdf');

  /** 汇集当前会话的 Analyzer 五项分析结果 + 四张图表快照, 供 HTML/PDF 报告共用 */
  function collectReportMaterial() {
    const hasData = currentSessionData.concurrencyTiers.length ||
      currentSessionData.contextTiers.length || currentSessionData.outputResult;
    if (!hasData) return null;

    const analyzer = window.benchmarkAnalyzer;
    analyzer.setData({
      concurrencyResults: currentSessionData.concurrencyTiers,
      contextResults: currentSessionData.contextTiers,
      outputResult: currentSessionData.outputResult
    });
    const analysis = {
      throughput: analyzer.analyzeThroughput(),
      sweetSpot: analyzer.calculateSweetSpot(),
      pressure: analyzer.diagnosePressurePoints(),
      context: analyzer.analyzeContextWindow(),
      maxOutput: analyzer.analyzeMaxOutput()
    };

    const charts = {};
    try {
      for (const name of ['latency', 'throughput', 'context', 'status']) {
        const inst = window.chartManager.charts[name];
        if (inst && inst.canvas) charts[name] = inst.canvas.toDataURL('image/png');
      }
    } catch (e) { /* 图表快照失败不影响报告主体 */ }

    return {
      modelName: `${modelNameInput.value || 'unknown'} @ ${apiUrlInput.value || 'unknown'}`,
      analysis,
      charts,
      concurrencyResults: currentSessionData.concurrencyTiers,
      contextResults: currentSessionData.contextTiers,
      meta: { totalRequests: currentSessionData.allRawRecords.length }
    };
  }

  btnExportHtml.addEventListener('click', () => {
    const material = collectReportMaterial();
    if (!material) { uiToast('当前还没有可导出的测试数据，请先运行一次压测。', 'warn', 5200); return; }

    const html = window.reportBuilder.buildReportHtml(material);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = window.reportBuilder.buildFilename(modelNameInput.value, 'html');
    a.click();
    URL.revokeObjectURL(url);
    appendLog('ok', 'HTML 报告已导出 (自包含单文件, 图表内嵌, 可离线打开)。');
  });

  btnExportPdf.addEventListener('click', async () => {
    const material = collectReportMaterial();
    if (!material) { uiToast('当前还没有可导出的测试数据，请先运行一次压测。', 'warn', 5200); return; }
    if (typeof html2pdf === 'undefined') {
      uiToast('PDF 组件未加载 (vendor/html2pdf.bundle.min.js)，请检查部署完整性。', 'error', 6000);      return;
    }

    const btn = btnExportPdf;
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'PDF 生成中…';
    appendLog('info', '正在渲染 PDF 报告 (含图表快照, 可能需要数秒)…');

    // 离屏容器承载报告 DOM, 供 html2pdf 截取
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:820px;background:#0A0A0A;z-index:-1;';
    try {
      const doc = new DOMParser().parseFromString(
        window.reportBuilder.buildReportHtml(material), 'text/html');
      const styleEl = doc.querySelector('style');
      if (styleEl) holder.appendChild(styleEl);
      while (doc.body.firstChild) holder.appendChild(doc.body.firstChild);
      document.body.appendChild(holder);

      await html2pdf().set({
        margin: [8, 8, 10, 8],
        filename: window.reportBuilder.buildFilename(modelNameInput.value, 'pdf'),
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#0A0A0A', logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.kpi', '.diag', 'tr'] }
      }).from(holder).save();
      appendLog('ok', 'PDF 报告已生成并开始下载。');
    } catch (err) {
      console.error(err);
      uiToast('PDF 生成失败: ' + (err && err.message ? err.message : err), 'error', 6000);      appendLog('error', 'PDF 生成失败: ' + (err && err.message ? err.message : err));
    } finally {
      holder.remove();
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ============ 11c. GPU 服务器压测 (多台并发) ============

  const gpuJobs = {};              // jobId -> { status, result }
  let gpuPollTimer = null;

  const $id = (id) => document.getElementById(id);
  const gpuPhaseMap = {
    connecting: 'SSH 连接中', uploading: '上传压测脚本', running: 'GPU 压测运行中',
    collecting: '收集产物并解析', done: '已完成', done_fail: '⚠ 执行错误', error: '出错', stopped: '已停止', idle: '空闲'
  };
  const gpuStageMap = {
    preparing: '硬件巡检中 (GPU 烧卡尚未开始)',
    burning: 'GPU 满载压测中',
    finalizing: '烧卡完成 · 脚本收尾中 (硬件汇总/生成报告)'
  };
  const gpuPhaseText = (st) => gpuStageMap[st.stage] || gpuPhaseMap[st.phase] || st.phase;

  function gpuLog(type, msg) { appendLog(type, `[GPU] ${msg}`); }

  // ---------- 多目标输入行 ----------

  function gpuAddTargetRow(prefill) {
    const row = document.createElement('div');
    row.className = 'gpu-target-row';
    row.innerHTML = `
      <div class="gtr-row">
        <input type="text" class="form-input gtr-host" placeholder="SSH 主机, 如 172.26.1.20">
        <input type="number" class="form-input gtr-port" value="22" min="1" max="65535" title="端口">
        <button type="button" class="btn btn-primary btn-xs gtr-start" title="单独启动该机器的压测">启动</button>
        <button type="button" class="btn-icon gtr-del" title="移除该服务器">✕</button>
      </div>
      <div class="gtr-row">
        <input type="text" class="form-input gtr-user" placeholder="用户名 (如 root)">
        <input type="password" class="form-input gtr-pass" placeholder="密码 (root 可留空)">
      </div>
      <div class="gtr-row" style="margin-bottom:0;align-items:center;">
        <input type="text" class="form-input gtr-key" placeholder="密钥路径 (可选; 填写后用密钥登录, 密码仅用于 sudo)">
        <label class="custom-check-clean gtr-sudo-wrap" title="普通用户提权执行 (gpu_check.sh 需要 root 权限)">
          <input type="checkbox" class="gtr-sudo"> sudo 提权
        </label>
      </div>`;
    if (prefill) {
      row.querySelector('.gtr-host').value = prefill.host || '';
      row.querySelector('.gtr-port').value = prefill.port || 22;
      row.querySelector('.gtr-user').value = prefill.username || '';
      row.querySelector('.gtr-pass').value = prefill.password || '';
      row.querySelector('.gtr-key').value = prefill.keyPath || '';
      if (prefill.useSudo) row.querySelector('.gtr-sudo').checked = true;
    }
    // ---- sudo 开关联动 ----
    const sudoBox = row.querySelector('.gtr-sudo');
    const userBox = row.querySelector('.gtr-user');
    const passBox = row.querySelector('.gtr-pass');
    const keyBox = row.querySelector('.gtr-key');
    const syncSudoUi = () => {
      const isRoot = userBox.value.trim() === 'root';
      if (isRoot) { sudoBox.checked = false; }
      sudoBox.disabled = isRoot;   // root 不需要 sudo
      const sudoOn = sudoBox.checked && !sudoBox.disabled;
      const keyUsed = keyBox.value.trim() !== '';
      if (sudoOn) {
        passBox.placeholder = keyUsed
          ? 'sudo 密码 (SSH 走密钥; 留空=免密 sudo)'
          : '密码 (SSH 登录 + sudo 提权; 留空=免密 sudo)';
      } else {
        passBox.placeholder = keyUsed ? '密码 (可留空, SSH 走密钥)' : '密码 (SSH 登录)';
      }
    };
    sudoBox.addEventListener('change', syncSudoUi);
    userBox.addEventListener('input', syncSudoUi);
    keyBox.addEventListener('input', syncSudoUi);
    syncSudoUi();
    attachRowKeyUpload(row);
    row.querySelector('.gtr-del').addEventListener('click', () => {
      if (document.querySelectorAll('.gpu-target-row').length > 1) row.remove();
      else uiToast('至少保留一台服务器', 'warn', 4200);    });
    // ---- 单机启动 (正在压测中的机器: 弹警告, 点击不生效) ----
    row.querySelector('.gtr-start').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const t = {
        host: row.querySelector('.gtr-host').value.trim(),
        port: parseInt(row.querySelector('.gtr-port').value, 10) || 22,
        username: row.querySelector('.gtr-user').value.trim(),
        password: row.querySelector('.gtr-pass').value,
        keyPath: row.querySelector('.gtr-key').value.trim(),
        useSudo: row.querySelector('.gtr-sudo').checked
      };
      const key = gpuTargetKey(t.host, t.port);
      if (gpuActiveKeys().has(key)) {
        uiToast('【' + key + '】正在压测中, 本次点击不生效。\n请等待其完成, 或先在右侧任务区停止该任务。', 'warn', 5200);        return;
      }
      if (!t.host || !t.username) { uiToast('请完整填写该机器的主机与用户名', 'warn', 5200); return; }
      if (!t.password && !t.keyPath && t.username !== 'root') { uiToast('【' + t.host + '】缺少密码/密钥', 'warn', 5200); return; }
      const burnSeconds = parseInt($id('gpuBurnSec').value, 10) || 1800;
      btn.disabled = true; btn.textContent = '启动中';
      try {
        const r = await fetch('/api/gpu/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...t, burnSeconds, engine: gpuGetEngine(), precision: gpuGetPrecision() })
        });
        const d = await r.json();
        if (d.ok && d.jobId) {
          gpuJobs[d.jobId] = { status: { phase: 'connecting', host: key }, result: null };
          gpuLog('system', '[' + key + '] 单机 GPU 压测已启动 (' + Math.round(burnSeconds / 60) + ' 分钟)。');
          enterWorkspace('gpu');
          startGpuPolling();
        } else {
          uiToast(d.message || d.error || '启动失败', 'error', 5200);   // 含后端同机重复启动拦截
        }
      } catch (err) {
        uiToast('启动请求失败: ' + err.message, 'error', 6000);      } finally {
        btn.disabled = false; btn.textContent = '启动';
      }
    });
    $id('gpuTargetList').appendChild(row);
  }

  $id('btnGpuAddTarget').addEventListener('click', () => gpuAddTargetRow());
  gpuAddTargetRow();   // 初始一行

  // ---------- SSH 密钥文件上传 (全局 + 单行, GPU/NPU 共用) ----------

  // 全局上传的密钥路径 (window.uploadedKeyPath)

  /** 上传密钥文件到服务端, 返回 { path } 或 null */
  async function uploadKeyFile(file) {
    if (!file) return null;
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    try {
      const r = await fetch('/api/keys/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, content: b64 })
      });
      const d = await r.json();
      if (d.ok) return d;
      uiToast('密钥上传失败: ' + (d.error || '未知'), 'error', 6000);
      return null;
    } catch (e) {
      uiToast('密钥上传请求失败: ' + e.message, 'error', 6000);
      return null;
    }
  }

  /** 在目标行密钥路径旁加单行上传按钮 */
  function attachRowKeyUpload(row) {
    const keyInput = row.querySelector('.gtr-key');
    if (!keyInput) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-icon gtr-keyup';
    btn.title = '上传该机器的密钥文件';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>';
    btn.style.cssText = 'flex:none;margin-left:4px;';
    keyInput.parentNode.appendChild(btn);
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.className = 'hidden';
    fileInput.accept = '*/*';
    keyInput.parentNode.appendChild(fileInput);
    btn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      uiToast('上传密钥 ' + f.name + '…', 'info', 2000);
      const result = await uploadKeyFile(f);
      if (result) {
        keyInput.value = result.path;
        uiToast('密钥已上传并填入: ' + result.name, 'ok', 3000);
      }
    });
  }

  /** 全局密钥上传 (GPU) */
  $id('btnGpuUploadKey').addEventListener('click', () => $id('gpuKeyFile').click());
  $id('gpuKeyFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    uiToast('上传密钥 ' + f.name + '…', 'info', 2000);
    const result = await uploadKeyFile(f);
    if (result) {
      window.uploadedKeyPath = result.path;
      const hint = $id('gpuUploadedKeyHint');
      hint.textContent = '已上传: ' + result.name + ' (路径: ' + result.path + ') — 识别填入时自动使用';
      hint.classList.remove('hidden');
      uiToast('密钥已上传: ' + result.name + ', 点「识别并填入 (密钥)」时各机器自动使用', 'ok', 5000);
      appendLog('ok', '[密钥] 已上传 ' + result.name + ' → ' + result.path);
    }
  });

  /** 全局密钥上传 (NPU) */
  $id('btnNpuUploadKey').addEventListener('click', () => $id('npuKeyFile').click());
  $id('npuKeyFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    uiToast('上传密钥 ' + f.name + '…', 'info', 2000);
    const result = await uploadKeyFile(f);
    if (result) {
      window.uploadedKeyPath = result.path;
      const hint = $id('npuUploadedKeyHint');
      hint.textContent = '已上传: ' + result.name + ' (路径: ' + result.path + ') — 识别填入时自动使用';
      hint.classList.remove('hidden');
      uiToast('密钥已上传: ' + result.name + ', 点「识别并填入 (密钥)」时各机器自动使用', 'ok', 5000);
      appendLog('ok', '[NPU 密钥] 已上传 ' + result.name + ' → ' + result.path);
    }
  });

  /** 当前在途机器标识集合 (host 或 host:port) */
  function gpuActiveKeys() {
    const s = new Set();
    for (const j of Object.values(gpuJobs)) {
      if (['connecting', 'uploading', 'running', 'collecting'].includes(j.status.phase)) {
        s.add(j.status.host);
      }
    }
    return s;
  }
  function gpuGetEngine() {
    const c = document.querySelector('input[name="gpuEngine"]:checked');
    return c ? c.value : 'gpu-burn';
  }

  function gpuGetPrecision() {
    const c = document.querySelector('input[name="gpuPrecision"]:checked');
    return c ? c.value : 'fp16';
  }

  function gpuSyncPrecisionUI() {
    const wrap = document.getElementById('gpuPrecisionWrap');
    if (wrap) wrap.hidden = gpuGetEngine() !== 'torch';
  }
  document.querySelectorAll('input[name="gpuEngine"]').forEach(r =>
    r.addEventListener('change', gpuSyncPrecisionUI));

  const gpuTargetKey = (host, port) => (port && port !== 22) ? host + ':' + port : host;

  function gpuCollectTargets() {
    return Array.from(document.querySelectorAll('.gpu-target-row')).map(r => ({
      host: r.querySelector('.gtr-host').value.trim(),
      port: parseInt(r.querySelector('.gtr-port').value, 10) || 22,
      username: r.querySelector('.gtr-user').value.trim(),
      password: r.querySelector('.gtr-pass').value,
      keyPath: r.querySelector('.gtr-key').value.trim(),
      useSudo: r.querySelector('.gtr-sudo').checked
    }));
  }

  // ---------- 启动 / 停止 ----------

  $id('btnGpuStart').addEventListener('click', async () => {
    const targets = gpuCollectTargets().filter(t => t.host);
    if (!targets.length) { uiToast('请至少填写一台服务器的主机地址', 'warn', 5200); return; }
    const burnSeconds = parseInt($id('gpuBurnSec').value, 10) || 1800;
    const btn = $id('btnGpuStart');
    btn.disabled = true; btn.textContent = '启动中…';
    let started = 0, failed = [], skipped = [];
    const activeNow = gpuActiveKeys();
    for (const t of targets) {
      const key = gpuTargetKey(t.host, t.port);
      if (activeNow.has(key)) { skipped.push(key); continue; }
      if (!t.username) { failed.push(`${t.host}: 缺用户名`); continue; }
      if (!t.password && !t.keyPath) { failed.push(`${t.host}: SSH 登录需要密码或密钥 (sudo 免密≠SSH 免密)`); continue; }
      try {
        const r = await fetch('/api/gpu/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...t, burnSeconds, engine: gpuGetEngine(), precision: gpuGetPrecision() })
        });
        const d = await r.json();
        if (d.ok && d.jobId) {
          gpuJobs[d.jobId] = { status: { phase: 'connecting', host: t.host }, result: null };
          started++;
        } else {
          failed.push(`${t.host}: ${d.message || d.error || '启动失败'}`);
        }
      } catch (e) { failed.push(`${t.host}: ${e.message}`); }
    }
    btn.disabled = false; btn.textContent = '启动全部压测';
    gpuLog(started ? 'system' : 'error',
      `多机 GPU 压测启动完成: 成功 ${started}/${targets.length} 台` +
      (skipped.length ? '; 跳过(压测中): ' + skipped.join(', ') : '') +
      (failed.length ? '; 失败: ' + failed.join('; ') : ''));
    if (started) { enterWorkspace('gpu'); startGpuPolling(); }
    else uiToast('全部启动失败:\n' + failed.join('\n'), 'error', 6000);    if (!started && skipped.length && !failed.length) {
      uiToast('以下机器正在压测中, 本次点击不生效:\n' + skipped.join('\n'), 'warn', 5200);    }
  });

  $id('btnGpuStopAll').addEventListener('click', async () => {
    if (!(await uiConfirm('确定停止全部远端 GPU 压测?'))) return;
    try {
      await fetch('/api/gpu/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      gpuLog('warn', '已向全部任务发送停止指令。');
    } catch (e) {}
    setTimeout(startGpuPolling, 1500);
  });

  async function gpuStopOne(jobId) {
    try {
      await fetch('/api/gpu/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
      });
      gpuLog('warn', `已停止任务 ${jobId}。`);
    } catch (e) {}
    setTimeout(startGpuPolling, 1200);
  }

  // ---------- 轮询与实时遥测 ----------

  function renderGpuJobBlocks() {
    const wrap = $id('gpuJobBlocks');
    const entries = Object.entries(gpuJobs);
    const anyActive = entries.some(([, j]) => ['connecting', 'uploading', 'running', 'collecting'].includes(j.status.phase));
    $id('gpuRunningCount').textContent = entries.filter(([, j]) =>
      ['connecting', 'uploading', 'running', 'collecting'].includes(j.status.phase)).length;
    $id('gpuLiveSection').classList.toggle('hidden', entries.length === 0);
    $id('btnGpuStopAll').classList.toggle('hidden', !anyActive);

    wrap.innerHTML = entries.map(([jid, j]) => {
      const st = j.status || {};
      const active = ['connecting', 'uploading', 'running', 'collecting'].includes(st.phase);
      const isFail = st.phase === 'done_fail';
      const phaseColor = (st.phase === 'error' || isFail) ? 'var(--danger)' :
        (st.phase === 'done' ? 'var(--accent)' : 'var(--gray-600)');
      const liveRows = (st.live || []).map(g => {
        const hot = (g.temp || 0) >= 85;
        return `<tr><td>GPU${g.index}</td>` +
          `<td style="${hot ? 'color:var(--danger);font-weight:700' : ''}">${g.temp ?? '-'}${hot ? ' ⚠' : ''}</td>` +
          `<td>${g.pwr ?? '-'}</td><td>${g.util ?? '-'}</td><td>${g.clk ?? '-'}</td></tr>`;
      }).join('');
      return `
      <div class="gpu-job-block" data-job="${jid}">
        <div class="gjb-head">
          <b>${j.status.host || jid}</b>
          <span class="gjb-phase" style="color:${phaseColor}">${gpuPhaseText(st)}</span>
          ${active ? `<span class="gjb-elapsed">${Math.floor((st.elapsed || 0) / 60)}m${(st.elapsed || 0) % 60}s / ${Math.round((st.burnSeconds || 0) / 60)}m</span>
          <button type="button" class="btn btn-danger btn-xs" data-stopjob="${jid}">停止</button>` : ''}
          ${st.phase === 'error' ? `<div class="gjb-err">${(st.error || '').slice(0, 160)}</div>` : ''}
          ${isFail ? `<div class="gjb-err">✗ ${(st.failSummary || '压测失败, 详见结果卡').replace(/</g, '&lt;').slice(0, 200)}</div>` : ''}
        </div>
        ${active ? `
        <div class="gjb-bar"><div style="width:${st.progress || 0}%;background:var(--accent);"></div></div>` : ''}
        ${(st.live || []).length ? `
        <table class="clean-table" style="width:100%;font-size:12px;">
          <thead><tr><th>GPU</th><th>温度℃</th><th>功耗W</th><th>利用率%</th><th>SM时钟MHz</th></tr></thead>
          <tbody>${liveRows}</tbody>
        </table>` : (active ? '<div class="gjb-waiting">等待遥测数据…(首个采样约 15s 后)</div>' : '')}
      </div>`;
    }).join('');

    wrap.querySelectorAll('[data-stopjob]').forEach(b => {
      b.addEventListener('click', () => gpuStopOne(b.getAttribute('data-stopjob')));
    });
  }

  function startGpuPolling() {
    stopGpuPolling();
    let busy = false;
    const tick = async () => {
      if (busy) return;                    // 上一轮未返回: 跳过本轮, 不堆积请求
      busy = true;
      try {
        const ctl = new AbortController();
        const abortT = setTimeout(() => ctl.abort(), 10000);   // 单请求 10s 硬超时
        const r = await fetch('/api/gpu/status', { signal: ctl.signal });
        clearTimeout(abortT);
        if (r.status === 401) { location.replace('/login.html'); return; }
        const d = await r.json();
        if (!d.ok || !Array.isArray(d.jobs)) return;
        let anyActive = false;
        for (const st of d.jobs) {
          gpuJobs[st.id] = gpuJobs[st.id] || { status: st, result: null };
          gpuJobs[st.id].status = st;
          if (['connecting', 'uploading', 'running', 'collecting'].includes(st.phase)) anyActive = true;
          if (st.hasResult && !gpuJobs[st.id].result) {
            try {
              const rr = await fetch('/api/gpu/result?jobId=' + encodeURIComponent(st.id));
              const dd = await rr.json();
              if (dd.ok && dd.result) {
                gpuJobs[st.id].result = dd.result;
                gpuLog('ok', `[${st.host || st.id}] GPU 压测报告就绪: ${dd.result.verdict}`);
                renderGpuResults();
              }
            } catch (e) {}
          }
        }
        renderGpuJobBlocks();
        if (!anyActive) { stopGpuPolling(); return; }
      } catch (e) { /* 网络抖动/超时: 等下一轮 */ }
      finally { busy = false; }
      gpuPollTimer = setTimeout(tick, 5000);   // 自调度: 完成后才排下一次
    };
    tick();
  }
  function stopGpuPolling() {
    if (gpuPollTimer) { clearTimeout(gpuPollTimer); gpuPollTimer = null; }
  }

  // ---------- 结果渲染 (多台各自一块, 各自导出) ----------

  function renderGpuResultBlock(jobId, parsed, hostLabel) {
    const b = window.gpuReportBuilder;
    const m = parsed.meta || {}, sm = parsed.summary || {}, burn = parsed.burn || {};
    const gpus = parsed.gpus || [];
    const kpi = (v, l, color) =>
      `<div style="border:1px solid var(--gray-200);border-radius:10px;padding:10px 12px;background:var(--gray-100);">` +
      `<div style="font-size:18px;font-weight:800;color:${color || 'var(--black)'};">${v}</div>` +
      `<div style="font-size:11px;color:var(--gray-400);">${l}</div></div>`;
    const tmaxHot = (sm.tmaxAll || 0) >= 80;
    const rows = gpus.map(g => {
      const v = b.gpuVerdict(g);
      return `<tr><td>GPU${g.index}</td><td>${b.fmt(g.bus)}</td><td>${b.fmt(g.tmax, '°C')}</td>` +
        `<td>${b.fmt(g.pmax, 'W')}</td><td>${b.fmt(g.clkMin)} / ${b.fmt(g.clkAvg)}</td>` +
        `<td>${b.fmt(g.gflopsAvg)}</td><td>${(g.throttleThermal || 0)}/${g.sampleCount || 0}</td>` +
        `<td>${v.text}</td></tr>`;
    }).join('');

    const clsName = { real: '真实观察', false: '误报', env: '环境限制/待复核', fail: '失败项' };
    const adjHtml = (parsed.adjudications || []).filter(a => a.level !== 'PASS').map(a =>
      `<div>· [${a.level === 'FAIL' ? '✗' : '⑂'} <b style="color:${a.cls === 'real' ? '#F5A623' : a.cls === 'false' ? '#3B9EFF' : a.cls === 'fail' ? 'var(--danger)' : 'var(--gray-400)'}">${clsName[a.cls] || a.cls}</b>] ${b.esc(a.text)}</div>`
    ).join('');

    const badgeColor = parsed.verdictCls === 'pass' ? '#35C46E' : (parsed.verdictCls === 'warn' ? '#F5A623' : 'var(--danger)');
    return `
    <div class="gpu-result-block" data-job="${jobId}" style="border:1px solid var(--gray-200);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <b style="font-size:14px;">${b.esc(hostLabel || m.hostname || jobId)}</b>
          ${m.hostIps && m.hostIps.length ? `<span style="font-size:11px;color:var(--gray-400);">IP: ${b.esc(m.hostIps.join(', '))}</span>` : ''}
          <span style="background:${badgeColor};color:#fff;padding:2px 12px;border-radius:999px;font-size:12px;font-weight:700;">${b.esc(parsed.verdict)}</span>
          <span style="font-size:11px;color:var(--gray-400);">${m.burnStart ? b.esc(m.burnStart) + ' · ' : ''}${m.durationSec ? Math.round(m.durationSec / 60) + ' 分钟' : ''}${m.source === 'ssh' ? ' · SSH 自动' : ' · 手动上传'}</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-xs" data-gpu-export="html" data-job="${jobId}">导出 HTML</button>
          <button class="btn btn-secondary btn-xs" data-gpu-export="md" data-job="${jobId}">导出 MD</button>
          <button class="btn btn-secondary btn-xs" data-gpu-export="pdf" data-job="${jobId}">导出 PDF</button>
          <button class="btn btn-outline btn-xs" data-gpu-export="preview" data-job="${jobId}">在线查看</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
        ${kpi(gpus.length ? `${burn.okCount || 0}/${gpus.length} OK` : '-', 'GPU 压测', '#35C46E')}
        ${kpi(sm.tmaxAll != null ? Math.round(sm.tmaxAll) + '°C' : '-', '最高温度', tmaxHot ? '#F5A623' : 'inherit')}
        ${kpi(sm.pmaxAll != null ? Math.round(sm.pmaxAll) + ' W' : '-', '峰值功耗', 'inherit')}
        ${kpi(sm.gflopsMax != null ? Math.round(sm.gflopsMax) : '-', '算力峰值 GFLOPS', 'inherit')}
        ${kpi(burn.eccUE != null ? `CE${burn.eccCE}/UE${burn.eccUE}` : '未检测', '内存 ECC', (burn.eccUE || 0) > 0 ? 'var(--danger)' : '#35C46E')}
      </div>
      <div class="table-responsive" style="border:1px solid var(--gray-200);">
        <table class="clean-table" style="width:100%;">
          <thead><tr><th>GPU</th><th>PCIe 总线</th><th>温度峰值</th><th>功耗峰值</th>
            <th>SM时钟 最低/均值</th><th>平均算力 GFLOPS</th><th>热降频采样</th><th>判定</th></tr></thead>
          <tbody>${rows || '<tr class="empty-row"><td colspan="8">无逐卡数据</td></tr>'}</tbody>
        </table>
      </div>
      ${adjHtml ? `<div style="font-size:12px;color:var(--gray-400);line-height:1.8;margin-top:8px;">
        脚本结论: ${b.esc(sm.scriptVerdict || '-')} (PASS ${sm.passCount || 0} / WARN ${sm.warnCount || 0} / FAIL ${sm.failCount || 0})<br>${adjHtml}</div>` : ''}
    </div>`;
  }

  function renderGpuResults() {
    const entries = Object.entries(gpuJobs).filter(([, j]) => j.result);
    $id('gpuEmptyState').classList.toggle('hidden', entries.length > 0);
    $id('gpuResultBody').classList.toggle('hidden', entries.length === 0);
    // SSH 任务按服务器分块; 手动解析结果 (manual_*) 也各占一块
    $id('gpuResultBody').innerHTML = entries.map(([jid, j]) =>
      renderGpuResultBlock(jid, j.result, j.result.jobHost || (j.status && j.status.host) || null)).join('');
    if (entries.length) enterWorkspace('gpu');
  }

  // 导出按钮 (事件委托, 支持多块)
  $id('gpuResultSection').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-gpu-export]');
    if (!btn) return;
    const jobId = btn.getAttribute('data-job');
    const j = gpuJobs[jobId];
    if (!j || !j.result) { uiToast('该任务暂无结果', 'warn', 5200); return; }
    const parsed = j.result;
    const kind = btn.getAttribute('data-gpu-export');
    const builder = window.gpuReportBuilder;

    if (kind === 'html') {
      downloadBlob(builder.buildHtmlReport(parsed), builder.buildFilename(parsed, 'html'), 'text/html;charset=utf-8');
      gpuLog('ok', `GPU HTML 报告已导出 (${parsed.meta.hostname || jobId})。`);
    } else if (kind === 'md') {
      downloadBlob(builder.buildMarkdownReport(parsed), builder.buildFilename(parsed, 'md'), 'text/markdown;charset=utf-8');
      gpuLog('ok', `GPU MD 报告已导出 (${parsed.meta.hostname || jobId})。`);
    } else if (kind === 'preview') {
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '生成中…';
      try {
        const r = await fetch('/api/gpu/report', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: builder.buildHtmlReport(parsed) })
        });
        const d = await r.json();
        if (!d.ok) { uiToast(d.error || '生成失败', 'error', 5200); return; }
        // 真实 URL: 新标签打开 (被拦截时可右键复制链接)
        const a = document.createElement('a');
        a.href = d.url; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        gpuLog('ok', '报告在线查看已生成: ' + d.url);
      } catch (err) {
        uiToast('在线查看失败: ' + err.message, 'error', 6000);      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    } else if (kind === 'pdf') {
      if (typeof html2pdf === 'undefined') { uiToast('PDF 组件未加载', 'error', 5200); return; }
      const orig = btn.innerHTML;
      btn.disabled = true; btn.textContent = '生成中…';
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:820px;background:#f3f5f9;z-index:-1;';
      try {
        const doc = new DOMParser().parseFromString(builder.buildHtmlReport(parsed), 'text/html');
        const styleEl = doc.querySelector('style');
        if (styleEl) holder.appendChild(styleEl);
        while (doc.body.firstChild) holder.appendChild(doc.body.firstChild);
        document.body.appendChild(holder);
        await html2pdf().set({
          margin: [8, 8, 10, 8],
          filename: builder.buildFilename(parsed, 'pdf'),
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: '#f3f5f9', logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['css', 'legacy'], avoid: ['.kpi', '.warn-item', 'tr', '.chart'] }
        }).from(holder).save();
        gpuLog('ok', `GPU PDF 报告已生成 (${parsed.meta.hostname || jobId})。`);
      } catch (err) {
        uiToast('PDF 生成失败: ' + (err && err.message ? err.message : err), 'error', 6000);      } finally {
        holder.remove();
        btn.disabled = false; btn.innerHTML = orig;
      }
    }
  });

  // ---------- 批量粘贴机器 (空格/Tab 分隔) ----------
  // 密码模式: IP 端口 用户名 密码        → 「识别并填入」
  // 密钥模式: IP 端口 用户名 密钥路径     → 「识别并填入(密钥)」

  function gpuParsePasted(mode) {
    const text = ($id('gpuPasteBox').value || '').trim();
    if (!text) {
      uiToast(mode === 'key' ? '请先粘贴机器信息, 每行: IP 端口 用户名 密钥路径' : '请先粘贴机器信息, 每行: IP 端口 用户名 密码', 'warn', 5200);
      return;
    }
    const list = []; let bad = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^(主机|host|ip)\b/i.test(line)) continue;   // 跳过表头行
      const parts = line.split(/[\s\u3000]+/).filter(Boolean);
      if (!parts.length || !/^[-\w.:]+$/.test(parts[0])) { bad++; continue; }
      const host = parts[0];
      const port = parseInt(parts[1], 10) || 22;
      const username = parts[2] || 'root';
      let password = '', keyPath = '';
      if (mode === 'key') {
        keyPath = parts.slice(3).join(' ');              // 第 4 段起 = 密钥路径
        if (!keyPath && window.uploadedKeyPath) keyPath = window.uploadedKeyPath;  // 未指定路径时用全局上传的密钥
      } else {
        password = parts.slice(3, 5).join(' ');          // 容忍含空格密码
        keyPath = parts.length > 5 ? parts[5] : '';
      }
      list.push({ host, port, username, password, keyPath, useSudo: username !== 'root' });
    }
    if (!list.length) {
      uiToast(mode === 'key' ? '未识别到有效机器行 (每行格式: IP 端口 用户名 密钥路径)' : '未识别到有效机器行 (每行格式: IP 端口 用户名 密码)', 'warn', 5200);
      return;
    }
    gpuFillTargets(list);
    const msg = '成功识别 ' + list.length + ' 台机器' + (bad ? ', 跳过 ' + bad + ' 行无效数据' : '') + (mode === 'key' ? ' (密钥登录)' : '') + ', 已自动填入列表。';
    uiToast(msg, 'ok', 4200);
    gpuLog('ok', '[粘贴导入' + (mode === 'key' ? '-密钥' : '') + '] ' + msg + ' (' + list.map(x => gpuTargetKey(x.host, x.port)).join(', ') + ')');
  }

  $id('btnGpuPasteFill').addEventListener('click', () => gpuParsePasted('password'));
  $id('btnGpuPasteFillKey').addEventListener('click', () => gpuParsePasted('key'));

  // ---------- 表格批量导入机器 (CSV / Excel) ----------

  const GPU_IMPORT_COLS = {
    host: ['host', '主机', 'ip', '地址', '服务器', 'server', 'address', 'ip地址', '机器'],
    port: ['port', '端口', 'ssh端口', 'sshport'],
    username: ['user', 'username', '用户名', '账号', '用户'],
    password: ['password', 'pass', '密码', 'pwd'],
    keyPath: ['key', 'keypath', '密钥', '密钥路径', '私钥'],
    useSudo: ['sudo', 'usesudo', '提权', 'sudo提权', '使用sudo']
  };

  /** CSV 解析 (支持引号包裹、逗号/分号/Tab 分隔、BOM) */
  function gpuParseCsv(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    const firstLine = (text.split(/\r?\n/)[0] || '');
    const delim = [',', ';', '\t'].map(d => ({ d, n: firstLine.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
    const rows = []; let cur = [], field = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') { q = false; }
        else { field += c; }
      } else if (c === '"') { q = true; }
      else if (c === delim) { cur.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        cur.push(field); field = '';
        if (cur.some(x => x !== '')) rows.push(cur);
        cur = [];
      } else { field += c; }
    }
    if (field !== '' || cur.length) { cur.push(field); if (cur.some(x => x !== '')) rows.push(cur); }
    return rows;
  }

  /** 表格行 → 机器对象 (按表头模糊识别) */
  function gpuMapImportRows(rows) {
    if (!rows || !rows.length) return { err: '表格为空' };
    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const idx = {};
    for (const k of Object.keys(GPU_IMPORT_COLS)) {
      idx[k] = header.findIndex(h => GPU_IMPORT_COLS[k].includes(h));
    }
    if (idx.host < 0) {
      return { err: '未识别到「主机/IP」列。表头需包含: 主机 (或 IP/地址/服务器), 其余列可选: 端口/用户名/密码/密钥路径/sudo提权' };
    }
    const list = []; let bad = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const host = String(row[idx.host] || '').trim();
      if (!host) { bad++; continue; }
      const get = k => (idx[k] >= 0 ? String(row[idx[k]] || '').trim() : '');
      const sudoRaw = get('useSudo').toLowerCase();
      list.push({
        host,
        port: parseInt(get('port'), 10) || 22,
        username: get('username') || 'root',
        password: get('password'),
        keyPath: get('keyPath') || (window.uploadedKeyPath || ''),
        useSudo: ['是', 'true', '1', 'y', 'yes', '开启', 'on'].includes(sudoRaw)
      });
    }
    return { list, bad };
  }

  /** 导入结果 → 重建目标行 */
  function gpuFillTargets(list) {
    const box = $id('gpuTargetList');
    box.innerHTML = '';
    list.forEach(t => gpuAddTargetRow(t));
    if (!list.length) gpuAddTargetRow();
  }

  $id('btnGpuImport').addEventListener('click', () => $id('gpuImportFile').click());
  $id('gpuImportFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      let rows;
      const name = file.name.toLowerCase();
      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        rows = gpuParseCsv(await file.text());
      } else {
        if (typeof XLSX === 'undefined') { uiToast('Excel 解析组件未加载 (vendor/xlsx.full.min.js)', 'error', 5200); return; }
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      }
      const mapped = gpuMapImportRows(rows);
      if (mapped.err) { uiToast('导入失败: ' + mapped.err, 'error', 5200); gpuLog('error', '机器表格导入失败: ' + mapped.err); return; }
      if (!mapped.list.length) { uiToast('表格中没有有效机器行', 'warn', 5200); return; }
      gpuFillTargets(mapped.list);
      const msg = `成功导入 ${mapped.list.length} 台机器` + (mapped.bad ? `, 跳过 ${mapped.bad} 行无效数据` : '') + ', 已自动填入下方列表。';
      uiToast(msg, 'ok', 4200);      gpuLog('ok', '[导入] ' + msg + ' (' + mapped.list.map(t => gpuTargetKey(t.host, t.port)).join(', ') + ')');
    } catch (err) {
      uiToast('解析文件失败: ' + err.message, 'error', 6000);    }
  });

  // 导入模板下载 (带 BOM, Excel 打开中文不乱码)
  $id('gpuTplLink').addEventListener('click', (e) => {
    e.preventDefault();
    const csv = '\uFEFF主机,端口,用户名,密码,密钥路径,sudo提权\r\n' +
      '10.0.0.10,22,user,passwd,,是\r\n' +
      '10.0.0.11,22,user,passwd,,是\r\n' +
      '10.0.0.12,22,root,,/root/.ssh/id_rsa,否\r\n';
    downloadBlob(csv, 'IceBreaker机器导入模板.csv', 'text/csv;charset=utf-8');
  });

  // ---------- 模式 B: 手动上传产物解析 ----------

  $id('btnGpuParse').addEventListener('click', async () => {
    const read = (id) => {
      const f = $id(id).files && $id(id).files[0];
      return f ? f.text() : Promise.resolve('');
    };
    const btn = $id('btnGpuParse');
    btn.disabled = true; btn.textContent = '解析中…';
    try {
      const [reportTxt, telemetryCsv, burnLog] = await Promise.all(
        [read('gpuFileReport'), read('gpuFileTele'), read('gpuFileBurn')]);
      if (!reportTxt && !telemetryCsv && !burnLog) { uiToast('请至少选择一个产物文件', 'warn', 5200); return; }
      const r = await fetch('/api/gpu/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportTxt, telemetryCsv, burnLog })
      });
      const d = await r.json();
      if (!d.ok) { uiToast(d.error || '解析失败', 'error', 5200); gpuLog('error', '手动产物解析失败: ' + (d.error || '')); return; }
      const jid = 'manual_' + Date.now();
      gpuJobs[jid] = { status: { phase: 'done', host: d.result.meta.hostname || '手动上传' }, result: d.result };
      renderGpuResults();
      gpuLog('ok', '手动产物解析完成, 报告已生成。');
    } catch (e) {
      uiToast('解析失败: ' + e.message, 'error', 6000);    } finally {
      btn.disabled = false; btn.textContent = '解析并生成报告';
    }
  });

  // ---------- 一键 ZIP 下载全部报告 / 清空历史 ----------

  /** 报告基础名: 内网IP_端口 (无内网IP时用 SSH 主机_端口; 手动上传用 主机名) */
  function gpuReportBaseName(jobId, j) {
    const m = (j.result && j.result.meta) || {};
    const st = j.status || {};
    let ip = (m.hostIps && m.hostIps[0]) || m.sshHost || '';
    let port = m.sshPort || '';
    if (!ip && st.host) {
      const seg = String(st.host).split(':');
      ip = seg[0]; port = port || seg[1] || '';
    }
    if (!ip) ip = m.hostname || 'server';
    const clean = (s) => String(s || '').replace(/[^0-9A-Za-z._-]/g, '');
    let base = clean(ip) + (port ? '_' + clean(port) : '');
    if (String(jobId).startsWith('manual_')) base = '手动上传_' + (clean(m.hostname) || jobId.slice(-6));
    return base || jobId;
  }

  $id('btnGpuZipAll').addEventListener('click', async () => {
    const entries = Object.entries(gpuJobs).filter(([, j]) => j.result);
    if (!entries.length) { uiToast('当前没有可下载的报告', 'warn', 4200); return; }
    if (typeof fflate === 'undefined' || !fflate.zipSync) {
      uiToast('ZIP 组件未加载 (vendor/fflate.min.js)', 'error', 5200); return;
    }
    const btn = $id('btnGpuZipAll');
    btn.disabled = true; btn.textContent = '打包中…';
    try {
      const files = {};
      for (const [jid, j] of entries) {
        const base = gpuReportBaseName(jid, j);
        files[base + '.html'] = fflate.strToU8(window.gpuReportBuilder.buildHtmlReport(j.result));
        files[base + '.md'] = fflate.strToU8(window.gpuReportBuilder.buildMarkdownReport(j.result));
      }
      const zipped = fflate.zipSync(files);
      const blob = new Blob([zipped], { type: 'application/zip' });
      const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `IceBreaker压测报告_${entries.length}台_${d}.zip`;
      document.body.appendChild(a);   // 挂载后点击, 兼容更多浏览器内核
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      uiToast('已打包 ' + entries.length + ' 台机器的报告 (HTML+MD 各一份)', 'ok', 4200);
      gpuLog('ok', '[报告打包] ' + entries.length + ' 台: ' + entries.map(([jid, j]) => gpuReportBaseName(jid, j)).join(', '));
    } catch (err) {
      uiToast('打包失败: ' + err.message, 'error', 6000);
    } finally {
      btn.disabled = false; btn.textContent = '下载全部报告 (ZIP)';
    }
  });

  $id('btnGpuClearHistory').addEventListener('click', async () => {
    const finished = Object.entries(gpuJobs).filter(([, j]) =>
      !['connecting', 'uploading', 'running', 'collecting'].includes(j.status.phase));
    if (!finished.length) { uiToast('没有可清空的历史记录', 'warn', 4200); return; }
    const yes = await uiConfirm('确定清空 ' + finished.length + ' 条已结束的压测记录与报告?\n(在途任务不受影响)');
    if (!yes) return;
    try {
      await fetch('/api/gpu/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) { /* 服务端清理失败也继续清本地展示 */ }
    for (const [jid, j] of finished) { delete gpuJobs[jid]; }
    renderGpuJobBlocks();
    renderGpuResults();
    uiToast('已清空 ' + finished.length + ' 条历史记录', 'ok', 4200);
    gpuLog('system', '[清空历史] 已清空 ' + finished.length + ' 条已结束任务。');
  });

  // ============================ NPU(昇腾) 服务器压测 ============================

  const npuJobs = {};               // jobId -> { status, result }
  let npuPollTimer = null;

  const npuPhaseMap = {
    connecting: 'SSH 连接中', uploading: '上传压测脚本', running: 'NPU 压测运行中',
    collecting: '收集产物并解析', done: '已完成', error: '出错', stopped: '已停止',
    detecting: '探测组件', installing: '安装中 (数分钟)'
  };
  const npuStageMap = {
    preparing: '健康基线检查中', burning: 'NPU 满载压测中', finalizing: '压测完成 · 汇总中'
  };
  const npuPhaseText = (st) => {
    if (st.device === 'npu-install') return 'ToolBox 安装: ' + (st.note || npuPhaseMap[st.phase] || st.phase);
    return npuStageMap[st.stage] || npuPhaseMap[st.phase] || st.phase;
  };
  function npuLog(type, msg) { appendLog(type, '[NPU] ' + msg); }

  // ---------- 目标行 (与 GPU 行同构, 独立实现) ----------

  function npuAddTargetRow(prefill) {
    const row = document.createElement('div');
    row.className = 'gpu-target-row';
    row.innerHTML = `
      <div class="gtr-row">
        <input type="text" class="form-input gtr-host" placeholder="SSH 主机, 如 172.16.11.30">
        <input type="number" class="form-input gtr-port" value="22" min="1" max="65535" title="端口">
        <button type="button" class="btn btn-primary btn-xs gtr-start">启动</button>
        <button type="button" class="btn-icon gtr-del" title="移除该机器">✕</button>
      </div>
      <div class="gtr-row">
        <input type="text" class="form-input gtr-user" placeholder="用户名 (如 root)">
        <input type="password" class="form-input gtr-pass" placeholder="密码 (SSH 登录)">
      </div>
      <div class="gtr-row" style="margin-bottom:0;align-items:center;">
        <input type="text" class="form-input gtr-key" placeholder="密钥路径 (可选; 支持Linux/Windows路径)">
        <label class="custom-check-clean gtr-sudo-wrap" title="普通用户提权 (npu-smi/安装需要 root)">
          <input type="checkbox" class="gtr-sudo" checked> sudo 提权
        </label>
      </div>`;
    if (prefill) {
      row.querySelector('.gtr-host').value = prefill.host || '';
      row.querySelector('.gtr-port').value = prefill.port || 22;
      row.querySelector('.gtr-user').value = prefill.username || '';
      row.querySelector('.gtr-pass').value = prefill.password || '';
      row.querySelector('.gtr-key').value = prefill.keyPath || '';
      if (prefill.useSudo != null) row.querySelector('.gtr-sudo').checked = !!prefill.useSudo;
    }
    row.querySelector('.gtr-del').addEventListener('click', () => {
      if (document.querySelectorAll('#npuTargetList .gpu-target-row').length > 1) row.remove();
      else uiToast('至少保留一台机器', 'warn', 4200);
    });
    // sudo 联动
    const sudoBox = row.querySelector('.gtr-sudo');
    const userBox = row.querySelector('.gtr-user');
    const passBox = row.querySelector('.gtr-pass');
    const keyBox = row.querySelector('.gtr-key');
    const syncSudo = () => {
      const isRoot = userBox.value.trim() === 'root';
      if (isRoot) sudoBox.checked = false;
      sudoBox.disabled = isRoot;
      const sudoOn = sudoBox.checked && !sudoBox.disabled;
      const keyUsed = keyBox.value.trim() !== '';
      if (sudoOn) {
        passBox.placeholder = keyUsed ? 'sudo 密码 (SSH 走密钥; 留空=免密 sudo)' : '密码 (SSH 登录 + sudo 提权; 留空=免密 sudo)';
      } else {
        passBox.placeholder = keyUsed ? '密码 (可留空, SSH 走密钥)' : '密码 (SSH 登录)';
      }
    };
    sudoBox.addEventListener('change', syncSudo);
    userBox.addEventListener('input', syncSudo);
    keyBox.addEventListener('input', syncSudo);
    syncSudo();
    attachRowKeyUpload(row);
    // 单机启动
    row.querySelector('.gtr-start').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const cfg = {
        host: row.querySelector('.gtr-host').value.trim(),
        port: parseInt(row.querySelector('.gtr-port').value, 10) || 22,
        username: row.querySelector('.gtr-user').value.trim(),
        password: row.querySelector('.gtr-pass').value,
        keyPath: row.querySelector('.gtr-key').value.trim(),
        useSudo: row.querySelector('.gtr-sudo').checked
      };
      const key = gpuTargetKey(cfg.host, cfg.port);
      if (npuActiveKeys().has(key)) {
        uiToast('【' + key + '】正在压测中, 本次点击不生效。', 'warn', 5200);
        return;
      }
      if (!cfg.host || !cfg.username) { uiToast('请完整填写该机器的主机与用户名', 'warn', 4200); return; }
      if (!cfg.password && !cfg.keyPath && cfg.username !== 'root') { uiToast('【' + cfg.host + '】缺少密码/密钥', 'warn', 4200); return; }
      const burnSeconds = parseInt($id('npuBurnSec').value, 10) || 1800;
      btn.disabled = true; btn.textContent = '启动中';
      try {
        const r = await fetch('/api/npu/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...cfg, burnSeconds })
        });
        const d = await r.json();
        if (d.ok && d.jobId) {
          npuJobs[d.jobId] = { status: { phase: 'connecting', host: key, device: 'npu' }, result: null };
          npuLog('system', '[' + key + '] 单机 NPU 压测已启动 (' + Math.round(burnSeconds / 60) + ' 分钟)。');
          enterWorkspace('npu');
          startNpuPolling();
        } else {
          uiToast(d.message || d.error || '启动失败', 'error', 6000);
        }
      } catch (err) {
        uiToast('启动请求失败: ' + err.message, 'error', 6000);
      } finally {
        btn.disabled = false; btn.textContent = '启动';
      }
    });
    $id('npuTargetList').appendChild(row);
  }

  $id('btnNpuAddTarget').addEventListener('click', () => npuAddTargetRow());
  npuAddTargetRow();

  function npuCollectTargets() {
    return Array.from(document.querySelectorAll('#npuTargetList .gpu-target-row')).map(r => ({
      host: r.querySelector('.gtr-host').value.trim(),
      port: parseInt(r.querySelector('.gtr-port').value, 10) || 22,
      username: r.querySelector('.gtr-user').value.trim(),
      password: r.querySelector('.gtr-pass').value,
      keyPath: r.querySelector('.gtr-key').value.trim(),
      useSudo: r.querySelector('.gtr-sudo').checked
    }));
  }

  function npuActiveKeys() {
    const s = new Set();
    for (const j of Object.values(npuJobs)) {
      if (['connecting', 'uploading', 'running', 'collecting'].includes(j.status.phase)) s.add(j.status.host);
    }
    return s;
  }

  function npuFillTargets(list) {
    const box = $id('npuTargetList');
    box.innerHTML = '';
    list.forEach(t => npuAddTargetRow(t));
    if (!list.length) npuAddTargetRow();
  }

  // ---------- 粘贴导入 (密码/密钥双按钮) ----------

  function npuParsePasted(mode) {
    const text = ($id('npuPasteBox').value || '').trim();
    if (!text) { uiToast('请先粘贴机器信息, 每行: IP 端口 用户名 密码/密钥路径', 'warn', 5200); return; }
    const list = []; let bad = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (/^(主机|host|ip)\b/i.test(line)) continue;
      const parts = line.split(/[\s\u3000]+/).filter(Boolean);
      if (!parts.length || !/^[-\w.:]+$/.test(parts[0])) { bad++; continue; }
      const host = parts[0];
      const port = parseInt(parts[1], 10) || 22;
      const username = parts[2] || 'root';
      let password = '', keyPath = '';
      if (mode === 'key') {
        keyPath = parts.slice(3).join(' ');
        if (!keyPath && window.uploadedKeyPath) keyPath = window.uploadedKeyPath;
      }
      else { password = parts.slice(3, 5).join(' '); keyPath = parts.length > 5 ? parts[5] : ''; }
      list.push({ host, port, username, password, keyPath, useSudo: username !== 'root' });
    }
    if (!list.length) { uiToast('未识别到有效机器行', 'warn', 5200); return; }
    npuFillTargets(list);
    const msg = '成功识别 ' + list.length + ' 台 NPU 机器' + (bad ? ', 跳过 ' + bad + ' 行' : '') + ', 已自动填入。';
    uiToast(msg, 'ok', 4200);
    npuLog('ok', '[粘贴导入] ' + msg);
  }

  $id('btnNpuPasteFill').addEventListener('click', () => npuParsePasted('password'));
  $id('btnNpuPasteFillKey').addEventListener('click', () => npuParsePasted('key'));

  // ---------- NPU 表格批量导入机器 (CSV / Excel) ----------

  $id('btnNpuImport').addEventListener('click', () => $id('npuImportFile').click());
  $id('npuImportFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      let rows;
      const name = file.name.toLowerCase();
      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        rows = gpuParseCsv(await file.text());
      } else {
        if (typeof XLSX === 'undefined') { uiToast('Excel 解析组件未加载', 'error', 5200); return; }
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      }
      const mapped = gpuMapImportRows(rows);
      if (mapped.err) { uiToast('导入失败: ' + mapped.err, 'error', 6000); return; }
      if (!mapped.list.length) { uiToast('表格中没有有效机器行', 'warn', 4200); return; }
      npuFillTargets(mapped.list);
      const msg = '成功导入 ' + mapped.list.length + ' 台 NPU 机器' + (mapped.bad ? ', 跳过 ' + mapped.bad + ' 行' : '') + '。';
      uiToast(msg, 'ok', 4200);
      npuLog('ok', '[NPU 导入] ' + msg);
    } catch (err) {
      uiToast('解析文件失败: ' + err.message, 'error', 6000);
    }
  });

  // NPU 模板下载
  $id('npuTplLink').addEventListener('click', (e) => {
    e.preventDefault();
    const csv = '\uFEFF主机,端口,用户名,密码,密钥路径,sudo提权\r\n' +
      '10.0.0.10,22,user,passwd,,是\r\n' +
      '10.0.0.11,22,user,passwd,,是\r\n' +
      '10.0.0.12,22,root,,/root/.ssh/id_rsa,否\r\n';
    downloadBlob(csv, 'IceBreaker-NPU机器导入模板.csv', 'text/csv;charset=utf-8');
  });

  // ---------- 启动全部 / 停止 ----------

  $id('btnNpuStart').addEventListener('click', async () => {
    const targets = npuCollectTargets().filter(t => t.host);
    if (!targets.length) { uiToast('请至少填写一台机器的主机地址', 'warn', 4200); return; }
    const burnSeconds = parseInt($id('npuBurnSec').value, 10) || 1800;
    const btn = $id('btnNpuStart');
    btn.disabled = true; btn.textContent = '启动中…';
    let started = 0, failed = [], skipped = [];
    const activeNow = npuActiveKeys();
    for (const t of targets) {
      const key = gpuTargetKey(t.host, t.port);
      if (activeNow.has(key)) { skipped.push(key); continue; }
      if (!t.username) { failed.push(t.host + ': 缺用户名'); continue; }
      if (!t.password && !t.keyPath && t.username !== 'root') { failed.push(t.host + ': 缺密码/密钥'); continue; }
      try {
        const r = await fetch('/api/npu/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...t, burnSeconds, engine: gpuGetEngine(), precision: gpuGetPrecision() })
        });
        const d = await r.json();
        if (d.ok && d.jobId) {
          npuJobs[d.jobId] = { status: { phase: 'connecting', host: key, device: 'npu' }, result: null };
          started++;
        } else { failed.push(t.host + ': ' + (d.message || d.error || '启动失败')); }
      } catch (e) { failed.push(t.host + ': ' + e.message); }
    }
    btn.disabled = false; btn.textContent = '启动全部压测';
    npuLog(started ? 'system' : 'error',
      'NPU 多机压测启动: 成功 ' + started + '/' + targets.length +
      (skipped.length ? '; 跳过(压测中): ' + skipped.join(', ') : '') +
      (failed.length ? '; 失败: ' + failed.join('; ') : ''));
    if (started) { enterWorkspace('npu'); startNpuPolling(); }
    else uiToast('全部启动失败:\n' + failed.join('\n'), 'error', 7000);
  });

  $id('btnNpuStopAll').addEventListener('click', async () => {
    if (!(await uiConfirm('确定停止全部 NPU 压测?'))) return;
    try { await fetch('/api/npu/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); npuLog('warn', '已发送停止指令。'); } catch (e) {}
    setTimeout(startNpuPolling, 1500);
  });

  // ---------- MindX ToolBox 安装 ----------

  function npuRefreshPkgsHint() {
    fetch('/api/npu/packages').then(r => r.json()).then(d => {
      if (!d.ok) return;
      const hint = $id('npuPkgsHint');
      const cann = (d.cann || []).join(', ');
      const tb = (d.toolbox || []).join(', ');
      hint.innerHTML = d.ready
        ? '本地安装包就绪: ' + (cann ? 'CANN(' + cann + ') ' : '') + (tb ? 'ToolBox(' + tb + ')' : '')
        : '未检测到本地安装包。安装 MindX ToolBox 需先从 <a href="https://www.hiascend.com/software" target="_blank" style="color:var(--accent);">昇腾官网</a> 下载与驱动配套的 CANN toolkit 与 MindX ToolBox (.run), 放入项目 packages/ 目录。';
    }).catch(() => {});
  }
  npuRefreshPkgsHint();

  $id('btnNpuToolbox').addEventListener('click', async () => {
    const targets = npuCollectTargets().filter(t => t.host && t.username);
    if (!targets.length) { uiToast('请先在上方填写至少一台机器', 'warn', 4200); return; }
    const pkgs = await fetch('/api/npu/packages').then(r => r.json()).catch(() => ({ ok: false }));
    if (!pkgs.ok || !pkgs.ready) {
      uiToast('本地 packages/ 目录没有安装包 (.run)。请先从昇腾官网下载配套版本的 CANN 与 MindX ToolBox 放入 packages/, 再点此按钮。', 'error', 8000);
      npuRefreshPkgsHint();
      return;
    }
    if (!(await uiConfirm('将对 ' + targets.length + ' 台机器检查并安装 MindX ToolBox (缺失才安装, 已装跳过)?\n安装包较大, 上传与安装需数分钟。'))) return;
    let queued = 0;
    for (const t of targets) {
      try {
        const r = await fetch('/api/npu/toolbox', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(t)
        });
        const d = await r.json();
        if (d.ok) queued++;
        else npuLog('warn', '[' + t.host + '] 安装任务未启动: ' + (d.message || ''));
      } catch (e) { npuLog('error', '[' + t.host + '] 安装请求失败: ' + e.message); }
    }
    if (queued) {
      uiToast('已对 ' + queued + ' 台机器发起 ToolBox 安装, 进度见任务区。', 'ok', 5000);
      npuLog('system', 'ToolBox 安装任务已发起: ' + queued + ' 台。');
      enterWorkspace('npu');
      startNpuPolling();
    }
  });

  // ---------- 轮询与任务块 ----------

  function renderNpuJobBlocks() {
    const wrap = $id('npuJobBlocks');
    const entries = Object.entries(npuJobs);
    const anyActive = entries.some(([, j]) => ['connecting', 'uploading', 'running', 'collecting', 'detecting', 'uploading', 'installing'].includes(j.status.phase));
    $id('npuRunningCount').textContent = entries.filter(([, j]) =>
      ['connecting', 'uploading', 'running', 'collecting', 'detecting', 'installing'].includes(j.status.phase)).length;
    $id('npuLiveSection').classList.toggle('hidden', entries.length === 0);
    $id('btnNpuStopAll').classList.toggle('hidden', !entries.some(([, j]) => ['connecting', 'uploading', 'running', 'collecting'].includes(j.status.phase)));

    wrap.innerHTML = entries.map(([jid, j]) => {
      const st = j.status || {};
      const active = ['connecting', 'uploading', 'running', 'collecting', 'detecting', 'installing'].includes(st.phase);
      const isInstall = st.device === 'npu-install';
      const phaseColor = st.phase === 'error' ? 'var(--danger)' : (st.phase === 'done' ? 'var(--accent)' : 'var(--gray-600)');
      const liveRows = (st.live || []).map(g => {
        const hot = (g.temp || 0) >= 80;
        return '<tr><td>NPU' + g.index + '</td>' +
          '<td style="' + (hot ? 'color:var(--danger);font-weight:700' : '') + '">' + (g.temp != null ? g.temp : '-') + (hot ? ' ⚠' : '') + '</td>' +
          '<td>' + (g.pwr != null ? g.pwr : '-') + '</td><td>' + (g.util != null ? g.util : '-') + '%</td></tr>';
      }).join('');
      return `
      <div class="gpu-job-block" data-job="${jid}">
        <div class="gjb-head">
          <b>${j.status.host || jid}${isInstall ? ' ⚙' : ''}</b>
          <span class="gjb-phase" style="color:${phaseColor}">${npuPhaseText(st)}</span>
          ${active && !isInstall ? `<span class="gjb-elapsed">${Math.floor((st.elapsed || 0) / 60)}m${(st.elapsed || 0) % 60}s / ${Math.round((st.burnSeconds || 0) / 60)}m</span>
          <button type="button" class="btn btn-danger btn-xs" data-stopjob="${jid}">停止</button>` : ''}
          ${st.phase === 'error' ? `<div class="gjb-err">${(st.error || '').slice(0, 160)}</div>` : ''}
        </div>
        ${active && !isInstall ? `<div class="gjb-bar"><div style="width:${st.progress || 0}%;background:var(--accent);"></div></div>` : ''}
        ${(st.live || []).length && !isInstall ? `
        <table class="clean-table" style="width:100%;font-size:12px;">
          <thead><tr><th>NPU</th><th>温度℃</th><th>功耗W</th><th>HBM%</th></tr></thead>
          <tbody>${liveRows}</tbody>
        </table>` : (active && !isInstall ? '<div class="gjb-waiting">等待遥测…(基线检查中)</div>' : '')}
      </div>`;
    }).join('');
    wrap.querySelectorAll('[data-stopjob]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!(await uiConfirm('确定停止该任务?'))) return;
        try { await fetch('/api/npu/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: b.getAttribute('data-stopjob') }) }); } catch (e) {}
        setTimeout(startNpuPolling, 1200);
      });
    });
  }

  function startNpuPolling() {
    stopNpuPolling();
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        const ctl = new AbortController();
        const abortT = setTimeout(() => ctl.abort(), 10000);
        const r = await fetch('/api/npu/status', { signal: ctl.signal });
        clearTimeout(abortT);
        if (r.status === 401) { location.replace('/login.html'); return; }
        const d = await r.json();
        if (!d.ok || !Array.isArray(d.jobs)) return;
        let anyActive = false;
        for (const st of d.jobs) {
          npuJobs[st.id] = npuJobs[st.id] || { status: st, result: null };
          npuJobs[st.id].status = st;
          if (['connecting', 'uploading', 'running', 'collecting', 'detecting', 'installing'].includes(st.phase)) anyActive = true;
          if (st.hasResult && !npuJobs[st.id].result) {
            try {
              const rr = await fetch('/api/npu/result?jobId=' + encodeURIComponent(st.id));
              const dd = await rr.json();
              if (dd.ok && dd.result) {
                npuJobs[st.id].result = dd.result;
                npuLog('ok', '[' + (st.host || st.id) + '] NPU 压测报告就绪: ' + dd.result.verdict);
                renderNpuResults();
              }
            } catch (e) {}
          }
        }
        renderNpuJobBlocks();
        if (!anyActive) { stopNpuPolling(); return; }
      } catch (e) {}
      finally { busy = false; }
      npuPollTimer = setTimeout(tick, 5000);
    };
    tick();
  }
  function stopNpuPolling() {
    if (npuPollTimer) { clearTimeout(npuPollTimer); npuPollTimer = null; }
  }

  // ---------- 结果渲染 ----------

  function npuReportBaseName(jobId, j) {
    const m = (j.result && j.result.meta) || {};
    const st = j.status || {};
    let ip = (m.hostIps && m.hostIps[0]) || m.sshHost || '';
    let port = m.sshPort || '';
    if (!ip && st.host) { const seg = String(st.host).split(':'); ip = seg[0]; port = port || seg[1] || ''; }
    if (!ip) ip = m.hostname || 'server';
    const clean = (s) => String(s || '').replace(/[^0-9A-Za-z._-]/g, '');
    let base = clean(ip) + (port ? '_' + clean(port) : '');
    if (String(jobId).startsWith('manual_')) base = '手动上传_' + (clean(m.hostname) || jobId.slice(-6));
    return base || jobId;
  }

  function renderNpuResultBlock(jobId, parsed, hostLabel) {
    const b = window.npuReportBuilder;
    const m = parsed.meta || {}, sm = parsed.summary || {}, burn = parsed.burn || {};
    const cards = parsed.npus || [];
    const kpi = (v, l, color) =>
      `<div style="border:1px solid var(--gray-200);border-radius:10px;padding:10px 12px;background:var(--gray-100);">` +
      `<div style="font-size:18px;font-weight:800;color:${color || 'var(--black)'};">${v}</div>` +
      `<div style="font-size:11px;color:var(--gray-400);">${l}</div></div>`;
    const rows = cards.map(g =>
      `<tr><td>NPU${g.index}</td><td>${b.fmt(g.tmax, '°C')}</td><td>${b.fmt(g.pmax, 'W')}</td>` +
      `<td>${b.fmt(g.hbmMax, '%')}</td><td>${g.sampleCount || 0}</td></tr>`).join('');
    const clsName = { real: '真实观察', false: '误报', env: '环境限制/待复核', fail: '失败项' };
    const adjHtml = (parsed.adjudications || []).map(a =>
      `<div>· [${a.level === 'FAIL' ? '✗' : '⑂'} <b style="color:${a.cls === 'real' ? '#F5A623' : a.cls === 'fail' ? 'var(--danger)' : 'var(--gray-400)'}">${clsName[a.cls] || a.cls}</b>] ${b.esc(a.text)}</div>`
    ).join('');
    const badgeColor = parsed.verdictCls === 'pass' ? '#35C46E' : (parsed.verdictCls === 'warn' ? '#F5A623' : 'var(--danger)');
    return `
    <div class="gpu-result-block" data-job="${jobId}" style="border:1px solid var(--gray-200);border-radius:12px;padding:16px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <b style="font-size:14px;">${b.esc(hostLabel || m.hostname || jobId)}</b>
          ${m.hostIps && m.hostIps.length ? `<span style="font-size:11px;color:var(--gray-400);">IP: ${b.esc(m.hostIps.join(', '))}</span>` : ''}
          ${m.model ? `<span style="font-size:11px;color:var(--gray-400);">${b.esc(m.model)}</span>` : ''}
          <span style="background:${badgeColor};color:#fff;padding:2px 12px;border-radius:999px;font-size:12px;font-weight:700;">${b.esc(parsed.verdict)}</span>
          ${burn.dmiMissing ? `<span style="font-size:11px;color:#F5A623;">仅基线检查 (ToolBox 未装)</span>` : ''}
          <span style="font-size:11px;color:var(--gray-400);">${m.burnStart ? b.esc(m.burnStart) + ' · ' : ''}${m.durationSec ? Math.round(m.durationSec / 60) + ' 分钟' : ''}${m.source === 'ssh' ? ' · SSH 自动' : ' · 手动上传'}</span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-xs" data-npu-export="html" data-job="${jobId}">导出 HTML</button>
          <button class="btn btn-secondary btn-xs" data-npu-export="md" data-job="${jobId}">导出 MD</button>
          <button class="btn btn-secondary btn-xs" data-npu-export="pdf" data-job="${jobId}">导出 PDF</button>
          <button class="btn btn-outline btn-xs" data-npu-export="preview" data-job="${jobId}">在线查看</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">
        ${kpi(cards.length ? cards.length + ' 张' : '-', 'NPU 数量', 'inherit')}
        ${kpi(sm.tmaxAll != null ? Math.round(sm.tmaxAll) + '°C' : '-', '最高温度', (sm.tmaxAll || 0) >= 80 ? '#F5A623' : 'inherit')}
        ${kpi(sm.pmaxAll != null ? Math.round(sm.pmaxAll) + ' W' : '-', '峰值功耗', 'inherit')}
        ${kpi(burn.dmiMissing ? '未安装' : '已安装', 'MindX ToolBox', burn.dmiMissing ? '#F5A623' : '#35C46E')}
        ${kpi(burn.passCount != null ? burn.passCount + ' 项' : '-', '健康检查通过', '#35C46E')}
      </div>
      <div class="table-responsive" style="border:1px solid var(--gray-200);">
        <table class="clean-table" style="width:100%;">
          <thead><tr><th>NPU</th><th>温度峰值</th><th>功耗峰值</th><th>HBM 峰值</th><th>采样数</th></tr></thead>
          <tbody>${rows || '<tr class="empty-row"><td colspan="5">无逐卡数据</td></tr>'}</tbody>
        </table>
      </div>
      ${adjHtml ? `<div style="font-size:12px;color:var(--gray-400);line-height:1.8;margin-top:8px;">
        脚本结论: ${b.esc(burn.scriptVerdict || '-')} (PASS ${burn.passCount || 0} / WARN ${burn.warnCount || 0} / FAIL ${burn.failCount || 0})<br>${adjHtml}</div>` : ''}
    </div>`;
  }

  function renderNpuResults() {
    const entries = Object.entries(npuJobs).filter(([, j]) => j.result);
    $id('npuEmptyState').classList.toggle('hidden', entries.length > 0);
    $id('npuResultBody').classList.toggle('hidden', entries.length === 0);
    $id('npuResultBody').innerHTML = entries.map(([jid, j]) =>
      renderNpuResultBlock(jid, j.result, j.result.jobHost || (j.status && j.status.host) || null)).join('');
    if (entries.length) enterWorkspace('npu');
  }

  // NPU 导出 (事件委托: html/md/pdf/preview)
  $id('npuResultSection').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-npu-export]');
    if (!btn) return;
    const jobId = btn.getAttribute('data-job');
    const j = npuJobs[jobId];
    if (!j || !j.result) { uiToast('该任务暂无结果', 'warn', 4200); return; }
    const parsed = j.result;
    const kind = btn.getAttribute('data-npu-export');
    const builder = window.npuReportBuilder;

    if (kind === 'html') {
      downloadBlob(builder.buildHtmlReport(parsed), builder.buildFilename(parsed, 'html'), 'text/html;charset=utf-8');
      npuLog('ok', 'NPU HTML 报告已导出。');
    } else if (kind === 'md') {
      downloadBlob(builder.buildMarkdownReport(parsed), builder.buildFilename(parsed, 'md'), 'text/markdown;charset=utf-8');
      npuLog('ok', 'NPU MD 报告已导出。');
    } else if (kind === 'preview') {
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '生成中…';
      try {
        const r = await fetch('/api/gpu/report', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: builder.buildHtmlReport(parsed) })
        });
        const d = await r.json();
        if (!d.ok) { uiToast(d.error || '生成失败', 'error', 5200); return; }
        const a = document.createElement('a');
        a.href = d.url; a.target = '_blank'; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
      } catch (err) {
        uiToast('在线查看失败: ' + err.message, 'error', 6000);
      } finally { btn.disabled = false; btn.textContent = orig; }
    } else if (kind === 'pdf') {
      if (typeof html2pdf === 'undefined') { uiToast('PDF 组件未加载', 'error', 5200); return; }
      const orig = btn.innerHTML;
      btn.disabled = true; btn.textContent = '生成中…';
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:820px;background:#f3f5f9;z-index:-1;';
      try {
        const doc = new DOMParser().parseFromString(builder.buildHtmlReport(parsed), 'text/html');
        const styleEl = doc.querySelector('style');
        if (styleEl) holder.appendChild(styleEl);
        while (doc.body.firstChild) holder.appendChild(doc.body.firstChild);
        document.body.appendChild(holder);
        await html2pdf().set({
          margin: [8, 8, 10, 8],
          filename: builder.buildFilename(parsed, 'pdf'),
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: '#f3f5f9', logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
          pagebreak: { mode: ['css', 'legacy'], avoid: ['.kpi', '.warn-item', 'tr', '.chart'] }
        }).from(holder).save();
        npuLog('ok', 'NPU PDF 报告已生成。');
      } catch (err) {
        uiToast('PDF 生成失败: ' + (err && err.message ? err.message : err), 'error', 6000);
      } finally { holder.remove(); btn.disabled = false; btn.innerHTML = orig; }
    }
  });

  // NPU ZIP 全部 + 清空
  $id('btnNpuZipAll').addEventListener('click', async () => {
    const entries = Object.entries(npuJobs).filter(([, j]) => j.result);
    if (!entries.length) { uiToast('当前没有可下载的报告', 'warn', 4200); return; }
    if (typeof fflate === 'undefined' || !fflate.zipSync) { uiToast('ZIP 组件未加载', 'error', 5200); return; }
    const btn = $id('btnNpuZipAll');
    btn.disabled = true; btn.textContent = '打包中…';
    try {
      const files = {};
      for (const [jid, j] of entries) {
        const base = npuReportBaseName(jid, j);
        files[base + '.html'] = fflate.strToU8(window.npuReportBuilder.buildHtmlReport(j.result));
        files[base + '.md'] = fflate.strToU8(window.npuReportBuilder.buildMarkdownReport(j.result));
      }
      const zipped = fflate.zipSync(files);
      const url = URL.createObjectURL(new Blob([zipped], { type: 'application/zip' }));
      const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const a = document.createElement('a');
      a.href = url; a.download = 'IceBreaker-NPU压测报告_' + entries.length + '台_' + d + '.zip';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      uiToast('已打包 ' + entries.length + ' 台机器的 NPU 报告', 'ok', 4200);
    } catch (err) {
      uiToast('打包失败: ' + err.message, 'error', 6000);
    } finally { btn.disabled = false; btn.textContent = '下载全部报告 (ZIP)'; }
  });

  $id('btnNpuClearHistory').addEventListener('click', async () => {
    const finished = Object.entries(npuJobs).filter(([, j]) =>
      !['connecting', 'uploading', 'running', 'collecting', 'detecting', 'installing'].includes(j.status.phase));
    if (!finished.length) { uiToast('没有可清空的历史记录', 'warn', 4200); return; }
    if (!(await uiConfirm('确定清空 ' + finished.length + ' 条已结束的 NPU 记录与报告?'))) return;
    try { await fetch('/api/npu/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
    for (const [jid] of finished) { delete npuJobs[jid]; }
    renderNpuJobBlocks();
    renderNpuResults();
    uiToast('已清空 ' + finished.length + ' 条 NPU 历史记录', 'ok', 4200);
  });

  // ---------- NPU 手动上传解析 ----------

  $id('btnNpuParse').addEventListener('click', async () => {
    const read = (id) => {
      const f = $id(id).files && $id(id).files[0];
      return f ? f.text() : Promise.resolve('');
    };
    const btn = $id('btnNpuParse');
    btn.disabled = true; btn.textContent = '解析中…';
    try {
      const [reportTxt, telemetryCsv, burnLog] = await Promise.all(
        [read('npuFileReport'), read('npuFileTele'), read('npuFileBurn')]);
      if (!reportTxt && !telemetryCsv && !burnLog) { uiToast('请至少选择一个产物文件', 'warn', 4200); return; }
      const r = await fetch('/api/npu/parse', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportTxt, telemetryCsv, burnLog })
      });
      const d = await r.json();
      if (!d.ok) { uiToast(d.error || '解析失败', 'error', 6000); return; }
      const jid = 'manual_' + Date.now();
      npuJobs[jid] = { status: { phase: 'done', host: d.result.meta.hostname || '手动上传', device: 'npu' }, result: d.result };
      renderNpuResults();
      npuLog('ok', 'NPU 手动产物解析完成, 报告已生成。');
    } catch (e) {
      uiToast('解析失败: ' + e.message, 'error', 6000);
    } finally {
      btn.disabled = false; btn.textContent = '解析并生成报告';
    }
  });

  // 页面加载恢复 NPU 任务
  fetch('/api/npu/status').then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.ok || !Array.isArray(d.jobs) || !d.jobs.length) return;
    const active = d.jobs.filter(st => ['connecting', 'uploading', 'running', 'collecting', 'detecting', 'installing'].includes(st.phase));
    const withResult = d.jobs.filter(st => st.hasResult);
    if (active.length || withResult.length) startNpuPolling();
  }).catch(() => {});

  // ---------- 页面加载: 恢复进行中的任务 ----------

  fetch('/api/gpu/status').then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.ok || !Array.isArray(d.jobs) || !d.jobs.length) return;
    const active = d.jobs.filter(st => ['connecting', 'uploading', 'running', 'collecting'].includes(st.phase));
    const withResult = d.jobs.filter(st => st.hasResult);
    if (active.length) {
      enterWorkspace('gpu');
      gpuLog('system', `检测到 ${active.length} 台进行中的 GPU 压测任务, 已恢复状态轮询。`);
      startGpuPolling();
    } else if (withResult.length) {
      startGpuPolling();   // 拉取历史结果后自动停止 (无在途任务)
    }
  }).catch(() => {});

  // 日志功能
  btnClearLogs.addEventListener('click', () => {
    terminalLog.innerHTML = '';
  });

  function appendLog(type, msg) {
    const line = document.createElement('div');
    const time = new Date().toLocaleTimeString();
    line.className = `term-row ${type}`;
    line.textContent = `[${time}] ${msg}`;
    terminalLog.appendChild(line);

    if (autoScrollLogs.checked) {
      terminalLog.scrollTop = terminalLog.scrollHeight;
    }
  }

  // 状态与定时重置
  function setRunState(running) {
    if (running) {
      btnStartBenchmark.classList.add('hidden');
      btnStopBenchmark.classList.remove('hidden');
      btnStopBenchmark.disabled = false;
      btnStopBenchmark.textContent = '紧急终止测试 (Stop)';
      systemStatusBadge.className = 'status-pill running';
      systemStatusBadge.innerHTML = '<span class="status-dot"></span> 正在压测执行中';
      hudDot.className = 'pulse-ring';
      progressSection.classList.remove('hidden');
    } else {
      btnStartBenchmark.classList.remove('hidden');
      btnStopBenchmark.classList.add('hidden');
      systemStatusBadge.className = 'status-pill';
      systemStatusBadge.innerHTML = '<span class="status-dot"></span> 系统就绪';
    }
  }

  function resetBenchmarkSession() {
    currentSessionData.concurrencyTiers = [];
    currentSessionData.contextTiers = [];
    currentSessionData.outputResult = null;
    currentSessionData.allRawRecords = [];
    updateConcurrencyTable([]);
    updateContextOutputTable();
    progressBarFill.style.width = '0%';
    progressPercentText.textContent = '0%';
    hudTimer.textContent = '00:00.0';
    hudTokenCount.innerHTML = '0 <small>tok</small>';
    hudLiveSpeed.innerHTML = '0.0 <small>tok/s</small>';
  }

  function applyEngineConfig() {
    let cleanProxyUrl = proxyBaseUrlInput ? proxyBaseUrlInput.value.trim() : '/proxy?url=';
    if (cleanProxyUrl.includes('?url=')) {
      cleanProxyUrl = cleanProxyUrl.split('?url=')[0] + '?url=';
      if (proxyBaseUrlInput && proxyBaseUrlInput.value !== cleanProxyUrl) {
        proxyBaseUrlInput.value = cleanProxyUrl;
      }
    }

    window.stressEngine.setConfig({
      apiUrl: apiUrlInput.value.trim().replace(/\/+$/, ''),
      apiKey: apiKeyInput.value.trim(),
      model: modelNameInput.value.trim(),
      stream: streamModeSelect.value === 'true',
      timeoutSec: Number(reqTimeoutInput.value) || 120,
      useProxy: enableCorsProxy ? enableCorsProxy.checked : false,
      proxyBaseUrl: cleanProxyUrl,
      proxyToken: window.__benchProxyToken || ''
    });
  }

  function saveSettings() {
    try {
      localStorage.setItem('llm_benchmark_url', apiUrlInput.value);
      localStorage.setItem('llm_benchmark_key', apiKeyInput.value);
      localStorage.setItem('llm_benchmark_model', modelNameInput.value);
      localStorage.setItem('llm_benchmark_stream', streamModeSelect.value);
      if (enableCorsProxy) {
        localStorage.setItem('llm_benchmark_use_proxy', enableCorsProxy.checked ? '1' : '0');
      }
      if (proxyBaseUrlInput) {
        localStorage.setItem('llm_benchmark_proxy_url', proxyBaseUrlInput.value);
      }
    } catch (e) {}
  }

  function loadSavedSettings() {
    try {
      const u = localStorage.getItem('llm_benchmark_url');
      const k = localStorage.getItem('llm_benchmark_key');
      const m = localStorage.getItem('llm_benchmark_model');
      const s = localStorage.getItem('llm_benchmark_stream');
      const p = localStorage.getItem('llm_benchmark_use_proxy');
      const pu = localStorage.getItem('llm_benchmark_proxy_url');
      if (u) apiUrlInput.value = u;
      if (k) apiKeyInput.value = k;
      if (m) modelNameInput.value = m;
      if (s) streamModeSelect.value = s;
      if (pu && proxyBaseUrlInput) {
        proxyBaseUrlInput.value = pu;
        if (proxyNodeSelect) {
          const matchOpt = Array.from(proxyNodeSelect.options).find(o => o.value === pu);
          if (matchOpt) {
            proxyNodeSelect.value = pu;
          } else {
            proxyNodeSelect.value = 'custom';
          }
        }
      }
      if (p !== null && enableCorsProxy) {
        enableCorsProxy.checked = p === '1';
        if (proxyUrlWrap) proxyUrlWrap.classList.toggle('hidden', p !== '1');
        if (corsStatusTag) {
          corsStatusTag.textContent = p === '1' ? '已开启' : '未开启';
          corsStatusTag.className = `cors-tag ${p === '1' ? 'active' : ''}`;
        }
      }
    } catch (e) {}
  }
});
