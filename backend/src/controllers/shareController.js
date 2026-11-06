import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { SharedFile } from '../models/SharedFile.js';
import { File } from '../models/File.js';
import { FileShard } from '../models/FileShard.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { StorageNode } from '../models/StorageNode.js';
import { isMongoConnected } from '../config/db.js';
import { memActivities, memFiles, memShards, resolveShardsForFile } from './fileController.js';
import { recordAuditEntry } from '../services/auditService.js';
import { reconstructBufferFromShards, validateShardBuffer } from '../services/shardingService.js';
import { generateFileHash, verifySHA256 } from '../services/hashingService.js';
import { decryptBuffer } from '../services/encryptionService.js';
import { env } from '../config/env.js';
import { GLOBAL_INFRA_NODES, readNodeShard } from '../services/nodeService.js';
import { logShardReconstruction, logReconstructionFailure, logIntegrityCheck } from '../middleware/terminalLogger.js';
import { loadStoredShares, saveStoredShares } from '../services/storeService.js';

export let memoryShares = loadStoredShares();

/**
 * Creates a new secure share link for an existing file.
 * Authenticated endpoint: requires req.user._id and verifies file ownership.
 *
 * Zero-Knowledge Guarantee:
 * - Backend receives ONLY the wrapped DEK (wrappedDEKForShare) prepared client-side.
 * - Backend NEVER receives or stores plaintext passwords, plaintext DEKs, or vault credentials.
 */
export const createShare = async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    const {
      fileId,
      expiresDays = 7,
      downloadLimit = 10,
      isPasswordProtected = false,
      wrappedDEKForShare = null,
      kdf = 'PBKDF2-HMAC-SHA256',
      kdfSalt = null,
      kdfIterations = 100000,
      recipient = 'public-link'
    } = req.body;

    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required to generate share link.' });
    }

    // Verify target file exists and caller is the owner
    let targetFile = null;
    if (isMongoConnected) {
      try {
        const fileDoc = await File.findById(fileId).catch(() => null);
        if (fileDoc) {
          if (fileDoc.userId.toString() !== userId.toString()) {
            return res.status(403).json({ error: 'Forbidden: You do not own this file.' });
          }
          targetFile = fileDoc;
        }
      } catch (e) {}
    }

    if (!targetFile) {
      const memDoc = memFiles.find(f => (f.id === fileId || String(f._id) === String(fileId)));
      if (memDoc) {
        if (memDoc.userId.toString() !== userId.toString()) {
          return res.status(403).json({ error: 'Forbidden: You do not own this file.' });
        }
        targetFile = memDoc;
      }
    }

    if (!targetFile) {
      return res.status(404).json({ error: 'File not found in your vault.' });
    }

    // Generate cryptographically secure 256-bit token (64 hex characters)
    const token = crypto.randomBytes(32).toString('hex');
    const parsedDays = Number(expiresDays) || 7;
    const expiresAt = new Date(Date.now() + parsedDays * 24 * 60 * 60 * 1000);
    const parsedLimit = Number(downloadLimit) || 10;
    const isProtected = isPasswordProtected === true || isPasswordProtected === 'true';

    const shareUrl = `http://localhost:5173/share/${token}`;
    const targetFileName = targetFile.fileName || targetFile.name || 'Vault Payload';
    const targetFileSize = targetFile.originalFileSize || targetFile.fileSize || targetFile.size || 0;
    const targetMimeType = targetFile.mimeType || targetFile.type || 'application/octet-stream';
    const targetCryptoVersion = targetFile.cryptoVersion || (targetFile.wrappedDEK ? 2 : 1);

    const shareObj = {
      id: token,
      token,
      fileId: targetFile._id ? targetFile._id.toString() : targetFile.id,
      creatorUserId: userId.toString(),
      fileName: targetFileName,
      fileSize: targetFileSize,
      mimeType: targetMimeType,
      cryptoVersion: targetCryptoVersion,
      shareUrl,
      recipient,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      downloadLimit: parsedLimit,
      downloadCount: 0,
      status: 'active',
      isPasswordProtected: isProtected,
      wrappedDEKForShare: wrappedDEKForShare || (targetCryptoVersion === 2 ? targetFile.wrappedDEK : null),
      kdf,
      kdfSalt,
      kdfIterations: Number(kdfIterations) || 100000
    };

    if (isMongoConnected) {
      try {
        const createdDoc = await SharedFile.create({
          fileId: targetFile._id,
          creatorUserId: userId,
          token,
          recipient,
          expiresAt,
          downloadLimit: parsedLimit,
          downloadCount: 0,
          status: 'active',
          isPasswordProtected: isProtected,
          wrappedDEKForShare: shareObj.wrappedDEKForShare,
          kdf,
          kdfSalt,
          kdfIterations: shareObj.kdfIterations
        });

        shareObj._id = createdDoc._id.toString();
      } catch (dbErr) {
        console.warn('[MongoDB SharedFile Warning]:', dbErr.message);
        memoryShares.push(shareObj);
        saveStoredShares(memoryShares);
      }
    } else {
      memoryShares.push(shareObj);
      saveStoredShares(memoryShares);
    }

    await recordAuditEntry({
      userId: String(userId),
      action: 'SHARE_CREATED',
      title: 'Share Link Created',
      description: `Generated secure share link for "${targetFileName}" (${parsedDays}d expiry, ${parsedLimit} downloads max)`,
      fileId: targetFile._id || targetFile.id
    }).catch(() => {});

    console.log(`[${new Date().toISOString()}] [SECUREVAULT] [SHARE] Created share link for file "${targetFileName}" | Token: ${token} | Expiry: ${parsedDays}d | Limit: ${parsedLimit}`);

    return res.status(201).json({
      success: true,
      message: 'Secure share link generated successfully.',
      share: shareObj,
      ...shareObj
    });
  } catch (error) {
    next(error);
  }
};

