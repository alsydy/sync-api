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
  normalizeOwnerUserId
} = require('../utils/helpers');
const { mapClientToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { resolveConflict } = require('../services/conflictResolver');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * Helpers
 */
function pickClientUuid(clientData) {
  // يقبل clientUuid أو entryId
  const provided = clientData.clientUuid || clientData.entryId || null;

  // إذا موجود لكنه غير UUID => خطأ واضح
  if (provided && !isValidUUID(provided)) {
    return { ok: false, uuid: null, error: 'clientUuid/entryId غير صالح - يجب أن يكون UUID صحيح' };
  }

  // إذا غير موجود => ننشئ UUID (لكن الأفضل أن يكون التطبيق يرسله دائماً للمزامنة)
  const uuid = provided || uuidv4();
  return { ok: true, uuid };
}

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

    if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
    }

    if (ownerFirebaseUid) {
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

    // حماية إضافية (احتياط) - لكن بعد إصلاح ترتيب الراوتات غالباً لن تحتاجها
    const reservedWords = ['sync', 'by-phone', 'by-uuid', 'health', 'info', 'stats'];
    if (reservedWords.includes(String(clientId).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid client ID: "${clientId}" is a reserved word`
      });
    }

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

    const ownerUserId = await normalizeOwnerUserId(clientData.ownerUserId, clientData.ownerFirebaseUid);
    if (!ownerUserId) {
      return res.status(400).json({
        success: false,
        error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات'
      });
    }

    const uuidInfo = pickClientUuid(clientData);
    if (!uuidInfo.ok) {
      return res.status(400).json({ success: false, error: uuidInfo.error });
    }
    const uuid = uuidInfo.uuid;

    const clientName = (clientData.name || clientData.clientName || '').toString().trim();
    if (!clientName) {
      return res.status(400).json({ success: false, error: 'اسم العميل مطلوب' });
    }

    const createdAtSeconds = msToSeconds(clientData.createdAt || Date.now());

    const result = await pool.query(
      `INSERT INTO business_clients (
        client_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_name, phone_number, job_title, notes, is_archived,
        device_id, sync_version, created_at, updated_at, cached_total_balance
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, to_timestamp($13), CURRENT_TIMESTAMP, $14
      )
      RETURNING *`,
      [
        uuid,
        clientData.cloudId || null,
        clientData.firestoreId || null,
        ownerUserId,
        clientData.ownerFirebaseUid || null,
        clientName,
        clientData.phone || clientData.phoneNumber || null,
        clientData.jobTitle || null,
        clientData.notes || null,
        intToBoolean(clientData.archived !== undefined ? clientData.archived : 0),
        clientData.deviceId || null,
        clientData.syncVersion || 1,
        createdAtSeconds,
        clientData.cachedTotalBalance || null
      ]
    );

    const client = result.rows[0];

    await logAudit(
      client.owner_user_id,
      client.owner_firebase_uid,
      'create',
      'client',
      String(client.client_id),
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
    if (!isValidUUID(clientUuid)) {
      return res.status(400).json({ success: false, error: 'clientUuid غير صالح - يجب أن يكون UUID صحيح' });
    }

    const result = await pool.query(
      `UPDATE business_clients
       SET deleted_at = CURRENT_TIMESTAMP,
           sync_version = sync_version + 1,
           updated_at = CURRENT_TIMESTAMP
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
      String(client.client_id),
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

    const uuidInfo = pickClientUuid(clientData);
    if (!uuidInfo.ok) {
      return res.status(400).json({ success: false, error: uuidInfo.error });
    }
    const uuid = uuidInfo.uuid;

    // ✅ تحقق ownerUserId دائماً (حتى في update)
    const ownerUserId = await normalizeOwnerUserId(clientData.ownerUserId, clientData.ownerFirebaseUid);
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

    const existing = await pool.query(
      'SELECT client_id, sync_version, updated_at FROM business_clients WHERE client_uuid = $1',
      [uuid]
    );

    // ====== UPDATE ======
    if (existing.rows.length > 0) {
      const existingClient = existing.rows[0];

      // حل التعارضات (اختياري)
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

      // archived: إذا undefined لا تغيّر القيمة
      const archivedVal = (clientData.archived === undefined)
        ? null
        : intToBoolean(clientData.archived);

      // ✅ sync_version: نزيد +1 دائماً، ونضمن عدم الرجوع للخلف
      const incomingSync = Number.isFinite(Number(clientData.syncVersion))
        ? parseInt(clientData.syncVersion, 10)
        : null;

      const baseSync = Math.max(
        existingClient.sync_version || 0,
        incomingSync || 0
      );

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
          sync_version = $13,
          updated_at = CURRENT_TIMESTAMP
        WHERE client_uuid = $1 AND deleted_at IS NULL
        RETURNING *`,
        [
          uuid,
          clientData.cloudId || null,
          clientData.firestoreId || null,
          ownerUserId,
          clientData.ownerFirebaseUid || null,
          clientName,
          clientData.phone || clientData.phoneNumber || null,
          clientData.jobTitle || null,
          clientData.notes || null,
          archivedVal,
          clientData.deviceId || null,
          clientData.cachedTotalBalance || null,
          baseSync + 1
        ]
      );

      const client = result.rows[0];

      await logAudit(
        client.owner_user_id,
        client.owner_firebase_uid,
        'update',
        'client',
        String(client.client_id),
        existingClient,
        client,
        req
      );

      return res.json({ success: true, data: mapClientToAPI(client), action: 'updated' });
    }

    // ====== INSERT ======
    const createdAtSeconds = msToSeconds(clientData.createdAt || Date.now());

    const result = await pool.query(
      `INSERT INTO business_clients (
        client_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_name, phone_number, job_title, notes, is_archived,
        device_id, sync_version, created_at, updated_at, cached_total_balance
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, to_timestamp($13), CURRENT_TIMESTAMP, $14
      )
      RETURNING *`,
      [
        uuid,
        clientData.cloudId || null,
        clientData.firestoreId || null,
        ownerUserId,
        clientData.ownerFirebaseUid || null,
        clientName,
        clientData.phone || clientData.phoneNumber || null,
        clientData.jobTitle || null,
        clientData.notes || null,
        intToBoolean(clientData.archived !== undefined ? clientData.archived : 0),
        clientData.deviceId || null,
        (clientData.syncVersion ? parseInt(clientData.syncVersion, 10) : 0) + 1,
        createdAtSeconds,
        clientData.cachedTotalBalance || null
      ]
    );

    const client = result.rows[0];

    await logAudit(
      client.owner_user_id,
      client.owner_firebase_uid,
      'create',
      'client',
      String(client.client_id),
      null,
      client,
      req
    );

    return res.json({ success: true, data: mapClientToAPI(client), action: 'created' });
  } catch (error) {
    logger.error('syncClient error', { error: error?.message, stack: error?.stack });
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
      return res.status(400).json({ success: false, error: 'phoneNumber مطلوب' });
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
