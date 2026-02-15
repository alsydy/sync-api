// ============================================================================
// User Routes
// ============================================================================
// Routes للمستخدمين
// ============================================================================

const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { optionalAuthenticate } = require('../middleware/auth');
const { syncLimiter } = require('../middleware/auth');
const { validateUser, validateUUID, validateID } = require('../middleware/validation');

/**
 * GET /api/users/:userId
 * الحصول على مستخدم محدد
 */
router.get('/:userId', optionalAuthenticate, validateID('userId'), userController.getUserById);

/**
 * GET /api/users/by-uuid/:userUuid
 * الحصول على مستخدم حسب UUID
 */
router.get('/by-uuid/:userUuid', optionalAuthenticate, validateUUID('userUuid'), userController.getUserByUuid);

/**
 * GET /api/users/by-firebase/:firebaseUid
 * الحصول على مستخدم حسب firebase_uid
 */
router.get('/by-firebase/:firebaseUid', optionalAuthenticate, userController.getUserByFirebaseUid);

/**
 * GET /api/users/by-phone/:phone
 * الحصول على مستخدم حسب رقم الهاتف
 */
router.get('/by-phone/:phone', optionalAuthenticate, userController.getUserByPhone);

/**
 * POST /api/users
 * إنشاء مستخدم جديد
 */
router.post('/', validateUser, userController.createUser);

/**
 * PUT /api/users/sync
 * مزامنة مستخدم (Insert or Update حسب UUID)
 */
router.put('/sync', syncLimiter, optionalAuthenticate, validateUser, userController.syncUser);

module.exports = router;

