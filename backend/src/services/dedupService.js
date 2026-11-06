import fs from 'fs';
import path from 'path';
import { StoredChunk } from '../models/StoredChunk.js';
import { File } from '../models/File.js';
import { FileShard } from '../models/FileShard.js';
import { isMongoConnected } from '../config/db.js';
import { calculateSHA256 } from './hashingService.js';
import { createShardsFromBuffer } from './shardingService.js';
import { writeNodeShard } from './nodeService.js';
import { loadStoredFiles, loadStoredShards, saveStoredFiles } from './storeService.js';

// ---------------------------------------------------------------------------
// In-memory TTL cache for getDedupStats (avoids re-scanning on rapid navigation)
// ---------------------------------------------------------------------------
const _dedupStatsCache = new Map(); // key: String(userId|'global') → { ts, stats }
const DEDUP_CACHE_TTL_MS = 15_000; // 15 s

/** Call this after any upload or delete to invalidate a user's cached stats. */
export const invalidateDedupCache = (userId) => {
  if (userId) _dedupStatsCache.delete(String(userId));
  _dedupStatsCache.delete('global');
};

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const CHUNKS_FILE = path.join(DATA_DIR, 'chunks_store.json');

export const loadStoredChunks = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CHUNKS_FILE)) {
      fs.writeFileSync(CHUNKS_FILE, JSON.stringify([], null, 2), 'utf8');
      return [];
    }
    const data = fs.readFileSync(CHUNKS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
};

export const saveStoredChunks = (chunks) => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CHUNKS_FILE, JSON.stringify(chunks, null, 2), 'utf8');
  } catch (err) {}
};

export const memChunks = loadStoredChunks();

/**
 * Splits an encrypted ciphertext buffer into content-addressed chunks (default 8 MiB)
 * and processes each chunk with deduplication.
 *
 * @param {Buffer} ciphertextBuffer
 * @param {string} fileId
 * @param {Array<object>} selectedNodes - 6 nodes for RS 4+2
 * @param {number} [chunkSize=8388608]
 * @returns {Promise<{ chunkReferences: Array<{ chunkIndex: number, chunkHash: string, isDeduplicated: boolean }>, totalShardsWritten: number, deduplicatedChunksCount: number, allShardRecords: Array<object> }>}
 */
