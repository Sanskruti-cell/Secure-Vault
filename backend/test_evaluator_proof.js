import http from 'http';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from './src/config/env.js';

const PORT = 5002;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const USER_ID = '6a939bf1e8d60eee7b1e11bf';
const FILE_ID = 'file-1792559510680';
const EXPECTED_CIPHERTEXT_HASH = '3d52578e25140dba790673144ded00d93b23f038415366f5fa12a0f95749ac87';
const EXPECTED_SIZE = 396665;

const token = jwt.sign(
  { id: USER_ID, email: 'sanskruti.asati.batch2024@sitnagpur.siu.edu.in', name: 'Sanskruti Asati' },
  env.jwtSecret,
  { expiresIn: '1h' }
);

function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buffer.toString('utf8'));
        } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          buffer,
          json
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runProof() {
  console.log('='.repeat(80));
  console.log('STARTING SECUREVAULT EVALUATOR PROOF TEST');
  console.log(`Backend Target: ${BASE_URL}`);
  console.log(`Target File ID: ${FILE_ID} (AICTE B1 PD 1-732-545.pdf, RS 4+2, Size: ${EXPECTED_SIZE}B)`);
  console.log('='.repeat(80));

  // 1. Restore all nodes to ensure clean initial state
  console.log('\n[TEST PREP] Restoring all storage nodes to ONLINE...');
  for (const n of ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06']) {
    await makeRequest('POST', `/api/nodes/${n}/restore`);
  }
  console.log('[TEST PREP] All nodes confirmed ONLINE.\n');

  // 2. Scenario 1: All 6 nodes online -> Fast Systematic Path
  console.log('------------------------------------------------------------------------');
  console.log('SCENARIO 1: All 6 Storage Nodes Online (Expected: Fast Path RS 4+2)');
  console.log('------------------------------------------------------------------------');
  const res1 = await makeRequest('GET', `/api/files/${FILE_ID}/download`);
  console.log(`HTTP Status: ${res1.statusCode}`);
  console.log(`Downloaded Bytes: ${res1.buffer.length}`);
  const hash1 = crypto.createHash('sha256').update(res1.buffer).digest('hex');
  console.log(`Ciphertext SHA-256: ${hash1}`);
  console.log(`Match Expected: ${hash1 === EXPECTED_CIPHERTEXT_HASH ? 'PASS (100% BIT-EXACT)' : 'FAIL'}`);
  if (res1.statusCode !== 200 || hash1 !== EXPECTED_CIPHERTEXT_HASH) {
    throw new Error('Scenario 1 Failed!');
  }

  // 3. Scenario 2: node-05 toggled offline (holds shard 3) → 5 shards surviving
  //    Shard map: node-03→{1,5}, node-01→{2,6}, node-05→{3}, node-04→{4}
  //    Offline node-05: loses shard 3. Remaining: 1,2,4,5,6 (5 shards) → RS succeeds
  console.log('\n------------------------------------------------------------------------');
  console.log('SCENARIO 2: node-05 Toggled OFFLINE (Holds Shard 3) → 5 Shards Available');
  console.log('------------------------------------------------------------------------');
  const toggleRes1 = await makeRequest('POST', '/api/nodes/node-05/toggle-status');
  console.log(`Toggle node-05 response:`, toggleRes1.json?.message || JSON.stringify(toggleRes1.json));

  const res2 = await makeRequest('GET', `/api/files/${FILE_ID}/download`);
  console.log(`HTTP Status: ${res2.statusCode}`);
  console.log(`Downloaded Bytes: ${res2.buffer.length}`);
  const hash2 = crypto.createHash('sha256').update(res2.buffer).digest('hex');
  console.log(`Ciphertext SHA-256: ${hash2}`);
  console.log(`Match Expected: ${hash2 === EXPECTED_CIPHERTEXT_HASH ? 'PASS (100% BIT-EXACT)' : 'FAIL'}`);
  if (res2.statusCode !== 200 || hash2 !== EXPECTED_CIPHERTEXT_HASH) {
    throw new Error(`Scenario 2 Failed! status=${res2.statusCode} hash=${hash2}`);
  }

  // 4. Scenario 3: node-04 ALSO toggled offline (holds shard 4) → 4 shards surviving (minimum quorum K=4)
  //    Offline: node-05{3} + node-04{4}. Remaining: shards 1,2,5,6 on node-03,node-01 → RS reconstruct
  console.log('\n------------------------------------------------------------------------');
  console.log('SCENARIO 3: node-04 ALSO Toggled OFFLINE (Holds Shard 4) → 4 Shards = Minimum K');
  console.log('------------------------------------------------------------------------');
  const toggleRes2 = await makeRequest('POST', '/api/nodes/node-04/toggle-status');
  console.log(`Toggle node-04 response:`, toggleRes2.json?.message || JSON.stringify(toggleRes2.json));

  const res3 = await makeRequest('GET', `/api/files/${FILE_ID}/download`);
  console.log(`HTTP Status: ${res3.statusCode}`);
  console.log(`Downloaded Bytes: ${res3.buffer.length}`);
  const hash3 = crypto.createHash('sha256').update(res3.buffer).digest('hex');
  console.log(`Ciphertext SHA-256: ${hash3}`);
  console.log(`Match Expected: ${hash3 === EXPECTED_CIPHERTEXT_HASH ? 'PASS (100% BIT-EXACT)' : 'FAIL'}`);
  if (res3.statusCode !== 200 || hash3 !== EXPECTED_CIPHERTEXT_HASH) {
    throw new Error(`Scenario 3 Failed! status=${res3.statusCode} hash=${hash3}`);
  }

  // 5. Scenario 4: node-01 ALSO toggled offline (holds shards 2,6) → only 2 shards remaining (<K=4 → FAIL)
  //    Offline: node-05{3} + node-04{4} + node-01{2,6}. Remaining: shards 1,5 on node-03 → sub-quorum
  console.log('\n------------------------------------------------------------------------');
  console.log('SCENARIO 4: node-01 ALSO Toggled OFFLINE (Holds Shards 2,6) → 2 Shards < K=4 → QUORUM FAILURE');
  console.log('------------------------------------------------------------------------');
  const toggleRes3 = await makeRequest('POST', '/api/nodes/node-01/toggle-status');
  console.log(`Toggle node-01 response:`, toggleRes3.json?.message || JSON.stringify(toggleRes3.json));

  const res4 = await makeRequest('GET', `/api/files/${FILE_ID}/download`);
  console.log(`HTTP Status: ${res4.statusCode} (Expected: 500)`);
  console.log(`Error Response:`, res4.json);
  if (res4.statusCode === 500 && res4.json?.error && res4.json.error.includes('Insufficient valid shards')) {
    console.log('Quorum Failure Test: PASS (Download strictly blocked when valid shards < 4)');
  } else {
    throw new Error(`Scenario 4 Failed: Expected 500 Quorum Failure, got ${res4.statusCode}: ${JSON.stringify(res4.json)}`);
  }

  // 6. Cleanup: Restore all nodes
  console.log('\n------------------------------------------------------------------------');
  console.log('SCENARIO 5: Node Recovery & Restoration (Restore all nodes to ONLINE)');
  console.log('------------------------------------------------------------------------');
  for (const n of ['node-01', 'node-04', 'node-05']) {
    const restoreRes = await makeRequest('POST', `/api/nodes/${n}/restore`);
    console.log(`Restored ${n}:`, restoreRes.json?.message || JSON.stringify(restoreRes.json));
  }

  const res5 = await makeRequest('GET', `/api/files/${FILE_ID}/download`);
  console.log(`HTTP Status after restoration: ${res5.statusCode}`);
  console.log(`Downloaded Bytes: ${res5.buffer.length}`);
  const hash5 = crypto.createHash('sha256').update(res5.buffer).digest('hex');
  console.log(`Ciphertext SHA-256: ${hash5}`);
  console.log(`Match Expected: ${hash5 === EXPECTED_CIPHERTEXT_HASH ? 'PASS (100% BIT-EXACT)' : 'FAIL'}`);
  if (res5.statusCode !== 200 || hash5 !== EXPECTED_CIPHERTEXT_HASH) {
    throw new Error(`Scenario 5 Failed! status=${res5.statusCode}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('ALL 5 EVALUATOR PROOF SCENARIOS PASSED WITH 100% SUCCESS!');
  console.log('='.repeat(80));
}

runProof().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
