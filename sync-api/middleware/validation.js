// ============================================================================
// Input Validation Middleware
// ============================================================================

const { body, param, query, validationResult } = require('express-validator');

// Logger (robust)
let logger = console;
try { logger = require('../utils/logger'); }
catch (e1) {
  try { logger = require('./utils/logger'); }
  catch (e2) { logger = console; }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize user fields قبل التحقق:
 * - name -> fullName
 * - phoneNumber -> phone
 * ✅ مهم: لا نقوم بأي تحويل لصيغة رقم الهاتف (لا +967)
 */
function normalizeUserBody(req) {
  if (!req.body || typeof req.body !== 'object') return;

  // name -> fullName
  if ((!req.body.fullName || String(req.body.fullName).trim() === '') && req.body.name) {
    req.body.fullName = req.body.name;
  }

  // phoneNumber -> phone
  if ((!req.body.phone || String(req.body.phone).trim() === '') && req.body.phoneNumber) {
    req.body.phone = req.body.phoneNumber;
  }

  // ✅ Keep phone "as-is" (لكن ننظف المسافات فقط)
  if (typeof req.body.phone === 'string') {
    req.body.phone = req.body.phone.trim();
  }
}

/**
 * Phone validation (RAW):
 * ✅ يسمح فقط:
 * - أرقام فقط 7..15 (مثل 775410201)
 * - أو + في البداية فقط ثم أرقام 7..15 (مثل +967775410201)
 * ❌ يرفض "967+775..." أو أي + في الوسط
 */
function isValidPhone(val) {
  if (val === undefined || val === null) return true; // optional
  const s = String(val).trim();
  if (s.length === 0) return true;

  if (/^\d{7,15}$/.test(s)) return true;       // digits only
  if (/^\+\d{7,15}$/.test(s)) return true;     // +digits
  return false;
}

// ============================================================================
// Result handler
// ============================================================================

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorDetails = errors.array().map(err => ({
      field: err.path || err.param,
      message: err.msg,
      value: err.value
    }));

    if (logger?.warn) {
      logger.warn('Validation failed', {
        errors: errorDetails,
        path: req.path,
        method: req.method,
        body: req.body
      });
    }

    const firstError = errorDetails[0];
    return res.status(400).json({
      success: false,
      error: firstError ? firstError.message : 'خطأ في التحقق من البيانات',
      errors: errorDetails
    });
  }
  next();
};

// ============================================================================
// Validation Rules
// ============================================================================

/**
 * Login validation
 * ✅ لا تغيير على الرقم، فقط تحقق RAW
 */
const validateLogin = [
  body('phone')
    .notEmpty().withMessage('رقم الهاتف مطلوب')
    .trim()
    .isString().withMessage('رقم الهاتف يجب أن يكون نص')
    .custom((v) => {
      if (!isValidPhone(v)) throw new Error('رقم الهاتف غير صحيح');
      return true;
    }),
  body('password')
    .notEmpty().withMessage('كلمة المرور مطلوبة')
    .isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
  validate
];

/**
 * User validation
 * ✅ name/fullName و phone/phoneNumber فقط
 * ✅ accountNumber اختياري
 */
const validateUser = [
  (req, _res, next) => { try { normalizeUserBody(req); } catch (_) {} next(); },

  body('phone')
    .optional()
    .trim()
    .custom((v) => {
      if (!isValidPhone(v)) throw new Error('رقم الهاتف غير صحيح');
      return true;
    }),

  body('phoneNumber')
    .optional()
    .trim()
    .custom((v) => {
      if (!isValidPhone(v)) throw new Error('رقم الهاتف غير صحيح');
      return true;
    }),

  body('name')
    .optional()
    .isLength({ min: 2, max: 255 }).withMessage('الاسم يجب أن يكون بين 2 و 255 حرف'),

  body('fullName')
    .optional()
    .isLength({ min: 2, max: 255 }).withMessage('الاسم الكامل يجب أن يكون بين 2 و 255 حرف'),

  body('firebaseUid')
    .optional()
    .isString().withMessage('firebaseUid يجب أن يكون نص')
    .isLength({ min: 1, max: 128 }).withMessage('firebaseUid يجب أن يكون بين 1 و 128 حرف'),

  body('userUuid')
    .optional()
    .isUUID().withMessage('userUuid يجب أن يكون UUID صحيح'),

  body('accountNumber')
    .optional({ nullable: true })
    .custom((v) => {
      if (v === null || v === undefined || v === '') return true;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) throw new Error('رقم الحساب يجب أن يكون رقم موجب');
      return true;
    }),

  validate
];

const validateClient = [
  body('clientName').optional().isLength({ min: 2, max: 255 }).withMessage('اسم العميل يجب أن يكون بين 2 و 255 حرف'),
  body('name').optional().isLength({ min: 2, max: 255 }).withMessage('الاسم يجب أن يكون بين 2 و 255 حرف'),
  body('ownerUserId').optional().isInt({ min: 1 }).withMessage('ownerUserId يجب أن يكون رقم موجب'),
  body('clientUuid').optional().isUUID().withMessage('clientUuid يجب أن يكون UUID صحيح'),
  validate
];

const validateTransaction = [
  body('amount').notEmpty().withMessage('المبلغ مطلوب').isFloat({ min: 0 }).withMessage('المبلغ يجب أن يكون رقم موجب'),
  body('transactionAmount').optional().isFloat({ min: 0 }).withMessage('المبلغ يجب أن يكون رقم موجب'),
  body('direction').notEmpty().withMessage('الاتجاه مطلوب').isIn(['income', 'expense']).withMessage('الاتجاه يجب أن يكون income أو expense'),
  body('transactionDirection').optional().isIn(['income', 'expense']).withMessage('الاتجاه يجب أن يكون income أو expense'),
  body('accountId').notEmpty().withMessage('معرف الحساب مطلوب').isInt({ min: 1 }).withMessage('معرف الحساب يجب أن يكون رقم موجب'),
  body('transactionUuid').optional().isUUID().withMessage('transactionUuid يجب أن يكون UUID صحيح'),
  validate
];

const validateAccount = [
  body('accountName').optional().isLength({ min: 2, max: 255 }).withMessage('اسم الحساب يجب أن يكون بين 2 و 255 حرف'),
  body('name').optional().isLength({ min: 2, max: 255 }).withMessage('الاسم يجب أن يكون بين 2 و 255 حرف'),
  body('accountUuid').optional().isUUID().withMessage('accountUuid يجب أن يكون UUID صحيح'),
  validate
];

const validatePagination = [
  query('page').optional().isInt({ min: 1 }).withMessage('الصفحة يجب أن تكون رقم موجب').toInt(),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('الحد يجب أن يكون بين 1 و 100').toInt(),
  validate
];

const validateFCMToken = [
  body('token').notEmpty().withMessage('Token مطلوب').isString().withMessage('Token يجب أن يكون نص').isLength({ min: 10 }).withMessage('Token قصير جداً'),
  body('firebaseUid').optional().isString().withMessage('firebaseUid يجب أن يكون نص'),
  validate
];

const validateUUID = (paramName = 'id') => [
  param(paramName).isUUID().withMessage(`${paramName} يجب أن يكون UUID صحيح`),
  validate
];

const validateID = (paramName = 'id') => [
  param(paramName).isInt({ min: 1 }).withMessage(`${paramName} يجب أن يكون رقم موجب`).toInt(),
  validate
];

module.exports = {
  validate,
  validateLogin,
  validateUser,
  validateClient,
  validateTransaction,
  validateAccount,
  validatePagination,
  validateFCMToken,
  validateUUID,
  validateID
};
