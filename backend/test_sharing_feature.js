import assert from 'assert';
import crypto from 'crypto';
import { 
  deriveKEK, 
  unwrapDEK, 
  wrapDEK, 
  hexToBytes, 
  bytesToHex, 
  createShareEnvelope,
  decryptSharedCiphertext
} from '../src/services/cryptoService.ts';
import { loadStoredFiles, loadStoredShards, loadStoredShares, saveStoredShares } from './src/services/storeService.js';
import { createShare, getSharedLinks, getPublicShareInfo, downloadPublicShare, deleteShare, memoryShares } from './src/controllers/shareController.js';
import { readNodeShard } from './src/services/nodeService.js';
import { reconstructBufferFromShards } from './src/services/shardingService.js';

console.log('='.repeat(75));
console.log('🧪 VERIFYING SECUREVAULT ZERO-KNOWLEDGE FILE SHARING PIPELINE');
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

// Helper to simulate express req/res
function mockReqRes(params = {}, body = {}, user = null) {
  const req = {
    params,
    body,
    user: user || { _id: '6a939bf1e8d60eee7b1e11bf', id: '6a939bf1e8d60eee7b1e11bf', email: 'asatisanskruti@gmail.com' }
  };
  let statusCode = 200;
  let headers = {};
  let sentData = null;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader(key, value) {
      headers[key.toLowerCase()] = value;
      return this;
    },
    getHeader(key) {
      return headers[key.toLowerCase()];
    },
    json(data) {
      sentData = data;
      return this;
    },
    send(data) {
      sentData = data;
      return this;
    },
    get statusCode() { return statusCode; },
    get sentData() { return sentData; },
    get headers() { return headers; }
  };

  return { req, res };
}

