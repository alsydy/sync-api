// ============================================================================
// Bootstrap Controller
// ============================================================================
// Ensures default accounts and returns user + accounts
// ============================================================================

const { pool } = require('../config/database');
const { mapUserToAPI, mapAccountToAPI } = require('../utils/mappers');
const { ensureDefaultAccounts } = require('../services/defaultAccountsService');

async function bootstrap(req, res, next) {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    await ensureDefaultAccounts(userId);

    const [userResult, accountsResult] = await Promise.all([
      pool.query('SELECT * FROM app_users WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1', [userId]),
      pool.query(
        `SELECT * FROM cash_accounts
         WHERE owner_user_id = $1 AND deleted_at IS NULL
         ORDER BY (template_key IS NOT NULL) DESC, is_primary DESC, account_id ASC`,
        [userId]
      )
    ]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'المستخدم غير موجود' });
    }

    res.json({
      success: true,
      data: {
        user: mapUserToAPI(userResult.rows[0]),
        accounts: accountsResult.rows.map(mapAccountToAPI),
        serverTime: Date.now()
      }
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  bootstrap
};
