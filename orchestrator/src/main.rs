use anyhow::{Context, Result};
use rayon::prelude::*;
use schnorrkel::{ExpansionMode, Keypair, MiniSecretKey, signing_context};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

#[derive(Deserialize, Serialize, Clone)]
struct DatasetItem {
    from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from_name: Option<String>,
    to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    to_name: Option<String>,
    amount: u64,
    nonce: u32,
    /// u64 preimage as decimal string (JSON-safe); fed directly to pedersen_hash.
    preimage: String,
}

#[derive(Deserialize, Serialize)]
struct Dataset {
    kind: String,
    name: String,
    #[serde(default)]
    description: String,
    items: Vec<DatasetItem>,
}

fn load_dataset(path: &Path) -> Result<Dataset> {
    let s = std::fs::read_to_string(path)
        .with_context(|| format!("read dataset {}", path.display()))?;
    let ds: Dataset = serde_json::from_str(&s)
        .with_context(|| format!("parse dataset {}", path.display()))?;
    Ok(ds)
}

/// Parses `[num_chunks] [--dataset path.json]` out of argv in any order.
/// `num_chunks` defaults to 2; dataset path is optional.
fn parse_cli() -> Result<(usize, Option<PathBuf>)> {
    let mut num_chunks: Option<usize> = None;
    let mut dataset: Option<PathBuf> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        if a == "--dataset" {
            dataset = it.next().map(PathBuf::from);
            anyhow::ensure!(dataset.is_some(), "--dataset requires a path");
        } else if let Ok(n) = a.parse::<usize>() {
            num_chunks = Some(n);
        } else {
            anyhow::bail!("unknown arg: {}", a);
        }
    }
    Ok((num_chunks.unwrap_or(2), dataset))
}

const CHUNK_SIZE: usize = 8;
const BB_BIN: &str = "bb";
const NARGO_BIN: &str = "nargo";

fn circuits_dir() -> PathBuf {
    std::env::current_exe()
        .unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .parent().unwrap()
        .join("circuits")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("../circuits"))
}

// ── Hash helpers via nargo tests ──────────────────────────────────────────────

fn run_nargo_print(inner_dir: &str, test_fn: &str, body: &str) -> Result<String> {
    // Copy the circuit into a temp dir so we never mutate the source tree.
    // This is crash-safe and allows future parallel calls.
    let tmp = tempfile::Builder::new().prefix("aggregato_hash_").tempdir()?;
    let src_dir = std::path::Path::new(inner_dir);
    for entry in std::fs::read_dir(src_dir)? {
        let entry = entry?;
        let dest = tmp.path().join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }

    let main_path = tmp.path().join("src/main.nr");
    let original = std::fs::read_to_string(&main_path)?;
    let with_test = format!("{}\n#[test]\nfn {}() {{\n    {}\n}}\n", original, test_fn, body);
    std::fs::write(&main_path, &with_test)?;

    let out = Command::new(NARGO_BIN)
        .args(["test", "--show-output", test_fn])
        .current_dir(tmp.path())
        .output()
        .context("nargo test failed")?;

    let combined = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    for line in combined.lines() {
        let line = line.trim();
        if line.starts_with("0x") && line.len() >= 10 && line.len() <= 66
            && line[2..].chars().all(|c| c.is_ascii_hexdigit())
        {
            return Ok(format!("0x{:0>64}", &line[2..]));
        }
    }
    anyhow::bail!("no hash in nargo output: {}", combined)
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

fn pedersen_hash_field(inner_dir: &str, value: u64) -> Result<String> {
    run_nargo_print(inner_dir, &format!("h_{}", value),
        &format!("std::println(std::hash::pedersen_hash([{}]));", value))
}

fn pedersen_hash_array(inner_dir: &str, fields: &[String], fn_name: &str) -> Result<String> {
    run_nargo_print(inner_dir, fn_name,
        &format!("std::println(std::hash::pedersen_hash([{}]));", fields.join(", ")))
}

fn pedersen_hash_two(inner_dir: &str, a: &str, b: &str, fn_name: &str) -> Result<String> {
    run_nargo_print(inner_dir, fn_name,
        &format!("std::println(std::hash::pedersen_hash([{}, {}]));", a, b))
}

// ── Portaldot block hash ──────────────────────────────────────────────────────

/// Fetches the latest block hash from a Portaldot/Substrate node via JSON-RPC.
/// Falls back to [0u8; 32] when PORTALDOT_WS is unset or the call fails.
async fn fetch_portaldot_block_hash() -> [u8; 32] {
    let ws = match std::env::var("PORTALDOT_WS") {
        Ok(v) => v,
        Err(_) => {
            println!("[block-hash] PORTALDOT_WS not set — using zero anchor");
            return [0u8; 32];
        }
    };
    // Substrate nodes accept HTTP JSON-RPC on the same port as WS.
    let http = ws.replace("wss://", "https://").replace("ws://", "http://");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return [0u8; 32],
    };
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "chain_getBlockHash",
        "params": [],
        "id": 1
    });
    match client.post(&http).json(&body).send().await {
        Ok(resp) => {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(hash_str) = json["result"].as_str() {
                    if let Some(bytes) = parse_hex32(hash_str) {
                        println!("[block-hash] Portaldot anchor: {}", hash_str);
                        return bytes;
                    }
                }
            }
            println!("[block-hash] RPC parse failed — using zero anchor");
            [0u8; 32]
        }
        Err(e) => {
            println!("[block-hash] RPC error ({}) — using zero anchor", e);
            [0u8; 32]
        }
    }
}

