// ============================================================================
// WhatsApp Outbox Service
// ============================================================================
// Creates outbox entries for WhatsApp notifications (Supabase PostgreSQL)
// ============================================================================

const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

// Note: schema may vary between legacy and new WhatsApp outbox tables.
// We detect columns at runtime and insert accordingly.

const OUTBOX_SCHEMA_TTL_MS = 60_000;
let outboxSchemaCache = null;
let outboxSchemaCacheAt = 0;

async function getOutboxSchema() {
  const now = Date.now();
  if (outboxSchemaCache && (now - outboxSchemaCacheAt) < OUTBOX_SCHEMA_TTL_MS) {
    return outboxSchemaCache;
  }
  try {
    const r = await pool.query(
      `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'whatsapp_outbox'
      `
    );
    const cols = new Set((r.rows || []).map((x) => String(x.column_name)));
    const has = (c) => cols.has(c);
    outboxSchemaCache = {
      hasOutboxId: has('outbox_id'),
      hasId: has('id'),
      phoneCol: has('phone_number') ? 'phone_number' : (has('to_phone') ? 'to_phone' : 'phone_number'),
      attemptsCol: has('attempts') ? 'attempts' : (has('tries') ? 'tries' : null),
      hasMaxTries: has('max_tries'),
      hasNextAttemptAt: has('next_attempt_at'),
      hasNextRetryAt: has('next_retry_at'),
      hasLockedAt: has('locked_at'),
      hasLockedBy: has('locked_by'),
      hasProcessingStartedAt: has('processing_started_at'),
      hasLastError: has('last_error')
    };
    outboxSchemaCacheAt = now;
    return outboxSchemaCache;
  } catch (e) {
    logger.warning('Failed to detect whatsapp_outbox schema', { error: e?.message });
    outboxSchemaCache = null;
    outboxSchemaCacheAt = now;
    return null;
  }
}

async function insertOutboxRow({
  ownerUserId,
  clientId,
  transactionUuid,
  transactionId,
  clientPhone,
  messageText
}) {
  const schema = await getOutboxSchema();
  if (!schema) throw new Error('outbox_schema_missing');

  const cols = [];
  const params = [];
  let idx = 1;
  const add = (col, val) => {
    cols.push(col);
    params.push(val);
    idx += 1;
  };

  const outboxId = uuidv4();
  if (schema.hasOutboxId) add('outbox_id', outboxId);
  else if (schema.hasId) add('id', outboxId);

  add('user_id', ownerUserId);
  add('client_id', clientId);
  add('transaction_uuid', transactionUuid);
  if (transactionId != null) add('transaction_id', transactionId);
  add(schema.phoneCol, clientPhone);
  add('message_text', messageText);
  add('status', 'pending');

  if (schema.attemptsCol) add(schema.attemptsCol, 0);
  if (schema.hasMaxTries) add('max_tries', Number(process.env.MAX_ATTEMPTS || 5));

  // Some schemas require explicit scheduling columns; set to now if present.
  if (schema.hasNextAttemptAt) add('next_attempt_at', new Date());
  if (schema.hasNextRetryAt) add('next_retry_at', new Date());

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const sql = `INSERT INTO whatsapp_outbox (${cols.join(', ')}) VALUES (${placeholders})`;
  await pool.query(sql, params);
  return outboxId;
}

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

async function cancelPendingOutboxForClient(userId, clientId, reason = 'client_opted_out') {
  if (!userId || !clientId) return { updated: 0 };
  const schema = await getOutboxSchema();
  if (!schema) return { updated: 0 };

  const updates = ['status = $3', 'updated_at = CURRENT_TIMESTAMP'];
  const params = [userId, clientId, 'skipped'];
  let idx = 4;

  if (schema.hasLastError && reason) {
    updates.push(`last_error = $${idx++}`);
    params.push(String(reason).slice(0, 2000));
  }

  if (schema.hasLockedAt) updates.push('locked_at = NULL');
  if (schema.hasLockedBy) updates.push('locked_by = NULL');
  if (schema.hasProcessingStartedAt) updates.push('processing_started_at = NULL');
  if (schema.hasNextAttemptAt) updates.push('next_attempt_at = CURRENT_TIMESTAMP');
  if (schema.hasNextRetryAt) updates.push('next_retry_at = CURRENT_TIMESTAMP');

  try {
    const r = await pool.query(
      `
      UPDATE whatsapp_outbox
      SET ${updates.join(', ')}
      WHERE user_id = $1
        AND client_id = $2
        AND status IN ('pending', 'retry', 'processing')
      `,
      params
    );
    return { updated: r.rowCount || 0 };
  } catch (e) {
    logger.warning('Failed to cancel pending WhatsApp outbox', {
      userId,
      clientId,
      error: e?.message
    });
    return { updated: 0 };
  }
}

