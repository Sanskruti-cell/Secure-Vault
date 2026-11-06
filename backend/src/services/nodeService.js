import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';
import { StorageNode } from '../models/StorageNode.js';
import { isMongoConnected } from '../config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const STORAGE_BASE_DIR = path.join(__dirname, '../../storage');

export const DEFAULT_NODES = [
  { id: 'node-01', nodeId: 'node-01', name: 'AWS-S3-US-EAST', region: 'North Virginia, US (aws-s3)', provider: 'aws-s3', providerType: 'emulator', emulatorBucket: 'securevault-aws-bucket', status: 'online', isSimulatedFailure: false, latency: 18, storageUsed: 320, storageAvailable: 1000, shardsStored: 42, uptime: 99.8, totalOperations: 0, successfulOperations: 0, failedOperations: 0, recentFailures: 0, avgLatencyMs: null, lastOperationalCheck: null },
  { id: 'node-02', nodeId: 'node-02', name: 'AWS-S3-EU-WEST', region: 'Frankfurt, DE (aws-s3)', provider: 'aws-s3', providerType: 'emulator', emulatorBucket: 'securevault-aws-bucket', status: 'online', isSimulatedFailure: false, latency: 42, storageUsed: 210, storageAvailable: 1000, shardsStored: 28, uptime: 99.5, totalOperations: 0, successfulOperations: 0, failedOperations: 0, recentFailures: 0, avgLatencyMs: null, lastOperationalCheck: null },
  { id: 'node-03', nodeId: 'node-03', name: 'GCP-GCS-AP-SOUTH', region: 'Mumbai, IN (gcp-gcs)', provider: 'gcp-gcs', providerType: 'emulator', emulatorBucket: 'securevault-gcp-bucket', status: 'online', isSimulatedFailure: false, latency: 28, storageUsed: 180, storageAvailable: 1000, shardsStored: 35, uptime: 99.9, totalOperations: 0, successfulOperations: 0, failedOperations: 0, recentFailures: 0, avgLatencyMs: null, lastOperationalCheck: null },
  { id: 'node-04', nodeId: 'node-04', name: 'GCP-GCS-US-CENTRAL', region: 'Iowa, US (gcp-gcs)', provider: 'gcp-gcs', providerType: 'emulator', emulatorBucket: 'securevault-gcp-bucket', status: 'online', isSimulatedFailure: false, latency: 35, storageUsed: 410, storageTotal: 1000, shardsStored: 54, uptime: 98.9, totalOperations: 0, successfulOperations: 0, failedOperations: 0, recentFailures: 0, avgLatencyMs: null, lastOperationalCheck: null },
  { id: 'node-05', nodeId: 'node-05', name: 'AZURE-BLOB-EAST-US', region: 'Virginia, US (azure-blob)', provider: 'azure-blob', providerType: 'emulator', emulatorBucket: 'securevault-azure-container', status: 'online', isSimulatedFailure: false, latency: 45, storageUsed: 350, storageTotal: 1000, shardsStored: 18, uptime: 99.2, totalOperations: 0, successfulOperations: 0, failedOperations: 0, recentFailures: 0, avgLatencyMs: null, lastOperationalCheck: null },
  { id: 'node-06', nodeId: 'node-06', name: 'AZURE-BLOB-EU-NORTH', region: 'Ireland, EU (azure-blob)', provider: 'azure-blob', providerType: 'emulator', emulatorBucket: 'securevault-azure-container', status: 'online', isSimulatedFailure: false, latency: 55, storageUsed: 150, storageTotal: 1000, shardsStored: 31, uptime: 99.6, totalOperations: 0, successfulOperations: 0, failedOperations: 0, recentFailures: 0, avgLatencyMs: null, lastOperationalCheck: null },
];

export const GLOBAL_INFRA_NODES = DEFAULT_NODES;

