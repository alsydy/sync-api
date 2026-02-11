// ============================================================================
// Settings Controller
// ============================================================================
// Controller للإعدادات (Settings)
// ============================================================================

const { pool } = require('../config/database');
const { secondsToMs } = require('../utils/helpers');

/**
 * GET /api/settings/shared
 * الحصول على الإعدادات المشتركة
 */
async function getSharedSettings(req, res, next) {
  try {
    const result = await pool.query('SELECT * FROM app_shared_settings ORDER BY setting_key');
    
    const settings = result.rows.map(row => ({
      settingKey: row.setting_key,
      settingValue: row.setting_value,
      settingType: row.setting_type,
      category: row.category,
      description: row.description,
      updatedBy: row.updated_by,
      updatedAt: secondsToMs(row.updated_at)
    }));
    
    res.json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/settings/user/:firebaseUid
 * الحصول على إعدادات المستخدم
 */
async function getUserSettings(req, res, next) {
  try {
    const { firebaseUid } = req.params;
    
    const result = await pool.query(
      'SELECT * FROM user_control_settings WHERE firebase_uid = $1',
      [firebaseUid]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'الإعدادات غير موجودة' });
    }
    
    const setting = result.rows[0];
    res.json({
      success: true,
      data: {
        firebaseUid: setting.firebase_uid,
        syncEnabled: setting.sync_enabled,
        updatedBy: setting.updated_by,
        updatedAt: secondsToMs(setting.updated_at)
      }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getSharedSettings,
  getUserSettings
};

