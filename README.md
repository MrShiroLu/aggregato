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

## License

MIT - see [`LICENSE`](LICENSE).
