// ============================================================================
// Audit Service
// ============================================================================
// خدمة تسجيل العمليات في audit_log
// ============================================================================

const { pool } = require('../config/database');
const logger = require('../utils/logger');

/**
 * تسجيل العملية في audit_log
 * @param {Number} userId - معرف المستخدم
 * @param {String} firebaseUid - Firebase UID
 * @param {String} actionType - نوع العملية (create, update, delete)
 * @param {String} entityType - نوع الكيان (user, client, account, transaction)
 * @param {String} entityId - معرف الكيان
 * @param {Object} oldValues - القيم القديمة
 * @param {Object} newValues - القيم الجديدة
 * @param {Object} req - Express request object
 */
async function logAudit(userId, firebaseUid, actionType, entityType, entityId, oldValues = null, newValues = null, req = null) {
  try {
    await pool.query(
      `INSERT INTO audit_log (
        user_id, firebase_uid, action_type, entity_type, entity_id,
        old_values, new_values, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        firebaseUid,
        actionType,
        entityType,
        entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        req?.ip || req?.connection?.remoteAddress || null,
        req?.get('user-agent') || null
      ]
    );
  } catch (error) {
    // لا نرمي خطأ هنا حتى لا نؤثر على العملية الأساسية
    logger.errorMsg('Error logging audit', {
      error: error.message,
      userId,
      actionType,
      entityType
    });
  }
}

module.exports = {
  logAudit
};

