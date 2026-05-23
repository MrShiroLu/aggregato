import { cx } from '../util'
import type { DotState } from '../types'

export function Panel({ title, kicker, right, children, className }: {
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

export function Dot({ state }: { state: DotState }) {
  const map: Record<DotState, string> = {
    idle: 'bg-line2', active: 'bg-accent', done: 'bg-accent', err: 'bg-err',
  }
  return <span className={cx('inline-block w-1.5 h-1.5', map[state] || map.idle)} />
}
