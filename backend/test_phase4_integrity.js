import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  encodeReedSolomon42,
  decodeReedSolomon42,
  validateShardBuffer,
  reconstructSingleShard,
  splitIntoShards,
  reassembleShards
} from './src/services/shardingService.js';
import { calculateSHA256, generateFileHash } from './src/services/hashingService.js';

let totalTests = 0;
let passedTests = 0;

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
console.log('  SECUREVAULT PHASE 4: UPLOAD, DOWNLOAD & RECOVERY INTEGRITY   ');
console.log('================================================================');

// Helper: Encrypt plaintext using AES-256-GCM mimicking Phase 2 client cryptoService
function clientEncrypt(plaintextBuffer, password) {
  const salt = crypto.randomBytes(16);
  const kek = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
  const dek = crypto.randomBytes(32);

  // Wrap DEK with KEK using AES-GCM
  const kwCipher = crypto.createCipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0));
  const wrappedDEK = Buffer.concat([kwCipher.update(dek), kwCipher.final(), kwCipher.getAuthTag()]);

  const baseNonce = crypto.randomBytes(8);
  const chunkIV = Buffer.concat([baseNonce, Buffer.from([0, 0, 0, 0])]); // 12 bytes
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, chunkIV);
  const ciphertextPayload = Buffer.concat([cipher.update(plaintextBuffer), cipher.final(), cipher.getAuthTag()]);
  const originalFileHash = calculateSHA256(plaintextBuffer);

  return {
    ciphertextPayload,
    ciphertextHash: calculateSHA256(ciphertextPayload),
    ciphertextSize: ciphertextPayload.length,
    originalFileHash,
    originalFileSize: plaintextBuffer.length,
    wrappedDEK,
    kdfSalt: salt,
    baseNonce,
    dek,
    kek
  };
}

// Helper: Decrypt ciphertext mimicking Phase 2 client cryptoService
function clientDecrypt(ciphertextPayload, metadata, password) {
  const kek = crypto.pbkdf2Sync(password, metadata.kdfSalt, 100000, 32, 'sha256');
  const kwDec = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0));
  kwDec.setAuthTag(metadata.wrappedDEK.subarray(metadata.wrappedDEK.length - 16));
  const unwrappedDEK = Buffer.concat([kwDec.update(metadata.wrappedDEK.subarray(0, metadata.wrappedDEK.length - 16)), kwDec.final()]);

  const chunkIV = Buffer.concat([metadata.baseNonce, Buffer.from([0, 0, 0, 0])]);
  const authTag = ciphertextPayload.subarray(ciphertextPayload.length - 16);
  const encryptedBytes = ciphertextPayload.subarray(0, ciphertextPayload.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', unwrappedDEK, chunkIV);
  decipher.setAuthTag(authTag);
  const decryptedPlaintext = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);

  // Plaintext SHA-256 incremental verification
  const computedHash = calculateSHA256(decryptedPlaintext);
  if (computedHash !== metadata.originalFileHash) {
    throw new Error(`Integrity Verification Failed: Plaintext hash mismatch (expected ${metadata.originalFileHash}, got ${computedHash})`);
  }

  return decryptedPlaintext;
}

