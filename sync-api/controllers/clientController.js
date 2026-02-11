/**
 * ============================================================================
 * Clients Controller (business_clients)
 * ============================================================================
 * - قراءة/إضافة/تحديث/حذف العملاء
 * - مزامنة العملاء (Upsert) مع حل بسيط للتعارضات
 * - يعتمد على توثيق JWT ويستخدم هوية المستخدم من التوكن كـ المصدر الأساسي للـ owner
 * ============================================================================
 */

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { handleError } = require('../middleware/errorHandler');

// Helpers (قد تكون موجودة في مشروعك، نستخدمها إن توفرت)
let helpers = {};
try {
  helpers = require('../utils/helpers');
} catch (_) {
  helpers = {};
}
const normalizePhoneNumber = helpers.normalizePhoneNumber || ((p) => (p || '').trim());
const validatePhoneNumber = helpers.validatePhoneNumber || (() => true);
const isValidUUID =
  helpers.isValidUUID ||
  ((v) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(v || '')
    ));

function safeParseInt(val) {
  const n = Number.parseInt(String(val), 10);
  return Number.isFinite(n) ? n : null;
}

function mapClientToAPI(row) {
  if (!row) return null;
  return {
    id: row.client_id,
    clientId: row.client_id,
    clientUuid: row.client_uuid,
    firestoreId: row.firestore_id,
    ownerUserId: row.owner_user_id,
    ownerFirebaseUid: row.owner_firebase_uid,
    name: row.name,
    phone: row.phone,
    address: row.address,
    notes: row.notes,
    isSupplier: !!row.is_supplier,
    isCustomer: !!row.is_customer,
    openingBalance: row.opening_balance ? Number(row.opening_balance) : 0,
    currency: row.currency || 'YER',
    isArchived: !!row.is_archived,
    syncVersion: row.sync_version || 1,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null
  };
}

function requireAuthOwner(req) {
  const tokenUserId = req?.user?.userId;
  const tokenFirebaseUid = req?.user?.firebaseUid;

  if (!tokenUserId) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
  return { ownerUserId: tokenUserId, ownerFirebaseUid: tokenFirebaseUid || null };
}

function assertOwnerMatchesToken(req, bodyOwnerUserId, bodyOwnerFirebaseUid) {
  const { ownerUserId, ownerFirebaseUid } = requireAuthOwner(req);

  const bodyUserId = safeParseInt(bodyOwnerUserId);
  if (bodyUserId !== null && bodyUserId !== ownerUserId) {
    const err = new Error('Forbidden: ownerUserId does not match token user');
    err.statusCode = 403;
    throw err;
  }

  if (bodyOwnerFirebaseUid && ownerFirebaseUid && String(bodyOwnerFirebaseUid) !== String(ownerFirebaseUid)) {
    const err = new Error('Forbidden: ownerFirebaseUid does not match token user');
    err.statusCode = 403;
    throw err;
  }

  return { ownerUserId, ownerFirebaseUid };
}

/**
 * GET /api/clients?sinceTimestamp=...
 * يجلب العملاء لهذا المستخدم فقط
 */
async function getClients(req, res) {
  try {
    const { ownerUserId } = requireAuthOwner(req);
    const sinceTimestamp = safeParseInt(req.query.sinceTimestamp) || 0;

    const result = await pool.query(
      `
      SELECT *
      FROM business_clients
      WHERE owner_user_id = $1
        AND ($2 = 0 OR EXTRACT(EPOCH FROM updated_at) * 1000 >= $2)
      ORDER BY updated_at ASC
      LIMIT 5000
      `,
      [ownerUserId, sinceTimestamp]
    );

    res.json({ success: true, data: result.rows.map(mapClientToAPI) });
  } catch (error) {
    handleError(res, error, 'getClients error');
  }
}

/**
 * GET /api/clients/:clientId
 */
