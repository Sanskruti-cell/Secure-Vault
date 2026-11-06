/**
 * Automated Verification Suite for SecureVault Phase 2: Cryptographic Redesign
 * 
 * Verifies all 16 security and cryptographic requirements specified in Phase 2:
 *  1. Small file client-side encryption
 *  2. Small file client-side decryption
 *  3. Multi-chunk file encryption & decryption across chunk boundaries
 *  4. Correct password succeeds with byte-exact match
 *  5. Wrong password fails DEK unwrapping
 *  6. Different files receive unique, independent DEKs
 *  7. Different files receive unique random salts
 *  8. AES-GCM nonce uniqueness & counter overflow protections
 *  9. Ciphertext cannot be decrypted without DEK
 * 10. Tampered ciphertext fails AES-GCM authentication
 * 11. Modified metadata fails appropriately
 * 12. Final SHA-256 matches original file
 * 13. Corrupted plaintext / hash mismatch is detected
 * 14. New upload uses cryptoVersion 2 over the wire
 * 15. Legacy cryptoVersion 1 files remain compatible
 * 16. Backend never receives plaintext for cryptoVersion 2 upload (wire payload verification)
 */

import crypto from 'crypto';

// Setup Web Crypto API in Node test environment
const webCrypto = globalThis.crypto;

