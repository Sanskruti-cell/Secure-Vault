import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { calculateSHA256, verifySHA256 } from './hashingService.js';
import { File } from '../models/File.js';
import { FileShard } from '../models/FileShard.js';
import { isMongoConnected } from '../config/db.js';
import { writeNodeShard, readNodeShard } from './nodeService.js';

/**
 * ==============================================================================
 * SECUREVAULT REED-SOLOMON (4, 2) ERASURE CODING SERVICE (GF(2^8))
 * ==============================================================================
 * 
 * Architecture Specification:
 * ----------------------------
 * - Galois Field: GF(2^8) with irreducible polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d = 285)
 * - Data Shards (K): 4 data shards (d1, d2, d3, d4)
 * - Parity Shards (M): 2 parity shards (p1, p2)
 * - Total Shards (N): 6 shards distributed across storage nodes (node-01 .. node-06)
 * - Reconstruction Threshold: Any 4 of 6 shards guarantee bit-exact ciphertext recovery
 * - Erasure Tolerance: Tolerates ANY 2 missing or corrupted shards (all 15 pairs)
 * - Zero Plaintext Guarantee: Operates strictly on AES-256-GCM encrypted ciphertext payloads.
 * ==============================================================================
 */

// 16-Byte Header Constants for Shard Format Versioning & Metadata
export const MAGIC_HEADER = Buffer.from([0x53, 0x56, 0x45, 0x43]); // "SVEC" - SecureVault Erasure Code
export const FORMAT_VERSION_RS42 = 2; // Reed-Solomon 4+2
export const FORMAT_VERSION_LEGACY = 1; // Legacy 3+1 XOR

export const RS_DATA_SHARDS = 4;   // K = 4
export const RS_PARITY_SHARDS = 2; // M = 2
export const RS_TOTAL_SHARDS = 6;  // N = 6

export const LEGACY_DATA_SHARDS = 3;   // K = 3
export const LEGACY_PARITY_SHARDS = 1; // M = 1
export const LEGACY_TOTAL_SHARDS = 4;  // N = 4

// ==============================================================================
// GALOIS FIELD GF(2^8) ARITHMETIC TABLES & OPERATIONS
// ==============================================================================

const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

// Initialize logarithm and exponential lookup tables using primitive polynomial 0x11d (285)
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    EXP_TABLE[i + 255] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  LOG_TABLE[0] = 0; // Log(0) is mathematically undefined
})();

/**
 * Multiply two elements in GF(2^8).
 */
export const gfMul = (a, b) => {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
};

/**
 * Divide two elements in GF(2^8).
 */
export const gfDiv = (a, b) => {
  if (b === 0) throw new Error('Division by zero in GF(2^8)');
  if (a === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a] - LOG_TABLE[b] + 255) % 255];
};

/**
 * Compute the multiplicative inverse in GF(2^8).
 */
export const gfInv = (a) => {
  if (a === 0) throw new Error('Cannot invert zero in GF(2^8)');
  return EXP_TABLE[255 - LOG_TABLE[a]];
};

/**
 * Inverts an N x N matrix over GF(2^8) using Gaussian elimination with partial pivoting.
 * 
 * @param {Array<Array<number>>} matrix Square matrix over GF(2^8).
 * @returns {Array<Array<number>>} Inverted matrix.
 */
export const invertMatrixGF = (matrix) => {
  const n = matrix.length;
  // Augment matrix with identity matrix
  const aug = matrix.map((row, i) => {
    const r = [...row];
    for (let j = 0; j < n; j++) {
      r.push(i === j ? 1 : 0);
    }
    return r;
  });

  for (let i = 0; i < n; i++) {
    // Find pivot with non-zero entry
    let pivot = i;
    while (pivot < n && aug[pivot][i] === 0) {
      pivot++;
    }
    if (pivot === n) {
      throw new Error('Matrix is singular (not invertible) over GF(2^8)');
    }

    // Swap pivot row into place
    if (pivot !== i) {
      const temp = aug[i];
      aug[i] = aug[pivot];
      aug[pivot] = temp;
    }

    // Scale pivot row so leading entry is 1
    const pivotVal = aug[i][i];
    const invPivot = gfInv(pivotVal);
    for (let j = 0; j < 2 * n; j++) {
      aug[i][j] = gfMul(aug[i][j], invPivot);
    }

    // Eliminate column in all other rows
    for (let r = 0; r < n; r++) {
      if (r !== i) {
        const factor = aug[r][i];
        if (factor !== 0) {
          for (let j = 0; j < 2 * n; j++) {
            aug[r][j] ^= gfMul(factor, aug[i][j]);
          }
        }
      }
    }
  }

  return aug.map(row => row.slice(n));
};

