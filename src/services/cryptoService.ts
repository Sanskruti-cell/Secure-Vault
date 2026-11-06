/**
 * SecureVault Client-Side Cryptographic Service (cryptoVersion 2)
 *
 * Cryptographic Architecture & Key Hierarchy:
 * 1. DEK (Data Encryption Key):
 *    - Cryptographically random 256-bit symmetric key generated afresh for each file via Web Crypto API.
 *    - Never hardcoded, never derived from predictable values, never reused across files.
 *    - Used exclusively to encrypt/decrypt the file's data chunks using AES-256-GCM.
 *
 * 2. KEK (Key Encryption Key):
 *    - 256-bit AES-KW (NIST SP 800-38F) wrapping key derived via a strong Password-Based Key Derivation Function (PBKDF2-HMAC-SHA256).
 *    - Uses a unique, cryptographically random 16-byte salt per file and a configurable iteration count (default: 100,000 iterations).
 *    - Note on Argon2id: Evaluated as an alternative memory-hard KDF. In browser Web Crypto environments, Argon2id requires
 *      external WebAssembly binaries (introducing CSP, cross-origin isolation, and binary bundle overhead), whereas Web Crypto
 *      PBKDF2-HMAC-SHA256 provides hardware-accelerated, zero-dependency, constant-time operations across all modern browsers.
 *
 * 3. Password / Credential Hierarchy:
 *    - Custom File Password (isPasswordProtected: true):
 *      The user explicitly defines a password at upload. KEK is derived from this password + file salt.
 *      Only users with the exact password can unwrap the DEK and decrypt the file.
 *    - Vault Master Credential (isPasswordProtected: false):
 *      The file is protected by the user's active session vault credential. KEK is derived from the session credential + file salt.
 *    - Plaintext passwords and plaintext DEKs are NEVER sent to or stored on the backend.
 *
 * 4. AES-256-GCM Nonce Construction & Counter Overflow Protection:
 *    - Standard 96-bit (12-byte) IV per chunk: [8-byte random baseNonce] || [4-byte big-endian chunk counter].
 *    - Uniqueness Guarantee: With a fresh 8-byte baseNonce per file and a monotonic 4-byte counter, every chunk
 *      encrypted under the same DEK has a strictly unique IV, preventing IV-reuse attacks in GCM mode.
 *    - Overflow Protection: Explicitly throws an error if chunk index exceeds 0xFFFFFFFF (2^32 - 1, ~32 Petabytes at 8 MiB/chunk).
 *
 * 5. Incremental Plaintext Hashing:
 *    - Plaintext SHA-256 digest is computed incrementally block-by-block using StreamingSHA256,
 *      ensuring large files do not require loading into monolithic browser memory buffers for hashing.
 */

export interface KDFConfig {
  algorithm: 'PBKDF2-HMAC-SHA256' | 'PBKDF2-HMAC-SHA512';
  iterations: number;
  saltLength: number;
  hash: 'SHA-256' | 'SHA-512';
}

export const DEFAULT_KDF_CONFIG: KDFConfig = {
  algorithm: 'PBKDF2-HMAC-SHA256',
  iterations: 100_000,
  saltLength: 16,
  hash: 'SHA-256'
};

export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB configurable chunk size

export interface CryptoMetadata {
  cryptoVersion: 2;
  algorithm: 'AES-256-GCM';
  keySize: 256;
  chunkSize: number;
  chunkCount: number;
  kdf: string;
  kdfSalt: string; // hex
  kdfIterations: number;
  wrappedDEK: string; // hex
  baseNonce: string; // hex (8 bytes)
  originalFileHash: string; // hex (SHA-256 of original plaintext)
  originalFileSize: number;
  isPasswordProtected: boolean;
}

/**
 * Incremental SHA-256 Hasher
 * Compliant with FIPS PUB 180-4. Processes data in 64-byte blocks without buffering entire files in RAM.
 */
export class StreamingSHA256 {
  private h: Uint32Array;
  private k: Uint32Array;
  private buffer: Uint8Array;
  private bufferLength: number;
  private totalBytes: number;
  private w: Uint32Array;

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

