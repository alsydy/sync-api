// ============================================================================
// Drop Old Tables Script - حذف الجداول القديمة
// ============================================================================

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function dropOldTables() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 بدء حذف الجداول القديمة...');
    await client.query('BEGIN');
    
    // قائمة الجداول القديمة للحذف
    const oldTables = [
      'users',
      'customers', 
      'transactions',
      'notifications',
      'account_numbers',
      'failed_operations',
      'cash_accounts' // سيتم إعادة إنشاؤه
    ];
    
    console.log('📋 الجداول التي سيتم حذفها:');
    oldTables.forEach(table => console.log(`   - ${table}`));
    
    // حذف الجداول القديمة
    for (const table of oldTables) {
      try {
        await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
        console.log(`   ✅ تم حذف جدول ${table}`);
      } catch (error) {
        console.log(`   ⚠️  خطأ في حذف ${table}: ${error.message.split('\n')[0]}`);
      }
    }
    
    // حذف الجداول الجديدة أيضاً إذا كانت موجودة (لإعادة الإنشاء)
    const newTables = [
      'app_users',
      'business_clients',
      'financial_transactions',
      'system_notifications',
      'account_numbers_registry',
      'sync_failed_operations',
      'audit_log',
      'sync_sessions',
      'sync_settings'
    ];
    
    console.log('\n📋 حذف الجداول الجديدة (لإعادة الإنشاء):');
    for (const table of newTables) {
      try {
        await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
        console.log(`   ✅ تم حذف جدول ${table}`);
      } catch (error) {
        console.log(`   ⚠️  خطأ في حذف ${table}: ${error.message.split('\n')[0]}`);
      }
    }
    
    // حذف Functions القديمة
    console.log('\n📋 حذف Functions القديمة:');
    await client.query('DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE').catch(() => {});
    await client.query('DROP FUNCTION IF EXISTS increment_sync_version() CASCADE').catch(() => {});
    console.log('   ✅ تم حذف Functions');
    
    await client.query('COMMIT');
    console.log('\n✅ تم حذف جميع الجداول القديمة بنجاح!');
    console.log('💡 الآن يمكنك تشغيل الهجرة الجديدة');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ خطأ في حذف الجداول:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

dropOldTables()
  .then(() => {
    console.log('✅ اكتملت عملية الحذف بنجاح');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ فشلت عملية الحذف:', error);
    process.exit(1);
  });

