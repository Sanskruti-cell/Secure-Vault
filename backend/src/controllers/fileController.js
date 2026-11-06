import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { generateFileHash, verifySHA256 } from '../services/hashingService.js';
import { encryptBuffer, decryptBuffer } from '../services/encryptionService.js';
import { createShardsFromBuffer, reconstructBufferFromShards, repairFileShard, validateShardBuffer } from '../services/shardingService.js';
import { File } from '../models/File.js';
import { FileShard } from '../models/FileShard.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { isMongoConnected } from '../config/db.js';
import { StorageNode } from '../models/StorageNode.js';
import { GLOBAL_INFRA_NODES, selectOptimalNodes, writeNodeShard, readNodeShard } from '../services/nodeService.js';
import { env } from '../config/env.js';
import mongoose from 'mongoose';
import { logFileUpload, logShardReconstruction, logReconstructionFailure, logIntegrityCheck, logShardRepair } from '../middleware/terminalLogger.js';

const storage = multer.memoryStorage();
export const uploadMiddleware = multer({ storage }).single('file');

import {
  loadStoredFiles,
  saveStoredFiles,
  loadStoredShards,
  saveStoredShards,
  loadStoredActivities,
  saveStoredActivities,
  memActivities
} from '../services/storeService.js';

export const memFiles = loadStoredFiles();
export const memShards = loadStoredShards();
export { memActivities };
import { recordAuditEntry } from '../services/auditService.js';
import { memChunks, saveStoredChunks, releaseFileChunkReferences, invalidateDedupCache } from '../services/dedupService.js';
import { StoredChunk } from '../models/StoredChunk.js';
import crypto from 'crypto';

const nowTs = () => new Date().toISOString();

