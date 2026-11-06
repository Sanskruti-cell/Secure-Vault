import fs from 'fs';

// ANSI Color Codes for terminal output
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  underscore: '\x1b[4m',
  
  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  
  // Bright colors
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  
  // Background colors
  bgCyan: '\x1b[46m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
};

export const getMethodColor = (method) => {
  switch (method) {
    case 'GET': return colors.brightCyan;
    case 'POST': return colors.brightGreen;
    case 'PUT':
    case 'PATCH': return colors.brightYellow;
    case 'DELETE': return colors.brightRed;
    case 'OPTIONS': return colors.dim;
    default: return colors.white;
  }
};

export const getStatusColor = (status) => {
  if (status >= 500) return colors.brightRed;
  if (status >= 400) return colors.brightYellow;
  if (status >= 300) return colors.cyan;
  if (status >= 200) return colors.brightGreen;
  return colors.white;
};

export const formatTimestamp = () => {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const ms = pad(d.getMilliseconds(), 3);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
};

// ─── Live Terminal Mirroring ──────────────────────────────────────────────────
// Ensures logs are mirrored to active user terminal tabs (e.g. /dev/ttys009)
// even if the backend process was started as a daemon or background task.
let _mirrorFds = [];
let _mirrorInitialized = false;

export const initLiveTerminalMirror = () => {
  if (_mirrorInitialized) return;
  _mirrorInitialized = true;

  try {
    let stdoutRdev = null;
    try {
      stdoutRdev = fs.fstatSync(1).rdev;
    } catch (e) {}

    const candidateTtys = [];
    for (let i = 0; i <= 20; i++) {
      const p = `/dev/ttys${String(i).padStart(3, '0')}`;
      try {
        fs.accessSync(p, fs.constants.W_OK);
        const st = fs.statSync(p);
        if (stdoutRdev === null || st.rdev !== stdoutRdev) {
          candidateTtys.push({ path: p, rdev: st.rdev, atime: st.atimeMs });
        }
      } catch (e) {}
    }

    // Sort candidate TTYs by most recently accessed
    candidateTtys.sort((a, b) => b.atime - a.atime);

    // Open top writable user terminals for live broadcast
    for (const cand of candidateTtys.slice(0, 3)) {
      try {
        const fd = fs.openSync(cand.path, 'w');
        _mirrorFds.push({ path: cand.path, fd });
      } catch (e) {}
    }

    if (_mirrorFds.length > 0) {
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);

      const mirrorWrite = (chunk, encoding) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        for (const target of _mirrorFds) {
          try {
            fs.writeSync(target.fd, buf);
          } catch (e) {}
        }
      };

      process.stdout.write = (chunk, encoding, cb) => {
        mirrorWrite(chunk, encoding);
        return origStdoutWrite(chunk, encoding, cb);
      };

      process.stderr.write = (chunk, encoding, cb) => {
        mirrorWrite(chunk, encoding);
        return origStderrWrite(chunk, encoding, cb);
      };
    }
  } catch (err) {
    // Gracefully ignore mirror initialization errors
  }
};

// Initialize mirror immediately upon module import
initLiveTerminalMirror();

// ─── Semantic Event Loggers for UI Actions & Protocol Pipeline ────────────────

/**
 * When a storage node is marked offline / simulated failure
 */
export const logStorageNodeOffline = (nodeId, status = 'OFFLINE', isSimulated = true) => {
  const ts = formatTimestamp();
  const simLabel = isSimulated ? ' (SIMULATED FAILURE)' : '';
  console.log(
    `[${ts}] ${colors.brightYellow}[STORAGE NODE OFFLINE]${colors.reset} Node: ${colors.brightWhite}${nodeId}${colors.reset} | Status: ${colors.brightRed}${status}${simLabel}${colors.reset}`
  );
};

/**
 * When a storage node is restored to ONLINE status
 */
export const logStorageNodeRestored = (nodeId, status = 'ONLINE') => {
  const ts = formatTimestamp();
  console.log(
    `[${ts}] ${colors.brightGreen}[STORAGE NODE RESTORED]${colors.reset} Node: ${colors.brightWhite}${nodeId}${colors.reset} | Status: ${colors.brightGreen}${status}${colors.reset}`
  );
};

