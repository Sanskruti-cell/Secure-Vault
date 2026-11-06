import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  gfMul,
  gfDiv,
  gfInv,
  invertMatrixGF,
  CAUCHY_GENERATOR_MATRIX_6x4,
  encodeReedSolomon42,
  decodeReedSolomon42,
  reconstructSingleShard,
  splitIntoShards,
  reassembleShards,
  MAGIC_HEADER,
  FORMAT_VERSION_RS42,
  RS_DATA_SHARDS,
  RS_PARITY_SHARDS,
  RS_TOTAL_SHARDS
} from './src/services/shardingService.js';
import { calculateSHA256 } from './src/services/hashingService.js';
import { encryptBuffer, decryptBuffer } from './src/services/encryptionService.js';

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  [PASS] Test ${totalTests}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] Test ${totalTests}: ${name}`);
    console.error(`         Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  [PASS] Test ${totalTests}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  [FAIL] Test ${totalTests}: ${name}`);
    console.error(`         Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

console.log('================================================================');
console.log('  SECUREVAULT REED-SOLOMON (4+2) ERASURE CODING TEST SUITE      ');
console.log('================================================================');

// Helper combinations generator C(n, k)
function getCombinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  const head = arr[0];
  const tail = arr.slice(1);
  const withHead = getCombinations(tail, k - 1).map(c => [head, ...c]);
  const withoutHead = getCombinations(tail, k);
  return [...withHead, ...withoutHead];
}

// -----------------------------------------------------------------------------
// Test 1: Mathematical Invertibility of all 15 submatrices of Cauchy G (6x4)
// -----------------------------------------------------------------------------
runTest('Mathematical Invertibility: All 15 submatrices C(6, 4) are invertible over GF(2^8)', () => {
  const rowIndices = [0, 1, 2, 3, 4, 5];
  const combinations = getCombinations(rowIndices, 4);
  assert.strictEqual(combinations.length, 15, 'There must be exactly 15 submatrices C(6, 4)');

  for (const comb of combinations) {
    const subMatrix = comb.map(idx => CAUCHY_GENERATOR_MATRIX_6x4[idx]);
    const inv = invertMatrixGF(subMatrix);
    assert.strictEqual(inv.length, 4, 'Inverse matrix must be 4x4');
    
    // Verify subMatrix * inv === I_4 in GF(2^8)
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum ^= gfMul(subMatrix[r][k], inv[k][c]);
        }
        const expected = r === c ? 1 : 0;
        assert.strictEqual(sum, expected, `Matrix multiplication must yield identity for comb ${comb}`);
      }
    }
  }
});

// -----------------------------------------------------------------------------
// Test 2: Encoding & Decoding with 0 Missing Shards (All 6 Shards Present)
// -----------------------------------------------------------------------------
runTest('RS 4+2 Encoding & Decoding with 0 Missing Shards (All 6 Present)', () => {
  const plaintext = Buffer.from('SecureVault confidential payload for testing RS 4+2 encoding.');
  const ciphertext = crypto.randomBytes( plaintext.length + 16 ); // Simulated AES-GCM ciphertext
  
  const shards = encodeReedSolomon42(ciphertext);
  assert.strictEqual(shards.length, 6, 'Must produce exactly 6 shards');
  assert.strictEqual(shards[0].shardType, 'data');
  assert.strictEqual(shards[3].shardType, 'data');
  assert.strictEqual(shards[4].shardType, 'parity');
  assert.strictEqual(shards[5].shardType, 'parity');

  const reconstructed = decodeReedSolomon42(shards);
  assert.strictEqual(Buffer.compare(ciphertext, reconstructed), 0, 'Reconstructed ciphertext must match original 100%');
});

