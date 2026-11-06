import express from 'express';
import { 
  uploadFile, 
  getFiles, 
  getFileById, 
  getFileShardsDetails,
  downloadFile, 
  repairFileShardController,
  deleteFile, 
  uploadMiddleware 
} from '../controllers/fileController.js';
import { protect } from '../middleware/authMiddleware.js';
import { uploadLimiter } from '../middleware/rateLimiter.js';
import { logFileUpload } from '../middleware/terminalLogger.js';

import fs from 'fs';
import path from 'path';
import { File } from '../models/File.js';
import { FileShard } from '../models/FileShard.js';
import { isMongoConnected } from '../config/db.js';
import { selectOptimalNodes, writeNodeShard } from '../services/nodeService.js';
import { createShardsFromBuffer } from '../services/shardingService.js';
import { recordAuditEntry } from '../services/auditService.js';
import { memFiles, memShards } from '../controllers/fileController.js';
import { saveStoredFiles, saveStoredShards } from '../services/storeService.js';
import { StoredChunk } from '../models/StoredChunk.js';
import { memChunks, saveStoredChunks, invalidateDedupCache } from '../services/dedupService.js';

import {
  initResumableSession,
  appendResumableChunk,
  getResumableSessionStatus,
  finalizeResumableStream
} from '../services/streamingService.js';

const router = express.Router();

router.use(protect);

router.post('/upload', uploadLimiter, uploadMiddleware, uploadFile);

// Resumable Large-File Streaming routes
router.post('/upload/resumable/init', async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    const { fileName, originalFileSize, totalChunks, chunkSize, isPasswordProtected } = req.body;
    const session = initResumableSession({
      userId,
      fileName,
      originalFileSize,
      totalChunks,
      chunkSize,
      isPasswordProtected
    });
    return res.status(201).json({ success: true, session });
  } catch (err) {
    next(err);
  }
});

