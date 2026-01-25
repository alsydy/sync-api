// ============================================================================
// Auth Routes
// ============================================================================
// Routes للمصادقة
// ============================================================================

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validateLogin } = require('../middleware/validation');

/**
 * POST /api/auth/login
 * تسجيل الدخول وإنشاء JWT token
 */
router.post('/login', validateLogin, authController.login);

module.exports = router;

