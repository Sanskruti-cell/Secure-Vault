import { StorageNode } from '../models/StorageNode.js';
import { File } from '../models/File.js';
import { FileShard } from '../models/FileShard.js';
import { isMongoConnected } from '../config/db.js';
import { predictNodeHealthWithML, GLOBAL_INFRA_NODES } from '../services/nodeService.js';
import { memFiles, memShards } from './fileController.js';
import { logStorageNodeOffline, logStorageNodeRestored } from '../middleware/terminalLogger.js';

export const getNodes = async (req, res, next) => {
  try {
    const userId = req.user ? (req.user._id || req.user.id) : null;
    let baseNodes = [];

    if (isMongoConnected) {
      try {
        baseNodes = await StorageNode.find();
      } catch (err) {
        console.warn('[MongoDB Nodes Warning]:', err.message);
      }
    }
    if (!baseNodes || baseNodes.length === 0) {
      baseNodes = GLOBAL_INFRA_NODES;
    }

    const mlPredictions = await predictNodeHealthWithML(baseNodes);

    // Compute authenticated user's specific shard allocations per node
    let userShardsMap = {};
    let userStorageBytesMap = {};

    if (userId) {
      if (isMongoConnected) {
        try {
          const userFiles = await File.find({ userId }).select('_id');
          const userFileIds = userFiles.map(f => f._id);
          if (userFileIds.length > 0) {
            const userShards = await FileShard.find({ fileId: { $in: userFileIds } });
            userShards.forEach(s => {
              const nId = s.nodeId;
              if (nId) {
                userShardsMap[nId] = (userShardsMap[nId] || 0) + 1;
                userStorageBytesMap[nId] = (userStorageBytesMap[nId] || 0) + (s.shardSize || s.size || 0);
              }
            });
          }
        } catch (e) {}
      } else {
        const userFiles = memFiles.filter(f => f.userId === userId);
        const userFileIds = new Set(userFiles.map(f => f.id));
        memShards.forEach(s => {
          if (userFileIds.has(s.fileId)) {
            const nId = s.nodeId;
            if (nId) {
              userShardsMap[nId] = (userShardsMap[nId] || 0) + 1;
              userStorageBytesMap[nId] = (userStorageBytesMap[nId] || 0) + (s.shardSize || s.size || 0);
            }
          }
        });
      }
    }

    // Compute global total shard allocations per node (all active shards in cluster)
    let globalShardsMap = {};
    if (isMongoConnected) {
      try {
        const allDbShards = await FileShard.find();
        allDbShards.forEach(s => {
          if (s.nodeId) {
            globalShardsMap[s.nodeId] = (globalShardsMap[s.nodeId] || 0) + 1;
          }
        });
      } catch (e) {}
    } else {
      memShards.forEach(s => {
        if (s.nodeId) {
          globalShardsMap[s.nodeId] = (globalShardsMap[s.nodeId] || 0) + 1;
        }
      });
    }

    const enrichedNodes = baseNodes.map(n => {
      const nodeObj = n.toObject ? n.toObject() : n;
      const key = nodeObj.nodeId || nodeObj.id || nodeObj.name;
      const pred = mlPredictions.find(p => p.nodeId === key || p.name === nodeObj.name);
      const score = pred && pred.reliabilityScore !== undefined ? pred.reliabilityScore : (nodeObj.uptime || 98.5);

      const userShardsCount = userShardsMap[key] || 0;
      const totalShardsStored = globalShardsMap[key] || 0;
      const userBytes = userStorageBytesMap[key] || 0;
      const userStorageMB = parseFloat((userBytes / (1024 * 1024)).toFixed(3));

      return {
        ...nodeObj,
        id: key,
        nodeId: key,
        reliabilityScore: score,
        mlReliabilityScore: score,
        mlStatus: pred ? (pred.isHealthy ? 'Healthy' : 'Degraded') : 'Healthy',
        userShardsCount,
        shardsStored: totalShardsStored,
        totalShardsStored,
        userBytesStored: userBytes,
        userStorageMB,
        isSimulatedFailure: !!nodeObj.isSimulatedFailure,
        storageTotal: nodeObj.storageTotal || 1000
      };
    });

    const ts = new Date().toISOString();
    console.log(`[${ts}] [SECUREVAULT] [STORAGE CLUSTER] Queried ${enrichedNodes.length} nodes (Online: ${enrichedNodes.filter(n => n.status === 'online').length}, Offline: ${enrichedNodes.filter(n => n.status === 'offline').length})`);
    return res.status(200).json(enrichedNodes);
  } catch (error) {
    next(error);
  }
};

export const getNodeById = async (req, res, next) => {
  try {
    const { id } = req.params;
    let node = null;
    if (isMongoConnected) {
      node = await StorageNode.findOne({ $or: [{ id }, { nodeId: id }] });
    }
    if (!node) {
      node = GLOBAL_INFRA_NODES.find(n => n.id === id || n.nodeId === id);
    }
    if (!node) {
      return res.status(404).json({ error: 'Node not found.' });
    }
    return res.status(200).json(node);
  } catch (error) {
    next(error);
  }
};