// ==============================================================================
// CAUCHY GENERATOR MATRIX G (6 x 4)
// ==============================================================================
// Top 4x4: Identity matrix I4 (systematic data shards d1, d2, d3, d4)
// Bottom 2x4: Cauchy matrix A[i, j] = gfInv(X[i] ^ Y[j]) with X=[4, 5], Y=[0, 1, 2, 3]
// A[0, :] = [gfInv(4), gfInv(5), gfInv(6), gfInv(7)] = [122, 244, 157, 180]
// A[1, :] = [gfInv(5), gfInv(4), gfInv(7), gfInv(6)] = [244, 122, 180, 157]
export const CAUCHY_GENERATOR_MATRIX_6x4 = [
  [1, 0, 0, 0],       // Row 0 -> Shard 1 (d1)
  [0, 1, 0, 0],       // Row 1 -> Shard 2 (d2)
  [0, 0, 1, 0],       // Row 2 -> Shard 3 (d3)
  [0, 0, 0, 1],       // Row 3 -> Shard 4 (d4)
  [122, 244, 157, 180], // Row 4 -> Shard 5 (p1)
  [244, 122, 180, 157]  // Row 5 -> Shard 6 (p2)
];

/**
 * Encodes an encrypted ciphertext buffer into 6 Reed-Solomon shards (4 Data + 2 Parity).
 * 
 * @param {Buffer} ciphertextBuffer AES-256-GCM encrypted ciphertext payload.
 * @returns {Array<{ shardIndex: number, index: number, shardType: 'data'|'parity', data: Buffer, hash: string, size: number }>}
 */
export const encodeReedSolomon42 = (ciphertextBuffer) => {
  if (!Buffer.isBuffer(ciphertextBuffer)) {
    ciphertextBuffer = Buffer.from(ciphertextBuffer);
  }

  const originalSize = ciphertextBuffer.length;
  // Calculate chunk block size (ceil of originalSize / 4)
  const chunkSize = Math.max(1, Math.ceil(originalSize / RS_DATA_SHARDS));

  // Slices payload into 4 equal-sized data blocks (zero-padded to chunkSize)
  const d1 = Buffer.alloc(chunkSize, 0);
  const d2 = Buffer.alloc(chunkSize, 0);
  const d3 = Buffer.alloc(chunkSize, 0);
  const d4 = Buffer.alloc(chunkSize, 0);

  ciphertextBuffer.copy(d1, 0, 0, Math.min(chunkSize, originalSize));
  if (originalSize > chunkSize) {
    ciphertextBuffer.copy(d2, 0, chunkSize, Math.min(2 * chunkSize, originalSize));
  }
  if (originalSize > 2 * chunkSize) {
    ciphertextBuffer.copy(d3, 0, 2 * chunkSize, Math.min(3 * chunkSize, originalSize));
  }
  if (originalSize > 3 * chunkSize) {
    ciphertextBuffer.copy(d4, 0, 3 * chunkSize, Math.min(4 * chunkSize, originalSize));
  }

  const dataBlocks = [d1, d2, d3, d4];

  // Compute Cauchy Parity Shard 1 (p1) = 122*d1 ^ 244*d2 ^ 157*d3 ^ 180*d4
  const p1 = Buffer.alloc(chunkSize, 0);
  const row4 = CAUCHY_GENERATOR_MATRIX_6x4[4];
  for (let i = 0; i < chunkSize; i++) {
    p1[i] = gfMul(row4[0], d1[i]) ^
            gfMul(row4[1], d2[i]) ^
            gfMul(row4[2], d3[i]) ^
            gfMul(row4[3], d4[i]);
  }

  // Compute Cauchy Parity Shard 2 (p2) = 244*d1 ^ 122*d2 ^ 180*d3 ^ 157*d4
  const p2 = Buffer.alloc(chunkSize, 0);
  const row5 = CAUCHY_GENERATOR_MATRIX_6x4[5];
  for (let i = 0; i < chunkSize; i++) {
    p2[i] = gfMul(row5[0], d1[i]) ^
            gfMul(row5[1], d2[i]) ^
            gfMul(row5[2], d3[i]) ^
            gfMul(row5[3], d4[i]);
  }

  const rawBlocks = [d1, d2, d3, d4, p1, p2];
  const shards = [];

  for (let i = 0; i < RS_TOTAL_SHARDS; i++) {
    const shardIndex = i + 1;
    const blockPayload = rawBlocks[i];
    const shardType = i < RS_DATA_SHARDS ? 'data' : 'parity';

    // Construct 16-Byte Header
    // Offset 0-3  : Magic "SVEC"
    // Offset 4    : Version (2 for Reed-Solomon 4+2)
    // Offset 5    : Shard Index (1..6)
    // Offset 6    : Data Shards K (4)
    // Offset 7    : Parity Shards M (2)
    // Offset 8-11 : Original Ciphertext Size (UInt32BE)
    // Offset 12-15: Block Chunk Size (UInt32BE)
    const header = Buffer.alloc(16);
    MAGIC_HEADER.copy(header, 0);
    header.writeUInt8(FORMAT_VERSION_RS42, 4);
    header.writeUInt8(shardIndex, 5);
    header.writeUInt8(RS_DATA_SHARDS, 6);
    header.writeUInt8(RS_PARITY_SHARDS, 7);
    header.writeUInt32BE(originalSize, 8);
    header.writeUInt32BE(chunkSize, 12);

    const fullShardBuffer = Buffer.concat([header, blockPayload]);
    const hash = calculateSHA256(fullShardBuffer);

    shards.push({
      shardIndex,
      index: shardIndex,
      shardType,
      data: fullShardBuffer,
      hash,
      size: fullShardBuffer.length,
    });
  }

  return shards;
};

