import { ApiPromise, WsProvider } from '@polkadot/api'
const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:9944') })
console.log('chain:', (await api.rpc.system.chain()).toString())
console.log('version:', (await api.rpc.system.version()).toString())
console.log('metadata version:', api.runtimeMetadata.version)
const txMods = Object.keys(api.tx)
console.log('has contracts pallet:', txMods.includes('contracts'))
console.log('has revive pallet:', txMods.includes('revive'))
if (txMods.includes('contracts')) {
  console.log('contracts extrinsics:', Object.keys(api.tx.contracts))
}
console.log('all pallets:', txMods.join(', '))
await api.disconnect()
