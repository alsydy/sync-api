// ============================================================================
// User Controller
// ============================================================================
// Controller للمستخدمين
// ============================================================================

const { pool } = require('../config/database');
const { generateToken } = require('../middleware/auth');
const {
  ensureUuid,
  isValidUUID,
  msToSeconds,
  intToBoolean,
  normalizeOwnerUserId
} = require('../utils/helpers');
const { mapUserToAPI, mapAccountToAPI } = require('../utils/mappers');
const { logAudit } = require('../services/auditService');
const { resolveConflict } = require('../services/conflictResolver');
const { ensureDefaultAccounts } = require('../services/defaultAccountsService');
const { validatePrivacyPolicyAcceptance, recordPrivacyPolicyAcceptance } = require('../services/privacyPolicyService');
const { handleError } = require('../middleware/errorHandler');
const { getPaginationParams, createPaginationResponse } = require('../utils/pagination');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

/**
 * الحصول على مستخدم حسب ID
 */
async function getUserById(req, res) {
  try {
    const { userId } = req.params;
    
    // التحقق من أن userId ليس كلمة محجوزة
    const reservedWords = ['sync', 'health', 'info', 'stats'];
    if (reservedWords.includes(userId.toLowerCase())) {
      return res.status(400).json({
        success: false,
        error: `Invalid user ID: "${userId}" is a reserved word`
      });
    }
    
    // التحقق من أن userId هو رقم
    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid user ID format: "${userId}" must be a number`
      });
    }
    
    const result = await pool.query(
      'SELECT * FROM app_users WHERE user_id = $1 AND deleted_at IS NULL',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    logger.info('User retrieved by ID', { userId, requestId: req.id });

    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    logger.errorMsg('Error getting user by ID', {
      error: error.message,
      userId: req.params.userId,
      requestId: req.id
    });
    handleError(res, error);
  }
}

/**
 * الحصول على مستخدم حسب UUID
 */
async function getUserByUuid(req, res) {
  try {
    const { userUuid } = req.params;
    const result = await pool.query(
      'SELECT * FROM app_users WHERE user_uuid = $1 AND deleted_at IS NULL',
      [userUuid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    logger.info('User retrieved by UUID', { userUuid, requestId: req.id });

    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    logger.errorMsg('Error getting user by UUID', {
      error: error.message,
      userUuid: req.params.userUuid,
      requestId: req.id
    });
    handleError(res, error);
  }
}

/**
 * الحصول على مستخدم حسب Firebase UID
 */
async function getUserByFirebaseUid(req, res) {
  try {
    const { firebaseUid } = req.params;
    if (!firebaseUid) {
      return res.status(400).json({ success: false, error: 'firebaseUid مطلوب' });
    }
    
    const result = await pool.query(
      'SELECT * FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL',
      [firebaseUid]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }
    
    logger.info('User retrieved by Firebase UID', { firebaseUid, requestId: req.id });
    
    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    logger.errorMsg('Error getting user by Firebase UID', {
      error: error.message,
      firebaseUid: req.params.firebaseUid,
      requestId: req.id
    });
    handleError(res, error);
  }
}

/**
 * الحصول على مستخدم حسب رقم الهاتف
 */
async function getUserByPhone(req, res) {
  try {
    const { phone } = req.params;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone مطلوب' });
    }
    
    const result = await pool.query(
      'SELECT * FROM app_users WHERE phone_number = $1 AND deleted_at IS NULL LIMIT 1',
      [phone]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }
    
    logger.info('User retrieved by phone', { phone, requestId: req.id });
    
    res.json({ success: true, data: mapUserToAPI(result.rows[0]) });
  } catch (error) {
    logger.errorMsg('Error getting user by phone', {
      error: error.message,
      phone: req.params.phone,
      requestId: req.id
    });
    handleError(res, error);
  }
}

/**
 * إنشاء مستخدم جديد
 */
async function createUser(req, res) {
  const client = await pool.connect();
  try {
    const userData = ensureUuid(req.body);

    // التحقق من الحقول المطلوبة
    if (!userData.name && !userData.fullName) {
      return res.status(400).json({ success: false, error: 'name أو fullName مطلوب' });
    }
    if (!userData.phone && !userData.phoneNumber) {
      return res.status(400).json({ success: false, error: 'phone أو phoneNumber مطلوب' });
    }
    if (!userData.passwordHash) {
      return res.status(400).json({ success: false, error: 'passwordHash مطلوب' });
    }
    if (!userData.passwordSalt) {
      return res.status(400).json({ success: false, error: 'passwordSalt مطلوب' });
    }

    // التأكد من وجود UUID صحيح
    const userUuid = (userData.userUuid && isValidUUID(userData.userUuid))
      ? userData.userUuid
      : ((userData.entryId && isValidUUID(userData.entryId))
          ? userData.entryId
          : uuidv4());

    let accountNumber = userData.accountNumber;
    const createdAtSeconds = msToSeconds(userData.createdAt || Date.now());

    await client.query('BEGIN');

    // التحقق من الموافقة على سياسة الخصوصية (إذا كانت منشورة)
    const policyCheck = await validatePrivacyPolicyAcceptance(client, userData);
    if (policyCheck.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: policyCheck.error });
    }

    // توليد رقم الحساب تلقائياً في السيرفر إذا لم يتم إرساله
    if (!accountNumber) {
      await client.query('SELECT pg_advisory_xact_lock(424242)');

      const maxResult = await client.query('SELECT MAX(account_number) AS max FROM app_users WHERE deleted_at IS NULL');
      const maxFromUsers = maxResult.rows[0]?.max ? parseInt(maxResult.rows[0].max, 10) : 0;

      const registryResult = await client.query('SELECT MAX(account_number) AS max FROM account_numbers_registry');
      const maxFromRegistry = registryResult.rows[0]?.max ? parseInt(registryResult.rows[0].max, 10) : 0;

      const maxNumber = Math.max(maxFromUsers, maxFromRegistry, 0);
      accountNumber = maxNumber + 1;

      await client.query(
        `INSERT INTO account_numbers_registry (
          account_number, user_id, user_name, phone_number, firebase_uid, is_active, created_at
        ) VALUES ($1, NULL, $2, $3, $4, TRUE, CURRENT_TIMESTAMP)
        ON CONFLICT (account_number) DO NOTHING`,
        [
          accountNumber,
          userData.name || userData.fullName || null,
          userData.phone || userData.phoneNumber || null,
          userData.firebaseUid || null
        ]
      );

      logger.info('Account number generated', { accountNumber, requestId: req.id });
    }

    const result = await client.query(
      `INSERT INTO app_users (
        user_uuid, firebase_uid, full_name, phone_number, job_title,
        password_hash, password_salt, account_number,
        created_at, app_version_name, app_version_code,
        device_model, device_brand, device_manufacturer,
        device_sdk_int, push_token, receive_transaction_notifications, sync_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        userUuid,
        userData.firebaseUid || null,
        userData.name || userData.fullName,
        userData.phone || userData.phoneNumber,
        userData.jobTitle || null,
        userData.passwordHash,
        userData.passwordSalt,
        accountNumber,
        createdAtSeconds,
        userData.appVersionName || null,
        userData.appVersionCode || null,
        userData.deviceModel || null,
        userData.deviceBrand || null,
        userData.deviceManufacturer || null,
        userData.deviceSdkInt || null,
        userData.accountPushToken || userData.pushToken || null,
        intToBoolean(userData.receiveTransactionNotifications !== undefined ? userData.receiveTransactionNotifications : 1),
        userData.syncVersion || 1
      ]
    );

    const user = result.rows[0];
    const defaultAccounts = await ensureDefaultAccounts(user.user_id, client);

    // تسجيل موافقة سياسة الخصوصية (إن وجدت سياسة فعّالة)
    if (policyCheck.policy && policyCheck.acceptedAtSeconds) {
      await recordPrivacyPolicyAcceptance(
        client,
        user.user_id,
        policyCheck.policy.policy_id,
        policyCheck.acceptedAtSeconds,
        req,
        userData.deviceId || userData.device_id || null
      );
    }

    await client.query('COMMIT');

    // تسجيل العملية
    await logAudit(user.user_id, user.firebase_uid, 'create', 'user', user.user_id.toString(), null, user, req);

    // إنشاء JWT token للمستخدم الجديد
    const token = generateToken(user.user_id, user.firebase_uid);

    logger.success('User created', {
      userId: user.user_id,
      firebaseUid: user.firebase_uid,
      accountNumber: user.account_number,
      requestId: req.id
    });

    res.status(201).json({
      success: true,
      data: {
        token,
        user: mapUserToAPI(user),
        accounts: defaultAccounts.map(mapAccountToAPI)
      }
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'المستخدم موجود بالفعل (رقم الهاتف أو UUID مكرر)' });
    }
    logger.errorMsg('Error creating user', {
      error: error.message,
      requestId: req.id
    });
    handleError(res, error);
  } finally {
    client.release();
  }
}

