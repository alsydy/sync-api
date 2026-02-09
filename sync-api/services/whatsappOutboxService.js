// ============================================================================
// WhatsApp Outbox Service
// ============================================================================
// Creates outbox entries for WhatsApp notifications (Supabase PostgreSQL)
// ============================================================================

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

// Your DB schema (as provided) for whatsapp_outbox includes:
// id (uuid) PK
// user_id (bigint)
// client_id (bigint nullable)
// transaction_uuid (uuid)
// transaction_id (bigint nullable)
// to_phone (varchar) NOT NULL
// message_text (text) NOT NULL
// status (varchar) NOT NULL default 'pending'
// tries (int) NOT NULL default 0
// max_tries (int) NOT NULL default 5
// next_retry_at (timestamptz) NOT NULL default now()
// next_attempt_at (timestamptz) nullable
// ... + locking/sent fields

async function isUserWhatsappEnabled(userId) {
  try {
    const r = await pool.query(
      'SELECT enable_whatsapp FROM whatsapp_user_settings WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (r.rows.length === 0) return false;
    return r.rows[0]?.enable_whatsapp === true;
  } catch (e) {
    logger.warning('WhatsApp settings lookup failed (schema may differ)', { userId, error: e?.message });
    return false;
  }
}

async function isClientOptedOut(userId, clientId) {
  try {
    // Some schemas may have opted_out, some may not.
    try {
      const r = await pool.query(
        'SELECT opted_out FROM whatsapp_client_opt_out WHERE user_id = $1 AND client_id = $2 LIMIT 1',
        [userId, clientId]
      );
      if (r.rows.length === 0) return false;
      return r.rows[0]?.opted_out === true;
    } catch (_) {
      // If column doesn't exist: treat ANY row as opted-out.
      const r2 = await pool.query(
        'SELECT 1 FROM whatsapp_client_opt_out WHERE user_id = $1 AND client_id = $2 LIMIT 1',
        [userId, clientId]
      );
      return r2.rows.length > 0;
    }
  } catch (e) {
    logger.warning('WhatsApp client opt-out lookup failed (schema may differ)', { userId, clientId, error: e?.message });
    return false;
  }
}

function formatDate(d) {
  try {
    const date = d instanceof Date ? d : new Date(d);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  } catch (_) {
    return 'غير محدد';
  }
}

function buildMessage({ customerName, amount, currency, direction, note, dateStr }) {
  const dir = String(direction || '').toLowerCase();
  const typeLabel =
    dir === 'income' || dir === 'credit' ? '📈 القيد لكم' :
    dir === 'expense' || dir === 'debit' ? '📉 القيد عليكم' :
    '🏦 القيد المالي';

  const safeName = customerName || 'العميل';
  const safeAmount = amount != null ? amount : 0;
  const safeCurrency = currency || 'IQD';
  const safeNote = (note && String(note).trim()) ? String(note).trim() : '-';
  const safeDate = dateStr || 'غير محدد';

  return (
`👋 مرحبًا ${safeName}،

📣 تم تسجيل قيد جديد باسمك:

────────────────
${typeLabel}
💰 المبلغ: ${safeAmount} ${safeCurrency}
📅 التاريخ: ${safeDate}
📋 ملاحظة: ${safeNote}
────────────────

⚖️ شكراً لإدارة حساباتكم بدقة واحترافية.`
  );
}

async function ensureTransactionStatusRow(transaction) {
  try {
    const uuid = transaction.transaction_uuid;
    if (!uuid) return;
    await pool.query(
      `
      INSERT INTO whatsapp_transaction_status (
        transaction_uuid,
        transaction_id,
        whatsapp_sent,
        created_at,
        updated_at
      ) VALUES ($1, $2, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (transaction_uuid) DO NOTHING
      `,
      [uuid, transaction.transaction_id || null]
    );
  } catch (e) {
    logger.warning('Failed to insert whatsapp_transaction_status (schema may differ)', {
      transactionUuid: transaction.transaction_uuid,
      error: e?.message
    });
  }
}

async function enqueueWhatsAppOutboxForTransaction(transaction) {
  const tUuid = transaction?.transaction_uuid;
  const tId = transaction?.transaction_id;
  const ownerUserId = transaction?.owner_user_id;
  const clientId = transaction?.client_id;

  if (!tUuid || !ownerUserId || !clientId) return { enqueued: false, reason: 'missing-fields' };

  // احترام notify_customer (قرار التطبيق)
  if (transaction.notify_customer !== true) {
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'notify_customer_disabled' };
  }

  const enabled = await isUserWhatsappEnabled(ownerUserId);
  if (!enabled) {
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'user_disabled' };
  }

  const optedOut = await isClientOptedOut(ownerUserId, clientId);
  if (optedOut) {
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'client_opted_out' };
  }

  // Idempotency: avoid duplicate outbox for same transaction_uuid
  try {
    const exists = await pool.query(
      'SELECT 1 FROM whatsapp_outbox WHERE transaction_uuid = $1 LIMIT 1',
      [tUuid]
    );
    if (exists.rows.length > 0) {
      await ensureTransactionStatusRow(transaction);
      return { enqueued: false, reason: 'already_exists' };
    }
  } catch (_) {
    // if schema differs, we'll attempt insert and rely on DB constraints/indexes
  }

  // ✅ Always send to CLIENT phone from business_clients, never owner phone.
  let customerName = null;
  let clientPhone = null;

  try {
    const c = await pool.query(
      'SELECT client_name, phone_number FROM business_clients WHERE client_id = $1 LIMIT 1',
      [clientId]
    );
    customerName = c.rows?.[0]?.client_name || null;
    clientPhone = c.rows?.[0]?.phone_number || null;
  } catch (e) {
    logger.warning('Failed reading business_clients for WhatsApp', { clientId, error: e?.message });
  }

  if (!clientPhone) {
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'missing_client_phone' };
  }

  const msg = buildMessage({
    customerName,
    amount: transaction.transaction_amount,
    currency: transaction.currency_code,
    direction: transaction.transaction_direction,
    note: transaction.transaction_note,
    dateStr: formatDate(transaction.transaction_date || transaction.created_at || Date.now())
  });

  const outboxId = uuidv4();
  const maxTries = Number(process.env.MAX_ATTEMPTS || process.env.MAX_TRIES || 5);

  try {
    await pool.query(
      `
      INSERT INTO whatsapp_outbox (
        id,
        user_id,
        client_id,
        transaction_uuid,
        transaction_id,
        to_phone,
        message_text,
        status,
        tries,
        max_tries,
        next_retry_at,
        next_attempt_at,
        created_at,
        updated_at
      ) VALUES (
        $1::uuid,
        $2,
        $3,
        $4::uuid,
        $5,
        $6,
        $7,
        'pending',
        0,
        $8,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      `,
      [outboxId, ownerUserId, clientId, tUuid, tId || null, clientPhone, msg, maxTries]
    );
  } catch (e) {
    logger.warning('Failed to insert whatsapp_outbox', {
      outboxId,
      transactionUuid: tUuid,
      error: e?.message
    });
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'insert_failed' };
  }

  await ensureTransactionStatusRow(transaction);
  return { enqueued: true, outboxId };
}

module.exports = {
  enqueueWhatsAppOutboxForTransaction
};