/**
 * When a file is uploaded & sharded
 */
export const logFileUpload = (filename, encryption = 'AES-256-GCM', sizeBytes = null, shardCount = 6, result = 'SUCCESS', failureReason = null) => {
  const ts = formatTimestamp();
  if (result === 'SUCCESS') {
    const sizeStr = sizeBytes ? ` | Size: ${(sizeBytes / 1024).toFixed(1)} KB` : '';
    console.log(
      `[${ts}] ${colors.brightGreen}[FILE UPLOAD]${colors.reset} Filename: ${colors.brightWhite}${filename}${colors.reset} | Encryption: ${colors.brightCyan}${encryption}${colors.reset}${sizeStr} | Shards: ${shardCount}/6 | Result: ${colors.brightGreen}SUCCESS${colors.reset}`
    );
  } else {
    console.log(
      `[${ts}] ${colors.brightRed}[FILE UPLOAD FAILED]${colors.reset} Filename: ${colors.brightWhite}${filename}${colors.reset} | Reason: ${failureReason || 'Upload failed'} | Result: ${colors.brightRed}FAIL${colors.reset}`
    );
  }
};

/**
 * When shards are reconstructed during download
 */
export const logShardReconstruction = (filename, validShards, totalShards = 6, result = 'SUCCESS') => {
  const ts = formatTimestamp();
  const resColor = result === 'SUCCESS' ? colors.brightGreen : colors.brightRed;
  console.log(
    `[${ts}] ${colors.brightCyan}[SHARD RECONSTRUCTION]${colors.reset} File: ${colors.brightWhite}${filename}${colors.reset} | Valid shards: ${validShards}/${totalShards} | Result: ${resColor}${result}${colors.reset}`
  );
};

/**
 * When shard reconstruction fails due to insufficient shards
 */
export const logReconstructionFailure = (filename, required = 4, available = 0) => {
  const ts = formatTimestamp();
  const fileStr = filename ? `File: ${colors.brightWhite}${filename}${colors.reset} | ` : '';
  console.log(
    `[${ts}] ${colors.brightRed}[RECONSTRUCTION FAILURE]${colors.reset} ${fileStr}Required: ${colors.brightYellow}${required} shards${colors.reset} | Available: ${colors.brightRed}${available}${colors.reset}`
  );
};

/**
 * When integrity verification runs
 */
export const logIntegrityCheck = (target, result = 'PASS', details = null) => {
  const ts = formatTimestamp();
  const resColor = result === 'PASS' ? colors.brightGreen : colors.brightRed;
  const detailStr = details ? ` | ${details}` : '';
  console.log(
    `[${ts}] ${colors.brightMagenta}[INTEGRITY CHECK]${colors.reset} ${target} | Result: ${resColor}${result}${colors.reset}${detailStr}`
  );
};

/**
 * When a shard is repaired via Reed-Solomon Cauchy matrix inversion
 */
export const logShardRepair = (filename, shardIndex, nodeId, survivingCount = 5, totalCount = 6, result = 'SUCCESS') => {
  const ts = formatTimestamp();
  const resColor = result === 'SUCCESS' ? colors.brightGreen : colors.brightRed;
  console.log(
    `[${ts}] ${colors.brightCyan}[SHARD REPAIR]${colors.reset} File: ${colors.brightWhite}${filename}${colors.reset} | Shard: #${shardIndex} on ${nodeId} | Quorum: ${survivingCount}/${totalCount} | Result: ${resColor}${result}${colors.reset}`
  );
};

/**
 * Express middleware to automatically log all incoming HTTP requests triggered by the Frontend UI or API clients.
 * Logs when a request arrives (REQ) and when the response completes (RES).
 */
