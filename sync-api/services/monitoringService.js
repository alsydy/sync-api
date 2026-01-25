// ============================================================================
// Monitoring Service (Lightweight / Small Servers Friendly)
// ============================================================================
// خدمة جمع إحصائيات المراقبة الشاملة للخادم - نسخة خفيفة جداً
// مناسبة للسيرفرات الصغيرة (مثل 1GB RAM) وتقلل Disk/DB/CPU
// ============================================================================

const os = require('os');
const fs = require('fs');
const path = require('path');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

// ===================== إعدادات قابلة للتعديل عبر ENV =====================
const MONITOR_CACHE_TTL_MS = Number(process.env.MONITOR_CACHE_TTL_MS || 5000);     // كاش كامل الإحصائيات
const MONITOR_DB_TTL_MS = Number(process.env.MONITOR_DB_TTL_MS || 20000);         // كاش DB info
const MONITOR_LOGS_TTL_MS = Number(process.env.MONITOR_LOGS_TTL_MS || 60000);     // كاش logs
const MAX_HISTORY = Number(process.env.MONITOR_MAX_HISTORY || 30);                // تاريخ الذاكرة (صغير)
const LOG_TAIL_KB = Number(process.env.MONITOR_LOG_TAIL_KB || 32);                // اقرأ آخر X KB فقط
const MAX_REQUEST_ERRORS = Number(process.env.MONITOR_MAX_REQUEST_ERRORS || 50);
const MAX_SLOW_REQUESTS = Number(process.env.MONITOR_MAX_SLOW_REQUESTS || 20);
const MAX_DB_ERRORS = Number(process.env.MONITOR_MAX_DB_ERRORS || 50);
const MAX_DB_SLOW = Number(process.env.MONITOR_MAX_DB_SLOW || 20);
const DB_SLOW_QUERY_MS = Number(process.env.MONITOR_DB_SLOW_QUERY_MS || 700);     // كان 500ms
const SLOW_REQUEST_MS = Number(process.env.MONITOR_SLOW_REQUEST_MS || 1500);      // كان 1000ms

// ===================== بيانات ثابتة (تجنب حساب مكلف متكرر) =====================
const CPU_INFO = (() => {
  try {
    const cpus = os.cpus();
    return {
      model: cpus?.[0]?.model || 'N/A',
      cores: Array.isArray(cpus) ? cpus.length : 0
    };
  } catch {
    return { model: 'N/A', cores: 0 };
  }
})();

// ===================== إحصائيات الطلبات (في الذاكرة) =====================
let requestStats = {
  total: 0,
  byMethod: {},
  byStatus: {},
  byPath: {},
  errors: [],
  slowRequests: [],
  startTime: Date.now()
};

// ===================== إحصائيات قاعدة البيانات =====================
let dbStats = {
  queries: 0,
  slowQueries: [],
  errors: []
};

// ===================== تاريخ الذاكرة =====================
let memoryHistory = [];

// ===================== Cache عام =====================
let statsCache = { ts: 0, data: null };
let dbCache = { ts: 0, data: null };
let logsCache = { ts: 0, data: null };

// ============================================================================
// Helpers
// ============================================================================

function nowMs() { return Date.now(); }

