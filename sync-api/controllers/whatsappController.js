// ============================================================================
// WhatsApp Controller
// ============================================================================
// APIs لإدارة إعدادات/جلسات WhatsApp (Outbox + Private Sessions)
// ============================================================================

const crypto = require('crypto');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function requireInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    const err = new Error(`${name} must be a positive integer`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') {
    const err = new Error(`${name} must be boolean`);
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function resolveUserId(req, providedUserId, name) {
  const authUserId = req.user?.userId;
  if (authUserId != null) {
    if (providedUserId != null) {
      const n = Number(providedUserId);
      if (!Number.isInteger(n) || n <= 0) {
        const err = new Error(`${name} must be a positive integer`);
        err.statusCode = 400;
        throw err;
      }
      if (n !== authUserId) {
        const err = new Error('user_id does not match auth token');
        err.statusCode = 403;
        throw err;
      }
    }
    return authUserId;
  }
  return requireInt(providedUserId, name);
}

// ----------------------------------------------------------------------------
// Settings
// ----------------------------------------------------------------------------

/**
 * GET /api/whatsapp/settings/:userId
 */
async function getWhatsappSettings(req, res, next) {
  try {
    const userId = resolveUserId(req, req.params.userId, 'userId');

    const r = await pool.query(
      'SELECT * FROM whatsapp_user_settings WHERE user_id = $1 LIMIT 1',
      [userId]
    );

    if (r.rows.length === 0) {
      return res.json({
        success: true,
        data: { userId, enableWhatsapp: false, usePrivateSession: false }
      });
    }

    const row = r.rows[0];
    res.json({
      success: true,
      data: {
        userId,
        enableWhatsapp: row.enable_whatsapp === true,
        usePrivateSession: row.use_private_session === true
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/whatsapp/settings
 * Body: { user_id, enable_whatsapp, use_private_session }
 */
async function upsertWhatsappSettings(req, res, next) {
  try {
    const body = req.body || {};
    const userId = resolveUserId(req, body.user_id, 'user_id');
    const enableWhatsapp = requireBoolean(body.enable_whatsapp, 'enable_whatsapp');
    const usePrivateSession = requireBoolean(body.use_private_session, 'use_private_session');

    await pool.query(
      `
      INSERT INTO whatsapp_user_settings (user_id, enable_whatsapp, use_private_session, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id)
      DO UPDATE SET
        enable_whatsapp = EXCLUDED.enable_whatsapp,
        use_private_session = EXCLUDED.use_private_session,
        updated_at = CURRENT_TIMESTAMP
      `,
      [userId, enableWhatsapp, usePrivateSession]
    );

    res.json({ success: true, data: { userId, enableWhatsapp, usePrivateSession } });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/whatsapp/client-opt-out
 * Body: { user_id, client_id, opted_out }
 */
async function setClientOptOut(req, res, next) {
  try {
    const body = req.body || {};
    const userId = resolveUserId(req, body.user_id, 'user_id');
    const clientId = requireInt(body.client_id, 'client_id');
    const optedOut = requireBoolean(body.opted_out, 'opted_out');

    // تصميم متسامح: إن كان opted_out = false نحذف السجل إن كان موجوداً
    if (!optedOut) {
      await pool.query(
        'DELETE FROM whatsapp_client_opt_out WHERE user_id = $1 AND client_id = $2',
        [userId, clientId]
      );
      return res.json({ success: true, data: { userId, clientId, optedOut: false } });
    }

    // ✅ Schema-compatible:
    // - Some DBs have (user_id, client_id) unique + opted_out boolean
    // - Your DB snapshot shows table with columns: id, user_id, client_id, created_at (no opted_out)
    // In that case, simply inserting the row means "opted out".
    try {
      await pool.query(
        `
        INSERT INTO whatsapp_client_opt_out (user_id, client_id, opted_out, created_at, updated_at)
        VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, client_id)
        DO UPDATE SET opted_out = TRUE, updated_at = CURRENT_TIMESTAMP
        `,
        [userId, clientId]
      );
    } catch (e1) {
      // fallback: insert without opted_out/upsert
      try {
        await pool.query(
          `
          INSERT INTO whatsapp_client_opt_out (user_id, client_id, created_at)
          VALUES ($1, $2, CURRENT_TIMESTAMP)
          `,
          [userId, clientId]
        );
      } catch (e2) {
        // if duplicate key exists on (user_id, client_id) just treat as success
      }
    }

    res.json({ success: true, data: { userId, clientId, optedOut: true } });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/whatsapp/client-opt-out/:userId
 * Returns list of opted-out clientIds for user
 */
async function getClientOptOuts(req, res, next) {
  try {
    const userId = resolveUserId(req, req.params.userId, 'userId');
    // Schema in your DB has no opted_out/is_opted_out; presence of a row means opted-out.
    const r = await pool.query(
      'SELECT client_id FROM whatsapp_client_opt_out WHERE user_id = $1',
      [userId]
    );
    const ids = (r.rows || [])
      .map((x) => Number(x.client_id))
      .filter((x) => Number.isFinite(x));
    res.json({ success: true, data: ids });
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------------
// Private Session Requests
// ----------------------------------------------------------------------------

/**
 * POST /api/whatsapp/session-request
 * Body: { user_id }
 *
 * Generates a temporary one-time token (10 minutes) and stores a request row.
 * Response: { session_url }
 */
async function createPrivateSessionRequest(req, res, next) {
  try {
    const body = req.body || {};
    const userId = resolveUserId(req, body.user_id, 'user_id');

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const sessionId = `user_${userId}`; // DB: session_id NOT NULL
    // ✅ IMPORTANT: في DB لديك request_id قد يكون BIGINT (Auto Increment)
    // لذلك لا نمرّر UUID. ندع DB يولد request_id ثم نعيده إن لزم.
    let insertedRequestId = null;
    try {
      const ins = await pool.query(
        `
        INSERT INTO whatsapp_session_requests (
          user_id,
          session_id,
          token,
          token_hash,
          status,
          expires_at,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, 'pending', $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING request_id
        `,
        [userId, sessionId, token, tokenHash, expiresAt]
      );
      insertedRequestId = ins.rows?.[0]?.request_id ?? null;
    } catch (e) {
      // fallback: بعض المخططات قد تكون request_id نصي (نادر) — حاول بالـUUID فقط إذا فشل الإدراج بدون request_id
      const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      const ins2 = await pool.query(
        `
        INSERT INTO whatsapp_session_requests (
          request_id,
          user_id,
          session_id,
          token,
          token_hash,
          status,
          expires_at,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        RETURNING request_id
        `,
        [requestId, userId, sessionId, token, tokenHash, expiresAt]
      );
      insertedRequestId = ins2.rows?.[0]?.request_id ?? null;
    }

    const baseRaw = (process.env.WHATSAPP_API_BASE_URL || '').trim();
    const base = baseRaw.replace(/\/+$/, '');
    if (!base) {
      // لا نرجّع رابط خاطئ. هذا يؤدي لضياع وقت على العميل.
      logger.errorMsg('WHATSAPP_API_BASE_URL is not configured', { userId, requestId: insertedRequestId });
      return res.status(500).json({
        success: false,
        error: 'WHATSAPP_API_BASE_URL is not configured on sync-api'
      });
    }
    const sessionUrl = `${base}/session/${token}`;

    logger.info('WhatsApp private session request created', {
      userId,
      requestId: insertedRequestId,
      sessionId,
      expiresAt: expiresAt.toISOString()
    });

    res.json({ success: true, data: { session_url: sessionUrl, request_id: insertedRequestId } });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/whatsapp/session-cancel
 * Body: { user_id }
 */
async function cancelPrivateSession(req, res, next) {
  try {
    const body = req.body || {};
    const userId = resolveUserId(req, body.user_id, 'user_id');

    // Cancel the latest non-ready request
    try {
      await pool.query(
        `
        UPDATE whatsapp_session_requests
        SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
        WHERE request_id = (
          SELECT request_id
          FROM whatsapp_session_requests
          WHERE user_id = $1
            AND status IN ('pending', 'in_progress')
          ORDER BY created_at DESC
          LIMIT 1
        )
        `,
        [userId]
      );
    } catch (e) {
      logger.warning('Failed to cancel session request (schema may differ)', { userId, error: e?.message });
    }

    // Also disable private-session preference to avoid selecting missing session
    try {
      await pool.query(
        `
        UPDATE whatsapp_user_settings
        SET use_private_session = FALSE, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        `,
        [userId]
      );
    } catch (e) {
      logger.warning('Failed to update whatsapp_user_settings during cancel', { userId, error: e?.message });
    }

    res.json({ success: true, data: { userId, cancelled: true } });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getWhatsappSettings,
  upsertWhatsappSettings,
  setClientOptOut,
  getClientOptOuts,
  createPrivateSessionRequest,
  cancelPrivateSession
};
