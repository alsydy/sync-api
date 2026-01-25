// ============================================================================
// MalyMax Professional Sync API Server - PostgreSQL
// ============================================================================
// نظام مزامنة احترافي ومحسّن مع أمان عالي
// يدعم العمل أونلاين وأوفلاين مع مزامنة ذكية
// ============================================================================

require('dotenv').config();
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const timeout = require('connect-timeout');

// Import config
const { pool } = require('./config/database');
const logger = require('./utils/logger');

// Import middleware
const { 
  authenticate, 
  optionalAuthenticate, 
  authorizeResource,
  generalLimiter,
  syncLimiter,
  generateToken 
} = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

// Import utils
const {
  intToBoolean,
  booleanToInt,
  msToSeconds,
  secondsToMs,
  verifyPassword,
  isValidUUID,
  ensureUuid,
  getUserIdFromFirebaseUid,
  normalizeOwnerUserId,
  normalizeColorCode,
  getClientIdFromFirestoreId,
  normalizeClientId,
  getAccountIdFromFirestoreId,
  normalizeAccountId,
  normalizeTransactionDirection
} = require('./utils/helpers');

// Import mappers
const {
  mapUserToAPI,
  mapClientToAPI,
  mapAccountToAPI,
  mapTransactionToAPI
} = require('./utils/mappers');

// Import services
const { resolveConflict } = require('./services/conflictResolver');
const { logAudit } = require('./services/auditService');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const healthRoutes = require('./routes/health');
const clientRoutes = require('./routes/clients');
const accountRoutes = require('./routes/accounts');
const transactionRoutes = require('./routes/transactions');
const subscriptionRoutes = require('./routes/subscriptions');
const fcmTokenRoutes = require('./routes/fcm-tokens');
const settingsRoutes = require('./routes/settings');

// ==================== 1. تهيئة Express Server ====================
const app = express();
const PORT = process.env.PORT || 3001;

// ==================== 2. Middleware ====================

// Security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
}));

// CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));

// Compression
app.use(compression());

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request timeout
app.use(timeout('30s'));

// Rate limiting
app.use(generalLimiter);

// Request ID middleware
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Timeout handler
app.use((req, res, next) => {
  if (!req.timedout) next();
});

// ==================== 3. Routes ====================

// Health & Info routes (before /api prefix)
app.use('/', healthRoutes);
app.use('/api', healthRoutes);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/fcm-tokens', fcmTokenRoutes);
app.use('/api/settings', settingsRoutes);

// ==================== 4. دوال مساعدة (Legacy - للتوافق) ====================
// ملاحظة: جميع الدوال المساعدة موجودة الآن في:
// - utils/helpers.js (intToBoolean, msToSeconds, etc.)
// - utils/mappers.js (mapUserToAPI, mapClientToAPI, etc.)
// - services/conflictResolver.js (resolveConflict)
// - services/auditService.js (logAudit)
// تم الاحتفاظ بالدوال هنا للتوافق مع الكود القديم
// يُنصح باستخدام الدوال من الملفات الجديدة بدلاً منها

// ملاحظة: mapUserToAPI, mapClientToAPI, mapAccountToAPI, mapTransactionToAPI
// مستوردة من utils/mappers.js أعلاه، لكن تم الاحتفاظ بالتعريفات هنا للتوافق

// ==================== 5. Routes - Authentication & Users ====================
// ملاحظة: Routes للمصادقة والمستخدمين موجودة الآن في routes/auth.js و routes/users.js
// تم إزالة Routes المكررة - الآن نعتمد فقط على routes من الملفات المنفصلة

// Routes للمستخدمين تم نقلها إلى routes/users.js (تستخدم controllers)
// Routes للمصادقة تم نقلها إلى routes/auth.js (تستخدم controllers)

// ==================== 6. Routes - Account Numbers ====================

/**
 * POST /api/account-numbers/next
 * الحصول على رقم حساب جديد (محجوز)
 */