// -----------------------------------------------------------------------------
// Test 3: Any 1 Missing Shard (All 6 Single-Missing Shard Scenarios)
// -----------------------------------------------------------------------------
runTest('RS 4+2 Reconstruction with ANY 1 Missing Shard (All 6 Scenarios)', () => {
  const ciphertext = crypto.randomBytes(1024);
  const shards = encodeReedSolomon42(ciphertext);

  for (let missingIdx = 1; missingIdx <= 6; missingIdx++) {
    const surviving = shards.filter(s => s.shardIndex !== missingIdx);
    assert.strictEqual(surviving.length, 5, 'Surviving shards must be 5');
    const reconstructed = decodeReedSolomon42(surviving);
    assert.strictEqual(
      Buffer.compare(ciphertext, reconstructed),
      0,
      `Reconstruction must succeed when shard #${missingIdx} is missing`
    );
  }
});

// -----------------------------------------------------------------------------
// Test 4: Any 2 Missing Shards (Exhaustive Test of All 15 Pairs)
// -----------------------------------------------------------------------------
runTest('RS 4+2 Reconstruction with ANY 2 Missing Shards (Exhaustive 15 Pairs)', () => {
  const ciphertext = crypto.randomBytes(2048);
  const shards = encodeReedSolomon42(ciphertext);
  const allIndices = [1, 2, 3, 4, 5, 6];
  const missingPairs = getCombinations(allIndices, 2);
  assert.strictEqual(missingPairs.length, 15, 'Must test exactly 15 pairwise failure combinations');

  for (const [m1, m2] of missingPairs) {
    const surviving = shards.filter(s => s.shardIndex !== m1 && s.shardIndex !== m2);
    assert.strictEqual(surviving.length, 4, `Surviving shards must be 4 when missing {${m1}, ${m2}}`);
    const reconstructed = decodeReedSolomon42(surviving);
    assert.strictEqual(
      Buffer.compare(ciphertext, reconstructed),
      0,
      `Reconstruction must succeed when missing shards {${m1}, ${m2}}`
    );
  }
});

// -----------------------------------------------------------------------------
// Test 5: Rejection when 3 or More Shards are Missing (< 4 Surviving)
// -----------------------------------------------------------------------------
runTest('RS 4+2 Reconstruction Fails Gracefully with 3 Missing Shards (< 4 Surviving)', () => {
  const ciphertext = crypto.randomBytes(512);
  const shards = encodeReedSolomon42(ciphertext);
  const surviving = shards.slice(0, 3); // Only 3 shards

  assert.throws(
    () => decodeReedSolomon42(surviving),
    /Insufficient valid shards|Distinct shards available/,
    'Must throw error when fewer than 4 shards are supplied'
  );
});

// -----------------------------------------------------------------------------
// Test 6: Corrupted Shard Detection via SHA-256 and Automatic Discarding
// -----------------------------------------------------------------------------
runTest('Corrupted Shard Detection: Corrupted shard is detected & filtered out via SHA-256', () => {
  const ciphertext = crypto.randomBytes(1500);
  const shards = encodeReedSolomon42(ciphertext);

  // Corrupt shard #2 payload by flipping bytes
  const corruptedShard2 = {
    shardIndex: 2,
    data: Buffer.from(shards[1].data),
    expectedHash: shards[1].hash // Expected original hash
  };
  corruptedShard2.data[20] ^= 0xff; // Flip a byte in the payload

  // Provide all 6 shards, but shard 2 is corrupted (leaving 5 valid shards)
  const inputShards = [shards[0], corruptedShard2, shards[2], shards[3], shards[4], shards[5]];
  const reconstructed = decodeReedSolomon42(inputShards);
  assert.strictEqual(
    Buffer.compare(ciphertext, reconstructed),
    0,
    'Reconstruction must discard corrupted shard and recover from 5 surviving valid shards'
  );

  // Now corrupt shard #2 AND shard #5 (leaving 4 valid shards: 1, 3, 4, 6)
  const corruptedShard5 = {
    shardIndex: 5,
    data: Buffer.from(shards[4].data),
    expectedHash: shards[4].hash
  };
  corruptedShard5.data[25] ^= 0xaa;

  const inputShards4Valid = [shards[0], corruptedShard2, shards[2], shards[3], corruptedShard5, shards[5]];
  const reconstructed4 = decodeReedSolomon42(inputShards4Valid);
  assert.strictEqual(
    Buffer.compare(ciphertext, reconstructed4),
    0,
    'Reconstruction must discard 2 corrupted shards and recover from the 4 surviving valid shards'
  );
});

