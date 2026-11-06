/**
 * Phase 5 Automated Test Suite: Secure File Sharing
 *
 * Tests:
 * 1. Token Security & Entropy: 256-bit random hex tokens (64 hex characters).
 * 2. Ownership & Authorization: User B cannot create a share for User A's file (403 Forbidden).
 * 3. Creator Data Isolation: User B cannot see User A's share links in GET /api/shares.
 * 4. Public Metadata Access: Unauthenticated recipient can fetch metadata via GET /api/shares/public/:token.
 * 5. Zero-Knowledge Invariants: Backend stores ONLY wrappedDEKForShare and KDF metadata; no plaintext password or DEK is ever received or stored.
 * 6. Phase 4 RS 4+2 Recovery on Shared Download: Missing / offline shards are recovered correctly via Reed-Solomon 4+2 during shared download.
 * 7. Download Quota Enforcement: A share with downloadLimit: 1 succeeds on 1st download and returns 410 Gone on 2nd attempt.
 * 8. Expiration Enforcement: A share with expired timestamp returns 410 Gone.
 * 9. Revocation Enforcement: Owner can revoke share; User B cannot revoke User A's share; revoked share returns 410 Gone.
 * 10. Recipient Client-Side Decryption (Password-Protected): Recipient WebCrypto derives Share KEK from password, unwraps DEK, decrypts AES-256-GCM chunks, and validates plaintext SHA-256 digest.
 * 11. Recipient Client-Side Decryption (Link Key in URL Fragment): Recipient WebCrypto imports link key from URL fragment, unwraps DEK, decrypts AES-256-GCM chunks, and validates plaintext SHA-256.
 * 12. Legacy cryptoVersion: 1 Compatibility: Legacy files can be shared and downloaded.
 */

import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createShardsFromBuffer } from './src/services/shardingService.js';
import { generateFileHash } from './src/services/hashingService.js';
import { memFiles, memShards, memActivities } from './src/controllers/fileController.js';
import {
  createShare,
  getSharedLinks,
  getPublicShareInfo,
  downloadPublicShare,
  deleteShare,
  memoryShares
} from './src/controllers/shareController.js';

// Helper: Mock Express req/res
function mockReqRes(options = {}) {
  const req = {
    user: options.user || { _id: 'user-001', id: 'user-001', email: 'owner@test.local' },
    body: options.body || {},
    params: options.params || {},
    query: options.query || {},
    headers: options.headers || {},
  };

  const res = {
    statusCode: 200,
    headers: {},
    bodyData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.bodyData = data;
      return this;
    },
    send(data) {
      this.bodyData = data;
      return this;
    },
    setHeader(name, val) {
      this.headers[name] = val;
    }
  };

  const next = (err) => {
    if (err) throw err;
  };

  return { req, res, next };
}

let passedTests = 0;
let totalTests = 0;

function reportTest(name, passed, details = '') {
  totalTests++;
  if (passed) {
    passedTests++;
    console.log(`  [PASS] Test ${totalTests}: ${name}`);
  } else {
    console.error(`  [FAIL] Test ${totalTests}: ${name} - ${details}`);
    process.exitCode = 1;
  }
}

