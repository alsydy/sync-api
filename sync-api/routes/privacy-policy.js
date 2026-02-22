// ============================================================================
// Privacy Policy Routes
// ============================================================================
// Routes لسياسة الخصوصية
// ============================================================================

const express = require('express');
const router = express.Router();
const privacyPolicyController = require('../controllers/privacyPolicyController');

/**
 * GET /api/privacy-policy
 * الحصول على سياسة الخصوصية الفعّالة
 */
router.get('/', privacyPolicyController.getActivePrivacyPolicy);

module.exports = router;
