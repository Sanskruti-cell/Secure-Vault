import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  encodeReedSolomon42,
  reconstructSingleShard,
  repairFileShard
} from './src/services/shardingService.js';
import { calculateSHA256 } from './src/services/hashingService.js';
import { memFiles, memShards } from './src/controllers/fileController.js';
import { saveStoredFiles, saveStoredShards } from './src/services/storeService.js';

console.log('================================================================');
console.log('  TEST PHASE 1: STRUCTURED SHARD METADATA & REPAIR VERIFICATION ');
console.log('================================================================\n');

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
  // Test 1: Generate valid 4+2 shards and verify header + structure
  await test('Reed-Solomon 4+2 encoding generates structured shards with SVEC headers', async () => {
    const payload = crypto.randomBytes(1024 * 64); // 64 KiB ciphertext
    const shards = encodeReedSolomon42(payload);
    assert.strictEqual(shards.length, 6, 'Must generate exactly 6 shards');
    shards.forEach((s, idx) => {
      assert.strictEqual(s.index, idx + 1);
      assert.strictEqual(s.shardType, idx < 4 ? 'data' : 'parity');
      assert.strictEqual(s.data.subarray(0, 4).toString('ascii'), 'SVEC', 'Magic header must be SVEC');
      assert.strictEqual(s.hash, calculateSHA256(s.data), 'Hash must match SHA-256');
    });
  });

  // Test 2: Repair corrupted shard and verify pre-save verification + repair history
  await test('Self-healing reconstructSingleShard and repairFileShard records structured history', async () => {
    const testFileId = `test-file-${Date.now()}`;
    const testPayload = crypto.randomBytes(4096);
    const shards = encodeReedSolomon42(testPayload);

    // Save shards to disk node directories
    const nodeDirs = ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06'];
    const shardRecords = [];

    shards.forEach((s, i) => {
      const nodeDir = path.join(process.cwd(), 'storage', nodeDirs[i]);
      if (!fs.existsSync(nodeDir)) fs.mkdirSync(nodeDir, { recursive: true });
      const fullPath = path.join(nodeDir, `${testFileId}.shard.${s.index}`);
      fs.writeFileSync(fullPath, s.data);

      shardRecords.push({
        fileId: testFileId,
        shardIndex: s.index,
        shardType: s.shardType,
        nodeId: nodeDirs[i],
        provider: 'local',
        bucket: null,
        objectKey: `${testFileId}.shard.${s.index}`,
        shardHash: s.hash,
        shardSize: s.size,
        size: s.size,
        storagePath: fullPath,
        filePath: fullPath,
        status: 'active',
        lastVerifiedAt: new Date().toISOString(),
        verificationHistory: [{
          verifiedAt: new Date().toISOString(),
          status: 'passed',
          computedHash: s.hash
        }],
        repairHistory: []
      });
    });

    // Populate in-memory store
    memFiles.push({
      id: testFileId,
      userId: 'test-user-123',
      name: 'self_healing_test.bin',
      size: testPayload.length,
      cryptoVersion: 2,
      shardingVersion: 2
    });
    memShards.push(...shardRecords);

    // Corrupt shard #2: overwrite with random garbage
    const corruptedNodeDir = path.join(process.cwd(), 'storage', 'node-02');
    const corruptedPath = path.join(corruptedNodeDir, `${testFileId}.shard.2`);
    const originalHash = shardRecords[1].shardHash;
    fs.writeFileSync(corruptedPath, crypto.randomBytes(shards[1].size));

    // Verify damaged shard hash mismatch
    const badBytes = fs.readFileSync(corruptedPath);
    const badHash = calculateSHA256(badBytes);
    assert.notStrictEqual(badHash, originalHash, 'Corrupted shard must have different hash');

    // Run repair for shard #2
    const repairResult = await repairFileShard(testFileId, 2);
    assert.strictEqual(repairResult.success, true, 'Repair must succeed');
    assert.strictEqual(repairResult.shardIndex, 2);
    assert.strictEqual(repairResult.shardHash, originalHash, 'Repaired shard must match original SHA-256');

    // Check disk content was restored
    const restoredBytes = fs.readFileSync(corruptedPath);
    assert.strictEqual(calculateSHA256(restoredBytes), originalHash, 'Restored bytes must be bit-exact to original');

    // Check repair history entry
    assert.ok(repairResult.repairHistory, 'Repair result must include repairHistory');
    assert.strictEqual(repairResult.repairHistory.newHash, originalHash);
    assert.ok(repairResult.repairHistory.survivingShardsUsed.length >= 4, 'Must use at least 4 surviving shards');

    // Check memShards updated
    const updatedMemShard = memShards.find(s => s.fileId === testFileId && s.shardIndex === 2);
    assert.ok(updatedMemShard, 'memShards must contain repaired record');
    assert.strictEqual(updatedMemShard.shardHash, originalHash);
    assert.ok(updatedMemShard.repairHistory.length > 0, 'repairHistory must be recorded in memShards');

    // Clean up test files
    shards.forEach((s, i) => {
      const fullPath = path.join(process.cwd(), 'storage', nodeDirs[i], `${testFileId}.shard.${s.index}`);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
    });
    const fIdx = memFiles.findIndex(f => f.id === testFileId);
    if (fIdx !== -1) memFiles.splice(fIdx, 1);
    const remaining = memShards.filter(s => s.fileId !== testFileId);
    memShards.length = 0;
    memShards.push(...remaining);
  });

  // Test 3: Quorum failure test when fewer than 4 shards survive
  await test('Self-healing safely aborts when fewer than 4 surviving shards are available', async () => {
    const testFileId = `test-abort-${Date.now()}`;
    const testPayload = crypto.randomBytes(1024);
    const shards = encodeReedSolomon42(testPayload);

    // Only save 3 shards to disk
    const nodeDirs = ['node-01', 'node-02', 'node-03'];
    const shardRecords = [];

    for (let i = 0; i < 3; i++) {
      const s = shards[i];
      const nodeDir = path.join(process.cwd(), 'storage', nodeDirs[i]);
      if (!fs.existsSync(nodeDir)) fs.mkdirSync(nodeDir, { recursive: true });
      const fullPath = path.join(nodeDir, `${testFileId}.shard.${s.index}`);
      fs.writeFileSync(fullPath, s.data);

      shardRecords.push({
        fileId: testFileId,
        shardIndex: s.index,
        shardType: s.shardType,
        nodeId: nodeDirs[i],
        storagePath: fullPath,
        shardHash: s.hash,
        shardSize: s.size
      });
    }

    memFiles.push({ id: testFileId, userId: 'test-user-123', name: 'abort_test.bin' });
    memShards.push(...shardRecords);

    // Attempt repair of shard #4 when only 3 shards exist
    let threw = false;
    try {
      await repairFileShard(testFileId, 4);
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('requires at least 4'), 'Error must specify quorum requirement');
    }
    assert.strictEqual(threw, true, 'Must throw when surviving shards < 4');

    // Cleanup
    for (let i = 0; i < 3; i++) {
      const fullPath = path.join(process.cwd(), 'storage', nodeDirs[i], `${testFileId}.shard.${shards[i].index}`);
      try { if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath); } catch (e) {}
    }
    const fIdx = memFiles.findIndex(f => f.id === testFileId);
    if (fIdx !== -1) memFiles.splice(fIdx, 1);
    const remaining = memShards.filter(s => s.fileId !== testFileId);
    memShards.length = 0;
    memShards.push(...remaining);
  });

  console.log('\n================================================================');
  console.log(`  PHASE 1 SUMMARY: ${testsPassed}/${testsTotal} TESTS PASSED`);
  console.log('================================================================');
  process.exit(testsPassed === testsTotal ? 0 : 1);
})();
