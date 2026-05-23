import { useState, useRef } from 'react'
import { cx } from '../util'
import type { DatasetItem, DatasetMeta, DatasetSource } from '../types'
import { TOTAL_ITEMS } from '../constants'
import { generateRandomDataset, validateDataset } from '../dataset'
import { Panel } from './common'

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

export function Dataset({ dataset, chunkSize, preview = false }: { dataset: DatasetMeta; chunkSize: number; preview?: boolean }) {
  const chunks: DatasetItem[][] = []
  for (let i = 0; i < dataset.items.length; i += chunkSize) {
    chunks.push(dataset.items.slice(i, i + chunkSize))
  }

  return (
    <Panel
      kicker="02"
      title={preview ? 'Dataset (preview)' : 'Dataset'}
      right={
        <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-mute2">
          {preview && <span className="text-accent mr-2">● pending run</span>}
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

export function DatasetSourcePanel({ source, onSourceChange, dataset, onDataset, disabled }: {
  source: DatasetSource
  onSourceChange: (s: DatasetSource) => void
  dataset: DatasetMeta | null
  onDataset: (d: DatasetMeta | null) => void
  disabled: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const pick = (s: DatasetSource) => {
    if (disabled) return
    setError(null)
    onSourceChange(s)
    if (s === 'demo') {
      onDataset(null)
    } else if (s === 'generate') {
      onDataset(generateRandomDataset(TOTAL_ITEMS))
    } else {
      onDataset(null)
      setTimeout(() => fileRef.current?.click(), 0)
    }
  }

  const handleFile = async (file: File) => {
    setError(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const ds = validateDataset(parsed, TOTAL_ITEMS)
      onDataset(ds)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      onDataset(null)
    }
  }

  const regenerate = () => {
    if (disabled) return
    onDataset(generateRandomDataset(TOTAL_ITEMS))
  }

  const Badge = ({ s, label, sub }: { s: DatasetSource; label: string; sub: string }) => {
    const active = source === s
    return (
      <button
        onClick={() => pick(s)}
        disabled={disabled}
        className={cx(
          'flex-1 text-left px-4 py-3 border transition-colors',
          active ? 'border-accent bg-accent/10' : 'border-line hover:border-line2',
          disabled && 'opacity-50 cursor-not-allowed',
        )}
      >
        <div className={cx('font-mono text-[10px] tracking-[0.16em] uppercase',
          active ? 'text-accent' : 'text-mute2')}>
          {label}
        </div>
        <div className="text-[11px] text-mute mt-1">{sub}</div>
      </button>
    )
  }

  const status =
    source === 'demo'     ? `bundled demo · ${TOTAL_ITEMS} items`
    : source === 'generate' ? (dataset ? `generated · ${dataset.items.length} items (fresh per click)` : 'no batch generated yet')
    : (dataset ? `uploaded · ${dataset.name} · ${dataset.items.length} items` : 'choose a JSON file…')

  return (
    <Panel
      kicker="00"
      title="Dataset source"
      right={<span className="font-mono text-[10px] tracking-[0.14em] uppercase text-mute2">input to refine phase</span>}
    >
      <div className="p-5 space-y-3">
        <div className="flex gap-2">
          <Badge s="demo"     label="Demo fixture"  sub={`bundled txs_${TOTAL_ITEMS}.json`} />
          <Badge s="generate" label="Generate"      sub="random batch in browser" />
          <Badge s="upload"   label="Upload JSON"   sub="bring your own batch" />
        </div>
        <div className="flex items-center justify-between font-mono text-[10px] text-mute">
          <span>{status}</span>
          {source === 'generate' && dataset && (
            <button
              onClick={regenerate}
              disabled={disabled}
              className="text-accent hover:underline tracking-[0.14em] uppercase disabled:opacity-50"
            >
              ↻ re-roll
            </button>
          )}
        </div>
        {error && (
          <div className="font-mono text-[10px] text-err break-all">{error}</div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />
      </div>
    </Panel>
  )
}
