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
- Node.js 18+ and `npm` (for the dashboard; `demo.sh` runs `npm install` automatically on first run)
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

## Gas (POT)

Every contract call in the pipeline — `instantiate` at deploy time and `submit_verified_root` on each aggregated proof — is a regular `pallet-contracts` extrinsic, so it is paid for in the chain's native token via `pallet-balances`. On Portaldot that token is **POT**: deploy fees, storage deposits, and per-call gas all come out of the signer's POT balance. The orchestrator signs every submission with the configured prover account, so that account is the one that needs a POT balance on the target endpoint.

Local `substrate-contracts-node` runs the same `pallet-contracts` / `pallet-balances` ABI under a placeholder unit token, which is why no code changes are required to switch endpoints — pointing `PORTALDOT_WS` at a Portaldot RPC makes the same extrinsics consume real POT.

---

## Security Note

The default `PROVER_SK` is `[1u8; 32]`, a fixed well-known seed. Do not use it in production. Set a real secret key:

```bash
export PROVER_SK=0x<your_64_char_hex_secret_key>
```

---

## Portaldot Compatibility

We tested Aggregato against the official Portaldot dev binary at [`portaldotVolunteer/Portaldot-node`](https://github.com/portaldotVolunteer/Portaldot-node) on 2026-05-13.

The binary (`portaldot_dev`, ~100 MB) downloads and starts cleanly with `./portaldot_dev --dev --tmp`. It produces blocks, exposes `ws://127.0.0.1:9944`, and accepts `//Alice` as a funded dev account. The orchestrator can submit a transaction and have it included in a block.

The contract instantiation, however, is rejected with `ExtrinsicFailed: Other`. Inspecting the runtime explains why:

| Probe                        | Result                                                                 |
|------------------------------|------------------------------------------------------------------------|
| `system.version`             | `2.0.0-unknown` (Substrate 2.0, 2020-vintage runtime)                  |
| Metadata version             | v13 - predates modern `frame-metadata`; `@polkadot/api` still parses it, but `cargo-contract` v4/v5 reject anything below v14 |
| `contracts.schedule.version` | 4 - current pallet-contracts ships schedule v15+                       |
| Host functions present       | `tombstoneDeposit`, `rentAllowance`, `setRentAllowance`, `restoreTo`, `rentParams` - the pre-rent-removal API (rent was removed from `pallet-contracts` in 2022) |

`aggregato_verifier` is built with ink! 5.1.1, which emits Wasm against the modern (post-rent) pallet-contracts ABI. The host-function imports the contract needs (`seal_input`, `seal_caller`, `seal_set_storage` in their current shapes, `sr25519_verify`, etc.) do not exist in the bundled runtime. The two ABIs are roughly four years apart, so the published Portaldot dev binary cannot host ink! 4+ contracts at all. This is a runtime issue, not a pipeline one.

What we ship runs end-to-end against `substrate-contracts-node`, which is the canonical reference runtime for ink! and is API-compatible with a modern Portaldot runtime. Switching to a remote endpoint is a one-line change:

```bash
export PORTALDOT_WS=wss://<portaldot_rpc_url>
export CONTRACT_ADDRESS=<deployed_address>
./demo.sh 8
```

We also ship a direct deployer that bypasses `cargo-contract` (it uses `@polkadot/api`, which can talk to legacy metadata if a future runtime needs it):

```bash
node frontend/scripts/deploy_contract.mjs \
  --ws wss://<portaldot_rpc_url> \
  --suri "//Alice" \
  --constructor new \
  --arg 0x<prover_pubkey>
```

The script resolves the contract bundle relative to its own location, so it works from any directory. Pass `--bundle <path>` to override.

When the active endpoint is local, the dashboard shows a `running on local DEV node` banner so the demo never claims to be on Portaldot itself.

---

## License

MIT - see [`LICENSE`](LICENSE).
