import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';

import { env } from '../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');
const USERS_FILE = path.join(DATA_DIR, 'users_store.json');

const defaultPasswordHash = bcrypt.hashSync('password123', 10);
const INITIAL_DEMO_USERS = [
  { id: 'usr-alex-demo', name: 'Alex Vance', email: 'alex@securevault.io', passwordHash: defaultPasswordHash, createdAt: new Date().toISOString() },
  { id: 'usr-admin-demo', name: 'Security Admin', email: 'admin@securevault.io', passwordHash: defaultPasswordHash, createdAt: new Date().toISOString() },
  { id: 'usr-demo-demo', name: 'Demo User', email: 'demo@securevault.io', passwordHash: defaultPasswordHash, createdAt: new Date().toISOString() },
];

export const loadStoredUsers = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const shouldSeedDemo = env.enableDemoAccounts === true;
    if (!fs.existsSync(USERS_FILE)) {
      const initialList = shouldSeedDemo ? [...INITIAL_DEMO_USERS] : [];
      fs.writeFileSync(USERS_FILE, JSON.stringify(initialList, null, 2), 'utf8');
      return initialList;
    }
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return shouldSeedDemo ? [...INITIAL_DEMO_USERS] : [];
  } catch (err) {
    console.warn('[StoreService Warning] Failed to read users file:', err.message);
    return env.enableDemoAccounts ? [...INITIAL_DEMO_USERS] : [];
  }
};

export const saveStoredUsers = (users) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.warn('[StoreService Warning] Failed to write users file:', err.message);
  }
};

const FILES_FILE = path.join(DATA_DIR, 'files_store.json');
const SHARDS_FILE = path.join(DATA_DIR, 'shards_store.json');
const ACTIVITIES_FILE = path.join(DATA_DIR, 'activities_store.json');
const SHARES_FILE = path.join(DATA_DIR, 'shares_store.json');

export const loadStoredShares = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(SHARES_FILE)) {
      fs.writeFileSync(SHARES_FILE, JSON.stringify([], null, 2), 'utf8');
      return [];
    }
    const data = fs.readFileSync(SHARES_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[StoreService Warning] Failed to read shares store:', err.message);
    return [];
  }
};

export const saveStoredShares = (shares) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SHARES_FILE, JSON.stringify(shares, null, 2), 'utf8');
  } catch (err) {
    console.warn('[StoreService Warning] Failed to write shares store:', err.message);
  }
};

export const loadStoredFiles = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(FILES_FILE)) {
      fs.writeFileSync(FILES_FILE, JSON.stringify([], null, 2), 'utf8');
      return [];
    }
    const data = fs.readFileSync(FILES_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[StoreService Warning] Failed to read files store:', err.message);
    return [];
  }
};

export const saveStoredFiles = (files) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(FILES_FILE, JSON.stringify(files, null, 2), 'utf8');
  } catch (err) {
    console.warn('[StoreService Warning] Failed to write files store:', err.message);
  }
};

export const loadStoredShards = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(SHARDS_FILE)) {
      fs.writeFileSync(SHARDS_FILE, JSON.stringify([], null, 2), 'utf8');
      return [];
    }
    const data = fs.readFileSync(SHARDS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[StoreService Warning] Failed to read shards store:', err.message);
    return [];
  }
};

export const saveStoredShards = (shards) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(SHARDS_FILE, JSON.stringify(shards, null, 2), 'utf8');
  } catch (err) {
    console.warn('[StoreService Warning] Failed to write shards store:', err.message);
  }
};

export const loadStoredActivities = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(ACTIVITIES_FILE)) {
      fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify([], null, 2), 'utf8');
      return [];
    }
    const data = fs.readFileSync(ACTIVITIES_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[StoreService Warning] Failed to read activities store:', err.message);
    return [];
  }
};

export const saveStoredActivities = (activities) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ACTIVITIES_FILE, JSON.stringify(activities, null, 2), 'utf8');
  } catch (err) {
    console.warn('[StoreService Warning] Failed to write activities store:', err.message);
  }
};