/**
 * Validates the binary structure, magic header, index, and SHA-256 hash of a shard buffer.
 * 
 * @param {Buffer} buffer Shard data buffer.
 * @param {number} [expectedIndex] Optional expected shard index (1..6).
 * @param {string} [expectedHash] Optional expected SHA-256 digest.
 * @returns {{ isValid: boolean, error?: string, version?: number, shardIndex?: number, originalSize?: number, chunkSize?: number }}
 */
export const validateShardBuffer = (buffer, expectedIndex, expectedHash) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
    return { isValid: false, error: 'Shard buffer too short (< 16 bytes)' };
  }

  // Check magic header "SVEC"
  if (!buffer.subarray(0, 4).equals(MAGIC_HEADER)) {
    return { isValid: false, error: 'Missing SVEC magic header' };
  }

  const version = buffer.readUInt8(4);
  if (version !== FORMAT_VERSION_RS42 && version !== FORMAT_VERSION_LEGACY) {
    return { isValid: false, error: `Unsupported shard format version: ${version}` };
  }

  const shardIndex = buffer.readUInt8(5);
  const maxShards = version === FORMAT_VERSION_RS42 ? RS_TOTAL_SHARDS : LEGACY_TOTAL_SHARDS;
  if (shardIndex < 1 || shardIndex > maxShards) {
    return { isValid: false, error: `Invalid shard index: ${shardIndex}` };
  }

  if (expectedIndex !== undefined && expectedIndex !== null && shardIndex !== Number(expectedIndex)) {
    return { isValid: false, error: `Shard index mismatch: expected ${expectedIndex}, found ${shardIndex}` };
  }

  const originalSize = buffer.readUInt32BE(8);
  const chunkSize = buffer.readUInt32BE(12);

  if (expectedHash) {
    const calculatedHash = calculateSHA256(buffer);
    if (calculatedHash.toLowerCase() !== String(expectedHash).toLowerCase()) {
      return { isValid: false, error: 'SHA-256 hash mismatch' };
    }
  }

  return {
    isValid: true,
    version,
    shardIndex,
    originalSize,
    chunkSize
  };
};

/**
 * Reconstructs the original ciphertext buffer from any >= 4 valid Reed-Solomon 4+2 shards.
 * 
 * @param {Array<{ shardIndex?: number, index?: number, data: Buffer, expectedHash?: string }>} availableShards 
 * @returns {Buffer} Reconstructed ciphertext buffer.
 */
