// ============================================================================
// MalyMax Professional Sync API Server - PostgreSQL
// ============================================================================
// نظام مزامنة احترافي ومحسّن مع أمان عالي
// يدعم العمل أونلاين وأوفلاين مع مزامنة ذكية
// ============================================================================

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const admin = require('firebase-admin');
const { 
  authenticate, 
  optionalAuthenticate, 
  authorizeResource,
  generalLimiter,
  syncLimiter,
  generateToken 
} = require('./middleware/auth');

// ==================== 1. تهيئة Express Server ====================
const app = express();
const PORT = process.env.PORT || 3001;

// ==================== 2. Middleware ====================
// ✅ تفعيل trust proxy للعمل خلف proxy (مثل Render)
app.set('trust proxy', true);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(generalLimiter);

// ==================== 3. تهيئة Firebase Admin SDK ====================
try {
  // ✅ استخدام GOOGLE_SERVICE_ACCOUNT_JSON من متغيرات البيئة (مثل Render)
  const serviceAccountJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  
  if (serviceAccountJson) {
    // إذا كان JSON string في متغير البيئة (مثل Render)
    const serviceAccount = JSON.parse(serviceAccountJson);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('✅ Firebase Admin SDK initialized from GOOGLE_SERVICE_ACCOUNT_JSON');
  } else {
    // محاولة استخدام ملف محلي (للتطوير)
    try {
      const serviceAccount = require('./serviceAccountKey.json');
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log('✅ Firebase Admin SDK initialized from serviceAccountKey.json');
    } catch (localError) {
      console.warn('⚠️ Firebase Admin SDK not initialized: GOOGLE_SERVICE_ACCOUNT_JSON not set and serviceAccountKey.json not found');
      console.warn('   FCM notifications will be disabled. Set GOOGLE_SERVICE_ACCOUNT_JSON in environment variables.');
    }
  }
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
  console.warn('⚠️ FCM notifications will be disabled');
}

// ==================== 4. إعداد PostgreSQL Connection Pool ====================

// ملاحظة: Supabase يحتاج SSL غالبًا
const isSupabase = (process.env.DB_HOST || '').includes('supabase.com') || (process.env.DB_HOST || '').includes('pooler');
const sslConfig = (process.env.DB_SSL === 'true' || isSupabase)
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: sslConfig,
});
// Test connection
pool.on('connect', () => {
  console.log('✅ تم الاتصال بقاعدة بيانات PostgreSQL بنجاح');
});

pool.on('error', (err) => {
  console.error('❌ خطأ في اتصال PostgreSQL:', err);
});

// ==================== 4. دوال مساعدة ====================

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
    return false;
  }
}

/**
 * معالجة الأخطاء بشكل موحد
 */
