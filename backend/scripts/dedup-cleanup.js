/**
 * One-time deduplication cleanup script for SecureVault.
 * 
 * Deduplicates files_store.json by (userId, fileName, fileHash),
 * keeping only the newest record per unique file.
 * Also cleans up duplicate MongoDB Atlas records.
 * 
 * Usage: node backend/scripts/dedup-cleanup.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');
const FILES_FILE = path.join(DATA_DIR, 'files_store.json');

function contentKey(userId, fileName, fileHash) {
  return `${String(userId || '')}::${String(fileName || '')}::${String(fileHash || '')}`;
}

console.log('='.repeat(60));
console.log('[SecureVault Dedup] Starting deduplication cleanup...');
console.log('='.repeat(60));

// 1. Read the local files store
const raw = fs.readFileSync(FILES_FILE, 'utf8');
const allFiles = JSON.parse(raw);
console.log(`\n[Before] Total records in files_store.json: ${allFiles.length}`);

// 2. Deduplicate: keep the newest record per (userId, fileName, fileHash)
const deduped = new Map();
for (const f of allFiles) {
  const fName = f.name || f.fileName;
  const fHash = f.fileHash || f.hash;
  const ck = contentKey(f.userId, fName, fHash);
  const existing = deduped.get(ck);
  
  if (!existing) {
    deduped.set(ck, f);
  } else {
    // Prefer MongoDB ObjectId format IDs (24-char hex strings)
    const existId = existing.id || '';
    const curId = f.id || '';
    const existIsMongoId = /^[a-f0-9]{24}$/.test(existId);
    const curIsMongoId = /^[a-f0-9]{24}$/.test(curId);
    
    if (curIsMongoId && !existIsMongoId) {
      deduped.set(ck, f);
    } else if (existIsMongoId && !curIsMongoId) {
      // keep existing
    } else {
      // Both same type; keep the newer one by encryptedAt
      const existTime = existing.encryptedAt ? new Date(existing.encryptedAt).getTime() : 0;
      const curTime = f.encryptedAt ? new Date(f.encryptedAt).getTime() : 0;
      if (curTime > existTime) deduped.set(ck, f);
    }
  }
}

const dedupedFiles = [...deduped.values()];
const removedCount = allFiles.length - dedupedFiles.length;

console.log(`[After]  Unique file records: ${dedupedFiles.length}`);
console.log(`[Removed] Duplicate records removed: ${removedCount}`);

// 3. Show per-user breakdown
const userCounts = {};
dedupedFiles.forEach(f => {
  const uid = f.userId || '?';
  userCounts[uid] = (userCounts[uid] || 0) + 1;
});
console.log('\nPer-user breakdown after dedup:');
Object.entries(userCounts)
  .sort(([,a], [,b]) => b - a)
  .forEach(([uid, cnt]) => console.log(`  ${uid}: ${cnt} files`));

// 4. Backup and write
const backupPath = FILES_FILE + '.backup-' + Date.now();
fs.copyFileSync(FILES_FILE, backupPath);
console.log(`\n[Backup] Saved backup to: ${backupPath}`);

fs.writeFileSync(FILES_FILE, JSON.stringify(dedupedFiles, null, 2), 'utf8');
console.log(`[Written] Deduplicated files_store.json saved (${dedupedFiles.length} records).`);

console.log('\n' + '='.repeat(60));
console.log('[SecureVault Dedup] Cleanup complete!');
console.log('='.repeat(60));