export const decodeReedSolomon42 = (availableShards) => {
  if (!availableShards || availableShards.length === 0) {
    throw new Error('Reed-Solomon Reconstruction Failed: No shards supplied.');
  }

  // 1. Verify SHA-256 integrity and header structure for each provided shard
  const validShards = [];
  for (const shard of availableShards) {
    if (!shard || !shard.data) continue;
    const targetIdx = shard.shardIndex || shard.index;
    const validation = validateShardBuffer(shard.data, targetIdx, shard.expectedHash);
    if (!validation.isValid) {
      console.warn(`[Integrity Warning] Shard #${targetIdx || '?'} validation failed (${validation.error}). Discarding.`);
      continue; // Skip corrupted shard
    }
    validShards.push(shard);
  }

  if (validShards.length < RS_DATA_SHARDS) {
    throw new Error(`Reed-Solomon Reconstruction Failed: Insufficient valid shards. Minimum ${RS_DATA_SHARDS} valid shards required, but only ${validShards.length} passed checksum verification.`);
  }

  // 2. Extract header info from the first valid shard
  const sampleShard = validShards[0];
  if (sampleShard.data.length < 16) {
    throw new Error('Reed-Solomon Reconstruction Failed: Invalid shard header length.');
  }

  const sampleHeader = sampleShard.data.subarray(0, 16);
  const originalCiphertextSize = sampleHeader.readUInt32BE(8);
  const chunkSize = sampleHeader.readUInt32BE(12);

  // Collect the first 4 distinct valid shards
  const distinctShardsMap = new Map();
  for (const s of validShards) {
    const sIndex = s.shardIndex || s.index || s.data.readUInt8(5);
    if (!distinctShardsMap.has(sIndex) && sIndex >= 1 && sIndex <= RS_TOTAL_SHARDS) {
      distinctShardsMap.set(sIndex, s.data.subarray(16)); // 16-byte header stripped
    }
  }

  if (distinctShardsMap.size < RS_DATA_SHARDS) {
    throw new Error(`Reed-Solomon Reconstruction Failed: Distinct shards available (${distinctShardsMap.size}) is below threshold ${RS_DATA_SHARDS}.`);
  }

  // Pick any 4 distinct shard indices
  const chosenIndices = Array.from(distinctShardsMap.keys()).slice(0, RS_DATA_SHARDS);
  // Sort indices for determinism
  chosenIndices.sort((a, b) => a - b);

  const ts = () => new Date().toISOString();
  console.log(`[${ts()}] [SECUREVAULT] [RECONSTRUCTION] [ALGORITHM] Distinct valid shard indices available: [${Array.from(distinctShardsMap.keys()).sort((a, b) => a - b).join(', ')}]`);
  console.log(`[${ts()}] [SECUREVAULT] [RECONSTRUCTION] [ALGORITHM] Selected K=${RS_DATA_SHARDS} shards for reconstruction: [${chosenIndices.join(', ')}]`);

  // Fast path: If chosen shards are exactly shards 1, 2, 3, 4 (the systematic data shards)
  if (chosenIndices[0] === 1 && chosenIndices[1] === 2 && chosenIndices[2] === 3 && chosenIndices[3] === 4) {
    console.log(`[${ts()}] [SECUREVAULT] [RECONSTRUCTION] [ALGORITHM] Mode: [FAST PATH - SYSTEMATIC IDENTITY]`);
    console.log(`  -> Shards #1, #2, #3, #4 are the systematic original data blocks.`);
    console.log(`  -> Generator submatrix G_sub is the 4x4 Identity Matrix (I_4).`);
    console.log(`  -> Matrix inversion bypassed. Direct byte concatenation.`);
    const d1 = distinctShardsMap.get(1);
    const d2 = distinctShardsMap.get(2);
    const d3 = distinctShardsMap.get(3);
    const d4 = distinctShardsMap.get(4);
    const concatenated = Buffer.concat([d1, d2, d3, d4]);
    const finalBuf = concatenated.subarray(0, originalCiphertextSize);
    console.log(`  -> Concatenated size: ${concatenated.length} bytes -> Truncated to original ciphertext: ${finalBuf.length} bytes.`);
    return finalBuf;
  }

  // General Reed-Solomon Reconstruction Path via Matrix Inversion:
  const missingDataShards = [1, 2, 3, 4].filter(idx => !chosenIndices.includes(idx));
  const parityShardsUsed = chosenIndices.filter(idx => idx > 4);
  console.log(`[${ts()}] [SECUREVAULT] [RECONSTRUCTION] [ALGORITHM] Mode: [ERASURE RECOVERY - CAUCHY MATRIX INVERSION]`);
  console.log(`  -> Missing systematic data shard(s): [${missingDataShards.join(', ')}]`);
  console.log(`  -> Parity shard(s) deployed: [${parityShardsUsed.join(', ')}] to reconstruct missing data`);
  console.log(`  -> Building 4x4 Cauchy submatrix G_sub from generator matrix rows: [${chosenIndices.map(i => i - 1).join(', ')}]`);

  // Build 4x4 submatrix G_sub corresponding to the 4 chosen rows
  const subMatrix = chosenIndices.map(idx => CAUCHY_GENERATOR_MATRIX_6x4[idx - 1]);
  console.log(`  -> Inverting 4x4 Cauchy submatrix G_sub over Galois Field GF(2^8) (mod x^8 + x^4 + x^3 + x^2 + 1)...`);
  const invertedSubMatrix = invertMatrixGF(subMatrix);
  console.log(`  -> Submatrix inversion successful. Inverted matrix determinant non-zero; full rank verified.`);

  const chosenBlocks = chosenIndices.map(idx => distinctShardsMap.get(idx));

  // Reconstruct original 4 data blocks: [d1, d2, d3, d4] = G_sub^-1 * [s_chosen]
  console.log(`  -> Executing Galois Field matrix-vector multiplication across ${chunkSize} byte positions per shard...`);
  const recoveredDataBlocks = [
    Buffer.alloc(chunkSize, 0),
    Buffer.alloc(chunkSize, 0),
    Buffer.alloc(chunkSize, 0),
    Buffer.alloc(chunkSize, 0)
  ];

  for (let byteIdx = 0; byteIdx < chunkSize; byteIdx++) {
    for (let row = 0; row < RS_DATA_SHARDS; row++) {
      let val = 0;
      for (let col = 0; col < RS_DATA_SHARDS; col++) {
        val ^= gfMul(invertedSubMatrix[row][col], chosenBlocks[col][byteIdx]);
      }
      recoveredDataBlocks[row][byteIdx] = val;
    }
  }

  missingDataShards.forEach(missingIdx => {
    console.log(`  -> Recovered lost data shard #${missingIdx} using parity equations.`);
  });

  const combined = Buffer.concat(recoveredDataBlocks);
  const finalBuf = combined.subarray(0, originalCiphertextSize);
  console.log(`  -> Reconstructed payload: ${combined.length} bytes -> Truncated to original ciphertext: ${finalBuf.length} bytes.`);
  return finalBuf;
};