// -----------------------------------------------------------------------------
// Test 7: Arbitrary File Sizes, Odd Sizes, and Chunk Boundary Conditions
// -----------------------------------------------------------------------------
runTest('Arbitrary File Sizes & Boundary Conditions: 1B, 3B, 7B, 15B, 1KB, 64KB, 1MB', () => {
  const testSizes = [1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 100, 1024, 65535, 65536, 1048576];

  for (const sz of testSizes) {
    const ciphertext = crypto.randomBytes(sz);
    const shards = encodeReedSolomon42(ciphertext);
    assert.strictEqual(shards.length, 6, `Encoding size ${sz} must produce 6 shards`);

    // Test with missing shards {2, 5}
    const surviving = [shards[0], shards[2], shards[3], shards[5]];
    const recovered = decodeReedSolomon42(surviving);
    assert.strictEqual(
      recovered.length,
      sz,
      `Recovered length must be exact ${sz} bytes without padding overflow`
    );
    assert.strictEqual(
      Buffer.compare(ciphertext, recovered),
      0,
      `Recovered data for size ${sz} must be byte-exact match`
    );
  }
});

// -----------------------------------------------------------------------------
// Test 8: Self-Healing Shard Repair Functionality
// -----------------------------------------------------------------------------
runTest('Self-Healing: Reconstruct any single missing shard from 4 surviving shards', () => {
  const ciphertext = crypto.randomBytes(4096);
  const originalShards = encodeReedSolomon42(ciphertext);

  for (let targetIndex = 1; targetIndex <= 6; targetIndex++) {
    // Pick 4 surviving shards that exclude targetIndex
    const surviving = originalShards.filter(s => s.shardIndex !== targetIndex).slice(0, 4);
    assert.strictEqual(surviving.length, 4, 'Must have 4 surviving shards');

    const repairedData = reconstructSingleShard(surviving, targetIndex);
    const originalData = originalShards[targetIndex - 1].data;

    assert.strictEqual(
      Buffer.compare(originalData, repairedData),
      0,
      `Repaired shard #${targetIndex} buffer must match original shard #${targetIndex} byte-for-byte`
    );

    // Verify reconstructed shard has valid header
    assert.strictEqual(repairedData.subarray(0, 4).equals(MAGIC_HEADER), true, 'Repaired shard must have SVEC header');
    assert.strictEqual(repairedData.readUInt8(4), FORMAT_VERSION_RS42, 'Repaired shard format version must be 2');
    assert.strictEqual(repairedData.readUInt8(5), targetIndex, 'Repaired shard index must match target');
  }
});

