// ============================================================================
// Authentication & Authorization Middleware
// ============================================================================
// نظام مصادقة وتحقق متقدم للأمان
// ============================================================================

const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

// JWT Secret (يجب أن يكون في .env)
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ============================================================================
// Rate Limiting
// ============================================================================

// Rate limiter عام
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 100, // 100 طلب لكل IP
  message: 'تم تجاوز الحد المسموح من الطلبات. يرجى المحاولة لاحقاً.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter للمصادقة
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 دقيقة
  max: 5, // 5 محاولات فقط
  message: 'تم تجاوز عدد محاولات تسجيل الدخول. يرجى المحاولة لاحقاً.',
  skipSuccessfulRequests: true,
});

// Rate limiter للمزامنة
const syncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 دقيقة
  max: 10, // 10 طلبات مزامنة في الدقيقة
  message: 'تم تجاوز حد طلبات المزامنة. يرجى الانتظار قليلاً.',
});

// ============================================================================
// JWT Token Functions
// ============================================================================

/**
 * إنشاء JWT token
 */
function generateToken(userId, firebaseUid) {
  return jwt.sign(
    { userId, firebaseUid, type: 'access' },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/**
 * التحقق من JWT token
 */
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

/**
 * Middleware للتحقق من المصادقة
 */
async function authenticate(req, res, next) {
  try {
    // الحصول على token من Header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'مطلوب token للمصادقة'
      });
    }
    
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    
    if (!decoded) {
      return res.status(401).json({
        success: false,
        error: 'Token غير صالح أو منتهي الصلاحية'
      });
    }
    
    // إضافة معلومات المستخدم للطلب
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
 */
async function optionalAuthenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const decoded = verifyToken(token);
      
      if (decoded) {
        req.user = {
          userId: decoded.userId,
          firebaseUid: decoded.firebaseUid
        };
      }
    }
    
    next();
  } catch (error) {
    // في حالة الخطأ، نستمر بدون مصادقة
    next();
  }
}

// ============================================================================
// Authorization Middleware
// ============================================================================

/**
 * التحقق من أن المستخدم يملك الصلاحية للوصول للمورد
 */
async function authorizeResource(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'مطلوب مصادقة للوصول لهذا المورد'
      });
    }
    
    // يمكن إضافة منطق إضافي للتحقق من الصلاحيات هنا
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

/**
 * التحقق من صحة البيانات المدخلة
 */
function validateInput(req, res, next) {
  // يمكن إضافة منطق التحقق هنا
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

