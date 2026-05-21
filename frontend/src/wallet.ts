import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiPromise, WsProvider } from '@polkadot/api'
import { ContractPromise } from '@polkadot/api-contract'
import type { InjectedAccountWithMeta, InjectedExtension } from '@polkadot/extension-inject/types'

const APP_NAME = 'Aggregato'
const ENABLE_TIMEOUT_MS = 30_000

export interface WalletState {
  status: 'idle' | 'connecting' | 'connected' | 'no-extension' | 'error'
  account: InjectedAccountWithMeta | null
  accounts: InjectedAccountWithMeta[]
  error: string | null
}

export interface PortaldotConfig {
  ws: string
  contract: string
}

export interface SubmitArgs {
  root: string
  blockHash: string
  numChunks: number
  totalItems: number
  signature: string
}

/// POT-as-gas: service fee charged per aggregated chunk, in POT base units
/// (12 decimals). Must match FEE_PER_CHUNK in the ink! contract.
export const FEE_PER_CHUNK: bigint = 10_000_000_000n
export const POT_DECIMALS = 12

export function feeForChunks(numChunks: number): bigint {
  return FEE_PER_CHUNK * BigInt(numChunks)
}

export function formatPot(units: bigint, frac = 4): string {
  const base = 10n ** BigInt(POT_DECIMALS)
  const whole = units / base
  const rem = units % base
  const fracStr = rem.toString().padStart(POT_DECIMALS, '0').slice(0, frac).replace(/0+$/, '')
  return fracStr.length ? `${whole}.${fracStr}` : `${whole}`
}

export interface SubmitProgress {
  stage: 'idle' | 'connecting' | 'building' | 'signing' | 'broadcasting' | 'in-block' | 'finalized' | 'error'
  message: string
  txHash?: string
  blockHash?: string
  feePaid?: string
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    status: 'idle', account: null, accounts: [], error: null,
  })

  // Guards: prevent re-entry under StrictMode double-invoke; cancel stale runs.
  const inFlightRef    = useRef(false)
  const unsubscribeRef = useRef<(() => void) | null>(null)

  useEffect(() => () => {
    if (unsubscribeRef.current) { unsubscribeRef.current(); unsubscribeRef.current = null }
  }, [])

  const connect = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setState(s => ({ ...s, status: 'connecting', error: null }))

    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const dapp = await import('@polkadot/extension-dapp')
      const { web3Enable, web3AccountsSubscribe } = dapp

      // Polkadot.js extension can take a moment to resolve the popup; fall back
      // to a clear error if the user never acts on it.
      const enable = web3Enable(APP_NAME)
      const exts: InjectedExtension[] = await Promise.race<InjectedExtension[]>([
        enable as Promise<InjectedExtension[]>,
        new Promise<InjectedExtension[]>((_, rej) => {
          timer = setTimeout(() => rej(new Error('extension authorization timed out — open the wallet popup and click Allow')), ENABLE_TIMEOUT_MS)
        }),
      ])
      if (timer) { clearTimeout(timer); timer = null }

      if (!exts || exts.length === 0) {
        setState({ status: 'no-extension', account: null, accounts: [], error: null })
        return
      }

      // Accounts may arrive asynchronously after web3Enable resolves — subscribe
      // instead of calling web3Accounts() once, otherwise the very first batch
      // can come back empty on slower extensions.
      const unsub = await web3AccountsSubscribe((accounts) => {
        if (!accounts || accounts.length === 0) {
          setState(prev => prev.status === 'connected'
            ? { status: 'error', account: null, accounts: [], error: 'All accounts removed from extension.' }
            : { status: 'error', account: null, accounts: [], error: 'No accounts in extension. Create one in Polkadot.js / Talisman / SubWallet.' })
          return
        }
        setState(prev => ({
          status:  'connected',
          // keep current selection if it still exists in the new list
          account: accounts.find(a => a.address === prev.account?.address) ?? accounts[0],
          accounts,
          error:   null,
        }))
      })
      if (unsubscribeRef.current) unsubscribeRef.current()
      unsubscribeRef.current = unsub
    } catch (e) {
      setState({
        status: 'error', account: null, accounts: [],
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      if (timer) clearTimeout(timer)
      inFlightRef.current = false
    }
  }, [])

  return { state, connect }
}

