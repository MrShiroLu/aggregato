import { cx, short } from '../util'
import type { Phase, DotState } from '../types'
import { CHUNKS } from '../constants'
import { Panel, Dot } from './common'

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

export function Pipeline({ phase, chunkProgress, running, contract, rpc }: { phase: Phase; chunkProgress: number[]; running: boolean; contract?: string; rpc?: string }) {
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
