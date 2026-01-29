// ============================================================================
// Notification Controller
// ============================================================================
// Controller لإرسال الإشعارات عبر FCM (من التطبيق إلى الخادم ثم إلى المستلم)
// ============================================================================

const { sendNotificationToUser } = require('../services/fcmNotificationService');
const logger = require('../utils/logger');

/**
 * POST /api/notifications/send
 * إرسال إشعار إلى مستخدم حسب firebaseUid (يُستدعى من التطبيق عند إضافة قيد مع إشعار العميل)
 * Body: { firebaseUid, title, body, type?, data? }
 */
async function sendNotification(req, res, next) {
  try {
    const { firebaseUid, title, body, type = 'transaction', data = {} } = req.body || {};

    if (!firebaseUid || !title || !body) {
      return res.status(400).json({
        success: false,
        error: 'firebaseUid و title و body مطلوبة'
      });
    }

    const result = await sendNotificationToUser(firebaseUid, title, body, type, data);

    if (!result.success) {
      let status = 500;
      if (result.error === 'no_fcm_tokens') status = 404;
      else if (result.error === 'firebase_not_initialized') status = 503;
      const message = result.error === 'no_fcm_tokens'
        ? 'لا توجد أجهزة مسجلة لهذا المستخدم'
        : result.error === 'firebase_not_initialized'
          ? 'خدمة الإشعارات غير مهيأة على الخادم — يرجى إعداد FIREBASE_SERVICE_ACCOUNT'
          : (result.message || result.error);
      return res.status(status).json({
        success: false,
        error: result.error,
        message
      });
    }

    res.json({
      success: true,
      data: {
        successCount: result.successCount,
        failureCount: result.failureCount || 0
      }
    });
  } catch (error) {
    logger.error('notificationController.sendNotification error', {
      error: error.message,
      stack: error.stack
    });
    next(error);
  }
}

module.exports = {
  sendNotification
};
