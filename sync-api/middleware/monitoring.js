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

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    // ✅ لا نجعل المراقبة تؤثر على الأداء أو تسبب أخطاء غير معالجة
    try {
      // نفذها بشكل غير حاجب (حتى لو كانت async)
      Promise.resolve(recordRequest(method, path, statusCode, duration))
        .catch((err) => {
          logger.warning('Monitoring recordRequest failed', {
            error: err?.message || String(err),
            method,
            path,
            statusCode,
            requestId: req.id
          });
        });
    } catch (err) {
      logger.warning('Monitoring recordRequest threw error', {
        error: err?.message || String(err),
        method,
        path,
        statusCode,
        requestId: req.id
      });
    }

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
