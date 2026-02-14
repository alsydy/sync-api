// utils/phone.js (sync-api)
// npm i libphonenumber-js

const { parsePhoneNumberFromString } = require('libphonenumber-js');

/**
 * toE164(raw, defaultCountry?)
 * - ✅ Any country: if raw includes +<cc> or 00<cc>
 * - ✅ Local numbers: uses defaultCountry (env DEFAULT_PHONE_COUNTRY or 'YE')
 * - ✅ Yemen smart heuristic for common local formats (7xxxxxxxx / 07xxxxxxxx)
 *
 * ملاحظة مهمة:
 * إذا الرقم "محلي" بدون + وبدون 00 ولا يوجد defaultCountry صحيح،
 * لا يمكن معرفة الدولة بشكل مؤكد.
 */
function toE164(raw, defaultCountry = process.env.DEFAULT_PHONE_COUNTRY || 'YE') {
  if (raw == null) return null;

  let s = String(raw).trim();
  if (!s) return null;

  // keep digits and leading +
  s = s.replace(/[^\d+]/g, '');

  // 00 -> +
  if (s.startsWith('00')) s = '+' + s.slice(2);

  // International format => ANY country
  if (s.startsWith('+')) {
    const pn = parsePhoneNumberFromString(s);
    if (!pn || !pn.isValid()) return null;
    return pn.number; // +E164
  }

  // Local format (no +): keep digits only
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  // ---- Yemen smart normalization (optional but helpful) ----
  // Common Yemen mobile numbers:
  // - 9 digits starts with 7: 7xxxxxxxx  => +9677xxxxxxxx
  // - 10 digits starts with 0 then 7: 07xxxxxxxx => +9677xxxxxxxx
  if ((defaultCountry || '').toUpperCase() === 'YE') {
    if (digits.length === 10 && digits.startsWith('0')) {
      digits = digits.slice(1);
    }
    if (digits.length === 9 && digits.startsWith('7')) {
      const forced = '+967' + digits;
      const pnForced = parsePhoneNumberFromString(forced);
      if (pnForced && pnForced.isValid()) return pnForced.number;
      // if not valid, fall back below
    }
  }

  // Fallback: parse local digits using defaultCountry
  const pn = parsePhoneNumberFromString(digits, defaultCountry);
  if (!pn || !pn.isValid()) return null;
  return pn.number; // +E164
}

/**
 * toChatId(e164)
 * +967775410201 -> 967775410201@c.us
 */
function toChatId(e164) {
  if (!e164) return null;
  const digits = String(e164).replace(/[^\d]/g, '');
  if (!digits) return null;
  return `${digits}@c.us`;
}

module.exports = { toE164, toChatId };
