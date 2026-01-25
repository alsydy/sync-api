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