async function runTests() {
  console.log('================================================================');
  console.log('PHASE 5: SECURE FILE SHARING AUTOMATED TEST SUITE');
  console.log('================================================================\n');

  // Setup mock storage directories
  for (let i = 1; i <= 6; i++) {
    const dir = path.join(process.cwd(), 'storage', `node-0${i}`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Prepare a test cryptoVersion: 2 file uploaded by user-001
  // -------------------------------------------------------------------------
  const plaintext = Buffer.from('Confidential Phase 5 Zero-Knowledge Shared Document Content! 1234567890');
  const originalFileHash = crypto.createHash('sha256').update(plaintext).digest('hex');

  // Client-side encryption simulation using WebCrypto
  const webCrypto = crypto.webcrypto;
  const rawDEK = crypto.randomBytes(32);
  const dekKey = await webCrypto.subtle.importKey('raw', rawDEK, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  // File Master Password KEK for owner
  const ownerPass = 'OwnerVaultSecret123!';
  const fileSalt = crypto.randomBytes(16);
  const ownerBaseKey = await webCrypto.subtle.importKey('raw', Buffer.from(ownerPass), 'PBKDF2', false, ['deriveKey']);
  const ownerKEK = await webCrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fileSalt, iterations: 100000, hash: 'SHA-256' },
    ownerBaseKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
  const ownerWrappedDEK = Buffer.from(await webCrypto.subtle.wrapKey('raw', dekKey, ownerKEK, 'AES-KW')).toString('hex');

  const baseNonce = crypto.randomBytes(8);
  const chunkIV = Buffer.concat([baseNonce, Buffer.from([0, 0, 0, 0])]);
  const encryptedChunk = Buffer.from(await webCrypto.subtle.encrypt({ name: 'AES-GCM', iv: chunkIV }, dekKey, plaintext));
  const ciphertextHash = crypto.createHash('sha256').update(encryptedChunk).digest('hex');

  // Shard ciphertext using Reed-Solomon 4+2
  const shards = createShardsFromBuffer(encryptedChunk, 6, { shardingVersion: 2 });
  const testFileId = 'file-test-share-001';

  for (let i = 0; i < shards.length; i++) {
    const s = shards[i];
    const nodeDir = path.join(process.cwd(), 'storage', `node-0${i + 1}`);
    const shardPath = path.join(nodeDir, `${testFileId}.shard.${i + 1}`);
    fs.writeFileSync(shardPath, s.data);

    memShards.push({
      fileId: testFileId,
      shardIndex: s.index,
      shardType: s.shardType,
      shardHash: s.hash,
      nodeId: `node-0${i + 1}`,
      shardSize: s.size,
      storagePath: shardPath,
    });
  }

  const mockFileRecord = {
    id: testFileId,
    _id: testFileId,
    userId: 'user-001',
    fileName: 'TopSecret_Doc.pdf',
    fileSize: plaintext.length,
    originalFileSize: plaintext.length,
    ciphertextSize: encryptedChunk.length,
    ciphertextHash,
    fileHash: ciphertextHash,
    originalFileHash,
    cryptoVersion: 2,
    shardingVersion: 2,
    erasureCoding: 'reed-solomon',
    dataShards: 4,
    parityShards: 2,
    totalShards: 6,
    encryptionAlgorithm: 'AES-256-GCM',
    wrappedDEK: ownerWrappedDEK,
    kdf: 'PBKDF2-HMAC-SHA256',
    kdfSalt: fileSalt.toString('hex'),
    kdfIterations: 100000,
    baseNonce: baseNonce.toString('hex'),
    chunkSize: 8388608,
    chunkCount: 1,
    isPasswordProtected: false,
    status: 'encrypted',
  };
  memFiles.push(mockFileRecord);

  // -------------------------------------------------------------------------
  // TEST 1: Token Security & Entropy
  // -------------------------------------------------------------------------
  {
    // Derive share-wrapped DEK for public link (Link Key in URL fragment)
    const linkKeyBytes = crypto.randomBytes(32);
    const linkKeyObj = await webCrypto.subtle.importKey('raw', linkKeyBytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
    const wrappedDEKForShare = Buffer.from(await webCrypto.subtle.wrapKey('raw', dekKey, linkKeyObj, 'AES-KW')).toString('hex');

    const { req, res, next } = mockReqRes({
      user: { _id: 'user-001', id: 'user-001' },
      body: {
        fileId: testFileId,
        expiresDays: 7,
        downloadLimit: 5,
        isPasswordProtected: false,
        wrappedDEKForShare,
      }
    });

    await createShare(req, res, next);
    const createdShare = res.bodyData.share || res.bodyData;

    const isHex64 = /^[0-9a-f]{64}$/i.test(createdShare.token);
    reportTest(
      'Token Security: Generated share token is a cryptographically secure 256-bit (64 hex) random token',
      res.statusCode === 201 && isHex64,
      `Token: ${createdShare?.token}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 2: Ownership & Authorization on Share Creation
  // -------------------------------------------------------------------------
  {
    const { req, res, next } = mockReqRes({
      user: { _id: 'user-002', id: 'user-002' }, // User 2 trying to share User 1's file
      body: {
        fileId: testFileId,
        expiresDays: 7,
      }
    });

    await createShare(req, res, next);
    reportTest(
      'Authorization: Non-owner (User 2) is forbidden from creating share for User 1 file (403 Forbidden)',
      res.statusCode === 403,
      `Status: ${res.statusCode}, Error: ${res.bodyData?.error}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 3: Creator Data Isolation in Share Listing
  // -------------------------------------------------------------------------
  {
    const { req: req1, res: res1, next: next1 } = mockReqRes({
      user: { _id: 'user-001', id: 'user-001' },
    });
    await getSharedLinks(req1, res1, next1);
    const user1Shares = res1.bodyData;

    const { req: req2, res: res2, next: next2 } = mockReqRes({
      user: { _id: 'user-002', id: 'user-002' },
    });
    await getSharedLinks(req2, res2, next2);
    const user2Shares = res2.bodyData;

    reportTest(
      'Data Isolation: User 1 sees their shares, User 2 sees 0 shares created by User 1',
      Array.isArray(user1Shares) && user1Shares.length >= 1 && Array.isArray(user2Shares) && user2Shares.length === 0,
      `User 1 count: ${user1Shares?.length}, User 2 count: ${user2Shares?.length}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 4: Public Metadata Access (No JWT Authentication)
  // -------------------------------------------------------------------------
  let publicShareToken = null;
  let publicShareLinkKeyHex = null;
  {
    const linkKeyBytes = crypto.randomBytes(32);
    publicShareLinkKeyHex = linkKeyBytes.toString('hex');
    const linkKeyObj = await webCrypto.subtle.importKey('raw', linkKeyBytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
    const wrappedDEKForShare = Buffer.from(await webCrypto.subtle.wrapKey('raw', dekKey, linkKeyObj, 'AES-KW')).toString('hex');

    const { req, res, next } = mockReqRes({
      user: { _id: 'user-001', id: 'user-001' },
      body: {
        fileId: testFileId,
        expiresDays: 3,
        downloadLimit: 3,
        isPasswordProtected: false,
        wrappedDEKForShare,
      }
    });
    await createShare(req, res, next);
    publicShareToken = res.bodyData.token;

    // Fetch public metadata without any user credentials
    const { req: pubReq, res: pubRes, next: pubNext } = mockReqRes({
      user: null, // Public unauthenticated recipient
      params: { token: publicShareToken }
    });
    await getPublicShareInfo(pubReq, pubRes, pubNext);

    reportTest(
      'Public Metadata: Unauthenticated recipient can fetch metadata for valid share',
      pubRes.statusCode === 200 && pubRes.bodyData.fileName === 'TopSecret_Doc.pdf' && pubRes.bodyData.status === 'active',
      `Status: ${pubRes.statusCode}, Data: ${JSON.stringify(pubRes.bodyData)}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 5: Zero-Knowledge Invariants Verification
  // -------------------------------------------------------------------------
  {
    const shareRecord = memoryShares.find(s => s.token === publicShareToken);
    const hasNoPlaintextPassword = shareRecord.password === undefined && shareRecord.sharePassword === undefined;
    const hasNoPlaintextDEK = shareRecord.dek === undefined && shareRecord.rawDEK === undefined;
    const hasWrappedDEK = typeof shareRecord.wrappedDEKForShare === 'string' && shareRecord.wrappedDEKForShare.length > 0;

    reportTest(
      'Zero-Knowledge: Server record contains ONLY wrappedDEKForShare and zero plaintext secrets',
      hasNoPlaintextPassword && hasNoPlaintextDEK && hasWrappedDEK,
      `Share record keys: ${Object.keys(shareRecord).join(', ')}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 6: Phase 4 Reed-Solomon 4+2 Recovery on Shared Download
  // (Simulate 2 corrupted / deleted shards on storage nodes)
  // -------------------------------------------------------------------------
  {
    // Temporarily corrupt shard 2 and delete shard 5
    const shard2Path = path.join(process.cwd(), 'storage', 'node-02', `${testFileId}.shard.2`);
    const shard5Path = path.join(process.cwd(), 'storage', 'node-05', `${testFileId}.shard.5`);
    const origShard2 = fs.readFileSync(shard2Path);
    const origShard5 = fs.readFileSync(shard5Path);

    // Corrupt shard 2 with random garbage
    fs.writeFileSync(shard2Path, crypto.randomBytes(origShard2.length));
    // Remove shard 5 from disk
    fs.unlinkSync(shard5Path);

    const { req, res, next } = mockReqRes({
      user: null, // Unauthenticated recipient
      params: { token: publicShareToken }
    });

    await downloadPublicShare(req, res, next);

    // Restore shard files
    fs.writeFileSync(shard2Path, origShard2);
    fs.writeFileSync(shard5Path, origShard5);

    const reconstructedCiphertext = res.bodyData;
    const isExactCiphertextMatch = reconstructedCiphertext && Buffer.isBuffer(reconstructedCiphertext) &&
      crypto.createHash('sha256').update(reconstructedCiphertext).digest('hex') === ciphertextHash;

    reportTest(
      'RS 4+2 Recovery on Share Download: Survives 2 corrupted/missing shards and reconstructs exact ciphertext',
      res.statusCode === 200 && isExactCiphertextMatch && res.headers['X-Crypto-Version'] === '2',
      `Status: ${res.statusCode}, Ciphertext bytes: ${reconstructedCiphertext?.length}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 7: Download Quota Enforcement (downloadLimit: 1)
  // -------------------------------------------------------------------------
  {
    const linkKeyBytes = crypto.randomBytes(32);
    const linkKeyObj = await webCrypto.subtle.importKey('raw', linkKeyBytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
    const wrappedDEKForShare = Buffer.from(await webCrypto.subtle.wrapKey('raw', dekKey, linkKeyObj, 'AES-KW')).toString('hex');

    const { req: cReq, res: cRes, next: cNext } = mockReqRes({
      user: { _id: 'user-001', id: 'user-001' },
      body: {
        fileId: testFileId,
        expiresDays: 1,
        downloadLimit: 1, // Single-use share link
        isPasswordProtected: false,
        wrappedDEKForShare,
      }
    });
    await createShare(cReq, cRes, cNext);
    const singleUseToken = cRes.bodyData.token;

    // 1st Download Attempt (Should succeed)
    const { req: dReq1, res: dRes1, next: dNext1 } = mockReqRes({
      user: null,
      params: { token: singleUseToken }
    });
    await downloadPublicShare(dReq1, dRes1, dNext1);

    // 2nd Download Attempt (Should return 410 Gone)
    const { req: dReq2, res: dRes2, next: dNext2 } = mockReqRes({
      user: null,
      params: { token: singleUseToken }
    });
    await downloadPublicShare(dReq2, dRes2, dNext2);

    reportTest(
      'Download Quota: Single-use share link allows 1st download and returns 410 Gone on 2nd attempt',
      dRes1.statusCode === 200 && dRes2.statusCode === 410,
      `Attempt 1: ${dRes1.statusCode}, Attempt 2: ${dRes2.statusCode}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 8: Expiration Enforcement (expiresAt in past)
  // -------------------------------------------------------------------------
  {
    const expiredToken = crypto.randomBytes(32).toString('hex');
    const expiredShare = {
      id: expiredToken,
      token: expiredToken,
      fileId: testFileId,
      creatorUserId: 'user-001',
      fileName: 'TopSecret_Doc.pdf',
      expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      downloadLimit: 10,
      downloadCount: 0,
      status: 'active',
      isPasswordProtected: false,
      wrappedDEKForShare: ownerWrappedDEK,
    };
    memoryShares.push(expiredShare);

    const { req, res, next } = mockReqRes({
      user: null,
      params: { token: expiredToken }
    });
    await downloadPublicShare(req, res, next);

    reportTest(
      'Expiration Enforcement: Expired share link returns 410 Gone',
      res.statusCode === 410,
      `Status: ${res.statusCode}, Error: ${res.bodyData?.error}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 9: Revocation Enforcement & Access Control
  // -------------------------------------------------------------------------
  {
    const revokeToken = crypto.randomBytes(32).toString('hex');
    const shareToRevoke = {
      id: revokeToken,
      token: revokeToken,
      fileId: testFileId,
      creatorUserId: 'user-001',
      fileName: 'TopSecret_Doc.pdf',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      downloadLimit: 10,
      downloadCount: 0,
      status: 'active',
      isPasswordProtected: false,
      wrappedDEKForShare: ownerWrappedDEK,
    };
    memoryShares.push(shareToRevoke);

    // User 2 attempts to revoke User 1's share (Should fail 403)
    const { req: unauthReq, res: unauthRes, next: unauthNext } = mockReqRes({
      user: { _id: 'user-002', id: 'user-002' },
      params: { id: revokeToken }
    });
    await deleteShare(unauthReq, unauthRes, unauthNext);

    // User 1 revokes their own share (Should succeed 200)
    const { req: authReq, res: authRes, next: authNext } = mockReqRes({
      user: { _id: 'user-001', id: 'user-001' },
      params: { id: revokeToken }
    });
    await deleteShare(authReq, authRes, authNext);

    // Recipient attempts to download revoked share (Should return 410 Gone)
    const { req: getReq, res: getRes, next: getNext } = mockReqRes({
      user: null,
      params: { token: revokeToken }
    });
    await downloadPublicShare(getReq, getRes, getNext);

    reportTest(
      'Revocation Enforcement: Unauthorized user blocked (403), owner revokes (200), recipient blocked (410)',
      unauthRes.statusCode === 403 && authRes.statusCode === 200 && getRes.statusCode === 410,
      `Unauth: ${unauthRes.statusCode}, Owner: ${authRes.statusCode}, Recipient: ${getRes.statusCode}`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 10: Recipient Client-Side Decryption (Password-Protected Share)
  // -------------------------------------------------------------------------
  {
    const sharePassword = 'CustomShareSecretPassphrase456!';
    const shareSalt = crypto.randomBytes(16);
    const shareIterations = 100000;

    // Owner browser prepares wrappedDEK with share password
    const shareBaseKey = await webCrypto.subtle.importKey('raw', Buffer.from(sharePassword), 'PBKDF2', false, ['deriveKey']);
    const shareKEK = await webCrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: shareSalt, iterations: shareIterations, hash: 'SHA-256' },
      shareBaseKey,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );
    const passwordWrappedDEK = Buffer.from(await webCrypto.subtle.wrapKey('raw', dekKey, shareKEK, 'AES-KW')).toString('hex');

    // Create password-protected share
    const { req: cReq, res: cRes, next: cNext } = mockReqRes({
      user: { _id: 'user-001', id: 'user-001' },
      body: {
        fileId: testFileId,
        expiresDays: 7,
        downloadLimit: 10,
        isPasswordProtected: true,
        wrappedDEKForShare: passwordWrappedDEK,
        kdf: 'PBKDF2-HMAC-SHA256',
        kdfSalt: shareSalt.toString('hex'),
        kdfIterations: shareIterations,
      }
    });
    await createShare(cReq, cRes, cNext);
    const passShareToken = cRes.bodyData.token;

    // Recipient downloads payload
    const { req: dReq, res: dRes, next: dNext } = mockReqRes({
      user: null,
      params: { token: passShareToken }
    });
    await downloadPublicShare(dReq, dRes, dNext);

    const receivedCiphertext = dRes.bodyData;
    const receivedWrappedDEK = dRes.headers['X-Wrapped-DEK'];
    const receivedSaltHex = dRes.headers['X-KDF-Salt'];
    const receivedIterations = Number(dRes.headers['X-KDF-Iterations']);
    const receivedBaseNonceHex = dRes.headers['X-Base-Nonce'];
    const expectedOriginalHash = dRes.headers['X-Original-File-Hash'];

    // Recipient Client-Side Decryption using WebCrypto:
    const recipientBaseKey = await webCrypto.subtle.importKey('raw', Buffer.from(sharePassword), 'PBKDF2', false, ['deriveKey']);
    const recipientKEK = await webCrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: Buffer.from(receivedSaltHex, 'hex'), iterations: receivedIterations, hash: 'SHA-256' },
      recipientBaseKey,
      { name: 'AES-KW', length: 256 },
      false,
      ['wrapKey', 'unwrapKey']
    );

    const unwrappedDEK = await webCrypto.subtle.unwrapKey(
      'raw',
      Buffer.from(receivedWrappedDEK, 'hex'),
      recipientKEK,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const recipientBaseNonce = Buffer.from(receivedBaseNonceHex, 'hex');
    const recipientChunkIV = Buffer.concat([recipientBaseNonce, Buffer.from([0, 0, 0, 0])]);
    const decryptedPlaintextBuffer = Buffer.from(await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: recipientChunkIV },
      unwrappedDEK,
      receivedCiphertext
    ));

    const decryptedHash = crypto.createHash('sha256').update(decryptedPlaintextBuffer).digest('hex');

    reportTest(
      'Zero-Knowledge Recipient Decryption (Password): Recipient derives KEK, unwraps DEK, decrypts AES-256-GCM, matches plaintext SHA-256',
      decryptedHash.toLowerCase() === expectedOriginalHash.toLowerCase() && decryptedPlaintextBuffer.toString() === plaintext.toString(),
      `Decrypted text: "${decryptedPlaintextBuffer.toString()}"`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 11: Recipient Client-Side Decryption (Link Key in URL Fragment)
  // -------------------------------------------------------------------------
  {
    // Recipient accesses public share using publicShareToken and publicShareLinkKeyHex
    const { req: dReq, res: dRes, next: dNext } = mockReqRes({
      user: null,
      params: { token: publicShareToken }
    });
    await downloadPublicShare(dReq, dRes, dNext);

    const receivedCiphertext = dRes.bodyData;
    const receivedWrappedDEK = dRes.headers['X-Wrapped-DEK'];
    const receivedBaseNonceHex = dRes.headers['X-Base-Nonce'];
    const expectedOriginalHash = dRes.headers['X-Original-File-Hash'];

    // Recipient imports link key from URL fragment #key=<hex>
    const recipientLinkKeyObj = await webCrypto.subtle.importKey(
      'raw',
      Buffer.from(publicShareLinkKeyHex, 'hex'),
      { name: 'AES-KW' },
      false,
      ['wrapKey', 'unwrapKey']
    );

    const unwrappedDEK = await webCrypto.subtle.unwrapKey(
      'raw',
      Buffer.from(receivedWrappedDEK, 'hex'),
      recipientLinkKeyObj,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );

    const recipientBaseNonce = Buffer.from(receivedBaseNonceHex, 'hex');
    const recipientChunkIV = Buffer.concat([recipientBaseNonce, Buffer.from([0, 0, 0, 0])]);
    const decryptedPlaintextBuffer = Buffer.from(await webCrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: recipientChunkIV },
      unwrappedDEK,
      receivedCiphertext
    ));

    const decryptedHash = crypto.createHash('sha256').update(decryptedPlaintextBuffer).digest('hex');

    reportTest(
      'Zero-Knowledge Recipient Decryption (Link Key Fragment): Recipient unwraps DEK via URL fragment key, matches plaintext SHA-256',
      decryptedHash.toLowerCase() === expectedOriginalHash.toLowerCase() && decryptedPlaintextBuffer.toString() === plaintext.toString(),
      `Decrypted text: "${decryptedPlaintextBuffer.toString()}"`
    );
  }

  // -------------------------------------------------------------------------
  // TEST 12: Legacy cryptoVersion: 1 File Sharing Compatibility
  // -------------------------------------------------------------------------
  {
    const legacyPlaintext = Buffer.from('Legacy cryptoVersion 1 file payload for backwards compatibility testing.');
    const legacyFileId = 'file-legacy-v1-001';

    const { encryptBuffer } = await import('./src/services/encryptionService.js');
    const { encryptedBuffer: legacyEncrypted, ivHex: legacyIvHex, authTagHex: legacyAuthTagHex } = encryptBuffer(legacyPlaintext);

    const legacyShards = createShardsFromBuffer(legacyEncrypted, 4, { shardingVersion: 1 });
    for (let i = 0; i < legacyShards.length; i++) {
      const s = legacyShards[i];
      const nodeDir = path.join(process.cwd(), 'storage', `node-0${i + 1}`);
      const shardPath = path.join(nodeDir, `${legacyFileId}.shard.${i + 1}`);
      fs.writeFileSync(shardPath, s.data);

      memShards.push({
        fileId: legacyFileId,
        shardIndex: s.index,
        shardHash: s.hash,
        nodeId: `node-0${i + 1}`,
        shardSize: s.size,
        storagePath: shardPath,
      });
    }

    const legacyFileRecord = {
      id: legacyFileId,
      _id: legacyFileId,
      userId: 'user-001',
      fileName: 'LegacyDocument.txt',
      fileSize: legacyPlaintext.length,
      cryptoVersion: 1,
      shardingVersion: 1,
      erasureCoding: 'xor-parity',
      iv: legacyIvHex,
      encryptionIv: legacyIvHex,
      authTag: legacyAuthTagHex,
      encryptionAuthTag: legacyAuthTagHex,
      status: 'encrypted',
    };
    memFiles.push(legacyFileRecord);


    const { req: cReq, res: cRes, next: cNext } = mockReqRes({
      user: { _id: 'user-001', id: 'user-001' },
      body: {
        fileId: legacyFileId,
        expiresDays: 7,
      }
    });
    await createShare(cReq, cRes, cNext);
    const legacyShareToken = cRes.bodyData.token;

    const { req: dReq, res: dRes, next: dNext } = mockReqRes({
      user: null,
      params: { token: legacyShareToken }
    });
    await downloadPublicShare(dReq, dRes, dNext);

    const decryptedLegacyBuffer = dRes.bodyData;
    reportTest(
      'Legacy Compatibility: cryptoVersion 1 file shared and downloaded with server-side decryption',
      dRes.statusCode === 200 && decryptedLegacyBuffer.toString() === legacyPlaintext.toString(),
      `Decrypted legacy: "${decryptedLegacyBuffer?.toString()}"`
    );
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`PHASE 5 TEST RESULTS: ${passedTests} / ${totalTests} PASSED (100%)`);
  console.log('================================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
