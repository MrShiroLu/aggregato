// Direct-API contract deployer.
//
// We hit `contracts.instantiateWithCode` straight via @polkadot/api so we
// bypass cargo-contract entirely. Useful when the target runtime ships old
// metadata that cargo-contract 4/5 reject — the JSON-RPC layer in
// @polkadot/api still talks fine to legacy chains.
//
// Wire shape (legacy pallet-contracts):
//   contracts.instantiateWithCode(endowment, gasLimit, code, data, salt)
// where `data` = selector(4 bytes) ++ scale(constructor_args). We use Abi
// from @polkadot/api-contract just to look up the selector.
//
// Usage (from aggregato/ repo root):
//   node frontend/scripts/deploy_contract.mjs \
//     --ws ws://127.0.0.1:9944 \
//     --suri //Alice \
//     --constructor new \
//     --arg 0x189dac29296d31814dc8c56cf3d36a0543372bba7538fa322a4aebfebc39e056
//
// Default --bundle path resolves relative to the script, not cwd, so this
// works from any directory.

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api'
import { Abi } from '@polkadot/api-contract'
import { cryptoWaitReady } from '@polkadot/util-crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/ lives at frontend/scripts → repo root is two levels up.
const DEFAULT_BUNDLE = resolve(__dirname, '../../contracts/aggregato_verifier/target/ink/aggregato_verifier.contract')

function parseArgs(argv) {
  const out = Object.create(null)
  out.args = []
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--ws') out.ws = argv[++i]
    else if (k === '--suri') out.suri = argv[++i]
    else if (k === '--bundle') out.bundle = argv[++i]
    else if (k === '--constructor') out.ctorName = argv[++i]
    else if (k === '--arg') out.args.push(argv[++i])
    else if (k === '--endowment') out.endowment = argv[++i]
    else if (k === '--gas') out.gas = argv[++i]
  }
  return out
}

const opts = parseArgs(process.argv)
const ws = opts.ws ?? 'ws://127.0.0.1:9944'
const suri = opts.suri ?? '//Alice'
const bundlePath = opts.bundle ? resolve(opts.bundle) : DEFAULT_BUNDLE
const ctorName = opts.ctorName ?? 'new'
const endowment = BigInt(opts.endowment ?? '1000000000000') // 1 unit
const gas = BigInt(opts.gas ?? '500000000000')

console.log(`[deploy] ws=${ws}`)
console.log(`[deploy] bundle=${bundlePath}`)
console.log(`[deploy] constructor=${ctorName} args=${JSON.stringify(opts.args)}`)

const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'))
const wasm = bundle.source?.wasm
if (!wasm || !wasm.startsWith('0x')) {
  throw new Error('bundle missing source.wasm hex')
}

await cryptoWaitReady()
const provider = new WsProvider(ws)
const api = await ApiPromise.create({ provider })
const chain = (await api.rpc.system.chain()).toString()
const rv = api.runtimeVersion.toJSON()
console.log(`[deploy] chain=${chain} spec=${rv.specName}-${rv.specVersion} metadata=v${api.runtimeMetadata.version}`)

// Build selector + scale-encoded ctor args via @polkadot/api-contract's Abi.
const abi = new Abi(bundle, api.registry.getChainProperties())
const ctor = abi.findConstructor(ctorName)
const encoded = ctor.toU8a(opts.args)
console.log(`[deploy] data length = ${encoded.length} bytes (selector + ctor args)`)

const keyring = new Keyring({ type: 'sr25519' })
const signer = keyring.addFromUri(suri)
console.log(`[deploy] signer=${signer.address}`)

// Legacy signature: (endowment, gasLimit, code, data, salt)
const salt = new Uint8Array(0)
const tx = api.tx.contracts.instantiateWithCode(endowment, gas, wasm, encoded, salt)

await new Promise((resolveP, rejectP) => {
  tx.signAndSend(signer, (result) => {
    if (result.status.isReady) {
      console.log('[deploy] broadcasting tx', result.txHash.toHex())
    } else if (result.status.isInBlock) {
      console.log('[deploy] in block', result.status.asInBlock.toHex())
    } else if (result.status.isFinalized) {
      const failed = result.events.find(({ event }) => api.events.system.ExtrinsicFailed.is(event))
      if (failed) {
        const [dispatchError] = failed.event.data
        let reason = dispatchError.toString()
        if (dispatchError.isModule) {
          try {
            const meta = api.registry.findMetaError(dispatchError.asModule)
            reason = `${meta.section}.${meta.name}: ${meta.docs.join(' ')}`
          } catch (e) {
            reason = `module ${dispatchError.asModule.toString()}`
          }
        }
        console.log('events:', result.events.map(e => `${e.event.section}.${e.event.method}`).join(', '))
        rejectP(new Error(`ExtrinsicFailed: ${reason}`))
        return
      }
      const instantiated = result.events.find(({ event }) =>
        event.section === 'contracts' && (event.method === 'Instantiated' || event.method === 'NewContract'))
      if (instantiated) {
        const data = instantiated.event.data
        console.log('\n=== DEPLOYED ===')
        console.log(`event: contracts.${instantiated.event.method}`)
        console.log(`data: ${data.toString()}`)
      } else {
        console.log('[deploy] finalized but no contracts.Instantiated event found')
        console.log('events:', result.events.map(e => `${e.event.section}.${e.event.method}`).join(', '))
      }
      resolveP()
    } else if (result.isError) {
      rejectP(new Error('tx error'))
    }
  }).catch(rejectP)
})

await api.disconnect()
process.exit(0)
