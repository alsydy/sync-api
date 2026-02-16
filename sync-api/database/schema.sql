-- ============================================================================
-- MalyMax Professional Database Schema - PostgreSQL
-- ============================================================================
-- نظام قاعدة بيانات احترافي ومحسّن للأداء والأمان
-- يدعم المزامنة المتقدمة والعمل أونلاين وأوفلاين
-- ============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. جدول المستخدمين (app_users)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_users (
    user_id BIGSERIAL PRIMARY KEY,
    user_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
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
);

-- Indexes for app_users
CREATE INDEX IF NOT EXISTS idx_app_users_firebase_uid ON app_users(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_users_phone_number ON app_users(phone_number);
CREATE INDEX IF NOT EXISTS idx_app_users_user_uuid ON app_users(user_uuid);
CREATE INDEX IF NOT EXISTS idx_app_users_account_number ON app_users(account_number);
CREATE INDEX IF NOT EXISTS idx_app_users_created_at ON app_users(created_at);
CREATE INDEX IF NOT EXISTS idx_app_users_active ON app_users(is_active) WHERE is_active = TRUE;

-- ============================================================================
-- 2. جدول العملاء (business_clients)
-- ============================================================================
CREATE TABLE IF NOT EXISTS business_clients (
    client_id BIGSERIAL PRIMARY KEY,
    client_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
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
);

-- Indexes for business_clients
CREATE INDEX IF NOT EXISTS idx_business_clients_owner_user_id ON business_clients(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_business_clients_owner_firebase_uid ON business_clients(owner_firebase_uid) WHERE owner_firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_clients_client_uuid ON business_clients(client_uuid);
CREATE INDEX IF NOT EXISTS idx_business_clients_firestore_id ON business_clients(firestore_id) WHERE firestore_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_clients_phone_number ON business_clients(phone_number) WHERE phone_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_clients_device_id ON business_clients(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_clients_archived ON business_clients(is_archived) WHERE is_archived = FALSE;
CREATE INDEX IF NOT EXISTS idx_business_clients_created_at ON business_clients(created_at);

-- ============================================================================
-- 3. جدول الحسابات النقدية (cash_accounts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS cash_accounts (
    account_id BIGSERIAL PRIMARY KEY,
    account_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    cloud_id VARCHAR(128),
    firestore_id VARCHAR(128),
    owner_user_id BIGINT REFERENCES app_users(user_id) ON DELETE CASCADE,
    owner_firebase_uid VARCHAR(128),
    account_name VARCHAR(255) NOT NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    is_shared BOOLEAN DEFAULT FALSE,
    template_key VARCHAR(32),
    color_code VARCHAR(7),
    device_id VARCHAR(128),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    sync_version INTEGER DEFAULT 1 NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for cash_accounts
CREATE INDEX IF NOT EXISTS idx_cash_accounts_owner_user_id ON cash_accounts(owner_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_accounts_user_template
ON cash_accounts(owner_user_id, template_key)
WHERE template_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_accounts_owner_firebase_uid ON cash_accounts(owner_firebase_uid) WHERE owner_firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_accounts_account_uuid ON cash_accounts(account_uuid);
CREATE INDEX IF NOT EXISTS idx_cash_accounts_firestore_id ON cash_accounts(firestore_id) WHERE firestore_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_accounts_primary ON cash_accounts(is_primary) WHERE is_primary = TRUE;
CREATE INDEX IF NOT EXISTS idx_cash_accounts_device_id ON cash_accounts(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cash_accounts_created_at ON cash_accounts(created_at);

-- ============================================================================
-- 4. جدول روابط المستخدمين بالصناديق (user_account_links)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_account_links (
    link_id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
    user_firebase_uid VARCHAR(128),
    account_firestore_id VARCHAR(128) NOT NULL,
    is_hidden BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for user_account_links
CREATE INDEX IF NOT EXISTS idx_user_account_links_user_id ON user_account_links(user_id);
CREATE INDEX IF NOT EXISTS idx_user_account_links_account_firestore_id ON user_account_links(account_firestore_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_account_links_user_account ON user_account_links(user_id, account_firestore_id);

-- ============================================================================
-- 5. جدول المعاملات المالية (financial_transactions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS financial_transactions (
    transaction_id BIGSERIAL PRIMARY KEY,
    transaction_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
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
);

-- Indexes for financial_transactions
CREATE INDEX IF NOT EXISTS idx_financial_transactions_owner_user_id ON financial_transactions(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_owner_firebase_uid ON financial_transactions(owner_firebase_uid) WHERE owner_firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_client_id ON financial_transactions(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_account_id ON financial_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_transaction_uuid ON financial_transactions(transaction_uuid);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_firestore_id ON financial_transactions(firestore_id) WHERE firestore_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_client_firestore_id ON financial_transactions(client_firestore_id) WHERE client_firestore_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_account_firestore_id ON financial_transactions(account_firestore_id) WHERE account_firestore_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_transaction_date ON financial_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_direction ON financial_transactions(transaction_direction);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_synced ON financial_transactions(is_synced) WHERE is_synced = FALSE;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_device_id ON financial_transactions(device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_financial_transactions_created_at ON financial_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_financial_transactions_deleted_at ON financial_transactions(deleted_at) WHERE deleted_at IS NULL;

-- ============================================================================
-- 5. جدول إعدادات النظام (system_settings)
-- ============================================================================
CREATE TABLE IF NOT EXISTS system_settings (
    setting_key VARCHAR(128) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_system_settings_key ON system_settings(setting_key);

-- ============================================================================
-- 6. جدول جلسات WhatsApp (whatsapp_sessions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    session_id VARCHAR(128) PRIMARY KEY,
    data TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_updated_at ON whatsapp_sessions(updated_at);

-- ============================================================================
-- 7. جدول حالة إشعارات WhatsApp للمعاملات (whatsapp_transaction_status)
-- ============================================================================
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
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_transaction_status_sent ON whatsapp_transaction_status(whatsapp_sent) WHERE whatsapp_sent = FALSE;
CREATE INDEX IF NOT EXISTS idx_whatsapp_transaction_status_error ON whatsapp_transaction_status(whatsapp_error_at) WHERE whatsapp_error_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_whatsapp_transaction_status_transaction_id ON whatsapp_transaction_status(transaction_id);

-- ============================================================================
-- 8. جدول الإشعارات (system_notifications)
-- ============================================================================
CREATE TABLE IF NOT EXISTS system_notifications (
    notification_id BIGSERIAL PRIMARY KEY,
    notification_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    notification_title VARCHAR(255) NOT NULL,
    notification_body TEXT NOT NULL,
    route_path VARCHAR(255),
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    read_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for system_notifications
CREATE INDEX IF NOT EXISTS idx_system_notifications_is_read ON system_notifications(is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_system_notifications_created_at ON system_notifications(created_at);
CREATE INDEX IF NOT EXISTS idx_system_notifications_uuid ON system_notifications(notification_uuid);

-- ============================================================================
-- 9. جدول أرقام الحسابات (account_numbers_registry)
-- ============================================================================
CREATE TABLE IF NOT EXISTS account_numbers_registry (
    registry_id BIGSERIAL PRIMARY KEY,
    account_number INTEGER UNIQUE NOT NULL,
    user_id BIGINT REFERENCES app_users(user_id) ON DELETE CASCADE,
    user_name VARCHAR(255),
    phone_number VARCHAR(20),
    firebase_uid VARCHAR(128),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for account_numbers_registry
CREATE INDEX IF NOT EXISTS idx_account_numbers_registry_account_number ON account_numbers_registry(account_number);
CREATE INDEX IF NOT EXISTS idx_account_numbers_registry_user_id ON account_numbers_registry(user_id);
CREATE INDEX IF NOT EXISTS idx_account_numbers_registry_active ON account_numbers_registry(is_active) WHERE is_active = TRUE;

-- ============================================================================
-- 10. جدول العمليات الفاشلة (sync_failed_operations)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sync_failed_operations (
    operation_id BIGSERIAL PRIMARY KEY,
    operation_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    operation_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(128),
    payload_data JSONB NOT NULL,
    error_message TEXT,
    error_type VARCHAR(100),
    attempt_count INTEGER DEFAULT 1,
    max_attempts INTEGER DEFAULT 3,
    priority_level INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    last_attempt_at TIMESTAMP WITH TIME ZONE,
    next_retry_at TIMESTAMP WITH TIME ZONE,
    operation_status VARCHAR(20) DEFAULT 'pending' CHECK (operation_status IN ('pending', 'processing', 'completed', 'failed'))
);

-- Indexes for sync_failed_operations
CREATE INDEX IF NOT EXISTS idx_sync_failed_operations_status ON sync_failed_operations(operation_status) WHERE operation_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sync_failed_operations_next_retry_at ON sync_failed_operations(next_retry_at) WHERE operation_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sync_failed_operations_entity_type ON sync_failed_operations(entity_type);
CREATE INDEX IF NOT EXISTS idx_sync_failed_operations_created_at ON sync_failed_operations(created_at);

-- ============================================================================
-- 11. جدول سجل العمليات (audit_log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
    log_id BIGSERIAL PRIMARY KEY,
    log_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    user_id BIGINT REFERENCES app_users(user_id) ON DELETE SET NULL,
    firebase_uid VARCHAR(128),
    action_type VARCHAR(50) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id VARCHAR(128),
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for audit_log
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_firebase_uid ON audit_log(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_action_type ON audit_log(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_type ON audit_log(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- ============================================================================
-- 12. جدول جلسات المزامنة (sync_sessions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sync_sessions (
    session_id BIGSERIAL PRIMARY KEY,
    session_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    user_id BIGINT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
    device_id VARCHAR(128) NOT NULL,
    sync_type VARCHAR(20) NOT NULL CHECK (sync_type IN ('full', 'incremental', 'upload', 'download')),
    sync_status VARCHAR(20) DEFAULT 'pending' CHECK (sync_status IN ('pending', 'in_progress', 'completed', 'failed')),
    items_uploaded INTEGER DEFAULT 0,
    items_downloaded INTEGER DEFAULT 0,
    items_failed INTEGER DEFAULT 0,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    metadata JSONB
);

-- Indexes for sync_sessions
CREATE INDEX IF NOT EXISTS idx_sync_sessions_user_id ON sync_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_device_id ON sync_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_status ON sync_sessions(sync_status);
CREATE INDEX IF NOT EXISTS idx_sync_sessions_started_at ON sync_sessions(started_at);

-- ============================================================================
-- 13. جدول إعدادات المزامنة (sync_settings)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sync_settings (
    setting_id BIGSERIAL PRIMARY KEY,
    user_id BIGINT UNIQUE REFERENCES app_users(user_id) ON DELETE CASCADE,
    firebase_uid VARCHAR(128) UNIQUE,
    auto_sync_enabled BOOLEAN DEFAULT TRUE,
    sync_on_wifi_only BOOLEAN DEFAULT FALSE,
    sync_interval_minutes INTEGER DEFAULT 15,
    max_retry_attempts INTEGER DEFAULT 3,
    conflict_resolution_strategy VARCHAR(20) DEFAULT 'last_write_wins' CHECK (conflict_resolution_strategy IN ('last_write_wins', 'server_wins', 'client_wins')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for sync_settings
CREATE INDEX IF NOT EXISTS idx_sync_settings_user_id ON sync_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_settings_firebase_uid ON sync_settings(firebase_uid) WHERE firebase_uid IS NOT NULL;

-- ============================================================================
-- 14. جدول الاشتراكات (subscriptions)
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscriptions (
    subscription_id BIGSERIAL PRIMARY KEY,
    subscription_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    user_id BIGINT REFERENCES app_users(user_id) ON DELETE CASCADE,
    firebase_uid VARCHAR(128),
    user_doc_id VARCHAR(128), -- للتوافق مع Firestore
    user_phone VARCHAR(20),
    package_id VARCHAR(255),
    status VARCHAR(50) NOT NULL CHECK (status IN ('active', 'pending', 'expired', 'cancelled')),
    start_at TIMESTAMP WITH TIME ZONE NOT NULL,
    end_at TIMESTAMP WITH TIME ZONE NOT NULL,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for subscriptions
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_firebase_uid ON subscriptions(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_doc_id ON subscriptions(user_doc_id) WHERE user_doc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_phone ON subscriptions(user_phone) WHERE user_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_end_at ON subscriptions(end_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(status, end_at) WHERE status IN ('active', 'pending');

-- ============================================================================
-- 15. جدول باقات الاشتراك (subscription_packages)
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscription_packages (
    package_id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    duration_days INTEGER NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    currency_code VARCHAR(10) DEFAULT 'YER',
    features JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for subscription_packages
CREATE INDEX IF NOT EXISTS idx_subscription_packages_active ON subscription_packages(is_active) WHERE is_active = TRUE;

-- ============================================================================
-- 15.5. جدول طلبات الاشتراك (subscription_requests)
-- ============================================================================
CREATE TABLE IF NOT EXISTS subscription_requests (
    request_id BIGSERIAL PRIMARY KEY,
    request_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    user_id BIGINT REFERENCES app_users(user_id) ON DELETE CASCADE,
    firebase_uid VARCHAR(128),
    user_doc_id VARCHAR(128),
    user_phone VARCHAR(20),
    user_name VARCHAR(255),
    package_id VARCHAR(255) NOT NULL REFERENCES subscription_packages(package_id),
    package_name VARCHAR(255),
    package_duration_days INTEGER,
    package_price DECIMAL(10, 2),
    package_currency VARCHAR(10),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    notes TEXT,
    admin_notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE,
    processed_by VARCHAR(255)
);

-- Indexes for subscription_requests
CREATE INDEX IF NOT EXISTS idx_subscription_requests_user_id ON subscription_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_firebase_uid ON subscription_requests(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_requests_user_doc_id ON subscription_requests(user_doc_id) WHERE user_doc_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_subscription_requests_status ON subscription_requests(status);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_created_at ON subscription_requests(created_at);

-- ============================================================================
-- 16. جدول الإعدادات المشتركة (app_shared_settings)
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_shared_settings (
    setting_id BIGSERIAL PRIMARY KEY,
    setting_key VARCHAR(255) UNIQUE NOT NULL,
    setting_value TEXT,
    setting_type VARCHAR(50) DEFAULT 'string',
    category VARCHAR(100) DEFAULT 'general',
    description TEXT,
    updated_by VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for app_shared_settings
CREATE INDEX IF NOT EXISTS idx_app_shared_settings_key ON app_shared_settings(setting_key);
CREATE INDEX IF NOT EXISTS idx_app_shared_settings_category ON app_shared_settings(category);

-- ============================================================================
-- 17. جدول إعدادات التحكم في المستخدمين (user_control_settings)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_control_settings (
    setting_id BIGSERIAL PRIMARY KEY,
    firebase_uid VARCHAR(128) UNIQUE NOT NULL,
    sync_enabled BOOLEAN DEFAULT TRUE,
    updated_by VARCHAR(255),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Indexes for user_control_settings
CREATE INDEX IF NOT EXISTS idx_user_control_settings_firebase_uid ON user_control_settings(firebase_uid);

-- ============================================================================
-- Functions and Triggers
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_app_users_updated_at BEFORE UPDATE ON app_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_business_clients_updated_at BEFORE UPDATE ON business_clients
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_cash_accounts_updated_at BEFORE UPDATE ON cash_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_account_links_updated_at BEFORE UPDATE ON user_account_links
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_financial_transactions_updated_at BEFORE UPDATE ON financial_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_whatsapp_sessions_updated_at BEFORE UPDATE ON whatsapp_sessions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_whatsapp_transaction_status_updated_at BEFORE UPDATE ON whatsapp_transaction_status
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_sync_settings_updated_at BEFORE UPDATE ON sync_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscriptions_updated_at BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscription_packages_updated_at BEFORE UPDATE ON subscription_packages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_subscription_requests_updated_at BEFORE UPDATE ON subscription_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_app_shared_settings_updated_at BEFORE UPDATE ON app_shared_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_control_settings_updated_at BEFORE UPDATE ON user_control_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to increment sync_version
CREATE OR REPLACE FUNCTION increment_sync_version()
RETURNS TRIGGER AS $$
BEGIN
    NEW.sync_version = COALESCE(OLD.sync_version, 0) + 1;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for sync_version (only on UPDATE)
CREATE TRIGGER increment_app_users_sync_version BEFORE UPDATE ON app_users
    FOR EACH ROW EXECUTE FUNCTION increment_sync_version();

CREATE TRIGGER increment_business_clients_sync_version BEFORE UPDATE ON business_clients
    FOR EACH ROW EXECUTE FUNCTION increment_sync_version();

CREATE TRIGGER increment_cash_accounts_sync_version BEFORE UPDATE ON cash_accounts
    FOR EACH ROW EXECUTE FUNCTION increment_sync_version();

CREATE TRIGGER increment_financial_transactions_sync_version BEFORE UPDATE ON financial_transactions
    FOR EACH ROW EXECUTE FUNCTION increment_sync_version();

-- ============================================================================
-- Views for easier querying
-- ============================================================================

-- View for active users
CREATE OR REPLACE VIEW vw_active_users AS
SELECT 
    user_id,
    user_uuid,
    firebase_uid,
    full_name,
    phone_number,
    account_number,
    is_active,
    created_at
FROM app_users
WHERE deleted_at IS NULL AND is_active = TRUE;

-- View for active clients
CREATE OR REPLACE VIEW vw_active_clients AS
SELECT 
    client_id,
    client_uuid,
    owner_user_id,
    client_name,
    phone_number,
    cached_total_balance,
    created_at
FROM business_clients
WHERE deleted_at IS NULL AND is_archived = FALSE;

-- View for pending sync operations
CREATE OR REPLACE VIEW vw_pending_sync_operations AS
SELECT 
    operation_id,
    operation_type,
    entity_type,
    entity_id,
    attempt_count,
    next_retry_at,
    priority_level
FROM sync_failed_operations
WHERE operation_status = 'pending' AND next_retry_at <= CURRENT_TIMESTAMP
ORDER BY priority_level DESC, created_at ASC;

-- ============================================================================
-- Comments for documentation
-- ============================================================================

COMMENT ON TABLE app_users IS 'جدول المستخدمين الرئيسي - يحتوي على معلومات المستخدمين والجهاز';
COMMENT ON TABLE business_clients IS 'جدول العملاء - يحتوي على معلومات العملاء والديون';
COMMENT ON TABLE cash_accounts IS 'جدول الحسابات النقدية - يحتوي على حسابات المستخدمين';
COMMENT ON TABLE financial_transactions IS 'جدول المعاملات المالية - يحتوي على جميع المعاملات';
COMMENT ON TABLE system_notifications IS 'جدول الإشعارات - يحتوي على إشعارات النظام';
COMMENT ON TABLE account_numbers_registry IS 'سجل أرقام الحسابات الفريدة';
COMMENT ON TABLE sync_failed_operations IS 'جدول العمليات الفاشلة - للمعالجة لاحقاً';
COMMENT ON TABLE audit_log IS 'سجل العمليات - لتتبع جميع العمليات المهمة';
COMMENT ON TABLE sync_sessions IS 'جلسات المزامنة - لتتبع عمليات المزامنة';
COMMENT ON TABLE sync_settings IS 'إعدادات المزامنة لكل مستخدم';

-- ============================================================================
-- End of Schema
-- ============================================================================