// Helper: race a promise against a timeout (ms). On timeout, resolves null.
const withTimeout = (promise, ms) => {
  const timeout = new Promise(resolve => setTimeout(() => resolve(null), ms));
  return Promise.race([promise, timeout]);
};

export const toggleNodeStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    let updatedNode = null;

    // Always update in-memory state immediately (no wait)
    const idx = GLOBAL_INFRA_NODES.findIndex(n => n.id === id || n.nodeId === id);
    if (idx !== -1) {
      GLOBAL_INFRA_NODES[idx].isSimulatedFailure = !GLOBAL_INFRA_NODES[idx].isSimulatedFailure;
      GLOBAL_INFRA_NODES[idx].status = GLOBAL_INFRA_NODES[idx].isSimulatedFailure ? 'offline' : 'online';
      updatedNode = GLOBAL_INFRA_NODES[idx];
    }

    if (!updatedNode) {
      return res.status(404).json({ error: 'Storage node not found.' });
    }

    if (updatedNode.status === 'offline') {
      logStorageNodeOffline(id, 'OFFLINE', true);
    } else {
      logStorageNodeRestored(id, 'ONLINE');
    }

    // Respond immediately with the in-memory result
    res.status(200).json({
      success: true,
      message: `Node ${id} ${updatedNode.isSimulatedFailure ? 'simulated failure activated (OFFLINE)' : 'restored to ONLINE'}`,
      node: updatedNode
    });

    // Persist to MongoDB asynchronously with a 500ms hard timeout - never blocks response
    if (isMongoConnected) {
      withTimeout(
        StorageNode.findOne({ $or: [{ id }, { nodeId: id }] }),
        500
      ).then(async dbNode => {
        if (dbNode) {
          dbNode.isSimulatedFailure = updatedNode.isSimulatedFailure;
          dbNode.status = updatedNode.status;
          return withTimeout(dbNode.save(), 500);
        }
      }).catch(() => {});
    }
  } catch (error) {
    next(error);
  }
};

export const restoreNode = async (req, res, next) => {
  try {
    const { id } = req.params;
    let updatedNode = null;

    // Always update in-memory state immediately (no wait)
    const idx = GLOBAL_INFRA_NODES.findIndex(n => n.id === id || n.nodeId === id);
    if (idx !== -1) {
      GLOBAL_INFRA_NODES[idx].isSimulatedFailure = false;
      GLOBAL_INFRA_NODES[idx].status = 'online';
      GLOBAL_INFRA_NODES[idx].recentFailures = 0;
      // Also reset operational telemetry so ML re-evaluates from a clean baseline
      GLOBAL_INFRA_NODES[idx].failedOperations = 0;
      GLOBAL_INFRA_NODES[idx].totalOperations = 0;
      GLOBAL_INFRA_NODES[idx].successfulOperations = 0;
      GLOBAL_INFRA_NODES[idx].avgLatencyMs = null;
      GLOBAL_INFRA_NODES[idx].lastOperationalCheck = null;
      if (GLOBAL_INFRA_NODES[idx].latency > 100) GLOBAL_INFRA_NODES[idx].latency = 45;
      if (GLOBAL_INFRA_NODES[idx].storageUsed > 800) GLOBAL_INFRA_NODES[idx].storageUsed = 300;
      updatedNode = GLOBAL_INFRA_NODES[idx];
    }

    if (!updatedNode) {
      return res.status(404).json({ error: 'Storage node not found.' });
    }

    logStorageNodeRestored(id, 'ONLINE');

    // Respond immediately with in-memory result
    res.status(200).json({
      success: true,
      message: `Node ${id} restored to ONLINE status.`,
      node: updatedNode
    });

    // Persist to MongoDB asynchronously with a 500ms hard timeout - never blocks response
    if (isMongoConnected) {
      withTimeout(
        StorageNode.findOne({ $or: [{ id }, { nodeId: id }] }),
        500
      ).then(async dbNode => {
        if (dbNode) {
          dbNode.isSimulatedFailure = false;
          dbNode.status = 'online';
          dbNode.recentFailures = 0;
          // Also reset operational telemetry so ML re-evaluates from a clean baseline
          dbNode.failedOperations = 0;
          dbNode.totalOperations = 0;
          dbNode.successfulOperations = 0;
          dbNode.avgLatencyMs = null;
          dbNode.lastOperationalCheck = null;
          if (dbNode.latency > 100) dbNode.latency = 45;
          if (dbNode.storageUsed > 800) dbNode.storageUsed = 300;
          return withTimeout(dbNode.save(), 500);
        }
      }).catch(() => {});
    }
  } catch (error) {
    next(error);
  }
};