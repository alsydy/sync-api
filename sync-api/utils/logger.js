// ============================================================================
// Professional Logger - Winston
// ============================================================================
// نظام logging احترافي بدلاً من console.log
// ============================================================================

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// إنشاء مجلد logs إذا لم يكن موجوداً
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// تنسيق السجلات
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// تنسيق console (للألوان في التطوير)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// إنشاء logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: logFormat,
  defaultMeta: { 
    service: 'malymax-api',
    environment: process.env.NODE_ENV || 'development'
  },
  transports: [
    // كتابة الأخطاء في ملف منفصل
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: logFormat
    }),
    // كتابة جميع السجلات
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      format: logFormat
    }),
  ],
  // معالجة الاستثناءات غير المعالجة
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log')
    })
  ],
  // معالجة الوعود المرفوضة
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log')
    })
  ]
});

// في التطوير، أظهر السجلات في console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat,
    level: 'debug'
  }));
} else {
  // في الإنتاج، أظهر فقط الأخطاء والتحذيرات
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
    level: 'warn'
  }));
}

// دوال مساعدة للاستخدام السهل
logger.success = (message, meta = {}) => {
  logger.info(`✅ ${message}`, meta);
};

logger.warning = (message, meta = {}) => {
  logger.warn(`⚠️ ${message}`, meta);
};

logger.errorMsg = (message, meta = {}) => {
  logger.error(`❌ ${message}`, meta);
};

module.exports = logger;

