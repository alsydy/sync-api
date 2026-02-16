-- التحقق من وجود الجدول
SELECT EXISTS (
   SELECT FROM information_schema.tables 
   WHERE table_schema = 'public' 
   AND table_name = 'user_fcm_tokens'
) as table_exists;

-- عرض بنية الجدول إذا كان موجوداً
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'user_fcm_tokens'
ORDER BY ordinal_position;

-- عرض جميع الـ indexes
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'user_fcm_tokens';

-- عرض الـ triggers
SELECT trigger_name, event_manipulation, event_object_table, action_statement
FROM information_schema.triggers
WHERE event_object_table = 'user_fcm_tokens';

-- عرض عدد السجلات (إذا كان الجدول موجوداً)
SELECT COUNT(*) as total_tokens FROM user_fcm_tokens;