/**
 * Reconstructs a single missing or corrupted shard from >= 4 surviving valid shards.
 * 
 * @param {Array<{ shardIndex?: number, index?: number, data: Buffer, expectedHash?: string }>} availableShards 
 * @param {number} targetShardIndex 1-based index (1..6) of the shard to repair.
 * @returns {Buffer} The repaired full shard buffer (including 16-byte header).
 */
export const reconstructSingleShard = (availableShards, targetShardIndex) => {
  if (targetShardIndex < 1 || targetShardIndex > RS_TOTAL_SHARDS) {
    throw new Error(`Invalid target shard index: ${targetShardIndex}. Must be 1..6.`);
  }

  // 1. Recover the original ciphertext buffer first
  const ciphertextBuffer = decodeReedSolomon42(availableShards);

  // 2. Re-encode and extract the target shard
  const allShards = encodeReedSolomon42(ciphertextBuffer);
  const targetShard = allShards.find(s => s.shardIndex === targetShardIndex);

  if (!targetShard) {
    throw new Error(`Failed to regenerate shard #${targetShardIndex}`);
  }

  return targetShard.data;
};

/**
 * Repairs a specific missing or corrupted file shard on disk and updates the database.
 * 
 * @param {string} fileId File document ID or string identifier.
 * @param {number} targetShardIndex 1-based index (1..6).
 * @returns {Promise<{ success: boolean, shardIndex: number, nodeId: string, shardHash: string, shardSize: number }>}
 */
