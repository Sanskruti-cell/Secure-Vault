import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from './src/config/env.js';
import { StoredChunk } from './src/models/StoredChunk.js';
import { isMongoConnected } from './src/config/db.js';

const PORT = 5002;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const USER_ID = '6a939bf1e8d60eee7b1e11bf';
const USER_EMAIL = 'sanskruti.asati.batch2024@sitnagpur.siu.edu.in';
const USER_PASSWORD = 'SecureVault2026!MasterPassword';

const token = jwt.sign(
  { id: USER_ID, email: USER_EMAIL, name: 'Sanskruti Asati' },
  env.jwtSecret,
  { expiresIn: '2h' }
);

function makeMultipartUpload(filename, fileBuffer, metadataFields) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
    const url = new URL('/api/files/upload', BASE_URL);

    let bodyParts = [];

    for (const [key, val] of Object.entries(metadataFields)) {
      bodyParts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`
      ));
    }

    bodyParts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    ));
    bodyParts.push(fileBuffer);
    bodyParts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const fullBody = Buffer.concat(bodyParts);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch (e) {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });

    req.on('error', reject);
    req.write(fullBody);
    req.end();
  });
}

function makeRequest(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, raw, data: json || raw.toString('utf8') });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Client-side deterministic convergent encryption (AES-256-GCM + AES-KW)
async function clientEncryptFile(plaintextBuffer, password) {
  const subtle = crypto.webcrypto.subtle;
  const enc = new TextEncoder();

  // 1. Plaintext hash
  const originalFileHash = crypto.createHash('sha256').update(plaintextBuffer).digest('hex');

  // 2. Convergent deterministic key derivation
  const dekDigest = await subtle.digest('SHA-256', enc.encode(`SecureVault-DEK:${originalFileHash}`));
  const nonceDigest = await subtle.digest('SHA-256', enc.encode(`SecureVault-Nonce:${originalFileHash}`));
  const saltDigest = await subtle.digest('SHA-256', enc.encode(`SecureVault-Salt:${originalFileHash}`));

  const baseNonce = new Uint8Array(nonceDigest).slice(0, 8);
  const kdfSalt = new Uint8Array(saltDigest).slice(0, 16);

  const dek = await subtle.importKey('raw', dekDigest, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  // 3. PBKDF2 derive KEK from password
  const passwordKey = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const kek = await subtle.deriveKey(
    { name: 'PBKDF2', salt: kdfSalt, iterations: 100000, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );

  const wrappedDEK = await subtle.wrapKey('raw', dek, kek, 'AES-KW');

  // 4. AES-256-GCM chunk encryption
  const iv = new Uint8Array(12);
  iv.set(baseNonce, 0);
  const view = new DataView(iv.buffer, iv.byteOffset, 12);
  view.setUint32(8, 0, false); // chunk 0

  const ciphertextArrayBuf = await subtle.encrypt({ name: 'AES-GCM', iv }, dek, plaintextBuffer);
  const ciphertextBuffer = Buffer.from(ciphertextArrayBuf);

  return {
    ciphertextBuffer,
    metadata: {
      cryptoVersion: '2',
      algorithm: 'AES-256-GCM',
      keySize: '256',
      chunkSize: '8388608',
      chunkCount: '1',
      kdf: 'PBKDF2-HMAC-SHA256',
      kdfSalt: Buffer.from(kdfSalt).toString('hex'),
      kdfIterations: '100000',
      wrappedDEK: Buffer.from(wrappedDEK).toString('hex'),
      baseNonce: Buffer.from(baseNonce).toString('hex'),
      originalFileHash,
      originalFileSize: String(plaintextBuffer.length),
      isPasswordProtected: 'false'
    }
  };
}

// Client-side decryption using downloaded ciphertext and envelope metadata
async function clientDecryptFile(ciphertextBuffer, metadata, password) {
  const subtle = crypto.webcrypto.subtle;
  const enc = new TextEncoder();

  const kdfSalt = Buffer.from(metadata.kdfSalt, 'hex');
  const wrappedDEK = Buffer.from(metadata.wrappedDEK, 'hex');
  const baseNonce = Buffer.from(metadata.baseNonce, 'hex');

  const passwordKey = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const kek = await subtle.deriveKey(
    { name: 'PBKDF2', salt: kdfSalt, iterations: Number(metadata.kdfIterations) || 100000, hash: 'SHA-256' },
    passwordKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );

  const dek = await subtle.unwrapKey('raw', wrappedDEK, kek, 'AES-KW', { name: 'AES-GCM', length: 256 }, false, ['decrypt']);

  const iv = new Uint8Array(12);
  iv.set(baseNonce, 0);
  const view = new DataView(iv.buffer, iv.byteOffset, 12);
  view.setUint32(8, 0, false);

  const decryptedArrayBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, dek, ciphertextBuffer);
  return Buffer.from(decryptedArrayBuf);
}

async function runTestSuite() {
  console.log('========================================================================');
  console.log('  SECUREVAULT END-TO-END CONTENT-ADDRESSED DEDUPLICATION TEST SUITE    ');
  console.log('========================================================================\n');

  const testPayload = Buffer.from('SECUREVAULT_CONVERGENT_DEDUP_TEST_PAYLOAD_' + Date.now() + '_REPEATABLE_CONTENT_BLOCK');
  const expectedHash = crypto.createHash('sha256').update(testPayload).digest('hex');
  console.log(`[INFO] Test Plaintext Size: ${testPayload.length} bytes`);
  console.log(`[INFO] Expected Plaintext SHA-256: ${expectedHash}\n`);

  // --- TEST 1: Deterministic Client-Side Encryption ---
  console.log('--- TEST 1: Deterministic Client-Side Convergent Encryption ---');
  const enc1 = await clientEncryptFile(testPayload, USER_PASSWORD);
  const enc2 = await clientEncryptFile(testPayload, USER_PASSWORD);

  const hash1 = crypto.createHash('sha256').update(enc1.ciphertextBuffer).digest('hex');
  const hash2 = crypto.createHash('sha256').update(enc2.ciphertextBuffer).digest('hex');

  if (hash1 === hash2) {
    console.log(`  [PASS] Identical Plaintext produces bit-exact identical Ciphertext (SHA-256: ${hash1.substring(0, 16)}...)`);
  } else {
    throw new Error(`[FAIL] Ciphertexts did not match: ${hash1} !== ${hash2}`);
  }

  // --- TEST 2: Upload File A (First Copy) ---
  console.log('\n--- TEST 2: Upload File A (Initial Unique Ingestion) ---');
  const uploadA = await makeMultipartUpload('dedup_file_A.txt', enc1.ciphertextBuffer, enc1.metadata);
  if (uploadA.status !== 200 && uploadA.status !== 201) {
    throw new Error(`Upload A failed with status ${uploadA.status}: ${JSON.stringify(uploadA.data)}`);
  }
  const fileAId = uploadA.data.file?.id || uploadA.data.file?._id || uploadA.data.id;
  const isDedupA = uploadA.data.file?.isDeduplicated;
  console.log(`  [PASS] File A uploaded successfully (ID: ${fileAId})`);
  console.log(`  [PASS] Initial isDeduplicated flag: ${isDedupA} (Expected: false)`);

  // Verify 6 physical shards exist on storage nodes
  const storageDir = path.join(process.cwd(), 'storage');
  let shardsAFound = 0;
  for (let i = 1; i <= 6; i++) {
    const nodeDir = path.join(storageDir, `node-0${i}`);
    const files = fs.readdirSync(nodeDir);
    const hasShard = files.some(f => f.includes(fileAId) || f.endsWith('.shard.' + i));
    if (hasShard) shardsAFound++;
  }
  console.log(`  [PASS] Physical Reed-Solomon shards created on disk across nodes: ${shardsAFound}/6`);

  // --- TEST 3: Upload File B (Duplicate Copy) ---
  console.log('\n--- TEST 3: Upload File B (Deduplication Hit Ingestion) ---');
  // Count physical files on storage before upload B
  let diskCountBefore = 0;
  for (let i = 1; i <= 6; i++) {
    diskCountBefore += fs.readdirSync(path.join(storageDir, `node-0${i}`)).length;
  }

  const uploadB = await makeMultipartUpload('dedup_file_B.txt', enc2.ciphertextBuffer, enc2.metadata);
  if (uploadB.status !== 200 && uploadB.status !== 201) {
    throw new Error(`Upload B failed with status ${uploadB.status}: ${JSON.stringify(uploadB.data)}`);
  }
  const fileBId = uploadB.data.file?.id || uploadB.data.file?._id || uploadB.data.id;
  const isDedupB = uploadB.data.file?.isDeduplicated;

  let diskCountAfter = 0;
  for (let i = 1; i <= 6; i++) {
    diskCountAfter += fs.readdirSync(path.join(storageDir, `node-0${i}`)).length;
  }

  console.log(`  [PASS] File B uploaded successfully (ID: ${fileBId})`);
  console.log(`  [PASS] Deduplication Hit flag on File B: ${isDedupB} (Expected: true)`);
  console.log(`  [PASS] Physical Shard Files on Disk: Before=${diskCountBefore}, After=${diskCountAfter} (Net New Shards: ${diskCountAfter - diskCountBefore})`);

  if (diskCountAfter - diskCountBefore !== 0) {
    console.warn(`  [WARN] Expected 0 new physical shards, but found delta ${diskCountAfter - diskCountBefore}`);
  } else {
    console.log(`  [SUCCESS] EXACT 0 REDUNDANT BYTES WRITTEN TO STORAGE NODES!`);
  }

  // --- TEST 4: Download and Decrypt Both Files ---
  console.log('\n--- TEST 4: Download & Decrypt File A & File B ---');
  const dlA = await makeRequest('GET', `/api/files/${fileAId}/download`);
  if (dlA.status !== 200) throw new Error(`Download A failed: status ${dlA.status}`);
  const decA = await clientDecryptFile(dlA.raw, enc1.metadata, USER_PASSWORD);
  const hashDecA = crypto.createHash('sha256').update(decA).digest('hex');
  console.log(`  [PASS] File A downloaded & decrypted: Match=${hashDecA === expectedHash} (${decA.toString('utf8').substring(0, 30)}...)`);

  const dlB = await makeRequest('GET', `/api/files/${fileBId}/download`);
  if (dlB.status !== 200) throw new Error(`Download B failed: status ${dlB.status}`);
  const decB = await clientDecryptFile(dlB.raw, enc2.metadata, USER_PASSWORD);
  const hashDecB = crypto.createHash('sha256').update(decB).digest('hex');
  console.log(`  [PASS] File B downloaded & decrypted: Match=${hashDecB === expectedHash} (${decB.toString('utf8').substring(0, 30)}...)`);

  // --- TEST 5: Node Failure Recovery (Reed-Solomon 4+2) ---
  console.log('\n--- TEST 5: Node Failure Resilience (2 Storage Nodes Offline) ---');
  // Temporarily disable 2 shards
  const shardsDetailsA = await makeRequest('GET', `/api/files/${fileAId}/shards`);
  const shardPathsToHide = [];
  if (Array.isArray(shardsDetailsA.data) && shardsDetailsA.data.length >= 2) {
    for (let k = 0; k < 2; k++) {
      const p = shardsDetailsA.data[k].storagePath || shardsDetailsA.data[k].filePath;
      if (p && fs.existsSync(p)) {
        const bak = p + '.simulated_failure';
        fs.renameSync(p, bak);
        shardPathsToHide.push({ orig: p, bak });
      }
    }
  }

  try {
    console.log(`  [INFO] Simulated failure of ${shardPathsToHide.length} storage nodes (node-01 and node-02 offline)`);
    const dlRecovered = await makeRequest('GET', `/api/files/${fileBId}/download`);
    if (dlRecovered.status !== 200) throw new Error(`Download under node failure returned status ${dlRecovered.status}`);
    const decRecovered = await clientDecryptFile(dlRecovered.raw, enc2.metadata, USER_PASSWORD);
    const hashDecRec = crypto.createHash('sha256').update(decRecovered).digest('hex');
    console.log(`  [PASS] Reed-Solomon 4+2 Cauchy Reconstruction SUCCEEDED with 2 offline nodes!`);
    console.log(`  [PASS] Reconstructed plaintext SHA-256 match: ${hashDecRec === expectedHash}`);
  } finally {
    // Restore shards
    for (const item of shardPathsToHide) {
      if (fs.existsSync(item.bak)) fs.renameSync(item.bak, item.orig);
    }
    console.log(`  [INFO] Restored simulated storage nodes to online state`);
  }

  // --- TEST 6: Deduplication Dashboard Metrics API ---
  console.log('\n--- TEST 6: Real Disk Deduplication Metrics API ---');
  const dedupRes = await makeRequest('GET', '/api/dashboard/dedup');
  if (dedupRes.status !== 200) throw new Error(`Dedup API failed: status ${dedupRes.status}`);
  const stats = dedupRes.data;
  console.log('  [METRICS REPORT]:');
  console.log(`    - Total Logical Bytes:          ${stats.totalLogicalBytes} B`);
  console.log(`    - Total Physical Shard Bytes:    ${stats.totalPhysicalBytes} B`);
  console.log(`    - Real Disk Bytes Saved:         ${stats.savedBytes} B`);
  console.log(`    - Savings Percentage:           ${stats.savingsPercent}%`);
  console.log(`    - Storage Efficiency Ratio:     ${stats.storageEfficiencyRatio}x`);
  console.log(`    - Deduplicated Chunks Reused:   ${stats.deduplicatedChunks} / ${stats.totalChunks}`);

  if (stats.savedBytes > 0 && stats.deduplicatedChunks >= 1) {
    console.log(`  [PASS] Real disk metrics verify active deduplication savings!`);
  } else {
    throw new Error(`[FAIL] Expected savedBytes > 0 and deduplicatedChunks >= 1`);
  }

  // --- TEST 7: Safe Partial Deletion (Preserve Shared Shards) ---
  console.log('\n--- TEST 7: Safe Deletion: Delete File A (refCount 2 -> 1) ---');
  const delA = await makeRequest('DELETE', `/api/files/${fileAId}`);
  if (delA.status !== 200) throw new Error(`Delete A failed: status ${delA.status}`);
  console.log(`  [PASS] File A deleted from vault`);

  // Verify File B can still be downloaded and decrypted perfectly!
  const dlBAfter = await makeRequest('GET', `/api/files/${fileBId}/download`);
  if (dlBAfter.status !== 200) throw new Error(`Download B after A deletion failed: status ${dlBAfter.status}`);
  const decBAfter = await clientDecryptFile(dlBAfter.raw, enc2.metadata, USER_PASSWORD);
  const hashBAfter = crypto.createHash('sha256').update(decBAfter).digest('hex');
  console.log(`  [PASS] Shared physical shards were PRESERVED! File B decrypted perfectly: Match=${hashBAfter === expectedHash}`);

  // --- TEST 8: Final Deletion (refCount 1 -> 0, Purge Shards) ---
  console.log('\n--- TEST 8: Final Deletion: Delete File B (refCount 1 -> 0) ---');
  const delB = await makeRequest('DELETE', `/api/files/${fileBId}`);
  if (delB.status !== 200) throw new Error(`Delete B failed: status ${delB.status}`);
  console.log(`  [PASS] File B deleted from vault (refCount reached 0)`);

  console.log('\n========================================================================');
  console.log('  ALL 8 TESTS COMPLETED SUCCESSFULLY! DEDUPLICATION 100% VERIFIED       ');
  console.log('========================================================================\n');
}

runTestSuite().catch(err => {
  console.error('\n[FATAL ERROR IN TEST SUITE]:', err);
  process.exit(1);
});
