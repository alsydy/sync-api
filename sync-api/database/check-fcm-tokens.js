// ============================================================================
// Script للتحقق من وجود جدول user_fcm_tokens
// ============================================================================

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 7754,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function checkFcmTokensTable() {
  try {
    console.log('🔍 التحقق من وجود جدول user_fcm_tokens...\n');
    console.log(`📡 الاتصال بقاعدة البيانات: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 7754}/${process.env.DB_NAME || 'malymax_prod'}\n`);

    // 1. التحقق من وجود الجدول
    const tableExists = await pool.query(`
      SELECT EXISTS (
         SELECT FROM information_schema.tables 
         WHERE table_schema = 'public' 
         AND table_name = 'user_fcm_tokens'
      ) as table_exists;
    `);

    const exists = tableExists.rows[0].table_exists;
    
    if (!exists) {
      console.log('❌ الجدول user_fcm_tokens غير موجود!');
      console.log('📝 يجب تشغيل migration script أولاً:');
      console.log('   psql -U postgres -h localhost -p 7754 -d malymax_prod -f database/migration_user_fcm_tokens.sql\n');
      await pool.end();
      process.exit(1);
    }

    console.log('✅ الجدول user_fcm_tokens موجود\n');

    // 2. عرض بنية الجدول
    console.log('📋 بنية الجدول:');
    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'user_fcm_tokens'
      ORDER BY ordinal_position;
    `);

    console.table(columns.rows.map(col => ({
      Column: col.column_name,
      Type: col.data_type,
      Nullable: col.is_nullable,
      Default: col.column_default || 'N/A'
    })));

    // 3. عرض الـ Indexes
    console.log('\n📊 Indexes:');
    const indexes = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'user_fcm_tokens';
    `);

    if (indexes.rows.length > 0) {
      indexes.rows.forEach(idx => {
        console.log(`   ✅ ${idx.indexname}`);
      });
    } else {
      console.log('   ⚠️ لا توجد indexes');
    }

    // 4. عرض الـ Triggers
    console.log('\n⚙️ Triggers:');
    const triggers = await pool.query(`
      SELECT trigger_name, event_manipulation, action_statement
      FROM information_schema.triggers
      WHERE event_object_table = 'user_fcm_tokens';
    `);

    if (triggers.rows.length > 0) {
      triggers.rows.forEach(trg => {
        console.log(`   ✅ ${trg.trigger_name} (${trg.event_manipulation})`);
      });
    } else {
      console.log('   ⚠️ لا توجد triggers');
    }

    // 5. عرض عدد السجلات
    console.log('\n📈 إحصائيات:');
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_tokens,
        COUNT(*) FILTER (WHERE is_active = TRUE) as active_tokens,
        COUNT(*) FILTER (WHERE is_primary = TRUE) as primary_tokens,
        COUNT(DISTINCT user_id) as unique_users
      FROM user_fcm_tokens;
    `);

    const stat = stats.rows[0];
    console.log(`   إجمالي التوكنات: ${stat.total_tokens}`);
    console.log(`   التوكنات النشطة: ${stat.active_tokens}`);
    console.log(`   التوكنات الأساسية: ${stat.primary_tokens}`);
    console.log(`   عدد المستخدمين: ${stat.unique_users}`);

    // 6. عرض آخر 5 توكنات مسجلة
    console.log('\n📝 آخر 5 توكنات مسجلة:');
    const recentTokens = await pool.query(`
      SELECT 
        token_id,
        firebase_uid,
        LEFT(token, 20) || '...' as token_preview,
        device_model,
        device_brand,
        is_active,
        is_primary,
        created_at
      FROM user_fcm_tokens
      ORDER BY created_at DESC
      LIMIT 5;
    `);

    if (recentTokens.rows.length > 0) {
      console.table(recentTokens.rows.map(t => ({
        ID: t.token_id,
        FirebaseUID: t.firebase_uid?.substring(0, 20) + '...',
        Token: t.token_preview,
        Device: `${t.device_brand || 'N/A'} ${t.device_model || 'N/A'}`,
        Active: t.is_active ? '✅' : '❌',
        Primary: t.is_primary ? '⭐' : '',
        Created: new Date(t.created_at).toLocaleString('ar-SA')
      })));
    } else {
      console.log('   لا توجد توكنات مسجلة بعد');
    }

    console.log('\n✅ التحقق اكتمل بنجاح!');
    await pool.end();
    process.exit(0);

  } catch (error) {
    console.error('❌ خطأ في التحقق:', error.message);
    if (error.code === '42P01') {
      console.error('   الجدول غير موجود! يجب تشغيل migration script.');
    }
    await pool.end();
    process.exit(1);
  }
}

checkFcmTokensTable();