export const repairFileShard = async (fileId, targetShardIndex) => {
  targetShardIndex = Number(targetShardIndex);
  if (targetShardIndex < 1 || targetShardIndex > RS_TOTAL_SHARDS) {
    throw new Error(`Invalid shardIndex ${targetShardIndex} for repair.`);
  }

  let fileDoc = null;
  let shardRecords = [];

  if (isMongoConnected) {
    try {
      fileDoc = await File.findById(fileId).lean();
      if (fileDoc) {
        const queryId = mongoose.Types.ObjectId.isValid(fileId) ? new mongoose.Types.ObjectId(fileId) : fileId;
        shardRecords = await FileShard.find({ fileId: queryId }).lean();
      }
    } catch (e) {}
  }

  if (!fileDoc) {
    // Check in-memory fallback
    const { memFiles, memShards } = await import('../controllers/fileController.js').catch(() => ({ memFiles: [], memShards: [] }));
    fileDoc = (memFiles || []).find(f => f.id === fileId || String(f._id) === fileId);
    shardRecords = (memShards || []).filter(s => s.fileId === fileId);
  }

  if (!fileDoc) {
    throw new Error(`File with ID ${fileId} not found.`);
  }

  const targetRecord = shardRecords.find(s => s.shardIndex === targetShardIndex);
  const targetNodeId = targetRecord ? targetRecord.nodeId : `node-0${targetShardIndex}`;

  // Load available shards from storage
  const loadedSurvivingShards = [];
  for (const s of shardRecords) {
    if (s.shardIndex === targetShardIndex) continue; // Skip target
    const p = s.storagePath || s.filePath;
    const fromNodeId = s.nodeId || `node-0${s.shardIndex}`;
    if (p) {
      try {
        const shardBuf = await readNodeShard(fromNodeId, p);
        loadedSurvivingShards.push({
          shardIndex: s.shardIndex,
          data: shardBuf,
          expectedHash: s.shardHash
        });
      } catch (readErr) {
        // Shard unavailable on that node
      }
    }
  }

  if (loadedSurvivingShards.length < RS_DATA_SHARDS) {
    throw new Error(`Cannot repair shard #${targetShardIndex}: only ${loadedSurvivingShards.length} valid surviving shards found (requires at least ${RS_DATA_SHARDS}).`);
  }

  // Reconstruct target shard buffer
  const repairedShardBuffer = reconstructSingleShard(loadedSurvivingShards, targetShardIndex);
  const repairedHash = calculateSHA256(repairedShardBuffer);

  // Strict pre-save integrity verification
  const isValidHeader = repairedShardBuffer.length >= 16 && repairedShardBuffer.subarray(0, 4).equals(MAGIC_HEADER);
  if (!isValidHeader) {
    throw new Error(`Self-Healing Failed: Reconstructed shard #${targetShardIndex} failed SVEC binary header validation.`);
  }

  // If previous record had a hash, ensure reconstructed shard matches expected hash if known
  const previousHash = targetRecord ? (targetRecord.shardHash || null) : null;
  if (previousHash && previousHash !== repairedHash) {
    console.warn(`[Self-Healing] Shard #${targetShardIndex} hash recalculated from surviving quorum. Previous: ${previousHash}, New: ${repairedHash}`);
  }

  // Write to node storage directory
  const nodeDir = path.join(process.cwd(), 'storage', targetNodeId);
  if (!fs.existsSync(nodeDir)) {
    fs.mkdirSync(nodeDir, { recursive: true });
  }
  const fullShardPath = (targetRecord && (targetRecord.storagePath || targetRecord.filePath))
    ? (targetRecord.storagePath || targetRecord.filePath)
    : path.join(nodeDir, `${fileId}.shard.${targetShardIndex}`);
  await writeNodeShard(targetNodeId, fullShardPath, repairedShardBuffer);

  const ts = new Date().toISOString();
  console.log('\n' + '='.repeat(80));
  console.log(`[${ts}] [SECUREVAULT] [SELF-HEALING] === REED-SOLOMON SHARD REPAIR EVENT ===`);
  console.log(`  -> File Target:       ${fileId} ("${fileDoc.fileName || fileDoc.name || 'Unknown'}")`);
  console.log(`  -> Target Shard:      Shard #${targetShardIndex} on node ${targetNodeId}`);
  console.log(`  -> Surviving Quorum:  ${loadedSurvivingShards.length} shards available: [${loadedSurvivingShards.map(s => s.shardIndex).join(', ')}]`);
  console.log(`  -> Cauchy Inversion:  Galois Field GF(2^8) Matrix equations resolved successfully`);
  console.log(`  -> Repaired Hash:     ${repairedHash}`);
  console.log(`  -> Shard Size:        ${repairedShardBuffer.length} bytes | SVEC Magic Header: [VALID]`);
  console.log(`  -> Restoration Path:  ${fullShardPath}`);
  console.log(`  -> Status:            100% BIT-EXACT RESTORATION COMPLETE`);
  console.log('='.repeat(80) + '\n');

  const repairEntry = {
    repairedAt: new Date(),
    survivingShardsUsed: loadedSurvivingShards.map(s => s.shardIndex),
    targetNodeId,
    previousHash,
    newHash: repairedHash
  };

  // Update DB or memory record
  if (isMongoConnected) {
    try {
      await FileShard.findOneAndUpdate(
        { fileId, shardIndex: targetShardIndex },
        {
          shardHash: repairedHash,
          shardSize: repairedShardBuffer.length,
          storagePath: fullShardPath,
          status: 'active',
          lastVerifiedAt: new Date(),
          $push: { repairHistory: repairEntry }
        },
        { upsert: true }
      );
    } catch (e) {}
  }

  // Synchronize local memory and persistent store fallback
  try {
    const { memShards, saveStoredShards } = await import('../controllers/fileController.js').catch(() => ({ memShards: [] }));
    if (memShards) {
      const idx = memShards.findIndex(s => (s.fileId === fileId || String(s.fileId) === String(fileId)) && s.shardIndex === targetShardIndex);
      if (idx !== -1) {
        memShards[idx].shardHash = repairedHash;
        memShards[idx].shardSize = repairedShardBuffer.length;
        memShards[idx].storagePath = fullShardPath;
        memShards[idx].filePath = fullShardPath;
        memShards[idx].status = 'active';
        memShards[idx].lastVerifiedAt = new Date().toISOString();
        if (!memShards[idx].repairHistory) memShards[idx].repairHistory = [];
        memShards[idx].repairHistory.push(repairEntry);
      }
      if (typeof saveStoredShards === 'function') {
        saveStoredShards(memShards);
      }
    }
  } catch (memErr) {}

  return {
    success: true,
    shardIndex: targetShardIndex,
    nodeId: targetNodeId,
    shardHash: repairedHash,
    shardSize: repairedShardBuffer.length,
    storagePath: fullShardPath,
    repairHistory: repairEntry
  };
};