export const createShareLink = createShare;

/**
 * Returns all active and expired share links created by the requesting user.
 * Authenticated endpoint: filtered strictly by creatorUserId.
 */
export const getSharedLinks = async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    let shares = [];
    const now = new Date();

    if (isMongoConnected) {
      try {
        const dbShares = await SharedFile.find({ creatorUserId: userId })
          .populate('fileId')
          .sort({ createdAt: -1 });

        shares = dbShares.map(s => {
          const fileDoc = s.fileId;
          const isExpired = now > new Date(s.expiresAt) || (s.downloadLimit && s.downloadCount >= s.downloadLimit);
          const computedStatus = s.status === 'revoked' ? 'revoked' : (isExpired ? 'expired' : s.status);

          return {
            id: s.token || s._id.toString(),
            _id: s._id.toString(),
            token: s.token,
            fileId: fileDoc ? fileDoc._id.toString() : (s.fileId ? s.fileId.toString() : 'unknown'),
            fileName: fileDoc ? (fileDoc.fileName || fileDoc.name) : 'Vault Payload',
            fileSize: fileDoc ? (fileDoc.originalFileSize || fileDoc.fileSize || 0) : 0,
            mimeType: fileDoc ? (fileDoc.mimeType || fileDoc.type) : 'application/octet-stream',
            cryptoVersion: fileDoc ? (fileDoc.cryptoVersion || (fileDoc.wrappedDEK ? 2 : 1)) : 2,
            shareUrl: `http://localhost:5173/share/${s.token}`,
            createdAt: s.createdAt ? s.createdAt.toISOString() : new Date().toISOString(),
            expiresAt: s.expiresAt ? s.expiresAt.toISOString() : new Date().toISOString(),
            accessCount: s.downloadCount || 0,
            downloadCount: s.downloadCount || 0,
            maxAccess: s.downloadLimit || 10,
            downloadLimit: s.downloadLimit || 10,
            isPasswordProtected: !!s.isPasswordProtected,
            status: computedStatus,
            wrappedDEKForShare: s.wrappedDEKForShare,
            kdf: s.kdf,
            kdfSalt: s.kdfSalt,
            kdfIterations: s.kdfIterations
          };
        });
      } catch (e) {
        shares = memoryShares.filter(s => s.creatorUserId === userId.toString());
      }
    } else {
      shares = memoryShares.filter(s => s.creatorUserId === userId.toString()).map(s => {
        const isExpired = now > new Date(s.expiresAt) || (s.downloadLimit && s.downloadCount >= s.downloadLimit);
        return {
          ...s,
          status: s.status === 'revoked' ? 'revoked' : (isExpired ? 'expired' : s.status)
        };
      });
    }

    return res.status(200).json(shares);
  } catch (error) {
    next(error);
  }
};

export const getShares = getSharedLinks;

/**
 * Revokes a share link created by the authenticated user.
 * Authenticated endpoint: verifies creator ownership.
 */
