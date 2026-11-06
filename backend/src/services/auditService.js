import crypto from 'crypto';
import { ActivityLog } from '../models/ActivityLog.js';
import { isMongoConnected } from '../config/db.js';
import { memActivities, saveStoredActivities } from './storeService.js';

export const GENESIS_PREV_HASH = '0'.repeat(64);

/**
 * Computes deterministic SHA-256 entry hash for audit record.
 *
 * @param {object} params
 * @returns {string} SHA-256 hex digest
 */
export const computeEntryHash = ({
  sequenceNumber,
  previousEntryHash,
  timestamp,
  userId,
  action,
  title,
  description,
  fileId = null
}) => {
  const payload = [
    sequenceNumber,
    previousEntryHash,
    timestamp,
    String(userId || ''),
    action,
    title,
    description,
    String(fileId || '')
  ].join('|');

  return crypto.createHash('sha256').update(payload).digest('hex');
};

/**
 * Safely anchors and backfills legacy activity log entries into the sequential cryptographic hash chain.
 * Sorts activities chronologically from oldest to newest, assigns sequential numbers starting at 0,
 * and computes deterministic SHA-256 forward links so legacy records gain cryptographic tamper-evidence
 * without loss of historical activity data.
 */
export const initializeOrMigrateAuditChain = () => {
  if (!memActivities || memActivities.length === 0) return;

  const seqCounts = new Set();
  let hasDuplicateSeq = false;
  for (const a of memActivities) {
    if (a.sequenceNumber !== null && a.sequenceNumber !== undefined && !isNaN(Number(a.sequenceNumber))) {
      if (seqCounts.has(Number(a.sequenceNumber))) {
        hasDuplicateSeq = true;
        break;
      }
      seqCounts.add(Number(a.sequenceNumber));
    }
  }

  // Check if any activity is missing sequenceNumber or entryHash or has NaN sequence or duplicate sequences
  const hasLegacyOrCorrupt = hasDuplicateSeq || memActivities.some(a => 
    a.sequenceNumber === null || 
    a.sequenceNumber === undefined || 
    isNaN(Number(a.sequenceNumber)) || 
    !a.entryHash ||
    String(a.id || '').includes('NaN')
  );

  if (!hasLegacyOrCorrupt) return;

  // Sort activities chronologically (oldest first)
  const sorted = [...memActivities].sort((a, b) => {
    if (!hasDuplicateSeq) {
      const seqA = (a.sequenceNumber !== null && a.sequenceNumber !== undefined && !isNaN(Number(a.sequenceNumber))) ? Number(a.sequenceNumber) : null;
      const seqB = (b.sequenceNumber !== null && b.sequenceNumber !== undefined && !isNaN(Number(b.sequenceNumber))) ? Number(b.sequenceNumber) : null;
      if (seqA !== null && seqB !== null && seqA !== seqB) return seqA - seqB;
    }

    const tA = (a.createdAt ? new Date(a.createdAt).getTime() : 0) ||
               (parseInt((a.id || '').replace(/^act-/, '').split('-')[0])) || 0;
    const tB = (b.createdAt ? new Date(b.createdAt).getTime() : 0) ||
               (parseInt((b.id || '').replace(/^act-/, '').split('-')[0])) || 0;
    return tA - tB;
  });

  let prevHash = GENESIS_PREV_HASH;

  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    const isUnchained = hasDuplicateSeq ||
                        entry.sequenceNumber === null || 
                        entry.sequenceNumber === undefined || 
                        isNaN(Number(entry.sequenceNumber)) || 
                        !entry.entryHash ||
                        String(entry.id || '').includes('NaN');

    if (isUnchained) {
      entry.sequenceNumber = i;
      entry.previousEntryHash = prevHash;
      
      const tsMs = parseInt((entry.id || '').replace(/^act-/, '').split('-')[0]);
      if (!entry.createdAt && !isNaN(tsMs) && tsMs > 0) {
        entry.createdAt = new Date(tsMs).toISOString();
      } else if (!entry.createdAt) {
        entry.createdAt = new Date().toISOString();
      }

      if (!entry.action) {
        const desc = (entry.description || '').toLowerCase();
        if (desc.includes('shredded') || desc.includes('purged')) entry.action = 'FILE_SHREDDED';
        else if (desc.includes('retrieved') || desc.includes('download')) entry.action = 'FILE_DOWNLOADED';
        else if (desc.includes('upload')) entry.action = 'FILE_UPLOADED';
        else if (desc.includes('auth') || desc.includes('session') || desc.includes('logged in')) entry.action = 'USER_LOGGED_IN';
        else entry.action = 'SYSTEM_ACTIVITY';
      }

      if (!entry.title) {
        entry.title = entry.action.replace(/_/g, ' ');
      }

      if (!entry.id || String(entry.id).includes('NaN')) {
        entry.id = `act-${tsMs || Date.now()}-${entry.sequenceNumber}`;
      }

      entry.entryHash = computeEntryHash({
        sequenceNumber: entry.sequenceNumber,
        previousEntryHash: entry.previousEntryHash,
        timestamp: entry.createdAt,
        userId: entry.userId,
        action: entry.action,
        title: entry.title,
        description: entry.description,
        fileId: entry.fileId
      });
    }

    prevHash = entry.entryHash;
  }

  // Restore memActivities in newest-first order (as expected by unshift / UI)
  memActivities.length = 0;
  memActivities.push(...[...sorted].reverse());
  saveStoredActivities(memActivities);
};

// Initialize chain on startup if legacy activities exist
initializeOrMigrateAuditChain();

/**
 * Appends a tamper-evident audit record to the hash chain.
 *
 * @param {object} logData
 * @returns {Promise<object>} Created audit record
 */
