import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  calculateNodeCompositeScore,
  selectOptimalNodes,
  predictNodeHealthWithML,
  GLOBAL_INFRA_NODES,
  DEFAULT_NODES,
  resetNodeTelemetry
} from './src/services/nodeService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('======================================================================');
console.log('  SECUREVAULT PHASE 6 - STEP 4: INTELLIGENT NODE RANKING TESTS       ');
console.log('======================================================================\n');

const API_HOST = '127.0.0.1';
const API_PORT = 5002;

let totalTests = 0;
let passedTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] Test ${totalTests}: ${testName}`);
    console.error(`       Error: ${err.message}`);
    process.exitCode = 1;
  }
}

async function runAsyncTest(testName, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] Test ${totalTests}: ${testName}`);
    console.error(`       Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

function apiRequest(endpoint, method = 'GET', data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = data ? (Buffer.isBuffer(data) ? data : JSON.stringify(data)) : null;
    const reqHeaders = { ...headers };
    if (payload && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: API_HOST,
      port: API_PORT,
      path: endpoint.startsWith('/api') ? endpoint : `/api${endpoint}`,
      method,
      headers: reqHeaders,
      timeout: 5000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: bodyBuf,
          json: () => {
            try { return JSON.parse(bodyBuf.toString()); } catch (e) { return null; }
          }
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`API request timed out: ${endpoint}`));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  // ---------------------------------------------------------------------------
  // TEST 1: Composite score calculation follows the 60/25/15 weights exactly
  // ---------------------------------------------------------------------------
  runTest('Composite score calculation follows 60/25/15 weights exactly', () => {
    // S_ml = 90.0, avgLatencyMs = 20 (S_lat = 100 - 10 = 90.0), headroom = 80.0 (S_cap = 80.0)
    // Expected: 0.60 * 90 + 0.25 * 90 + 0.15 * 80 = 54 + 22.5 + 12 = 88.50
    const node = {
      nodeId: 'test-node-1',
      name: 'TEST-1',
      uptime: 95.0,
      avgLatencyMs: 20.0,
      storageTotal: 1000,
      storageUsed: 200 // 800 free = 80%
    };
    const pred = { reliabilityScore: 90.0, predictionSource: 'bootstrap_model' };

    const result = calculateNodeCompositeScore(node, pred);
    assert.strictEqual(result.scores.sMl, 90.0);
    assert.strictEqual(result.scores.sLat, 90.0);
    assert.strictEqual(result.scores.sCap, 80.0);
    assert.strictEqual(result.weights.ml, 0.60);
    assert.strictEqual(result.weights.latency, 0.25);
    assert.strictEqual(result.weights.headroom, 0.15);
    assert.strictEqual(result.compositeScore, 88.50);
  });

  // ---------------------------------------------------------------------------
  // TEST 2: Higher ML reliability produces higher ranking, all else being equal
  // ---------------------------------------------------------------------------
  runTest('Higher ML reliability produces higher composite score, all else equal', () => {
    const nodeHigh = { nodeId: 'node-high', name: 'HIGH', avgLatencyMs: 30, storageTotal: 1000, storageUsed: 300 };
    const nodeLow = { nodeId: 'node-low', name: 'LOW', avgLatencyMs: 30, storageTotal: 1000, storageUsed: 300 };

    const predHigh = { reliabilityScore: 99.0 };
    const predLow = { reliabilityScore: 70.0 };

    const scoreHigh = calculateNodeCompositeScore(nodeHigh, predHigh);
    const scoreLow = calculateNodeCompositeScore(nodeLow, predLow);

    assert(scoreHigh.compositeScore > scoreLow.compositeScore,
      `Expected ${scoreHigh.compositeScore} > ${scoreLow.compositeScore}`);
    // Difference should be exactly 0.60 * (99.0 - 70.0) = 17.4
    assert.strictEqual(Number((scoreHigh.compositeScore - scoreLow.compositeScore).toFixed(2)), 17.40);
  });

  // ---------------------------------------------------------------------------
  // TEST 3: Lower measured latency produces higher ranking, all else being equal
  // ---------------------------------------------------------------------------
  runTest('Lower measured latency produces higher composite score, all else equal', () => {
    const nodeFast = { nodeId: 'node-fast', name: 'FAST', avgLatencyMs: 10, storageTotal: 1000, storageUsed: 400 };
    const nodeSlow = { nodeId: 'node-slow', name: 'SLOW', avgLatencyMs: 110, storageTotal: 1000, storageUsed: 400 };

    const pred = { reliabilityScore: 95.0 };

    const scoreFast = calculateNodeCompositeScore(nodeFast, pred);
    const scoreSlow = calculateNodeCompositeScore(nodeSlow, pred);

    assert(scoreFast.scores.sLat > scoreSlow.scores.sLat, 'Fast node latency score must be higher');
    assert(scoreFast.compositeScore > scoreSlow.compositeScore,
      `Expected ${scoreFast.compositeScore} > ${scoreSlow.compositeScore}`);
  });

  // ---------------------------------------------------------------------------
  // TEST 4: Higher capacity headroom produces higher ranking, all else being equal
  // ---------------------------------------------------------------------------
  runTest('Higher capacity headroom produces higher composite score, all else equal', () => {
    const nodeEmpty = { nodeId: 'node-empty', name: 'EMPTY', avgLatencyMs: 40, storageTotal: 1000, storageUsed: 100 }; // 90% headroom
    const nodeFull = { nodeId: 'node-full', name: 'FULL', avgLatencyMs: 40, storageTotal: 1000, storageUsed: 900 }; // 10% headroom

    const pred = { reliabilityScore: 95.0 };

    const scoreEmpty = calculateNodeCompositeScore(nodeEmpty, pred);
    const scoreFull = calculateNodeCompositeScore(nodeFull, pred);

    assert(scoreEmpty.scores.sCap > scoreFull.scores.sCap, 'Empty node capacity score must be higher');
    assert(scoreEmpty.compositeScore > scoreFull.compositeScore,
      `Expected ${scoreEmpty.compositeScore} > ${scoreFull.compositeScore}`);
  });

  // ---------------------------------------------------------------------------
  // TEST 5: Measured vs unmeasured latency handling & neutral score
  // ---------------------------------------------------------------------------
  runTest('Nodes with measured latency evaluated against curve; unmeasured receives neutral 50.0 without fabricating observation', () => {
    // Unmeasured node
    const unmeasuredNode = { nodeId: 'node-unmeas', name: 'UNMEAS', avgLatencyMs: null, storageTotal: 1000, storageUsed: 500 };
    const unmeasuredScore = calculateNodeCompositeScore(unmeasuredNode, null);

    assert.strictEqual(unmeasuredScore.scores.sLat, 50.0, 'Unmeasured node must receive neutral latency score 50.0');
    assert.strictEqual(unmeasuredScore.telemetry.isLatencyMeasured, false);
    assert.strictEqual(unmeasuredScore.telemetry.measuredLatencyMs, null, 'Never fabricate measuredLatencyMs');

    // Measured node at 100ms: 100 - (100 * 0.5) = 50.0
    const measured100 = { nodeId: 'node-100', name: 'M100', avgLatencyMs: 100, storageTotal: 1000, storageUsed: 500 };
    const measuredScore = calculateNodeCompositeScore(measured100, null);
    assert.strictEqual(measuredScore.scores.sLat, 50.0);
    assert.strictEqual(measuredScore.telemetry.isLatencyMeasured, true);
    assert.strictEqual(measuredScore.telemetry.measuredLatencyMs, 100.0);

    // Measured node at 0ms: 100.0
    const measured0 = { nodeId: 'node-0', name: 'M0', avgLatencyMs: 0, storageTotal: 1000, storageUsed: 500 };
    assert.strictEqual(calculateNodeCompositeScore(measured0, null).scores.sLat, 100.0);

    // Clamping on extreme latency: 300ms -> 100 - 150 = -50 -> clamped to 0.0
    const measuredExtreme = { nodeId: 'node-ext', name: 'EXT', avgLatencyMs: 300, storageTotal: 1000, storageUsed: 500 };
    assert.strictEqual(calculateNodeCompositeScore(measuredExtreme, null).scores.sLat, 0.0);
  });

  // ---------------------------------------------------------------------------
  // TEST 6: Missing/invalid ML prediction & invalid capacity fallback resilience
  // ---------------------------------------------------------------------------
  runTest('Missing or invalid ML prediction and capacity fall back gracefully with score clamping', () => {
    // Missing pred: falls back to node uptime
    const nodeWithUptime = { nodeId: 'n-up', uptime: 97.5, storageTotal: 1000, storageUsed: 200 };
    const resWithUptime = calculateNodeCompositeScore(nodeWithUptime, null);
    assert.strictEqual(resWithUptime.scores.sMl, 97.5);
    assert.strictEqual(resWithUptime.predictionSource, 'heuristic_fallback');

    // Invalid non-finite ML score: falls back to safe 50.0
    const nodeCorrupt = { nodeId: 'n-bad', uptime: null, storageTotal: 1000, storageUsed: 200 };
    const predCorrupt = { reliabilityScore: NaN };
    const resCorrupt = calculateNodeCompositeScore(nodeCorrupt, predCorrupt);
    assert.strictEqual(resCorrupt.scores.sMl, 50.0);

    // Invalid capacity (total <= 0): conservative penalty score 30.0 (never 100%)
    const nodeZeroCap = { nodeId: 'n-zero-cap', uptime: 95.0, storageTotal: 0, storageUsed: 0 };
    const resZeroCap = calculateNodeCompositeScore(nodeZeroCap, null);
    assert.strictEqual(resZeroCap.scores.sCap, 30.0);

    // Score clamped to [0, 100]
    assert(resZeroCap.compositeScore >= 0 && resZeroCap.compositeScore <= 100);
  });

  // ---------------------------------------------------------------------------
  // TEST 7: Candidate nodes deduplication guarantee
  // ---------------------------------------------------------------------------
  await runAsyncTest('Candidate nodes are deduplicated — no duplicate node IDs in selection', async () => {
    const selected = await selectOptimalNodes(6);
    const seen = new Set();
    for (const n of selected) {
      const id = n.nodeId || n.id;
      assert(!seen.has(id), `Duplicate node detected in selection: ${id}`);
      seen.add(id);
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 8: Selection returns distinct nodes up to the requested count
  // ---------------------------------------------------------------------------
  await runAsyncTest('Selection returns distinct nodes matching requested count', async () => {
    const sel4 = await selectOptimalNodes(4);
    assert.strictEqual(sel4.length, 4, 'Must return 4 nodes');
    const ids4 = sel4.map(n => n.nodeId || n.id);
    assert.strictEqual(new Set(ids4).size, 4, 'All 4 nodes must be distinct');

    // Make node-05 temporarily online and healthy to test 6 distinct nodes selection
    const n5 = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-05');
    const origStatusN5 = n5.status;
    const origLatN5 = n5.latency;
    const origStorageN5 = n5.storageUsed;
    try {
      n5.status = 'online';
      n5.latency = 40;
      n5.storageUsed = 200;
      const sel6 = await selectOptimalNodes(6);
      assert.strictEqual(sel6.length, 6, 'Must return 6 nodes when 6 are eligible');
      const ids6 = sel6.map(n => n.nodeId || n.id);
      assert.strictEqual(new Set(ids6).size, 6, 'All 6 nodes must be distinct');
    } finally {
      n5.status = origStatusN5;
      n5.latency = origLatN5;
      n5.storageUsed = origStorageN5;
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 9: Offline or simulated-failure nodes excluded from selection
  // ---------------------------------------------------------------------------
  await runAsyncTest('Offline or simulated-failure nodes are excluded from selection', async () => {
    // node-05 is permanently 'degraded' in default setup
    const selected = await selectOptimalNodes(6);
    const ids = selected.map(n => n.nodeId || n.id);
    assert(!ids.includes('node-05'), 'node-05 (degraded) must be excluded from selection');

    // Simulate failure on node-02 in GLOBAL_INFRA_NODES
    const node2 = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-02');
    const origFailure = node2.isSimulatedFailure;
    try {
      node2.isSimulatedFailure = true;
      const selAfter = await selectOptimalNodes(6);
      const idsAfter = selAfter.map(n => n.nodeId || n.id);
      assert(!idsAfter.includes('node-02'), 'Simulated failure node-02 must be excluded from selection');
    } finally {
      node2.isSimulatedFailure = origFailure;
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 10: Deterministic tie-breaking produces consistent ordering on identical scores
  // ---------------------------------------------------------------------------
  runTest('Deterministic tie-breaking uses composite -> ML -> latency -> headroom -> nodeId', () => {
    // Two nodes with identical composite score, differing only in nodeId
    const nodeA = { nodeId: 'node-alpha', name: 'Alpha', uptime: 95.0, avgLatencyMs: 30, storageTotal: 1000, storageUsed: 200 };
    const nodeZ = { nodeId: 'node-zebra', name: 'Zebra', uptime: 95.0, avgLatencyMs: 30, storageTotal: 1000, storageUsed: 200 };

    const scoreA = calculateNodeCompositeScore(nodeA, null);
    const scoreZ = calculateNodeCompositeScore(nodeZ, null);

    assert.strictEqual(scoreA.compositeScore, scoreZ.compositeScore);

    const candidates = [
      { nodeId: nodeZ.nodeId, compositeScore: scoreZ.compositeScore, scores: scoreZ.scores },
      { nodeId: nodeA.nodeId, compositeScore: scoreA.compositeScore, scores: scoreA.scores }
    ];

    candidates.sort((a, b) => {
      if (b.compositeScore !== a.compositeScore) return b.compositeScore - a.compositeScore;
      if (b.scores.sMl !== a.scores.sMl) return b.scores.sMl - a.scores.sMl;
      if (b.scores.sLat !== a.scores.sLat) return b.scores.sLat - a.scores.sLat;
      if (b.scores.sCap !== a.scores.sCap) return b.scores.sCap - a.scores.sCap;
      return String(a.nodeId).localeCompare(String(b.nodeId));
    });

    // node-alpha must precede node-zebra due to alphabetical tie-breaking
    assert.strictEqual(candidates[0].nodeId, 'node-alpha');
    assert.strictEqual(candidates[1].nodeId, 'node-zebra');
  });

  // ---------------------------------------------------------------------------
  // TEST 11: Reed-Solomon 4+2 upload fails safely (HTTP 503) when < 6 distinct nodes available
  // ---------------------------------------------------------------------------
  await runAsyncTest('Reed-Solomon 4+2 upload fails safely with HTTP 503 when < 6 distinct nodes available', async () => {
    // Register a test user
    const email = `test_rs42_safety_${Date.now()}@securevault.io`;
    const regRes = await apiRequest('/auth/register', 'POST', {
      name: 'Safety User',
      email,
      password: 'Password123!'
    });
    assert.strictEqual(regRes.status, 201);
    const token = regRes.json().token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Explicitly toggle node-01 offline in server to guarantee < 6 available nodes
    await apiRequest('/nodes/node-01/toggle-status', 'POST', {}, authHeaders);

    try {
      // Construct cryptoVersion 2 multipart payload
      const testPayload = Buffer.from('Confidential RS 4+2 safety test buffer content.');
      const boundary = '----WebKitFormBoundarySafeRS';
      const bodyParts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="cryptoVersion"\r\n\r\n2\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="wrappedDEK"\r\n\r\nbase64wrappedDEK\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="kdfSalt"\r\n\r\nsalt123\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="baseNonce"\r\n\r\nnonce123\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="originalFileHash"\r\n\r\n${crypto.createHash('sha256').update(testPayload).digest('hex')}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test_insufficient.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ];

      const fullBody = Buffer.concat([
        Buffer.from(bodyParts.join('')),
        testPayload,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);

      const uploadRes = await apiRequest('/files/upload', 'POST', fullBody, {
        ...authHeaders,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      });

      assert.strictEqual(uploadRes.status, 503, `Expected HTTP 503 for insufficient nodes, got ${uploadRes.status}`);
      const errJson = uploadRes.json();
      assert(errJson && errJson.error, 'Must return informative error message');
      assert(errJson.error.includes('Reed-Solomon 4+2 requires 6 distinct healthy storage nodes'),
        `Error message mismatch: ${errJson.error}`);
    } finally {
      // Restore node-01
      await apiRequest('/nodes/node-01/restore', 'POST', {}, authHeaders);
    }
  });

  // ---------------------------------------------------------------------------
  // TEST 12: Existing upload, distribution, and recovery flow with 6 distinct nodes
  // ---------------------------------------------------------------------------
  await runAsyncTest('End-to-end cryptoVersion 2 upload with RS 4+2 allocates 6 distinct nodes successfully', async () => {
    const email = `test_rs42_e2e_${Date.now()}@securevault.io`;
    const regRes = await apiRequest('/auth/register', 'POST', {
      name: 'E2E User',
      email,
      password: 'Password123!'
    });
    const token = regRes.json().token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Restore node-05 so all 6 cluster nodes are healthy
    await apiRequest('/nodes/node-05/restore', 'POST', {}, authHeaders);

    try {
      const testPayload = Buffer.from('SecureVault RS 4+2 End-to-End Encryption Sharding Verification Payload 2026!');
      const payloadHash = crypto.createHash('sha256').update(testPayload).digest('hex');

      const boundary = '----WebKitFormBoundaryE2ERS';
      const bodyParts = [
        `--${boundary}\r\nContent-Disposition: form-data; name="cryptoVersion"\r\n\r\n2\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="wrappedDEK"\r\n\r\nvalidWrappedDEKString\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="kdfSalt"\r\n\r\nsaltABC\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="baseNonce"\r\n\r\nnonceXYZ\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="originalFileHash"\r\n\r\n${payloadHash}\r\n`,
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rs42_test_file.dat"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ];

      const fullBody = Buffer.concat([
        Buffer.from(bodyParts.join('')),
        testPayload,
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);

      const uploadRes = await apiRequest('/files/upload', 'POST', fullBody, {
        ...authHeaders,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      });

      assert.strictEqual(uploadRes.status, 201, `Upload failed: ${uploadRes.body.toString()}`);
      const uploadedFile = uploadRes.json().file;
      assert.strictEqual(uploadedFile.cryptoVersion, 2);
      assert.strictEqual(uploadedFile.totalShards, 6);
      assert.strictEqual(uploadedFile.nodeDistribution.length, 6);

      // Verify all 6 nodes are distinct
      const distinctAllocated = new Set(uploadedFile.nodeDistribution);
      assert.strictEqual(distinctAllocated.size, 6, 'All 6 shards must reside on 6 distinct nodes');

      // Verify shard records from backend API
      const shardsRes = await apiRequest(`/files/${uploadedFile.id}/shards`, 'GET', null, authHeaders);
      assert.strictEqual(shardsRes.status, 200);
      const shardsList = shardsRes.json();
      assert.strictEqual(shardsList.length, 6);

      const shardNodeIds = shardsList.map(s => s.nodeId);
      assert.strictEqual(new Set(shardNodeIds).size, 6, 'Each of the 6 shards must be assigned to a distinct node');

      // Verify retrieval / download recovery flow
      const dlRes = await apiRequest(`/files/${uploadedFile.id}/download`, 'GET', null, authHeaders);
      assert.strictEqual(dlRes.status, 200);
      assert(dlRes.body.equals(testPayload), 'Recovered file ciphertext must match uploaded payload exactly');
    } finally {
      // Toggle node-05 back to degraded/offline status to preserve default demo cluster topology
      await apiRequest('/nodes/node-05/toggle-status', 'POST', {}, authHeaders);
    }
  });

  // Summary
  console.log('\n======================================================================');
  console.log(`  STEP 4 TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
  console.log('======================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
