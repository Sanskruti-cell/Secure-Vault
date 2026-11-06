import mongoose from 'mongoose';

const storageNodeSchema = new mongoose.Schema({
  nodeId: {
    type: String,
    required: true,
    unique: true,
  },
  id: {
    type: String,
  },
  name: {
    type: String,
    required: true,
  },
  region: {
    type: String,
    default: 'Global',
  },
  status: {
    type: String,
    default: 'online',
  },
  isSimulatedFailure: {
    type: Boolean,
    default: false,
  },
  provider: {
    type: String,
    enum: ['local', 'aws-s3', 'gcp-gcs', 'azure-blob'],
    default: 'local',
  },
  providerType: {
    type: String,
    enum: ['local', 'emulator', 'cloud'],
    default: 'emulator',
  },
  emulatorBucket: {
    type: String,
    default: null,
  },
  storageUsed: {
    type: Number,
    default: 0,
  },
  storageAvailable: {
    type: Number,
    default: 1000,
  },
  storageTotal: {
    type: Number,
    default: 1000,
  },
  latency: {
    type: Number,
    default: 25,
  },
  shardsStored: {
    type: Number,
    default: 0,
  },
  uptime: {
    type: Number,
    default: 99,
  },
  healthScore: {
    type: Number,
    default: 99,
  },
  lastChecked: {
    type: Date,
    default: Date.now,
  },
  totalOperations: {
    type: Number,
    default: 0,
  },
  successfulOperations: {
    type: Number,
    default: 0,
  },
  failedOperations: {
    type: Number,
    default: 0,
  },
  recentFailures: {
    type: Number,
    default: 0,
  },
  avgLatencyMs: {
    type: Number,
    default: null,
  },
  lastOperationalCheck: {
    type: Date,
    default: null,
  },
});

export const StorageNode = mongoose.model('StorageNode', storageNodeSchema);