app.post('/api/account-numbers/next', async (req, res) => {
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
        logger.info(`Generated account number on server: ${accountNumber}`);
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`Failed to generate account number:`, error);
        throw error;
      } finally {
        client.release();
      }
    }
    
    const createdAtSeconds = msToSeconds(userData.createdAt || Date.now());
    logger.info(`Creating new user (POST): uuid=${userUuid}, firebaseUid=${userData.firebaseUid}, name=${userData.name || userData.fullName}, phone=${userData.phone || userData.phoneNumber}, accountNumber=${accountNumber}, createdAt=${createdAtSeconds}`);
    
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
    
    logger.info(`User created successfully: user_id=${user.user_id}, firebase_uid=${user.firebase_uid}, accountNumber=${user.account_number}, token generated`);

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

// ==================== 5.5 Routes - Users Sync (Legacy) ====================
// ملاحظة: PUT /api/users/sync موجود الآن في routes/users.js
// تم إزالة Route المكرر - الآن نعتمد فقط على routes من الملفات المنفصلة
// تم الاحتفاظ بالتعليق هنا للتوثيق فقط

// Route للمزامنة تم نقله إلى routes/users.js (يستخدم controllers)

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
// ملاحظة: Routes للعملاء موجودة الآن في routes/clients.js
// تم نقل Routes إلى routes/clients.js (تستخدم controllers)

// ==================== 8. Routes - Cash Accounts ====================
// ملاحظة: Routes للحسابات موجودة الآن في routes/accounts.js
// تم نقل Routes إلى routes/accounts.js (تستخدم controllers)

// ==================== 9. Routes - Transactions ====================
// ملاحظة: Routes للمعاملات موجودة الآن في routes/transactions.js
// تم نقل Routes إلى routes/transactions.js (تستخدم controllers)
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
        logger.error('ownerUserId is null in UPDATE transaction', { transactionData });
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
        logger.error('accountId is null in UPDATE transaction', { transactionData });
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
        logger.info(`Creating shared main account with ownerUserId: ${ownerUserId}`);
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
            logger.info(`Created shared main account with account_id: ${accountId}`);
          }
        } catch (error) {
          logger.error(`Error creating shared main account: ${error.message}`);
          // إذا فشل الإنشاء بسبب conflict، حاول البحث مرة أخرى
          if (error.code === '23505') { // unique_violation
            logger.info(`Account already exists, searching again...`);
            accountId = await getAccountIdFromFirestoreId('shared-main-account-v1');
          }
        }
      }
      
      // التحقق من أن accountId موجود (لأنه NOT NULL)
      if (!accountId) {
        logger.error('accountId is null in INSERT transaction', { transactionData });
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
    
    res.json({ success: true, message: 'تم حذف المعاملة بنجاح' });
  } catch (error) {
    handleError(res, error);
  }
});

