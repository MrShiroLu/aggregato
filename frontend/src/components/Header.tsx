import { cx } from '../util'
import { shortAddr, type WalletState } from '../wallet'
import { Dot } from './common'

export function Header({ running, runId, onRun, wallet, onConnect }: {
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
