// ============================================================================
// Monitoring Routes
// ============================================================================
// Routes لصفحة مراقبة الخادم الشاملة
// ============================================================================

const express = require('express');
const router = express.Router();
const { getMonitoringStats, resetStats, formatBytes, formatUptime } = require('../services/monitoringService');
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
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            padding: 20px;
            min-height: 100vh;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        .header {
            background: white;
            padding: 20px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        
        .header h1 {
            color: #667eea;
            font-size: 28px;
        }
        
        .status {
            display: flex;
            gap: 15px;
            align-items: center;
        }
        
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #10b981;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .status-text {
            font-weight: bold;
            color: #10b981;
        }
        
        .controls {
            display: flex;
            gap: 10px;
        }
        
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
            transition: all 0.3s;
        }
        
        .btn-primary {
            background: #667eea;
            color: white;
        }
        
        .btn-primary:hover {
            background: #5568d3;
        }
        
        .btn-danger {
            background: #ef4444;
            color: white;
        }
        
        .btn-danger:hover {
            background: #dc2626;
        }
        
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
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
            padding: 10px 0;
            border-bottom: 1px solid #e5e7eb;
        }
        
        .stat-item:last-child {
            border-bottom: none;
        }
        
        .stat-label {
            color: #6b7280;
            font-weight: 500;
        }
        
        .stat-value {
            color: #111827;
            font-weight: bold;
        }
        
        .progress-bar {
            width: 100%;
            height: 20px;
            background: #e5e7eb;
            border-radius: 10px;
            overflow: hidden;
            margin-top: 5px;
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, #10b981, #34d399);
            transition: width 0.3s;
        }
        
        .progress-fill.warning {
            background: linear-gradient(90deg, #f59e0b, #fbbf24);
        }
        
        .progress-fill.danger {
            background: linear-gradient(90deg, #ef4444, #f87171);
        }
        
        .full-width {
            grid-column: 1 / -1;
        }
        
        .error-list {
            max-height: 300px;
            overflow-y: auto;
        }
        
        .error-item {
            padding: 10px;
            margin-bottom: 10px;
            background: #fef2f2;
            border-right: 4px solid #ef4444;
            border-radius: 5px;
        }
        
        .error-time {
            font-size: 12px;
            color: #6b7280;
            margin-bottom: 5px;
        }
        
        .error-message {
            color: #dc2626;
            font-weight: bold;
        }
        
        .chart-container {
            height: 200px;
            margin-top: 15px;
        }
        
        .table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 10px;
        }
        
        .table th,
        .table td {
            padding: 10px;
            text-align: right;
            border-bottom: 1px solid #e5e7eb;
        }
        
        .table th {
            background: #f9fafb;
            font-weight: bold;
            color: #374151;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
        }
        
        .badge-success {
            background: #d1fae5;
            color: #065f46;
        }
        
        .badge-warning {
            background: #fef3c7;
            color: #92400e;
        }
        
        .badge-danger {
            background: #fee2e2;
            color: #991b1b;
        }
        
        .loading {
            text-align: center;
            padding: 20px;
            color: #6b7280;
        }
        
        .refresh-info {
            text-align: center;
            padding: 10px;
            color: #6b7280;
            font-size: 14px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>🚀 مراقبة الخادم - MalyMax API</h1>
                <div class="status">
                    <div class="status-indicator"></div>
                    <span class="status-text" id="statusText">جاري التحميل...</span>
                </div>
            </div>
            <div class="controls">
                <button class="btn-primary" onclick="refreshData()">🔄 تحديث</button>
                <button class="btn-danger" onclick="resetStats()">🔄 إعادة تعيين</button>
            </div>
        </div>
        
        <div class="grid" id="statsContainer">
            <div class="loading">جاري تحميل البيانات...</div>
        </div>
        
        <div class="refresh-info" id="refreshInfo"></div>
    </div>
    
    <script>
        let autoRefreshInterval;
        
        // تحميل البيانات عند فتح الصفحة
        window.addEventListener('DOMContentLoaded', () => {
            loadData();
            startAutoRefresh();
        });
        
        // تحديث تلقائي كل 5 ثوانٍ
        function startAutoRefresh() {
            autoRefreshInterval = setInterval(loadData, 5000);
        }
        
        // تحميل البيانات
        async function loadData() {
            try {
                const response = await fetch('/api/monitoring/stats');
                const result = await response.json();
                
                if (result.success) {
                    displayStats(result.data);
                    updateRefreshInfo();
                } else {
                    document.getElementById('statsContainer').innerHTML = 
                        '<div class="card full-width"><p style="color: red;">خطأ في تحميل البيانات</p></div>';
                }
            } catch (error) {
                console.error('Error loading data:', error);
                document.getElementById('statsContainer').innerHTML = 
                    '<div class="card full-width"><p style="color: red;">خطأ في الاتصال بالخادم</p></div>';
            }
        }
        
        // عرض الإحصائيات
        function displayStats(data) {
            const container = document.getElementById('statsContainer');
            
            // تحديث حالة الخادم
            document.getElementById('statusText').textContent = 'الخادم يعمل';
            
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
                        <span class="stat-label">وقت التشغيل:</span>
                        <span class="stat-value">\${formatUptime(data.system.uptime)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">المعالج:</span>
                        <span class="stat-value">\${data.system.cpu.cores} نواة</span>
                    </div>
                </div>
                
                <!-- استخدام الذاكرة -->
                <div class="card">
                    <h2>🧠 استخدام الذاكرة</h2>
                    <div class="stat-item">
                        <span class="stat-label">RSS:</span>
                        <span class="stat-value">\${formatBytes(data.process.memory.rss)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Heap Total:</span>
                        <span class="stat-value">\${formatBytes(data.process.memory.heapTotal)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Heap Used:</span>
                        <span class="stat-value">\${formatBytes(data.process.memory.heapUsed)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">النسبة:</span>
                        <span class="stat-value">\${((data.process.memory.heapUsed / data.process.memory.heapTotal) * 100).toFixed(2)}%</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill \${getProgressClass(data.process.memory.heapUsed / data.process.memory.heapTotal)}" 
                             style="width: \${(data.process.memory.heapUsed / data.process.memory.heapTotal) * 100}%"></div>
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
                            <span class="stat-label">الاتصالات النشطة:</span>
                            <span class="stat-value">\${data.database.pool.totalCount} / \${data.database.pool.max}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">الاتصالات الخاملة:</span>
                            <span class="stat-value">\${data.database.pool.idleCount}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">في الانتظار:</span>
                            <span class="stat-value">\${data.database.pool.waitingCount}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">الاستعلامات:</span>
                            <span class="stat-value">\${data.database.queries.total}</span>
                        </div>
                    \` : \`
                        <div class="stat-item">
                            <span class="stat-label">الخطأ:</span>
                            <span class="stat-value" style="color: red;">\${data.database.error}</span>
                        </div>
                    \`}
                </div>
                
                <!-- إحصائيات الطلبات -->
                <div class="card">
                    <h2>📊 إحصائيات الطلبات</h2>
                    <div class="stat-item">
                        <span class="stat-label">إجمالي الطلبات:</span>
                        <span class="stat-value">\${data.requests.total}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">وقت التشغيل:</span>
                        <span class="stat-value">\${formatUptime(data.requests.uptime / 1000)}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">الأخطاء:</span>
                        <span class="stat-value">
                            <span class="badge \${data.requests.errors.length > 0 ? 'badge-danger' : 'badge-success'}">
                                \${data.requests.errors.length}
                            </span>
                        </span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">طلبات بطيئة:</span>
                        <span class="stat-value">
                            <span class="badge \${data.requests.slowRequests.length > 0 ? 'badge-warning' : 'badge-success'}">
                                \${data.requests.slowRequests.length}
                            </span>
                        </span>
                    </div>
                </div>
                
                <!-- الطلبات حسب Method -->
                <div class="card">
                    <h2>📤 الطلبات حسب Method</h2>
                    \${Object.entries(data.requests.byMethod).map(([method, count]) => \`
                        <div class="stat-item">
                            <span class="stat-label">\${method}:</span>
                            <span class="stat-value">\${count}</span>
                        </div>
                    \`).join('')}
                </div>
                
                <!-- الطلبات حسب Status -->
                <div class="card">
                    <h2>📈 الطلبات حسب Status</h2>
                    \${Object.entries(data.requests.byStatus).map(([status, count]) => \`
                        <div class="stat-item">
                            <span class="stat-label">\${status}:</span>
                            <span class="stat-value">\${count}</span>
                        </div>
                    \`).join('')}
                </div>
                
                <!-- المسارات الأكثر استخداماً -->
                <div class="card">
                    <h2>🔗 المسارات الأكثر استخداماً</h2>
                    \${Object.entries(data.requests.byPath).slice(0, 10).map(([path, count]) => \`
                        <div class="stat-item">
                            <span class="stat-label" style="font-size: 12px;">\${path}:</span>
                            <span class="stat-value">\${count}</span>
                        </div>
                    \`).join('')}
                </div>
                
                <!-- الأخطاء الأخيرة -->
                <div class="card full-width">
                    <h2>❌ الأخطاء الأخيرة</h2>
                    <div class="error-list">
                        \${data.requests.errors.length > 0 ? 
                            data.requests.errors.slice(-10).reverse().map(error => \`
                                <div class="error-item">
                                    <div class="error-time">\${new Date(error.timestamp).toLocaleString('ar-SA')}</div>
                                    <div class="error-message">\${error.method} \${error.path} - \${error.statusCode} (\${error.duration}ms)</div>
                                </div>
                            \`).join('') : 
                            '<p style="color: #10b981; text-align: center; padding: 20px;">لا توجد أخطاء 🎉</p>'
                        }
                    </div>
                </div>
                
                <!-- معلومات السجلات -->
                <div class="card full-width">
                    <h2>📝 معلومات السجلات</h2>
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
                            \${Object.entries(data.logs).map(([name, info]) => \`
                                <tr>
                                    <td>\${name}.log</td>
                                    <td>\${info.exists ? info.sizeFormatted : 'غير موجود'}</td>
                                    <td>\${info.exists ? info.lineCount : '-'}</td>
                                    <td>\${info.exists ? new Date(info.modified).toLocaleString('ar-SA') : '-'}</td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                </div>
            \`;
        }
        
        // تحديث معلومات التحديث
        function updateRefreshInfo() {
            const now = new Date();
            document.getElementById('refreshInfo').textContent = 
                \`آخر تحديث: \${now.toLocaleString('ar-SA')} - التحديث التلقائي كل 5 ثوانٍ\`;
        }
        
        // تحديث البيانات يدوياً
        function refreshData() {
            loadData();
        }
        
        // إعادة تعيين الإحصائيات
        async function resetStats() {
            if (!confirm('هل أنت متأكد من إعادة تعيين جميع الإحصائيات؟')) {
                return;
            }
            
            try {
                const response = await fetch('/api/monitoring/reset', { method: 'POST' });
                const result = await response.json();
                
                if (result.success) {
                    alert('تم إعادة تعيين الإحصائيات بنجاح');
                    loadData();
                } else {
                    alert('خطأ في إعادة تعيين الإحصائيات');
                }
            } catch (error) {
                console.error('Error resetting stats:', error);
                alert('خطأ في الاتصال بالخادم');
            }
        }
        
        // دوال مساعدة
        function formatBytes(bytes) {
            if (bytes === 0) return '0 Bytes';
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
        
        function getProgressClass(percentage) {
            if (percentage > 0.8) return 'danger';
            if (percentage > 0.6) return 'warning';
            return '';
        }
    </script>
</body>
</html>
    `;
}

module.exports = router;

