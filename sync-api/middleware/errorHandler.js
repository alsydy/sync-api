// ============================================================================
// Error Handler Middleware
// ============================================================================
// معالجة الأخطاء بشكل احترافي ومحسّن
// ============================================================================

const logger = require('../utils/logger');

/**
 * معالجة الأخطاء بشكل موحد ومحسّن
 * @param {Object} res - Express response object
 * @param {Error} error - Error object
 * @param {Number} statusCode - HTTP status code (default: 500)
 */
function handleError(res, error, statusCode = 500) {
  // تسجيل الخطأ
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    statusCode,
    code: error.code,
    name: error.name
  };
  
  logger.error('Error occurred', errorInfo);
  
  // تصنيف الأخطاء حسب نوعها
  if (error.code === '23505') { // Unique violation (PostgreSQL)
    return res.status(409).json({
      success: false,
      error: 'البيانات مكررة',
      code: 'DUPLICATE_ENTRY',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
  
  if (error.code === '23503') { // Foreign key violation (PostgreSQL)
    return res.status(400).json({
      success: false,
      error: 'البيانات المرتبطة غير موجودة',
      code: 'FOREIGN_KEY_VIOLATION',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
  
  if (error.code === '23502') { // Not null violation (PostgreSQL)
    return res.status(400).json({
      success: false,
      error: 'حقل مطلوب مفقود',
      code: 'NOT_NULL_VIOLATION',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
  
  if (error.code === '42P01') { // Table does not exist
    return res.status(500).json({
      success: false,
      error: 'جدول غير موجود في قاعدة البيانات',
      code: 'TABLE_NOT_FOUND',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
  
  // أخطاء المصادقة
  if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'Token غير صالح أو منتهي الصلاحية',
      code: 'INVALID_TOKEN'
    });
  }
  
  // إرسال إشعار للأخطاء الحرجة (500+)
  if (statusCode >= 500) {
    logger.error('Critical error - should send notification', {
      error: error.message,
      stack: error.stack,
      statusCode
    });
    // يمكن إضافة إرسال إشعار هنا (email, Slack, etc.)
  }
  
  // الرد الافتراضي
  res.status(statusCode).json({
    success: false,
    error: error.message || 'حدث خطأ غير متوقع',
    code: error.code || 'UNKNOWN_ERROR',
    details: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
}

/**
 * Middleware لمعالجة الأخطاء في Express
 */
function errorHandler(err, req, res, next) {
  // إذا كان الرد قد أُرسل بالفعل، استخدم default error handler
  if (res.headersSent) {
    return next(err);
  }
  
  // تحديد status code
  const statusCode = err.statusCode || err.status || 500;
  
  // معالجة الخطأ
  handleError(res, err, statusCode);
}

module.exports = {
  handleError,
  errorHandler
};

