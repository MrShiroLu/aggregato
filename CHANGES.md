# Son Değişiklikler — Demo Veri Seti Entegrasyonu

Demo sırasında "1..N" yerine gerçekçi görünen rollup tx batch verisi besleyebilmek için yapılan değişiklikler.

## Yeni dosyalar

- `demo_data/txs_16.json`, `demo_data/txs_32.json`, `demo_data/txs_64.json`
  - Substrate dev hesapları (Alice/Bob/Charlie/Dave/Eve/Ferdie/Ivy/Mallory) arasında deterministik sentetik L2 tx batch'leri.
  - Her item: `from`, `from_name`, `to`, `to_name`, `amount` (µDOT), `nonce`, `preimage` (u64 decimal string).
  - `preimage = FNV-1a(from|to|amount|nonce) & 0x7fff_ffff_ffff_ffff` — circuit'in `pedersen_hash([preimage])` çağrısına direkt giriyor.
- `orchestrator/src/bin/gen_dataset.rs`
  - `cargo run --bin gen_dataset -- --size N --out path.json [--name foo]`
  - `--size` 8'in pozitif katı olmalı.

## Orchestrator

- `--dataset path.json` flag'i eklendi (`orchestrator/src/main.rs`).
  - Argüman sırası serbest: `cargo run -- 4 --dataset demo_data/txs_32.json` veya `cargo run -- --dataset … 4`.
  - Item sayısı `num_chunks * 8` değilse hata.
  - Flag yoksa eski davranış: `1..=N` preimage dizisi.
- `Dataset` JSON tüm haliyle `benchmark_latest.json`'ın `dataset` alanına gömülüyor (dashboard tüketsin diye).

## Demo script

- `demo.sh` ikinci argüman olarak dataset yolu kabul ediyor:
  ```
  ./demo.sh 4 demo_data/txs_32.json
  ```
  Verilen yol göreceliyse repo root'una göre çözümleniyor.

## Dashboard

- `frontend/src/App.tsx`
  - `BenchmarkData`'ya `dataset?: DatasetMeta` alanı eklendi.
  - Yeni **Dataset** paneli (Pipeline ↔ Metrics arasında, kicker `02`): her chunk için kart, her satır `Alice → Bob · 1.25 DOT · n0` formatında.
  - Mevcut paneller renumber: Metrics `03`, Terminal `04`, Verification `05`.
- `frontend/vite.config.ts`
  - "▶ run benchmark" butonu `num_chunks * 8` ile eşleşen `demo_data/txs_<total>.json` varsa otomatik `--dataset` olarak geçiriyor.
  - POST body'sinde `dataset: string` alanı destekleniyor (client override için).

## Doğrulama

- `cargo build --bin orchestrator` ve `cargo build --bin gen_dataset` temiz derleniyor.
- `npx tsc --noEmit` (frontend) temiz.
- Hata yolları kontrol edildi:
  - Var olmayan dosya → `Error: read dataset …`
  - Item sayısı uyumsuzluğu → `Error: dataset … has 16 items but num_chunks=4 expects 32`
  - 2'nin kuvveti olmayan `num_chunks` → `Error: num_chunks must be a power of 2 …`
  - Tanınmayan argüman → `Error: unknown arg: …`

## Kullanım özeti

```bash
# Demo akışı, dataset ile:
./demo.sh 4 demo_data/txs_32.json

# Doğrudan orchestrator:
cargo run --bin orchestrator -- 8 --dataset ../demo_data/txs_64.json

# Yeni dataset üret:
cargo run --bin gen_dataset -- --size 32 --out ../demo_data/my_set.json
```
