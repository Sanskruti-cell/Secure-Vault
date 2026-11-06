import mongoose from 'mongoose';
import { env } from './env.js';
import { syncStoreWithMongo } from '../services/storeService.js';
import { reconcileDatabaseDeduplication } from '../services/dedupService.js';

export let isMongoConnected = false;

// ─── Log deduplication ────────────────────────────────────────────────────────
// Prevents identical warnings from spamming the terminal on every error event.
const _lastLogTime = {};
function logOnce(level, msg, cooldownMs = 30000) {
  const now = Date.now();
  if (_lastLogTime[msg] && now - _lastLogTime[msg] < cooldownMs) return;
  _lastLogTime[msg] = now;
  const ts = new Date().toISOString();
  if (level === 'error') console.error(`[${ts}] ${msg}`);
  else if (level === 'warn')  console.warn(`[${ts}] ${msg}`);
  else                        console.log(`[${ts}] ${msg}`);
}

// ─── Storage mode banner ──────────────────────────────────────────────────────
function printStorageMode(mode) {
  const ts = new Date().toISOString();
  if (mode === 'atlas') {
    console.log(`[${ts}] [STORAGE MODE] ✅  PRIMARY: MongoDB Atlas  (cloud persistence active)`);
  } else {
    console.warn(`[${ts}] [STORAGE MODE] ⚠️   FALLBACK: Local JSON store (backend/data/*.json). ` +
      `Data written here will NOT sync to Atlas until reconnected.`);
  }
}

// ─── Reconnect state ──────────────────────────────────────────────────────────
let _reconnecting = false;
let _reconnectTimer = null;
let _reconnectAttempt = 0;
const BASE_BACKOFF_MS = 4000;
const MAX_BACKOFF_MS  = 60000; // cap at 60 s

function scheduleReconnect() {
  // Guard: already scheduling, already connected, or no URI
  if (_reconnecting) return;
  if (!env.mongoUri) return;
  if (mongoose.connection.readyState === 1) return; // already connected
  if (mongoose.connection.readyState === 2) return; // connecting right now

  _reconnecting = true;
  const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(1.5, _reconnectAttempt), MAX_BACKOFF_MS);
  _reconnectAttempt++;

  logOnce('warn',
    `[MongoDB] Scheduling reconnect attempt #${_reconnectAttempt} in ${Math.round(backoffMs / 1000)}s…`,
    5000);

  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;

    // Skip if state changed while we were waiting
    const state = mongoose.connection.readyState;
    if (state === 1 || state === 2) {
      _reconnecting = false;
      return;
    }

    try {
      await mongoose.connect(env.mongoUri, CONNECT_OPTIONS);
      // Success is handled by the 'connected' event handler below.
    } catch (e) {
      logOnce('warn',
        `[MongoDB] Reconnect attempt #${_reconnectAttempt} failed: ${e.message}`,
        15000);
      _reconnecting = false;
      scheduleReconnect(); // schedule next attempt with increased backoff
    }
  }, backoffMs);
}

// ─── Unified connection options ───────────────────────────────────────────────
const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS:        10000,
  socketTimeoutMS:         45000,
  maxIdleTimeMS:           30000,   // prune idle pool sockets before Atlas closes them
  heartbeatFrequencyMS:    10000,
  maxPoolSize:             10,
  family:                  4,       // force IPv4 — avoids IPv6/SRV lookup issues
  retryWrites:             true,
  retryReads:              true,
};

// ─── Lifecycle event handlers (registered ONCE at module load) ────────────────
mongoose.connection.on('connected', () => {
  isMongoConnected = true;
  _reconnecting    = false;
  _reconnectAttempt = 0;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }

  console.log(
    `[${new Date().toISOString()}] [MongoDB Atlas] ✅ Connected → ` +
    `${mongoose.connection.host}/${mongoose.connection.name}`
  );
  printStorageMode('atlas');
  syncStoreWithMongo().catch(() => {});
  reconcileDatabaseDeduplication().catch(() => {});
});

mongoose.connection.on('disconnected', () => {
  isMongoConnected = false;
  logOnce('warn', '[MongoDB Atlas] Connection disconnected — switching to fallback storage.', 10000);
  printStorageMode('fallback');
  scheduleReconnect();
});

// error fires on transient socket issues without necessarily dropping the entire pool
mongoose.connection.on('error', (err) => {
  if (mongoose.connection.readyState !== 1) {
    isMongoConnected = false;
  }
  logOnce('warn', `[MongoDB Atlas] Socket warning: ${err.message}`, 15000);
});

mongoose.connection.on('reconnected', () => {
  isMongoConnected = true;
  _reconnecting    = false;
  _reconnectAttempt = 0;
  console.log(`[${new Date().toISOString()}] [MongoDB Atlas] ✅ Reconnected successfully.`);
  printStorageMode('atlas');
});

// ─── Initial connection ───────────────────────────────────────────────────────
export const connectDB = async () => {
  if (!env.mongoUri) {
    console.warn(
      `[${new Date().toISOString()}] [MongoDB] No MONGODB_URI configured. ` +
      `Running in local JSON fallback mode only.`
    );
    printStorageMode('fallback');
    return false;
  }

  try {
    mongoose.set('bufferCommands', false);
    const conn = await mongoose.connect(env.mongoUri, CONNECT_OPTIONS);
    console.log(
      `[${new Date().toISOString()}] [MongoDB Atlas] Initial connection established → ` +
      `${conn.connection.host}/${conn.connection.name}`
    );
    isMongoConnected = true;
    printStorageMode('atlas');
    await syncStoreWithMongo();
    reconcileDatabaseDeduplication().catch(() => {});
    return true;
  } catch (error) {
    console.warn(
      `[${new Date().toISOString()}] [MongoDB] Initial connection failed: ${error.message}`
    );
    printStorageMode('fallback');
    scheduleReconnect();
    return false;
  }
};

// ─── Backward-compat alias ────────────────────────────────────────────────────
export const startMongoAutoReconnect = scheduleReconnect;

