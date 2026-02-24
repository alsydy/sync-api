// ============================================================================
// Notification Controller
// ============================================================================
// Controller لإرسال الإشعارات عبر FCM (من التطبيق إلى الخادم ثم إلى المستلم)
// ============================================================================

const { sendNotificationToUser } = require('../services/fcmNotificationService');
const { pool } = require('../config/database');
const { normalizeClientId } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * POST /api/notifications/send
 * إرسال إشعار إلى مستخدم حسب firebaseUid (يُستدعى من التطبيق عند إضافة قيد مع إشعار العميل)
 * Body: { firebaseUid, title, body, type?, data?, ownerUserId?, clientId?, clientEntryId?, clientFirestoreId? }
 */
async function sendNotification(req, res, next) {
  try {
    const {
      firebaseUid,
      title,
      body,
      type = 'transaction',
      data = {},
      ownerUserId: bodyOwnerUserId,
      clientId: bodyClientId,
      clientEntryId: bodyClientEntryId,
      clientFirestoreId: bodyClientFirestoreId,
      clientUuid: bodyClientUuid
    } = req.body || {};

    if (!firebaseUid || !title || !body) {
      return res.status(400).json({
        success: false,
        error: 'firebaseUid و title و body مطلوبة'
      });
    }

    const authUserId = req?.user?.userId || req?.user?.user_id || null;
    const rawOwnerUserId = authUserId ?? bodyOwnerUserId ?? data?.ownerUserId ?? data?.owner_user_id ?? null;
    const ownerUserId = rawOwnerUserId != null && Number.isFinite(Number(rawOwnerUserId))
      ? Number(rawOwnerUserId)
      : null;

    const rawClientId = bodyClientId ?? data?.clientId ?? data?.client_id ?? null;
    const rawClientRef =
      bodyClientEntryId ||
      bodyClientUuid ||
      bodyClientFirestoreId ||
      data?.clientEntryId ||
      data?.clientUuid ||
      data?.clientFirestoreId ||
      data?.client_firestore_id ||
      data?.clientEntry ||
      null;

    if (type === 'transaction' && firebaseUid) {
      try {
        const u = await pool.query(
          'SELECT receive_transaction_notifications FROM app_users WHERE firebase_uid = $1 LIMIT 1',
          [firebaseUid]
        );
        if (u.rows.length > 0 && u.rows[0]?.receive_transaction_notifications === false) {
          logger.info('Notification skipped: receiver disabled transaction notifications', {
            firebaseUid
          });
          return res.json({ success: true, skipped: true, reason: 'receiver_disabled' });
        }
      } catch (e) {
        logger.warning('Failed to check receiver notification settings', {
          firebaseUid,
          error: e?.message
        });
      }
    }

    if (type === 'transaction' && ownerUserId && (rawClientId || rawClientRef)) {
      try {
        const clientId = await normalizeClientId(rawClientId, rawClientRef, ownerUserId);
        if (clientId) {
          const o = await pool.query(
            'SELECT 1 FROM whatsapp_client_opt_out WHERE user_id = $1 AND client_id = $2 LIMIT 1',
            [ownerUserId, clientId]
          );
          if (o.rows.length > 0) {
            logger.info('Notification skipped: client opted out', {
              ownerUserId,
              clientId,
              firebaseUid
            });
            return res.json({ success: true, skipped: true, reason: 'client_opted_out' });
          }
        } else {
          logger.debug('Notification opt-out check skipped: clientId unresolved', {
            ownerUserId,
            rawClientId,
            rawClientRef
          });
        }
      } catch (e) {
        logger.warning('Notification opt-out check failed', {
          ownerUserId,
          rawClientId,
          rawClientRef,
          error: e?.message
        });
      }
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
