// ============================================================================
// Helper Functions
// ============================================================================
// دوال مساعدة عامة
// ============================================================================

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { pool } = require('../config/database');
const logger = require('./logger');

/**
 * تحويل Room INTEGER (0/1) إلى PostgreSQL BOOLEAN
 */
function intToBoolean(value) {
  if (value === null || value === undefined) return null;
  return value === 1 || value === true;
}

/**
 * تحويل PostgreSQL BOOLEAN إلى Room INTEGER (0/1)
 */
function booleanToInt(value) {
  if (value === null || value === undefined) return 0;
  return value === true ? 1 : 0;
}

/**
 * تحويل timestamp من milliseconds إلى seconds (PostgreSQL)
 * يدعم القيم بالثواني والميلي ثواني تلقائياً
 */
function msToSeconds(timestamp) {
  if (!timestamp) return null;
  
  // إذا كان string، حاول تحويله إلى number
  if (typeof timestamp === 'string') {
    timestamp = parseFloat(timestamp);
    if (isNaN(timestamp)) return null;
  }
  
  // إذا كان number
  if (typeof timestamp === 'number') {
    // القيم بالميلي ثواني عادة تكون حوالي 13 رقم (مثل 1768690957014)
    // القيم بالثواني عادة تكون حوالي 10 أرقام (مثل 1768690957)
    // إذا كان الرقم أكبر من 1e12 (1 تريليون = 1000 مليار)، فهو بالميلي ثواني
    // إذا كان الرقم أصغر من 1e12، فهو بالثواني
    if (timestamp > 1e12) {
      // بالميلي ثواني - حوله إلى ثواني
      return Math.floor(timestamp / 1000);
    } else {
      // بالفعل بالثواني - ارجعه كما هو
      return Math.floor(timestamp);
    }
  }
  
  return null;
}

/**
 * تحويل timestamp من seconds إلى milliseconds (Android)
 */
function secondsToMs(timestamp) {
  if (!timestamp) return null;
  
  // إذا كان Date object
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }
  
  // إذا كان string
  if (typeof timestamp === 'string') {
    const date = new Date(timestamp);
    if (!isNaN(date.getTime())) {
      return date.getTime();
    }
  }
  
  // إذا كان number (seconds)
  if (typeof timestamp === 'number') {
    // إذا كان بالفعل milliseconds (> year 2000)
    if (timestamp > 946684800000) {
      return timestamp;
    }
    // إذا كان seconds
    return timestamp * 1000;
  }
  
  return null;
}

/**
 * التحقق من كلمة المرور (PBKDF2 + دعم التجزئة القديمة)
 */
function verifyPassword(password, salt, storedHash) {
  if (!password || !salt || !storedHash) return false;

  try {
    if (storedHash.startsWith('pbkdf2_v1$')) {
      const parts = storedHash.split('$');
      if (parts.length !== 3) return false;
      const iterations = parseInt(parts[1], 10);
      if (!Number.isFinite(iterations) || iterations <= 0) return false;
      const derived = crypto.pbkdf2Sync(
        password,
        Buffer.from(salt, 'base64'),
        iterations,
        64,
        'sha512'
      );
      const expected = Buffer.from(parts[2], 'base64');
      if (expected.length !== derived.length) return false;
      return crypto.timingSafeEqual(expected, derived);
    }

    // تجزئة قديمة (SHA-256)
    const legacy = crypto
      .createHash('sha256')
      .update(`${password}${salt}`)
      .digest('base64');
    return legacy === storedHash;
  } catch (error) {
    logger.warning('Password verification error', { error: error.message });
    return false;
  }
}

/**
 * التحقق من صحة UUID
 */
