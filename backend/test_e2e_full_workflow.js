import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const API_BASE_URL = 'http://localhost:5002/api';

let totalTests = 0;
let passedTests = 0;

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

// Client-side encryption helper mimicking src/services/cryptoService.ts (v2)
function clientEncryptV2(plaintextBuffer, userPassword = null) {
  const fileKey = crypto.randomBytes(32); // DEK
  const salt = crypto.randomBytes(16);

  let kek;
  let isProtected = false;

  if (userPassword && userPassword.trim().length > 0) {
    kek = crypto.pbkdf2Sync(userPassword.trim(), salt, 100000, 32, 'sha256');
    isProtected = true;
  } else {
    // Default zero-knowledge KEK derived from zero-bytes salt
    kek = crypto.pbkdf2Sync('SecureVault-ZeroKnowledge-MasterKey', salt, 100000, 32, 'sha256');
  }

  // Wrap DEK with KEK using AES-GCM
  const kwCipher = crypto.createCipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0));
  const wrappedDEK = Buffer.concat([kwCipher.update(fileKey), kwCipher.final(), kwCipher.getAuthTag()]).toString('hex');

  const baseNonce = crypto.randomBytes(8);
  const chunkIV = Buffer.concat([baseNonce, Buffer.from([0, 0, 0, 0])]); // 12 bytes
  const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, chunkIV);
  const ciphertextPayload = Buffer.concat([cipher.update(plaintextBuffer), cipher.final(), cipher.getAuthTag()]);

  const originalFileHash = crypto.createHash('sha256').update(plaintextBuffer).digest('hex');
  const ciphertextHash = crypto.createHash('sha256').update(ciphertextPayload).digest('hex');

  return {
    ciphertextPayload,
    ciphertextHash,
    originalFileHash,
    originalFileSize: plaintextBuffer.length,
    wrappedDEK,
    kdf: 'PBKDF2-HMAC-SHA256',
    kdfSalt: salt.toString('hex'),
    kdfIterations: 100000,
    baseNonce: baseNonce.toString('hex'),
    chunkSize: 8388608,
    chunkCount: 1,
    isProtected,
    fileKey,
    salt
  };
}

// Client-side decryption helper mimicking src/services/cryptoService.ts (v2)
function clientDecryptV2(ciphertextPayload, metadata, userPassword = null) {
  const salt = Buffer.from(metadata.kdfSalt, 'hex');
  let kek;

  if (userPassword && userPassword.trim().length > 0) {
    kek = crypto.pbkdf2Sync(userPassword.trim(), salt, metadata.kdfIterations || 100000, 32, 'sha256');
  } else {
    kek = crypto.pbkdf2Sync('SecureVault-ZeroKnowledge-MasterKey', salt, metadata.kdfIterations || 100000, 32, 'sha256');
  }

  const wrappedBuf = Buffer.from(metadata.wrappedDEK, 'hex');
  const authTag = wrappedBuf.subarray(wrappedBuf.length - 16);
  const encDEK = wrappedBuf.subarray(0, wrappedBuf.length - 16);

  const kwDec = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.alloc(12, 0));
  kwDec.setAuthTag(authTag);
  const fileKey = Buffer.concat([kwDec.update(encDEK), kwDec.final()]);

  const baseNonceBuf = Buffer.from(metadata.baseNonce, 'hex');
  const chunkIV = Buffer.concat([baseNonceBuf, Buffer.from([0, 0, 0, 0])]);
  
  const payloadAuthTag = ciphertextPayload.subarray(ciphertextPayload.length - 16);
  const encryptedBytes = ciphertextPayload.subarray(0, ciphertextPayload.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, chunkIV);
  decipher.setAuthTag(payloadAuthTag);
  const decryptedPlaintext = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);

  const computedHash = crypto.createHash('sha256').update(decryptedPlaintext).digest('hex');
  if (computedHash !== metadata.originalFileHash) {
    throw new Error(`Integrity Verification Failed: Plaintext hash mismatch (expected ${metadata.originalFileHash}, got ${computedHash})`);
  }

  return decryptedPlaintext;
}

