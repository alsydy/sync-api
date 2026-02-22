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
// Rate Limiting (محسن)
// ============================================================================

/**
 * مفتاح الـ Rate Limit:
 * - لو المستخدم معروف (req.user) نستخدم firebaseUid/userId لاحتساب الحد لكل مستخدم
 * - وإلا نستخدم IP كحل احتياطي
 */
function rateLimitKey(req) {
  const u = req.user || null;

  if (u) {
    return (
      u.firebaseUid ||
      u.firebase_uid ||
      u.uid ||
      u.userId ||
      u.user_id ||
      `user:${u.id || 'unknown'}`
    );
  }

  return req.ip;
}

/**
 * Limiter عام:
 * - رفعنا الحد لتقليل 429
 * - استثنينا health/info حتى تقدر تعمل ping بدون مشاكل
 * - keyGenerator: حسب المستخدم إذا موجود
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500, // كان 100
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => rateLimitKey(req),
  skip: (req) => req.path === '/api/health' || req.path === '/api/info',
  message: {
    success: false,
    error: 'تم تجاوز الحد المسموح من الطلبات. يرجى المحاولة لاحقاً.'
  }
});

/**
 * Limiter تسجيل الدخول:
 * - أبقيناه 5/15min
 * - keyGenerator لتخفيف مشكلة IP المشترك
 * - skipSuccessfulRequests كما عندك
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => rateLimitKey(req),
  message: {
    success: false,
    error: 'تم تجاوز عدد محاولات تسجيل الدخول. يرجى المحاولة لاحقاً.'
  },
  skipSuccessfulRequests: true,
});

/**
 * Limiter المزامنة:
 * - رفعناه لأن 10/دقيقة قليل جداً لمزامنة حقيقية
 * - keyGenerator: حسب المستخدم إذا optionalAuthenticate قبل هذا limiter
 */
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // كان 10
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => rateLimitKey(req),
  message: {
    success: false,
    error: 'تم تجاوز حد طلبات المزامنة. يرجى الانتظار قليلاً.'
  }
});

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
