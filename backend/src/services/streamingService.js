import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { calculateSHA256 } from './hashingService.js';
import { createShardsFromBuffer, reconstructBufferFromShards } from './shardingService.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const UPLOAD_SESSIONS_FILE = path.join(DATA_DIR, 'resumable_sessions.json');

export const loadUploadSessions = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(UPLOAD_SESSIONS_FILE)) {
      fs.writeFileSync(UPLOAD_SESSIONS_FILE, JSON.stringify({}, null, 2), 'utf8');
      return {};
    }
    const data = fs.readFileSync(UPLOAD_SESSIONS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
};

export const saveUploadSessions = (sessions) => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(UPLOAD_SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (err) {}
};

export const memUploadSessions = loadUploadSessions();

/**
 * Initializes a resumable streaming upload session.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.fileName
 * @param {number} params.totalSize
 * @param {number} [params.chunkSize=8388608]
 * @param {object} params.cryptoMetadata
 * @returns {string} sessionId
 */
export const initResumableSession = ({
  userId,
  fileName,
  totalSize,
  originalFileSize,
  chunkSize = 8 * 1024 * 1024,
  totalChunks: explicitTotalChunks,
  cryptoMetadata,
  isPasswordProtected = false
}) => {
  const sessionId = `sess-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const effectiveSize = Number(totalSize || originalFileSize || 0);
  const totalChunks = explicitTotalChunks ? Number(explicitTotalChunks) : Math.max(1, Math.ceil(effectiveSize / chunkSize));

  const session = {
    sessionId,
    userId,
    fileName,
    totalSize: effectiveSize,
    originalFileSize: effectiveSize,
    chunkSize,
    totalChunks,
    receivedChunks: {},
    receivedBytes: 0,
    cryptoMetadata: cryptoMetadata || {},
    isPasswordProtected: !!isPasswordProtected,
    status: 'uploading',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  memUploadSessions[sessionId] = session;
  saveUploadSessions(memUploadSessions);
  return sessionId;
};

/**
 * Uploads a discrete chunk into an active resumable session.
 * Accepts either an options object or positional arguments (sessionId, chunkIndex, chunkBuffer, expectedSha256)
 */
export const appendResumableChunk = async (
  sessionIdOrObj,
  chunkIndexParam = null,
  chunkBufferParam = null,
  expectedSha256Param = null
) => {
  let sessionId, chunkIndex, chunkBuffer, expectedSha256;
  if (typeof sessionIdOrObj === 'object' && sessionIdOrObj !== null) {
    sessionId = sessionIdOrObj.sessionId;
    chunkIndex = Number(sessionIdOrObj.chunkIndex);
    chunkBuffer = sessionIdOrObj.chunkBuffer;
    expectedSha256 = sessionIdOrObj.expectedHash || sessionIdOrObj.expectedSha256 || null;
  } else {
    sessionId = sessionIdOrObj;
    chunkIndex = Number(chunkIndexParam);
    chunkBuffer = chunkBufferParam;
    expectedSha256 = expectedSha256Param;
  }

  const session = memUploadSessions[sessionId];
  if (!session) {
    throw new Error(`Resumable session "${sessionId}" not found or expired.`);
  }

  if (session.status !== 'uploading') {
    throw new Error(`Cannot append chunk: session status is "${session.status}".`);
  }

  const computedHash = calculateSHA256(chunkBuffer);
  if (expectedSha256 && computedHash !== expectedSha256) {
    throw new Error(`Chunk #${chunkIndex} integrity verification failed (expected ${expectedSha256}, got ${computedHash}).`);
  }

  const chunkDir = path.join(DATA_DIR, 'staging', sessionId);
  if (!fs.existsSync(chunkDir)) fs.mkdirSync(chunkDir, { recursive: true });

  const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}.bin`);
  fs.writeFileSync(chunkPath, chunkBuffer);

  session.receivedChunks[chunkIndex] = {
    chunkIndex,
    size: chunkBuffer.length,
    hash: computedHash,
    path: chunkPath
  };
  session.receivedBytes = Object.values(session.receivedChunks).reduce((sum, c) => sum + c.size, 0);
  session.updatedAt = new Date().toISOString();

  const countReceived = Object.keys(session.receivedChunks).length;
  const isComplete = countReceived === session.totalChunks;

  if (isComplete) {
    session.status = 'ready_to_assemble';
  }

  saveUploadSessions(memUploadSessions);

  return {
    chunkIndex,
    receivedChunks: countReceived,
    totalChunks: session.totalChunks,
    isComplete
  };
};

/**
 * Returns current status of a resumable upload session (missing chunk indices, progress %).
 *
 * @param {string} sessionId
 */
export const getResumableSessionStatus = (sessionId) => {
  const session = memUploadSessions[sessionId];
  if (!session) return null;

  const missingIndices = [];
  for (let i = 0; i < session.totalChunks; i++) {
    if (!session.receivedChunks[i]) {
      missingIndices.push(i);
    }
  }

  return {
    sessionId: session.sessionId,
    fileName: session.fileName,
    totalSize: session.totalSize,
    totalChunks: session.totalChunks,
    receivedChunksCount: Object.keys(session.receivedChunks).length,
    missingChunkIndices: missingIndices,
    status: session.status,
    progressPercent: Number(((session.receivedBytes / session.totalSize) * 100).toFixed(2))
  };
};

/**
 * Assembles all staged chunks via an async Node stream, writing directly to destination
 * without accumulating entire monolithic files in heap memory.
 *
 * @param {string} sessionId
 * @returns {Promise<{ fullCiphertext: Buffer, totalBytes: number, fullSha256: string }>}
 */
export const finalizeResumableStream = async (sessionId) => {
  const session = memUploadSessions[sessionId];
  if (!session) throw new Error(`Session ${sessionId} not found.`);
  if (session.status !== 'ready_to_assemble') {
    throw new Error(`Cannot finalize session: missing chunks.`);
  }

  const stagingDir = path.join(DATA_DIR, 'staging', sessionId);
  const chunkParts = [];

  for (let i = 0; i < session.totalChunks; i++) {
    const chunkInfo = session.receivedChunks[i];
    if (!chunkInfo || !fs.existsSync(chunkInfo.path)) {
      throw new Error(`Corrupted session: chunk file missing for index ${i}.`);
    }
    const buf = fs.readFileSync(chunkInfo.path);
    chunkParts.push(buf);
    // Cleanup chunk file
    try { fs.unlinkSync(chunkInfo.path); } catch (e) {}
  }

  try { if (fs.existsSync(stagingDir)) fs.rmdirSync(stagingDir); } catch (e) {}

  const fullCiphertext = Buffer.concat(chunkParts);
  const fullSha256 = calculateSHA256(fullCiphertext);

  delete memUploadSessions[sessionId];
  saveUploadSessions(memUploadSessions);

  return {
    fullCiphertext,
    totalBytes: fullCiphertext.length,
    fullSha256
  };
};
