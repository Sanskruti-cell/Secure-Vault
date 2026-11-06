# SecureVault Backend – Decentralized Storage & Cryptographic Orchestrator

SecureVault Backend is an enterprise-grade Node.js / Express microservice powering zero-knowledge decentralized cloud storage. It orchestrates Reed-Solomon $(4+2)$ Cauchy erasure coding, cross-user content-addressed deduplication, cryptographic envelope validation, storage node allocation via Python ML telemetry, and tamper-evident audit logging.

---

## Key Architectural Capabilities

### 1. Zero-Knowledge Cryptographic Boundary
- The backend operates strictly under zero-knowledge principles. For `cryptoVersion: 2` files, file content is encrypted and decrypted exclusively in the browser using WebCrypto AES-256-GCM with PBKDF2-HMAC-SHA256 (100,000 iterations) and NIST SP 800-38F AES Key Wrap (AES-KW).
- The server never receives, stores, or sees plaintext data or user passwords. It receives only encrypted ciphertext chunks and sealed metadata envelopes.

### 2. Reed-Solomon $(4+2)$ Cauchy Erasure Coding
- Galois Field $GF(2^8)$ erasure coding using a systematic Cauchy generator matrix:
  $$\mathbf{G} = \begin{bmatrix} \mathbf{I}_{4 \times 4} \\ \mathbf{C}_{2 \times 4} \end{bmatrix}$$
- Every payload is split into $K=4$ data shards and $M=2$ Cauchy parity shards ($N=6$ total).
- The system tolerates the simultaneous loss or simulated offline failure of any 2 nodes while guaranteeing complete bit-for-bit mathematical payload reconstruction.

### 3. Content-Addressed Chunk Deduplication
- Ciphertexts are content-addressed by SHA-256 fingerprint.
- Duplicate files across users reuse physical shard allocations across storage nodes, consuming $0$ redundant storage bytes and performing $O(1)$ reference counting.
- Cryptographic isolation is maintained: each file keeps its own unique wrapped DEK envelope.

### 4. Machine Learning Storage Node Allocation
- Communicates with the Python ML microservice (`http://127.0.0.1:5001/predict`) to assess node health, latency, failure rates, and storage utilization.
- Dynamically selects the top 6 nodes for shard distribution.
- Automatic deterministic heuristic fallback when the Python ML service is offline.

### 5. AI Command Center & Natural Language Dispatcher
- Exposes `POST /api/ai/command` to process natural language queries regarding cluster health, vault inventory, deduplication savings, and encryption mechanics.
- Dispatches structured action payloads (`{ type: "NAVIGATE", route, label }`) for seamless frontend navigation.

### 6. Dual-Mode Persistence Architecture
- **Primary**: MongoDB Atlas via Mongoose with connection pooling and automated reconnects.
- **Failover**: Resilient local JSON data store (`backend/data/*.json`) allowing full local development and disconnected demonstrations without crashing.

---

## Directory Structure

```
backend/
├── data/                      # Persistent storage store (*.json)
├── ml/                        # Python ML service (scikit-learn)
│   ├── ml_service.py          # Flask REST API for node health prediction
│   ├── train_model.py         # Model training script
│   ├── requirements.txt       # Python dependencies
│   └── README.md              # ML microservice documentation
├── scripts/                   # Automated node setup and diagnostic scripts
├── src/
│   ├── config/                # Environment variables and database config
│   │   ├── db.js              # MongoDB Atlas connection manager with failover
│   │   └── env.js             # Validated configuration schema
│   ├── controllers/           # Route handler controllers
│   │   ├── aiController.js    # AI Assistant and command dispatcher
│   │   ├── authController.js  # JWT authentication and registration
│   │   ├── dashboardController.js # Cluster metrics and activity timeline
│   │   ├── fileController.js  # Ingestion, sharding, recovery, and download
│   │   ├── nodeController.js  # Node health, simulation, and telemetry
│   │   └── shareController.js # Time-limited and password-protected sharing
│   ├── middleware/            # Express middleware
│   │   ├── authMiddleware.js  # JWT validation and user resolution
│   │   ├── errorMiddleware.js # Centralized error handler
│   │   ├── rateLimiter.js     # IP rate limiting protection
│   │   └── terminalLogger.js  # Real-time ANSI terminal logging
│   ├── models/                # Mongoose database schemas
│   │   ├── ActivityLog.js     # Tamper-evident audit ledger
│   │   ├── File.js            # Cryptographic file envelope metadata
│   │   ├── FileShard.js       # Individual physical shard mapping
│   │   ├── SharedFile.js      # Public and passworded share envelopes
│   │   ├── StorageNode.js     # Storage cluster nodes and ML reliability
│   │   ├── StoredChunk.js     # Content-addressed deduplication store
│   │   └── User.js            # User accounts and credentials
│   ├── routes/                # Express router mounts
│   ├── services/              # Domain logic services
│   │   ├── auditService.js    # Cryptographic hash chaining for audit logs
│   │   ├── cryptoService.js   # Server cryptographic utilities
│   │   ├── dedupService.js    # Chunk deduplication engine
│   │   ├── nodeService.js     # Cluster node management and ML bridge
│   │   ├── shardingService.js # Reed-Solomon 4+2 encoding & decoding
│   │   └── storeService.js    # Fallback JSON persistence engine
│   └── server.js              # Application entrypoint
├── storage/                   # Physical shard files partitioned across node-01 to node-06
├── package.json               # Dependencies and scripts
└── .env.example               # Configuration template
```

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env`:

```env
PORT=5002
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
MONGODB_URI=mongodb://127.0.0.1:27017/securevault
MONGODB_DB_NAME=securevault
JWT_SECRET=your_jwt_secret_min_32_characters_here
ENCRYPTION_MASTER_KEY=your_aes_256_master_key_32_chars!
ENABLE_DEMO_ACCOUNTS=false
```

---

## Getting Started

### Installation
```bash
cd backend
npm install
```

### Running in Development
```bash
npm run dev
```

### Running in Production
```bash
npm start
```

### Running Test Suites
```bash
# Run complete end-to-end test suite
npm run test:all

# Run individual verification suites
npm run test:crypto     # AES-256-GCM client envelope test
npm run test:sharding   # Reed-Solomon 4+2 Cauchy matrix test
npm run test:dedup      # Content-addressed deduplication test
```