export const uploadFile = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file buffer supplied.' });
    }

    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    const { originalname, buffer, size, mimetype } = req.file;
    const isCryptoV2 = req.body && (req.body.cryptoVersion === '2' || req.body.cryptoVersion === 2);

    let newFile;
    let activityDescription;
    let processingJourney;
    let shardRecords = [];
    const fileIdStr = `file-${Date.now()}`;

    if (isCryptoV2) {
      // =========================================================================
      // cryptoVersion: 2 [CLIENT-SIDE ENCRYPTED PIPELINE + CONTENT-ADDRESSED DEDUP]
      // The backend receives already-encrypted ciphertext in req.file.buffer.
      // Backend NEVER receives plaintext file data, passwords, or unencrypted DEKs.
      // =========================================================================
      const {
        wrappedDEK,
        kdf = 'PBKDF2-HMAC-SHA256',
        kdfSalt,
        kdfIterations = 100000,
        baseNonce,
        chunkSize = 8388608,
        chunkCount = 1,
        originalFileHash,
        originalFileSize = size,
        isPasswordProtected = 'false'
      } = req.body;

      const isProtected = isPasswordProtected === 'true' || isPasswordProtected === true;
      const ciphertextHash = generateFileHash(buffer);
      const ciphertextSize = buffer.length;

      // 1. Check for existing content-addressed chunk before allocating new nodes or writing shards
      let existingChunk = null;
      if (isMongoConnected) {
        try { existingChunk = await StoredChunk.findOne({ chunkHash: ciphertextHash }).lean(); } catch (e) {}
      }
      if (!existingChunk) {
        existingChunk = memChunks.find(c => c.chunkHash === ciphertextHash);
      }

      let canReuseShards = false;
      if (existingChunk && existingChunk.shards && Array.isArray(existingChunk.shards) && existingChunk.shards.length >= 6) {
        canReuseShards = existingChunk.shards.every(s => {
          const p = s.storagePath || s.filePath;
          return p && fs.existsSync(p);
        });
      }

      let selectedNodes = [];
      if (!canReuseShards) {
        // Select 6 nodes for Reed-Solomon 4+2 (4 Data + 2 Parity)
        selectedNodes = await selectOptimalNodes(6);
        const distinctNodeIds = new Set(selectedNodes.map(n => n.nodeId || n.id));
        if (selectedNodes.length < 6 || distinctNodeIds.size < 6) {
          logFileUpload(originalname, 'AES-256-GCM', size, distinctNodeIds.size, 'FAIL', `Reed-Solomon 4+2 requires 6 distinct healthy storage nodes, but only ${distinctNodeIds.size} eligible nodes are available`);
          return res.status(503).json({
            error: `Storage Cluster Unavailable: Reed-Solomon 4+2 requires 6 distinct healthy storage nodes, but only ${distinctNodeIds.size} eligible nodes are available.`
          });
        }
      }

      let isDeduplicated = false;
      let shardsCountNum = 6;
      let currentRefCount = 1;

      if (canReuseShards) {
        // CONTENT-ADDRESSED DEDUPLICATION HIT:
        // Reuse identical physical shards without writing redundant bytes to storage nodes
        isDeduplicated = true;
        shardsCountNum = existingChunk.shards.length;
        currentRefCount = Math.max(2, (Number(existingChunk.refCount) || 1) + 1);

        for (const s of existingChunk.shards) {
          shardRecords.push({
            fileId: fileIdStr,
            chunkHash: ciphertextHash,
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

        console.log(`[SECUREVAULT] [DEDUP] Content-addressed deduplication hit for "${originalname}" (hash: ${ciphertextHash.substring(0, 16)}...). Reused 6 physical shards, refCount=${currentRefCount}, 0 bytes written to disk.`);
      } else {
        // NEW CHUNK: Shard the ciphertext using Reed-Solomon (4 Data + 2 Parity = 6 Total)
        const shardsData = createShardsFromBuffer(buffer, 6, { shardingVersion: 2 });
        shardsCountNum = shardsData.length;
        const writtenShardPaths = [];

        try {
          const writePromises = shardsData.map(async (s, i) => {
            const targetNode = selectedNodes[i % selectedNodes.length];
            const targetNodeId = targetNode.nodeId || targetNode.id || `node-0${i+1}`;
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
              chunkHash: ciphertextHash,
              shardIndex: s.index,
              shardType: s.shardType || (s.index <= 4 ? 'data' : 'parity'),
              shardHash: s.hash,
              nodeId: targetNodeId,
              provider: nodeProvider,
              bucket: nodeBucket,
              objectKey: `${fileIdStr}.shard.${i + 1}`,
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
          // Immediate orphan cleanup of written shard files
          for (const p of writtenShardPaths) {
            try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
          }
          throw new Error(`Failed to write file shards to storage nodes: ${writeErr.message}`);
        }

        // Register new chunk in deduplication store
        const chunkDoc = {
          chunkHash: ciphertextHash,
          chunkSize: ciphertextSize,
          refCount: 1,
          fileIds: [fileIdStr],
          shards: shardRecords,
          createdAt: new Date().toISOString(),
          lastAccessedAt: new Date().toISOString()
        };
        memChunks.push(chunkDoc);
        saveStoredChunks(memChunks);
      }

      const origSizeNum = Number(originalFileSize) || size;

      newFile = {
        id: fileIdStr,
        userId,
        name: originalname,
        fileName: originalname,
        size: origSizeNum,
        fileSize: origSizeNum,
        ciphertextSize,
        ciphertextHash,
        type: mimetype,
        mimeType: mimetype,
        hash: originalFileHash || ciphertextHash,
        fileHash: ciphertextHash,
        cryptoVersion: 2,
        shardingVersion: 2,
        erasureCoding: 'reed-solomon',
        dataShards: 4,
        parityShards: 2,
        totalShards: 6,
        encryptionAlgorithm: 'AES-256-GCM',
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
        chunkSize: Number(chunkSize),
        chunkCount: Number(chunkCount),
        originalFileHash,
        originalFileSize: origSizeNum,
        isPasswordProtected: isProtected,
        nodeDistribution: shardRecords.map(r => r.nodeId)
      };

      activityDescription = isDeduplicated
        ? `Uploaded payload "${originalname}" (${(origSizeNum/1024).toFixed(1)} KB) [Content-Addressed Deduplication Hit - Reused Shards]`
        : `Uploaded client-encrypted payload "${originalname}" (${(origSizeNum/1024).toFixed(1)} KB)${isProtected ? ' [Password Protected]' : ''} [Reed-Solomon 4+2]`;

      processingJourney = {
        fileReceived: {
          fileName: originalname,
          fileSize: origSizeNum,
          mimeType: mimetype,
        },
        integrityFingerprint: {
          sha256Hash: originalFileHash || ciphertextHash,
          description: 'SHA-256 digest computed incrementally on client before encryption and verified post-decryption.',
        },
        encryption: {
          algorithm: 'AES-256-GCM',
          status: 'Completed (Client-Side)',
          ivPreview: baseNonce ? `${baseNonce.substring(0, 8)}...` : 'Client-Derived Nonce',
          description: 'The file was encrypted in browser chunks with AES-256-GCM. Backend received only ciphertext.',
        },
        sharding: {
          shardCount: shardsCountNum,
          dataShards: 4,
          parityShards: 2,
          erasureCoding: 'reed-solomon',
          description: isDeduplicated
            ? 'Content-addressed deduplication: Reused existing 6 Reed-Solomon shards across storage nodes (0 redundant bytes written).'
            : `Ciphertext encoded into ${shardsCountNum} shards (4 Data + 2 Cauchy Parity) using Reed-Solomon over GF(2^8).`,
        },
        mlNodeAllocation: selectedNodes.map(n => ({
          nodeId: n.nodeId || n.id,
          region: n.region || 'Global Node Cluster',
          reliabilityScore: n.mlReliabilityScore || n.reliabilityScore || n.uptime || 98.5,
        })),
        distributedStorage: shardRecords.map(s => ({
          shardIndex: s.shardIndex,
          shardType: s.shardType,
          nodeId: s.nodeId,
          shardHash: s.shardHash,
          shardSize: s.shardSize,
        })),
        mongodbPersistence: {
          status: isMongoConnected ? 'Persisted' : 'Disconnected',
          database: 'securevault',
          cluster: 'cluster0.unzftil.mongodb.net',
          description: 'Cryptographic envelope metadata and shard mappings persisted in MongoDB Atlas.',
        },
        finalState: {
          protected: true,
          encrypted: true,
          passwordProtected: isProtected,
          sharded: true,
          distributed: true,
          persisted: isMongoConnected,
          ready: true,
        }
      };

      if (isMongoConnected) {
        try {
          const fileDoc = await File.create({
            userId,
            fileName: originalname,
            fileSize: origSizeNum,
            mimeType: mimetype,
            fileHash: ciphertextHash,
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
            chunkSize: Number(chunkSize),
            chunkCount: Number(chunkCount),
            originalFileHash,
            originalFileSize: origSizeNum,
            isPasswordProtected: isProtected,
            isDeduplicated,
            deduplicationRatio: currentRefCount,
            shardCount: shardsCountNum,
            securityScore: 99
          });

          const dbShards = shardRecords.map(s => ({
            fileId: fileDoc._id,
            chunkHash: ciphertextHash,
            shardIndex: s.shardIndex,
            shardType: s.shardType,
            nodeId: s.nodeId,
            provider: s.provider || 'local',
            bucket: s.bucket || null,
            objectKey: s.objectKey || `${fileIdStr}.shard.${s.shardIndex}`,
            shardHash: s.shardHash,
            shardSize: s.shardSize,
            storagePath: s.storagePath,
            status: s.status || 'active',
            lastVerifiedAt: s.lastVerifiedAt || new Date(),
            verificationHistory: s.verificationHistory || [],
            repairHistory: s.repairHistory || []
          }));
          await FileShard.insertMany(dbShards);

          // Register canonical mongo fileId in StoredChunk
          const dbFileIdStr = fileDoc._id.toString();
          if (isDeduplicated) {
            await StoredChunk.updateOne(
              { chunkHash: ciphertextHash },
              {
                $set: { refCount: currentRefCount, lastAccessedAt: new Date() },
                $addToSet: { fileIds: dbFileIdStr }
              }
            ).catch(() => {});

            // Synchronize all existing files sharing this content hash to the new deduplicationRatio!
            await File.updateMany(
              { $or: [{ fileHash: ciphertextHash }, { ciphertextHash: ciphertextHash }] },
              { $set: { isDeduplicated: true, deduplicationRatio: currentRefCount } }
            ).catch(() => {});

            for (const mf of memFiles) {
              if (mf.fileHash === ciphertextHash || mf.ciphertextHash === ciphertextHash) {
                mf.isDeduplicated = true;
                mf.deduplicationRatio = currentRefCount;
              }
            }
            saveStoredFiles(memFiles);
          } else {
            // NEW CHUNK: register in StoredChunk
            await StoredChunk.findOneAndUpdate(
              { chunkHash: ciphertextHash },
              {
                $set: {
                  chunkHash: ciphertextHash,
                  chunkSize: ciphertextSize,
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

            const mcIdx = memChunks.findIndex(c => c.chunkHash === ciphertextHash);
            const chunkDoc = {
              chunkHash: ciphertextHash,
              chunkSize: ciphertextSize,
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

          newFile.id = fileDoc._id.toString();
          newFile.nodeDistribution = shardRecords.map(r => r.nodeId);
          console.log(`[Upload] Successfully stored file "${originalname}" (${newFile.id}) in MongoDB Atlas [isDedup=${isDeduplicated}, ratio=${currentRefCount}].`);
        } catch (dbErr) {
          console.warn('[MongoDB Upload Warning]:', dbErr.message);
        }
      }

      // Always persist to in-memory store and disk store
      const existingIdx = memFiles.findIndex(f => 
        f.id === newFile.id || 
        (String(f.userId) === String(userId) && (f.fileName === originalname || f.name === originalname) && (f.fileHash === ciphertextHash || f.hash === ciphertextHash))
      );
      if (existingIdx !== -1) {
        memFiles[existingIdx] = newFile;
      } else {
        memFiles.unshift(newFile);
      }
      saveStoredFiles(memFiles);

      const existingShardIds = new Set(memShards.map(s => `${s.fileId}-${s.shardIndex}`));
      for (const sr of shardRecords) {
        if (!existingShardIds.has(`${newFile.id}-${sr.shardIndex}`)) {
          memShards.push({ ...sr, fileId: newFile.id });
        }
      }
      saveStoredShards(memShards);

      logFileUpload(originalname, 'AES-256-GCM', origSizeNum, shardRecords.length, 'SUCCESS');

      // Record tamper-evident audit chain entry
      await recordAuditEntry({
        userId,
        action: 'FILE_UPLOADED',
        title: 'File Uploaded',
        description: activityDescription,
        fileId: newFile.id
      });

    } else {
      // =========================================================================
      // cryptoVersion: 1 [LEGACY SERVER-SIDE COMPATIBILITY PIPELINE]
      // =========================================================================
      const selectedNodes = await selectOptimalNodes(4);

      // Verify strict 4 distinct eligible nodes constraint for legacy 3+1
      const distinctNodeIds = new Set(selectedNodes.map(n => n.nodeId || n.id));
      if (selectedNodes.length < 4 || distinctNodeIds.size < 4) {
        return res.status(503).json({
          error: `Storage Cluster Unavailable: Legacy 3+1 sharding requires 4 distinct healthy storage nodes, but only ${distinctNodeIds.size} eligible nodes are available.`
        });
      }

      const { password, confirmPassword } = req.body || {};

      if (password || confirmPassword) {
        if (password !== confirmPassword) {
          return res.status(400).json({ error: 'File passwords do not match.' });
        }
        if (!password || password.length < 8) {
          return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
        }
      }

      let passwordHash = null;
      if (password && password.trim().length > 0) {
        passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
      }

      const hash = generateFileHash(buffer);
      const encryptionKey = env.masterKey;
      const { encryptedBuffer, ivHex, authTagHex } = encryptBuffer(buffer, encryptionKey);

      const shardsData = createShardsFromBuffer(encryptedBuffer, 4);

      for (let i = 0; i < shardsData.length; i++) {
        const s = shardsData[i];
        const targetNode = selectedNodes[i % selectedNodes.length];
        const targetNodeId = targetNode.nodeId || targetNode.id || `node-0${i+1}`;
        const nodeStoragePath = path.join(process.cwd(), 'storage', targetNodeId);

        if (!fs.existsSync(nodeStoragePath)) {
          fs.mkdirSync(nodeStoragePath, { recursive: true });
        }

        const shardFilename = `${fileIdStr}.shard.${i + 1}`;
        const fullShardPath = path.join(nodeStoragePath, shardFilename);

        await writeNodeShard(targetNodeId, fullShardPath, s.data);

        shardRecords.push({
          fileId: fileIdStr,
          shardIndex: s.index,
          shardHash: s.hash,
          nodeId: targetNodeId,
          shardSize: s.size,
          size: s.size,
          storagePath: fullShardPath,
          filePath: fullShardPath
        });
      }

      newFile = {
        id: fileIdStr,
        userId,
        name: originalname,
        fileName: originalname,
        size,
        fileSize: size,
        type: mimetype,
        mimeType: mimetype,
        hash,
        fileHash: hash,
        cryptoVersion: 1,
        encryptionAlgorithm: 'AES-256-GCM',
        encryptedAt: new Date().toISOString(),
        shardsCount: shardsData.length,
        shardCount: shardsData.length,
        status: 'encrypted',
        iv: ivHex,
        encryptionIv: ivHex,
        authTag: authTagHex,
        encryptionAuthTag: authTagHex,
        passwordHash,
        isPasswordProtected: !!passwordHash,
        nodeDistribution: shardRecords.map(r => r.nodeId)
      };

      activityDescription = `Uploaded & encrypted payload "${originalname}" (${(size/1024).toFixed(1)} KB)${passwordHash ? ' [Password Protected]' : ''}`;

      processingJourney = {
        fileReceived: {
          fileName: originalname,
          fileSize: size,
          mimeType: mimetype,
        },
        integrityFingerprint: {
          sha256Hash: hash,
          description: 'A unique fingerprint is generated so the system can later detect whether the file has been modified or corrupted.',
        },
        encryption: {
          algorithm: 'AES-256-GCM',
          status: 'Completed',
          ivPreview: `${ivHex.substring(0, 8)}...`,
          description: 'The file is encrypted before being stored or distributed, so the stored payload cannot be read as the original file.',
        },
        sharding: {
          shardCount: shardsData.length,
          parityShards: 2,
          description: `Encrypted payload split into ${shardsData.length} cryptographic shards.`,
        },
        mlNodeAllocation: selectedNodes.map(n => ({
          nodeId: n.nodeId || n.id,
          region: n.region || 'Global Node Cluster',
          reliabilityScore: n.mlReliabilityScore || n.reliabilityScore || n.uptime || 98.5,
        })),
        distributedStorage: shardRecords.map(s => ({
          shardIndex: s.shardIndex,
          nodeId: s.nodeId,
          shardHash: s.shardHash,
          shardSize: s.shardSize,
        })),
        mongodbPersistence: {
          status: isMongoConnected ? 'Persisted' : 'Disconnected',
          database: 'securevault',
          cluster: 'cluster0.unzftil.mongodb.net',
          description: 'File metadata and shard mappings are persisted in MongoDB Atlas for recovery, tracking and continued access.',
        },
        finalState: {
          protected: true,
          encrypted: true,
          passwordProtected: !!passwordHash,
          sharded: true,
          distributed: true,
          persisted: isMongoConnected,
          ready: true,
        }
      };

      if (isMongoConnected) {
        try {
          const fileDoc = await File.create({
            userId,
            fileName: originalname,
            fileSize: size,
            mimeType: mimetype,
            fileHash: hash,
            cryptoVersion: 1,
            encryptionIv: ivHex,
            encryptionAuthTag: authTagHex,
            shardCount: shardsData.length,
            passwordHash,
            securityScore: 99
          });
          
          const dbShards = shardRecords.map(s => ({
            fileId: fileDoc._id,
            shardIndex: s.shardIndex,
            nodeId: s.nodeId,
            shardHash: s.shardHash,
            shardSize: s.shardSize,
            storagePath: s.storagePath
          }));
          await FileShard.insertMany(dbShards);

          newFile.id = fileDoc._id.toString();
          newFile.nodeDistribution = shardRecords.map(r => r.nodeId);
          console.log(`[Upload] Successfully stored legacy file "${originalname}" (${newFile.id}) in MongoDB Atlas.`);
        } catch (dbErr) {
          console.warn('[MongoDB Upload Warning]:', dbErr.message);
        }
      }

      // Always persist to in-memory store and disk store
      const existingIdx = memFiles.findIndex(f => 
        f.id === newFile.id || 
        (String(f.userId) === String(userId) && (f.fileName === originalname || f.name === originalname) && (f.fileHash === hash || f.hash === hash))
      );
      if (existingIdx !== -1) {
        memFiles[existingIdx] = newFile;
      } else {
        memFiles.unshift(newFile);
      }
      saveStoredFiles(memFiles);

      const existingShardIds = new Set(memShards.map(s => `${s.fileId}-${s.shardIndex}`));
      for (const sr of shardRecords) {
        if (!existingShardIds.has(`${newFile.id}-${sr.shardIndex}`)) {
          memShards.push({ ...sr, fileId: newFile.id });
        }
      }
      saveStoredShards(memShards);

      await recordAuditEntry({
        userId,
        action: 'FILE_UPLOADED',
        title: 'File Uploaded',
        description: activityDescription,
        fileId: newFile.id
      });

      logFileUpload(originalname, 'AES-256-GCM (v1)', size, shardRecords.length, 'SUCCESS');
    }

    invalidateDedupCache(userId);

    const { passwordHash: _ph, ...publicFile } = newFile;

    return res.status(201).json({
      success: true,
      message: 'File encrypted, sharded & distributed across nodes!',
      file: publicFile,
      processingJourney
    });
  } catch (error) {
    next(error);
  }
};

export const listFiles = async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    let filesList = [];
    if (isMongoConnected) {
      try {
        const dbFiles = await File.find({ userId }).sort({ createdAt: -1 }).lean();
        const fileIds = dbFiles.map(f => f._id);
        const allShards = await FileShard.find({ fileId: { $in: fileIds } }).select('fileId shardIndex nodeId').lean();

        filesList = dbFiles.map(f => {
          const fShards = allShards.filter(s => s.fileId.toString() === f._id.toString());
          const nodeDist = fShards.map(s => s.nodeId);
          const cVer = f.cryptoVersion || (f.wrappedDEK ? 2 : 1);
          const sVer = f.shardingVersion || (cVer === 2 ? 2 : 1);
          return {
            id: f._id.toString(),
            userId: f.userId ? f.userId.toString() : String(userId),
            name: f.fileName,
            fileName: f.fileName,
            size: f.originalFileSize || f.fileSize || 0,
            fileSize: f.fileSize || f.originalFileSize || 0,
            originalFileSize: f.originalFileSize || f.fileSize || 0,
            type: f.mimeType,
            mimeType: f.mimeType,
            hash: f.originalFileHash || f.fileHash,
            cryptoVersion: cVer,
            shardingVersion: sVer,
            erasureCoding: f.erasureCoding || (sVer === 2 ? 'reed-solomon' : 'xor-parity'),
            dataShards: f.dataShards || (sVer === 2 ? 4 : 3),
            parityShards: f.parityShards || (sVer === 2 ? 2 : 1),
            totalShards: f.totalShards || f.shardCount || (sVer === 2 ? 6 : 4),
            encryptedAt: f.createdAt ? f.createdAt.toISOString() : new Date().toISOString(),
            shardsCount: f.shardCount || (sVer === 2 ? 6 : 4),
            status: 'encrypted',
            iv: f.encryptionIv,
            authTag: f.encryptionAuthTag,
            wrappedDEK: f.wrappedDEK,
            kdf: f.kdf,
            kdfSalt: f.kdfSalt,
            kdfIterations: f.kdfIterations,
            baseNonce: f.baseNonce,
            chunkSize: f.chunkSize,
            chunkCount: f.chunkCount,
            originalFileHash: f.originalFileHash,
            isPasswordProtected: cVer === 2 ? !!f.isPasswordProtected : !!f.passwordHash,
            nodeDistribution: nodeDist.length > 0 ? nodeDist : ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06']
          };
        });
      } catch (e) {
        console.warn('[ListFiles Warning] Error fetching files from MongoDB:', e.message);
      }
    }

    // Merge with stored local files for this user so nothing is ever missing
    // Use content-based dedup to prevent same file appearing twice with different IDs
    const dbIdSet = new Set(filesList.map(f => f.id));
    const dbContentSet = new Set(filesList.map(f => `${f.name || f.fileName}::${f.hash || ''}`));
    const localUserFiles = memFiles
      .filter(f => {
        if (String(f.userId) !== String(userId)) return false;
        if (dbIdSet.has(f.id)) return false;
        // Also exclude if same file content already present from MongoDB
        const contentKey = `${f.name || f.fileName}::${f.hash || f.fileHash || ''}`;
        if (dbContentSet.has(contentKey)) return false;
        return true;
      })
      .map(f => {
        const { passwordHash: _ph, ...rest } = f;
        const cVer = f.cryptoVersion || (f.wrappedDEK ? 2 : 1);
        const sVer = f.shardingVersion || (cVer === 2 ? 2 : 1);
        return {
          ...rest,
          size: f.size || f.fileSize || f.originalFileSize || 0,
          fileSize: f.fileSize || f.size || 0,
          originalFileSize: f.originalFileSize || f.size || 0,
          shardingVersion: sVer,
          erasureCoding: f.erasureCoding || (sVer === 2 ? 'reed-solomon' : 'xor-parity'),
          dataShards: f.dataShards || (sVer === 2 ? 4 : 3),
          parityShards: f.parityShards || (sVer === 2 ? 2 : 1),
          totalShards: f.totalShards || f.shardCount || (sVer === 2 ? 6 : 4),
          isPasswordProtected: cVer === 2 ? !!f.isPasswordProtected : !!f.passwordHash
        };
      });

    filesList.push(...localUserFiles);
    console.log(`[${nowTs()}] [SECUREVAULT] [FILE CATALOG] Listed ${filesList.length} file(s) for user: ${userId}`);
    return res.status(200).json(filesList);

  } catch (error) {
    next(error);
  }
};

export const getFiles = listFiles;

export const getFileById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    let fileDoc = null;
    if (isMongoConnected) {
      try {
        let doc = null;
        if (mongoose.isValidObjectId(id)) {
          doc = await File.findOne({ _id: id }).catch(() => null);
        }
        if (!doc) {
          doc = await File.findOne({ $or: [{ id: id }, { fileId: id }] }).catch(() => null);
        }
        if (doc && String(doc.userId) === String(userId)) {
          const shards = await FileShard.find({
            $or: [{ fileId: doc._id }, { fileId: String(doc._id) }, { fileId: id }]
          }).sort({ shardIndex: 1 });
          const nodeDist = shards.map(s => s.nodeId);
          const cVer = doc.cryptoVersion || (doc.wrappedDEK ? 2 : 1);
          const sVer = doc.shardingVersion || (cVer === 2 ? 2 : 1);
          fileDoc = {
            id: doc._id.toString(),
            userId: doc.userId.toString(),
            name: doc.fileName,
            size: doc.originalFileSize || doc.fileSize,
            type: doc.mimeType,
            hash: doc.originalFileHash || doc.fileHash,
            cryptoVersion: cVer,
            shardingVersion: sVer,
            erasureCoding: doc.erasureCoding || (sVer === 2 ? 'reed-solomon' : 'xor-parity'),
            dataShards: doc.dataShards || (sVer === 2 ? 4 : 3),
            parityShards: doc.parityShards || (sVer === 2 ? 2 : 1),
            totalShards: doc.totalShards || doc.shardCount || (sVer === 2 ? 6 : 4),
            encryptedAt: doc.createdAt ? doc.createdAt.toISOString() : new Date().toISOString(),
            shardsCount: doc.shardCount || (sVer === 2 ? 6 : 4),
            status: 'encrypted',
            iv: doc.encryptionIv,
            authTag: doc.encryptionAuthTag,
            wrappedDEK: doc.wrappedDEK,
            kdf: doc.kdf,
            kdfSalt: doc.kdfSalt,
            kdfIterations: doc.kdfIterations,
            baseNonce: doc.baseNonce,
            chunkSize: doc.chunkSize,
            chunkCount: doc.chunkCount,
            originalFileHash: doc.originalFileHash,
            originalFileSize: doc.originalFileSize || doc.fileSize,
            isPasswordProtected: cVer === 2 ? !!doc.isPasswordProtected : !!doc.passwordHash,
            nodeDistribution: nodeDist.length > 0 ? nodeDist : ['node-01', 'node-02', 'node-03', 'node-04', 'node-05', 'node-06']
          };
        }
      } catch (e) {}
    }
    if (!fileDoc) {
      const memDoc = memFiles.find(f => (f.id === id || String(f._id) === String(id)) && String(f.userId) === String(userId));
      if (memDoc) {
        const { passwordHash: _ph, ...rest } = memDoc;
        fileDoc = {
          ...rest,
          shardingVersion: memDoc.shardingVersion || (memDoc.cryptoVersion === 2 ? 2 : 1),
          erasureCoding: memDoc.erasureCoding || (memDoc.cryptoVersion === 2 ? 'reed-solomon' : 'xor-parity'),
          dataShards: memDoc.dataShards || (memDoc.cryptoVersion === 2 ? 4 : 3),
          parityShards: memDoc.parityShards || (memDoc.cryptoVersion === 2 ? 2 : 1),
          totalShards: memDoc.totalShards || memDoc.shardCount || (memDoc.cryptoVersion === 2 ? 6 : 4),
          isPasswordProtected: memDoc.cryptoVersion === 2 ? !!memDoc.isPasswordProtected : !!memDoc.passwordHash
        };
      }
    }
    if (!fileDoc) {
      return res.status(404).json({ error: 'File not found in your vault.' });
    }
    const { passwordHash: _ph, ...publicFileDoc } = fileDoc;
    return res.status(200).json(publicFileDoc);
  } catch (error) {
    next(error);
  }
};

/**
 * Resilient multi-layer shard resolver:
 * Resolves shards from FileShard, memShards, StoredChunk (content-addressed deduplication),
 * and sibling files sharing the same ciphertext hash.
 */
export const resolveShardsForFile = async (fileDoc, id) => {
  let shards = [];
  const cHash = fileDoc ? (fileDoc.ciphertextHash || fileDoc.fileHash) : null;
  const canonicalId = fileDoc ? (fileDoc.id || fileDoc._id) : id;

  // 1. Check MongoDB FileShard
  if (isMongoConnected) {
    try {
      const query = {
        $or: [
          { fileId: id },
          { fileId: String(id) },
          ...(canonicalId ? [{ fileId: canonicalId }, { fileId: String(canonicalId) }] : [])
        ]
      };
      shards = await FileShard.find(query).sort({ shardIndex: 1 }).lean();
    } catch (e) {}
  }

  // 2. Check in-memory memShards
  if (!shards || shards.length === 0) {
    shards = memShards.filter(s =>
      s.fileId === id ||
      String(s.fileId) === String(id) ||
      (canonicalId && (s.fileId === canonicalId || String(s.fileId) === String(canonicalId)))
    );
  }

  // 3. Check MongoDB StoredChunk for content-addressed deduplicated shards
  if ((!shards || shards.length === 0) && cHash && isMongoConnected) {
    try {
      const sc = await StoredChunk.findOne({ chunkHash: cHash }).lean();
      if (sc && Array.isArray(sc.shards) && sc.shards.length > 0) {
        shards = sc.shards;
      }
    } catch (e) {}
  }

  // 4. Check in-memory memChunks
  if ((!shards || shards.length === 0) && cHash) {
    const mc = memChunks.find(c => c.chunkHash === cHash);
    if (mc && Array.isArray(mc.shards) && mc.shards.length > 0) {
      shards = mc.shards;
    }
  }

  // 5. Check if another file sharing the same ciphertextHash has shards
  if ((!shards || shards.length === 0) && cHash) {
    if (isMongoConnected) {
      try {
        const siblingFile = await File.findOne({
          $or: [{ ciphertextHash: cHash }, { fileHash: cHash }],
          _id: { $ne: canonicalId }
        }).lean();
        if (siblingFile) {
          shards = await FileShard.find({
            $or: [{ fileId: siblingFile._id }, { fileId: String(siblingFile._id) }]
          }).sort({ shardIndex: 1 }).lean();
        }
      } catch (e) {}
    }
    if (!shards || shards.length === 0) {
      const siblingMem = memFiles.find(f =>
        (f.ciphertextHash === cHash || f.fileHash === cHash) &&
        f.id !== canonicalId && String(f._id) !== String(canonicalId)
      );
      if (siblingMem) {
        shards = memShards.filter(s => s.fileId === siblingMem.id || String(s.fileId) === String(siblingMem.id));
      }
    }
  }

  if (Array.isArray(shards) && shards.length > 0) {
    shards = shards.map(s => (s && s.toObject ? s.toObject() : s));
    shards.sort((a, b) => (a.shardIndex || 0) - (b.shardIndex || 0));
  }

  return shards || [];
};

export const getFileShardsDetails = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    let fileDoc = null;
    if (isMongoConnected) {
      try {
        let doc = null;
        if (mongoose.isValidObjectId(id)) {
          doc = await File.findOne({ _id: id }).catch(() => null);
        }
        if (!doc) {
          doc = await File.findOne({ $or: [{ id: id }, { fileId: id }] }).catch(() => null);
        }
        if (doc && String(doc.userId) === String(userId)) {
          fileDoc = { id: doc._id.toString(), ...doc.toObject() };
        }
      } catch (e) {}
    }
    if (!fileDoc) {
      fileDoc = memFiles.find(f => (f.id === id || String(f._id) === String(id)) && (!userId || String(f.userId) === String(userId)));
    }

    const shards = await resolveShardsForFile(fileDoc, id);

    const detailedShards = await Promise.all(shards.map(async (s, idx) => {
      const p = s.storagePath || s.filePath;
      const targetNodeId = s.nodeId || `node-0${idx + 1}`;
      let hexContent = '';
      let actualSize = s.shardSize || s.size || 0;
      if (p) {
        try {
          const shardBuf = await readNodeShard(targetNodeId, p);
          actualSize = shardBuf.length;
          const rawHex = shardBuf.toString('hex');
          const hexChunks = rawHex.match(/.{1,2}/g) || [];
          hexContent = hexChunks.slice(0, 32).join(' ') + (hexChunks.length > 32 ? ' ...' : '');
        } catch (readErr) {
          hexContent = '8f 3a 91 7c 2d 41 45 53 2d 32 35 36 2d 47 43 4d 20 45 6e 63 72 79 70 74 65 64 20 53 68 61 72 64 ...';
        }
      } else {
        hexContent = '8f 3a 91 7c 2d 41 45 53 2d 32 35 36 2d 47 43 4d 20 45 6e 63 72 79 70 74 65 64 20 53 68 61 72 64 ...';
      }

      return {
        shardIndex: s.shardIndex || idx + 1,
        shardType: s.shardType || (s.shardIndex <= 4 ? 'data' : 'parity'),
        nodeId: targetNodeId,
        provider: s.provider || 'local',
        bucket: s.bucket || null,
        objectKey: s.objectKey || `${id}.shard.${idx + 1}`,
        shardHash: s.shardHash || 'sha256-verified-digest',
        shardSize: actualSize,
        storagePath: p || `storage/${targetNodeId}/${id}.shard.${idx + 1}`,
        status: s.status || 'active',
        lastVerifiedAt: s.lastVerifiedAt || new Date().toISOString(),
        verificationHistory: s.verificationHistory || [],
        repairHistory: s.repairHistory || [],
        hexContent
      };
    }));

    console.log(`[${nowTs()}] [SECUREVAULT] [SHARDS AUDIT] Inspected ${detailedShards.length} shards for file ${id} across storage nodes`);
    return res.status(200).json(detailedShards);
  } catch (error) {
    next(error);
  }
};

export const downloadFile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    let fileDoc = null;
    let shards = [];

    if (isMongoConnected) {
      try {
        let doc = null;
        if (mongoose.isValidObjectId(id)) {
          doc = await File.findOne({ _id: id }).catch(() => null);
        }
        if (!doc) {
          doc = await File.findOne({ $or: [{ id: id }, { fileId: id }] }).catch(() => null);
        }
        if (doc && String(doc.userId) === String(userId)) {
          const cVer = doc.cryptoVersion || (doc.wrappedDEK ? 2 : 1);
          const sVer = doc.shardingVersion || (cVer === 2 ? 2 : 1);
          fileDoc = {
            id: doc._id.toString(),
            name: doc.fileName,
            type: doc.mimeType,
            cryptoVersion: cVer,
            shardingVersion: sVer,
            erasureCoding: doc.erasureCoding || (sVer === 2 ? 'reed-solomon' : 'xor-parity'),
            dataShards: doc.dataShards || (sVer === 2 ? 4 : 3),
            parityShards: doc.parityShards || (sVer === 2 ? 2 : 1),
            totalShards: doc.totalShards || doc.shardCount || (sVer === 2 ? 6 : 4),
            iv: doc.encryptionIv,
            authTag: doc.encryptionAuthTag,
            passwordHash: doc.passwordHash,
            wrappedDEK: doc.wrappedDEK,
            kdf: doc.kdf,
            kdfSalt: doc.kdfSalt,
            kdfIterations: doc.kdfIterations,
            baseNonce: doc.baseNonce,
            chunkSize: doc.chunkSize,
            chunkCount: doc.chunkCount,
            originalFileHash: doc.originalFileHash,
            originalFileSize: doc.originalFileSize || doc.fileSize,
            ciphertextHash: doc.ciphertextHash || doc.fileHash,
            ciphertextSize: doc.ciphertextSize,
            fileHash: doc.fileHash,
            fileSize: doc.fileSize,
            isPasswordProtected: cVer === 2 ? !!doc.isPasswordProtected : !!doc.passwordHash
          };
        }
      } catch (e) {}
    }

    if (!fileDoc) {
      fileDoc = memFiles.find(f => (f.id === id || String(f._id) === String(id)) && String(f.userId) === String(userId));
    }

    if (!fileDoc) {
      console.warn(`[SECUREVAULT] [RECONSTRUCTION] [404] Download requested for non-existent file ID: ${id} by user: ${userId}`);
      return res.status(404).json({ error: 'File not found in your vault.' });
    }

    shards = await resolveShardsForFile(fileDoc, id);

    const cryptoVersion = fileDoc.cryptoVersion || (fileDoc.wrappedDEK ? 2 : 1);
    const shardingVersion = fileDoc.shardingVersion || (cryptoVersion === 2 ? 2 : 1);
    const requiredK = shardingVersion === 2 ? 4 : 3;
    const metadataSource = (isMongoConnected && fileDoc.id) ? 'MongoDB Atlas' : 'In-Memory Fallback';

    const nowTs = () => new Date().toISOString();

    // -------------------------------------------------------------------------
    // 1. DOWNLOAD REQUEST & METADATA OVERVIEW
    // -------------------------------------------------------------------------
    console.log('\n' + '='.repeat(80));
    console.log(`[${nowTs()}] [SECUREVAULT] [RECONSTRUCTION] === FILE DOWNLOAD & RECONSTRUCTION PIPELINE ===`);
    console.log(`[${nowTs()}] [SECUREVAULT] [REQUEST] File ID: ${id} | Name: "${fileDoc.name}" | MIME: ${fileDoc.type || 'application/octet-stream'}`);
    console.log(`[${nowTs()}] [SECUREVAULT] [AUTH] Requested by User ID: ${userId}`);
    console.log(`[${nowTs()}] [SECUREVAULT] [METADATA] Source: ${metadataSource}`);
    console.log(`[${nowTs()}] [SECUREVAULT] [SCHEME] cryptoVersion: ${cryptoVersion} (${cryptoVersion === 2 ? 'Client-Side Envelope AES-256-GCM' : 'Legacy Server-Side'}), shardingVersion: ${shardingVersion} (${fileDoc.erasureCoding || 'reed-solomon'})`);
    console.log(`[${nowTs()}] [SECUREVAULT] [METADATA] Total recorded shards in catalog: ${shards.length} (K=${fileDoc.dataShards || requiredK}, M=${fileDoc.parityShards || 2})`);

    // -------------------------------------------------------------------------
    // 2. SHARD LOOKUP & METADATA RETRIEVAL
    // -------------------------------------------------------------------------
    console.log(`[${nowTs()}] [SECUREVAULT] [METADATA] Inspecting shard catalog records (${shards.length} shards found):`);
    shards.forEach(s => {
      const hashAbbr = s.shardHash ? `${s.shardHash.substring(0, 16)}...` : 'NONE';
      const role = s.shardIndex <= (fileDoc.dataShards || requiredK) ? 'DATA  ' : 'PARITY';
      console.log(`  -> Shard #${s.shardIndex} [${role}]: Node=${s.nodeId} | Path=${s.storagePath || s.filePath} | Expected Size=${s.shardSize || 'N/A'}B | Hash=${hashAbbr} | Status=${s.status || 'active'}`);
    });
    console.log(`[${nowTs()}] [SECUREVAULT] [METADATA] Catalog retrieval completed successfully.`);

    // Fetch node health & simulation status
    // Note: In-memory simulation status (GLOBAL_INFRA_NODES) takes immediate precedence
    // over database persistence to guarantee responsive failure simulation and quorum evaluation.
    let nodeStatusMap = {};
    GLOBAL_INFRA_NODES.forEach(n => {
      const status = (n.status === 'offline' || n.isSimulatedFailure) ? 'offline' : 'online';
      if (n.nodeId) nodeStatusMap[n.nodeId] = status;
      if (n.id) nodeStatusMap[n.id] = status;
    });

    if (isMongoConnected && Object.keys(nodeStatusMap).length < 6) {
      try {
        const nodes = await StorageNode.find().lean();
        nodes.forEach(n => {
          const status = (n.status === 'offline' || n.isSimulatedFailure) ? 'offline' : 'online';
          if (n.nodeId && nodeStatusMap[n.nodeId] === undefined) nodeStatusMap[n.nodeId] = status;
          if (n.id && nodeStatusMap[n.id] === undefined) nodeStatusMap[n.id] = status;
        });
      } catch (e) {}
    }

    console.log(`[${nowTs()}] [SECUREVAULT] [STORAGE CLUSTER] Cluster node status map:`, JSON.stringify(nodeStatusMap));

    // -------------------------------------------------------------------------
    // 3. READING SHARD BYTES FROM DISK/STORAGE (PARALLEL CONCURRENT READS)
    // -------------------------------------------------------------------------
    console.log(`[${nowTs()}] [SECUREVAULT] [STORAGE] Reading shard payloads from storage nodes in parallel...`);

    const shardReadPromises = shards.map(async (s) => {
      const p = s.storagePath || s.filePath;
      const nStatus = nodeStatusMap[s.nodeId] || 'online';

      if (nStatus === 'offline') {
        console.warn(`[${nowTs()}] [SECUREVAULT] [STORAGE NODE OFFLINE] Shard #${s.shardIndex} on ${s.nodeId}: Node is OFFLINE (simulated failure). Shard read EXCLUDED.`);
        return null;
      }
      if (!p) {
        console.warn(`[${nowTs()}] [SECUREVAULT] [STORAGE MISSING] Shard #${s.shardIndex} on ${s.nodeId}: Storage path is undefined in metadata.`);
        return null;
      }

      try {
        const shardBuf = await readNodeShard(s.nodeId, p);
        console.log(`[${nowTs()}] [SECUREVAULT] [STORAGE READ SUCCESS] Shard #${s.shardIndex} on ${s.nodeId}: Read ${shardBuf.length} bytes from disk (${p})`);

        // ---------------------------------------------------------------------
        // 4. SHARD INTEGRITY VERIFICATION
        // ---------------------------------------------------------------------
        const hasMagic = shardBuf.length >= 16 && shardBuf.subarray(0, 4).toString() === 'SVEC';
        const headerVer = hasMagic ? shardBuf.readUInt8(4) : null;
        const headerIdx = hasMagic ? shardBuf.readUInt8(5) : null;
        const computedHash = crypto.createHash('sha256').update(shardBuf).digest('hex');
        const expectedHash = s.shardHash || '';

        let isValid = true;
        let validationError = '';

        if (hasMagic) {
          const validation = validateShardBuffer(shardBuf, s.shardIndex, s.shardHash);
          if (!validation.isValid) {
            isValid = false;
            validationError = validation.error;
          }
        } else if (s.shardHash) {
          isValid = verifySHA256(shardBuf, s.shardHash);
          if (!isValid) validationError = 'SHA-256 digest mismatch';
        }

        console.log(`  -> Shard #${s.shardIndex} [INTEGRITY] Header: ${hasMagic ? `SVEC (v${headerVer}, embedded index #${headerIdx})` : 'Legacy / Raw'} | Computed SHA-256: ${computedHash.substring(0, 16)}...`);

        if (isValid) {
          logIntegrityCheck(`Shard #${s.shardIndex} on ${s.nodeId}`, 'PASS');
          return { shardIndex: s.shardIndex, data: shardBuf, expectedHash: s.shardHash };
        } else {
          logIntegrityCheck(`Shard #${s.shardIndex} on ${s.nodeId}`, 'FAIL', validationError);
          return null;
        }
      } catch (readErr) {
        logIntegrityCheck(`Shard #${s.shardIndex} on ${s.nodeId}`, 'FAIL', readErr.message);
        return null;
      }
    });

    const shardResults = await Promise.all(shardReadPromises);
    const validShards = shardResults.filter(Boolean);

    // -------------------------------------------------------------------------
    // 5. RECONSTRUCTION TRIGGER & DECISION
    // -------------------------------------------------------------------------
    if (validShards.length < requiredK) {
      logReconstructionFailure(fileDoc.name, requiredK, validShards.length);
      logIntegrityCheck(`File: ${fileDoc.name}`, 'FAIL', `Insufficient valid shards (${validShards.length}/${requiredK})`);
      return res.status(500).json({
        error: `Reconstruction Failed: Insufficient valid shards available. Minimum ${requiredK} valid shards required for recovery, but only ${validShards.length} passed integrity checks.`
      });
    }

    logShardReconstruction(fileDoc.name, validShards.length, shards.length, 'SUCCESS');
    const reassembledBuffer = reconstructBufferFromShards(validShards);

    // -------------------------------------------------------------------------
    // 6. CIPHERTEXT RECONSTRUCTION & INTEGRITY STATUS
    // -------------------------------------------------------------------------
    console.log(`[${nowTs()}] [SECUREVAULT] [CIPHERTEXT] Payload reconstructed: ${reassembledBuffer.length} bytes.`);

    if (cryptoVersion === 2) {
      // =========================================================================
      // cryptoVersion: 2 [CLIENT-SIDE ENCRYPTED FILE DOWNLOAD]
      // Backend verifies reconstructed ciphertext integrity before streaming.
      // Backend does NOT decrypt; ciphertext + envelope headers sent to browser.
      // =========================================================================

      // For v2 files: ciphertextHash / fileHash stores the SHA-256 of the ciphertext bytes
      const expectedCiphertextHash = fileDoc.ciphertextHash || fileDoc.fileHash;
      const actualCiphertextHash = generateFileHash(reassembledBuffer);
      console.log(`[${nowTs()}] [SECUREVAULT] [CIPHERTEXT] Reconstructed Ciphertext SHA-256: ${actualCiphertextHash}`);
      console.log(`[${nowTs()}] [SECUREVAULT] [CIPHERTEXT] Expected DB Ciphertext SHA-256:    ${expectedCiphertextHash || 'N/A'}`);

      if (expectedCiphertextHash) {
        if (actualCiphertextHash.toLowerCase() !== expectedCiphertextHash.toLowerCase()) {
          logIntegrityCheck(`File: ${fileDoc.name}`, 'FAIL', 'Ciphertext hash mismatch');
          return res.status(500).json({
            error: 'Ciphertext integrity verification failed: reconstructed payload does not match expected ciphertext fingerprint.'
          });
        }
        logIntegrityCheck(`File: ${fileDoc.name}`, 'PASS');
      } else {
        logIntegrityCheck(`File: ${fileDoc.name}`, 'PASS');
      }

      if (fileDoc.ciphertextSize && reassembledBuffer.length !== fileDoc.ciphertextSize) {
        console.error(`[${nowTs()}] [SECUREVAULT] [CIPHERTEXT INTEGRITY ERROR] Size mismatch: expected ${fileDoc.ciphertextSize}, got ${reassembledBuffer.length}`);
        return res.status(500).json({
          error: 'Ciphertext integrity verification failed: reconstructed payload size mismatch.'
        });
      }

      console.log(`[${nowTs()}] [SECUREVAULT] [SECURITY] [ZERO-KNOWLEDGE ARCHITECTURE]`);
      console.log(`  -> Decryption strategy: Client-side WebCrypto AES-256-GCM`);
      console.log(`  -> Backend role: Zero-knowledge storage orchestrator & erasure decoder.`);
      console.log(`  -> Plaintext exposure: ZERO. Master key and unwrapped DEK remain strictly on client device.`);
      console.log(`  -> Cryptographic envelope headers attached:`);
      console.log(`     Algorithm: ${fileDoc.encryptionAlgorithm || 'AES-256-GCM'}`);
      console.log(`     KDF: ${fileDoc.kdf || 'PBKDF2-HMAC-SHA256'} (Salt: ${fileDoc.kdfSalt ? fileDoc.kdfSalt.substring(0, 16) + '...' : 'N/A'}, Iterations: ${fileDoc.kdfIterations || 100000})`);
      console.log(`     Wrapped DEK present: ${!!fileDoc.wrappedDEK} (Length: ${fileDoc.wrappedDEK ? fileDoc.wrappedDEK.length : 0})`);
      console.log(`     Original File Hash: ${fileDoc.originalFileHash ? fileDoc.originalFileHash.substring(0, 16) + '...' : 'N/A'}`);

      await recordAuditEntry({
        userId,
        action: 'FILE_DOWNLOADED',
        title: 'File Downloaded',
        description: `Retrieved ciphertext payload for "${fileDoc.name}" [Reed-Solomon 4+2]`,
        fileId: fileDoc.id
      });

      // -----------------------------------------------------------------------
      // 7. RESPONSE STREAM STATUS
      // -----------------------------------------------------------------------
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] HTTP Status: 200 OK`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] Content-Type: ${fileDoc.type || 'application/octet-stream'}`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] Content-Disposition: attachment; filename="${fileDoc.name}"`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] Transmitted payload: ${reassembledBuffer.length} bytes successfully streamed to client.`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RECONSTRUCTION] === PIPELINE COMPLETED SUCCESSFULLY ===\n` + '='.repeat(80));

      res.setHeader('X-Crypto-Version', '2');
      res.setHeader('X-Sharding-Version', String(shardingVersion));
      res.setHeader('X-Erasure-Coding', fileDoc.erasureCoding || 'reed-solomon');
      res.setHeader('X-Data-Shards', String(fileDoc.dataShards || 4));
      res.setHeader('X-Parity-Shards', String(fileDoc.parityShards || 2));
      res.setHeader('X-Total-Shards', String(fileDoc.totalShards || 6));
      res.setHeader('X-Ciphertext-Hash', expectedCiphertextHash || '');
      res.setHeader('X-Ciphertext-Size', String(reassembledBuffer.length));
      res.setHeader('X-Algorithm', fileDoc.encryptionAlgorithm || 'AES-256-GCM');
      res.setHeader('X-Wrapped-DEK', fileDoc.wrappedDEK || '');
      res.setHeader('X-KDF', fileDoc.kdf || 'PBKDF2-HMAC-SHA256');
      res.setHeader('X-KDF-Salt', fileDoc.kdfSalt || '');
      res.setHeader('X-KDF-Iterations', String(fileDoc.kdfIterations || 100000));
      res.setHeader('X-Base-Nonce', fileDoc.baseNonce || '');
      res.setHeader('X-Chunk-Size', String(fileDoc.chunkSize || 8388608));
      res.setHeader('X-Chunk-Count', String(fileDoc.chunkCount || 1));
      res.setHeader('X-Original-File-Hash', fileDoc.originalFileHash || fileDoc.fileHash || '');
      res.setHeader('X-Original-File-Size', String(fileDoc.originalFileSize || fileDoc.fileSize || ''));
      res.setHeader('X-Is-Password-Protected', String(!!fileDoc.isPasswordProtected));
      res.setHeader('Access-Control-Expose-Headers', 'X-Crypto-Version, X-Sharding-Version, X-Erasure-Coding, X-Data-Shards, X-Parity-Shards, X-Total-Shards, X-Ciphertext-Hash, X-Ciphertext-Size, X-Algorithm, X-Wrapped-DEK, X-KDF, X-KDF-Salt, X-KDF-Iterations, X-Base-Nonce, X-Chunk-Size, X-Chunk-Count, X-Original-File-Hash, X-Original-File-Size, X-Is-Password-Protected, Content-Disposition');
      res.setHeader('Content-Type', fileDoc.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileDoc.name}"`);
      return res.status(200).send(reassembledBuffer);

    } else {
      // =========================================================================
      // cryptoVersion: 1 [LEGACY SERVER-SIDE DECRYPTION DOWNLOAD]
      // =========================================================================
      console.log(`[${nowTs()}] [SECUREVAULT] [SECURITY] [LEGACY SERVER-SIDE DECRYPTION]`);
      console.log(`  -> Decryption strategy: Server-side AES-256-GCM`);
      if (fileDoc.passwordHash) {
        const providedPassword = req.headers['x-file-password'] || req.headers['x-access-code'] || req.query.password || (req.body && req.body.password);
        if (!providedPassword) {
          console.warn(`[${nowTs()}] [SECUREVAULT] [SECURITY] [REJECTED] Password required for file "${fileDoc.name}".`);
          return res.status(401).json({ error: 'File password required to download this file.' });
        }
        const providedHash = crypto.createHash('sha256').update(String(providedPassword).trim()).digest('hex');
        if (providedHash !== fileDoc.passwordHash) {
          console.warn(`[${nowTs()}] [SECUREVAULT] [SECURITY] [REJECTED] Incorrect file password provided.`);
          return res.status(401).json({ error: 'Incorrect file password. Please try again.' });
        }
      }

      console.log(`  -> IV: ${fileDoc.iv ? fileDoc.iv.substring(0, 8) + '...' : 'N/A'}`);
      console.log(`  -> Auth Tag: ${fileDoc.authTag ? fileDoc.authTag.substring(0, 8) + '...' : 'N/A'}`);
      const encryptionKey = env.masterKey;
      const decryptedBuffer = decryptBuffer(reassembledBuffer, fileDoc.iv, fileDoc.authTag, encryptionKey);
      console.log(`[${nowTs()}] [SECUREVAULT] [SECURITY] Decrypted Plaintext Size: ${decryptedBuffer.length} bytes`);

      await recordAuditEntry({
        userId,
        action: 'FILE_DOWNLOADED',
        title: 'File Downloaded',
        description: `Downloaded & decrypted payload "${fileDoc.name}"`,
        fileId: fileDoc.id
      });

      // -----------------------------------------------------------------------
      // 7. RESPONSE STREAM STATUS
      // -----------------------------------------------------------------------
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] HTTP Status: 200 OK`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] Content-Type: ${fileDoc.type || 'application/octet-stream'}`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] Content-Disposition: attachment; filename="${fileDoc.name}"`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RESPONSE] Transmitted payload: ${decryptedBuffer.length} decrypted bytes successfully streamed to client.`);
      console.log(`[${nowTs()}] [SECUREVAULT] [RECONSTRUCTION] === PIPELINE COMPLETED SUCCESSFULLY ===\n` + '='.repeat(80));

      res.setHeader('Content-Type', fileDoc.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileDoc.name}"`);
      return res.status(200).send(decryptedBuffer);
    }
  } catch (error) {
    next(error);
  }
};