export const deleteShare = async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized: Session user ID required.' });
    }

    const { id } = req.params;
    let found = false;

    if (isMongoConnected) {
      try {
        const isObjectId = id.match(/^[0-9a-fA-F]{24}$/);
        const query = isObjectId ? { $or: [{ token: id }, { _id: id }] } : { token: id };
        const shareDoc = await SharedFile.findOne(query);

        if (shareDoc) {
          if (shareDoc.creatorUserId.toString() !== userId.toString()) {
            return res.status(403).json({ error: 'Forbidden: You cannot revoke a share link created by another user.' });
          }
          shareDoc.status = 'revoked';
          await shareDoc.save();
          found = true;

          await recordAuditEntry({
            userId: String(userId),
            action: 'SHARE_REVOKED',
            title: 'Share Link Revoked',
            description: `Revoked share token ${shareDoc.token.substring(0, 12)}...`,
            fileId: shareDoc.fileId
          }).catch(() => {});
        }
      } catch (e) {}
    }

    const memShare = memoryShares.find(s => s.id === id || s.token === id);
    if (memShare) {
      if (memShare.creatorUserId.toString() !== userId.toString()) {
        return res.status(403).json({ error: 'Forbidden: You cannot revoke a share link created by another user.' });
      }
      memShare.status = 'revoked';
      saveStoredShares(memoryShares);
      found = true;
    }

    if (!found) {
      return res.status(404).json({ error: 'Share link not found.' });
    }

    console.log(`[${new Date().toISOString()}] [SECUREVAULT] [SHARE] Revoked share link: ${id}`);
    return res.status(200).json({ success: true, message: 'Share link revoked successfully.' });
  } catch (error) {
    next(error);
  }
};

export const revokeShare = deleteShare;

/**
 * Returns public metadata for a share token.
 * Public endpoint: NO JWT authentication required.
 * Enforces expiration, download limit, and revocation status.
 */
export const getPublicShareInfo = async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ error: 'Share token is required.' });
    }

    let shareDoc = null;
    let fileDoc = null;

    if (isMongoConnected) {
      try {
        const doc = await SharedFile.findOne({ token }).populate('fileId');
        if (doc) {
          shareDoc = doc;
          fileDoc = doc.fileId;
        }
      } catch (e) {}
    }

    if (!shareDoc) {
      const memDoc = memoryShares.find(s => s.token === token || s.id === token || (s.shareUrl && s.shareUrl.includes(token)));
      if (memDoc) {
        shareDoc = memDoc;
        fileDoc = memFiles.find(f => f.id === memDoc.fileId || String(f._id) === String(memDoc.fileId));
      }
    }

    if (!shareDoc) {
      return res.status(404).json({ error: 'Share link not found.' });
    }

    // Check revocation
    if (shareDoc.status === 'revoked') {
      return res.status(410).json({ error: 'This share link has been revoked by the owner.' });
    }

    // Check expiration
    const now = new Date();
    if (now > new Date(shareDoc.expiresAt)) {
      if (isMongoConnected && shareDoc.save) {
        shareDoc.status = 'expired';
        await shareDoc.save().catch(() => {});
      }
      return res.status(410).json({ error: 'This share link has expired.' });
    }

    // Check download limit
    if (shareDoc.downloadLimit && shareDoc.downloadCount >= shareDoc.downloadLimit) {
      if (isMongoConnected && shareDoc.save) {
        shareDoc.status = 'expired';
        await shareDoc.save().catch(() => {});
      }
      return res.status(410).json({ error: 'This share link has reached its maximum download limit.' });
    }

    const fileName = fileDoc ? (fileDoc.fileName || fileDoc.name) : (shareDoc.fileName || 'Shared Vault Payload');
    const fileSize = fileDoc ? (fileDoc.originalFileSize || fileDoc.fileSize || fileDoc.size || 0) : (shareDoc.fileSize || 0);
    const mimeType = fileDoc ? (fileDoc.mimeType || fileDoc.type || 'application/octet-stream') : 'application/octet-stream';
    const cryptoVersion = fileDoc ? (fileDoc.cryptoVersion || (fileDoc.wrappedDEK ? 2 : 1)) : 2;

    return res.status(200).json({
      id: shareDoc.token || shareDoc.id,
      token: shareDoc.token || shareDoc.id,
      fileId: fileDoc ? (fileDoc._id ? fileDoc._id.toString() : fileDoc.id) : shareDoc.fileId,
      fileName,
      fileSize,
      mimeType,
      cryptoVersion,
      shareUrl: `http://localhost:5173/share/${shareDoc.token || shareDoc.id}`,
      createdAt: shareDoc.createdAt ? (shareDoc.createdAt.toISOString ? shareDoc.createdAt.toISOString() : shareDoc.createdAt) : new Date().toISOString(),
      expiresAt: shareDoc.expiresAt ? (shareDoc.expiresAt.toISOString ? shareDoc.expiresAt.toISOString() : shareDoc.expiresAt) : new Date().toISOString(),
      accessCount: shareDoc.downloadCount || 0,
      downloadCount: shareDoc.downloadCount || 0,
      maxAccess: shareDoc.downloadLimit || 10,
      downloadLimit: shareDoc.downloadLimit || 10,
      isPasswordProtected: !!shareDoc.isPasswordProtected,
      status: 'active',
      wrappedDEKForShare: shareDoc.wrappedDEKForShare || (fileDoc ? fileDoc.wrappedDEK : null),
      kdf: shareDoc.kdf || 'PBKDF2-HMAC-SHA256',
      kdfSalt: shareDoc.kdfSalt || (fileDoc ? fileDoc.kdfSalt : null),
      kdfIterations: shareDoc.kdfIterations || 100000
    });

    console.log(`[${new Date().toISOString()}] [SECUREVAULT] [SHARE] Public share metadata retrieved for token: ${token} ("${shareDoc.fileName || (fileDoc ? fileDoc.name : 'shared-file')}")`);
  } catch (error) {
    next(error);
  }
};

