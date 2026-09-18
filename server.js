/**
 * SafeRoute AI — backend
 * -----------------------------------------------------------------------------
 * Handles:
 *   POST /api/auth/google   -> verify a Google ID token, create a session
 *   POST /api/auth/trial    -> start (or resume) a 30-day free trial
 *   GET  /api/auth/me       -> current session + days left in trial
 *   POST /api/auth/logout   -> clear the session cookie
 *   GET  /api/profile       -> saved route + guardian for the signed-in user
 *   PUT  /api/profile       -> save route + guardian
 *
 * Storage is a JSON file (data/db.json) so the prototype runs with no database
 * to install. Swap `store.js` for Postgres/Mongo when you go to production.
 */
import dotenv from 'dotenv';
dotenv.config(); 



import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getUser, upsertUser, updateUser } from './store.js';

const PORT = process.env.PORT || 3000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 30);
const COOKIE_NAME = 'saferoute_session';
const IS_PROD = process.env.NODE_ENV === 'production';

import path from 'path';

const app = express();
// Force fallback connection straight to the cloud link if the environment variable goes missing
const finalURI ="mongodb+srv://admin:Khushi1234@cluster0.pbvrxl1.mongodb.net/?appName=Cluster0";

mongoose.connect(process.env.MONGODB_URI || finalURI)

  .then(() => console.log('✓ MongoDB connection established successfully.'))
  .catch(err => console.error('✗ MongoDB connection error:', err));

// Serves your index.html, styles, and logos from the root folder
app.use(express.static(import.meta.dirname));

// Explicitly handles the home page URL request
app.get('/', (req, res) => {
    res.sendFile(path.join(import.meta.dirname, 'index.html'));
});

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);


app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || true, // set to your site URL in production
    credentials: true,
  })
);

// Serve the front-end straight from the parent folder, so `npm start` runs the
// whole prototype on one origin (no CORS needed in the simple case).
app.use(express.static(fileURLToPath(new URL('..', import.meta.url))));

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
      audience:  [ GOOGLE_CLIENT_ID,
      "890937835758-52o2lbg7a3gj11u8mr0ab150ga4ns94u.apps.googleusercontent.com"
      ]
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
    user = (await upsertUser(id, { lastLoginAt: Date.now() })) || user;
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

/* ------------------------------- boot ------------------------------------ */

app.get('/api/health', (req, res) => res.json({ ok: true, trialDays: TRIAL_DAYS }));
// Catch-all route to serve the frontend interface
app.get('*', (req, res) => {
    res.sendFile(process.cwd() + '/index.html');
});

app.listen(PORT, () => {
  console.log(`SafeRoute AI backend listening on http://localhost:${PORT}`);
  if (!GOOGLE_CLIENT_ID) {
    console.warn('⚠  GOOGLE_CLIENT_ID is not set — /api/auth/google will reject requests.');
  }
  if (JWT_SECRET === 'dev-only-change-me') {
    console.warn('⚠  JWT_SECRET is using the default value. Set a real one before deploying.');
  }
});