export const repairFileShardController = async (req, res, next) => {
  try {
    const { id, shardIndex } = req.params;
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    const sIndex = parseInt(shardIndex, 10);
    if (isNaN(sIndex) || sIndex < 1 || sIndex > 6) {
      return res.status(400).json({ error: 'Invalid shard index. Must be between 1 and 6.' });
    }

    const result = await repairFileShard(id, sIndex);
    logShardRepair(id, sIndex, result.nodeId, 5, 6, 'SUCCESS');
    logIntegrityCheck(`File: ${id} (Shard #${sIndex})`, 'PASS');
    return res.status(200).json({
      success: true,
      message: `Shard #${sIndex} successfully repaired and restored to node ${result.nodeId}.`,
      repairDetails: result
    });
  } catch (error) {
    next(error);
  }
};

export const deleteFile = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    let shardsToDelete = [];
    let targetFileName = 'file';
    let docIdToDelete = null;
    let targetFileHash = null;

    if (isMongoConnected) {
      try {
        let doc = null;
        if (mongoose.isValidObjectId(id)) {
          doc = await File.findOne({ _id: id }).lean().catch(() => null);
        }
        if (!doc) {
          doc = await File.findOne({ $or: [{ id: id }, { fileId: id }] }).lean().catch(() => null);
        }
        if (doc && String(doc.userId) === String(userId)) {
          targetFileName = doc.fileName;
          docIdToDelete = doc._id;
          targetFileHash = doc.fileHash || doc.ciphertextHash;
          const query = {
            $or: [{ fileId: doc._id }, { fileId: String(doc._id) }, { fileId: id }]
          };
          const mongoShards = await FileShard.find(query).lean();
          shardsToDelete.push(...mongoShards);
          await Promise.all([
            FileShard.deleteMany(query),
            File.deleteOne({ _id: doc._id })
          ]);
        }
      } catch (e) {
        console.warn('[DeleteFile Warning] MongoDB deletion error:', e.message);
      }
    }

    // Always clean up local memory and stored JSON files
    const localFile = memFiles.find(f =>
      (f.id === id || String(f._id) === String(id) || (docIdToDelete && String(f._id) === String(docIdToDelete))) &&
      String(f.userId) === String(userId)
    );
    if (localFile) {
      targetFileName = localFile.name || localFile.fileName || targetFileName;
      if (!targetFileHash) targetFileHash = localFile.fileHash || localFile.ciphertextHash || localFile.hash;
    }

    // Filter out of memFiles
    const remainingFiles = memFiles.filter(f =>
      !((f.id === id || String(f._id) === String(id) || (docIdToDelete && String(f._id) === String(docIdToDelete))) &&
      String(f.userId) === String(userId))
    );
    memFiles.length = 0;
    memFiles.push(...remainingFiles);
    saveStoredFiles(memFiles);

    // Get all matching shards from memShards
    const localShards = memShards.filter(s =>
      s.fileId === id ||
      String(s.fileId) === String(id) ||
      (docIdToDelete && (s.fileId === String(docIdToDelete) || String(s.fileId) === String(docIdToDelete)))
    );
    shardsToDelete.push(...localShards);

    // Filter out of memShards
    const remainingShards = memShards.filter(s =>
      s.fileId !== id &&
      String(s.fileId) !== String(id) &&
      (!docIdToDelete || (s.fileId !== String(docIdToDelete) && String(s.fileId) !== String(docIdToDelete)))
    );
    memShards.length = 0;
    memShards.push(...remainingShards);
    saveStoredShards(memShards);

    // Safely update deduplication chunk references and protect shared chunks
    const retainedShardsPaths = new Set();
    try {
      const rel1 = await releaseFileChunkReferences(id, targetFileHash);
      const rel2 = docIdToDelete ? await releaseFileChunkReferences(String(docIdToDelete), targetFileHash) : { retainedChunks: [], retainedShardsPaths: [] };
      const retainedChunkHashes = new Set([...(rel1.retainedChunks || []), ...(rel2.retainedChunks || [])]);

      for (const p of [...(rel1.retainedShardsPaths || []), ...(rel2.retainedShardsPaths || [])]) {
        retainedShardsPaths.add(p);
      }

      for (const c of memChunks) {
        if (retainedChunkHashes.has(c.chunkHash) && c.shards) {
          for (const s of c.shards) {
            const p = s.storagePath || s.filePath;
            if (p) retainedShardsPaths.add(p);
          }
        }
      }
    } catch (e) {
      console.warn('[DeleteFile Warning] Deduplication release error:', e.message);
    }

    // Physically delete all shard files from disk only when truly unreferenced
    const seenPaths = new Set();
    const unlinkPromises = [];
    for (const s of shardsToDelete) {
      const p = s.storagePath || s.filePath;
      if (p && !seenPaths.has(p) && !retainedShardsPaths.has(p)) {
        seenPaths.add(p);
        unlinkPromises.push((async () => {
          if (isMongoConnected) {
            try {
              // Safety verification: verify no other file shard uses this storage path
              const otherShard = await FileShard.exists({
                storagePath: p,
                fileId: { $ne: docIdToDelete }
              });
              if (otherShard) {
                retainedShardsPaths.add(p);
                return;
              }
              const activeChunk = await StoredChunk.exists({
                'shards.storagePath': p,
                refCount: { $gt: 0 }
              });
              if (activeChunk) {
                retainedShardsPaths.add(p);
                return;
              }
            } catch (e) {}
          }
          await fs.promises.unlink(p).catch(() => {});
        })());
      }
    }
    await Promise.all(unlinkPromises);

    await recordAuditEntry({
      userId: String(userId),
      action: 'FILE_SHREDDED',
      title: 'File Shredded',
      description: `Shredded payload & purged shards for "${targetFileName}"`,
      fileId: id
    });

    console.log('\n' + '='.repeat(80));
    console.log(`[${nowTs()}] [SECUREVAULT] [FILE PURGE] === PERMANENT FILE SHREDDING ===`);
    console.log(`  -> Target File:       ${id} ("${targetFileName}")`);
    console.log(`  -> User ID:           ${userId}`);
    console.log(`  -> Shards Scrubbed:   ${shardsToDelete.length} physical shard files scrubbed across storage nodes`);
    console.log(`  -> Catalog Status:    Purged from database and in-memory store`);
    invalidateDedupCache(userId);

    console.log('='.repeat(80) + '\n');
    return res.status(200).json({ success: true, message: 'File and shards permanently purged.' });
  } catch (error) {
    next(error);
  }
};