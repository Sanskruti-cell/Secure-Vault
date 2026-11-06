import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { env } from './src/config/env.js';
import { connectDB, isMongoConnected } from './src/config/db.js';
import { File } from './src/models/File.js';
import { FileShard } from './src/models/FileShard.js';
import { StoredChunk } from './src/models/StoredChunk.js';
import { uploadFile, deleteFile } from './src/controllers/fileController.js';
import { decodeReedSolomon42, RS_DATA_SHARDS, RS_TOTAL_SHARDS } from './src/services/shardingService.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(PROJECT_ROOT, 'storage');

// Helper to count physical shard files and disk bytes
function getStorageDiskStats() {
  const nodeDirs = ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06'];
  let totalFiles = 0;
  let totalBytes = 0;
  const shardPaths = [];

  for (const dir of nodeDirs) {
    const fullDir = path.join(STORAGE_DIR, dir);
    if (!fs.existsSync(fullDir)) continue;
    const entries = fs.readdirSync(fullDir);
    for (const file of entries) {
      if (file.includes('.shard.')) {
        const filePath = path.join(fullDir, file);
        try {
          const stat = fs.statSync(filePath);
          totalFiles++;
          totalBytes += stat.size;
          shardPaths.push(filePath);
        } catch (e) {}
      }
    }
  }
  return { totalFiles, totalBytes, shardPaths };
}

// Client-side convergent encryption helper (matches cryptoService.ts)
function clientSideConvergentEncrypt(plaintextBuffer, password = 'test-password-securevault') {
  const originalFileHash = crypto.createHash('sha256').update(plaintextBuffer).digest('hex');
  const dekDigest = crypto.createHash('sha256').update(`SecureVault-DEK:${originalFileHash}`).digest();
  const nonceDigest = crypto.createHash('sha256').update(`SecureVault-Nonce:${originalFileHash}`).digest();
  const saltDigest = crypto.createHash('sha256').update(`SecureVault-Salt:${originalFileHash}`).digest();

  const baseNonce = nonceDigest.subarray(0, 8);
  const kdfSalt = saltDigest.subarray(0, 16);

  // Derive 12-byte IV for chunk 0: 8 bytes baseNonce + 4 bytes counter (0)
  const iv = Buffer.alloc(12);
  baseNonce.copy(iv, 0);
  iv.writeUInt32BE(0, 8);

  const cipher = crypto.createCipheriv('aes-256-gcm', dekDigest, iv);
  const encrypted = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertextBuffer = Buffer.concat([encrypted, authTag]);

  // Derive per-user KEK and wrap DEK using AES keywrap emulation / AES-KW
  const kek = crypto.pbkdf2Sync(password, kdfSalt, 100000, 32, 'sha256');
  // Simple wrap: encrypt DEK with KEK
  const wrapCipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const wrappedDEKBuf = Buffer.concat([wrapCipher.update(dekDigest), wrapCipher.final(), wrapCipher.getAuthTag()]);

  return {
    ciphertextBuffer,
    wrappedDEK: wrappedDEKBuf.toString('base64'),
    kdf: 'PBKDF2-HMAC-SHA256',
    kdfSalt: kdfSalt.toString('base64'),
    kdfIterations: 100000,
    baseNonce: baseNonce.toString('base64'),
    originalFileHash,
    originalFileSize: plaintextBuffer.length,
    dekDigest,
    iv
  };
}

// Client-side decryption helper
function clientSideDecrypt(ciphertextBuffer, dekDigest, baseNonce) {
  const iv = Buffer.alloc(12);
  baseNonce.copy(iv, 0);
  iv.writeUInt32BE(0, 8);

  const authTag = ciphertextBuffer.subarray(ciphertextBuffer.length - 16);
  const encryptedData = ciphertextBuffer.subarray(0, ciphertextBuffer.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', dekDigest, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted;
}

// Mock Express req/res
function createMockReqRes({ file, body, user, params }) {
  const req = {
    file,
    body: body || {},
    user: user || { _id: '6a9396fdc9ed4da9bf47e3b8', email: 'sanskrutiasati@gmail.com' },
    params: params || {}
  };
  let statusCode = 200;
  let responseData = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    getStatusCode: () => statusCode,
    getData: () => responseData
  };
  return { req, res };
}