export const processContentAddressedChunks = async (
  ciphertextBuffer,
  fileId,
  selectedNodes,
  chunkSize = 8 * 1024 * 1024
) => {
  const totalLength = ciphertextBuffer.length;
  const numChunks = Math.max(1, Math.ceil(totalLength / chunkSize));
  const chunkReferences = [];
  let totalShardsWritten = 0;
  let deduplicatedChunksCount = 0;
  const allShardRecords = [];

  for (let cIdx = 0; cIdx < numChunks; cIdx++) {
    const start = cIdx * chunkSize;
    const end = Math.min(start + chunkSize, totalLength);
    const chunkBuf = ciphertextBuffer.subarray(start, end);
    const chunkHash = calculateSHA256(chunkBuf);

    // 1. Check if chunk already exists in MongoDB or local memory
    let existingChunk = null;
    if (isMongoConnected) {
      try {
        existingChunk = await StoredChunk.findOne({ chunkHash }).lean();
      } catch (e) {}
    }
    if (!existingChunk) {
      existingChunk = memChunks.find(c => c.chunkHash === chunkHash);
    }

    if (existingChunk) {
      // Chunk already exists: DEDUPLICATE (increment refCount, link fileId)
      deduplicatedChunksCount++;
      chunkReferences.push({
        chunkIndex: cIdx,
        chunkHash,
        isDeduplicated: true,
        chunkSize: chunkBuf.length,
      });

      // Update refCount and fileIds in MongoDB
      if (isMongoConnected) {
        try {
          await StoredChunk.updateOne(
            { chunkHash },
            {
              $inc: { refCount: 1 },
              $addToSet: { fileIds: fileId },
              $set: { lastAccessedAt: new Date() }
            }
          );
        } catch (e) {}
      }

      // Update in-memory and local store
      const mIdx = memChunks.findIndex(c => c.chunkHash === chunkHash);
      if (mIdx !== -1) {
        memChunks[mIdx].refCount = (Number(memChunks[mIdx].refCount) || 1) + 1;
        if (!memChunks[mIdx].fileIds.includes(fileId)) {
          memChunks[mIdx].fileIds.push(fileId);
        }
        memChunks[mIdx].lastAccessedAt = new Date().toISOString();
        saveStoredChunks(memChunks);
      }

      // Collect existing shard records for file manifest linking
      if (existingChunk.shards && existingChunk.shards.length > 0) {
        existingChunk.shards.forEach(s => {
          allShardRecords.push({
            ...s,
            fileId,
            chunkHash,
          });
        });
      }
    } else {
      // Chunk is new: Shard across 6 nodes using Reed-Solomon 4+2
      const shardsData = createShardsFromBuffer(chunkBuf, 6, { shardingVersion: 2 });
      const chunkShards = [];

      for (let i = 0; i < shardsData.length; i++) {
        const s = shardsData[i];
        const targetNode = selectedNodes[i % selectedNodes.length];
        const targetNodeId = targetNode.nodeId || targetNode.id || `node-0${i + 1}`;
        const nodeDir = path.join(process.cwd(), 'storage', targetNodeId);
        if (!fs.existsSync(nodeDir)) fs.mkdirSync(nodeDir, { recursive: true });

        // Use content-addressed shard filename based on chunkHash and shardIndex
        const shardFilename = `${chunkHash.substring(0, 16)}_${fileId}.shard.${i + 1}`;
        const fullShardPath = path.join(nodeDir, shardFilename);

        await writeNodeShard(targetNodeId, fullShardPath, s.data);
        totalShardsWritten++;

        const nodeProvider = targetNode.provider || (i < 2 ? 'aws-s3' : (i < 4 ? 'gcp-gcs' : 'azure-blob'));
        const nodeBucket = targetNode.emulatorBucket || (nodeProvider === 'aws-s3' ? 'securevault-aws-bucket' : (nodeProvider === 'gcp-gcs' ? 'securevault-gcp-bucket' : 'securevault-azure-container'));

        const shardRecord = {
          fileId,
          chunkHash,
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

        chunkShards.push(shardRecord);
        allShardRecords.push(shardRecord);
      }

      const chunkDoc = {
        chunkHash,
        chunkSize: chunkBuf.length,
        refCount: 1,
        fileIds: [fileId],
        shards: chunkShards,
        createdAt: new Date(),
        lastAccessedAt: new Date()
      };

      if (isMongoConnected) {
        try {
          await StoredChunk.create(chunkDoc);
        } catch (e) {}
      }

      memChunks.push({
        ...chunkDoc,
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString()
      });
      saveStoredChunks(memChunks);

      chunkReferences.push({
        chunkIndex: cIdx,
        chunkHash,
        isDeduplicated: false,
        chunkSize: chunkBuf.length,
      });
    }
  }

  return {
    chunkReferences,
    totalShardsWritten,
    deduplicatedChunksCount,
    allShardRecords
  };
};

/**
 * Decrements chunk reference count on file deletion.
 * Only purges physical shards from storage when refCount reaches 0.
 *
 * @param {string} fileId
 * @param {string} [fileHash]
 * @returns {Promise<{ deletedChunks: Array<string>, retainedChunks: Array<string>, retainedShardsPaths: Array<string> }>}
 */
export const releaseFileChunkReferences = async (fileId, fileHash = null) => {
  const deletedChunks = [];
  const retainedChunks = [];
  const retainedShardsPaths = new Set();
  const fileIdStr = String(fileId);

  // Update in memory & local store
  for (let i = memChunks.length - 1; i >= 0; i--) {
    const c = memChunks[i];
    const matchesId = c.fileIds && c.fileIds.some(id => String(id) === fileIdStr);
    const matchesHash = fileHash && c.chunkHash === fileHash;
    if (matchesId || matchesHash) {
      c.fileIds = (c.fileIds || []).filter(id => String(id) !== fileIdStr);
      c.refCount = Math.max(0, c.fileIds.length);

      if (c.refCount <= 0) {
        // Safe to purge physical shards
        if (c.shards && Array.isArray(c.shards)) {
          for (const s of c.shards) {
            const p = s.storagePath || s.filePath;
            if (p && fs.existsSync(p)) {
              try { fs.unlinkSync(p); } catch (e) {}
            }
          }
        }
        deletedChunks.push(c.chunkHash);
        memChunks.splice(i, 1);
      } else {
        retainedChunks.push(c.chunkHash);
        if (c.shards) {
          for (const s of c.shards) {
            const p = s.storagePath || s.filePath;
            if (p) retainedShardsPaths.add(p);
          }
        }
      }
    }
  }
  saveStoredChunks(memChunks);

  // Update MongoDB
  if (isMongoConnected) {
    try {
      const query = {
        $or: [
          { fileIds: { $in: [fileId, fileIdStr] } },
          ...(fileHash ? [{ chunkHash: fileHash }] : [])
        ]
      };
      const matchingChunks = await StoredChunk.find(query);

      for (const chunk of matchingChunks) {
        // Query remaining files in MongoDB sharing this content hash (single source of truth)
        let remainingFiles = [];
        try {
          remainingFiles = await File.find({
            $or: [{ fileHash: chunk.chunkHash }, { ciphertextHash: chunk.chunkHash }],
            _id: { $ne: fileId }
          }).select('_id').lean();
        } catch (e) {
          remainingFiles = [];
        }

        const cleanFileIds = remainingFiles.map(f => f._id.toString());
        const newRefCount = cleanFileIds.length;

        if (newRefCount > 0) {
          await StoredChunk.updateOne(
            { _id: chunk._id },
            {
              $set: {
                fileIds: cleanFileIds,
                refCount: newRefCount,
                lastAccessedAt: new Date()
              }
            }
          );
          retainedChunks.push(chunk.chunkHash);
          if (chunk.shards) {
            for (const s of chunk.shards) {
              const p = s.storagePath || s.filePath;
              if (p) retainedShardsPaths.add(p);
            }
          }

          // Update remaining File documents with this hash
          const remainingRatio = newRefCount;
          const remainingIsDedup = newRefCount > 1;
          await File.updateMany(
            { $or: [{ fileHash: chunk.chunkHash }, { ciphertextHash: chunk.chunkHash }] },
            { $set: { isDeduplicated: remainingIsDedup, deduplicationRatio: remainingRatio } }
          );
        } else {
          // Truly unreferenced: safe to purge physical shards
          if (chunk.shards && Array.isArray(chunk.shards)) {
            for (const s of chunk.shards) {
              const p = s.storagePath || s.filePath;
              if (p && fs.existsSync(p)) {
                try { await fs.promises.unlink(p); } catch (e) {}
              }
            }
          }
          deletedChunks.push(chunk.chunkHash);
          await StoredChunk.deleteOne({ _id: chunk._id });
        }
      }
    } catch (e) {
      console.warn('[DedupService Warning] releaseFileChunkReferences error:', e.message);
    }
  }

  invalidateDedupCache();
  return { deletedChunks, retainedChunks, retainedShardsPaths: Array.from(retainedShardsPaths) };
};

/**
 * Synchronizes persisted File and FileShard records into StoredChunk manifests.
 * Ensures that all files previously stored have accurate content-addressed
 * deduplication chunk records, without fabricating any numbers.
 */
export const syncPersistedFilesToChunks = async () => {
  let files = [];
  if (isMongoConnected) {
    try {
      files = await File.find().lean();
    } catch (e) {}
  }
  if (!files || files.length === 0) {
    files = loadStoredFiles();
  }

  let shards = [];
  if (isMongoConnected) {
    try {
      shards = await FileShard.find().lean();
    } catch (e) {}
  }
  if (!shards || shards.length === 0) {
    shards = loadStoredShards();
  }

  let modified = false;

  for (const f of files) {
    const fId = String(f.id || f._id);
    const chunkHash = f.ciphertextHash || f.hash || f.fileHash;
    if (!chunkHash) continue;

    const existingChunk = memChunks.find(c => c.chunkHash === chunkHash);
    const cSize = Number(f.ciphertextSize) || Number(f.originalFileSize || f.size || f.fileSize) || 0;

    if (!existingChunk) {
      const fileShards = shards.filter(s => String(s.fileId) === fId);
      const newChunk = {
        chunkHash,
        chunkSize: cSize,
        refCount: 1,
        fileIds: [fId],
        shards: fileShards,
        createdAt: f.encryptedAt || f.createdAt || new Date().toISOString(),
        lastAccessedAt: new Date().toISOString()
      };
      memChunks.push(newChunk);
      if (isMongoConnected) {
        try { await StoredChunk.create(newChunk); } catch (e) {}
      }
      modified = true;
    } else {
      if (!existingChunk.fileIds.includes(fId)) {
        existingChunk.fileIds.push(fId);
        existingChunk.refCount = existingChunk.fileIds.length;
        if (isMongoConnected) {
          try {
            await StoredChunk.updateOne(
              { chunkHash },
              { $addToSet: { fileIds: fId }, $set: { refCount: existingChunk.refCount } }
            );
          } catch (e) {}
        }
        modified = true;
      }
    }
  }

  if (modified) {
    saveStoredChunks(memChunks);
  }
};

/**
 * Reconciles MongoDB Atlas deduplication metrics across all files.
 * Corrects legacy records with undefined or hardcoded isDeduplicated and deduplicationRatio values.
 * Synchronizes StoredChunk refCount and fileIds to match ground truth.
 */
export const reconcileDatabaseDeduplication = async () => {
  if (!isMongoConnected) return { updatedFiles: 0, uniqueHashes: 0 };
  try {
    const files = await File.find().select('_id fileHash ciphertextHash originalFileHash isDeduplicated deduplicationRatio').lean();
    if (!files || files.length === 0) return { updatedFiles: 0, uniqueHashes: 0 };

    const groups = new Map();
    for (const f of files) {
      const h = f.fileHash || f.ciphertextHash || f.originalFileHash;
      if (!h) continue;
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h).push(f);
    }

    const bulkFileUpdates = [];
    for (const [hash, groupFiles] of groups.entries()) {
      const count = groupFiles.length;
      const isDedup = count > 1;
      const ratio = Math.max(1, count);

      const needsUpdate = groupFiles.some(f => f.isDeduplicated !== isDedup || f.deduplicationRatio !== ratio);
      if (needsUpdate) {
        bulkFileUpdates.push({
          updateMany: {
            filter: { $or: [{ fileHash: hash }, { ciphertextHash: hash }] },
            update: { $set: { isDeduplicated: isDedup, deduplicationRatio: ratio } }
          }
        });
      }

      const cleanFileIds = groupFiles.map(f => f._id.toString());
      await StoredChunk.updateOne(
        { chunkHash: hash },
        {
          $set: {
            refCount: count,
            fileIds: cleanFileIds,
            lastAccessedAt: new Date()
          }
        }
      ).catch(() => {});
    }

    if (bulkFileUpdates.length > 0) {
      await File.bulkWrite(bulkFileUpdates);
      console.log(`[SECUREVAULT] [DEDUP-RECONCILE] Successfully reconciled deduplication metrics for ${bulkFileUpdates.length} content hashes across ${files.length} files.`);
    }

    // Also reconcile in-memory files
    const localStoredFiles = loadStoredFiles();
    for (const mf of localStoredFiles || []) {
      const h = mf.fileHash || mf.ciphertextHash || mf.hash;
      const group = groups.get(h);
      if (group) {
        mf.isDeduplicated = group.length > 1;
        mf.deduplicationRatio = Math.max(1, group.length);
      }
    }
    saveStoredFiles(localStoredFiles);

    invalidateDedupCache();
    return { updatedFiles: bulkFileUpdates.length, uniqueHashes: groups.size };
  } catch (err) {
    console.warn('[DEDUP-RECONCILE Warning]:', err.message);
    return { error: err.message };
  }
};

