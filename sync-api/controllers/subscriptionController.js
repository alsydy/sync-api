// ============================================================================
// Subscription Controller
// ============================================================================
// Controller للاشتراكات (Subscriptions)
// ============================================================================

const { pool } = require('../config/database');
const { secondsToMs } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * GET /api/subscriptions/active
 * الحصول على الاشتراك النشط للمستخدم
 */
async function getActiveSubscription(req, res, next) {
  try {
    const { firebaseUid, userPhone } = req.query;
    
    // Input Validation
    if (!firebaseUid && !userPhone) {
      return res.status(400).json({ success: false, error: 'firebaseUid أو userPhone مطلوب' });
    }
    
    // Security: إذا كان المستخدم مصادقاً، تأكد من أنه يطلب اشتراكه فقط
    if (req.user) {
      const userFirebaseUid = req.user.firebaseUid;
      if (firebaseUid && firebaseUid !== userFirebaseUid) {
        logger.warning(`Security: User ${userFirebaseUid} attempted to access subscription for ${firebaseUid}`);
        return res.status(403).json({ 
          success: false, 
          error: 'ليس لديك صلاحية للوصول لهذا الاشتراك' 
        });
      }
      
      // إذا كان المستخدم مصادقاً، استخدم firebaseUid من token
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
    
    // للطلبات غير المصادقة (للتوافق مع الكود القديم)
    let query = 'SELECT * FROM subscriptions WHERE status IN ($1, $2) AND end_at > CURRENT_TIMESTAMP';
    const params = ['active', 'pending'];
    let paramIndex = 3;
    
    if (firebaseUid) {
      // Input validation: التحقق من format
      if (firebaseUid.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(firebaseUid)) {
        return res.status(400).json({ success: false, error: 'firebaseUid غير صالح' });
      }
      query += ` AND (firebase_uid = $${paramIndex++} OR user_doc_id = $${paramIndex - 1})`;
      params.push(firebaseUid);
    }
    if (userPhone) {
      // Input validation: التحقق من format
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
    next(error);
  }
}

/**
 * GET /api/packages
 * الحصول على جميع الباقات النشطة
 */
async function getPackages(req, res, next) {
  try {
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
    next(error);
  }
}

/**
 * POST /api/subscription-requests
 * إرسال طلب اشتراك جديد
 */
async function createSubscriptionRequest(req, res, next) {
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

    // Input Validation
    if (!packageId) {
      return res.status(400).json({ success: false, error: 'packageId مطلوب' });
    }

    // Security: إذا كان المستخدم مصادقاً، استخدم firebaseUid من token
    let finalFirebaseUid = firebaseUid || userDocId;
    if (req.user && req.user.firebaseUid) {
      finalFirebaseUid = req.user.firebaseUid;
      // Security: التحقق من أن المستخدم لا يرسل طلباً باسم مستخدم آخر
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

    // التحقق من وجود الباقة
    const packageResult = await pool.query(
      'SELECT * FROM subscription_packages WHERE package_id = $1 AND is_active = $2',
      [packageId, true]
    );

    if (packageResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الباقة غير موجودة أو غير نشطة' });
    }

    const pkg = packageResult.rows[0];

    // الحصول على user_id إذا كان firebaseUid موجوداً
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

    // إدراج طلب الاشتراك
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
    next(error);
  }
}

module.exports = {
  getActiveSubscription,
  getPackages,
  createSubscriptionRequest
};

