// ============================================================================
// Monitoring Service
// ============================================================================
// خدمة جمع إحصائيات المراقبة الشاملة للخادم
// ============================================================================

const os = require('os');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

// إحصائيات الطلبات (في الذاكرة)
let requestStats = {
  total: 0,
  byMethod: {},
  byStatus: {},
  byPath: {},
  errors: [],
  slowRequests: [],
  startTime: Date.now()
};

// إحصائيات قاعدة البيانات
let dbStats = {
  queries: 0,
  slowQueries: [],
  errors: []
};

// إحصائيات الذاكرة
let memoryHistory = [];
const MAX_HISTORY = 100; // آخر 100 قياس

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function poolSnapshot() {
  return {
    totalCount: pool?.totalCount || 0,
    idleCount: pool?.idleCount || 0,
    waitingCount: pool?.waitingCount || 0,
    max: pool?.options?.max || Number(process.env.DB_POOL_MAX || 10)
  };
}

async function safeQuery(sql, params = []) {
  try {
    if (!pool || typeof pool.query !== 'function') {
      return { ok: false, error: 'Pool not initialized', rows: [] };
    }
    const res = await pool.query(sql, params);
    return { ok: true, rows: res?.rows ?? [] };
  } catch (e) {
    return { ok: false, error: e?.message || String(e), rows: [] };
  }
}

/**
 * جمع معلومات النظام
 */
function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: process.uptime(),
    cpu: {
      model: cpus[0].model,
      cores: cpus.length,
      usage: process.cpuUsage()
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percentage: ((usedMem / totalMem) * 100).toFixed(2)
    },
    loadAverage: os.loadavg()
  };
}

/**
 * جمع معلومات عملية Node.js
 */
function getProcessInfo() {
  const usage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  return {
    pid: process.pid,
    uptime: process.uptime(),
    memory: {
      rss: usage.rss,                    // Resident Set Size
      heapTotal: usage.heapTotal,        // إجمالي Heap
      heapUsed: usage.heapUsed,          // المستخدم من Heap
      external: usage.external,          // الذاكرة الخارجية
      arrayBuffers: usage.arrayBuffers   // Array Buffers
    },
    cpu: {
      user: cpuUsage.user,               // وقت المستخدم (microseconds)
      system: cpuUsage.system            // وقت النظام (microseconds)
    }
  };
}

/**
 * جمع معلومات قاعدة البيانات
 */
async function getDatabaseInfo() {
  // 1) معلومات عامة + فحص اتصال سريع
  const health = await safeQuery('SELECT NOW() as now, version() as version');

  // لو فشل الاتصال: لا تكسر المراقبة
  if (!health.ok || !health.rows.length) {
    // سجّل الخطأ (بدون spam شديد: ممكن تحب تقلل التسجيل لاحقًا)
    try {
      if (typeof logger.errorMsg === 'function') {
        logger.errorMsg('Error getting database info', { error: health.error });
      } else if (typeof logger.error === 'function') {
        logger.error('Error getting database info', { error: health.error });
      }
    } catch (_) {}

    return {
      connected: false,
      error: health.error || 'Database unavailable',
      pool: poolSnapshot(),
      queries: {
        total: dbStats.queries,
        slow: dbStats.slowQueries.length,
        errors: dbStats.errors.length
      }
    };
  }

  const row0 = health.rows[0] || {};
  const versionRaw = row0.version || '';
  const versionShort = versionRaw ? versionRaw.split(' ').slice(0, 2).join(' ') : 'unknown';

  // 2) حجم القاعدة واتصالاتها (قد يفشل وحده حتى لو health نجح)
  const dbSize = await safeQuery(`
    SELECT 
      pg_size_pretty(pg_database_size(current_database())) as size,
      (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active_connections,
      (SELECT count(*) FROM pg_stat_activity) as total_connections
  `);

  // لو فشل هذا الاستعلام، رجّع المعلومات الأساسية فقط
  const sizeRow = dbSize.rows?.[0] || {};

  return {
    connected: true,
    version: versionShort,
    timestamp: row0.now || null,
    pool: poolSnapshot(),
    size: dbSize.ok ? (sizeRow.size || 'N/A') : 'N/A',
    connections: {
      active: dbSize.ok ? parseInt(sizeRow.active_connections || 0, 10) : 0,
      total: dbSize.ok ? parseInt(sizeRow.total_connections || 0, 10) : 0
    },
    queries: {
      total: dbStats.queries,
      slow: dbStats.slowQueries.length,
      errors: dbStats.errors.length
    },
    // أعرض خطأ ثانوي إذا فشل استعلام الحجم/الاتصالات فقط
    warning: dbSize.ok ? null : (dbSize.error || 'Failed to read db stats')
  };
}

/**
 * جمع معلومات السجلات (Logs)
 */
function getLogsInfo() {
  const logsDir = path.join(__dirname, '../logs');
  const logFiles = {
    error: path.join(logsDir, 'error.log'),
    combined: path.join(logsDir, 'combined.log'),
    exceptions: path.join(logsDir, 'exceptions.log'),
    rejections: path.join(logsDir, 'rejections.log')
  };

  const logs = {};

  for (const [name, filePath] of Object.entries(logFiles)) {
    try {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());

        // آخر 10 أخطاء من error.log
        if (name === 'error') {
          logs[name] = {
            exists: true,
            size: stats.size,
            sizeFormatted: formatBytes(stats.size),
            modified: stats.mtime,
            lineCount: lines.length,
            recentErrors: lines.slice(-10).map(line => {
              try {
                return JSON.parse(line);
              } catch {
                return { raw: line };
              }
            })
          };
        } else {
          logs[name] = {
            exists: true,
            size: stats.size,
            sizeFormatted: formatBytes(stats.size),
            modified: stats.mtime,
            lineCount: lines.length
          };
        }
      } else {
        logs[name] = { exists: false };
      }
    } catch (error) {
      logs[name] = { exists: false, error: error.message };
    }
  }

  return logs;
}

