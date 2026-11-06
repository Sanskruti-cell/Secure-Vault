import rateLimit from 'express-rate-limit';

/**
 * Strict limiter for authentication endpoints (prevents brute-force password guessing)
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 authentication requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many authentication attempts from this IP. Please try again after 15 minutes.'
  },
  statusCode: 429
});

/**
 * Upload limiter (protects against storage flooding / DoS)
 */
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60, // Limit each IP to 60 upload requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Upload rate limit exceeded. Please wait a few moments before uploading more files.'
  },
  statusCode: 429
});

/**
 * General API limiter for sensitive public routes
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests from this IP. Please slow down.'
  },
  statusCode: 429
});
