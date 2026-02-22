// ============================================================================
// Safe Migration Script - إنشاء الجداول الجديدة مع الحفاظ على البيانات القديمة
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

async function migrateSafe() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 بدء عملية الهجرة الآمنة...');
    await client.query('BEGIN');
    
    // 1. إنشاء Extensions
    console.log('📦 إنشاء Extensions...');
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    
    // 2. إنشاء الجداول الجديدة فقط (إذا لم تكن موجودة)
    console.log('📦 إنشاء الجداول الجديدة...');
    
    // جدول app_users
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
    
    // إضافة الأعمدة المفقودة إذا كانت موجودة
    await client.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_users' AND column_name='user_uuid') THEN
          ALTER TABLE app_users ADD COLUMN user_uuid UUID UNIQUE DEFAULT uuid_generate_v4();
        END IF;
      END $$;
    `).catch(() => {});
    
    // جدول business_clients
    await client.query(`
      CREATE TABLE IF NOT EXISTS business_clients (
        client_id BIGSERIAL PRIMARY KEY,
        client_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
        cloud_id VARCHAR(128),
        firestore_id VARCHAR(128),
        owner_user_id BIGINT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
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
    
    // جدول cash_accounts - تحديث الجدول الموجود
    await client.query(`
      DO $$ 
      BEGIN
        -- إضافة account_uuid إذا لم يكن موجوداً
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='account_uuid') THEN
          ALTER TABLE cash_accounts ADD COLUMN account_uuid UUID UNIQUE DEFAULT uuid_generate_v4();
        END IF;
        
        -- السماح بأن يكون owner_user_id فارغاً (للحسابات المشتركة العالمية)
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='cash_accounts' AND column_name='owner_user_id' AND is_nullable='NO'
        ) THEN
          ALTER TABLE cash_accounts ALTER COLUMN owner_user_id DROP NOT NULL;
        END IF;
        
        -- إعادة تسمية الأعمدة إذا لزم الأمر
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='name') 
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='account_name') THEN
          ALTER TABLE cash_accounts RENAME COLUMN name TO account_name;
        END IF;
        
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='color') 
           AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cash_accounts' AND column_name='color_code') THEN
          ALTER TABLE cash_accounts RENAME COLUMN color TO color_code;
        END IF;
      END $$;
    `);

    // جدول user_account_links
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
    
    // جدول financial_transactions
    await client.query(`
      CREATE TABLE IF NOT EXISTS financial_transactions (
        transaction_id BIGSERIAL PRIMARY KEY,
        transaction_uuid UUID UNIQUE DEFAULT uuid_generate_v4(),
        cloud_id VARCHAR(128),
        firestore_id VARCHAR(128),
        owner_user_id BIGINT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
        owner_firebase_uid VARCHAR(128),
        client_id BIGINT REFERENCES business_clients(client_id) ON DELETE SET NULL,
        account_id BIGINT NOT NULL REFERENCES cash_accounts(account_id) ON DELETE RESTRICT,
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

    // جداول إعدادات النظام و WhatsApp
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

    // جداول سياسة الخصوصية
    await client.query(`
      CREATE TABLE IF NOT EXISTS privacy_policies (
        policy_id BIGSERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL DEFAULT 'سياسة الخصوصية',
        version INTEGER NOT NULL DEFAULT 1,
        app_version VARCHAR(32),
        is_active BOOLEAN DEFAULT FALSE,
        published_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    await client.query(`
      ALTER TABLE privacy_policies
      ADD COLUMN IF NOT EXISTS app_version VARCHAR(32)
    `).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS privacy_policy_items (
        item_id BIGSERIAL PRIMARY KEY,
        policy_id BIGINT NOT NULL REFERENCES privacy_policies(policy_id) ON DELETE CASCADE,
        item_order INTEGER DEFAULT 0,
        item_text TEXT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS privacy_policy_acceptances (
        acceptance_id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
        policy_id BIGINT NOT NULL REFERENCES privacy_policies(policy_id) ON DELETE CASCADE,
        accepted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
        ip_address INET,
        user_agent TEXT,
        device_id VARCHAR(128)
      )
    `);
    
    // إنشاء الفهارس
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
      'CREATE INDEX IF NOT EXISTS idx_whatsapp_transaction_status_transaction_id ON whatsapp_transaction_status(transaction_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_privacy_policies_version ON privacy_policies(version)',
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_privacy_policies_active ON privacy_policies(is_active) WHERE is_active = TRUE',
      'CREATE INDEX IF NOT EXISTS idx_privacy_policies_active ON privacy_policies(is_active)',
      'CREATE INDEX IF NOT EXISTS idx_privacy_policy_items_policy ON privacy_policy_items(policy_id)',
      'CREATE INDEX IF NOT EXISTS idx_privacy_policy_items_active ON privacy_policy_items(policy_id, is_active)',
      'CREATE UNIQUE INDEX IF NOT EXISTS ux_privacy_policy_acceptances_user_policy ON privacy_policy_acceptances(user_id, policy_id)',
      'CREATE INDEX IF NOT EXISTS idx_privacy_policy_acceptances_policy ON privacy_policy_acceptances(policy_id)'
    ];
    
    for (const indexSQL of indexes) {
      await client.query(indexSQL).catch(err => {
        console.log(`   ⚠️  فهرس موجود بالفعل أو خطأ: ${err.message.split('\n')[0]}`);
      });
    }
    
    // إنشاء Triggers
    console.log('📦 إنشاء Triggers...');
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
      DROP TRIGGER IF EXISTS update_app_users_updated_at ON app_users;
      CREATE TRIGGER update_app_users_updated_at BEFORE UPDATE ON app_users
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `).catch(() => {});

    await client.query(`
      DROP TRIGGER IF EXISTS update_user_account_links_updated_at ON user_account_links;
      CREATE TRIGGER update_user_account_links_updated_at BEFORE UPDATE ON user_account_links
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `).catch(() => {});

    await client.query(`
      DROP TRIGGER IF EXISTS update_privacy_policies_updated_at ON privacy_policies;
      CREATE TRIGGER update_privacy_policies_updated_at BEFORE UPDATE ON privacy_policies
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `).catch(() => {});

    await client.query(`
      DROP TRIGGER IF EXISTS update_privacy_policy_items_updated_at ON privacy_policy_items;
      CREATE TRIGGER update_privacy_policy_items_updated_at BEFORE UPDATE ON privacy_policy_items
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `).catch(() => {});
    
    await client.query('COMMIT');
    console.log('✅ تم إنشاء الجداول الجديدة بنجاح!');
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ خطأ في عملية الهجرة:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

migrateSafe()
  .then(() => {
    console.log('✅ اكتملت عملية الهجرة بنجاح');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ فشلت عملية الهجرة:', error);
    process.exit(1);
  });