// ==================== 10. Routes - Health & Info ====================
// ملاحظة: Routes للـ health و info موجودة الآن في routes/health.js
// تم إزالة Routes المكررة - الآن نعتمد فقط على routes من الملفات المنفصلة
// Routes للـ health تم نقلها إلى routes/health.js (تستخدم logger)

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
        logger.warning(`Security: User ${userFirebaseUid} attempted to access subscription for ${firebaseUid}`);
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
        logger.warning(`Security: User ${req.user.firebaseUid} attempted to create request for ${firebaseUid}`);
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
    
    logger.info(`Subscription request created: request_id=${request.request_id}, user=${finalFirebaseUid || userPhone}, package=${packageId}`);

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
      firebaseUid,
      token,
      deviceModel,
      deviceBrand,
      deviceManufacturer,
      appVersionName,
      appVersionCode
    } = req.body;

    logger.info(`Receiving FCM token registration request: firebaseUid=${firebaseUid}, token=${token?.substring(0, 20)}...`);

    // ✅ Input Validation
    if (!token) {
      logger.warning('Validation failed: token is required');
      return res.status(400).json({ success: false, error: 'token مطلوب' });
    }
    
    if (typeof token !== 'string' || token.trim().length === 0) {
      logger.warning('Validation failed: token is invalid');
      return res.status(400).json({ success: false, error: 'token غير صحيح' });
    }

    // ✅ Security: إذا كان المستخدم مصادقاً، استخدم firebaseUid من token
    let finalFirebaseUid = firebaseUid;
    if (req.user && req.user.firebaseUid) {
      finalFirebaseUid = req.user.firebaseUid;
      // ✅ Security: التحقق من أن المستخدم لا يسجل token لمستخدم آخر
      if (firebaseUid && firebaseUid !== req.user.firebaseUid) {
        logger.warning(`Security: User ${req.user.firebaseUid} attempted to register token for ${firebaseUid}`);
        return res.status(403).json({ 
          success: false, 
          error: 'ليس لديك صلاحية لتسجيل token لمستخدم آخر' 
        });
      }
    }

    if (!finalFirebaseUid) {
      return res.status(400).json({ success: false, error: 'firebaseUid مطلوب' });
    }

    // ✅ الحصول على user_id
    const userResult = await pool.query(
      'SELECT user_id FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL',
      [finalFirebaseUid]
    );

    if (userResult.rows.length === 0) {
      logger.warning(`User not found: firebase_uid=${finalFirebaseUid}`);
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    const userId = userResult.rows[0].user_id;
    logger.info(`User found: user_id=${userId}, firebase_uid=${finalFirebaseUid}`);

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
             device_model = COALESCE($1, device_model),
             device_brand = COALESCE($2, device_brand),
             device_manufacturer = COALESCE($3, device_manufacturer),
             app_version_name = COALESCE($4, app_version_name),
             app_version_code = COALESCE($5::INTEGER, app_version_code),
             updated_at = CURRENT_TIMESTAMP
         WHERE token_id = $6`,
        [
          deviceModel || null,
          deviceBrand || null,
          deviceManufacturer || null,
          appVersionName || null,
          appVersionCode ? parseInt(appVersionCode, 10) : null, // تحويل إلى INTEGER
          existingToken.token_id
        ]
      );

      logger.info(`FCM token updated: user_id=${userId}, firebase_uid=${finalFirebaseUid}, token_id=${existingToken.token_id}`);

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
        user_id, firebase_uid, token, device_model, device_brand, 
        device_manufacturer, app_version_name, app_version_code, 
        is_active, is_primary, last_used_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        userId,                    // $1
        finalFirebaseUid,          // $2
        token,                      // $3
        deviceModel || null,        // $4
        deviceBrand || null,        // $5
        deviceManufacturer || null, // $6
        appVersionName || null,     // $7
        appVersionCodeInt,          // $8 (INTEGER)
        true,                       // $9 is_active
        true                        // $10 is_primary (الـ token الجديد يصبح primary)
      ]
    );

    const newToken = result.rows[0];
    
    logger.info(`FCM token registered successfully`, {
      user_id: userId,
      firebase_uid: finalFirebaseUid,
      token_id: newToken.token_id,
      token_uuid: newToken.token_uuid,
      device: `${deviceModel || 'N/A'} (${deviceBrand || 'N/A'})`,
      app_version: `${appVersionName || 'N/A'} (${appVersionCodeInt || 'N/A'})`
    });

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
    logger.error('Error registering FCM token', error);
    if (error.code === '23505') { // Unique constraint violation
      logger.warning('Token already registered (unique constraint)');
      return res.status(409).json({ success: false, error: 'هذا الـ token مسجل بالفعل' });
    }
    if (error.code === '42P01') { // Table does not exist
      logger.error('Table user_fcm_tokens does not exist! Migration script must be run');
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
      `SELECT token_id, token_uuid, token, device_model, device_brand, 
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

    logger.info(`FCM token disabled: token_id=${tokenId}, firebase_uid=${token.firebase_uid}`);

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
app.use(errorHandler);

// ==================== 14. 404 Handler ====================
app.use((req, res) => {
  logger.warning('Route not found', {
    method: req.method,
    path: req.path,
    requestId: req.id
  });
  
  res.status(404).json({
    success: false,
    error: 'المسار غير موجود',
    path: req.path
  });
});

// ==================== 15. Start Server ====================
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
  
  logger.success('Server started', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    localIP,
    serverUrl
  });
  
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
  logger.info('SIGTERM received, shutting down gracefully');
  console.log('🛑 إغلاق الخادم...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  console.log('🛑 إغلاق الخادم...');
  await pool.end();
  process.exit(0);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.errorMsg('Unhandled Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.errorMsg('Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

module.exports = app;