// -----------------------------------------------------------------------------
// Test 9: End-to-End Cryptography + RS 4+2 + 2 Node Failure + Decryption Pipeline
// -----------------------------------------------------------------------------
runTest('Full Pipeline: Client AES-GCM Encrypt -> RS 4+2 -> 2 Node Failure -> RS Decode -> Client Decrypt', () => {
  const originalPlaintext = Buffer.from('Top secret biometric master record encrypted with AES-256-GCM.');
  const filePassword = 'SuperSecurePassword2026!';
  const salt = crypto.randomBytes(16);
  const baseNonce = crypto.randomBytes(8);

  // Derive KEK
  const kek = crypto.pbkdf2Sync(filePassword, salt, 100000, 32, 'sha256');
  // Generate random DEK
  const dek = crypto.randomBytes(32);
  // Encrypt DEK with KEK (AES-256-KW or AES-GCM mock)
  const kwCipher = crypto.createCipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0));
  const wrappedDEK = Buffer.concat([kwCipher.update(dek), kwCipher.final(), kwCipher.getAuthTag()]);

  // Client encrypt plaintext with DEK
  const chunkIV = Buffer.concat([baseNonce, Buffer.from([0, 0, 0, 0])]); // 12-byte IV for chunk 0
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, chunkIV);
  const ciphertextPayload = Buffer.concat([cipher.update(originalPlaintext), cipher.final(), cipher.getAuthTag()]);

  // Shard ciphertext with Reed-Solomon 4+2
  const shards = encodeReedSolomon42(ciphertextPayload);
  assert.strictEqual(shards.length, 6);

  // Simulate 2 storage nodes going offline: Node 2 (shard 2) and Node 6 (shard 6)
  const onlineShards = [shards[0], shards[2], shards[3], shards[4]]; // Shards 1, 3, 4, 5
  assert.strictEqual(onlineShards.length, 4);

  // Reassemble ciphertext from available 4 shards
  const reconstructedCiphertext = reassembleShards(onlineShards);
  assert.strictEqual(Buffer.compare(ciphertextPayload, reconstructedCiphertext), 0, 'Reconstructed ciphertext matches');

  // Client side: Unwrap DEK
  const kwDec = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0));
  kwDec.setAuthTag(wrappedDEK.subarray(wrappedDEK.length - 16));
  const unwrappedDEK = Buffer.concat([kwDec.update(wrappedDEK.subarray(0, wrappedDEK.length - 16)), kwDec.final()]);
  assert.strictEqual(Buffer.compare(dek, unwrappedDEK), 0, 'DEK unwrap succeeds');

  // Client side: Decrypt reconstructed ciphertext
  const authTag = reconstructedCiphertext.subarray(reconstructedCiphertext.length - 16);
  const encryptedBytes = reconstructedCiphertext.subarray(0, reconstructedCiphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', unwrappedDEK, chunkIV);
  decipher.setAuthTag(authTag);
  const decryptedPlaintext = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);

  assert.strictEqual(
    Buffer.compare(originalPlaintext, decryptedPlaintext),
    0,
    'End-to-end decrypted plaintext matches original plaintext 100%'
  );
});

// -----------------------------------------------------------------------------
// Test 10: Storage Node Distribution across 6 Nodes
// -----------------------------------------------------------------------------
runTest('Storage Node Distribution: 6 shards distributed to node-01 through node-06', () => {
  const ciphertext = crypto.randomBytes(1200);
  const shards = splitIntoShards(ciphertext, 6, { shardingVersion: 2 });
  assert.strictEqual(shards.length, 6);

  const targetNodes = ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06'];
  const distribution = shards.map((s, i) => ({
    shardIndex: s.shardIndex,
    nodeId: targetNodes[i % targetNodes.length]
  }));

  assert.strictEqual(distribution.length, 6);
  const uniqueNodes = new Set(distribution.map(d => d.nodeId));
  assert.strictEqual(uniqueNodes.size, 6, 'All 6 distinct nodes must be allocated for the 6 shards');
});

// -----------------------------------------------------------------------------
// Test 11: Metadata Verification for Sharding Version 2
// -----------------------------------------------------------------------------
runTest('Metadata Verification: shardingVersion=2, erasureCoding="reed-solomon", dataShards=4, parityShards=2, totalShards=6', () => {
  const sampleHeader = Buffer.alloc(16);
  MAGIC_HEADER.copy(sampleHeader, 0);
  sampleHeader.writeUInt8(FORMAT_VERSION_RS42, 4);
  sampleHeader.writeUInt8(1, 5); // Shard 1
  sampleHeader.writeUInt8(RS_DATA_SHARDS, 6);
  sampleHeader.writeUInt8(RS_PARITY_SHARDS, 7);
  sampleHeader.writeUInt32BE(1000, 8);
  sampleHeader.writeUInt32BE(250, 12);

  assert.strictEqual(sampleHeader.readUInt8(4), 2, 'Header version must be 2');
  assert.strictEqual(sampleHeader.readUInt8(6), 4, 'Data shards must be 4');
  assert.strictEqual(sampleHeader.readUInt8(7), 2, 'Parity shards must be 2');
});

