// ============================================================================
// Auth Routes
// ============================================================================
// Routes للمصادقة
// ============================================================================

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validateLogin } = require('../middleware/validation');
const { authLimiter } = require('../middleware/auth');

/**
 * POST /api/auth/login
 * تسجيل الدخول وإنشاء JWT token
 *
 * حماية: authLimiter يمنع كثرة المحاولات خلال وقت قصير
 */
router.post('/login', authLimiter, validateLogin, authController.login);

module.exports = router;
