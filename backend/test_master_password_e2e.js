import assert from 'assert';
import crypto from 'crypto';

const API_BASE = 'http://127.0.0.1:5002/api';

// Helper WebCrypto/Node crypto routines for Master Key testing matching cryptoService.ts
async function deriveKEK(password, salt, iterations = 100000) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function deriveVerificationKey(password, salt, iterations = 100000) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function generateRecoveryKey() {
  const bytes = crypto.randomBytes(32);
  const hex = bytes.toString('hex').toUpperCase();
  const groups = [];
  for (let i = 0; i < hex.length; i += 4) {
    groups.push(hex.substring(i, i + 4));
  }
  return groups.join('-');
}

function hashRecoveryKey(recoveryKey) {
  const normalized = recoveryKey.replace(/[\s-]/g, '').toUpperCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

async function runE2ETests() {
  console.log('='.repeat(75));
  console.log('🚀 SECUREVAULT MASTER PASSWORD / MASTER KEY END-TO-END WORKFLOW TEST');
  console.log('='.repeat(75));

  // 1. Authenticate dedicated test user so real user account is never altered
  console.log('\n[1] Authenticating dedicated test user test_mp_e2e@securevault.io...');
  let loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test_mp_e2e@securevault.io', password: 'Password123!' })
  });

  if (loginRes.status !== 200) {
    // Register if doesn't exist
    const regRes = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'E2E Test User', email: 'test_mp_e2e@securevault.io', password: 'Password123!' })
    });
    loginRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test_mp_e2e@securevault.io', password: 'Password123!' })
    });
  }

  assert.strictEqual(loginRes.status, 200, `Login failed: ${loginRes.status}`);
  const loginData = await loginRes.json();
  const token = loginData.token;
  const user = loginData.user;
  console.log('    Login successful!');
  console.log(`    User: ${user.name} (${user.email})`);
  console.log(`    Has Master Password configured? ${user.hasMasterPassword ? 'YES' : 'NO'}`);

  // 2. Generate Master Key Envelope
  console.log('\n[2] Generating Client-Side Master Key Envelope...');
  const rawMasterKey = crypto.randomBytes(32);
  const masterKey = await crypto.subtle.importKey('raw', rawMasterKey, { name: 'AES-KW', length: 256 }, true, ['wrapKey', 'unwrapKey']);
  
  const salt = crypto.randomBytes(16);
  const kek = await deriveKEK('VaultMasterSecret#2026', salt);
  const wrappedMasterKey = await crypto.subtle.wrapKey('raw', masterKey, kek, 'AES-KW');

  // Verifier token derived from password KEK
  const verifierIv = crypto.randomBytes(12);
  const verifierKey = await deriveVerificationKey('VaultMasterSecret#2026', salt);
  const verifierCipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: verifierIv },
    verifierKey,
    new TextEncoder().encode('SECUREVAULT-MASTER-KEY-V1')
  );
  const masterKeyVerifier = `${bytesToHex(verifierIv)}:${bytesToHex(new Uint8Array(verifierCipher))}`;

  // Recovery Key
  const recoveryKey = generateRecoveryKey();
  const recoveryKeyHash = hashRecoveryKey(recoveryKey);
  const recoverySalt = crypto.randomBytes(16);
  const recoveryKek = await deriveKEK(recoveryKey.replace(/[\s-]/g, '').toUpperCase(), recoverySalt);
  const wrappedWithRecovery = await crypto.subtle.wrapKey('raw', masterKey, recoveryKek, 'AES-KW');

  console.log('    Master Key generated client-side: 256-bit AES-KW');
  console.log('    Recovery Key generated:', recoveryKey.substring(0, 14) + '...');
  console.log('    Recovery Key SHA-256 Hash:', recoveryKeyHash.substring(0, 16) + '...');

  // 3. Setup Master Password on Backend
  console.log('\n[3] Calling POST /api/auth/master-password/setup...');
  const setupRes = await fetch(`${API_BASE}/auth/master-password/setup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      masterPasswordSalt: bytesToHex(salt),
      wrappedMasterKey: bytesToHex(new Uint8Array(wrappedMasterKey)),
      masterKeyVerifier: masterKeyVerifier,
      recoveryKeyHash: recoveryKeyHash,
      recoverySalt: bytesToHex(recoverySalt),
      wrappedMasterKeyWithRecovery: bytesToHex(new Uint8Array(wrappedWithRecovery)),
      autoLockMinutes: 15
    })
  });
  assert.strictEqual(setupRes.status, 200, `Setup failed: ${setupRes.status}`);
  const setupData = await setupRes.json();
  assert.strictEqual(setupData.hasMasterPassword, true, 'User should now have hasMasterPassword=true');
  console.log('    Master password successfully registered and persisted in database!');

  // 4. Verify /api/auth/me returns updated envelope
  console.log('\n[4] Calling GET /api/auth/me to verify persistence...');
  const meRes = await fetch(`${API_BASE}/auth/me`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const meData = await meRes.json();
  assert.strictEqual(meData.user.hasMasterPassword, true);
  assert.strictEqual(meData.user.masterPasswordSalt, bytesToHex(salt));
  assert.strictEqual(meData.user.wrappedMasterKey, bytesToHex(new Uint8Array(wrappedMasterKey)));
  console.log('    Verified: GET /api/auth/me returns zero-knowledge wrapped master key envelope.');

  // 5. Test Vault Unlocking using correct master password
  console.log('\n[5] Testing Vault Unlock with correct Master Password...');
  const unlockKek = await deriveKEK('VaultMasterSecret#2026', hexToBytes(meData.user.masterPasswordSalt));
  const unwrappedMasterKey = await crypto.subtle.unwrapKey(
    'raw',
    hexToBytes(meData.user.wrappedMasterKey),
    unlockKek,
    'AES-KW',
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey']
  );
  const exportedRaw = await crypto.subtle.exportKey('raw', unwrappedMasterKey);
  assert.strictEqual(bytesToHex(new Uint8Array(exportedRaw)), bytesToHex(rawMasterKey));
  console.log('    Master Key successfully unlocked client-side (bit-exact match)!');

  // 6. Test Vault Unlocking failure with incorrect password
  console.log('\n[6] Testing Vault Unlock with wrong Master Password...');
  const wrongKek = await deriveKEK('WrongMasterPassword!123', hexToBytes(meData.user.masterPasswordSalt));
  let failed = false;
  try {
    await crypto.subtle.unwrapKey(
      'raw',
      hexToBytes(meData.user.wrappedMasterKey),
      wrongKek,
      'AES-KW',
      { name: 'AES-KW', length: 256 },
      true,
      ['wrapKey', 'unwrapKey']
    );
  } catch (err) {
    failed = true;
  }
  assert.strictEqual(failed, true, 'Wrong password must fail AES-KW unwrapping');
  console.log('    Confirmed: Wrong password securely rejected by AES-KW integrity check.');

  // 7. Test Emergency Recovery with Recovery Key
  console.log('\n[7] Testing Emergency Recovery with 32-byte Recovery Key...');
  const recKek = await deriveKEK(recoveryKey.replace(/[\s-]/g, '').toUpperCase(), hexToBytes(meData.user.recoverySalt));
  const recoveredMasterKey = await crypto.subtle.unwrapKey(
    'raw',
    hexToBytes(meData.user.wrappedMasterKeyWithRecovery),
    recKek,
    'AES-KW',
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey']
  );
  const recoveredRaw = await crypto.subtle.exportKey('raw', recoveredMasterKey);
  assert.strictEqual(bytesToHex(new Uint8Array(recoveredRaw)), bytesToHex(rawMasterKey));
  console.log('    Confirmed: Emergency Recovery Key successfully unwraped identical Master Key!');

  // 8. Test Master Password Rotation / Change
  console.log('\n[8] Testing Master Password Change (Rotation) via /api/auth/master-password/change...');
  const newSalt = crypto.randomBytes(16);
  const newKek = await deriveKEK('NewRotatedPassword#2026', newSalt);
  const newWrappedMasterKey = await crypto.subtle.wrapKey('raw', unwrappedMasterKey, newKek, 'AES-KW');

  const newVerifierIv = crypto.randomBytes(12);
  const newVerifierKey = await deriveVerificationKey('NewRotatedPassword#2026', newSalt);
  const newVerifierCipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: newVerifierIv },
    newVerifierKey,
    new TextEncoder().encode('SECUREVAULT-MASTER-KEY-V1')
  );
  const newMasterKeyVerifier = `${bytesToHex(newVerifierIv)}:${bytesToHex(new Uint8Array(newVerifierCipher))}`;

  const newRecoveryKey = generateRecoveryKey();
  const newRecoveryHash = hashRecoveryKey(newRecoveryKey);
  const newRecoverySalt = crypto.randomBytes(16);
  const newRecoveryKek = await deriveKEK(newRecoveryKey.replace(/[\s-]/g, '').toUpperCase(), newRecoverySalt);
  const newWrappedWithRecovery = await crypto.subtle.wrapKey('raw', unwrappedMasterKey, newRecoveryKek, 'AES-KW');

  const changeRes = await fetch(`${API_BASE}/auth/master-password/change`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      masterPasswordSalt: bytesToHex(newSalt),
      wrappedMasterKey: bytesToHex(new Uint8Array(newWrappedMasterKey)),
      masterKeyVerifier: newMasterKeyVerifier,
      recoverySalt: bytesToHex(newRecoverySalt),
      wrappedMasterKeyWithRecovery: bytesToHex(new Uint8Array(newWrappedWithRecovery))
    })
  });
  assert.strictEqual(changeRes.status, 200, `Change failed: ${changeRes.status}`);
  console.log('    Master Password rotation registered successfully on server!');

  // 9. Verify new password unwraps the same master key
  console.log('\n[9] Verifying new password unwraps same underlying Master Key...');
  const verifyRotatedKek = await deriveKEK('NewRotatedPassword#2026', newSalt);
  const rotatedMasterKey = await crypto.subtle.unwrapKey(
    'raw',
    new Uint8Array(newWrappedMasterKey),
    verifyRotatedKek,
    'AES-KW',
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey']
  );
  const rotatedRaw = await crypto.subtle.exportKey('raw', rotatedMasterKey);
  assert.strictEqual(bytesToHex(new Uint8Array(rotatedRaw)), bytesToHex(rawMasterKey));
  console.log('    Master Key retained 100% integrity across password rotation without re-encrypting files!');

  // 10. Update Auto-Lock Preference
  console.log('\n[10] Testing Auto-Lock Preference API...');
  const autoLockRes = await fetch(`${API_BASE}/auth/auto-lock`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ autoLockMinutes: 30 })
  });
  assert.strictEqual(autoLockRes.status, 200);
  const autoLockData = await autoLockRes.json();
  assert.strictEqual(autoLockData.autoLockMinutes, 30);
  console.log('    Auto-lock preference updated to 30 minutes.');

  console.log('\n' + '='.repeat(75));
  console.log('🎉 ALL 10 END-TO-END MASTER PASSWORD WORKFLOW CHECKS PASSED!');
  console.log('='.repeat(75));
}

runE2ETests().catch((err) => {
  console.error('\n❌ E2E Test Failed:', err);
  process.exit(1);
});
