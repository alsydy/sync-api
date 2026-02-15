// ============================================================================
// Input Validation Middleware
// ============================================================================
// استخدام express-validator للتحقق من صحة المدخلات
// ============================================================================

const { body, param, query, validationResult } = require('express-validator');
const logger = require('../utils/logger');

/**
 * Middleware للتحقق من نتائج validation
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errorDetails = errors.array().map(err => ({
      field: err.path || err.param,
      message: err.msg,
      value: err.value
    }));
    
    logger.warn('Validation failed', {
      errors: errorDetails,
      path: req.path,
      method: req.method,
      body: req.body
    });
    
    // ✅ إرجاع رسالة خطأ أكثر وضوحاً
    const firstError = errorDetails[0];
    const errorMessage = firstError ? firstError.message : 'خطأ في التحقق من البيانات';
    
    return res.status(400).json({
      success: false,
      error: errorMessage,
      errors: errorDetails
    });
  }
  next();
};

// ============================================================================
// Validation Rules
// ============================================================================

/**
 * Validation rules لتسجيل الدخول
 */
const validateLogin = [
  body('phone')
    .notEmpty().withMessage('رقم الهاتف مطلوب')
    .trim()
    .isString().withMessage('رقم الهاتف يجب أن يكون نص')
    .matches(/^[0-9]{7,15}$/).withMessage('رقم الهاتف يجب أن يكون أرقام فقط (7-15 رقم)'),
  body('password')
    .notEmpty().withMessage('كلمة المرور مطلوبة')
    .isLength({ min: 6 }).withMessage('كلمة المرور يجب أن تكون 6 أحرف على الأقل'),
  validate
];

/**
 * Validation rules للمستخدم
 */
const validateUser = [
  body('phone')
    // ✅ السماح بأن يكون الحقل غائباً أو null
    .optional({ nullable: true })
    // ✅ استخدام تحقق عام للأرقام بدلاً من isMobilePhone(ar-IQ)
    // حتى يدعم أرقام دول مختلفة (6-15 رقم)
    .matches(/^[0-9]{6,15}$/).withMessage('رقم الهاتف يجب أن يكون أرقام فقط (6-15 رقم)'),
  body('name')
    .optional({ nullable: true })
    .isLength({ min: 2, max: 255 }).withMessage('الاسم يجب أن يكون بين 2 و 255 حرف'),
  body('fullName')
    .optional({ nullable: true })
    .isLength({ min: 2, max: 255 }).withMessage('الاسم الكامل يجب أن يكون بين 2 و 255 حرف'),
  body('firebaseUid')
    .optional({ nullable: true })
    .isString().withMessage('firebaseUid يجب أن يكون نص')
    .isLength({ min: 1, max: 128 }).withMessage('firebaseUid يجب أن يكون بين 1 و 128 حرف'),
  body('userUuid')
    .optional({ nullable: true })
    .isUUID().withMessage('userUuid يجب أن يكون UUID صحيح'),
  body('accountNumber')
    // ✅ الحقل اختياري بالكامل، وإذا كان null نتجاوزه
    .optional({ nullable: true })
    .isInt({ min: 1 }).withMessage('رقم الحساب يجب أن يكون رقم موجب'),
  validate
];

/**
 * Validation rules للعميل
 */
const validateClient = [
  body('clientName')
    .optional()
    .isLength({ min: 2, max: 255 }).withMessage('اسم العميل يجب أن يكون بين 2 و 255 حرف'),
  body('name')
    .optional()
    .isLength({ min: 2, max: 255 }).withMessage('الاسم يجب أن يكون بين 2 و 255 حرف'),
  body('ownerUserId')
    .optional()
    .isInt({ min: 1 }).withMessage('ownerUserId يجب أن يكون رقم موجب'),
  body('clientUuid')
    .optional()
    .isUUID().withMessage('clientUuid يجب أن يكون UUID صحيح'),
  validate
];

/**
 * Validation rules للمعاملة
 */
const validateTransaction = [
  body('amount')
    .notEmpty().withMessage('المبلغ مطلوب')
    .isFloat({ min: 0 }).withMessage('المبلغ يجب أن يكون رقم موجب'),
  body('transactionAmount')
    .optional()
    .isFloat({ min: 0 }).withMessage('المبلغ يجب أن يكون رقم موجب'),
  body('direction')
    .notEmpty().withMessage('الاتجاه مطلوب')
    .isIn(['income', 'expense']).withMessage('الاتجاه يجب أن يكون income أو expense'),
  body('transactionDirection')
    .optional()
    .isIn(['income', 'expense']).withMessage('الاتجاه يجب أن يكون income أو expense'),
  body('accountId')
    .notEmpty().withMessage('معرف الحساب مطلوب')
    .isInt({ min: 1 }).withMessage('معرف الحساب يجب أن يكون رقم موجب'),
  body('transactionUuid')
    .optional()
    .isUUID().withMessage('transactionUuid يجب أن يكون UUID صحيح'),
  validate
];

/**
 * Validation rules للحساب
 */
const validateAccount = [
  body('accountName')
    .optional()
    .isLength({ min: 2, max: 255 }).withMessage('اسم الحساب يجب أن يكون بين 2 و 255 حرف'),
  body('name')
    .optional()
    .isLength({ min: 2, max: 255 }).withMessage('الاسم يجب أن يكون بين 2 و 255 حرف'),
  body('accountUuid')
    .optional()
    .isUUID().withMessage('accountUuid يجب أن يكون UUID صحيح'),
  validate
];

/**
 * Validation rules للـ pagination
 */
const validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('الصفحة يجب أن تكون رقم موجب')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('الحد يجب أن يكون بين 1 و 100')
    .toInt(),
  validate
];

/**
 * Validation rules للـ FCM token
 */
const validateFCMToken = [
  body('token')
    .notEmpty().withMessage('Token مطلوب')
    .isString().withMessage('Token يجب أن يكون نص')
    .isLength({ min: 10 }).withMessage('Token قصير جداً'),
  body('firebaseUid')
    .optional()
    .isString().withMessage('firebaseUid يجب أن يكون نص'),
  validate
];

/**
 * Validation rules للـ UUID parameters
 */
const validateUUID = (paramName = 'id') => [
  param(paramName)
    .isUUID().withMessage(`${paramName} يجب أن يكون UUID صحيح`),
  validate
];

/**
 * Validation rules للـ ID parameters
 */
const validateID = (paramName = 'id') => [
  param(paramName)
    .isInt({ min: 1 }).withMessage(`${paramName} يجب أن يكون رقم موجب`)
    .toInt(),
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

