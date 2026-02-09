// ============================================================================
// FCM Notification Service
// ============================================================================
// خدمة إرسال إشعارات FCM للمستخدمين
// ============================================================================

const admin = require('firebase-admin');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

// تهيئة Firebase Admin SDK (يجب إضافة credentials)
let isInitialized = false;

function initializeFirebase() {
  if (isInitialized) return;
  
  try {
    // محاولة تحميل service account من ملف JSON
    const serviceAccountPath = require('path').join(__dirname, '../config/firebase-service-account.json');
    const fs = require('fs');
    
    if (fs.existsSync(serviceAccountPath)) {
      const serviceAccount = require(serviceAccountPath);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      isInitialized = true;
      logger.info('Firebase Admin SDK initialized successfully');
    } else {
      // محاولة استخدام environment variables
      const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
      if (serviceAccountEnv) {
        const serviceAccount = JSON.parse(serviceAccountEnv);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount)
        });
        isInitialized = true;
        logger.info('Firebase Admin SDK initialized from environment variables');
      } else {
        logger.warning('Firebase Admin SDK not initialized: service account not found');
      }
    }
  } catch (error) {
    logger.error('Error initializing Firebase Admin SDK', error);
  }
}

// تهيئة Firebase عند تحميل الملف
initializeFirebase();

/**
 * إرسال إشعار FCM عند إنشاء/تحديث معاملة
 * @param {Object} transaction - بيانات المعاملة من قاعدة البيانات
 * @param {Object} customer - بيانات العميل (customer/client)
 * @param {Object} owner - بيانات صاحب المعاملة (owner)
 */
async function sendTransactionNotification(transaction, customer, owner) {
  try {
    if (!isInitialized) {
      logger.warning('Firebase Admin SDK not initialized - skipping notification');
      return { success: false, reason: 'firebase_not_initialized' };
    }

    // التحقق من أن notify_customer = true
    if (!transaction.notify_customer) {
      logger.debug('Transaction notification skipped: notify_customer is false', {
        transactionUuid: transaction.transaction_uuid
      });
      return { success: false, reason: 'notify_customer_is_false' };
    }

    // جلب firebase_uid للعميل عبر رقم الهاتف فقط (لا نستخدم owner.firebase_uid نهائياً)
    const customerUser = await pool.query(
      `SELECT firebase_uid
       FROM app_users
       WHERE phone_number = $1
         AND deleted_at IS NULL
       LIMIT 1`,
      [customer.phone_number]
    );

    const customerFirebaseUid = customerUser.rows?.[0]?.firebase_uid || null;
    if (!customerFirebaseUid) {
      logger.warning(`No app user found for customer phone`, {
        customerId: customer.client_id,
        phoneNumber: customer.phone_number
      });
      return { success: false, reason: 'no_customer_user' };
    }

    const customerTokens = await pool.query(
      `SELECT token, is_primary, firebase_uid
       FROM user_fcm_tokens
       WHERE firebase_uid = $1
         AND is_active = TRUE
       ORDER BY is_primary DESC, last_used_at DESC
       LIMIT 10`,
      [customerFirebaseUid]
    );

    logger.info(`Searching FCM tokens for customer`, {
      customerId: customer.client_id,
      phoneNumber: customer.phone_number,
      customerFirebaseUid,
      tokensFound: customerTokens.rows.length
    });

    if (customerTokens.rows.length === 0) {
      logger.warning(`No FCM tokens found for customer`, {
        customerId: customer.client_id,
        phoneNumber: customer.phone_number,
        customerFirebaseUid
      });
      return { success: false, reason: 'no_fcm_tokens' };
    }

    // بناء محتوى الإشعار
    // ✅ قاعدة البيانات تحفظ income/expense، لكن نحتاج DEBIT/CREDIT للإشعار
    const direction = transaction.transaction_direction;
    const isDebit = direction === 'expense' || direction === 'DEBIT';
    const directionText = isDebit ? 'مدين' : 'دائن';
    const directionCode = isDebit ? 'DEBIT' : 'CREDIT';
    
    const amount = parseFloat(transaction.transaction_amount);
    const currency = transaction.currency_code || 'IQD';
    const ownerName = owner?.full_name || owner?.name || 'مستخدم';
    const customerName = customer?.client_name || 'عميل';
    
    const notificationTitle = `قيد جديد من ${ownerName}`;
    const notificationBody = `${directionText}: ${amount} ${currency}${transaction.transaction_note ? ` - ${transaction.transaction_note}` : ''}`;
    
    const message = {
      notification: {
        title: notificationTitle,
        body: notificationBody
      },
      data: {
        type: 'transaction',
        transactionUuid: transaction.transaction_uuid || '',
        transactionId: transaction.transaction_id?.toString() || '',
        direction: directionCode,
        amount: amount.toString(),
        currency: currency,
        customerId: transaction.client_id?.toString() || '',
        customerName: customerName,
        ownerFirebaseUid: transaction.owner_firebase_uid || '',
        ownerName: ownerName,
        note: transaction.transaction_note || '',
        timestamp: new Date().toISOString()
      },
      tokens: customerTokens.rows.map(row => row.token),
      android: {
        priority: 'high'
      },
      apns: {
        headers: {
          'apns-priority': '10'
        }
      }
    };

    // إرسال الإشعار
    const response = await admin.messaging().sendEachForMulticast(message);
    
    logger.info(`Transaction notification sent`, {
      transactionUuid: transaction.transaction_uuid,
      customerId: transaction.client_id,
      customerPhone: customer.phone_number,
      tokensCount: customerTokens.rows.length,
      successCount: response.successCount,
      failureCount: response.failureCount
    });

    // تسجيل الأخطاء إذا كانت هناك
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          logger.warning(`FCM notification failed for token ${idx}`, {
            error: resp.error?.code || 'unknown',
            message: resp.error?.message || 'unknown error'
          });
        }
      });
    }

    return {
      success: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount,
      responses: response.responses
    };
  } catch (error) {
    logger.error('Error sending transaction notification', {
      error: error.message,
      stack: error.stack,
      transactionUuid: transaction?.transaction_uuid
    });
    return { success: false, error: error.message };
  }
}

