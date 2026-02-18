// Default Accounts Service
// ============================================================================
// Ensures per-user default accounts (main + transfer)
// ============================================================================

const { pool } = require('../config/database');
const { msToSeconds, normalizeColorCode } = require('../utils/helpers');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_TEMPLATES = [
  { key: 'main', name: 'الصندوق الرئيسي', isPrimary: true, color: normalizeColorCode(0xFF0A84FF) },
  { key: 'transfer', name: 'تحويل بين الحسابات', isPrimary: false, color: normalizeColorCode(0xFF4CAF50) }
];

async function ensureDefaultAccounts(userId, client = pool) {
  if (!userId) return [];

  const nowSeconds = msToSeconds(Date.now());

  const insertSql = `
    INSERT INTO cash_accounts (
      account_uuid, firestore_id, owner_user_id, account_name, is_primary, is_shared,
      template_key, color_code, sync_version, created_at, updated_at
    ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), CURRENT_TIMESTAMP)
    ON CONFLICT (owner_user_id, template_key) DO NOTHING
  `;

  for (const t of DEFAULT_TEMPLATES) {
    const uuid = uuidv4();
    try {
      await client.query(insertSql, [
        uuid,
        uuid,
        userId,
        t.name,
        t.isPrimary,
        false,
        t.key,
        t.color,
        1,
        nowSeconds
      ]);
    } catch (error) {
      logger.warning('ensureDefaultAccounts insert failed', {
        userId,
        templateKey: t.key,
        error: error.message
      });
      throw error;
    }
  }

  const result = await client.query(
    `SELECT * FROM cash_accounts
     WHERE owner_user_id = $1
       AND template_key IN ('main','transfer')
       AND deleted_at IS NULL
     ORDER BY (template_key = 'main') DESC, account_id ASC`,
    [userId]
  );

  return result.rows;
}

module.exports = {
  ensureDefaultAccounts,
  DEFAULT_TEMPLATES
};
