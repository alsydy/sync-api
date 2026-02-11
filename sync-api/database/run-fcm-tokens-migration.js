// ============================================================================
// Script لتشغيل migration لجدول user_fcm_tokens
// ============================================================================

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 7754,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 بدء تشغيل migration لجدول user_fcm_tokens...\n');
    console.log(`📡 الاتصال بقاعدة البيانات: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 7754}/${process.env.DB_NAME || 'malymax_prod'}\n`);

    // قراءة ملف migration
    const migrationPath = path.join(__dirname, 'migration_user_fcm_tokens.sql');
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    // تنفيذ SQL كاملاً
    console.log('⏳ تنفيذ migration script...\n');
    
    try {
      await client.query('BEGIN');
      
      // تنفيذ كل أمر بشكل منفصل
      const statements = migrationSQL
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('='));
      
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];
        if (statement.trim().length === 0) continue;
        
        try {
          console.log(`   ⏳ تنفيذ ${i + 1}/${statements.length}...`);
          await client.query(statement);
          console.log(`   ✅ تم بنجاح\n`);
        } catch (error) {
          // تجاهل الأخطاء إذا كان موجوداً بالفعل
          if (error.code === '42P07' || 
              error.message.includes('already exists') ||
              error.message.includes('duplicate')) {
            console.log(`   ⚠️  تم تخطي (موجود بالفعل)\n`);
          } else {
            throw error;
          }
        }
      }
      
      await client.query('COMMIT');
      console.log('✅ Migration اكتمل بنجاح!\n');
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    // التحقق من نجاح Migration
    console.log('🔍 التحقق من نجاح Migration...\n');
    const checkResult = await client.query(`
      SELECT EXISTS (
         SELECT FROM information_schema.tables 
         WHERE table_schema = 'public' 
         AND table_name = 'user_fcm_tokens'
      ) as table_exists;
    `);

    if (checkResult.rows[0].table_exists) {
      console.log('✅ Migration اكتمل بنجاح! الجدول user_fcm_tokens موجود الآن.\n');
      
      // عرض معلومات الجدول
      const columns = await client.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = 'user_fcm_tokens'
        ORDER BY ordinal_position;
      `);
      
      console.log('📋 أعمدة الجدول:');
      columns.rows.forEach(col => {
        console.log(`   - ${col.column_name} (${col.data_type})`);
      });
      
      const indexes = await client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'user_fcm_tokens';
      `);
      
      console.log(`\n📊 عدد الـ Indexes: ${indexes.rows.length}`);
      
      const triggers = await client.query(`
        SELECT trigger_name
        FROM information_schema.triggers
        WHERE event_object_table = 'user_fcm_tokens';
      `);
      
      console.log(`⚙️  عدد الـ Triggers: ${triggers.rows.length}\n`);
      
    } else {
      console.log('❌ Migration فشل! الجدول غير موجود.');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ خطأ في Migration:', error.message);
    console.error('   Code:', error.code);
    if (error.position) {
      console.error('   Position:', error.position);
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration();

