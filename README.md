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

## License

MIT - see [`LICENSE`](LICENSE).