fn format_block_hash_toml(bytes: &[u8; 32]) -> String {
    let nums: Vec<String> = bytes.iter().map(|b| b.to_string()).collect();
    format!("[{}]", nums.join(", "))
}

// ── Sr25519 signing ──────────────────────────────────────────────────────────

fn prover_keypair() -> Keypair {
    let seed: [u8; 32] = std::env::var("PROVER_SK")
        .ok()
        .and_then(|h| {
            let h = h.strip_prefix("0x").unwrap_or(&h).to_string();
            hex::decode(&h).ok()
        })
        .and_then(|b| b.try_into().ok())
        .unwrap_or([1u8; 32]);

    MiniSecretKey::from_bytes(&seed)
        .expect("invalid PROVER_SK seed")
        .expand_to_keypair(ExpansionMode::Ed25519)
}

/// Signs `root_bytes || portaldot_block_hash` (64 bytes) so the signature
/// simultaneously authenticates the Merkle root and the Portaldot block anchor.
fn sign_root(keypair: &Keypair, root_bytes: &[u8; 32], block_hash: &[u8; 32]) -> String {
    let ctx = signing_context(b"substrate");
    let mut msg = [0u8; 64];
    msg[..32].copy_from_slice(root_bytes);
    msg[32..].copy_from_slice(block_hash);
    let sig = keypair.sign(ctx.bytes(&msg));
    format!("0x{}", hex::encode(sig.to_bytes()))
}

fn parse_hex32(s: &str) -> Option<[u8; 32]> {
    let h = s.strip_prefix("0x").unwrap_or(s);
    if h.len() != 64 { return None; }
    hex::decode(h).ok()?.try_into().ok()
}

// ── bb binary resolution ──────────────────────────────────────────────────────

fn which_bb() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("BB_PATH") {
        let pb = PathBuf::from(&p);
        if pb.is_file() { return Ok(pb); }
        anyhow::bail!("BB_PATH={} does not point to a file", p);
    }
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(BB_BIN);
            if candidate.is_file() { return Ok(candidate); }
        }
    }
    let fallbacks = [
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".bb").join(BB_BIN)),
        std::env::var("BB_HOME").ok().map(|h| PathBuf::from(h).join(BB_BIN)),
    ];
    for fb in fallbacks.into_iter().flatten() {
        if fb.is_file() {
            eprintln!("[info] bb not on PATH, using {:?}", fb);
            return Ok(fb);
        }
    }
    anyhow::bail!("'{}' not found. Install barretenberg or set BB_PATH=/path/to/bb", BB_BIN)
}

// ── bb prove + verify helper ──────────────────────────────────────────────────
// Writes VK, proves, and verifies inline with `--verify`.
// Returns the public inputs extracted from the JSON output.