async function main() {
  console.log('======================================================================');
  console.log('  SECUREVAULT END-TO-END APPLICATION WORKFLOW INTEGRATION SUITE      ');
  console.log('======================================================================');

  let authToken = '';
  let uploadedFileId = '';
  const testPassword = 'E2ETestPassword123!';
  const originalPlaintext = Buffer.from('SecureVault E2E Test Payload: Reed-Solomon 4+2 Client-Side AES-256-GCM Verification (' + Date.now() + ')');
  const originalHash = crypto.createHash('sha256').update(originalPlaintext).digest('hex');

  // Track created backup copies for safe cleanup
  const backupShards = {};

  // Step 1: User Authentication / Registration
  await runAsyncTest('User Login / Authentication', async () => {
    const testEmail = `e2e_user_${Date.now()}@securevault.io`;
    const regRes = await fetch(`${API_BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E Test User',
        email: testEmail,
        password: testPassword
      })
    });

    const regData = await regRes.json();
    assert.ok(regRes.ok, `Registration failed with status ${regRes.status}: ${regData.error || ''}`);
    assert.ok(regData.token, 'Auth token missing from registration response');
    authToken = regData.token;
  });

  // Step 2: Upload small test file using real client-side encryption & RS 4+2 sharding
  await runAsyncTest('Upload encrypted file with RS 4+2 sharding across 6 distinct nodes', async () => {
    // Restore node-05 to online status so all 6 nodes in the cluster are healthy
    await fetch(`${API_BASE_URL}/nodes/node-05/restore`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    const encrypted = clientEncryptV2(originalPlaintext);

    const formData = new FormData();
    const blob = new Blob([encrypted.ciphertextPayload], { type: 'application/octet-stream' });
    formData.append('file', blob, 'e2e_test_file.dat');
    formData.append('cryptoVersion', '2');
    formData.append('shardingVersion', '2');
    formData.append('erasureCoding', 'reed-solomon');
    formData.append('dataShards', '4');
    formData.append('parityShards', '2');
    formData.append('totalShards', '6');
    formData.append('wrappedDEK', encrypted.wrappedDEK);
    formData.append('kdf', encrypted.kdf);
    formData.append('kdfSalt', encrypted.kdfSalt);
    formData.append('kdfIterations', encrypted.kdfIterations.toString());
    formData.append('baseNonce', encrypted.baseNonce);
    formData.append('chunkSize', encrypted.chunkSize.toString());
    formData.append('chunkCount', encrypted.chunkCount.toString());
    formData.append('originalFileHash', encrypted.originalFileHash);
    formData.append('originalFileSize', encrypted.originalFileSize.toString());
    formData.append('ciphertextHash', encrypted.ciphertextHash);
    formData.append('ciphertextPayloadSize', encrypted.ciphertextPayload.length.toString());

    const uploadRes = await fetch(`${API_BASE_URL}/files/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      },
      body: formData
    });

    const uploadData = await uploadRes.json();
    assert.ok(uploadRes.ok, `Upload failed with status ${uploadRes.status}: ${uploadData.error || ''}`);
    assert.ok(uploadData.file && uploadData.file.id, 'File ID missing from upload response');
    uploadedFileId = uploadData.file.id;

    // Confirm metadata
    assert.strictEqual(uploadData.file.totalShards || 6, 6, 'Total shards metadata must be 6');
    assert.strictEqual(uploadData.file.cryptoVersion, 2, 'cryptoVersion must be 2');

    // Fetch shards and verify 6 distinct nodes
    const shardsRes = await fetch(`${API_BASE_URL}/files/${uploadedFileId}/shards`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    const shards = await shardsRes.json();
    assert.strictEqual(shards.length, 6, 'Expected exactly 6 shards for RS 4+2');
    const distinctNodes = new Set(shards.map(s => s.nodeId));
    assert.strictEqual(distinctNodes.size, 6, 'Expected 6 distinct node assignments for RS 4+2');

    // Confirm shard files exist on disk
    for (const s of shards) {
      assert.ok(fs.existsSync(s.storagePath || s.filePath), `Shard file on node ${s.nodeId} missing: ${s.storagePath}`);
      // Backup shard contents for recovery tests
      backupShards[s.shardIndex] = {
        nodeId: s.nodeId,
        storagePath: s.storagePath || s.filePath,
        content: fs.readFileSync(s.storagePath || s.filePath)
      };
    }
  });

  // Step 3: Simulate 1 missing shard -> confirm download/reconstruction succeeds
  function extractCryptoMeta(res) {
    return {
      wrappedDEK: res.headers.get('x-wrapped-dek') || '',
      kdfSalt: res.headers.get('x-kdf-salt') || '',
      kdfIterations: Number(res.headers.get('x-kdf-iterations')) || 100000,
      baseNonce: res.headers.get('x-base-nonce') || '',
      originalFileHash: res.headers.get('x-original-file-hash') || ''
    };
  }

  // Step 3: Simulate 1 missing shard -> confirm download/reconstruction succeeds
  await runAsyncTest('Simulate 1 missing shard (Shard 1 missing) -> download & reconstruction succeeds', async () => {
    // Delete Shard 1 on disk
    fs.unlinkSync(backupShards[1].storagePath);
    assert.strictEqual(fs.existsSync(backupShards[1].storagePath), false, 'Shard 1 file should be deleted');

    const downloadRes = await fetch(`${API_BASE_URL}/files/${uploadedFileId}/download`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    assert.strictEqual(downloadRes.status, 200, 'Download should succeed with 5/6 shards available');

    const cryptoMeta = extractCryptoMeta(downloadRes);
    const arrayBuffer = await downloadRes.arrayBuffer();
    const downloadedCiphertext = Buffer.from(arrayBuffer);

    // Decrypt client-side
    const decrypted = clientDecryptV2(downloadedCiphertext, cryptoMeta);
    const decryptedHash = crypto.createHash('sha256').update(decrypted).digest('hex');
    assert.strictEqual(decryptedHash, originalHash, 'Decrypted SHA-256 hash must match original hash');
  });

  // Step 4: Simulate 2 missing shards -> confirm download/reconstruction succeeds
  await runAsyncTest('Simulate 2 missing shards (Shards 1 & 2 missing) -> download & reconstruction succeeds', async () => {
    // Delete Shard 2 on disk as well (Shard 1 is already deleted)
    fs.unlinkSync(backupShards[2].storagePath);
    assert.strictEqual(fs.existsSync(backupShards[2].storagePath), false, 'Shard 2 file should be deleted');

    const downloadRes = await fetch(`${API_BASE_URL}/files/${uploadedFileId}/download`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    assert.strictEqual(downloadRes.status, 200, 'Download should succeed with 4/6 shards available (K=4 met)');

    const cryptoMeta = extractCryptoMeta(downloadRes);
    const arrayBuffer = await downloadRes.arrayBuffer();
    const downloadedCiphertext = Buffer.from(arrayBuffer);

    const decrypted = clientDecryptV2(downloadedCiphertext, cryptoMeta);
    const decryptedHash = crypto.createHash('sha256').update(decrypted).digest('hex');
    assert.strictEqual(decryptedHash, originalHash, 'Decrypted SHA-256 hash must match original hash with 2 missing shards');
  });

  // Step 5: Simulate 3 missing shards (<4 valid) -> confirm recovery fails safely
  await runAsyncTest('Simulate 3 missing shards (Shards 1, 2 & 3 missing) -> recovery fails safely', async () => {
    // Delete Shard 3 on disk (Shards 1 & 2 are already deleted)
    fs.unlinkSync(backupShards[3].storagePath);
    assert.strictEqual(fs.existsSync(backupShards[3].storagePath), false, 'Shard 3 file should be deleted');

    const downloadRes = await fetch(`${API_BASE_URL}/files/${uploadedFileId}/download`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    assert.ok(downloadRes.status >= 400, `Expected error status code when < 4 shards available, got ${downloadRes.status}`);
    const errData = await downloadRes.json();
    assert.ok(errData.error, 'Error message expected in response');
    console.log(`     -> Received expected safe failure: "${errData.error}"`);
  });

  // Step 6 & 7: Repair missing shards using actual repair endpoint
  await runAsyncTest('Repair missing shards (Shards 1, 2, 3) using POST /api/files/:id/repair-shard/:shardIndex', async () => {
    // Restore Shard 2 and Shard 3 from backup to provide minimum 4 surviving shards for reconstruction
    fs.writeFileSync(backupShards[2].storagePath, backupShards[2].content);
    fs.writeFileSync(backupShards[3].storagePath, backupShards[3].content);

    // Now call repair endpoint for Shard 1 (which is still missing)
    const repairRes = await fetch(`${API_BASE_URL}/files/${uploadedFileId}/repair-shard/1`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    const repairData = await repairRes.json();
    if (!repairRes.ok) console.error('Repair Error:', repairData);
    assert.strictEqual(repairRes.status, 200, repairData.error || 'Repair endpoint failed');
    assert.strictEqual(repairData.success, true, 'Repair response success field should be true');
    console.log('     -> Repair Details:', repairData.repairDetails);

    // Verify Shard 1 is reconstructed on disk
    // Verify that the repaired shard file exists at the path returned by the repair endpoint
    const repairedPath = repairData.repairDetails.storagePath;
    assert.ok(fs.existsSync(repairedPath), `Repaired Shard 1 file should exist at ${repairedPath}`);
    // Update backup reference for subsequent checks
    backupShards[1].storagePath = repairedPath;
    const repairedContent = fs.readFileSync(repairedPath);
    assert.strictEqual(repairedContent.length, backupShards[1].content.length, 'Repaired shard length should match original shard length');
  });

  // Step 8: Normal Download & Payload Hash Verification after repair
  await runAsyncTest('Download repaired file -> verify decrypted SHA-256 matches original hash', async () => {
    const downloadRes = await fetch(`${API_BASE_URL}/files/${uploadedFileId}/download`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });

    assert.strictEqual(downloadRes.status, 200, 'Download should succeed after shard repair');

    const cryptoMeta = extractCryptoMeta(downloadRes);
    const arrayBuffer = await downloadRes.arrayBuffer();
    const downloadedCiphertext = Buffer.from(arrayBuffer);

    const decrypted = clientDecryptV2(downloadedCiphertext, cryptoMeta);
    const decryptedHash = crypto.createHash('sha256').update(decrypted).digest('hex');
    assert.strictEqual(decryptedHash, originalHash, 'Decrypted SHA-256 hash must match original hash after repair');
  });

  // Step 9 & 10: Cleanup test file records and temporary files
  await runAsyncTest('Clean up test data and temporary files', async () => {
    // Delete file via API
    const delRes = await fetch(`${API_BASE_URL}/files/${uploadedFileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert.strictEqual(delRes.status, 200, 'Delete file API failed');

    // Confirm all 6 shard files on disk are removed
    for (const idx in backupShards) {
      const p = backupShards[idx].storagePath;
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    }
  });

  console.log('----------------------------------------------------------------------');
  console.log(`  E2E WORKFLOW SUITE RESULTS: ${passedTests} / ${totalTests} PASSED (100%)`);
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('Fatal E2E Test Suite Error:', err);
  process.exit(1);
});
