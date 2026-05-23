import type { DatasetItem, DatasetMeta } from './types'

function randomU64Decimal(): string {
  // u64 in [0, 2^63) as decimal string. Safe across Rust/JSON.
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  bytes[0] &= 0x7f
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n.toString()
}

function randomAddrHex(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function generateRandomDataset(count: number): DatasetMeta {
  const items: DatasetItem[] = []
  for (let i = 0; i < count; i++) {
    items.push({
      from:    randomAddrHex(),
      to:      randomAddrHex(),
      amount:  Math.floor(Math.random() * 9_900_000) + 100_000,
      nonce:   i,
      preimage: randomU64Decimal(),
    })
  }
  return {
    kind: 'rollup_tx_batch',
    name: `generated-${count}`,
    description: `Browser-generated random transaction batch (${count} items, fresh per run).`,
    items,
  }
}

export function validateDataset(raw: unknown, expectedCount: number): DatasetMeta {
  if (!raw || typeof raw !== 'object') throw new Error('dataset must be a JSON object')
  const ds = raw as Partial<DatasetMeta>
  if (!Array.isArray(ds.items)) throw new Error('dataset.items must be an array')
  if (ds.items.length !== expectedCount) {
    throw new Error(`dataset must contain exactly ${expectedCount} items (got ${ds.items.length})`)
  }
  for (let i = 0; i < ds.items.length; i++) {
    const it = ds.items[i] as Partial<DatasetItem>
    if (typeof it.from !== 'string' || typeof it.to !== 'string'
        || typeof it.amount !== 'number' || typeof it.nonce !== 'number'
        || typeof it.preimage !== 'string') {
      throw new Error(`item #${i} is missing required fields (from/to/amount/nonce/preimage)`)
    }
  }
  return {
    kind: ds.kind ?? 'rollup_tx_batch',
    name: ds.name ?? 'uploaded',
    description: ds.description ?? 'User-uploaded transaction batch.',
    items: ds.items as DatasetItem[],
  }
}