export const terminalHttpLogger = (req, res, next) => {
  const startTime = process.hrtime();
  const origin = req.headers.origin || req.headers.referer || '';
  const isFrontend = origin.includes('5173') || origin.includes('localhost') || origin.includes('127.0.0.1');

  // Skip silent health checks and internal telemetry endpoints from generic HTTP logging
  const isHealthCheck = req.originalUrl === '/api/health' && req.method === 'GET' && !req.query.verbose;
  const isTelemetry = req.originalUrl.startsWith('/api/telemetry');

  // Identify route action
  let routeSummary = '';
  if (req.originalUrl.includes('/upload/resumable')) {
    routeSummary = ' (Resumable Stream)';
  } else if (req.originalUrl.includes('/upload')) {
    routeSummary = ' (File Ingest & Reed-Solomon)';
  } else if (req.originalUrl.includes('/download')) {
    routeSummary = ' (Shard Stream & Reconstruct)';
  } else if (req.originalUrl.includes('/repair-shard')) {
    routeSummary = ' (Reed-Solomon Shard Repair)';
  } else if (req.originalUrl.includes('/shards')) {
    routeSummary = ' (Shard Audit)';
  } else if (req.originalUrl.includes('/nodes') && req.method === 'POST') {
    routeSummary = ' (Storage Node Toggle)';
  } else if (req.originalUrl.includes('/nodes')) {
    routeSummary = ' (Storage Cluster Query)';
  } else if (req.originalUrl.includes('/shares') && req.method === 'POST') {
    routeSummary = ' (Create Share Link)';
  } else if (req.originalUrl.includes('/auth/login')) {
    routeSummary = ' (User Authentication)';
  } else if (req.originalUrl.includes('/auth/register')) {
    routeSummary = ' (Vault Registration)';
  }

  const methodColor = getMethodColor(req.method);
  const sourceTag = isFrontend ? `${colors.brightMagenta}[UI]${colors.reset}` : `${colors.dim}[API]${colors.reset}`;

  // Log incoming request immediately for live terminal feedback
  if (!isHealthCheck && !isTelemetry) {
    const reqTs = formatTimestamp();
    console.log(
      `[${reqTs}] ${sourceTag} ${colors.brightYellow}⚡ [REQ]${colors.reset} ${methodColor}${req.method.padEnd(6)}${colors.reset} ${req.originalUrl}${colors.dim}${routeSummary}${colors.reset}`
    );
  }

  // Intercept response finish event to calculate elapsed time and status
  res.on('finish', () => {
    if (isHealthCheck || isTelemetry) return;

    const diff = process.hrtime(startTime);
    const latencyMs = ((diff[0] * 1e9 + diff[1]) / 1e6).toFixed(1);
    const statusColor = getStatusColor(res.statusCode);

    let userIdentifier = '';
    if (req.user) {
      userIdentifier = req.user.email || req.user.id || req.user._id || '';
    }
    const userTag = userIdentifier ? ` | ${colors.brightWhite}User:${colors.reset} ${userIdentifier}` : '';

    const resTs = formatTimestamp();
    console.log(
      `[${resTs}] ${sourceTag} ${colors.brightGreen}✔ [RES]${colors.reset} ${methodColor}${req.method.padEnd(6)}${colors.reset} ${req.originalUrl} -> ${statusColor}${res.statusCode}${colors.reset} (${latencyMs}ms)${userTag}`
    );
  });

  next();
};

/**
 * Format and print a dedicated banner for Frontend UI actions
 */
export const logFrontendUiAction = (action, details = {}, user = null) => {
  const ts = formatTimestamp();
  
  // Format specific semantic actions cleanly
  if (action === 'CLIENT_DECRYPTION_SUCCESS') {
    logIntegrityCheck(`File: ${details.fileName || 'Downloaded File'}`, 'PASS', 'Client-Side AES-256-GCM Plaintext Verification');
    return;
  }
  if (action === 'VAULT_LOCKED_MANUALLY') {
    console.log(`[${ts}] ${colors.brightYellow}[VAULT]${colors.reset} Vault locked manually by ${user || 'user'}`);
    return;
  }
  if (action === 'VAULT_UNLOCKED_SUCCESS') {
    console.log(`[${ts}] ${colors.brightGreen}[VAULT]${colors.reset} Vault unlocked successfully by ${user || 'user'}`);
    return;
  }
  if (action === 'UI_ROUTE_NAVIGATE') {
    // Keep navigation quiet so storage events remain the primary focus
    return;
  }

  // Fallback for general UI actions
  console.log(`[${ts}] ${colors.brightCyan}[UI ACTION]${colors.reset} ${action} | User: ${user || 'user'}`);
};
