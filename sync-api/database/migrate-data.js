// ============================================================================
// Migration Script - نقل البيانات من الجداول القديمة إلى الجديدة
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

async function migrateData() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 بدء نقل البيانات...');
    await client.query('BEGIN');
    
    // 1. نقل بيانات المستخدمين
    console.log('📦 نقل بيانات المستخدمين...');
    await client.query(`
      INSERT INTO app_users (
        user_id, user_uuid, firebase_uid, full_name, phone_number, 
        job_title, password_hash, password_salt, account_number,
        receive_transaction_notifications, app_version_name, app_version_code,
        device_model, device_brand, device_manufacturer, device_sdk_int,
        push_token, created_at, sync_version
      )
      SELECT 
        id, 
        COALESCE(entry_id::uuid, uuid_generate_v4()),
        firebase_uid, 
        name, 
        phone,
        job_title, 
        password_hash, 
        password_salt, 
        account_number,
        receive_transaction_notifications,
        app_version_name,
        app_version_code,
        device_model,
        device_brand,
        device_manufacturer,
        device_sdk_int,
        account_push_token,
        CASE 
          WHEN created_at IS NULL THEN CURRENT_TIMESTAMP
          WHEN created_at::text ~ '^[0-9]+$' AND created_at::bigint > 1000000000000 THEN to_timestamp(created_at::bigint / 1000)
          WHEN created_at::text ~ '^[0-9]+$' THEN to_timestamp(created_at::bigint)
          ELSE created_at::timestamp with time zone
        END,
        COALESCE(sync_version, 1)
      FROM users
      WHERE NOT EXISTS (
        SELECT 1 FROM app_users WHERE app_users.user_id = users.id
      )
      ON CONFLICT (user_id) DO NOTHING
    `);
    
    // 2. نقل بيانات العملاء
    console.log('📦 نقل بيانات العملاء...');
    await client.query(`
      INSERT INTO business_clients (
        client_id, client_uuid, cloud_id, firestore_id, owner_user_id,
        owner_firebase_uid, client_name, phone_number, job_title, notes,
        is_archived, device_id, sync_version, created_at, updated_at, cached_total_balance
      )
      SELECT 
        id,
        COALESCE(entry_id::uuid, uuid_generate_v4()),
        cloud_id, 
        firestore_id, 
        owner_user_id,
        owner_firebase_uid, 
        name, 
        phone, 
        job_title, 
        notes,
        archived, 
        device_id, 
        COALESCE(sync_version, 1),
        CASE 
          WHEN created_at IS NULL THEN CURRENT_TIMESTAMP
          WHEN created_at::text ~ '^[0-9]+$' AND created_at::bigint > 1000000000000 THEN to_timestamp(created_at::bigint / 1000)
          WHEN created_at::text ~ '^[0-9]+$' THEN to_timestamp(created_at::bigint)
          ELSE created_at::timestamp with time zone
        END, 
        CASE 
          WHEN COALESCE(updated_at, created_at) IS NULL THEN CURRENT_TIMESTAMP
          WHEN COALESCE(updated_at, created_at)::text ~ '^[0-9]+$' AND COALESCE(updated_at, created_at)::bigint > 1000000000000 THEN to_timestamp(COALESCE(updated_at, created_at)::bigint / 1000)
          WHEN COALESCE(updated_at, created_at)::text ~ '^[0-9]+$' THEN to_timestamp(COALESCE(updated_at, created_at)::bigint)
          ELSE COALESCE(updated_at, created_at)::timestamp with time zone
        END, 
        COALESCE(cached_total_balance, 0)
      FROM customers
      WHERE NOT EXISTS (
        SELECT 1 FROM business_clients WHERE business_clients.client_id = customers.id
      )
      ON CONFLICT (client_id) DO NOTHING
    `);
    
    // 3. نقل بيانات الحسابات (إذا كان الجدول القديم موجود)
    console.log('📦 نقل بيانات الحسابات...');
    await client.query(`
      INSERT INTO cash_accounts (
        account_id, account_uuid, cloud_id, firestore_id, owner_user_id,
        owner_firebase_uid, account_name, is_primary, is_shared, color_code,
        device_id, sync_version, created_at, updated_at
      )
      SELECT 
        id,
        COALESCE(entry_id::uuid, uuid_generate_v4()),
        cloud_id, 
        firestore_id, 
        owner_user_id,
        owner_firebase_uid, 
        name, 
        is_primary, 
        is_shared, 
        color,
        device_id, 
        COALESCE(sync_version, 1),
        CASE 
          WHEN created_at IS NULL THEN CURRENT_TIMESTAMP
          WHEN created_at::text ~ '^[0-9]+$' AND created_at::bigint > 1000000000000 THEN to_timestamp(created_at::bigint / 1000)
          WHEN created_at::text ~ '^[0-9]+$' THEN to_timestamp(created_at::bigint)
          ELSE created_at::timestamp with time zone
        END,
        to_timestamp(COALESCE(updated_at, created_at) / 1000)
      FROM cash_accounts
      WHERE NOT EXISTS (
        SELECT 1 FROM cash_accounts new WHERE new.account_id = cash_accounts.id AND new.account_uuid IS NOT NULL
      )
      AND account_uuid IS NULL
      ON CONFLICT (account_id) DO NOTHING
    `).catch(() => {
      console.log('   ⚠️  جدول cash_accounts موجود بالفعل أو لا يحتاج نقل');
    });
    
    // 4. نقل بيانات المعاملات
    console.log('📦 نقل بيانات المعاملات...');
    await client.query(`
      INSERT INTO financial_transactions (
        transaction_id, transaction_uuid, cloud_id, firestore_id, owner_user_id,
        owner_firebase_uid, client_id, account_id, client_firestore_id, account_firestore_id,
        transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
        notify_customer, is_synced, device_id, transaction_number, sync_version,
        created_at, updated_at
      )
      SELECT 
        id,
        COALESCE(entry_id::uuid, uuid_generate_v4()),
        cloud_id, 
        firestore_id, 
        owner_user_id,
        owner_firebase_uid, 
        customer_id, 
        account_id, 
        customer_firestore_id, 
        account_firestore_id,
        amount, 
        currency, 
        direction, 
        note, 
        to_timestamp(transaction_date / 1000),
        notify_customer, 
        synced, 
        device_id, 
        transaction_number, 
        COALESCE(sync_version, 1),
        CASE 
          WHEN created_at IS NULL THEN CURRENT_TIMESTAMP
          WHEN created_at::text ~ '^[0-9]+$' AND created_at::bigint > 1000000000000 THEN to_timestamp(created_at::bigint / 1000)
          WHEN created_at::text ~ '^[0-9]+$' THEN to_timestamp(created_at::bigint)
          ELSE created_at::timestamp with time zone
        END,
        to_timestamp(COALESCE(updated_at, created_at) / 1000)
      FROM transactions
      WHERE deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM financial_transactions WHERE financial_transactions.transaction_id = transactions.id
      )
      ON CONFLICT (transaction_id) DO NOTHING
    `);
    
    // 5. نقل بيانات الإشعارات
    console.log('📦 نقل بيانات الإشعارات...');
    await client.query(`
      INSERT INTO system_notifications (
        notification_uuid, notification_title, notification_body, route_path, is_read, created_at
      )
      SELECT 
        uuid_generate_v4(),
        title, 
        body, 
        route, 
        is_read,
        to_timestamp(created_at / 1000)
      FROM notifications
      WHERE NOT EXISTS (
        SELECT 1 FROM system_notifications WHERE 
          system_notifications.notification_title = notifications.title AND
          system_notifications.notification_body = notifications.body
      )
      ON CONFLICT DO NOTHING
    `).catch(() => {
      console.log('   ⚠️  جدول notifications موجود بالفعل');
    });
    
    // 6. نقل بيانات أرقام الحسابات
    console.log('📦 نقل بيانات أرقام الحسابات...');
    await client.query(`
      INSERT INTO account_numbers_registry (
        account_number, user_id, user_name, phone_number, firebase_uid, is_active, created_at
      )
      SELECT 
        account_number,
        user_id,
        user_name,
        phone,
        firebase_uid,
        COALESCE(is_active, true),
        to_timestamp(created_at / 1000)
      FROM account_numbers
      WHERE NOT EXISTS (
        SELECT 1 FROM account_numbers_registry WHERE account_numbers_registry.account_number = account_numbers.account_number
      )
      ON CONFLICT (account_number) DO NOTHING
    `).catch(() => {
      console.log('   ⚠️  جدول account_numbers موجود بالفعل');
    });
    
    await client.query('COMMIT');
    console.log('✅ تم نقل البيانات بنجاح!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ خطأ في نقل البيانات:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateData()
  .then(() => {
    console.log('✅ اكتملت عملية نقل البيانات بنجاح');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ فشلت عملية نقل البيانات:', error);
    process.exit(1);
  });