export const memActivities = loadStoredActivities();

export const syncStoreWithMongo = async () => {
  try {
    const mongoose = (await import('mongoose')).default;
    if (mongoose.connection.readyState !== 1) return;

    const { File } = await import('../models/File.js');
    const { FileShard } = await import('../models/FileShard.js');

    // Helper: content-based deduplication key (userId + fileName + fileHash)
    const contentKey = (userId, fileName, fileHash) =>
      `${String(userId || '')}::${String(fileName || '')}::${String(fileHash || '')}`;

    // 1. Pull from MongoDB Atlas into local store (deduplicate by content, not by ID)
    const dbFiles = await File.find().lean();
    const storedFiles = loadStoredFiles();
    const storedShards = loadStoredShards();

    // Build a set of content keys already present in the local store
    const localContentKeys = new Set();
    storedFiles.forEach(f => {
      const fName = f.name || f.fileName;
      const fHash = f.fileHash || f.hash;
      localContentKeys.add(contentKey(f.userId, fName, fHash));
    });

    let pullCount = 0;
    for (const dbF of dbFiles) {
      const fName = dbF.fileName;
      const fHash = dbF.fileHash;
      const ck = contentKey(dbF.userId, fName, fHash);

      if (!localContentKeys.has(ck)) {
        storedFiles.push({
          id: dbF._id.toString(),
          userId: dbF.userId.toString(),
          name: fName,
          fileName: fName,
          size: dbF.originalFileSize || dbF.fileSize,
          fileSize: dbF.fileSize,
          type: dbF.mimeType,
          mimeType: dbF.mimeType,
          hash: dbF.originalFileHash || fHash,
          fileHash: fHash,
          cryptoVersion: dbF.cryptoVersion || 2,
          shardingVersion: dbF.shardingVersion || 2,
          erasureCoding: dbF.erasureCoding || 'reed-solomon',
          dataShards: dbF.dataShards || 4,
          parityShards: dbF.parityShards || 2,
          totalShards: dbF.totalShards || 6,
          encryptedAt: dbF.createdAt ? new Date(dbF.createdAt).toISOString() : new Date().toISOString(),
          shardsCount: dbF.shardCount || 6,
          status: 'encrypted',
          wrappedDEK: dbF.wrappedDEK,
          kdf: dbF.kdf,
          kdfSalt: dbF.kdfSalt,
          kdfIterations: dbF.kdfIterations,
          baseNonce: dbF.baseNonce,
          chunkSize: dbF.chunkSize,
          chunkCount: dbF.chunkCount,
          originalFileHash: dbF.originalFileHash,
          originalFileSize: dbF.originalFileSize || dbF.fileSize,
          isPasswordProtected: !!dbF.isPasswordProtected
        });
        localContentKeys.add(ck);
        pullCount++;
      }
    }

    // 2. Deduplicate the local store: keep only the newest record per (userId, fileName, fileHash)
    const deduped = new Map();
    for (const f of storedFiles) {
      const fName = f.name || f.fileName;
      const fHash = f.fileHash || f.hash;
      const ck = contentKey(f.userId, fName, fHash);
      const existing = deduped.get(ck);
      if (!existing) {
        deduped.set(ck, f);
      } else {
        // Keep the one with a valid MongoDB ObjectId, or the newer one
        const existId = existing.id || '';
        const curId = f.id || '';
        const existIsMongoId = mongoose.Types.ObjectId.isValid(existId);
        const curIsMongoId = mongoose.Types.ObjectId.isValid(curId);
        if (curIsMongoId && !existIsMongoId) {
          deduped.set(ck, f);
        } else if (existIsMongoId && !curIsMongoId) {
          // keep existing
        } else {
          // Both same type; keep the one with the newer encryptedAt / id
          const existTime = existing.encryptedAt ? new Date(existing.encryptedAt).getTime() : 0;
          const curTime = f.encryptedAt ? new Date(f.encryptedAt).getTime() : 0;
          if (curTime > existTime) deduped.set(ck, f);
        }
      }
    }
    const dedupedFiles = [...deduped.values()];
    const removedCount = storedFiles.length - dedupedFiles.length;

    // Save the deduplicated local store
    saveStoredFiles(dedupedFiles);

    // 3. Push local-only files to MongoDB Atlas if they don't already exist there (by content key)
    const dbContentKeys = new Set();
    dbFiles.forEach(f => {
      dbContentKeys.add(contentKey(f.userId, f.fileName, f.fileHash));
    });

    let pushCount = 0;
    for (const sf of dedupedFiles) {
      const fName = sf.name || sf.fileName;
      const fHash = sf.fileHash || sf.hash;
      const ck = contentKey(sf.userId, fName, fHash);
      const fileId = sf.id || String(sf._id);

      if (!dbContentKeys.has(ck)) {
        try {
          const createdDoc = await File.create({
            _id: mongoose.Types.ObjectId.isValid(fileId) ? new mongoose.Types.ObjectId(fileId) : undefined,
            userId: mongoose.Types.ObjectId.isValid(sf.userId) ? new mongoose.Types.ObjectId(sf.userId) : sf.userId,
            fileName: fName,
            fileSize: sf.size || sf.fileSize || 0,
            mimeType: sf.type || sf.mimeType || 'application/octet-stream',
            fileHash: fHash,
            cryptoVersion: sf.cryptoVersion || 2,
            shardingVersion: sf.shardingVersion || 2,
            erasureCoding: sf.erasureCoding || 'reed-solomon',
            dataShards: sf.dataShards || 4,
            parityShards: sf.parityShards || 2,
            totalShards: sf.totalShards || 6,
            encryptionAlgorithm: sf.encryptionAlgorithm || 'AES-256-GCM',
            wrappedDEK: sf.wrappedDEK,
            kdf: sf.kdf,
            kdfSalt: sf.kdfSalt,
            kdfIterations: sf.kdfIterations || 100000,
            baseNonce: sf.baseNonce,
            chunkSize: sf.chunkSize || 8388608,
            chunkCount: sf.chunkCount || 1,
            originalFileHash: sf.originalFileHash,
            originalFileSize: sf.originalFileSize || sf.size,
            isPasswordProtected: !!sf.isPasswordProtected,
            shardCount: sf.totalShards || 6,
            securityScore: 99
          });

          // Insert matching shards
          const matchingShards = storedShards.filter(s => s.fileId === fileId);
          if (matchingShards.length > 0) {
            const shardsToInsert = matchingShards.map(s => ({
              fileId: createdDoc._id,
              shardIndex: s.shardIndex,
              shardType: s.shardType,
              nodeId: s.nodeId,
              provider: s.provider || 'local',
              bucket: s.bucket || null,
              objectKey: s.objectKey || `${fileId}.shard.${s.shardIndex}`,
              shardHash: s.shardHash,
              shardSize: s.shardSize || s.size,
              storagePath: s.storagePath || s.filePath,
              status: s.status || 'active',
              lastVerifiedAt: s.lastVerifiedAt || new Date(),
              verificationHistory: s.verificationHistory || [],
              repairHistory: s.repairHistory || []
            }));
            await FileShard.insertMany(shardsToInsert).catch(() => {});
          }
          dbContentKeys.add(ck);
          pushCount++;
          console.log(`[Sync] Synced stored file "${fName}" (${fileId}) to MongoDB Atlas.`);
        } catch (syncErr) {
          if (syncErr.code === 11000) {
            // Duplicate key — file already exists in Atlas, skip silently
            dbContentKeys.add(ck);
          } else {
            console.warn(`[Sync Warning] Failed to sync file ${fileId} to Atlas:`, syncErr.message);
          }
        }
      }
    }

    if (pullCount > 0 || pushCount > 0 || removedCount > 0) {
      console.log(`[Sync] syncStoreWithMongo completed: pulled=${pullCount}, pushed=${pushCount}, deduplicatedRemoved=${removedCount}`);
    }
  } catch (err) {
    console.warn('[Sync Warning] syncStoreWithMongo error:', err.message);
  }
};
