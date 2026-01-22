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
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
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

// ==================== 3. إعداد PostgreSQL Connection Pool ====================
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
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
 */
function msToSeconds(timestamp) {
  if (!timestamp) return null;
  return Math.floor(timestamp / 1000);
}

/**
 * تحويل timestamp من seconds إلى milliseconds (Android)
 */
function secondsToMs(timestamp) {
  if (!timestamp) return null;
  return timestamp * 1000;
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
 * التحقق من وجود UUID (للمزامنة الذكية)
 */
function ensureUuid(data) {
  if (!data.entryId && !data.userUuid && !data.clientUuid && !data.accountUuid && !data.transactionUuid) {
    // إنشاء UUID حسب نوع الكيان
    if (data.userUuid !== undefined) data.userUuid = uuidv4();
    else if (data.clientUuid !== undefined) data.clientUuid = uuidv4();
    else if (data.accountUuid !== undefined) data.accountUuid = uuidv4();
    else if (data.transactionUuid !== undefined) data.transactionUuid = uuidv4();
    else data.entryId = uuidv4(); // للتوافق مع الإصدار القديم
  }
  return data;
}

/**
 * حل التعارضات: Last Write Wins مع التحقق من syncVersion
 */
async function resolveConflict(tableName, uuid, localData, remoteData) {
  // إذا كان syncVersion المحلي أكبر، استخدم البيانات المحلية
  if (localData.syncVersion > remoteData.syncVersion) {
    return localData;
  }
  // إذا كان syncVersion البعيد أكبر، استخدم البيانات البعيدة
  if (remoteData.syncVersion > localData.syncVersion) {
    return remoteData;
  }
  // إذا كانت متساوية، استخدم Last Write Wins (updatedAt)
  const localTime = localData.updatedAt || localData.createdAt || 0;
  const remoteTime = remoteData.updatedAt || remoteData.createdAt || 0;
  return localTime >= remoteTime ? localData : remoteData;
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
    color: row.color_code,
    colorCode: row.color_code,
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
    
    // التحقق من كلمة المرور (يجب تطبيق hashing في الإنتاج)
    // هنا مثال بسيط - يجب استخدام bcrypt في الإنتاج
    if (user.password_hash !== password) {
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
 * POST /api/users
 * إنشاء مستخدم جديد
 */
app.post('/api/users', async (req, res) => {
  try {
    const userData = ensureUuid(req.body);
    
    const result = await pool.query(
      `INSERT INTO app_users (
        user_uuid, firebase_uid, full_name, phone_number, job_title, 
        password_hash, password_salt, account_number, 
        created_at, app_version_name, app_version_code,
        device_model, device_brand, device_manufacturer, 
        device_sdk_int, push_token, receive_transaction_notifications, sync_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        userData.userUuid || userData.entryId || uuidv4(),
        userData.firebaseUid || null,
        userData.name || userData.fullName,
        userData.phone || userData.phoneNumber,
        userData.jobTitle || null,
        userData.passwordHash,
        userData.passwordSalt,
        userData.accountNumber,
        msToSeconds(userData.createdAt || Date.now()),
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

    res.status(201).json({ success: true, data: mapUserToAPI(user) });
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
    const uuid = userData.userUuid || userData.entryId;
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'userUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT user_id, sync_version, updated_at FROM app_users WHERE user_uuid = $1 OR (entry_id = $1 AND user_uuid IS NULL)',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      
      // حل التعارضات إذا لزم الأمر
      if (userData.syncVersion && existingUser.sync_version) {
        const resolved = await resolveConflict('app_users', uuid, userData, {
          syncVersion: existingUser.sync_version,
          updatedAt: secondsToMs(existingUser.updated_at)
        });
        if (resolved !== userData) {
          const remoteUser = await pool.query('SELECT * FROM app_users WHERE user_uuid = $1', [uuid]);
          const user = remoteUser.rows[0];
          return res.json({ success: true, data: mapUserToAPI(user), action: 'conflict_resolved', conflict: true });
        }
      }
      
      // تحديث المستخدم الموجود
      const result = await pool.query(
        `UPDATE app_users SET
          firebase_uid = COALESCE($2, firebase_uid),
          full_name = $3,
          phone_number = $4,
          job_title = COALESCE($5, job_title),
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
        WHERE user_uuid = $1 OR (entry_id = $1 AND user_uuid IS NULL)
        RETURNING *`,
        [
          uuid,
          userData.firebaseUid,
          userData.name || userData.fullName,
          userData.phone || userData.phoneNumber,
          userData.jobTitle,
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
      // إنشاء مستخدم جديد
      const result = await pool.query(
        `INSERT INTO app_users (
          user_uuid, firebase_uid, full_name, phone_number, job_title,
          password_hash, password_salt, account_number,
          created_at, app_version_name, app_version_code,
          device_model, device_brand, device_manufacturer,
          device_sdk_int, push_token, receive_transaction_notifications, sync_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
          msToSeconds(userData.createdAt || Date.now()),
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

// ==================== 7. Routes - Clients (Customers) ====================

/**
 * GET /api/clients
 * الحصول على جميع العملاء لمستخدم محدد
 */
app.get('/api/clients', optionalAuthenticate, async (req, res) => {
  try {
    const { ownerUserId, ownerFirebaseUid, archived } = req.query;
    
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
    
    query += ' ORDER BY created_at DESC';
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        clientData.clientUuid || clientData.entryId || uuidv4(),
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
        msToSeconds(clientData.createdAt || Date.now()),
        msToSeconds(clientData.updatedAt || Date.now()),
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
 * PUT /api/clients/sync
 * مزامنة عميل (Insert or Update حسب UUID)
 */
app.put('/api/clients/sync', syncLimiter, optionalAuthenticate, async (req, res) => {
  try {
    const clientData = ensureUuid(req.body);
    const uuid = clientData.clientUuid || clientData.entryId;
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'clientUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT client_id, sync_version, updated_at FROM business_clients WHERE client_uuid = $1 OR (entry_id = $1 AND client_uuid IS NULL)',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingClient = existing.rows[0];
      
      // حل التعارضات
      if (clientData.syncVersion && existingClient.sync_version) {
        const resolved = await resolveConflict('business_clients', uuid, clientData, {
          syncVersion: existingClient.sync_version,
          updatedAt: secondsToMs(existingClient.updated_at)
        });
        if (resolved !== clientData) {
          const remoteClient = await pool.query('SELECT * FROM business_clients WHERE client_uuid = $1', [uuid]);
          const client = remoteClient.rows[0];
          return res.json({ success: true, data: mapClientToAPI(client), action: 'conflict_resolved', conflict: true });
        }
      }
      
      // تحديث العميل الموجود
      const result = await pool.query(
        `UPDATE business_clients SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          client_name = $6,
          phone_number = COALESCE($7, phone_number),
          job_title = COALESCE($8, job_title),
          notes = COALESCE($9, notes),
          is_archived = COALESCE($10, is_archived),
          device_id = COALESCE($11, device_id),
          sync_version = COALESCE($12, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP,
          cached_total_balance = COALESCE($13, cached_total_balance)
        WHERE client_uuid = $1 OR (entry_id = $1 AND client_uuid IS NULL)
        RETURNING *`,
        [
          uuid,
          clientData.cloudId,
          clientData.firestoreId,
          clientData.ownerUserId,
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
      
      return res.json({ success: true, data: mapClientToAPI(client), action: 'updated' });
    } else {
      // إنشاء عميل جديد
      const result = await pool.query(
        `INSERT INTO business_clients (
          client_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          client_name, phone_number, job_title, notes, is_archived,
          device_id, sync_version, created_at, updated_at, cached_total_balance
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          uuid,
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
          msToSeconds(clientData.createdAt || Date.now()),
          msToSeconds(clientData.updatedAt || Date.now()),
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
 */
app.get('/api/accounts', optionalAuthenticate, async (req, res) => {
  try {
    const { ownerUserId, ownerFirebaseUid } = req.query;
    
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
    
    query += ' ORDER BY is_primary DESC, created_at ASC';
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
    const uuid = accountData.accountUuid || accountData.entryId;
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'accountUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT account_id, sync_version, updated_at FROM cash_accounts WHERE account_uuid = $1 OR (entry_id = $1 AND account_uuid IS NULL)',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingAccount = existing.rows[0];
      
      // حل التعارضات
      if (accountData.syncVersion && existingAccount.sync_version) {
        const resolved = await resolveConflict('cash_accounts', uuid, accountData, {
          syncVersion: existingAccount.sync_version,
          updatedAt: secondsToMs(existingAccount.updated_at)
        });
        if (resolved !== accountData) {
          const remoteAccount = await pool.query('SELECT * FROM cash_accounts WHERE account_uuid = $1', [uuid]);
          const account = remoteAccount.rows[0];
          return res.json({ success: true, data: mapAccountToAPI(account), action: 'conflict_resolved', conflict: true });
        }
      }
      
      const result = await pool.query(
        `UPDATE cash_accounts SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          account_name = $6,
          is_primary = COALESCE($7, is_primary),
          is_shared = COALESCE($8, is_shared),
          color_code = $9,
          device_id = COALESCE($10, device_id),
          sync_version = COALESCE($11, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE account_uuid = $1 OR (entry_id = $1 AND account_uuid IS NULL)
        RETURNING *`,
        [
          uuid,
          accountData.cloudId,
          accountData.firestoreId,
          accountData.ownerUserId,
          accountData.ownerFirebaseUid,
          accountData.name || accountData.accountName,
          intToBoolean(accountData.isPrimary),
          intToBoolean(accountData.isShared),
          accountData.color || accountData.colorCode,
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
      
      return res.json({ success: true, data: mapAccountToAPI(account), action: 'updated' });
    } else {
      const result = await pool.query(
        `INSERT INTO cash_accounts (
          account_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          account_name, is_primary, is_shared, color_code,
          device_id, sync_version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          uuid,
          accountData.cloudId || null,
          accountData.firestoreId || null,
          accountData.ownerUserId,
          accountData.ownerFirebaseUid || null,
          accountData.name || accountData.accountName,
          intToBoolean(accountData.isPrimary !== undefined ? accountData.isPrimary : 0),
          intToBoolean(accountData.isShared !== undefined ? accountData.isShared : 0),
          accountData.color || accountData.colorCode,
          accountData.deviceId || null,
          accountData.syncVersion || 1,
          msToSeconds(accountData.createdAt || Date.now()),
          msToSeconds(accountData.updatedAt || Date.now())
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
      
      return res.json({ success: true, data: mapAccountToAPI(account), action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 9. Routes - Transactions ====================

/**
 * GET /api/transactions
 * الحصول على المعاملات
 */
app.get('/api/transactions', optionalAuthenticate, async (req, res) => {
  try {
    const { ownerUserId, customerId, clientId, accountId, synced, limit, offset } = req.query;
    
    let query = 'SELECT * FROM financial_transactions WHERE deleted_at IS NULL';
    const params = [];
    let paramIndex = 1;
    
    if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
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
    
    query += ' ORDER BY transaction_date DESC, created_at DESC';
    
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
 * GET /api/transactions/:transactionId
 * الحصول على معاملة محددة
 */
app.get('/api/transactions/:transactionId', optionalAuthenticate, async (req, res) => {
  try {
    const { transactionId } = req.params;
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
 * POST /api/transactions
 * إنشاء معاملة جديدة
 */
app.post('/api/transactions', optionalAuthenticate, async (req, res) => {
  try {
    const transactionData = ensureUuid(req.body);
    
    const result = await pool.query(
      `INSERT INTO financial_transactions (
        transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_id, account_id, client_firestore_id, account_firestore_id,
        transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
        notify_customer, is_synced, device_id, transaction_number, sync_version,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *`,
      [
        transactionData.transactionUuid || transactionData.entryId || uuidv4(),
        transactionData.cloudId || null,
        transactionData.firestoreId || null,
        transactionData.ownerUserId,
        transactionData.ownerFirebaseUid || null,
        transactionData.customerId || transactionData.clientId,
        transactionData.accountId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
        transactionData.accountFirestoreId || null,
        transactionData.amount || transactionData.transactionAmount,
        transactionData.currency || transactionData.currencyCode || 'IQD',
        transactionData.direction || transactionData.transactionDirection,
        transactionData.note || transactionData.transactionNote || null,
        msToSeconds(transactionData.transactionDate || Date.now()),
        intToBoolean(transactionData.notifyCustomer !== undefined ? transactionData.notifyCustomer : 0),
        intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
        transactionData.deviceId || null,
        transactionData.transactionNumber || null,
        transactionData.syncVersion || 1,
        msToSeconds(transactionData.createdAt || Date.now()),
        msToSeconds(transactionData.updatedAt || Date.now())
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
    const uuid = transactionData.transactionUuid || transactionData.entryId;
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'transactionUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT transaction_id, sync_version, updated_at FROM financial_transactions WHERE transaction_uuid = $1 OR (entry_id = $1 AND transaction_uuid IS NULL)',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingTransaction = existing.rows[0];
      
      // حل التعارضات
      if (transactionData.syncVersion && existingTransaction.sync_version) {
        const resolved = await resolveConflict('financial_transactions', uuid, transactionData, {
          syncVersion: existingTransaction.sync_version,
          updatedAt: secondsToMs(existingTransaction.updated_at)
        });
        if (resolved !== transactionData) {
          const remoteTransaction = await pool.query('SELECT * FROM financial_transactions WHERE transaction_uuid = $1', [uuid]);
          const transaction = remoteTransaction.rows[0];
          return res.json({ success: true, data: mapTransactionToAPI(transaction), action: 'conflict_resolved', conflict: true });
        }
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
          transaction_date = $14,
          notify_customer = COALESCE($15, notify_customer),
          is_synced = COALESCE($16, is_synced),
          device_id = COALESCE($17, device_id),
          transaction_number = COALESCE($18, transaction_number),
          sync_version = COALESCE($19, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE transaction_uuid = $1 OR (entry_id = $1 AND transaction_uuid IS NULL) AND deleted_at IS NULL
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId,
          transactionData.firestoreId,
          transactionData.ownerUserId,
          transactionData.ownerFirebaseUid,
          transactionData.customerId || transactionData.clientId,
          transactionData.accountId,
          transactionData.customerFirestoreId || transactionData.clientFirestoreId,
          transactionData.accountFirestoreId,
          transactionData.amount || transactionData.transactionAmount,
          transactionData.currency || transactionData.currencyCode || 'IQD',
          transactionData.direction || transactionData.transactionDirection,
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
      
      return res.json({ success: true, data: mapTransactionToAPI(transaction), action: 'updated' });
    } else {
      // إنشاء معاملة جديدة
      const result = await pool.query(
        `INSERT INTO financial_transactions (
          transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          client_id, account_id, client_firestore_id, account_firestore_id,
          transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
          notify_customer, is_synced, device_id, transaction_number, sync_version,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId || null,
          transactionData.firestoreId || null,
          transactionData.ownerUserId,
          transactionData.ownerFirebaseUid || null,
          transactionData.customerId || transactionData.clientId,
          transactionData.accountId,
          transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
          transactionData.accountFirestoreId || null,
          transactionData.amount || transactionData.transactionAmount,
          transactionData.currency || transactionData.currencyCode || 'IQD',
          transactionData.direction || transactionData.transactionDirection,
          transactionData.note || transactionData.transactionNote || null,
          msToSeconds(transactionData.transactionDate || Date.now()),
          intToBoolean(transactionData.notifyCustomer !== undefined ? transactionData.notifyCustomer : 0),
          intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
          transactionData.deviceId || null,
          transactionData.transactionNumber || null,
          transactionData.syncVersion || 1,
          msToSeconds(transactionData.createdAt || Date.now()),
          msToSeconds(transactionData.updatedAt || Date.now())
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
    
    res.json({ success: true, message: 'تم حذف المعاملة بنجاح' });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 10. Routes - Health Check ====================

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

// ==================== 11. Error Handling Middleware ====================
app.use((err, req, res, next) => {
  handleError(res, err);
});

// ==================== 12. 404 Handler ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'المسار غير موجود'
  });
});

// ==================== 13. Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 خادم MalyMax Professional Sync API يعمل على المنفذ ${PORT}`);
  console.log(`📡 API متاح على: http://localhost:${PORT}`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
  console.log(`\n📋 Endpoints المتاحة:`);
  console.log(`   POST   /api/auth/login`);
  console.log(`   GET    /api/users/:userId`);
  console.log(`   PUT    /api/users/sync`);
  console.log(`   GET    /api/clients`);
  console.log(`   PUT    /api/clients/sync`);
  console.log(`   GET    /api/accounts`);
  console.log(`   PUT    /api/accounts/sync`);
  console.log(`   GET    /api/transactions`);
  console.log(`   PUT    /api/transactions/sync`);
  console.log(`   GET    /api/health\n`);
});

// ==================== 14. Graceful Shutdown ====================
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

