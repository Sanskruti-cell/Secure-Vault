import crypto from 'crypto';

/**
 * Generates a secure random share token
 * @returns {string}
 */
export const generateShareToken = () => {
  return crypto.randomBytes(16).toString('hex');
};

/**
 * Computes expiration date from current time
 * @param {number} expiryHours 
 * @returns {Date}
 */
export const calculateExpiryDate = (expiryHours = 24) => {
  return new Date(Date.now() + expiryHours * 3600 * 1000);
};
