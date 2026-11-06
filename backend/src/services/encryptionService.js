import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * [LEGACY COMPATIBILITY MODULE - cryptoVersion: 1]
 * 
 * IMPORTANT:
 * This service implements server-side AES-256-GCM encryption with ENCRYPTION_MASTER_KEY.
 * It is strictly retained for backwards compatibility with legacy cryptoVersion: 1 files.
 * 
 * For all new uploads (cryptoVersion: 2), encryption and key derivation are performed
 * client-side in the browser via src/services/cryptoService.ts. The backend never receives
 * plaintext file data or unencrypted DEKs for cryptoVersion: 2 files.
 */

const ALGORITHM = 'aes-256-gcm';

/**
 * [LEGACY] Derives a 32-byte key from string key or ENCRYPTION_MASTER_KEY
 * @param {string} rawKey 
 * @returns {Buffer}
 */
const getKeyBuffer = (rawKey) => {
  const secret = rawKey || env.masterKey;
  if (!secret) {
    throw new Error('[SECURITY ERROR] Encryption key is missing. Ensure ENCRYPTION_MASTER_KEY is defined in backend/.env for legacy file support.');
  }
  return crypto.createHash('sha256').update(secret).digest();
};

/**
 * [LEGACY] Encrypts buffer using server-side AES-256-GCM
 * @param {Buffer} buffer 
 * @param {string} [customKey]
 * @returns {{ encryptedBuffer: Buffer, ivHex: string, authTagHex: string }}
 */
export const encryptBuffer = (buffer, customKey) => {
  const key = getKeyBuffer(customKey);
  const iv = crypto.randomBytes(12); // 12-byte IV standard for GCM
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encryptedBuffer: encrypted,
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
  };
};

/**
 * Decrypts buffer using AES-256-GCM
 * @param {Buffer} encryptedBuffer 
 * @param {string} ivHex 
 * @param {string} authTagHex 
 * @param {string} [customKey]
 * @returns {Buffer}
 */
export const decryptBuffer = (encryptedBuffer, ivHex, authTagHex, customKey) => {
  const key = getKeyBuffer(customKey);
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
};