function handleError(res, error, statusCode = 500) {
  console.error('❌ خطأ:', error);
  res.status(statusCode).json({
    success: false,
    error: error.message || 'حدث خطأ غير متوقع',
    details: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
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
    console.warn('⚠️ getUserIdFromFirebaseUid: firebaseUid is null/undefined');
    return null;
  }
  try {
    const result = await pool.query(
      'SELECT user_id FROM app_users WHERE firebase_uid = $1 LIMIT 1',
      [firebaseUid]
    );
    if (result.rows.length > 0) {
      console.log(`✅ Found user_id ${result.rows[0].user_id} for firebaseUid: ${firebaseUid}`);
      return result.rows[0].user_id;
    } else {
      console.warn(`⚠️ No user found with firebaseUid: ${firebaseUid}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error getting userId from firebaseUid:', error);
    return null;
  }
}

/**
 * تحويل ownerUserId إلى Long (يدعم String و Long)
 */
async function normalizeOwnerUserId(ownerUserId, ownerFirebaseUid) {
  console.log(`🔍 normalizeOwnerUserId: ownerUserId=${ownerUserId} (${typeof ownerUserId}), ownerFirebaseUid=${ownerFirebaseUid}`);
  
  // إذا كان ownerUserId موجوداً و Long، استخدمه
  if (ownerUserId && typeof ownerUserId === 'number') {
    console.log(`✅ Using ownerUserId as number: ${ownerUserId}`);
    return ownerUserId;
  }
  
  // إذا كان ownerUserId String (Firebase UID)، احصل على user_id من قاعدة البيانات
  if (ownerUserId && typeof ownerUserId === 'string' && !ownerUserId.match(/^\d+$/)) {
    console.log(`🔍 ownerUserId is Firebase UID string, looking up user_id...`);
    const userId = await getUserIdFromFirebaseUid(ownerUserId);
    if (userId) {
      console.log(`✅ Found user_id ${userId} from ownerUserId (Firebase UID)`);
      return userId;
    }
  }
  
  // إذا كان ownerFirebaseUid موجوداً، احصل على user_id من قاعدة البيانات
  if (ownerFirebaseUid) {
    console.log(`🔍 ownerFirebaseUid provided, looking up user_id...`);
    const userId = await getUserIdFromFirebaseUid(ownerFirebaseUid);
    if (userId) {
      console.log(`✅ Found user_id ${userId} from ownerFirebaseUid`);
      return userId;
    }
  }
  
  console.error(`❌ normalizeOwnerUserId: Could not find user_id for ownerUserId=${ownerUserId}, ownerFirebaseUid=${ownerFirebaseUid}`);
  return null;
}

/**
 * تحويل color من Long إلى hex string
 * يدعم: Long (number), String (hex مع أو بدون #), null
 * الإرجاع: hex string بدون # (مثل "FF2196F3") أو null
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
    // 0xFF2196F3 -> "FF2196" (6 أحرف)
    return (color >>> 8).toString(16).toUpperCase().padStart(6, '0');
  }
  
  return null;
}

/**
 * الحصول على client_id من clientFirestoreId
 */
async function getClientIdFromFirestoreId(firestoreId) {
  if (!firestoreId) {
    return null;
  }
  try {
    // التحقق من أن firestoreId هو UUID صحيح
    const isUUID = isValidUUID(firestoreId);
    
    // البحث عن العميل بناءً على client_uuid (entryId) أو firestore_id
    let result;
    if (isUUID) {
      // إذا كان UUID، ابحث في client_uuid (UUID type)
      result = await pool.query(
        'SELECT client_id FROM business_clients WHERE client_uuid = $1::uuid LIMIT 1',
        [firestoreId]
      );
      if (result.rows.length === 0) {
        // إذا لم يُوجد في client_uuid، ابحث في firestore_id (VARCHAR)
        result = await pool.query(
          'SELECT client_id FROM business_clients WHERE firestore_id = $1 LIMIT 1',
          [firestoreId]
        );
      }
    } else {
      // إذا لم يكن UUID، ابحث في firestore_id فقط
      result = await pool.query(
        'SELECT client_id FROM business_clients WHERE firestore_id = $1 LIMIT 1',
        [firestoreId]
      );
    }
    
    if (result.rows.length > 0) {
      console.log(`✅ Found client_id ${result.rows[0].client_id} for firestoreId: ${firestoreId}`);
      return result.rows[0].client_id;
    } else {
      console.warn(`⚠️ No client found with firestoreId: ${firestoreId}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error getting clientId from firestoreId:', error);
    return null;
  }
}

/**
 * تحويل clientId إلى client_id في PostgreSQL
 * إذا كان clientId موجوداً و Long، استخدمه مباشرة
 * إذا كان clientFirestoreId موجوداً، ابحث عن client_id من قاعدة البيانات
 */
async function normalizeClientId(clientId, clientFirestoreId) {
  console.log(`🔍 normalizeClientId: clientId=${clientId} (${typeof clientId}), clientFirestoreId=${clientFirestoreId}`);
  
  // إذا كان clientId موجوداً و Long، استخدمه مباشرة
  if (clientId && typeof clientId === 'number') {
    // التحقق من أن client_id موجود في قاعدة البيانات
    try {
      const checkResult = await pool.query('SELECT client_id FROM business_clients WHERE client_id = $1', [clientId]);
      if (checkResult.rows.length > 0) {
        console.log(`✅ Using clientId as number: ${clientId}`);
        return clientId;
      } else {
        console.warn(`⚠️ clientId ${clientId} not found in database, trying firestoreId...`);
      }
    } catch (error) {
      console.error('❌ Error checking clientId:', error);
    }
  }
  
  // إذا كان clientFirestoreId موجوداً، احصل على client_id من قاعدة البيانات
  if (clientFirestoreId) {
    console.log(`🔍 clientFirestoreId provided, looking up client_id...`);
    const foundClientId = await getClientIdFromFirestoreId(clientFirestoreId);
    if (foundClientId) {
      console.log(`✅ Found client_id ${foundClientId} from clientFirestoreId`);
      return foundClientId;
    }
  }
  
  console.warn(`⚠️ normalizeClientId: Could not find client_id for clientId=${clientId}, clientFirestoreId=${clientFirestoreId}. Using null.`);
  return null; // client_id يمكن أن يكون null في قاعدة البيانات
}

/**
 * الحصول على account_id من accountFirestoreId
 */
async function getAccountIdFromFirestoreId(firestoreId) {
  if (!firestoreId) {
    return null;
  }
  try {
    // التحقق من أن firestoreId هو UUID صحيح
    const isUUID = isValidUUID(firestoreId);
    
    // البحث عن الحساب بناءً على account_uuid (entryId) أو firestore_id
    let result;
    if (isUUID) {
      // إذا كان UUID، ابحث في account_uuid (UUID type)
      result = await pool.query(
        'SELECT account_id FROM cash_accounts WHERE account_uuid = $1::uuid LIMIT 1',
        [firestoreId]
      );
      if (result.rows.length === 0) {
        // إذا لم يُوجد في account_uuid، ابحث في firestore_id (VARCHAR)
        result = await pool.query(
          'SELECT account_id FROM cash_accounts WHERE firestore_id = $1 LIMIT 1',
          [firestoreId]
        );
      }
    } else {
      // إذا لم يكن UUID، ابحث في firestore_id أولاً
      result = await pool.query(
        'SELECT account_id FROM cash_accounts WHERE firestore_id = $1 LIMIT 1',
        [firestoreId]
      );
      
      // إذا لم يُوجد وكان firestoreId هو "shared-main-account-v1"، ابحث بالاسم
      if (result.rows.length === 0 && firestoreId === 'shared-main-account-v1') {
        console.log(`🔍 Searching for shared main account by name: ${firestoreId}`);
        result = await pool.query(
          'SELECT account_id FROM cash_accounts WHERE account_name = $1 AND is_shared = true AND is_primary = true LIMIT 1',
          ['الصندوق الرئيسي']
        );
      }
    }
    
    if (result.rows.length > 0) {
      console.log(`✅ Found account_id ${result.rows[0].account_id} for firestoreId: ${firestoreId}`);
      return result.rows[0].account_id;
    } else {
      console.warn(`⚠️ No account found with firestoreId: ${firestoreId}`);
      return null;
    }
  } catch (error) {
    console.error('❌ Error getting accountId from firestoreId:', error);
    return null;
  }
}

/**
 * تحويل accountId إلى account_id في PostgreSQL
 * إذا كان accountId موجوداً و Long، استخدمه مباشرة
 * إذا كان accountFirestoreId موجوداً، ابحث عن account_id من قاعدة البيانات
 */
async function normalizeAccountId(accountId, accountFirestoreId) {
  console.log(`🔍 normalizeAccountId: accountId=${accountId} (${typeof accountId}), accountFirestoreId=${accountFirestoreId}`);
  
  // إذا كان accountId موجوداً و Long، استخدمه مباشرة
  if (accountId && typeof accountId === 'number') {
    // التحقق من أن account_id موجود في قاعدة البيانات
    try {
      const checkResult = await pool.query('SELECT account_id FROM cash_accounts WHERE account_id = $1', [accountId]);
      if (checkResult.rows.length > 0) {
        console.log(`✅ Using accountId as number: ${accountId}`);
        return accountId;
      } else {
        console.warn(`⚠️ accountId ${accountId} not found in database, trying firestoreId...`);
      }
    } catch (error) {
      console.error('❌ Error checking accountId:', error);
    }
  }
  
  // إذا كان accountFirestoreId موجوداً، احصل على account_id من قاعدة البيانات
  if (accountFirestoreId) {
    console.log(`🔍 accountFirestoreId provided, looking up account_id...`);
    const foundAccountId = await getAccountIdFromFirestoreId(accountFirestoreId);
    if (foundAccountId) {
      console.log(`✅ Found account_id ${foundAccountId} from accountFirestoreId`);
      return foundAccountId;
    }
    
    // إذا كان accountFirestoreId هو "shared-main-account-v1" ولم يُوجد، أنشئه تلقائياً
    // ملاحظة: normalizeAccountId لا يمكنه إنشاء الحساب لأنه لا يعرف ownerUserId
    // سيتم إنشاء الحساب في INSERT transaction query
  }
  
  console.error(`❌ normalizeAccountId: Could not find account_id for accountId=${accountId}, accountFirestoreId=${accountFirestoreId}`);
  return null; // account_id لا يمكن أن يكون null (NOT NULL constraint)
}

/**
 * تحويل transaction direction من التطبيق إلى قاعدة البيانات
 * DEBIT → expense (مصروف)
 * CREDIT → income (دخل)
 */
function normalizeTransactionDirection(direction) {
  if (!direction) {
    return 'expense'; // افتراضي
  }
  
  const upperDirection = String(direction).toUpperCase();
  
  if (upperDirection === 'DEBIT') {
    return 'expense';
  } else if (upperDirection === 'CREDIT') {
    return 'income';
  } else if (upperDirection === 'INCOME' || upperDirection === 'EXPENSE') {
    return upperDirection.toLowerCase();
  }
  
  // إذا كانت القيمة غير معروفة، نستخدم expense كافتراضي
  console.warn(`⚠️ Unknown transaction direction: ${direction}, using 'expense' as default`);
  return 'expense';
}

/**
 * حل التعارضات: Last Write Wins مع التحقق من syncVersion
 * ✅ مطابق لآلية Firebase: syncVersion أولاً، ثم updatedAt
 */
async function resolveConflict(tableName, uuid, localData, remoteData) {
  const localVersion = localData.syncVersion || 1;
  const remoteVersion = remoteData.syncVersion || 1;
  const localTime = localData.updatedAt || localData.createdAt || 0;
  const remoteTime = remoteData.updatedAt || remoteData.createdAt || 0;
  
  // ✅ آلية Firebase: مقارنة syncVersion أولاً
  if (localVersion > remoteVersion) {
    // المحلي أحدث - يجب الكتابة
    console.log(`✅ Conflict resolved: Local wins (v${localVersion} > v${remoteVersion})`);
    return { winner: localData, conflict: true, reason: 'version' };
  }
  if (remoteVersion > localVersion) {
    // البعيد أحدث - لا يجب الكتابة
    console.log(`✅ Conflict resolved: Remote wins (v${remoteVersion} > v${localVersion})`);
    return { winner: remoteData, conflict: true, reason: 'version' };
  }
  
  // ✅ نفس الإصدار - مقارنة بالوقت (Last Write Wins)
  if (localTime > remoteTime) {
    console.log(`✅ Conflict resolved: Local wins (same version, newer timestamp)`);
    return { winner: localData, conflict: true, reason: 'timestamp' };
  } else {
    console.log(`✅ Conflict resolved: Remote wins (same version, newer timestamp)`);
    return { winner: remoteData, conflict: true, reason: 'timestamp' };
  }
}

/**
 * إرسال إشعار FCM للمزامنة الفورية بين الأجهزة
 * @param {string} firebaseUid - معرف Firebase للمستخدم
 * @param {string} sourceDeviceId - معرف الجهاز الذي أنشأ التغيير (للتجاهل)
 * @param {string} entityType - نوع الكيان (transaction, customer, account)
 * @param {string} action - نوع العملية (created, updated, deleted)
 * @param {string} entityId - معرف الكيان
 */
async function sendSyncNotification(firebaseUid, sourceDeviceId, entityType, action, entityId) {
  if (!firebaseUid) {
    console.warn('⚠️ Cannot send sync notification: firebaseUid is missing');
    return;
  }

  try {
    // ✅ جلب جميع FCM tokens النشطة للمستخدم (باستثناء الجهاز المصدر)
    const tokensResult = await pool.query(
      `SELECT token, device_id FROM user_fcm_tokens 
       WHERE firebase_uid = $1 AND is_active = TRUE 
       ${sourceDeviceId ? 'AND (device_id IS NULL OR device_id != $2)' : ''}
       ORDER BY is_primary DESC, last_used_at DESC`,
      sourceDeviceId ? [firebaseUid, sourceDeviceId] : [firebaseUid]
    );

    if (tokensResult.rows.length === 0) {
      console.log(`ℹ️ No FCM tokens found for user ${firebaseUid} (excluding device ${sourceDeviceId || 'none'})`);
      return;
    }

    const tokens = tokensResult.rows.map(row => row.token);
    console.log(`📤 Sending sync notification to ${tokens.length} device(s) for ${entityType} ${action}: ${entityId}`);

    // ✅ التحقق من تهيئة Firebase Admin SDK
    if (!admin.apps.length) {
      console.warn('⚠️ Firebase Admin SDK not initialized - skipping sync notification');
      return;
    }

    // ✅ إرسال إشعار FCM عبر Firebase Admin SDK
    const message = {
      notification: {
        title: 'تحديث جديد',
        body: `تم ${action === 'created' ? 'إضافة' : action === 'updated' ? 'تحديث' : 'حذف'} ${entityType === 'transaction' ? 'معاملة' : entityType === 'customer' ? 'عميل' : 'حساب'}`,
      },
      data: {
        type: 'sync_required',
        entityType: entityType,
        action: action,
        entityId: entityId || '',
        firebaseUid: firebaseUid,
        timestamp: Date.now().toString()
      },
      android: {
        priority: 'high',
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
      },
    };

    // إرسال إشعار لكل token
    const notificationPromises = tokens.map(async (token) => {
      try {
        const response = await admin.messaging().send({
          ...message,
          token: token
        });
        console.log(`✅ FCM notification sent successfully to token ${token.substring(0, 20)}...: ${response}`);
      } catch (error) {
        // معالجة الأخطاء الشائعة
        if (error.code === 'messaging/invalid-registration-token' || 
            error.code === 'messaging/registration-token-not-registered') {
          console.warn(`⚠️ Invalid or unregistered token ${token.substring(0, 20)}... - consider removing it from database`);
        } else {
          console.error(`❌ Error sending FCM notification to token ${token.substring(0, 20)}...:`, error.message);
        }
      }
    });

    await Promise.allSettled(notificationPromises);
  } catch (error) {
    console.error('❌ Error in sendSyncNotification:', error);
    // لا نرمي خطأ هنا حتى لا نؤثر على العملية الأساسية
  }
}

/**
 * تسجيل العملية في audit_log
 */
async function logAudit(userId, firebaseUid, actionType, entityType, entityId, oldValues = null, newValues = null, req = null) {
  try {
    await pool.query(
      `INSERT INTO audit_log (
        user_id, firebase_uid, action_type, entity_type, entity_id,
        old_values, new_values, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        firebaseUid,
        actionType,
        entityType,
        entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        req?.ip || req?.connection?.remoteAddress || null,
        req?.get('user-agent') || null
      ]
    );
  } catch (error) {
    console.error('❌ خطأ في تسجيل audit log:', error);
    // لا نرمي خطأ هنا حتى لا نؤثر على العملية الأساسية
  }
}

/**
 * تحويل بيانات المستخدم من قاعدة البيانات إلى تنسيق API
 */
function mapUserToAPI(row) {
  return {
    id: row.user_id,
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
  // ✅ تحسين: استخدام account_uuid كـ firestoreId إذا كان firestore_id فارغاً
  // هذا يضمن أن المعاملات التي تستخدم account_uuid كـ accountFirestoreId يمكنها العثور على الحساب
  const accountUuidStr = row.account_uuid?.toString();
  const firestoreId = row.firestore_id || accountUuidStr; // استخدام account_uuid كبديل إذا كان firestore_id فارغاً
  
  return {
    id: row.account_id,
    entryId: accountUuidStr || row.entry_id, // للتوافق
    accountUuid: accountUuidStr,
    cloudId: row.cloud_id,
    firestoreId: firestoreId, // ✅ الآن يحتوي على account_uuid إذا كان firestore_id فارغاً
    ownerUserId: row.owner_user_id,
    ownerFirebaseUid: row.owner_firebase_uid,
    name: row.account_name,
    accountName: row.account_name,
    isPrimary: booleanToInt(row.is_primary),
    isShared: booleanToInt(row.is_shared),
    color: row.color_code ? (row.color_code.startsWith('#') ? row.color_code : '#' + row.color_code) : null,
    colorCode: row.color_code ? (row.color_code.startsWith('#') ? row.color_code : '#' + row.color_code) : null,
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
    deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
  };
}

// ==================== 5. Routes - Authentication ====================

/**
 * POST /api/auth/login
 * تسجيل الدخول وإنشاء JWT token
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    
    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        error: 'رقم الهاتف وكلمة المرور مطلوبان'
      });
    }
    
    // البحث عن المستخدم
    const result = await pool.query(
      'SELECT * FROM app_users WHERE phone_number = $1 AND deleted_at IS NULL',
      [phone]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'رقم الهاتف أو كلمة المرور غير صحيحة'
      });
    }
    
    const user = result.rows[0];
    
    // التحقق من كلمة المرور (PBKDF2/Legacy)
    if (!verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({
        success: false,
        error: 'رقم الهاتف أو كلمة المرور غير صحيحة'
      });
    }
    
    // تحديث last_login_at
    await pool.query(
      'UPDATE app_users SET last_login_at = CURRENT_TIMESTAMP WHERE user_id = $1',
      [user.user_id]
    );
    
    // إنشاء JWT token
    const token = generateToken(user.user_id, user.firebase_uid);
    
    // تسجيل العملية
    await logAudit(user.user_id, user.firebase_uid, 'login', 'user', user.user_id.toString(), null, null, req);
    
    res.json({
      success: true,
      data: {
        token,
        user: mapUserToAPI(user)
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 6. Routes - Users ====================

/**
 * GET /api/users/:userId
 * الحصول على مستخدم محدد
 */
app.get('/api/users/:userId', optionalAuthenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // التحقق من أن userId ليس كلمة محجوزة
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(userId.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid user ID: "${userId}" is a reserved word`
      });
    }
    
    // التحقق من أن userId هو رقم
    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid user ID format: "${userId}" must be a number`
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM app_users WHERE user_id = $1 AND deleted_at IS NULL',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/users/by-uuid/:userUuid
 * الحصول على مستخدم حسب UUID
 */
app.get('/api/users/by-uuid/:userUuid', optionalAuthenticate, async (req, res) => {
  try {
    const { userUuid } = req.params;
    const result = await pool.query(
      'SELECT * FROM app_users WHERE user_uuid = $1 AND deleted_at IS NULL',
      [userUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/users/by-firebase/:firebaseUid
 * الحصول على مستخدم حسب firebase_uid
 */
app.get('/api/users/by-firebase/:firebaseUid', optionalAuthenticate, async (req, res) => {
  try {
    const { firebaseUid } = req.params;
    if (!firebaseUid) {
      return res.status(400).json({ success: false, error: 'firebaseUid مطلوب' });
    }
    const result = await pool.query(
      'SELECT * FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL',
      [firebaseUid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }
    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/users/by-phone/:phone
 * الحصول على مستخدم حسب رقم الهاتف
 */
app.get('/api/users/by-phone/:phone', optionalAuthenticate, async (req, res) => {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone مطلوب' });
    }
    const result = await pool.query(
      'SELECT * FROM app_users WHERE phone_number = $1 AND deleted_at IS NULL LIMIT 1',
      [phone]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }
    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/users
 * إنشاء مستخدم جديد
 */
app.post('/api/users', async (req, res) => {
  try {
    const userData = ensureUuid(req.body);
    
    // التحقق من الحقول المطلوبة
    if (!userData.name && !userData.fullName) {
      return res.status(400).json({ success: false, error: 'name أو fullName مطلوب' });
    }
    if (!userData.phone && !userData.phoneNumber) {
      return res.status(400).json({ success: false, error: 'phone أو phoneNumber مطلوب' });
    }
    if (!userData.passwordHash) {
      return res.status(400).json({ success: false, error: 'passwordHash مطلوب' });
    }
    if (!userData.passwordSalt) {
      return res.status(400).json({ success: false, error: 'passwordSalt مطلوب' });
    }
    
    // التأكد من وجود UUID صحيح
    const userUuid = (userData.userUuid && isValidUUID(userData.userUuid)) 
      ? userData.userUuid 
      : ((userData.entryId && isValidUUID(userData.entryId)) 
          ? userData.entryId 
          : uuidv4());
    
    // ✅ توليد رقم الحساب تلقائياً في السيرفر إذا لم يتم إرساله
    let accountNumber = userData.accountNumber;
    if (!accountNumber) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // قفل منطقي لتجنب التنافس
        await client.query('SELECT pg_advisory_xact_lock(424242)');
        
        // البحث عن أكبر رقم حساب في app_users
        const maxResult = await client.query('SELECT MAX(account_number) AS max FROM app_users WHERE deleted_at IS NULL');
        const maxFromUsers = maxResult.rows[0]?.max ? parseInt(maxResult.rows[0].max, 10) : 0;
        
        // البحث عن أكبر رقم حساب في account_numbers_registry
        const registryResult = await client.query('SELECT MAX(account_number) AS max FROM account_numbers_registry');
        const maxFromRegistry = registryResult.rows[0]?.max ? parseInt(registryResult.rows[0].max, 10) : 0;
        
        // استخدام أكبر رقم + 1
        const maxNumber = Math.max(maxFromUsers, maxFromRegistry, 0);
        accountNumber = maxNumber + 1;
        
        // تسجيل رقم الحساب في account_numbers_registry
        await client.query(
          `INSERT INTO account_numbers_registry (
            account_number, user_id, user_name, phone_number, firebase_uid, is_active, created_at
          ) VALUES ($1, NULL, $2, $3, $4, TRUE, CURRENT_TIMESTAMP)
          ON CONFLICT (account_number) DO NOTHING`,
          [
            accountNumber,
            userData.name || userData.fullName || null,
            userData.phone || userData.phoneNumber || null,
            userData.firebaseUid || null
          ]
        );
        
        await client.query('COMMIT');
        console.log(`🔢 Generated account number on server: ${accountNumber}`);
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`❌ Failed to generate account number:`, error);
        throw error;
      } finally {
        client.release();
      }
    }
    
    const createdAtSeconds = msToSeconds(userData.createdAt || Date.now());
    console.log(`📝 Creating new user (POST): uuid=${userUuid}, firebaseUid=${userData.firebaseUid}, name=${userData.name || userData.fullName}, phone=${userData.phone || userData.phoneNumber}, accountNumber=${accountNumber}, createdAt=${createdAtSeconds}`);
    
    const result = await pool.query(
      `INSERT INTO app_users (
        user_uuid, firebase_uid, full_name, phone_number, job_title, 
        password_hash, password_salt, account_number, 
        created_at, app_version_name, app_version_code,
        device_model, device_brand, device_manufacturer, 
        device_sdk_int, push_token, receive_transaction_notifications, sync_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        userUuid,
        userData.firebaseUid || null,
        userData.name || userData.fullName,
        userData.phone || userData.phoneNumber,
        userData.jobTitle || null,
        userData.passwordHash,
        userData.passwordSalt,
        accountNumber, // ✅ تم توليده في السيرفر
        createdAtSeconds, // $9 - سيتم تحويله إلى timestamp في SQL
        userData.appVersionName || null,
        userData.appVersionCode || null,
        userData.deviceModel || null,
        userData.deviceBrand || null,
        userData.deviceManufacturer || null,
        userData.deviceSdkInt || null,
        userData.accountPushToken || userData.pushToken || null,
        intToBoolean(userData.receiveTransactionNotifications !== undefined ? userData.receiveTransactionNotifications : 1),
        userData.syncVersion || 1
      ]
    );

    const user = result.rows[0];
    
    // تسجيل العملية
    await logAudit(user.user_id, user.firebase_uid, 'create', 'user', user.user_id.toString(), null, user, req);

    // إنشاء JWT token للمستخدم الجديد
    const token = generateToken(user.user_id, user.firebase_uid);
    
    console.log(`✅ User created successfully: user_id=${user.user_id}, firebase_uid=${user.firebase_uid}, accountNumber=${user.account_number}, token generated`);

    res.status(201).json({ 
      success: true, 
      data: {
        token,
        user: mapUserToAPI(user)
      }
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'المستخدم موجود بالفعل (رقم الهاتف أو UUID مكرر)' });
    }
    handleError(res, error);
  }
});