(async () => {
  const masterPassword = 'Sanskruti@123';
  const files = loadStoredFiles();
  const shards = loadStoredShards();

  // Pick an actual stored file (e.g., Sanskruti_Asati_Resume_Final.pdf or aicte_bon_prom_ren.pdf)
  const targetFile = files.find(f => f.id === '6ae1b89181aea58599bed71d') || files[0];
  assert.ok(targetFile, 'Target vault file must exist in stored files');

  console.log(`Using target file: "${targetFile.name}" (ID: ${targetFile.id}, Size: ${targetFile.size} B)`);

  let publicShareToken = null;
  let publicLinkKey = null;
  let passwordShareToken = null;
  const testSharePassphrase = 'ShareSecret@2026';

  // ---------------------------------------------------------------------------
  // Test 1: Generate Public Zero-Knowledge Share Link (URL Fragment Key)
  // ---------------------------------------------------------------------------
  await test('Generate public Zero-Knowledge share link with client-side derived link key', async () => {
    // 1. Client derives zero-knowledge envelope
    const envelope = await createShareEnvelope(
      targetFile.wrappedDEK,
      [masterPassword, '12345678', 'SecureVault-Default-Session-Vault-Passkey'],
      targetFile.kdfSalt,
      targetFile.kdfIterations || 100000,
      targetFile.kdf || 'PBKDF2-HMAC-SHA256'
    );

    assert.ok(envelope.wrappedDEKForShare, 'Must produce wrappedDEKForShare');
    assert.strictEqual(envelope.isPasswordProtected, false, 'Public link is not password protected');
    assert.ok(envelope.linkKeyHex, 'Must produce a 256-bit linkKeyHex');
    publicLinkKey = envelope.linkKeyHex;

    // 2. Call backend createShare
    const { req, res } = mockReqRes({}, {
      fileId: targetFile.id,
      expiresDays: 7,
      downloadLimit: 5,
      isPasswordProtected: false,
      wrappedDEKForShare: envelope.wrappedDEKForShare,
      kdf: envelope.kdf,
      kdfSalt: envelope.kdfSalt,
      kdfIterations: envelope.kdfIterations
    });

    await createShare(req, res, (err) => { throw err; });

    assert.strictEqual(res.statusCode, 201, 'Must return HTTP 201 Created');
    assert.ok(res.sentData.share, 'Must return created share object');
    assert.ok(res.sentData.share.token, 'Must contain cryptographically secure token');
    assert.strictEqual(res.sentData.share.status, 'active');
    assert.strictEqual(res.sentData.share.downloadLimit, 5);

    publicShareToken = res.sentData.share.token;

    // Verify persisted in shares_store.json
    const persistedShares = loadStoredShares();
    const found = persistedShares.find(s => s.token === publicShareToken);
    assert.ok(found, 'Share link must be persisted in shares_store.json');
  });

  // ---------------------------------------------------------------------------
  // Test 2: Recipient Fetches Public Metadata (Unauthenticated)
  // ---------------------------------------------------------------------------
  await test('Recipient retrieves public share metadata without authentication', async () => {
    assert.ok(publicShareToken, 'publicShareToken must be set');
    const { req, res } = mockReqRes({ token: publicShareToken });
    req.user = null; // Unauthenticated public request

    await getPublicShareInfo(req, res, (err) => { throw err; });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.sentData.fileName, targetFile.name);
    assert.strictEqual(res.sentData.status, 'active');
    assert.strictEqual(res.sentData.isPasswordProtected, false);
    assert.ok(res.sentData.wrappedDEKForShare, 'Must include wrappedDEKForShare for client decryption');
  });

  // ---------------------------------------------------------------------------
  // Test 3: Recipient Downloads & Decrypts via Public Share Link Key
  // ---------------------------------------------------------------------------
  await test('Recipient reconstructs shards and decrypts plaintext via URL fragment key', async () => {
    const { req, res } = mockReqRes({ token: publicShareToken });
    req.user = null; // Unauthenticated public download

    await downloadPublicShare(req, res, (err) => { throw err; });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.sentData, 'Must return reconstructed ciphertext buffer');
    assert.strictEqual(res.headers['x-crypto-version'], '2');
    assert.ok(res.headers['x-wrapped-dek'], 'Must include X-Wrapped-DEK header');
    assert.ok(res.headers['x-base-nonce'], 'Must include X-Base-Nonce header');

    // Client-side decryption simulation using the fragment key
    const envelope = {
      wrappedDEK: res.headers['x-wrapped-dek'],
      kdf: res.headers['x-kdf'],
      kdfSalt: res.headers['x-kdf-salt'],
      kdfIterations: Number(res.headers['x-kdf-iterations']),
      baseNonce: res.headers['x-base-nonce'],
      chunkSize: Number(res.headers['x-chunk-size']),
      chunkCount: Number(res.headers['x-chunk-count']),
      originalFileHash: res.headers['x-original-file-hash'],
      isPasswordProtected: res.headers['x-is-password-protected'] === 'true'
    };

    const decryptedBytes = await decryptSharedCiphertext(res.sentData, envelope, publicLinkKey);
    assert.ok(decryptedBytes && decryptedBytes.length > 0, 'Decrypted bytes must not be empty');
    assert.strictEqual(decryptedBytes.length, targetFile.size, 'Decrypted byte size must match original file size');
  });

  // ---------------------------------------------------------------------------
  // Test 4: Generate Passphrase-Protected Share Link & Verify Protection
  // ---------------------------------------------------------------------------
  await test('Passphrase-protected share link requires correct passphrase to decrypt', async () => {
    // 1. Create passphrase-protected share envelope
    const envelope = await createShareEnvelope(
      targetFile.wrappedDEK,
      [masterPassword, '12345678', 'SecureVault-Default-Session-Vault-Passkey'],
      targetFile.kdfSalt,
      targetFile.kdfIterations || 100000,
      targetFile.kdf || 'PBKDF2-HMAC-SHA256',
      testSharePassphrase
    );

    assert.strictEqual(envelope.isPasswordProtected, true);
    assert.strictEqual(envelope.linkKeyHex, null);
    assert.ok(envelope.kdfSalt, 'Passphrase protection must generate fresh salt');

    // 2. Register share in backend
    const { req, res } = mockReqRes({}, {
      fileId: targetFile.id,
      expiresDays: 3,
      downloadLimit: 2,
      isPasswordProtected: true,
      wrappedDEKForShare: envelope.wrappedDEKForShare,
      kdf: envelope.kdf,
      kdfSalt: envelope.kdfSalt,
      kdfIterations: envelope.kdfIterations
    });

    await createShare(req, res, (err) => { throw err; });
    assert.strictEqual(res.statusCode, 201);
    passwordShareToken = res.sentData.share.token;

    // 3. Recipient downloads ciphertext
    const dl = mockReqRes({ token: passwordShareToken });
    dl.req.user = null;
    await downloadPublicShare(dl.req, dl.res, (err) => { throw err; });
    assert.strictEqual(dl.res.statusCode, 200);

    const shareEnv = {
      wrappedDEK: dl.res.headers['x-wrapped-dek'],
      kdf: dl.res.headers['x-kdf'],
      kdfSalt: dl.res.headers['x-kdf-salt'],
      kdfIterations: Number(dl.res.headers['x-kdf-iterations']),
      baseNonce: dl.res.headers['x-base-nonce'],
      chunkSize: Number(dl.res.headers['x-chunk-size']),
      chunkCount: Number(dl.res.headers['x-chunk-count']),
      originalFileHash: dl.res.headers['x-original-file-hash'],
      isPasswordProtected: true
    };

    // 4. Attempt with WRONG passphrase -> must fail
    let failed = false;
    try {
      await decryptSharedCiphertext(dl.res.sentData, shareEnv, 'WrongPassphrase!999');
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true, 'Incorrect passphrase must be rejected client-side');

    // 5. Attempt with CORRECT passphrase -> succeeds
    const decrypted = await decryptSharedCiphertext(dl.res.sentData, shareEnv, testSharePassphrase);
    assert.strictEqual(decrypted.length, targetFile.size);
  });

  // ---------------------------------------------------------------------------
  // Test 5: Verify Active Share Links List for Creator
  // ---------------------------------------------------------------------------
  await test('Creator can list active share links from backend', async () => {
    const { req, res } = mockReqRes();
    await getSharedLinks(req, res, (err) => { throw err; });

    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.sentData));
    const publicShare = res.sentData.find(s => s.token === publicShareToken);
    assert.ok(publicShare, 'Must find created public share in listing');
    assert.strictEqual(publicShare.status, 'active');
  });

  // ---------------------------------------------------------------------------
  // Test 6: Verify Expiration and Rejection
  // ---------------------------------------------------------------------------
  await test('Expired share links are rejected with HTTP 410', async () => {
    // Force publicShare to be expired in memory & disk
    const targetShare = memoryShares.find(s => s.token === publicShareToken);
    assert.ok(targetShare);
    targetShare.expiresAt = new Date(Date.now() - 10000).toISOString(); // 10s in the past
    saveStoredShares(memoryShares);

    const { req, res } = mockReqRes({ token: publicShareToken });
    req.user = null;
    await getPublicShareInfo(req, res, (err) => { throw err; });

    assert.strictEqual(res.statusCode, 410, 'Must return 410 Gone for expired share info');

    // Try download as well
    const dl = mockReqRes({ token: publicShareToken });
    dl.req.user = null;
    await downloadPublicShare(dl.req, dl.res, (err) => { throw err; });
    assert.strictEqual(dl.res.statusCode, 410, 'Must return 410 Gone for expired share download');
  });

  // ---------------------------------------------------------------------------
  // Test 7: Verify Revocation
  // ---------------------------------------------------------------------------
  await test('Revoked share links are immediately blocked with HTTP 410', async () => {
    // Revoke the passwordShareToken
    const { req, res } = mockReqRes({ id: passwordShareToken });
    await deleteShare(req, res, (err) => { throw err; });

    assert.strictEqual(res.statusCode, 200, 'Revoke must return HTTP 200');

    // Now try to fetch it as recipient
    const recipientReq = mockReqRes({ token: passwordShareToken });
    recipientReq.req.user = null;
    await getPublicShareInfo(recipientReq.req, recipientReq.res, (err) => { throw err; });

    assert.strictEqual(recipientReq.res.statusCode, 410, 'Must reject revoked link with 410');
    assert.strictEqual(recipientReq.res.sentData.error, 'This share link has been revoked by the owner.');
  });

  console.log('='.repeat(75));
  console.log(`SUMMARY: ${passed}/${total} SHARING TESTS PASSED!`);
  console.log('='.repeat(75));

  if (passed !== total) {
    process.exit(1);
  }
})();
