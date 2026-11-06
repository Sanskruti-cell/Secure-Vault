import fs from 'fs';
import path from 'path';

/**
 * Base Abstract Storage Provider Interface
 */
export class BaseStorageProvider {
  constructor(providerName) {
    this.providerName = providerName;
  }

  async writeShard(bucket, objectKey, buffer) {
    throw new Error(`writeShard not implemented in ${this.providerName}`);
  }

  async readShard(bucket, objectKey) {
    throw new Error(`readShard not implemented in ${this.providerName}`);
  }

  async deleteShard(bucket, objectKey) {
    throw new Error(`deleteShard not implemented in ${this.providerName}`);
  }

  async shardExists(bucket, objectKey) {
    throw new Error(`shardExists not implemented in ${this.providerName}`);
  }
}

/**
 * Local Disk Provider (Existing Storage Nodes)
 */
export class LocalStorageProvider extends BaseStorageProvider {
  constructor() {
    super('local');
    this.baseDir = path.join(process.cwd(), 'storage');
  }

  async writeShard(bucket, objectKey, buffer) {
    const targetDir = bucket ? path.join(this.baseDir, bucket) : this.baseDir;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    const fullPath = path.join(targetDir, objectKey);
    fs.writeFileSync(fullPath, buffer);
    return {
      provider: 'local',
      bucket: bucket || null,
      objectKey,
      storagePath: fullPath,
      size: buffer.length
    };
  }

  async readShard(bucket, objectKey) {
    const targetDir = bucket ? path.join(this.baseDir, bucket) : this.baseDir;
    const fullPath = path.join(targetDir, objectKey);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Local shard file not found: ${fullPath}`);
    }
    return fs.readFileSync(fullPath);
  }

  async deleteShard(bucket, objectKey) {
    const targetDir = bucket ? path.join(this.baseDir, bucket) : this.baseDir;
    const fullPath = path.join(targetDir, objectKey);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      return true;
    }
    return false;
  }

  async shardExists(bucket, objectKey) {
    const targetDir = bucket ? path.join(this.baseDir, bucket) : this.baseDir;
    const fullPath = path.join(targetDir, objectKey);
    return fs.existsSync(fullPath);
  }
}

/**
 * Isolated Cloud Emulator for Local Testing without Real Cloud Credentials
 * Creates discrete bucket folders under storage/cloud_emulators/<provider>/<bucket>/
 */
export class CloudStorageEmulator extends BaseStorageProvider {
  constructor(providerName, defaultBucket = 'securevault-shards') {
    super(providerName);
    this.defaultBucket = defaultBucket;
    this.rootDir = path.join(process.cwd(), 'storage', 'cloud_emulators', providerName);
    if (!fs.existsSync(this.rootDir)) fs.mkdirSync(this.rootDir, { recursive: true });
  }

  _resolvePath(bucket, objectKey) {
    const b = bucket || this.defaultBucket;
    const bucketDir = path.join(this.rootDir, b);
    if (!fs.existsSync(bucketDir)) fs.mkdirSync(bucketDir, { recursive: true });
    return path.join(bucketDir, objectKey);
  }

  async writeShard(bucket, objectKey, buffer) {
    const fullPath = this._resolvePath(bucket, objectKey);
    fs.writeFileSync(fullPath, buffer);
    return {
      provider: this.providerName,
      bucket: bucket || this.defaultBucket,
      objectKey,
      storagePath: fullPath,
      size: buffer.length,
      simulatedCloudUri: `${this.providerName}://${bucket || this.defaultBucket}/${objectKey}`
    };
  }

  async readShard(bucket, objectKey) {
    const fullPath = this._resolvePath(bucket, objectKey);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`[${this.providerName.toUpperCase()}] Object key not found: ${objectKey}`);
    }
    return fs.readFileSync(fullPath);
  }

  async deleteShard(bucket, objectKey) {
    const fullPath = this._resolvePath(bucket, objectKey);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      return true;
    }
    return false;
  }

  async shardExists(bucket, objectKey) {
    const fullPath = this._resolvePath(bucket, objectKey);
    return fs.existsSync(fullPath);
  }
}

/**
 * Storage Provider Registry & Multi-Cloud Distribution Router
 */
class StorageProviderRegistry {
  constructor() {
    this.providers = new Map();
    // Default registrations
    this.register('local', new LocalStorageProvider());
    this.register('aws-s3', new CloudStorageEmulator('aws-s3', 'securevault-aws-bucket'));
    this.register('gcp-gcs', new CloudStorageEmulator('gcp-gcs', 'securevault-gcp-bucket'));
    this.register('azure-blob', new CloudStorageEmulator('azure-blob', 'securevault-azure-container'));
  }

  register(name, providerInstance) {
    this.providers.set(name, providerInstance);
  }

  get(name) {
    const p = this.providers.get(name);
    if (!p) throw new Error(`Unknown storage provider: "${name}"`);
    return p;
  }

  /**
   * Assigns 6 shards across 3 distinct cloud providers ensuring no single provider
   * holds more than 2 shards.
   *
   * @param {Array<object>} shards 6 encoded Reed-Solomon shards
   * @returns {Array<object>} Shard allocation plans
   */
  planMultiCloudAllocation(shards) {
    if (shards.length !== 6) {
      throw new Error(`Multi-cloud allocation requires exactly 6 shards (got ${shards.length})`);
    }

    // Strict fault-domain distribution: 2 AWS + 2 GCP + 2 Azure
    const providerMapping = [
      { provider: 'aws-s3', bucket: 'securevault-aws-bucket', region: 'us-east-1' },
      { provider: 'aws-s3', bucket: 'securevault-aws-bucket', region: 'us-east-1' },
      { provider: 'gcp-gcs', bucket: 'securevault-gcp-bucket', region: 'us-central1' },
      { provider: 'gcp-gcs', bucket: 'securevault-gcp-bucket', region: 'us-central1' },
      { provider: 'azure-blob', bucket: 'securevault-azure-container', region: 'eastus' },
      { provider: 'azure-blob', bucket: 'securevault-azure-container', region: 'eastus' },
    ];

    return shards.map((s, idx) => ({
      shard: s,
      provider: providerMapping[idx].provider,
      bucket: providerMapping[idx].bucket,
      region: providerMapping[idx].region,
      nodeId: `node-0${idx + 1}`
    }));
  }
}

export const storageRegistry = new StorageProviderRegistry();