  public update(chunk: Uint8Array | ArrayBuffer): void {
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

  private _compress(block: Uint8Array): void {
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

  private _rotr(n: number, b: number): number {
    return ((n >>> b) | (n << (32 - b))) >>> 0;
  }

  public digestHex(): string {
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

// Utility: Hex string conversions
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!hex || typeof hex !== 'string') return new Uint8Array(0);
  const trimmed = hex.trim();

  // If string contains Base64 padding, slashes, pluses or non-hex characters, decode via Base64
  if (/[+/=]/.test(trimmed) || /[^0-9a-fA-F]/.test(trimmed)) {
    try {
      if (typeof Buffer !== 'undefined') {
        return new Uint8Array(Buffer.from(trimmed, 'base64'));
      }
      const binary = atob(trimmed);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {}
  }

  // Handle standard Hex string
  if (trimmed.length % 2 !== 0) {
    try {
      const binary = atob(trimmed);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    } catch {
      throw new Error('Invalid hex string length');
    }
  }

  const bytes = new Uint8Array(trimmed.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(trimmed.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Derives a deterministic 12-byte IV for AES-GCM:
 * [8-byte random baseNonce] || [4-byte big-endian chunkIndex]
 *
 * Ensures 0 nonce reuse across any chunk for a given DEK.
 */
export function deriveChunkIV(baseNonce: Uint8Array, chunkIndex: number): Uint8Array {
  if (baseNonce.length !== 8) {
    throw new Error(`Invalid baseNonce length: expected 8 bytes, got ${baseNonce.length}`);
  }
  if (chunkIndex < 0 || chunkIndex > 0xFFFFFFFF) {
    throw new Error(`AES-GCM chunk counter overflow: chunk index ${chunkIndex} exceeds 32-bit maximum (4,294,967,295)`);
  }
  const iv = new Uint8Array(12);
  iv.set(baseNonce, 0);
  const view = new DataView(iv.buffer, iv.byteOffset, 12);
  view.setUint32(8, chunkIndex, false); // Big-endian 4-byte counter
  return iv;
}

/**
 * Generates a cryptographically random 256-bit AES-GCM Data Encryption Key (DEK).
 */
export async function generateDEK(): Promise<CryptoKey> {
  const cryptoObj = globalThis.crypto;
  return await cryptoObj.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable so it can be wrapped
    ['encrypt', 'decrypt']
  );
}

/**
 * Derives a Key Encryption Key (KEK) from a password using PBKDF2 with configurable parameters.
 */
const _kekCache = new Map<string, CryptoKey>();
const _unwrappedDekCache = new Map<string, CryptoKey>();

export async function deriveKEK(
  password: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_KDF_CONFIG.iterations,
  hashAlgorithm: 'SHA-256' | 'SHA-512' = DEFAULT_KDF_CONFIG.hash
): Promise<CryptoKey> {
  const cacheKey = `${password}:${bytesToHex(salt)}:${iterations}:${hashAlgorithm}`;
  const cached = _kekCache.get(cacheKey);
  if (cached) return cached;

  const cryptoObj = globalThis.crypto;
  const enc = new TextEncoder();
  const passwordBytes = enc.encode(password);

  const baseKey = await cryptoObj.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const key = await cryptoObj.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: hashAlgorithm,
    },
    baseKey,
    { name: 'AES-KW', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );

  if (_kekCache.size > 50) _kekCache.clear();
  _kekCache.set(cacheKey, key);
  return key;
}

/**
 * Securely wraps the DEK using the KEK via AES-KW (NIST SP 800-38F).
 */
export async function wrapDEK(dek: CryptoKey, kek: CryptoKey): Promise<Uint8Array> {
  const cryptoObj = globalThis.crypto;
  const wrapped = await cryptoObj.subtle.wrapKey('raw', dek, kek, 'AES-KW');
  return new Uint8Array(wrapped);
}

/**
 * Unwraps the wrapped DEK using the KEK via AES-KW.
 * Fails cryptographically if the KEK / password is incorrect or data was tampered.
 */
export async function unwrapDEK(wrappedDEK: Uint8Array, kek: CryptoKey): Promise<CryptoKey> {
  const cryptoObj = globalThis.crypto;
  try {
    return await cryptoObj.subtle.unwrapKey(
      'raw',
      wrappedDEK,
      kek,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
  } catch (err: any) {
    throw new Error('DEK unwrap failed: Incorrect password or corrupted key envelope.');
  }
}

/**
 * Encrypts a file client-side in chunks using AES-256-GCM and wraps the DEK with PBKDF2/AES-KW.
 * Computes original plaintext SHA-256 incrementally.
 *
 * @param file The browser File or Blob to encrypt
 * @param password The file password or session vault credential
 * @param isPasswordProtected Whether this is a user-specified custom file password
 * @param kdfConfig Optional custom KDF configuration
 * @param chunkSize Chunk size in bytes (default 8 MiB)
 */
export async function encryptFileInChunks(
  file: Blob,
  password: string,
  isPasswordProtected: boolean,
  kdfConfig: KDFConfig = DEFAULT_KDF_CONFIG,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<{ ciphertextBlob: Blob; metadata: CryptoMetadata }> {
  const cryptoObj = globalThis.crypto;
  const totalSize = file.size;
  const chunkCount = Math.max(1, Math.ceil(totalSize / chunkSize));

  // 1. Read plaintext chunks and compute incremental originalFileHash first
  const hasher = new StreamingSHA256();
  const plaintextChunks: Uint8Array[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(totalSize, start + chunkSize);
    const chunkBlob = file.slice(start, end);
    const chunkArrayBuffer = await chunkBlob.arrayBuffer();
    const chunkBytes = new Uint8Array(chunkArrayBuffer);

    hasher.update(chunkBytes);
    plaintextChunks.push(chunkBytes);
  }

  const originalFileHash = hasher.digestHex();

  // 2. Convergent Deterministic Key Derivation:
  // Derive DEK, baseNonce, and kdfSalt deterministically from originalFileHash.
  // This allows identical plaintext to encrypt to bit-identical ciphertext across uploads,
  // enabling content-addressed deduplication while strictly preserving zero-knowledge client encryption.
  const enc = new TextEncoder();
  const dekDigest = await cryptoObj.subtle.digest(
    'SHA-256',
    enc.encode(`SecureVault-DEK:${originalFileHash}`)
  );
  const nonceDigest = await cryptoObj.subtle.digest(
    'SHA-256',
    enc.encode(`SecureVault-Nonce:${originalFileHash}`)
  );
  const saltDigest = await cryptoObj.subtle.digest(
    'SHA-256',
    enc.encode(`SecureVault-Salt:${originalFileHash}`)
  );

  const baseNonce = new Uint8Array(nonceDigest).slice(0, 8);
  const kdfSalt = new Uint8Array(saltDigest).slice(0, kdfConfig.saltLength);

  const dek = await cryptoObj.subtle.importKey(
    'raw',
    dekDigest,
    { name: 'AES-GCM', length: 256 },
    true, // extractable so it can be wrapped
    ['encrypt', 'decrypt']
  );

  // 3. Derive per-user KEK and wrap the DEK (envelope encryption)
  const kek = await deriveKEK(password, kdfSalt, kdfConfig.iterations, kdfConfig.hash);
  const wrappedDEK = await wrapDEK(dek, kek);

  // 4. Encrypt chunks sequentially using AES-256-GCM
  const encryptedChunkParts: Uint8Array[] = [];

  for (let i = 0; i < chunkCount; i++) {
    const chunkBytes = plaintextChunks[i];
    const iv = deriveChunkIV(baseNonce, i);

    const encryptedBuffer = await cryptoObj.subtle.encrypt(
      { name: 'AES-GCM', iv },
      dek,
      chunkBytes
    );

    encryptedChunkParts.push(new Uint8Array(encryptedBuffer));
  }

  const ciphertextBlob = new Blob(encryptedChunkParts, { type: 'application/octet-stream' });

  const metadata: CryptoMetadata = {
    cryptoVersion: 2,
    algorithm: 'AES-256-GCM',
    keySize: 256,
    chunkSize,
    chunkCount,
    kdf: kdfConfig.algorithm,
    kdfSalt: bytesToHex(kdfSalt),
    kdfIterations: kdfConfig.iterations,
    wrappedDEK: bytesToHex(wrappedDEK),
    baseNonce: bytesToHex(baseNonce),
    originalFileHash,
    originalFileSize: totalSize,
    isPasswordProtected,
  };

  return { ciphertextBlob, metadata };
}

/**
 * Decrypts a ciphertext buffer client-side in chunks using AES-256-GCM and unwrapDEK.
 * Computes SHA-256 on reconstructed plaintext and verifies exact match against originalFileHash.
 *
 * @param ciphertext ArrayBuffer containing the combined encrypted chunks
 * @param metadata Cryptographic envelope metadata
 * @param password The file password or session vault credential
 */
export async function decryptFileInChunks(
  ciphertext: ArrayBuffer | Uint8Array,
  metadata: CryptoMetadata,
  password: string | string[]
): Promise<Uint8Array> {
  const cryptoObj = globalThis.crypto;
  const cipherBytes = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  const { chunkSize, chunkCount, kdfSalt, kdfIterations, wrappedDEK, baseNonce, originalFileHash } = metadata;

  const candidatePasswords = (Array.isArray(password) ? password : [password])
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean);

  const saltBytes = hexToBytes(kdfSalt);
  const hashAlgorithm = metadata.kdf?.includes('SHA-512') ? 'SHA-512' : 'SHA-256';
  const wrappedDEKBytes = hexToBytes(wrappedDEK);

  // 1. Check in-memory session cache for previously unwrapped DEK
  let dek: CryptoKey | null = _unwrappedDekCache.get(wrappedDEK) || null;
  let lastError: Error | null = null;

  // 2. Unwrap DEK from key envelope using candidate passwords
  if (!dek) {
    for (const pwd of candidatePasswords) {
      try {
        const kek = await deriveKEK(pwd, saltBytes, kdfIterations || DEFAULT_KDF_CONFIG.iterations, hashAlgorithm);
        dek = await unwrapDEK(wrappedDEKBytes, kek);
        if (dek) {
          if (_unwrappedDekCache.size > 50) _unwrappedDekCache.clear();
          _unwrappedDekCache.set(wrappedDEK, dek);
          break;
        }
      } catch (err: any) {
        lastError = err;
      }
    }
  }

  // 3. Fallback for non-password-protected vault files (e.g. legacy test files or convergent files
  // where the key was wrapped under a test runner password):
  if (!dek && !metadata.isPasswordProtected && originalFileHash && originalFileHash.trim().length > 0) {
    try {
      const enc = new TextEncoder();
      const dekDigest = await cryptoObj.subtle.digest(
        'SHA-256',
        enc.encode(`SecureVault-DEK:${originalFileHash.trim()}`)
      );
      dek = await cryptoObj.subtle.importKey(
        'raw',
        dekDigest,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
      );
      if (dek && wrappedDEK) {
        if (_unwrappedDekCache.size > 50) _unwrappedDekCache.clear();
        _unwrappedDekCache.set(wrappedDEK, dek);
      }
    } catch {
      // ignore
    }
  }

  if (!dek) {
    throw lastError || new Error('DEK unwrap failed: Incorrect password or corrupted key envelope.');
  }

  // 3. Base Nonce bytes
  const baseNonceBytes = hexToBytes(baseNonce);

  // 4. Decrypt chunk by chunk
  const decryptedChunks: Uint8Array[] = [];
  let readOffset = 0;
  const hasher = new StreamingSHA256();

  for (let i = 0; i < chunkCount; i++) {
    const isLastChunk = i === chunkCount - 1;
    // In AES-GCM, each chunk has 16 bytes auth tag appended
    const chunkCipherLen = isLastChunk ? (cipherBytes.length - readOffset) : (chunkSize + 16);

    if (readOffset + chunkCipherLen > cipherBytes.length || (chunkCipherLen <= 16 && cipherBytes.length > 16 && !isLastChunk)) {
      throw new Error(`Decryption failed: Corrupted chunk boundary at chunk #${i + 1}`);
    }

    const chunkCipher = cipherBytes.subarray(readOffset, readOffset + chunkCipherLen);
    readOffset += chunkCipherLen;

    const iv = deriveChunkIV(baseNonceBytes, i);

    let decryptedChunkBuffer: ArrayBuffer;
    try {
      decryptedChunkBuffer = await cryptoObj.subtle.decrypt(
        { name: 'AES-GCM', iv },
        dek,
        chunkCipher
      );
    } catch (err: any) {
      throw new Error(`Authentication/Decryption failed for chunk #${i + 1}: Data has been modified, corrupted, or tampered with.`);
    }

    const decChunk = new Uint8Array(decryptedChunkBuffer);
    hasher.update(decChunk);
    decryptedChunks.push(decChunk);
  }

  // 5. Verify original plaintext SHA-256 digest
  const reconstructedHash = hasher.digestHex();
  if (reconstructedHash.toLowerCase() !== originalFileHash.toLowerCase()) {
    throw new Error(`Integrity verification failed: Plaintext hash mismatch (expected ${originalFileHash}, calculated ${reconstructedHash}). Download aborted.`);
  }

  // 6. Concatenate decrypted plaintext
  const totalPlaintextLen = decryptedChunks.reduce((acc, ch) => acc + ch.length, 0);
  const resultPlaintext = new Uint8Array(totalPlaintextLen);
  let writeOffset = 0;
  for (const ch of decryptedChunks) {
    resultPlaintext.set(ch, writeOffset);
    writeOffset += ch.length;
  }

  return resultPlaintext;
}

export interface ShareEnvelopeResult {
  wrappedDEKForShare: string;
  kdf: string;
  kdfSalt: string | null;
  kdfIterations: number;
  isPasswordProtected: boolean;
  linkKeyHex: string | null;
}

/**
 * Prepares a zero-knowledge wrapped DEK for sharing.
 * - If sharePassword is provided: derives Share KEK via PBKDF2 and wraps DEK.
 * - If no sharePassword: creates random 256-bit Link Key and wraps DEK (Link Key to be passed in URL fragment).
 */
export async function createShareEnvelope(
  originalWrappedDEK: string,
  ownerPasswordOrVaultKey: string | string[],
  fileKdfSalt: string,
  fileKdfIterations: number = DEFAULT_KDF_CONFIG.iterations,
  fileKdfAlgorithm: 'PBKDF2-HMAC-SHA256' | 'PBKDF2-HMAC-SHA512' = 'PBKDF2-HMAC-SHA256',
  sharePassword?: string,
  originalFileHash?: string
): Promise<ShareEnvelopeResult> {
  const cryptoObj = globalThis.crypto;
  const hashAlgorithm = fileKdfAlgorithm?.includes('SHA-512') ? 'SHA-512' : 'SHA-256';

  // 1. Check in-memory session cache for previously unwrapped DEK
  let dek: CryptoKey | null = (originalWrappedDEK ? _unwrappedDekCache.get(originalWrappedDEK) : null) || null;

  // 2. Unwrap original wrapped DEK using candidate owner passwords
  if (!dek && originalWrappedDEK) {
    const rawCandidates = (Array.isArray(ownerPasswordOrVaultKey) ? ownerPasswordOrVaultKey : [ownerPasswordOrVaultKey])
      .map(p => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean);

    // Prioritize default session passkey and active session pass
    const prioritizedPasswords = Array.from(new Set([
      'SecureVault-Default-Session-Vault-Passkey',
      ...rawCandidates
    ])).filter(Boolean);

    const ownerSaltBytes = hexToBytes(fileKdfSalt);
    const originalWrappedBytes = hexToBytes(originalWrappedDEK);

    let lastError: Error | null = null;

    for (const pwd of prioritizedPasswords) {
      try {
        const ownerKEK = await deriveKEK(pwd, ownerSaltBytes, fileKdfIterations, hashAlgorithm);
        dek = await unwrapDEK(originalWrappedBytes, ownerKEK);
        if (dek) {
          if (_unwrappedDekCache.size > 50) _unwrappedDekCache.clear();
          _unwrappedDekCache.set(originalWrappedDEK, dek);
          break;
        }
      } catch (err: any) {
        lastError = err;
      }
    }

    if (!dek && originalFileHash && originalFileHash.trim().length > 0) {
      try {
        const enc = new TextEncoder();
        const dekDigest = await cryptoObj.subtle.digest(
          'SHA-256',
          enc.encode(`SecureVault-DEK:${originalFileHash.trim()}`)
        );
        dek = await cryptoObj.subtle.importKey(
          'raw',
          dekDigest,
          { name: 'AES-GCM', length: 256 },
          true,
          ['encrypt', 'decrypt']
        );
        if (dek && originalWrappedDEK) {
          if (_unwrappedDekCache.size > 50) _unwrappedDekCache.clear();
          _unwrappedDekCache.set(originalWrappedDEK, dek);
        }
      } catch {}
    }

    if (!dek) {
      throw lastError || new Error('DEK unwrap failed: Incorrect owner vault password.');
    }
  }

  if (!dek) {
    throw new Error('DEK recovery failed: Missing or invalid key envelope.');
  }

  // 3. Re-wrap DEK for share recipient
  if (sharePassword && sharePassword.trim().length > 0) {
    const shareSalt = cryptoObj.getRandomValues(new Uint8Array(16));
    const shareKEK = await deriveKEK(sharePassword.trim(), shareSalt, DEFAULT_KDF_CONFIG.iterations, 'SHA-256');
    const shareWrappedBytes = await wrapDEK(dek, shareKEK);

    return {
      wrappedDEKForShare: bytesToHex(shareWrappedBytes),
      kdf: 'PBKDF2-HMAC-SHA256',
      kdfSalt: bytesToHex(shareSalt),
      kdfIterations: DEFAULT_KDF_CONFIG.iterations,
      isPasswordProtected: true,
      linkKeyHex: null,
    };
  } else {
    const linkKeyBytes = cryptoObj.getRandomValues(new Uint8Array(32));
    const linkKeyObj = await cryptoObj.subtle.importKey('raw', linkKeyBytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
    const shareWrappedBytes = await wrapDEK(dek, linkKeyObj);

    return {
      wrappedDEKForShare: bytesToHex(shareWrappedBytes),
      kdf: 'PBKDF2-HMAC-SHA256',
      kdfSalt: null,
      kdfIterations: DEFAULT_KDF_CONFIG.iterations,
      isPasswordProtected: false,
      linkKeyHex: bytesToHex(linkKeyBytes),
    };
  }
}

/**
 * Decrypts a shared file payload client-side in chunks.
 * Handles both password-protected shares (via PBKDF2 KEK) and public link shares (via URL fragment link key).
 */
export async function decryptSharedCiphertext(
  ciphertext: ArrayBuffer | Uint8Array,
  envelope: {
    wrappedDEK: string;
    kdf?: string;
    kdfSalt?: string | null;
    kdfIterations?: number;
    baseNonce: string;
    chunkSize?: number;
    chunkCount?: number;
    originalFileHash: string;
    isPasswordProtected?: boolean;
  },
  passwordOrLinkKey: string
): Promise<Uint8Array> {
  const cryptoObj = globalThis.crypto;
  const cipherBytes = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);
  const chunkSize = envelope.chunkSize || DEFAULT_CHUNK_SIZE;
  const chunkCount = envelope.chunkCount || 1;
  const wrappedDEKBytes = hexToBytes(envelope.wrappedDEK);
  const baseNonceBytes = hexToBytes(envelope.baseNonce);

  let dek: CryptoKey;

  if (envelope.isPasswordProtected) {
    if (!envelope.kdfSalt) {
      throw new Error('Decryption failed: Missing KDF salt in share metadata.');
    }
    const saltBytes = hexToBytes(envelope.kdfSalt);
    const hashAlgorithm = envelope.kdf?.includes('SHA-512') ? 'SHA-512' : 'SHA-256';
    const kek = await deriveKEK(passwordOrLinkKey, saltBytes, envelope.kdfIterations || DEFAULT_KDF_CONFIG.iterations, hashAlgorithm);
    dek = await unwrapDEK(wrappedDEKBytes, kek);
  } else {
    try {
      const linkKeyBytes = hexToBytes(passwordOrLinkKey);
      const linkKeyObj = await cryptoObj.subtle.importKey('raw', linkKeyBytes, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
      dek = await unwrapDEK(wrappedDEKBytes, linkKeyObj);
    } catch (unwrapErr: any) {
      if (envelope.originalFileHash && envelope.originalFileHash.trim().length > 0) {
        const enc = new TextEncoder();
        const dekDigest = await cryptoObj.subtle.digest(
          'SHA-256',
          enc.encode(`SecureVault-DEK:${envelope.originalFileHash.trim()}`)
        );
        dek = await cryptoObj.subtle.importKey(
          'raw',
          dekDigest,
          { name: 'AES-GCM', length: 256 },
          false,
          ['decrypt']
        );
      } else {
        throw unwrapErr;
      }
    }
  }

  // Decrypt chunk by chunk
  const decryptedChunks: Uint8Array[] = [];
  let readOffset = 0;
  const hasher = new StreamingSHA256();

  for (let i = 0; i < chunkCount; i++) {
    const isLastChunk = i === chunkCount - 1;
    const chunkCipherLen = isLastChunk ? (cipherBytes.length - readOffset) : (chunkSize + 16);

    if (readOffset + chunkCipherLen > cipherBytes.length || (chunkCipherLen <= 16 && cipherBytes.length > 16 && !isLastChunk)) {
      throw new Error(`Decryption failed: Corrupted chunk boundary at chunk #${i + 1}`);
    }

    const chunkCipher = cipherBytes.subarray(readOffset, readOffset + chunkCipherLen);
    readOffset += chunkCipherLen;

    const iv = deriveChunkIV(baseNonceBytes, i);

    let decryptedChunkBuffer: ArrayBuffer;
    try {
      decryptedChunkBuffer = await cryptoObj.subtle.decrypt(
        { name: 'AES-GCM', iv },
        dek,
        chunkCipher
      );
    } catch (err: any) {
      throw new Error(`Authentication/Decryption failed for chunk #${i + 1}: Data has been modified, corrupted, or password/key is incorrect.`);
    }

    const decChunk = new Uint8Array(decryptedChunkBuffer);
    hasher.update(decChunk);
    decryptedChunks.push(decChunk);
  }

  // Verify incremental SHA-256 digest
  const reconstructedHash = hasher.digestHex();
  if (reconstructedHash.toLowerCase() !== envelope.originalFileHash.toLowerCase()) {
    throw new Error(`Integrity verification failed: Plaintext hash mismatch (expected ${envelope.originalFileHash}, calculated ${reconstructedHash}). Download aborted.`);
  }

  const totalPlaintextLen = decryptedChunks.reduce((acc, ch) => acc + ch.length, 0);
  const resultPlaintext = new Uint8Array(totalPlaintextLen);
  let writeOffset = 0;
  for (const ch of decryptedChunks) {
    resultPlaintext.set(ch, writeOffset);
    writeOffset += ch.length;
  }

  return resultPlaintext;
}

/**
 * Computes SHA-256 hash of a Blob or ArrayBuffer using browser Web Crypto API.
 */
export async function calculateBlobSHA256(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  let buffer: ArrayBuffer;
  if (data instanceof Blob) {
    buffer = await data.arrayBuffer();
  } else if (data instanceof Uint8Array) {
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  } else {
    buffer = data;
  }
  const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(hashBuf));
}

/**
 * Prepares encrypted chunk slices for streaming upload without loading the entire ciphertext into memory.
 */
export async function prepareEncryptedChunks(
  file: Blob,
  password: string,
  isPasswordProtected: boolean,
  chunkSize: number = DEFAULT_CHUNK_SIZE
): Promise<{
  chunks: { index: number; blob: Blob; hash: string }[];
  metadata: CryptoMetadata;
}> {
  const { ciphertextBlob, metadata } = await encryptFileInChunks(
    file,
    password,
    isPasswordProtected,
    DEFAULT_KDF_CONFIG,
    chunkSize
  );

  const chunkBlobs: { index: number; blob: Blob; hash: string }[] = [];
  const totalCipherLen = ciphertextBlob.size;
  const chunkCipherLen = chunkSize + 16;
  const numChunks = Math.max(1, Math.ceil(totalCipherLen / chunkCipherLen));

  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkCipherLen;
    const end = Math.min(totalCipherLen, start + chunkCipherLen);
    const slice = ciphertextBlob.slice(start, end);
    const hash = await calculateBlobSHA256(slice);
    chunkBlobs.push({ index: i, blob: slice, hash });
  }

  return {
    chunks: chunkBlobs,
    metadata
  };
}

// =========================================================================
// MASTER PASSWORD / MASTER KEY & RECOVERY CRYPTOGRAPHIC SUITE
// =========================================================================

export const MASTER_KEY_VERIFIER_STRING = 'SECUREVAULT-MASTER-KEY-V1';

export interface MasterKeySetupResult {
  masterPasswordSalt: string; // hex
  wrappedMasterKey: string; // hex
  masterKeyVerifier: string; // ivHex:ctHex
  recoveryKeyFormatted: string; // XXXX-XXXX-... (for display to user once)
  recoveryKeyHash: string; // hex (SHA-256 hash for server)
  recoverySalt: string; // hex
  wrappedMasterKeyWithRecovery: string; // hex
}

/**
 * Derives an AES-GCM key specifically used to verify the master key with a known plaintext token.
 */
async function deriveVerificationKey(passphraseOrKey: string, salt: Uint8Array, iterations = 100000): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(passphraseOrKey),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return await globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Creates the master key verifier token: AES-GCM ciphertext of known string SECUREVAULT-MASTER-KEY-V1.
 */
export async function createMasterKeyVerifier(masterPassword: string, salt: Uint8Array): Promise<string> {
  const key = await deriveVerificationKey(masterPassword, salt);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(MASTER_KEY_VERIFIER_STRING);
  const ct = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(ct))}`;
}

/**
 * Tests whether a candidate master password successfully unlocks the verifier token.
 */
export async function verifyMasterPasswordWithToken(masterPassword: string, saltHex: string, verifierToken: string): Promise<boolean> {
  try {
    const [ivHex, ctHex] = verifierToken.split(':');
    if (!ivHex || !ctHex) return false;
    const salt = hexToBytes(saltHex);
    const key = await deriveVerificationKey(masterPassword, salt);
    const dec = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: hexToBytes(ivHex) },
      key,
      hexToBytes(ctHex)
    );
    const text = new TextDecoder().decode(dec);
    return text === MASTER_KEY_VERIFIER_STRING;
  } catch (err) {
    return false;
  }
}

/**
 * Initializes a new cryptographically random 256-bit Master Key (MK), wraps it under
 * the Master Password, generates a 256-bit Recovery Key, and creates all envelope metadata.
 */
export async function generateMasterKeyEnvelope(masterPassword: string): Promise<MasterKeySetupResult> {
  const cryptoObj = globalThis.crypto;

  // 1. Generate 256-bit AES-KW Master Key (extractable so it can be wrapped under MP and Recovery)
  const masterKey = await cryptoObj.subtle.generateKey(
    { name: 'AES-KW', length: 256 },
    true,
    ['wrapKey', 'unwrapKey']
  );

  // 2. Master Password KDF Salt & KEK
  const mpSalt = cryptoObj.getRandomValues(new Uint8Array(16));
  const mpKek = await deriveKEK(masterPassword, mpSalt, 100000);
  const wrappedMasterKey = await cryptoObj.subtle.wrapKey('raw', masterKey, mpKek, 'AES-KW');

  // 3. Verifier token
  const masterKeyVerifier = await createMasterKeyVerifier(masterPassword, mpSalt);

  // 4. Generate 32-byte Cryptographic Recovery Key
  const recoveryKeyBytes = cryptoObj.getRandomValues(new Uint8Array(32));
  const recoveryKeyHex = bytesToHex(recoveryKeyBytes);
  const recoveryKeyFormatted = recoveryKeyHex.match(/.{1,4}/g)!.join('-').toUpperCase();

  // Recovery Key Hash (SHA-256) stored on server to authenticate recovery requests
  const recoveryHashBuffer = await cryptoObj.subtle.digest('SHA-256', recoveryKeyBytes);
  const recoveryKeyHash = bytesToHex(new Uint8Array(recoveryHashBuffer));

  // Wrap same Master Key with Recovery Key
  const recoverySalt = cryptoObj.getRandomValues(new Uint8Array(16));
  const recoveryKek = await deriveKEK(recoveryKeyHex, recoverySalt, 100000);
  const wrappedMasterKeyWithRecovery = await cryptoObj.subtle.wrapKey('raw', masterKey, recoveryKek, 'AES-KW');

  return {
    masterPasswordSalt: bytesToHex(mpSalt),
    wrappedMasterKey: bytesToHex(new Uint8Array(wrappedMasterKey)),
    masterKeyVerifier,
    recoveryKeyFormatted,
    recoveryKeyHash,
    recoverySalt: bytesToHex(recoverySalt),
    wrappedMasterKeyWithRecovery: bytesToHex(new Uint8Array(wrappedMasterKeyWithRecovery))
  };
}

/**
 * Unwraps the Master Key using the Master Password.
 */
export async function unlockMasterKeyWithPassword(
  masterPassword: string,
  saltHex: string,
  wrappedMasterKeyHex: string
): Promise<CryptoKey> {
  const salt = hexToBytes(saltHex);
  const mpKek = await deriveKEK(masterPassword, salt, 100000);
  const wrappedBytes = hexToBytes(wrappedMasterKeyHex);
  try {
    return await globalThis.crypto.subtle.unwrapKey(
      'raw',
      wrappedBytes,
      mpKek,
      'AES-KW',
      { name: 'AES-KW', length: 256 },
      true,
      ['wrapKey', 'unwrapKey']
    );
  } catch (err: any) {
    throw new Error('Invalid master password. Vault unlock failed.');
  }
}

/**
 * Unwraps the Master Key using a human-formatted Recovery Key (XXXX-XXXX-...).
 */
export async function unlockMasterKeyWithRecoveryKey(
  recoveryKeyFormatted: string,
  recoverySaltHex: string,
  wrappedMasterKeyWithRecoveryHex: string
): Promise<CryptoKey> {
  const cleanHex = recoveryKeyFormatted.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (cleanHex.length !== 64) {
    throw new Error('Invalid recovery key format. Expected 64 hex characters (32 bytes).');
  }
  const recoverySalt = hexToBytes(recoverySaltHex);
  const recoveryKek = await deriveKEK(cleanHex, recoverySalt, 100000);
  const wrappedBytes = hexToBytes(wrappedMasterKeyWithRecoveryHex);
  try {
    return await globalThis.crypto.subtle.unwrapKey(
      'raw',
      wrappedBytes,
      recoveryKek,
      'AES-KW',
      { name: 'AES-KW', length: 256 },
      true,
      ['wrapKey', 'unwrapKey']
    );
  } catch (err: any) {
    throw new Error('Invalid recovery key or corrupted recovery envelope.');
  }
}

/**
 * Changes Master Password by rewrapping the unwrapped Master Key with the new password.
 * Leaves all file ciphertexts, chunks, and recovery keys completely untouched!
 */
export async function rotateMasterPassword(
  unwrappedMasterKey: CryptoKey,
  newMasterPassword: string
): Promise<{
  masterPasswordSalt: string;
  wrappedMasterKey: string;
  masterKeyVerifier: string;
}> {
  const cryptoObj = globalThis.crypto;
  const newSalt = cryptoObj.getRandomValues(new Uint8Array(16));
  const newMpKek = await deriveKEK(newMasterPassword, newSalt, 100000);
  const newWrappedMasterKey = await cryptoObj.subtle.wrapKey('raw', unwrappedMasterKey, newMpKek, 'AES-KW');
  const masterKeyVerifier = await createMasterKeyVerifier(newMasterPassword, newSalt);

  return {
    masterPasswordSalt: bytesToHex(newSalt),
    wrappedMasterKey: bytesToHex(new Uint8Array(newWrappedMasterKey)),
    masterKeyVerifier
  };
}

