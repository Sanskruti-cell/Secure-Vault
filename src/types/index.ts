export interface User {
  id?: string;
  name: string;
  email: string;
  hasMasterPassword?: boolean;
  masterPasswordSalt?: string | null;
  wrappedMasterKey?: string | null;
  masterKeyVerifier?: string | null;
  recoveryKeyHash?: string | null;
  recoverySalt?: string | null;
  wrappedMasterKeyWithRecovery?: string | null;
  autoLockMinutes?: number;
}

export interface VaultFile {
  id: string;
  name: string;
  size: number;
  formattedSize?: string;
  type: string;
  category: 'document' | 'image' | 'video' | 'archive' | 'code' | 'audio' | 'other';
  encryptedAt: string;
  hash: string;
  shardsCount: number;
  status: 'encrypted' | 'processing' | 'error';
  nodeDistribution: string[];
  isPasswordProtected?: boolean;
  cryptoVersion?: number;
  wrappedDEK?: string;
  kdf?: string;
  kdfSalt?: string;
  kdfIterations?: number;
  baseNonce?: string;
  chunkSize?: number;
  chunkCount?: number;
  originalFileHash?: string;
  originalFileSize?: number;
}

export interface StorageNode {
  id: string;
  name: string;
  region: string;
  status: 'online' | 'degraded' | 'offline';
  latency: number;
  storageUsed: number;
  storageTotal: number;
  shardsStored: number;
  uptime: number;
  reliabilityScore?: number;
  mlReliabilityScore?: number;
  mlStatus?: string;
  provider?: 'local' | 'aws-s3' | 'gcp-gcs' | 'azure-blob';
  providerType?: 'local' | 'emulator' | 'cloud';
  emulatorBucket?: string;
}

export interface SharedLink {
  id: string;
  token?: string;
  fileId: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  cryptoVersion?: number;
  shareUrl: string;
  createdAt: string;
  expiresAt: string;
  accessCount: number;
  downloadCount?: number;
  maxAccess: number;
  downloadLimit?: number;
  isPasswordProtected: boolean;
  status?: 'active' | 'expired' | 'revoked';
  wrappedDEKForShare?: string;
  kdf?: string;
  kdfSalt?: string;
  kdfIterations?: number;
}


export interface ActivityItem {
  id: string;
  type: 'upload' | 'download' | 'delete' | 'share' | 'login' | 'node_rebalance' | 'encryption';
  description: string;
  timestamp: string;
  user: string;
  ip: string;
  status: 'success' | 'warning' | 'failed';
}

export interface SecurityFactors {
  encryption: number;
  integrity: number;
  nodeReliability: number;
  databasePersistence: number;
  auditMonitoring: number;
}

export interface DashboardMetrics {
  storageUsedGB: number;
  storageTotalGB: number;
  fileCount: number;
  activeNodesCount: number;
  totalNodesCount: number;
  securityScore: number;
  securityFactors?: SecurityFactors;
  totalShards: number;
  categoryDistribution: { category: string; sizeGB: number; count: number }[];
}

export interface DedupStats {
  totalChunks: number;
  deduplicatedChunks: number;
  totalLogicalBytes: number;
  totalPhysicalBytes: number;
  savedBytes: number;
  savingsPercent: number;
  storageEfficiencyRatio: number;
}