export const initStorageNodes = async () => {
  if (!fs.existsSync(STORAGE_BASE_DIR)) {
    fs.mkdirSync(STORAGE_BASE_DIR, { recursive: true });
  }

  for (const n of DEFAULT_NODES) {
    const nodeDir = path.join(STORAGE_BASE_DIR, n.nodeId);
    if (!fs.existsSync(nodeDir)) {
      fs.mkdirSync(nodeDir, { recursive: true });
    }
  }

  try {
    const count = await StorageNode.countDocuments();
    if (count === 0) {
      await StorageNode.insertMany(DEFAULT_NODES);
    }
  } catch (err) {}
};

/**
 * Invokes the Python ML service (http://127.0.0.1:5001/predict) running in-memory scikit-learn Logistic Regression
 */
export const predictNodeHealthWithML = (nodes) => {
  return new Promise((resolve) => {
    try {
      const payload = JSON.stringify({
        nodes: nodes.map(n => ({
          id: n.nodeId || n.id || n.name,
          nodeId: n.nodeId || n.id || n.name,
          name: n.name,
          status: n.status || 'online',
          isSimulatedFailure: !!n.isSimulatedFailure,
          // Real operational telemetry (Phase 6)
          avgLatencyMs: n.avgLatencyMs !== undefined ? n.avgLatencyMs : null,
          totalOperations: Number(n.totalOperations) || 0,
          successfulOperations: Number(n.successfulOperations) || 0,
          failedOperations: Number(n.failedOperations) || 0,
          recentFailures: Number(n.recentFailures) || (n.status === 'degraded' || n.status === 'unhealthy' ? 3 : 0),
          lastOperationalCheck: n.lastOperationalCheck || null,
          // Baseline / backward-compatible properties
          latency: Number(n.latency) || 50,
          storageUtil: Math.round(((Number(n.storageUsed) || 100) / (Number(n.storageTotal) || 1000)) * 100),
          uptime: Number(n.uptime) || 99
        }))
      });

      const options = {
        hostname: '127.0.0.1',
        port: 5001,
        path: '/predict',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 1000
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.success && data.predictions) {
              return resolve(data.predictions);
            }
          } catch (e) {}
          resolve(fallbackPredictions(nodes));
        });
      });

      req.on('error', () => resolve(fallbackPredictions(nodes)));
      req.on('timeout', () => { req.destroy(); resolve(fallbackPredictions(nodes)); });
      req.write(payload);
      req.end();
    } catch (e) {
      resolve(fallbackPredictions(nodes));
    }
  });
};

const fallbackPredictions = (nodes) => {
  return nodes.map(n => ({
    nodeId: n.nodeId || n.id || n.name,
    name: n.name,
    isHealthy: n.status !== 'degraded' && n.status !== 'unhealthy' && !n.isSimulatedFailure,
    reliabilityScore: n.uptime || 98.5,
    status: (n.status === 'degraded' || n.status === 'unhealthy' || n.isSimulatedFailure) ? 'Degraded' : 'Healthy',
    predictionSource: 'heuristic_fallback'
  }));
};

export const getNodesWithMLReliability = async () => {
  let dbNodes = [];
  try {
    dbNodes = await StorageNode.find();
  } catch (e) {}

  if (!dbNodes || dbNodes.length === 0) {
    dbNodes = DEFAULT_NODES;
  }

  const mlPredictions = await predictNodeHealthWithML(dbNodes);

  return dbNodes.map((n) => {
    const key = n.nodeId || n.id || n.name;
    const pred = mlPredictions.find(p => p.nodeId === key || p.name === n.name);
    const score = pred && pred.reliabilityScore !== undefined ? pred.reliabilityScore : (n.uptime || 98.5);
    return {
      id: key,
      nodeId: key,
      name: n.name,
      region: n.region,
      status: n.status,
      latency: n.latency,
      storageUsed: n.storageUsed,
      storageAvailable: n.storageAvailable || 1000,
      storageTotal: n.storageTotal || 1000,
      shardsStored: n.shardsStored,
      uptime: n.uptime,
      reliabilityScore: score,
      mlReliabilityScore: score,
      mlStatus: pred ? (pred.isHealthy ? 'Healthy' : 'Degraded') : 'Healthy',
      totalOperations: n.totalOperations !== undefined ? n.totalOperations : 0,
      successfulOperations: n.successfulOperations !== undefined ? n.successfulOperations : 0,
      failedOperations: n.failedOperations !== undefined ? n.failedOperations : 0,
      recentFailures: n.recentFailures !== undefined ? n.recentFailures : 0,
      avgLatencyMs: n.avgLatencyMs !== undefined ? n.avgLatencyMs : null,
      lastOperationalCheck: n.lastOperationalCheck || null
    };
  });
};

