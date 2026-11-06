import mongoose from 'mongoose';

const storedChunkSchema = new mongoose.Schema({
  chunkHash: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  chunkSize: {
    type: Number,
    required: true,
  },
  refCount: {
    type: Number,
    default: 1,
    min: 0,
  },
  fileIds: [{
    type: String,
    required: true,
  }],
  // Array of 6 shard IDs or shard descriptors associated with this ciphertext chunk
  shards: [{
    shardIndex: Number,
    shardHash: String,
    nodeId: String,
    storagePath: String,
    shardSize: Number,
    provider: { type: String, default: 'local' },
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastAccessedAt: {
    type: Date,
    default: Date.now,
  },
});

storedChunkSchema.index({ fileIds: 1 });

export const StoredChunk = mongoose.model('StoredChunk', storedChunkSchema);
