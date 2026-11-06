import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  recordNodeOperation,
  writeNodeShard,
  readNodeShard,
  resetNodeTelemetry,
  GLOBAL_INFRA_NODES,
  DEFAULT_NODES
} from './src/services/nodeService.js';
import { isMongoConnected } from './src/config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = path.join(__dirname, 'test_storage_telemetry_scratch');

console.log('======================================================================');
console.log('  SECUREVAULT PHASE 6 - STEP 2: OPERATIONAL TELEMETRY TEST SUITE     ');
console.log('======================================================================\n');

let passCount = 0;
let totalTests = 0;

async function runTest(testName, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] Test ${totalTests}: ${testName}`);
    console.error(`       Error: ${err.message}`);
    process.exitCode = 1;
  }
}

// Clean up scratch directory before and after
function cleanupScratch() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

cleanupScratch();
fs.mkdirSync(TEST_DIR, { recursive: true });

(async () => {
  // ---------------------------------------------------------------------------
  // TEST 1: Successful storage operation updates the correct counters
  // ---------------------------------------------------------------------------
  await runTest('Successful storage operation increments total and successful counters', async () => {
    resetNodeTelemetry('node-01');
    const targetPath = path.join(TEST_DIR, 'node-01', 'sample.shard.1');
    const sampleData = Buffer.from('secure-vault-shard-data-payload-01');

    await writeNodeShard('node-01', targetPath, sampleData);

    const node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-01');
    assert(node, 'node-01 must exist');
    assert.strictEqual(node.totalOperations, 1, 'totalOperations must be 1');
    assert.strictEqual(node.successfulOperations, 1, 'successfulOperations must be 1');
    assert.strictEqual(node.failedOperations, 0, 'failedOperations must remain 0');
    assert.strictEqual(node.recentFailures, 0, 'recentFailures must remain 0');
    assert(typeof node.avgLatencyMs === 'number', 'avgLatencyMs must be a number');
    assert(node.avgLatencyMs >= 0, 'avgLatencyMs must be non-negative');
    assert(node.lastOperationalCheck instanceof Date, 'lastOperationalCheck must be updated to Date');
    assert(fs.existsSync(targetPath), 'File must be written to disk');
  });

  // ---------------------------------------------------------------------------
  // TEST 2: Failed storage operation updates the correct counters
  // ---------------------------------------------------------------------------
  await runTest('Failed storage operation increments total and failed counters', async () => {
    resetNodeTelemetry('node-02');
    const nonExistentPath = path.join(TEST_DIR, 'node-02', 'missing-shard.2');

    let threw = false;
    try {
      await readNodeShard('node-02', nonExistentPath);
    } catch (e) {
      threw = true;
    }
    assert(threw, 'readNodeShard must throw for missing shard');

    const node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-02');
    assert(node, 'node-02 must exist');
    assert.strictEqual(node.totalOperations, 1, 'totalOperations must be 1');
    assert.strictEqual(node.successfulOperations, 0, 'successfulOperations must be 0');
    assert.strictEqual(node.failedOperations, 1, 'failedOperations must be 1');
    assert.strictEqual(node.recentFailures, 1, 'recentFailures must be 1');
    assert(typeof node.avgLatencyMs === 'number', 'avgLatencyMs must be recorded');
    assert(node.lastOperationalCheck instanceof Date, 'lastOperationalCheck must be updated to Date');
  });

  // ---------------------------------------------------------------------------
  // TEST 3: recentFailures increments on consecutive failures and resets after success
  // ---------------------------------------------------------------------------
  await runTest('recentFailures accumulates on failures and resets to zero on success', async () => {
    resetNodeTelemetry('node-03');

    // 1st failure
    await recordNodeOperation('node-03', 5.0, false);
    let node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-03');
    assert.strictEqual(node.recentFailures, 1);
    assert.strictEqual(node.failedOperations, 1);
    assert.strictEqual(node.totalOperations, 1);

    // 2nd failure
    await recordNodeOperation('node-03', 6.0, false);
    assert.strictEqual(node.recentFailures, 2);
    assert.strictEqual(node.failedOperations, 2);
    assert.strictEqual(node.totalOperations, 2);

    // 3rd failure
    await recordNodeOperation('node-03', 7.0, false);
    assert.strictEqual(node.recentFailures, 3);
    assert.strictEqual(node.failedOperations, 3);
    assert.strictEqual(node.totalOperations, 3);

    // Success resets recentFailures to 0
    await recordNodeOperation('node-03', 4.0, true);
    assert.strictEqual(node.recentFailures, 0, 'recentFailures must reset to 0 after success');
    assert.strictEqual(node.successfulOperations, 1);
    assert.strictEqual(node.failedOperations, 3);
    assert.strictEqual(node.totalOperations, 4);
  });

  // ---------------------------------------------------------------------------
  // TEST 4: First real latency observation initializes avgLatencyMs correctly
  // ---------------------------------------------------------------------------
  await runTest('First latency observation initializes avgLatencyMs from null without zero fabrication', async () => {
    resetNodeTelemetry('node-04');
    let node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-04');
    assert.strictEqual(node.avgLatencyMs, null, 'Unmeasured node must start with avgLatencyMs === null');

    await recordNodeOperation('node-04', 15.42, true);
    assert.strictEqual(node.avgLatencyMs, 15.42, 'First observation must set avgLatencyMs to exactly 15.42');
  });

  // ---------------------------------------------------------------------------
  // TEST 5: Subsequent observations maintain a valid running average
  // ---------------------------------------------------------------------------
  await runTest('Subsequent observations maintain mathematical running average', async () => {
    resetNodeTelemetry('node-04');

    // Op 1: 10.0ms -> avg = 10.0ms
    await recordNodeOperation('node-04', 10.0, true);
    let node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-04');
    assert.strictEqual(node.avgLatencyMs, 10.0);

    // Op 2: 20.0ms -> avg = (10*1 + 20)/2 = 15.0ms
    await recordNodeOperation('node-04', 20.0, true);
    assert.strictEqual(node.avgLatencyMs, 15.0);

    // Op 3: 30.0ms -> avg = (15*2 + 30)/3 = 20.0ms
    await recordNodeOperation('node-04', 30.0, true);
    assert.strictEqual(node.avgLatencyMs, 20.0);

    // Op 4: 10.0ms -> avg = (20*3 + 10)/4 = 70/4 = 17.5ms
    await recordNodeOperation('node-04', 10.0, false);
    assert.strictEqual(node.avgLatencyMs, 17.5);
    assert.strictEqual(node.totalOperations, 4);
  });

  // ---------------------------------------------------------------------------
  // TEST 6: lastOperationalCheck updates after an attempted operation
  // ---------------------------------------------------------------------------
  await runTest('lastOperationalCheck timestamp updates on every attempted operation', async () => {
    resetNodeTelemetry('node-05');
    let node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-05');
    assert.strictEqual(node.lastOperationalCheck, null);

    const before = Date.now() - 100;
    await recordNodeOperation('node-05', 8.5, true);
    const after = Date.now() + 100;

    assert(node.lastOperationalCheck instanceof Date, 'Must be Date object');
    assert(node.lastOperationalCheck.getTime() >= before, 'Timestamp must be after start time');
    assert(node.lastOperationalCheck.getTime() <= after, 'Timestamp must be before end time');
  });

  // ---------------------------------------------------------------------------
  // TEST 7: Telemetry persistence failure does not break underlying storage operation
  // ---------------------------------------------------------------------------
  await runTest('Telemetry failure does not prevent successful storage write/read', async () => {
    // Pass an abnormal nodeId or simulate internal telemetry error
    const testPath = path.join(TEST_DIR, 'safe-io.shard');
    const data = Buffer.from('critical-user-data-payload');

    // writeNodeShard should succeed even if given an unusual node key
    const written = await writeNodeShard('node-nonexistent-mock', testPath, data);
    assert.strictEqual(written, testPath);
    assert(fs.existsSync(testPath));

    const read = await readNodeShard('node-nonexistent-mock', testPath);
    assert(read.equals(data), 'Read buffer must match written data');
  });

  // ---------------------------------------------------------------------------
  // TEST 8: Database-unavailable in-memory fallback works
  // ---------------------------------------------------------------------------
  await runTest('In-memory fallback accurately maintains all operational telemetry', async () => {
    resetNodeTelemetry('node-06');
    const node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-06');
    assert(node);

    await recordNodeOperation('node-06', 12.0, true);
    await recordNodeOperation('node-06', 18.0, false);

    assert.strictEqual(node.totalOperations, 2);
    assert.strictEqual(node.successfulOperations, 1);
    assert.strictEqual(node.failedOperations, 1);
    assert.strictEqual(node.recentFailures, 1);
    assert.strictEqual(node.avgLatencyMs, 15.0);
    assert(node.lastOperationalCheck instanceof Date);
  });

  // ---------------------------------------------------------------------------
  // TEST 9: A single operation is not double-counted
  // ---------------------------------------------------------------------------
  await runTest('A single storage operation increments totalOperations by exactly one', async () => {
    resetNodeTelemetry('node-01');
    const node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-01');
    assert.strictEqual(node.totalOperations, 0);

    const testFile = path.join(TEST_DIR, 'node-01', 'single-op.shard');
    await writeNodeShard('node-01', testFile, Buffer.from('one-write-op'));
    assert.strictEqual(node.totalOperations, 1, 'Write must increment totalOperations by exactly 1');

    await readNodeShard('node-01', testFile);
    assert.strictEqual(node.totalOperations, 2, 'Read must increment totalOperations by exactly 1');
  });

  // ---------------------------------------------------------------------------
  // TEST 10: Configured static latency remains distinct from measured avgLatencyMs
  // ---------------------------------------------------------------------------
  await runTest('Configured static latency is preserved and distinct from measured avgLatencyMs', async () => {
    const node = GLOBAL_INFRA_NODES.find(n => n.nodeId === 'node-01');
    assert.strictEqual(node.latency, 18, 'Static baseline latency (18ms) must not be mutated');
    assert(node.avgLatencyMs !== undefined, 'avgLatencyMs is a separate operational metric');
  });

  cleanupScratch();

  console.log('\n----------------------------------------------------------------------');
  console.log(`  STEP 2 VERIFICATION RESULTS: ${passCount} / ${totalTests} tests passed (${Math.round((passCount / totalTests) * 100)}%)`);
  console.log('======================================================================\n');
})();