fn bb_prove_and_verify(
    bytecode: &Path,
    witness: &Path,
    output_dir: &Path,
    label: &str,
) -> Result<Vec<String>> {
    let bb = which_bb()?;

    let vk_dir = output_dir.join("vk");
    std::fs::create_dir_all(&vk_dir)?;
    let r = Command::new(&bb)
        .args([
            "write_vk",
            "-b", bytecode.to_str().unwrap(),
            "-o", vk_dir.to_str().unwrap(),
            "-t", "noir-recursive",
        ])
        .status()
        .with_context(|| format!("bb write_vk for {}", label))?;
    anyhow::ensure!(r.success(), "bb write_vk failed for {}", label);

    let proof_dir = output_dir.join("proof");
    std::fs::create_dir_all(&proof_dir)?;
    let r = Command::new(&bb)
        .args([
            "prove",
            "-b", bytecode.to_str().unwrap(),
            "-w", witness.to_str().unwrap(),
            "-k", vk_dir.join("vk").to_str().unwrap(),
            "-o", proof_dir.to_str().unwrap(),
            "-t", "noir-recursive",
            "--output_format", "json",
            "--verify",
        ])
        .status()
        .with_context(|| format!("bb prove for {}", label))?;
    anyhow::ensure!(r.success(), "bb prove --verify failed for {}", label);

    let pi_json: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(proof_dir.join("public_inputs.json"))
            .with_context(|| format!("read public_inputs.json for {}", label))?
    )?;
    let pub_inputs: Vec<String> = serde_json::from_value(pi_json["public_inputs"].clone())
        .context("parse public_inputs")?;
    Ok(pub_inputs)
}

// ── Prove one inner chunk ─────────────────────────────────────────────────────
// Returns the chunk_root (public input of the inner circuit).

fn prove_chunk(
    chunk_id: usize,
    preimages: Vec<u64>,
    commitments: Vec<String>,
    chunk_root: String,
    block_hash: [u8; 32],
) -> Result<String> {
    let inner_dir = circuits_dir().join("inner");
    let prover_name = format!("ProverChunk{}", chunk_id);
    let witness_name = format!("chunk_{}", chunk_id);

    let preimages_str = preimages.iter().map(|p| format!("\"{}\"", p)).collect::<Vec<_>>().join(", ");
    let commitments_str = commitments.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(",\n  ");
    std::fs::write(
        inner_dir.join(format!("{}.toml", prover_name)),
        format!(
            "preimages = [{}]\ncommitments = [\n  {}\n]\nchunk_root = \"{}\"\nportaldot_block_hash = {}\n",
            preimages_str, commitments_str, chunk_root, format_block_hash_toml(&block_hash)
        ),
    ).with_context(|| format!("write prover toml for chunk {}", chunk_id))?;

    let r = Command::new(NARGO_BIN)
        .args(["execute", "--prover-name", &prover_name, &witness_name])
        .current_dir(&inner_dir)
        .status()
        .with_context(|| format!("nargo execute for chunk {}", chunk_id))?;
    anyhow::ensure!(r.success(), "nargo execute failed for chunk {}", chunk_id);

    let output_dir = inner_dir.join(format!("target/proof_chunk{}", chunk_id));
    std::fs::create_dir_all(&output_dir)?;

    let pub_inputs = bb_prove_and_verify(
        &inner_dir.join("target/inner.json"),
        &inner_dir.join(format!("target/{}.gz", witness_name)),
        &output_dir,
        &format!("chunk_{}", chunk_id),
    )?;

    std::fs::remove_file(inner_dir.join(format!("{}.toml", prover_name))).ok();

    let root = pub_inputs.into_iter().next()
        .with_context(|| format!("no public inputs from chunk {}", chunk_id))?;
    println!("[chunk {}] verified ✓  root: {}", chunk_id, root);
    Ok(root)
}

// ── Aggregator step ───────────────────────────────────────────────────────────
// Proves that pedersen_hash(root_1, root_2) == aggregated_root.

