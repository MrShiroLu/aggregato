import { cx } from '../util'
import type { Phase, BenchmarkData } from '../types'
import { Panel } from './common'

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

export function Metrics({ phase, benchmark }: { phase: Phase; benchmark: BenchmarkData | null }) {
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
