import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'

type Phase = 'idle' | 'refine' | 'accumulate' | 'ontransfer' | 'done'
type LogEntry = { i: number; ts: number; text: string }

let orchProc: ReturnType<typeof spawn> | null = null
let logBuffer: LogEntry[] = []
let lineCount = 0
let runId = 0
let currentPhase: Phase = 'idle'
let inParallelPhase = false
const CHUNK_COUNT = 8
let chunkProgress: number[] = Array(CHUNK_COUNT).fill(0)

function resetRunState() {
  logBuffer = []
  lineCount = 0
  currentPhase = 'idle'
  inParallelPhase = false
  chunkProgress = Array(CHUNK_COUNT).fill(0)
  runId += 1
}

function pushLine(raw: string) {
  const text = raw.replace(/\r/g, '').replace(/\x1b\[[0-9;]*m/g, '')
  if (!text.trim()) return

  if (text.includes('[3/5]')) { currentPhase = 'refine'; inParallelPhase = true }
  else if (text.includes('[4/5]')) { currentPhase = 'accumulate'; inParallelPhase = false }
  else if (text.includes('[5/5]')) { currentPhase = 'ontransfer'; inParallelPhase = false }
  else if (text.includes('AGGREGATO RESULTS')) { currentPhase = 'done' }
  else if (text.includes('[2/5]') || text.includes('[1/5]') || text.includes('[0/5]')) {
    if (currentPhase === 'idle') currentPhase = 'refine'
  }

  if (inParallelPhase) {
    const m = text.match(/\[chunk (\d+)\]/)
    if (m) {
      const idx = parseInt(m[1], 10)
      if (idx >= 0 && idx < chunkProgress.length) chunkProgress[idx] = 1
    }
  }

  logBuffer.push({ i: lineCount++, ts: Date.now(), text })
  if (logBuffer.length > 1000) {
    logBuffer = logBuffer.slice(-800)
  }
}

function captureStream(stream: NodeJS.ReadableStream) {
  let leftover = ''
  stream.on('data', (chunk: Buffer) => {
    const s = leftover + chunk.toString('utf8')
    const parts = s.split('\n')
    leftover = parts.pop() ?? ''
    for (const p of parts) pushLine(p)
  })
  stream.on('end', () => { if (leftover) { pushLine(leftover); leftover = '' } })
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'benchmark-api',
      configureServer(server) {
        server.middlewares.use('/api/benchmark', (_req, res) => {
          const filePath = resolve(__dirname, '../benchmark_latest.json')
          try {
            const data = fs.readFileSync(filePath, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(data)
          } catch {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'benchmark_latest.json not found' }))
          }
        })

        server.middlewares.use('/api/run/logs', (req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-cache')
          const url = new URL(req.url ?? '', 'http://x')
          const since = parseInt(url.searchParams.get('since') ?? '0', 10) || 0
          const lines = logBuffer.filter(l => l.i >= since)
          res.end(JSON.stringify({ lines, next: lineCount, runId, phase: currentPhase }))
        })

        server.middlewares.use('/api/contract-metadata', (_req, res) => {
          const filePath = resolve(
            __dirname,
            '../contracts/aggregato_verifier/target/ink/aggregato_verifier.contract',
          )
          try {
            const data = fs.readFileSync(filePath, 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.setHeader('Cache-Control', 'no-cache')
            res.end(data)
          } catch {
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'contract metadata not built' }))
          }
        })

        server.middlewares.use('/api/portaldot-config', (_req, res) => {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(JSON.stringify({
            ws: process.env.PORTALDOT_WS ?? 'ws://127.0.0.1:9944',
            contract: process.env.CONTRACT_ADDRESS ?? '',
            explorer: process.env.PORTALDOT_EXPLORER ?? '',
          }))
        })

        server.middlewares.use('/api/run', (req, res) => {
          res.setHeader('Content-Type', 'application/json')

          if (req.method === 'GET') {
            res.end(JSON.stringify({
              running: orchProc !== null,
              phase: currentPhase,
              runId,
              chunkProgress,
            }))
            return
          }

          if (req.method !== 'POST') {
            res.statusCode = 405
            res.end('{}')
            return
          }

          if (orchProc) {
            res.end(JSON.stringify({ ok: false, error: 'already running' }))
            return
          }

          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            let num_chunks = 8
            let walletSubmit = false
            let dataset: string | undefined
            let tempDataset: string | undefined
            let datasetLabel: string | undefined
            try {
              const parsed = JSON.parse(body)
              num_chunks = parsed.num_chunks ?? 8
              walletSubmit = Boolean(parsed.wallet_submit)
              if (typeof parsed.dataset === 'string' && parsed.dataset.length > 0) {
                dataset = parsed.dataset
              }
              if (parsed.dataset_inline && typeof parsed.dataset_inline === 'object') {
                const tmpPath = resolve(os.tmpdir(), `aggregato_run_${Date.now()}_${runId + 1}.json`)
                fs.writeFileSync(tmpPath, JSON.stringify(parsed.dataset_inline))
                dataset = tmpPath
                tempDataset = tmpPath
                datasetLabel = parsed.dataset_inline.name
                  ? `inline:${parsed.dataset_inline.name}`
                  : 'inline'
              }
            } catch { /* invalid JSON */ }

            // Auto-pick the matching demo dataset when the client doesn't
            // specify one, so the dashboard shows real-looking tx metadata
            // instead of plain 1..N preimages.
            if (!dataset) {
              const total = num_chunks * 8
              const candidate = resolve(__dirname, `../demo_data/txs_${total}.json`)
              if (fs.existsSync(candidate)) dataset = candidate
            }

            resetRunState()
            const labelForLog = datasetLabel ?? (dataset ? dataset.split('/').pop() : undefined)
            pushLine(`[orchestrator] starting run #${runId} (num_chunks=${num_chunks}${walletSubmit ? ', wallet_submit=true' : ''}${labelForLog ? `, dataset=${labelForLog}` : ''})`)

            const childEnv: NodeJS.ProcessEnv = { ...process.env }
            if (walletSubmit) childEnv.SKIP_ONCHAIN = '1'

            const args = ['run', '--', String(num_chunks)]
            if (dataset) args.push('--dataset', dataset)
            const proc = spawn('cargo', args, {
              cwd: resolve(__dirname, '../orchestrator'),
              env: childEnv,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            orchProc = proc
            if (proc.stdout) captureStream(proc.stdout)
            if (proc.stderr) captureStream(proc.stderr)
            proc.on('close', (code) => {
              pushLine(`[orchestrator] exit ${code ?? 0}`)
              currentPhase = 'done'
              for (let i = 0; i < chunkProgress.length; i++) chunkProgress[i] = 1
              orchProc = null
              if (tempDataset) {
                fs.unlink(tempDataset, () => {})
              }
            })
            res.end(JSON.stringify({ ok: true, runId }))
          })
        })
      },
    },
  ],
  server: { port: 3000 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        run:  resolve(__dirname, 'run.html'),
      },
    },
  },
})
