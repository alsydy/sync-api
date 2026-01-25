// ============================================================================
// FCM Token Controller
// ============================================================================
// Controller لـ FCM Tokens
// ============================================================================

const { pool } = require('../config/database');
const { secondsToMs } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * POST /api/fcm-tokens
 * تسجيل/تحديث FCM token للمستخدم
 */
async function registerFcmToken(req, res, next) {
  try {
    const {
      firebaseUid,
      token,
      deviceModel,
      deviceBrand,
      deviceManufacturer,
      appVersionName,
      appVersionCode
    } = req.body;

    logger.info(`Receiving FCM token registration request: firebaseUid=${firebaseUid}, token=${token?.substring(0, 20)}...`);

    // Input Validation
    if (!token) {
      logger.warning('Validation failed: token is required');
      return res.status(400).json({ success: false, error: 'token مطلوب' });
    }
    
    if (typeof token !== 'string' || token.trim().length === 0) {
      logger.warning('Validation failed: token is invalid');
      return res.status(400).json({ success: false, error: 'token غير صحيح' });
    }

    // Security: إذا كان المستخدم مصادقاً، استخدم firebaseUid من token
    let finalFirebaseUid = firebaseUid;
    if (req.user && req.user.firebaseUid) {
      finalFirebaseUid = req.user.firebaseUid;
      // Security: التحقق من أن المستخدم لا يسجل token لمستخدم آخر
      if (firebaseUid && firebaseUid !== req.user.firebaseUid) {
        logger.warning(`Security: User ${req.user.firebaseUid} attempted to register token for ${firebaseUid}`);
        return res.status(403).json({ 
          success: false, 
          error: 'ليس لديك صلاحية لتسجيل token لمستخدم آخر' 
        });
      }
    }

    if (!finalFirebaseUid) {
      return res.status(400).json({ success: false, error: 'firebaseUid مطلوب' });
    }

    // الحصول على user_id
    const userResult = await pool.query(
      'SELECT user_id FROM app_users WHERE firebase_uid = $1 AND deleted_at IS NULL',
      [finalFirebaseUid]
    );

    if (userResult.rows.length === 0) {
      logger.warning(`User not found: firebase_uid=${finalFirebaseUid}`);
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    const userId = userResult.rows[0].user_id;
    logger.info(`User found: user_id=${userId}, firebase_uid=${finalFirebaseUid}`);

    // التحقق من وجود token مسبقاً
    const existingTokenResult = await pool.query(
      'SELECT token_id, is_primary FROM user_fcm_tokens WHERE user_id = $1 AND token = $2',
      [userId, token]
    );

    if (existingTokenResult.rows.length > 0) {
      // تحديث token موجود
      const existingToken = existingTokenResult.rows[0];
      await pool.query(
        `UPDATE user_fcm_tokens 
         SET is_active = TRUE, 
             last_used_at = CURRENT_TIMESTAMP,
             device_model = COALESCE($1, device_model),
             device_brand = COALESCE($2, device_brand),
             device_manufacturer = COALESCE($3, device_manufacturer),
             app_version_name = COALESCE($4, app_version_name),
             app_version_code = COALESCE($5::INTEGER, app_version_code),
             updated_at = CURRENT_TIMESTAMP
         WHERE token_id = $6`,
        [
          deviceModel || null,
          deviceBrand || null,
          deviceManufacturer || null,
          appVersionName || null,
          appVersionCode ? parseInt(appVersionCode, 10) : null,
          existingToken.token_id
        ]
      );

      logger.info(`FCM token updated: user_id=${userId}, firebase_uid=${finalFirebaseUid}, token_id=${existingToken.token_id}`);

      return res.json({
        success: true,
        data: {
          tokenId: existingToken.token_id,
          isPrimary: existingToken.is_primary,
          message: 'تم تحديث FCM token بنجاح'
        }
      });
    }

    // إلغاء primary من جميع tokens الأخرى للمستخدم
    await pool.query(
      'UPDATE user_fcm_tokens SET is_primary = FALSE WHERE user_id = $1',
      [userId]
    );

    // إدراج token جديد
    const appVersionCodeInt = appVersionCode ? parseInt(appVersionCode, 10) : null;
    
    const result = await pool.query(
      `INSERT INTO user_fcm_tokens (
        user_id, firebase_uid, token, device_model, device_brand, 
        device_manufacturer, app_version_name, app_version_code, 
        is_active, is_primary, last_used_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        userId,
        finalFirebaseUid,
        token,
        deviceModel || null,
        deviceBrand || null,
        deviceManufacturer || null,
        appVersionName || null,
        appVersionCodeInt,
        true,
        true
      ]
    );

    const newToken = result.rows[0];
    
    logger.info(`FCM token registered successfully`, {
      user_id: userId,
      firebase_uid: finalFirebaseUid,
      token_id: newToken.token_id,
      token_uuid: newToken.token_uuid,
      device: `${deviceModel || 'N/A'} (${deviceBrand || 'N/A'})`,
      app_version: `${appVersionName || 'N/A'} (${appVersionCodeInt || 'N/A'})`
    });

    res.status(201).json({
      success: true,
      data: {
        tokenId: newToken.token_id,
        tokenUuid: newToken.token_uuid,
        isPrimary: newToken.is_primary,
        message: 'تم تسجيل FCM token بنجاح'
      }
    });
  } catch (error) {
    logger.error('Error registering FCM token', error);
    if (error.code === '23505') { // Unique constraint violation
      logger.warning('Token already registered (unique constraint)');
      return res.status(409).json({ success: false, error: 'هذا الـ token مسجل بالفعل' });
    }
    if (error.code === '42P01') { // Table does not exist
      logger.error('Table user_fcm_tokens does not exist! Migration script must be run');
      return res.status(500).json({ 
        success: false, 
        error: 'الجدول غير موجود. يرجى تشغيل migration script أولاً' 
      });
    }
    next(error);
  }
}

/**
 * GET /api/fcm-tokens/:firebaseUid
 * جلب جميع FCM tokens النشطة للمستخدم
 */
async function getFcmTokens(req, res, next) {
  try {
    const { firebaseUid } = req.params;

    // Security: إذا كان المستخدم مصادقاً، تحقق من أنه يطلب tokens لنفسه
    if (req.user && req.user.firebaseUid && req.user.firebaseUid !== firebaseUid) {
      return res.status(403).json({ 
        success: false, 
        error: 'ليس لديك صلاحية لعرض tokens لمستخدم آخر' 
      });
    }

    const result = await pool.query(
      `SELECT token_id, token_uuid, token, device_model, device_brand, 
              device_manufacturer, app_version_name, app_version_code,
              is_active, is_primary, last_used_at, created_at, updated_at
       FROM user_fcm_tokens 
       WHERE firebase_uid = $1 AND is_active = TRUE
       ORDER BY is_primary DESC, last_used_at DESC`,
      [firebaseUid]
    );

    const tokens = result.rows.map(row => ({
      tokenId: row.token_id,
      tokenUuid: row.token_uuid,
      token: row.token,
      deviceModel: row.device_model,
      deviceBrand: row.device_brand,
      deviceManufacturer: row.device_manufacturer,
      appVersionName: row.app_version_name,
      appVersionCode: row.app_version_code,
      isActive: row.is_active,
      isPrimary: row.is_primary,
      lastUsedAt: secondsToMs(row.last_used_at),
      createdAt: secondsToMs(row.created_at),
      updatedAt: secondsToMs(row.updated_at)
    }));

    res.json({ success: true, data: tokens });
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/fcm-tokens/:tokenId
 * حذف/تعطيل FCM token
 */
async function deleteFcmToken(req, res, next) {
  try {
    const { tokenId } = req.params;

    // Security: التحقق من أن المستخدم يملك هذا الـ token
    const tokenResult = await pool.query(
      'SELECT user_id, firebase_uid FROM user_fcm_tokens WHERE token_id = $1',
      [tokenId]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الـ token غير موجود' });
    }

    const token = tokenResult.rows[0];

    if (req.user && req.user.firebaseUid && req.user.firebaseUid !== token.firebase_uid) {
      return res.status(403).json({ 
        success: false, 
        error: 'ليس لديك صلاحية لحذف token لمستخدم آخر' 
      });
    }

    // تعطيل الـ token (soft delete)
    await pool.query(
      'UPDATE user_fcm_tokens SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE token_id = $1',
      [tokenId]
    );

    logger.info(`FCM token disabled: token_id=${tokenId}, firebase_uid=${token.firebase_uid}`);

    res.json({ success: true, message: 'تم تعطيل FCM token بنجاح' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  registerFcmToken,
  getFcmTokens,
  deleteFcmToken
};

