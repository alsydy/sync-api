// ============================================================================
// Client Controller
// ============================================================================
// Controller للعملاء (Clients)
// ============================================================================

'use strict';

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const {
  requireBody,
  safeTrim,
  safeNumber,
  toIsoDate,
  toDbTimestamp,
  normalizeOwnerFirebaseUid,
  normalizeOwnerUserId,
  toDbBool,
  toDbInt,
  parseDeviceId,
  normalizePhone,
  validateUuid,
} = require('../utils/helpers');

/**
 * Resolve a valid owner_user_id that actually exists in app_users.
 * IMPORTANT: Prefer firebase_uid mapping when available, because the Android app may send a local ownerUserId (e.g. 1)
 * that does NOT match PostgreSQL app_users.id.
 */
async function resolveOwnerUserId(pool, { ownerUserId, ownerFirebaseUid }) {
  // 1) Prefer firebase_uid -> app_users.id
  if (ownerFirebaseUid) {
    const r = await pool.query(
      'SELECT id FROM app_users WHERE firebase_uid = $1 LIMIT 1',
      [ownerFirebaseUid]
    );
    if (r.rowCount > 0) return r.rows[0].id;
  }

  // 2) Fallback: validate ownerUserId exists (if provided)
  if (ownerUserId !== undefined && ownerUserId !== null && ownerUserId !== '') {
    const r = await pool.query(
      'SELECT id FROM app_users WHERE id = $1 LIMIT 1',
      [ownerUserId]
    );
    if (r.rowCount > 0) return r.rows[0].id;
  }

  return null;
}

/**
 * GET /api/clients
 * Query params:
 *  - ownerUserId (optional)
 *  - ownerFirebaseUid (optional)
 *  - sinceTimestamp (optional, ms)
 */
