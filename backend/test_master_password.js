import assert from 'assert';
import { 
  generateMasterKeyEnvelope, 
  verifyMasterPasswordWithToken, 
  unlockMasterKeyWithPassword, 
  unlockMasterKeyWithRecoveryKey, 
  rotateMasterPassword,
  deriveKEK,
  wrapDEK,
  unwrapDEK,
  hexToBytes,
  bytesToHex,
  encryptFileInChunks,
  decryptFileInChunks
} from '../src/services/cryptoService.ts';

console.log('='.repeat(75));
console.log('🧪 RUNNING MASTER PASSWORD & CRYPTOGRAPHIC KEY WRAPPING TEST SUITE');
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
  }
}

(async () => {
  const masterPassword = 'MasterSecretPass@123';
  let envelope;
  let masterKey;

  // Test 1: Setup Master Password & Generate Envelope
  await test('First-time Master Password setup generates valid cryptographic envelope', async () => {
    envelope = await generateMasterKeyEnvelope(masterPassword);
    assert.ok(envelope.masterPasswordSalt && envelope.masterPasswordSalt.length === 32, 'Salt must be 16 bytes (32 hex chars)');
    assert.ok(envelope.wrappedMasterKey && envelope.wrappedMasterKey.length === 80, 'Wrapped MK must be 40 bytes (80 hex chars)');
    assert.ok(envelope.masterKeyVerifier && envelope.masterKeyVerifier.includes(':'), 'Verifier must be iv:ciphertext format');
    assert.ok(envelope.recoveryKeyFormatted && envelope.recoveryKeyFormatted.includes('-'), 'Recovery key must be formatted with dashes');
    assert.ok(envelope.recoveryKeyHash && envelope.recoveryKeyHash.length === 64, 'Recovery hash must be SHA-256 (64 hex chars)');
    assert.ok(envelope.wrappedMasterKeyWithRecovery && envelope.wrappedMasterKeyWithRecovery.length === 80, 'Wrapped MK with recovery must be 40 bytes');
  });

  // Test 2: Master Password Verification with Token
  await test('Verifies correct master password against verifier token', async () => {
    const isCorrect = await verifyMasterPasswordWithToken(
      masterPassword,
      envelope.masterPasswordSalt,
      envelope.masterKeyVerifier
    );
    assert.strictEqual(isCorrect, true, 'Valid password must be verified');
  });

  // Test 3: Wrong Master Password Fails Verification
  await test('Rejects incorrect master password with token verification', async () => {
    const isCorrect = await verifyMasterPasswordWithToken(
      'WrongPassword123!',
      envelope.masterPasswordSalt,
      envelope.masterKeyVerifier
    );
    assert.strictEqual(isCorrect, false, 'Invalid password must be rejected');
  });

  // Test 4: Master Key Unlock
  await test('Unwraps Master Key successfully with valid master password', async () => {
    masterKey = await unlockMasterKeyWithPassword(
      masterPassword,
      envelope.masterPasswordSalt,
      envelope.wrappedMasterKey
    );
    assert.ok(masterKey, 'Master Key must be unwrapped');
    assert.strictEqual(masterKey.algorithm.name, 'AES-KW', 'Master Key algorithm must be AES-KW');
  });

  // Test 5: Wrong Password Fails Unlock
  await test('Fails to unwrap Master Key with invalid password', async () => {
    let failed = false;
    try {
      await unlockMasterKeyWithPassword(
        'IncorrectPassword456!',
        envelope.masterPasswordSalt,
        envelope.wrappedMasterKey
      );
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true, 'Unwrap with incorrect password must fail');
  });

  // Test 6: Recovery Key Unlock
  await test('Unwraps Master Key successfully using Emergency Recovery Key', async () => {
    const recoveredMK = await unlockMasterKeyWithRecoveryKey(
      envelope.recoveryKeyFormatted,
      envelope.recoverySalt,
      envelope.wrappedMasterKeyWithRecovery
    );
    assert.ok(recoveredMK, 'Recovery key must unwrap Master Key');
    assert.strictEqual(recoveredMK.algorithm.name, 'AES-KW');
  });

  // Test 7: Master Password Rotation with 0 File Re-encryption
  let rotatedEnvelope;
  const newPassword = 'NewMasterPass@2026!';

  await test('Master password rotation preserves master key without touching file ciphertexts', async () => {
    rotatedEnvelope = await rotateMasterPassword(masterKey, newPassword);
    assert.ok(rotatedEnvelope.wrappedMasterKey, 'Must produce new wrapped master key');
    assert.ok(rotatedEnvelope.masterPasswordSalt, 'Must produce fresh KDF salt');
    assert.ok(rotatedEnvelope.masterKeyVerifier, 'Must produce fresh verifier');

    // Verify new password unlocks the rotated envelope
    const newMK = await unlockMasterKeyWithPassword(
      newPassword,
      rotatedEnvelope.masterPasswordSalt,
      rotatedEnvelope.wrappedMasterKey
    );
    assert.ok(newMK, 'New password must unlock master key');

    // Verify old password fails
    let oldFailed = false;
    try {
      await unlockMasterKeyWithPassword(
        masterPassword,
        rotatedEnvelope.masterPasswordSalt,
        rotatedEnvelope.wrappedMasterKey
      );
    } catch {
      oldFailed = true;
    }
    assert.strictEqual(oldFailed, true, 'Old password must fail on rotated envelope');
  });

  // Test 8: Existing File Decryption & Per-File DEK Rewrapping
  await test('Existing file encryption, per-file DEK rewrapping, and decryption work seamlessly', async () => {
    const originalText = 'CONFIDENTIAL_DATA_PROTECTED_BY_SECUREVAULT_MASTER_KEY_2026';
    const originalBlob = new Blob([new TextEncoder().encode(originalText)], { type: 'text/plain' });

    // Encrypt file using current password
    const { ciphertextBlob, metadata } = await encryptFileInChunks(
      originalBlob,
      masterPassword,
      false
    );

    // Decrypt using current password
    const cipherArrayBuffer = await ciphertextBlob.arrayBuffer();
    const decryptedBytes = await decryptFileInChunks(cipherArrayBuffer, metadata, masterPassword);
    const decryptedText = new TextDecoder().decode(decryptedBytes);
    assert.strictEqual(decryptedText, originalText, 'Decrypted text must match original');

    // Rewrap DEK for the file under new password (ZERO ciphertext re-encryption!)
    const fileSalt = hexToBytes(metadata.kdfSalt);
    const oldKek = await deriveKEK(masterPassword, fileSalt, metadata.kdfIterations);
    const dek = await unwrapDEK(hexToBytes(metadata.wrappedDEK), oldKek);

    const newKek = await deriveKEK(newPassword, fileSalt, metadata.kdfIterations);
    const rewrappedDEK = await wrapDEK(dek, newKek);

    // Update metadata with rewrapped DEK
    const updatedMetadata = {
      ...metadata,
      wrappedDEK: bytesToHex(rewrappedDEK)
    };

    // Decrypt original ciphertext using new password and rewrapped DEK
    const decryptedWithNew = await decryptFileInChunks(cipherArrayBuffer, updatedMetadata, newPassword);
    const decryptedWithNewText = new TextDecoder().decode(decryptedWithNew);
    assert.strictEqual(decryptedWithNewText, originalText, 'Decryption with new password and rewrapped DEK must match original');
  });

  console.log('='.repeat(75));
  console.log(`SUMMARY: ${passed}/${total} MASTER PASSWORD TESTS PASSED!`);
  console.log('='.repeat(75));

  if (passed !== total) process.exit(1);
})();
