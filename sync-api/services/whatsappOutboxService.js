// ============================================================================
// WhatsApp Outbox Service
// ============================================================================
// Creates outbox entries for WhatsApp notifications (Supabase PostgreSQL)
// ============================================================================

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

// Note: current DB schema uses columns:
// id (uuid), to_phone, tries, max_tries, next_retry_at, next_attempt_at (nullable)

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
    // Your schema may not have opted_out; treat any row as opted-out.
    try {
      const r = await pool.query(
        'SELECT opted_out FROM whatsapp_client_opt_out WHERE user_id = $1 AND client_id = $2 LIMIT 1',
        [userId, clientId]
      );
      if (r.rows.length === 0) return false;
      return r.rows[0]?.opted_out === true;
    } catch (e) {
      const r2 = await pool.query(
        'SELECT 1 FROM whatsapp_client_opt_out WHERE user_id = $1 AND client_id = $2 LIMIT 1',
        [userId, clientId]
      );
      return r2.rows.length > 0;
    }
  } catch (e) {
    // إذا لم يوجد الجدول/الأعمدة لا نمنع الإرسال (آمن/متسامح)
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

function formatAmount(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val ?? '');
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function formatBalancesLines(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return ['-'];
  return balances.map((b) => `${b.currency}: ${formatAmount(b.balance)}`);
}

function buildMessage({ customerName, amount, currency, direction, note, dateStr, balances, senderName }) {
  const dir = String(direction || '').toLowerCase();
  const typeLabel =
    dir === 'income' || dir === 'credit' ? '📈 القيد لكم' :
    dir === 'expense' || dir === 'debit' ? '📉 القيد عليكم' :
    '📊 القيد';

  const safeName = customerName || 'عميلنا';
  const safeAmount = formatAmount(amount != null ? amount : 0);
  const safeCurrency = currency || 'IQD';
  const safeNote = (note && String(note).trim()) ? String(note).trim() : '-';
  const safeDate = dateStr || 'غير محدد';
  const safeSender = senderName || '-';
  const balanceLines = formatBalancesLines(balances).join('\n');

  return (
`👋 مرحبًا ${safeName}،

📣 تم تسجيل قيد جديد باسمك:

────────────────
${typeLabel}
💰 المبلغ: ${safeAmount} ${safeCurrency}
📅 التاريخ: ${safeDate}
📋 ملاحظة: ${safeNote}
────────────────
💹 إجمالي الرصيد لكل عملة:
${balanceLines}
────────────────
⚖️ شكراً لإدارة حساباتكم بدقة واحترافية.
📝 تم الإرسال بواسطة:${safeSender}`
  );
}

async function getOwnerName(userId) {
  try {
    const r = await pool.query(
      'SELECT full_name FROM app_users WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1',
      [userId]
    );
    return r.rows?.[0]?.full_name || null;
  } catch (e) {
    logger.warning('Owner name lookup failed', { userId, error: e?.message });
    return null;
  }
}

async function getClientBalances(ownerUserId, clientId) {
  try {
    const r = await pool.query(
      `
      SELECT
        currency_code,
        SUM(
          CASE
            WHEN transaction_direction IN ('expense','debit','DEBIT') THEN -transaction_amount
            ELSE transaction_amount
          END
        ) AS balance
      FROM financial_transactions
      WHERE owner_user_id = $1
        AND client_id = $2
        AND deleted_at IS NULL
      GROUP BY currency_code
      ORDER BY currency_code
      `,
      [ownerUserId, clientId]
    );
    return r.rows.map((row) => ({
      currency: row.currency_code,
      balance: row.balance
    }));
  } catch (e) {
    logger.warning('Client balances lookup failed', { ownerUserId, clientId, error: e?.message });
    return [];
  }
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

  // احترام notify_customer أيضاً لتجنب إرسال غير مقصود
  if (transaction.notify_customer !== true) {
    return { enqueued: false, reason: 'notify_customer_disabled' };
  }

  const enabled = await isUserWhatsappEnabled(ownerUserId);
  if (!enabled) return { enqueued: false, reason: 'user_disabled' };

  const optedOut = await isClientOptedOut(ownerUserId, clientId);
  if (optedOut) return { enqueued: false, reason: 'client_opted_out' };

  // Idempotency: avoid duplicate outbox for same transaction_uuid
  try {
    const exists = await pool.query(
      'SELECT 1 FROM whatsapp_outbox WHERE transaction_uuid = $1 LIMIT 1',
      [tUuid]
    );
    if (exists.rows.length > 0) {
      return { enqueued: false, reason: 'already_exists' };
    }
  } catch (e) {
    // إذا لم يدعم الجدول/العمود، نكمل بمحاولة insert (وسنلتقط الخطأ)
  }

  let customerName = null;
  let clientPhone = null;
  try {
    const c = await pool.query(
      'SELECT client_name, phone_number FROM business_clients WHERE client_id = $1 LIMIT 1',
      [clientId]
    );
    customerName = c.rows?.[0]?.client_name || null;
    clientPhone = c.rows?.[0]?.phone_number || null;
  } catch (_) {}

  // Enforce client phone source (no owner/user phone fallback).
  if (!clientPhone) {
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'missing_client_phone' };
  }

  const [ownerName, balances] = await Promise.all([
    getOwnerName(ownerUserId),
    getClientBalances(ownerUserId, clientId)
  ]);

  const msg = buildMessage({
    customerName,
    amount: transaction.transaction_amount,
    currency: transaction.currency_code,
    direction: transaction.transaction_direction,
    note: transaction.transaction_note,
    dateStr: formatDate(transaction.transaction_date || transaction.created_at || Date.now()),
    balances,
    senderName: ownerName
  });

  const outboxId = uuidv4();

  try {
    const maxTries = Number(process.env.MAX_ATTEMPTS || 5);
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
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      [outboxId, ownerUserId, clientId, tUuid, tId || null, clientPhone, msg, maxTries]
    );
  } catch (e) {
    logger.warning('Failed to insert whatsapp_outbox (schema may differ)', {
      outboxId,
      transactionUuid: tUuid,
      error: e?.message
    });
    // still ensure status row
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'insert_failed' };
  }

  await ensureTransactionStatusRow(transaction);
  return { enqueued: true, outboxId };
}

module.exports = {
  enqueueWhatsAppOutboxForTransaction
};
