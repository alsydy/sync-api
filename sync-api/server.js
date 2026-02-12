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

// ✅ FIX: استيراد handleError أيضاً لأنك تستخدمه داخل الملف
const { errorHandler, handleError } = require('./middleware/errorHandler');

const { monitoringMiddleware } = require('./middleware/monitoring');

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
const subscriptionController = require('./controllers/subscriptionController');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const healthRoutes = require('./routes/health');
const monitoringRoutes = require('./routes/monitoring');
const clientRoutes = require('./routes/clients');
const accountRoutes = require('./routes/accounts');
const transactionRoutes = require('./routes/transactions');
const subscriptionRoutes = require('./routes/subscriptions');
const fcmTokenRoutes = require('./routes/fcm-tokens');
const settingsRoutes = require('./routes/settings');
const notificationRoutes = require('./routes/notifications');
const whatsappRoutes = require('./routes/whatsapp');

// ==================== 1. تهيئة Express Server ====================
const app = express();
const PORT = process.env.PORT || 3001;

// ✅ Trust proxy (مطلوب عند العمل خلف proxy مثل Render.com)
// هذا يسمح لـ express-rate-limit بقراءة X-Forwarded-For header بشكل صحيح
app.set('trust proxy', true);

// ==================== 2. Middleware ====================

// Security (Helmet) - CSP صارم + استثناء للمراقبة فقط
app.use((req, res, next) => {
  const p = req.path || '';
  const isMonitoringPage = (p === '/api/monitoring' || p === '/api/monitoring/');

  const baseHelmet = helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: isMonitoringPage ? ["'self'", "'unsafe-inline'"] : ["'self'"],
      },
    },
  });

  return baseHelmet(req, res, next);
});

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

// ✅ CHANGE: لا نطبق generalLimiter على كل السيرفر
// (كان يطبق حتى على / وملفات static وhealth وقد يسبب 429 غير منطقي)
// سنطبقه لاحقاً على /api فقط بعد تعريف health routes.
// app.use(generalLimiter);

// Request ID middleware
app.use((req, res, next) => {
  req.id = uuidv4();
  res.setHeader('X-Request-ID', req.id);
  next();
});

// Monitoring middleware (يجب أن يكون بعد Request ID)
app.use(monitoringMiddleware);

// Timeout handler
app.use((req, res, next) => {
  if (!req.timedout) next();
});

// ==================== 3. Routes ====================

// Health & Info routes (before /api prefix)
app.use('/', healthRoutes);
app.use('/api', healthRoutes);

// ✅ CHANGE: طبق generalLimiter فقط على /api
// ملاحظة: في auth.js أنت مستثني /api/health و /api/info من limiter العام (skip)
// لذلك ping على /api/health لن يسبب 429 بسهولة.
app.use('/api', generalLimiter);

// Monitoring routes
app.use('/api/monitoring', monitoringRoutes);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
// ✅ Compatibility routes (بدون تعديل التطبيق)
app.get('/api/packages', optionalAuthenticate, subscriptionController.getPackages);
app.post('/api/subscription-requests', optionalAuthenticate, subscriptionController.createSubscriptionRequest);

