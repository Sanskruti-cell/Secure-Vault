import assert from 'assert';
import crypto from 'crypto';

const API_BASE = 'http://127.0.0.1:5002/api';

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

async function testFileDecryption() {
  console.log('='.repeat(75));
  console.log('🧪 TESTING LIVE FILE DECRYPTION WITH MASTER KEY & LEGACY COMPATIBILITY');
  console.log('='.repeat(75));

  // 1. Login
  const loginRes = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'asatisanskruti@gmail.com', password: 'Sanskruti@123' })
  });
  const { token, user } = await loginRes.json();
  console.log(`[1] Logged in user: ${user.name}`);

  // 2. Fetch files
  const filesRes = await fetch(`${API_BASE}/files`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const files = await filesRes.json();
  const fileList = Array.isArray(files) ? files : files.files;
  console.log(`[2] Retrieved ${fileList.length} files from vault.`);
  assert.ok(fileList.length > 0, 'Should find at least 1 file');

  const targetFile = fileList.find(f => f.fileName && f.fileName.includes('AICTE')) || fileList[0];
  console.log(`[3] Target file: ${targetFile.fileName} (ID: ${targetFile._id || targetFile.id})`);
  console.log(`    Wrapped DEK: ${targetFile.wrappedDEK ? targetFile.wrappedDEK.substring(0, 16) + '...' : 'none'}`);
  console.log(`    KDF Salt: ${targetFile.kdfSalt}`);
  console.log(`    Crypto Version: ${targetFile.cryptoVersion || 1}`);

  // 3. Download reconstructed ciphertext from backend
  const dlRes = await fetch(`${API_BASE}/files/${targetFile._id || targetFile.id}/download`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  assert.strictEqual(dlRes.status, 200, `Download failed: ${dlRes.status}`);
  const ciphertextBuffer = await dlRes.arrayBuffer();
  console.log(`[4] Successfully downloaded ciphertext: ${ciphertextBuffer.byteLength} bytes`);

  // 4. Unwrap DEK using user's vault passkey (Sanskruti@123)
  console.log('[5] Unwrapping DEK using User Vault Passkey (Sanskruti@123)...');
  const salt = hexToBytes(targetFile.kdfSalt);
  let unwrappedDEK = null;

  for (const candidatePass of ['Sanskruti@123', 'SecureVault-Default-Session-Vault-Passkey']) {
    try {
      const kek = await deriveKEK(candidatePass, salt, targetFile.kdfIterations || 100000);
      const wrappedDEKBytes = hexToBytes(targetFile.wrappedDEK);
      unwrappedDEK = await crypto.subtle.unwrapKey(
        'raw',
        wrappedDEKBytes,
        kek,
        'AES-KW',
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
      );
      if (unwrappedDEK) {
        console.log(`    Successfully unwrapped DEK with passkey: "${candidatePass}"!`);
        break;
      }
    } catch (e) {
      // try next
    }
  }
  assert.ok(unwrappedDEK, 'DEK must unwrap successfully');

  // 5. Decrypt file payload with unwrapped DEK
  console.log('[6] Decrypting file payload with unwrapped DEK...');
  const cipherBytes = new Uint8Array(ciphertextBuffer);

  // Derive IV using baseNonce from file metadata (8 bytes) + 4 bytes big endian counter (0 for chunk 0)
  const baseNonce = hexToBytes(targetFile.baseNonce);
  const iv = new Uint8Array(12);
  iv.set(baseNonce, 0);
  const view = new DataView(iv.buffer, iv.byteOffset, iv.byteLength);
  view.setUint32(8, 0, false);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    unwrappedDEK,
    cipherBytes
  );
  console.log(`    Successfully decrypted plaintext: ${decrypted.byteLength} bytes!`);
  const magic = new TextDecoder().decode(new Uint8Array(decrypted, 0, 4));
  console.log(`    Plaintext Magic Header: ${magic}`);
  assert.strictEqual(magic, '%PDF', 'File must be valid decrypted PDF (%PDF magic)');
  console.log('    100% BIT-EXACT PDF HEADER VERIFIED (%PDF)!');

  console.log('\n' + '='.repeat(75));
  console.log('🎉 LIVE FILE DECRYPTION WITH KEY UNWRAPPING PASSED WITH 100% SUCCESS!');
  console.log('='.repeat(75));
}

testFileDecryption().catch(err => {
  console.error('\n❌ Decryption Test Failed:', err);
  process.exit(1);
});
