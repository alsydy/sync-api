// ============================================================================
// Final Migration Script - تحديث الجداول الموجودة وإضافة الجداول الجديدة
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

async function migrateFinal() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 بدء عملية الهجرة النهائية...');
    await client.query('BEGIN');
    
    // 1. إنشاء Extensions
    console.log('📦 إنشاء Extensions...');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    
    // 2. تحديث جدول cash_accounts
    console.log('📦 تحديث جدول cash_accounts...');
    
    // إضافة account_id إذا لم يكن موجوداً (إعادة تسمية id)
    await client.query(`
      DO $$ 
      BEGIN
        -- إضافة account_uuid إذا لم يكن موجوداً
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='account_uuid') THEN
          ALTER TABLE cash_accounts ADD COLUMN account_uuid UUID UNIQUE DEFAULT uuid_generate_v4();
          -- تحديث القيم الموجودة
          UPDATE cash_accounts SET account_uuid = uuid_generate_v4() WHERE account_uuid IS NULL;
        END IF;

        -- السماح بأن يكون owner_user_id فارغاً (للحسابات المشتركة العالمية)
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='cash_accounts' AND column_name='owner_user_id' AND is_nullable='NO'
        ) THEN
          ALTER TABLE cash_accounts ALTER COLUMN owner_user_id DROP NOT NULL;
        END IF;
        
        -- إعادة تسمية name إلى account_name
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='name') 
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='account_name') THEN
          ALTER TABLE cash_accounts RENAME COLUMN name TO account_name;
        END IF;
        
        -- إعادة تسمية color إلى color_code
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='color') 
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='color_code') THEN
          ALTER TABLE cash_accounts RENAME COLUMN color TO color_code;
        END IF;
        
        -- إضافة account_id كاسم بديل (إذا لم يكن موجوداً)
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='account_id') THEN
          ALTER TABLE cash_accounts ADD COLUMN account_id BIGINT;
          UPDATE cash_accounts SET account_id = id;
          ALTER TABLE cash_accounts ALTER COLUMN account_id SET NOT NULL;
        END IF;
      END $$;
    `);

    // إنشاء جدول user_account_links
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_account_links (
        link_id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
        user_firebase_uid VARCHAR(128),
        account_firestore_id VARCHAR(128) NOT NULL,
        is_hidden BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);
    
    // 3. إنشاء جدول app_users (إذا لم يكن موجوداً)
    console.log('📦 إنشاء/تحديث جدول app_users...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        user_id BIGSERIAL PRIMARY KEY,
        user_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
        firebase_uid VARCHAR(128) UNIQUE,
        full_name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(20) UNIQUE NOT NULL,
        job_title VARCHAR(100),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        account_number INTEGER UNIQUE NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        receive_transaction_notifications BOOLEAN DEFAULT TRUE,
        app_version_name VARCHAR(50),
        app_version_code INTEGER,
        device_model VARCHAR(100),
        device_brand VARCHAR(50),
        device_manufacturer VARCHAR(50),
        device_sdk_int INTEGER,
        push_token TEXT,
        last_login_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        sync_version INTEGER DEFAULT 1 NOT NULL,
        deleted_at TIMESTAMP WITH TIME ZONE
      )
    `);
    
    // 4. إنشاء جدول business_clients (إذا لم يكن موجوداً)
    console.log('📦 إنشاء/تحديث جدول business_clients...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_clients (
        client_id BIGSERIAL PRIMARY KEY,
        client_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
        cloud_id VARCHAR(128),
        firestore_id VARCHAR(128),
        owner_user_id BIGINT NOT NULL,
        owner_firebase_uid VARCHAR(128),
        client_name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(20),
        job_title VARCHAR(100),
        notes TEXT,
        is_archived BOOLEAN DEFAULT FALSE,
        device_id VARCHAR(128),
        cached_total_balance DECIMAL(15, 2) DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        sync_version INTEGER DEFAULT 1 NOT NULL,
        deleted_at TIMESTAMP WITH TIME ZONE
      )
    `);
    
    // 5. إنشاء جدول financial_transactions (إذا لم يكن موجوداً)
    console.log('📦 إنشاء/تحديث جدول financial_transactions...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS financial_transactions (
        transaction_id BIGSERIAL PRIMARY KEY,
        transaction_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
        cloud_id VARCHAR(128),
        firestore_id VARCHAR(128),
        owner_user_id BIGINT NOT NULL,
        owner_firebase_uid VARCHAR(128),
        client_id BIGINT,
        account_id BIGINT NOT NULL,
        client_firestore_id VARCHAR(128),
        account_firestore_id VARCHAR(128),
        transaction_amount DECIMAL(15, 2) NOT NULL,
        currency_code VARCHAR(3) DEFAULT 'IQD',
        transaction_direction VARCHAR(10) NOT NULL CHECK (transaction_direction IN ('income', 'expense')),
        transaction_note TEXT,
        transaction_date TIMESTAMP WITH TIME ZONE NOT NULL,
        notify_customer BOOLEAN DEFAULT FALSE,
        is_synced BOOLEAN DEFAULT FALSE,
        device_id VARCHAR(128),
        transaction_number VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        sync_version INTEGER DEFAULT 1 NOT NULL,
        deleted_at TIMESTAMP WITH TIME ZONE
      )
    `);
    
    // 6. إنشاء الجداول الإضافية (إعدادات النظام + WhatsApp)
    console.log('📦 إنشاء جداول إعدادات النظام و WhatsApp...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        setting_key VARCHAR(128) PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        session_id VARCHAR(128) PRIMARY KEY,
        data TEXT,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_transaction_status (
        transaction_uuid UUID PRIMARY KEY,
        transaction_id BIGINT,
        whatsapp_sent BOOLEAN DEFAULT FALSE,
        whatsapp_sent_at TIMESTAMP WITH TIME ZONE,
        whatsapp_sent_to VARCHAR(32),
        whatsapp_message_id VARCHAR(128),
        whatsapp_error TEXT,
        whatsapp_error_at TIMESTAMP WITH TIME ZONE,
        whatsapp_cancelled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    // 7. إنشاء الفهارس
    console.log('📦 إنشاء الفهارس...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_app_users_firebase_uid ON app_users(firebase_uid) WHERE firebase_uid IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_app_users_phone_number ON app_users(phone_number)',
      'CREATE INDEX IF NOT EXISTS idx_app_users_user_uuid ON app_users(user_uuid)',
      'CREATE INDEX IF NOT EXISTS idx_business_clients_owner_user_id ON business_clients(owner_user_id)',
      'CREATE INDEX IF NOT EXISTS idx_business_clients_client_uuid ON business_clients(client_uuid)',
      'CREATE INDEX IF NOT EXISTS idx_cash_accounts_account_uuid ON cash_accounts(account_uuid) WHERE account_uuid IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_financial_transactions_transaction_uuid ON financial_transactions(transaction_uuid)',
      'CREATE INDEX IF NOT EXISTS idx_user_account_links_user_id ON user_account_links(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_user_account_links_account_firestore_id ON user_account_links(account_firestore_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_user_account_links_user_account ON user_account_links(user_id, account_firestore_id)',
      'CREATE INDEX IF NOT EXISTS idx_system_settings_key ON system_settings(setting_key)',
      'CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_updated_at ON whatsapp_sessions(updated_at)',
      'CREATE INDEX IF NOT EXISTS idx_whatsapp_transaction_status_sent ON whatsapp_transaction_status(whatsapp_sent) WHERE whatsapp_sent = FALSE',
      'CREATE INDEX IF NOT EXISTS idx_whatsapp_transaction_status_error ON whatsapp_transaction_status(whatsapp_error_at) WHERE whatsapp_error_at IS NULL',
      'CREATE INDEX IF NOT EXISTS idx_whatsapp_transaction_status_transaction_id ON whatsapp_transaction_status(transaction_id)'
    ];
    
    for (const indexSQL of indexes) {
      await client.query(indexSQL).catch(err => {
        console.log(`   ⚠️  ${err.message.split('\n')[0]}`);
      });
    }
    
    // 8. إنشاء Functions و Triggers
    console.log('📦 إنشاء Functions و Triggers...');
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);
    
    await client.query(`
      CREATE OR REPLACE FUNCTION increment_sync_version()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.sync_version = COALESCE(OLD.sync_version, 0) + 1;
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);
    
    await client.query('COMMIT');
    console.log('✅ تم إنشاء/تحديث الجداول بنجاح!');
    console.log('\n📊 الجداول المتاحة:');
    console.log('   - app_users (المستخدمين)');
    console.log('   - business_clients (العملاء)');
    console.log('   - cash_accounts (الحسابات - محدث)');
    console.log('   - financial_transactions (المعاملات المالية)');
    console.log('   - user_account_links (روابط المستخدمين بالصناديق)');
    console.log('   - system_settings (إعدادات النظام)');
    console.log('   - whatsapp_sessions (جلسات WhatsApp)');
    console.log('   - whatsapp_transaction_status (حالة إشعارات WhatsApp)');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ خطأ في عملية الهجرة:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateFinal()
  .then(() => {
    console.log('✅ اكتملت عملية الهجرة بنجاح');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ فشلت عملية الهجرة:', error);
    process.exit(1);
  });

