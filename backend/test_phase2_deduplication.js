import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  processContentAddressedChunks,
  releaseFileChunkReferences,
  memChunks
} from './src/services/dedupService.js';
import { GLOBAL_INFRA_NODES } from './src/services/nodeService.js';

console.log('================================================================');
console.log('  TEST PHASE 2: CONTENT-ADDRESSED CHUNKING & DEDUPLICATION      ');
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
  const selectedNodes = GLOBAL_INFRA_NODES.slice(0, 6);
  const identicalCiphertext = crypto.randomBytes(64 * 1024); // 64 KiB identical encrypted block

  const file1Id = `file-alpha-${Date.now()}`;
  const file2Id = `file-beta-${Date.now()}`;

  // Test 1: Upload first file -> creates new chunks & writes 6 shards
  await test('First file upload creates content-addressed chunk with refCount=1 and writes 6 shards', async () => {
    const res1 = await processContentAddressedChunks(identicalCiphertext, file1Id, selectedNodes);
    assert.strictEqual(res1.chunkReferences.length, 1);
    assert.strictEqual(res1.chunkReferences[0].isDeduplicated, false, 'First upload must not be marked deduplicated');
    assert.strictEqual(res1.totalShardsWritten, 6, 'Must write 6 shards for new chunk');
    assert.strictEqual(res1.deduplicatedChunksCount, 0);

    const chunk = memChunks.find(c => c.chunkHash === res1.chunkReferences[0].chunkHash);
    assert.ok(chunk, 'Chunk must exist in memChunks');
    assert.strictEqual(chunk.refCount, 1);
    assert.ok(chunk.fileIds.includes(file1Id));
  });

  // Test 2: Upload second file with identical ciphertext chunk -> deduplicates (writes 0 new shards)
  await test('Second file upload with identical chunk deduplicates and skips redundant shard writes', async () => {
    const res2 = await processContentAddressedChunks(identicalCiphertext, file2Id, selectedNodes);
    assert.strictEqual(res2.chunkReferences.length, 1);
    assert.strictEqual(res2.chunkReferences[0].isDeduplicated, true, 'Second upload must be marked deduplicated');
    assert.strictEqual(res2.totalShardsWritten, 0, 'Must NOT write redundant shards to disk');
    assert.strictEqual(res2.deduplicatedChunksCount, 1);

    const chunk = memChunks.find(c => c.chunkHash === res2.chunkReferences[0].chunkHash);
    assert.strictEqual(chunk.refCount, 2, 'refCount must increment to 2');
    assert.ok(chunk.fileIds.includes(file1Id));
    assert.ok(chunk.fileIds.includes(file2Id));
  });

  // Test 3: Delete first file -> decrements refCount to 1, retains physical shards for second file
  await test('Deleting file 1 decrements refCount but does NOT delete shards still used by file 2', async () => {
    const releaseRes1 = await releaseFileChunkReferences(file1Id);
    assert.strictEqual(releaseRes1.deletedChunks.length, 0, 'No chunks should be purged while refCount > 0');
    assert.strictEqual(releaseRes1.retainedChunks.length, 1);

    const chunk = memChunks.find(c => c.chunkHash === releaseRes1.retainedChunks[0]);
    assert.ok(chunk, 'Chunk must still exist');
    assert.strictEqual(chunk.refCount, 1, 'refCount must now be 1');
    assert.ok(!chunk.fileIds.includes(file1Id), 'file1Id must be removed');
    assert.ok(chunk.fileIds.includes(file2Id), 'file2Id must remain');

    // Verify physical shards on disk still exist
    for (const s of chunk.shards) {
      assert.ok(fs.existsSync(s.storagePath), `Shard file must still exist: ${s.storagePath}`);
    }
  });

  // Test 4: Delete second file -> refCount drops to 0, physical shards are safely purged
  await test('Deleting file 2 drops refCount to 0 and safely purges orphan physical shards', async () => {
    const chunk = memChunks.find(c => c.fileIds.includes(file2Id));
    const shardPaths = chunk.shards.map(s => s.storagePath);

    const releaseRes2 = await releaseFileChunkReferences(file2Id);
    assert.strictEqual(releaseRes2.deletedChunks.length, 1, 'Chunk must now be purged');

    // Verify chunk is removed from memChunks
    const purgedChunk = memChunks.find(c => c.chunkHash === releaseRes2.deletedChunks[0]);
    assert.strictEqual(purgedChunk, undefined, 'Purged chunk must be removed from store');

    // Verify physical shard files were unlinked
    for (const p of shardPaths) {
      assert.strictEqual(fs.existsSync(p), false, `Orphan shard file must be unlinked: ${p}`);
    }
  });

  console.log('\n================================================================');
  console.log(`  PHASE 2 SUMMARY: ${testsPassed}/${testsTotal} TESTS PASSED`);
  console.log('================================================================');
  process.exit(testsPassed === testsTotal ? 0 : 1);
})();
