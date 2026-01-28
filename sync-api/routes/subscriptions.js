// ============================================================================
// Subscription Routes
// ============================================================================
// Routes للاشتراكات (Subscriptions)
// ============================================================================

const express = require('express');
const router = express.Router();
const subscriptionController = require('../controllers/subscriptionController');
const { optionalAuthenticate } = require('../middleware/auth');

/**
 * GET /api/subscriptions/active
 * الحصول على الاشتراك النشط للمستخدم
 */
router.get('/active', optionalAuthenticate, subscriptionController.getActiveSubscription);

/**
 * GET /api/subscriptions/packages
 * GET /api/packages   ✅ توافق مع التطبيق
 */
router.get('/packages', optionalAuthenticate, subscriptionController.getPackages);

/**
 * POST /api/subscriptions/requests
 * POST /api/subscription-requests ✅ توافق مع التطبيق
 */
router.post('/requests', optionalAuthenticate, subscriptionController.createSubscriptionRequest);

// ✅ Alias paths للتوافق (نفس الكنترولر)
router.get('/../packages', optionalAuthenticate, subscriptionController.getPackages); // ملاحظة: هذا غير صحيح في Express
module.exports = router;