/**
 * Computes a normalized composite score for a candidate storage node using:
 * - ML Reliability Component: 60%
 * - Measured Latency Component: 25% (prefers avgLatencyMs; uses documented neutral default for unmeasured)
 * - Storage Capacity Headroom: 15% (conservative penalty for invalid/missing capacity)
 *
 * All components normalized to [0, 100].
 *
 * @param {object} n - Storage node record
 * @param {object|null} pred - ML prediction result
 * @returns {object} - Structured breakdown with composite score and components
 */
export const calculateNodeCompositeScore = (n, pred = null) => {
  const nodeId = n.nodeId || n.id || n.name || 'unknown-node';
  const name = n.name || nodeId;

  // 1. ML Reliability Component (60%)
  let rawMl = pred && pred.reliabilityScore !== undefined 
    ? Number(pred.reliabilityScore) 
    : (Number(n.uptime) || 98.5);
  if (isNaN(rawMl) || !isFinite(rawMl)) rawMl = 50.0;
  const sMl = Number(Math.max(0, Math.min(100, rawMl)).toFixed(2));
  const predictionSource = pred ? (pred.predictionSource || 'bootstrap_model') : 'heuristic_fallback';

  // 2. Measured Latency Component (25%)
  const hasMeasuredLatency = n.avgLatencyMs !== null && 
    n.avgLatencyMs !== undefined && 
    !isNaN(n.avgLatencyMs) && 
    isFinite(n.avgLatencyMs) && 
    Number(n.avgLatencyMs) >= 0;

  let sLat;
  let measuredLatencyMs = null;
  const staticLatencyMs = Number(n.latency) || 50;

  if (hasMeasuredLatency) {
    measuredLatencyMs = Number(Number(n.avgLatencyMs).toFixed(2));
    // Latency scoring curve: 0ms -> 100, 100ms -> 50, 200ms+ -> 0
    sLat = Number(Math.max(0, Math.min(100, 100 - (measuredLatencyMs * 0.5))).toFixed(2));
  } else {
    // Documented neutral default score for unmeasured latency (no fabricated observation)
    sLat = 50.0;
  }

  // 3. Storage Headroom Component (15%)
  const totalCap = Number(n.storageTotal !== undefined ? n.storageTotal : (n.storageAvailable !== undefined ? n.storageAvailable : 0));
  const usedCap = Number(n.storageUsed || 0);

  let sCap;
  if (isNaN(totalCap) || !isFinite(totalCap) || totalCap <= 0 || isNaN(usedCap) || !isFinite(usedCap) || usedCap < 0) {
    // Conservative penalty for invalid/missing capacity: 30 / 100 (never awarded 100%)
    sCap = 30.0;
  } else {
    const freeCap = Math.max(0, totalCap - usedCap);
    const headroomPct = (freeCap / totalCap) * 100;
    sCap = Number(Math.max(0, Math.min(100, headroomPct)).toFixed(2));
  }

  // 4. Composite Score: (0.60 * sMl) + (0.25 * sLat) + (0.15 * sCap)
  const rawComposite = (0.60 * sMl) + (0.25 * sLat) + (0.15 * sCap);
  const compositeScore = Number(Math.max(0, Math.min(100, rawComposite)).toFixed(2));

  return {
    nodeId,
    name,
    compositeScore,
    scores: {
      sMl,
      sLat,
      sCap
    },
    weights: {
      ml: 0.60,
      latency: 0.25,
      headroom: 0.15
    },
    telemetry: {
      isLatencyMeasured: hasMeasuredLatency,
      measuredLatencyMs,
      staticLatencyMs,
      totalCapacityMB: totalCap > 0 ? totalCap : null,
      usedCapacityMB: usedCap >= 0 ? usedCap : null
    },
    predictionSource
  };
};

