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

    // جلب FCM tokens للعميل (customer)
    // البحث عن المستخدم الذي له نفس رقم الهاتف مثل العميل
    // ✅ استخدام phone_number من app_users (ليس phone)
    const customerTokens = await pool.query(
      `SELECT uft.token, uft.is_primary, uft.firebase_uid
       FROM user_fcm_tokens uft
       JOIN app_users au ON uft.firebase_uid = au.firebase_uid
       WHERE au.phone_number = $1 
         AND uft.is_active = TRUE
         AND au.deleted_at IS NULL
       ORDER BY uft.is_primary DESC, uft.last_used_at DESC
       LIMIT 10`,
      [customer.phone_number]
    );
    
    logger.info(`Searching FCM tokens for customer`, {
      customerId: customer.client_id,
      phoneNumber: customer.phone_number,
      tokensFound: customerTokens.rows.length
    });

    if (customerTokens.rows.length === 0) {
      logger.warning(`No FCM tokens found for customer`, {
        customerId: customer.client_id,
        phoneNumber: customer.phone_number
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

module.exports = {
  sendTransactionNotification,
  initializeFirebase
};

