/**
 * SMS sender (Twilio REST API, no extra npm package needed — uses Node 18+ fetch).
 *
 * Env (read lazily, because dotenv is loaded after ES-module imports run):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_FROM                      a Twilio number in E.164, e.g. +15551234567
 *     or TWILIO_MESSAGING_SERVICE_SID  (use one or the other)
 *   DEFAULT_COUNTRY_CODE             prefix for numbers typed without one (default +91)
 *
 * If Twilio isn't configured the message is only logged ("dry run"), so you can
 * develop and test the whole flow without sending real texts.
 */

export function normalizePhone(raw) {
  let s = String(raw || '').trim().replace(/[\s().-]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    const cc = process.env.DEFAULT_COUNTRY_CODE || '+91';
    s = cc + s.replace(/^0+/, '');
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

export function isSmsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID)
  );
}

const mask = (p) => p.slice(0, 3) + '******' + p.slice(-2);

export async function sendSms(to, body) {
  const phone = normalizePhone(to);
  if (!phone) {
    const err = new Error('invalid_phone');
    err.permanent = true; // retrying can't fix a bad number
    throw err;
  }

  if (!isSmsConfigured()) {
    console.log(`[SMS dry-run] to ${mask(phone)}: ${body}`);
    return { dryRun: true };
  }

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const params = new URLSearchParams({ To: phone, Body: body });
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    params.set('MessagingServiceSid', process.env.TWILIO_MESSAGING_SERVICE_SID);
  } else {
    params.set('From', process.env.TWILIO_FROM);
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`sms_failed: ${data.message || res.status}`);
    // 4xx (bad number, unverified trial recipient, etc.) won't fix itself on retry
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  console.log(`[SMS] sent to ${mask(phone)} (${data.sid})`);
  return { sid: data.sid };
}
