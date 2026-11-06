import mongoose from 'mongoose';

const fileShardSchema = new mongoose.Schema({
  fileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    required: true,
  },
  shardIndex: {
    type: Number,
    required: true,
    min: 1,
    max: 6,
  },
  chunkHash: {
    type: String,
    default: null,
    index: true,
  },
  nodeId: {
    type: String,
    required: true,
  },
  provider: {
    type: String,
    enum: ['local', 'aws-s3', 'gcp-gcs', 'azure-blob'],
    default: 'local',
  },
  bucket: {
    type: String,
    default: null,
  },
  objectKey: {
    type: String,
    default: null,
  },
  shardHash: {
    type: String,
    required: true,
  },
  shardSize: {
    type: Number,
    required: true,
  },
  storagePath: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['active', 'degraded', 'corrupted', 'deleted'],
    default: 'active',
  },
  shardType: {
    type: String,
    enum: ['data', 'parity'],
    default: 'data',
  },
  lastVerifiedAt: {
    type: Date,
    default: Date.now,
  },
  verificationHistory: [{
    verifiedAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['passed', 'checksum_mismatch', 'missing'] },
    computedHash: String,
  }],
  repairHistory: [{
    repairedAt: { type: Date, default: Date.now },
    survivingShardsUsed: [Number],
    targetNodeId: String,
    previousHash: String,
    newHash: String,
  }],
});

// Performance indexes — compound index covers both "by file" and "by file+index" queries
fileShardSchema.index({ fileId: 1, shardIndex: 1 });
fileShardSchema.index({ fileId: 1 });
fileShardSchema.index({ nodeId: 1, status: 1 });
fileShardSchema.index({ storagePath: 1 });
fileShardSchema.index({ chunkHash: 1, shardIndex: 1 });

export const FileShard = mongoose.model('FileShard', fileShardSchema);

