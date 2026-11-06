/**
 * One-time deduplication cleanup for files_store.json.
 * Keeps the first occurrence of each unique ciphertextHash (or fileHash) per user,
 * AND always keeps any file that has actual shards on disk.
 * Does NOT delete shard files. Does NOT touch other users' files.
 * Backs up the original store before modifying.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, '../data/files_store.json');
const SHARDS_PATH = path.join(__dirname, '../data/shards_store.json');
const BACKUP_PATH = path.join(__dirname, `../data/files_store.backup_${Date.now()}.json`);

const files = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
const shards = JSON.parse(fs.readFileSync(SHARDS_PATH, 'utf8'));

// File IDs that have real shard records — always keep these
const fileIdsWithShards = new Set(shards.map(s => s.fileId));
console.log(`Total files in store: ${files.length}`);
console.log(`File IDs with shards: ${fileIdsWithShards.size}`);

// Deduplicate: per user, keep first occurrence by ciphertextHash or fileHash
const seenHashes = {};  // userId -> Set of hashes
const seenIds = new Set();
const keptFiles = [];
const removedCount = { total: 0, byUser: {} };

for (const f of files) {
  const userId = String(f.userId || 'unknown');
  const hash = f.ciphertextHash || f.fileHash || null;
  const hasRealShards = fileIdsWithShards.has(f.id);

  if (!seenHashes[userId]) seenHashes[userId] = new Set();

  // Always keep if it has real shards
  if (hasRealShards) {
    keptFiles.push(f);
    seenIds.add(f.id);
    if (hash) seenHashes[userId].add(hash);
    continue;
  }

  // Deduplicate by hash
  if (hash && seenHashes[userId].has(hash)) {
    // Skip duplicate
    removedCount.total++;
    removedCount.byUser[userId] = (removedCount.byUser[userId] || 0) + 1;
    continue;
  }

  // Keep first occurrence
  keptFiles.push(f);
  seenIds.add(f.id);
  if (hash) seenHashes[userId].add(hash);
}

console.log(`\nKept: ${keptFiles.length} files`);
console.log(`Removed: ${removedCount.total} duplicate files`);
console.log('By user:');
for (const [uid, cnt] of Object.entries(removedCount.byUser)) {
  console.log(`  ${uid}: -${cnt}`);
}

// Write backup
fs.copyFileSync(STORE_PATH, BACKUP_PATH);
console.log(`\nBackup written to: ${BACKUP_PATH}`);

// Write cleaned store
fs.writeFileSync(STORE_PATH, JSON.stringify(keptFiles, null, 2));
console.log(`Cleaned store written: ${keptFiles.length} files total`);

// Verify
const verify = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
console.log(`Verification: ${verify.length} files in cleaned store`);
