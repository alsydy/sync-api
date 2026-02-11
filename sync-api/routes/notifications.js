// ============================================================================
// Notification Routes
// ============================================================================
// مسارات إرسال الإشعارات عبر FCM
// ============================================================================

const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { optionalAuthenticate } = require('../middleware/auth');

/**
 * POST /api/notifications/send
 * إرسال إشعار إلى مستخدم (firebaseUid) — يُستدعى من التطبيق عند إشعار العميل بقيد جديد
 */
router.post('/send', optionalAuthenticate, notificationController.sendNotification);

module.exports = router;
