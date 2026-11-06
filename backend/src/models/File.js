import mongoose from 'mongoose';

const fileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  fileName: {
    type: String,
    required: true,
  },
  fileSize: {
    type: Number,
    required: true,
  },
  mimeType: {
    type: String,
    default: 'application/octet-stream',
  },
  fileHash: {
    type: String,
    required: true,
  },
  ciphertextHash: {
    type: String,
    default: null,
  },
  ciphertextSize: {
    type: Number,
    default: null,
  },
  cryptoVersion: {
    type: Number,
    default: 1,
  },
  encryptionAlgorithm: {
    type: String,
    default: 'AES-256-GCM',
  },
  encryptionIv: {
    type: String,
    default: null,
  },
  encryptionAuthTag: {
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
  wrappedDEK: {
    type: String,
    default: null,
  },
  baseNonce: {
    type: String,
    default: null,
  },
  chunkSize: {
    type: Number,
    default: 8388608,
  },
  chunkCount: {
    type: Number,
    default: 1,
  },
  originalFileHash: {
    type: String,
    default: null,
  },
  originalFileSize: {
    type: Number,
    default: null,
  },
  isPasswordProtected: {
    type: Boolean,
    default: false,
  },
  isDeduplicated: {
    type: Boolean,
    default: false,
  },
  deduplicationRatio: {
    type: Number,
    default: 1.0,
  },
  shardingVersion: {
    type: Number,
    default: 1,
  },
  erasureCoding: {
    type: String,
    default: 'reed-solomon',
  },
  dataShards: {
    type: Number,
    default: 4,
  },
  parityShards: {
    type: Number,
    default: 2,
  },
  totalShards: {
    type: Number,
    default: 6,
  },
  shardCount: {
    type: Number,
    default: 6,
  },
  securityScore: {
    type: Number,
    default: 99,
  },
  category: {
    type: String,
    default: 'security',
  },
  status: {
    type: String,
    enum: ['active', 'encrypted', 'deleted'],
    default: 'active',
  },
  passwordHash: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Performance indexes
fileSchema.index({ userId: 1, createdAt: -1 });
fileSchema.index({ userId: 1, fileHash: 1 });
fileSchema.index({ fileHash: 1 });
fileSchema.index({ ciphertextHash: 1 });

export const File = mongoose.model('File', fileSchema);
