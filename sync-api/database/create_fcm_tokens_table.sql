-- ============================================================================
-- إنشاء جدول user_fcm_tokens
-- ============================================================================
-- يمكنك نسخ هذا الكود ولصقه في psql أو أي أداة إدارة PostgreSQL
-- ============================================================================

-- جدول FCM tokens للمستخدمين
CREATE TABLE IF NOT EXISTS user_fcm_tokens (
    token_id BIGSERIAL PRIMARY KEY,
    token_uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
    user_id BIGINT REFERENCES app_users(user_id) ON DELETE CASCADE,
    firebase_uid VARCHAR(128),
    token TEXT NOT NULL,
    device_model VARCHAR(100),
    device_brand VARCHAR(50),
    device_manufacturer VARCHAR(50),
    app_version_name VARCHAR(50),
    app_version_code INTEGER,
    is_active BOOLEAN DEFAULT TRUE,
    is_primary BOOLEAN DEFAULT FALSE,
    last_used_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT unique_user_token UNIQUE (user_id, token)
);

-- Indexes لتحسين الأداء
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_user_id ON user_fcm_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_firebase_uid ON user_fcm_tokens(firebase_uid) WHERE firebase_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_active ON user_fcm_tokens(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_primary ON user_fcm_tokens(is_primary) WHERE is_primary = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_fcm_tokens_token ON user_fcm_tokens(token);

-- Trigger لتحديث updated_at تلقائياً
-- ملاحظة: تأكد من وجود دالة update_updated_at_column() في قاعدة البيانات
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger 
        WHERE tgname = 'update_user_fcm_tokens_updated_at'
    ) THEN
        CREATE TRIGGER update_user_fcm_tokens_updated_at 
        BEFORE UPDATE ON user_fcm_tokens
        FOR EACH ROW 
        EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- التحقق من نجاح الإنشاء
SELECT 
    '✅ تم إنشاء جدول user_fcm_tokens بنجاح!' as status,
    COUNT(*) as column_count
FROM information_schema.columns 
WHERE table_name = 'user_fcm_tokens';

