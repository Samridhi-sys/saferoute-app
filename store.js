import mongoose from 'mongoose';

const GuardianSchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    phone: { type: String, default: '' },
    alertsEnabled: { type: Boolean, default: false },
  },
  { _id: false }
);

// Latest heartbeat from the device + flags that stop the same alert being sent twice.
const TrackingSchema = new mongoose.Schema(
  {
    lat: Number,
    lon: Number,
    accuracy: Number,
    locationAt: Number, // when the coordinates were last received
    battery: Number, // 0-100
    charging: Boolean,
    lastSeenAt: Number, // last heartbeat of any kind
    lowBatteryAlertedAt: { type: Number, default: null },
    offlineAlertedAt: { type: Number, default: null },
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  plan: { type: String, default: 'trial' },
  email: String,
  name: String,
  picture: String,
  trialStartedAt: { type: Number, default: () => Date.now() },
  lastLoginAt: { type: Number, default: () => Date.now() },
  savedRoute: String,
  guardian: GuardianSchema,
  tracking: TrackingSchema,
});
UserSchema.index({ 'guardian.alertsEnabled': 1, 'tracking.lastSeenAt': 1 });

const User = mongoose.model('User', UserSchema);

const OPTS = { returnDocument: 'after', lean: true };

// 1. Fetch a user (plain object, or null)
export async function getUser(id) {
  try {
    return await User.findOne({ id }).lean();
  } catch (err) {
    console.error('Database read error:', err);
    return null;
  }
}

// 2. Insert or update a user. Accepts upsertUser({ id, ...fields }) or upsertUser(id, fields).
export async function upsertUser(a, b) {
  try {
    const { id, ...fields } = typeof a === 'string' ? { ...(b || {}), id: a } : { ...(a || {}) };
    for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
    return await User.findOneAndUpdate({ id }, { $set: fields }, { ...OPTS, upsert: true });
  } catch (err) {
    console.error('Database write error:', err);
    return null;
  }
}

// 3. Update fields on an existing user
export async function updateUser(id, updateFields) {
  try {
    return await User.findOneAndUpdate({ id }, { $set: updateFields }, OPTS);
  } catch (err) {
    console.error('Database update error:', err);
    return null;
  }
}

/* ------------------------- location / battery tracking ------------------------ */

// Store a heartbeat. A new heartbeat means the device is back online, so the
// "offline" alert is re-armed; the "low battery" alert re-arms once the phone is
// charging or back above `resetPercent`.
export async function recordPing(id, fields, now, resetPercent) {
  const set = { 'tracking.lastSeenAt': now, 'tracking.offlineAlertedAt': null };
  if (fields.lat !== undefined) {
    set['tracking.lat'] = fields.lat;
    set['tracking.lon'] = fields.lon;
    set['tracking.locationAt'] = now;
    if (fields.accuracy !== undefined) set['tracking.accuracy'] = fields.accuracy;
  }
  if (fields.battery !== undefined) set['tracking.battery'] = fields.battery;
  if (fields.charging !== undefined) set['tracking.charging'] = fields.charging;
  if (fields.charging === true || (fields.battery !== undefined && fields.battery >= resetPercent)) {
    set['tracking.lowBatteryAlertedAt'] = null;
  }
  try {
    return await User.findOneAndUpdate({ id }, { $set: set }, OPTS);
  } catch (err) {
    console.error('Database ping error:', err);
    return null;
  }
}

// Atomically mark an alert as sent. Returns the updated user only for the caller
// that won the claim, so concurrent pings / server instances can't double-send.
export async function claimAlert(id, field, now, extraFilter = {}) {
  try {
    return await User.findOneAndUpdate(
      { id, [`tracking.${field}`]: null, ...extraFilter },
      { $set: { [`tracking.${field}`]: now } },
      OPTS
    );
  } catch (err) {
    console.error('Database claim error:', err);
    return null;
  }
}

// Undo a claim after a temporary SMS failure so the next check retries.
export async function releaseAlert(id, field) {
  try {
    await User.updateOne({ id }, { $set: { [`tracking.${field}`]: null } });
  } catch (err) {
    console.error('Database release error:', err);
  }
}

// Devices that have gone quiet, were low on battery and not charging, and whose
// guardian wants alerts.
export async function findOfflineCandidates({ olderThan, newerThan, maxBattery }) {
  try {
    return await User.find({
      'guardian.alertsEnabled': true,
      'guardian.phone': { $nin: [null, ''] },
      'tracking.lastSeenAt': { $lte: olderThan, $gte: newerThan },
      'tracking.battery': { $lte: maxBattery },
      'tracking.charging': { $ne: true },
      'tracking.offlineAlertedAt': null,
    }).lean();
  } catch (err) {
    console.error('Database query error:', err);
    return [];
  }
}