function isValidUUID(uuid) {
  if (!uuid) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * التحقق من وجود UUID (للمزامنة الذكية)
 */
function ensureUuid(data) {
  // التحقق من userUuid
  if (data.userUuid && !isValidUUID(data.userUuid)) {
    data.userUuid = uuidv4();
  } else if (!data.userUuid && !data.entryId) {
    data.userUuid = uuidv4();
  }
  
  // التحقق من clientUuid
  if (data.clientUuid && !isValidUUID(data.clientUuid)) {
    data.clientUuid = uuidv4();
  } else if (!data.clientUuid && !data.entryId) {
    data.clientUuid = uuidv4();
  }
  
  // التحقق من accountUuid
  if (data.accountUuid && !isValidUUID(data.accountUuid)) {
    data.accountUuid = uuidv4();
  } else if (!data.accountUuid && !data.entryId) {
    data.accountUuid = uuidv4();
  }
  
  // التحقق من transactionUuid
  if (data.transactionUuid && !isValidUUID(data.transactionUuid)) {
    data.transactionUuid = uuidv4();
  } else if (!data.transactionUuid && !data.entryId) {
    data.transactionUuid = uuidv4();
  }
  
  // للتوافق مع الإصدار القديم - استخدام entryId إذا كان UUID صحيح
  if (data.entryId && isValidUUID(data.entryId)) {
    if (!data.userUuid) data.userUuid = data.entryId;
    if (!data.clientUuid) data.clientUuid = data.entryId;
    if (!data.accountUuid) data.accountUuid = data.entryId;
    if (!data.transactionUuid) data.transactionUuid = data.entryId;
  } else if (data.entryId && !isValidUUID(data.entryId)) {
    // إذا كان entryId غير صحيح، ننشئ UUID جديد
    const newUuid = uuidv4();
    if (!data.userUuid) data.userUuid = newUuid;
    if (!data.clientUuid) data.clientUuid = newUuid;
    if (!data.accountUuid) data.accountUuid = newUuid;
    if (!data.transactionUuid) data.transactionUuid = newUuid;
  }
  
  return data;
}

/**
 * الحصول على ownerUserId من ownerFirebaseUid
 */
async function getUserIdFromFirebaseUid(firebaseUid) {
  if (!firebaseUid) {
    logger.warning('getUserIdFromFirebaseUid: firebaseUid is null/undefined');
    return null;
  }
  try {
    const result = await pool.query(
      'SELECT user_id FROM app_users WHERE firebase_uid = $1 LIMIT 1',
      [firebaseUid]
    );
    if (result.rows.length > 0) {
      logger.info('Found user_id for firebaseUid', {
        userId: result.rows[0].user_id,
        firebaseUid
      });
      return result.rows[0].user_id;
    } else {
      logger.warning('No user found with firebaseUid', { firebaseUid });
      return null;
    }
  } catch (error) {
    logger.errorMsg('Error getting userId from firebaseUid', {
      error: error.message,
      firebaseUid
    });
    return null;
  }
}

/**
 * تحويل ownerUserId إلى Long (يدعم String و Long)
 */
async function normalizeOwnerUserId(ownerUserId, ownerFirebaseUid) {
  logger.debug('normalizeOwnerUserId', { ownerUserId, ownerFirebaseUid });

  const numericOwnerId =
    (typeof ownerUserId === 'number' && Number.isFinite(ownerUserId))
      ? ownerUserId
      : (typeof ownerUserId === 'string' && ownerUserId.match(/^\d+$/))
        ? parseInt(ownerUserId, 10)
        : null;

  // إذا كان ownerUserId موجوداً ورقماً، تأكد أولاً أنه موجود في app_users
  if (numericOwnerId) {
    try {
      // إذا كان ownerFirebaseUid متوفرًا، تأكد من التطابق بينهما
      const checkResult = ownerFirebaseUid
        ? await pool.query(
          'SELECT user_id FROM app_users WHERE user_id = $1 AND firebase_uid = $2 LIMIT 1',
          [numericOwnerId, ownerFirebaseUid]
        )
        : await pool.query(
          'SELECT user_id FROM app_users WHERE user_id = $1 LIMIT 1',
          [numericOwnerId]
        );
      if (checkResult.rows.length > 0) {
        return numericOwnerId;
      } else {
        logger.warning('normalizeOwnerUserId: numeric ownerUserId not found or mismatched, falling back to firebaseUid', {
          ownerUserId: numericOwnerId,
          ownerFirebaseUid
        });
      }
    } catch (error) {
      logger.warning('normalizeOwnerUserId: error checking numeric ownerUserId, falling back to firebaseUid', {
        error: error.message,
        ownerUserId: numericOwnerId,
        ownerFirebaseUid
      });
    }
  }
  
  // إذا كان ownerUserId String (Firebase UID)، احصل على user_id من قاعدة البيانات
  if (ownerUserId && typeof ownerUserId === 'string' && !ownerUserId.match(/^\d+$/)) {
    const userId = await getUserIdFromFirebaseUid(ownerUserId);
    if (userId) {
      return userId;
    }
  }
  
  // إذا كان ownerFirebaseUid موجوداً، احصل على user_id من قاعدة البيانات
  if (ownerFirebaseUid) {
    const userId = await getUserIdFromFirebaseUid(ownerFirebaseUid);
    if (userId) {
      return userId;
    }
  }
  
  logger.errorMsg('Could not find user_id', { ownerUserId, ownerFirebaseUid });
  return null;
}

/**
 * Resolve ownerUserId with optional auth binding
 * - إذا كان authUserId موجوداً: نستخدمه ونمنع عدم التطابق
 * - إذا لا يوجد auth: نستخدم normalizeOwnerUserId
 */
async function resolveOwnerUserIdForRequest({ ownerUserId, ownerFirebaseUid, authUserId, authFirebaseUid }) {
  if (authUserId != null) {
    const authId = typeof authUserId === 'string' ? parseInt(authUserId, 10) : authUserId;
    if (!Number.isFinite(authId)) {
      return { ownerUserId: null, ownerFirebaseUid, error: 'Invalid auth userId' };
    }
    if (ownerUserId != null && String(ownerUserId) !== String(authId)) {
      return { ownerUserId: null, ownerFirebaseUid, error: 'ownerUserId mismatch with auth token' };
    }
    return {
      ownerUserId: authId,
      ownerFirebaseUid: authFirebaseUid || ownerFirebaseUid
    };
  }

  const resolved = await normalizeOwnerUserId(ownerUserId, ownerFirebaseUid);
  return { ownerUserId: resolved, ownerFirebaseUid };
}

/**
 * تحويل color من Long إلى hex string
 */
function normalizeColorCode(color) {
  if (!color && color !== 0) {
    return null;
  }
  
  // إذا كان String بالفعل
  if (typeof color === 'string') {
    // إزالة # إذا كان موجوداً
    const cleaned = color.replace(/^#/, '').toUpperCase();
    // التحقق من أنه hex صحيح (6 أو 8 أحرف)
    if (/^[0-9A-F]{6}$/.test(cleaned) || /^[0-9A-F]{8}$/.test(cleaned)) {
      return cleaned.substring(0, 6); // نأخذ أول 6 أحرف فقط (RGB بدون alpha)
    }
    // إذا كان hex غير صحيح، نحاول تحويله من Long
    const parsed = parseInt(cleaned, 16);
    if (!isNaN(parsed)) {
      return (parsed >>> 8).toString(16).toUpperCase().padStart(6, '0');
    }
    return null;
  }
  
  // إذا كان Number (Long)
  if (typeof color === 'number') {
    // تحويل Long إلى hex string (نزيل alpha channel)
    return (color >>> 8).toString(16).toUpperCase().padStart(6, '0');
  }
  
  return null;
}

/**
 * الحصول على client_id من clientFirestoreId
 */
async function getClientIdFromFirestoreId(firestoreId, ownerUserId = null) {
  if (!firestoreId) {
    return null;
  }
  try {
    const isUUID = isValidUUID(firestoreId);

    const params = [];
    let query = 'SELECT client_id FROM business_clients WHERE ';
    if (isUUID) {
      params.push(firestoreId);
      query += `client_uuid = $${params.length}`;
    } else {
      params.push(firestoreId);
      query += `firestore_id = $${params.length}`;
    }
    if (ownerUserId != null) {
      params.push(ownerUserId);
      query += ` AND owner_user_id = $${params.length}`;
    }
    query += ' LIMIT 1';

    const result = await pool.query(query, params);
    
    if (result.rows.length > 0) {
      logger.info('Found client_id for firestoreId', {
        clientId: result.rows[0].client_id,
        firestoreId
      });
      return result.rows[0].client_id;
    } else {
      logger.warning('No client found with firestoreId', { firestoreId });
      return null;
    }
  } catch (error) {
    logger.errorMsg('Error getting clientId from firestoreId', {
      error: error.message,
      firestoreId
    });
    return null;
  }
}

/**
 * تحويل clientId إلى Long (يدعم String و Long)
 */
async function normalizeClientId(clientId, clientFirestoreId, ownerUserId = null) {
  logger.debug('normalizeClientId', { clientId, clientFirestoreId, ownerUserId });
  
  // Prefer stable firestore/UUID mapping when available (prevents cross-client mismatch)
  if (clientFirestoreId) {
    const foundClientId = await getClientIdFromFirestoreId(clientFirestoreId, ownerUserId);
    if (foundClientId) {
      return foundClientId;
    }
  }

  // Fallback to clientId (only if it belongs to this owner)
  let numericClientId = null;
  if (typeof clientId === 'number') {
    numericClientId = clientId;
  } else if (typeof clientId === 'string' && clientId.trim() !== '') {
    const parsed = Number(clientId);
    if (Number.isFinite(parsed)) numericClientId = parsed;
  }

  if (numericClientId != null) {
    try {
      const params = [numericClientId];
      let query = 'SELECT client_id FROM business_clients WHERE client_id = $1';
      if (ownerUserId != null) {
        params.push(ownerUserId);
        query += ` AND owner_user_id = $${params.length}`;
      }
      query += ' LIMIT 1';
      const checkResult = await pool.query(query, params);
      if (checkResult.rows.length > 0) {
        return numericClientId;
      }
    } catch (error) {
      logger.warning('Error checking clientId', { error: error.message });
    }
  }
  
  logger.warning('Could not find client_id', { clientId, clientFirestoreId });
  return null;
}

/**
 * الحصول على account_id من accountFirestoreId
 */
async function getAccountIdFromFirestoreId(firestoreId, ownerUserId = null) {
  if (!firestoreId) {
    return null;
  }
  try {
    const isUuid = isValidUUID(firestoreId);
    const hasOwner = ownerUserId != null;
    const params = [];
    let query = 'SELECT account_id FROM cash_accounts WHERE ';

    if (hasOwner) {
      params.push(ownerUserId);
      query += `owner_user_id = $${params.length} AND `;
    }

    if (isUuid) {
      // Use separate params to avoid UUID vs VARCHAR operator mismatch
      params.push(firestoreId);
      params.push(firestoreId);
      query += `(account_uuid = $${params.length - 1}::uuid OR firestore_id = $${params.length})`;
    } else {
      params.push(firestoreId);
      query += `firestore_id = $${params.length}`;
    }

    query += ' LIMIT 1';

    const result = await pool.query(query, params);
    
    if (result.rows.length > 0) {
      logger.info('Found account_id for firestoreId', {
        accountId: result.rows[0].account_id,
        firestoreId,
        ownerUserId
      });
      return result.rows[0].account_id;
    } else {
      logger.warning('No account found with firestoreId', { firestoreId });
      return null;
    }
  } catch (error) {
    logger.errorMsg('Error getting accountId from firestoreId', {
      error: error.message,
      firestoreId
    });
    return null;
  }
}

/**
 * تحويل accountId إلى Long (يدعم String و Long)
 */
async function normalizeAccountId(accountId, accountFirestoreId, ownerUserId = null) {
  logger.debug('normalizeAccountId', { accountId, accountFirestoreId, ownerUserId });

  // إذا كان accountFirestoreId موجوداً، احصل على account_id أولاً (أكثر أماناً من accountId المحلي)
  if (accountFirestoreId) {
    const foundAccountId = await getAccountIdFromFirestoreId(accountFirestoreId, ownerUserId);
    if (foundAccountId) {
      return foundAccountId;
    }
    // ✅ لا تستخدم accountId المحلي إذا فشل حل accountFirestoreId لتجنب ربط خاطئ
    logger.warning('accountFirestoreId provided but not resolved', { accountId, accountFirestoreId, ownerUserId });
    return null;
  }

  if (accountId && typeof accountId === 'number') {
    // التحقق من وجود accountId في قاعدة البيانات
    try {
      const checkQuery = ownerUserId != null
        ? 'SELECT account_id FROM cash_accounts WHERE account_id = $1 AND owner_user_id = $2'
        : 'SELECT account_id FROM cash_accounts WHERE account_id = $1';
      const checkParams = ownerUserId != null ? [accountId, ownerUserId] : [accountId];
      const checkResult = await pool.query(checkQuery, checkParams);
      if (checkResult.rows.length > 0) {
        return accountId;
      }
    } catch (error) {
      logger.warning('Error checking accountId', { error: error.message });
    }
  }
  
  logger.errorMsg('Could not find account_id', { accountId, accountFirestoreId });
  return null;
}

/**
 * تحويل transaction direction إلى صيغة صحيحة
 * قاعدة البيانات تستخدم: income/expense
 * التطبيق يرسل: DEBIT/CREDIT
 * 
 * التحويل:
 * - DEBIT → expense (مدين)
 * - CREDIT → income (دائن)
 * - income → income (للتوافق)
 * - expense → expense (للتوافق)
 */
function normalizeTransactionDirection(direction) {
  if (!direction) return 'expense';
  
  const normalized = direction.toUpperCase().trim();
  
  // الصيغة الجديدة من التطبيق (DEBIT/CREDIT) → تحويل إلى income/expense
  if (normalized === 'DEBIT') {
    return 'expense'; // DEBIT = expense (مدين)
  }
  if (normalized === 'CREDIT') {
    return 'income'; // CREDIT = income (دائن)
  }
  
  // الصيغة القديمة (income/expense) - للتوافق
  const lowerNormalized = normalized.toLowerCase();
  if (lowerNormalized === 'income' || lowerNormalized === 'expense') {
    return lowerNormalized;
  }
  
  logger.warning('Unknown transaction direction', { direction, normalized });
  return 'expense'; // القيمة الافتراضية
}

module.exports = {
  intToBoolean,
  booleanToInt,
  msToSeconds,
  secondsToMs,
  verifyPassword,
  isValidUUID,
  ensureUuid,
  getUserIdFromFirebaseUid,
  normalizeOwnerUserId,
  resolveOwnerUserIdForRequest,
  normalizeColorCode,
  getClientIdFromFirestoreId,
  normalizeClientId,
  getAccountIdFromFirestoreId,
  normalizeAccountId,
  normalizeTransactionDirection
};