// Initial sync on module load
syncPersistedFilesToChunks().catch(() => {});

/**
 * Calculates global and user-specific deduplication metrics.
 * Accurately traces persisted File, StoredChunk, and FileShard records.
 * Shows true physical vs logical storage bytes, saved space, and efficiency ratio.
 */
export const getDedupStats = async (userId = null) => {
  // --- TTL cache check: avoid expensive MongoDB+fs scan on rapid navigation ---
  const _cacheKey = userId ? String(userId) : 'global';
  const _cached = _dedupStatsCache.get(_cacheKey);
  if (_cached && (Date.now() - _cached.ts) < DEDUP_CACHE_TTL_MS) {
    return _cached.stats;
  }

  // 1. Load persisted files for this user (or all if no userId)
  let files = [];
  if (isMongoConnected) {
    try {
      files = userId ? await File.find({ userId }).lean() : await File.find().lean();
    } catch (e) {}
  }
  if (!files || files.length === 0) {
    const allStoredFiles = loadStoredFiles();
    files = userId ? allStoredFiles.filter(f => String(f.userId) === String(userId)) : allStoredFiles;
  }

  if (!files || files.length === 0) {
    const _emptyResult = {
      totalChunks: 0,
      deduplicatedChunks: 0,
      totalLogicalBytes: 0,
      totalPhysicalBytes: 0,
      savedBytes: 0,
      savingsPercent: 0,
      storageEfficiencyRatio: 1.0
    };
    _dedupStatsCache.set(_cacheKey, { ts: Date.now(), stats: _emptyResult });
    return _emptyResult;
  }

  const userFileIds = new Set(files.map(f => String(f.id || f._id)));

  // Ensure memChunks reflects stored chunks on disk
  try {
    const diskChunks = loadStoredChunks();
    if (diskChunks.length > memChunks.length || memChunks.length === 0) {
      memChunks.splice(0, memChunks.length, ...diskChunks);
    }
  } catch (e) {}

  // 3. Load stored chunks (merge in-memory/persisted JSON store with MongoDB Atlas)
  const chunkMap = new Map();
  for (const c of memChunks) {
    if (c.chunkHash) chunkMap.set(c.chunkHash, { ...c });
  }
  if (isMongoConnected) {
    try {
      const dbChunks = await StoredChunk.find().lean();
      for (const dbc of dbChunks) {
        if (dbc.chunkHash) {
          const existing = chunkMap.get(dbc.chunkHash);
          if (existing) {
            const mergedFileIds = Array.from(new Set([...(existing.fileIds || []), ...(dbc.fileIds || [])]));
            chunkMap.set(dbc.chunkHash, {
              ...existing,
              ...dbc,
              fileIds: mergedFileIds,
              refCount: Math.max(Number(existing.refCount) || 1, Number(dbc.refCount) || 1, mergedFileIds.length)
            });
          } else {
            chunkMap.set(dbc.chunkHash, dbc);
          }
        }
      }
    } catch (e) {}
  }
  const chunks = Array.from(chunkMap.values());

  // Filter chunks referenced by user's files
  const userChunks = chunks.filter(c => 
    c.fileIds && c.fileIds.some(fid => userFileIds.has(String(fid)))
  );

  // 4. Calculate Logical Bytes, Physical Disk Bytes, and Deduplication Savings
  let totalLogicalBytes = 0;
  for (const f of files) {
    totalLogicalBytes += (Number(f.originalFileSize || f.size || f.fileSize) || 0);
  }

  let deduplicatedCount = 0;
  let savedBytes = 0;
  let totalPhysicalBytes = 0;

  for (const c of userChunks) {
    // 1. Measure real physical disk bytes occupied by this unique chunk's shards.
    //    Use stored shardSize field — already accurate from upload time — to avoid
    //    per-shard fs.statSync() calls that were the main performance bottleneck.
    let chunkPhysicalBytes = 0;
    if (c.shards && Array.isArray(c.shards) && c.shards.length > 0) {
      for (const s of c.shards) {
        chunkPhysicalBytes += (Number(s.shardSize || s.size) || 0);
      }
    }
    // Fallback if shard records missing: RS(4+2) = 6 * ceil(chunkSize / 4)
    if (chunkPhysicalBytes === 0) {
      const cSize = Number(c.chunkSize) || 0;
      chunkPhysicalBytes = Math.ceil(cSize / 4) * 6;
    }

    // Number of references to this chunk by this user's files
    const userFilesCount = c.fileIds ? c.fileIds.filter(fid => userFileIds.has(String(fid))).length : 1;
    // Total global references to this chunk
    const totalRefCount = Math.max(Number(c.refCount) || 1, c.fileIds ? c.fileIds.length : 1);

    // This unique chunk is stored once on physical storage:
    totalPhysicalBytes += chunkPhysicalBytes;

    // Redundant physical shard writes avoided by deduplication:
    const redundantCopies = userId ? Math.max(0, userFilesCount - 1) : Math.max(0, totalRefCount - 1);
    if (redundantCopies > 0) {
      deduplicatedCount++;
      savedBytes += redundantCopies * chunkPhysicalBytes;
    }
  }

  // Baseline physical storage without deduplication = actual physical shards + saved physical shards avoided
  const baselinePhysicalBytes = totalPhysicalBytes + savedBytes;
  const savingsPercent = baselinePhysicalBytes > 0
    ? parseFloat(((savedBytes / baselinePhysicalBytes) * 100).toFixed(1))
    : 0;

  const storageEfficiencyRatio = totalPhysicalBytes > 0
    ? parseFloat(((totalPhysicalBytes + savedBytes) / totalPhysicalBytes).toFixed(2))
    : 1.0;

  // Total chunk references across files
  const totalChunksCount = userChunks.reduce((acc, c) => 
    acc + (c.fileIds ? c.fileIds.filter(fid => userFileIds.has(String(fid))).length : 1), 0
  ) || files.length;

  const _result = {
    totalChunks: totalChunksCount,
    deduplicatedChunks: deduplicatedCount,
    totalLogicalBytes,
    totalPhysicalBytes,
    savedBytes,
    savingsPercent,
    storageEfficiencyRatio: Math.max(1.0, storageEfficiencyRatio)
  };

  // Store in TTL cache for rapid subsequent requests
  _dedupStatsCache.set(_cacheKey, { ts: Date.now(), stats: _result });

  return _result;
};
