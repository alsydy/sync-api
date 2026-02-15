// ============================================================================
// Account Controller
// ============================================================================
// Controller للحسابات النقدية (Cash Accounts)
// ============================================================================

const { pool } = require('../config/database');
const {
  ensureUuid,
  isValidUUID,
  msToSeconds,
  secondsToMs,
  intToBoolean,
  normalizeOwnerUserId,
  resolveOwnerUserIdForRequest,
  normalizeColorCode
} = require('../utils/helpers');
const { mapAccountToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { resolveConflict } = require('../services/conflictResolver');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * GET /api/accounts
 * الحصول على جميع الحسابات النقدية
 */
async function getAccounts(req, res, next) {
  try {
    const { ownerUserId, ownerFirebaseUid, sinceTimestamp } = req.query;
    
    let query = 'SELECT * FROM cash_accounts WHERE deleted_at IS NULL';
    const params = [];
    let paramIndex = 1;
    
    if (req.user?.userId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(req.user.userId);
    } else if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
    }
    if (!req.user?.userId && ownerFirebaseUid) {
      query += ` AND owner_firebase_uid = $${paramIndex++}`;
      params.push(ownerFirebaseUid);
    }
    
    // دعم المزامنة التزايدية
    if (sinceTimestamp) {
      const sinceSeconds = msToSeconds(parseInt(sinceTimestamp));
      if (sinceSeconds) {
        query += ` AND updated_at > to_timestamp($${paramIndex++})`;
        params.push(sinceSeconds);
      }
    }
    
    query += ' ORDER BY is_primary DESC, updated_at DESC, created_at ASC';
    const result = await pool.query(query, params);
    
    const accounts = result.rows.map(row => mapAccountToAPI(row));
    
    res.json({ success: true, data: accounts, count: accounts.length });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/accounts/sync
 * مزامنة حساب نقدي
 */
async function syncAccount(req, res, next) {
  try {
    const accountData = ensureUuid(req.body);
    const uuid = accountData.accountUuid || (accountData.entryId && isValidUUID(accountData.entryId) ? accountData.entryId : uuidv4());
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'accountUuid أو entryId مطلوب' });
    }
    
    const existing = await pool.query(
      'SELECT account_id, sync_version, updated_at FROM cash_accounts WHERE account_uuid = $1',
      [uuid]
    );
    
    if (existing.rows.length > 0) {
      const existingAccount = existing.rows[0];
      
      // حل التعارضات
      if (accountData.syncVersion && existingAccount.sync_version) {
        const conflictResult = await resolveConflict('cash_accounts', uuid, accountData, {
          syncVersion: existingAccount.sync_version,
          updatedAt: secondsToMs(existingAccount.updated_at)
        });
        if (conflictResult.winner !== accountData) {
          const remoteAccount = await pool.query('SELECT * FROM cash_accounts WHERE account_uuid = $1', [uuid]);
          const account = remoteAccount.rows[0];
          return res.json({
            success: true,
            data: mapAccountToAPI(account),
            action: 'conflict_resolved',
            conflict: true,
            conflictReason: conflictResult.reason
          });
        }
      }
      
      // الحصول على ownerUserId الصحيح + ربطه بالـ auth
      const resolved = await resolveOwnerUserIdForRequest({
        ownerUserId: accountData.ownerUserId,
        ownerFirebaseUid: accountData.ownerFirebaseUid,
        authUserId: req.user?.userId,
        authFirebaseUid: req.user?.firebaseUid || req.user?.firebase_uid
      });

      if (resolved.error) {
        return res.status(403).json({ success: false, error: resolved.error });
      }

      const ownerUserId = resolved.ownerUserId;
      const ownerFirebaseUid = resolved.ownerFirebaseUid;

      if (!ownerUserId) {
        return res.status(400).json({
          success: false,
          error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات'
        });
      }
      
      const result = await pool.query(
        `UPDATE cash_accounts SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = COALESCE($4, owner_user_id),
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          account_name = $6,
          is_primary = COALESCE($7, is_primary),
          is_shared = COALESCE($8, is_shared),
          color_code = $9,
          device_id = COALESCE($10, device_id),
          sync_version = COALESCE($11, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE account_uuid = $1
        RETURNING *`,
        [
          uuid,
          accountData.cloudId,
          accountData.firestoreId,
          ownerUserId,
          ownerFirebaseUid,
          accountData.name || accountData.accountName,
          intToBoolean(accountData.isPrimary),
          intToBoolean(accountData.isShared),
          normalizeColorCode(accountData.color || accountData.colorCode),
          accountData.deviceId,
          accountData.syncVersion || existingAccount.sync_version || 0
        ]
      );
      
      const account = result.rows[0];
      
      await logAudit(
        account.owner_user_id,
        account.owner_firebase_uid,
        'update',
        'account',
        account.account_id.toString(),
        existingAccount,
        account,
        req
      );
      
      return res.json({ success: true, data: mapAccountToAPI(account), action: 'updated' });
    } else {
      // الحصول على ownerUserId الصحيح + ربطه بالـ auth
      const resolved = await resolveOwnerUserIdForRequest({
        ownerUserId: accountData.ownerUserId,
        ownerFirebaseUid: accountData.ownerFirebaseUid,
        authUserId: req.user?.userId,
        authFirebaseUid: req.user?.firebaseUid || req.user?.firebase_uid
      });

      if (resolved.error) {
        return res.status(403).json({ success: false, error: resolved.error });
      }

      const ownerUserId = resolved.ownerUserId;
      const ownerFirebaseUid = resolved.ownerFirebaseUid;
      
      if (!ownerUserId) {
        logger.error('ownerUserId is null in INSERT account', { accountData });
        return res.status(400).json({
          success: false,
          error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات. يرجى التأكد من أن المستخدم مسجل في النظام.'
        });
      }
      
      const result = await pool.query(
        `INSERT INTO cash_accounts (
          account_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          account_name, is_primary, is_shared, color_code,
          device_id, sync_version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, to_timestamp($12), CURRENT_TIMESTAMP)
        RETURNING *`,
        [
          uuid,
          accountData.cloudId || null,
          accountData.firestoreId || null,
          ownerUserId,
          ownerFirebaseUid || null,
          accountData.name || accountData.accountName,
          intToBoolean(accountData.isPrimary !== undefined ? accountData.isPrimary : 0),
          intToBoolean(accountData.isShared !== undefined ? accountData.isShared : 0),
          normalizeColorCode(accountData.color || accountData.colorCode),
          accountData.deviceId || null,
          accountData.syncVersion || 1,
          msToSeconds(accountData.createdAt || Date.now())
        ]
      );
      
      const account = result.rows[0];
      
      await logAudit(
        account.owner_user_id,
        account.owner_firebase_uid,
        'create',
        'account',
        account.account_id.toString(),
        null,
        account,
        req
      );
      
      return res.json({ success: true, data: mapAccountToAPI(account), action: 'created' });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/accounts/by-uuid/:accountUuid
 * حذف حساب (Soft Delete) حسب UUID
 */
async function deleteAccountByUuid(req, res, next) {
  try {
    const { accountUuid } = req.params;
    
    if (!accountUuid) {
      return res.status(400).json({ success: false, error: 'accountUuid مطلوب' });
    }
    
    const result = await pool.query(
      `UPDATE cash_accounts
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE account_uuid = $1 AND deleted_at IS NULL
       RETURNING *`,
      [accountUuid]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
    }
    
    const account = result.rows[0];
    await logAudit(
      account.owner_user_id,
      account.owner_firebase_uid,
      'delete',
      'account',
      account.account_id.toString(),
      null,
      account,
      req
    );
    
    res.json({ success: true, data: mapAccountToAPI(account) });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getAccounts,
  syncAccount,
  deleteAccountByUuid
};

