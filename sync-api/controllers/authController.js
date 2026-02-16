// ============================================================================
// Auth Controller
// ============================================================================
// Controller للمصادقة
// ============================================================================

const { pool } = require('../config/database');
const { generateToken, verifyToken } = require('../middleware/auth');
const { verifyPassword } = require('../utils/helpers');
const { mapUserToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { handleError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

/**
 * تسجيل الدخول
 */
async function login(req, res) {
  try {
    const { phone, password } = req.body;
    
    // البحث عن المستخدم
    const result = await pool.query(
      'SELECT * FROM app_users WHERE phone_number = $1 AND deleted_at IS NULL',
      [phone]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'رقم الهاتف أو كلمة المرور غير صحيحة'
      });
    }
    
    const user = result.rows[0];
    
    // التحقق من كلمة المرور
    if (!verifyPassword(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({
        success: false,
        error: 'رقم الهاتف أو كلمة المرور غير صحيحة'
      });
    }
    
    // تحديث last_login_at
    await pool.query(
      'UPDATE app_users SET last_login_at = CURRENT_TIMESTAMP WHERE user_id = $1',
      [user.user_id]
    );
    
    // إنشاء JWT token
    const token = generateToken(user.user_id, user.firebase_uid);
    if (process.env.AUTH_DEBUG === '1') {
      const decoded = verifyToken(token);
      logger.info('Auth debug', {
        userId: user.user_id,
        tokenUserId: decoded?.userId ?? null,
        firebaseUid: user.firebase_uid ?? null,
        tokenFirebaseUid: decoded?.firebaseUid ?? null,
        requestId: req.id
      });
    }
    
    // تسجيل العملية
    await logAudit(user.user_id, user.firebase_uid, 'login', 'user', user.user_id.toString(), null, null, req);
    
    logger.success('User logged in', {
      userId: user.user_id,
      phone,
      requestId: req.id
    });
    
    res.json({
      success: true,
      data: {
        token,
        user: mapUserToAPI(user)
      }
    });
  } catch (error) {
    logger.errorMsg('Login error', {
      error: error.message,
      phone: req.body.phone,
      requestId: req.id
    });
    handleError(res, error);
  }
}

module.exports = {
  login
};

