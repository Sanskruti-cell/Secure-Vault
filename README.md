# SecureVault – Decentralized Cloud Storage with Zero-Knowledge Encryption & File Sharding

[![React 18](https://img.shields.io/badge/React-18.2.0-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-v20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org/)
[![scikit-learn](https://img.shields.io/badge/scikit--learn-1.4-F7931E?logo=scikitlearn&logoColor=white)](https://scikit-learn.org/)
[![Docker](https://img.shields.io/badge/Docker-Enabled-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)
[![Zero-Knowledge](https://img.shields.io/badge/Security-Zero--Knowledge-00C7B7)](https://en.wikipedia.org/wiki/Zero-knowledge_proof)

SecureVault is a decentralized, zero-knowledge cloud storage mesh designed to eliminate central points of failure and vendor lock-in. By coupling **client-side WebCrypto AES-256-GCM envelope encryption**, **Reed-Solomon (4+2) Cauchy erasure coding over Galois Field $GF(2^8)$**, **cross-user content-addressed deduplication**, and **ML-driven node reliability scoring**, SecureVault guarantees end-to-end data confidentiality, high fault tolerance, and optimal multi-cloud storage distribution.

---

## Architecture Overview

```mermaid
flowchart TD
    subgraph Client ["Client Device (Browser - Zero-Knowledge Boundary)"]
        UI["React 18 + Three.js 3D Cyberpunk Interface"]
        AI_CMD["AI Command Center (Cmd+K)"]
        CRYPTO["WebCrypto AES-256-GCM + PBKDF2 (100,000 iter)"]
        DEK["Envelope Encryption: NIST SP 800-38F AES-KW"]
        HASH["Incremental Streaming SHA-256 Digest"]
        UI --> CRYPTO
        UI --> AI_CMD
        CRYPTO --> DEK
        CRYPTO --> HASH
    end

    subgraph Backend ["SecureVault Core Orchestrator (Node.js / Express)"]
        API["REST API Router (CORS & Rate Limiting)"]
        DEDUP["Content-Addressed Chunk Deduplication Engine"]
        RS["Reed-Solomon (4+2) Cauchy Erasure Coder (GF(2^8))"]
        AUDIT["Tamper-Evident SHA-256 Chained Audit Ledger"]
        DB["Dual-Mode Store (MongoDB Atlas / Resilient JSON Store)"]
        
        API --> DEDUP
        DEDUP --> RS
        RS --> AUDIT
        RS --> DB
    end

    subgraph ML ["AI / ML Telemetry Service (Python / Flask)"]
        TELEMETRY["Node Telemetry Ingestion (Latency, Failures, Storage)"]
        MODEL["scikit-learn Logistic Regression / Random Forest"]
        HEURISTIC["Deterministic Fallback Engine"]
        
        TELEMETRY --> MODEL
        MODEL -. Failover .-> HEURISTIC
    end

    subgraph Nodes ["Decentralized Multi-Cloud Storage Mesh"]
        N1["Node 1: AWS S3 (US-East)"]
        N2["Node 2: GCP GCS (US-Central)"]
        N3["Node 3: Azure Blob (EU-North)"]
        N4["Node 4: AWS S3 (EU-West)"]
        N5["Node 5: GCP GCS (AP-South)"]
        N6["Node 6: Azure Blob (East-US)"]
    end

    Client -- "Encrypted Ciphertext + Wrapped DEK (Zero Plaintext)" --> Backend
    Backend <--> "Telemetry & Health Scoring" ML
    Backend -- "Distribute 4 Data Shards + 2 Parity Shards" --> Nodes
```

---

## Core Engineering Implementations

### 1. Zero-Knowledge Cryptographic Envelope
- **Client-Side Encryption**: Plaintext files never leave the client device unencrypted. Encryption is executed via the browser's native hardware-accelerated Web Cryptography API (`crypto.subtle`).
- **Data Encryption Key (DEK)**: A cryptographically random 256-bit key (`AES-GCM-256`) is generated per upload.
- **Key Encryption Key (KEK)**: Derived using PBKDF2-HMAC-SHA256 with 100,000 iterations and a unique 16-byte cryptographic salt.
- **Key Wrapping**: The DEK is sealed inside a key envelope using NIST SP 800-38F AES Key Wrap (`AES-KW`).
- **Integrity Fingerprinting**: SHA-256 digests are computed incrementally on plaintext before encryption and strictly verified post-reassembly before saving to disk.

### 2. Reed-Solomon (4+2) Cauchy Erasure Coding
- **Mathematical Foundation**: Operates over Galois Field $GF(2^8)$ with irreducible polynomial $p(x) = x^8 + x^4 + x^3 + x^2 + 1$ (0x11D).
- **Cauchy Generator Matrix**:
  $$\mathbf{G} = \begin{bmatrix} \mathbf{I}_{4 \times 4} \\ \mathbf{C}_{2 \times 4} \end{bmatrix}$$
  where Cauchy matrix elements $c_{i,j} = \frac{1}{x_i \oplus y_j}$ in $GF(2^8)$.
- **Fault Tolerance**: The payload is split into $K=4$ data shards and $M=2$ parity shards ($N=6$ total). Up to any 2 storage nodes can suffer complete hardware failure or network blackout simultaneously without any data loss.
- **Fast-Path Identity Optimization**: When all $K=4$ systematic data shards are online, matrix inversion is completely bypassed, achieving direct $O(1)$ memory assembly.

### 3. Content-Addressed Chunk Deduplication
- Ciphertexts are content-addressed by their SHA-256 hash.
- Identical files uploaded by the same or different users detect existing physical shards across storage nodes, creating reference links with zero redundant storage bytes written.
- Cryptographic isolation is strictly preserved: each file record retains its own wrapped DEK envelope, authorization ACLs, and metadata.

### 4. ML-Powered Storage Node Allocation
- Telemetry across all nodes (effective latency, failure rates, consecutive timeouts, storage utilization) is evaluated continuously by a Python `scikit-learn` microservice.
- Storage nodes are dynamically scored ($0-100\%$) and ranked to select the optimal 6 nodes for shard distribution.
- Includes automatic deterministic heuristic failover if the ML service is unreachable.

### 5. AI Command Center & Natural Language Dispatcher (`Cmd+K`)
- Interactive NLP-driven terminal modal in the UI.
- Direct query support for cluster health, storage utilization, zero-knowledge encryption mechanics, and file searches.
- Dispatches structured action payloads (`{ type: "NAVIGATE", route, label }`) with one-click navigation buttons.

---

## Directory Structure

```
├── .github/
│   └── workflows/ci.yml       # GitHub Actions CI pipeline
├── backend/                   # Core Backend & Sharding Orchestrator
│   ├── data/                  # Persistent JSON storage store (fallback)
│   ├── ml/                    # Python ML Node Health Microservice
│   │   ├── ml_service.py      # Flask REST API for node predictions
│   │   ├── train_model.py     # Model training script
│   │   ├── requirements.txt   # Python ML dependencies
│   │   └── README.md          # ML microservice documentation
│   ├── src/
│   │   ├── config/            # DB and environment configuration
│   │   ├── controllers/       # API controllers (file, node, share, ai, etc.)
│   │   ├── middleware/        # Authentication, rate limiting, terminal logger
│   │   ├── models/            # Mongoose database models
│   │   ├── routes/            # Express router mounts
│   │   ├── services/          # Reed-Solomon, crypto, dedup, audit services
│   │   └── server.js          # Express server entrypoint
│   ├── test_*.js              # Cryptographic, RS 4+2, and E2E test suites
│   ├── package.json           # Backend dependencies and test scripts
│   └── README.md              # Detailed backend documentation
├── public/                    # Static public assets
├── scripts/                   # Cluster automation scripts
│   ├── install.sh             # Automated dependency installer
│   ├── start.sh               # Concurrent multi-service startup script
│   ├── test.sh                # Complete system verification runner
│   └── docker-run.sh          # Containerized deployment script
├── src/                       # Frontend Application (React 18 + TypeScript)
│   ├── components/            # UI components (AICommandCenter, Navbar, Modals)
│   ├── context/               # Global state (AppContext)
│   ├── pages/                 # Views (Vault, Upload, Recovery, Nodes, Security)
│   ├── scene/                 # Three.js 3D interactive storage mesh canvas
│   ├── services/              # API client & client-side WebCrypto service
│   ├── types/                 # TypeScript interfaces and contracts
│   ├── App.tsx                # Main application layout and routes
│   └── main.tsx               # React DOM entrypoint
├── storage/                   # Physical storage nodes (node-01 through node-06)
├── docker-compose.yml         # Unified Docker Compose orchestration
├── Dockerfile.frontend        # Multi-stage production build for React + Nginx
├── Dockerfile.backend         # Production build for Express API
├── Dockerfile.ml              # Production build for Python ML Microservice
├── nginx.conf                 # Nginx reverse proxy configuration
├── package.json               # Root dependencies and project scripts
├── .env.example               # Root environment template
└── README.md                  # Master technical documentation
```

---

## Quickstart Guide

### Prerequisites
- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **Python**: v3.9 or higher (for the ML service)
- **Docker & Docker Compose** *(Optional, for containerized run)*

### Method 1: Local Development via Helper Scripts (Recommended)

1. **Clone the repository and install dependencies:**
   ```bash
   git clone <repository-url>
   cd hackathon-project
   ./scripts/install.sh
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   ```

3. **Start all services concurrently:**
   ```bash
   ./scripts/start.sh
   ```

4. **Open in browser:**
   - **Frontend Application**: [http://localhost:5173](http://localhost:5173)
   - **Backend API**: [http://localhost:5002/api/health](http://localhost:5002/api/health)
   - **Python ML Service**: [http://localhost:5001/health](http://localhost:5001/health)

---

### Method 2: Docker Compose Orchestration

To run the entire distributed cluster (MongoDB, Python ML Service, Node.js Backend, and Nginx Frontend) in isolated Docker containers:

```bash
./scripts/docker-run.sh
```

Or manually:
```bash
docker compose build
docker compose up -d
```

---

## Running the Verification Test Suites

SecureVault includes an automated test suite verifying client-side cryptographic security, Reed-Solomon Cauchy erasure recovery under node failure, and content-addressed deduplication.

Run all tests via npm:
```bash
npm run test:all
```

Or execute individual test suites:
```bash
# Test 1: Client Envelope WebCrypto AES-256-GCM & PBKDF2
npm run test:crypto

# Test 2: Reed-Solomon 4+2 Galois Field (2^8) Cauchy Reconstruction
npm run test:sharding

# Test 3: Comprehensive End-to-End Vault Ingestion, Deduplication & Recovery
npm run test:backend
```

---

## API Specification Reference

### Authentication & Vault Access
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/register` | Register new account with bcrypt password hashing |
| `POST` | `/api/auth/login` | Authenticate user and issue JWT bearer token |
| `GET` | `/api/auth/me` | Fetch active session user profile |

### File Ingestion, Sharding & Recovery
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/files/upload` | Ingest ciphertext chunks, wrapped DEK envelope, and distribute RS shards |
| `GET` | `/api/files` | List encrypted files for authenticated user |
| `GET` | `/api/files/:id` | Fetch file cryptographic metadata and shard node map |
| `GET` | `/api/files/:id/shards` | Inspect individual physical shard states and integrity hex previews |
| `GET` | `/api/files/:id/download` | Reconstruct ciphertext from available shards and stream envelope headers |
| `DELETE` | `/api/files/:id` | Purge file shards across storage nodes |
| `POST` | `/api/files/:id/repair-shard/:index` | Reconstruct corrupted/lost shard using surviving parity shards |

### Storage Nodes & Machine Learning Telemetry
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/nodes` | List all 6 storage nodes with ML reliability scores and status |
| `POST` | `/api/nodes/:id/simulate-failure` | Toggle simulated hardware outage on a specific storage node |
| `POST` | `/api/nodes/rebalance` | Trigger cluster rebalancing across online storage nodes |

### AI Assistant & Command Dispatcher
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/ai/command` | Natural language queries, cluster diagnostics, and action dispatching |

---

## Security Model & Threat Assessment

| Threat Vector | Mitigating SecureVault Architecture |
| :--- | :--- |
| **Compromised Storage Node** | Storage nodes hold only individual Reed-Solomon shards of encrypted ciphertext. A single shard reveals zero plaintext and cannot be reconstructed without $K \ge 4$ surviving shards. |
| **Malicious Server / Database Leak** | Zero-knowledge architecture: The backend never holds plaintext, user passwords, or unwrapped DEKs. A total database breach exposes only ciphertext fingerprints and encrypted envelopes. |
| **Ciphertext Tampering / Bit Rot** | Every shard has an embedded `SVEC` magic header and SHA-256 fingerprint; reassembled payloads are strictly verified against pre-encryption hashes before decryption. |
| **Node Failure / Disconnection** | Reed-Solomon $(4+2)$ Cauchy code mathematically reconstructs missing data even if 2 out of 6 nodes are offline or destroyed. |
| **Audit Log Forgery** | Audit ledger records are linked in an append-only cryptographic hash chain (`prevEntryHash` $\rightarrow$ `entryHash`), with automated tamper verification via `/api/dashboard/audit/verify`. |

---

## License
MIT License. Open-source decentralized cloud storage mesh.
