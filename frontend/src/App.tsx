import { useState, useCallback } from 'react'
import { useWallet, usePortaldotConfig } from './wallet'
import type { DatasetMeta, DatasetSource } from './types'
import { CHUNK_SIZE } from './constants'
import { useBenchmark, useRunMachine, useWalletSubmit } from './hooks'
import { Header } from './components/Header'
import { Pipeline } from './components/Pipeline'
import { Dataset, DatasetSourcePanel } from './components/Dataset'
import { Metrics } from './components/Metrics'
import { Terminal } from './components/Terminal'
import { StatusStrip } from './components/StatusStrip'
import { Verification } from './components/Verification'

export default function App() {
  const benchmark = useBenchmark(3000)
  const { runId, phase, running, chunkProgress, lines, run, hasRun } = useRunMachine()
  const { state: wallet, connect } = useWallet()
  const portaldot   = usePortaldotConfig()
  const walletSubmit = useWalletSubmit(benchmark, wallet, portaldot)
  const [datasetSource, setDatasetSource] = useState<DatasetSource>('demo')
  const [customDataset, setCustomDataset] = useState<DatasetMeta | null>(null)

  const runWithMaybeWallet = useCallback(() => {
    if (wallet.status !== 'connected' || !wallet.account) return
    if (datasetSource !== 'demo' && !customDataset) return
    run({ walletSubmit: true, dataset: customDataset })
  }, [run, wallet.status, wallet.account, datasetSource, customDataset])

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

        <DatasetSourcePanel
          source={datasetSource}
          onSourceChange={setDatasetSource}
          dataset={customDataset}
          onDataset={setCustomDataset}
          disabled={running}
        />
        <StatusStrip phase={phase} chunkProgress={chunkProgress} />
        <Pipeline phase={phase} chunkProgress={chunkProgress} running={running} contract={benchmark?.on_chain?.contract || portaldot?.contract} rpc={portaldot?.ws} />
        {(customDataset || (hasRun && benchmark?.dataset)) && (
          <Dataset
            dataset={(customDataset ?? benchmark!.dataset)!}
            chunkSize={benchmark?.chunk_size ?? CHUNK_SIZE}
            preview={Boolean(customDataset)}
          />
        )}
        <Metrics phase={phase} benchmark={benchmark} />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          <div className="lg:col-span-3">
            <Terminal lines={lines} running={running} />
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
