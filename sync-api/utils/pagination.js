// ============================================================================
// Pagination Utilities
// ============================================================================
// دوال مساعدة للتعامل مع pagination
// ============================================================================

/**
 * الحصول على معاملات pagination من request
 * @param {Object} req - Express request object
 * @param {Number} defaultLimit - الحد الافتراضي (default: 20)
 * @param {Number} maxLimit - الحد الأقصى (default: 100)
 * @returns {Object} { page, limit, offset }
 */
function getPaginationParams(req, defaultLimit = 20, maxLimit = 100) {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  let limit = parseInt(req.query.limit) || defaultLimit;
  
  // تحديد حد أقصى
  if (limit > maxLimit) {
    limit = maxLimit;
  }
  
  // التأكد من أن limit رقم موجب
  if (limit < 1) {
    limit = defaultLimit;
  }
  
  const offset = (page - 1) * limit;
  
  return { page, limit, offset };
}

/**
 * إنشاء metadata للـ pagination
 * @param {Number} page - رقم الصفحة الحالية
 * @param {Number} limit - عدد العناصر في الصفحة
 * @param {Number} total - العدد الإجمالي للعناصر
 * @returns {Object} pagination metadata
 */
function getPaginationMeta(page, limit, total) {
  const totalPages = Math.ceil(total / limit);
  
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    nextPage: page < totalPages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null
  };
}

/**
 * إنشاء response مع pagination
 * @param {Array} data - البيانات
 * @param {Number} page - رقم الصفحة
 * @param {Number} limit - الحد
 * @param {Number} total - العدد الإجمالي
 * @returns {Object} response object
 */
function createPaginationResponse(data, page, limit, total) {
  return {
    data,
    pagination: getPaginationMeta(page, limit, total)
  };
}

module.exports = {
  getPaginationParams,
  getPaginationMeta,
  createPaginationResponse
};

