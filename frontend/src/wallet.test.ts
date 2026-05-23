import { describe, it, expect } from 'vitest'
import {
  explorerExtrinsicUrl,
  explorerBlockUrl,
  feeForChunks,
  formatPot,
  shortAddr,
  stripHexPrefix,
  FEE_PER_CHUNK,
  type PortaldotConfig,
} from './wallet'

const TX = '0x939aac6104f2cd3a05f4bfc54c6f99413bcede241a0ad22890c8b484c36c145b'
const BLK = '0xbfab36322498cfc00e3d010864c26a7aa473a2faae5275233f7e835a7a93e83a'
const local: PortaldotConfig = { ws: 'ws://127.0.0.1:9944', contract: '5xyz' }
const subscan: PortaldotConfig = { ...local, explorer: 'https://shibuya.subscan.io/' }

describe('stripHexPrefix', () => {
  it('removes a leading 0x', () => {
    expect(stripHexPrefix('0xabcd')).toBe('abcd')
  })
  it('leaves a string without 0x untouched', () => {
    expect(stripHexPrefix('abcd')).toBe('abcd')
  })
  it('only strips the first 0x, not occurrences inside', () => {
    expect(stripHexPrefix('0x0xab')).toBe('0xab')
  })
  it('handles the empty string', () => {
    expect(stripHexPrefix('')).toBe('')
  })
})

describe('explorerExtrinsicUrl', () => {
  it('uses the Subscan /extrinsic route when an explorer is configured', () => {
    expect(explorerExtrinsicUrl(subscan, TX)).toBe(`https://shibuya.subscan.io/extrinsic/${TX}`)
  })

  it('strips a trailing slash from the configured explorer base', () => {
    expect(explorerExtrinsicUrl({ ...local, explorer: 'https://x.io/' }, TX))
      .toBe(`https://x.io/extrinsic/${TX}`)
  })

  // Regression: Polkadot.js Apps' explorer/query route only resolves block
  // hashes, so linking an extrinsic hash there errors. We must point at the
  // including block instead.
  it('falls back to the including BLOCK hash on the Polkadot.js link', () => {
    const url = explorerExtrinsicUrl(local, TX, BLK)
    expect(url).toContain(`#/explorer/query/${BLK}`)
    expect(url).not.toContain(TX)
  })

  it('uses the tx hash on Polkadot.js only when no block hash is known yet', () => {
    expect(explorerExtrinsicUrl(local, TX)).toContain(`#/explorer/query/${TX}`)
  })

  it('url-encodes the ws endpoint in the rpc query param', () => {
    expect(explorerExtrinsicUrl(local, TX, BLK))
      .toContain('rpc=ws%3A%2F%2F127.0.0.1%3A9944')
  })
})

describe('explorerBlockUrl', () => {
  it('uses the Subscan /block route when configured', () => {
    expect(explorerBlockUrl(subscan, BLK)).toBe(`https://shibuya.subscan.io/block/${BLK}`)
  })
  it('builds a Polkadot.js explorer/query link from ws otherwise', () => {
    expect(explorerBlockUrl(local, BLK)).toContain(`#/explorer/query/${BLK}`)
  })
})

describe('feeForChunks', () => {
  it('is zero for zero chunks', () => {
    expect(feeForChunks(0)).toBe(0n)
  })
  it('scales linearly with chunk count', () => {
    expect(feeForChunks(8)).toBe(FEE_PER_CHUNK * 8n)
  })
})

describe('formatPot', () => {
  it('renders whole POT with no fractional part', () => {
    expect(formatPot(FEE_PER_CHUNK * 100n)).toBe('1') // 1e12 base units = 1 POT
  })
  it('renders the 8-chunk service fee as 0.08', () => {
    expect(formatPot(feeForChunks(8))).toBe('0.08')
  })
  it('trims trailing zeros in the fraction', () => {
    expect(formatPot(1_500_000_000_000n)).toBe('1.5')
  })
  it('honours the fractional-digit cap', () => {
    // 1.23456 POT capped at 2 digits → 1.23
    expect(formatPot(1_234_560_000_000n, 2)).toBe('1.23')
  })
  it('renders sub-unit amounts with a leading zero', () => {
    expect(formatPot(10_000_000_000n)).toBe('0.01')
  })
})

describe('shortAddr', () => {
  it('truncates long addresses with an ellipsis', () => {
    const a = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
    expect(shortAddr(a)).toBe(`${a.slice(0, 6)}…${a.slice(-6)}`)
  })
  it('leaves short strings unchanged', () => {
    expect(shortAddr('5Grw')).toBe('5Grw')
  })
})
