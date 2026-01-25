// ============================================================================
// Database Configuration
// ============================================================================
// إعدادات اتصال قاعدة البيانات PostgreSQL
// ============================================================================

require('dotenv').config();
const { Pool } = require('pg');
const logger = require('../utils/logger');

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

// التحقق من نوع الخادم (Supabase أو خادم سحابي آخر)
const isSupabase =
  (process.env.DB_HOST || '').includes('supabase.co') ||
  (process.env.DB_HOST || '').includes('supabase.com') ||
  (process.env.DB_HOST || '').includes('pooler') ||
  (process.env.DATABASE_URL || '').includes('supabase.co') ||
  (process.env.DATABASE_URL || '').includes('supabase.com') ||
  (process.env.DATABASE_URL || '').includes('pooler');

// إعدادات SSL
const sslConfig =
  (process.env.DB_SSL === 'true' || isSupabase || !!process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false;

// ----------------------------------------------------------------------------
// Pool Config
// ----------------------------------------------------------------------------
// الأفضل في الإنتاج استخدام DATABASE_URL إن توفر (خصوصاً على Render/Supabase)
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: sslConfig,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      max: Number(process.env.DB_POOL_MAX || 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: sslConfig,
    };

// تنبيه مبكر لو ناقص إعدادات DB في الإنتاج
if (isProd && !process.env.DATABASE_URL) {
  const missing = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'].filter((k) => !process.env[k]);
  if (missing.length) {
    logger.errorMsg('Missing DB env vars in production', { missing });
    // لا نوقف السيرفر هنا حتى لا يدخل Render في إعادة تشغيل لا نهائية
    // لكن ستظهر حالة DB غير متصلة في المراقبة/الأخطاء
  }
}

// إنشاء Connection Pool
const pool = new Pool(poolConfig);

// ----------------------------------------------------------------------------
// Connection Test (Startup)
// ----------------------------------------------------------------------------
// اختبار الاتصال عند بدء التطبيق
// في الإنتاج (Render) لا نوقف الخادم بالكامل إذا فشل الاتصال
(async () => {
  try {
    const result = await pool.query('SELECT NOW() as now, version() as version');

    const versionRaw = result?.rows?.[0]?.version || '';
    const versionShort = versionRaw ? versionRaw.split(' ').slice(0, 2).join(' ') : 'unknown';

    logger.success('Database connection successful', {
      timestamp: result?.rows?.[0]?.now || null,
      version: versionShort,
      host: process.env.DATABASE_URL
        ? 'DATABASE_URL'
        : ((process.env.DB_HOST || '').substring(0, 30) + ((process.env.DB_HOST || '').length > 30 ? '...' : '')),
      ssl: !!sslConfig,
      environment: process.env.NODE_ENV || 'unknown',
    });
  } catch (error) {
    logger.errorMsg('Database connection failed', {
      error: error?.message || String(error),
      host: process.env.DATABASE_URL ? 'DATABASE_URL' : (process.env.DB_HOST || null),
      ssl: !!sslConfig,
      environment: process.env.NODE_ENV || 'unknown',
    });

    // محلياً/تطوير: أوقف التشغيل لتنتبه مباشرة
    // إنتاج: لا توقف حتى لا يصير Restart Loop في Render
    if (!isProd) {
      process.exit(1);
    }
  }
})();

// ----------------------------------------------------------------------------
// Pool Events
// ----------------------------------------------------------------------------
pool.on('connect', () => {
  logger.info('New PostgreSQL connection created');
});

pool.on('error', (err) => {
  logger.errorMsg('PostgreSQL connection error', {
    error: err?.message || String(err),
    code: err?.code,
  });
});

// ----------------------------------------------------------------------------
// Query Wrapper (Monitoring)
// ----------------------------------------------------------------------------
// Wrapper لتسجيل استعلامات قاعدة البيانات (للمراقبة)
// ملاحظة: يتم تحميل monitoringService بشكل lazy لتجنب circular dependencies
let monitoringServiceLoaded = false;
let recordQuery = null;

function loadMonitoringService() {
  if (!monitoringServiceLoaded) {
    try {
      const monitoring = require('../services/monitoringService');
      recordQuery = monitoring?.recordQuery || null;
      monitoringServiceLoaded = true;
    } catch (error) {
      // تجاهل الأخطاء في تحميل خدمة المراقبة
      monitoringServiceLoaded = true; // لا تحاول كل مرة
    }
  }
}

const originalQuery = pool.query.bind(pool);

pool.query = function (text, params, callback) {
  const startTime = Date.now();
  const queryText =
    typeof text === 'string'
      ? text
      : (text?.text || text?.command || 'N/A');

  // تحميل خدمة المراقبة
  loadMonitoringService();

  // ملاحظة: pg يدعم شكلين:
  // pool.query(text, params, cb)  أو  pool.query(text, cb)
  // لذلك نمرّر كما هي بدون كسر التواقيع
  const done = (err, res) => {
    const duration = Date.now() - startTime;

    if (recordQuery) {
      try {
        recordQuery(duration, queryText, err);
      } catch (_) {
        // تجاهل
      }
    }

    if (typeof callback === 'function') {
      callback(err, res);
    }
  };

  // إذا callback موجود: استخدم callback style
  if (typeof callback === 'function') {
    return originalQuery(text, params, done);
  }

  // إذا params عبارة عن function (query(text, cb))
  if (typeof params === 'function') {
    return originalQuery(text, done);
  }

  // Promise style
  const result = originalQuery(text, params);

  if (result && typeof result.then === 'function') {
    return result.then(
      (res) => {
        const duration = Date.now() - startTime;
        if (recordQuery) {
          try {
            recordQuery(duration, queryText, null);
          } catch (_) {}
        }
        return res;
      },
      (err) => {
        const duration = Date.now() - startTime;
        if (recordQuery) {
          try {
            recordQuery(duration, queryText, err);
          } catch (_) {}
        }
        throw err;
      }
    );
  }

  return result;
};

// ----------------------------------------------------------------------------
// Health Check Helper
// ----------------------------------------------------------------------------
async function checkPoolHealth() {
  try {
    const result = await originalQuery('SELECT NOW() as now');
    return {
      healthy: true,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      timestamp: result?.rows?.[0]?.now || null,
    };
  } catch (error) {
    return {
      healthy: false,
      error: error?.message || String(error),
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
  }
}

module.exports = {
  pool,
  checkPoolHealth,
};
