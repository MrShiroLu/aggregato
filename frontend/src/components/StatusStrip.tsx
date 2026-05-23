import { Fragment } from 'react'
import type { Phase } from '../types'

export function StatusStrip({ phase }: { phase: Phase; chunkProgress: number[] }) {
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
