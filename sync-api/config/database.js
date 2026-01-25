// ============================================================================
// Database Configuration
// ============================================================================
// إعدادات اتصال قاعدة البيانات PostgreSQL
// ============================================================================

require('dotenv').config();
const { Pool } = require('pg');
const logger = require('../utils/logger');

// التحقق من نوع الخادم (Supabase أو خادم سحابي آخر)
const isSupabase =
  (process.env.DB_HOST || '').includes('supabase.co') ||
  (process.env.DB_HOST || '').includes('supabase.com') ||
  (process.env.DB_HOST || '').includes('pooler');

// إعدادات SSL
const sslConfig = (process.env.DB_SSL === 'true' || isSupabase)
  ? { rejectUnauthorized: false }
  : false;

// إنشاء Connection Pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: sslConfig,
});

// اختبار الاتصال عند بدء التطبيق
(async () => {
  try {
    const result = await pool.query('SELECT NOW() as now, version() as version');
    logger.success('Database connection successful', {
      timestamp: result.rows[0].now,
      version: result.rows[0].version.split(' ')[0] + ' ' + result.rows[0].version.split(' ')[1],
      host: process.env.DB_HOST?.substring(0, 30) + '...'
    });
  } catch (error) {
    logger.errorMsg('Database connection failed', {
      error: error.message,
      host: process.env.DB_HOST
    });
    process.exit(1);
  }
})();

// أحداث الـ Pool
pool.on('connect', () => {
  logger.info('New PostgreSQL connection created');
});

pool.on('error', (err) => {
  logger.errorMsg('PostgreSQL connection error', {
    error: err.message,
    code: err.code
  });
});

// Wrapper لتسجيل استعلامات قاعدة البيانات (للمراقبة)
// ملاحظة: يتم تحميل monitoringService بشكل lazy لتجنب circular dependencies
let monitoringServiceLoaded = false;
let recordQuery = null;

function loadMonitoringService() {
  if (!monitoringServiceLoaded) {
    try {
      const monitoring = require('../services/monitoringService');
      recordQuery = monitoring.recordQuery;
      monitoringServiceLoaded = true;
    } catch (error) {
      // تجاهل الأخطاء في تحميل خدمة المراقبة
    }
  }
}

const originalQuery = pool.query.bind(pool);
pool.query = function(text, params, callback) {
  const startTime = Date.now();
  const queryText = typeof text === 'string' ? text : (text?.text || text?.command || 'N/A');
  
  // تحميل خدمة المراقبة
  loadMonitoringService();
  
  // استدعاء الاستعلام الأصلي
  const result = originalQuery(text, params, (err, res) => {
    const duration = Date.now() - startTime;
    
    // تسجيل الاستعلام للمراقبة
    if (recordQuery) {
      try {
        recordQuery(duration, queryText, err);
      } catch (error) {
        // تجاهل الأخطاء في تسجيل المراقبة
      }
    }
    
    // استدعاء callback الأصلي
    if (callback) {
      callback(err, res);
    }
  });
  
  // إذا كان Promise
  if (result && typeof result.then === 'function') {
    return result.then(
      (res) => {
        const duration = Date.now() - startTime;
        if (recordQuery) {
          try {
            recordQuery(duration, queryText, null);
          } catch (error) {
            // تجاهل الأخطاء في تسجيل المراقبة
          }
        }
        return res;
      },
      (err) => {
        const duration = Date.now() - startTime;
        if (recordQuery) {
          try {
            recordQuery(duration, queryText, err);
          } catch (error) {
            // تجاهل الأخطاء في تسجيل المراقبة
          }
        }
        throw err;
      }
    );
  }
  
  return result;
};

// دالة للتحقق من صحة الـ Pool
async function checkPoolHealth() {
  try {
    const result = await pool.query('SELECT NOW()');
    return {
      healthy: true,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      timestamp: result.rows[0].now
    };
  } catch (error) {
    return {
      healthy: false,
      error: error.message
    };
  }
}

module.exports = {
  pool,
  checkPoolHealth
};

