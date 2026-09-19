/**
 * SafeRoute AI — backend
 * -----------------------------------------------------------------------------
 * Handles:
 *   POST /api/auth/google    -> verify a Google ID token, create a session
 *   POST /api/auth/trial     -> start (or resume) a 30-day free trial
 *   GET  /api/auth/me        -> current session + days left in trial
 *   POST /api/auth/logout    -> clear the session cookie
 *   GET  /api/profile        -> saved route + guardian for the signed-in user
 *   PUT  /api/profile        -> save route + guardian
 *   POST /api/location/ping  -> device heartbeat: location + battery level
 *
 * Guardian SMS alerts (see the "guardian alerts" section below):
 *   1. LOW BATTERY  - a heartbeat arrives with battery <= LOW_BATTERY_PERCENT
 *                     (and not charging)  -> SMS with the current location.
 *   2. WENT OFFLINE - heartbeats stop for OFFLINE_AFTER_MINUTES while the last
 *                     known battery was <= OFFLINE_ALERT_MAX_BATTERY (i.e. the
 *                     phone most likely died) -> SMS with the last known location.
 */
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  getUser,
  upsertUser,
  updateUser,
  recordPing,
  claimAlert,
  releaseAlert,
  findOfflineCandidates,
} from './store.js';
import { sendSms, isSmsConfigured } from './sms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 30);
const COOKIE_NAME = 'saferoute_session';
const IS_PROD = process.env.NODE_ENV === 'production';

// Guardian-alert tuning
const LOW_BATTERY_PERCENT = Number(process.env.LOW_BATTERY_PERCENT || 5);
const LOW_BATTERY_RESET_PERCENT = Number(process.env.LOW_BATTERY_RESET_PERCENT || 20);
const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_MINUTES || 6) * 60_000;
const OFFLINE_ALERT_MAX_BATTERY = Number(process.env.OFFLINE_ALERT_MAX_BATTERY || 15);
const OFFLINE_MAX_AGE_MS = Number(process.env.OFFLINE_MAX_AGE_HOURS || 24) * 3_600_000;

const app = express();

// The database URL must come from the environment (.env locally, the host's
// environment variables on Render). Never hard-code credentials in this file.
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('✗ MONGODB_URI is not set. Add it to .env, or to your host\'s environment variables.');
  process.exit(1);
}
mongoose
  .connect(MONGODB_URI)
  .then(() => console.log('✓ MongoDB connection established successfully.'))
  .catch((err) => console.error('✗ MongoDB connection error:', err));

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || true, // set to your site URL in production
    credentials: true,
  })
);

// Serve ONLY the front-end files. (The previous express.static on the project
// folder also exposed server.js, store.js and package.json to anyone.)
const sendFile = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get('/', sendFile('index.html'));
app.get('/index.html', sendFile('index.html'));
app.get('/manifest.json', sendFile('manifest.json'));
app.get('/Logo.png', sendFile('Logo.png'));

/* ------------------------------ helpers ---------------------------------- */

function issueSession(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: IS_PROD ? 'none' : 'lax',
    secure: IS_PROD,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
  return token;
}

function readSession(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  req.session = session;
  next();
}

function daysLeft(trialStartedAt) {
  if (!trialStartedAt) return null;
  const elapsedDays = (Date.now() - trialStartedAt) / 86400000;
  return Math.max(0, Math.ceil(TRIAL_DAYS - elapsedDays));
}

function describe(user) {
  if (!user) return null;
  const left = user.plan === 'trial' ? daysLeft(user.trialStartedAt) : null;
  return {
    id: user.id,
    plan: user.plan, // 'google' | 'trial'
    email: user.email || null,
    name: user.name || null,
    picture: user.picture || null,
    trialDaysLeft: left,
    trialExpired: user.plan === 'trial' && left === 0,
  };
}

