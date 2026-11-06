import crypto from 'crypto';

/**
 * Calculates SHA-256 hash of a Buffer or string
 * @param {Buffer|string} data 
 * @returns {string} Hex encoded SHA-256 hash
 */
export const calculateSHA256 = (data) => {
  return crypto.createHash('sha256').update(data).digest('hex');
};

/**
 * Verifies if data matches expected SHA-256 hash
 * @param {Buffer|string} data 
 * @param {string} expectedHash 
 * @returns {boolean}
 */
export const verifySHA256 = (data, expectedHash) => {
  const actualHash = calculateSHA256(data);
  return actualHash.toLowerCase() === expectedHash.toLowerCase();
};

export const generateFileHash = calculateSHA256;