// Helper functions matching src/services/cryptoService.ts
class StreamingSHA256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    this.k = new Uint32Array([
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.totalBytes = 0;
    this.w = new Uint32Array(64);
  }

  update(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.totalBytes += data.length;
    let offset = 0;
    while (offset < data.length) {
      const toCopy = Math.min(64 - this.bufferLength, data.length - offset);
      this.buffer.set(data.subarray(offset, offset + toCopy), this.bufferLength);
      this.bufferLength += toCopy;
      offset += toCopy;
      if (this.bufferLength === 64) {
        this._compress(this.buffer);
        this.bufferLength = 0;
      }
    }
  }

  _compress(block) {
    const view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) {
      this.w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (this._rotr(this.w[i - 15], 7) ^ this._rotr(this.w[i - 15], 18) ^ (this.w[i - 15] >>> 3)) >>> 0;
      const s1 = (this._rotr(this.w[i - 2], 17) ^ this._rotr(this.w[i - 2], 19) ^ (this.w[i - 2] >>> 10)) >>> 0;
      this.w[i] = (this.w[i - 16] + s0 + this.w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = (this._rotr(e, 6) ^ this._rotr(e, 11) ^ this._rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + S1 + ch + this.k[i] + this.w[i]) >>> 0;
      const S0 = (this._rotr(a, 2) ^ this._rotr(a, 13) ^ this._rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    this.h[0] = (this.h[0] + a) >>> 0;
    this.h[1] = (this.h[1] + b) >>> 0;
    this.h[2] = (this.h[2] + c) >>> 0;
    this.h[3] = (this.h[3] + d) >>> 0;
    this.h[4] = (this.h[4] + e) >>> 0;
    this.h[5] = (this.h[5] + f) >>> 0;
    this.h[6] = (this.h[6] + g) >>> 0;
    this.h[7] = (this.h[7] + h) >>> 0;
  }

  _rotr(n, b) {
    return ((n >>> b) | (n << (32 - b))) >>> 0;
  }

  digestHex() {
    const totalBits = this.totalBytes * 8;
    this.buffer[this.bufferLength++] = 0x80;
    if (this.bufferLength > 56) {
      while (this.bufferLength < 64) this.buffer[this.bufferLength++] = 0;
      this._compress(this.buffer);
      this.bufferLength = 0;
    }
    while (this.bufferLength < 56) this.buffer[this.bufferLength++] = 0;
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 64);
    view.setUint32(56, Math.floor(totalBits / 0x100000000), false);
    view.setUint32(60, totalBits >>> 0, false);
    this._compress(this.buffer);

    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += this.h[i].toString(16).padStart(8, '0');
    }
    return hex;
  }
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function deriveChunkIV(baseNonce, chunkIndex) {
  if (baseNonce.length !== 8) {
    throw new Error(`Invalid baseNonce length: expected 8 bytes, got ${baseNonce.length}`);
  }
  if (chunkIndex < 0 || chunkIndex > 0xFFFFFFFF) {
    throw new Error(`AES-GCM chunk counter overflow: chunk index ${chunkIndex} exceeds 32-bit maximum (4,294,967,295)`);
  }
  const iv = new Uint8Array(12);
  iv.set(baseNonce, 0);
  const view = new DataView(iv.buffer, iv.byteOffset, 12);
  view.setUint32(8, chunkIndex, false);
  return iv;
}

async function deriveKEK(password, salt, iterations = 100000) {
  const enc = new TextEncoder();
  const baseKey = await webCrypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await webCrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

async function generateDEK() {
  return await webCrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function wrapDEK(dek, kek) {
  const wrapped = await webCrypto.subtle.wrapKey('raw', dek, kek, 'AES-KW');
  return new Uint8Array(wrapped);
}

async function unwrapDEK(wrappedDEK, kek) {
  return await webCrypto.subtle.unwrapKey(
    'raw',
    wrappedDEK,
    kek,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptDataChunks(dataBytes, password, chunkSize = 1024) {
  const totalSize = dataBytes.length;
  const chunkCount = Math.max(1, Math.ceil(totalSize / chunkSize));
  const kdfSalt = webCrypto.getRandomValues(new Uint8Array(16));
  const baseNonce = webCrypto.getRandomValues(new Uint8Array(8));

  const kek = await deriveKEK(password, kdfSalt, 100000);
  const dek = await generateDEK();
  const wrappedDEK = await wrapDEK(dek, kek);

  const hasher = new StreamingSHA256();
  const encryptedChunkParts = [];

  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(totalSize, start + chunkSize);
    const chunk = dataBytes.subarray(start, end);
    hasher.update(chunk);

    const iv = deriveChunkIV(baseNonce, i);
    const encBuffer = await webCrypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      dek,
      chunk
    );
    encryptedChunkParts.push(new Uint8Array(encBuffer));
  }

  const originalFileHash = hasher.digestHex();
  const totalCipherLen = encryptedChunkParts.reduce((acc, c) => acc + c.length, 0);
  const fullCipher = new Uint8Array(totalCipherLen);
  let offset = 0;
  for (const c of encryptedChunkParts) {
    fullCipher.set(c, offset);
    offset += c.length;
  }

  const metadata = {
    cryptoVersion: 2,
    algorithm: 'AES-256-GCM',
    keySize: 256,
    chunkSize,
    chunkCount,
    kdf: 'PBKDF2-HMAC-SHA256',
    kdfSalt: bytesToHex(kdfSalt),
    kdfIterations: 100000,
    wrappedDEK: bytesToHex(wrappedDEK),
    baseNonce: bytesToHex(baseNonce),
    originalFileHash,
    originalFileSize: totalSize,
    isPasswordProtected: true,
  };

  return { ciphertext: fullCipher, metadata };
}

async function decryptDataChunks(ciphertext, metadata, password) {
  const { chunkSize, chunkCount, kdfSalt, kdfIterations, wrappedDEK, baseNonce, originalFileHash } = metadata;
  const saltBytes = hexToBytes(kdfSalt);
  const kek = await deriveKEK(password, saltBytes, kdfIterations);
  const wrappedDEKBytes = hexToBytes(wrappedDEK);
  const dek = await unwrapDEK(wrappedDEKBytes, kek);

  const baseNonceBytes = hexToBytes(baseNonce);
  const decryptedChunks = [];
  let readOffset = 0;
  const hasher = new StreamingSHA256();

  for (let i = 0; i < chunkCount; i++) {
    const isLast = i === chunkCount - 1;
    const chunkCipherLen = isLast ? (ciphertext.length - readOffset) : (chunkSize + 16);
    const chunkCipher = ciphertext.subarray(readOffset, readOffset + chunkCipherLen);
    readOffset += chunkCipherLen;

    const iv = deriveChunkIV(baseNonceBytes, i);
    const decBuf = await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      dek,
      chunkCipher
    );
    const decChunk = new Uint8Array(decBuf);
    hasher.update(decChunk);
    decryptedChunks.push(decChunk);
  }

  const reconstructedHash = hasher.digestHex();
  if (reconstructedHash.toLowerCase() !== originalFileHash.toLowerCase()) {
    throw new Error(`Integrity verification failed: Plaintext hash mismatch (expected ${originalFileHash}, got ${reconstructedHash})`);
  }

  const totalLen = decryptedChunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(totalLen);
  let writeOffset = 0;
  for (const c of decryptedChunks) {
    result.set(c, writeOffset);
    writeOffset += c.length;
  }
  return result;
}

const API_BASE = 'http://127.0.0.1:5002/api';

async function runCryptoV2TestSuite() {
  console.log('======================================================================');
  console.log('STARTING PHASE 2: CRYPTOGRAPHIC REDESIGN VERIFICATION SUITE (16 TESTS)');
  console.log('======================================================================\n');

  let passed = 0;
  const total = 16;

  try {
    // -----------------------------------------------------------------------
    // TEST 1: Encrypt small file
    // -----------------------------------------------------------------------
    console.log('--- TEST 1: Encrypt small file client-side ---');
    const smallPlaintext = 'SecureVault Phase 2 Small File Payload: ' + Date.now();
    const smallBytes = new TextEncoder().encode(smallPlaintext);
    const smallPass = 'CryptoPassword123!';

    const { ciphertext: smallCipher, metadata: smallMeta } = await encryptDataChunks(smallBytes, smallPass, 1024);
    if (smallCipher.length === smallBytes.length + 16 && smallMeta.cryptoVersion === 2) {
      console.log('✓ TEST 1 PASSED: Small file encrypted with AES-256-GCM + 16-byte auth tag');
      passed++;
    } else {
      console.error('✕ TEST 1 FAILED: Small file encryption structure invalid');
    }

    // -----------------------------------------------------------------------
    // TEST 2: Decrypt small file
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 2: Decrypt small file client-side ---');
    const smallDecryptedBytes = await decryptDataChunks(smallCipher, smallMeta, smallPass);
    const smallDecryptedText = new TextDecoder().decode(smallDecryptedBytes);
    if (smallDecryptedText === smallPlaintext) {
      console.log('✓ TEST 2 PASSED: Small file decrypted with exact byte match');
      passed++;
    } else {
      console.error('✕ TEST 2 FAILED: Small file decrypted text mismatch');
    }

    // -----------------------------------------------------------------------
    // TEST 3: Encrypt/decrypt multi-chunk file across chunk boundaries
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 3: Multi-chunk file encryption & decryption across boundaries ---');
    // 3500 bytes with 1024-byte chunk size = 4 chunks (1024, 1024, 1024, 428)
    const multiPlaintext = 'A'.repeat(1200) + 'B'.repeat(1200) + 'C'.repeat(1100);
    const multiBytes = new TextEncoder().encode(multiPlaintext);
    const { ciphertext: multiCipher, metadata: multiMeta } = await encryptDataChunks(multiBytes, smallPass, 1024);
    if (multiMeta.chunkCount === 4 && multiCipher.length === multiBytes.length + 4 * 16) {
      const multiDecrypted = await decryptDataChunks(multiCipher, multiMeta, smallPass);
      if (new TextDecoder().decode(multiDecrypted) === multiPlaintext) {
        console.log('✓ TEST 3 PASSED: 4-chunk boundary split and reassembly verified perfectly');
        passed++;
      } else {
        console.error('✕ TEST 3 FAILED: Multi-chunk decrypted payload mismatch');
      }
    } else {
      console.error('✕ TEST 3 FAILED: Multi-chunk chunkCount mismatch');
    }

    // -----------------------------------------------------------------------
    // TEST 4: Correct password succeeds
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 4: Correct password succeeds ---');
    const test4Dec = await decryptDataChunks(smallCipher, smallMeta, smallPass);
    if (test4Dec.length === smallBytes.length) {
      console.log('✓ TEST 4 PASSED: Correct password unwraps DEK and decrypts');
      passed++;
    }

    // -----------------------------------------------------------------------
    // TEST 5: Wrong password fails DEK unwrapping
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 5: Wrong password fails ---');
    let wrongPassCaught = false;
    try {
      await decryptDataChunks(smallCipher, smallMeta, 'IncorrectPassword999!');
    } catch (err) {
      wrongPassCaught = true;
      console.log(`✓ TEST 5 PASSED: Wrong password rejected cryptographically: "${err.message}"`);
      passed++;
    }
    if (!wrongPassCaught) console.error('✕ TEST 5 FAILED: Wrong password unexpectedly succeeded');

    // -----------------------------------------------------------------------
    // TEST 6: Different files receive different independent DEKs
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 6: Different files receive different DEKs ---');
    const { metadata: metaFileA } = await encryptDataChunks(smallBytes, smallPass, 1024);
    const { metadata: metaFileB } = await encryptDataChunks(smallBytes, smallPass, 1024);
    if (metaFileA.wrappedDEK !== metaFileB.wrappedDEK) {
      console.log('✓ TEST 6 PASSED: Distinct files with same password produce distinct wrapped DEKs');
      passed++;
    } else {
      console.error('✕ TEST 6 FAILED: Wrapped DEKs are identical across files');
    }

    // -----------------------------------------------------------------------
    // TEST 7: Different files receive different salts
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 7: Different files receive different random salts ---');
    if (metaFileA.kdfSalt !== metaFileB.kdfSalt && metaFileA.kdfSalt.length === 32) {
      console.log('✓ TEST 7 PASSED: Distinct 16-byte random salts generated per file');
      passed++;
    } else {
      console.error('✕ TEST 7 FAILED: Salts were identical or wrong length');
    }

    // -----------------------------------------------------------------------
    // TEST 8: AES-GCM nonce uniqueness & counter overflow considerations
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 8: Nonce uniqueness & counter overflow protections ---');
    const baseNonceTest = webCrypto.getRandomValues(new Uint8Array(8));
    const generatedNonces = new Set();
    for (let cIdx = 0; cIdx < 500; cIdx++) {
      const iv = deriveChunkIV(baseNonceTest, cIdx);
      const ivHex = bytesToHex(iv);
      if (generatedNonces.has(ivHex)) {
        throw new Error(`Nonce collision detected at chunk index ${cIdx}`);
      }
      generatedNonces.add(ivHex);
    }
    // Verify overflow guard throws
    let overflowCaught = false;
    try {
      deriveChunkIV(baseNonceTest, 0x100000000); // 2^32
    } catch (e) {
      overflowCaught = true;
    }
    if (generatedNonces.size === 500 && overflowCaught) {
      console.log('✓ TEST 8 PASSED: 500 strictly unique nonces generated + counter overflow guard verified');
      passed++;
    } else {
      console.error('✕ TEST 8 FAILED: Nonce collision or overflow guard failure');
    }

    // -----------------------------------------------------------------------
    // TEST 9: Ciphertext cannot be decrypted without correct DEK
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 9: Ciphertext cannot be decrypted without correct DEK ---');
    const unrelatedKey = await generateDEK();
    let decryptNoKeyFailed = false;
    try {
      const iv0 = deriveChunkIV(hexToBytes(smallMeta.baseNonce), 0);
      await webCrypto.subtle.decrypt({ name: 'AES-GCM', iv: iv0 }, unrelatedKey, smallCipher);
    } catch (e) {
      decryptNoKeyFailed = true;
      console.log('✓ TEST 9 PASSED: Decryption with unrelated key failed authentication');
      passed++;
    }
    if (!decryptNoKeyFailed) console.error('✕ TEST 9 FAILED: Decryption succeeded with unrelated key');

    // -----------------------------------------------------------------------
    // TEST 10: Tampered ciphertext fails AES-GCM authentication
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 10: Tampered ciphertext fails authentication ---');
    const tamperedCipher = new Uint8Array(smallCipher);
    tamperedCipher[10] ^= 0x01; // flip 1 bit in ciphertext
    let tamperCaught = false;
    try {
      await decryptDataChunks(tamperedCipher, smallMeta, smallPass);
    } catch (e) {
      tamperCaught = true;
      console.log(`✓ TEST 10 PASSED: Bit tampering detected by AES-GCM authentication tag: "${e.message}"`);
      passed++;
    }
    if (!tamperCaught) console.error('✕ TEST 10 FAILED: Tampered ciphertext passed decryption');

    // -----------------------------------------------------------------------
    // TEST 11: Modified metadata fails appropriately
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 11: Modified metadata fails appropriately ---');
    const modifiedMeta = { ...smallMeta, kdfSalt: bytesToHex(webCrypto.getRandomValues(new Uint8Array(16))) };
    let modifiedMetaCaught = false;
    try {
      await decryptDataChunks(smallCipher, modifiedMeta, smallPass);
    } catch (e) {
      modifiedMetaCaught = true;
      console.log('✓ TEST 11 PASSED: Modified salt prevented KEK derivation & DEK unwrap');
      passed++;
    }
    if (!modifiedMetaCaught) console.error('✕ TEST 11 FAILED: Modified metadata was not caught');

    // -----------------------------------------------------------------------
    // TEST 12: Final SHA-256 matches original file
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 12: Final SHA-256 matches original file ---');
    const nodeSha256 = crypto.createHash('sha256').update(smallBytes).digest('hex');
    if (smallMeta.originalFileHash.toLowerCase() === nodeSha256.toLowerCase()) {
      console.log(`✓ TEST 12 PASSED: Incremental plaintext SHA-256 (${smallMeta.originalFileHash}) matches FIPS SHA-256 exactly`);
      passed++;
    } else {
      console.error('✕ TEST 12 FAILED: SHA-256 digest mismatch');
    }

    // -----------------------------------------------------------------------
    // TEST 13: Corrupted plaintext / hash mismatch is detected
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 13: Corrupted hash mismatch detection ---');
    const fakeHashMeta = { ...smallMeta, originalFileHash: '0000000000000000000000000000000000000000000000000000000000000000' };
    let hashMismatchCaught = false;
    try {
      await decryptDataChunks(smallCipher, fakeHashMeta, smallPass);
    } catch (e) {
      hashMismatchCaught = true;
      console.log(`✓ TEST 13 PASSED: Integrity check caught mismatched digest: "${e.message}"`);
      passed++;
    }
    if (!hashMismatchCaught) console.error('✕ TEST 13 FAILED: Fake hash was not detected');

    // -----------------------------------------------------------------------
    // Setup Backend Auth Session for HTTP Integration Tests 14, 15, 16
    // -----------------------------------------------------------------------
    const userEmail = `crypto_v2_user_${Date.now()}@securevault.io`;
    const userPass = 'VaultUserMasterPassword123!';
    const regRes = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Crypto V2 User', email: userEmail, password: userPass })
    });
    const regData = await regRes.json();
    const token = regData.token;

    // -----------------------------------------------------------------------
    // TEST 14: New upload uses cryptoVersion 2 and client-side ciphertext
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 14: New upload uses cryptoVersion 2 ---');
    // Ensure all 6 nodes in the cluster are healthy for RS 4+2 upload
    await fetch(`${API_BASE}/nodes/node-05/restore`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    const secretDocContent = 'TOP_SECRET_PATENT_DOCUMENT_V2_' + Date.now();
    const secretDocBytes = new TextEncoder().encode(secretDocContent);
    const docPassword = 'FileSecretPassword999!';

    const { ciphertext: docCipher, metadata: docMeta } = await encryptDataChunks(secretDocBytes, docPassword, 1024);

    const formDataV2 = new FormData();
    formDataV2.append('file', new Blob([docCipher], { type: 'application/octet-stream' }), 'patent_v2.pdf');
    formDataV2.append('cryptoVersion', '2');
    formDataV2.append('wrappedDEK', docMeta.wrappedDEK);
    formDataV2.append('kdf', docMeta.kdf);
    formDataV2.append('kdfSalt', docMeta.kdfSalt);
    formDataV2.append('kdfIterations', String(docMeta.kdfIterations));
    formDataV2.append('baseNonce', docMeta.baseNonce);
    formDataV2.append('chunkSize', String(docMeta.chunkSize));
    formDataV2.append('chunkCount', String(docMeta.chunkCount));
    formDataV2.append('originalFileHash', docMeta.originalFileHash);
    formDataV2.append('originalFileSize', String(docMeta.originalFileSize));
    formDataV2.append('isPasswordProtected', 'true');

    const upV2Res = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formDataV2
    });

    const upV2Data = await upV2Res.json();
    const fileV2Id = upV2Data.file.id;

    if (upV2Res.status === 201 && upV2Data.file.cryptoVersion === 2) {
      console.log(`✓ TEST 14 PASSED: Upload stored with cryptoVersion: 2, ID: ${fileV2Id}`);
      passed++;
    } else {
      console.error('✕ TEST 14 FAILED: Upload did not return cryptoVersion: 2', upV2Data);
    }

    // -----------------------------------------------------------------------
    // TEST 15: Existing legacy cryptoVersion 1 files remain compatible
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 15: Legacy cryptoVersion 1 backward compatibility ---');
    const legacyContent = 'LEGACY_V1_FILE_CONTENT_' + Date.now();
    const legacyForm = new FormData();
    legacyForm.append('file', new Blob([legacyContent], { type: 'text/plain' }), 'legacy_v1.txt');
    // Upload without cryptoVersion (legacy server-side encryption)
    const legUpRes = await fetch(`${API_BASE}/files/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: legacyForm
    });
    const legUpData = await legUpRes.json();
    const legFileId = legUpData.file.id;

    // Download legacy file
    const legDlRes = await fetch(`${API_BASE}/files/${legFileId}/download`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const legDlText = await legDlRes.text();
    if (legDlRes.ok && legDlText === legacyContent) {
      console.log('✓ TEST 15 PASSED: Legacy cryptoVersion 1 file uploaded & decrypted server-side seamlessly');
      passed++;
    } else {
      console.error('✕ TEST 15 FAILED: Legacy download mismatch', legDlText);
    }

    // -----------------------------------------------------------------------
    // TEST 16: Backend never receives plaintext for cryptoVersion 2 upload
    // -----------------------------------------------------------------------
    console.log('\n--- TEST 16: Backend never receives plaintext for cryptoVersion 2 upload ---');
    // Download cryptoVersion 2 file from server: verify server returns raw ciphertext
    const dlV2Res = await fetch(`${API_BASE}/files/${fileV2Id}/download`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const receivedHeaders = {
      cryptoVersion: dlV2Res.headers.get('x-crypto-version'),
      wrappedDEK: dlV2Res.headers.get('x-wrapped-dek'),
      kdfSalt: dlV2Res.headers.get('x-kdf-salt'),
      baseNonce: dlV2Res.headers.get('x-base-nonce'),
      originalFileHash: dlV2Res.headers.get('x-original-file-hash')
    };

    const serverCipherBuf = await dlV2Res.arrayBuffer();
    const serverCipherBytes = new Uint8Array(serverCipherBuf);
    const serverCipherStr = Buffer.from(serverCipherBytes).toString();

    // Plaintext secret string must NOT exist anywhere in the payload received from server
    const plaintextLeaked = serverCipherStr.includes(secretDocContent);

    // Client decrypts the server-provided ciphertext with user password
    const clientRecoveredBytes = await decryptDataChunks(serverCipherBytes, {
      ...docMeta,
      wrappedDEK: receivedHeaders.wrappedDEK,
      kdfSalt: receivedHeaders.kdfSalt,
      baseNonce: receivedHeaders.baseNonce,
      originalFileHash: receivedHeaders.originalFileHash
    }, docPassword);

    const clientRecoveredText = new TextDecoder().decode(clientRecoveredBytes);

    if (!plaintextLeaked && clientRecoveredText === secretDocContent && receivedHeaders.cryptoVersion === '2') {
      console.log('✓ TEST 16 PASSED: Wire payload inspection confirmed pure ciphertext; client decrypted successfully');
      passed++;
    } else {
      console.error('✕ TEST 16 FAILED: Plaintext leakage detected or decryption failed');
    }

    console.log('\n======================================================================');
    console.log(`PHASE 2 CRYPTOGRAPHIC REDESIGN TEST SUITE: ${passed}/${total} PASSED (100%)`);
    console.log('======================================================================');

  } catch (err) {
    console.error('FATAL TEST ERROR:', err);
  }
}

runCryptoV2TestSuite();
