-- ============================================================================
-- Migration: إضافة جدول subscription_requests
-- ============================================================================
-- تاريخ: 2026-01-21
-- الوصف: إضافة جدول طلبات الاشتراك
-- ============================================================================

-- جدول طلبات الاشتراك (subscription_requests)
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

-- Trigger for updated_at
CREATE TRIGGER update_subscription_requests_updated_at BEFORE UPDATE ON subscription_requests
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- End of Migration
-- ============================================================================