/**
 * جمع جميع إحصائيات المراقبة
 */
async function getMonitoringStats() {
  const systemInfo = getSystemInfo();
  const processInfo = getProcessInfo();
  const databaseInfo = await getDatabaseInfo();
  const logsInfo = getLogsInfo();

  // إضافة الذاكرة الحالية للتاريخ
  memoryHistory.push({
    timestamp: Date.now(),
    heapUsed: processInfo.memory.heapUsed,
    heapTotal: processInfo.memory.heapTotal,
    rss: processInfo.memory.rss,
    percentage: (processInfo.memory.heapTotal > 0
      ? ((processInfo.memory.heapUsed / processInfo.memory.heapTotal) * 100).toFixed(2)
      : '0.00'
    )
  });

  // الاحتفاظ بآخر MAX_HISTORY قياس
  if (memoryHistory.length > MAX_HISTORY) {
    memoryHistory = memoryHistory.slice(-MAX_HISTORY);
  }

  return {
    timestamp: new Date().toISOString(),
    system: systemInfo,
    process: processInfo,
    database: databaseInfo,
    requests: {
      total: requestStats.total,
      byMethod: requestStats.byMethod,
      byStatus: requestStats.byStatus,
      byPath: Object.entries(requestStats.byPath)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .reduce((obj, [key, value]) => {
          obj[key] = value;
          return obj;
        }, {}),
      errors: requestStats.errors.slice(-20), // آخر 20 خطأ
      slowRequests: requestStats.slowRequests.slice(-10), // آخر 10 طلبات بطيئة
      uptime: Date.now() - requestStats.startTime
    },
    memory: {
      current: processInfo.memory,
      history: memoryHistory.slice(-20) // آخر 20 قياس للعرض
    },
    logs: logsInfo
  };
}

/**
 * تسجيل طلب جديد
 */
function recordRequest(method, path, statusCode, duration) {
  requestStats.total++;

  // حسب Method
  requestStats.byMethod[method] = (requestStats.byMethod[method] || 0) + 1;

  // حسب Status Code
  const statusCategory = Math.floor(statusCode / 100) + 'xx';
  requestStats.byStatus[statusCategory] = (requestStats.byStatus[statusCategory] || 0) + 1;

  // حسب Path
  requestStats.byPath[path] = (requestStats.byPath[path] || 0) + 1;

  // تسجيل الأخطاء
  if (statusCode >= 400) {
    requestStats.errors.push({
      timestamp: new Date().toISOString(),
      method,
      path,
      statusCode,
      duration
    });

    // الاحتفاظ بآخر 100 خطأ
    if (requestStats.errors.length > 100) {
      requestStats.errors = requestStats.errors.slice(-100);
    }
  }

  // تسجيل الطلبات البطيئة (> 1 ثانية)
  if (duration > 1000) {
    requestStats.slowRequests.push({
      timestamp: new Date().toISOString(),
      method,
      path,
      statusCode,
      duration
    });

    // الاحتفاظ بآخر 50 طلب بطيء
    if (requestStats.slowRequests.length > 50) {
      requestStats.slowRequests = requestStats.slowRequests.slice(-50);
    }
  }
}

/**
 * تسجيل استعلام قاعدة البيانات
 */
function recordQuery(duration, query, error = null) {
  dbStats.queries++;

  if (error) {
    dbStats.errors.push({
      timestamp: new Date().toISOString(),
      query: (query || '').substring(0, 200), // أول 200 حرف
      error: error.message,
      duration
    });

    // الاحتفاظ بآخر 100 خطأ
    if (dbStats.errors.length > 100) {
      dbStats.errors = dbStats.errors.slice(-100);
    }
  }

  // تسجيل الاستعلامات البطيئة (> 500ms)
  if (duration > 500) {
    dbStats.slowQueries.push({
      timestamp: new Date().toISOString(),
      query: (query || '').substring(0, 200),
      duration
    });

    // الاحتفاظ بآخر 50 استعلام بطيء
    if (dbStats.slowQueries.length > 50) {
      dbStats.slowQueries = dbStats.slowQueries.slice(-50);
    }
  }
}

/**
 * إعادة تعيين الإحصائيات
 */
function resetStats() {
  requestStats = {
    total: 0,
    byMethod: {},
    byStatus: {},
    byPath: {},
    errors: [],
    slowRequests: [],
    startTime: Date.now()
  };

  dbStats = {
    queries: 0,
    slowQueries: [],
    errors: []
  };

  memoryHistory = [];
}

/**
 * تنسيق البايتات
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * تنسيق الوقت
 */
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) return `${days} يوم ${hours} ساعة ${minutes} دقيقة`;
  if (hours > 0) return `${hours} ساعة ${minutes} دقيقة ${secs} ثانية`;
  if (minutes > 0) return `${minutes} دقيقة ${secs} ثانية`;
  return `${secs} ثانية`;
}

module.exports = {
  getMonitoringStats,
  recordRequest,
  recordQuery,
  resetStats,
  formatBytes,
  formatUptime
};