export const selectOptimalNodes = async (count = 4) => {
  let dbNodes = [];
  if (isMongoConnected) {
    try {
      dbNodes = await StorageNode.find().lean();
    } catch (e) {}
  }

  if (!dbNodes || dbNodes.length === 0) {
    dbNodes = GLOBAL_INFRA_NODES;
  } else {
    dbNodes = dbNodes.map(n => {
      const key = n.nodeId || n.id || n.name;
      const memNode = GLOBAL_INFRA_NODES.find(m => m.id === key || m.nodeId === key);
      if (memNode) {
        return {
          ...n,
          status: memNode.status || n.status,
          isSimulatedFailure: memNode.isSimulatedFailure !== undefined ? memNode.isSimulatedFailure : n.isSimulatedFailure,
          avgLatencyMs: memNode.avgLatencyMs !== undefined ? memNode.avgLatencyMs : n.avgLatencyMs,
          totalOperations: memNode.totalOperations || n.totalOperations,
          failedOperations: memNode.failedOperations || n.failedOperations,
          recentFailures: memNode.recentFailures || n.recentFailures
        };
      }
      return n;
    });
  }

  // Deduplicate candidate nodes by unique ID to guarantee distinct node placement
  const seenNodeIds = new Set();
  const uniqueNodes = [];
  for (const n of dbNodes) {
    const key = n.nodeId || n.id || n.name;
    if (key && !seenNodeIds.has(key)) {
      seenNodeIds.add(key);
      uniqueNodes.push(n);
    }
  }

  // Filter out offline and simulated-failure nodes
  const availableNodes = uniqueNodes.filter(n => {
    const isOffline = n.status === 'offline' || n.isSimulatedFailure === true;
    return !isOffline;
  });

  // Batch ML prediction request
  const mlPredictions = await predictNodeHealthWithML(availableNodes);

  // Filter eligible nodes (exclude nodes marked unhealthy by ML prediction or status)
  let eligibleNodes = availableNodes.filter((n) => {
    const key = n.nodeId || n.id || n.name;
    const pred = mlPredictions.find(p => p.nodeId === key || p.name === n.name);
    return pred ? pred.isHealthy : n.status !== 'degraded' && n.status !== 'unhealthy';
  });

  if (eligibleNodes.length < count && availableNodes.length >= count) {
    // If ML prediction or degradation filtered too many nodes for RS(4+2),
    // include remaining available nodes to ensure 6 distinct nodes are satisfied
    const eligibleKeys = new Set(eligibleNodes.map(n => n.nodeId || n.id || n.name));
    for (const an of availableNodes) {
      const key = an.nodeId || an.id || an.name;
      if (!eligibleKeys.has(key)) {
        eligibleNodes.push(an);
        eligibleKeys.add(key);
        if (eligibleNodes.length >= count) break;
      }
    }
  }

  if (eligibleNodes.length === 0) {
    console.warn('[Node Allocation Warning] No eligible healthy nodes available.');
    return [];
  }

  // Calculate 60/25/15 composite score for each eligible node
  const scoredCandidates = eligibleNodes.map(n => {
    const key = n.nodeId || n.id || n.name;
    const pred = mlPredictions.find(p => p.nodeId === key || p.name === n.name);
    const breakdown = calculateNodeCompositeScore(n, pred);
    return {
      node: {
        ...n,
        rankingScore: breakdown.compositeScore,
        rankingBreakdown: breakdown
      },
      ...breakdown
    };
  });

  // Deterministic candidate sorting:
  // 1. Highest compositeScore
  // 2. Higher ML reliability score
  // 3. Higher latency score
  // 4. Higher headroom score
  // 5. Deterministic node ID string comparison
  scoredCandidates.sort((a, b) => {
    if (b.compositeScore !== a.compositeScore) {
      return b.compositeScore - a.compositeScore;
    }
    if (b.scores.sMl !== a.scores.sMl) {
      return b.scores.sMl - a.scores.sMl;
    }
    if (b.scores.sLat !== a.scores.sLat) {
      return b.scores.sLat - a.scores.sLat;
    }
    if (b.scores.sCap !== a.scores.sCap) {
      return b.scores.sCap - a.scores.sCap;
    }
    return String(a.nodeId).localeCompare(String(b.nodeId));
  });

  // Safe structured diagnostic logging (no sensitive secrets or user data)
  console.log('[Dynamic Intelligent Node Allocation] Ranked candidate nodes:');
  scoredCandidates.forEach((item, index) => {
    console.log(
      `  Rank ${index + 1}: ${item.nodeId} (${item.name}) | Score: ${item.compositeScore} | ML: ${item.scores.sMl}% (${item.predictionSource}) | LatencyScore: ${item.scores.sLat}% (measured: ${item.telemetry.isLatencyMeasured}${item.telemetry.isLatencyMeasured ? `, ${item.telemetry.measuredLatencyMs}ms` : ''}) | Headroom: ${item.scores.sCap}%`
    );
  });

  const selectedObjects = scoredCandidates.slice(0, count).map(item => item.node);

  if (selectedObjects.length < count) {
    console.warn(`[Node Allocation Notice] Only ${selectedObjects.length} eligible nodes available (requested ${count}).`);
  }

  return selectedObjects;
};

