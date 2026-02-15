// utils/phone.js (sync-api)
const { parsePhoneNumberFromString } = require('libphonenumber-js');

function toE164(raw, defaultCountry = 'YE') {
  if (!raw) return null;

  let s = String(raw).trim();
  if (!s) return null;

  // keep digits and leading +
  s = s.replace(/[^\d+]/g, '');

  // 00 -> +
  if (s.startsWith('00')) s = '+' + s.slice(2);

  const pn = parsePhoneNumberFromString(s, defaultCountry);
  if (!pn || !pn.isValid()) return null;
  return pn.number; // +E164
}

module.exports = { toE164 };
