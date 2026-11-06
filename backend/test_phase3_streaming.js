import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  initResumableSession,
  appendResumableChunk,
  getResumableSessionStatus,
  finalizeResumableStream,
  memUploadSessions
} from './src/services/streamingService.js';
import { calculateSHA256 } from './src/services/hashingService.js';

console.log('================================================================');
console.log('  TEST PHASE 3: LARGE-FILE STREAMING & RESUMABLE UPLOADS        ');
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
  // Test 1: Initialize session with 3 chunks
  const chunkSize = 16 * 1024; // 16 KiB per chunk
  const totalSize = 40 * 1024; // 40 KiB total -> 3 chunks (16 + 16 + 8)
  const fullData = crypto.randomBytes(totalSize);
  const expectedFullSha256 = calculateSHA256(fullData);

  const chunk0 = fullData.subarray(0, 16 * 1024);
  const chunk1 = fullData.subarray(16 * 1024, 32 * 1024);
  const chunk2 = fullData.subarray(32 * 1024);

  let sessionId = null;

  await test('initResumableSession initializes tracking for multi-chunk payload', async () => {
    sessionId = initResumableSession({
      userId: 'test-user-456',
      fileName: 'large_archive.tar.enc',
      totalSize,
      chunkSize,
      cryptoMetadata: { cryptoVersion: 2, algorithm: 'AES-256-GCM' }
    });
    assert.ok(sessionId.startsWith('sess-'));
    const status = getResumableSessionStatus(sessionId);
    assert.strictEqual(status.totalChunks, 3);
    assert.strictEqual(status.receivedChunksCount, 0);
    assert.deepStrictEqual(status.missingChunkIndices, [0, 1, 2]);
    assert.strictEqual(status.progressPercent, 0);
  });

  // Test 2: Upload chunk 0 and chunk 2 out of order (simulating network resume / concurrency)
  await test('appendResumableChunk supports out-of-order chunk uploads and tracks missing parts', async () => {
    // Append chunk 0
    const res0 = await appendResumableChunk(sessionId, 0, chunk0, calculateSHA256(chunk0));
    assert.strictEqual(res0.isComplete, false);
    assert.strictEqual(res0.receivedChunks, 1);

    // Append chunk 2 (chunk 1 still missing)
    const res2 = await appendResumableChunk(sessionId, 2, chunk2, calculateSHA256(chunk2));
    assert.strictEqual(res2.isComplete, false);
    assert.strictEqual(res2.receivedChunks, 2);

    const status = getResumableSessionStatus(sessionId);
    assert.deepStrictEqual(status.missingChunkIndices, [1], 'Must accurately report missing chunk 1');
    assert.ok(status.progressPercent > 50, 'Progress must reflect received bytes');
  });

  // Test 3: Integrity verification catches corrupted chunk upload
  await test('appendResumableChunk rejects corrupted chunk when expected SHA-256 does not match', async () => {
    let threw = false;
    try {
      // Pass corrupted buffer with chunk 1 hash
      const badBuf = crypto.randomBytes(chunk1.length);
      await appendResumableChunk(sessionId, 1, badBuf, calculateSHA256(chunk1));
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('integrity verification failed'));
    }
    assert.strictEqual(threw, true, 'Must reject bad chunk');
  });

  // Test 4: Upload missing chunk 1 and finalize assembly
  await test('Finalizing completed session concatenates bit-exact payload and cleans up staging', async () => {
    const res1 = await appendResumableChunk(sessionId, 1, chunk1, calculateSHA256(chunk1));
    assert.strictEqual(res1.isComplete, true, 'Session must now be complete');

    const finalizeResult = await finalizeResumableStream(sessionId);
    assert.strictEqual(finalizeResult.totalBytes, totalSize);
    assert.strictEqual(finalizeResult.fullSha256, expectedFullSha256, 'Reconstructed stream must be 100% bit-exact');
    assert.strictEqual(memUploadSessions[sessionId], undefined, 'Session must be cleaned up from memory');
  });

  console.log('\n================================================================');
  console.log(`  PHASE 3 SUMMARY: ${testsPassed}/${testsTotal} TESTS PASSED`);
  console.log('================================================================');
  process.exit(testsPassed === testsTotal ? 0 : 1);
})();
