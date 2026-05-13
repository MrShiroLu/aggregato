# Aggregato

Parallel ZK proof aggregation service inspired by JAM (Join-Accumulate Machine). Aggregato splits a dataset into chunks, proves each chunk in parallel with Noir/Barretenberg, aggregates the chunk roots into a single Merkle root, signs it with Sr25519, and submits it to an ink! contract on Portaldot.

---

## Architecture

```
Dataset (N items)
     │
     ▼
┌─────────────────────────────────────┐
│         Orchestrator (Rust)         │
│                                     │
│  ┌──────────┐   ┌──────────┐        │
│  │ Chunk 0  │   │ Chunk 1  │  ...   │  ← Refine (JAM)
│  │ nargo+bb │   │ nargo+bb │        │
│  └──────────┘   └──────────┘        │
│         │parallel│                  │
│         ▼                           │
│  ┌──────────────────────┐           │
│  │  Aggregator Circuit  │           │  ← Accumulate (JAM)
│  │  Binary-tree Merkle  │           │
│  │  root of chunk roots │           │
│  └──────────────────────┘           │
│         │                           │
│  Sr25519 sign aggregated root       │
└─────────────────────────────────────┘
          │
          ▼
┌─────────────────────┐
│  Ink! Contract      │  ← OnTransfer (JAM)
│  aggregato_verifier │
│  on Portaldot       │
└─────────────────────┘
```

The three JAM phases map onto the pipeline directly: Refine is the parallel chunk proving, Accumulate is the binary-tree Merkle aggregation, and OnTransfer is the on-chain Sr25519 verification done by the ink! contract.

---

## Tech Stack

Noir (Aztec DSL) for the circuits, Barretenberg (UltraHonk) as the proving backend, Rust (`tokio` + `rayon`) for the orchestrator, ink! for the contract, and `schnorrkel` for Sr25519 signing.

---

## Benchmark Results

All runs verified on a local Portaldot-compatible dev node (the deployed ink! contract emits `ProofVerified`).

| JAM Cores | Items | Sequential | Parallel | Speedup | Aggregation |
|-----------|-------|------------|----------|---------|-------------|
| 2         | 16    | 1.03 s     | 0.67 s   | 1.54×   | 0.58 s      |
| 4         | 32    | 1.96 s     | 1.05 s   | 1.87×   | 1.84 s      |
| 8         | 64    | 9.23 s     | 3.37 s   | 2.74×   | 9.98 s      |

Numbers come from `benchmark_history.json`; the dashboard pulls the latest run from `benchmark_latest.json` at runtime.

---

## Project Structure

```
aggregato/
├── circuits/
│   ├── inner/          # Chunk circuit (Noir) - proves 8 items per chunk
│   └── aggregator/     # Aggregator circuit (Noir) - binary-tree Merkle root
├── contracts/
│   └── aggregato_verifier/   # Ink! contract (Sr25519 on-chain verification)
├── orchestrator/       # Rust orchestrator - parallel proving + contract submission
├── frontend/           # React/TypeScript real-time dashboard
└── demo.sh             # One-command end-to-end demo
```

---

## Quick Start (one command)

```bash
./demo.sh          # 2 JAM cores (default)
./demo.sh 4        # 4 JAM cores
./demo.sh 8        # 8 JAM cores
```

`demo.sh` starts a local `substrate-contracts-node --dev`, builds and deploys the ink! contract, opens the dashboard at http://localhost:3000, and runs the orchestrator end-to-end.

---

## Manual Setup

### Prerequisites

- Rust (stable + `nightly-2024-12-01` toolchain)
- Noir: `curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash && noirup`
- Barretenberg: `bbup -v 0.82.1` (or compatible)
- `cargo-contract 5.0.3`: `cargo install cargo-contract --version 5.0.3`
- `substrate-contracts-node` v0.41.0:
  ```bash
  curl -L https://github.com/paritytech/substrate-contracts-node/releases/download/v0.41.0/substrate-contracts-node-linux.tar.gz | tar -xz -C /tmp/
  cp /tmp/artifacts/substrate-contracts-node-linux/substrate-contracts-node ~/.cargo/bin/
  ```

### 1. Run the orchestrator

```bash
export PATH="$HOME/.nargo/bin:$PATH"
cd orchestrator
cargo run -- 2        # or 4 or 8
```

The orchestrator prints the prover pubkey on completion:
```
[prover] pubkey (use when deploying contract): 0x189dac...
```

### 2. Start local node

```bash
substrate-contracts-node --dev --tmp
```

### 3. Deploy the ink! contract

```bash
cargo contract instantiate \
  --url ws://127.0.0.1:9944 \
  --constructor new \
  --args 0x<PROVER_PUBKEY> \
  --suri "//Alice" \
  --execute \
  --skip-confirm \
  contracts/aggregato_verifier/target/ink/aggregato_verifier.contract
```

### 4. Submit proof on-chain

```bash
export PORTALDOT_WS=ws://127.0.0.1:9944
export CONTRACT_ADDRESS=<deployed_address>
cd orchestrator && cargo run -- 2
```

---

## Smart Contract

`AggregatoVerifier` (`contracts/aggregato_verifier/src/lib.rs`) stores verified aggregated roots with metadata, verifies Sr25519 signatures on-chain via the `sr25519_verify` host function, emits `ProofVerified` on each successful submission, and lets the owner rotate the prover pubkey.

Key message:
```
submit_verified_root(aggregated_root_hex, num_chunks, total_items, signature_hex)
```

---

## Security Note

The default `PROVER_SK` is `[1u8; 32]`, a fixed well-known seed. Do not use it in production. Set a real secret key:

```bash
export PROVER_SK=0x<your_64_char_hex_secret_key>
```

---

## License

MIT - see [`LICENSE`](LICENSE).
