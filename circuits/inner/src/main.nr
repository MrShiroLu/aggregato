global CHUNK_SIZE: u32 = 8;

// portaldot_block_hash is a public input that cryptographically binds this
// proof to a specific Portaldot block. Proofs generated for a given Portaldot
// block cannot be replayed on any other chain without knowing that block's hash.
fn main(
    preimages: [Field; 8],
    commitments: [Field; 8],
    chunk_root: pub Field,
    portaldot_block_hash: pub [u8; 32],
) {
    for i in 0..CHUNK_SIZE {
        let h = std::hash::pedersen_hash([preimages[i]]);
        assert(h == commitments[i]);
    }
    let computed = std::hash::pedersen_hash(commitments);
    assert(computed == chunk_root);
    // Each byte of portaldot_block_hash is range-checked implicitly via u8 type.
    // Its presence as `pub` commits it into the proof's public inputs.
    let _anchor = portaldot_block_hash[0];
}

#[test]
fn test_batch() {
    let preimages: [Field; 8] = [1, 2, 3, 4, 5, 6, 7, 8];
    let commitments = preimages.map(|p| std::hash::pedersen_hash([p]));
    let chunk_root = std::hash::pedersen_hash(commitments);
    let block_hash: [u8; 32] = [0; 32];
    main(preimages, commitments, chunk_root, block_hash);
}

#[test]
fn print_commitments_chunk_0() {
    let preimages: [Field; 8] = [1, 2, 3, 4, 5, 6, 7, 8];
    for i in 0..8 {
        std::println(std::hash::pedersen_hash([preimages[i]]));
    }
}

#[test]
fn print_commitments_chunk_1() {
    let preimages: [Field; 8] = [9, 10, 11, 12, 13, 14, 15, 16];
    for i in 0..8 {
        std::println(std::hash::pedersen_hash([preimages[i]]));
    }
}

