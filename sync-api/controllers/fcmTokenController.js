// ============================================================================
// FCM Token Controller
// ============================================================================

const { pool } = require('../config/database');
const { secondsToMs } = require('../utils/helpers');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/auth');

/**
 * استخراج firebaseUid من Authorization header (احتياط)
 */
function extractFirebaseUidFromAuthHeader(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.substring(7).trim();
  const decoded = verifyToken(token);
  if (!decoded || !decoded.firebaseUid) return null;

  return decoded.firebaseUid;
}

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

    const hasAuthHeader = !!req.headers.authorization;
    logger.info(
      `Receiving FCM token registration request: firebaseUid=${firebaseUid || 'null'}, token=${token?.substring(0, 20)}..., authHeader=${hasAuthHeader}`
    );

    // Input Validation
    if (!token) {
      logger.warning('Validation failed: token is required');
      return res.status(400).json({ success: false, error: 'token مطلوب' });
    }

    if (typeof token !== 'string' || token.trim().length === 0) {
      logger.warning('Validation failed: token is invalid');
      return res.status(400).json({ success: false, error: 'token غير صحيح' });
    }

    // 1) الأفضل: firebaseUid من req.user (لو token verified)
    let finalFirebaseUid = null;

    if (req.user && req.user.firebaseUid) {
      finalFirebaseUid = req.user.firebaseUid;

      // Security: منع تسجيل token لمستخدم آخر
      if (firebaseUid && firebaseUid !== req.user.firebaseUid) {
        logger.warning(`Security: User ${req.user.firebaseUid} attempted to register token for ${firebaseUid}`);
        return res.status(403).json({
          success: false,
          error: 'ليس لديك صلاحية لتسجيل token لمستخدم آخر'
        });
      }
    } else {
      // 2) احتياط: حاول استخراجها مباشرة من Authorization
      const headerUid = extractFirebaseUidFromAuthHeader(req);
      if (headerUid) {
        finalFirebaseUid = headerUid;

        // لو أرسل firebaseUid مختلف في body نمنع
        if (firebaseUid && firebaseUid !== headerUid) {
          logger.warning(`Security: headerUid=${headerUid} but body firebaseUid=${firebaseUid}`);
          return res.status(403).json({
            success: false,
            error: 'ليس لديك صلاحية لتسجيل token لمستخدم آخر'
          });
        }
      } else {
        // 3) كآخر حل: body firebaseUid (لو موثق عندك بطريقة ثانية)
        finalFirebaseUid = firebaseUid || null;

        // إذا كان فيه Authorization لكن ما قدرنا نفكه -> هذا غالباً JWT_SECRET مختلف
        if (!finalFirebaseUid && hasAuthHeader) {
          logger.warning(
            'Auth header present but token verify failed. Check JWT_SECRET on the server (Render) matches the one used to sign tokens.'
          );
          return res.status(401).json({
            success: false,
            error: 'Token غير صالح (تحقق من JWT_SECRET على الخادم)'
          });
        }
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

    if (error.code === '23505') {
      logger.warning('Token already registered (unique constraint)');
      return res.status(409).json({ success: false, error: 'هذا الـ token مسجل بالفعل' });
    }

    if (error.code === '42P01') {
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
 */
async function getFcmTokens(req, res, next) {
  try {
    const { firebaseUid } = req.params;

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
 */
async function deleteFcmToken(req, res, next) {
  try {
    const { tokenId } = req.params;

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