/**
 * Records operational telemetry for a storage node attempt.
 * Updates in-memory fallback immediately and persists to MongoDB if connected.
 * Never throws — catches all errors to prevent breaking storage operations.
 *
 * @param {string} nodeId - Target node ID (e.g. 'node-01')
 * @param {number} durationMs - Monotonically measured operation duration in ms
 * @param {boolean} success - Whether the operation succeeded
 * @returns {Promise<object|null>} - Updated node record
 */
export const recordNodeOperation = async (nodeId, durationMs, success = true) => {
  try {
    if (!nodeId) return null;
    const duration = Math.max(0, Number(durationMs) || 0);

    // 1. Update in-memory fallback (GLOBAL_INFRA_NODES)
    const memNode = GLOBAL_INFRA_NODES.find(n => n.nodeId === nodeId || n.id === nodeId);
    if (memNode) {
      const prevTotal = Number(memNode.totalOperations) || 0;
      const newTotal = prevTotal + 1;
      memNode.totalOperations = newTotal;

      if (success) {
        memNode.successfulOperations = (Number(memNode.successfulOperations) || 0) + 1;
        memNode.recentFailures = 0;
      } else {
        memNode.failedOperations = (Number(memNode.failedOperations) || 0) + 1;
        memNode.recentFailures = (Number(memNode.recentFailures) || 0) + 1;
      }

      if (memNode.avgLatencyMs === null || memNode.avgLatencyMs === undefined) {
        memNode.avgLatencyMs = Number(duration.toFixed(2));
      } else {
        const runningAvg = ((Number(memNode.avgLatencyMs) * prevTotal) + duration) / newTotal;
        memNode.avgLatencyMs = Number(runningAvg.toFixed(2));
      }

      memNode.lastOperationalCheck = new Date();
    }

    // 2. Persist to MongoDB if connected
    if (isMongoConnected) {
      try {
        const dbNode = await StorageNode.findOne({ $or: [{ nodeId }, { id: nodeId }] });
        if (dbNode) {
          const prevTotal = Number(dbNode.totalOperations) || 0;
          const newTotal = prevTotal + 1;
          dbNode.totalOperations = newTotal;

          if (success) {
            dbNode.successfulOperations = (Number(dbNode.successfulOperations) || 0) + 1;
            dbNode.recentFailures = 0;
          } else {
            dbNode.failedOperations = (Number(dbNode.failedOperations) || 0) + 1;
            dbNode.recentFailures = (Number(dbNode.recentFailures) || 0) + 1;
          }

          if (dbNode.avgLatencyMs === null || dbNode.avgLatencyMs === undefined) {
            dbNode.avgLatencyMs = Number(duration.toFixed(2));
          } else {
            const runningAvg = ((Number(dbNode.avgLatencyMs) * prevTotal) + duration) / newTotal;
            dbNode.avgLatencyMs = Number(runningAvg.toFixed(2));
          }

          dbNode.lastOperationalCheck = new Date();
          await dbNode.save();
        }
      } catch (mongoErr) {
        console.warn(`[Telemetry Warning] Could not persist telemetry for node ${nodeId} to MongoDB:`, mongoErr.message);
      }
    }

    return memNode || null;
  } catch (err) {
    console.warn(`[Telemetry Warning] Telemetry recording failed for node ${nodeId}:`, err.message);
    return null;
  }
};

