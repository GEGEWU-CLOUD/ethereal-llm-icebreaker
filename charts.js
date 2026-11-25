/**
 * ChartManager v2.5 — Admin Console Theme
 */
class ChartManager {
  constructor() {
    this.charts = { latency: null, throughput: null, context: null, status: null };

    if (window.Chart) {
      Chart.defaults.color = '#565d65';
      Chart.defaults.borderColor = '#e6e8eb';
      Chart.defaults.font.family = 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
      Chart.defaults.font.size = 12;
    }
  }

  initCharts() {
    if (!window.Chart) return;
    this.initLatencyChart();
    this.initThroughputChart();
    this.initContextChart();
    this.initStatusChart();
    // 跟随当前主题 (initTheme 可能先于本方法执行)
    this.applyTheme(document.documentElement.dataset.theme === 'dark');
  }

  /** 昼夜主题联动: 更新全局默认色与各图网格/刻度并刷新 */
  applyTheme(isDark) {
    if (!window.Chart) return;
    Chart.defaults.color = isDark ? '#a2abb5' : '#565d65';
    Chart.defaults.borderColor = isDark ? '#2b3138' : '#e6e8eb';
    const gridColor = isDark ? '#2b3138' : '#e6e8eb';
    for (const key of Object.keys(this.charts)) {
      const ch = this.charts[key];
      if (!ch) continue;
      const scales = ch.options.scales || {};
      for (const sk of Object.keys(scales)) {
        if (scales[sk] && scales[sk].grid) scales[sk].grid.color = gridColor;
      }
      ch.update('none');
    }
  }

  initLatencyChart() {
    const ctx = document.getElementById('chartLatency')?.getContext('2d');
    if (!ctx) return;
    this.charts.latency = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['并发 5', '并发 10', '并发 20', '并发 50', '并发 100'],
        datasets: [
          { label: 'P90 延迟 (s)', data: [], borderColor: '#075f49', backgroundColor: 'rgba(7,95,73,0.06)', borderWidth: 2, tension: 0.25, fill: false, pointBackgroundColor: '#075f49', pointRadius: 4 },
          { label: 'P50 延迟 (s)', data: [], borderColor: '#1d537d', backgroundColor: 'rgba(29,83,125,0.06)', borderWidth: 2, tension: 0.25, fill: false, pointBackgroundColor: '#1d537d', pointRadius: 4 },
          { label: 'TTFT (s)',     data: [], borderColor: '#16734b', backgroundColor: 'rgba(22,115,75,0.06)', borderWidth: 1.5, borderDash: [5,4], tension: 0.25, fill: false, pointBackgroundColor: '#16734b', pointRadius: 3 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, padding: 14 } },
          tooltip: { backgroundColor: '#202428', padding: 10, cornerRadius: 8, mode: 'index', intersect: false }
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#e6e8eb' }, title: { display: true, text: '响应时间 (秒)', color: '#565d65' } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  initThroughputChart() {
    const ctx = document.getElementById('chartThroughput')?.getContext('2d');
    if (!ctx) return;
    this.charts.throughput = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['并发 5', '并发 10', '并发 20', '并发 50', '并发 100'],
        datasets: [
          { label: 'RPS (req/s)', data: [], type: 'bar', backgroundColor: 'rgba(29,83,125,0.65)', borderColor: '#1d537d', borderWidth: 1, borderRadius: 4, yAxisID: 'y' },
          { label: 'TPM (tok/min)', data: [], type: 'line', borderColor: '#945000', backgroundColor: 'rgba(148,80,0,0.08)', borderWidth: 2, tension: 0.25, pointBackgroundColor: '#945000', pointRadius: 4, yAxisID: 'y1' }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10, padding: 14 } },
          tooltip: { backgroundColor: '#202428', padding: 10, cornerRadius: 8, mode: 'index', intersect: false }
        },
        scales: {
          y:  { type: 'linear', position: 'left',  beginAtZero: true, grid: { color: '#e6e8eb' }, title: { display: true, text: 'RPS', color: '#1d537d' } },
          y1: { type: 'linear', position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'TPM', color: '#945000' } },
          x:  { grid: { display: false } }
        }
      }
    });
  }

  initContextChart() {
    const ctx = document.getElementById('chartContext')?.getContext('2d');
    if (!ctx) return;
    this.charts.context = new Chart(ctx, {
      type: 'line',
      data: {
        labels: ['64k', '128k', '256k', '512k', '1M'],
        datasets: [{ label: 'TTFT Prefill (s)', data: [], borderColor: '#5b3d96', backgroundColor: 'rgba(91,61,150,0.08)', borderWidth: 2.5, fill: true, tension: 0.2, pointBackgroundColor: '#5b3d96', pointRadius: 4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 10 } },
          tooltip: { backgroundColor: '#202428', padding: 10, cornerRadius: 8 }
        },
        scales: {
          y: { beginAtZero: true, grid: { color: '#e6e8eb' }, title: { display: true, text: 'TTFT (秒)', color: '#5b3d96' } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  initStatusChart() {
    const ctx = document.getElementById('chartStatus')?.getContext('2d');
    if (!ctx) return;
    this.charts.status = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['200 成功', '429 限流', '5xx 错误', '超时/网络'],
        datasets: [{ data: [0,0,0,0], backgroundColor: ['#16734b','#945000','#b42330','#8b939d'], borderWidth: 2, borderColor: '#ffffff' }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { boxWidth: 10, padding: 12 } },
          tooltip: { backgroundColor: '#202428', padding: 10, cornerRadius: 8 }
        }
      }
    });
  }

  updateConcurrencyCharts(tierResults) {
    if (!this.charts.latency || !this.charts.throughput) return;

    const labels = tierResults.map(t => `并发 ${t.concurrency}`);
    this.charts.latency.data.labels = labels;
    this.charts.latency.data.datasets[0].data = tierResults.map(t => +t.p90.toFixed(2));
    this.charts.latency.data.datasets[1].data = tierResults.map(t => +t.p50.toFixed(2));
    this.charts.latency.data.datasets[2].data = tierResults.map(t => +t.avgTtft.toFixed(2));
    this.charts.latency.update();

    this.charts.throughput.data.labels = labels;
    this.charts.throughput.data.datasets[0].data = tierResults.map(t => +t.rps.toFixed(1));
    this.charts.throughput.data.datasets[1].data = tierResults.map(t => Math.round(t.tpm));
    this.charts.throughput.update();

    if (this.charts.status) {
      let s200 = 0, s429 = 0, s5xx = 0, sOther = 0;
      for (const t of tierResults) {
        s200 += (t.successCount || 0);
        s429 += (t.rateLimit429Count || 0);
        const recs = t.records || [];
        s5xx += recs.filter(r => r.status >= 500 && r.status < 600).length;
        sOther += recs.filter(r => !r.ok && r.status !== 429 && !(r.status >= 500)).length;
        if (!recs.length && t.failCount > 0) {
          sOther += Math.max(0, t.failCount - (t.rateLimit429Count || 0));
        }
      }
      this.charts.status.data.datasets[0].data = [s200, s429, s5xx, sOther];
      this.charts.status.update();
    }
  }

  updateContextCharts(contextResults) {
    if (!this.charts.context) return;
    this.charts.context.data.labels = contextResults.map(c => c.tierLabel);
    this.charts.context.data.datasets[0].data = contextResults.map(c => c.ok ? +c.ttft.toFixed(2) : null);
    this.charts.context.update();
  }
}

window.chartManager = new ChartManager();
