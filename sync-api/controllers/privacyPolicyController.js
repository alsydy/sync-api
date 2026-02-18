// ============================================================================
// Privacy Policy Controller
// ============================================================================
// Controller لسياسة الخصوصية
// ============================================================================

const { pool } = require('../config/database');
const { secondsToMs } = require('../utils/helpers');
const { handleError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

/**
 * GET /api/privacy-policy
 * الحصول على سياسة الخصوصية الفعّالة
 */
async function getActivePrivacyPolicy(req, res) {
  try {
    const policyResult = await pool.query(
      `SELECT policy_id, title, version, published_at, updated_at
       FROM privacy_policies
       WHERE is_active = TRUE
       ORDER BY published_at DESC NULLS LAST, policy_id DESC
       LIMIT 1`
    );

    if (policyResult.rows.length === 0) {
      return res.json({ success: true, data: null });
    }

    const policy = policyResult.rows[0];

    const itemsResult = await pool.query(
      `SELECT item_id, item_order, item_text
       FROM privacy_policy_items
       WHERE policy_id = $1 AND is_active = TRUE
       ORDER BY item_order ASC, item_id ASC`,
      [policy.policy_id]
    );

    const items = itemsResult.rows.map((row) => ({
      itemId: row.item_id,
      order: row.item_order,
      text: row.item_text
    }));

    res.json({
      success: true,
      data: {
        policyId: policy.policy_id,
        title: policy.title,
        version: policy.version,
        publishedAt: policy.published_at ? secondsToMs(policy.published_at) : null,
        updatedAt: policy.updated_at ? secondsToMs(policy.updated_at) : null,
        items
      }
    });
  } catch (error) {
    logger.errorMsg('Error getting privacy policy', {
      error: error.message,
      requestId: req.id
    });
    handleError(res, error);
  }
}

module.exports = {
  getActivePrivacyPolicy
};
