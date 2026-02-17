// ============================================================================
// Privacy Policy Service
// ============================================================================
// خدمة سياسات الخصوصية (جلب السياسة الفعّالة والتحقق من الموافقة)
// ============================================================================

const { pool } = require('../config/database');
const { msToSeconds } = require('../utils/helpers');

async function getActivePrivacyPolicy(client = pool) {
  const result = await client.query(
    `SELECT policy_id, title, version, is_active, published_at, updated_at
     FROM privacy_policies
     WHERE is_active = TRUE
     ORDER BY published_at DESC NULLS LAST, policy_id DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

function extractPrivacyPolicyAcceptance(userData) {
  const policyId =
    userData.privacyPolicyId ||
    userData.privacyPolicyVersion ||
    userData.policyId ||
    userData.privacy_policy_id ||
    userData.privacy_policy_version ||
    null;

  const acceptedAt =
    userData.privacyPolicyAcceptedAt ||
    userData.privacyPolicyAcceptedAtMs ||
    userData.privacyPolicyAcceptedAtMillis ||
    userData.privacy_policy_accepted_at ||
    null;

  return { policyId, acceptedAt };
}

async function validatePrivacyPolicyAcceptance(client, userData) {
  const activePolicy = await getActivePrivacyPolicy(client);
  if (!activePolicy) {
    return { policy: null };
  }

  const { policyId, acceptedAt } = extractPrivacyPolicyAcceptance(userData);
  const normalizedPolicyId = policyId !== null && policyId !== undefined
    ? parseInt(policyId, 10)
    : null;

  if (!Number.isFinite(normalizedPolicyId)) {
    return { error: 'يجب الموافقة على سياسة الخصوصية قبل إنشاء الحساب' };
  }

  if (normalizedPolicyId !== activePolicy.policy_id) {
    return { error: 'سياسة الخصوصية المعتمدة غير مطابقة للإصدار الحالي' };
  }

  const acceptedAtSeconds = msToSeconds(acceptedAt);
  if (!acceptedAtSeconds) {
    return { error: 'تاريخ الموافقة على سياسة الخصوصية مطلوب' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000) + 60;
  if (acceptedAtSeconds > nowSeconds) {
    return { error: 'تاريخ الموافقة على سياسة الخصوصية غير صالح' };
  }

  return { policy: activePolicy, acceptedAtSeconds };
}

async function recordPrivacyPolicyAcceptance(client, userId, policyId, acceptedAtSeconds, req, deviceId = null) {
  await client.query(
    `INSERT INTO privacy_policy_acceptances (
       user_id, policy_id, accepted_at, ip_address, user_agent, device_id
     ) VALUES ($1, $2, to_timestamp($3), $4, $5, $6)
     ON CONFLICT (user_id, policy_id) DO NOTHING`,
    [
      userId,
      policyId,
      acceptedAtSeconds,
      req?.ip || null,
      req?.headers?.['user-agent'] || null,
      deviceId
    ]
  );
}

module.exports = {
  getActivePrivacyPolicy,
  validatePrivacyPolicyAcceptance,
  recordPrivacyPolicyAcceptance
};
