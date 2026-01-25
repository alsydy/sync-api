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
 * POST /api/fcm-tokens
 * تسجيل/تحديث FCM token للمستخدم
 */
router.post('/', optionalAuthenticate, fcmTokenController.registerFcmToken);

/**
 * GET /api/fcm-tokens/:firebaseUid
 * جلب جميع FCM tokens النشطة للمستخدم
 */
router.get('/:firebaseUid', optionalAuthenticate, fcmTokenController.getFcmTokens);

/**
 * DELETE /api/fcm-tokens/:tokenId
 * حذف/تعطيل FCM token
 */
router.delete('/:tokenId', optionalAuthenticate, fcmTokenController.deleteFcmToken);

module.exports = router;

