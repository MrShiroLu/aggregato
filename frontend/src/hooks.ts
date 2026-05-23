import { useState, useEffect, useRef, useCallback } from 'react'
import type { InjectedAccountWithMeta } from '@polkadot/extension-inject/types'
import { submitVerifiedRoot, type WalletState, type PortaldotConfig, type SubmitProgress } from './wallet'
import type { BenchmarkData, DatasetMeta, Phase, WalletSubmitState } from './types'
import { CHUNKS } from './constants'

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark polling hook
// ─────────────────────────────────────────────────────────────────────────────

export function useBenchmark(pollIntervalMs = 3000) {
  const [data, setData] = useState<BenchmarkData | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetch_ = () => {
      fetch('/api/benchmark')
        .then(r => r.ok ? r.json() : null)
        .then((json: BenchmarkData | null) => { if (!cancelled && json) setData(json) })
        .catch(() => { /* server not running yet */ })
    }

    fetch_()
    const id = setInterval(fetch_, pollIntervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [pollIntervalMs])

  return data
}

// ─────────────────────────────────────────────────────────────────────────────
// Run-machine: drives phase, chunk progress, and log streaming
// ─────────────────────────────────────────────────────────────────────────────

export function useRunMachine() {
  const [runId, setRunId]                 = useState(0)
  const [phase, setPhase]                 = useState<Phase>('done')
  const [chunkProgress, setChunkProgress] = useState<number[]>(Array(CHUNKS).fill(1))
  const [lines, setLines]                 = useState<{ ts: number; text: string }[]>([])
  const [orchRunning, setOrchRunning]     = useState(false)
  const [hasRun, setHasRun]               = useState(false)
  const sinceRef       = useRef(0)
  const seenRunIdRef   = useRef<number | null>(null)

  // Poll orchestrator status + chunk progress
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      fetch('/api/run')
        .then(r => r.json())
        .then((d: { running: boolean; phase: Phase; runId: number; chunkProgress: number[] }) => {
          if (cancelled) return
          setOrchRunning(Boolean(d.running))
          if (typeof d.runId === 'number') setRunId(d.runId)
          if (d.phase) setPhase(d.phase)
          if (Array.isArray(d.chunkProgress)) {
            setChunkProgress(d.chunkProgress.slice(0, CHUNKS).concat(Array(Math.max(0, CHUNKS - d.chunkProgress.length)).fill(0)))
          }
        })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, 700)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // Poll log buffer
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      fetch(`/api/run/logs?since=${sinceRef.current}`)
        .then(r => r.json())
        .then((d: { lines: { i: number; ts: number; text: string }[]; next: number; runId: number }) => {
          if (cancelled) return
          if (seenRunIdRef.current !== d.runId) {
            seenRunIdRef.current = d.runId
            sinceRef.current = 0
            setLines([])
          }
          if (d.lines.length) {
            setLines(prev => [...prev, ...d.lines.map(l => ({ ts: l.ts, text: l.text }))])
            sinceRef.current = d.next
          }
        })
        .catch(() => {})
    }
    tick()
    const id = setInterval(tick, orchRunning ? 400 : 1500)
    return () => { cancelled = true; clearInterval(id) }
  }, [orchRunning])

  const run = useCallback((opts?: { walletSubmit?: boolean; dataset?: DatasetMeta | null }) => {
    setHasRun(true)
    setOrchRunning(true)
    setPhase('refine')
    setChunkProgress(Array(CHUNKS).fill(0))
    setLines([])
    sinceRef.current = 0
    const body: Record<string, unknown> = {
      num_chunks: CHUNKS,
      wallet_submit: Boolean(opts?.walletSubmit),
    }
    if (opts?.dataset) body.dataset_inline = opts.dataset
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { setOrchRunning(false) })
  }, [])

  const running = orchRunning
  return { runId, phase, running, chunkProgress, lines, run, hasRun }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet submit state
// ─────────────────────────────────────────────────────────────────────────────

export function useWalletSubmit(
  benchmark: BenchmarkData | null,
  wallet: WalletState,
  portaldot: PortaldotConfig | null,
): WalletSubmitState {
  const [busy, setBusy]         = useState(false)
  const [progress, setProgress] = useState<SubmitProgress>({ stage: 'idle', message: '' })

  const submit = useCallback(() => {
    if (!benchmark || !portaldot || wallet.status !== 'connected' || !wallet.account) return
    if (!benchmark.portaldot_block_hash || !benchmark.sig) {
      setProgress({ stage: 'error', message: 'benchmark missing block hash or signature' })
      return
    }
    setBusy(true)
    setProgress({ stage: 'connecting', message: 'preparing submission' })
    submitVerifiedRoot(
      portaldot,
      wallet.account as InjectedAccountWithMeta,
      {
        root:       benchmark.aggregated_root,
        blockHash:  benchmark.portaldot_block_hash,
        numChunks:  benchmark.num_chunks,
        totalItems: benchmark.total_items,
        signature:  benchmark.sig,
      },
      setProgress,
    )
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        setProgress({ stage: 'error', message: msg })
      })
      .finally(() => setBusy(false))
  }, [benchmark, portaldot, wallet])

  return { busy, progress, submit }
}