function clampArray(arr, max) {
  if (!Array.isArray(arr)) return [];
  return arr.length > max ? arr.slice(-max) : arr;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

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

// اقرأ آخر جزء من الملف فقط (بدون قراءة الملف كامل) - مهم لتخفيف Disk IO
async function readFileTail(filePath, tailBytes) {
  try {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      const size = stat.size || 0;
      const readSize = Math.min(size, tailBytes);
      const start = Math.max(0, size - readSize);

      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (e) {
    return null;
  }
}

function safeJsonParseLines(text, maxLines = 10) {
  if (!text) return [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const tail = lines.slice(-maxLines);
  return tail.map(line => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}

// ============================================================================
// جمع معلومات النظام (خفيف)
// ============================================================================
function getSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);

  return {
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptime: process.uptime(),
    cpu: {
      model: CPU_INFO.model,
      cores: CPU_INFO.cores,
      usage: process.cpuUsage()
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      percentage: totalMem ? ((usedMem / totalMem) * 100).toFixed(2) : '0.00'
    },
    loadAverage: os.loadavg()
  };
}

// ============================================================================
// جمع معلومات عملية Node.js
// ============================================================================
function getProcessInfo() {
  const usage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  return {
    pid: process.pid,
    uptime: process.uptime(),
    memory: {
      rss: usage.rss,
      heapTotal: usage.heapTotal,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers
    },
    cpu: {
      user: cpuUsage.user,
      system: cpuUsage.system
    }
  };
}

// ============================================================================
// جمع معلومات قاعدة البيانات (مع Cache لتخفيف الضغط)
// ============================================================================
async function getDatabaseInfoCached() {
  const now = nowMs();
  if (dbCache.data && (now - dbCache.ts) < MONITOR_DB_TTL_MS) return dbCache.data;

  const data = await getDatabaseInfoLight();
  dbCache = { ts: now, data };
  return data;
}

async function getDatabaseInfoLight() {
  // ✅ “خفيف”:
  // - استعلام version/now
  // - استعلام حجم القاعدة + اتصالات (واحد)
  // * وإذا فشل، لا نقتل السيرفر
  try {
    const poolHealth = await pool.query('SELECT NOW() as now, version() as version');
    const version = poolHealth.rows?.[0]?.version || 'N/A';

    // إحصائيات الـ Pool
    const poolStats = {
      totalCount: pool.totalCount || 0,
      idleCount: pool.idleCount || 0,
      waitingCount: pool.waitingCount || 0,
      max: pool.options?.max || 10
    };

    // استعلام واحد فقط (بدلاً من عدة استعلامات)
    const dbSizeResult = await pool.query(`
      SELECT 
        pg_size_pretty(pg_database_size(current_database())) as size,
        (SELECT count(*) FROM pg_stat_activity WHERE state = 'active') as active_connections,
        (SELECT count(*) FROM pg_stat_activity) as total_connections
    `);

    const row = dbSizeResult.rows?.[0] || {};

    return {
      connected: true,
      version: version.split(' ').slice(0, 2).join(' '),
      timestamp: poolHealth.rows?.[0]?.now,
      pool: poolStats,
      size: row.size || 'N/A',
      connections: {
        active: parseInt(row.active_connections || 0, 10),
        total: parseInt(row.total_connections || 0, 10)
      },
      queries: {
        total: dbStats.queries,
        slow: dbStats.slowQueries.length,
        errors: dbStats.errors.length
      },
      warning: null
    };
  } catch (error) {
    // لا تسوي spam لوج كثير
    logger.error('Error getting database info', { error: error.message });
    return {
      connected: false,
      error: error.message
    };
  }
}

// ============================================================================
// جمع معلومات السجلات (Logs) - Cache + Tail Only
// ============================================================================
async function getLogsInfoCached() {
  const now = nowMs();
  if (logsCache.data && (now - logsCache.ts) < MONITOR_LOGS_TTL_MS) return logsCache.data;

  const data = await getLogsInfoLight();
  logsCache = { ts: now, data };
  return data;
}

async function getLogsInfoLight() {
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
      const exists = fs.existsSync(filePath);
      if (!exists) {
        logs[name] = { exists: false };
        continue;
      }

      const stats = fs.statSync(filePath);

      // ✅ لا نقرأ الملف كامل أبداً
      if (name === 'error') {
        const tailText = await readFileTail(filePath, LOG_TAIL_KB * 1024);
        const recentErrors = safeJsonParseLines(tailText, 10);

        // lineCount الحقيقي قد يحتاج قراءة كاملة (مكلف)، لذلك نضع تقديريًا أو "-"
        logs[name] = {
          exists: true,
          size: stats.size,
          sizeFormatted: formatBytes(stats.size),
          modified: stats.mtime,
          lineCount: '-', // لتخفيف الموارد
          recentErrors
        };
      } else {
        logs[name] = {
          exists: true,
          size: stats.size,
          sizeFormatted: formatBytes(stats.size),
          modified: stats.mtime,
          lineCount: '-' // لتخفيف الموارد
        };
      }
    } catch (error) {
      logs[name] = { exists: false, error: error.message };
    }
  }

  return logs;
}