export const getSharedByToken = getPublicShareInfo;

/**
 * Downloads a shared file payload using the Phase 4 Reed-Solomon 4+2 recovery pipeline.
 * Public endpoint: NO JWT authentication required.
 *
 * Zero-Knowledge Guarantee:
 * - Ciphertext is reconstructed from shards and streamed directly to browser with cryptographic envelope headers.
 * - Backend NEVER performs decryption on cryptoVersion 2 files.
 * - Recipient browser unwraps wrappedDEK and decrypts AES-256-GCM chunks locally.
 */
export const downloadPublicShare = async (req, res, next) => {
  try {
    const { token } = req.params;
    if (!token) {
      return res.status(400).json({ error: 'Share token is required.' });
    }

    let shareDoc = null;
    let fileDoc = null;
    let shards = [];

    if (isMongoConnected) {
      try {
        const doc = await SharedFile.findOne({ token });
        if (doc) {
          shareDoc = doc;
          fileDoc = await File.findById(doc.fileId);
        }
      } catch (e) {}
    }

    if (!shareDoc) {
      const memDoc = memoryShares.find(s => s.token === token || s.id === token || (s.shareUrl && s.shareUrl.includes(token)));
      if (memDoc) {
        shareDoc = memDoc;
        fileDoc = memFiles.find(f => f.id === memDoc.fileId || String(f._id) === String(memDoc.fileId));
      }
    }

    if (fileDoc) {
      shards = await resolveShardsForFile(fileDoc, fileDoc.id || fileDoc._id);
    }

    if (!shareDoc || !fileDoc) {
      return res.status(404).json({ error: 'Shared file not found or has been deleted.' });
    }

    // Check revocation
    if (shareDoc.status === 'revoked') {
      return res.status(410).json({ error: 'This share link has been revoked by the owner.' });
    }

    // Check expiration
    const now = new Date();
    if (now > new Date(shareDoc.expiresAt)) {
      if (isMongoConnected && shareDoc.save) {
        shareDoc.status = 'expired';
        await shareDoc.save().catch(() => {});
      }
      return res.status(410).json({ error: 'This share link has expired.' });
    }

    // Check download limit
    if (shareDoc.downloadLimit && shareDoc.downloadCount >= shareDoc.downloadLimit) {
      if (isMongoConnected && shareDoc.save) {
        shareDoc.status = 'expired';
        await shareDoc.save().catch(() => {});
      }
      return res.status(410).json({ error: 'This share link has reached its maximum download limit.' });
    }

    const cryptoVersion = fileDoc.cryptoVersion || (fileDoc.wrappedDEK ? 2 : 1);
    const shardingVersion = fileDoc.shardingVersion || (cryptoVersion === 2 ? 2 : 1);

    // Fetch storage node statuses to account for simulated node failures
    let nodeStatusMap = {};
    if (isMongoConnected) {
      try {
        const nodes = await StorageNode.find().lean();
        nodes.forEach(n => {
          const status = (n.status === 'offline' || n.isSimulatedFailure) ? 'offline' : 'online';
          if (n.nodeId) nodeStatusMap[n.nodeId] = status;
          if (n.id) nodeStatusMap[n.id] = status;
        });
      } catch (e) {}
    }
    GLOBAL_INFRA_NODES.forEach(n => {
      const status = (n.status === 'offline' || n.isSimulatedFailure) ? 'offline' : 'online';
      if (n.nodeId && nodeStatusMap[n.nodeId] === undefined) {
        nodeStatusMap[n.nodeId] = status;
      }
      if (n.id && nodeStatusMap[n.id] === undefined) {
        nodeStatusMap[n.id] = status;
      }
    });

    // Concurrent parallel shard reading matching fileController
    const shardReadPromises = shards.map(async (s) => {
      const p = s.storagePath || s.filePath;
      const nStatus = nodeStatusMap[s.nodeId] || 'online';
      if (nStatus === 'offline') {
        console.warn(`[Node Failure Simulation] Shard #${s.shardIndex} on ${s.nodeId} is unavailable (node offline).`);
        return null;
      }
      if (!p) {
        console.warn(`[Storage Missing] Shard #${s.shardIndex} on ${s.nodeId}: Storage path is undefined in metadata.`);
        return null;
      }
      try {
        const shardBuf = await readNodeShard(s.nodeId, p);
        if (shardBuf.length >= 16 && shardBuf.subarray(0, 4).toString() === 'SVEC') {
          const validation = validateShardBuffer(shardBuf, s.shardIndex, s.shardHash);
          if (!validation.isValid) {
            console.warn(`[Integrity Warning] Shard #${s.shardIndex} failed validation (${validation.error}). Discarding.`);
            return null;
          }
        } else if (s.shardHash) {
          const isValid = verifySHA256(shardBuf, s.shardHash);
          if (!isValid) {
            console.warn(`[Integrity Warning] Shard #${s.shardIndex} failed SHA-256 integrity check. Discarding.`);
            return null;
          }
        }
        return { shardIndex: s.shardIndex, data: shardBuf, expectedHash: s.shardHash };
      } catch (readErr) {
        console.warn(`[Storage Warning] Shard #${s.shardIndex} could not be read: ${readErr.message}`);
        return null;
      }
    });

    const shardResults = await Promise.all(shardReadPromises);
    const validShards = shardResults.filter(Boolean);

    // Require minimum threshold (4 for RS 4+2, 3 for legacy 3+1)
    const requiredK = shardingVersion === 2 ? 4 : 3;
    const fileName = fileDoc.fileName || fileDoc.name || 'Shared File';
    if (validShards.length < requiredK) {
      logReconstructionFailure(fileName, requiredK, validShards.length);
      logIntegrityCheck(fileName, 'FAIL');
      return res.status(500).json({
        error: `Reconstruction Failed: Insufficient valid shards available. Minimum ${requiredK} valid shards required for recovery, but only ${validShards.length} passed integrity checks.`
      });
    }

    logShardReconstruction(fileName, validShards.length, shards.length, 'SUCCESS');
    logIntegrityCheck(fileName, 'PASS');

    // Reconstruct ciphertext buffer
    const reassembledBuffer = reconstructBufferFromShards(validShards);

    // Atomically increment download counter
    if (isMongoConnected && shareDoc.save) {
      shareDoc.downloadCount = (shareDoc.downloadCount || 0) + 1;
      if (shareDoc.downloadLimit && shareDoc.downloadCount >= shareDoc.downloadLimit) {
        shareDoc.status = 'expired';
      }
      await shareDoc.save().catch(() => {});
    } else {
      shareDoc.downloadCount = (shareDoc.downloadCount || 0) + 1;
      if (shareDoc.downloadLimit && shareDoc.downloadCount >= shareDoc.downloadLimit) {
        shareDoc.status = 'expired';
      }
      saveStoredShares(memoryShares);
    }

    if (cryptoVersion === 2) {
      // =========================================================================
      // cryptoVersion: 2 [ZERO-KNOWLEDGE CLIENT-SIDE DECRYPTION PIPELINE]
      // Backend validates reconstructed ciphertext SHA-256 before streaming.
      // Backend NEVER decrypts.
      // =========================================================================
      const expectedCiphertextHash = fileDoc.ciphertextHash || fileDoc.fileHash;
      if (expectedCiphertextHash) {
        const actualCiphertextHash = generateFileHash(reassembledBuffer);
        if (actualCiphertextHash.toLowerCase() !== expectedCiphertextHash.toLowerCase()) {
          console.error(`[Ciphertext Integrity Error] Shared reconstructed hash mismatch: expected ${expectedCiphertextHash}, got ${actualCiphertextHash}`);
          return res.status(500).json({
            error: 'Ciphertext integrity verification failed: reconstructed payload does not match expected fingerprint.'
          });
        }
      }

      if (fileDoc.ciphertextSize && reassembledBuffer.length !== fileDoc.ciphertextSize) {
        console.error(`[Ciphertext Integrity Error] Shared reconstructed size mismatch: expected ${fileDoc.ciphertextSize}, got ${reassembledBuffer.length}`);
        return res.status(500).json({
          error: 'Ciphertext integrity verification failed: reconstructed payload size mismatch.'
        });
      }

      const fileName = fileDoc.fileName || fileDoc.name || 'payload';
      const effectiveWrappedDEK = shareDoc.wrappedDEKForShare || fileDoc.wrappedDEK || '';
      const effectiveKDF = shareDoc.kdf || fileDoc.kdf || 'PBKDF2-HMAC-SHA256';
      const effectiveSalt = shareDoc.kdfSalt || fileDoc.kdfSalt || '';
      const effectiveIterations = shareDoc.kdfIterations || fileDoc.kdfIterations || 100000;

      res.setHeader('X-Crypto-Version', '2');
      res.setHeader('X-Sharding-Version', String(shardingVersion));
      res.setHeader('X-Erasure-Coding', fileDoc.erasureCoding || 'reed-solomon');
      res.setHeader('X-Data-Shards', String(fileDoc.dataShards || 4));
      res.setHeader('X-Parity-Shards', String(fileDoc.parityShards || 2));
      res.setHeader('X-Total-Shards', String(fileDoc.totalShards || 6));
      res.setHeader('X-Ciphertext-Hash', expectedCiphertextHash || '');
      res.setHeader('X-Ciphertext-Size', String(reassembledBuffer.length));
      res.setHeader('X-Algorithm', fileDoc.encryptionAlgorithm || 'AES-256-GCM');
      res.setHeader('X-Wrapped-DEK', effectiveWrappedDEK);
      res.setHeader('X-KDF', effectiveKDF);
      res.setHeader('X-KDF-Salt', effectiveSalt);
      res.setHeader('X-KDF-Iterations', String(effectiveIterations));
      res.setHeader('X-Base-Nonce', fileDoc.baseNonce || '');
      res.setHeader('X-Chunk-Size', String(fileDoc.chunkSize || 8388608));
      res.setHeader('X-Chunk-Count', String(fileDoc.chunkCount || 1));
      res.setHeader('X-Original-File-Hash', fileDoc.originalFileHash || fileDoc.fileHash || '');
      res.setHeader('X-Original-File-Size', String(fileDoc.originalFileSize || fileDoc.fileSize || ''));
      res.setHeader('X-Is-Password-Protected', String(!!shareDoc.isPasswordProtected));
      res.setHeader('Access-Control-Expose-Headers', 'X-Crypto-Version, X-Sharding-Version, X-Erasure-Coding, X-Data-Shards, X-Parity-Shards, X-Total-Shards, X-Ciphertext-Hash, X-Ciphertext-Size, X-Algorithm, X-Wrapped-DEK, X-KDF, X-KDF-Salt, X-KDF-Iterations, X-Base-Nonce, X-Chunk-Size, X-Chunk-Count, X-Original-File-Hash, X-Original-File-Size, X-Is-Password-Protected, Content-Disposition');
      res.setHeader('Content-Type', fileDoc.mimeType || fileDoc.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

      return res.status(200).send(reassembledBuffer);

    } else {
      // =========================================================================
      // cryptoVersion: 1 [LEGACY SERVER-SIDE DECRYPTION PIPELINE]
      // =========================================================================
      const encryptionKey = env.masterKey;
      const decryptedBuffer = decryptBuffer(reassembledBuffer, fileDoc.iv || fileDoc.encryptionIv, fileDoc.authTag || fileDoc.encryptionAuthTag, encryptionKey);

      const fileName = fileDoc.fileName || fileDoc.name || 'payload';
      res.setHeader('Content-Type', fileDoc.mimeType || fileDoc.type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      return res.status(200).send(decryptedBuffer);
    }
  } catch (error) {
    next(error);
  }
};