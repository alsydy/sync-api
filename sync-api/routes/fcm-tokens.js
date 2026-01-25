// ============================================================================
// FCM Token Routes
// ============================================================================
// Routes لـ FCM Tokens
// ============================================================================

const express = require('express');
const router = express.Router();
const fcmTokenController = require('../controllers/fcmTokenController');
const { optionalAuthenticate } = require('../middleware/auth');

/**
 * Middleware: يضمن وجود firebaseUid في body إن كان موجوداً داخل JWT
 * - إذا كان التطبيق يرسل JWT فقط بدون firebaseUid في body، نعوضه هنا
 * - يحمي أيضاً من محاولة إرسال firebaseUid مختلف عن الموجود في JWT
 */
function ensureFirebaseUidFromToken(req, res, next) {
  try {
    // تأكد أن body موجود (لأن بعض الأحيان يكون undefined)
    req.body = req.body || {};

    const bodyUid = (req.body.firebaseUid || '').toString().trim();
    const tokenUid = (req.user?.firebaseUid || '').toString().trim();

    // إذا الاثنين موجودين لكن مختلفين -> رفض
    if (bodyUid && tokenUid && bodyUid !== tokenUid) {
      return res.status(403).json({
        success: false,
        error: 'غير مسموح: firebaseUid لا يطابق بيانات المصادقة'
      });
    }

    // إذا bodyUid غير موجود و tokenUid موجود -> حقن
    if (!bodyUid && tokenUid) {
      req.body.firebaseUid = tokenUid;
    }

    next();
  } catch (e) {
    // لا نكسر الطلب، نكمل (الـ controller قد يتحقق لاحقاً)
    next();
  }
}

/**
 * POST /api/fcm-tokens
 * تسجيل/تحديث FCM token للمستخدم
 */
router.post(
  '/',
  optionalAuthenticate,
  ensureFirebaseUidFromToken,
  fcmTokenController.registerFcmToken
);

/**
 * GET /api/fcm-tokens/:firebaseUid
 * جلب جميع FCM tokens النشطة للمستخدم
 */
router.get(
  '/:firebaseUid',
  optionalAuthenticate,
  fcmTokenController.getFcmTokens
);

/**
 * DELETE /api/fcm-tokens/:tokenId
 * حذف/تعطيل FCM token
 */
router.delete(
  '/:tokenId',
  optionalAuthenticate,
  fcmTokenController.deleteFcmToken
);

module.exports = router;
