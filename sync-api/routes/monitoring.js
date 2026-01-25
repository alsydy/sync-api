// ============================================================================
// Monitoring Routes
// ============================================================================
// Routes لصفحة مراقبة الخادم الشاملة
// ============================================================================

const express = require('express');
const router = express.Router();
const { getMonitoringStats, resetStats } = require('../services/monitoringService');
const logger = require('../utils/logger');

/**
 * GET /api/monitoring
 * صفحة مراقبة الخادم (HTML)
 */
router.get('/', (req, res) => {
  res.send(getMonitoringHTML());
});

/**
 * GET /api/monitoring/stats
 * إحصائيات المراقبة (JSON API)
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getMonitoringStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Error getting monitoring stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'خطأ في الحصول على إحصائيات المراقبة'
    });
  }
});

/**
 * POST /api/monitoring/reset
 * إعادة تعيين الإحصائيات
 */
router.post('/reset', (req, res) => {
  try {
    resetStats();
    res.json({
      success: true,
      message: 'تم إعادة تعيين الإحصائيات بنجاح'
    });
  } catch (error) {
    logger.error('Error resetting stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'خطأ في إعادة تعيين الإحصائيات'
    });
  }
});

/**
 * إنشاء صفحة HTML للمراقبة
 */
function getMonitoringHTML() {
  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>مراقبة الخادم - MalyMax API</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            padding: 20px;
            min-height: 100vh;
        }

        .container { max-width: 1400px; margin: 0 auto; }

        .header {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
        }

        .header h1 { color: #667eea; font-size: 28px; }

        .status {
            display: flex;
            gap: 12px;
            align-items: center;
            margin-top: 6px;
        }

        .status-indicator {
            width: 12px; height: 12px; border-radius: 50%;
            background: #9ca3af;
            animation: pulse 2s infinite;
        }

        .status-indicator.ok { background: #10b981; }
        .status-indicator.warn { background: #f59e0b; }
        .status-indicator.bad { background: #ef4444; }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .status-text { font-weight: bold; color: #6b7280; }
        .status-text.ok { color: #10b981; }
        .status-text.warn { color: #92400e; }
        .status-text.bad { color: #dc2626; }

        .controls { display: flex; gap: 10px; flex-wrap: wrap; }

        button {
            padding: 8px 16px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
            transition: all 0.3s;
        }

        .btn-primary { background: #667eea; color: white; }
        .btn-primary:hover { background: #5568d3; }
        .btn-danger { background: #ef4444; color: white; }
        .btn-danger:hover { background: #dc2626; }
        .btn-secondary { background: #111827; color: white; opacity: 0.9; }
        .btn-secondary:hover { opacity: 1; }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }

        .card {
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }

        .card h2 {
            color: #667eea;
            margin-bottom: 15px;
            font-size: 20px;
            border-bottom: 2px solid #667eea;
            padding-bottom: 10px;
        }

        .stat-item {
            display: flex;
            justify-content: space-between;
            gap: 10px;
            padding: 10px 0;
            border-bottom: 1px solid #e5e7eb;
        }
        .stat-item:last-child { border-bottom: none; }

        .stat-label { color: #6b7280; font-weight: 500; }
        .stat-value { color: #111827; font-weight: bold; text-align: left; direction: ltr; }

        .muted { color: #6b7280; font-weight: 500; }
        .dangerText { color: #dc2626; }
        .warningText { color: #92400e; }

        .progress-bar {
            width: 100%;
            height: 20px;
            background: #e5e7eb;
            border-radius: 10px;
            overflow: hidden;
            margin-top: 8px;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #10b981, #34d399);
            transition: width 0.3s;
        }
        .progress-fill.warning { background: linear-gradient(90deg, #f59e0b, #fbbf24); }
        .progress-fill.danger { background: linear-gradient(90deg, #ef4444, #f87171); }

        .full-width { grid-column: 1 / -1; }

        .error-list { max-height: 320px; overflow-y: auto; }
        .error-item {
            padding: 10px;
            margin-bottom: 10px;
            background: #fef2f2;
            border-right: 4px solid #ef4444;
            border-radius: 5px;
        }
        .error-time { font-size: 12px; color: #6b7280; margin-bottom: 5px; }
        .error-message { color: #dc2626; font-weight: bold; }

        .warning-item {
            padding: 10px;
            margin-bottom: 10px;
            background: #fffbeb;
            border-right: 4px solid #f59e0b;
            border-radius: 5px;
        }

        .table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        .table th, .table td {
            padding: 10px;
            text-align: right;
            border-bottom: 1px solid #e5e7eb;
            vertical-align: top;
        }
        .table th { background: #f9fafb; font-weight: bold; color: #374151; }

        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: bold;
            direction: rtl;
        }
        .badge-success { background: #d1fae5; color: #065f46; }
        .badge-warning { background: #fef3c7; color: #92400e; }
        .badge-danger { background: #fee2e2; color: #991b1b; }
        .badge-neutral { background: #eef2ff; color: #3730a3; }

        .loading { text-align: center; padding: 20px; color: #6b7280; }
        .refresh-info { text-align: center; padding: 10px; color: #6b7280; font-size: 14px; }

        .small { font-size: 12px; }
        .wrap { word-break: break-word; direction: ltr; text-align: left; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>🚀 مراقبة الخادم - MalyMax API</h1>
                <div class="status">
                    <div class="status-indicator" id="statusDot"></div>
                    <span class="status-text" id="statusText">جاري التحميل...</span>
                    <span class="badge badge-neutral" id="envBadge" style="display:none;"></span>
                </div>
            </div>
            <div class="controls">
                <button class="btn-primary" onclick="refreshData()">🔄 تحديث</button>
                <button class="btn-danger" onclick="resetAllStats()">🧹 إعادة تعيين</button>
                <button class="btn-secondary" onclick="toggleAutoRefresh()" id="autoBtn">⏸️ إيقاف التحديث</button>
            </div>
        </div>

        <div class="grid" id="statsContainer">
            <div class="loading">جاري تحميل البيانات...</div>
        </div>

        <div class="refresh-info" id="refreshInfo"></div>
    </div>

    <script>
        let autoRefreshInterval;
        let autoRefreshEnabled = true;
        let lastData = null;

        window.addEventListener('DOMContentLoaded', () => {
            loadData();
            startAutoRefresh();
        });

        function startAutoRefresh() {
            stopAutoRefresh();
            autoRefreshInterval = setInterval(() => {
                if (autoRefreshEnabled) loadData();
            }, 5000);
        }

        function stopAutoRefresh() {
            if (autoRefreshInterval) clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
        }

        function toggleAutoRefresh() {
            autoRefreshEnabled = !autoRefreshEnabled;
            document.getElementById('autoBtn').textContent = autoRefreshEnabled ? '⏸️ إيقاف التحديث' : '▶️ تشغيل التحديث';
        }

        // ✅ إصلاح المسارات: يعمل سواء كان الرابط /api/monitoring أو /api/monitoring/
        function apiUrl(subPath) {
            let base = window.location.pathname || '/';
            if (!base.endsWith('/')) base += '/';
            return base + String(subPath || '').replace(/^\\/+/, '');
        }

        // ✅ Timeout للـ fetch حتى لا يعلق "جاري التحميل"
        async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
                return res;
            } finally {
                clearTimeout(id);
            }
        }

        async function loadData() {
            try {
                const response = await fetchWithTimeout(apiUrl('stats'), {}, 8000);
                const result = await response.json();

                if (result.success) {
                    lastData = result.data;
                    displayStats(result.data);
                    updateRefreshInfo();
                } else {
                    document.getElementById('statsContainer').innerHTML =
                        '<div class="card full-width"><p class="dangerText">خطأ في تحميل البيانات</p></div>';
                    setStatus('bad', 'خطأ في تحميل البيانات');
                }
            } catch (error) {
                console.error('Error loading data:', error);
                document.getElementById('statsContainer').innerHTML =
                    '<div class="card full-width"><p class="dangerText">تعذر تحميل البيانات. جرّب تحديث الصفحة.</p></div>';
                setStatus('bad', (error && error.name === 'AbortError') ? 'انتهت مهلة التحميل' : 'لا يمكن الاتصال بالخادم');
            }
        }

        function setStatus(level, text) {
            const dot = document.getElementById('statusDot');
            const st = document.getElementById('statusText');

            dot.className = 'status-indicator ' + (level || '');
            st.className = 'status-text ' + (level || '');
            st.textContent = text || '...';
        }

        function computeOverallStatus(data) {
            if (!data) return { level: 'warn', text: 'جاري التحميل...' };

            const dbOk = !!(data.database && data.database.connected);
            const hasReqErrors = (data.requests && Array.isArray(data.requests.errors) && data.requests.errors.length > 0);
            const has5xx = data.requests && data.requests.byStatus && (data.requests.byStatus['5xx'] > 0);

            if (!dbOk || has5xx) {
                return { level: 'bad', text: 'يوجد مشكلة (قاعدة البيانات/أخطاء 5xx)' };
            }
            if (hasReqErrors) {
                return { level: 'warn', text: 'تحذير: توجد أخطاء طلبات' };
            }
            return { level: 'ok', text: 'الخادم يعمل بشكل طبيعي' };
        }

        function displayStats(data) {
            const overall = computeOverallStatus(data);
            setStatus(overall.level, overall.text);

            const container = document.getElementById('statsContainer');

            const heapRatio = safeDivide(data.process.memory.heapUsed, data.process.memory.heapTotal);
            const heapPct = (heapRatio * 100).toFixed(2);
            const ramPct = Number(data.system.memory.percentage || 0).toFixed(2);

            container.innerHTML = \`
                <!-- معلومات النظام -->
                <div class="card">
                    <h2>💻 معلومات النظام</h2>
                    <div class="stat-item">
                        <span class="stat-label">النظام:</span>
                        <span class="stat-value">\${data.system.platform} (\${data.system.arch})</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Node.js:</span>
                        <span class="stat-value">\${data.system.nodeVersion}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Uptime:</span>
                        <span class="stat-value">\${formatUptime(data.system.uptime)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">CPU:</span>
                        <span class="stat-value">\${data.system.cpu.cores} نواة</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Load Avg:</span>
                        <span class="stat-value">\${(data.system.loadAverage || []).map(n => Number(n).toFixed(2)).join(' , ')}</span>
                    </div>
                </div>

                <!-- استخدام الذاكرة -->
                <div class="card">
                    <h2>🧠 الذاكرة</h2>
                    <div class="stat-item">
                        <span class="stat-label">System RAM:</span>
                        <span class="stat-value">\${ramPct}%</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">RSS:</span>
                        <span class="stat-value">\${formatBytes(data.process.memory.rss)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Heap Used:</span>
                        <span class="stat-value">\${formatBytes(data.process.memory.heapUsed)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Heap Total:</span>
                        <span class="stat-value">\${formatBytes(data.process.memory.heapTotal)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Heap %:</span>
                        <span class="stat-value">\${heapPct}%</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill \${getProgressClass(heapRatio)}"
                             style="width: \${Math.min(100, Math.max(0, heapRatio * 100))}%"></div>
                    </div>
                    <div class="small muted" style="margin-top:8px;">
                        تنبيه: Heap % يختلف عن System RAM %
                    </div>
                </div>

                <!-- قاعدة البيانات -->
                <div class="card">
                    <h2>🗄️ قاعدة البيانات</h2>

                    <div class="stat-item">
                        <span class="stat-label">الحالة:</span>
                        <span class="stat-value">
                            <span class="badge \${data.database.connected ? 'badge-success' : 'badge-danger'}">
                                \${data.database.connected ? 'متصل' : 'غير متصل'}
                            </span>
                        </span>
                    </div>

                    \${data.database.connected ? \`
                        <div class="stat-item">
                            <span class="stat-label">الإصدار:</span>
                            <span class="stat-value">\${data.database.version}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">حجم القاعدة:</span>
                            <span class="stat-value">\${data.database.size || 'N/A'}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">اتصالات DB:</span>
                            <span class="stat-value">\${data.database.connections.active} نشط / \${data.database.connections.total} إجمالي</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Pool:</span>
                            <span class="stat-value">\${data.database.pool.totalCount} total | \${data.database.pool.idleCount} idle | \${data.database.pool.waitingCount} wait</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Pool Max:</span>
                            <span class="stat-value">\${data.database.pool.max}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Queries:</span>
                            <span class="stat-value">\${data.database.queries.total} (slow: \${data.database.queries.slow}, errors: \${data.database.queries.errors})</span>
                        </div>
                        \${data.database.warning ? \`
                          <div class="warning-item">
                            <div class="small warningText"><b>تنبيه DB:</b> \${escapeHtml(data.database.warning)}</div>
                          </div>
                        \` : '' }
                    \` : \`
                        <div class="stat-item">
                            <span class="stat-label">الخطأ:</span>
                            <span class="stat-value dangerText wrap">\${escapeHtml(data.database.error || 'N/A')}</span>
                        </div>
                        \${data.database.pool ? \`
                        <div class="stat-item">
                            <span class="stat-label">Pool:</span>
                            <span class="stat-value">\${data.database.pool.totalCount} total | \${data.database.pool.idleCount} idle | \${data.database.pool.waitingCount} wait</span>
                        </div>\` : '' }
                    \`}
                </div>

                <!-- إحصائيات الطلبات -->
                <div class="card">
                    <h2>📊 الطلبات</h2>
                    <div class="stat-item">
                        <span class="stat-label">إجمالي الطلبات:</span>
                        <span class="stat-value">\${data.requests.total}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Uptime:</span>
                        <span class="stat-value">\${formatUptime(data.requests.uptime / 1000)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Errors:</span>
                        <span class="stat-value">
                            <span class="badge \${data.requests.errors.length > 0 ? 'badge-danger' : 'badge-success'}">
                                \${data.requests.errors.length}
                            </span>
                        </span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Slow Requests:</span>
                        <span class="stat-value">
                            <span class="badge \${data.requests.slowRequests.length > 0 ? 'badge-warning' : 'badge-success'}">
                                \${data.requests.slowRequests.length}
                            </span>
                        </span>
                    </div>
                </div>

                <!-- الطلبات حسب Method -->
                <div class="card">
                    <h2>📤 حسب Method</h2>
                    \${Object.entries(data.requests.byMethod || {}).map(([method, count]) => \`
                        <div class="stat-item">
                            <span class="stat-label">\${method}:</span>
                            <span class="stat-value">\${count}</span>
                        </div>
                    \`).join('') || '<div class="muted">لا توجد بيانات</div>'}
                </div>

                <!-- الطلبات حسب Status -->
                <div class="card">
                    <h2>📈 حسب Status</h2>
                    \${Object.entries(data.requests.byStatus || {}).map(([status, count]) => \`
                        <div class="stat-item">
                            <span class="stat-label">\${status}:</span>
                            <span class="stat-value">\${count}</span>
                        </div>
                    \`).join('') || '<div class="muted">لا توجد بيانات</div>'}
                </div>

                <!-- المسارات الأكثر استخداماً -->
                <div class="card">
                    <h2>🔗 أشهر المسارات</h2>
                    \${Object.entries(data.requests.byPath || {}).slice(0, 10).map(([p, count]) => \`
                        <div class="stat-item">
                            <span class="stat-label small">\${escapeHtml(p)}:</span>
                            <span class="stat-value">\${count}</span>
                        </div>
                    \`).join('') || '<div class="muted">لا توجد بيانات</div>'}
                </div>

                <!-- الطلبات البطيئة -->
                <div class="card full-width">
                    <h2>🐢 الطلبات البطيئة</h2>
                    <div class="error-list">
                        \${(data.requests.slowRequests && data.requests.slowRequests.length > 0)
                          ? data.requests.slowRequests.slice(-10).reverse().map(req => \`
                            <div class="warning-item">
                              <div class="error-time">\${new Date(req.timestamp).toLocaleString('ar-SA')}</div>
                              <div class="warningText"><b>\${req.method}</b> \${escapeHtml(req.path)} - \${req.statusCode} (\${req.duration}ms)</div>
                            </div>\`).join('')
                          : '<p style="color:#10b981; text-align:center; padding: 20px;">لا توجد طلبات بطيئة 🎉</p>'}
                    </div>
                </div>

                <!-- الأخطاء الأخيرة -->
                <div class="card full-width">
                    <h2>❌ أخطاء الطلبات</h2>
                    <div class="error-list">
                        \${(data.requests.errors && data.requests.errors.length > 0)
                          ? data.requests.errors.slice(-10).reverse().map(error => \`
                            <div class="error-item">
                                <div class="error-time">\${new Date(error.timestamp).toLocaleString('ar-SA')}</div>
                                <div class="error-message">\${error.method} \${escapeHtml(error.path)} - \${error.statusCode} (\${error.duration}ms)</div>
                            </div>\`).join('')
                          : '<p style="color:#10b981; text-align:center; padding: 20px;">لا توجد أخطاء 🎉</p>'}
                    </div>
                </div>

                <!-- معلومات السجلات -->
                <div class="card full-width">
                    <h2>📝 السجلات</h2>
                    <table class="table">
                        <thead>
                            <tr>
                                <th>الملف</th>
                                <th>الحجم</th>
                                <th>عدد الأسطر</th>
                                <th>آخر تعديل</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${Object.entries(data.logs || {}).map(([name, info]) => \`
                                <tr>
                                    <td>\${escapeHtml(name)}.log</td>
                                    <td>\${info && info.exists ? info.sizeFormatted : 'غير موجود'}</td>
                                    <td>\${info && info.exists ? info.lineCount : '-'}</td>
                                    <td>\${info && info.exists ? new Date(info.modified).toLocaleString('ar-SA') : '-'}</td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                </div>
            \`;
        }

        function updateRefreshInfo() {
            const now = new Date();
            document.getElementById('refreshInfo').textContent =
                \`آخر تحديث: \${now.toLocaleString('ar-SA')} - التحديث التلقائي كل 5 ثوانٍ\`;
        }

        function refreshData() {
            loadData();
        }

        async function resetAllStats() {
            if (!confirm('هل أنت متأكد من إعادة تعيين جميع الإحصائيات؟')) return;

            const wasEnabled = autoRefreshEnabled;
            autoRefreshEnabled = false;

            try {
                const response = await fetchWithTimeout(apiUrl('reset'), { method: 'POST' }, 8000);
                const result = await response.json();

                if (result.success) {
                    alert('تم إعادة تعيين الإحصائيات بنجاح');
                    await loadData();
                } else {
                    alert('خطأ في إعادة تعيين الإحصائيات');
                }
            } catch (error) {
                console.error('Error resetting stats:', error);
                alert((error && error.name === 'AbortError') ? 'انتهت مهلة الاتصال' : 'خطأ في الاتصال بالخادم');
            } finally {
                autoRefreshEnabled = wasEnabled;
            }
        }

        function formatBytes(bytes) {
            if (!bytes) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
        }

        function formatUptime(seconds) {
            const days = Math.floor(seconds / 86400);
            const hours = Math.floor((seconds % 86400) / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            const secs = Math.floor(seconds % 60);

            if (days > 0) return \`\${days} يوم \${hours} ساعة \${minutes} دقيقة\`;
            if (hours > 0) return \`\${hours} ساعة \${minutes} دقيقة \${secs} ثانية\`;
            if (minutes > 0) return \`\${minutes} دقيقة \${secs} ثانية\`;
            return \`\${secs} ثانية\`;
        }

        function getProgressClass(ratio) {
            if (ratio > 0.8) return 'danger';
            if (ratio > 0.6) return 'warning';
            return '';
        }

        function safeDivide(a, b) {
            const x = Number(a || 0);
            const y = Number(b || 0);
            if (!y) return 0;
            return x / y;
        }

        function escapeHtml(str) {
            if (str === null || str === undefined) return '';
            return String(str)
              .replaceAll('&', '&amp;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
              .replaceAll('"', '&quot;')
              .replaceAll("'", '&#039;');
        }
    </script>
</body>
</html>
  `;
}

module.exports = router;