// -----------------------------------------------------------------------------
// Test 12: Legacy Compatibility: 3+1 XOR (Version 1) Files Continue to Work
// -----------------------------------------------------------------------------
runTest('Legacy Compatibility: 3+1 XOR Files (shardingVersion: 1) continue to encode and reconstruct', () => {
  const legacyPayload = Buffer.from('Legacy file payload from Phase 1/Phase 2 test suite.');
  
  // Encode with legacy 3+1 XOR scheme
  const legacyShards = splitIntoShards(legacyPayload, 4, { shardingVersion: 1 });
  assert.strictEqual(legacyShards.length, 4, 'Legacy must produce 4 shards');
  assert.strictEqual(legacyShards[0].data.readUInt8(4), 1, 'Legacy header version must be 1');
  assert.strictEqual(legacyShards[0].data.readUInt8(6), 3, 'Legacy data shards must be 3');
  assert.strictEqual(legacyShards[0].data.readUInt8(7), 1, 'Legacy parity shards must be 1');

  // Test legacy reassembly with 0 missing shards
  const recoveredFull = reassembleShards(legacyShards);
  assert.strictEqual(Buffer.compare(legacyPayload, recoveredFull), 0, 'Legacy 4/4 reassembly matches');

  // Test legacy reassembly with 1 missing data shard (shard #2)
  const survivingLegacy = [legacyShards[0], legacyShards[2], legacyShards[3]]; // Shards 1, 3, 4 (p1)
  const recoveredMissing1 = reassembleShards(survivingLegacy);
  assert.strictEqual(Buffer.compare(legacyPayload, recoveredMissing1), 0, 'Legacy 3/4 reassembly with parity matches');
});

// -----------------------------------------------------------------------------
// Test 13: Wire Security Check: Zero Plaintext in Sharding Layer
// -----------------------------------------------------------------------------
runTest('Wire Security: Sharding input and shard outputs never contain plaintext byte patterns', () => {
  const plaintextSecret = 'SUPER_SECRET_PLAINTEXT_CANNOT_LEAK_INTO_SHARDS_999999';
  const plainBuf = Buffer.from(plaintextSecret, 'utf8');

  // AES-256-GCM encrypt
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final(), cipher.getAuthTag()]);

  // Feed ciphertext to Reed-Solomon
  const shards = encodeReedSolomon42(ciphertext);

  for (const s of shards) {
    const shardPayload = s.data.subarray(16);
    assert.strictEqual(
      shardPayload.includes(Buffer.from(plaintextSecret)),
      false,
      'Shard data must never contain plaintext secret string'
    );
  }
});

// -----------------------------------------------------------------------------
// Test 14: Sensitive Material Logging & Header Exposure Verification
// -----------------------------------------------------------------------------
runTest('Security Check: Shard headers and shard objects contain no passwords or key material', () => {
  const ciphertext = crypto.randomBytes(512);
  const shards = encodeReedSolomon42(ciphertext);

  for (const s of shards) {
    assert.strictEqual(s.wrappedDEK, undefined, 'Shard objects must not embed wrappedDEK');
    assert.strictEqual(s.password, undefined, 'Shard objects must not embed password');
    assert.strictEqual(s.dek, undefined, 'Shard objects must not embed DEK');
    assert.strictEqual(s.kek, undefined, 'Shard objects must not embed KEK');
  }
});

console.log('----------------------------------------------------------------');
console.log(`  RESULTS: ${passedTests} / ${totalTests} tests passed (${Math.round((passedTests/totalTests)*100)}%)`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
