import assert from 'assert';
import { 
  deriveKEK, 
  unwrapDEK, 
  wrapDEK, 
  hexToBytes, 
  bytesToHex, 
  decryptFileInChunks,
  unlockMasterKeyWithPassword,
  rotateMasterPassword
} from '../src/services/cryptoService.ts';
import { loadStoredFiles, loadStoredShards } from './src/services/storeService.js';
import { reconstructBufferFromShards } from './src/services/shardingService.js';
import { readNodeShard } from './src/services/nodeService.js';

console.log('='.repeat(75));
console.log('🧪 VERIFYING MASTER KEY UNLOCKED VAULT DECRYPTION PIPELINE');
console.log('='.repeat(75));

let passed = 0;
let total = 0;

async function test(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  [PASS] Test ${total}: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] Test ${total}: ${name}`);
    console.error(`         ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

(async () => {
  const masterPassword = 'Sanskruti@123';
  const files = loadStoredFiles();
  const shards = loadStoredShards();

  // Test 1: Identify previously password-protected file (aicte_bon_prom_ren.pdf)
  const targetFile = files.find(f => f.id === 'file-1792835721648');
  assert.ok(targetFile, 'Target file file-1792835721648 must exist');
  assert.strictEqual(targetFile.isPasswordProtected, true, 'File must be flagged as password protected');

  await test('Target file has valid cryptographic metadata and 6 shards', async () => {
    assert.ok(targetFile.wrappedDEK && targetFile.wrappedDEK.length > 0);
    assert.ok(targetFile.kdfSalt && targetFile.kdfSalt.length === 32);
    assert.strictEqual(targetFile.cryptoVersion, 2);
    
    const fileShards = shards.filter(s => s.fileId === targetFile.id);
    assert.strictEqual(fileShards.length, 6, 'Must have 6 Reed-Solomon shards');
  });

  // Test 2: Unlocked vault directly unwraps DEK using Master Password with ZERO prompt for upload-time password
  await test('Unlocked vault Master Password directly unwraps per-file DEK', async () => {
    const saltBytes = hexToBytes(targetFile.kdfSalt);
    const kek = await deriveKEK(masterPassword, saltBytes, targetFile.kdfIterations || 100000);
    const dek = await unwrapDEK(hexToBytes(targetFile.wrappedDEK), kek);
    
    assert.ok(dek, 'DEK must be unwrapped successfully');
    assert.strictEqual(dek.algorithm.name, 'AES-GCM');
  });

  // Test 3: Full end-to-end reconstruction and client-side decryption using Master Password
  await test('Reconstructs shards and decrypts plaintext payload using unlocked Master Password', async () => {
    const fileShards = shards.filter(s => s.fileId === targetFile.id);
    const validShards = [];
    for (const s of fileShards) {
      const data = await readNodeShard(s.nodeId, s.storagePath);
      validShards.push({ ...s, data });
    }

    const reassembledBuffer = reconstructBufferFromShards(validShards);
    assert.ok(reassembledBuffer.length > 0, 'Reassembled buffer must not be empty');

    const metadata = {
      cryptoVersion: 2,
      algorithm: 'AES-256-GCM',
      keySize: 256,
      chunkSize: targetFile.chunkSize || 8388608,
      chunkCount: targetFile.chunkCount || 1,
      kdf: targetFile.kdf,
      kdfSalt: targetFile.kdfSalt,
      kdfIterations: targetFile.kdfIterations,
      wrappedDEK: targetFile.wrappedDEK,
      baseNonce: targetFile.baseNonce,
      originalFileHash: targetFile.originalFileHash,
      originalFileSize: targetFile.originalFileSize,
      isPasswordProtected: targetFile.isPasswordProtected
    };

    // Client-side decryption with candidate master password (no upload password needed)
    const decrypted = await decryptFileInChunks(reassembledBuffer, metadata, masterPassword);
    assert.strictEqual(decrypted.length, targetFile.originalFileSize, 'Decrypted size must match original');

    // Verify PDF header magic bytes
    const magic = String.fromCharCode(...decrypted.slice(0, 5));
    assert.strictEqual(magic, '%PDF-', 'Decrypted content must be valid PDF');
  });

  // Test 4: Locked vault (invalid / empty password) is completely blocked from decrypting
  await test('Locked vault / incorrect master password is cryptographically blocked from decryption', async () => {
    const fileShards = shards.filter(s => s.fileId === targetFile.id);
    const validShards = [];
    for (const s of fileShards) {
      const data = await readNodeShard(s.nodeId, s.storagePath);
      validShards.push({ ...s, data });
    }
    const reassembledBuffer = reconstructBufferFromShards(validShards);

    const metadata = {
      cryptoVersion: 2,
      algorithm: 'AES-256-GCM',
      keySize: 256,
      chunkSize: targetFile.chunkSize || 8388608,
      chunkCount: targetFile.chunkCount || 1,
      kdf: targetFile.kdf,
      kdfSalt: targetFile.kdfSalt,
      kdfIterations: targetFile.kdfIterations,
      wrappedDEK: targetFile.wrappedDEK,
      baseNonce: targetFile.baseNonce,
      originalFileHash: targetFile.originalFileHash,
      originalFileSize: targetFile.originalFileSize,
      isPasswordProtected: targetFile.isPasswordProtected
    };

    let failed = false;
    try {
      await decryptFileInChunks(reassembledBuffer, metadata, 'WrongLockedPassword999!');
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true, 'Decryption with wrong password MUST fail cryptographically');
  });

  // Test 5: Master Password rotation preserves access to all files seamlessly
  await test('Master Password rotation preserves file accessibility with 0 file re-encryption', async () => {
    const newMasterPassword = 'RotatedMasterPass@2026!';
    
    // 1. Unwrap DEK with current master password
    const saltBytes = hexToBytes(targetFile.kdfSalt);
    const oldKek = await deriveKEK(masterPassword, saltBytes, targetFile.kdfIterations || 100000);
    const dek = await unwrapDEK(hexToBytes(targetFile.wrappedDEK), oldKek);

    // 2. Rewrap DEK with new master password
    const newKek = await deriveKEK(newMasterPassword, saltBytes, targetFile.kdfIterations || 100000);
    const rewrapped = await wrapDEK(dek, newKek);

    const updatedMetadata = {
      cryptoVersion: 2,
      algorithm: 'AES-256-GCM',
      keySize: 256,
      chunkSize: targetFile.chunkSize || 8388608,
      chunkCount: targetFile.chunkCount || 1,
      kdf: targetFile.kdf,
      kdfSalt: targetFile.kdfSalt,
      kdfIterations: targetFile.kdfIterations,
      wrappedDEK: bytesToHex(rewrapped),
      baseNonce: targetFile.baseNonce,
      originalFileHash: targetFile.originalFileHash,
      originalFileSize: targetFile.originalFileSize,
      isPasswordProtected: targetFile.isPasswordProtected
    };

    // 3. Read shards and decrypt using new master password
    const fileShards = shards.filter(s => s.fileId === targetFile.id);
    const validShards = [];
    for (const s of fileShards) {
      const data = await readNodeShard(s.nodeId, s.storagePath);
      validShards.push({ ...s, data });
    }
    const reassembledBuffer = reconstructBufferFromShards(validShards);

    const decrypted = await decryptFileInChunks(reassembledBuffer, updatedMetadata, newMasterPassword);
    const magic = String.fromCharCode(...decrypted.slice(0, 5));
    assert.strictEqual(magic, '%PDF-', 'Decrypted content under rotated password must remain valid PDF');
  });

  console.log('='.repeat(75));
  console.log(`SUMMARY: ${passed}/${total} MASTER KEY DECRYPTION TESTS PASSED!`);
  console.log('='.repeat(75));

  if (passed !== total) process.exit(1);
})();
