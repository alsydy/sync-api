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
 * GET /api/packages
 * الحصول على جميع الباقات النشطة
 */
router.get('/packages', optionalAuthenticate, subscriptionController.getPackages);

/**
 * POST /api/subscription-requests
 * إرسال طلب اشتراك جديد
 */
router.post('/requests', optionalAuthenticate, subscriptionController.createSubscriptionRequest);

module.exports = router;