// ============================================================================
// جمع جميع إحصائيات المراقبة (Cache عام)
// ============================================================================
async function getMonitoringStats() {
  const now = nowMs();
  if (statsCache.data && (now - statsCache.ts) < MONITOR_CACHE_TTL_MS) {
    return statsCache.data;
  }

  const systemInfo = getSystemInfo();
  const processInfo = getProcessInfo();
  const databaseInfo = await getDatabaseInfoCached();
  const logsInfo = await getLogsInfoCached();

  // تاريخ الذاكرة (صغير)
  const heapTotal = processInfo.memory.heapTotal || 0;
  const heapUsed = processInfo.memory.heapUsed || 0;
  const percentage = heapTotal ? ((heapUsed / heapTotal) * 100).toFixed(2) : '0.00';

  memoryHistory.push({
    timestamp: now,
    heapUsed,
    heapTotal,
    rss: processInfo.memory.rss,
    percentage
  });
  memoryHistory = clampArray(memoryHistory, MAX_HISTORY);

  const data = {
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
      errors: requestStats.errors.slice(-20),
      slowRequests: requestStats.slowRequests.slice(-10),
      uptime: now - requestStats.startTime
    },
    memory: {
      current: processInfo.memory,
      history: memoryHistory.slice(-20)
    },
    logs: logsInfo
  };

  statsCache = { ts: now, data };
  return data;
}

// ============================================================================
// تسجيل طلب جديد
// ============================================================================
function recordRequest(method, reqPath, statusCode, duration) {
  requestStats.total++;

  const m = String(method || '').toUpperCase();
  requestStats.byMethod[m] = (requestStats.byMethod[m] || 0) + 1;

  const statusCategory = Math.floor((statusCode || 0) / 100) + 'xx';
  requestStats.byStatus[statusCategory] = (requestStats.byStatus[statusCategory] || 0) + 1;

  const p = String(reqPath || '/');
  requestStats.byPath[p] = (requestStats.byPath[p] || 0) + 1;

  if (statusCode >= 400) {
    requestStats.errors.push({
      timestamp: new Date().toISOString(),
      method: m,
      path: p,
      statusCode,
      duration
    });
    requestStats.errors = clampArray(requestStats.errors, MAX_REQUEST_ERRORS);
  }

  if (duration > SLOW_REQUEST_MS) {
    requestStats.slowRequests.push({
      timestamp: new Date().toISOString(),
      method: m,
      path: p,
      statusCode,
      duration
    });
    requestStats.slowRequests = clampArray(requestStats.slowRequests, MAX_SLOW_REQUESTS);
  }
}

// ============================================================================
// تسجيل استعلام قاعدة البيانات
// ============================================================================
function recordQuery(duration, query, error = null) {
  dbStats.queries++;

  const q = String(query || 'N/A').substring(0, 200);

  if (error) {
    dbStats.errors.push({
      timestamp: new Date().toISOString(),
      query: q,
      error: error.message,
      duration
    });
    dbStats.errors = clampArray(dbStats.errors, MAX_DB_ERRORS);
  }

  if (duration > DB_SLOW_QUERY_MS) {
    dbStats.slowQueries.push({
      timestamp: new Date().toISOString(),
      query: q,
      duration
    });
    dbStats.slowQueries = clampArray(dbStats.slowQueries, MAX_DB_SLOW);
  }
}

// ============================================================================
// إعادة تعيين الإحصائيات
// ============================================================================
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

  // تنظيف الكاشات أيضًا
  statsCache = { ts: 0, data: null };
  dbCache = { ts: 0, data: null };
  logsCache = { ts: 0, data: null };
}

module.exports = {
  getMonitoringStats,
  recordRequest,
  recordQuery,
  resetStats,
  formatBytes,
  formatUptime
};
