// ============================================================================
// MalyMax Sync API Server - خادم مزامنة MalyMax مع PostgreSQL
// ============================================================================
// نظام مزامنة ذكي يدعم عدة أجهزة وحل التعارضات
// PostgreSQL هو المصدر الأساسي للبيانات (Source of Truth)
// ============================================================================

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');

// ==================== 1. تهيئة Express Server ====================
const app = express();
const PORT = process.env.PORT || 3001;

// ==================== 2. Middleware ====================
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ==================== 3. إعداد PostgreSQL Connection Pool ====================
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'malymax_prod',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
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
 * التحقق من وجود entryId (للمزامنة الذكية)
 */
function ensureEntryId(data) {
  if (!data.entryId) {
    data.entryId = uuidv4();
  }
  return data;
}

/**
 * حل التعارضات: Last Write Wins مع التحقق من syncVersion
 */
async function resolveConflict(tableName, entryId, localData, remoteData) {
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

// ==================== 5. Routes - Users ====================

/**
 * GET /api/users/:userId
 * الحصول على مستخدم محدد
 */
app.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    const user = result.rows[0];
    user.receiveTransactionNotifications = booleanToInt(user.receive_transaction_notifications);
    user.createdAt = secondsToMs(user.created_at);
    
    res.json({ success: true, data: user });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/users/by-entry/:entryId
 * الحصول على مستخدم حسب entryId
 */
app.get('/api/users/by-entry/:entryId', async (req, res) => {
  try {
    const { entryId } = req.params;
    const result = await pool.query(
      'SELECT * FROM users WHERE entry_id = $1',
      [entryId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    const user = result.rows[0];
    user.receiveTransactionNotifications = booleanToInt(user.receive_transaction_notifications);
    user.createdAt = secondsToMs(user.created_at);
    
    res.json({ success: true, data: user });
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
    const userData = ensureEntryId(req.body);
    
    const result = await pool.query(
      `INSERT INTO users (
        entry_id, firebase_uid, name, phone, job_title, 
        password_hash, password_salt, account_number, 
        created_at, app_version_name, app_version_code,
        device_model, device_brand, device_manufacturer, 
        device_sdk_int, account_push_token, receive_transaction_notifications, sync_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        userData.entryId,
        userData.firebaseUid || null,
        userData.name,
        userData.phone,
        userData.jobTitle,
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
        userData.accountPushToken || null,
        intToBoolean(userData.receiveTransactionNotifications !== undefined ? userData.receiveTransactionNotifications : 1),
        userData.syncVersion || 1
      ]
    );

    const user = result.rows[0];
    user.receiveTransactionNotifications = booleanToInt(user.receive_transaction_notifications);
    user.createdAt = secondsToMs(user.created_at);

    res.status(201).json({ success: true, data: user });
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({ success: false, error: 'المستخدم موجود بالفعل (رقم الهاتف أو entryId مكرر)' });
    }
    handleError(res, error);
  }
});

/**
 * PUT /api/users/sync
 * مزامنة مستخدم (Insert or Update حسب entryId)
 */
app.put('/api/users/sync', async (req, res) => {
  try {
    const userData = ensureEntryId(req.body);
    
    const existing = await pool.query(
      'SELECT id, sync_version, updated_at FROM users WHERE entry_id = $1',
      [userData.entryId]
    );
    
    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      
      // حل التعارضات إذا لزم الأمر
      if (userData.syncVersion && existingUser.sync_version) {
        const resolved = await resolveConflict('users', userData.entryId, userData, {
          syncVersion: existingUser.sync_version,
          updatedAt: secondsToMs(existingUser.updated_at)
        });
        if (resolved !== userData) {
          const remoteUser = await pool.query('SELECT * FROM users WHERE entry_id = $1', [userData.entryId]);
          const user = remoteUser.rows[0];
          user.receiveTransactionNotifications = booleanToInt(user.receive_transaction_notifications);
          user.createdAt = secondsToMs(user.created_at);
          return res.json({ success: true, data: user, action: 'conflict_resolved', conflict: true });
        }
      }
      
      // تحديث المستخدم الموجود
      const result = await pool.query(
        `UPDATE users SET
          firebase_uid = COALESCE($2, firebase_uid),
          name = $3,
          phone = $4,
          job_title = $5,
          password_hash = $6,
          password_salt = $7,
          account_number = $8,
          app_version_name = COALESCE($9, app_version_name),
          app_version_code = COALESCE($10, app_version_code),
          device_model = COALESCE($11, device_model),
          device_brand = COALESCE($12, device_brand),
          device_manufacturer = COALESCE($13, device_manufacturer),
          device_sdk_int = COALESCE($14, device_sdk_int),
          account_push_token = COALESCE($15, account_push_token),
          receive_transaction_notifications = COALESCE($16, receive_transaction_notifications),
          sync_version = COALESCE($17, sync_version) + 1,
          updated_at = NOW()
        WHERE entry_id = $1
        RETURNING *`,
        [
          userData.entryId,
          userData.firebaseUid,
          userData.name,
          userData.phone,
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
          userData.accountPushToken,
          intToBoolean(userData.receiveTransactionNotifications),
          userData.syncVersion || existingUser.sync_version || 0
        ]
      );

      const user = result.rows[0];
      user.receiveTransactionNotifications = booleanToInt(user.receive_transaction_notifications);
      user.createdAt = secondsToMs(user.created_at);
      return res.json({ success: true, data: user, action: 'updated' });
    } else {
      // إنشاء مستخدم جديد
      const result = await pool.query(
        `INSERT INTO users (
          entry_id, firebase_uid, name, phone, job_title,
          password_hash, password_salt, account_number,
          created_at, app_version_name, app_version_code,
          device_model, device_brand, device_manufacturer,
          device_sdk_int, account_push_token, receive_transaction_notifications, sync_version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING *`,
        [
          userData.entryId,
          userData.firebaseUid || null,
          userData.name,
          userData.phone,
          userData.jobTitle,
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
          userData.accountPushToken || null,
          intToBoolean(userData.receiveTransactionNotifications !== undefined ? userData.receiveTransactionNotifications : 1),
          userData.syncVersion || 1
        ]
      );

      const user = result.rows[0];
      user.receiveTransactionNotifications = booleanToInt(user.receive_transaction_notifications);
      user.createdAt = secondsToMs(user.created_at);
      return res.json({ success: true, data: user, action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 6. Routes - Customers ====================

/**
 * GET /api/customers
 * الحصول على جميع العملاء لمستخدم محدد
 */
app.get('/api/customers', async (req, res) => {
  try {
    const { ownerUserId, ownerFirebaseUid, archived } = req.query;
    
    let query = 'SELECT * FROM customers WHERE 1=1';
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
      query += ` AND archived = $${paramIndex++}`;
      params.push(intToBoolean(archived));
    }
    
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    
    const customers = result.rows.map(row => ({
      id: row.id,
      entryId: row.entry_id,
      cloudId: row.cloud_id,
      firestoreId: row.firestore_id,
      ownerUserId: row.owner_user_id,
      ownerFirebaseUid: row.owner_firebase_uid,
      name: row.name,
      phone: row.phone,
      jobTitle: row.job_title,
      notes: row.notes,
      archived: booleanToInt(row.archived),
      deviceId: row.device_id,
      syncVersion: row.sync_version,
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at),
      cachedTotalBalance: row.cached_total_balance
    }));
    
    res.json({ success: true, data: customers, count: customers.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/customers/:customerId
 * الحصول على عميل محدد
 */
app.get('/api/customers/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const result = await pool.query(
      'SELECT * FROM customers WHERE id = $1',
      [customerId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }
    const row = result.rows[0];
    const customer = {
      id: row.id,
      entryId: row.entry_id,
      cloudId: row.cloud_id,
      firestoreId: row.firestore_id,
      ownerUserId: row.owner_user_id,
      ownerFirebaseUid: row.owner_firebase_uid,
      name: row.name,
      phone: row.phone,
      jobTitle: row.job_title,
      notes: row.notes,
      archived: booleanToInt(row.archived),
      deviceId: row.device_id,
      syncVersion: row.sync_version,
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at),
      cachedTotalBalance: row.cached_total_balance
    };
    res.json({ success: true, data: customer });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/customers
 * إنشاء عميل جديد
 */
app.post('/api/customers', async (req, res) => {
  try {
    const customerData = ensureEntryId(req.body);
    
    const result = await pool.query(
      `INSERT INTO customers (
        entry_id, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        name, phone, job_title, notes, archived,
        device_id, sync_version, created_at, updated_at, cached_total_balance
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING *`,
      [
        customerData.entryId,
        customerData.cloudId || null,
        customerData.firestoreId || null,
        customerData.ownerUserId,
        customerData.ownerFirebaseUid || null,
        customerData.name,
        customerData.phone || null,
        customerData.jobTitle || null,
        customerData.notes || null,
        intToBoolean(customerData.archived !== undefined ? customerData.archived : 0),
        customerData.deviceId || null,
        customerData.syncVersion || 1,
        msToSeconds(customerData.createdAt || Date.now()),
        msToSeconds(customerData.updatedAt || Date.now()),
        customerData.cachedTotalBalance || null
      ]
    );
    const row = result.rows[0];
    const customer = {
      id: row.id,
      entryId: row.entry_id,
      cloudId: row.cloud_id,
      firestoreId: row.firestore_id,
      ownerUserId: row.owner_user_id,
      ownerFirebaseUid: row.owner_firebase_uid,
      name: row.name,
      phone: row.phone,
      jobTitle: row.job_title,
      notes: row.notes,
      archived: booleanToInt(row.archived),
      deviceId: row.device_id,
      syncVersion: row.sync_version,
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at),
      cachedTotalBalance: row.cached_total_balance
    };
    res.status(201).json({ success: true, data: customer });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PUT /api/customers/sync
 * مزامنة عميل (Insert or Update حسب entryId)
 */
app.put('/api/customers/sync', async (req, res) => {
  try {
    const customerData = ensureEntryId(req.body);
    
    const existing = await pool.query(
      'SELECT id, sync_version, updated_at FROM customers WHERE entry_id = $1',
      [customerData.entryId]
    );
    
    if (existing.rows.length > 0) {
      const existingCustomer = existing.rows[0];
      
      // حل التعارضات
      if (customerData.syncVersion && existingCustomer.sync_version) {
        const resolved = await resolveConflict('customers', customerData.entryId, customerData, {
          syncVersion: existingCustomer.sync_version,
          updatedAt: secondsToMs(existingCustomer.updated_at)
        });
        if (resolved !== customerData) {
          const remoteCustomer = await pool.query('SELECT * FROM customers WHERE entry_id = $1', [customerData.entryId]);
          const row = remoteCustomer.rows[0];
          const customer = {
            id: row.id,
            entryId: row.entry_id,
            cloudId: row.cloud_id,
            firestoreId: row.firestore_id,
            ownerUserId: row.owner_user_id,
            ownerFirebaseUid: row.owner_firebase_uid,
            name: row.name,
            phone: row.phone,
            jobTitle: row.job_title,
            notes: row.notes,
            archived: booleanToInt(row.archived),
            deviceId: row.device_id,
            syncVersion: row.sync_version,
            createdAt: secondsToMs(row.created_at),
            updatedAt: secondsToMs(row.updated_at),
            cachedTotalBalance: row.cached_total_balance
          };
          return res.json({ success: true, data: customer, action: 'conflict_resolved', conflict: true });
        }
      }
      
      // تحديث العميل الموجود
      const result = await pool.query(
        `UPDATE customers SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          name = $6,
          phone = COALESCE($7, phone),
          job_title = COALESCE($8, job_title),
          notes = COALESCE($9, notes),
          archived = COALESCE($10, archived),
          device_id = COALESCE($11, device_id),
          sync_version = COALESCE($12, sync_version) + 1,
          updated_at = NOW(),
          cached_total_balance = COALESCE($13, cached_total_balance)
        WHERE entry_id = $1
        RETURNING *`,
        [
          customerData.entryId,
          customerData.cloudId,
          customerData.firestoreId,
          customerData.ownerUserId,
          customerData.ownerFirebaseUid,
          customerData.name,
          customerData.phone,
          customerData.jobTitle,
          customerData.notes,
          intToBoolean(customerData.archived),
          customerData.deviceId,
          customerData.syncVersion || existingCustomer.sync_version || 0,
          customerData.cachedTotalBalance
        ]
      );
      const row = result.rows[0];
      const customer = {
        id: row.id,
        entryId: row.entry_id,
        cloudId: row.cloud_id,
        firestoreId: row.firestore_id,
        ownerUserId: row.owner_user_id,
        ownerFirebaseUid: row.owner_firebase_uid,
        name: row.name,
        phone: row.phone,
        jobTitle: row.job_title,
        notes: row.notes,
        archived: booleanToInt(row.archived),
        deviceId: row.device_id,
        syncVersion: row.sync_version,
        createdAt: secondsToMs(row.created_at),
        updatedAt: secondsToMs(row.updated_at),
        cachedTotalBalance: row.cached_total_balance
      };
      return res.json({ success: true, data: customer, action: 'updated' });
    } else {
      // إنشاء عميل جديد
      const result = await pool.query(
        `INSERT INTO customers (
          entry_id, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          name, phone, job_title, notes, archived,
          device_id, sync_version, created_at, updated_at, cached_total_balance
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING *`,
        [
          customerData.entryId,
          customerData.cloudId || null,
          customerData.firestoreId || null,
          customerData.ownerUserId,
          customerData.ownerFirebaseUid || null,
          customerData.name,
          customerData.phone || null,
          customerData.jobTitle || null,
          customerData.notes || null,
          intToBoolean(customerData.archived !== undefined ? customerData.archived : 0),
          customerData.deviceId || null,
          customerData.syncVersion || 1,
          msToSeconds(customerData.createdAt || Date.now()),
          msToSeconds(customerData.updatedAt || Date.now()),
          customerData.cachedTotalBalance || null
        ]
      );
      const row = result.rows[0];
      const customer = {
        id: row.id,
        entryId: row.entry_id,
        cloudId: row.cloud_id,
        firestoreId: row.firestore_id,
        ownerUserId: row.owner_user_id,
        ownerFirebaseUid: row.owner_firebase_uid,
        name: row.name,
        phone: row.phone,
        jobTitle: row.job_title,
        notes: row.notes,
        archived: booleanToInt(row.archived),
        deviceId: row.device_id,
        syncVersion: row.sync_version,
        createdAt: secondsToMs(row.created_at),
        updatedAt: secondsToMs(row.updated_at),
        cachedTotalBalance: row.cached_total_balance
      };
      return res.json({ success: true, data: customer, action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 7. Routes - Cash Accounts ====================

/**
 * GET /api/cash-accounts
 * الحصول على جميع الحسابات النقدية
 */
app.get('/api/cash-accounts', async (req, res) => {
  try {
    const { ownerUserId, ownerFirebaseUid } = req.query;
    
    let query = 'SELECT * FROM cash_accounts WHERE 1=1';
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
    
    const accounts = result.rows.map(row => ({
      id: row.id,
      entryId: row.entry_id,
      cloudId: row.cloud_id,
      firestoreId: row.firestore_id,
      ownerUserId: row.owner_user_id,
      ownerFirebaseUid: row.owner_firebase_uid,
      name: row.name,
      isPrimary: booleanToInt(row.is_primary),
      isShared: booleanToInt(row.is_shared),
      color: row.color,
      deviceId: row.device_id,
      syncVersion: row.sync_version,
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at)
    }));
    
    res.json({ success: true, data: accounts, count: accounts.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PUT /api/cash-accounts/sync
 * مزامنة حساب نقدي
 */
app.put('/api/cash-accounts/sync', async (req, res) => {
  try {
    const accountData = ensureEntryId(req.body);
    
    const existing = await pool.query(
      'SELECT id, sync_version, updated_at FROM cash_accounts WHERE entry_id = $1',
      [accountData.entryId]
    );
    
    if (existing.rows.length > 0) {
      const existingAccount = existing.rows[0];
      
      // حل التعارضات
      if (accountData.syncVersion && existingAccount.sync_version) {
        const resolved = await resolveConflict('cash_accounts', accountData.entryId, accountData, {
          syncVersion: existingAccount.sync_version,
          updatedAt: secondsToMs(existingAccount.updated_at)
        });
        if (resolved !== accountData) {
          const remoteAccount = await pool.query('SELECT * FROM cash_accounts WHERE entry_id = $1', [accountData.entryId]);
          const row = remoteAccount.rows[0];
          const account = {
            id: row.id,
            entryId: row.entry_id,
            cloudId: row.cloud_id,
            firestoreId: row.firestore_id,
            ownerUserId: row.owner_user_id,
            ownerFirebaseUid: row.owner_firebase_uid,
            name: row.name,
            isPrimary: booleanToInt(row.is_primary),
            isShared: booleanToInt(row.is_shared),
            color: row.color,
            deviceId: row.device_id,
            syncVersion: row.sync_version,
            createdAt: secondsToMs(row.created_at),
            updatedAt: secondsToMs(row.updated_at)
          };
          return res.json({ success: true, data: account, action: 'conflict_resolved', conflict: true });
        }
      }
      
      const result = await pool.query(
        `UPDATE cash_accounts SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          name = $6,
          is_primary = COALESCE($7, is_primary),
          is_shared = COALESCE($8, is_shared),
          color = $9,
          device_id = COALESCE($10, device_id),
          sync_version = COALESCE($11, sync_version) + 1,
          updated_at = NOW()
        WHERE entry_id = $1
        RETURNING *`,
        [
          accountData.entryId,
          accountData.cloudId,
          accountData.firestoreId,
          accountData.ownerUserId,
          accountData.ownerFirebaseUid,
          accountData.name,
          intToBoolean(accountData.isPrimary),
          intToBoolean(accountData.isShared),
          accountData.color,
          accountData.deviceId,
          accountData.syncVersion || existingAccount.sync_version || 0
        ]
      );
      const row = result.rows[0];
      const account = {
        id: row.id,
        entryId: row.entry_id,
        cloudId: row.cloud_id,
        firestoreId: row.firestore_id,
        ownerUserId: row.owner_user_id,
        ownerFirebaseUid: row.owner_firebase_uid,
        name: row.name,
        isPrimary: booleanToInt(row.is_primary),
        isShared: booleanToInt(row.is_shared),
        color: row.color,
        deviceId: row.device_id,
        syncVersion: row.sync_version,
        createdAt: secondsToMs(row.created_at),
        updatedAt: secondsToMs(row.updated_at)
      };
      return res.json({ success: true, data: account, action: 'updated' });
    } else {
      const result = await pool.query(
        `INSERT INTO cash_accounts (
          entry_id, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          name, is_primary, is_shared, color,
          device_id, sync_version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *`,
        [
          accountData.entryId,
          accountData.cloudId || null,
          accountData.firestoreId || null,
          accountData.ownerUserId,
          accountData.ownerFirebaseUid || null,
          accountData.name,
          intToBoolean(accountData.isPrimary !== undefined ? accountData.isPrimary : 0),
          intToBoolean(accountData.isShared !== undefined ? accountData.isShared : 0),
          accountData.color,
          accountData.deviceId || null,
          accountData.syncVersion || 1,
          msToSeconds(accountData.createdAt || Date.now()),
          msToSeconds(accountData.updatedAt || Date.now())
        ]
      );
      const row = result.rows[0];
      const account = {
        id: row.id,
        entryId: row.entry_id,
        cloudId: row.cloud_id,
        firestoreId: row.firestore_id,
        ownerUserId: row.owner_user_id,
        ownerFirebaseUid: row.owner_firebase_uid,
        name: row.name,
        isPrimary: booleanToInt(row.is_primary),
        isShared: booleanToInt(row.is_shared),
        color: row.color,
        deviceId: row.device_id,
        syncVersion: row.sync_version,
        createdAt: secondsToMs(row.created_at),
        updatedAt: secondsToMs(row.updated_at)
      };
      return res.json({ success: true, data: account, action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 8. Routes - Transactions ====================

/**
 * GET /api/transactions
 * الحصول على المعاملات
 */
app.get('/api/transactions', async (req, res) => {
  try {
    const { ownerUserId, customerId, accountId, synced, limit, offset } = req.query;
    
    let query = 'SELECT * FROM transactions WHERE deleted_at IS NULL';
    const params = [];
    let paramIndex = 1;
    
    if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
    }
    if (customerId) {
      query += ` AND customer_id = $${paramIndex++}`;
      params.push(customerId);
    }
    if (accountId) {
      query += ` AND account_id = $${paramIndex++}`;
      params.push(accountId);
    }
    if (synced !== undefined) {
      query += ` AND synced = $${paramIndex++}`;
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
    
    const transactions = result.rows.map(row => ({
      id: row.id,
      entryId: row.entry_id,
      cloudId: row.cloud_id,
      firestoreId: row.firestore_id,
      ownerUserId: row.owner_user_id,
      ownerFirebaseUid: row.owner_firebase_uid,
      customerId: row.customer_id,
      accountId: row.account_id,
      customerFirestoreId: row.customer_firestore_id,
      accountFirestoreId: row.account_firestore_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      direction: row.direction,
      note: row.note,
      transactionDate: secondsToMs(row.transaction_date),
      notifyCustomer: booleanToInt(row.notify_customer),
      synced: booleanToInt(row.synced),
      deviceId: row.device_id,
      transactionNumber: row.transaction_number,
      syncVersion: row.sync_version,
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at),
      deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
    }));
    
    res.json({ success: true, data: transactions, count: transactions.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * GET /api/transactions/:transactionId
 * الحصول على معاملة محددة
 */
app.get('/api/transactions/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const result = await pool.query(
      'SELECT * FROM transactions WHERE id = $1 AND deleted_at IS NULL',
      [transactionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    const row = result.rows[0];
    const transaction = {
      id: row.id,
      entryId: row.entry_id,
      cloudId: row.cloud_id,
      firestoreId: row.firestore_id,
      ownerUserId: row.owner_user_id,
      ownerFirebaseUid: row.owner_firebase_uid,
      customerId: row.customer_id,
      accountId: row.account_id,
      customerFirestoreId: row.customer_firestore_id,
      accountFirestoreId: row.account_firestore_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      direction: row.direction,
      note: row.note,
      transactionDate: secondsToMs(row.transaction_date),
      notifyCustomer: booleanToInt(row.notify_customer),
      synced: booleanToInt(row.synced),
      deviceId: row.device_id,
      transactionNumber: row.transaction_number,
      syncVersion: row.sync_version,
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at),
      deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
    };
    res.json({ success: true, data: transaction });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/transactions
 * إنشاء معاملة جديدة
 */
app.post('/api/transactions', async (req, res) => {
  try {
    const transactionData = ensureEntryId(req.body);
    
    const result = await pool.query(
      `INSERT INTO transactions (
        entry_id, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        customer_id, account_id, customer_firestore_id, account_firestore_id,
        amount, currency, direction, note, transaction_date,
        notify_customer, synced, device_id, transaction_number, sync_version,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
      RETURNING *`,
      [
        transactionData.entryId,
        transactionData.cloudId || null,
        transactionData.firestoreId || null,
        transactionData.ownerUserId,
        transactionData.ownerFirebaseUid || null,
        transactionData.customerId,
        transactionData.accountId,
        transactionData.customerFirestoreId || null,
        transactionData.accountFirestoreId || null,
        transactionData.amount,
        transactionData.currency,
        transactionData.direction,
        transactionData.note || null,
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
    const row = result.rows[0];
    const transaction = {
      id: row.id,
      entryId: row.entry_id,
      cloudId: row.cloud_id,
      firestoreId: row.firestore_id,
      ownerUserId: row.owner_user_id,
      ownerFirebaseUid: row.owner_firebase_uid,
      customerId: row.customer_id,
      accountId: row.account_id,
      customerFirestoreId: row.customer_firestore_id,
      accountFirestoreId: row.account_firestore_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      direction: row.direction,
      note: row.note,
      transactionDate: secondsToMs(row.transaction_date),
      notifyCustomer: booleanToInt(row.notify_customer),
      synced: booleanToInt(row.synced),
      deviceId: row.device_id,
      transactionNumber: row.transaction_number,
      syncVersion: row.sync_version,
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at),
      deletedAt: null
    };
    res.status(201).json({ success: true, data: transaction });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PUT /api/transactions/sync
 * مزامنة معاملة (Insert or Update حسب entryId)
 */
app.put('/api/transactions/sync', async (req, res) => {
  try {
    const transactionData = ensureEntryId(req.body);
    
    const existing = await pool.query(
      'SELECT id, sync_version, updated_at FROM transactions WHERE entry_id = $1',
      [transactionData.entryId]
    );
    
    if (existing.rows.length > 0) {
      const existingTransaction = existing.rows[0];
      
      // حل التعارضات
      if (transactionData.syncVersion && existingTransaction.sync_version) {
        const resolved = await resolveConflict('transactions', transactionData.entryId, transactionData, {
          syncVersion: existingTransaction.sync_version,
          updatedAt: secondsToMs(existingTransaction.updated_at)
        });
        if (resolved !== transactionData) {
          const remoteTransaction = await pool.query('SELECT * FROM transactions WHERE entry_id = $1', [transactionData.entryId]);
          const row = remoteTransaction.rows[0];
          const transaction = {
            id: row.id,
            entryId: row.entry_id,
            cloudId: row.cloud_id,
            firestoreId: row.firestore_id,
            ownerUserId: row.owner_user_id,
            ownerFirebaseUid: row.owner_firebase_uid,
            customerId: row.customer_id,
            accountId: row.account_id,
            customerFirestoreId: row.customer_firestore_id,
            accountFirestoreId: row.account_firestore_id,
            amount: parseFloat(row.amount),
            currency: row.currency,
            direction: row.direction,
            note: row.note,
            transactionDate: secondsToMs(row.transaction_date),
            notifyCustomer: booleanToInt(row.notify_customer),
            synced: booleanToInt(row.synced),
            deviceId: row.device_id,
            transactionNumber: row.transaction_number,
            syncVersion: row.sync_version,
            createdAt: secondsToMs(row.created_at),
            updatedAt: secondsToMs(row.updated_at),
            deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
          };
          return res.json({ success: true, data: transaction, action: 'conflict_resolved', conflict: true });
        }
      }
      
      // تحديث المعاملة الموجودة
      const result = await pool.query(
        `UPDATE transactions SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          customer_id = $6,
          account_id = $7,
          customer_firestore_id = COALESCE($8, customer_firestore_id),
          account_firestore_id = COALESCE($9, account_firestore_id),
          amount = $10,
          currency = $11,
          direction = $12,
          note = COALESCE($13, note),
          transaction_date = $14,
          notify_customer = COALESCE($15, notify_customer),
          synced = COALESCE($16, synced),
          device_id = COALESCE($17, device_id),
          transaction_number = COALESCE($18, transaction_number),
          sync_version = COALESCE($19, sync_version) + 1,
          updated_at = NOW()
        WHERE entry_id = $1 AND deleted_at IS NULL
        RETURNING *`,
        [
          transactionData.entryId,
          transactionData.cloudId,
          transactionData.firestoreId,
          transactionData.ownerUserId,
          transactionData.ownerFirebaseUid,
          transactionData.customerId,
          transactionData.accountId,
          transactionData.customerFirestoreId,
          transactionData.accountFirestoreId,
          transactionData.amount,
          transactionData.currency,
          transactionData.direction,
          transactionData.note,
          msToSeconds(transactionData.transactionDate),
          intToBoolean(transactionData.notifyCustomer),
          intToBoolean(transactionData.synced),
          transactionData.deviceId,
          transactionData.transactionNumber,
          transactionData.syncVersion || existingTransaction.sync_version || 0
        ]
      );
      const row = result.rows[0];
      const transaction = {
        id: row.id,
        entryId: row.entry_id,
        cloudId: row.cloud_id,
        firestoreId: row.firestore_id,
        ownerUserId: row.owner_user_id,
        ownerFirebaseUid: row.owner_firebase_uid,
        customerId: row.customer_id,
        accountId: row.account_id,
        customerFirestoreId: row.customer_firestore_id,
        accountFirestoreId: row.account_firestore_id,
        amount: parseFloat(row.amount),
        currency: row.currency,
        direction: row.direction,
        note: row.note,
        transactionDate: secondsToMs(row.transaction_date),
        notifyCustomer: booleanToInt(row.notify_customer),
        synced: booleanToInt(row.synced),
        deviceId: row.device_id,
        transactionNumber: row.transaction_number,
        syncVersion: row.sync_version,
        createdAt: secondsToMs(row.created_at),
        updatedAt: secondsToMs(row.updated_at),
        deletedAt: row.deleted_at ? secondsToMs(row.deleted_at) : null
      };
      return res.json({ success: true, data: transaction, action: 'updated' });
    } else {
      // إنشاء معاملة جديدة
      const result = await pool.query(
        `INSERT INTO transactions (
          entry_id, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          customer_id, account_id, customer_firestore_id, account_firestore_id,
          amount, currency, direction, note, transaction_date,
          notify_customer, synced, device_id, transaction_number, sync_version,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
        RETURNING *`,
        [
          transactionData.entryId,
          transactionData.cloudId || null,
          transactionData.firestoreId || null,
          transactionData.ownerUserId,
          transactionData.ownerFirebaseUid || null,
          transactionData.customerId,
          transactionData.accountId,
          transactionData.customerFirestoreId || null,
          transactionData.accountFirestoreId || null,
          transactionData.amount,
          transactionData.currency,
          transactionData.direction,
          transactionData.note || null,
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
      const row = result.rows[0];
      const transaction = {
        id: row.id,
        entryId: row.entry_id,
        cloudId: row.cloud_id,
        firestoreId: row.firestore_id,
        ownerUserId: row.owner_user_id,
        ownerFirebaseUid: row.owner_firebase_uid,
        customerId: row.customer_id,
        accountId: row.account_id,
        customerFirestoreId: row.customer_firestore_id,
        accountFirestoreId: row.account_firestore_id,
        amount: parseFloat(row.amount),
        currency: row.currency,
        direction: row.direction,
        note: row.note,
        transactionDate: secondsToMs(row.transaction_date),
        notifyCustomer: booleanToInt(row.notify_customer),
        synced: booleanToInt(row.synced),
        deviceId: row.device_id,
        transactionNumber: row.transaction_number,
        syncVersion: row.sync_version,
        createdAt: secondsToMs(row.created_at),
        updatedAt: secondsToMs(row.updated_at),
        deletedAt: null
      };
      return res.json({ success: true, data: transaction, action: 'created' });
    }
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * DELETE /api/transactions/:transactionId
 * حذف معاملة (Soft Delete)
 */
app.delete('/api/transactions/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const result = await pool.query(
      `UPDATE transactions 
       SET deleted_at = NOW(), sync_version = sync_version + 1, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [transactionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }
    res.json({ success: true, message: 'تم حذف المعاملة بنجاح' });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 9. Routes - Notifications ====================

/**
 * GET /api/notifications
 * الحصول على الإشعارات
 */
app.get('/api/notifications', async (req, res) => {
  try {
    const { isRead, limit, offset } = req.query;
    
    let query = 'SELECT * FROM notifications WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (isRead !== undefined) {
      query += ` AND is_read = $${paramIndex++}`;
      params.push(intToBoolean(isRead));
    }
    
    query += ' ORDER BY created_at DESC';
    
    if (limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(parseInt(limit));
    }
    if (offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(parseInt(offset));
    }
    
    const result = await pool.query(query, params);
    
    const notifications = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      body: row.body,
      route: row.route,
      createdAt: secondsToMs(row.created_at),
      isRead: booleanToInt(row.is_read)
    }));
    
    res.json({ success: true, data: notifications, count: notifications.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/notifications
 * إنشاء إشعار جديد
 */
app.post('/api/notifications', async (req, res) => {
  try {
    const { title, body, route } = req.body;
    
    const result = await pool.query(
      `INSERT INTO notifications (title, body, route, created_at, is_read)
       VALUES ($1, $2, $3, NOW(), false)
       RETURNING *`,
      [title, body, route || null]
    );
    
    const row = result.rows[0];
    const notification = {
      id: row.id,
      title: row.title,
      body: row.body,
      route: row.route,
      createdAt: secondsToMs(row.created_at),
      isRead: booleanToInt(row.is_read)
    };
    
    res.status(201).json({ success: true, data: notification });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * PUT /api/notifications/:notificationId/read
 * تحديد إشعار كمقروء
 */
app.put('/api/notifications/:notificationId/read', async (req, res) => {
  try {
    const { notificationId } = req.params;
    const result = await pool.query(
      `UPDATE notifications SET is_read = true WHERE id = $1 RETURNING *`,
      [notificationId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الإشعار غير موجود' });
    }
    
    const row = result.rows[0];
    const notification = {
      id: row.id,
      title: row.title,
      body: row.body,
      route: row.route,
      createdAt: secondsToMs(row.created_at),
      isRead: booleanToInt(row.is_read)
    };
    
    res.json({ success: true, data: notification });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 10. Routes - Bulk Sync ====================

/**
 * POST /api/sync/bulk
 * مزامنة مجمعة لعدة كيانات في طلب واحد
 */
app.post('/api/sync/bulk', async (req, res) => {
  try {
    const { users, customers, cashAccounts, transactions } = req.body;
    const results = {
      users: { created: 0, updated: 0, errors: [] },
      customers: { created: 0, updated: 0, errors: [] },
      cashAccounts: { created: 0, updated: 0, errors: [] },
      transactions: { created: 0, updated: 0, errors: [] }
    };
    
    // معالجة المستخدمين
    if (users && Array.isArray(users)) {
      for (const userData of users) {
        try {
          const userDataWithEntryId = ensureEntryId(userData);
          const existing = await pool.query(
            'SELECT id, sync_version FROM users WHERE entry_id = $1',
            [userDataWithEntryId.entryId]
          );
          
          if (existing.rows.length > 0) {
            await pool.query(
              `UPDATE users SET
                firebase_uid = COALESCE($2, firebase_uid),
                name = $3,
                phone = $4,
                sync_version = sync_version + 1,
                updated_at = NOW()
              WHERE entry_id = $1`,
              [
                userDataWithEntryId.entryId,
                userDataWithEntryId.firebaseUid,
                userDataWithEntryId.name,
                userDataWithEntryId.phone
              ]
            );
            results.users.updated++;
          } else {
            await pool.query(
              `INSERT INTO users (entry_id, firebase_uid, name, phone, job_title, password_hash, password_salt, account_number, created_at, sync_version)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)`,
              [
                userDataWithEntryId.entryId,
                userDataWithEntryId.firebaseUid || null,
                userDataWithEntryId.name,
                userDataWithEntryId.phone,
                userDataWithEntryId.jobTitle,
                userDataWithEntryId.passwordHash,
                userDataWithEntryId.passwordSalt,
                userDataWithEntryId.accountNumber,
                userDataWithEntryId.syncVersion || 1
              ]
            );
            results.users.created++;
          }
        } catch (error) {
          results.users.errors.push({ entryId: userData.entryId, error: error.message });
        }
      }
    }
    
    // معالجة العملاء
    if (customers && Array.isArray(customers)) {
      for (const customerData of customers) {
        try {
          const customerDataWithEntryId = ensureEntryId(customerData);
          const existing = await pool.query(
            'SELECT id FROM customers WHERE entry_id = $1',
            [customerDataWithEntryId.entryId]
          );
          
          if (existing.rows.length > 0) {
            await pool.query(
              `UPDATE customers SET
                name = $2,
                sync_version = sync_version + 1,
                updated_at = NOW()
              WHERE entry_id = $1`,
              [customerDataWithEntryId.entryId, customerDataWithEntryId.name]
            );
            results.customers.updated++;
          } else {
            await pool.query(
              `INSERT INTO customers (entry_id, owner_user_id, name, created_at, updated_at, sync_version)
               VALUES ($1, $2, $3, NOW(), NOW(), $4)`,
              [
                customerDataWithEntryId.entryId,
                customerDataWithEntryId.ownerUserId,
                customerDataWithEntryId.name,
                customerDataWithEntryId.syncVersion || 1
              ]
            );
            results.customers.created++;
          }
        } catch (error) {
          results.customers.errors.push({ entryId: customerData.entryId, error: error.message });
        }
      }
    }
    
    // معالجة الحسابات النقدية
    if (cashAccounts && Array.isArray(cashAccounts)) {
      for (const accountData of cashAccounts) {
        try {
          const accountDataWithEntryId = ensureEntryId(accountData);
          const existing = await pool.query(
            'SELECT id FROM cash_accounts WHERE entry_id = $1',
            [accountDataWithEntryId.entryId]
          );
          
          if (existing.rows.length > 0) {
            await pool.query(
              `UPDATE cash_accounts SET
                name = $2,
                sync_version = sync_version + 1,
                updated_at = NOW()
              WHERE entry_id = $1`,
              [accountDataWithEntryId.entryId, accountDataWithEntryId.name]
            );
            results.cashAccounts.updated++;
          } else {
            await pool.query(
              `INSERT INTO cash_accounts (entry_id, owner_user_id, name, is_primary, is_shared, color, created_at, updated_at, sync_version)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW(), $7)`,
              [
                accountDataWithEntryId.entryId,
                accountDataWithEntryId.ownerUserId,
                accountDataWithEntryId.name,
                intToBoolean(accountDataWithEntryId.isPrimary || 0),
                intToBoolean(accountDataWithEntryId.isShared || 0),
                accountDataWithEntryId.color,
                accountDataWithEntryId.syncVersion || 1
              ]
            );
            results.cashAccounts.created++;
          }
        } catch (error) {
          results.cashAccounts.errors.push({ entryId: accountData.entryId, error: error.message });
        }
      }
    }
    
    // معالجة المعاملات
    if (transactions && Array.isArray(transactions)) {
      for (const transactionData of transactions) {
        try {
          const transactionDataWithEntryId = ensureEntryId(transactionData);
          const existing = await pool.query(
            'SELECT id FROM transactions WHERE entry_id = $1',
            [transactionDataWithEntryId.entryId]
          );
          
          if (existing.rows.length > 0) {
            await pool.query(
              `UPDATE transactions SET
                amount = $2,
                sync_version = sync_version + 1,
                updated_at = NOW()
              WHERE entry_id = $1 AND deleted_at IS NULL`,
              [transactionDataWithEntryId.entryId, transactionDataWithEntryId.amount]
            );
            results.transactions.updated++;
          } else {
            await pool.query(
              `INSERT INTO transactions (entry_id, owner_user_id, customer_id, account_id, amount, currency, direction, transaction_date, created_at, updated_at, sync_version)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), NOW(), $8)`,
              [
                transactionDataWithEntryId.entryId,
                transactionDataWithEntryId.ownerUserId,
                transactionDataWithEntryId.customerId,
                transactionDataWithEntryId.accountId,
                transactionDataWithEntryId.amount,
                transactionDataWithEntryId.currency,
                transactionDataWithEntryId.direction,
                transactionDataWithEntryId.syncVersion || 1
              ]
            );
            results.transactions.created++;
          }
        } catch (error) {
          results.transactions.errors.push({ entryId: transactionData.entryId, error: error.message });
        }
      }
    }
    
    res.json({ success: true, results });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 11. Routes - Account Numbers ====================

/**
 * GET /api/account-numbers
 * الحصول على أرقام الحسابات
 */
app.get('/api/account-numbers', async (req, res) => {
  try {
    const { userId, isActive } = req.query;
    
    let query = 'SELECT * FROM account_numbers WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (userId) {
      query += ` AND user_id = $${paramIndex++}`;
      params.push(userId);
    }
    if (isActive !== undefined) {
      query += ` AND is_active = $${paramIndex++}`;
      params.push(intToBoolean(isActive));
    }
    
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    
    const accountNumbers = result.rows.map(row => ({
      id: row.id,
      accountNumber: row.account_number,
      userId: row.user_id,
      userName: row.user_name,
      phone: row.phone,
      firebaseUid: row.firebase_uid,
      createdAt: secondsToMs(row.created_at),
      isActive: booleanToInt(row.is_active)
    }));
    
    res.json({ success: true, data: accountNumbers, count: accountNumbers.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/account-numbers
 * إنشاء رقم حساب جديد
 */
app.post('/api/account-numbers', async (req, res) => {
  try {
    const { accountNumber, userId, userName, phone, firebaseUid } = req.body;
    
    const result = await pool.query(
      `INSERT INTO account_numbers (account_number, user_id, user_name, phone, firebase_uid, created_at, is_active)
       VALUES ($1, $2, $3, $4, $5, NOW(), true)
       RETURNING *`,
      [accountNumber, userId, userName, phone, firebaseUid || null]
    );
    
    const row = result.rows[0];
    const accountNumberData = {
      id: row.id,
      accountNumber: row.account_number,
      userId: row.user_id,
      userName: row.user_name,
      phone: row.phone,
      firebaseUid: row.firebase_uid,
      createdAt: secondsToMs(row.created_at),
      isActive: booleanToInt(row.is_active)
    };
    
    res.status(201).json({ success: true, data: accountNumberData });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'رقم الحساب موجود بالفعل' });
    }
    handleError(res, error);
  }
});

// ==================== 12. Routes - Failed Operations ====================

/**
 * GET /api/failed-operations
 * الحصول على العمليات الفاشلة
 */
app.get('/api/failed-operations', async (req, res) => {
  try {
    const { status, limit } = req.query;
    
    let query = 'SELECT * FROM failed_operations WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }
    
    query += ' ORDER BY created_at DESC';
    
    if (limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(parseInt(limit));
    }
    
    const result = await pool.query(query, params);
    
    const failedOps = result.rows.map(row => ({
      id: row.id,
      operationType: row.operation_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: JSON.parse(row.payload),
      errorMessage: row.error_message,
      errorType: row.error_type,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      priority: row.priority,
      createdAt: secondsToMs(row.created_at),
      lastAttemptAt: row.last_attempt_at ? secondsToMs(row.last_attempt_at) : null,
      nextRetryAt: secondsToMs(row.next_retry_at),
      status: row.status
    }));
    
    res.json({ success: true, data: failedOps, count: failedOps.length });
  } catch (error) {
    handleError(res, error);
  }
});

/**
 * POST /api/failed-operations
 * تسجيل عملية فاشلة
 */
app.post('/api/failed-operations', async (req, res) => {
  try {
    const failedOpData = req.body;
    
    const result = await pool.query(
      `INSERT INTO failed_operations (
        id, operation_type, entity_type, entity_id, payload,
        error_message, error_type, attempt_count, max_attempts,
        priority, created_at, next_retry_at, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW() + INTERVAL '1 hour', $11)
      RETURNING *`,
      [
        failedOpData.id || uuidv4(),
        failedOpData.operationType,
        failedOpData.entityType,
        failedOpData.entityId || null,
        JSON.stringify(failedOpData.payload),
        failedOpData.errorMessage,
        failedOpData.errorType,
        failedOpData.attemptCount || 1,
        failedOpData.maxAttempts || 3,
        failedOpData.priority || 0,
        failedOpData.status || 'pending'
      ]
    );
    
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 13. Routes - Health Check ====================

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

// ==================== 14. Error Handling Middleware ====================
app.use((err, req, res, next) => {
  handleError(res, err);
});

// ==================== 15. 404 Handler ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'المسار غير موجود'
  });
});

// ==================== 16. Start Server ====================
app.listen(PORT, () => {
  console.log(`🚀 خادم MalyMax Sync API يعمل على المنفذ ${PORT}`);
  console.log(`📡 API متاح على: http://localhost:${PORT}`);
  console.log(`🏥 Health Check: http://localhost:${PORT}/api/health`);
  console.log(`\n📋 Endpoints المتاحة:`);
  console.log(`   GET    /api/users/:userId`);
  console.log(`   PUT    /api/users/sync`);
  console.log(`   GET    /api/customers`);
  console.log(`   PUT    /api/customers/sync`);
  console.log(`   GET    /api/cash-accounts`);
  console.log(`   PUT    /api/cash-accounts/sync`);
  console.log(`   GET    /api/transactions`);
  console.log(`   PUT    /api/transactions/sync`);
  console.log(`   POST   /api/sync/bulk`);
  console.log(`   GET    /api/health\n`);
});

// ==================== 17. Graceful Shutdown ====================
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
