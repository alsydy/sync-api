// ============================================================================
// Audit Service
// ============================================================================
// خدمة تسجيل العمليات في audit_log
// ============================================================================

const { pool } = require('../config/database');
const logger = require('../utils/logger');

/**
 * تسجيل العملية في audit_log
 * ملاحظة: تم تحسين الأداء -> تسجيل غير حاجب (لا ننتظر INSERT)
 */
function logAudit(userId, firebaseUid, actionType, entityType, entityId, oldValues = null, newValues = null, req = null) {
  try {
    const params = [
      userId,
      firebaseUid,
      actionType,
      entityType,
      entityId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      req?.ip || req?.connection?.remoteAddress || null,
      req?.get?.('user-agent') ? req.get('user-agent') : (req?.headers?.['user-agent'] || null)
    ];

    // ✅ Fire-and-forget: لا ننتظر حتى لا نبطئ الطلب الأساسي
    pool.query(
      `INSERT INTO audit_log (
        user_id, firebase_uid, action_type, entity_type, entity_id,
        old_values, new_values, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      params
    ).catch((error) => {
      logger.errorMsg('Error logging audit', {
        error: error.message,
        userId,
        actionType,
        entityType
      });
    });
  } catch (error) {
    logger.errorMsg('Error logging audit (sync throw)', {
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
