# ==============================================================================
# SECUREVAULT BACKEND DATA DIRECTORY – RUNTIME PERSISTENCE STORE
# ==============================================================================
# 
# This directory holds the resilient JSON fallback persistence layer.
# It is used automatically when MongoDB Atlas is unavailable (network-free
# local development, demo environments, CI pipelines, hackathon demos, etc.)
#
# The store files are auto-created and managed by storeService.js.
# You should NOT manually edit these files; they are overwritten at runtime.
#
# Files:
#   users_store.json         – Registered user accounts (hashed passwords only)
#   files_store.json         – Cryptographic file envelope metadata records
#   shards_store.json        – Physical shard-to-node routing tables
#   chunks_store.json        – Content-addressed deduplication chunk index
#   shares_store.json        – Tokenized sharing link envelopes
#   activities_store.json    – Tamper-evident activity audit ledger
#   resumable_sessions.json  – Resumable chunked upload session state
#
# GITIGNORE NOTE:
# These files are intentionally tracked with empty arrays at repo init time.
# They are auto-populated on first server run.
#
# PRODUCTION:
# In production with MongoDB Atlas connected, all data is persisted in Atlas
# and these files act as an emergency in-memory buffer only.
# ==============================================================================
