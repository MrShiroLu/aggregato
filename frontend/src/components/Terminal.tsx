import { useRef, useEffect, Fragment } from 'react'
import { Panel } from './common'

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

export function Terminal({ lines, running }: { lines: { ts: number; text: string }[]; running: boolean }) {
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
        className="scrollbar font-mono text-[12px] leading-[1.65] p-4 max-h-[596px] min-h-[560px] overflow-y-auto bg-panel"
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
