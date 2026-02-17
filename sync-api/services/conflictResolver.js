// ============================================================================
// Conflict Resolution Service
// ============================================================================
// خدمة حل التعارضات في المزامنة
// ============================================================================

const logger = require('../utils/logger');
const { secondsToMs } = require('../utils/helpers');

/**
 * حل التعارضات بين البيانات المحلية والبعيدة
 * @param {String} tableName - اسم الجدول
 * @param {String} uuid - UUID السجل
 * @param {Object} localData - البيانات المحلية
 * @param {Object} remoteData - البيانات البعيدة
 * @returns {Object} { winner, conflict, reason }
 */
async function resolveConflict(tableName, uuid, localData, remoteData) {
  const localVersion = localData.syncVersion || 0;
  const remoteVersion = remoteData.syncVersion || 0;
  const localTime = localData.updatedAt || localData.createdAt || 0;
  const remoteTime = remoteData.updatedAt || remoteData.createdAt || 0;
  
  // ✅ الإصدار الأحدث يفوز
  if (localVersion > remoteVersion) {
    logger.info('Conflict resolved: Local wins (version)', {
      tableName,
      uuid,
      localVersion,
      remoteVersion
    });
    return { winner: localData, conflict: true, reason: 'version' };
  }
  
  if (remoteVersion > localVersion) {
    logger.info('Conflict resolved: Remote wins (version)', {
      tableName,
      uuid,
      localVersion,
      remoteVersion
    });
    return { winner: remoteData, conflict: true, reason: 'version' };
  }
  
  // ✅ نفس الإصدار - مقارنة بالوقت (Last Write Wins)
  if (localTime > remoteTime) {
    logger.info('Conflict resolved: Local wins (timestamp)', {
      tableName,
      uuid,
      localTime,
      remoteTime
    });
    return { winner: localData, conflict: true, reason: 'timestamp' };
  } else {
    logger.info('Conflict resolved: Remote wins (timestamp)', {
      tableName,
      uuid,
      localTime,
      remoteTime
    });
    return { winner: remoteData, conflict: true, reason: 'timestamp' };
  }
}

module.exports = {
  resolveConflict
};

