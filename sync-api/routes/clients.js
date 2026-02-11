// ============================================================================
// Client Routes
// ============================================================================
// Routes للعملاء (Clients)
// ============================================================================

const express = require('express');
const router = express.Router();
const clientController = require('../controllers/clientController');
const { optionalAuthenticate, syncLimiter } = require('../middleware/auth');

/**
 * GET /api/clients
 * الحصول على جميع العملاء لمستخدم محدد
 */
router.get('/', optionalAuthenticate, clientController.getClients);

/**
 * GET /api/clients/by-phone/:phoneNumber
 * البحث عن جميع العملاء برقم الهاتف (للمتابعة الديون)
 */
router.get('/by-phone/:phoneNumber', optionalAuthenticate, clientController.getClientsByPhone);

/**
 * DELETE /api/clients/by-uuid/:clientUuid
 * حذف عميل (Soft Delete) حسب UUID
 */
router.delete('/by-uuid/:clientUuid', optionalAuthenticate, clientController.deleteClientByUuid);

/**
 * PUT /api/clients/sync
 * مزامنة عميل (Insert or Update حسب UUID)
 *
 * مهم: يجب أن يسبق optionalAuthenticate أي limiter يعتمد على user/firebaseUid
 */
router.put('/sync', optionalAuthenticate, syncLimiter, clientController.syncClient);

/**
 * POST /api/clients
 * إنشاء عميل جديد
 */
router.post('/', optionalAuthenticate, clientController.createClient);

/**
 * GET /api/clients/:clientId
 * الحصول على عميل محدد
 */
router.get('/:clientId', optionalAuthenticate, clientController.getClientById);

module.exports = router;
