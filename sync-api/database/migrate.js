// ============================================================================
// Database Migration Script - MalyMax Professional Schema
// ============================================================================
// هذا السكريبت ينفذ هيكل قاعدة البيانات الجديد
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function migrate() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 بدء عملية الهجرة...');
    
    // قراءة ملف schema.sql
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSQL = fs.readFileSync(schemaPath, 'utf8');
    
    // تنفيذ SQL
    await client.query('BEGIN');
    await client.query(schemaSQL);
    await client.query('COMMIT');
    
    console.log('✅ تم إنشاء هيكل قاعدة البيانات بنجاح!');
    console.log('📊 الجداول المتاحة:');
    console.log('   - app_users (المستخدمين)');
    console.log('   - business_clients (العملاء)');
    console.log('   - cash_accounts (الحسابات النقدية)');
    console.log('   - financial_transactions (المعاملات المالية)');
    console.log('   - system_notifications (الإشعارات)');
    console.log('   - account_numbers_registry (سجل أرقام الحسابات)');
    console.log('   - sync_failed_operations (العمليات الفاشلة)');
    console.log('   - audit_log (سجل العمليات)');
    console.log('   - sync_sessions (جلسات المزامنة)');
    console.log('   - sync_settings (إعدادات المزامنة)');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ خطأ في عملية الهجرة:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// تنفيذ الهجرة
migrate()
  .then(() => {
    console.log('✅ اكتملت عملية الهجرة بنجاح');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ فشلت عملية الهجرة:', error);
    process.exit(1);
  });