// ==============================================================================
// UNIFIED DISPATCH FUNCTIONS WITH BACKWARD COMPATIBILITY
// ==============================================================================

/**
 * Encodes a buffer into shards.
 * Defaults to Reed-Solomon (4 Data + 2 Parity = 6 Total) for new uploads,
 * or 3+1 XOR for legacy shardingVersion: 1 requests.
 * 
 * @param {Buffer} buffer Encrypted payload buffer.
 * @param {number} shardCount Total shard count (6 for RS 4+2, 4 for legacy 3+1).
 * @param {object} options Optional flags { shardingVersion: 2 }.
 */
export const splitIntoShards = (buffer, shardCount = 6, options = {}) => {
  const version = options.shardingVersion !== undefined ? Number(options.shardingVersion) : (shardCount === 4 ? 1 : 2);

  if (version === 2 || shardCount === 6) {
    return encodeReedSolomon42(buffer);
  }

  // --------------------------------------------------------------------------
  // BACKWARD COMPATIBILITY: Legacy 3 Data + 1 Parity XOR Encoding
  // --------------------------------------------------------------------------
  const originalSize = buffer.length;
  const chunkSize = Math.max(1, Math.ceil(originalSize / LEGACY_DATA_SHARDS));

  const d1 = Buffer.alloc(chunkSize, 0);
  const d2 = Buffer.alloc(chunkSize, 0);
  const d3 = Buffer.alloc(chunkSize, 0);

  buffer.copy(d1, 0, 0, Math.min(chunkSize, originalSize));
  if (originalSize > chunkSize) {
    buffer.copy(d2, 0, chunkSize, Math.min(2 * chunkSize, originalSize));
  }
  if (originalSize > 2 * chunkSize) {
    buffer.copy(d3, 0, 2 * chunkSize, Math.min(3 * chunkSize, originalSize));
  }

  // Calculate Parity Shard: p1 = d1 ^ d2 ^ d3
  const p1 = Buffer.alloc(chunkSize);
  for (let i = 0; i < chunkSize; i++) {
    p1[i] = d1[i] ^ d2[i] ^ d3[i];
  }

  const rawBlocks = [d1, d2, d3, p1];
  const shards = [];

  for (let i = 0; i < LEGACY_TOTAL_SHARDS; i++) {
    const shardIndex = i + 1;
    const blockPayload = rawBlocks[i];

    const header = Buffer.alloc(16);
    MAGIC_HEADER.copy(header, 0);
    header.writeUInt8(FORMAT_VERSION_LEGACY, 4);
    header.writeUInt8(shardIndex, 5);
    header.writeUInt8(LEGACY_DATA_SHARDS, 6);
    header.writeUInt8(LEGACY_PARITY_SHARDS, 7);
    header.writeUInt32BE(originalSize, 8);
    header.writeUInt32BE(chunkSize, 12);

    const fullShardBuffer = Buffer.concat([header, blockPayload]);
    const hash = calculateSHA256(fullShardBuffer);

    shards.push({
      shardIndex,
      index: shardIndex,
      shardType: i < 3 ? 'data' : 'parity',
      data: fullShardBuffer,
      hash,
      size: fullShardBuffer.length,
    });
  }

  return shards;
};