/**
 * PUT /api/users/sync
 * مزامنة مستخدم (Insert or Update حسب UUID)
 */
app.put('/api/users/sync', syncLimiter, optionalAuthenticate, async (req, res) => {
  try {
    const userData = ensureUuid(req.body);
    const uuid = userData.userUuid || (userData.entryId && isValidUUID(userData.entryId) ? userData.entryId : uuidv4());
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'userUuid أو entryId مطلوب' });
    }
    
    // البحث عن المستخدم بناءً على user_uuid أولاً
    let existing = await pool.query(
      'SELECT user_id, sync_version, updated_at, user_uuid, firebase_uid FROM app_users WHERE user_uuid = $1',
      [uuid]
    );
    
    // إذا لم يوجد بناءً على user_uuid، ابحث بناءً على firebase_uid
    if (existing.rows.length === 0 && userData.firebaseUid) {
      console.log(`🔍 User not found by uuid=${uuid}, searching by firebase_uid=${userData.firebaseUid}`);
      existing = await pool.query(
        'SELECT user_id, sync_version, updated_at, user_uuid, firebase_uid FROM app_users WHERE firebase_uid = $1',
        [userData.firebaseUid]
      );
      
      // إذا وُجد المستخدم بناءً على firebase_uid، استخدم user_uuid الخاص به
      if (existing.rows.length > 0) {
        const foundUser = existing.rows[0];
        console.log(`✅ Found existing user by firebase_uid: user_id=${foundUser.user_id}, user_uuid=${foundUser.user_uuid}`);
        // استخدم user_uuid الموجود بدلاً من uuid الجديد
        const existingUuid = foundUser.user_uuid;
        
        // تحديث المستخدم الموجود
        const existingUser = existing.rows[0];
        
        // حل التعارضات إذا لزم الأمر
        if (userData.syncVersion && existingUser.sync_version) {
          const conflictResult = await resolveConflict('app_users', existingUuid, userData, {
            syncVersion: existingUser.sync_version,
            updatedAt: secondsToMs(existingUser.updated_at)
          });
          if (conflictResult.winner !== userData) {
            const remoteUser = await pool.query('SELECT * FROM app_users WHERE user_uuid = $1', [existingUuid]);
            const user = remoteUser.rows[0];
            return res.json({ success: true, data: mapUserToAPI(user), action: 'conflict_resolved', conflict: true, conflictReason: conflictResult.reason });
          }
        }
        
        // تحديث المستخدم الموجود
        const result = await pool.query(
          `UPDATE app_users SET
            firebase_uid = COALESCE($2, firebase_uid),
            full_name = $3,
            phone_number = $4,
            job_title = $5,
            password_hash = COALESCE($6, password_hash),
            password_salt = COALESCE($7, password_salt),
            account_number = COALESCE($8, account_number),
            app_version_name = COALESCE($9, app_version_name),
            app_version_code = COALESCE($10, app_version_code),
            device_model = COALESCE($11, device_model),
            device_brand = COALESCE($12, device_brand),
            device_manufacturer = COALESCE($13, device_manufacturer),
            device_sdk_int = COALESCE($14, device_sdk_int),
            push_token = COALESCE($15, push_token),
            receive_transaction_notifications = COALESCE($16, receive_transaction_notifications),
            sync_version = COALESCE($17, sync_version) + 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_uuid = $1
          RETURNING *`,
          [
            existingUuid,
            userData.firebaseUid,
            userData.name || userData.fullName,
            userData.phone || userData.phoneNumber,
            userData.jobTitle || '',
            userData.passwordHash,
            userData.passwordSalt,
            userData.accountNumber,
            userData.appVersionName,
            userData.appVersionCode,
            userData.deviceModel,
            userData.deviceBrand,
            userData.deviceManufacturer,
            userData.deviceSdkInt,
            userData.accountPushToken || userData.pushToken,
            intToBoolean(userData.receiveTransactionNotifications),
            userData.syncVersion || existingUser.sync_version || 0
          ]
        );

        const user = result.rows[0];
        
        // تسجيل العملية
        await logAudit(user.user_id, user.firebase_uid, 'update', 'user', user.user_id.toString(), existingUser, user, req);
        
        return res.json({ success: true, data: mapUserToAPI(user), action: 'updated' });
      }
    }
    
    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      
      // حل التعارضات إذا لزم الأمر
      if (userData.syncVersion && existingUser.sync_version) {
        const conflictResult = await resolveConflict('app_users', uuid, userData, {
          syncVersion: existingUser.sync_version,
          updatedAt: secondsToMs(existingUser.updated_at)
        });
        if (conflictResult.winner !== userData) {
          const remoteUser = await pool.query('SELECT * FROM app_users WHERE user_uuid = $1', [uuid]);
          const user = remoteUser.rows[0];
          return res.json({ success: true, data: mapUserToAPI(user), action: 'conflict_resolved', conflict: true, conflictReason: conflictResult.reason });
        }
      }
      
      // تحديث المستخدم الموجود
      const result = await pool.query(
        `UPDATE app_users SET
          firebase_uid = COALESCE($2, firebase_uid),
          full_name = $3,
          phone_number = $4,
          job_title = $5,
          password_hash = COALESCE($6, password_hash),
          password_salt = COALESCE($7, password_salt),
          account_number = COALESCE($8, account_number),
          app_version_name = COALESCE($9, app_version_name),
          app_version_code = COALESCE($10, app_version_code),
          device_model = COALESCE($11, device_model),
          device_brand = COALESCE($12, device_brand),
          device_manufacturer = COALESCE($13, device_manufacturer),
          device_sdk_int = COALESCE($14, device_sdk_int),
          push_token = COALESCE($15, push_token),
          receive_transaction_notifications = COALESCE($16, receive_transaction_notifications),
          sync_version = COALESCE($17, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_uuid = $1
        RETURNING *`,
        [
          uuid,
          userData.firebaseUid,
          userData.name || userData.fullName,
          userData.phone || userData.phoneNumber,
          userData.jobTitle || '',
          userData.passwordHash,
          userData.passwordSalt,
          userData.accountNumber,
          userData.appVersionName,
          userData.appVersionCode,
          userData.deviceModel,
          userData.deviceBrand,
          userData.deviceManufacturer,
          userData.deviceSdkInt,
          userData.accountPushToken || userData.pushToken,
          intToBoolean(userData.receiveTransactionNotifications),
          userData.syncVersion || existingUser.sync_version || 0
        ]
      );

      const user = result.rows[0];
      
      // تسجيل العملية
      await logAudit(user.user_id, user.firebase_uid, 'update', 'user', user.user_id.toString(), existingUser, user, req);
      
      return res.json({ success: true, data: mapUserToAPI(user), action: 'updated' });
    } else {
      // التحقق من الحقول المطلوبة
      if (!userData.name && !userData.fullName) {
        return res.status(400).json({ success: false, error: 'name أو fullName مطلوب' });
      }
      if (!userData.phone && !userData.phoneNumber) {
        return res.status(400).json({ success: false, error: 'phone أو phoneNumber مطلوب' });
      }
      if (!userData.passwordHash) {
        return res.status(400).json({ success: false, error: 'passwordHash مطلوب' });
      }
      if (!userData.passwordSalt) {
        return res.status(400).json({ success: false, error: 'passwordSalt مطلوب' });
      }
      if (!userData.accountNumber) {
        return res.status(400).json({ success: false, error: 'accountNumber مطلوب' });
      }
      
      // التحقق من وجود مستخدم بنفس firebase_uid قبل الإنشاء
      if (userData.firebaseUid) {
        const duplicateCheck = await pool.query(
          'SELECT user_id, user_uuid FROM app_users WHERE firebase_uid = $1',
          [userData.firebaseUid]
        );
        
        if (duplicateCheck.rows.length > 0) {
          const existingUser = duplicateCheck.rows[0];
          console.log(`⚠️ User with firebase_uid=${userData.firebaseUid} already exists (user_id=${existingUser.user_id}, user_uuid=${existingUser.user_uuid}). Updating instead of creating.`);
          
          // تحديث المستخدم الموجود بدلاً من إنشاء جديد
          const result = await pool.query(
            `UPDATE app_users SET
              user_uuid = COALESCE($2, user_uuid),
              full_name = $3,
              phone_number = $4,
              job_title = $5,
              password_hash = COALESCE($6, password_hash),
              password_salt = COALESCE($7, password_salt),
              account_number = COALESCE($8, account_number),
              app_version_name = COALESCE($9, app_version_name),
              app_version_code = COALESCE($10, app_version_code),
              device_model = COALESCE($11, device_model),
              device_brand = COALESCE($12, device_brand),
              device_manufacturer = COALESCE($13, device_manufacturer),
              device_sdk_int = COALESCE($14, device_sdk_int),
              push_token = COALESCE($15, push_token),
              receive_transaction_notifications = COALESCE($16, receive_transaction_notifications),
              sync_version = COALESCE($17, sync_version) + 1,
              updated_at = CURRENT_TIMESTAMP
            WHERE firebase_uid = $1
            RETURNING *`,
            [
              userData.firebaseUid,
              uuid,
              userData.name || userData.fullName,
              userData.phone || userData.phoneNumber,
              userData.jobTitle || '',
              userData.passwordHash,
              userData.passwordSalt,
              userData.accountNumber,
              userData.appVersionName,
              userData.appVersionCode,
              userData.deviceModel,
              userData.deviceBrand,
              userData.deviceManufacturer,
              userData.deviceSdkInt,
              userData.accountPushToken || userData.pushToken,
              intToBoolean(userData.receiveTransactionNotifications !== undefined ? userData.receiveTransactionNotifications : 1),
              userData.syncVersion || 1
            ]
          );

          const user = result.rows[0];
          
          // تسجيل العملية
          await logAudit(user.user_id, user.firebase_uid, 'update', 'user', user.user_id.toString(), existingUser, user, req);
          
          return res.json({ success: true, data: mapUserToAPI(user), action: 'updated' });
        }
      }
      
      // إنشاء مستخدم جديد
      const createdAtSeconds = msToSeconds(userData.createdAt || Date.now());
      console.log(`📝 Creating new user: uuid=${uuid}, firebaseUid=${userData.firebaseUid}, name=${userData.name || userData.fullName}, phone=${userData.phone || userData.phoneNumber}, createdAt=${createdAtSeconds}`);
      
      const result = await pool.query(
        `INSERT INTO app_users (
          user_uuid, firebase_uid, full_name, phone_number, job_title,
          password_hash, password_salt, account_number,
          created_at, app_version_name, app_version_code,
          device_model, device_brand, device_manufacturer,
          device_sdk_int, push_token, receive_transaction_notifications, sync_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *`,
        [
          uuid,
          userData.firebaseUid || null,
          userData.name || userData.fullName,
          userData.phone || userData.phoneNumber,
          userData.jobTitle || null,
          userData.passwordHash,
          userData.passwordSalt,
          userData.accountNumber,
          createdAtSeconds, // $9 - سيتم تحويله إلى timestamp في SQL
          userData.appVersionName || null,
          userData.appVersionCode || null,
          userData.deviceModel || null,
          userData.deviceBrand || null,
          userData.deviceManufacturer || null,
          userData.deviceSdkInt || null,
          userData.accountPushToken || userData.pushToken || null,
          intToBoolean(userData.receiveTransactionNotifications !== undefined ? userData.receiveTransactionNotifications : 1),
          userData.syncVersion || 1
        ]
      );

      const user = result.rows[0];
      
      // تسجيل العملية
      await logAudit(user.user_id, user.firebase_uid, 'create', 'user', user.user_id.toString(), null, user, req);
      
      return res.json({ success: true, data: mapUserToAPI(user), action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 6.5 Routes - Account Numbers ====================

/**
 * POST /api/account-numbers/next
 * الحصول على رقم حساب جديد (محجوز)
 */
app.post('/api/account-numbers/next', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, userName, phone, firebaseUid } = req.body || {};

    await client.query('BEGIN');
    // قفل منطقي لتجنب التنافس
    await client.query('SELECT pg_advisory_xact_lock(424242)');

    const result = await client.query('SELECT MAX(account_number) AS max FROM account_numbers_registry');
    const maxNumber = result.rows[0]?.max ? parseInt(result.rows[0].max, 10) : 0;
    const nextNumber = (Number.isFinite(maxNumber) ? maxNumber : 0) + 1;

    await client.query(
      `INSERT INTO account_numbers_registry (
        account_number, user_id, user_name, phone_number, firebase_uid, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP)
      ON CONFLICT (account_number) DO NOTHING`,
      [
        nextNumber,
        userId || null,
        userName || null,
        phone || null,
        firebaseUid || null
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, data: { accountNumber: nextNumber } });
  } catch (error) {
    await client.query('ROLLBACK');
    handleError(res, error);
  } finally {
    client.release();
  }
});

