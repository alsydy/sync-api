// ============================================================================
// Client Controller
// ============================================================================
// تحكم كامل بالعملاء (CRUD + Sync)
// ============================================================================

const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { successResponse, errorResponse } = require('../utils/response');
const { sanitizeText, normalizePhone } = require('../utils/sanitize');
const { normalizeOwnerUserId } = require('../utils/owner');

// ============================================================================
// Helpers
// ============================================================================

function parseSinceTimestamp(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function nowMs() {
  return Date.now();
}

function asInt(val, def = null) {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.trunc(n);
}

function boolVal(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  return false;
}

// ============================================================================
// GET /api/clients
// ============================================================================

exports.getClients = async (req, res) => {
  try {
    const ownerFirebaseUid = (req.query.ownerFirebaseUid || req.user?.firebaseUid || '').trim();
    if (!ownerFirebaseUid) {
      return res.status(400).json(errorResponse('ownerFirebaseUid مطلوب'));
    }

    const sinceTimestamp = parseSinceTimestamp(req.query.sinceTimestamp);

    const result = await pool.query(
      `
      SELECT
        id,
        client_uuid,
        firestore_id,
        owner_user_id,
        owner_firebase_uid,
        name,
        phone,
        address,
        note,
        is_deleted,
        created_at,
        updated_at,
        deleted_at,
        device_id,
        version,
        last_modified_at
      FROM business_clients
      WHERE owner_firebase_uid = $1
        AND last_modified_at >= $2
      ORDER BY last_modified_at ASC
      LIMIT 500
      `,
      [ownerFirebaseUid, sinceTimestamp]
    );

    return res.json(successResponse(result.rows));
  } catch (err) {
    logger.error('getClients error', { error: err.message, stack: err.stack });
    return res.status(500).json(errorResponse('خطأ في جلب العملاء'));
  }
};

// ============================================================================
// GET /api/clients/:clientId
// ============================================================================

exports.getClientById = async (req, res) => {
  try {
    const clientIdRaw = (req.params.clientId || '').trim();

    // ✅ حماية إضافية ضد المسارات الخاصة (حتى لو تغيّر ترتيب routes لاحقاً)
    const reservedWords = ['sync', 'health', 'info', 'stats', 'by-uuid', 'by-phone'];
    if (!clientIdRaw || reservedWords.includes(clientIdRaw)) {
      return res.status(400).json(errorResponse('clientId غير صالح'));
    }

    const clientId = asInt(clientIdRaw, null);
    if (!clientId) {
      return res.status(400).json(errorResponse('clientId غير صالح'));
    }

    const ownerFirebaseUid = (req.query.ownerFirebaseUid || req.user?.firebaseUid || '').trim();
    if (!ownerFirebaseUid) {
      return res.status(400).json(errorResponse('ownerFirebaseUid مطلوب'));
    }

    const result = await pool.query(
      `
      SELECT
        id,
        client_uuid,
        firestore_id,
        owner_user_id,
        owner_firebase_uid,
        name,
        phone,
        address,
        note,
        is_deleted,
        created_at,
        updated_at,
        deleted_at,
        device_id,
        version,
        last_modified_at
      FROM business_clients
      WHERE id = $1
        AND owner_firebase_uid = $2
      LIMIT 1
      `,
      [clientId, ownerFirebaseUid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(errorResponse('العميل غير موجود'));
    }

    return res.json(successResponse(result.rows[0]));
  } catch (err) {
    logger.error('getClientById error', { error: err.message, stack: err.stack });
    return res.status(500).json(errorResponse('خطأ في جلب العميل'));
  }
};

// ============================================================================
// POST /api/clients
// ============================================================================

exports.createClient = async (req, res) => {
  try {
    const ownerFirebaseUid = (req.body.ownerFirebaseUid || req.user?.firebaseUid || '').trim();
    if (!ownerFirebaseUid) return res.status(400).json(errorResponse('ownerFirebaseUid مطلوب'));

    const ownerUserId = await normalizeOwnerUserId({ pool, ownerFirebaseUid, reqUser: req.user });
    if (!ownerUserId) return res.status(400).json(errorResponse('تعذر تحديد ownerUserId للمستخدم'));

    const name = sanitizeText(req.body.name || '');
    const phone = normalizePhone(req.body.phone || '');
    const address = sanitizeText(req.body.address || '');
    const note = sanitizeText(req.body.note || '');

    if (!name) return res.status(400).json(errorResponse('اسم العميل مطلوب'));

    const clientUuid = (req.body.clientUuid || req.body.client_uuid || '').trim() || null;
    const firestoreId = (req.body.firestoreId || req.body.firestore_id || '').trim() || null;

    const deviceId = (req.body.deviceId || '').trim() || null;
    const version = asInt(req.body.version, 1) || 1;

    const now = nowMs();

    const result = await pool.query(
      `
      INSERT INTO business_clients
      (client_uuid, firestore_id, owner_user_id, owner_firebase_uid, name, phone, address, note,
       is_deleted, created_at, updated_at, deleted_at, device_id, version, last_modified_at)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,false,$9,$9,NULL,$10,$11,$12)
      RETURNING *
      `,
      [clientUuid, firestoreId, ownerUserId, ownerFirebaseUid, name, phone, address, note, now, deviceId, version, now]
    );

    return res.json(successResponse(result.rows[0]));
  } catch (err) {
    logger.error('createClient error', { error: err.message, stack: err.stack });
    return res.status(500).json(errorResponse('خطأ في إنشاء العميل'));
  }
};

// ============================================================================
// DELETE /api/clients/by-uuid/:clientUuid   (Soft delete)
// ============================================================================

exports.deleteClientByUuid = async (req, res) => {
  try {
    const ownerFirebaseUid = (req.query.ownerFirebaseUid || req.user?.firebaseUid || '').trim();
    if (!ownerFirebaseUid) return res.status(400).json(errorResponse('ownerFirebaseUid مطلوب'));

    const clientUuid = (req.params.clientUuid || '').trim();
    if (!clientUuid) return res.status(400).json(errorResponse('clientUuid مطلوب'));

    const now = nowMs();

    const result = await pool.query(
      `
      UPDATE business_clients
      SET is_deleted = true,
          deleted_at = $1,
          updated_at = $1,
          last_modified_at = $1,
          version = COALESCE(version, 0) + 1
      WHERE client_uuid = $2
        AND owner_firebase_uid = $3
      RETURNING *
      `,
      [now, clientUuid, ownerFirebaseUid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json(errorResponse('العميل غير موجود'));
    }

    return res.json(successResponse(result.rows[0]));
  } catch (err) {
    logger.error('deleteClientByUuid error', { error: err.message, stack: err.stack });
    return res.status(500).json(errorResponse('خطأ في حذف العميل'));
  }
};

// ============================================================================
// GET /api/clients/by-phone/:phoneNumber
// ============================================================================

exports.getClientsByPhone = async (req, res) => {
  try {
    const ownerFirebaseUid = (req.query.ownerFirebaseUid || req.user?.firebaseUid || '').trim();
    if (!ownerFirebaseUid) return res.status(400).json(errorResponse('ownerFirebaseUid مطلوب'));

    const phoneNumber = normalizePhone(req.params.phoneNumber || '');
    if (!phoneNumber) return res.status(400).json(errorResponse('phoneNumber مطلوب'));

    const result = await pool.query(
      `
      SELECT *
      FROM business_clients
      WHERE owner_firebase_uid = $1
        AND phone = $2
        AND is_deleted = false
      ORDER BY updated_at DESC
      LIMIT 50
      `,
      [ownerFirebaseUid, phoneNumber]
    );

    return res.json(successResponse(result.rows));
  } catch (err) {
    logger.error('getClientsByPhone error', { error: err.message, stack: err.stack });
    return res.status(500).json(errorResponse('خطأ في البحث عن العملاء'));
  }
};

// ============================================================================
// PUT /api/clients/sync
// ============================================================================

exports.syncClient = async (req, res) => {
  try {
    const ownerFirebaseUid = (req.body.ownerFirebaseUid || req.user?.firebaseUid || '').trim();
    if (!ownerFirebaseUid) return res.status(400).json(errorResponse('ownerFirebaseUid مطلوب'));

    const ownerUserId = await normalizeOwnerUserId({ pool, ownerFirebaseUid, reqUser: req.user });
    if (!ownerUserId) {
      // ✅ بدل FK crash
      return res.status(400).json(errorResponse('تعذر تحديد ownerUserId للمستخدم - تأكد أن المستخدم مسجل في app_users'));
    }

    const clientUuid = (req.body.clientUuid || req.body.client_uuid || '').trim();
    if (!clientUuid) return res.status(400).json(errorResponse('clientUuid مطلوب للمزامنة'));

    const name = sanitizeText(req.body.name || '');
    const phone = normalizePhone(req.body.phone || '');
    const address = sanitizeText(req.body.address || '');
    const note = sanitizeText(req.body.note || '');

    const firestoreId = (req.body.firestoreId || req.body.firestore_id || '').trim() || null;
    const deviceId = (req.body.deviceId || '').trim() || null;

    const isDeleted = boolVal(req.body.isDeleted ?? req.body.is_deleted ?? false);
    const deletedAt = isDeleted ? (asInt(req.body.deletedAt, nowMs()) || nowMs()) : null;

    const clientVersion = asInt(req.body.version, 1) || 1;
    const lastModifiedAt = asInt(req.body.lastModifiedAt, nowMs()) || nowMs();

    // تحقق إن موجود
    const existing = await pool.query(
      `
      SELECT id, version, last_modified_at
      FROM business_clients
      WHERE client_uuid = $1
        AND owner_firebase_uid = $2
      LIMIT 1
      `,
      [clientUuid, ownerFirebaseUid]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];

      // تعارض: لو عندنا أحدث في السيرفر
      if (Number(row.last_modified_at) > lastModifiedAt) {
        const latest = await pool.query(
          `SELECT * FROM business_clients WHERE id = $1 LIMIT 1`,
          [row.id]
        );
        return res.json(successResponse(latest.rows[0], { conflict: true, reason: 'server_newer' }));
      }

      const updated = await pool.query(
        `
        UPDATE business_clients
        SET firestore_id = COALESCE($1, firestore_id),
            owner_user_id = $2,
            name = $3,
            phone = $4,
            address = $5,
            note = $6,
            is_deleted = $7,
            deleted_at = $8,
            device_id = COALESCE($9, device_id),
            version = $10,
            last_modified_at = $11,
            updated_at = $11
        WHERE id = $12
        RETURNING *
        `,
        [firestoreId, ownerUserId, name, phone, address, note, isDeleted, deletedAt, deviceId, clientVersion, lastModifiedAt, row.id]
      );

      return res.json(successResponse(updated.rows[0]));
    }

    // Insert جديد
    const inserted = await pool.query(
      `
      INSERT INTO business_clients
      (client_uuid, firestore_id, owner_user_id, owner_firebase_uid, name, phone, address, note,
       is_deleted, deleted_at, device_id, version, last_modified_at, created_at, updated_at)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13)
      RETURNING *
      `,
      [clientUuid, firestoreId, ownerUserId, ownerFirebaseUid, name, phone, address, note, isDeleted, deletedAt, deviceId, clientVersion, lastModifiedAt]
    );

    return res.json(successResponse(inserted.rows[0]));
  } catch (err) {
    logger.error('syncClient error', { error: err.message, stack: err.stack });
    // 23503 FK
    if (err.code === '23503') {
      return res.status(400).json(errorResponse('ownerUserId غير موجود في app_users (FK) - سجل المستخدم أولاً'));
    }
    return res.status(500).json(errorResponse('خطأ في مزامنة العميل'));
  }
};