/* ------------------------------- auth ------------------------------------ */

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'missing_credential' });
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: 'server_missing_google_client_id' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: [
        GOOGLE_CLIENT_ID,
        '890937835758-52o2lbg7a3gj11u8mr0ab150ga4ns94u.apps.googleusercontent.com',
      ],
    });
    const p = ticket.getPayload();
    if (!p?.email_verified) {
      return res.status(401).json({ error: 'email_not_verified' });
    }

    const user = await upsertUser({
      id: `google:${p.sub}`,
      plan: 'google',
      email: p.email,
      name: p.name,
      picture: p.picture,
      lastLoginAt: Date.now(),
    });

    issueSession(res, { sub: user.id, plan: 'google' });
    res.json({ user: describe(user) });
  } catch (err) {
    console.error('Google verification failed:', err.message);
    res.status(401).json({ error: 'invalid_google_token' });
  }
});

app.post('/api/auth/trial', async (req, res) => {
  // A trial is tied to an anonymous id kept in the session cookie, so closing
  // the tab doesn't hand out a fresh 30 days.
  const existing = readSession(req);
  let id = existing?.sub;

  if (!id || !id.startsWith('trial:')) {
    id = `trial:${randomUUID()}`;
  }

  let user = await getUser(id);
  if (!user) {
    user = await upsertUser({
      id,
      plan: 'trial',
      trialStartedAt: Date.now(),
      lastLoginAt: Date.now(),
    });
  } else {
    // updateUser returns the updated record — reassign, or `user` stays stale.
    user = (await updateUser(id, { lastLoginAt: Date.now() })) || user;
  }

  const info = describe(user);

  // An exhausted trial must not be handed a fresh session, or the client can
  // re-enter the app by calling this endpoint again.
  if (info?.trialExpired) {
    return res.status(403).json({ error: 'trial_expired', user: info });
  }

  issueSession(res, { sub: user.id, plan: 'trial' });
  res.json({ user: info });
});

app.get('/api/auth/me', async (req, res) => {
  const session = readSession(req);
  if (!session) return res.json({ user: null });

  const user = await getUser(session.sub);
  if (!user) return res.json({ user: null });

  const info = describe(user);
  if (info.trialExpired) return res.status(403).json({ error: 'trial_expired', user: info });
  res.json({ user: info });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { sameSite: IS_PROD ? 'none' : 'lax', secure: IS_PROD });
  res.json({ ok: true });
});

/* ------------------------ saved route + guardian -------------------------- */

app.get('/api/profile', requireAuth, async (req, res) => {
  const user = await getUser(req.session.sub);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json({
    savedRoute: user.savedRoute || null,
    guardian: user.guardian || null,
  });
});

app.put('/api/profile', requireAuth, async (req, res) => {
  const { savedRoute, guardian } = req.body || {};

  const patch = {};
  if (typeof savedRoute === 'string') patch.savedRoute = savedRoute.slice(0, 5000);
  if (guardian && typeof guardian === 'object') {
    patch.guardian = {
      name: String(guardian.name || '').slice(0, 120),
      phone: String(guardian.phone || '').slice(0, 30),
      alertsEnabled: Boolean(guardian.alertsEnabled),
    };
  }

  const user = await updateUser(req.session.sub, patch);
  if (!user) return res.status(404).json({ error: 'not_found' });

  res.json({ savedRoute: user.savedRoute || null, guardian: user.guardian || null });
});

/* --------------------------- guardian alerts ------------------------------ */

const IST = process.env.DISPLAY_TZ || 'Asia/Kolkata';
const fmtTime = (ms) =>
  new Date(ms).toLocaleString('en-IN', { timeZone: IST, dateStyle: 'medium', timeStyle: 'short' });

function locationPart(t) {
  if (t?.lat == null || t?.lon == null) return 'Location was not available.';
  return `Last known location: https://maps.google.com/?q=${t.lat},${t.lon} (as of ${fmtTime(t.locationAt || t.lastSeenAt)}).`;
}

const ownerPhrase = (user) => (user.name ? `${user.name}'s phone` : "Your contact's phone");

function lowBatteryText(user) {
  const t = user.tracking;
  return `SafeRoute AI alert: ${ownerPhrase(user)} battery is at ${t.battery}% and it may switch off soon. ${locationPart(t)}`;
}