async function runE2ETests() {
  console.log('================================================================');
  console.log('       SECUREVAULT END-TO-END DEDUPLICATION & RECOVERY TEST     ');
  console.log('================================================================\n');

  await connectDB();
  if (!isMongoConnected) {
    throw new Error('Could not connect to MongoDB Atlas for verified audit!');
  }

  const testUserId = '6a9396fdc9ed4da9bf47e3b8';
  const testUser = { _id: testUserId, id: testUserId, email: 'sanskrutiasati@gmail.com' };

  // --------------------------------------------------------------------------
  // Baseline Snapshot
  // --------------------------------------------------------------------------
  console.log('[SNAPSHOT] Recording initial baseline metrics...');
  const initialFilesCount = await File.countDocuments();
  const initialShardsCount = await FileShard.countDocuments();
  const initialChunksCount = await StoredChunk.countDocuments();
  const initialDisk = getStorageDiskStats();

  console.log(`  Initial MongoDB Files:        ${initialFilesCount}`);
  console.log(`  Initial MongoDB FileShards:   ${initialShardsCount}`);
  console.log(`  Initial MongoDB StoredChunks: ${initialChunksCount}`);
  console.log(`  Initial Physical Shard Files: ${initialDisk.totalFiles}`);
  console.log(`  Initial Physical Disk Usage:  ${(initialDisk.totalBytes / 1024).toFixed(2)} KB\n`);

  // Prepare synthetic test files (64 KB each)
  const fileAContent = crypto.randomBytes(64 * 1024); // 65,536 bytes
  const fileASha256 = crypto.createHash('sha256').update(fileAContent).digest('hex');

  const fileBContent = crypto.randomBytes(48 * 1024); // 49,152 bytes (distinct content)
  const fileBSha256 = crypto.createHash('sha256').update(fileBContent).digest('hex');

  console.log(`[TEST DATA] File A generated: 64 KB, SHA-256: ${fileASha256.substring(0, 16)}...`);
  console.log(`[TEST DATA] File B generated: 48 KB, SHA-256: ${fileBSha256.substring(0, 16)}...\n`);

  const timings = {};

  // --------------------------------------------------------------------------
  // TEST 1: Upload File A (First upload - new unique content)
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Upload File A (First Upload - New Unique Content) ---');
  const encA1 = clientSideConvergentEncrypt(fileAContent);
  const t0 = performance.now();

  const { req: req1, res: res1 } = createMockReqRes({
    file: {
      originalname: 'test_file_A_v1.bin',
      buffer: encA1.ciphertextBuffer,
      size: encA1.ciphertextBuffer.length,
      mimetype: 'application/octet-stream'
    },
    body: {
      cryptoVersion: '2',
      wrappedDEK: encA1.wrappedDEK,
      kdf: encA1.kdf,
      kdfSalt: encA1.kdfSalt,
      kdfIterations: encA1.kdfIterations,
      baseNonce: encA1.baseNonce,
      originalFileHash: encA1.originalFileHash,
      originalFileSize: encA1.originalFileSize,
      isPasswordProtected: 'false'
    },
    user: testUser
  });

  await uploadFile(req1, res1, () => {});
  timings.uploadA1 = performance.now() - t0;
  const fileA1Data = res1.getData();
  const fileA1Id = fileA1Data.id || fileA1Data.file?.id;

  console.log(`  Upload Status: ${res1.getStatusCode()} in ${timings.uploadA1.toFixed(1)} ms`);
  console.log(`  Created File ID: ${fileA1Id}`);

  // Verification 1
  const docA1 = await File.findById(fileA1Id).lean();
  const shardsA1 = await FileShard.find({ fileId: fileA1Id }).lean();
  const chunkA1 = await StoredChunk.findOne({ chunkHash: docA1.fileHash }).lean();
  const diskAfterA1 = getStorageDiskStats();

  console.log(`  File A1 isDeduplicated: ${docA1.isDeduplicated} (Expected: false)`);
  console.log(`  File A1 deduplicationRatio: ${docA1.deduplicationRatio} (Expected: 1)`);
  console.log(`  StoredChunk refCount: ${chunkA1?.refCount} (Expected: 1)`);
  console.log(`  StoredChunk fileIds: [${chunkA1?.fileIds?.join(', ')}]`);
  console.log(`  Physical Shards created: ${diskAfterA1.totalFiles - initialDisk.totalFiles} (Expected: 6)`);
  console.log(`  Disk bytes delta: +${diskAfterA1.totalBytes - initialDisk.totalBytes} bytes\n`);

  if (docA1.isDeduplicated !== false || chunkA1?.refCount !== 1 || (diskAfterA1.totalFiles - initialDisk.totalFiles) !== 6) {
    throw new Error('Test 1 Assertion Failed!');
  }

  // --------------------------------------------------------------------------
  // TEST 2: Upload File A Again (Duplicate Upload - Exact same content)
  // --------------------------------------------------------------------------
  console.log('--- TEST 2: Upload File A Again (Duplicate Upload - Content Deduplication Hit) ---');
  const encA2 = clientSideConvergentEncrypt(fileAContent);
  const t1 = performance.now();

  const { req: req2, res: res2 } = createMockReqRes({
    file: {
      originalname: 'test_file_A_v2_duplicate.bin',
      buffer: encA2.ciphertextBuffer,
      size: encA2.ciphertextBuffer.length,
      mimetype: 'application/octet-stream'
    },
    body: {
      cryptoVersion: '2',
      wrappedDEK: encA2.wrappedDEK,
      kdf: encA2.kdf,
      kdfSalt: encA2.kdfSalt,
      kdfIterations: encA2.kdfIterations,
      baseNonce: encA2.baseNonce,
      originalFileHash: encA2.originalFileHash,
      originalFileSize: encA2.originalFileSize,
      isPasswordProtected: 'false'
    },
    user: testUser
  });

  await uploadFile(req2, res2, () => {});
  timings.uploadA2_dedup = performance.now() - t1;
  const fileA2Data = res2.getData();
  const fileA2Id = fileA2Data.id || fileA2Data.file?.id;

  console.log(`  Upload Status: ${res2.getStatusCode()} in ${timings.uploadA2_dedup.toFixed(1)} ms`);
  console.log(`  Created Duplicate File ID: ${fileA2Id}`);

  // Verification 2
  const docA1_updated = await File.findById(fileA1Id).lean();
  const docA2 = await File.findById(fileA2Id).lean();
  const shardsA2 = await FileShard.find({ fileId: fileA2Id }).lean();
  const chunkA_updated = await StoredChunk.findOne({ chunkHash: docA2.fileHash }).lean();
  const diskAfterA2 = getStorageDiskStats();

  console.log(`  File A1 (Original) isDeduplicated: ${docA1_updated.isDeduplicated} (Expected: true)`);
  console.log(`  File A1 deduplicationRatio: ${docA1_updated.deduplicationRatio} (Expected: 2)`);
  console.log(`  File A2 (Duplicate) isDeduplicated: ${docA2.isDeduplicated} (Expected: true)`);
  console.log(`  File A2 deduplicationRatio: ${docA2.deduplicationRatio} (Expected: 2)`);
  console.log(`  StoredChunk refCount: ${chunkA_updated?.refCount} (Expected: 2)`);
  console.log(`  StoredChunk fileIds: [${chunkA_updated?.fileIds?.join(', ')}]`);
  console.log(`  New Physical Shard Files Written to Disk: ${diskAfterA2.totalFiles - diskAfterA1.totalFiles} (Expected: 0 - ZERO byte disk writes)`);
  console.log(`  Disk Bytes Delta: +${diskAfterA2.totalBytes - diskAfterA1.totalBytes} bytes (Expected: 0)\n`);

  // Verify physical shard paths are identical
  const shard1Paths = shardsA1.map(s => s.storagePath).sort();
  const shard2Paths = shardsA2.map(s => s.storagePath).sort();
  const pathsMatch = shard1Paths.length === shard2Paths.length && shard1Paths.every((p, i) => p === shard2Paths[i]);
  console.log(`  Physical Shard Paths Shared 100%: ${pathsMatch}`);

  if (!docA1_updated.isDeduplicated || !docA2.isDeduplicated || chunkA_updated?.refCount !== 2 || diskAfterA2.totalFiles !== diskAfterA1.totalFiles || !pathsMatch) {
    throw new Error('Test 2 Assertion Failed!');
  }

  // --------------------------------------------------------------------------
  // TEST 3: Upload File B (Different Content)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Upload File B (Different Content) ---');
  const encB = clientSideConvergentEncrypt(fileBContent);
  const t2 = performance.now();

  const { req: req3, res: res3 } = createMockReqRes({
    file: {
      originalname: 'test_file_B_distinct.bin',
      buffer: encB.ciphertextBuffer,
      size: encB.ciphertextBuffer.length,
      mimetype: 'application/octet-stream'
    },
    body: {
      cryptoVersion: '2',
      wrappedDEK: encB.wrappedDEK,
      kdf: encB.kdf,
      kdfSalt: encB.kdfSalt,
      kdfIterations: encB.kdfIterations,
      baseNonce: encB.baseNonce,
      originalFileHash: encB.originalFileHash,
      originalFileSize: encB.originalFileSize,
      isPasswordProtected: 'false'
    },
    user: testUser
  });

  await uploadFile(req3, res3, () => {});
  timings.uploadB = performance.now() - t2;
  const fileBData = res3.getData();
  const fileBId = fileBData.id || fileBData.file?.id;

  console.log(`  Upload Status: ${res3.getStatusCode()} in ${timings.uploadB.toFixed(1)} ms`);
  console.log(`  Created File B ID: ${fileBId}`);

  // Verification 3
  const docB = await File.findById(fileBId).lean();
  const chunkB = await StoredChunk.findOne({ chunkHash: docB.fileHash }).lean();
  const diskAfterB = getStorageDiskStats();

  console.log(`  File B isDeduplicated: ${docB.isDeduplicated} (Expected: false)`);
  console.log(`  File B deduplicationRatio: ${docB.deduplicationRatio} (Expected: 1)`);
  console.log(`  StoredChunk B refCount: ${chunkB?.refCount} (Expected: 1)`);
  console.log(`  Physical Shards added for B: ${diskAfterB.totalFiles - diskAfterA2.totalFiles} (Expected: 6)\n`);

  if (docB.isDeduplicated !== false || chunkB?.refCount !== 1 || (diskAfterB.totalFiles - diskAfterA2.totalFiles) !== 6) {
    throw new Error('Test 3 Assertion Failed!');
  }

  // --------------------------------------------------------------------------
  // TEST 4: Download & Decrypt File A (Both Instances) and File B
  // --------------------------------------------------------------------------
  console.log('--- TEST 4: Download & Decryption Verification ---');
  
  // Reassemble File A from shards
  const tDlA1 = performance.now();
  const rawShardsA1 = shardsA1.map(s => ({
    shardIndex: s.shardIndex,
    index: s.shardIndex,
    data: fs.readFileSync(s.storagePath),
    expectedHash: s.shardHash
  }));
  const reassembledCiphertextA1 = decodeReedSolomon42(rawShardsA1);
  const decryptedA1 = clientSideDecrypt(reassembledCiphertextA1, encA1.dekDigest, Buffer.from(encA1.baseNonce, 'base64'));
  timings.downloadA1 = performance.now() - tDlA1;

  const decryptedA1Sha256 = crypto.createHash('sha256').update(decryptedA1).digest('hex');
  const a1Match = decryptedA1Sha256 === fileASha256;
  console.log(`  File A1 Decrypted in ${timings.downloadA1.toFixed(1)} ms | SHA-256 Match: ${a1Match} (${decryptedA1Sha256.substring(0, 16)}...)`);

  // Reassemble File A2 from the SAME shared shards
  const tDlA2 = performance.now();
  const rawShardsA2 = shardsA2.map(s => ({
    shardIndex: s.shardIndex,
    index: s.shardIndex,
    data: fs.readFileSync(s.storagePath),
    expectedHash: s.shardHash
  }));
  const reassembledCiphertextA2 = decodeReedSolomon42(rawShardsA2);
  const decryptedA2 = clientSideDecrypt(reassembledCiphertextA2, encA2.dekDigest, Buffer.from(encA2.baseNonce, 'base64'));
  timings.downloadA2 = performance.now() - tDlA2;

  const decryptedA2Sha256 = crypto.createHash('sha256').update(decryptedA2).digest('hex');
  const a2Match = decryptedA2Sha256 === fileASha256;
  console.log(`  File A2 Decrypted in ${timings.downloadA2.toFixed(1)} ms | SHA-256 Match: ${a2Match} (${decryptedA2Sha256.substring(0, 16)}...)`);

  // Reassemble File B
  const shardsB = await FileShard.find({ fileId: fileBId }).lean();
  const rawShardsB = shardsB.map(s => ({
    shardIndex: s.shardIndex,
    index: s.shardIndex,
    data: fs.readFileSync(s.storagePath),
    expectedHash: s.shardHash
  }));
  const reassembledCiphertextB = decodeReedSolomon42(rawShardsB);
  const decryptedB = clientSideDecrypt(reassembledCiphertextB, encB.dekDigest, Buffer.from(encB.baseNonce, 'base64'));
  const bMatch = crypto.createHash('sha256').update(decryptedB).digest('hex') === fileBSha256;
  console.log(`  File B Decrypted | SHA-256 Match: ${bMatch}\n`);

  if (!a1Match || !a2Match || !bMatch) {
    throw new Error('Test 4 Assertion Failed: Checksum mismatch on download!');
  }

  // --------------------------------------------------------------------------
  // TEST 5: Fault Tolerance & Recovery from 2 Unavailable Nodes (Reed-Solomon 4+2)
  // --------------------------------------------------------------------------
  console.log('--- TEST 5: Fault Tolerance & Reconstruction (2 Out of 6 Nodes Offline) ---');
  // Simulate loss of Shard 1 (data) and Shard 5 (parity): pass only 4 surviving shards
  const survivingShards = [
    rawShardsA1[1], // Shard 2 present
    rawShardsA1[2], // Shard 3 present
    rawShardsA1[3], // Shard 4 present
    rawShardsA1[5]  // Shard 6 present
  ];

  const tRec = performance.now();
  const reconstructedCiphertext = decodeReedSolomon42(survivingShards);
  const reconstructedPlaintext = clientSideDecrypt(reconstructedCiphertext, encA1.dekDigest, Buffer.from(encA1.baseNonce, 'base64'));
  timings.reedSolomonRecovery = performance.now() - tRec;

  const reconstructedSha256 = crypto.createHash('sha256').update(reconstructedPlaintext).digest('hex');
  const recoverySuccess = reconstructedSha256 === fileASha256;
  console.log(`  Surviving Shards: 4 / 6 (Indices 2, 3, 4, 6 available; 1, 5 dropped)`);
  console.log(`  Reed-Solomon Cauchy Decoding Time: ${timings.reedSolomonRecovery.toFixed(2)} ms`);
  console.log(`  Reconstructed Data Integrity: ${recoverySuccess ? '100% BIT-EXACT MATCH' : 'CORRUPTED'}\n`);

  if (!recoverySuccess) {
    throw new Error('Test 5 Assertion Failed: Reed-Solomon 4+2 reconstruction failed!');
  }

  // --------------------------------------------------------------------------
  // TEST 6: Delete One Duplicate (Delete File A2)
  // --------------------------------------------------------------------------
  console.log('--- TEST 6: Delete One Duplicate (File A2) - Physical Shards Must Be Preserved ---');
  const tDel1 = performance.now();
  const { req: reqDel1, res: resDel1 } = createMockReqRes({
    params: { id: fileA2Id },
    user: testUser
  });
  await deleteFile(reqDel1, resDel1, () => {});
  timings.deleteDuplicate = performance.now() - tDel1;

  console.log(`  Delete File A2 Status: ${resDel1.getStatusCode()} in ${timings.deleteDuplicate.toFixed(1)} ms`);

  // Verification 6
  const deletedDocA2 = await File.findById(fileA2Id).lean();
  const deletedShardsA2 = await FileShard.find({ fileId: fileA2Id }).lean();
  const remainingDocA1 = await File.findById(fileA1Id).lean();
  const remainingChunkA = await StoredChunk.findOne({ chunkHash: remainingDocA1.fileHash }).lean();
  const diskAfterDelA2 = getStorageDiskStats();

  // Check physical shard files on disk
  const physicalShardsStillExist = shard1Paths.every(p => fs.existsSync(p));

  console.log(`  File A2 Document in DB: ${deletedDocA2 ? 'STILL EXISTS (ERROR)' : 'DELETED (OK)'}`);
  console.log(`  File A2 Shard Records in DB: ${deletedShardsA2.length} (Expected: 0)`);
  console.log(`  Physical Shards on Disk Still Exist: ${physicalShardsStillExist} (Expected: true)`);
  console.log(`  Total Physical Shard Files on Disk: ${diskAfterDelA2.totalFiles} (Expected: unchanged at ${diskAfterB.totalFiles})`);
  console.log(`  Remaining File A1 isDeduplicated: ${remainingDocA1.isDeduplicated} (Expected: false)`);
  console.log(`  Remaining File A1 deduplicationRatio: ${remainingDocA1.deduplicationRatio} (Expected: 1)`);
  console.log(`  Remaining StoredChunk refCount: ${remainingChunkA?.refCount} (Expected: 1)`);
  console.log(`  Remaining StoredChunk fileIds: [${remainingChunkA?.fileIds?.join(', ')}]\n`);

  if (deletedDocA2 || !physicalShardsStillExist || remainingDocA1.isDeduplicated !== false || remainingChunkA?.refCount !== 1) {
    throw new Error('Test 6 Assertion Failed: Physical shards were erroneously deleted or refCount not updated!');
  }

  // --------------------------------------------------------------------------
  // TEST 7: Delete Final Reference (Delete File A1) - Physical Shards Must Be Purged
  // --------------------------------------------------------------------------
  console.log('--- TEST 7: Delete Final Reference (File A1) - Physical Shards Must Be Purged ---');
  const tDel2 = performance.now();
  const { req: reqDel2, res: resDel2 } = createMockReqRes({
    params: { id: fileA1Id },
    user: testUser
  });
  await deleteFile(reqDel2, resDel2, () => {});
  timings.deleteFinal = performance.now() - tDel2;

  console.log(`  Delete File A1 Status: ${resDel2.getStatusCode()} in ${timings.deleteFinal.toFixed(1)} ms`);

  // Verification 7
  const deletedDocA1 = await File.findById(fileA1Id).lean();
  const purgedChunkA = await StoredChunk.findOne({ chunkHash: docA1.fileHash }).lean();
  const physicalShardsPurged = shard1Paths.every(p => !fs.existsSync(p));
  const diskAfterDelA1 = getStorageDiskStats();

  console.log(`  File A1 Document in DB: ${deletedDocA1 ? 'STILL EXISTS (ERROR)' : 'DELETED (OK)'}`);
  console.log(`  StoredChunk A in DB: ${purgedChunkA ? 'STILL EXISTS (ERROR)' : 'DELETED (OK)'}`);
  console.log(`  All 6 Physical Shard Files Purged from Disk: ${physicalShardsPurged} (Expected: true)`);
  console.log(`  Physical Shards Removed: ${diskAfterDelA2.totalFiles - diskAfterDelA1.totalFiles} (Expected: 6)`);
  console.log(`  Disk Bytes Reclaimed: ${(diskAfterDelA2.totalBytes - diskAfterDelA1.totalBytes)} bytes\n`);

  // Verify File B is completely untouched
  const docB_intact = await File.findById(fileBId).lean();
  const shardsB_intact = await FileShard.find({ fileId: fileBId }).lean();
  const shardsB_filesExist = shardsB_intact.every(s => fs.existsSync(s.storagePath));
  console.log(`  File B Unaffected & Intact: ${Boolean(docB_intact)} | Shard Files Exist: ${shardsB_filesExist}\n`);

  if (deletedDocA1 || purgedChunkA || !physicalShardsPurged || !docB_intact || !shardsB_filesExist) {
    throw new Error('Test 7 Assertion Failed: Shards not unlinked or File B corrupted!');
  }

  // --------------------------------------------------------------------------
  // TEST 8: Clean up File B
  // --------------------------------------------------------------------------
  console.log('--- TEST 8: Clean up File B ---');
  const { req: reqDelB, res: resDelB } = createMockReqRes({
    params: { id: fileBId },
    user: testUser
  });
  await deleteFile(reqDelB, resDelB, () => {});
  const finalDisk = getStorageDiskStats();
  const finalFilesCount = await File.countDocuments();
  const finalShardsCount = await FileShard.countDocuments();
  const finalChunksCount = await StoredChunk.countDocuments();

  console.log(`  Final MongoDB Files:        ${finalFilesCount} (Delta from baseline: ${finalFilesCount - initialFilesCount})`);
  console.log(`  Final MongoDB FileShards:   ${finalShardsCount} (Delta from baseline: ${finalShardsCount - initialShardsCount})`);
  console.log(`  Final MongoDB StoredChunks: ${finalChunksCount} (Delta from baseline: ${finalChunksCount - initialChunksCount})`);
  console.log(`  Final Physical Shards:      ${finalDisk.totalFiles} (Delta from baseline: ${finalDisk.totalFiles - initialDisk.totalFiles})`);
  console.log(`  Final Disk Usage:           ${(finalDisk.totalBytes / 1024).toFixed(2)} KB (Delta: ${finalDisk.totalBytes - initialDisk.totalBytes} bytes)\n`);

  console.log('================================================================');
  console.log('              ALL 8 VERIFICATION TESTS PASSED!                 ');
  console.log('================================================================\n');

  console.log('--- BENCHMARK OPERATION TIMINGS ---');
  console.log(`  Upload Unique File (File A1):       ${timings.uploadA1.toFixed(1)} ms`);
  console.log(`  Upload Deduplicated (File A2):       ${timings.uploadA2_dedup.toFixed(1)} ms (${((1 - timings.uploadA2_dedup/timings.uploadA1)*100).toFixed(1)}% latency reduction)`);
  console.log(`  Upload Unique File (File B):        ${timings.uploadB.toFixed(1)} ms`);
  console.log(`  Download & Decrypt (File A1):       ${timings.downloadA1.toFixed(1)} ms`);
  console.log(`  Download & Decrypt (File A2):       ${timings.downloadA2.toFixed(1)} ms`);
  console.log(`  Reed-Solomon 4+2 Recovery (2 down): ${timings.reedSolomonRecovery.toFixed(2)} ms`);
  console.log(`  Delete Duplicate (Retain Shards):   ${timings.deleteDuplicate.toFixed(1)} ms`);
  console.log(`  Delete Final Ref (Purge Shards):    ${timings.deleteFinal.toFixed(1)} ms\n`);

  await mongoose.disconnect();
  process.exit(0);
}

runE2ETests().catch(err => {
  console.error('\n❌ E2E Test Failure:', err);
  process.exit(1);
});
