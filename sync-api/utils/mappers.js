// ============================================================================
// Data Mappers
// ============================================================================
// دوال تحويل البيانات من قاعدة البيانات إلى تنسيق API
// ============================================================================

const { booleanToInt, secondsToMs } = require('./helpers');

/**
 * تحويل بيانات المستخدم من قاعدة البيانات إلى تنسيق API
 */
function mapUserToAPI(row) {
  return {
    id: row.user_id,
    userId: row.user_id,
    user_id: row.user_id,
    entryId: row.user_uuid?.toString() || row.entry_id, // للتوافق
    userUuid: row.user_uuid?.toString(),
    firebaseUid: row.firebase_uid,
    name: row.full_name,
    fullName: row.full_name,
    phone: row.phone_number,
    phoneNumber: row.phone_number,
    jobTitle: row.job_title,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    accountNumber: row.account_number,
    isActive: booleanToInt(row.is_active),
    receiveTransactionNotifications: booleanToInt(row.receive_transaction_notifications),
    appVersionName: row.app_version_name,
    appVersionCode: row.app_version_code,
    deviceModel: row.device_model,
    deviceBrand: row.device_brand,
    deviceManufacturer: row.device_manufacturer,
    deviceSdkInt: row.device_sdk_int,
    accountPushToken: row.push_token,
    pushToken: row.push_token,
    lastLoginAt: row.last_login_at ? secondsToMs(row.last_login_at) : null,
    createdAt: secondsToMs(row.created_at),
    updatedAt: secondsToMs(row.updated_at),
    syncVersion: row.sync_version,
    deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
  };
}

/**
 * تحويل بيانات العميل من قاعدة البيانات إلى تنسيق API
 */
function mapClientToAPI(row) {
  return {
    id: row.client_id,
    entryId: row.client_uuid?.toString() || row.entry_id, // للتوافق
    clientUuid: row.client_uuid?.toString(),
    cloudId: row.cloud_id,
    firestoreId: row.firestore_id,
    ownerUserId: row.owner_user_id,
    ownerFirebaseUid: row.owner_firebase_uid,
    name: row.client_name,
    clientName: row.client_name,
    phone: row.phone_number,
    phoneNumber: row.phone_number,
    jobTitle: row.job_title,
    notes: row.notes,
    archived: booleanToInt(row.is_archived),
    isArchived: booleanToInt(row.is_archived),
    deviceId: row.device_id,
    syncVersion: row.sync_version,
    cachedTotalBalance: parseFloat(row.cached_total_balance || 0),
    createdAt: secondsToMs(row.created_at),
    updatedAt: secondsToMs(row.updated_at),
    deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
  };
}

/**
 * تحويل بيانات الحساب من قاعدة البيانات إلى تنسيق API
 */
function mapAccountToAPI(row) {
  return {
    id: row.account_id,
    entryId: row.account_uuid?.toString() || row.entry_id, // للتوافق
    accountUuid: row.account_uuid?.toString(),
    cloudId: row.cloud_id,
    firestoreId: row.firestore_id,
    ownerUserId: row.owner_user_id,
    ownerFirebaseUid: row.owner_firebase_uid,
    name: row.account_name,
    accountName: row.account_name,
    isPrimary: booleanToInt(row.is_primary),
    isShared: booleanToInt(row.is_shared),
    color: row.color_code ? (row.color_code.startsWith('#') ? row.color_code : '#' + row.color_code) : null,
    colorCode: row.color_code ? (row.color_code.startsWith('#') ? row.color_code : '#' + row.color_code) : null,
    templateKey: row.template_key || null,
    deviceId: row.device_id,
    syncVersion: row.sync_version,
    createdAt: secondsToMs(row.created_at),
    updatedAt: secondsToMs(row.updated_at),
    deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
  };
}

/**
 * تحويل بيانات المعاملة من قاعدة البيانات إلى تنسيق API
 */
function mapTransactionToAPI(row) {
  return {
    id: row.transaction_id,
    entryId: row.transaction_uuid?.toString() || row.entry_id, // للتوافق
    transactionUuid: row.transaction_uuid?.toString(),
    cloudId: row.cloud_id,
    firestoreId: row.firestore_id,
    ownerUserId: row.owner_user_id,
    ownerFirebaseUid: row.owner_firebase_uid,
    customerId: row.client_id,
    clientId: row.client_id,
    accountId: row.account_id,
    accountName: row.account_name || null, // ✅ إضافة accountName
    customerFirestoreId: row.client_firestore_id,
    clientFirestoreId: row.client_firestore_id,
    accountFirestoreId: row.account_firestore_id,
    amount: parseFloat(row.transaction_amount),
    transactionAmount: parseFloat(row.transaction_amount),
    currency: row.currency_code,
    currencyCode: row.currency_code,
    direction: row.transaction_direction,
    transactionDirection: row.transaction_direction,
    note: row.transaction_note,
    transactionNote: row.transaction_note,
    transactionDate: secondsToMs(row.transaction_date),
    notifyCustomer: booleanToInt(row.notify_customer),
    synced: booleanToInt(row.is_synced),
    isSynced: booleanToInt(row.is_synced),
    deviceId: row.device_id,
    transactionNumber: row.transaction_number,
    syncVersion: row.sync_version,
    createdAt: secondsToMs(row.created_at),
    updatedAt: secondsToMs(row.updated_at),
    deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null,
    // الحوالات المالية
    entryType: row.entry_type || null,
    transferCompany: row.transfer_company || null,
    transferRecipient: row.transfer_recipient || null,
    transferSender: row.transfer_sender || null,
    transferNumber: row.transfer_number || null,
    feeAmount: row.fee_amount != null ? parseFloat(row.fee_amount) : null,
    feeCurrency: row.fee_currency || null,
    centerFeeAmount: row.center_fee_amount != null ? parseFloat(row.center_fee_amount) : null,
    centerFeeCurrency: row.center_fee_currency || null
  };
}

module.exports = {
  mapUserToAPI,
  mapClientToAPI,
  mapAccountToAPI,
  mapTransactionToAPI
};