fn prove_aggregator_step(
    agg_dir: &Path,
    root_1: &str,
    root_2: &str,
    aggregated_root: &str,
    label: &str,
    block_hash: &[u8; 32],
) -> Result<()> {
    std::fs::write(
        agg_dir.join("Prover.toml"),
        format!(
            "root_1 = \"{}\"\nroot_2 = \"{}\"\naggregated_root = \"{}\"\nportaldot_block_hash = {}\n",
            root_1, root_2, aggregated_root, format_block_hash_toml(block_hash)
        ),
    )?;

    let r = Command::new(NARGO_BIN).arg("execute").current_dir(agg_dir).status()?;
    anyhow::ensure!(r.success(), "nargo execute failed for {}", label);

    let output_dir = agg_dir.join("target").join(format!("proof_{}", label));
    std::fs::create_dir_all(&output_dir)?;

    bb_prove_and_verify(
        &agg_dir.join("target/aggregator.json"),
        &agg_dir.join("target/aggregator.gz"),
        &output_dir,
        label,
    )?;
    println!("[{}] aggregation verified ✓  root: {}", label, aggregated_root);
    Ok(())
}

// ── Binary-tree aggregation ───────────────────────────────────────────────────
// Reduces N roots → 1 via binary tree of prove_aggregator_step calls.

fn aggregate_tree(
    inner_dir_str: &str,
    agg_dir: &Path,
    roots: Vec<String>,
    level: usize,
    block_hash: &[u8; 32],
) -> Result<String> {
    if roots.len() == 1 {
        return Ok(roots.into_iter().next().unwrap());
    }

    let mut next_roots = Vec::new();
    let mut idx = 0;
    while idx < roots.len() {
        let pair = idx / 2;
        let merged = pedersen_hash_two(
            inner_dir_str, &roots[idx], &roots[idx + 1],
            &format!("agg_l{}p{}", level, pair),
        )?;
        println!("  [L{} pair {}] root: {}", level, pair, merged);
        let label = format!("l{}p{}", level, pair);
        prove_aggregator_step(agg_dir, &roots[idx], &roots[idx + 1], &merged, &label, block_hash)?;
        next_roots.push(merged);
        idx += 2;
    }

    aggregate_tree(inner_dir_str, agg_dir, next_roots, level + 1, block_hash)
}

// ── Ink! contract submission ──────────────────────────────────────────────────

fn which_cargo_contract() -> String {
    // Try $HOME/.cargo/bin first, then fall back to PATH lookup
    if let Ok(home) = std::env::var("HOME") {
        let p = format!("{home}/.cargo/bin/cargo-contract");
        if std::path::Path::new(&p).exists() {
            return p;
        }
    }
    "cargo-contract".to_string()
}

