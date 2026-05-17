// Generates a deterministic, realistic-looking rollup tx batch JSON for the
// Aggregato demo. The `preimage` field is the u64 fed into pedersen_hash by
// the inner circuit — derived here so the JSON is the single source of truth.
//
//   cargo run --bin gen_dataset -- --size 16 --out demo_data/txs_16.json

use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
struct Item {
    from: String,
    from_name: String,
    to: String,
    to_name: String,
    amount: u64,
    nonce: u32,
    preimage: String,
}

#[derive(Serialize)]
struct Dataset {
    kind: &'static str,
    name: String,
    description: &'static str,
    items: Vec<Item>,
}

// Well-known Substrate dev addresses plus a handful of deterministic
// SS58-style fillers — gives the demo "real-looking" senders/receivers.
const ACCOUNTS: &[(&str, &str)] = &[
    ("Alice",   "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"),
    ("Bob",     "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty"),
    ("Charlie", "5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y"),
    ("Dave",    "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy"),
    ("Eve",     "5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw"),
    ("Ferdie",  "5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL"),
    ("Ivy",     "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV"),
    ("Mallory", "5EYCAe5cKPAoFh2HnQQvpKqRrZS4nWumnL1z3BFSCxsh6kjy"),
];

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    // Keep the high bit clear so the value round-trips cleanly through any
    // i64-typed JSON consumer; the circuit only cares about it as a Field.
    h & 0x7fff_ffff_ffff_ffff
}

fn parse_args() -> Result<(usize, PathBuf, String)> {
    let mut size: Option<usize> = None;
    let mut out: Option<PathBuf> = None;
    let mut name: Option<String> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--size" => size = it.next().and_then(|s| s.parse().ok()),
            "--out"  => out  = it.next().map(PathBuf::from),
            "--name" => name = it.next(),
            _ => bail!("unknown arg: {}", a),
        }
    }
    let size = size.context("--size required")?;
    let out  = out.context("--out required")?;
    if size == 0 || size % 8 != 0 {
        bail!("--size must be a positive multiple of 8 (got {})", size);
    }
    let name = name.unwrap_or_else(|| format!("demo-{}", size));
    Ok((size, out, name))
}

fn main() -> Result<()> {
    let (size, out, name) = parse_args()?;

    let mut nonces = vec![0u32; ACCOUNTS.len()];
    let mut items = Vec::with_capacity(size);

    for i in 0..size {
        // Deterministic but varied sender/receiver/amount mix.
        let from_idx = i % ACCOUNTS.len();
        let to_idx   = (i * 3 + 1) % ACCOUNTS.len();
        let to_idx   = if to_idx == from_idx { (to_idx + 1) % ACCOUNTS.len() } else { to_idx };
        let (from_name, from) = ACCOUNTS[from_idx];
        let (to_name, to)     = ACCOUNTS[to_idx];
        // Amounts in micro-DOT, varied across orders of magnitude for visual
        // texture without ever colliding into the trivial "all 1's" look.
        let amount: u64 = 100_000 + ((i as u64) * 1_730_117) % 9_000_000;
        let nonce = nonces[from_idx];
        nonces[from_idx] += 1;

        let canon = format!("{}|{}|{}|{}", from, to, amount, nonce);
        let preimage = fnv1a_64(canon.as_bytes());

        items.push(Item {
            from: from.to_string(),
            from_name: from_name.to_string(),
            to:   to.to_string(),
            to_name: to_name.to_string(),
            amount,
            nonce,
            preimage: preimage.to_string(),
        });
    }

    let ds = Dataset {
        kind: "rollup_tx_batch",
        name,
        description: "Synthetic L2 transaction batch for the Aggregato demo. \
                      Each item's `preimage` is FNV-1a(from|to|amount|nonce) and is the u64 fed into pedersen_hash by the inner circuit.",
        items,
    };

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&ds)?;
    std::fs::write(&out, json)?;
    println!("wrote {} items → {}", size, out.display());
    Ok(())
}