app.use('/api/fcm-tokens', fcmTokenRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/whatsapp', whatsappRoutes);

// ==================== 4. دوال مساعدة (Legacy - للتوافق) ====================
// (كما هي)

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
        await client.query('SELECT pg_advisory_xact_lock(424242)');

        const maxResult = await client.query('SELECT MAX(account_number) AS max FROM app_users WHERE deleted_at IS NULL');
        const maxFromUsers = maxResult.rows[0]?.max ? parseInt(maxResult.rows[0].max, 10) : 0;

        const registryResult = await client.query('SELECT MAX(account_number) AS max FROM account_numbers_registry');
        const maxFromRegistry = registryResult.rows[0]?.max ? parseInt(registryResult.rows[0].max, 10) : 0;

        const maxNumber = Math.max(maxFromUsers, maxFromRegistry, 0);
        accountNumber = maxNumber + 1;

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
        accountNumber,
        createdAtSeconds,
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

// ✅ REMOVED: Route مكرر لـ /api/account-numbers/next
// كان موجود مرتين ويسبب تعارض وصيانة صعبة.
// إذا تحتاج النسخة القديمة، غيّر مسارها بدل تكرار نفس المسار.

// ==================== 9. Routes - Transactions (Legacy endpoints كما هي عندك) ====================

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

app.get('/api/transactions/:transactionId', optionalAuthenticate, async (req, res) => {
  try {
    const { transactionId } = req.params;

    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(transactionId.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID: "${transactionId}" is a reserved word`
      });
    }

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

app.post('/api/transactions', optionalAuthenticate, async (req, res) => {
  try {
    const transactionData = ensureUuid(req.body);

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
        msToSeconds(transactionData.transactionDate || Date.now()),
        intToBoolean(transactionData.notifyCustomer !== undefined ? transactionData.notifyCustomer : 0),
        intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
        transactionData.deviceId || null,
        transactionData.transactionNumber || null,
        transactionData.syncVersion || 1,
        msToSeconds(transactionData.createdAt || Date.now())
      ]
    );

    const transaction = result.rows[0];

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
 *
 * ✅ CHANGE: ترتيب middleware صار:
 * optionalAuthenticate ثم syncLimiter
 * حتى يصبح rate limit "حسب المستخدم" عندما يوجد token
 */
app.put('/api/transactions/sync', optionalAuthenticate, syncLimiter, async (req, res) => {
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

      const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);

      if (!ownerUserId) {
        logger.error('ownerUserId is null in UPDATE transaction', { transactionData });
        return res.status(400).json({
          success: false,
          error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات. يرجى التأكد من أن المستخدم مسجل في النظام.'
        });
      }

      const clientId = await normalizeClientId(
        transactionData.customerId || transactionData.clientId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId
      );

      const accountId = await normalizeAccountId(
        transactionData.accountId,
        transactionData.accountFirestoreId
      );

      if (!accountId) {
        logger.error('accountId is null in UPDATE transaction', { transactionData });
        return res.status(400).json({
          success: false,
          error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
        });
      }

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
          clientId,
          accountId,
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
      const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);

      const clientId = await normalizeClientId(
        transactionData.customerId || transactionData.clientId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId
      );

      let accountId = await normalizeAccountId(
        transactionData.accountId,
        transactionData.accountFirestoreId
      );

      // ✅ الصندوق المشترك الرئيسي يجب أن يكون واحداً فقط لكل النظام
      // ولا يرتبط بمستخدم معيّن (owner_user_id يكون NULL)
      if (!accountId && transactionData.accountFirestoreId === 'shared-main-account-v1') {
        logger.info(`Creating or reusing GLOBAL shared main account (not bound to specific ownerUserId)`);
        try {
          const sharedAccountUuid = '00000000-0000-0000-0000-000000000001';
          const now = Date.now();
          const createdAtSeconds = msToSeconds(now);

          const colorValue = 0xFF0A84FF;
          const colorHex = normalizeColorCode(colorValue);

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
              owner_user_id = NULL,
              owner_firebase_uid = NULL,
              updated_at = CURRENT_TIMESTAMP
            RETURNING account_id`,
            [
              sharedAccountUuid,
              'shared-main-account-v1',
              null, // ✅ لا نربطه بمستخدم معيّن
              null,
              'الصندوق الرئيسي',
              true,
              true,
              colorHex,
              1,
              createdAtSeconds
            ]
          );

          if (createResult.rows.length > 0) {
            accountId = createResult.rows[0].account_id;
            logger.info(`Created shared main account with account_id: ${accountId}`);
          }
        } catch (error) {
          logger.error(`Error creating shared main account: ${error.message}`);
          if (error.code === '23505') {
            logger.info(`Account already exists, searching again...`);
            accountId = await getAccountIdFromFirestoreId('shared-main-account-v1');
          }
        }
      }

      if (!accountId) {
        logger.error('accountId is null in INSERT transaction', { transactionData });
        return res.status(400).json({
          success: false,
          error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
        });
      }

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
          clientId,
          accountId,
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
          msToSeconds(transactionData.createdAt || Date.now())
        ]
      );

      const transaction = result.rows[0];

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

app.delete('/api/transactions/:transactionId', optionalAuthenticate, async (req, res) => {
  try {
    const { transactionId } = req.params;

    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(transactionId.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID: "${transactionId}" is a reserved word`
      });
    }

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

process.on('unhandledRejection', (reason, promise) => {
  logger.errorMsg('Unhandled Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

process.on('uncaughtException', (error) => {
  logger.errorMsg('Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });
  process.exit(1);
});

module.exports = app;