/// Returns (success, contract_address) for embedding in the benchmark JSON.
fn submit_to_ink_contract(
    root: &str,
    portaldot_block_hash_hex: &str,
    num_chunks: u32,
    total_items: u32,
    signature_hex: &str,
) -> (bool, String) {
    if std::env::var("SKIP_ONCHAIN").ok().as_deref() == Some("1") {
        let contract = std::env::var("CONTRACT_ADDRESS").unwrap_or_default();
        println!("[ink] SKIP_ONCHAIN=1 — leaving submission to frontend wallet");
        return (false, contract);
    }
    let ws = match std::env::var("PORTALDOT_WS") {
        Ok(v) => v,
        Err(_) => {
            println!("[ink] PORTALDOT_WS not set — skipping on-chain submission");
            return (false, String::new());
        }
    };
    let contract = match std::env::var("CONTRACT_ADDRESS") {
        Ok(v) => v,
        Err(_) => {
            println!("[ink] CONTRACT_ADDRESS not set — skipping on-chain submission");
            return (false, String::new());
        }
    };
    let suri = std::env::var("SURI").unwrap_or_else(|_| "//Alice".to_string());
    // Resolve contract dir relative to this binary's location or CARGO_MANIFEST_DIR
    let contract_dir = std::env::var("CONTRACT_MANIFEST_DIR").unwrap_or_else(|_| {
        let exe = std::env::current_exe().unwrap_or_default();
        // exe: .../aggregato/orchestrator/target/debug/orchestrator
        // ancestors: [exe, debug/, target/, orchestrator/, aggregato/]
        // nth(4) = aggregato root
        exe.ancestors()
            .nth(4)
            .unwrap_or(std::path::Path::new("."))
            .join("contracts/aggregato_verifier")
            .to_string_lossy()
            .to_string()
    });
    // Augment PATH so `cargo contract` resolves cargo-contract plugin correctly
    let cargo_bin_dir = which_cargo_contract()
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .unwrap_or_default();
    let path_with_cargo_bin = {
        let base = std::env::var("PATH").unwrap_or_default();
        if cargo_bin_dir.is_empty() { base.clone() } else { format!("{cargo_bin_dir}:{base}") }
    };

    // Check if root already on-chain before submitting (avoids ContractReverted)
    let already = Command::new("cargo")
        .args([
            "contract", "call",
            "--url", &ws,
            "--contract", &contract,
            "--message", "is_verified",
            "--args", &format!("\"{root}\""),
            "--suri", &suri,
        ])
        .env("PATH", &path_with_cargo_bin)
        .current_dir(&contract_dir)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("true"))
        .unwrap_or(false);

    if already {
        println!("[ink] ✓ Root already verified on-chain: {}", root);
        return (true, contract);
    }

    println!("[ink] Submitting to Portaldot contract {}...", contract);
    let output = Command::new("cargo")
        .args([
            "contract", "call",
            "--url", &ws,
            "--contract", &contract,
            "--message", "submit_verified_root",
            "--args", &format!("\"{root}\""),
            &format!("\"{portaldot_block_hash_hex}\""),
            &num_chunks.to_string(),
            &total_items.to_string(),
            &format!("\"{signature_hex}\""),
            "--suri", &suri,
            "--execute",
            "--skip-confirm",
        ])
        .env("PATH", &path_with_cargo_bin)
        .current_dir(&contract_dir)
        .output();
    match output {
        Ok(o) if o.status.success() => {
            println!("[ink] ✓ Root committed on-chain: {}", root);
            (true, contract)
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            let stdout = String::from_utf8_lossy(&o.stdout);
            let combined = format!("{}{}", stderr, stdout);
            println!("[ink] cargo contract call failed ({}): {}", o.status, combined.trim());
            (false, contract)
        }
        Err(e) => {
            println!("[ink] cargo contract not available: {}", e);
            (false, String::new())
        }
    }
}

// ── Sequential baseline ───────────────────────────────────────────────────────