async function getClientById(req, res) {
  try {
    const { ownerUserId } = requireAuthOwner(req);
    const clientId = safeParseInt(req.params.clientId);

    if (!clientId) {
      return res.status(400).json({ success: false, error: 'clientId غير صالح' });
    }

    const result = await pool.query(
      `SELECT * FROM business_clients WHERE client_id = $1 AND owner_user_id = $2`,
      [clientId, ownerUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    res.json({ success: true, data: mapClientToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error, 'getClientById error');
  }
}

/**
 * GET /api/clients/by-uuid/:clientUuid
 */
async function getClientByUuid(req, res) {
  try {
    const { ownerUserId } = requireAuthOwner(req);
    const clientUuid = req.params.clientUuid;

    if (!isValidUUID(clientUuid)) {
      return res.status(400).json({ success: false, error: 'clientUuid غير صالح' });
    }

    const result = await pool.query(
      `SELECT * FROM business_clients WHERE client_uuid = $1 AND owner_user_id = $2`,
      [clientUuid, ownerUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    res.json({ success: true, data: mapClientToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error, 'getClientByUuid error');
  }
}

/**
 * GET /api/clients/by-phone/:phone
 * يبحث عن عميل ضمن نفس المالك فقط
 */
async function getClientsByPhone(req, res) {
  try {
    const { ownerUserId } = requireAuthOwner(req);

    const rawPhone = req.params.phone;
    const phone = normalizePhoneNumber(rawPhone);

    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone مطلوب' });
    }
    if (validatePhoneNumber && validatePhoneNumber !== (() => true) && !validatePhoneNumber(phone)) {
      return res.status(400).json({ success: false, error: 'رقم الهاتف غير صحيح' });
    }

    const result = await pool.query(
      `SELECT * FROM business_clients WHERE owner_user_id = $1 AND phone = $2 ORDER BY updated_at DESC LIMIT 50`,
      [ownerUserId, phone]
    );

    res.json({ success: true, data: result.rows.map(mapClientToAPI) });
  } catch (error) {
    handleError(res, error, 'getClientsByPhone error');
  }
}

/**
 * POST /api/clients
 */
async function createClient(req, res) {
  try {
    const { ownerUserId, ownerFirebaseUid } = requireAuthOwner(req);

    const body = req.body || {};
    const clientUuid = body.clientUuid && isValidUUID(body.clientUuid) ? body.clientUuid : uuidv4();
    const firestoreId = body.firestoreId || null;

    const name = (body.name || '').trim();
    const phone = normalizePhoneNumber(body.phone || '');
    const address = (body.address || '').trim() || null;
    const notes = (body.notes || '').trim() || null;

    if (!name) return res.status(400).json({ success: false, error: 'name مطلوب' });

    const isSupplier = !!body.isSupplier;
    const isCustomer = body.isCustomer === undefined ? true : !!body.isCustomer;

    const openingBalance = Number(body.openingBalance || 0) || 0;
    const currency = (body.currency || 'YER').trim();

    const result = await pool.query(
      `
      INSERT INTO business_clients (
        client_uuid, firestore_id, owner_user_id, owner_firebase_uid,
        name, phone, address, notes,
        is_supplier, is_customer,
        opening_balance, currency,
        is_archived, sync_version
      ) VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,
        $9,$10,
        $11,$12,
        false, 1
      )
      RETURNING *
      `,
      [
        clientUuid, firestoreId, ownerUserId, ownerFirebaseUid,
        name, phone || null, address, notes,
        isSupplier, isCustomer,
        openingBalance, currency
      ]
    );

    res.status(201).json({ success: true, data: mapClientToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error, 'createClient error');
  }
}

/**
 * PUT /api/clients/:clientId
 */
async function updateClient(req, res) {
  try {
    const { ownerUserId } = requireAuthOwner(req);
    const clientId = safeParseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId غير صالح' });

    const body = req.body || {};
    const name = body.name !== undefined ? String(body.name).trim() : undefined;
    const phone = body.phone !== undefined ? normalizePhoneNumber(body.phone) : undefined;
    const address = body.address !== undefined ? String(body.address).trim() : undefined;
    const notes = body.notes !== undefined ? String(body.notes).trim() : undefined;

    const isSupplier = body.isSupplier !== undefined ? !!body.isSupplier : undefined;
    const isCustomer = body.isCustomer !== undefined ? !!body.isCustomer : undefined;

    const openingBalance = body.openingBalance !== undefined ? Number(body.openingBalance || 0) : undefined;
    const currency = body.currency !== undefined ? String(body.currency || 'YER').trim() : undefined;
    const isArchived = body.isArchived !== undefined ? !!body.isArchived : undefined;

    const result = await pool.query(
      `
      UPDATE business_clients
      SET
        name = COALESCE($1, name),
        phone = COALESCE($2, phone),
        address = COALESCE($3, address),
        notes = COALESCE($4, notes),
        is_supplier = COALESCE($5, is_supplier),
        is_customer = COALESCE($6, is_customer),
        opening_balance = COALESCE($7, opening_balance),
        currency = COALESCE($8, currency),
        is_archived = COALESCE($9, is_archived),
        sync_version = sync_version + 1,
        updated_at = NOW()
      WHERE client_id = $10 AND owner_user_id = $11
      RETURNING *
      `,
      [
        name ?? null,
        phone ?? null,
        address ?? null,
        notes ?? null,
        isSupplier ?? null,
        isCustomer ?? null,
        openingBalance ?? null,
        currency ?? null,
        isArchived ?? null,
        clientId,
        ownerUserId
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    res.json({ success: true, data: mapClientToAPI(result.rows[0]) });
  } catch (error) {
    handleError(res, error, 'updateClient error');
  }
}

/**
 * DELETE /api/clients/id/:clientId
 */
async function deleteClient(req, res) {
  try {
    const { ownerUserId } = requireAuthOwner(req);
    const clientId = safeParseInt(req.params.clientId);
    if (!clientId) return res.status(400).json({ success: false, error: 'clientId غير صالح' });

    const result = await pool.query(
      `DELETE FROM business_clients WHERE client_id = $1 AND owner_user_id = $2 RETURNING client_id`,
      [clientId, ownerUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    res.json({ success: true, deleted: true, id: result.rows[0].client_id });
  } catch (error) {
    handleError(res, error, 'deleteClient error');
  }
}

/**
 * DELETE /api/clients/by-uuid/:clientUuid
 */
async function deleteClientByUuid(req, res) {
  try {
    const { ownerUserId } = requireAuthOwner(req);
    const clientUuid = req.params.clientUuid;

    if (!isValidUUID(clientUuid)) {
      return res.status(400).json({ success: false, error: 'clientUuid غير صالح' });
    }

    const result = await pool.query(
      `DELETE FROM business_clients WHERE client_uuid = $1 AND owner_user_id = $2 RETURNING client_uuid`,
      [clientUuid, ownerUserId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'العميل غير موجود' });
    }

    res.json({ success: true, deleted: true, clientUuid: result.rows[0].client_uuid });
  } catch (error) {
    handleError(res, error, 'deleteClientByUuid error');
  }
}

/**
 * PUT /api/clients/sync
 *
 * التغيير المهم:
 * - ownerUserId/ownerFirebaseUid يتم أخذهما من التوكن فقط لتجنّب FK violations
 * - رفض أي owner في body لا يطابق التوكن
 */
async function syncClient(req, res) {
  const db = await pool.connect();
  try {
    const { ownerUserId, ownerFirebaseUid } = assertOwnerMatchesToken(
      req,
      req.body?.ownerUserId,
      req.body?.ownerFirebaseUid
    );

    const payload = req.body || {};
    const clients = Array.isArray(payload.clients) ? payload.clients : [payload];

    if (!clients.length) {
      return res.status(400).json({ success: false, error: 'clients فارغة' });
    }

    const synced = [];
    const errors = [];

    await db.query('BEGIN');

    for (const c of clients) {
      try {
        const clientUuid = (c.clientUuid && isValidUUID(c.clientUuid)) ? c.clientUuid : uuidv4();

        const name = (c.name || '').trim();
        if (!name) throw new Error('name مطلوب');

        const phone = normalizePhoneNumber(c.phone || '');
        const address = (c.address || '').trim() || null;
        const notes = (c.notes || '').trim() || null;

        const firestoreId = c.firestoreId || null;
        const isSupplier = !!c.isSupplier;
        const isCustomer = c.isCustomer === undefined ? true : !!c.isCustomer;

        const openingBalance = Number(c.openingBalance || 0) || 0;
        const currency = (c.currency || 'YER').trim();

        // حل تعارض بسيط: إن كان payload.syncVersion أقل من الموجود، نرجع الموجود ولا نكتب
        const existing = await db.query(
          `SELECT client_id, sync_version FROM business_clients WHERE client_uuid = $1 AND owner_user_id = $2`,
          [clientUuid, ownerUserId]
        );

        if (existing.rows.length > 0) {
          const dbSyncVersion = existing.rows[0].sync_version || 1;
          const incomingVersion = safeParseInt(c.syncVersion) || 1;

          if (incomingVersion < dbSyncVersion) {
            const remote = await db.query(
              `SELECT * FROM business_clients WHERE client_uuid = $1 AND owner_user_id = $2`,
              [clientUuid, ownerUserId]
            );
            synced.push(mapClientToAPI(remote.rows[0]));
            continue;
          }

          const updated = await db.query(
            `
            UPDATE business_clients
            SET
              firestore_id = COALESCE($1, firestore_id),
              name = $2,
              phone = COALESCE($3, phone),
              address = $4,
              notes = $5,
              is_supplier = $6,
              is_customer = $7,
              opening_balance = $8,
              currency = $9,
              sync_version = GREATEST(sync_version + 1, $10),
              updated_at = NOW()
            WHERE client_uuid = $11 AND owner_user_id = $12
            RETURNING *
            `,
            [
              firestoreId,
              name,
              phone || null,
              address,
              notes,
              isSupplier,
              isCustomer,
              openingBalance,
              currency,
              incomingVersion,
              clientUuid,
              ownerUserId
            ]
          );

          synced.push(mapClientToAPI(updated.rows[0]));
        } else {
          // إدراج جديد: owner_user_id من التوكن (هذا هو سبب إصلاح FK)
          const inserted = await db.query(
            `
            INSERT INTO business_clients (
              client_uuid, firestore_id, owner_user_id, owner_firebase_uid,
              name, phone, address, notes,
              is_supplier, is_customer,
              opening_balance, currency,
              is_archived, sync_version
            ) VALUES (
              $1,$2,$3,$4,
              $5,$6,$7,$8,
              $9,$10,
              $11,$12,
              false, COALESCE($13, 1)
            )
            RETURNING *
            `,
            [
              clientUuid, firestoreId, ownerUserId, ownerFirebaseUid,
              name, phone || null, address, notes,
              isSupplier, isCustomer,
              openingBalance, currency,
              safeParseInt(c.syncVersion)
            ]
          );

          synced.push(mapClientToAPI(inserted.rows[0]));
        }
      } catch (e) {
        errors.push({ clientUuid: c?.clientUuid || null, error: e.message || String(e) });
      }
    }

    await db.query('COMMIT');

    if (synced.length === 0 && errors.length > 0) {
      return res.status(400).json({ success: false, error: 'sync failed', errors });
    }

    res.json({ success: true, data: synced, errors });
  } catch (error) {
    try { await db.query('ROLLBACK'); } catch (_) {}
    logger.error('syncClient error', { error: error.message, stack: error.stack });
    handleError(res, error, 'syncClient error');
  } finally {
    db.release();
  }
}

module.exports = {
  getClients,
  getClientById,
  getClientByUuid,
  getClientsByPhone,
  createClient,
  updateClient,
  deleteClient,
  deleteClientByUuid,
  syncClient
};
