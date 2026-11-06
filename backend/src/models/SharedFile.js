import mongoose from 'mongoose';

const sharedFileSchema = new mongoose.Schema({
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    required: true,
    index: true,
  },
  creatorUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  token: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  recipient: {
    type: String,
    default: 'public-link',
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true,
  },
  downloadLimit: {
    type: Number,
    default: 10,
  },
  downloadCount: {
    type: Number,
    default: 0,
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'revoked'],
    default: 'active',
    index: true,
  },
  isPasswordProtected: {
    type: Boolean,
    default: false,
  },
  // Zero-Knowledge Client-Side Envelope for Share Recipient
  // Backend stores ONLY the wrapped DEK (wrapped with Share KEK or Link Key)
  // Backend NEVER receives or stores plaintext share passwords or plaintext DEKs
  wrappedDEKForShare: {
    type: String,
    default: null,
  },
  kdf: {
    type: String,
    default: 'PBKDF2-HMAC-SHA256',
  },
  kdfSalt: {
    type: String,
    default: null,
  },
  kdfIterations: {
    type: Number,
    default: 100000,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

sharedFileSchema.index({ token: 1, status: 1 });
sharedFileSchema.index({ creatorUserId: 1, createdAt: -1 });

export const SharedFile = mongoose.model('SharedFile', sharedFileSchema);

