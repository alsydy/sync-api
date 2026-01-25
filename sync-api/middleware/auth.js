// ============================================================================
// Authentication & Authorization Middleware
// ============================================================================

const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// JWT Secret (يجب أن يكون في .env)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// تحذير مهم إذا تعمل على production وما زلت تستخدم default secret
if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'your-secret-key-change-in-production') {
  // لا نوقف السيرفر، لكن نطبع تحذير واضح
  // لأن هذا يسبب فشل verifyToken إذا كانت التوكنات صادرة من بيئة Secret مختلف
  console.warn('⚠️ WARNING: JWT_SECRET is using the default value in production. Set JWT_SECRET in environment variables!');
}

// ============================================================================
// Rate Limiting
// ============================================================================

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'تم تجاوز الحد المسموح من الطلبات. يرجى المحاولة لاحقاً.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'تم تجاوز عدد محاولات تسجيل الدخول. يرجى المحاولة لاحقاً.',
  skipSuccessfulRequests: true,
});

const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'تم تجاوز حد طلبات المزامنة. يرجى الانتظار قليلاً.',
});

// ============================================================================
// JWT Token Functions
// ============================================================================

function generateToken(userId, firebaseUid) {
  return jwt.sign(
    { userId, firebaseUid, type: 'access' },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// ============================================================================
// Authentication Middleware
// ============================================================================

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'مطلوب token للمصادقة'
      });
    }

    const token = authHeader.substring(7).trim();
    const decoded = verifyToken(token);

    if (!decoded) {
      return res.status(401).json({
        success: false,
        error: 'Token غير صالح أو منتهي الصلاحية'
      });
    }

    req.user = {
      userId: decoded.userId,
      firebaseUid: decoded.firebaseUid
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'خطأ في التحقق من المصادقة'
    });
  }
}

/**
 * Middleware اختياري للمصادقة (للعمليات العامة)
 * ✅ تم تحسينه: إذا فشل verify نضيف ملاحظة داخل req (للتشخيص) بدون ما نمنع الطلب
 */
async function optionalAuthenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      const decoded = verifyToken(token);

      if (decoded) {
        req.user = {
          userId: decoded.userId,
          firebaseUid: decoded.firebaseUid
        };
      } else {
        // ملاحظة تشخيصية فقط
        req.authWarning = 'Bearer token موجود لكن verifyToken فشل (تحقق من JWT_SECRET أو token)';
      }
    }

    next();
  } catch (error) {
    req.authWarning = 'خطأ أثناء optionalAuthenticate';
    next();
  }
}

// ============================================================================
// Authorization Middleware
// ============================================================================

async function authorizeResource(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'مطلوب مصادقة للوصول لهذا المورد'
      });
    }

    next();
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: 'ليس لديك صلاحية للوصول لهذا المورد'
    });
  }
}

// ============================================================================
// Input Validation
// ============================================================================

function validateInput(req, res, next) {
  next();
}

// ============================================================================
// Export
// ============================================================================

module.exports = {
  generateToken,
  verifyToken,
  authenticate,
  optionalAuthenticate,
  authorizeResource,
  validateInput,
  generalLimiter,
  authLimiter,
  syncLimiter
};
