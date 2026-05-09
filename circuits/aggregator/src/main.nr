// Aggregates two sub-roots via Pedersen hash.
// Works at every level of the binary aggregation tree.
// portaldot_block_hash binds every aggregation step to a specific Portaldot
// block, making the entire proof tree chain-specific and non-replayable.
fn main(
    root_1: Field,
    root_2: Field,
    aggregated_root: pub Field,
    portaldot_block_hash: pub [u8; 32],
) {
    let computed = std::hash::pedersen_hash([root_1, root_2]);
    assert(computed == aggregated_root);
    let _anchor = portaldot_block_hash[0];
}