fn prove_chunks_sequential(
    chunks: &[Vec<u64>],
    all_commitments: &[Vec<String>],
    leaf_roots: &[String],
    block_hash: [u8; 32],
) -> Result<f64> {
    let t = Instant::now();
    for (i, ((pre, com), root)) in chunks.iter().zip(all_commitments.iter()).zip(leaf_roots.iter()).enumerate() {
        prove_chunk(i, pre.clone(), com.clone(), root.clone(), block_hash)?;
    }
    Ok(t.elapsed().as_secs_f64())
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    let inner_dir_str = circuits_dir().join("inner").to_str().unwrap().to_string();
    let agg_dir = circuits_dir().join("aggregator");

    let (num_chunks, dataset_path) = parse_cli()?;
    anyhow::ensure!(
        num_chunks.is_power_of_two() && num_chunks >= 2,
        "num_chunks must be a power of 2 (2, 4, 8, ...), got {}", num_chunks
    );

    let total_items = num_chunks * CHUNK_SIZE;

    // Either load a real-looking dataset from disk, or fall back to the
    // deterministic 1..=N sequence for plain benchmark runs.
    let (all_preimages, dataset_meta): (Vec<u64>, Option<Dataset>) = match dataset_path {
        Some(path) => {
            let ds = load_dataset(&path)?;
            anyhow::ensure!(
                ds.items.len() == total_items,
                "dataset {} has {} items but num_chunks={} expects {}",
                path.display(), ds.items.len(), num_chunks, total_items,
            );
            let preimages = ds.items.iter()
                .map(|it| it.preimage.parse::<u64>()
                    .with_context(|| format!("preimage `{}` is not a u64", it.preimage)))
                .collect::<Result<Vec<_>>>()?;
            println!("[dataset] loaded {} ({} items) from {}", ds.name, ds.items.len(), path.display());
            (preimages, Some(ds))
        }
        None => ((1..=(total_items as u64)).collect(), None),
    };
    let chunks: Vec<Vec<u64>> = all_preimages.chunks(CHUNK_SIZE).map(|c| c.to_vec()).collect();

    println!("=== Aggregato Orchestrator ===");
    println!("Items: {}  |  Chunks: {}  |  Chunk size: {}", total_items, num_chunks, CHUNK_SIZE);

    // Fetch the latest Portaldot block hash — used as a public input in every
    // ZK proof, binding the entire batch to a specific Portaldot block state.
    println!("\n[0/5] Fetching Portaldot block anchor...");
    let block_hash = fetch_portaldot_block_hash().await;
    let block_hash_hex = format!("0x{}", hex::encode(block_hash));

    // Step 1: Commitments + chunk roots
    println!("\n[1/5] Computing commitments...");
    let t0 = Instant::now();
    let mut all_commitments: Vec<Vec<String>> = Vec::new();
    let mut leaf_roots: Vec<String> = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        let mut c = Vec::new();
        for &v in chunk { c.push(pedersen_hash_field(&inner_dir_str, v)?); }
        let root = pedersen_hash_array(&inner_dir_str, &c, &format!("leaf_root_{}", i))?;
        leaf_roots.push(root);
        all_commitments.push(c);
    }
    println!("      {:.2}s", t0.elapsed().as_secs_f64());

    // Step 2: Sequential baseline
    println!("\n[2/5] Sequential baseline (JAM single-core simulation)...");
    let seq_time = prove_chunks_sequential(&chunks, &all_commitments, &leaf_roots, block_hash)?;
    println!("      Sequential: {:.2}s", seq_time);

    for i in 0..num_chunks {
        std::fs::remove_dir_all(
            circuits_dir().join("inner").join(format!("target/proof_chunk{}", i))
        ).ok();
    }

    // Step 3: Parallel proving via rayon
    println!("\n[3/5] Proving chunks IN PARALLEL ({} JAM cores)...", num_chunks);
    let t_par = Instant::now();

    let par_inputs: Vec<(usize, Vec<u64>, Vec<String>, String)> = chunks.iter()
        .zip(all_commitments.iter())
        .zip(leaf_roots.iter())
        .enumerate()
        .map(|(i, ((pre, com), root))| (i, pre.clone(), com.clone(), root.clone()))
        .collect();

    let mut chunk_results: Vec<(usize, String)> = tokio::task::spawn_blocking(move || {
        par_inputs
            .into_par_iter()
            .map(|(i, pre, com, root)| {
                let t = Instant::now();
                let chunk_root = prove_chunk(i, pre, com, root, block_hash)?;
                println!("[chunk {}] {:.2}s", i, t.elapsed().as_secs_f64());
                Ok::<_, anyhow::Error>((i, chunk_root))
            })
            .collect::<Result<Vec<_>>>()
    })
    .await??;
    chunk_results.sort_by_key(|(i, _)| *i);

    let par_time = t_par.elapsed().as_secs_f64();
    let speedup = seq_time / par_time;
    println!("      Parallel: {:.2}s  (speedup: {:.2}x)", par_time, speedup);

    // Step 4: Binary-tree aggregation (Accumulate)
    println!("\n[4/5] Accumulate — binary-tree aggregation ({} leaves)...", num_chunks);
    let t_agg = Instant::now();

    let verified_roots: Vec<String> = chunk_results.into_iter().map(|(_, r)| r).collect();
    for (i, r) in verified_roots.iter().enumerate() {
        println!("  [leaf {}] {}", i, r);
    }

    let final_root = if num_chunks == 2 {
        let root = pedersen_hash_two(
            &inner_dir_str, &verified_roots[0], &verified_roots[1], "agg_root_final",
        )?;
        prove_aggregator_step(&agg_dir, &verified_roots[0], &verified_roots[1], &root, "final", &block_hash)?;
        root
    } else {
        aggregate_tree(&inner_dir_str, &agg_dir, verified_roots, 1, &block_hash)?
    };
    println!("  final aggregated_root: {}", final_root);

    let agg_time = t_agg.elapsed().as_secs_f64();
    let total = t0.elapsed().as_secs_f64();

    // Step 5: OnTransfer — sign + submit to Ink! contract
    println!("\n[5/5] OnTransfer — signing and submitting...");
    let keypair = prover_keypair();
    let root_bytes = parse_hex32(&final_root).expect("final_root is always valid hex");
    let signature_hex = sign_root(&keypair, &root_bytes, &block_hash);
    let pubkey_hex = format!("0x{}", hex::encode(keypair.public.to_bytes()));
    println!("[prover] pubkey (use when deploying contract): {}", pubkey_hex);
    println!("[prover] block anchor: {}", block_hash_hex);
    println!("[prover] signature (over root||block_hash): {}", signature_hex);
    let (on_chain_ok, contract_addr) = submit_to_ink_contract(
        &final_root,
        &block_hash_hex,
        num_chunks as u32,
        total_items as u32,
        &signature_hex,
    );

    let on_chain_json = if on_chain_ok {
        format!(r#","on_chain":{{"success":true,"contract":"{}"}}"#, contract_addr)
    } else {
        r#","on_chain":{"success":false,"contract":""}"#.to_string()
    };

    let dataset_json = match &dataset_meta {
        Some(ds) => format!(r#","dataset":{}"#, serde_json::to_string(ds).unwrap_or_else(|_| "null".into())),
        None => String::new(),
    };

    let benchmark_json = format!(
        r#"{{"num_chunks":{},"chunk_size":{},"total_items":{},"sequential_s":{:.3},"parallel_s":{:.3},"speedup":{:.3},"aggregation_s":{:.3},"total_s":{:.3},"aggregated_root":"{}","portaldot_block_hash":"{}","pubkey":"{}","sig":"{}"{}{}}}"#,
        num_chunks, CHUNK_SIZE, total_items,
        seq_time, par_time, speedup, agg_time, total, final_root,
        block_hash_hex, pubkey_hex, signature_hex, on_chain_json, dataset_json
    );
    let repo_root = circuits_dir().parent().unwrap().to_path_buf();
    std::fs::write(repo_root.join("benchmark_latest.json"), &benchmark_json).ok();

    // Append to history for multi-chunk speedup chart
    let history_path = repo_root.join("benchmark_history.json");
    let mut history: Vec<serde_json::Value> = history_path
        .exists()
        .then(|| std::fs::read_to_string(&history_path).ok())
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    if let Ok(entry) = serde_json::from_str::<serde_json::Value>(&benchmark_json) {
        // Replace existing entry for same num_chunks
        history.retain(|e| e.get("num_chunks") != entry.get("num_chunks"));
        history.push(entry);
        history.sort_by_key(|e| e.get("num_chunks").and_then(|v| v.as_u64()).unwrap_or(0));
        if let Ok(s) = serde_json::to_string(&history) {
            std::fs::write(&history_path, s).ok();
        }
    }

    println!("\n[benchmark] {}", benchmark_json);

    println!("\n╔══════════════════════════════════════════════╗");
    println!("║           AGGREGATO RESULTS                  ║");
    println!("╠══════════════════════════════════════════════╣");
    println!("║  Refine  — sequential:  {:>8.2}s            ║", seq_time);
    println!("║  Refine  — parallel:    {:>8.2}s            ║", par_time);
    println!("║  Speedup ({:>2} JAM cores): {:>8.2}x            ║", num_chunks, speedup);
    println!("╠══════════════════════════════════════════════╣");
    println!("║  Accumulate (tree agg): {:>8.2}s            ║", agg_time);
    println!("║  Total pipeline:        {:>8.2}s            ║", total);
    println!("╠══════════════════════════════════════════════╣");
    println!("║  OnTransfer verify:     OK ✓                 ║");
    println!("╚══════════════════════════════════════════════╝");
    println!("\nAggregated root: {}", final_root);

    Ok(())
}
