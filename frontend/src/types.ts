import type { SubmitProgress } from './wallet'

// ─────────────────────────────────────────────────────────────────────────────
// Shared domain types
// ─────────────────────────────────────────────────────────────────────────────

export type Phase    = 'idle' | 'refine' | 'accumulate' | 'ontransfer' | 'done'
export type DotState = 'idle' | 'active' | 'done' | 'err'
export type DatasetSource = 'demo' | 'generate' | 'upload'

export interface DatasetItem {
  from:       string
  from_name?: string
  to:         string
  to_name?:   string
  amount:     number
  nonce:      number
  preimage:   string
}

export interface DatasetMeta {
  kind:         string
  name:         string
  description?: string
  items:        DatasetItem[]
}

export interface BenchmarkData {
  num_chunks:            number
  chunk_size:            number
  total_items:           number
  sequential_s:          number
  parallel_s:            number
  speedup:               number
  aggregation_s:         number
  total_s:               number
  aggregated_root:       string
  portaldot_block_hash?: string
  pubkey?:               string
  sig?:                  string
  dataset?:              DatasetMeta
  on_chain: {
    success:  boolean
    contract: string
  }
}

export interface WalletSubmitState {
  busy:     boolean
  progress: SubmitProgress
  submit:   () => void
}
