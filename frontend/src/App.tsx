import { useState, useEffect, useRef, useCallback, Fragment } from 'react'
import {
  useWallet, usePortaldotConfig, submitVerifiedRoot, shortAddr,
  type SubmitProgress, type WalletState, type PortaldotConfig,
} from './wallet'
import type { InjectedAccountWithMeta } from '@polkadot/extension-inject/types'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type Phase    = 'idle' | 'refine' | 'accumulate' | 'ontransfer' | 'done'
type DotState = 'idle' | 'active' | 'done' | 'err'

interface DatasetItem {
  from:       string
  from_name?: string
  to:         string
  to_name?:   string
  amount:     number
  nonce:      number
  preimage:   string
}

interface DatasetMeta {
  kind:         string
  name:         string
  description?: string
  items:        DatasetItem[]
}

interface BenchmarkData {
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

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CHUNKS = 8


// ─────────────────────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────────────────────

const cx = (...xs: (string | false | undefined | null)[]) => xs.filter(Boolean).join(' ')
const short = (h: string, n = 10) => h.slice(0, 2 + n) + '…' + h.slice(-n)


// ─────────────────────────────────────────────────────────────────────────────
// Small atoms
// ─────────────────────────────────────────────────────────────────────────────

function Panel({ title, kicker, right, children, className }: {
  title?: string; kicker?: string; right?: React.ReactNode
  children: React.ReactNode; className?: string
}) {
  return (
    <section className={cx('border border-line bg-panel', className)}>
      {(title || right) && (
        <header className="flex items-center justify-between px-5 py-3 border-b border-line">
          <div className="flex items-baseline gap-3">
            {kicker && <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-mute2">{kicker}</span>}
            <h3 className="text-[13px] font-medium tracking-tight text-ink">{title}</h3>
          </div>
          {right && <div className="text-mute">{right}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

function Dot({ state }: { state: DotState }) {
  const map: Record<DotState, string> = {
    idle: 'bg-line2', active: 'bg-accent', done: 'bg-accent', err: 'bg-err',
  }
  return <span className={cx('inline-block w-1.5 h-1.5', map[state] || map.idle)} />
}


// ─────────────────────────────────────────────────────────────────────────────
// Header
// ─────────────────────────────────────────────────────────────────────────────

function Header({ running, runId, onRun, wallet, onConnect }: {
  running: boolean; runId: number; onRun: () => void
  wallet: WalletState; onConnect: () => void
}) {
  return (
    <header className="border-b border-line bg-bg sticky top-0 z-20">
      <div className="max-w-[1480px] mx-auto px-8 py-4 flex items-center justify-between">
        <a href="/" className="flex items-center gap-4 hover:opacity-80 transition-opacity">
          <img src="/logo.svg" width={32} height={32} alt="Aggregato" className="object-contain" />
          <h1 className="text-[18px] font-semibold tracking-tight">Aggregato</h1>
        </a>

        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-2 font-mono text-[11px] text-mute">
            <Dot state={running ? 'active' : 'done'} />
            <span>{running ? 'orchestrator running' : 'orchestrator idle'}</span>
            <span className="text-mute2 ml-3">run #</span>
            <span className="text-ink">{String(runId).padStart(4, '0')}</span>
          </div>
          <WalletButton wallet={wallet} onConnect={onConnect} />
          {(() => {
            const walletReady = wallet.status === 'connected' && !!wallet.account
            const disabled = running || !walletReady
            const label =
              running       ? '▶ running…'
              : !walletReady ? '⬡ connect wallet to run'
              :                '▶ run benchmark'
            return (
              <button
                onClick={onRun}
                disabled={disabled}
                title={!walletReady ? 'Connect a Polkadot wallet to start a benchmark run' : ''}
                className={cx(
                  'font-mono text-[11px] tracking-[0.16em] uppercase px-4 py-2 border transition-colors',
                  disabled
                    ? 'border-line text-mute2 cursor-not-allowed'
                    : 'border-accent text-bg bg-accent hover:bg-accentDk hover:border-accentDk',
                )}
              >
                {label}
              </button>
            )
          })()}
        </div>
      </div>
    </header>
  )
}

function WalletButton({ wallet, onConnect }: { wallet: WalletState; onConnect: () => void }) {
  if (wallet.status === 'connected' && wallet.account) {
    const name = wallet.account.meta.name ?? 'wallet'
    return (
      <div className="flex items-center gap-2 font-mono text-[11px] px-3 py-2 border border-accent text-accent">
        <span className="w-1.5 h-1.5 bg-accent" />
        <span>{name}</span>
        <span className="text-mute2">·</span>
        <span className="text-ink">{shortAddr(wallet.account.address, 5)}</span>
      </div>
    )
  }
  const label =
    wallet.status === 'connecting'   ? '… connecting'
    : wallet.status === 'no-extension' ? 'install extension'
    : wallet.status === 'error'      ? 'retry connect'
    :                                  '⬡ connect wallet'
  return (
    <button
      onClick={onConnect}
      disabled={wallet.status === 'connecting'}
      className={cx(
        'font-mono text-[11px] tracking-[0.16em] uppercase px-4 py-2 border transition-colors',
        wallet.status === 'no-extension'
          ? 'border-warn text-warn hover:bg-warn/10'
          : 'border-line text-ink hover:border-accent hover:text-accent',
      )}
      title={wallet.error ?? ''}
    >
      {label}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline: Refine → Accumulate → OnTransfer (JAM mapping)
// ─────────────────────────────────────────────────────────────────────────────

function PipelineStage({ idx, label, jam, sub, state, children, wide }: {
  idx: number; label: string; jam: string; sub: string
  state: DotState; children: React.ReactNode; wide?: boolean
}) {
  return (
    <div className={cx(
      'border bg-panel flex flex-col',
      wide ? 'flex-[2.2]' : 'flex-1',
      state === 'active' ? 'border-accent' : 'border-line'
    )}>
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] text-mute2">0{idx}</span>
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-mute">{jam}</span>
          <span className="text-mute2">·</span>
          <span className="text-[13px] font-medium text-ink">{label}</span>
        </div>
        <Dot state={state} />
      </div>
      <div className="p-4 flex-1 flex flex-col">
        {children}
        <div className="mt-auto pt-3 font-mono text-[10px] text-mute2">{sub}</div>
      </div>
    </div>
  )
}

function ChunkGrid({ progress, running }: { progress: number[]; running: boolean }) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {Array.from({ length: CHUNKS }).map((_, i) => {
        const p = progress[i] ?? 0
        const done = p >= 1
        return (
          <div key={i} className="border border-line bg-panel2 px-2 py-2">
            <div className="flex items-center justify-between text-[10px] font-mono">
              <span className="text-mute2">w{i}</span>
              <span className={done ? 'text-accent' : (p > 0 ? 'text-ink' : 'text-mute2')}>
                {done ? '✓' : (running && p > 0 ? Math.round(p * 100) + '%' : '—')}
              </span>
            </div>
            <div className="mt-2 h-[3px] bg-line">
              <div
                className="h-full bg-accent transition-[width] duration-150 ease-linear"
                style={{ width: `${Math.min(1, p) * 100}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ArrowConnector({ active }: { active: boolean }) {
  return (
    <div className="self-stretch flex items-center justify-center px-1">
      <div className="relative h-[1px] w-10 bg-line overflow-hidden">
        {active && <div className="flowline absolute inset-0" />}
      </div>
    </div>
  )
}

function Pipeline({ phase, chunkProgress, running, contract, rpc }: { phase: Phase; chunkProgress: number[]; running: boolean; contract?: string; rpc?: string }) {
  const stateOf = (key: string): DotState => {
    if (phase === 'idle') return 'idle'
    const order = ['refine', 'accumulate', 'ontransfer']
    const cur = order.indexOf(phase)
    const me  = order.indexOf(key)
    if (phase === 'done') return 'done'
    if (me < cur) return 'done'
    if (me === cur) return 'active'
    return 'idle'
  }
  return (
    <Panel
      kicker="01"
      title="Processing flow"
      right={<span className="font-mono text-[10px] tracking-[0.14em] uppercase text-mute2">JAM mapping</span>}
    >
      <div className="p-5 flex items-stretch gap-0">
        <PipelineStage idx={1} jam="Refine" label="Prove chunks in parallel"
          state={stateOf('refine')} sub="noir + barretenberg · 8 workers" wide
        >
          <ChunkGrid progress={chunkProgress} running={running} />
        </PipelineStage>
        <ArrowConnector active={stateOf('refine') === 'done' || stateOf('accumulate') === 'active'} />
        <PipelineStage idx={2} jam="Accumulate" label="Merge to Merkle root"
          state={stateOf('accumulate')} sub="binary tree · depth 3"
        >
          <MerkleDiagram
            active={stateOf('accumulate') !== 'idle'}
            done={stateOf('accumulate') === 'done' || phase === 'ontransfer' || phase === 'done'}
          />
        </PipelineStage>
        <ArrowConnector active={stateOf('accumulate') === 'done' || stateOf('ontransfer') === 'active'} />
        <PipelineStage idx={3} jam="OnTransfer" label="Submit to Ink! contract"
          state={stateOf('ontransfer')} sub="portaldot · sr25519-signed extrinsic"
        >
          <SubmitDiagram active={stateOf('ontransfer') !== 'idle'} done={phase === 'done'} contract={contract} rpc={rpc} />
        </PipelineStage>
      </div>
    </Panel>
  )
}

function MerkleDiagram({ active, done }: { active: boolean; done: boolean }) {
  const nodeCls = (lit: boolean) => cx('w-3 h-3 border', lit ? 'bg-accent border-accent' : 'bg-panel border-line2')
  return (
    <div className="flex flex-col items-center gap-3 py-1">
      <div className={cx('px-2 py-1 border font-mono text-[10px]',
        done ? 'border-accent text-accent' : 'border-line2 text-mute')}>
        root
      </div>
      <div className="flex gap-8">
        <div className={nodeCls(active)} /><div className={nodeCls(active)} />
      </div>
      <div className="flex gap-3">
        {[0,1,2,3].map(i => <div key={i} className={nodeCls(active)} />)}
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className={cx('w-2 h-2', active ? 'bg-accentDk' : 'bg-line')} />
        ))}
      </div>
    </div>
  )
}

function SubmitDiagram({ active, done, contract, rpc }: { active: boolean; done: boolean; contract?: string; rpc?: string }) {
  const contractDisplay = contract && contract.length > 14 ? short(contract, 6) : (contract || 'awaiting on-chain submit')
  const rpcDisplay = rpc || 'awaiting rpc'
  return (
    <div className="flex flex-col gap-2 font-mono text-[11px]">
      <div className="flex items-center gap-2 text-mute">
        <span className="text-mute2">→</span><span className="break-all">{rpcDisplay}</span>
      </div>
      <div className="flex items-center gap-2 text-mute">
        <span className="text-mute2">→</span><span>contract {contractDisplay}</span>
      </div>
      <div className="flex items-center gap-2 text-mute">
        <span className="text-mute2">→</span><span>submit_verified_root(…)</span>
      </div>
      <div className="mt-1 px-2 py-1.5 border border-line2 bg-panel2 flex items-center justify-between">
        <span className="text-mute2 text-[10px] tracking-[0.14em] uppercase">event</span>
        <span className={done ? 'text-accent' : (active ? 'text-warn' : 'text-mute2')}>
          {done ? 'ProofVerified ✓' : (active ? 'awaiting…' : '—')}
        </span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Dataset — shows the actual tx batch being proved, grouped by chunk
// ─────────────────────────────────────────────────────────────────────────────

function formatAmount(microDot: number): string {
  // amounts are in micro-DOT (10^-6); render with up to 2 decimal places
  const dot = microDot / 1_000_000
  if (dot >= 100) return dot.toFixed(0)
  if (dot >= 10)  return dot.toFixed(1)
  return dot.toFixed(2)
}

function partyLabel(name: string | undefined, addr: string): string {
  if (name && name.length > 0) return name
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-3)}` : addr
}

function Dataset({ dataset, chunkSize }: { dataset: DatasetMeta; chunkSize: number }) {
  const chunks: DatasetItem[][] = []
  for (let i = 0; i < dataset.items.length; i += chunkSize) {
    chunks.push(dataset.items.slice(i, i + chunkSize))
  }

  return (
    <Panel
      kicker="02"
      title="Dataset"
      right={
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-mute2">
          {dataset.kind.replace(/_/g, ' ')} · {dataset.items.length} items
        </span>
      }
    >
      {dataset.description && (
        <div className="px-5 pt-4 font-mono text-[10px] text-mute leading-relaxed">
          {dataset.description}
        </div>
      )}
      <div className="p-5 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {chunks.map((items, ci) => (
          <div key={ci} className="border border-line bg-panel2">
            <div className="px-3 py-2 border-b border-line flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-mute2">chunk {ci}</span>
              <span className="font-mono text-[10px] text-mute">{items.length} txs</span>
            </div>
            <div className="px-3 py-2 font-mono text-[10.5px] leading-[1.55]">
              {items.map((tx, ti) => (
                <div key={ti} className="flex items-center justify-between gap-3 py-[3px] border-b border-line/40 last:border-b-0">
                  <div className="flex items-center gap-1.5 text-ink min-w-0">
                    <span className="text-mute2 tabular-nums w-4 text-right">{ci * chunkSize + ti}</span>
                    <span className="truncate">{partyLabel(tx.from_name, tx.from)}</span>
                    <span className="text-mute2">→</span>
                    <span className="truncate">{partyLabel(tx.to_name, tx.to)}</span>
                  </div>
                  <div className="flex items-baseline gap-2 shrink-0">
                    <span className="text-accent tabular-nums">{formatAmount(tx.amount)}</span>
                    <span className="text-mute2 text-[9.5px]">DOT</span>
                    <span className="text-mute2 text-[9.5px]">n{tx.nonce}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

function MetricCard({ kicker, value, unit, sub, highlight, children }: {
  kicker: string; value: string; unit?: string; sub?: string
  highlight?: boolean; children?: React.ReactNode
}) {
  return (
    <div className={cx(
      'border bg-panel p-5 flex flex-col gap-3 min-h-[150px]',
      highlight ? 'border-accent bg-panel2' : 'border-line'
    )}>
      <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-mute2">{kicker}</div>
      <div className="flex items-baseline gap-2">
        <div className={cx(
          'font-mono font-medium tabular-nums leading-none',
          highlight ? 'text-accent text-[44px]' : 'text-ink text-[34px]'
        )}>{value}</div>
        {unit && <div className="font-mono text-[13px] text-mute">{unit}</div>}
      </div>
      {sub && <div className="font-mono text-[11px] text-mute">{sub}</div>}
      {children}
    </div>
  )
}

function SpeedupBar({ seq, par }: { seq: number; par: number }) {
  const max = Math.max(seq, par)
  return (
    <div className="mt-1 space-y-2 font-mono text-[10px]">
      <div className="flex items-center gap-2">
        <span className="w-8 text-mute2">seq</span>
        <div className="flex-1 h-[6px] bg-line">
          <div className="h-full bg-line2" style={{ width: `${(seq / max) * 100}%` }} />
        </div>
        <span className="text-mute tabular-nums w-12 text-right">{seq.toFixed(2)}s</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-8 text-mute2">par</span>
        <div className="flex-1 h-[6px] bg-line">
          <div className="h-full bg-accent" style={{ width: `${(par / max) * 100}%` }} />
        </div>
        <span className="text-accent tabular-nums w-12 text-right">{par.toFixed(2)}s</span>
      </div>
    </div>
  )
}

function Metrics({ phase, benchmark }: { phase: Phase; benchmark: BenchmarkData | null }) {
  const measured = phase === 'done'
  const d = benchmark

  const workload   = d ? String(d.total_items)                              : '—'
  const workloadSub = d ? `chunks: ${d.num_chunks} × ${d.chunk_size}`      : 'no data yet'
  const seqVal     = d ? d.sequential_s.toFixed(2)                         : '—'
  const parVal     = d ? d.parallel_s.toFixed(2)                           : '—'
  const speedupVal = d ? d.speedup.toFixed(2) + '×'                        : '—'

  return (
    <Panel
      kicker="03"
      title="Benchmark metrics"
      right={
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-mute2">
          {d ? (measured ? 'measured · last run' : 'last completed run') : 'awaiting benchmark data'}
        </span>
      }
    >
      <div className="grid grid-cols-4 gap-px bg-line">
        <MetricCard kicker="Workload"   value={workload}   unit={d ? 'items' : ''} sub={workloadSub} />
        <MetricCard kicker="Sequential" value={seqVal}     unit={d ? 's' : ''}     sub="single-threaded baseline" />
        <MetricCard kicker="Parallel"   value={parVal}     unit={d ? 's' : ''}     sub={`${d?.num_chunks ?? '?'} barretenberg workers`} />
        <MetricCard kicker="Speedup"    value={speedupVal}                          sub="parallel vs sequential" highlight>
          {d && <SpeedupBar seq={d.sequential_s} par={d.parallel_s} />}
        </MetricCard>
      </div>
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal
// ─────────────────────────────────────────────────────────────────────────────

function colorizeLine(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const re = /(\[[^\]\n]+\])|(0x[0-9a-fA-F]{4,})|(ProofVerified)|(✓)/g
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(<span key={key++} className="text-ink/90">{text.slice(last, m.index)}</span>)
    }
    const seg = m[0]
    let cls = 'text-ink/90'
    if (m[1])      cls = 'text-accentDk'
    else if (m[2]) cls = 'text-accent'
    else if (m[3]) cls = 'text-accent'
    else if (m[4]) cls = 'text-ok'
    out.push(<span key={key++} className={cls}>{seg}</span>)
    last = m.index + seg.length
  }
  if (last < text.length) out.push(<span key={key++} className="text-ink/90">{text.slice(last)}</span>)
  return out
}

function Terminal({ lines, running }: { lines: { ts: number; text: string }[]; running: boolean; runId: number }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [lines.length])

  const fmtTs = (ms: number) => new Date(ms).toISOString().slice(11, 23)

  return (
    <Panel
      kicker="04"
      title="Orchestrator console"
      right={
        <div className="flex items-center gap-3 font-mono text-[10px] text-mute2">
          <span>aggregato/orchestrator</span>
          <span>·</span>
          <span>rust 1.78</span>
          <span>·</span>
          <span>{running ? <span className="text-accent">live</span> : 'attached'}</span>
        </div>
      }
    >
      {/* fake window chrome */}
      <div className="px-4 py-2 border-b border-line bg-panel2 flex items-center gap-2 font-mono text-[10px] text-mute2">
        <span className="w-2 h-2 border border-line2" />
        <span className="w-2 h-2 border border-line2" />
        <span className="w-2 h-2 border border-line2" />
        <span className="ml-3">~/aggregato $ cargo run --release --bin orchestrator</span>
      </div>
      <div
        ref={scrollRef}
        className="scrollbar font-mono text-[12px] leading-[1.65] p-4 max-h-[420px] min-h-[420px] overflow-y-auto bg-panel"
      >
        {lines.map((l, i) => (
          <div key={i} className="flex gap-3 whitespace-pre-wrap break-all">
            <span className="text-mute2 select-none shrink-0">{fmtTs(l.ts)}</span>
            <span className="flex-1">
              {colorizeLine(l.text).map((node, j) => <Fragment key={j}>{node}</Fragment>)}
            </span>
          </div>
        ))}
        {running && (
          <div className="flex gap-3 whitespace-pre">
            <span className="text-mute2 select-none">{fmtTs(Date.now())}</span>
            <span className="text-mute">▌<span className="caret text-accent">█</span></span>
          </div>
        )}
        {!running && lines.length > 0 && (
          <div className="flex gap-3 whitespace-pre pt-1">
            <span className="text-mute2 select-none">{fmtTs(Date.now())}</span>
            <span className="text-mute">~/aggregato $ <span className="caret text-accent">█</span></span>
          </div>
        )}
      </div>
    </Panel>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification card
// ─────────────────────────────────────────────────────────────────────────────

function Copyable({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(value) } catch { /* ignore */ }
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className="group w-full text-left border border-line bg-panel2 hover:border-line2 transition-colors"
    >
      <div className="px-3 py-2 border-b border-line flex items-center justify-between">
        <span className="font-mono text-[10px] tracking-[0.16em] uppercase text-mute2">{label}</span>
        <span className="font-mono text-[10px] text-mute group-hover:text-accent">
          {copied ? 'copied' : 'copy'}
        </span>
      </div>
      <div className="px-3 py-3 font-mono text-[11px] text-ink break-all">{value}</div>
    </button>
  )
}

function Verification({ phase, benchmark, wallet, portaldot, walletSubmit }: {
  phase: Phase; benchmark: BenchmarkData | null
  wallet: WalletState; portaldot: PortaldotConfig | null
  walletSubmit: WalletSubmitState
}) {
  const onChainOk = benchmark?.on_chain?.success ?? false
  const verified  = onChainOk || walletSubmit.progress.stage === 'finalized'
  const contract  = benchmark?.on_chain?.contract || portaldot?.contract || '—'
  const root      = benchmark?.aggregated_root ?? '—'

  const submitterDisplay =
    wallet.status === 'connected' && wallet.account
      ? shortAddr(wallet.account.address, 6)
      : (onChainOk ? 'alice//aggregato' : 'awaiting submitter')

  return (
    <Panel
      kicker="05"
      title="On-chain verification state"
      right={<span className="font-mono text-[10px] tracking-[0.14em] uppercase text-mute2">portaldot · ink!</span>}
    >
      <div className="p-5 grid grid-cols-1 gap-4">
        <div className="border border-line bg-panel2">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Dot state={verified ? 'done' : 'idle'} />
              <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-mute2">contract event</span>
              <span className={cx('font-mono text-[12px]', verified ? 'text-accent' : 'text-mute')}>
                ProofVerified
              </span>
            </div>
            <span className={cx('font-mono text-[10px] tracking-[0.14em] uppercase', verified ? 'text-ok' : 'text-mute2')}>
              {verified ? '● success' : '○ pending'}
            </span>
          </div>
          <div className="px-4 py-4 grid grid-cols-2 gap-y-3 gap-x-6 font-mono text-[11px]">
            <Field k="contract"  v={contract.length > 14 ? short(contract, 6) : contract} />
            <Field k="submitter" v={submitterDisplay} good={wallet.status === 'connected'} />
            <Field k="chunks"    v={benchmark ? String(benchmark.num_chunks) : '—'} />
            <Field k="items"     v={benchmark ? String(benchmark.total_items) : '—'} />
            <Field k="total_s"   v={benchmark ? benchmark.total_s.toFixed(3) + 's' : '—'} />
            <Field k="verified"  v={verified ? '✓ on-chain' : '—'} good={verified} />
          </div>
        </div>
        <Copyable value={root} label="aggregated merkle root" />
        <Copyable value={benchmark?.sig ? short(benchmark.sig, 18) : '—'} label="sr25519 signature (truncated)" />
        <WalletSubmitPanel
          phase={phase}
          benchmark={benchmark}
          wallet={wallet}
          portaldot={portaldot}
          state={walletSubmit}
        />
      </div>
    </Panel>
  )
}

interface WalletSubmitState {
  busy:     boolean
  progress: SubmitProgress
  submit:   () => void
}

function WalletSubmitPanel({ phase, benchmark, wallet, portaldot, state }: {
  phase: Phase; benchmark: BenchmarkData | null
  wallet: WalletState; portaldot: PortaldotConfig | null
  state: WalletSubmitState
}) {
  const ready =
    wallet.status === 'connected' &&
    !!benchmark &&
    !!benchmark.portaldot_block_hash &&
    !!benchmark.sig &&
    (phase === 'done' || phase === 'ontransfer') &&
    !!portaldot?.contract

  const blockMsg =
    wallet.status !== 'connected' ? 'connect a Polkadot wallet to enable wallet-driven submit'
    : !benchmark                  ? 'run a benchmark first'
    : !benchmark.portaldot_block_hash ? 'benchmark predates wallet support — re-run orchestrator'
    : !portaldot?.contract        ? 'set CONTRACT_ADDRESS env to enable submit'
    : phase !== 'done' && phase !== 'ontransfer' ? 'aggregation must finish first'
    :                               ''

  const stage = state.progress.stage
  const stageBadge =
    stage === 'finalized' ? 'text-ok'
    : stage === 'error'   ? 'text-err'
    : stage === 'idle'    ? 'text-mute2'
    :                       'text-warn'

  return (
    <div className="border border-line bg-panel2">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-mute2">wallet submit</span>
          <span className="text-mute2">·</span>
          <span className="font-mono text-[11px] text-ink">submit_verified_root</span>
        </div>
        <span className={cx('font-mono text-[10px] tracking-[0.14em] uppercase', stageBadge)}>
          {stage === 'idle' ? '○ idle' : `● ${stage}`}
        </span>
      </div>
      <div className="px-4 py-4 flex flex-col gap-3">
        <button
          onClick={state.submit}
          disabled={!ready || state.busy}
          className={cx(
            'font-mono text-[11px] tracking-[0.16em] uppercase px-4 py-2 border transition-colors w-full',
            !ready || state.busy
              ? 'border-line text-mute2 cursor-not-allowed'
              : 'border-accent text-bg bg-accent hover:bg-accentDk hover:border-accentDk',
          )}
        >
          {state.busy ? '▶ awaiting wallet…' : '▶ submit proof with my wallet'}
        </button>
        {blockMsg && (
          <div className="font-mono text-[10px] text-mute2">{blockMsg}</div>
        )}
        {state.progress.message && stage !== 'idle' && (
          <div className="font-mono text-[10px] text-mute break-all">
            <span className="text-mute2 mr-2">{stage}</span>{state.progress.message}
          </div>
        )}
        {state.progress.txHash && (
          <div className="font-mono text-[10px] text-mute break-all">
            <span className="text-mute2 mr-2">tx</span>{state.progress.txHash}
          </div>
        )}
        {state.progress.blockHash && (
          <div className="font-mono text-[10px] text-mute break-all">
            <span className="text-mute2 mr-2">blk</span>{state.progress.blockHash}
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ k, v, good }: { k: string; v: string; good?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 pb-2">
      <span className="text-mute2 tracking-[0.12em] uppercase text-[10px]">{k}</span>
      <span className={cx('tabular-nums', good ? 'text-accent' : 'text-ink')}>{v}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Network banner — names the active endpoint so the demo is honest about it
// ─────────────────────────────────────────────────────────────────────────────

function NetworkBanner({ portaldot }: { portaldot: PortaldotConfig | null }) {
  if (!portaldot) return null
  const ws = portaldot.ws
  const isLocal = /^wss?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(ws)
  return (
    <div className="border border-accent/40 bg-accent/[0.04] px-5 py-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <span className="w-1.5 h-1.5 bg-accent shrink-0" />
        <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-accent">
          {isLocal ? 'local dev node' : 'remote endpoint'}
        </span>
        <span className="font-mono text-[12px] text-mute">
          Connected to <span className="text-ink">{ws}</span>
        </span>
      </div>
      <span className="font-mono text-[10px] text-mute2 text-right">
        running on a local Portaldot-compatible dev environment
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Sidebar status strip
// ─────────────────────────────────────────────────────────────────────────────

function StatusStrip({ phase }: { phase: Phase; chunkProgress: number[] }) {
  const stages = [
    { k: 'refine', l: 'Refine' },
    { k: 'accumulate', l: 'Accumulate' },
    { k: 'ontransfer', l: 'OnTransfer' },
  ]
  const order = ['refine', 'accumulate', 'ontransfer']
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-line border border-line">
      <KV k="Network"   v="Portaldot" />
      <KV k="Prover"    v="Barretenberg / Noir" />
      <KV k="Signature" v="sr25519" />
      <KV k="Stage" v={
        <span className="flex items-center gap-2">
          {stages.map((s, i) => {
            const cur = order.indexOf(phase)
            const me  = order.indexOf(s.k)
            const cls = phase === 'done' || me < cur ? 'text-accent' :
                        me === cur ? 'text-ink' : 'text-mute2'
            return (
              <Fragment key={s.k}>
                <span className={cls}>{s.l}</span>
                {i < stages.length - 1 && <span className="text-mute2">›</span>}
              </Fragment>
            )
          })}
        </span>
      } />
    </div>
  )
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="bg-panel p-4">
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-mute2">{k}</div>
      <div className="mt-1.5 font-mono text-[12px] text-ink">{v}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark polling hook
// ─────────────────────────────────────────────────────────────────────────────

function useBenchmark(pollIntervalMs = 3000) {
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

function useRunMachine() {
  const [runId, setRunId]                 = useState(0)
  const [phase, setPhase]                 = useState<Phase>('done')
  const [chunkProgress, setChunkProgress] = useState<number[]>(Array(CHUNKS).fill(1))
  const [lines, setLines]                 = useState<{ ts: number; text: string }[]>([])
  const [orchRunning, setOrchRunning]     = useState(false)
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

  const run = useCallback((opts?: { walletSubmit?: boolean }) => {
    setOrchRunning(true)
    setPhase('refine')
    setChunkProgress(Array(CHUNKS).fill(0))
    setLines([])
    sinceRef.current = 0
    fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        num_chunks: CHUNKS,
        wallet_submit: Boolean(opts?.walletSubmit),
      }),
    }).catch(() => { setOrchRunning(false) })
  }, [])

  const running = orchRunning
  return { runId, phase, running, chunkProgress, lines, run }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet submit state
// ─────────────────────────────────────────────────────────────────────────────

function useWalletSubmit(
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

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const benchmark = useBenchmark(3000)
  const { runId, phase, running, chunkProgress, lines, run } = useRunMachine()
  const { state: wallet, connect } = useWallet()
  const portaldot   = usePortaldotConfig()
  const walletSubmit = useWalletSubmit(benchmark, wallet, portaldot)

  const runWithMaybeWallet = useCallback(() => {
    if (wallet.status !== 'connected' || !wallet.account) return
    run({ walletSubmit: true })
  }, [run, wallet.status, wallet.account])

  return (
    <div className="min-h-screen">
      <Header
        running={running}
        runId={runId}
        onRun={runWithMaybeWallet}
        wallet={wallet}
        onConnect={connect}
      />

      <main className="max-w-[1480px] mx-auto px-8 py-8 space-y-6">

        <NetworkBanner portaldot={portaldot} />
        <StatusStrip phase={phase} chunkProgress={chunkProgress} />
        <Pipeline phase={phase} chunkProgress={chunkProgress} running={running} contract={benchmark?.on_chain?.contract || portaldot?.contract} rpc={portaldot?.ws} />
        {benchmark?.dataset && <Dataset dataset={benchmark.dataset} chunkSize={benchmark.chunk_size} />}
        <Metrics phase={phase} benchmark={benchmark} />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3">
            <Terminal lines={lines} running={running} runId={runId} />
          </div>
          <div className="lg:col-span-2">
            <Verification
              phase={phase}
              benchmark={benchmark}
              wallet={wallet}
              portaldot={portaldot}
              walletSubmit={walletSubmit}
            />
          </div>
        </div>

        <footer className="pt-6 pb-12 flex items-center justify-between border-t border-line">
          <div className="flex items-center gap-3 text-mute">
            <img src="/logo.svg" width={18} height={18} alt="" className="object-contain opacity-60" />
            <span className="font-mono text-[11px]">aggregato · parallel-zk-aggregator</span>
          </div>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-mute2">
            built for portaldot · 2026
          </div>
        </footer>
      </main>
    </div>
  )
}
