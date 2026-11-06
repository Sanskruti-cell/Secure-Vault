import mongoose from 'mongoose';

const activityLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.Mixed,
    required: false,
  },
  sequenceNumber: {
    type: Number,
    required: true,
    min: 0,
    index: true,
  },
  previousEntryHash: {
    type: String,
    required: true,
  },
  entryHash: {
    type: String,
    required: true,
    index: true,
  },
  action: {
    type: String,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  fileId: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  metadata: {
    type: Object,
    default: {},
  },
  isAICommand: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);
