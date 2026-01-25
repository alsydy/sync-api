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
  normalizeOwnerUserId,
  normalizeClientId,
  normalizeAccountId,
  normalizeTransactionDirection,
  getAccountIdFromFirestoreId,
  normalizeColorCode
} = require('../utils/helpers');
const { mapTransactionToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { resolveConflict } = require('../services/conflictResolver');
const { sendTransactionNotification } = require('../services/fcmNotificationService');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

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
    
    if (ownerUserId) {
      query += ` AND owner_user_id = $${paramIndex++}`;
      params.push(ownerUserId);
    }
    if (ownerFirebaseUid) {
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
    if (reservedWords.includes(transactionId.toLowerCase())) {
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
    
    // الحصول على ownerUserId الصحيح
    const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);
    
    const result = await pool.query(
      `INSERT INTO financial_transactions (
        transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
        client_id, account_id, client_firestore_id, account_firestore_id,
        transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
        notify_customer, is_synced, device_id, transaction_number, sync_version,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14), $15, $16, $17, $18, $19, to_timestamp($20), CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        (transactionData.transactionUuid && isValidUUID(transactionData.transactionUuid)) ? transactionData.transactionUuid : ((transactionData.entryId && isValidUUID(transactionData.entryId)) ? transactionData.entryId : uuidv4()),
        transactionData.cloudId || null,
        transactionData.firestoreId || null,
        ownerUserId,
        transactionData.ownerFirebaseUid || null,
        transactionData.customerId || transactionData.clientId,
        transactionData.accountId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
        transactionData.accountFirestoreId || null,
        transactionData.amount || transactionData.transactionAmount,
        transactionData.currency || transactionData.currencyCode || 'IQD',
        transactionData.direction || transactionData.transactionDirection,
        transactionData.note || transactionData.transactionNote || null,
        msToSeconds(transactionData.transactionDate || Date.now()),
        intToBoolean(transactionData.notifyCustomer !== undefined ? transactionData.notifyCustomer : 0),
        intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
        transactionData.deviceId || null,
        transactionData.transactionNumber || null,
        transactionData.syncVersion || 1,
        msToSeconds(transactionData.createdAt || Date.now())
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
      
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);
      
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
          notify_customer = COALESCE($15, notify_customer),
          is_synced = COALESCE($16, is_synced),
          device_id = COALESCE($17, device_id),
          transaction_number = COALESCE($18, transaction_number),
          sync_version = COALESCE($19, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE transaction_uuid = $1 AND deleted_at IS NULL
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId,
          transactionData.firestoreId,
          ownerUserId,
          transactionData.ownerFirebaseUid,
          clientId,
          accountId,
          transactionData.customerFirestoreId || transactionData.clientFirestoreId,
          transactionData.accountFirestoreId,
          transactionData.amount || transactionData.transactionAmount,
          transactionData.currency || transactionData.currencyCode || 'IQD',
          normalizeTransactionDirection(transactionData.direction || transactionData.transactionDirection),
          transactionData.note || transactionData.transactionNote,
          msToSeconds(transactionData.transactionDate),
          intToBoolean(transactionData.notifyCustomer),
          intToBoolean(transactionData.synced),
          transactionData.deviceId,
          transactionData.transactionNumber,
          transactionData.syncVersion || existingTransaction.sync_version || 0
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
      
      // ✅ إرسال إشعار FCM إذا كان notify_customer = true
      if (transaction.notify_customer) {
        // إرسال الإشعار في الخلفية (لا ننتظر النتيجة)
        setImmediate(async () => {
          try {
            // جلب بيانات العميل والمالك
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
              
              const result = await sendTransactionNotification(transaction, customer, owner);
              if (!result.success) {
                logger.warning('Transaction notification failed', {
                  transactionUuid: transaction.transaction_uuid,
                  reason: result.reason || result.error
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
            // لا نوقف العملية إذا فشل الإشعار
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
      // الحصول على ownerUserId الصحيح
      const ownerUserId = await normalizeOwnerUserId(transactionData.ownerUserId, transactionData.ownerFirebaseUid);
      
      // الحصول على clientId الصحيح
      const clientId = await normalizeClientId(
        transactionData.customerId || transactionData.clientId,
        transactionData.customerFirestoreId || transactionData.clientFirestoreId
      );
      
      // الحصول على accountId الصحيح
      let accountId = await normalizeAccountId(
        transactionData.accountId,
        transactionData.accountFirestoreId
      );
      
      // إذا كان accountFirestoreId هو "shared-main-account-v1" ولم يُوجد، أنشئه
      if (!accountId && transactionData.accountFirestoreId === 'shared-main-account-v1' && ownerUserId) {
        logger.info(`Creating shared main account with ownerUserId: ${ownerUserId}`);
        try {
          const sharedAccountUuid = '00000000-0000-0000-0000-000000000001';
          const now = Date.now();
          const createdAtSeconds = msToSeconds(now);
          const colorValue = 0xFF0A84FF;
          const colorHex = normalizeColorCode(colorValue);
          
          const createResult = await pool.query(
            `INSERT INTO cash_accounts (
              account_uuid, firestore_id, owner_user_id, owner_firebase_uid, account_name, is_primary, is_shared,
              color_code, sync_version, created_at, updated_at
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), CURRENT_TIMESTAMP)
            ON CONFLICT (account_uuid) DO UPDATE SET
              account_name = EXCLUDED.account_name,
              is_primary = EXCLUDED.is_primary,
              is_shared = EXCLUDED.is_shared,
              firestore_id = EXCLUDED.firestore_id,
              updated_at = CURRENT_TIMESTAMP
            RETURNING account_id`,
            [
              sharedAccountUuid,
              'shared-main-account-v1',
              ownerUserId,
              transactionData.ownerFirebaseUid || null,
              'الصندوق الرئيسي',
              true,
              true,
              colorHex,
              1,
              createdAtSeconds
            ]
          );
          
          if (createResult.rows.length > 0) {
            accountId = createResult.rows[0].account_id;
            logger.info(`Created shared main account with account_id: ${accountId}`);
          }
        } catch (error) {
          logger.error(`Error creating shared main account: ${error.message}`);
          if (error.code === '23505') {
            logger.info(`Account already exists, searching again...`);
            accountId = await getAccountIdFromFirestoreId('shared-main-account-v1');
          }
        }
      }
      
      if (!accountId) {
        logger.error('accountId is null in INSERT transaction', { transactionData });
        return res.status(400).json({
          success: false,
          error: 'accountId مطلوب - لا يمكن العثور على الحساب في قاعدة البيانات. يرجى التأكد من أن الحساب مسجل في النظام.'
        });
      }
      
      // إنشاء معاملة جديدة
      const result = await pool.query(
        `INSERT INTO financial_transactions (
          transaction_uuid, cloud_id, firestore_id, owner_user_id, owner_firebase_uid,
          client_id, account_id, client_firestore_id, account_firestore_id,
          transaction_amount, currency_code, transaction_direction, transaction_note, transaction_date,
          notify_customer, is_synced, device_id, transaction_number, sync_version,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, to_timestamp($14), $15, $16, $17, $18, $19, to_timestamp($20), CURRENT_TIMESTAMP)
        RETURNING *`,
        [
          uuid,
          transactionData.cloudId || null,
          transactionData.firestoreId || null,
          ownerUserId,
          transactionData.ownerFirebaseUid || null,
          clientId,
          accountId,
          transactionData.customerFirestoreId || transactionData.clientFirestoreId || null,
          transactionData.accountFirestoreId || null,
          transactionData.amount || transactionData.transactionAmount,
          transactionData.currency || transactionData.currencyCode || 'IQD',
          normalizeTransactionDirection(transactionData.direction || transactionData.transactionDirection),
          transactionData.note || transactionData.transactionNote || null,
          msToSeconds(transactionData.transactionDate || Date.now()),
          intToBoolean(transactionData.notifyCustomer !== undefined ? transactionData.notifyCustomer : 0),
          intToBoolean(transactionData.synced !== undefined ? transactionData.synced : 1),
          transactionData.deviceId || null,
          transactionData.transactionNumber || null,
          transactionData.syncVersion || 1,
          msToSeconds(transactionData.createdAt || Date.now())
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
      
      // ✅ إرسال إشعار FCM إذا كان notify_customer = true
      if (transaction.notify_customer) {
        // إرسال الإشعار في الخلفية (لا ننتظر النتيجة)
        setImmediate(async () => {
          try {
            // جلب بيانات العميل والمالك
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
              
              const result = await sendTransactionNotification(transaction, customer, owner);
              if (!result.success) {
                logger.warning('Transaction notification failed', {
                  transactionUuid: transaction.transaction_uuid,
                  reason: result.reason || result.error
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
            // لا نوقف العملية إذا فشل الإشعار
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
    
    // التحقق من أن transactionId ليس كلمة محجوزة
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(transactionId.toLowerCase())) {
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

/**
 * GET /api/transactions/debt-summary
 * الحصول على إحصائيات الديون (creditor summaries)
 * Query params:
 *   - currentUserPhone: رقم هاتف المستخدم الحالي
 *   - currentUserId: معرف المستخدم الحالي (local ID)
 *   - currentUserFirebaseUid: معرف Firebase للمستخدم الحالي
 */
async function getDebtSummary(req, res, next) {
  try {
    // 🔒 الأمان: استخدام req.user فقط (من المصادقة) - تجاهل جميع query parameters
    if (!req.user || !req.user.firebaseUid) {
      return res.status(401).json({
        success: false,
        error: 'مطلوب مصادقة صالحة'
      });
    }
    
    const ownerFirebaseUid = req.user.firebaseUid;
    
    logger.debug('getDebtSummary: Authenticated request', {
      userId: req.user.userId,
      firebaseUid: ownerFirebaseUid
    });
    
    // ✅ البحث عن جميع عملاء المستخدم الحالي
    const clientsResult = await pool.query(
      `SELECT client_id, owner_user_id, owner_firebase_uid, client_name, phone_number
       FROM business_clients
       WHERE owner_firebase_uid = $1 AND deleted_at IS NULL`,
      [ownerFirebaseUid]
    );
    
    const clients = clientsResult.rows;
    
    logger.debug('getDebtSummary: Found clients', {
      ownerFirebaseUid,
      clientsCount: clients.length,
      clientIds: clients.map(c => c.client_id)
    });
    
    if (clients.length === 0) {
      logger.debug('getDebtSummary: No clients found for user', { ownerFirebaseUid });
      return res.json({ success: true, data: [] });
    }
    
    // ✅ تجميع المعاملات حسب ownerFirebaseUid (الدائن)
    // نحتاج إلى المعاملات التي تم إنشاؤها من قبل مستخدمين آخرين (دائنين)
    const creditorMap = new Map();
    
    for (const client of clients) {
      const transactionsResult = await pool.query(
        `SELECT ft.*, bc.client_name, bc.phone_number
         FROM financial_transactions ft
         JOIN business_clients bc ON ft.client_id = bc.client_id
         WHERE ft.client_id = $1 
           AND ft.owner_firebase_uid != $2
           AND ft.owner_firebase_uid IS NOT NULL
           AND ft.deleted_at IS NULL
         ORDER BY ft.transaction_date DESC`,
        [client.client_id, ownerFirebaseUid]
      );
      
      for (const transaction of transactionsResult.rows) {
        const creditorUid = transaction.owner_firebase_uid;
        if (!creditorUid || creditorUid === ownerFirebaseUid) continue;
        
        if (!creditorMap.has(creditorUid)) {
          creditorMap.set(creditorUid, {
            creditorFirebaseUid: creditorUid,
            transactions: [],
            totalDebit: 0,
            totalCredit: 0,
            balancesByCurrency: {}
          });
        }
        
        const summary = creditorMap.get(creditorUid);
        summary.transactions.push(transaction);
        
        const amount = parseFloat(transaction.transaction_amount);
        const currency = transaction.currency_code || 'IQD';
        
        // ✅ قاعدة البيانات تحفظ income/expense، لكن نحتاج DEBIT/CREDIT
        const direction = transaction.transaction_direction;
        const isDebit = direction === 'expense' || direction === 'DEBIT';
        
        if (isDebit) {
          summary.totalDebit += amount;
          summary.balancesByCurrency[currency] = (summary.balancesByCurrency[currency] || 0) - amount;
        } else {
          summary.totalCredit += amount;
          summary.balancesByCurrency[currency] = (summary.balancesByCurrency[currency] || 0) + amount;
        }
      }
    }
    
    // جلب بيانات الدائنين من جدول app_users
    const creditors = [];
    for (const [creditorUid, summary] of creditorMap.entries()) {
      const userResult = await pool.query(
        'SELECT user_id, full_name, phone_number, job_title FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL',
        [creditorUid]
      );
      
      const user = userResult.rows[0];
      if (!user) continue;
      
      const netBalance = summary.totalCredit - summary.totalDebit;
      const lastTransaction = summary.transactions[0]; // تم ترتيبها DESC
      
      creditors.push({
        creditorName: user.full_name || 'مستخدم مجهول',
        creditorPhone: user.phone_number || '',
        creditorJobTitle: user.job_title || null,
        creditorFirebaseUid: creditorUid,
        totalDebit: summary.totalDebit,
        totalCredit: summary.totalCredit,
        netBalance: netBalance,
        transactionCount: summary.transactions.length,
        currency: lastTransaction.currency_code || 'IQD',
        lastTransactionDate: lastTransaction.transaction_date ? 
          Math.floor(new Date(lastTransaction.transaction_date).getTime()) : 
          Date.now(),
        balancesByCurrency: summary.balancesByCurrency
      });
    }
    
    // ترتيب حسب تاريخ آخر معاملة
    creditors.sort((a, b) => b.lastTransactionDate - a.lastTransactionDate);
    
    logger.debug('getDebtSummary: Returning creditors', {
      ownerFirebaseUid,
      creditorsCount: creditors.length,
      creditorUids: creditors.map(c => c.creditorFirebaseUid)
    });
    
    res.json({ success: true, data: creditors });
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
  getDebtSummary
};