async function getClients(req, res) {
  try {
    const ownerUserId = req.query.ownerUserId ? Number(req.query.ownerUserId) : null;
    const ownerFirebaseUid = req.query.ownerFirebaseUid ? String(req.query.ownerFirebaseUid).trim() : null;
    const sinceTimestamp = req.query.sinceTimestamp ? Number(req.query.sinceTimestamp) : null;

    const where = [];
    const values = [];
    let i = 1;

    if (ownerUserId) {
      where.push(`owner_user_id = $${i++}`);
      values.push(ownerUserId);
    } else if (ownerFirebaseUid) {
      where.push(`owner_firebase_uid = $${i++}`);
      values.push(ownerFirebaseUid);
    }

    if (sinceTimestamp) {
      where.push(`updated_at >= to_timestamp($${i++} / 1000.0)`);
      values.push(sinceTimestamp);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT
        id,
        client_uuid,
        firestore_id,
        owner_user_id,
        owner_firebase_uid,
        full_name,
        phone,
        address,
        notes,
        is_active,
        created_at,
        updated_at,
        device_id,
        deleted_at
      FROM business_clients
      ${whereSql}
      ORDER BY updated_at DESC
      LIMIT 1000
    `;

    const result = await pool.query(sql, values);

    return res.json({
      success: true,
      data: result.rows || []
    });
  } catch (err) {
    logger.error('getClients error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'حدث خطأ أثناء جلب العملاء'
    });
  }
}

/**
 * PUT /api/clients/sync
 * Body:
 *  { items: [ ...clients ] }
 */
async function syncClients(req, res) {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'items مطلوب ويجب أن يكون مصفوفة'
      });
    }

    const results = {
      success: true,
      total: items.length,
      inserted: 0,
      updated: 0,
      deleted: 0,
      failed: 0,
      errors: []
    };

    for (const item of items) {
      try {
        const r = await syncClient(item);
        if (r === 'inserted') results.inserted++;
        else if (r === 'updated') results.updated++;
        else if (r === 'deleted') results.deleted++;
      } catch (e) {
        results.failed++;
        results.errors.push({
          clientUuid: item?.clientUuid || item?.client_uuid || null,
          message: e.message
        });
      }
    }

    if (results.failed > 0) {
      return res.status(400).json({
        success: false,
        message: 'فشل مزامنة بعض العملاء',
        results
      });
    }

    return res.json({
      success: true,
      results
    });
  } catch (err) {
    logger.error('syncClients error', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'حدث خطأ أثناء مزامنة العملاء'
    });
  }
}

/**
 * Upsert single client item
 */
async function syncClient(clientData) {
  const clientUuid = clientData.clientUuid || clientData.client_uuid || uuidv4();
  const firestoreId = clientData.firestoreId || clientData.firestore_id || null;

  const ownerFirebaseUid = normalizeOwnerFirebaseUid(
    clientData.ownerFirebaseUid || clientData.owner_firebase_uid
  );

  // ✅ FIX: Always resolve owner_user_id from app_users by firebase_uid when possible
  const ownerUserId = await resolveOwnerUserId(pool, {
    ownerUserId: clientData.ownerUserId || clientData.owner_user_id,
    ownerFirebaseUid
  });

  if (!ownerUserId) {
    const err = new Error(
      'ownerUserId/ownerFirebaseUid غير صالح. تأكد أن المستخدم (مالك البيانات) مسجل في PostgreSQL (app_users) وأنك ترسل ownerFirebaseUid الصحيح.'
    );
    err.statusCode = 400;
    throw err;
  }

  const fullName = safeTrim(clientData.fullName || clientData.full_name) || null;
  const phone = normalizePhone(clientData.phone) || null;
  const address = safeTrim(clientData.address) || null;
  const notes = safeTrim(clientData.notes) || null;
  const isActive = toDbBool(clientData.isActive ?? clientData.is_active ?? true);

  const deviceId = parseDeviceId(clientData.deviceId || clientData.device_id) || null;

  const createdAt = clientData.createdAt || clientData.created_at || Date.now();
  const updatedAt = clientData.updatedAt || clientData.updated_at || Date.now();

  const deletedAtVal = clientData.deletedAt || clientData.deleted_at || null;
  const deletedAt = deletedAtVal ? toDbTimestamp(deletedAtVal) : null;

  try {
    // Find existing
    const existing = await pool.query(
      `
      SELECT id, client_uuid, deleted_at
      FROM business_clients
      WHERE (client_uuid = $1)
        AND owner_user_id = $2
      LIMIT 1
      `,
      [clientUuid, ownerUserId]
    );

    if (existing.rowCount > 0) {
      // Update
      await pool.query(
        `
        UPDATE business_clients
        SET
          firestore_id = $1,
          owner_firebase_uid = $2,
          full_name = $3,
          phone = $4,
          address = $5,
          notes = $6,
          is_active = $7,
          updated_at = to_timestamp($8 / 1000.0),
          device_id = $9,
          deleted_at = $10
        WHERE client_uuid = $11 AND owner_user_id = $12
        `,
        [
          firestoreId,
          ownerFirebaseUid,
          fullName,
          phone,
          address,
          notes,
          isActive,
          updatedAt,
          deviceId,
          deletedAt,
          clientUuid,
          ownerUserId
        ]
      );

      return deletedAt ? 'deleted' : 'updated';
    }

    // Insert
    await pool.query(
      `
      INSERT INTO business_clients (
        client_uuid,
        firestore_id,
        owner_user_id,
        owner_firebase_uid,
        full_name,
        phone,
        address,
        notes,
        is_active,
        created_at,
        updated_at,
        device_id,
        deleted_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        to_timestamp($10 / 1000.0),
        to_timestamp($11 / 1000.0),
        $12, $13
      )
      `,
      [
        clientUuid,
        firestoreId,
        ownerUserId,
        ownerFirebaseUid,
        fullName,
        phone,
        address,
        notes,
        isActive,
        createdAt,
        updatedAt,
        deviceId,
        deletedAt
      ]
    );

    return deletedAt ? 'deleted' : 'inserted';
  } catch (err) {
    // Better error mapping for FK issues
    if (err && err.code === '23503') {
      const e = new Error(
        'فشل حفظ العميل بسبب مرجع غير موجود (Foreign Key). تأكد أن المستخدم مسجل في app_users وأن ownerFirebaseUid صحيح.'
      );
      e.statusCode = 400;
      throw e;
    }

    logger.error('syncClient error', { error: err.message, stack: err.stack });
    const e = new Error('حدث خطأ أثناء مزامنة العميل');
    e.statusCode = 500;
    throw e;
  }
}

module.exports = {
  getClients,
  syncClients
};

