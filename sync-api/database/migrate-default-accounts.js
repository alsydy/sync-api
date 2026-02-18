// ============================================================================
// Migration: Add template_key + per-user default accounts
// ============================================================================

require('dotenv').config();
const { pool } = require('../config/database');
const { ensureDefaultAccounts } = require('../services/defaultAccountsService');

async function migrateDefaultAccounts() {
  const client = await pool.connect();
  try {
    console.log('Starting migration: template_key + default accounts');
    await client.query('BEGIN');

    await client.query('ALTER TABLE cash_accounts ADD COLUMN IF NOT EXISTS template_key VARCHAR(32);');
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_accounts_user_template
      ON cash_accounts(owner_user_id, template_key)
      WHERE template_key IS NOT NULL
    `);

    await client.query('UPDATE cash_accounts SET is_shared = FALSE WHERE template_key IS NOT NULL;');

    await client.query('COMMIT');
    console.log('Schema updated');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Schema update failed', error);
    throw error;
  } finally {
    client.release();
  }

  const usersResult = await pool.query(
    'SELECT user_id FROM app_users WHERE deleted_at IS NULL ORDER BY user_id ASC'
  );

  let processed = 0;
  for (const row of usersResult.rows) {
    await ensureDefaultAccounts(row.user_id, pool);
    processed += 1;
    if (processed % 100 === 0) {
      console.log(`Processed ${processed}/${usersResult.rows.length} users`);
    }
  }

  console.log(`Done. Ensured defaults for ${processed} users.`);

  try {
    const moveResult = await pool.query(`
      WITH shared_accounts AS (
        SELECT account_id
        FROM cash_accounts
        WHERE is_shared = TRUE
          AND deleted_at IS NULL
      ),
      main_accounts AS (
        SELECT owner_user_id, account_id, firestore_id
        FROM cash_accounts
        WHERE template_key = 'main'
          AND deleted_at IS NULL
      )
      UPDATE financial_transactions ft
      SET account_id = ma.account_id,
          account_firestore_id = ma.firestore_id
      FROM main_accounts ma
      WHERE ft.account_id IN (SELECT account_id FROM shared_accounts)
        AND ft.owner_user_id = ma.owner_user_id
        AND ft.deleted_at IS NULL
    `);
    console.log(`Reassigned ${moveResult.rowCount || 0} transactions from shared accounts`);
  } catch (error) {
    console.warn('Skipping shared transaction reassignment:', error.message || error);
  }

  await pool.end();
}

migrateDefaultAccounts().catch((error) => {
  console.error('Migration failed', error);
  process.exit(1);
});
