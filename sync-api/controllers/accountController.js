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
  resolveOwnerUserIdForRequest,
  normalizeColorCode
} = require('../utils/helpers');
const { mapAccountToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { resolveConflict } = require('../services/conflictResolver');
const { ensureDefaultAccounts } = require('../services/defaultAccountsService');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

function mapAccountLinkToAPI(row) {
  return {
    id: row.link_id,
    linkId: row.link_id,
    userId: row.user_id,
    userFirebaseUid: row.user_firebase_uid,
    accountFirestoreId: row.account_firestore_id,
    isHidden: row.is_hidden,
    createdAt: row.created_at ? secondsToMs(row.created_at) : null,
    updatedAt: row.updated_at ? secondsToMs(row.updated_at) : null
  };
}

/**
 * GET /api/accounts
 * الحصول على جميع الحسابات النقدية
 */
async function getAccounts(req, res, next) {
  try {
    const { ownerUserId, ownerFirebaseUid, sinceTimestamp } = req.query;

    const authUserId = req.user?.userId;
    let effectiveUserId = null;
    let authUserIdNum = null;

    if (authUserId != null) {
      const parsed = typeof authUserId === 'string' ? parseInt(authUserId, 10) : authUserId;
      authUserIdNum = Number.isFinite(parsed) ? parsed : null;
      effectiveUserId = authUserIdNum;
    } else if (ownerUserId != null) {
      const parsed = typeof ownerUserId === 'string' ? parseInt(ownerUserId, 10) : ownerUserId;
      effectiveUserId = Number.isFinite(parsed) ? parsed : null;
    }

    if (!effectiveUserId && ownerFirebaseUid) {
      const r = await pool.query(
        'SELECT user_id FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL LIMIT 1',
        [ownerFirebaseUid]
      );
      effectiveUserId = r.rows?.[0]?.user_id || null;
    }

    if (!effectiveUserId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (authUserIdNum && authUserIdNum === effectiveUserId) {
      await ensureDefaultAccounts(effectiveUserId);
    }

    let query = 'SELECT * FROM cash_accounts WHERE owner_user_id = $1 AND deleted_at IS NULL AND is_shared = FALSE';
    const params = [effectiveUserId];
    let paramIndex = 2;

    // دعم المزامنة التزايدية
    if (sinceTimestamp) {
      const sinceSeconds = msToSeconds(parseInt(sinceTimestamp));
      if (sinceSeconds) {
        query += ` AND updated_at > to_timestamp($${paramIndex++})`;
        params.push(sinceSeconds);
      }
    }

    query += ' ORDER BY (template_key IS NOT NULL) DESC, is_primary DESC, account_id ASC';
    const result = await pool.query(query, params);

    const accounts = result.rows.map(row => mapAccountToAPI(row));

    res.json({ success: true, data: accounts, count: accounts.length });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/accounts/links
 * جلب روابط المستخدم بالصناديق (مرئية فقط افتراضياً)
 */
async function getAccountLinks(req, res, next) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const includeHidden = String(req.query.includeHidden || '').toLowerCase() === 'true'
      || req.query.includeHidden === '1';

    const result = await pool.query(
      `SELECT link_id, user_id, user_firebase_uid, account_firestore_id, is_hidden, created_at, updated_at
       FROM user_account_links
       WHERE user_id = $1 ${includeHidden ? '' : 'AND is_hidden = FALSE'}
       ORDER BY updated_at DESC, created_at DESC`,
      [userId]
    );

    const links = result.rows.map(mapAccountLinkToAPI);
    res.json({ success: true, data: links, count: links.length });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/accounts/links/:accountFirestoreId
 * إنشاء/تحديث ربط صندوق لمستخدم (إخفاء/إظهار)
 */
async function upsertAccountLink(req, res, next) {
  try {
    const userId = req.user?.userId;
    const userFirebaseUid = req.user?.firebaseUid || req.user?.firebase_uid || null;
    const { accountFirestoreId } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!accountFirestoreId) {
      return res.status(400).json({ success: false, error: 'accountFirestoreId مطلوب' });
    }

    const isHidden = req.body?.isHidden === true
      || req.body?.isHidden === 1
      || req.body?.isHidden === '1';

    const result = await pool.query(
      `INSERT INTO user_account_links (
        user_id, user_firebase_uid, account_firestore_id, is_hidden, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, account_firestore_id) DO UPDATE SET
        is_hidden = EXCLUDED.is_hidden,
        user_firebase_uid = COALESCE(EXCLUDED.user_firebase_uid, user_account_links.user_firebase_uid),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *`,
      [userId, userFirebaseUid, accountFirestoreId, isHidden]
    );

    res.json({ success: true, data: mapAccountLinkToAPI(result.rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/accounts/links/:accountFirestoreId
 * حذف ربط صندوق لمستخدم (حذف حقيقي)
 */
async function deleteAccountLink(req, res, next) {
  try {
    const userId = req.user?.userId;
    const { accountFirestoreId } = req.params;

    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (!accountFirestoreId) {
      return res.status(400).json({ success: false, error: 'accountFirestoreId مطلوب' });
    }

    const result = await pool.query(
      `DELETE FROM user_account_links
       WHERE user_id = $1 AND account_firestore_id = $2
       RETURNING *`,
      [userId, accountFirestoreId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الربط غير موجود' });
    }

    res.json({ success: true, data: mapAccountLinkToAPI(result.rows[0]) });
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

    const templateKeyRaw = accountData.templateKey || accountData.template_key || null;
    const templateKey = templateKeyRaw ? String(templateKeyRaw).trim().toLowerCase() : null;
    if (templateKey) {
      if (!['main', 'transfer'].includes(templateKey)) {
        return res.status(400).json({ success: false, error: 'templateKey غير مدعوم' });
      }
      const defaults = await ensureDefaultAccounts(ownerUserId);
      const match = defaults.find((row) => row.template_key === templateKey);
      if (!match) {
        return res.status(500).json({ success: false, error: 'تعذر تهيئة الصناديق الافتراضية' });
      }
      return res.json({ success: true, data: mapAccountToAPI(match), action: 'default' });
    }

    const existing = await pool.query(
      'SELECT account_id, sync_version, updated_at, template_key FROM cash_accounts WHERE account_uuid = $1',
      [uuid]
    );

    if (existing.rows.length > 0) {
      const existingAccount = existing.rows[0];

      if (existingAccount.template_key) {
        const remoteAccount = await pool.query('SELECT * FROM cash_accounts WHERE account_uuid = $1', [uuid]);
        const account = remoteAccount.rows[0];
        return res.json({ success: true, data: mapAccountToAPI(account), action: 'default' });
      }

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

      const result = await pool.query(
        `UPDATE cash_accounts SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          account_name = $6,
          is_primary = COALESCE($7, is_primary),
          is_shared = $8,
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
          false,
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
          false,
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
  deleteAccountByUuid,
  getAccountLinks,
  upsertAccountLink,
  deleteAccountLink
};

