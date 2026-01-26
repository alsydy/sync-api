// ============================================================================
// Transaction Routes
// ============================================================================
// Routes للمعاملات المالية (Financial Transactions)
// ============================================================================

const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { optionalAuthenticate, syncLimiter } = require('../middleware/auth');

/**
 * GET /api/transactions
 * الحصول على المعاملات
 */
router.get('/', optionalAuthenticate, transactionController.getTransactions);

/**
 * GET /api/transactions/by-uuid/:transactionUuid
 * الحصول على معاملة حسب UUID
 */
router.get('/by-uuid/:transactionUuid', optionalAuthenticate, transactionController.getTransactionByUuid);

/**
 * GET /api/transactions/debt-summary
 * ✅ السيناريو المطلوب: المستخدم يرى من سجّل عليه/له قيوداً (ملخص)
 * يجب أن يأتي قبل /:transactionId
 */
router.get('/debt-summary', optionalAuthenticate, transactionController.getDebtSummary);

/**
 * GET /api/transactions/debt-details/:recorderFirebaseUid
 * ✅ عند الضغط على مستخدم: عرض القيود التي سجّلها هذا المستخدم عليّ
 * يجب أن يأتي قبل /:transactionId
 */
router.get('/debt-details/:recorderFirebaseUid', optionalAuthenticate, transactionController.getDebtDetails);

/**
 * GET /api/transactions/:transactionId
 * الحصول على معاملة محددة
 * ⚠️ يجب أن يأتي بعد جميع routes المحددة
 */
router.get('/:transactionId', optionalAuthenticate, transactionController.getTransactionById);

/**
 * POST /api/transactions
 * إنشاء معاملة جديدة
 */
router.post('/', optionalAuthenticate, transactionController.createTransaction);

/**
 * PUT /api/transactions/sync
 * مزامنة معاملة (Insert or Update حسب UUID)
 */
router.put('/sync', syncLimiter, optionalAuthenticate, transactionController.syncTransaction);

/**
 * DELETE /api/transactions/by-uuid/:transactionUuid
 * حذف معاملة (Soft Delete) حسب UUID
 */
router.delete('/by-uuid/:transactionUuid', optionalAuthenticate, transactionController.deleteTransactionByUuid);

/**
 * DELETE /api/transactions/:transactionId
 * حذف معاملة (Soft Delete)
 */
router.delete('/:transactionId', optionalAuthenticate, transactionController.deleteTransactionById);

module.exports = router;