/**
 * Writes a shard buffer to a node's local storage path.
 * Measures execution time using monotonic performance.now() and updates telemetry.
 *
 * @param {string} nodeId - Target node ID (e.g. 'node-01')
 * @param {string} fullShardPath - Destination file path
 * @param {Buffer} buffer - Shard data buffer
 * @returns {Promise<string>} - fullShardPath
 */
export const writeNodeShard = async (nodeId, fullShardPath, buffer) => {
  const start = performance.now();
  let success = false;
  try {
    const nodeDir = path.dirname(fullShardPath);
    if (!fs.existsSync(nodeDir)) {
      fs.mkdirSync(nodeDir, { recursive: true });
    }
    fs.writeFileSync(fullShardPath, buffer);
    success = true;
    return fullShardPath;
  } catch (err) {
    success = false;
    throw err;
  } finally {
    const durationMs = Math.max(0, performance.now() - start);
    await recordNodeOperation(nodeId, durationMs, success);
  }
};

/**
 * Reads a shard buffer from a node's local storage path.
 * Measures execution time using monotonic performance.now() and updates telemetry.
 *
 * @param {string} nodeId - Target node ID (e.g. 'node-01')
 * @param {string} fullShardPath - Shard file path
 * @returns {Promise<Buffer>} - Shard data buffer
 */
export const readNodeShard = async (nodeId, fullShardPath) => {
  const start = performance.now();
  let success = false;
  try {
    if (!fullShardPath || !fs.existsSync(fullShardPath)) {
      throw new Error(`Shard file not found: ${fullShardPath}`);
    }
    const buf = fs.readFileSync(fullShardPath);
    success = true;
    return buf;
  } catch (err) {
    success = false;
    throw err;
  } finally {
    const durationMs = Math.max(0, performance.now() - start);
    await recordNodeOperation(nodeId, durationMs, success);
  }
};

/**
 * Resets operational telemetry for a node (primarily used for test isolation).
 *
 * @param {string} nodeId - Target node ID (e.g. 'node-01')
 */
export const resetNodeTelemetry = (nodeId) => {
  const memNode = GLOBAL_INFRA_NODES.find(n => n.nodeId === nodeId || n.id === nodeId);
  if (memNode) {
    memNode.totalOperations = 0;
    memNode.successfulOperations = 0;
    memNode.failedOperations = 0;
    memNode.recentFailures = 0;
    memNode.avgLatencyMs = null;
    memNode.lastOperationalCheck = null;
  }
};