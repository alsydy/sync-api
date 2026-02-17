// ============================================================================
// Client Controller
// ============================================================================
// Controller للعملاء (Clients)
// ============================================================================

const { pool } = require('../config/database');
const {
  ensureUuid,
  isValidUUID,
  msToSeconds,
  secondsToMs,
  intToBoolean,
  normalizeOwnerUserId,
  resolveOwnerUserIdForRequest
} = require('../utils/helpers');
const { mapClientToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { resolveConflict } = require('../services/conflictResolver');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * GET /api/clients
 * الحصول على جميع العملاء لمستخدم محدد
 */
async function getClients(req, res, next) {
  try {
    const { ownerUserId, ownerFirebaseUid, archived, sinceTimestamp } = req.query;

    let query = 'SELECT * FROM business_clients WHERE deleted_at IS NULL';
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
    if (archived !== undefined) {
      query += ` AND is_archived = $${paramIndex++}`;
      params.push(intToBoolean(archived));
    }

    // دعم المزامنة التزايدية
    if (sinceTimestamp) {
      const sinceSeconds = msToSeconds(parseInt(sinceTimestamp, 10));
      if (sinceSeconds) {
        query += ` AND updated_at > to_timestamp($${paramIndex++})`;
        params.push(sinceSeconds);
      }
    }

    query += ' ORDER BY updated_at DESC, created_at DESC';
    const result = await pool.query(query, params);

    const clients = result.rows.map(row => mapClientToAPI(row));
    res.json({ success: true, data: clients, count: clients.length });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/clients/:clientId
 * الحصول على عميل محدد
 */
async function getClientById(req, res, next) {
  try {
    const { clientId } = req.params;

    // التحقق من أن clientId ليس كلمة محجوزة
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(String(clientId).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid client ID: "${clientId}" is a reserved word`
      });
    }

    // التحقق من أن clientId هو رقم
    if (!/^\d+$/.test(String(clientId))) {
      return res.status(400).json({
        success: false,
        error: `Invalid client ID format: "${clientId}" must be a number`
      });
    }

    const result = await pool.query(
      'SELECT * FROM business_clients WHERE client_id = $1 AND deleted_at IS NULL',
      [clientId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    res.json({ success: true, data: mapClientToAPI(result.rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/clients
 * إنشاء عميل جديد
 */
async function createClient(req, res, next) {
  try {
    const clientData = ensureUuid(req.body);

    // الحصول على ownerUserId الصحيح + ربطه بالـ auth إن توفر
    const resolved = await resolveOwnerUserIdForRequest({
      ownerUserId: clientData.ownerUserId,
      ownerFirebaseUid: clientData.ownerFirebaseUid,
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

    const uuid = (clientData.clientUuid && isValidUUID(clientData.clientUuid))
      ? clientData.clientUuid
      : ((clientData.entryId && isValidUUID(clientData.entryId))
        ? clientData.entryId
        : uuidv4());

    const clientName = (clientData.name || clientData.clientName || '').toString().trim();
    if (!clientName) {
      return res.status(400).json({ success: false, error: 'اسم العميل مطلوب' });
    }

    const result = await pool.query(
      `INSERT INTO business_clients (
        client_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_name, phone_number, job_title, notes, is_archived,
        device_id, sync_version, created_at, updated_at, cached_total_balance
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_timestamp($13), CURRENT_TIMESTAMP, $14)
      RETURNING *`,
      [
        uuid,
        clientData.cloudId || null,
        clientData.firestoreId || null,
        ownerUserId,
        ownerFirebaseUid || null,
        clientName,
        clientData.phone || clientData.phoneNumber || null,
        clientData.jobTitle || null,
        clientData.notes || null,
        intToBoolean(clientData.archived !== undefined ? clientData.archived : 0),
        clientData.deviceId || null,
        clientData.syncVersion || 1,
        msToSeconds(clientData.createdAt || Date.now()),
        clientData.cachedTotalBalance || null
      ]
    );

    const client = result.rows[0];

    await logAudit(
      client.owner_user_id,
      client.owner_firebase_uid,
      'create',
      'client',
      client.client_id.toString(),
      null,
      client,
      req
    );

    res.status(201).json({ success: true, data: mapClientToAPI(client), action: 'created' });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/clients/by-uuid/:clientUuid
 * حذف عميل (Soft Delete) حسب UUID
 */
async function deleteClientByUuid(req, res, next) {
  try {
    const { clientUuid } = req.params;

    if (!clientUuid) {
      return res.status(400).json({ success: false, error: 'clientUuid مطلوب' });
    }

    const result = await pool.query(
      `UPDATE business_clients
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE client_uuid = $1 AND deleted_at IS NULL
       RETURNING *`,
      [clientUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    const client = result.rows[0];
    await logAudit(
      client.owner_user_id,
      client.owner_firebase_uid,
      'delete',
      'client',
      client.client_id.toString(),
      client,
      null,
      req
    );

    res.json({ success: true, data: mapClientToAPI(client) });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/clients/sync
 * مزامنة عميل (Insert or Update حسب UUID)
 */
async function syncClient(req, res, next) {
  try {
    const clientData = ensureUuid(req.body);
    const uuid = clientData.clientUuid || (clientData.entryId && isValidUUID(clientData.entryId) ? clientData.entryId : uuidv4());

    if (!uuid) {
      return res.status(400).json({ success: false, error: 'clientUuid أو entryId مطلوب' });
    }

    const existing = await pool.query(
      'SELECT client_id, sync_version, updated_at FROM business_clients WHERE client_uuid = $1',
      [uuid]
    );

    if (existing.rows.length > 0) {
      const existingClient = existing.rows[0];

      // حل التعارضات
      if (clientData.syncVersion && existingClient.sync_version) {
        const conflictResult = await resolveConflict('business_clients', uuid, clientData, {
          syncVersion: existingClient.sync_version,
          updatedAt: secondsToMs(existingClient.updated_at)
        });

        if (conflictResult.winner !== clientData) {
          const remoteClient = await pool.query('SELECT * FROM business_clients WHERE client_uuid = $1', [uuid]);
          const client = remoteClient.rows[0];
          return res.json({
            success: true,
            data: mapClientToAPI(client),
            action: 'conflict_resolved',
            conflict: true,
            conflictReason: conflictResult.reason
          });
        }
      }

      // ✅ FIX: تحقق ownerUserId مثل INSERT + ربطه بالـ auth
      const resolved = await resolveOwnerUserIdForRequest({
        ownerUserId: clientData.ownerUserId,
        ownerFirebaseUid: clientData.ownerFirebaseUid,
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

      const clientName = (clientData.name || clientData.clientName || '').toString().trim();
      if (!clientName) {
        return res.status(400).json({ success: false, error: 'اسم العميل مطلوب' });
      }

      // archived: إذا undefined لا تغيّر القيمة
      const archivedVal = (clientData.archived === undefined)
        ? null
        : intToBoolean(clientData.archived);

      const result = await pool.query(
        `UPDATE business_clients SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          client_name = $6,
          phone_number = COALESCE($7, phone_number),
          job_title = COALESCE($8, job_title),
          notes = COALESCE($9, notes),
          is_archived = COALESCE($10, is_archived),
          device_id = COALESCE($11, device_id),
          cached_total_balance = COALESCE($12, cached_total_balance),
          sync_version = COALESCE($13, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE client_uuid = $1 AND deleted_at IS NULL
        RETURNING *`,
        [
          uuid,
          clientData.cloudId,
          clientData.firestoreId,
          ownerUserId, // ✅ مضمون
          ownerFirebaseUid,
          clientName,
          clientData.phone || clientData.phoneNumber,
          clientData.jobTitle,
          clientData.notes,
          archivedVal,
          clientData.deviceId,
          clientData.cachedTotalBalance,
          clientData.syncVersion || existingClient.sync_version || 0
        ]
      );

      const client = result.rows[0];

      await logAudit(
        client.owner_user_id,
        client.owner_firebase_uid,
        'update',
        'client',
        client.client_id.toString(),
        existingClient,
        client,
        req
      );

      return res.json({ success: true, data: mapClientToAPI(client), action: 'updated' });
    } else {
      // الحصول على ownerUserId الصحيح
      const resolved = await resolveOwnerUserIdForRequest({
        ownerUserId: clientData.ownerUserId,
        ownerFirebaseUid: clientData.ownerFirebaseUid,
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

      const clientName = (clientData.name || clientData.clientName || '').toString().trim();
      if (!clientName) {
        return res.status(400).json({ success: false, error: 'اسم العميل مطلوب' });
      }

      const result = await pool.query(
        `INSERT INTO business_clients (
          client_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          client_name, phone_number, job_title, notes, is_archived,
          device_id, sync_version, created_at, updated_at, cached_total_balance
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_timestamp($13), CURRENT_TIMESTAMP, $14)
        RETURNING *`,
        [
          uuid,
          clientData.cloudId || null,
          clientData.firestoreId || null,
          ownerUserId,
          ownerFirebaseUid || null,
          clientName,
          clientData.phone || clientData.phoneNumber || null,
          clientData.jobTitle || null,
          clientData.notes || null,
          intToBoolean(clientData.archived !== undefined ? clientData.archived : 0),
          clientData.deviceId || null,
          clientData.syncVersion || 1,
          msToSeconds(clientData.createdAt || Date.now()),
          clientData.cachedTotalBalance || null
        ]
      );

      const client = result.rows[0];

      await logAudit(
        client.owner_user_id,
        client.owner_firebase_uid,
        'create',
        'client',
        client.client_id.toString(),
        null,
        client,
        req
      );

      return res.json({ success: true, data: mapClientToAPI(client), action: 'created' });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/clients/by-phone/:phoneNumber
 * البحث عن جميع العملاء برقم الهاتف (للمتابعة الديون)
 */
async function getClientsByPhone(req, res, next) {
  try {
    const { phoneNumber } = req.params;
    const { ownerFirebaseUid, excludeOwnerId } = req.query;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber مطلوب'
      });
    }

    let query = `
      SELECT * FROM business_clients
      WHERE phone_number = $1
        AND deleted_at IS NULL
    `;
    const params = [phoneNumber];
    let paramIndex = 2;

    if (ownerFirebaseUid) {
      query += ` AND owner_firebase_uid = $${paramIndex++}`;
      params.push(ownerFirebaseUid);
    }

    if (excludeOwnerId) {
      query += ` AND owner_user_id != $${paramIndex++}`;
      params.push(parseInt(excludeOwnerId, 10));
    }

    query += ' ORDER BY updated_at DESC, created_at DESC';

    const result = await pool.query(query, params);
    const clients = result.rows.map(row => mapClientToAPI(row));

    res.json({ success: true, data: clients, count: clients.length });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getClients,
  getClientById,
  createClient,
  deleteClientByUuid,
  syncClient,
  getClientsByPhone
};