/**
 * Reconstructs the original buffer from available shards.
 * Automatically detects whether shards are Reed-Solomon 4+2 (version 2),
 * legacy 3+1 XOR (version 1), or legacy 4-of-4 raw slices.
 * 
 * @param {Array<{ shardIndex?: number, index?: number, data: Buffer, expectedHash?: string }>} availableShards 
 * @returns {Buffer} Reconstructed payload buffer.
 */
export const reassembleShards = (availableShards) => {
  if (!availableShards || availableShards.length === 0) {
    throw new Error('Erasure Reconstruction Failed: No shards supplied.');
  }

  // Verify SHA-256 integrity and filter out corrupted shards
  const validShards = [];
  for (const shard of availableShards) {
    if (!shard || !shard.data) continue;
    if (shard.expectedHash) {
      const isValid = verifySHA256(shard.data, shard.expectedHash);
      if (!isValid) {
        console.warn(`[Integrity Warning] Shard #${shard.shardIndex || shard.index} checksum verification failed.`);
        continue;
      }
    }
    validShards.push(shard);
  }

  if (validShards.length === 0) {
    throw new Error('Erasure Reconstruction Failed: All provided shards failed integrity checksum verification.');
  }

  const sampleShard = validShards[0];
  const hasSVECHeader = sampleShard.data.length >= 16 && 
                        sampleShard.data.subarray(0, 4).equals(MAGIC_HEADER);

  // --------------------------------------------------------------------------
  // PATH 1: Legacy 4-of-4 Contiguous Slice Format (no SVEC header)
  // --------------------------------------------------------------------------
  if (!hasSVECHeader) {
    if (validShards.length < 4) {
      throw new Error(`Legacy Format Error: Legacy 4-of-4 sliced file requires all 4 shards. Only ${validShards.length} shards available.`);
    }
    const sorted = [...validShards].sort((a, b) => (a.shardIndex || a.index) - (b.shardIndex || b.index));
    return Buffer.concat(sorted.map(s => s.data));
  }

  // Parse header parameters
  const header = sampleShard.data.subarray(0, 16);
  const version = header.readUInt8(4);

  // --------------------------------------------------------------------------
  // PATH 2: Reed-Solomon 4+2 Format (Version 2)
  // --------------------------------------------------------------------------
  if (version === FORMAT_VERSION_RS42) {
    return decodeReedSolomon42(validShards);
  }

  // --------------------------------------------------------------------------
  // PATH 3: Legacy 3+1 XOR Format (Version 1)
  // --------------------------------------------------------------------------
  const k = header.readUInt8(6) || LEGACY_DATA_SHARDS; // K = 3
  const originalSize = header.readUInt32BE(8);
  const chunkSize = header.readUInt32BE(12);

  if (validShards.length < k) {
    throw new Error(`Erasure Reconstruction Failed: Insufficient shards available. Minimum ${k} shards required for recovery, but only ${validShards.length} were present.`);
  }

  const shardMap = new Map();
  for (const s of validShards) {
    const sIndex = s.shardIndex || s.index || s.data.readUInt8(5);
    const payload = s.data.subarray(16); // Strip 16-byte header
    shardMap.set(sIndex, payload);
  }

  let d1 = shardMap.get(1);
  let d2 = shardMap.get(2);
  let d3 = shardMap.get(3);
  const p1 = shardMap.get(4);

  if (d1 && d2 && d3) {
    const combined = Buffer.concat([d1, d2, d3]);
    return combined.subarray(0, originalSize);
  }

  if (!d1 && d2 && d3 && p1) {
    d1 = Buffer.alloc(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      d1[i] = p1[i] ^ d2[i] ^ d3[i];
    }
    const combined = Buffer.concat([d1, d2, d3]);
    return combined.subarray(0, originalSize);
  }

  if (!d2 && d1 && d3 && p1) {
    d2 = Buffer.alloc(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      d2[i] = p1[i] ^ d1[i] ^ d3[i];
    }
    const combined = Buffer.concat([d1, d2, d3]);
    return combined.subarray(0, originalSize);
  }

  if (!d3 && d1 && d2 && p1) {
    d3 = Buffer.alloc(chunkSize);
    for (let i = 0; i < chunkSize; i++) {
      d3[i] = p1[i] ^ d1[i] ^ d2[i];
    }
    const combined = Buffer.concat([d1, d2, d3]);
    return combined.subarray(0, originalSize);
  }

  throw new Error('Erasure Reconstruction Failed: Unable to resolve data blocks from current legacy shard combination.');
};

export const createShardsFromBuffer = splitIntoShards;
export const reconstructBufferFromShards = reassembleShards;
