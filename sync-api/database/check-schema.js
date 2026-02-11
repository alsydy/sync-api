require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function checkSchema() {
  try {
    // التحقق من هيكل cash_accounts
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'cash_accounts'
      ORDER BY ordinal_position
    `);
    
    console.log('📊 هيكل جدول cash_accounts:');
    result.rows.forEach(col => {
      console.log(`   - ${col.column_name} (${col.data_type}) ${col.is_nullable === 'NO' ? 'NOT NULL' : ''}`);
    });
    
    // التحقق من المفاتيح الأساسية
    const pkResult = await pool.query(`
      SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'cash_accounts'::regclass AND i.indisprimary
    `);
    
    console.log('\n🔑 المفتاح الأساسي:');
    pkResult.rows.forEach(row => {
      console.log(`   - ${row.attname}`);
    });
    
  } catch (error) {
    console.error('❌ خطأ:', error.message);
  } finally {
    await pool.end();
  }
}

checkSchema();

