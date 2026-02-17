// ============================================================================
// Transaction Controller
// ============================================================================
// Controller للمعاملات المالية (Financial Transactions)
// ============================================================================

const { pool } = require('../config/database');
const {
  ensureUuid,
  isValidUUID,
  msToSeconds,
  secondsToMs,
  intToBoolean,
  normalizeClientId,
  normalizeAccountId,
  normalizeTransactionDirection,
  resolveOwnerUserIdForRequest
} = require('../utils/helpers');
const { mapTransactionToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { resolveConflict } = require('../services/conflictResolver');
const { sendTransactionNotification } = require('../services/fcmNotificationService');
const { enqueueWhatsAppOutboxForTransaction } = require('../services/whatsappOutboxService');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ----------------------------------------------------------------------------
// Helpers (local)
// ----------------------------------------------------------------------------
function parseFirebaseUidFromAuth(req) {
  return req.user?.firebase_uid || req.user?.firebaseUid || req.user?.uid || null;
}

async function computeNotifyCustomer(ownerUserId, clientId) {
  // Server-driven notifications: depend only on user settings + client opt-out.
  if (!ownerUserId || !clientId) return false;
  try {
    const [s, o] = await Promise.all([
      pool.query(
        'SELECT enable_whatsapp FROM whatsapp_user_settings WHERE user_id = $1 LIMIT 1',
        [ownerUserId]
      ),
      pool.query(
        'SELECT 1 FROM whatsapp_client_opt_out WHERE user_id = $1 AND client_id = $2 LIMIT 1',
        [ownerUserId, clientId]
      )
    ]);
    const enabled = s.rows.length > 0 && s.rows[0].enable_whatsapp === true;
    const optedOut = o.rows.length > 0;
    return enabled && !optedOut;
  } catch (e) {
    logger.warning('computeNotifyCustomer failed', { ownerUserId, clientId, error: e?.message });
    return false;
  }
}

const SHARED_ACCOUNT_ERROR = 'الحساب المشترك غير مدعوم. يرجى استخدام الصناديق الافتراضية الخاصة بك.';
const ACCOUNT_OWNERSHIP_ERROR = 'الحساب لا يخص هذا المستخدم أو غير متاح.';
const ACCOUNT_DELETED_ERROR = 'الحساب محذوف أو مؤرشف.';

async function validateAccountForOwner(accountId, ownerUserId) {
  if (!accountId || !ownerUserId) {
    return { ok: false, error: ACCOUNT_OWNERSHIP_ERROR };
  }
  const ownerIdNum = typeof ownerUserId === 'string' ? parseInt(ownerUserId, 10) : ownerUserId;
  if (!Number.isFinite(ownerIdNum)) {
    return { ok: false, error: ACCOUNT_OWNERSHIP_ERROR };
  }
  try {
    const result = await pool.query(
      'SELECT owner_user_id, deleted_at, is_shared FROM cash_accounts WHERE account_id = $1 LIMIT 1',
      [accountId]
    );
    if (result.rows.length === 0) {
      return { ok: false, error: ACCOUNT_OWNERSHIP_ERROR };
    }
    const row = result.rows[0];
    if (row.deleted_at) {
      return { ok: false, error: ACCOUNT_DELETED_ERROR };
    }
    if (row.is_shared === true) {
      return { ok: false, error: SHARED_ACCOUNT_ERROR };
    }
    if (row.owner_user_id !== ownerIdNum) {
      return { ok: false, error: ACCOUNT_OWNERSHIP_ERROR };
    }
    return { ok: true };
  } catch (error) {
    logger.warning('validateAccountForOwner failed', { accountId, ownerUserId, error: error.message });
    return { ok: false, error: ACCOUNT_OWNERSHIP_ERROR };
  }
}

// ----------------------------------------------------------------------------
// Transactions
// ----------------------------------------------------------------------------

/**
 * GET /api/transactions
 * الحصول على المعاملات
 */
async function getTransactions(req, res, next) {
  try {
    const { ownerUserId, ownerFirebaseUid, customerId, clientId, accountId, synced, limit, offset, sinceTimestamp } = req.query;

    let query = 'SELECT * FROM financial_transactions WHERE deleted_at IS NULL';
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
    if (customerId || clientId) {
      query += ` AND client_id = $${paramIndex++}`;
      params.push(customerId || clientId);
    }
    if (accountId) {
      query += ` AND account_id = $${paramIndex++}`;
      params.push(accountId);
    }
    if (synced !== undefined) {
      query += ` AND is_synced = $${paramIndex++}`;
      params.push(intToBoolean(synced));
    }

    // دعم المزامنة التزايدية
    if (sinceTimestamp) {
      const sinceSeconds = msToSeconds(parseInt(sinceTimestamp));
      if (sinceSeconds) {
        query += ` AND updated_at > to_timestamp($${paramIndex++})`;
        params.push(sinceSeconds);
      }
    }

    query += ' ORDER BY updated_at DESC, transaction_date DESC, created_at DESC';

    if (limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(parseInt(limit));
    }
    if (offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(parseInt(offset));
    }

    const result = await pool.query(query, params);
    const transactions = result.rows.map(row => mapTransactionToAPI(row));

    res.json({ success: true, data: transactions, count: transactions.length });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/transactions/by-uuid/:transactionUuid
 * الحصول على معاملة حسب UUID
 */
async function getTransactionByUuid(req, res, next) {
  try {
    const { transactionUuid } = req.params;

    if (!transactionUuid) {
      return res.status(400).json({ success: false, error: 'transactionUuid مطلوب' });
    }

    const result = await pool.query(
      'SELECT * FROM financial_transactions WHERE transaction_uuid = $1 AND deleted_at IS NULL',
      [transactionUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }

    res.json({ success: true, data: mapTransactionToAPI(result.rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/transactions/:transactionId
 * الحصول على معاملة محددة
 */
async function getTransactionById(req, res, next) {
  try {
    const { transactionId } = req.params;

    // التحقق من أن transactionId ليس كلمة محجوزة
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(String(transactionId).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID: "${transactionId}" is a reserved word`
      });
    }

    // التحقق من أن transactionId هو رقم (BIGINT) أو UUID
    const isNumeric = /^\d+$/.test(transactionId);
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionId);

    if (!isNumeric && !isUUID) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID format: "${transactionId}" must be a number or UUID`
      });
    }

    const result = await pool.query(
      'SELECT * FROM financial_transactions WHERE transaction_id = $1 AND deleted_at IS NULL',
      [transactionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }

    res.json({ success: true, data: mapTransactionToAPI(result.rows[0]) });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/transactions
 * إنشاء معاملة جديدة
 */
async function createTransaction(req, res, next) {
  try {
    const transactionData = ensureUuid(req.body);

    // الحصول على ownerUserId الصحيح + ربطه بالـ auth
    const resolved = await resolveOwnerUserIdForRequest({
      ownerUserId: transactionData.ownerUserId,
      ownerFirebaseUid: transactionData.ownerFirebaseUid,
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
        error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات. يرجى التأكد من أن المستخدم مسجل في النظام.'
      });
    }
    const clientId = await normalizeClientId(
      transactionData.customerId || transactionData.clientId,
      transactionData.customerFirestoreId || transactionData.clientFirestoreId
    );
    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'clientId مطلوب - لا يمكن العثور على العميل في قاعدة البيانات. يرجى التأكد من أن العميل مسجل في النظام.'
      });
    }
    let accountId = await normalizeAccountId(
      transactionData.accountId,
      transactionData.accountFirestoreId
    );
    if (!accountId && transactionData.accountFirestoreId === 'shared-main-account-v1') {
      return res.status(400).json({ success: false, error: SHARED_ACCOUNT_ERROR });
    }
    if (!accountId) {
      logger.error('accountId is null in INSERT transaction', { transactionData });
      return res.status(400).json({
        success: false,
        error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
      });
    }
    const accountCheck = await validateAccountForOwner(accountId, ownerUserId);
    if (!accountCheck.ok) {
      return res.status(400).json({ success: false, error: accountCheck.error });
    }
    const notifyCustomerServer = await computeNotifyCustomer(ownerUserId, clientId);

    const result = await pool.query(
      `INSERT INTO financial_transactions (
        transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_id, account_id, client_firestore_id, account_firestore_id,
        transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
        notify_customer, is_synced, device_id, transaction_number, sync_version,
        created_at, updated_at,
        entry_type, transfer_company, transfer_recipient, transfer_sender, transfer_number,
        fee_amount, fee_currency, center_fee_amount, center_fee_currency
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14), $15, $16, $17, $18, $19, to_timestamp($20), CURRENT_TIMESTAMP,
        $21, $22, $23, $24, $25, $26, $27, $28, $29)
      RETURNING *`,
      [
        (transactionData.transactionUuid && isValidUUID(transactionData.transactionUuid))
          ? transactionData.transactionUuid
          : ((transactionData.entryId && isValidUUID(transactionData.entryId)) ? transactionData.entryId : uuidv4()),
        transactionData.cloudId || null,
        transactionData.firestoreId || null,
        ownerUserId,
        ownerFirebaseUid || null,
        clientId,
        accountId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
        transactionData.accountFirestoreId || null,
        transactionData.amount || transactionData.transactionAmount,
        transactionData.currency || transactionData.currencyCode || 'IQD',
        transactionData.direction || transactionData.transactionDirection,
        transactionData.note || transactionData.transactionNote || null,
        msToSeconds(transactionData.transactionDate || Date.now()),
        intToBoolean(notifyCustomerServer),
        intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
        transactionData.deviceId || null,
        transactionData.transactionNumber || null,
        transactionData.syncVersion || 1,
        msToSeconds(transactionData.createdAt || Date.now()),
        transactionData.entryType || null,
        transactionData.transferCompany || null,
        transactionData.transferRecipient || null,
        transactionData.transferSender || null,
        transactionData.transferNumber || null,
        transactionData.feeAmount != null ? transactionData.feeAmount : null,
        transactionData.feeCurrency || null,
        transactionData.centerFeeAmount != null ? transactionData.centerFeeAmount : null,
        transactionData.centerFeeCurrency || null
      ]
    );

    const transaction = result.rows[0];

    await logAudit(
      transaction.owner_user_id,
      transaction.owner_firebase_uid,
      'create',
      'transaction',
      transaction.transaction_id.toString(),
      null,
      transaction,
      req
    );

    // ✅ WhatsApp Outbox (غير متزامن - لا يؤثر على زمن الاستجابة)
    setImmediate(() => {
      enqueueWhatsAppOutboxForTransaction(transaction)
        .then((r) => {
          if (r?.enqueued) {
            logger.info('WhatsApp outbox enqueued', {
              transactionUuid: transaction.transaction_uuid,
              outboxId: r.outboxId
            });
          }
        })
        .catch((e) => {
          logger.warning('WhatsApp outbox enqueue failed', {
            transactionUuid: transaction.transaction_uuid,
            error: e?.message
          });
        });
    });

    res.status(201).json({ success: true, data: mapTransactionToAPI(transaction) });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/transactions/sync
 * مزامنة معاملة (Insert or Update حسب UUID)
 */
async function syncTransaction(req, res, next) {
  try {
    const transactionData = ensureUuid(req.body);
    const uuid = transactionData.transactionUuid || (transactionData.entryId && isValidUUID(transactionData.entryId) ? transactionData.entryId : uuidv4());

    if (!uuid) {
      return res.status(400).json({ success: false, error: 'transactionUuid أو entryId مطلوب' });
    }

    const existing = await pool.query(
      'SELECT transaction_id, sync_version, updated_at FROM financial_transactions WHERE transaction_uuid = $1',
      [uuid]
    );

    if (existing.rows.length > 0) {
      const existingTransaction = existing.rows[0];

      // حل التعارضات
      if (transactionData.syncVersion && existingTransaction.sync_version) {
        const conflictResult = await resolveConflict('financial_transactions', uuid, transactionData, {
          syncVersion: existingTransaction.sync_version,
          updatedAt: secondsToMs(existingTransaction.updated_at)
        });
        if (conflictResult.winner !== transactionData) {
          const remoteTransaction = await pool.query('SELECT * FROM financial_transactions WHERE transaction_uuid = $1', [uuid]);
          const transaction = remoteTransaction.rows[0];
          return res.json({
            success: true,
            data: mapTransactionToAPI(transaction),
            action: 'conflict_resolved',
            conflict: true,
            conflictReason: conflictResult.reason
          });
        }
      }

      // الحصول على ownerUserId الصحيح + ربطه بالـ auth
      const resolved = await resolveOwnerUserIdForRequest({
        ownerUserId: transactionData.ownerUserId,
        ownerFirebaseUid: transactionData.ownerFirebaseUid,
        authUserId: req.user?.userId,
        authFirebaseUid: req.user?.firebaseUid || req.user?.firebase_uid
      });

      if (resolved.error) {
        return res.status(403).json({ success: false, error: resolved.error });
      }

      const ownerUserId = resolved.ownerUserId;
      const ownerFirebaseUid = resolved.ownerFirebaseUid;

      if (!ownerUserId) {
        logger.error('ownerUserId is null in UPDATE transaction', { transactionData });
        return res.status(400).json({
          success: false,
          error: 'ownerUserId مطلوب - لا يمكن العثور على المستخدم في قاعدة البيانات. يرجى التأكد من أن المستخدم مسجل في النظام.'
        });
      }

      // الحصول على clientId الصحيح
      const clientId = await normalizeClientId(
        transactionData.customerId || transactionData.clientId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId
      );

      // الحصول على accountId الصحيح
      const accountId = await normalizeAccountId(
        transactionData.accountId,
        transactionData.accountFirestoreId
      );

      if (!accountId) {
        logger.error('accountId is null in UPDATE transaction', { transactionData });
        return res.status(400).json({
          success: false,
          error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
        });
      }
      const accountCheck = await validateAccountForOwner(accountId, ownerUserId);
      if (!accountCheck.ok) {
        return res.status(400).json({ success: false, error: accountCheck.error });
      }

      const notifyCustomerServer = await computeNotifyCustomer(ownerUserId, clientId);

      // تحديث المعاملة الموجودة
      const result = await pool.query(
        `UPDATE financial_transactions SET
          cloud_id = COALESCE($2, cloud_id),
          firestore_id = COALESCE($3, firestore_id),
          owner_user_id = $4,
          owner_firebase_uid = COALESCE($5, owner_firebase_uid),
          client_id = $6,
          account_id = $7,
          client_firestore_id = COALESCE($8, client_firestore_id),
          account_firestore_id = COALESCE($9, account_firestore_id),
          transaction_amount = $10,
          currency_code = $11,
          transaction_direction = $12,
          transaction_note = COALESCE($13, transaction_note),
          transaction_date = to_timestamp($14),
          notify_customer = $15,
          is_synced = COALESCE($16, is_synced),
          device_id = COALESCE($17, device_id),
          transaction_number = COALESCE($18, transaction_number),
          sync_version = COALESCE($19, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP,
          entry_type = COALESCE($20, entry_type),
          transfer_company = COALESCE($21, transfer_company),
          transfer_recipient = COALESCE($22, transfer_recipient),
          transfer_sender = COALESCE($23, transfer_sender),
          transfer_number = COALESCE($24, transfer_number),
          fee_amount = COALESCE($25, fee_amount),
          fee_currency = COALESCE($26, fee_currency),
          center_fee_amount = COALESCE($27, center_fee_amount),
          center_fee_currency = COALESCE($28, center_fee_currency)
        WHERE transaction_uuid = $1 AND deleted_at IS NULL
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId,
          transactionData.firestoreId,
          ownerUserId,
          ownerFirebaseUid,
          clientId,
          accountId,
          transactionData.customerFirestoreId || transactionData.clientFirestoreId,
          transactionData.accountFirestoreId,
          transactionData.amount || transactionData.transactionAmount,
          transactionData.currency || transactionData.currencyCode || 'IQD',
          normalizeTransactionDirection(transactionData.direction || transactionData.transactionDirection),
          transactionData.note || transactionData.transactionNote,
          msToSeconds(transactionData.transactionDate),
          intToBoolean(notifyCustomerServer),
          intToBoolean(transactionData.synced),
          transactionData.deviceId,
          transactionData.transactionNumber,
          transactionData.syncVersion || existingTransaction.sync_version || 0,
          transactionData.entryType ?? null,
          transactionData.transferCompany ?? null,
          transactionData.transferRecipient ?? null,
          transactionData.transferSender ?? null,
          transactionData.transferNumber ?? null,
          transactionData.feeAmount != null ? transactionData.feeAmount : null,
          transactionData.feeCurrency ?? null,
          transactionData.centerFeeAmount != null ? transactionData.centerFeeAmount : null,
          transactionData.centerFeeCurrency ?? null
        ]
      );

      const transaction = result.rows[0];

      await logAudit(
        transaction.owner_user_id,
        transaction.owner_firebase_uid,
        'update',
        'transaction',
        transaction.transaction_id.toString(),
        existingTransaction,
        transaction,
        req
      );

      // ✅ WhatsApp Outbox (غير متزامن - لا يؤثر على زمن الاستجابة)
      setImmediate(() => {
        enqueueWhatsAppOutboxForTransaction(transaction)
          .then((r) => {
            if (r?.enqueued) {
              logger.info('WhatsApp outbox enqueued', {
                transactionUuid: transaction.transaction_uuid,
                outboxId: r.outboxId
              });
            }
          })
          .catch((e) => {
            logger.warning('WhatsApp outbox enqueue failed', {
              transactionUuid: transaction.transaction_uuid,
              error: e?.message
            });
          });
      });

      // ✅ إرسال إشعار FCM إذا كان notify_customer = true
      if (transaction.notify_customer) {
        setImmediate(async () => {
          try {
            const [customerResult, ownerResult] = await Promise.all([
              pool.query('SELECT * FROM business_clients WHERE client_id = $1', [transaction.client_id]),
              pool.query('SELECT * FROM app_users WHERE user_id = $1', [transaction.owner_user_id])
            ]);

            const customer = customerResult.rows[0];
            const owner = ownerResult.rows[0];

            if (customer && owner && customer.phone_number) {
              logger.info('Sending transaction notification', {
                transactionUuid: transaction.transaction_uuid,
                customerId: customer.client_id,
                customerPhone: customer.phone_number,
                ownerId: owner.user_id
              });

              const notifResult = await sendTransactionNotification(transaction, customer, owner);
              if (!notifResult.success) {
                logger.warning('Transaction notification failed', {
                  transactionUuid: transaction.transaction_uuid,
                  reason: notifResult.reason || notifResult.error
                });
              }
            } else {
              logger.warning('Cannot send notification: missing data', {
                transactionUuid: transaction.transaction_uuid,
                hasCustomer: !!customer,
                hasOwner: !!owner,
                hasPhone: !!(customer?.phone_number)
              });
            }
          } catch (notifError) {
            logger.error('Error sending transaction notification', {
              error: notifError.message,
              stack: notifError.stack,
              transactionUuid: transaction.transaction_uuid
            });
          }
        });
      }

      return res.json({ success: true, data: mapTransactionToAPI(transaction), action: 'updated' });
    } else {
      // INSERT جديد
      const resolved = await resolveOwnerUserIdForRequest({
        ownerUserId: transactionData.ownerUserId,
        ownerFirebaseUid: transactionData.ownerFirebaseUid,
        authUserId: req.user?.userId,
        authFirebaseUid: req.user?.firebaseUid || req.user?.firebase_uid
      });

      if (resolved.error) {
        return res.status(403).json({ success: false, error: resolved.error });
      }

      const ownerUserId = resolved.ownerUserId;
      const ownerFirebaseUid = resolved.ownerFirebaseUid;

      const clientId = await normalizeClientId(
        transactionData.customerId || transactionData.clientId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId
      );

      let accountId = await normalizeAccountId(
        transactionData.accountId,
        transactionData.accountFirestoreId
      );

      if (!accountId && transactionData.accountFirestoreId === 'shared-main-account-v1') {
        return res.status(400).json({ success: false, error: SHARED_ACCOUNT_ERROR });
      }

      if (!accountId) {
        logger.error('accountId is null in INSERT transaction', { transactionData });
        return res.status(400).json({
          success: false,
          error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
        });
      }
      const accountCheck = await validateAccountForOwner(accountId, ownerUserId);
      if (!accountCheck.ok) {
        return res.status(400).json({ success: false, error: accountCheck.error });
      }

      const notifyCustomerServer = await computeNotifyCustomer(ownerUserId, clientId);

      const result = await pool.query(
        `INSERT INTO financial_transactions (
          transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          client_id, account_id, client_firestore_id, account_firestore_id,
          transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
          notify_customer, is_synced, device_id, transaction_number, sync_version,
          created_at, updated_at,
          entry_type, transfer_company, transfer_recipient, transfer_sender, transfer_number,
          fee_amount, fee_currency, center_fee_amount, center_fee_currency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14), $15, $16, $17, $18, $19, to_timestamp($20), CURRENT_TIMESTAMP,
          $21, $22, $23, $24, $25, $26, $27, $28, $29)
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId || null,
        transactionData.firestoreId || null,
        ownerUserId,
        ownerFirebaseUid || null,
        clientId,
        accountId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
        transactionData.accountFirestoreId || null,
        transactionData.amount || transactionData.transactionAmount,
        transactionData.currency || transactionData.currencyCode || 'IQD',
        normalizeTransactionDirection(transactionData.direction || transactionData.transactionDirection),
        transactionData.note || transactionData.transactionNote || null,
        msToSeconds(transactionData.transactionDate || Date.now()),
        intToBoolean(notifyCustomerServer),
        intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
        transactionData.deviceId || null,
        transactionData.transactionNumber || null,
        transactionData.syncVersion || 1,
          msToSeconds(transactionData.createdAt || Date.now()),
          transactionData.entryType || null,
          transactionData.transferCompany || null,
          transactionData.transferRecipient || null,
          transactionData.transferSender || null,
          transactionData.transferNumber || null,
          transactionData.feeAmount != null ? transactionData.feeAmount : null,
          transactionData.feeCurrency || null,
          transactionData.centerFeeAmount != null ? transactionData.centerFeeAmount : null,
          transactionData.centerFeeCurrency || null
        ]
      );

      const transaction = result.rows[0];

      await logAudit(
        transaction.owner_user_id,
        transaction.owner_firebase_uid,
        'create',
        'transaction',
        transaction.transaction_id.toString(),
        null,
        transaction,
        req
      );

      // ✅ WhatsApp Outbox (غير متزامن)
      setImmediate(() => {
        enqueueWhatsAppOutboxForTransaction(transaction)
          .then((r) => {
            if (r?.enqueued) {
              logger.info('WhatsApp outbox enqueued', {
                transactionUuid: transaction.transaction_uuid,
                outboxId: r.outboxId
              });
            }
          })
          .catch((e) => {
            logger.warning('WhatsApp outbox enqueue failed', {
              transactionUuid: transaction.transaction_uuid,
              error: e?.message
            });
          });
      });

      if (transaction.notify_customer) {
        setImmediate(async () => {
          try {
            const [customerResult, ownerResult] = await Promise.all([
              pool.query('SELECT * FROM business_clients WHERE client_id = $1', [transaction.client_id]),
              pool.query('SELECT * FROM app_users WHERE user_id = $1', [transaction.owner_user_id])
            ]);

            const customer = customerResult.rows[0];
            const owner = ownerResult.rows[0];

            if (customer && owner && customer.phone_number) {
              logger.info('Sending transaction notification', {
                transactionUuid: transaction.transaction_uuid,
                customerId: customer.client_id,
                customerPhone: customer.phone_number,
                ownerId: owner.user_id
              });

              const notifResult = await sendTransactionNotification(transaction, customer, owner);
              if (!notifResult.success) {
                logger.warning('Transaction notification failed', {
                  transactionUuid: transaction.transaction_uuid,
                  reason: notifResult.reason || notifResult.error
                });
              }
            } else {
              logger.warning('Cannot send notification: missing data', {
                transactionUuid: transaction.transaction_uuid,
                hasCustomer: !!customer,
                hasOwner: !!owner,
                hasPhone: !!(customer?.phone_number)
              });
            }
          } catch (notifError) {
            logger.error('Error sending transaction notification', {
              error: notifError.message,
              stack: notifError.stack,
              transactionUuid: transaction.transaction_uuid
            });
          }
        });
      }

      return res.json({ success: true, data: mapTransactionToAPI(transaction), action: 'created' });
    }
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/transactions/by-uuid/:transactionUuid
 * حذف معاملة (Soft Delete) حسب UUID
 */
async function deleteTransactionByUuid(req, res, next) {
  try {
    const { transactionUuid } = req.params;

    if (!transactionUuid) {
      return res.status(400).json({ success: false, error: 'transactionUuid مطلوب' });
    }

    const result = await pool.query(
      `UPDATE financial_transactions
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE transaction_uuid = $1 AND deleted_at IS NULL
       RETURNING *`,
      [transactionUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }

    const transaction = result.rows[0];
    await logAudit(
      transaction.owner_user_id,
      transaction.owner_firebase_uid,
      'delete',
      'transaction',
      transaction.transaction_id.toString(),
      null,
      transaction,
      req
    );

    res.json({ success: true, data: mapTransactionToAPI(transaction) });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/transactions/:transactionId
 * حذف معاملة (Soft Delete)
 */
async function deleteTransactionById(req, res, next) {
  try {
    const { transactionId } = req.params;

    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(String(transactionId).toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID: "${transactionId}" is a reserved word`
      });
    }

    const isNumeric = /^\d+$/.test(transactionId);
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(transactionId);

    if (!isNumeric && !isUUID) {
      return res.status(400).json({
        success: false,
        error: `Invalid transaction ID format: "${transactionId}" must be a number or UUID`
      });
    }

    const result = await pool.query(
      `UPDATE financial_transactions
       SET deleted_at = CURRENT_TIMESTAMP, sync_version = sync_version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE transaction_id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [transactionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المعاملة غير موجودة' });
    }

    const transaction = result.rows[0];

    await logAudit(
      transaction.owner_user_id,
      transaction.owner_firebase_uid,
      'delete',
      'transaction',
      transaction.transaction_id.toString(),
      transaction,
      null,
      req
    );

    res.json({ success: true, message: 'تم حذف المعاملة بنجاح' });
  } catch (error) {
    next(error);
  }
}

// ----------------------------------------------------------------------------
// Debt Tracking (من سجّل عليّ؟)
// ----------------------------------------------------------------------------

/**
 * GET /api/transactions/debt-summary
 *
 * ✅ السيناريو المطلوب:
 * المستخدم الحالي يرى "من هم المستخدمون الذين سجّلوا قيوداً عليه/له"
 *
 * المنطق:
 * - نحدد المستخدم الحالي (UID) من auth أو query
 * - نجلب رقم هاتفه من app_users
 * - نبحث عن كل client_id في business_clients حيث phone_number = رقم هاتفي
 * - نجلب معاملات financial_transactions لهذه client_id
 * - نجمع حسب owner_firebase_uid (المسجّل)
 * - نستثني قيود المستخدم نفسه حتى لا يظهر لنفسه
 */
async function getDebtSummary(req, res, next) {
  try {
    const { currentUserPhone, currentUserFirebaseUid, currency } = req.query;

    const uidFromAuth = parseFirebaseUidFromAuth(req);
    let myFirebaseUid = uidFromAuth || currentUserFirebaseUid || null;

    // fallback: إذا لا يوجد UID، نحاول من الهاتف (نجيب UID من app_users)
    if (!myFirebaseUid && currentUserPhone) {
      const r = await pool.query(
        'SELECT firebase_uid FROM app_users WHERE phone_number = $1 AND deleted_at IS NULL LIMIT 1',
        [String(currentUserPhone).trim()]
      );
      myFirebaseUid = r.rows?.[0]?.firebase_uid || null;
    }

    if (!myFirebaseUid) {
      return res.status(400).json({ success: false, error: 'currentUserFirebaseUid مطلوب' });
    }

    // 1) نجيب رقم الهاتف الخاص بي (المستخدم الحالي)
    const meRes = await pool.query(
      'SELECT phone_number FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL LIMIT 1',
      [myFirebaseUid]
    );

    const myPhone = meRes.rows?.[0]?.phone_number || null;
    if (!myPhone) {
      logger.debug('getDebtSummary: No phone number found for user', { myFirebaseUid });
      return res.json({ success: true, data: [] });
    }

    // ✅ (اختياري) طباعة تشخيص سريع
    logger.debug('getDebtSummary: identity resolved', { myFirebaseUid, myPhone, currency });

    // ✅ هذا هو الاستعلام الصحيح للسيناريو: "من سجّل عليّ؟"
    const sql = `
      WITH my_client_ids AS (
        SELECT bc.client_id
        FROM business_clients bc
        WHERE bc.phone_number = $1
          AND bc.deleted_at IS NULL
      ),
      tx AS (
        SELECT
          ft.owner_firebase_uid AS recorder_uid,
          ft.transaction_amount,
          ft.transaction_direction,
          ft.transaction_date,
          COALESCE(ft.currency_code, 'IQD') AS currency_code,
          CASE
            WHEN ft.transaction_direction IN ('expense','DEBIT','debit') THEN -ft.transaction_amount
            ELSE ft.transaction_amount
          END AS signed_amount
        FROM financial_transactions ft
        WHERE ft.client_id IN (SELECT client_id FROM my_client_ids)
          AND ft.deleted_at IS NULL
          AND ft.owner_firebase_uid IS NOT NULL
          AND ft.owner_firebase_uid <> $2
      ),
      by_currency_base AS (
        SELECT recorder_uid, currency_code, SUM(signed_amount) AS balance
        FROM tx
        GROUP BY recorder_uid, currency_code
      ),
      by_currency AS (
        SELECT recorder_uid, jsonb_object_agg(currency_code, balance) AS balances_by_currency
        FROM by_currency_base
        GROUP BY recorder_uid
      ),
      by_user AS (
        SELECT
          recorder_uid,
          COUNT(*) AS transaction_count,
          MAX(transaction_date) AS last_transaction_date,
          SUM(CASE WHEN signed_amount < 0 THEN -signed_amount ELSE 0 END) AS total_debit,
          SUM(CASE WHEN signed_amount > 0 THEN  signed_amount ELSE 0 END) AS total_credit,
          SUM(signed_amount) AS net_balance
        FROM tx
        GROUP BY recorder_uid
      )
      SELECT
        au.full_name,
        au.phone_number,
        au.job_title,
        bu.recorder_uid AS recorder_firebase_uid,
        bu.transaction_count,
        bu.last_transaction_date,
        bu.total_debit,
        bu.total_credit,
        bu.net_balance,
        COALESCE(cur.balances_by_currency, '{}'::jsonb) AS balances_by_currency
      FROM by_user bu
      JOIN app_users au
        ON au.firebase_uid = bu.recorder_uid
       AND au.deleted_at IS NULL
      LEFT JOIN by_currency cur
        ON cur.recorder_uid = bu.recorder_uid
      WHERE ($3::text IS NULL OR (cur.balances_by_currency IS NOT NULL AND cur.balances_by_currency ? $3::text))
      ORDER BY bu.last_transaction_date DESC NULLS LAST;
    `;

    const t0 = Date.now();
    // ✅ إذا تم تمرير currency، نفلتر الدائنين الذين لديهم رصيد في هذه العملة
    const result = await pool.query(sql, [myPhone, myFirebaseUid, currency || null]);
    const totalMs = Date.now() - t0;

    logger.debug('getDebtSummary: done', {
      myFirebaseUid,
      myPhone,
      rows: result.rows.length,
      totalMs
    });

    const users = result.rows.map((row) => {
      const totalDebit = row.total_debit !== null ? Number(row.total_debit) : 0;
      const totalCredit = row.total_credit !== null ? Number(row.total_credit) : 0;
      const netBalance = row.net_balance !== null ? Number(row.net_balance) : (totalCredit - totalDebit);

      const lastDateMs = row.last_transaction_date
        ? new Date(row.last_transaction_date).getTime()
        : Date.now();

      const balancesByCurrency =
        row.balances_by_currency && typeof row.balances_by_currency === 'object'
          ? row.balances_by_currency
          : {};

      // العملة الأساسية (للعرض) = أكبر رصيد مطلق
      const primaryCurrency = Object.keys(balancesByCurrency).length > 0
        ? Object.entries(balancesByCurrency).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0]
        : 'IQD';

      return {
        creditorName: row.full_name || 'مستخدم مجهول',
        creditorPhone: row.phone_number || '',
        creditorJobTitle: row.job_title || null,
        creditorFirebaseUid: row.recorder_firebase_uid,
        totalDebit,
        totalCredit,
        netBalance, // ✅ الرصيد الإجمالي (يتم الفلترة حسب العملة في التطبيق)
        transactionCount: Number(row.transaction_count) || 0,
        currency: primaryCurrency,
        lastTransactionDate: Math.floor(lastDateMs),
        balancesByCurrency
      };
    });

    res.json({ success: true, data: users });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/transactions/debt-details/:creditorFirebaseUid
 *
 * ✅ عند النقر على مستخدم من شاشة المتابعة:
 * نعرض كل القيود التي سجّلها هذا المستخدم عليّ (أنا = رقم هاتفي)
 */
async function getDebtDetails(req, res, next) {
  try {
    const { creditorFirebaseUid } = req.params;
    const { currentUserPhone, currentUserFirebaseUid, limit, offset } = req.query;

    if (!creditorFirebaseUid) {
      return res.status(400).json({ success: false, error: 'creditorFirebaseUid مطلوب' });
    }

    const uidFromAuth = parseFirebaseUidFromAuth(req);
    let myFirebaseUid = uidFromAuth || currentUserFirebaseUid || null;

    if (!myFirebaseUid && currentUserPhone) {
      const r = await pool.query(
        'SELECT firebase_uid FROM app_users WHERE phone_number = $1 AND deleted_at IS NULL LIMIT 1',
        [String(currentUserPhone).trim()]
      );
      myFirebaseUid = r.rows?.[0]?.firebase_uid || null;
    }

    if (!myFirebaseUid) {
      return res.status(400).json({ success: false, error: 'currentUserFirebaseUid مطلوب' });
    }

    const meRes = await pool.query(
      'SELECT phone_number FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL LIMIT 1',
      [myFirebaseUid]
    );

    const myPhone = meRes.rows?.[0]?.phone_number || null;
    if (!myPhone) {
      return res.json({ success: true, data: [], count: 0 });
    }

    let q = `
      WITH my_client_ids AS (
        SELECT bc.client_id
        FROM business_clients bc
        WHERE bc.phone_number = $1
          AND bc.deleted_at IS NULL
      )
      SELECT
        ft.*,
        ca.account_name
      FROM financial_transactions ft
      LEFT JOIN cash_accounts ca
        ON ft.account_id = ca.account_id
       AND ca.deleted_at IS NULL
      WHERE ft.client_id IN (SELECT client_id FROM my_client_ids)
        AND ft.owner_firebase_uid = $2
        AND ft.deleted_at IS NULL
      ORDER BY ft.transaction_date DESC, ft.updated_at DESC, ft.created_at DESC
    `;

    const params = [myPhone, creditorFirebaseUid];

    // ⚠️ مهم: أول باراميتر إضافي يبدأ من $3
    let idx = 3;

    if (limit) {
      q += ` LIMIT $${idx++}`;
      params.push(parseInt(limit));
    }
    if (offset) {
      q += ` OFFSET $${idx++}`;
      params.push(parseInt(offset));
    }

    const result = await pool.query(q, params);
    const transactions = result.rows.map((row) => mapTransactionToAPI(row));

    res.json({ success: true, data: transactions, count: transactions.length });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getTransactions,
  getTransactionByUuid,
  getTransactionById,
  createTransaction,
  syncTransaction,
  deleteTransactionByUuid,
  deleteTransactionById,
  getDebtSummary, // ✅ ملخص "من سجّل عليّ"
  getDebtDetails  // ✅ تفاصيل القيود عند الضغط
};

