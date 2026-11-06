import assert from 'assert';
import mongoose from 'mongoose';
import { StorageNode } from './src/models/StorageNode.js';
import { DEFAULT_NODES, GLOBAL_INFRA_NODES } from './src/services/nodeService.js';

console.log('======================================================================');
console.log('  SECUREVAULT PHASE 6 - STEP 1: STORAGE NODE TELEMETRY SCHEMA TESTS  ');
console.log('======================================================================\n');

let passCount = 0;
let totalTests = 0;

function runTest(testName, fn) {
  totalTests++;
  try {
    fn();
    console.log(`[PASS] Test ${totalTests}: ${testName}`);
    passCount++;
  } catch (err) {
    console.error(`[FAIL] Test ${totalTests}: ${testName}`);
    console.error(`       Error: ${err.message}`);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// TEST 1: Schema Paths & Types Check
// -----------------------------------------------------------------------------
runTest('Schema path definitions & type registration', () => {
  const schema = StorageNode.schema;
  const paths = schema.paths;

  assert(paths.totalOperations, 'totalOperations path must be registered in schema');
  assert.strictEqual(paths.totalOperations.instance, 'Number', 'totalOperations must be Number');
  assert.strictEqual(paths.totalOperations.defaultValue, 0, 'totalOperations default must be 0');

  assert(paths.successfulOperations, 'successfulOperations path must be registered in schema');
  assert.strictEqual(paths.successfulOperations.instance, 'Number', 'successfulOperations must be Number');
  assert.strictEqual(paths.successfulOperations.defaultValue, 0, 'successfulOperations default must be 0');

  assert(paths.failedOperations, 'failedOperations path must be registered in schema');
  assert.strictEqual(paths.failedOperations.instance, 'Number', 'failedOperations must be Number');
  assert.strictEqual(paths.failedOperations.defaultValue, 0, 'failedOperations default must be 0');

  assert(paths.recentFailures, 'recentFailures path must be registered in schema');
  assert.strictEqual(paths.recentFailures.instance, 'Number', 'recentFailures must be Number');
  assert.strictEqual(paths.recentFailures.defaultValue, 0, 'recentFailures default must be 0');

  assert(paths.avgLatencyMs, 'avgLatencyMs path must be registered in schema');
  assert.strictEqual(paths.avgLatencyMs.instance, 'Number', 'avgLatencyMs must be Number');
  assert.strictEqual(paths.avgLatencyMs.defaultValue, null, 'avgLatencyMs default must be null');

  assert(paths.lastOperationalCheck, 'lastOperationalCheck path must be registered in schema');
  assert.strictEqual(paths.lastOperationalCheck.instance, 'Date', 'lastOperationalCheck must be Date');
  assert.strictEqual(paths.lastOperationalCheck.defaultValue, null, 'lastOperationalCheck default must be null');
});

// -----------------------------------------------------------------------------
// TEST 2: New Document Instantiation Defaults
// -----------------------------------------------------------------------------
runTest('Newly instantiated document receives safe operational telemetry defaults', () => {
  const node = new StorageNode({
    nodeId: 'node-test-01',
    name: 'TEST-NODE-ALPHA',
  });

  assert.strictEqual(node.totalOperations, 0, 'totalOperations must default to 0');
  assert.strictEqual(node.successfulOperations, 0, 'successfulOperations must default to 0');
  assert.strictEqual(node.failedOperations, 0, 'failedOperations must default to 0');
  assert.strictEqual(node.recentFailures, 0, 'recentFailures must default to 0');
  assert.strictEqual(node.avgLatencyMs, null, 'avgLatencyMs must default to null (unmeasured)');
  assert.strictEqual(node.lastOperationalCheck, null, 'lastOperationalCheck must default to null (unmeasured)');

  const plainObj = node.toObject();
  assert.strictEqual(plainObj.totalOperations, 0);
  assert.strictEqual(plainObj.successfulOperations, 0);
  assert.strictEqual(plainObj.failedOperations, 0);
  assert.strictEqual(plainObj.recentFailures, 0);
  assert.strictEqual(plainObj.avgLatencyMs, null);
  assert.strictEqual(plainObj.lastOperationalCheck, null);
});

// -----------------------------------------------------------------------------
// TEST 3: Existing / Legacy Document Compatibility
// -----------------------------------------------------------------------------
runTest('Existing document lacking telemetry fields loads safely with defaults', () => {
  // Simulating document retrieved from MongoDB that only has legacy pre-Step 1 fields
  const legacyRecord = {
    _id: new mongoose.Types.ObjectId(),
    nodeId: 'node-01',
    name: 'US-EAST-ALPHA',
    region: 'North Virginia, US',
    status: 'online',
    isSimulatedFailure: false,
    latency: 18,
    storageUsed: 320,
    storageTotal: 1000,
    uptime: 99.8,
  };

  const hydrated = StorageNode.hydrate(legacyRecord);

  assert.strictEqual(hydrated.nodeId, 'node-01');
  assert.strictEqual(hydrated.totalOperations, 0, 'Legacy document must yield 0 totalOperations');
  assert.strictEqual(hydrated.successfulOperations, 0, 'Legacy document must yield 0 successfulOperations');
  assert.strictEqual(hydrated.failedOperations, 0, 'Legacy document must yield 0 failedOperations');
  assert.strictEqual(hydrated.recentFailures, 0, 'Legacy document must yield 0 recentFailures');
  assert.strictEqual(hydrated.avgLatencyMs, null, 'Legacy document must yield null avgLatencyMs');
  assert.strictEqual(hydrated.lastOperationalCheck, null, 'Legacy document must yield null lastOperationalCheck');

  const obj = hydrated.toObject();
  assert.strictEqual(obj.nodeId, 'node-01');
  assert.strictEqual(obj.totalOperations, 0);
  assert.strictEqual(obj.successfulOperations, 0);
  assert.strictEqual(obj.failedOperations, 0);
  assert.strictEqual(obj.recentFailures, 0);
  assert.strictEqual(obj.avgLatencyMs, null);
  assert.strictEqual(obj.lastOperationalCheck, null);
});

// -----------------------------------------------------------------------------
// TEST 4: Distinguish Unmeasured (null) from Genuine Zero Measurements
// -----------------------------------------------------------------------------
runTest('Telemetry distinguishes unmeasured values (null) from genuine zero measurements', () => {
  // Case A: Unmeasured node
  const unmeasuredNode = new StorageNode({
    nodeId: 'node-unmeasured',
    name: 'UNMEASURED-NODE',
  });
  assert.strictEqual(unmeasuredNode.avgLatencyMs, null, 'Unmeasured latency must be null');
  assert.strictEqual(unmeasuredNode.lastOperationalCheck, null, 'Unmeasured check timestamp must be null');

  // Case B: Genuine measured zero (e.g., 0ms ultra-fast local mock or 0 failures)
  const measuredNode = new StorageNode({
    nodeId: 'node-measured',
    name: 'MEASURED-NODE',
    totalOperations: 12,
    successfulOperations: 12,
    failedOperations: 0,
    recentFailures: 0,
    avgLatencyMs: 0, // genuinely measured 0ms
    lastOperationalCheck: new Date(1700000000000),
  });

  assert.strictEqual(measuredNode.avgLatencyMs, 0, 'Genuine 0ms latency must be preserved as 0, not coerced to null');
  assert.strictEqual(typeof measuredNode.avgLatencyMs, 'number');
  assert.strictEqual(measuredNode.totalOperations, 12);
  assert.strictEqual(measuredNode.failedOperations, 0);
  assert.strictEqual(measuredNode.lastOperationalCheck.getTime(), 1700000000000);
});

// -----------------------------------------------------------------------------
// TEST 5: In-Memory Fallback Structures (DEFAULT_NODES & GLOBAL_INFRA_NODES)
// -----------------------------------------------------------------------------
runTest('In-memory fallback structures contain all operational telemetry fields with safe defaults', () => {
  assert(Array.isArray(DEFAULT_NODES), 'DEFAULT_NODES must be an array');
  assert.strictEqual(DEFAULT_NODES.length, 6, 'DEFAULT_NODES must contain exactly 6 nodes');
  assert.strictEqual(GLOBAL_INFRA_NODES, DEFAULT_NODES, 'GLOBAL_INFRA_NODES must reference DEFAULT_NODES');

  for (const node of DEFAULT_NODES) {
    assert(node.nodeId, 'Each node must have a nodeId');
    assert.strictEqual(typeof node.totalOperations, 'number', `${node.nodeId} must have numeric totalOperations`);
    assert.strictEqual(node.totalOperations, 0, `${node.nodeId} totalOperations must be 0`);
    assert.strictEqual(typeof node.successfulOperations, 'number', `${node.nodeId} must have numeric successfulOperations`);
    assert.strictEqual(node.successfulOperations, 0, `${node.nodeId} successfulOperations must be 0`);
    assert.strictEqual(typeof node.failedOperations, 'number', `${node.nodeId} must have numeric failedOperations`);
    assert.strictEqual(node.failedOperations, 0, `${node.nodeId} failedOperations must be 0`);
    assert.strictEqual(typeof node.recentFailures, 'number', `${node.nodeId} must have numeric recentFailures`);
    assert.strictEqual(node.recentFailures, 0, `${node.nodeId} recentFailures must be 0`);
    assert.strictEqual(node.avgLatencyMs, null, `${node.nodeId} avgLatencyMs must be null (unmeasured)`);
    assert.strictEqual(node.lastOperationalCheck, null, `${node.nodeId} lastOperationalCheck must be null (unmeasured)`);
  }
});

// -----------------------------------------------------------------------------
// TEST 6: Reed-Solomon 4+2 Constraint: Exactly 6 Distinct Simulated Nodes
// -----------------------------------------------------------------------------
runTest('Reed-Solomon 4+2 distinct 6-node cluster constraint preserved', () => {
  const nodeIds = DEFAULT_NODES.map(n => n.nodeId);
  const uniqueIds = new Set(nodeIds);

  assert.strictEqual(uniqueIds.size, 6, 'Cluster must model exactly 6 unique node IDs');
  assert.strictEqual(uniqueIds.size, DEFAULT_NODES.length, 'No duplicate node IDs allowed');

  const expectedNodes = ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06'];
  for (const exp of expectedNodes) {
    assert(uniqueIds.has(exp), `Expected node ${exp} must be present in cluster`);
  }
});

console.log('\n----------------------------------------------------------------------');
console.log(`  STEP 1 VERIFICATION RESULTS: ${passCount} / ${totalTests} tests passed (${Math.round((passCount / totalTests) * 100)}%)`);
console.log('======================================================================\n');
