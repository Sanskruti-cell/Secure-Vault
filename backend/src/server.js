import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { connectDB, isMongoConnected } from './config/db.js';
import { initStorageNodes } from './services/nodeService.js';
import { errorHandler } from './middleware/errorMiddleware.js';
import { apiLimiter } from './middleware/rateLimiter.js';

import authRoutes from './routes/authRoutes.js';
import fileRoutes from './routes/fileRoutes.js';
import nodeRoutes from './routes/nodeRoutes.js';
import shareRoutes from './routes/shareRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import aiRoutes from './routes/aiRoutes.js';
import telemetryRoutes from './routes/telemetryRoutes.js';
import { terminalHttpLogger } from './middleware/terminalLogger.js';

import { syncAtlasUsers } from './controllers/authController.js';

const app = express();

// Security Headers via Helmet
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Secure CORS with explicit origin allowlist (no wildcard with credentials)
const allowedOrigins = new Set(
  [
    env.frontendUrl,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5174'
  ]
    .filter(Boolean)
    .map((o) => o.replace(/\/$/, ''))
);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, server-to-server, test scripts)
    if (!origin) return callback(null, true);
    const normalizedOrigin = origin.replace(/\/$/, '');
    if (allowedOrigins.has(normalizedOrigin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS Error: Origin '${origin}' is not permitted.`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-File-Password', 'X-Access-Code', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID'],
}));

// Automatic Backend Terminal Logging for Frontend UI actions and API calls
app.use(terminalHttpLogger);

// Global API Rate Limiter
app.use('/api', apiLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Healthcheck Route
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    service: 'SecureVault Backend Protocol',
    version: '1.0.0',
    mongodbConnected: isMongoConnected,
    storageMode: isMongoConnected ? 'mongodb-atlas' : 'local-json-fallback',
    databaseName: env.dbName,
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/nodes', nodeRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/shares', shareRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/telemetry', telemetryRoutes);

// Centralized Error Handler
app.use(errorHandler);

// Initialize Server
const startServer = async () => {
  const ts = new Date().toISOString();
  console.log('\n\x1b[96m╔══════════════════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log(`\x1b[96m║\x1b[0m \x1b[93m⚡ [SECUREVAULT] Decentralized Storage & Encryption Protocol Starting...   \x1b[0m \x1b[96m║\x1b[0m`);
  console.log('\x1b[96m╠──────────────────────────────────────────────────────────────────────────────╣\x1b[0m');
  console.log(`\x1b[96m║\x1b[0m  Timestamp:       ${ts.padEnd(58)}\x1b[96m║\x1b[0m`);
  console.log(`\x1b[96m║\x1b[0m  Port:            http://127.0.0.1:${env.port.toString().padEnd(46)}\x1b[96m║\x1b[0m`);
  console.log(`\x1b[96m║\x1b[0m  Live Terminal:   \x1b[92m[ACTIVE] Real-Time Event & Request Streaming Enabled\x1b[0m        \x1b[96m║\x1b[0m`);
  console.log('\x1b[96m╚══════════════════════════════════════════════════════════════════════════════╝\x1b[0m\n');
  
  await connectDB();
  await syncAtlasUsers();
  await initStorageNodes();

  app.listen(env.port, '0.0.0.0', () => {
    console.log(`\x1b[92m✔ [Express] SecureVault API Server listening on port ${env.port} (0.0.0.0)\x1b[0m`);
    console.log(`\x1b[92m✔ [Express] Healthcheck available at: http://127.0.0.1:${env.port}/api/health\x1b[0m`);
    console.log(`\x1b[92m✔ [Express] Reed-Solomon 4+2 Erasure Coding Storage Cluster: 6 Nodes Ready\x1b[0m`);
    console.log(`\x1b[90m--------------------------------------------------------------------------------\x1b[0m\n`);
  });
};

startServer();
