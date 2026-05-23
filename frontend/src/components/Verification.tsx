import { useState } from 'react'
import { cx, short } from '../util'
import {
  shortAddr, feeForChunks, formatPot, explorerExtrinsicUrl, explorerBlockUrl,
  type WalletState, type PortaldotConfig,
} from '../wallet'
import type { Phase, BenchmarkData, WalletSubmitState } from '../types'
import { Panel, Dot } from './common'

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

export function Verification({ phase, benchmark, wallet, portaldot, walletSubmit }: {
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
            <Field
              k="service fee"
              v={benchmark ? `${formatPot(feeForChunks(benchmark.num_chunks))} POT` : '—'}
              good={verified}
            />
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
        {benchmark && (
          <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em] uppercase">
            <span className="text-mute2">pot-as-gas · service fee</span>
            <span className="text-accent">
              {formatPot(feeForChunks(benchmark.num_chunks))} POT
              <span className="text-mute2 ml-2 normal-case tracking-normal">
                ({formatPot(feeForChunks(1))} × {benchmark.num_chunks} chunks)
              </span>
            </span>
          </div>
        )}
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
        {state.progress.feePaid && (stage === 'in-block' || stage === 'finalized') && (
          <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.14em] uppercase">
            <span className="text-mute2">fee paid on-chain</span>
            <span className="text-ok">{state.progress.feePaid}</span>
          </div>
        )}
        {state.progress.txHash && (
          <div className="font-mono text-[10px] text-mute break-all flex items-baseline gap-2">
            <span className="text-mute2 shrink-0">tx</span>
            <span className="flex-1 break-all">{state.progress.txHash}</span>
            {portaldot && (
              <a
                href={explorerExtrinsicUrl(portaldot, state.progress.txHash, state.progress.blockHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline tracking-[0.14em] uppercase shrink-0"
              >
                view ↗
              </a>
            )}
          </div>
        )}
        {state.progress.blockHash && (
          <div className="font-mono text-[10px] text-mute break-all flex items-baseline gap-2">
            <span className="text-mute2 shrink-0">blk</span>
            <span className="flex-1 break-all">{state.progress.blockHash}</span>
            {portaldot && (
              <a
                href={explorerBlockUrl(portaldot, state.progress.blockHash)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent hover:underline tracking-[0.14em] uppercase shrink-0"
              >
                view ↗
              </a>
            )}
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