// ─── Portaldot config loader ─────────────────────────────────────────────────

export function usePortaldotConfig() {
  const [cfg, setCfg] = useState<PortaldotConfig | null>(null)
  useEffect(() => {
    fetch('/api/portaldot-config')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j) setCfg(j) })
      .catch(() => { /* ignore */ })
  }, [])
  return cfg
}

// ─── Contract submit ─────────────────────────────────────────────────────────

let cachedApi: { ws: string; api: ApiPromise } | null = null

async function getApi(ws: string): Promise<ApiPromise> {
  if (cachedApi && cachedApi.ws === ws) return cachedApi.api
  if (cachedApi) await cachedApi.api.disconnect().catch(() => {})
  const provider = new WsProvider(ws)
  const api = await ApiPromise.create({ provider })
  cachedApi = { ws, api }
  return api
}

export async function submitVerifiedRoot(
  cfg: PortaldotConfig,
  account: InjectedAccountWithMeta,
  args: SubmitArgs,
  onProgress: (p: SubmitProgress) => void,
): Promise<void> {
  if (!cfg.contract) throw new Error('CONTRACT_ADDRESS not configured on server')

  onProgress({ stage: 'connecting', message: `connecting to ${cfg.ws}` })
  const api = await getApi(cfg.ws)

  onProgress({ stage: 'building', message: 'loading contract metadata' })
  const metaRes = await fetch('/api/contract-metadata')
  if (!metaRes.ok) throw new Error('contract metadata not available — build with cargo contract build')
  const metadata = await metaRes.json()

  const contract = new ContractPromise(api, metadata, cfg.contract)

  // Generous gas limit — Substrate contracts node returns it as a Weight struct.
  const gasLimit = api.registry.createType('WeightV2', {
    refTime: 5_000_000_000,
    proofSize: 200_000,
  })
  const storageDepositLimit = null
  const fee = feeForChunks(args.numChunks)
  const feePotStr = `${formatPot(fee)} POT`

  onProgress({ stage: 'signing', message: `awaiting wallet signature — service fee ${feePotStr}`, feePaid: feePotStr })
  const { web3FromAddress } = await import('@polkadot/extension-dapp')
  const injector = await web3FromAddress(account.address)

  return new Promise<void>((resolveTx, rejectTx) => {
    contract.tx
      .submitVerifiedRoot(
        { gasLimit: gasLimit as unknown as undefined, storageDepositLimit, value: fee },
        args.root,
        args.blockHash,
        args.numChunks,
        args.totalItems,
        args.signature,
      )
      // Cast: extension-inject ships its own @polkadot/types; structurally identical
      // but TS sees two distinct Signer types.
      .signAndSend(account.address, { signer: injector.signer as never }, (result) => {
        if (result.status.isReady) {
          onProgress({ stage: 'broadcasting', message: 'broadcasting tx', txHash: result.txHash.toHex(), feePaid: feePotStr })
        } else if (result.status.isInBlock) {
          onProgress({
            stage: 'in-block',
            message: 'included in block',
            txHash: result.txHash.toHex(),
            blockHash: result.status.asInBlock.toHex(),
            feePaid: feePotStr,
          })
        } else if (result.status.isFinalized) {
          const failed = result.events.find(({ event }) =>
            api.events.system.ExtrinsicFailed.is(event),
          )
          if (failed) {
            rejectTx(new Error('extrinsic failed — likely InsufficientFee, InvalidSignature, or AlreadyVerified'))
            return
          }
          onProgress({
            stage: 'finalized',
            message: `finalized — ${feePotStr} paid, ProofVerified emitted`,
            txHash: result.txHash.toHex(),
            blockHash: result.status.asFinalized.toHex(),
            feePaid: feePotStr,
          })
          resolveTx()
        } else if (result.isError) {
          rejectTx(new Error('tx error'))
        }
      })
      .catch(rejectTx)
  })
}

export function shortAddr(a: string, n = 6): string {
  if (a.length <= 2 * n + 2) return a
  return `${a.slice(0, n)}…${a.slice(-n)}`
}
