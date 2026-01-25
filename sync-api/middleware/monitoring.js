// ============================================================================
// Monitoring Middleware
// ============================================================================
// Middleware لتتبع الطلبات وجمع إحصائيات المراقبة
// ============================================================================

const { recordRequest } = require('../services/monitoringService');
const logger = require('../utils/logger');

/**
 * Middleware لتتبع الطلبات
 */
function monitoringMiddleware(req, res, next) {
  const startTime = Date.now();
  const method = req.method;
  const path = req.path;
  
  // تسجيل وقت الانتهاء
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;
    
    // تسجيل الطلب
    recordRequest(method, path, statusCode, duration);
    
    // تسجيل الطلبات البطيئة في السجلات
    if (duration > 1000) {
      logger.warning('Slow request detected', {
        method,
        path,
        statusCode,
        duration: `${duration}ms`,
        requestId: req.id
      });
    }
    
    // تسجيل الأخطاء في السجلات
    if (statusCode >= 500) {
      logger.error('Server error', {
        method,
        path,
        statusCode,
        duration: `${duration}ms`,
        requestId: req.id
      });
    }
  });
  
  next();
}

module.exports = {
  monitoringMiddleware
};