function formatDateTime(d) {
  try {
    const date = d instanceof Date ? d : new Date(d);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const h24 = date.getHours();
    const suffix = h24 >= 12 ? 'م' : 'ص';
    let h12 = h24 % 12;
    if (h12 === 0) h12 = 12;
    const hh = String(h12).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const sec = String(date.getSeconds()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}:${sec} ${suffix}`;
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

function formatAmountPretty(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val ?? '');
  const hasDecimals = Math.abs(n % 1) > 0;
  try {
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: hasDecimals ? 2 : 0
    }).format(n);
  } catch (_) {
    return hasDecimals ? n.toFixed(2) : String(n);
  }
}

function formatBalancesLines(balances) {
  if (!Array.isArray(balances) || balances.length === 0) return ['-'];
  return balances.map((b) => `${b.currency}: ${formatAmount(b.balance)}`);
}

function safeText(val, fallback = '-') {
  const s = val == null ? '' : String(val).trim();
  return s ? s : fallback;
}

function currencyName(code) {
  const c = String(code || '').toUpperCase();
  const map = {
    YER: 'ريال يمني',
    SAR: 'سعودي',
    USD: 'دولار أمريكي',
    IQD: 'دينار عراقي'
  };
  return map[c] || c || 'غير محدد';
}

function isRemittanceEntryType(entryType) {
  const type = String(entryType || '').toLowerCase();
  return (
    type.includes('transfer') ||
    type.includes('remittance') ||
    type.includes('hawala') ||
    type.includes('حوال')
  );
}

function isTransferEntry({ entryType, transferCompany, transferRecipient, transferSender, transferNumber }) {
  const type = String(entryType || '').toLowerCase();
  if (type.includes('transfer') || type.includes('remittance') || type.includes('حوال') || type.includes('hawala')) return true;
  return !!(transferCompany || transferRecipient || transferSender || transferNumber);
}

function isFeeOnlyRemittanceTransaction(tx) {
  if (!isRemittanceEntryType(tx?.entry_type)) return false;
  const dir = String(tx?.transaction_direction || '').toLowerCase();
  const isDebit = dir === 'expense' || dir === 'debit';
  if (!isDebit) return false;
  const note = String(tx?.transaction_note || '');
  const feeHints = ['خدمة تحويل', 'عمولة تحويل', 'عمولة تسليم', 'خدمة تسليم'];
  const hasFeeHint = feeHints.some((hint) => note.includes(hint)) || note.toLowerCase().includes('fee');
  const amountNum = Number(tx?.transaction_amount ?? tx?.amount);
  const feeNum = Number(tx?.fee_amount ?? tx?.feeAmount);
  const hasFee = Number.isFinite(feeNum) && feeNum > 0;
  const amountIsZero = !Number.isFinite(amountNum) || amountNum <= 0;
  return hasFeeHint || (hasFee && amountIsZero);
}

function computeTransferDisplayAmount({ amount, currency, feeAmount, feeCurrency, direction }) {
  const dir = String(direction || '').toLowerCase();
  const isSend = dir === 'expense' || dir === 'debit';
  const amountNum = Number(amount);
  const feeNum = Number(feeAmount);
  const safeCurrency = String(currency || '').toUpperCase();
  const feeCur = String(feeCurrency || '').toUpperCase();
  if (
    isSend &&
    safeCurrency &&
    feeCur &&
    safeCurrency === feeCur &&
    Number.isFinite(amountNum) &&
    Number.isFinite(feeNum) &&
    feeNum > 0
  ) {
    return amountNum - feeNum;
  }
  return Number.isFinite(amountNum) ? amountNum : amount;
}

function buildBalanceLineForCurrency(balances, currencyCode) {
  if (!Array.isArray(balances) || balances.length === 0) return '';
  const code = String(currencyCode || '').toUpperCase();
  if (!code) return '';
  const row = balances.find((b) => String(b.currency || '').toUpperCase() === code);
  if (!row) return '';
  const raw = Number(row.balance);
  if (!Number.isFinite(raw)) return '';
  const absVal = formatAmountPretty(Math.abs(raw));
  const status = raw > 0 ? 'لك' : raw < 0 ? 'عليك' : 'متزن';
  return `الرصيد: ${absVal} ${currencyName(code)} ${status}`;
}

function buildSimpleBalanceLineForCurrency(balances, currencyCode) {
  if (!Array.isArray(balances) || balances.length === 0) return '';
  const code = String(currencyCode || '').toUpperCase();
  if (!code) return '';
  const row = balances.find((b) => String(b.currency || '').toUpperCase() === code);
  if (!row) return '';
  const raw = Number(row.balance);
  if (!Number.isFinite(raw)) return '';
  const absVal = formatAmountPretty(Math.abs(raw));
  const label = raw > 0 ? 'الرصيد لكم' : raw < 0 ? 'الرصيد عليكم' : 'الرصيد متزن';
  return `${label}: ${absVal} ${currencyName(code)}`;
}

function inferFeeLabel(note) {
  const n = String(note || '');
  if (n.includes('تحويل')) return 'عمولة تحويل';
  if (n.includes('تسليم')) return 'عمولة تسليم';
  return 'عمولة حوالة';
}

function buildFeeOnlyRemittanceMessage({
  amount,
  feeAmount,
  feeCurrency,
  currency,
  dateValue,
  transferNumber,
  note,
  balances
}) {
  const safeCurrency = String(feeCurrency || currency || 'IQD').toUpperCase();
  const feeNum = Number(feeAmount);
  const amountNum = Number(amount);
  const displayAmount = Number.isFinite(feeNum) && feeNum > 0
    ? feeNum
    : (Number.isFinite(amountNum) ? amountNum : 0);
  const amountText = formatAmountPretty(displayAmount);
  const number = safeText(transferNumber, '0');
  const feeLabel = inferFeeLabel(note);
  const balanceLine = buildBalanceLineForCurrency(balances, safeCurrency);
  const balanceBlock = balanceLine ? `\n\n${balanceLine}` : '';
  return (
`عليكم خصم ${amountText} ${currencyName(safeCurrency)}
تم خصم ${feeLabel} حوالة رقم الحوالة: ${number}
${balanceBlock}`
  );
}

function buildTransferMessage({
  customerName,
  amount,
  currency,
  direction,
  dateValue,
  balances,
  transferCompany,
  transferRecipient,
  transferSender,
  transferNumber,
  feeAmount,
  feeCurrency
}) {
  const dir = String(direction || '').toLowerCase();
  const isSend = dir === 'expense' || dir === 'debit';
  const title = isSend ? 'إرسال حوالة' : 'إستلام حوالة';

  const safeCurrency = String(currency || 'IQD').toUpperCase();
  const feeCur = String(feeCurrency || '').toUpperCase();
  const displayAmount = computeTransferDisplayAmount({
    amount,
    currency: safeCurrency,
    feeAmount,
    feeCurrency: feeCur,
    direction
  });
  const feeNum = Number(feeAmount);
  const hasFee = Number.isFinite(feeNum) && feeNum > 0;

  const amountText = formatAmountPretty(Number.isFinite(displayAmount) ? displayAmount : 0);
  const feeText = formatAmountPretty(Number.isFinite(feeNum) ? feeNum : 0);
  const feeCurrencyName = currencyName(feeCur || safeCurrency);

  const feeSegment = (isSend && hasFee)
    ? `  العمولة: ${feeText} ${feeCurrencyName}`
    : '';

  const firstLine =
    (isSend ? 'عليكم حوالة' : 'لكم حوالة') +
    ` ${amountText} ${currencyName(safeCurrency)}` +
    feeSegment;

  const company = safeText(transferCompany, 'غير محدد');
  const recipient = safeText(transferRecipient, 'غير محدد');
  const sender = safeText(transferSender, 'غير محدد');
  const number = safeText(transferNumber, 'غير محدد');
  const dateLine = safeText(formatDateTime(dateValue), 'غير محدد');

  const advisory = isSend
    ? `\nعميلنا العزيز عند إرسالك حوالة احرص \nعلى إبلاغ المستفيد باستلامها`
    : '';

  const balanceLine = isSend
    ? buildBalanceLineForCurrency(balances, safeCurrency)
    : buildSimpleBalanceLineForCurrency(balances, safeCurrency);
  const balanceBlock = balanceLine ? `\n\n${balanceLine}` : '';

  return (
`*(${title})*
${firstLine}

مقابل ${isSend ? 'تحويل حوالة من حسابكم لدينا إلى' : 'حوالة واردة عن طريق'}: ${company}
مبلغ الحوالة: ${amountText}
عملة الحوالة: ${currencyName(safeCurrency)}
المستلم: ${recipient}
المرسل: ${sender}
رقم الحوالة: ${number}

${dateLine}${advisory}${balanceBlock}`
  );
}

function buildMessage({
  customerName,
  amount,
  currency,
  direction,
  note,
  dateValue,
  balances,
  senderName,
  entryType,
  transferCompany,
  transferRecipient,
  transferSender,
  transferNumber,
  feeAmount,
  feeCurrency
}) {
  if (isFeeOnlyRemittanceTransaction({
    entry_type: entryType,
    transaction_direction: direction,
    transaction_note: note,
    transaction_amount: amount,
    fee_amount: feeAmount
  })) {
    return buildFeeOnlyRemittanceMessage({
      amount,
      feeAmount,
      feeCurrency,
      currency,
      dateValue,
      transferNumber,
      note,
      balances
    });
  }
  if (isTransferEntry({ entryType, transferCompany, transferRecipient, transferSender, transferNumber })) {
    return buildTransferMessage({
      customerName,
      amount,
      currency,
      direction,
      dateValue,
      transferCompany,
      transferRecipient,
      transferSender,
      transferNumber,
      feeAmount,
      feeCurrency,
      balances
    });
  }

  const dir = String(direction || '').toLowerCase();
  const typeLabel =
    dir === 'income' || dir === 'credit' ? '📈 القيد لكم' :
    dir === 'expense' || dir === 'debit' ? '📉 القيد عليكم' :
    '📊 القيد';

  const safeName = customerName || 'عميلنا';
  const safeAmount = formatAmount(amount != null ? amount : 0);
  const safeCurrency = currency || 'IQD';
  const safeNote = (note && String(note).trim()) ? String(note).trim() : '-';
  const safeDate = formatDate(dateValue || Date.now());
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

async function markWhatsappCancelled(transaction, reason) {
  try {
    const uuid = transaction.transaction_uuid;
    if (!uuid) return;
    await pool.query(
      `
      INSERT INTO whatsapp_transaction_status (
        transaction_uuid,
        transaction_id,
        whatsapp_cancelled,
        updated_at,
        created_at
      ) VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (transaction_uuid)
      DO UPDATE SET whatsapp_cancelled = TRUE, updated_at = CURRENT_TIMESTAMP
      `,
      [uuid, transaction.transaction_id || null]
    );
    if (reason) {
      logger.info('WhatsApp notification cancelled', {
        transactionUuid: uuid,
        reason
      });
    }
  } catch (e) {
    logger.warning('Failed to mark whatsapp_cancelled', {
      transactionUuid: transaction?.transaction_uuid,
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
    dateValue: transaction.transaction_date || transaction.created_at || Date.now(),
    balances,
    senderName: ownerName,
    entryType: transaction.entry_type,
    transferCompany: transaction.transfer_company,
    transferRecipient: transaction.transfer_recipient,
    transferSender: transaction.transfer_sender,
    transferNumber: transaction.transfer_number,
    feeAmount: transaction.fee_amount,
    feeCurrency: transaction.fee_currency
  });

  try {
    const outboxId = await insertOutboxRow({
      ownerUserId,
      clientId,
      transactionUuid: tUuid,
      transactionId: tId || null,
      clientPhone,
      messageText: msg
    });
    await ensureTransactionStatusRow(transaction);
    return { enqueued: true, outboxId };
  } catch (e) {
    logger.warning('Failed to insert whatsapp_outbox (schema may differ)', {
      transactionUuid: tUuid,
      error: e?.message
    });
    // still ensure status row
    await ensureTransactionStatusRow(transaction);
    return { enqueued: false, reason: 'insert_failed' };
  }
}

module.exports = {
  enqueueWhatsAppOutboxForTransaction,
  cancelPendingOutboxForClient
};
