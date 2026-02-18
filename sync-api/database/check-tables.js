require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function checkTables() {
  try {
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log('📊 الجداول الموجودة في قاعدة البيانات:');
    result.rows.forEach(row => {
      console.log(`   - ${row.table_name}`);
    });
    
    // التحقق من وجود الجداول القديمة
    const oldTables = ['users', 'customers', 'transactions', 'notifications', 'account_numbers', 'failed_operations'];
    const existingOldTables = result.rows
      .map(r => r.table_name)
      .filter(name => oldTables.includes(name));
    
    if (existingOldTables.length > 0) {
      console.log('\n⚠️  تم العثور على جداول قديمة:');
      existingOldTables.forEach(name => console.log(`   - ${name}`));
      console.log('\n💡 يجب حذف الجداول القديمة أو تحديثها قبل المتابعة');
    }
    
  } catch (error) {
    console.error('❌ خطأ:', error.message);
  } finally {
    await pool.end();
  }
}

checkTables();

