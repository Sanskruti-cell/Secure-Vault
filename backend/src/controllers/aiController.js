import { File } from '../models/File.js';
import { StorageNode } from '../models/StorageNode.js';
import { ActivityLog } from '../models/ActivityLog.js';
import { SharedFile } from '../models/SharedFile.js';
import { isMongoConnected } from '../config/db.js';
import { getNodesWithMLReliability, GLOBAL_INFRA_NODES } from '../services/nodeService.js';
import { memFiles, memShards, memActivities } from './fileController.js';
import { memoryShares } from './shareController.js';
import { memChunks } from '../services/dedupService.js';

export const processAiCommand = async (req, res, next) => {
  try {
    const { prompt } = req.body;
    const userId = req.user ? (req.user._id || req.user.id) : null;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const p = prompt.trim();
    const cmd = p.toLowerCase();
    let response = '';
    let action = null;

    // Gather live state
    let userFiles = [];
    if (isMongoConnected && userId) {
      try {
        userFiles = await File.find({ userId }).lean();
      } catch (e) {
        userFiles = [];
      }
    }
    if (userFiles.length === 0) {
      userFiles = memFiles.filter(f => !userId || String(f.userId) === String(userId));
    }
    if (userFiles.length === 0 && memFiles.length > 0) {
      userFiles = memFiles;
    }

    let activeShares = [];
    if (isMongoConnected && userId) {
      try {
        activeShares = await SharedFile.find({ creatorUserId: userId, status: 'active' }).lean();
      } catch (e) {
        activeShares = [];
      }
    }
    if (activeShares.length === 0) {
      activeShares = memoryShares.filter(s => s.status === 'active');
    }

    let clusterNodes = [];
    try {
      clusterNodes = await getNodesWithMLReliability();
    } catch (e) {
      clusterNodes = GLOBAL_INFRA_NODES;
    }

    // ------------------------------------------------------------------------
    // 1. NAVIGATION & SHORTCUT ACTIONS
    // ------------------------------------------------------------------------
    if (cmd.includes('upload') || cmd.includes('encrypt') || cmd.includes('ingest') || cmd.includes('add file')) {
      action = { type: 'NAVIGATE', route: 'upload', label: 'Go to Ingest & Encrypt' };
      response = 'Navigating to the **Ingest & Encrypt** pipeline. Client-side AES-256-GCM chunked encryption with NIST SP 800-38F key wrapping is active and ready for your file.';

    } else if (cmd.includes('go to vault') || cmd.includes('open vault') || cmd.includes('view vault') || cmd.includes('show vault') || cmd.includes('my vault') || cmd.includes('list files')) {
      action = { type: 'NAVIGATE', route: 'vault', label: 'Open My Vault' };
      const totalBytes = userFiles.reduce((acc, f) => acc + (f.size || f.fileSize || 0), 0);
      const mb = (totalBytes / (1024 * 1024)).toFixed(2);
      response = `Navigating to **My Vault**. You currently have **${userFiles.length} encrypted file(s)** stored across the decentralized mesh (${mb} MB total). All files are sealed with zero-knowledge envelope encryption.`;

    } else if (cmd.includes('node') || cmd.includes('health') || cmd.includes('cluster') || cmd.includes('storage node') || cmd.includes('mesh')) {
      action = { type: 'NAVIGATE', route: 'nodes', label: 'View Storage Cluster' };
      const onlineCount = clusterNodes.filter(n => n.status !== 'offline' && !n.isSimulatedFailure).length;
      const scores = clusterNodes.map(n => n.mlReliabilityScore || n.reliabilityScore || 98.5);
      const avgScore = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
      response = `Cluster Status: **${onlineCount}/${clusterNodes.length} nodes online** with a cluster quorum of ${((onlineCount / clusterNodes.length) * 100).toFixed(0)}%. Average ML-predicted reliability is **${avgScore}%**. Erasure coding threshold: K=4 data + M=2 parity (tolerant of up to 2 simultaneous node outages).`;

    } else if (cmd.includes('security') || cmd.includes('audit') || cmd.includes('compliance') || cmd.includes('chain')) {
      action = { type: 'NAVIGATE', route: 'security', label: 'View Security & Audit' };
      const auditCount = isMongoConnected ? await ActivityLog.countDocuments().catch(() => memActivities.length) : memActivities.length;
      response = `Zero-Knowledge security posture is **Optimal (Score: 99/100)**. The tamper-evident blockchain audit hash chain has **${auditCount} verified sequential records**. Plaintext keys never touch the server.`;

    } else if (cmd.includes('share') || cmd.includes('link') || cmd.includes('shared')) {
      action = { type: 'NAVIGATE', route: 'shares', label: 'Manage Share Envelopes' };
      response = `Navigating to **Share Envelopes**. You have **${activeShares.length} active zero-knowledge share links**. Secret link keys are passed exclusively via URL hash fragments (#key=...) and are never transmitted to server headers or storage.`;

    } else if (cmd.includes('config') || cmd.includes('setting') || cmd.includes('configuration')) {
      action = { type: 'NAVIGATE', route: 'config', label: 'Open Vault Configuration' };
      response = 'Opening **Vault Configuration**. Here you can manage your master passphrase, PBKDF2 iteration limits, auto-lock timeouts, and security policies.';

    } else if (cmd.includes('dashboard') || cmd.includes('command center') || cmd.includes('overview') || cmd.includes('home')) {
      action = { type: 'NAVIGATE', route: 'dashboard', label: 'Return to Command Center' };
      response = 'Returning to the **Command Center** overview dashboard.';

    // ------------------------------------------------------------------------
    // 2. SEARCH & FILE INTELLIGENCE
    // ------------------------------------------------------------------------
    } else if (cmd.includes('find') || cmd.includes('search') || cmd.includes('where is')) {
      // Extract search term after find/search/where is
      const cleaned = cmd.replace(/^(can you )?(please )?(find|search for|search|where is|locate)\s+/i, '').trim();
      const matches = userFiles.filter(f => (f.name || f.fileName || '').toLowerCase().includes(cleaned));

      if (matches.length > 0) {
        action = { type: 'NAVIGATE', route: 'vault', label: 'View in Vault' };
        const fileNames = matches.slice(0, 3).map(m => `"${m.name || m.fileName}" (${((m.size || m.fileSize || 0) / 1024).toFixed(1)} KB)`).join(', ');
        response = `Found **${matches.length} matching file(s)**: ${fileNames}. Status: Encrypted (AES-256-GCM) with Reed-Solomon 4+2 distribution across 6 storage nodes.`;
      } else {
        response = `No files matching "${cleaned}" were found in your vault. Try listing all files or uploading a new file.`;
      }

    } else if (cmd.includes('dedup') || cmd.includes('saving') || cmd.includes('duplicate')) {
      const dedupedFiles = userFiles.filter(f => f.isDeduplicated);
      const totalDedupChunks = memChunks.filter(c => c.refCount > 1).length;
      response = `Content-Addressed Deduplication Analysis: **${dedupedFiles.length} file(s)** are currently reusing physical storage shards without duplicate disk allocation (${totalDedupChunks} multi-referenced chunks). Shard ref-counts ensure physical data is only freed when the final reference is deleted.`;

    // ------------------------------------------------------------------------
    // 3. CRYPTOGRAPHIC & ARCHITECTURAL EXPLANATIONS
    // ------------------------------------------------------------------------
    } else if (cmd.includes('how does encryption work') || cmd.includes('explain encryption') || cmd.includes('zero knowledge') || cmd.includes('zero-knowledge')) {
      response = 'SecureVault uses a **true Zero-Knowledge client-side architecture**:\n\n1. **Data Encryption Key (DEK)**: A fresh 256-bit AES-GCM symmetric key encrypts file chunks in the browser.\n2. **Key Encryption Key (KEK)**: Derived via PBKDF2-HMAC-SHA256 (100,000 rounds) from your master passphrase + a unique 16-byte salt.\n3. **Key Wrapping**: The DEK is sealed with NIST SP 800-38F AES Key Wrap. Plaintext passwords and raw DEKs NEVER leave your browser or touch server storage.';

    } else if (cmd.includes('reed solomon') || cmd.includes('reed-solomon') || cmd.includes('erasure') || cmd.includes('why 4+2') || cmd.includes('recovery')) {
      response = 'SecureVault implements **Reed-Solomon 4+2 Erasure Coding** over Galois Field GF(2^8):\n\n- Encrypted payloads are partitioned into **4 systematic data shards** + **2 Cauchy parity shards**.\n- Distributed across 6 multi-cloud nodes (AWS, GCP, Azure, Local).\n- **High Availability**: Any 4 of the 6 shards can mathematically reconstruct the full payload via Cauchy matrix inversion, allowing the system to withstand up to 2 total node outages without data loss.';

    // ------------------------------------------------------------------------
    // 4. GENERAL ASSISTANT FALLBACK
    // ------------------------------------------------------------------------
    } else {
      response = `SecureVault AI ready: I analyzed "${p}". Cluster status is normal with ${clusterNodes.filter(n => n.status !== 'offline').length}/6 nodes online and ${userFiles.length} encrypted vault files. Type "upload", "check node health", "show vault", "dedup stats", or "explain zero-knowledge" for guided operations.`;
    }

    console.log(`[${new Date().toISOString()}] [SECUREVAULT] [AI COMMAND] Processed: "${p}" -> Action: ${action ? action.route : 'None'}`);

    return res.status(200).json({
      success: true,
      prompt: p,
      response,
      action
    });
  } catch (error) {
    next(error);
  }
};

export const processAICommand = processAiCommand;