export const recordAuditEntry = async ({
  userId,
  action,
  title,
  description,
  fileId = null,
  metadata = {},
  isAICommand = false
}) => {
  // Ensure existing entries are anchored before appending new block
  initializeOrMigrateAuditChain();

  const timestamp = new Date().toISOString();

  // Find the previous entry to extract sequenceNumber and entryHash
  let latestEntry = null;
  if (isMongoConnected) {
    try {
      latestEntry = await ActivityLog.findOne({
        sequenceNumber: { $exists: true, $ne: null }
      }).sort({ sequenceNumber: -1 }).lean();
    } catch (e) {}
  }
  if (!latestEntry && memActivities.length > 0) {
    const validChained = memActivities.filter(a =>
      a.sequenceNumber !== null &&
      a.sequenceNumber !== undefined &&
      !isNaN(Number(a.sequenceNumber)) &&
      a.entryHash
    );
    if (validChained.length > 0) {
      validChained.sort((a, b) => Number(b.sequenceNumber) - Number(a.sequenceNumber));
      latestEntry = validChained[0];
    }
  }

  const sequenceNumber = (latestEntry && typeof latestEntry.sequenceNumber === 'number' && !isNaN(latestEntry.sequenceNumber))
    ? (Number(latestEntry.sequenceNumber) + 1)
    : 0;
  const previousEntryHash = latestEntry && latestEntry.entryHash ? latestEntry.entryHash : GENESIS_PREV_HASH;

  const entryHash = computeEntryHash({
    sequenceNumber,
    previousEntryHash,
    timestamp,
    userId,
    action,
    title,
    description,
    fileId
  });

  const entry = {
    id: `act-${Date.now()}-${sequenceNumber}`,
    userId: String(userId || ''),
    sequenceNumber,
    previousEntryHash,
    entryHash,
    action,
    title,
    description,
    fileId,
    metadata,
    isAICommand,
    createdAt: timestamp,
    timestamp: new Date().toLocaleTimeString(),
    status: action && action.includes('FAIL') ? 'warning' : 'success'
  };

  if (isMongoConnected) {
    try {
      await ActivityLog.create({
        ...entry,
        userId
      });
    } catch (dbErr) {
      console.warn('[Audit Chain Warning] MongoDB insert failed, preserved locally:', dbErr.message);
    }
  }

  memActivities.unshift(entry);
  saveStoredActivities(memActivities);

  return entry;
};

/**
 * Verifies the mathematical integrity of the entire audit hash chain.
 * Detects modified, missing, inserted, or reordered entries.
 *
 * @returns {Promise<{ isValid: boolean, totalEntries: number, checkedEntries: number, error: string|null, brokenSequenceIndex: number|null }>}
 */
export const verifyAuditChain = async () => {
  // Ensure legacy records are anchored before verification
  initializeOrMigrateAuditChain();

  let entries = [];
  if (isMongoConnected) {
    try {
      entries = await ActivityLog.find({
        sequenceNumber: { $exists: true, $ne: null }
      }).sort({ sequenceNumber: 1 }).lean();
    } catch (e) {}
  }

  if (entries.length === 0) {
    // Local store: filter valid chained entries and sort by sequenceNumber ascending
    entries = [...memActivities]
      .filter(a => a.sequenceNumber !== null && a.sequenceNumber !== undefined && !isNaN(Number(a.sequenceNumber)))
      .sort((a, b) => Number(a.sequenceNumber) - Number(b.sequenceNumber));
  }

  if (entries.length === 0) {
    return {
      isValid: true,
      totalEntries: 0,
      checkedEntries: 0,
      error: null,
      brokenSequenceIndex: null,
      message: 'Audit chain is empty. Genesis block not yet created.'
    };
  }

  let expectedPrevHash = GENESIS_PREV_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const seq = Number(entry.sequenceNumber);

    // 1. Strict sequence increment check
    if (seq !== i) {
      return {
        isValid: false,
        totalEntries: entries.length,
        checkedEntries: i,
        error: `Sequence discontinuity detected at index ${i}. Expected sequence ${i}, found ${seq}.`,
        brokenSequenceIndex: i
      };
    }

    // 2. Previous hash link check
    if (entry.previousEntryHash !== expectedPrevHash) {
      return {
        isValid: false,
        totalEntries: entries.length,
        checkedEntries: i,
        error: `Broken hash chain at sequence #${seq}: previousEntryHash "${entry.previousEntryHash}" does not match expected "${expectedPrevHash}".`,
        brokenSequenceIndex: seq
      };
    }

    // 3. Entry hash verification
    const recalculatedHash = computeEntryHash({
      sequenceNumber: seq,
      previousEntryHash: entry.previousEntryHash,
      timestamp: entry.createdAt instanceof Date ? entry.createdAt.toISOString() : (entry.createdAt || entry.timestamp),
      userId: entry.userId,
      action: entry.action,
      title: entry.title,
      description: entry.description,
      fileId: entry.fileId
    });

    if (entry.entryHash !== recalculatedHash) {
      return {
        isValid: false,
        totalEntries: entries.length,
        checkedEntries: i,
        error: `Tampered audit record detected at sequence #${seq}: computed hash "${recalculatedHash}" != stored "${entry.entryHash}".`,
        brokenSequenceIndex: seq
      };
    }

    expectedPrevHash = entry.entryHash;
  }

  return {
    isValid: true,
    totalEntries: entries.length,
    checkedEntries: entries.length,
    error: null,
    brokenSequenceIndex: null,
    latestEntryHash: expectedPrevHash,
    message: `All ${entries.length} audit entries verified. Cryptographic hash chain is 100% intact.`
  };
};