router.post('/upload/resumable/:sessionId/chunk/:chunkIndex', uploadMiddleware, async (req, res, next) => {
  try {
    const { sessionId, chunkIndex } = req.params;
    const { chunkHash } = req.body;
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No chunk buffer supplied.' });
    }
    const result = appendResumableChunk({
      sessionId,
      chunkIndex,
      chunkBuffer: req.file.buffer,
      expectedHash: chunkHash
    });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.get('/upload/resumable/:sessionId/status', (req, res, next) => {
  try {
    const status = getResumableSessionStatus(req.params.sessionId);
    return res.status(200).json({ success: true, status });
  } catch (err) {
    next(err);
  }
});

router.post('/upload/resumable/:sessionId/finalize', async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    const {
      wrappedDEK,
      kdf,
      kdfSalt,
      kdfIterations,
      baseNonce,
      originalFileHash,
      originalFileSize,
      mimetype = 'application/octet-stream'
    } = req.body || {};

    const userId = req.user ? (req.user._id || req.user.id) : null;
    const session = await finalizeResumableStream(sessionId);
    const { fullCiphertext, totalBytes, fullSha256 } = session;

    // Check for existing content-addressed chunk before writing physical shards to disk
    let existingChunk = null;
    if (isMongoConnected) {
      try { existingChunk = await StoredChunk.findOne({ chunkHash: fullSha256 }).lean(); } catch (e) {}
    }
    if (!existingChunk) {
      existingChunk = memChunks.find(c => c.chunkHash === fullSha256);
    }

    let canReuseShards = false;
    if (existingChunk && existingChunk.shards && Array.isArray(existingChunk.shards) && existingChunk.shards.length >= 6) {
      canReuseShards = existingChunk.shards.every(s => {
        const p = s.storagePath || s.filePath;
        return p && fs.existsSync(p);
      });
    }

    const fileIdStr = `file-${Date.now()}`;
    const shardRecords = [];
    let isDeduplicated = false;
    let shardsCountNum = 6;
    let currentRefCount = 1;

    if (canReuseShards) {
      // CONTENT-ADDRESSED DEDUPLICATION HIT:
      isDeduplicated = true;
      shardsCountNum = existingChunk.shards.length;
      currentRefCount = Math.max(2, (Number(existingChunk.refCount) || 1) + 1);

      for (const s of existingChunk.shards) {
        shardRecords.push({
          fileId: fileIdStr,
          chunkHash: fullSha256,
          shardIndex: s.shardIndex,
          shardType: s.shardType || (s.shardIndex <= 4 ? 'data' : 'parity'),
          shardHash: s.shardHash,
          nodeId: s.nodeId,
          provider: s.provider || 'local',
          bucket: s.bucket || null,
          objectKey: s.objectKey || `${fileIdStr}.shard.${s.shardIndex}`,
          shardSize: s.shardSize || s.size,
          size: s.shardSize || s.size,
          storagePath: s.storagePath,
          filePath: s.filePath || s.storagePath,
          status: 'active',
          lastVerifiedAt: new Date().toISOString(),
          verificationHistory: [{
            verifiedAt: new Date().toISOString(),
            status: 'passed',
            computedHash: s.shardHash
          }],
          repairHistory: []
        });
      }

      console.log(`[SECUREVAULT] [DEDUP-RESUMABLE] Content-addressed deduplication hit (hash: ${fullSha256.substring(0, 16)}...). Reused 6 physical shards, refCount=${currentRefCount}.`);
    } else {
      // NEW CHUNK: Select 6 nodes for Reed-Solomon 4+2
      const selectedNodes = await selectOptimalNodes(6);
      const shardsData = createShardsFromBuffer(fullCiphertext, 6, { shardingVersion: 2 });
      shardsCountNum = shardsData.length;
      const writtenShardPaths = [];

      try {
        const writePromises = shardsData.map(async (s, i) => {
          const targetNode = selectedNodes[i % selectedNodes.length];
          const targetNodeId = targetNode.nodeId || targetNode.id || `node-0${i + 1}`;
          const nodeStoragePath = path.join(process.cwd(), 'storage', targetNodeId);

          if (!fs.existsSync(nodeStoragePath)) {
            fs.mkdirSync(nodeStoragePath, { recursive: true });
          }

          const shardFilename = `${fileIdStr}.shard.${i + 1}`;
          const fullShardPath = path.join(nodeStoragePath, shardFilename);

          await writeNodeShard(targetNodeId, fullShardPath, s.data);
          writtenShardPaths.push(fullShardPath);

          const nodeProvider = targetNode.provider || (i < 2 ? 'aws-s3' : (i < 4 ? 'gcp-gcs' : 'azure-blob'));
          const nodeBucket = targetNode.emulatorBucket || (nodeProvider === 'aws-s3' ? 'securevault-aws-bucket' : (nodeProvider === 'gcp-gcs' ? 'securevault-gcp-bucket' : 'securevault-azure-container'));

          return {
            fileId: fileIdStr,
            chunkHash: fullSha256,
            shardIndex: s.index,
            shardType: s.shardType || (s.index <= 4 ? 'data' : 'parity'),
            shardHash: s.hash,
            nodeId: targetNodeId,
            provider: nodeProvider,
            bucket: nodeBucket,
            objectKey: shardFilename,
            shardSize: s.size,
            size: s.size,
            storagePath: fullShardPath,
            filePath: fullShardPath,
            status: 'active',
            lastVerifiedAt: new Date().toISOString(),
            verificationHistory: [{
              verifiedAt: new Date().toISOString(),
              status: 'passed',
              computedHash: s.hash
            }],
            repairHistory: []
          };
        });

        const results = await Promise.all(writePromises);
        results.sort((a, b) => a.shardIndex - b.shardIndex);
        shardRecords.push(...results);
      } catch (writeErr) {
        for (const p of writtenShardPaths) {
          try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
        }
        throw writeErr;
      }

      // Register new chunk in dedup store
      const chunkDoc = {
        chunkHash: fullSha256,
        chunkSize: totalBytes,
        refCount: 1,
        fileIds: [fileIdStr],
        shards: shardRecords,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString()
      };
      memChunks.push(chunkDoc);
      saveStoredChunks(memChunks);
    }

    const origSize = Number(originalFileSize) || totalBytes;
    const finalFile = {
      id: fileIdStr,
      userId,
      name: session.fileName || req.body.fileName || 'streamed_upload.bin',
      fileName: session.fileName || req.body.fileName || 'streamed_upload.bin',
      size: origSize,
      fileSize: origSize,
      ciphertextSize: totalBytes,
      ciphertextHash: fullSha256,
      type: mimetype,
      mimeType: mimetype,
      hash: originalFileHash || fullSha256,
      fileHash: fullSha256,
      cryptoVersion: 2,
      shardingVersion: 2,
      erasureCoding: 'reed-solomon',
      dataShards: 4,
      parityShards: 2,
      totalShards: 6,
      encryptedAt: new Date().toISOString(),
      shardsCount: shardsCountNum,
      shardCount: shardsCountNum,
      status: 'encrypted',
      isDeduplicated,
      deduplicationRatio: currentRefCount,
      wrappedDEK,
      kdf,
      kdfSalt,
      kdfIterations: Number(kdfIterations),
      baseNonce,
      originalFileHash,
      originalFileSize: origSize,
      isPasswordProtected: !!req.body.isPasswordProtected,
      nodeDistribution: shardRecords.map(r => r.nodeId)
    };

    if (isMongoConnected) {
      try {
        const fileDoc = await File.create({
          userId,
          fileName: finalFile.name,
          fileSize: origSize,
          mimeType: mimetype,
          fileHash: fullSha256,
          cryptoVersion: 2,
          shardingVersion: 2,
          erasureCoding: 'reed-solomon',
          dataShards: 4,
          parityShards: 2,
          totalShards: 6,
          encryptionAlgorithm: 'AES-256-GCM',
          wrappedDEK,
          kdf,
          kdfSalt,
          kdfIterations: Number(kdfIterations),
          baseNonce,
          originalFileHash,
          originalFileSize: origSize,
          isPasswordProtected: !!req.body.isPasswordProtected,
          isDeduplicated,
          deduplicationRatio: currentRefCount,
          shardCount: shardsCountNum,
          securityScore: 99
        });

        const dbShards = shardRecords.map(s => ({
          fileId: fileDoc._id,
          chunkHash: fullSha256,
          shardIndex: s.shardIndex,
          shardType: s.shardType,
          nodeId: s.nodeId,
          provider: s.provider,
          bucket: s.bucket,
          objectKey: s.objectKey,
          shardHash: s.shardHash,
          shardSize: s.shardSize,
          storagePath: s.storagePath,
          status: 'active',
          lastVerifiedAt: new Date(),
          verificationHistory: s.verificationHistory,
          repairHistory: []
        }));
        await FileShard.insertMany(dbShards);

        const dbFileIdStr = fileDoc._id.toString();
        if (isDeduplicated) {
          await StoredChunk.updateOne(
            { chunkHash: fullSha256 },
            {
              $set: { refCount: currentRefCount, lastAccessedAt: new Date() },
              $addToSet: { fileIds: dbFileIdStr }
            }
          ).catch(() => {});

          await File.updateMany(
            { $or: [{ fileHash: fullSha256 }, { ciphertextHash: fullSha256 }] },
            { $set: { isDeduplicated: true, deduplicationRatio: currentRefCount } }
          ).catch(() => {});

          for (const mf of memFiles) {
            if (mf.fileHash === fullSha256 || mf.ciphertextHash === fullSha256) {
              mf.isDeduplicated = true;
              mf.deduplicationRatio = currentRefCount;
            }
          }
          saveStoredFiles(memFiles);
        } else {
          await StoredChunk.findOneAndUpdate(
            { chunkHash: fullSha256 },
            {
              $set: {
                chunkHash: fullSha256,
                chunkSize: totalBytes,
                refCount: 1,
                fileIds: [dbFileIdStr],
                shards: shardRecords,
                lastAccessedAt: new Date()
              },
              $setOnInsert: {
                createdAt: new Date()
              }
            },
            { upsert: true, new: true }
          ).catch(() => {});

          const mcIdx = memChunks.findIndex(c => c.chunkHash === fullSha256);
          const chunkDoc = {
            chunkHash: fullSha256,
            chunkSize: totalBytes,
            refCount: 1,
            fileIds: [dbFileIdStr],
            shards: shardRecords,
            createdAt: new Date().toISOString(),
            lastAccessedAt: new Date().toISOString()
          };
          if (mcIdx !== -1) {
            memChunks[mcIdx] = chunkDoc;
          } else {
            memChunks.push(chunkDoc);
          }
          saveStoredChunks(memChunks);
        }
        invalidateDedupCache(userId);

        finalFile.id = fileDoc._id.toString();
      } catch (dbErr) {
        console.warn('[MongoDB Resumable Upload Warning]:', dbErr.message);
      }
    }

    // Idempotency guard: only persist if this fileId/content is not already in the store
    const alreadyExists = memFiles.findIndex(f => 
      f.id === finalFile.id || 
      (String(f.userId) === String(userId) && (f.fileName === finalFile.name || f.name === finalFile.name) && (f.fileHash === fullSha256 || f.hash === fullSha256))
    );
    if (alreadyExists !== -1) {
      memFiles[alreadyExists] = finalFile; // update in-place
    } else {
      memFiles.unshift(finalFile);
    }
    saveStoredFiles(memFiles);

    const existingShardIds = new Set(memShards.map(s => `${s.fileId}-${s.shardIndex}`));
    for (const sr of shardRecords) {
      if (!existingShardIds.has(`${finalFile.id}-${sr.shardIndex}`)) {
        memShards.push({ ...sr, fileId: finalFile.id });
      }
    }
    saveStoredShards(memShards);

    await recordAuditEntry({
      userId,
      action: 'FILE_UPLOADED_STREAM',
      title: 'Resumable File Streamed & Sharded',
      description: `Streamed & sharded "${finalFile.name}" (${(origSize / 1024).toFixed(1)} KB) via Reed-Solomon 4+2`,
      fileId: finalFile.id
    });

    logFileUpload(finalFile.name, 'AES-256-GCM', origSize, shardRecords.length, 'SUCCESS');

    return res.status(201).json({
      success: true,
      message: 'All chunks successfully assembled, encrypted, and sharded!',
      file: finalFile
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', getFiles);
router.post('/batch-rewrap', async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    const { updates } = req.body || {};

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Array of file key updates required.' });
    }

    let modifiedCount = 0;
    const updatedIds = [];

    for (const item of updates) {
      const { fileId, wrappedDEK, kdfSalt, kdfIterations } = item;
      if (!fileId || !wrappedDEK) continue;

      if (isMongoConnected) {
        try {
          const resMongo = await File.updateOne(
            { _id: fileId, userId },
            { 
              $set: { 
                wrappedDEK, 
                ...(kdfSalt ? { kdfSalt } : {}), 
                ...(kdfIterations ? { kdfIterations: Number(kdfIterations) } : {}) 
              } 
            }
          );
          if (resMongo.modifiedCount > 0) {
            modifiedCount++;
            updatedIds.push(fileId);
          }
        } catch (dbErr) {
          console.warn('[Batch Rewrap DB Warning]:', dbErr.message);
        }
      }

      // Also update local memFiles
      const idx = memFiles.findIndex(f => (f.id === fileId || String(f._id) === fileId) && String(f.userId) === String(userId));
      if (idx !== -1) {
        memFiles[idx].wrappedDEK = wrappedDEK;
        if (kdfSalt) memFiles[idx].kdfSalt = kdfSalt;
        if (kdfIterations) memFiles[idx].kdfIterations = Number(kdfIterations);
        if (!updatedIds.includes(fileId)) {
          modifiedCount++;
          updatedIds.push(fileId);
        }
      }
    }

    if (modifiedCount > 0) {
      saveStoredFiles(memFiles);
    }

    console.log(`[${new Date().toISOString()}] [SECUREVAULT] [KEY ROTATION] Rewrapped DEKs for ${modifiedCount} file(s) for user: ${userId}`);

    return res.status(200).json({
      success: true,
      message: `Successfully rewrapped ${modifiedCount} file(s).`,
      modifiedCount,
      updatedIds
    });
  } catch (err) {
    next(err);
  }
});
router.get('/:id/shards', getFileShardsDetails);
router.get('/:id', getFileById);
router.get('/:id/download', downloadFile);
router.post('/:id/repair-shard/:shardIndex', repairFileShardController);
router.delete('/:id', deleteFile);

export default router;