/**
 * مزامنة مستخدم (Insert or Update حسب UUID)
 */
async function syncUser(req, res) {
  try {
    const userData = ensureUuid(req.body);
    const uuid = userData.userUuid || (userData.entryId && isValidUUID(userData.entryId) ? userData.entryId : uuidv4());
    
    if (!uuid) {
      return res.status(400).json({ success: false, error: 'userUuid أو entryId مطلوب' });
    }
    
    // البحث عن المستخدم بناءً على user_uuid أولاً
    let existing = await pool.query(
      'SELECT user_id, sync_version, updated_at, user_uuid, firebase_uid FROM app_users WHERE user_uuid = $1',
      [uuid]
    );
    
    // إذا لم يوجد بناءً على user_uuid، ابحث بناءً على firebase_uid
    if (existing.rows.length === 0 && userData.firebaseUid) {
      logger.debug('User not found by UUID, searching by Firebase UID', {
        uuid,
        firebaseUid: userData.firebaseUid,
        requestId: req.id
      });
      
      existing = await pool.query(
        'SELECT user_id, sync_version, updated_at, user_uuid, firebase_uid FROM app_users WHERE firebase_uid = $1',
        [userData.firebaseUid]
      );
      
      if (existing.rows.length > 0) {
        const foundUser = existing.rows[0];
        const existingUuid = foundUser.user_uuid;
        
        // حل التعارضات إذا لزم الأمر
        if (userData.syncVersion && foundUser.sync_version) {
          const conflictResult = await resolveConflict('app_users', existingUuid, userData, {
            syncVersion: foundUser.sync_version,
            updatedAt: foundUser.updated_at ? new Date(foundUser.updated_at).getTime() : 0
          });
          
          if (conflictResult.winner !== userData) {
            const remoteUser = await pool.query('SELECT * FROM app_users WHERE user_uuid = $1', [existingUuid]);
            const user = remoteUser.rows[0];
            return res.json({
              success: true,
              data: mapUserToAPI(user),
              action: 'conflict_resolved',
              conflict: true,
              conflictReason: conflictResult.reason
            });
          }
        }
        
        // تحديث المستخدم الموجود
        const result = await pool.query(
          `UPDATE app_users SET
            firebase_uid = COALESCE($2, firebase_uid),
            full_name = $3,
            phone_number = $4,
            job_title = COALESCE($5, job_title),
            password_hash = COALESCE($6, password_hash),
            password_salt = COALESCE($7, password_salt),
            account_number = COALESCE($8, account_number),
            app_version_name = COALESCE($9, app_version_name),
            app_version_code = COALESCE($10, app_version_code),
            device_model = COALESCE($11, device_model),
            device_brand = COALESCE($12, device_brand),
            device_manufacturer = COALESCE($13, device_manufacturer),
            device_sdk_int = COALESCE($14, device_sdk_int),
            push_token = COALESCE($15, push_token),
            receive_transaction_notifications = COALESCE($16, receive_transaction_notifications),
            sync_version = COALESCE($17, sync_version) + 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_uuid = $1
          RETURNING *`,
          [
            existingUuid,
            userData.firebaseUid,
            userData.name || userData.fullName,
            userData.phone || userData.phoneNumber,
            userData.jobTitle,
            userData.passwordHash,
            userData.passwordSalt,
            userData.accountNumber,
            userData.appVersionName,
            userData.appVersionCode,
            userData.deviceModel,
            userData.deviceBrand,
            userData.deviceManufacturer,
            userData.deviceSdkInt,
            userData.accountPushToken || userData.pushToken,
            intToBoolean(userData.receiveTransactionNotifications),
            userData.syncVersion || foundUser.sync_version || 0
          ]
        );

        const user = result.rows[0];
        await logAudit(user.user_id, user.firebase_uid, 'update', 'user', user.user_id.toString(), foundUser, user, req);
        
        logger.info('User updated via sync', {
          userId: user.user_id,
          uuid: existingUuid,
          requestId: req.id
        });
        
        return res.json({ success: true, data: mapUserToAPI(user), action: 'updated' });
      }
    }
    
    // إذا كان المستخدم موجوداً، قم بالتحديث
    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      
      // حل التعارضات إذا لزم الأمر
      if (userData.syncVersion && existingUser.sync_version) {
        const conflictResult = await resolveConflict('app_users', uuid, userData, {
          syncVersion: existingUser.sync_version,
          updatedAt: existingUser.updated_at ? new Date(existingUser.updated_at).getTime() : 0
        });
        
        if (conflictResult.winner !== userData) {
          const remoteUser = await pool.query('SELECT * FROM app_users WHERE user_uuid = $1', [uuid]);
          const user = remoteUser.rows[0];
          return res.json({
            success: true,
            data: mapUserToAPI(user),
            action: 'conflict_resolved',
            conflict: true,
            conflictReason: conflictResult.reason
          });
        }
      }
      
      // تحديث المستخدم
      const result = await pool.query(
        `UPDATE app_users SET
          firebase_uid = COALESCE($2, firebase_uid),
          full_name = $3,
          phone_number = $4,
          job_title = COALESCE($5, job_title),
          password_hash = COALESCE($6, password_hash),
          password_salt = COALESCE($7, password_salt),
          account_number = COALESCE($8, account_number),
          app_version_name = COALESCE($9, app_version_name),
          app_version_code = COALESCE($10, app_version_code),
          device_model = COALESCE($11, device_model),
          device_brand = COALESCE($12, device_brand),
          device_manufacturer = COALESCE($13, device_manufacturer),
          device_sdk_int = COALESCE($14, device_sdk_int),
          push_token = COALESCE($15, push_token),
          receive_transaction_notifications = COALESCE($16, receive_transaction_notifications),
          sync_version = COALESCE($17, sync_version) + 1,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_uuid = $1
        RETURNING *`,
        [
          uuid,
          userData.firebaseUid,
          userData.name || userData.fullName,
          userData.phone || userData.phoneNumber,
          userData.jobTitle,
          userData.passwordHash,
          userData.passwordSalt,
          userData.accountNumber,
          userData.appVersionName,
          userData.appVersionCode,
          userData.deviceModel,
          userData.deviceBrand,
          userData.deviceManufacturer,
          userData.deviceSdkInt,
          userData.accountPushToken || userData.pushToken,
          intToBoolean(userData.receiveTransactionNotifications),
          userData.syncVersion || existingUser.sync_version || 0
        ]
      );

      const user = result.rows[0];
      await logAudit(user.user_id, user.firebase_uid, 'update', 'user', user.user_id.toString(), existingUser, user, req);
      
      logger.info('User updated via sync', {
        userId: user.user_id,
        uuid,
        requestId: req.id
      });
      
      return res.json({ success: true, data: mapUserToAPI(user), action: 'updated' });
    }
    
    // إنشاء مستخدم جديد
    const createdAtSeconds = msToSeconds(userData.createdAt || Date.now());
    
    const result = await pool.query(
      `INSERT INTO app_users (
        user_uuid, firebase_uid, full_name, phone_number, job_title,
        password_hash, password_salt, account_number,
        created_at, app_version_name, app_version_code,
        device_model, device_brand, device_manufacturer,
        device_sdk_int, push_token, receive_transaction_notifications, sync_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        uuid,
        userData.firebaseUid || null,
        userData.name || userData.fullName,
        userData.phone || userData.phoneNumber,
        userData.jobTitle || null,
        userData.passwordHash,
        userData.passwordSalt,
        userData.accountNumber || null,
        createdAtSeconds,
        userData.appVersionName || null,
        userData.appVersionCode || null,
        userData.deviceModel || null,
        userData.deviceBrand || null,
        userData.deviceManufacturer || null,
        userData.deviceSdkInt || null,
        userData.accountPushToken || userData.pushToken || null,
        intToBoolean(userData.receiveTransactionNotifications !== undefined ? userData.receiveTransactionNotifications : 1),
        userData.syncVersion || 1
      ]
    );

    const user = result.rows[0];
    await logAudit(user.user_id, user.firebase_uid, 'create', 'user', user.user_id.toString(), null, user, req);
    
    logger.success('User created via sync', {
      userId: user.user_id,
      uuid,
      requestId: req.id
    });
    
    res.status(201).json({ success: true, data: mapUserToAPI(user), action: 'created' });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ success: false, error: 'المستخدم موجود بالفعل' });
    }
    logger.errorMsg('Error syncing user', {
      error: error.message,
      requestId: req.id
    });
    handleError(res, error);
  }
}

module.exports = {
  getUserById,
  getUserByUuid,
  getUserByFirebaseUid,
  getUserByPhone,
  createUser,
  syncUser
};