function offlineText(user) {
  const t = user.tracking;
  return (
    `SafeRoute AI alert: ${ownerPhrase(user)} went offline at ${fmtTime(t.lastSeenAt)} with ${t.battery}% battery, ` +
    `so it has likely run out of power. ${locationPart(t)} This is the last verified location, not a live one.`
  );
}

// Send the SMS for an alert that was already claimed. A temporary failure (network,
// provider outage) releases the claim so it is retried; a permanent one (bad
// number) does not, to avoid retrying forever.
async function deliver(user, field, text) {
  try {
    await sendSms(user.guardian.phone, text);
  } catch (err) {
    console.error(`Guardian SMS failed (${field}):`, err.message);
    if (!err.permanent) await releaseAlert(user.id, field);
  }
}

async function maybeSendLowBatteryAlert(user, now) {
  const g = user.guardian;
  const t = user.tracking;
  if (!g?.alertsEnabled || !g.phone) return;
  if (t?.battery == null || t.battery > LOW_BATTERY_PERCENT || t.charging) return;

  const claimed = await claimAlert(user.id, 'lowBatteryAlertedAt', now);
  if (!claimed) return; // already alerted for this discharge cycle
  await deliver(claimed, 'lowBatteryAlertedAt', lowBatteryText(claimed));
}

// Device heartbeat. The front-end calls this every minute while the app is open,
// and immediately when the battery is low or the page is being hidden.
app.post('/api/location/ping', requireAuth, async (req, res) => {
  const { lat, lon, accuracy, battery, charging } = req.body || {};
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  const fields = {};
  if (isNum(lat) && isNum(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    fields.lat = lat;
    fields.lon = lon;
    if (isNum(accuracy)) fields.accuracy = Math.max(0, Math.round(accuracy));
  }
  if (isNum(battery) && battery >= 0 && battery <= 100) fields.battery = Math.round(battery);
  if (typeof charging === 'boolean') fields.charging = charging;
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'empty_ping' });

  const now = Date.now();
  const user = await recordPing(req.session.sub, fields, now, LOW_BATTERY_RESET_PERCENT);
  if (!user) return res.status(404).json({ error: 'not_found' });

  res.json({ ok: true });

  try {
    await maybeSendLowBatteryAlert(user, now);
  } catch (err) {
    console.error('Low-battery alert error:', err);
  }
});

// A phone at 0% can't send anything, so the server notices the silence instead.
async function checkOfflineDevices() {
  if (mongoose.connection.readyState !== 1) return;
  const now = Date.now();
  const stale = now - OFFLINE_AFTER_MS;

  const candidates = await findOfflineCandidates({
    olderThan: stale,
    newerThan: now - OFFLINE_MAX_AGE_MS,
    maxBattery: OFFLINE_ALERT_MAX_BATTERY,
  });

  for (const c of candidates) {
    // The extra filter re-checks staleness, so a heartbeat that landed a moment
    // ago cancels the alert.
    const claimed = await claimAlert(c.id, 'offlineAlertedAt', now, {
      'tracking.lastSeenAt': { $lte: stale },
    });
    if (!claimed) continue;
    await deliver(claimed, 'offlineAlertedAt', offlineText(claimed));
  }
}

setInterval(() => {
  checkOfflineDevices().catch((err) => console.error('Offline check error:', err));
}, 60_000);

/* ------------------------------- boot ------------------------------------ */

app.get('/api/health', (req, res) => res.json({ ok: true, trialDays: TRIAL_DAYS }));

// Catch-all: unknown API paths get JSON 404s, everything else gets the front-end.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SafeRoute AI backend listening on http://localhost:${PORT}`);
  if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠  GOOGLE_CLIENT_ID is not set — /api/auth/google will reject requests.');
  }
  if (JWT_SECRET === 'dev-only-change-me') {
    console.warn('⚠  JWT_SECRET is using the default value. Set a real one before deploying.');
  }
  if (!isSmsConfigured()) {
    console.warn('⚠  Twilio is not configured — guardian SMS alerts will only be logged, not sent.');
  }
});
