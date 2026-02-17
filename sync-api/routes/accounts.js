// ============================================================================
// Account Routes
// ============================================================================
// Routes للحسابات النقدية (Cash Accounts)
// ============================================================================

const express = require('express');
const router = express.Router();
const accountController = require('../controllers/accountController');
const { optionalAuthenticate, syncLimiter } = require('../middleware/auth');

/**
 * GET /api/accounts
 * الحصول على جميع الحسابات النقدية
 */
router.get('/', optionalAuthenticate, accountController.getAccounts);

/**
 * GET /api/accounts/links
 * جلب روابط المستخدم بالصناديق
 */
router.get('/links', optionalAuthenticate, accountController.getAccountLinks);

/**
 * PUT /api/accounts/links/:accountFirestoreId
 * إنشاء/تحديث ربط صندوق لمستخدم
 */
router.put('/links/:accountFirestoreId', optionalAuthenticate, accountController.upsertAccountLink);

/**
 * DELETE /api/accounts/links/:accountFirestoreId
 * حذف ربط صندوق لمستخدم
 */
router.delete('/links/:accountFirestoreId', optionalAuthenticate, accountController.deleteAccountLink);

/**
 * PUT /api/accounts/sync
 * مزامنة حساب نقدي
 */
router.put('/sync', syncLimiter, optionalAuthenticate, accountController.syncAccount);

/**
 * DELETE /api/accounts/by-uuid/:accountUuid
 * حذف حساب (Soft Delete) حسب UUID
 */
router.delete('/by-uuid/:accountUuid', optionalAuthenticate, accountController.deleteAccountByUuid);

module.exports = router;

