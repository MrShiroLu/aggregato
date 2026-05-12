# frontend/scripts

Standalone Node.js utilities. These are **not** bundled into the Vite app —
they're one-shot tools you run with `node`.

## deploy_contract.mjs

Deploys `aggregato_verifier` to any Substrate chain that exposes a
`pallet-contracts.instantiateWithCode` extrinsic. Uses `@polkadot/api`
directly so it works against legacy metadata (v13+) where `cargo-contract`
refuses to talk.

```bash
# from repo root
node frontend/scripts/deploy_contract.mjs \
  --ws ws://127.0.0.1:9944 \
  --suri "//Alice" \
  --constructor new \
  --arg 0x<prover_pubkey_hex>
```

Flags:

| Flag            | Default                                  | Notes                                    |
|-----------------|------------------------------------------|------------------------------------------|
| `--ws`          | `ws://127.0.0.1:9944`                    | RPC endpoint                             |
| `--suri`        | `//Alice`                                | dev keyring URI; supply real seed in prod |
| `--bundle`      | `../../contracts/aggregato_verifier/target/ink/aggregato_verifier.contract` (resolved from script location) | `.contract` bundle path |
| `--constructor` | `new`                                    | constructor label from ink! metadata     |
| `--arg`         | (repeatable)                             | constructor args in order                |
| `--endowment`   | `1000000000000` (1 unit)                 | value transferred on instantiate         |
| `--gas`         | `500000000000`                           | legacy `Compact<u64>` gas limit          |

On success prints `=== DEPLOYED ===` with the new contract address.

## check_pallets.mjs

One-screen probe of a running node. Prints chain name, runtime version,
metadata version, and whether `pallet-contracts` / `pallet-revive` exist.
Useful when figuring out whether a freshly published RPC can host modern
ink! contracts.

```bash
node frontend/scripts/check_pallets.mjs
```

Edit the hardcoded WS URL inside the file if you need a different endpoint —
it's a debug script, not a CLI.