/**
 * إرسال إشعار إلى مستخدم حسب firebaseUid (للاستدعاء من التطبيق عبر POST /api/notifications/send)
 * @param {String} firebaseUid - معرف Firebase للمستلم
 * @param {String} title - عنوان الإشعار
 * @param {String} body - نص الإشعار
 * @param {String} type - نوع الإشعار (مثل 'transaction')
 * @param {Object} data - بيانات إضافية (تُحوَّل إلى strings لـ FCM)
 */
async function sendNotificationToUser(firebaseUid, title, body, type = 'transaction', data = {}) {
  try {
    if (!isInitialized) {
      logger.warning('Firebase Admin SDK not initialized - skipping sendNotificationToUser');
      return { success: false, error: 'firebase_not_initialized' };
    }
    if (!firebaseUid || !title || !body) {
      return { success: false, error: 'firebaseUid, title and body are required' };
    }

    const tokensResult = await pool.query(
      `SELECT token FROM user_fcm_tokens
       WHERE firebase_uid = $1 AND is_active = TRUE
       ORDER BY is_primary DESC, last_used_at DESC
       LIMIT 10`,
      [firebaseUid]
    );

    if (tokensResult.rows.length === 0) {
      logger.warning('No FCM tokens found for firebaseUid in sendNotificationToUser', { firebaseUid });
      return { success: false, error: 'no_fcm_tokens', message: 'لا توجد أجهزة مسجلة لهذا المستخدم' };
    }

    const tokens = tokensResult.rows.map(row => row.token);
    const dataStrings = {};
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        dataStrings[k] = String(v ?? '');
      }
    }
    dataStrings.type = type || 'transaction';

    const message = {
      notification: { title, body },
      data: dataStrings,
      tokens,
      android: { priority: 'high' },
      apns: { headers: { 'apns-priority': '10' } }
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    logger.info('Notification sent via sendNotificationToUser', {
      firebaseUid,
      tokensCount: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount
    });
    if (response.failureCount > 0) {
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          logger.warning('FCM send failed for token index', { idx, error: resp.error?.message });
        }
      });
    }

    return {
      success: response.successCount > 0,
      successCount: response.successCount,
      failureCount: response.failureCount
    };
  } catch (error) {
    logger.error('Error in sendNotificationToUser', {
      error: error.message,
      stack: error.stack,
      firebaseUid
    });
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendTransactionNotification,
  sendNotificationToUser,
  initializeFirebase
};

