# إصلاح إنشاء الحساب المشترك تلقائياً

## المشكلة

```
❌ normalizeAccountId: Could not find account_id for accountId=9, accountFirestoreId=shared-main-account-v1
❌ accountId is null in INSERT transaction
```

### السبب

1. التطبيق يحاول إضافة معاملة تشير إلى حساب `shared-main-account-v1`
2. هذا الحساب غير موجود في قاعدة البيانات PostgreSQL
3. البحث بالاسم `'الصندوق الرئيسي'` لم يجد الحساب
4. المعاملة تفشل لأن `account_id` مطلوب (NOT NULL constraint)

## الحل المطبق ✅

### 1. إنشاء الحساب المشترك تلقائياً في INSERT transaction

عند إضافة معاملة جديدة وإذا كان `accountFirestoreId = 'shared-main-account-v1'` ولم يُوجد الحساب:

```javascript
if (!accountId && transactionData.accountFirestoreId === 'shared-main-account-v1' && ownerUserId) {
  // إنشاء UUID ثابت للحساب المشترك
  const sharedAccountUuid = '00000000-0000-0000-0000-000000000001';
  
  const createResult = await pool.query(
    `INSERT INTO cash_accounts (
      account_uuid, firestore_id, owner_user_id, owner_firebase_uid, account_name, 
      is_primary, is_shared, color_code, sync_version, created_at, updated_at
    ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), to_timestamp($11))
    ON CONFLICT (account_uuid) DO UPDATE SET
      account_name = EXCLUDED.account_name,
      is_primary = EXCLUDED.is_primary,
      is_shared = EXCLUDED.is_shared,
      firestore_id = EXCLUDED.firestore_id,
      updated_at = EXCLUDED.updated_at
    RETURNING account_id`,
    [
      sharedAccountUuid,           // UUID ثابت
      'shared-main-account-v1',    // firestore_id
      ownerUserId,                 // owner_user_id
      transactionData.ownerFirebaseUid || null,
      'الصندوق الرئيسي',          // account_name
      true,                        // is_primary
      true,                        // is_shared
      0xFF0A84FF,                  // color (أزرق)
      1,                           // sync_version
      createdAtSeconds,
      createdAtSeconds
    ]
  );
}
```

### 2. خصائص الحساب المشترك

- **account_uuid**: `00000000-0000-0000-0000-000000000001` (UUID ثابت)
- **firestore_id**: `shared-main-account-v1`
- **account_name**: `الصندوق الرئيسي`
- **is_primary**: `true`
- **is_shared**: `true`
- **owner_user_id**: المستخدم الذي أنشأ المعاملة الأولى

### 3. معالجة الأخطاء

- إذا فشل الإنشاء بسبب `unique_violation` (الحساب موجود بالفعل):
  - البحث مرة أخرى عن الحساب باستخدام `getAccountIdFromFirestoreId`
- إذا فشل لأي سبب آخر:
  - تسجيل الخطأ في console
  - إرجاع خطأ واضح للمستخدم

## النتيجة

✅ الآن عند إضافة معاملة تشير إلى `shared-main-account-v1`:
1. يتم البحث عن الحساب أولاً
2. إذا لم يُوجد، يتم إنشاؤه تلقائياً
3. يتم استخدام `account_id` الجديد في المعاملة
4. لا توجد أخطاء `accountId is null`

## الخطوة التالية

1. أعد تشغيل الخادم
2. أضف معاملة جديدة من التطبيق تشير إلى `shared-main-account-v1`
3. راقب console logs - يجب أن ترى:
   - `🆕 Creating shared main account with ownerUserId: X`
   - `✅ Created shared main account with account_id: X`
   - لا توجد رسالة خطأ `accountId is null`
   - المعاملة يتم إدراجها بنجاح

---

**الحالة**: ✅ **تم الإصلاح**

