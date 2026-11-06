import assert from 'assert';
import { verifyAuditChain, recordAuditEntry, computeEntryHash, initializeOrMigrateAuditChain } from './src/services/auditService.js';
import { getDedupStats, syncPersistedFilesToChunks } from './src/services/dedupService.js';
import { loadStoredFiles, loadStoredShards, loadStoredActivities } from './src/services/storeService.js';
import { isMongoConnected } from './src/config/db.js';

console.log('='.repeat(70));
console.log('🧪 TESTING FIXES FOR USER-REPORTED BUGS');
console.log('='.repeat(70));

let testsPassed = 0;
let testsTotal = 0;

async function test(name, fn) {
  testsTotal++;
  try {
    await fn();
    console.log(`  [PASS] Test ${testsTotal}: ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`  [FAIL] Test ${testsTotal}: ${name}`);
    console.error(`         ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

(async () => {
  // Test 1: Audit chain verification on persisted data
  await test('Audit chain verifies 20/20 entries with no NaN sequence errors', async () => {
    const res = await verifyAuditChain();
    assert.strictEqual(res.isValid, true, 'Audit chain must be valid');
    assert.ok(res.totalEntries >= 20, `Total entries must be >= 20 (found ${res.totalEntries})`);
    assert.strictEqual(res.checkedEntries, res.totalEntries, 'All entries must be checked');
    assert.strictEqual(res.error, null, 'Error must be null');
    assert.strictEqual(res.brokenSequenceIndex, null);
    assert.ok(res.latestEntryHash && res.latestEntryHash.length === 64);
  });

  // Test 2: Audit chain tamper detection preserved
  await test('Tamper detection is preserved and not falsely verified', async () => {
    const acts = loadStoredActivities();
    assert.ok(acts.length >= 20);
    // Find an entry to tamper with temporarily
    const originalDesc = acts[5].description;
    acts[5].description = 'UNAUTHORIZED_TAMPER_MODIFICATION';
    
    // Temporarily mutate memActivities
    const { memActivities } = await import('./src/services/storeService.js');
    const backup = [...memActivities];
    memActivities.length = 0;
    memActivities.push(...acts);

    const tamperRes = await verifyAuditChain();
    assert.strictEqual(tamperRes.isValid, false, 'Tampered chain must be rejected');
    assert.ok(tamperRes.error && tamperRes.error.includes('Tampered audit record detected'), 'Error must specify tamper');

    // Restore clean activities
    memActivities.length = 0;
    memActivities.push(...backup);
  });

  // Test 3: Dedup metrics on persisted user files (no 0 B or 0 chunks)
  await test('Dedup metrics returns accurate persisted size and chunk count (> 0)', async () => {
    const files = loadStoredFiles();
    const userFiles = files.filter(f => f.userId === '6a92e4ffd7607b6039cbfac1');
    const stats = await getDedupStats('6a92e4ffd7607b6039cbfac1');

    assert.ok(stats.totalChunks >= userFiles.length, `User chunks (${stats.totalChunks}) must be >= user file count (${userFiles.length})`);
    assert.ok(stats.totalLogicalBytes > 1000000, `Logical bytes must be > 1MB (found ${stats.totalLogicalBytes})`);
    assert.ok(stats.totalPhysicalBytes > 1000000, `Physical bytes must be > 1MB (found ${stats.totalPhysicalBytes})`);
    assert.ok(stats.storageEfficiencyRatio >= 1.0, 'Efficiency ratio must be >= 1.0');
  });

  // Test 4: Database fallback and data source verification
  await test('Database offline fallback accurately identifies persistent JSON data source', async () => {
    const files = loadStoredFiles();
    const shards = loadStoredShards();
    assert.ok(files.length >= 10, `Local store must contain persisted files (found ${files.length})`);
    assert.ok(shards.length >= 30, `Local store must contain persisted shards (found ${shards.length})`);
    assert.strictEqual(isMongoConnected, false, 'isMongoConnected should be false in sandbox without network');
  });

  console.log('\n' + '='.repeat(70));
  console.log(`SUMMARY: ${testsPassed}/${testsTotal} TESTS PASSED`);
  console.log('='.repeat(70));
  process.exit(testsPassed === testsTotal ? 0 : 1);
})();