// -----------------------------------------------------------------------------
// Scenario A: Normal Upload -> Normal Download (All 6 Shards Present)
// -----------------------------------------------------------------------------
runTest('Scenario A: Normal Upload -> Normal Download (6/6 Shards)', () => {
  const plaintext = Buffer.from('SecureVault Phase 4 Test: Normal Upload & Normal Download validation.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);
  assert.strictEqual(shards.length, 6);

  const reconstructedCiphertext = reassembleShards(shards);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario B: 1 Missing Data Shard (Shard 1 missing)
// -----------------------------------------------------------------------------
runTest('Scenario B: 1 Missing Data Shard (Shard 1 missing -> Shards 2, 3, 4, 5, 6)', () => {
  const plaintext = Buffer.from('Testing 1 missing data shard scenario.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const surviving = shards.filter(s => s.shardIndex !== 1);
  assert.strictEqual(surviving.length, 5);

  const reconstructedCiphertext = reassembleShards(surviving);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario C: 1 Missing Parity Shard (Shard 5 missing)
// -----------------------------------------------------------------------------
runTest('Scenario C: 1 Missing Parity Shard (Shard 5 missing -> Shards 1, 2, 3, 4, 6)', () => {
  const plaintext = Buffer.from('Testing 1 missing parity shard scenario.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const surviving = shards.filter(s => s.shardIndex !== 5);
  assert.strictEqual(surviving.length, 5);

  const reconstructedCiphertext = reassembleShards(surviving);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario D: 2 Missing Data Shards (Shards 1 & 2 missing)
// -----------------------------------------------------------------------------
runTest('Scenario D: 2 Missing Data Shards (Shards 1 & 2 missing -> Shards 3, 4, 5, 6)', () => {
  const plaintext = Buffer.from('Testing 2 missing data shards scenario.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const surviving = shards.filter(s => s.shardIndex !== 1 && s.shardIndex !== 2);
  assert.strictEqual(surviving.length, 4);

  const reconstructedCiphertext = reassembleShards(surviving);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario E: 1 Data + 1 Parity Shard Missing (Shards 2 & 5 missing)
// -----------------------------------------------------------------------------
runTest('Scenario E: 1 Data + 1 Parity Shard Missing (Shards 2 & 5 missing -> Shards 1, 3, 4, 6)', () => {
  const plaintext = Buffer.from('Testing 1 data + 1 parity shard missing scenario.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const surviving = shards.filter(s => s.shardIndex !== 2 && s.shardIndex !== 5);
  assert.strictEqual(surviving.length, 4);

  const reconstructedCiphertext = reassembleShards(surviving);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario F: 2 Parity Shards Missing (Shards 5 & 6 missing)
// -----------------------------------------------------------------------------
runTest('Scenario F: 2 Parity Shards Missing (Shards 5 & 6 missing -> Data Shards 1, 2, 3, 4)', () => {
  const plaintext = Buffer.from('Testing both parity shards missing scenario.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const surviving = shards.filter(s => s.shardIndex <= 4);
  assert.strictEqual(surviving.length, 4);

  const reconstructedCiphertext = reassembleShards(surviving);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario G: 1 Corrupted Shard Detected via SHA-256 and Discarded
// -----------------------------------------------------------------------------
runTest('Scenario G: 1 Corrupted Shard (Shard 2 corrupted -> filtered out & reconstructed from 5 valid)', () => {
  const plaintext = Buffer.from('Testing 1 corrupted shard detection.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const tamperedShard2 = {
    shardIndex: 2,
    data: Buffer.from(shards[1].data),
    expectedHash: shards[1].hash
  };
  tamperedShard2.data[18] ^= 0xff; // Corrupt payload

  const inputShards = [shards[0], tamperedShard2, shards[2], shards[3], shards[4], shards[5]];
  const reconstructedCiphertext = decodeReedSolomon42(inputShards);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario H: 2 Corrupted Shards Detected via SHA-256 and Discarded
// -----------------------------------------------------------------------------
runTest('Scenario H: 2 Corrupted Shards (Shards 2 & 5 corrupted -> reconstructed from 4 valid)', () => {
  const plaintext = Buffer.from('Testing 2 corrupted shards detection.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const tamperedShard2 = { shardIndex: 2, data: Buffer.from(shards[1].data), expectedHash: shards[1].hash };
  tamperedShard2.data[19] ^= 0x55;
  const tamperedShard5 = { shardIndex: 5, data: Buffer.from(shards[4].data), expectedHash: shards[4].hash };
  tamperedShard5.data[21] ^= 0xaa;

  const inputShards = [shards[0], tamperedShard2, shards[2], shards[3], tamperedShard5, shards[5]];
  const reconstructedCiphertext = decodeReedSolomon42(inputShards);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'TestPass123!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

// -----------------------------------------------------------------------------
// Scenario I: 3 Missing / Corrupted Shards Fail Safely (Threshold Violation)
// -----------------------------------------------------------------------------
runTest('Scenario I: 3 Missing Shards -> Fails Safely with Insufficient Shards Error', () => {
  const plaintext = Buffer.from('Testing 3 missing shards rejection.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const surviving = shards.slice(0, 3); // Only 3 shards
  assert.throws(
    () => decodeReedSolomon42(surviving),
    /Insufficient valid shards|Distinct shards available/
  );
});

// -----------------------------------------------------------------------------
// Scenario J: Wrong Shard Hash in Metadata -> Shard Discarded
// -----------------------------------------------------------------------------
runTest('Scenario J: Wrong Shard Hash in Metadata -> Shard Discarded', () => {
  const plaintext = Buffer.from('Testing wrong metadata hash rejection.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  const badMetadataShard = {
    shardIndex: 1,
    data: shards[0].data,
    expectedHash: '0000000000000000000000000000000000000000000000000000000000000000' // Wrong hash
  };

  const inputShards = [badMetadataShard, shards[1], shards[2], shards[3], shards[4], shards[5]];
  const reconstructedCiphertext = decodeReedSolomon42(inputShards);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);
});

// -----------------------------------------------------------------------------
// Scenario K: Corrupted Shard Header (Tampered Magic Bytes / Shard Index)
// -----------------------------------------------------------------------------
runTest('Scenario K: Corrupted Shard Header (Tampered Magic / Bad Index) -> Rejected', () => {
  const plaintext = Buffer.from('Testing invalid header rejection.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');
  const shards = encodeReedSolomon42(enc.ciphertextPayload);

  // Corrupt magic bytes in shard 1
  const badMagicShard = Buffer.from(shards[0].data);
  badMagicShard[0] = 0x00; // Overwrite 'S' with 0x00
  const validation1 = validateShardBuffer(badMagicShard, 1, shards[0].hash);
  assert.strictEqual(validation1.isValid, false);
  assert.strictEqual(validation1.error, 'Missing SVEC magic header');

  // Corrupt shard index in shard 2
  const badIndexShard = Buffer.from(shards[1].data);
  badIndexShard[5] = 99; // Invalid shard index 99
  const validation2 = validateShardBuffer(badIndexShard, 2, shards[1].hash);
  assert.strictEqual(validation2.isValid, false);
  assert.strictEqual(validation2.error, 'Invalid shard index: 99');
});

// -----------------------------------------------------------------------------
// Scenario L: Corrupted Ciphertext Payload -> Client-Side Rejection
// -----------------------------------------------------------------------------
runTest('Scenario L: Corrupted Ciphertext -> Client AES-GCM Auth Tag Failure & Abort', () => {
  const plaintext = Buffer.from('Testing client-side tampered ciphertext rejection.');
  const enc = clientEncrypt(plaintext, 'TestPass123!');

  // Tamper with a byte of ciphertext
  const tamperedCiphertext = Buffer.from(enc.ciphertextPayload);
  tamperedCiphertext[10] ^= 0x42;

  assert.throws(
    () => clientDecrypt(tamperedCiphertext, enc, 'TestPass123!'),
    /operation-specific reason|bad decrypt|Unsupported state/i,
    'Must fail client-side decryption when ciphertext is tampered'
  );
});

// -----------------------------------------------------------------------------
// Scenario M: Wrong Password -> Client-Side DEK Unwrap Rejection
// -----------------------------------------------------------------------------
runTest('Scenario M: Wrong Password -> Client DEK Unwrap Rejection & Abort', () => {
  const plaintext = Buffer.from('Testing wrong password rejection.');
  const enc = clientEncrypt(plaintext, 'CorrectPassword123!');

  assert.throws(
    () => clientDecrypt(enc.ciphertextPayload, enc, 'WrongPassword456!'),
    /operation-specific reason|bad decrypt|Unsupported state/i,
    'Must fail DEK unwrap when wrong password is supplied'
  );
});

// -----------------------------------------------------------------------------
// Scenario N: End-to-End Plaintext Hash Integrity Match
// -----------------------------------------------------------------------------
runTest('Scenario N: End-to-End Plaintext Hash Integrity: Recovered Hash == Original Hash', () => {
  const plaintext = crypto.randomBytes(32768); // 32 KB payload
  const expectedOriginalHash = calculateSHA256(plaintext);
  const enc = clientEncrypt(plaintext, 'IntegrityPass2026!');
  assert.strictEqual(enc.originalFileHash, expectedOriginalHash);

  const shards = encodeReedSolomon42(enc.ciphertextPayload);
  // Missing shards 3 and 6
  const surviving = [shards[0], shards[1], shards[3], shards[4]];
  const recoveredCiphertext = decodeReedSolomon42(surviving);

  const decrypted = clientDecrypt(recoveredCiphertext, enc, 'IntegrityPass2026!');
  const actualDecryptedHash = calculateSHA256(decrypted);

  assert.strictEqual(actualDecryptedHash, expectedOriginalHash, 'Plaintext SHA-256 must match original 100%');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0, 'Recovered buffer must match byte-for-byte');
});

// -----------------------------------------------------------------------------
// Scenario O: Shard Self-Healing Repair Followed by Successful Download
// -----------------------------------------------------------------------------
runTest('Scenario O: Shard Self-Healing Repair -> Restores Shard & Succeeds in Subsequent Download', () => {
  const plaintext = Buffer.from('Testing shard repair and subsequent download participation.');
  const enc = clientEncrypt(plaintext, 'RepairTestPass!');
  const originalShards = encodeReedSolomon42(enc.ciphertextPayload);

  // Suppose Shard #3 is lost on node-03
  const survivingBeforeRepair = [originalShards[0], originalShards[1], originalShards[3], originalShards[4], originalShards[5]];
  
  // Reconstruct Shard #3 using 4 surviving shards (shards 1, 2, 4, 5)
  const surviving4 = [originalShards[0], originalShards[1], originalShards[3], originalShards[4]];
  const repairedShard3Buffer = reconstructSingleShard(surviving4, 3);

  // Verify repaired shard is byte-exact match with original shard 3
  assert.strictEqual(
    Buffer.compare(originalShards[2].data, repairedShard3Buffer),
    0,
    'Repaired shard #3 must match original shard #3 byte-for-byte'
  );

  // Verify repaired shard passes validation
  const validation = validateShardBuffer(repairedShard3Buffer, 3, originalShards[2].hash);
  assert.strictEqual(validation.isValid, true);

  // Now perform download using Shard #3 + Shards #1, #2, #6 (simulating node 4 and 5 temporarily offline)
  const repairedShardObject = {
    shardIndex: 3,
    data: repairedShard3Buffer,
    expectedHash: calculateSHA256(repairedShard3Buffer)
  };
  const downloadShards = [originalShards[0], originalShards[1], repairedShardObject, originalShards[5]];

  const reconstructedCiphertext = decodeReedSolomon42(downloadShards);
  assert.strictEqual(calculateSHA256(reconstructedCiphertext), enc.ciphertextHash);

  const decrypted = clientDecrypt(reconstructedCiphertext, enc, 'RepairTestPass!');
  assert.strictEqual(Buffer.compare(plaintext, decrypted), 0);
});

console.log('----------------------------------------------------------------');
console.log(`  PHASE 4 RESULTS: ${passedTests} / ${totalTests} tests passed (${Math.round((passedTests/totalTests)*100)}%)`);
console.log('================================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
