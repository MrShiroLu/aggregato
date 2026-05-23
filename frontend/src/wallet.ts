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
  /// Subscan-style explorer base URL (no trailing slash), e.g. https://shibuya.subscan.io.
  /// Optional — when empty the UI falls back to a Polkadot.js Apps link built from `ws`.
  explorer?: string
}

export function explorerExtrinsicUrl(cfg: PortaldotConfig, txHash: string, blockHash?: string): string {
  if (cfg.explorer) return `${cfg.explorer.replace(/\/$/, '')}/extrinsic/${txHash}`
  // Polkadot.js Apps' explorer/query route only resolves block hashes, not extrinsic hashes.
  // Link to the including block (its detail view lists the extrinsic) when we know it.
  const hash = blockHash ?? txHash
  return `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(cfg.ws)}#/explorer/query/${hash}`
}

export function explorerBlockUrl(cfg: PortaldotConfig, blockHash: string): string {
  if (cfg.explorer) return `${cfg.explorer.replace(/\/$/, '')}/block/${blockHash}`
  return `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(cfg.ws)}#/explorer/query/${blockHash}`
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

/// @polkadot/api-contract auto-decodes any `0x`-prefixed string passed for a
/// `String`-typed argument into raw bytes, which corrupts the SCALE-encoded
/// String the contract actually receives. Strip the prefix so the contract
/// sees the literal 64/128-char hex text its `parse_hex_root` expects.
export function stripHexPrefix(h: string): string {
  return h.startsWith('0x') ? h.slice(2) : h
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

/// Maps an ink! contract `Error` variant name to an actionable hint.
function contractErrorHint(variant: string): string {
  switch (variant) {
    case 'AlreadyVerified':   return 'this aggregated root was already submitted — pick "Generate" in the dataset picker and re-run to get a fresh root'
    case 'InsufficientFee':   return 'transferred value is below the per-chunk service fee'
    case 'InvalidSignature':  return 'signature/pubkey mismatch — the prover key the contract was deployed with does not match the signer'
    case 'InvalidRootFormat': return 'root or block hash is not valid 64-char hex'
    case 'NotOwner':          return 'caller is not the contract owner'
    case 'TransferFailed':    return 'fee transfer to the owner failed'
    default:                  return 'see the contract Error enum'
  }
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

  // Strip `0x` so the contract sees the literal hex text its `parse_hex_root`
  // expects (see stripHexPrefix for the full SCALE-encoding rationale).
  const callArgs = [
    stripHexPrefix(args.root),
    stripHexPrefix(args.blockHash),
    args.numChunks,
    args.totalItems,
    stripHexPrefix(args.signature),
  ] as const
  const callOpts = { gasLimit: gasLimit as unknown as undefined, storageDepositLimit, value: fee }

  // Pre-flight via a dry-run query so we surface the exact contract Error
  // variant (AlreadyVerified, InsufficientFee, …) before the user signs and
  // pays gas. Without this the only signal is a generic ExtrinsicFailed event
  // at finalization, which can't distinguish the cause.
  onProgress({ stage: 'building', message: 'simulating submission', feePaid: feePotStr })
  const dry = await contract.query.submitVerifiedRoot(account.address, callOpts, ...callArgs)
  if (dry.result.isErr) {
    throw new Error(`dry-run reverted: ${dry.result.asErr.toString()}`)
  }
  // ink! wraps the message return as Result<Result<(), Error>, LangError>.
  // toJSON() casing varies by metadata, so probe both Ok/ok and Err/err.
  const j = dry.output?.toJSON() as { ok?: unknown; Ok?: unknown } | null
  const inner = (j?.ok ?? j?.Ok ?? j) as { err?: string; Err?: string } | null
  const errVariant = inner?.err ?? inner?.Err
  if (errVariant) {
    throw new Error(`${errVariant} — ${contractErrorHint(errVariant)}`)
  }

  return new Promise<void>((resolveTx, rejectTx) => {
    contract.tx
      .submitVerifiedRoot(callOpts, ...callArgs)
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
            // The dry-run above already filters known contract reverts, so a
            // failure here is something that only shows up on-chain (state
            // changed between dry-run and inclusion, or a dispatch-level error).
            rejectTx(new Error('extrinsic failed on-chain after a clean dry-run — root may have been submitted by another tx in between'))
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
