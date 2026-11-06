import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: {
    type: String,
    required: true,
  },
  hasMasterPassword: {
    type: Boolean,
    default: false,
  },
  masterPasswordSalt: {
    type: String,
    default: null,
  },
  wrappedMasterKey: {
    type: String,
    default: null,
  },
  masterKeyVerifier: {
    type: String,
    default: null,
  },
  recoveryKeyHash: {
    type: String,
    default: null,
  },
  recoverySalt: {
    type: String,
    default: null,
  },
  wrappedMasterKeyWithRecovery: {
    type: String,
    default: null,
  },
  autoLockMinutes: {
    type: Number,
    default: 15,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export const User = mongoose.model('User', userSchema);