// ==================== 7. Routes - Clients (Customers) ====================

/**
 * GET /api/clients
 * الحصول على جميع العملاء لمستخدم محدد
 * يدعم المزامنة التزايدية باستخدام sinceTimestamp
 */
app.get('/api/clients', optionalAuthenticate, async (req, res) => {
  try {
    const { ownerUserId, ownerFirebaseUid, archived, sinceTimestamp } = req.query;
    
    let query = 'SELECT * FROM business_clients WHERE deleted_at IS NULL';
    const params = [];
    let paramIndex = 1;
    
    if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
    }
    if (ownerFirebaseUid) {
      query += ` AND owner_firebase_uid = $${paramIndex++}`;
      params.push(ownerFirebaseUid);
    }
    if (archived !== undefined) {
      query += ` AND is_archived = $${paramIndex++}`;
      params.push(intToBoolean(archived));
    }
    
    // ✅ دعم المزامنة التزايدية: جلب البيانات المحدثة بعد timestamp معين
    if (sinceTimestamp) {
      const sinceSeconds = msToSeconds(parseInt(sinceTimestamp));
      if (sinceSeconds) {
        query += ` AND updated_at > to_timestamp($${paramIndex++})`;
        params.push(sinceSeconds);
      }
    }
    
    query += ' ORDER BY updated_at DESC, created_at DESC';
    const result = await pool.query(query, params);
    
    const clients = result.rows.map(row => mapClientToAPI(row));
    
    res.json({ success: true, data: clients, count: clients.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/clients/:clientId
 * الحصول على عميل محدد
 */
app.get('/api/clients/:clientId', optionalAuthenticate, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // التحقق من أن clientId ليس كلمة محجوزة
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(clientId.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid client ID: "${clientId}" is a reserved word`
      });
    }
    
    // التحقق من أن clientId هو رقم
    if (!/^\d+$/.test(clientId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid client ID format: "${clientId}" must be a number`
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM business_clients WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }
    res.json({ success: true, data: mapClientToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/clients
 * إنشاء عميل جديد
 */
app.post('/api/clients', optionalAuthenticate, async (req, res) => {
  try {
    const clientData = ensureUuid(req.body);
    
    const result = await pool.query(
      `INSERT INTO business_clients (
        client_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_name, phone_number, job_title, notes, is_archived,
        device_id, sync_version, created_at, updated_at, cached_total_balance
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_timestamp($13), to_timestamp($14), $15)
      RETURNING *`,
      [
        (clientData.clientUuid && isValidUUID(clientData.clientUuid)) ? clientData.clientUuid : ((clientData.entryId && isValidUUID(clientData.entryId)) ? clientData.entryId : uuidv4()),
        clientData.cloudId || null,
        clientData.firestoreId || null,
        clientData.ownerUserId,
        clientData.ownerFirebaseUid || null,
        clientData.name || clientData.clientName,
        clientData.phone || clientData.phoneNumber || null,
        clientData.jobTitle || null,
        clientData.notes || null,
        intToBoolean(clientData.archived !== undefined ? clientData.archived : 0),
        clientData.deviceId || null,
        clientData.syncVersion || 1,
        msToSeconds(clientData.createdAt || Date.now()), // $13 - سيتم تحويله إلى timestamp في SQL
        msToSeconds(clientData.updatedAt || Date.now()), // $14 - سيتم تحويله إلى timestamp في SQL
        clientData.cachedTotalBalance || null
      ]
    );
    
    const client = result.rows[0];
    
    // تسجيل العملية
    await logAudit(
      client.owner_user_id, 
      client.owner_firebase_uid, 
      'create', 
      'client', 
      client.client_id.toString(), 
      null, 
      client, 
      req
    );
    
    res.status(201).json({ success: true, data: mapClientToAPI(client) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * DELETE /api/clients/by-uuid/:clientUuid
 * حذف عميل (Soft Delete) حسب UUID
 */
app.delete('/api/clients/by-uuid/:clientUuid', optionalAuthenticate, async (req, res) => {
  try {
    const { clientUuid } = req.params;
    if (!clientUuid) {
      return res.status(400).json({ success: false, error: 'clientUuid مطلوب' });
    }

    const result = await pool.query(
      `UPDATE business_clients
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE client_uuid = $1 AND deleted_at IS NULL
       RETURNING *`,
      [clientUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    const client = result.rows[0];
    await logAudit(client.owner_user_id, client.owner_firebase_uid, 'delete', 'client', client.client_id.toString(), null, client, req);
    res.json({ success: true, data: mapClientToAPI(client) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PUT /api/clients/sync
 * مزامنة عميل (Insert or Update حسب UUID)
 */
app.put('/api/clients/sync', syncLimiter, optionalAuthenticate, async (req, res) => {
  try {
    const clientData = ensureUuid(req.body);
    const uuid = clientData.clientUuid || (clientData.entryId && isValidUUID(clientData.entryId) ? clientData.entryId : uuidv4());
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'clientUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT client_id, sync_version, updated_at FROM business_clients WHERE client_uuid = $1',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingClient = existing.rows[0];
      
      // حل التعارضات
      if (clientData.syncVersion && existingClient.sync_version) {
        const conflictResult = await resolveConflict('business_clients', uuid, clientData, {
          syncVersion: existingClient.sync_version,
          updatedAt: secondsToMs(existingClient.updated_at)
        });
        if (conflictResult.winner !== clientData) {
          const remoteClient = await pool.query('SELECT * FROM business_clients WHERE client_uuid = $1', [uuid]);
          const client = remoteClient.rows[0];
          return res.json({ success: true, data: mapClientToAPI(client), action: 'conflict_resolved', conflict: true, conflictReason: conflictResult.reason });
        }
      }
      
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(clientData.ownerUserId, clientData.ownerFirebaseUid);
      
      // تحديث العميل الموجود
      const result = await pool.query(
        `UPDATE business_clients SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = COALESCE($4, owner_user_id),
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          client_name = $6,
          phone_number = COALESCE($7, phone_number),
          job_title = $8,
          notes = COALESCE($9, notes),
          is_archived = COALESCE($10, is_archived),
          device_id = COALESCE($11, device_id),
          sync_version = COALESCE($12, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP,
          cached_total_balance = COALESCE($13, cached_total_balance)
        WHERE client_uuid = $1
        RETURNING *`,
        [
          uuid,
          clientData.cloudId,
          clientData.firestoreId,
          ownerUserId,
          clientData.ownerFirebaseUid,
          clientData.name || clientData.clientName,
          clientData.phone || clientData.phoneNumber,
          clientData.jobTitle,
          clientData.notes,
          intToBoolean(clientData.archived),
          clientData.deviceId,
          clientData.syncVersion || existingClient.sync_version || 0,
          clientData.cachedTotalBalance
        ]
      );
      
      const client = result.rows[0];
      
      // تسجيل العملية
      await logAudit(
        client.owner_user_id, 
        client.owner_firebase_uid, 
        'update', 
        'client', 
        client.client_id.toString(), 
        existingClient, 
        client, 
        req
      );
      
      // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
      await sendSyncNotification(client.owner_firebase_uid, clientData.deviceId, 'customer', 'updated', client.client_uuid?.toString());
      
      return res.json({ success: true, data: mapClientToAPI(client), action: 'updated' });
    } else {
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(clientData.ownerUserId, clientData.ownerFirebaseUid);
      
      // إنشاء عميل جديد
      const result = await pool.query(
        `INSERT INTO business_clients (
          client_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          client_name, phone_number, job_title, notes, is_archived,
          device_id, sync_version, created_at, updated_at, cached_total_balance
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_timestamp($13), CURRENT_TIMESTAMP, $14)
        RETURNING *`,
        [
          uuid,
          clientData.cloudId || null,
          clientData.firestoreId || null,
          ownerUserId,
          clientData.ownerFirebaseUid || null,
          clientData.name || clientData.clientName,
          clientData.phone || clientData.phoneNumber || null,
          clientData.jobTitle || null,
          clientData.notes || null,
          intToBoolean(clientData.archived !== undefined ? clientData.archived : 0),
          clientData.deviceId || null,
          clientData.syncVersion || 1,
          msToSeconds(clientData.createdAt || Date.now()), // $13 - سيتم تحويله إلى timestamp في SQL
          clientData.cachedTotalBalance || null
        ]
      );
      
      const client = result.rows[0];
      
      // تسجيل العملية
      await logAudit(
        client.owner_user_id, 
        client.owner_firebase_uid, 
        'create', 
        'client', 
        client.client_id.toString(), 
        null, 
        client, 
        req
      );
      
      // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
      await sendSyncNotification(client.owner_firebase_uid, clientData.deviceId, 'customer', 'created', client.client_uuid?.toString());
      
      return res.json({ success: true, data: mapClientToAPI(client), action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 8. Routes - Cash Accounts ====================

/**
 * GET /api/accounts
 * الحصول على جميع الحسابات النقدية
 * يدعم المزامنة التزايدية باستخدام sinceTimestamp
 */
app.get('/api/accounts', optionalAuthenticate, async (req, res) => {
  try {
    const { ownerUserId, ownerFirebaseUid, sinceTimestamp } = req.query;
    
    let query = 'SELECT * FROM cash_accounts WHERE deleted_at IS NULL';
    const params = [];
    let paramIndex = 1;
    
    if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
    }
    if (ownerFirebaseUid) {
      query += ` AND owner_firebase_uid = $${paramIndex++}`;
      params.push(ownerFirebaseUid);
    }
    
    // ✅ دعم المزامنة التزايدية: جلب البيانات المحدثة بعد timestamp معين
    if (sinceTimestamp) {
      const sinceSeconds = msToSeconds(parseInt(sinceTimestamp));
      if (sinceSeconds) {
        query += ` AND updated_at > to_timestamp($${paramIndex++})`;
        params.push(sinceSeconds);
      }
    }
    
    query += ' ORDER BY is_primary DESC, updated_at DESC, created_at ASC';
    const result = await pool.query(query, params);
    
    const accounts = result.rows.map(row => mapAccountToAPI(row));
    
    res.json({ success: true, data: accounts, count: accounts.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PUT /api/accounts/sync
 * مزامنة حساب نقدي
 */
app.put('/api/accounts/sync', syncLimiter, optionalAuthenticate, async (req, res) => {
  try {
    const accountData = ensureUuid(req.body);
    const uuid = accountData.accountUuid || (accountData.entryId && isValidUUID(accountData.entryId) ? accountData.entryId : uuidv4());
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'accountUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT account_id, sync_version, updated_at FROM cash_accounts WHERE account_uuid = $1',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingAccount = existing.rows[0];
      
      // حل التعارضات
      if (accountData.syncVersion && existingAccount.sync_version) {
        const conflictResult = await resolveConflict('cash_accounts', uuid, accountData, {
          syncVersion: existingAccount.sync_version,
          updatedAt: secondsToMs(existingAccount.updated_at)
        });
        if (conflictResult.winner !== accountData) {
          const remoteAccount = await pool.query('SELECT * FROM cash_accounts WHERE account_uuid = $1', [uuid]);
          const account = remoteAccount.rows[0];
          return res.json({ success: true, data: mapAccountToAPI(account), action: 'conflict_resolved', conflict: true, conflictReason: conflictResult.reason });
        }
      }
      
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(accountData.ownerUserId, accountData.ownerFirebaseUid);
      
      const result = await pool.query(
        `UPDATE cash_accounts SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = COALESCE($4, owner_user_id),
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          account_name = $6,
          is_primary = COALESCE($7, is_primary),
          is_shared = COALESCE($8, is_shared),
          color_code = $9,
          device_id = COALESCE($10, device_id),
          sync_version = COALESCE($11, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE account_uuid = $1
        RETURNING *`,
        [
          uuid,
          accountData.cloudId,
          accountData.firestoreId,
          ownerUserId,
          accountData.ownerFirebaseUid,
          accountData.name || accountData.accountName,
          intToBoolean(accountData.isPrimary),
          intToBoolean(accountData.isShared),
          normalizeColorCode(accountData.color || accountData.colorCode),
          accountData.deviceId,
          accountData.syncVersion || existingAccount.sync_version || 0
        ]
      );
      
      const account = result.rows[0];
      
      // تسجيل العملية
      await logAudit(
        account.owner_user_id, 
        account.owner_firebase_uid, 
        'update', 
        'account', 
        account.account_id.toString(), 
        existingAccount, 
        account, 
        req
      );
      
      // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
      await sendSyncNotification(account.owner_firebase_uid, accountData.deviceId, 'account', 'updated', account.account_uuid?.toString());
      
      return res.json({ success: true, data: mapAccountToAPI(account), action: 'updated' });
    } else {
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(accountData.ownerUserId, accountData.ownerFirebaseUid);
      
      // التحقق من أن ownerUserId موجود
      if (!ownerUserId) {
        console.error('❌ ownerUserId is null in INSERT account. accountData:', JSON.stringify(accountData, null, 2));
        return res.status(400).json({
          success: false,
          error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات. يرجى التأكد من أن المستخدم مسجل في النظام.'
        });
      }
      
      const result = await pool.query(
        `INSERT INTO cash_accounts (
          account_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          account_name, is_primary, is_shared, color_code,
          device_id, sync_version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12), CURRENT_TIMESTAMP)
        RETURNING *`,
        [
          uuid,
          accountData.cloudId || null,
          accountData.firestoreId || null,
          ownerUserId,
          accountData.ownerFirebaseUid || null,
          accountData.name || accountData.accountName,
          intToBoolean(accountData.isPrimary !== undefined ? accountData.isPrimary : 0),
          intToBoolean(accountData.isShared !== undefined ? accountData.isShared : 0),
          normalizeColorCode(accountData.color || accountData.colorCode),
          accountData.deviceId || null,
          accountData.syncVersion || 1,
          msToSeconds(accountData.createdAt || Date.now()) // $12 - سيتم تحويله إلى timestamp في SQL
        ]
      );
      
      const account = result.rows[0];
      
      // تسجيل العملية
      await logAudit(
        account.owner_user_id, 
        account.owner_firebase_uid, 
        'create', 
        'account', 
        account.account_id.toString(), 
        null, 
        account, 
        req
      );
      
      // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
      await sendSyncNotification(account.owner_firebase_uid, accountData.deviceId, 'account', 'created', account.account_uuid?.toString());
      
      return res.json({ success: true, data: mapAccountToAPI(account), action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 8.5 Routes - Accounts Delete ====================

/**
 * DELETE /api/accounts/by-uuid/:accountUuid
 * حذف حساب (Soft Delete) حسب UUID
 */
app.delete('/api/accounts/by-uuid/:accountUuid', optionalAuthenticate, async (req, res) => {
  try {
    const { accountUuid } = req.params;
    if (!accountUuid) {
      return res.status(400).json({ success: false, error: 'accountUuid مطلوب' });
    }

    const result = await pool.query(
      `UPDATE cash_accounts
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE account_uuid = $1 AND deleted_at IS NULL
       RETURNING *`,
      [accountUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
    }

    const account = result.rows[0];
    await logAudit(account.owner_user_id, account.owner_firebase_uid, 'delete', 'account', account.account_id.toString(), null, account, req);
    res.json({ success: true, data: mapAccountToAPI(account) });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 9. Routes - Transactions ====================

/**
 * GET /api/transactions
 * الحصول على المعاملات
 * يدعم المزامنة التزايدية باستخدام sinceTimestamp
 */
app.get('/api/transactions', optionalAuthenticate, async (req, res) => {
  try {
    const { ownerUserId, ownerFirebaseUid, customerId, clientId, accountId, synced, limit, offset, sinceTimestamp } = req.query;
    
    let query = 'SELECT * FROM financial_transactions WHERE deleted_at IS NULL';
    const params = [];
    let paramIndex = 1;
    
    if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
    }
    if (ownerFirebaseUid) {
      query += ` AND owner_firebase_uid = $${paramIndex++}`;
      params.push(ownerFirebaseUid);
    }
    if (customerId || clientId) {
      query += ` AND client_id = $${paramIndex++}`;
      params.push(customerId || clientId);
    }
    if (accountId) {
      query += ` AND account_id = $${paramIndex++}`;
      params.push(accountId);
    }
    if (synced !== undefined) {
      query += ` AND is_synced = $${paramIndex++}`;
      params.push(intToBoolean(synced));
    }
    
    // ✅ دعم المزامنة التزايدية: جلب البيانات المحدثة بعد timestamp معين
    if (sinceTimestamp) {
      const sinceSeconds = msToSeconds(parseInt(sinceTimestamp));
      if (sinceSeconds) {
        query += ` AND updated_at > to_timestamp($${paramIndex++})`;
        params.push(sinceSeconds);
      }
    }
    
    query += ' ORDER BY updated_at DESC, transaction_date DESC, created_at DESC';
    
    if (limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(parseInt(limit));
    }
    if (offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(parseInt(offset));
    }
    
    const result = await pool.query(query, params);
    
    const transactions = result.rows.map(row => mapTransactionToAPI(row));
    
    res.json({ success: true, data: transactions, count: transactions.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/transactions/by-uuid/:transactionUuid
 * الحصول على معاملة حسب UUID
 */
app.get('/api/transactions/by-uuid/:transactionUuid', optionalAuthenticate, async (req, res) => {
  try {
    const { transactionUuid } = req.params;
    if (!transactionUuid) {
      return res.status(400).json({ success: false, error: 'transactionUuid مطلوب' });
    }
    const result = await pool.query(
      'SELECT * FROM financial_transactions WHERE transaction_uuid = $1 AND deleted_at IS NULL',
      [transactionUuid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    res.json({ success: true, data: mapTransactionToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/transactions/:transactionId
 * الحصول على معاملة محددة
 */
app.get('/api/transactions/:transactionId', optionalAuthenticate, async (req, res) => {
  try {
    const { transactionId } = req.params;
    
    // التحقق من أن transactionId ليس كلمة محجوزة (مثل "sync")
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(transactionId.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID: "${transactionId}" is a reserved word`
      });
    }
    
    // التحقق من أن transactionId هو رقم (BIGINT) أو UUID
    const isNumeric = /^\d+$/.test(transactionId);
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionId);
    
    if (!isNumeric && !isUUID) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID format: "${transactionId}" must be a number or UUID`
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM financial_transactions WHERE transaction_id = $1 AND deleted_at IS NULL',
      [transactionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    res.json({ success: true, data: mapTransactionToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * DELETE /api/transactions/by-uuid/:transactionUuid
 * حذف معاملة (Soft Delete) حسب UUID
 */
app.delete('/api/transactions/by-uuid/:transactionUuid', optionalAuthenticate, async (req, res) => {
  try {
    const { transactionUuid } = req.params;
    if (!transactionUuid) {
      return res.status(400).json({ success: false, error: 'transactionUuid مطلوب' });
    }

    const result = await pool.query(
      `UPDATE financial_transactions
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE transaction_uuid = $1 AND deleted_at IS NULL
       RETURNING *`,
      [transactionUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }

    const transaction = result.rows[0];
    await logAudit(transaction.owner_user_id, transaction.owner_firebase_uid, 'delete', 'transaction', transaction.transaction_id.toString(), null, transaction, req);
    
    // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
    await sendSyncNotification(transaction.owner_firebase_uid, null, 'transaction', 'deleted', transaction.transaction_uuid?.toString());
    
    res.json({ success: true, data: mapTransactionToAPI(transaction) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/transactions
 * إنشاء معاملة جديدة
 */
app.post('/api/transactions', optionalAuthenticate, async (req, res) => {
  try {
    const transactionData = ensureUuid(req.body);
    
    // الحصول على ownerUserId الصحيح
    const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);
    
    const result = await pool.query(
      
      `INSERT INTO financial_transactions (
        transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_id, account_id, client_firestore_id, account_firestore_id,
        transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
        notify_customer, is_synced, device_id, transaction_number, sync_version,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14), $15, $16, $17, $18, $19, to_timestamp($20), CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        (transactionData.transactionUuid && isValidUUID(transactionData.transactionUuid)) ? transactionData.transactionUuid : ((transactionData.entryId && isValidUUID(transactionData.entryId)) ? transactionData.entryId : uuidv4()),
        transactionData.cloudId || null,
        transactionData.firestoreId || null,
        ownerUserId,
        transactionData.ownerFirebaseUid || null,
        transactionData.customerId || transactionData.clientId,
        transactionData.accountId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
        transactionData.accountFirestoreId || null,
        transactionData.amount || transactionData.transactionAmount,
        transactionData.currency || transactionData.currencyCode || 'IQD',
        transactionData.direction || transactionData.transactionDirection,
        transactionData.note || transactionData.transactionNote || null,
        msToSeconds(transactionData.transactionDate || Date.now()), // $14 - سيتم تحويله إلى timestamp في SQL
        intToBoolean(transactionData.notifyCustomer !== undefined ? transactionData.notifyCustomer : 0),
        intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
        transactionData.deviceId || null,
        transactionData.transactionNumber || null,
        transactionData.syncVersion || 1,
        msToSeconds(transactionData.createdAt || Date.now()) // $20 - سيتم تحويله إلى timestamp في SQL
      ]
    );
    
    const transaction = result.rows[0];
    
    // تسجيل العملية
    await logAudit(
      transaction.owner_user_id, 
      transaction.owner_firebase_uid, 
      'create', 
      'transaction', 
      transaction.transaction_id.toString(), 
      null, 
      transaction, 
      req
    );
    
    res.status(201).json({ success: true, data: mapTransactionToAPI(transaction) });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PUT /api/transactions/sync
 * مزامنة معاملة (Insert or Update حسب UUID)
 */
app.put('/api/transactions/sync', syncLimiter, optionalAuthenticate, async (req, res) => {
  try {
    const transactionData = ensureUuid(req.body);
    const uuid = transactionData.transactionUuid || (transactionData.entryId && isValidUUID(transactionData.entryId) ? transactionData.entryId : uuidv4());
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'transactionUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT transaction_id, sync_version, updated_at FROM financial_transactions WHERE transaction_uuid = $1',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingTransaction = existing.rows[0];
      
      // حل التعارضات
      if (transactionData.syncVersion && existingTransaction.sync_version) {
        const conflictResult = await resolveConflict('financial_transactions', uuid, transactionData, {
          syncVersion: existingTransaction.sync_version,
          updatedAt: secondsToMs(existingTransaction.updated_at)
        });
        if (conflictResult.winner !== transactionData) {
          const remoteTransaction = await pool.query('SELECT * FROM financial_transactions WHERE transaction_uuid = $1', [uuid]);
          const transaction = remoteTransaction.rows[0];
          return res.json({ success: true, data: mapTransactionToAPI(transaction), action: 'conflict_resolved', conflict: true, conflictReason: conflictResult.reason });
        }
      }
      
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);
      
      // التحقق من أن ownerUserId موجود
      if (!ownerUserId) {
        console.error('❌ ownerUserId is null in UPDATE. transactionData:', JSON.stringify(transactionData, null, 2));
        return res.status(400).json({
          success: false,
          error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات. يرجى التأكد من أن المستخدم مسجل في النظام.'
        });
      }
      
      // الحصول على clientId الصحيح
      const clientId = await normalizeClientId(
        transactionData.customerId || transactionData.clientId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId
      );
      
      // الحصول على accountId الصحيح
      const accountId = await normalizeAccountId(
        transactionData.accountId,
        transactionData.accountFirestoreId
      );
      
      // التحقق من أن accountId موجود (لأنه NOT NULL)
      if (!accountId) {
        console.error('❌ accountId is null in UPDATE transaction. transactionData:', JSON.stringify(transactionData, null, 2));
        return res.status(400).json({
          success: false,
          error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
        });
      }
      
      // تحديث المعاملة الموجودة
      const result = await pool.query(
        `UPDATE financial_transactions SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          client_id = $6,
          account_id = $7,
          client_firestore_id = COALESCE($8, client_firestore_id),
          account_firestore_id = COALESCE($9, account_firestore_id),
          transaction_amount = $10,
          currency_code = $11,
          transaction_direction = $12,
          transaction_note = COALESCE($13, transaction_note),
          transaction_date = to_timestamp($14),
          notify_customer = COALESCE($15, notify_customer),
          is_synced = COALESCE($16, is_synced),
          device_id = COALESCE($17, device_id),
          transaction_number = COALESCE($18, transaction_number),
          sync_version = COALESCE($19, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE transaction_uuid = $1 AND deleted_at IS NULL
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId,
          transactionData.firestoreId,
          ownerUserId,
          transactionData.ownerFirebaseUid,
          clientId, // استخدام clientId المحول
          accountId, // استخدام accountId المحول
          transactionData.customerFirestoreId || transactionData.clientFirestoreId,
          transactionData.accountFirestoreId,
          transactionData.amount || transactionData.transactionAmount,
          transactionData.currency || transactionData.currencyCode || 'IQD',
          normalizeTransactionDirection(transactionData.direction || transactionData.transactionDirection),
          transactionData.note || transactionData.transactionNote,
          msToSeconds(transactionData.transactionDate),
          intToBoolean(transactionData.notifyCustomer),
          intToBoolean(transactionData.synced),
          transactionData.deviceId,
          transactionData.transactionNumber,
          transactionData.syncVersion || existingTransaction.sync_version || 0
        ]
      );
      
      const transaction = result.rows[0];
      
      // تسجيل العملية
      await logAudit(
        transaction.owner_user_id, 
        transaction.owner_firebase_uid, 
        'update', 
        'transaction', 
        transaction.transaction_id.toString(), 
        existingTransaction, 
        transaction, 
        req
      );
      
      // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
      await sendSyncNotification(transaction.owner_firebase_uid, transactionData.deviceId, 'transaction', 'updated', transaction.transaction_uuid?.toString());
      
      return res.json({ success: true, data: mapTransactionToAPI(transaction), action: 'updated' });
    } else {
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);
      
      // الحصول على clientId الصحيح
      const clientId = await normalizeClientId(
        transactionData.customerId || transactionData.clientId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId
      );
      
      // الحصول على accountId الصحيح
      let accountId = await normalizeAccountId(
        transactionData.accountId,
        transactionData.accountFirestoreId
      );
      
      // إذا كان accountFirestoreId هو "shared-main-account-v1" ولم يُوجد، أنشئه مع ownerUserId
      if (!accountId && transactionData.accountFirestoreId === 'shared-main-account-v1' && ownerUserId) {
        console.log(`🆕 Creating shared main account with ownerUserId: ${ownerUserId}`);
        try {
          // إنشاء UUID صحيح للحساب المشترك
          // نستخدم UUID ثابت للحساب المشترك لضمان أنه واحد فقط في النظام
          const sharedAccountUuid = '00000000-0000-0000-0000-000000000001'; // UUID ثابت للحساب المشترك
          const now = Date.now();
          const createdAtSeconds = msToSeconds(now);
          
          // تحويل color من رقم إلى hex string (0xFF0A84FF -> FF0A84)
          // نزيل alpha channel ونحول إلى hex string بدون #
          const colorValue = 0xFF0A84FF;
          const colorHex = normalizeColorCode(colorValue); // FF0A84 (6 أحرف بدون #)
          
          const createResult = await pool.query(
            `INSERT INTO cash_accounts (
              account_uuid, firestore_id, owner_user_id, owner_firebase_uid, account_name, is_primary, is_shared,
              color_code, sync_version, created_at, updated_at
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), CURRENT_TIMESTAMP)
            ON CONFLICT (account_uuid) DO UPDATE SET
              account_name = EXCLUDED.account_name,
              is_primary = EXCLUDED.is_primary,
              is_shared = EXCLUDED.is_shared,
              firestore_id = EXCLUDED.firestore_id,
              updated_at = CURRENT_TIMESTAMP
            RETURNING account_id`,
            [
              sharedAccountUuid,
              'shared-main-account-v1',
              ownerUserId,
              transactionData.ownerFirebaseUid || null,
              'الصندوق الرئيسي',
              true, // is_primary
              true, // is_shared
              colorHex, // color_code: 'FF0A84' (6 أحرف بدون #)
              1, // sync_version
              createdAtSeconds
            ]
          );
          
          if (createResult.rows.length > 0) {
            accountId = createResult.rows[0].account_id;
            console.log(`✅ Created shared main account with account_id: ${accountId}`);
          }
        } catch (error) {
          console.error(`❌ Error creating shared main account: ${error.message}`);
          // إذا فشل الإنشاء بسبب conflict، حاول البحث مرة أخرى
          if (error.code === '23505') { // unique_violation
            console.log(`🔄 Account already exists, searching again...`);
            accountId = await getAccountIdFromFirestoreId('shared-main-account-v1');
          }
        }
      }
      
      // التحقق من أن accountId موجود (لأنه NOT NULL)
      if (!accountId) {
        console.error('❌ accountId is null in INSERT transaction. transactionData:', JSON.stringify(transactionData, null, 2));
        return res.status(400).json({
          success: false,
          error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
        });
      }
      
      // إنشاء معاملة جديدة
      const result = await pool.query(
        `INSERT INTO financial_transactions (
          transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          client_id, account_id, client_firestore_id, account_firestore_id,
          transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
          notify_customer, is_synced, device_id, transaction_number, sync_version,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14), $15, $16, $17, $18, $19, to_timestamp($20), CURRENT_TIMESTAMP)
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId || null,
          transactionData.firestoreId || null,
          ownerUserId,
          transactionData.ownerFirebaseUid || null,
          clientId, // استخدام clientId المحول
          accountId, // استخدام accountId المحول
          transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
          transactionData.accountFirestoreId || null,
          transactionData.amount || transactionData.transactionAmount,
          transactionData.currency || transactionData.currencyCode || 'IQD',
          normalizeTransactionDirection(transactionData.direction || transactionData.transactionDirection),
          transactionData.note || transactionData.transactionNote || null,
          msToSeconds(transactionData.transactionDate || Date.now()),
          intToBoolean(transactionData.notifyCustomer !== undefined ? transactionData.notifyCustomer : 0),
          intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
          transactionData.deviceId || null,
          transactionData.transactionNumber || null,
          transactionData.syncVersion || 1,
          msToSeconds(transactionData.createdAt || Date.now()) // $20 - سيتم تحويله إلى timestamp في SQL
        ]
      );
      
      const transaction = result.rows[0];
      
      // تسجيل العملية
      await logAudit(
        transaction.owner_user_id, 
        transaction.owner_firebase_uid, 
        'create', 
        'transaction', 
        transaction.transaction_id.toString(), 
        null, 
        transaction, 
        req
      );
      
      // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
      await sendSyncNotification(transaction.owner_firebase_uid, transactionData.deviceId, 'transaction', 'created', transaction.transaction_uuid?.toString());
      
      return res.json({ success: true, data: mapTransactionToAPI(transaction), action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * DELETE /api/transactions/:transactionId
 * حذف معاملة (Soft Delete)
 */
app.delete('/api/transactions/:transactionId', optionalAuthenticate, async (req, res) => {
  try {
    const { transactionId } = req.params;
    
    // التحقق من أن transactionId ليس كلمة محجوزة
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(transactionId.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID: "${transactionId}" is a reserved word`
      });
    }
    
    // التحقق من أن transactionId هو رقم (BIGINT) أو UUID
    const isNumeric = /^\d+$/.test(transactionId);
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionId);
    
    if (!isNumeric && !isUUID) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID format: "${transactionId}" must be a number or UUID`
      });
    }
    
    const result = await pool.query(
      `UPDATE financial_transactions 
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE transaction_id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [transactionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    
    const transaction = result.rows[0];
    
    // تسجيل العملية
    await logAudit(
      transaction.owner_user_id, 
      transaction.owner_firebase_uid, 
      'delete', 
      'transaction', 
      transaction.transaction_id.toString(), 
      transaction, 
      null, 
      req
    );
    
    // ✅ إرسال إشعار FCM للأجهزة الأخرى للمزامنة الفورية
    await sendSyncNotification(transaction.owner_firebase_uid, null, 'transaction', 'deleted', transaction.transaction_uuid?.toString());
    
    res.json({ success: true, message: 'تم حذف المعاملة بنجاح' });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 10. Routes - Health Check ====================

/**
 * GET /
 * صفحة افتراضية بسيطة لتسهيل فحص الخادم
 */
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'MalyMax Sync API is running',
    health: '/api/health',
    info: '/api/info'
  });
});

/**
 * GET /api/health
 * فحص صحة الخادم وقاعدة البيانات
 */
app.get('/api/health', async (req, res) => {
  try {
    const dbCheck = await pool.query('SELECT NOW() as time, version() as version');
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      server: {
        url: process.env.SERVER_URL || `http://localhost:${PORT}`,
        port: PORT,
        environment: process.env.NODE_ENV || 'development'
      },
      database: {
        connected: true,
        time: dbCheck.rows[0].time,
        version: dbCheck.rows[0].version.split(' ')[0] + ' ' + dbCheck.rows[0].version.split(' ')[1]
      }
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

/**
 * GET /api/info
 * الحصول على معلومات الخادم
 */
app.get('/api/info', async (req, res) => {
  try {
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const interfaceName in networkInterfaces) {
      const interfaces = networkInterfaces[interfaceName];
      for (const iface of interfaces) {
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push({
            interface: interfaceName,
            address: iface.address,
            url: `http://${iface.address}:${PORT}`
          });
        }
      }
    }
    
    res.json({
      success: true,
      server: {
        name: 'MalyMax Professional Sync API',
        version: '2.0.0',
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        serverUrl: process.env.SERVER_URL || `http://localhost:${PORT}`
      },
      network: {
        localhost: `http://localhost:${PORT}`,
        addresses: addresses,
        androidEmulator: addresses.length > 0 ? addresses[0].url : `http://10.0.2.2:${PORT}`
      },
      endpoints: {
        health: '/api/health',
        auth: '/api/auth/login',
        users: '/api/users',
        clients: '/api/clients',
        accounts: '/api/accounts',
        transactions: '/api/transactions'
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 11. Routes - Subscriptions ====================

/**
 * GET /api/subscriptions/active
 * الحصول على الاشتراك النشط للمستخدم
 * ✅ Security: يتحقق من أن المستخدم يطلب اشتراكه فقط
 */
app.get('/api/subscriptions/active', optionalAuthenticate, async (req, res) => {
  try {
    const { firebaseUid, userPhone } = req.query;
    
    // ✅ Input Validation
    if (!firebaseUid && !userPhone) {
      return res.status(400).json({ success: false, error: 'firebaseUid أو userPhone مطلوب' });
    }
    
    // ✅ Security: إذا كان المستخدم مصادقاً، تأكد من أنه يطلب اشتراكه فقط
    if (req.user) {
      const userFirebaseUid = req.user.firebaseUid;
      if (firebaseUid && firebaseUid !== userFirebaseUid) {
        console.log(`⚠️ Security: User ${userFirebaseUid} attempted to access subscription for ${firebaseUid}`);
        return res.status(403).json({ 
          success: false, 
          error: 'ليس لديك صلاحية للوصول لهذا الاشتراك' 
        });
      }
      
      // ✅ إذا كان المستخدم مصادقاً، استخدم firebaseUid من token بدلاً من query parameter
      if (userFirebaseUid) {
        const query = 'SELECT * FROM subscriptions WHERE status IN ($1, $2) AND end_at > CURRENT_TIMESTAMP AND (firebase_uid = $3 OR user_doc_id = $3) ORDER BY end_at DESC LIMIT 1';
        const result = await pool.query(query, ['active', 'pending', userFirebaseUid]);
        
        if (result.rows.length === 0) {
          return res.status(404).json({ success: false, error: 'لا يوجد اشتراك نشط' });
        }
        
        const subscription = result.rows[0];
        return res.json({
          success: true,
          data: {
            id: subscription.subscription_uuid?.toString() || subscription.subscription_id.toString(),
            packageId: subscription.package_id,
            status: subscription.status,
            startAtMillis: secondsToMs(subscription.start_at),
            endAtMillis: secondsToMs(subscription.end_at),
            notes: subscription.notes,
            firebaseUid: subscription.firebase_uid,
            userDocId: subscription.user_doc_id,
            userPhone: subscription.user_phone
          }
        });
      }
    }
    
    // ✅ للطلبات غير المصادقة (للتوافق مع الكود القديم)، استخدام query parameters
    let query = 'SELECT * FROM subscriptions WHERE status IN ($1, $2) AND end_at > CURRENT_TIMESTAMP';
    const params = ['active', 'pending'];
    let paramIndex = 3;
    
    if (firebaseUid) {
      // ✅ Input validation: التحقق من format
      if (firebaseUid.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(firebaseUid)) {
        return res.status(400).json({ success: false, error: 'firebaseUid غير صالح' });
      }
      query += ` AND (firebase_uid = $${paramIndex++} OR user_doc_id = $${paramIndex - 1})`;
      params.push(firebaseUid);
    }
    if (userPhone) {
      // ✅ Input validation: التحقق من format
      if (userPhone.length > 20 || !/^[0-9+\-() ]+$/.test(userPhone)) {
        return res.status(400).json({ success: false, error: 'userPhone غير صالح' });
      }
      query += ` AND user_phone = $${paramIndex++}`;
      params.push(userPhone);
    }
    
    query += ' ORDER BY end_at DESC LIMIT 1';
    
    const result = await pool.query(query, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'لا يوجد اشتراك نشط' });
    }
    
    const subscription = result.rows[0];
    res.json({
      success: true,
      data: {
        id: subscription.subscription_uuid?.toString() || subscription.subscription_id.toString(),
        packageId: subscription.package_id,
        status: subscription.status,
        startAtMillis: secondsToMs(subscription.start_at),
        endAtMillis: secondsToMs(subscription.end_at),
        notes: subscription.notes,
        firebaseUid: subscription.firebase_uid,
        userDocId: subscription.user_doc_id,
        userPhone: subscription.user_phone
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/packages
 * الحصول على جميع الباقات النشطة
 * ✅ Public endpoint - لا يحتاج مصادقة (الباقات متاحة للجميع)
 */
app.get('/api/packages', optionalAuthenticate, async (req, res) => {
  try {
    // ✅ Security: استخدام parameterized query
    const result = await pool.query(
      'SELECT * FROM subscription_packages WHERE is_active = $1 ORDER BY duration_days ASC',
      [true]
    );
    
    const packages = result.rows.map(row => ({
      id: row.package_id,
      name: row.name,
      durationDays: row.duration_days,
      price: parseFloat(row.price),
      currencyCode: row.currency_code || 'YER',
      features: row.features || [],
      isActive: row.is_active,
      updatedAtMillis: secondsToMs(row.updated_at)
    }));
    
    res.json({ success: true, data: packages });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/subscription-requests
 * إرسال طلب اشتراك جديد
 * ✅ Security: يتحقق من أن المستخدم يرسل طلباً لنفسه
 */
app.post('/api/subscription-requests', optionalAuthenticate, async (req, res) => {
  try {
    const {
      firebaseUid,
      userDocId,
      userPhone,
      userName,
      packageId,
      packageName,
      packageDurationDays,
      packagePrice,
      packageCurrency,
      notes
    } = req.body;

    // ✅ Input Validation
    if (!packageId) {
      return res.status(400).json({ success: false, error: 'packageId مطلوب' });
    }

    // ✅ Security: إذا كان المستخدم مصادقاً، استخدم firebaseUid من token
    let finalFirebaseUid = firebaseUid || userDocId;
    if (req.user && req.user.firebaseUid) {
      finalFirebaseUid = req.user.firebaseUid;
      // ✅ Security: التحقق من أن المستخدم لا يرسل طلباً باسم مستخدم آخر
      if (firebaseUid && firebaseUid !== req.user.firebaseUid) {
        console.log(`⚠️ Security: User ${req.user.firebaseUid} attempted to create request for ${firebaseUid}`);
        return res.status(403).json({ 
          success: false, 
          error: 'ليس لديك صلاحية لإنشاء طلب اشتراك لمستخدم آخر' 
        });
      }
    }

    if (!finalFirebaseUid && !userPhone) {
      return res.status(400).json({ success: false, error: 'firebaseUid أو userPhone مطلوب' });
    }

    // ✅ التحقق من وجود الباقة
    const packageResult = await pool.query(
      'SELECT * FROM subscription_packages WHERE package_id = $1 AND is_active = $2',
      [packageId, true]
    );

    if (packageResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الباقة غير موجودة أو غير نشطة' });
    }

    const pkg = packageResult.rows[0];

    // ✅ الحصول على user_id إذا كان firebaseUid موجوداً
    let userId = null;
    if (finalFirebaseUid) {
      const userResult = await pool.query(
        'SELECT user_id FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL',
        [finalFirebaseUid]
      );
      if (userResult.rows.length > 0) {
        userId = userResult.rows[0].user_id;
      }
    }

    // ✅ إدراج طلب الاشتراك
    const result = await pool.query(
      `INSERT INTO subscription_requests (
        user_id, firebase_uid, user_doc_id, user_phone, user_name,
        package_id, package_name, package_duration_days, package_price, package_currency,
        notes, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        userId,
        finalFirebaseUid,
        finalFirebaseUid, // user_doc_id = firebaseUid للتوافق
        userPhone,
        userName,
        packageId,
        packageName || pkg.name,
        packageDurationDays || pkg.duration_days,
        packagePrice || parseFloat(pkg.price),
        packageCurrency || pkg.currency_code || 'YER',
        notes,
        'pending'
      ]
    );

    const request = result.rows[0];
    
    console.log(`✅ Subscription request created: request_id=${request.request_id}, user=${finalFirebaseUid || userPhone}, package=${packageId}`);

    res.status(201).json({
      success: true,
      data: {
        requestId: request.request_uuid?.toString() || request.request_id.toString(),
        status: request.status,
        createdAt: secondsToMs(request.created_at)
      },
      message: 'تم إرسال طلب الاشتراك بنجاح. سيتم مراجعته من قبل الإدارة.'
    });
  } catch (error) {
    if (error.code === '23503') { // Foreign key violation
      return res.status(400).json({ success: false, error: 'الباقة غير موجودة' });
    }
    handleError(res, error);
  }
});

// ==================== 12. Routes - FCM Tokens ====================

/**
 * POST /api/fcm-tokens
 * تسجيل/تحديث FCM token للمستخدم
 * ✅ Security: يتحقق من أن المستخدم يسجل token لنفسه
 */
app.post('/api/fcm-tokens', optionalAuthenticate, async (req, res) => {
  try {
    const {
      firebaseUid, // ✅ اختياري - الخادم يستخرجه من authToken إذا كان متاحاً
      token,
      deviceId, // ✅ معرف الجهاز الفريد (DeviceIdManager.getDeviceId)
      deviceModel,
      deviceBrand,
      deviceManufacturer,
      appVersionName,
      appVersionCode
    } = req.body;

    console.log(`📥 استقبال طلب تسجيل FCM token: token=${token?.substring(0, 20)}..., hasAuth=${!!req.user}`);

    // ✅ Input Validation
    if (!token) {
      console.log('❌ فشل التحقق: token مطلوب');
      return res.status(400).json({ success: false, error: 'token مطلوب' });
    }
    
    if (typeof token !== 'string' || token.trim().length === 0) {
      console.log('❌ فشل التحقق: token غير صحيح');
      return res.status(400).json({ success: false, error: 'token غير صحيح' });
    }

    // 🏗️ التصميم المعماري: الخادم هو مصدر الحقيقة
    // ✅ إذا كان المستخدم مصادقاً (authToken موجود)، استخدم firebaseUid من JWT token
    // ✅ إذا لم يكن مصادقاً، استخدم firebaseUid من body (للتوافق مع الطلبات القديمة)
    let finalFirebaseUid = firebaseUid;
    if (req.user && req.user.firebaseUid) {
      // ✅ الخادم هو مصدر الحقيقة: firebaseUid من authToken (JWT)
      finalFirebaseUid = req.user.firebaseUid;
      console.log(`✅ [FCM] Using firebaseUid from authToken (JWT): ${finalFirebaseUid}`);
      
      // ✅ Security: التحقق من أن المستخدم لا يسجل token لمستخدم آخر
      if (firebaseUid && firebaseUid !== req.user.firebaseUid) {
        console.log(`⚠️ Security: User ${req.user.firebaseUid} attempted to register token for ${firebaseUid}`);
        return res.status(403).json({ 
          success: false, 
          error: 'ليس لديك صلاحية لتسجيل token لمستخدم آخر' 
        });
      }
    } else if (!finalFirebaseUid) {
      // ❌ لا authToken ولا firebaseUid في body
      console.log('❌ فشل التحقق: firebaseUid مطلوب (إما من authToken أو من body)');
      return res.status(400).json({ 
        success: false, 
        error: 'firebaseUid مطلوب. يرجى تسجيل الدخول أولاً أو إرسال firebaseUid في body' 
      });
    } else {
      console.log(`⚠️ [FCM] Using firebaseUid from body (no authToken): ${finalFirebaseUid}`);
    }

    // ✅ الحصول على user_id
    const userResult = await pool.query(
      'SELECT user_id FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL',
      [finalFirebaseUid]
    );

    if (userResult.rows.length === 0) {
      console.log(`❌ المستخدم غير موجود: firebase_uid=${finalFirebaseUid}`);
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    const userId = userResult.rows[0].user_id;
    console.log(`✅ تم العثور على المستخدم: user_id=${userId}, firebase_uid=${finalFirebaseUid}`);

    // ✅ التحقق من وجود token مسبقاً
    const existingTokenResult = await pool.query(
      'SELECT token_id, is_primary FROM user_fcm_tokens WHERE user_id = $1 AND token = $2',
      [userId, token]
    );

    if (existingTokenResult.rows.length > 0) {
      // ✅ تحديث token موجود
      const existingToken = existingTokenResult.rows[0];
      await pool.query(
        `UPDATE user_fcm_tokens 
         SET is_active = TRUE, 
             last_used_at = CURRENT_TIMESTAMP,
             device_id = COALESCE($1, device_id),
             device_model = COALESCE($2, device_model),
             device_brand = COALESCE($3, device_brand),
             device_manufacturer = COALESCE($4, device_manufacturer),
             app_version_name = COALESCE($5, app_version_name),
             app_version_code = COALESCE($6::INTEGER, app_version_code),
             updated_at = CURRENT_TIMESTAMP
         WHERE token_id = $7`,
        [
          deviceId || null,
          deviceModel || null,
          deviceBrand || null,
          deviceManufacturer || null,
          appVersionName || null,
          appVersionCode ? parseInt(appVersionCode, 10) : null, // تحويل إلى INTEGER
          existingToken.token_id
        ]
      );

      console.log(`✅ FCM token updated: user_id=${userId}, firebase_uid=${finalFirebaseUid}, token_id=${existingToken.token_id}`);

      return res.json({
        success: true,
        data: {
          tokenId: existingToken.token_id,
          isPrimary: existingToken.is_primary,
          message: 'تم تحديث FCM token بنجاح'
        }
      });
    }

    // ✅ إلغاء primary من جميع tokens الأخرى للمستخدم
    await pool.query(
      'UPDATE user_fcm_tokens SET is_primary = FALSE WHERE user_id = $1',
      [userId]
    );

    // ✅ إدراج token جديد
    // تحويل appVersionCode إلى INTEGER إذا كان موجوداً
    const appVersionCodeInt = appVersionCode ? parseInt(appVersionCode, 10) : null;
    
    const result = await pool.query(
      `INSERT INTO user_fcm_tokens (
        user_id, firebase_uid, token, device_id, device_model, device_brand, 
        device_manufacturer, app_version_name, app_version_code, 
        is_active, is_primary, last_used_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        userId,                    // $1
        finalFirebaseUid,          // $2
        token,                      // $3
        deviceId || null,           // $4 device_id
        deviceModel || null,        // $5
        deviceBrand || null,        // $6
        deviceManufacturer || null, // $7
        appVersionName || null,     // $8
        appVersionCodeInt,          // $9 (INTEGER)
        true,                       // $10 is_active
        true                        // $11 is_primary (الـ token الجديد يصبح primary)
      ]
    );

    const newToken = result.rows[0];
    
    console.log(`✅ FCM token registered successfully:`);
    console.log(`   - user_id: ${userId}`);
    console.log(`   - firebase_uid: ${finalFirebaseUid}`);
    console.log(`   - token_id: ${newToken.token_id}`);
    console.log(`   - token_uuid: ${newToken.token_uuid}`);
    console.log(`   - device: ${deviceModel || 'N/A'} (${deviceBrand || 'N/A'})`);
    console.log(`   - app_version: ${appVersionName || 'N/A'} (${appVersionCodeInt || 'N/A'})`);

    res.status(201).json({
      success: true,
      data: {
        tokenId: newToken.token_id,
        tokenUuid: newToken.token_uuid,
        isPrimary: newToken.is_primary,
        message: 'تم تسجيل FCM token بنجاح'
      }
    });
  } catch (error) {
    console.error('❌ خطأ في تسجيل FCM token:', error);
    if (error.code === '23505') { // Unique constraint violation
      console.log('⚠️ Token مسجل بالفعل (unique constraint)');
      return res.status(409).json({ success: false, error: 'هذا الـ token مسجل بالفعل' });
    }
    if (error.code === '42P01') { // Table does not exist
      console.error('❌ الجدول user_fcm_tokens غير موجود! يجب تشغيل migration script');
      return res.status(500).json({ 
        success: false, 
        error: 'الجدول غير موجود. يرجى تشغيل migration script أولاً' 
      });
    }
    handleError(res, error);
  }
});

/**
 * GET /api/fcm-tokens/:firebaseUid
 * جلب جميع FCM tokens النشطة للمستخدم
 */
app.get('/api/fcm-tokens/:firebaseUid', optionalAuthenticate, async (req, res) => {
  try {
    const { firebaseUid } = req.params;

    // ✅ Security: إذا كان المستخدم مصادقاً، تحقق من أنه يطلب tokens لنفسه
    if (req.user && req.user.firebaseUid && req.user.firebaseUid !== firebaseUid) {
      return res.status(403).json({ 
        success: false, 
        error: 'ليس لديك صلاحية لعرض tokens لمستخدم آخر' 
      });
    }

    const result = await pool.query(
      `SELECT token_id, token_uuid, token, device_id, device_model, device_brand, 
              device_manufacturer, app_version_name, app_version_code,
              is_active, is_primary, last_used_at, created_at, updated_at
       FROM user_fcm_tokens 
       WHERE firebase_uid = $1 AND is_active = TRUE
       ORDER BY is_primary DESC, last_used_at DESC`,
      [firebaseUid]
    );

    const tokens = result.rows.map(row => ({
      tokenId: row.token_id,
      tokenUuid: row.token_uuid,
      token: row.token,
      deviceId: row.device_id,
      deviceModel: row.device_model,
      deviceBrand: row.device_brand,
      deviceManufacturer: row.device_manufacturer,
      appVersionName: row.app_version_name,
      appVersionCode: row.app_version_code,
      isActive: row.is_active,
      isPrimary: row.is_primary,
      lastUsedAt: secondsToMs(row.last_used_at),
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at)
    }));

    res.json({ success: true, data: tokens });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * DELETE /api/fcm-tokens/:tokenId
 * حذف/تعطيل FCM token
 */
app.delete('/api/fcm-tokens/:tokenId', optionalAuthenticate, async (req, res) => {
  try {
    const { tokenId } = req.params;

    // ✅ Security: التحقق من أن المستخدم يملك هذا الـ token
    const tokenResult = await pool.query(
      'SELECT user_id, firebase_uid FROM user_fcm_tokens WHERE token_id = $1',
      [tokenId]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الـ token غير موجود' });
    }

    const token = tokenResult.rows[0];

    if (req.user && req.user.firebaseUid && req.user.firebaseUid !== token.firebase_uid) {
      return res.status(403).json({ 
        success: false, 
        error: 'ليس لديك صلاحية لحذف token لمستخدم آخر' 
      });
    }

    // ✅ تعطيل الـ token (soft delete)
    await pool.query(
      'UPDATE user_fcm_tokens SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE token_id = $1',
      [tokenId]
    );

    console.log(`✅ FCM token disabled: token_id=${tokenId}, firebase_uid=${token.firebase_uid}`);

    res.json({ success: true, message: 'تم تعطيل FCM token بنجاح' });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 13. Routes - Settings ====================

/**
 * GET /api/settings/shared
 * الحصول على الإعدادات المشتركة
 */
app.get('/api/settings/shared', optionalAuthenticate, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM app_shared_settings ORDER BY setting_key');
    
    const settings = result.rows.map(row => ({
      settingKey: row.setting_key,
      settingValue: row.setting_value,
      settingType: row.setting_type,
      category: row.category,
      description: row.description,
      updatedBy: row.updated_by,
      updatedAt: secondsToMs(row.updated_at)
    }));
    
    res.json({ success: true, data: settings });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/settings/user/:firebaseUid
 * الحصول على إعدادات المستخدم
 */
app.get('/api/settings/user/:firebaseUid', optionalAuthenticate, async (req, res) => {
  try {
    const { firebaseUid } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM user_control_settings WHERE firebase_uid = $1',
      [firebaseUid]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الإعدادات غير موجودة' });
    }
    
    const setting = result.rows[0];
    res.json({
      success: true,
      data: {
        firebaseUid: setting.firebase_uid,
        syncEnabled: setting.sync_enabled,
        updatedBy: setting.updated_by,
        updatedAt: secondsToMs(setting.updated_at)
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 13. Error Handling Middleware ====================
app.use((err, req, res, next) => {
  handleError(res, err);
});

// ==================== 14. 404 Handler ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'المسار غير موجود'
  });
});

// ==================== 13. Start Server ====================
app.listen(PORT, () => {
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  let localIP = 'localhost';
  
  // الحصول على IP address للشبكة المحلية
  for (const interfaceName in networkInterfaces) {
    const interfaces = networkInterfaces[interfaceName];
    for (const iface of interfaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
    if (localIP !== 'localhost') break;
  }
  
  const serverUrl = process.env.SERVER_URL || `http://${localIP}:${PORT}`;
  
  console.log(`🚀 خادم MalyMax Professional Sync API يعمل على المنفذ ${PORT}`);
  console.log(`📡 API متاح على:`);
  console.log(`   - Local: http://localhost:${PORT}`);
  console.log(`   - Network: http://${localIP}:${PORT}`);
  console.log(`   - Android Emulator: http://10.0.2.2:${PORT}`);
  console.log(`   - Server URL: ${serverUrl}`);
  console.log(`\n🏥 Health Check:`);
  console.log(`   - http://localhost:${PORT}/api/health`);
  console.log(`   - http://${localIP}:${PORT}/api/health`);
  console.log(`\n📋 Endpoints المتاحة:`);
  console.log(`   GET    /api/info - معلومات الخادم`);
  console.log(`   GET    /api/health - فحص الصحة`);
  console.log(`   POST   /api/auth/login`);
  console.log(`   GET    /api/users/:userId`);
  console.log(`   PUT    /api/users/sync`);
  console.log(`   POST   /api/fcm-tokens - تسجيل/تحديث FCM token`);
  console.log(`   GET    /api/fcm-tokens/:firebaseUid - جلب FCM tokens للمستخدم`);
  console.log(`   DELETE /api/fcm-tokens/:tokenId - حذف/تعطيل FCM token`);
  console.log(`   GET    /api/clients`);
  console.log(`   PUT    /api/clients/sync`);
  console.log(`   GET    /api/accounts`);
  console.log(`   PUT    /api/accounts/sync`);
  console.log(`   GET    /api/transactions`);
  console.log(`   PUT    /api/transactions/sync`);
  console.log(`   GET    /api/subscriptions/active`);
  console.log(`   GET    /api/packages`);
  console.log(`   POST   /api/subscription-requests`);
  console.log(`   GET    /api/settings/shared`);
  console.log(`   GET    /api/settings/user/:firebaseUid`);
  console.log(`\n📱 للاستخدام مع Android Emulator:`);
  console.log(`   استخدم: http://10.0.2.2:${PORT}`);
  console.log(`   أو: http://${localIP}:${PORT}\n`);
});

// ==================== 16. Graceful Shutdown ====================
process.on('SIGTERM', async () => {
  console.log('🛑 إغلاق الخادم...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 إغلاق الخادم...');
  await pool.end();
  process.exit(0);
});

