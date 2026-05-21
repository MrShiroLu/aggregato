//! Aggregato Verifier — Ink! smart contract on Portaldot
//!
//! Phase 4 (OnTransfer): Receives the aggregated Merkle root produced by the
//! Rust orchestrator, verifies the prover's Sr25519 signature on-chain, stores
//! the root, and emits a ProofVerified event so any dApp can react to it.
//!
//! Verification model:
//! The orchestrator signs the 32-byte aggregated root with its Sr25519 private
//! key before calling this contract.  The contract uses the `sr25519_verify`
//! host function (exposed by pallet-contracts) to authenticate the submission
//! without trusting the caller's identity alone.  Full on-chain Barretenberg
//! proof verification is out-of-scope for the MVP; a future upgrade can swap in
//! a ZK precompile when Portaldot exposes one.

#![cfg_attr(not(feature = "std"), no_std, no_main)]

#[ink::contract]
mod aggregato_verifier {
    use ink::prelude::string::String;
    use ink::storage::Mapping;

    #[derive(scale::Decode, scale::Encode, Clone)]
    #[cfg_attr(
        feature = "std",
        derive(scale_info::TypeInfo, ink::storage::traits::StorageLayout)
    )]
    pub struct VerifiedRoot {
        pub aggregated_root: [u8; 32],
        /// Portaldot block hash at proof-generation time.
        /// Every ZK proof in the tree committed to this hash as a public input,
        /// binding the entire computation to a specific Portaldot block.
        pub portaldot_block_hash: [u8; 32],
        pub num_chunks: u32,
        pub total_items: u32,
        pub submitted_at: u64,
        pub submitter: AccountId,
        /// Service fee paid by the submitter in POT base units.
        pub fee_paid: Balance,
    }

    /// Service fee per aggregated chunk, in POT base units (12 decimals).
    /// 10_000_000_000 = 0.01 POT. Each batch must pay FEE_PER_CHUNK × num_chunks
    /// so cost scales with the work the aggregator did off-chain.
    pub const FEE_PER_CHUNK: Balance = 10_000_000_000;

    #[ink(storage)]
    pub struct AggregatoVerifier {
        owner: AccountId,
        /// Sr25519 public key of the authorized prover node (32 bytes).
        prover_pubkey: [u8; 32],
        roots: Mapping<[u8; 32], VerifiedRoot>,
        root_index: Mapping<u32, [u8; 32]>,
        proof_count: u32,
        /// Lifetime total of service fees collected (not yet withdrawn).
        collected_fees: Balance,
    }

    #[ink(event)]
    pub struct ProofVerified {
        #[ink(topic)]
        aggregated_root: [u8; 32],
        /// Portaldot block the ZK proofs were anchored to.
        #[ink(topic)]
        portaldot_block_hash: [u8; 32],
        num_chunks: u32,
        total_items: u32,
        proof_count: u32,
        #[ink(topic)]
        submitter: AccountId,
        fee_paid: Balance,
    }

    #[ink(event)]
    pub struct FeesWithdrawn {
        #[ink(topic)]
        to: AccountId,
        amount: Balance,
    }

    #[derive(Debug, PartialEq, Eq, scale::Encode, scale::Decode)]
    #[cfg_attr(feature = "std", derive(scale_info::TypeInfo))]
    pub enum Error {
        NotOwner,
        AlreadyVerified,
        InvalidRootFormat,
        InvalidSignature,
        InsufficientFee,
        TransferFailed,
    }

    pub type Result<T> = core::result::Result<T, Error>;

    impl AggregatoVerifier {
        /// Deploy with the deployer as owner and the prover's Sr25519 public key.
        ///
        /// `prover_pubkey` is the 32-byte compressed Sr25519 public key of the
        /// orchestrator node.  Obtain it by running the orchestrator with
        /// `PRINT_PUBKEY=1` or via `subkey inspect <SURI>`.
        #[ink(constructor)]
        pub fn new(prover_pubkey: [u8; 32]) -> Self {
            Self {
                owner: Self::env().caller(),
                prover_pubkey,
                roots: Mapping::default(),
                root_index: Mapping::default(),
                proof_count: 0,
                collected_fees: 0,
            }
        }

        /// Submit a verified aggregated root with an Sr25519 signature.
        ///
        /// The orchestrator calls this after `bb verify` succeeds off-chain.
        /// `aggregated_root_hex`    — 0x-prefixed 64-char hex Merkle root.
        /// `portaldot_block_hash_hex` — 0x-prefixed 64-char hex of the Portaldot
        ///   block hash that was embedded as a public input into every ZK proof
        ///   in the aggregation tree.  This cryptographically anchors the proof
        ///   batch to a specific Portaldot block and prevents cross-chain replay.
        /// `signature_hex` — 0x-prefixed 128-char Sr25519 signature over the
        ///   64-byte message `root_bytes || portaldot_block_hash_bytes`.
        ///
        /// The contract verifies the signature on-chain via the `sr25519_verify`
        /// host function (Substrate-native, unavailable on EVM chains) before
        /// accepting the submission.
        #[ink(message, payable)]
        pub fn submit_verified_root(
            &mut self,
            aggregated_root_hex: String,
            portaldot_block_hash_hex: String,
            num_chunks: u32,
            total_items: u32,
            signature_hex: String,
        ) -> Result<()> {
            // Validate the submission first (cheap, no state changes). The fee
            // check comes last so a malformed/forged submission can return Err
            // before we bookkeep the transferred value as collected revenue.
            let root_bytes = parse_hex_root(&aggregated_root_hex)
                .ok_or(Error::InvalidRootFormat)?;

            let block_hash_bytes = parse_hex_root(&portaldot_block_hash_hex)
                .ok_or(Error::InvalidRootFormat)?;

            let sig_bytes = parse_hex_sig(&signature_hex)
                .ok_or(Error::InvalidSignature)?;

            // Build the 64-byte signed message: root_bytes || portaldot_block_hash.
            // The orchestrator signs this combined message so the signature
            // simultaneously authenticates the Merkle root AND the Portaldot
            // block anchor — both must match for verification to pass.
            let mut msg = [0u8; 64];
            msg[..32].copy_from_slice(&root_bytes);
            msg[32..].copy_from_slice(&block_hash_bytes);

            // On-chain Sr25519 verification via pallet-contracts host function.
            // This host function is Substrate-specific and does not exist on EVM.
            ink::env::sr25519_verify(&sig_bytes, &msg, &self.prover_pubkey)
                .map_err(|_| Error::InvalidSignature)?;

            if self.roots.contains(root_bytes) {
                return Err(Error::AlreadyVerified);
            }

            // POT-as-gas: caller pays FEE_PER_CHUNK × num_chunks in addition to
            // the base extrinsic fee. The collected balance accrues to the
            // aggregator operator (owner) and can be withdrawn with withdraw_fees.
            let required_fee = FEE_PER_CHUNK.saturating_mul(num_chunks as Balance);
            let paid = self.env().transferred_value();
            if paid < required_fee {
                return Err(Error::InsufficientFee);
            }

            let caller = self.env().caller();
            let entry = VerifiedRoot {
                aggregated_root: root_bytes,
                portaldot_block_hash: block_hash_bytes,
                num_chunks,
                total_items,
                submitted_at: self.env().block_timestamp(),
                submitter: caller,
                fee_paid: paid,
            };

            self.roots.insert(root_bytes, &entry);
            self.root_index.insert(self.proof_count, &root_bytes);
            self.proof_count = self.proof_count.saturating_add(1);
            self.collected_fees = self.collected_fees.saturating_add(paid);

            self.env().emit_event(ProofVerified {
                aggregated_root: root_bytes,
                portaldot_block_hash: block_hash_bytes,
                num_chunks,
                total_items,
                proof_count: self.proof_count,
                submitter: caller,
                fee_paid: paid,
            });

            Ok(())
        }

        /// Fee charged for a batch of the given chunk count, in POT base units.
        #[ink(message)]
        pub fn fee_for_chunks(&self, num_chunks: u32) -> Balance {
            FEE_PER_CHUNK.saturating_mul(num_chunks as Balance)
        }

        /// Total service fees collected and not yet withdrawn.
        #[ink(message)]
        pub fn collected_fees(&self) -> Balance {
            self.collected_fees
        }

        /// Withdraw accumulated service fees to the owner (owner-only).
        #[ink(message)]
        pub fn withdraw_fees(&mut self) -> Result<Balance> {
            if self.env().caller() != self.owner {
                return Err(Error::NotOwner);
            }
            let amount = self.collected_fees;
            if amount == 0 {
                return Ok(0);
            }
            self.collected_fees = 0;
            self.env()
                .transfer(self.owner, amount)
                .map_err(|_| Error::TransferFailed)?;
            self.env().emit_event(FeesWithdrawn { to: self.owner, amount });
            Ok(amount)
        }

        /// Check whether a root (0x-prefixed hex) has been verified.
        #[ink(message)]
        pub fn is_verified(&self, aggregated_root_hex: String) -> bool {
            parse_hex_root(&aggregated_root_hex)
                .map(|b| self.roots.contains(b))
                .unwrap_or(false)
        }

        /// Get entry by 0x-prefixed hex root.
        #[ink(message)]
        pub fn get_entry(&self, aggregated_root_hex: String) -> Option<VerifiedRoot> {
            let root = parse_hex_root(&aggregated_root_hex)?;
            self.roots.get(root)
        }

        /// Total number of verified proofs stored.
        #[ink(message)]
        pub fn proof_count(&self) -> u32 {
            self.proof_count
        }

        /// Owner account.
        #[ink(message)]
        pub fn owner(&self) -> AccountId {
            self.owner
        }

        /// Current prover's Sr25519 public key.
        #[ink(message)]
        pub fn prover_pubkey(&self) -> [u8; 32] {
            self.prover_pubkey
        }

        /// Rotate the authorized prover's public key (owner only).
        #[ink(message)]
        pub fn set_prover_pubkey(&mut self, new_pubkey: [u8; 32]) -> Result<()> {
            if self.env().caller() != self.owner {
                return Err(Error::NotOwner);
            }
            self.prover_pubkey = new_pubkey;
            Ok(())
        }

        /// Transfer ownership (for multi-prover setups).
        #[ink(message)]
        pub fn transfer_ownership(&mut self, new_owner: AccountId) -> Result<()> {
            if self.env().caller() != self.owner {
                return Err(Error::NotOwner);
            }
            self.owner = new_owner;
            Ok(())
        }
    }

    // ── Hex helpers ───────────────────────────────────────────────────────────

    fn parse_hex_root(s: &str) -> Option<[u8; 32]> {
        let hex = s.strip_prefix("0x").unwrap_or(s);
        if hex.len() != 64 {
            return None;
        }
        let mut bytes = [0u8; 32];
        for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
            let hi = hex_nibble(chunk[0])?;
            let lo = hex_nibble(chunk[1])?;
            bytes[i] = (hi << 4) | lo;
        }
        Some(bytes)
    }

    fn parse_hex_sig(s: &str) -> Option<[u8; 64]> {
        let hex = s.strip_prefix("0x").unwrap_or(s);
        if hex.len() != 128 {
            return None;
        }
        let mut bytes = [0u8; 64];
        for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
            let hi = hex_nibble(chunk[0])?;
            let lo = hex_nibble(chunk[1])?;
            bytes[i] = (hi << 4) | lo;
        }
        Some(bytes)
    }

    fn hex_nibble(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b.saturating_sub(b'0')),
            b'a'..=b'f' => Some(b.saturating_sub(b'a').saturating_add(10)),
            b'A'..=b'F' => Some(b.saturating_sub(b'A').saturating_add(10)),
            _ => None,
        }
    }

    // ── Tests ─────────────────────────────────────────────────────────────────

    #[cfg(test)]
    mod tests {
        use super::*;
        use schnorrkel::{ExpansionMode, Keypair, MiniSecretKey, signing_context};

        fn test_keypair() -> Keypair {
            MiniSecretKey::from_bytes(&[1u8; 32])
                .unwrap()
                .expand_to_keypair(ExpansionMode::Ed25519)
        }

        const TEST_BLOCK_HASH: &str =
            "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

        fn pay(value: Balance) {
            ink::env::test::set_value_transferred::<ink::env::DefaultEnvironment>(value);
        }

        fn fee(num_chunks: u32) -> Balance {
            FEE_PER_CHUNK.saturating_mul(num_chunks as Balance)
        }

        fn sign_combined(kp: &Keypair, root: &[u8; 32], block_hash: &[u8; 32]) -> String {
            let ctx = signing_context(b"substrate");
            let mut msg = [0u8; 64];
            msg[..32].copy_from_slice(root);
            msg[32..].copy_from_slice(block_hash);
            let sig = kp.sign(ctx.bytes(&msg));
            let bytes = sig.to_bytes();
            format!("0x{}", bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>())
        }

        #[ink::test]
        fn submit_and_query() {
            let kp = test_keypair();
            let mut contract = AggregatoVerifier::new(kp.public.to_bytes());

            let root = "0x1595ee7e09fb5804c2256d5332f202ccd5e0a575da018ca6cf69ea50ced55b55".to_string();
            let root_bytes = parse_hex_root(&root).unwrap();
            let block_hash_bytes = parse_hex_root(TEST_BLOCK_HASH).unwrap();
            let sig = sign_combined(&kp, &root_bytes, &block_hash_bytes);

            assert!(!contract.is_verified(root.clone()));
            assert_eq!(contract.proof_count(), 0);

            pay(fee(2));
            contract.submit_verified_root(
                root.clone(), TEST_BLOCK_HASH.to_string(), 2, 16, sig
            ).unwrap();

            assert!(contract.is_verified(root.clone()));
            assert_eq!(contract.proof_count(), 1);
            assert_eq!(contract.collected_fees(), fee(2));

            let entry = contract.get_entry(root).unwrap();
            assert_eq!(entry.num_chunks, 2);
            assert_eq!(entry.total_items, 16);
            assert_eq!(entry.portaldot_block_hash, block_hash_bytes);
            assert_eq!(entry.fee_paid, fee(2));
        }

        #[ink::test]
        fn insufficient_fee_rejected() {
            let kp = test_keypair();
            let mut contract = AggregatoVerifier::new(kp.public.to_bytes());

            let root = "0x1595ee7e09fb5804c2256d5332f202ccd5e0a575da018ca6cf69ea50ced55b55".to_string();
            let root_bytes = parse_hex_root(&root).unwrap();
            let block_hash_bytes = parse_hex_root(TEST_BLOCK_HASH).unwrap();
            let sig = sign_combined(&kp, &root_bytes, &block_hash_bytes);

            pay(fee(2) - 1);
            assert_eq!(
                contract.submit_verified_root(
                    root, TEST_BLOCK_HASH.to_string(), 2, 16, sig
                ),
                Err(Error::InsufficientFee)
            );
        }

        #[ink::test]
        fn duplicate_rejected() {
            let kp = test_keypair();
            let mut contract = AggregatoVerifier::new(kp.public.to_bytes());

            let root = "0x1595ee7e09fb5804c2256d5332f202ccd5e0a575da018ca6cf69ea50ced55b55".to_string();
            let root_bytes = parse_hex_root(&root).unwrap();
            let block_hash_bytes = parse_hex_root(TEST_BLOCK_HASH).unwrap();
            let sig = sign_combined(&kp, &root_bytes, &block_hash_bytes);

            pay(fee(2));
            contract.submit_verified_root(
                root.clone(), TEST_BLOCK_HASH.to_string(), 2, 16, sig.clone()
            ).unwrap();
            pay(fee(2));
            assert_eq!(
                contract.submit_verified_root(
                    root, TEST_BLOCK_HASH.to_string(), 2, 16, sig
                ),
                Err(Error::AlreadyVerified)
            );
        }

        #[ink::test]
        fn invalid_hex_rejected() {
            let mut contract = AggregatoVerifier::new([0u8; 32]);
            let fake_sig = format!("0x{}", "ab".repeat(64));
            pay(fee(2));
            assert_eq!(
                contract.submit_verified_root(
                    "not_hex".to_string(), TEST_BLOCK_HASH.to_string(), 2, 16, fake_sig
                ),
                Err(Error::InvalidRootFormat)
            );
        }

        #[ink::test]
        fn invalid_signature_rejected() {
            let kp = test_keypair();
            let mut contract = AggregatoVerifier::new(kp.public.to_bytes());

            let root = "0x1595ee7e09fb5804c2256d5332f202ccd5e0a575da018ca6cf69ea50ced55b55".to_string();
            let bad_sig = format!("0x{}", "00".repeat(64));
            pay(fee(2));
            assert_eq!(
                contract.submit_verified_root(
                    root, TEST_BLOCK_HASH.to_string(), 2, 16, bad_sig
                ),
                Err(Error::InvalidSignature)
            );
        }
    }
}
