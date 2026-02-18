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
  optionalAuthenticate,
  generalLimiter,
  generateToken
} = require('./middleware/auth');

// ✅ FIX: استيراد handleError أيضاً لأنك تستخدمه داخل الملف
const { errorHandler, handleError } = require('./middleware/errorHandler');

const { monitoringMiddleware } = require('./middleware/monitoring');

// Import utils
const {
  intToBoolean,
  msToSeconds,
  isValidUUID,
  ensureUuid
} = require('./utils/helpers');

// Import mappers
const { mapUserToAPI } = require('./utils/mappers');

// Import services
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
const bootstrapRoutes = require('./routes/bootstrap');
const subscriptionRoutes = require('./routes/subscriptions');
const fcmTokenRoutes = require('./routes/fcm-tokens');
const settingsRoutes = require('./routes/settings');
const notificationRoutes = require('./routes/notifications');
const whatsappRoutes = require('./routes/whatsapp');
const privacyPolicyRoutes = require('./routes/privacy-policy');
const { validatePrivacyPolicyAcceptance, recordPrivacyPolicyAcceptance } = require('./services/privacyPolicyService');

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
app.use('/api/bootstrap', bootstrapRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
// ✅ Compatibility routes (بدون تعديل التطبيق)
app.get('/api/packages', optionalAuthenticate, subscriptionController.getPackages);
app.post('/api/subscription-requests', optionalAuthenticate, subscriptionController.createSubscriptionRequest);

app.use('/api/fcm-tokens', fcmTokenRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/privacy-policy', privacyPolicyRoutes);

// ==================== 4. دوال مساعدة (Legacy - للتوافق) ====================
// (كما هي)

// ==================== 6. Routes - Account Numbers ====================

/**
 * POST /api/account-numbers/next
 * الحصول على رقم حساب جديد (محجوز)
 */
app.post('/api/account-numbers/next', async (req, res) => {
  const client = await pool.connect();
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

    await client.query('BEGIN');

    // التحقق من الموافقة على سياسة الخصوصية (إذا كانت منشورة)
    const policyCheck = await validatePrivacyPolicyAcceptance(client, userData);
    if (policyCheck.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: policyCheck.error });
    }

    // ✅ توليد رقم الحساب تلقائياً في السيرفر إذا لم يتم إرساله
    let accountNumber = userData.accountNumber;
    if (!accountNumber) {
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

      logger.info(`Generated account number on server: ${accountNumber}`);
    }

    const createdAtSeconds = msToSeconds(userData.createdAt || Date.now());
    logger.info(`Creating new user (POST): uuid=${userUuid}, firebaseUid=${userData.firebaseUid}, name=${userData.name || userData.fullName}, phone=${userData.phone || userData.phoneNumber}, accountNumber=${accountNumber}, createdAt=${createdAtSeconds}`);

    const result = await client.query(
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

    // تسجيل موافقة سياسة الخصوصية (إن وجدت سياسة فعّالة)
    if (policyCheck.policy && policyCheck.acceptedAtSeconds) {
      await recordPrivacyPolicyAcceptance(
        client,
        user.user_id,
        policyCheck.policy.policy_id,
        policyCheck.acceptedAtSeconds,
        req,
        userData.deviceId || userData.device_id || null
      );
    }

    await client.query('COMMIT');

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
    try { await client.query('ROLLBACK'); } catch (e) {}
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'المستخدم موجود بالفعل (رقم الهاتف أو UUID مكرر)' });
    }
    handleError(res, error);
  } finally {
    client.release();
  }
});

// ✅ REMOVED: Route مكرر لـ /api/account-numbers/next
// كان موجود مرتين ويسبب تعارض وصيانة صعبة.
// إذا تحتاج النسخة القديمة، غيّر مسارها بدل تكرار نفس المسار.

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
