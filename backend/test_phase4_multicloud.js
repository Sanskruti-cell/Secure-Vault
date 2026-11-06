import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { storageRegistry } from './src/services/storageProviders.js';
import { encodeReedSolomon42, decodeReedSolomon42 } from './src/services/shardingService.js';
import { calculateSHA256 } from './src/services/hashingService.js';

console.log('================================================================');
console.log('  TEST PHASE 4: PLUGGABLE MULTI-CLOUD STORAGE & 2-PER-CLOUD     ');
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
  const payload = crypto.randomBytes(32 * 1024); // 32 KiB payload
  const expectedPayloadSha256 = calculateSHA256(payload);
  const shards = encodeReedSolomon42(payload);
  const testFileId = `multi-cloud-${Date.now()}`;

  // Test 1: Plan multi-cloud allocation ensures exactly 2 AWS + 2 GCP + 2 Azure
  await test('planMultiCloudAllocation guarantees no single provider holds > 2 shards', async () => {
    const plans = storageRegistry.planMultiCloudAllocation(shards);
    assert.strictEqual(plans.length, 6);

    const counts = {};
    plans.forEach(p => {
      counts[p.provider] = (counts[p.provider] || 0) + 1;
    });

    assert.strictEqual(counts['aws-s3'], 2, 'Must have exactly 2 AWS S3 shards');
    assert.strictEqual(counts['gcp-gcs'], 2, 'Must have exactly 2 GCP GCS shards');
    assert.strictEqual(counts['azure-blob'], 2, 'Must have exactly 2 Azure Blob shards');
  });

  // Test 2: Write shards to isolated multi-cloud emulators
  const storedLocations = [];
  await test('Dispatch shards to discrete multi-cloud providers (AWS, GCP, Azure)', async () => {
    const plans = storageRegistry.planMultiCloudAllocation(shards);

    for (let i = 0; i < plans.length; i++) {
      const p = plans[i];
      const provider = storageRegistry.get(p.provider);
      const objectKey = `${testFileId}.shard.${p.shard.index}`;
      const writeResult = await provider.writeShard(p.bucket, objectKey, p.shard.data);

      assert.strictEqual(writeResult.provider, p.provider);
      assert.strictEqual(writeResult.size, p.shard.size);
      assert.ok(fs.existsSync(writeResult.storagePath));

      storedLocations.push({
        ...p,
        objectKey,
        storagePath: writeResult.storagePath,
        expectedHash: p.shard.hash
      });
    }
  });

  // Test 3: Complete simulated failure of AWS S3 (2 shards lost) -> Reconstruct from GCP + Azure (4 shards)
  await test('Full collapse of AWS S3 (2 shards lost): Reconstructs bit-exact from GCP & Azure', async () => {
    // Collect surviving shards strictly from GCP and Azure (shards 3, 4, 5, 6)
    const survivingShards = [];
    for (const loc of storedLocations) {
      if (loc.provider === 'aws-s3') {
        // AWS is DEAD / unreachable
        continue;
      }
      const provider = storageRegistry.get(loc.provider);
      const shardBytes = await provider.readShard(loc.bucket, loc.objectKey);
      survivingShards.push({
        shardIndex: loc.shard.index,
        data: shardBytes,
        expectedHash: loc.expectedHash
      });
    }

    assert.strictEqual(survivingShards.length, 4, 'Must have exactly 4 surviving shards from GCP + Azure');

    // Decode surviving 4 shards
    const recoveredPayload = decodeReedSolomon42(survivingShards);
    assert.strictEqual(calculateSHA256(recoveredPayload), expectedPayloadSha256, 'Payload must recover 100% bit-exact');
  });

  // Test 4: Complete simulated failure of GCP (2 shards lost) -> Reconstruct from AWS + Azure (4 shards)
  await test('Full collapse of GCP GCS (2 shards lost): Reconstructs bit-exact from AWS & Azure', async () => {
    const survivingShards = [];
    for (const loc of storedLocations) {
      if (loc.provider === 'gcp-gcs') {
        // GCP is DEAD
        continue;
      }
      const provider = storageRegistry.get(loc.provider);
      const shardBytes = await provider.readShard(loc.bucket, loc.objectKey);
      survivingShards.push({
        shardIndex: loc.shard.index,
        data: shardBytes,
        expectedHash: loc.expectedHash
      });
    }

    assert.strictEqual(survivingShards.length, 4);
    const recoveredPayload = decodeReedSolomon42(survivingShards);
    assert.strictEqual(calculateSHA256(recoveredPayload), expectedPayloadSha256, 'Payload must recover 100% bit-exact');
  });

  // Cleanup test shards across emulators
  for (const loc of storedLocations) {
    const provider = storageRegistry.get(loc.provider);
    await provider.deleteShard(loc.bucket, loc.objectKey);
  }

  console.log('\n================================================================');
  console.log(`  PHASE 4 SUMMARY: ${testsPassed}/${testsTotal} TESTS PASSED`);
  console.log('================================================================');
  process.exit(testsPassed === testsTotal ? 0 : 1);
})();
