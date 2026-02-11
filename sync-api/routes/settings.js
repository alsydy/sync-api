// ============================================================================
// Settings Routes
// ============================================================================
// Routes للإعدادات (Settings)
// ============================================================================

const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { optionalAuthenticate } = require('../middleware/auth');

/**
 * GET /api/settings/shared
 * الحصول على الإعدادات المشتركة
 */
router.get('/shared', optionalAuthenticate, settingsController.getSharedSettings);

/**
 * GET /api/settings/user/:firebaseUid
 * الحصول على إعدادات المستخدم
 */
router.get('/user/:firebaseUid', optionalAuthenticate, settingsController.getUserSettings);

module.exports = router;

