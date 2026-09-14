# GhostGraph — indexer BeeworkEscrow

Definisi indexer hosted di [GhostGraph](https://ghostlogs.xyz) untuk kontrak eskrow.
Backend Beework tetap punya indexer RPC sendiri; Ghost dipakai sebagai **sumber kedua**
(backfill/rekonsiliasi kalau RPC publik bermasalah) dan sebagai GraphQL siap pakai
untuk frontend.

## Pasang

1. Daftar di GhostGraph → *Create a new GhostGraph* → network **Monad Testnet**.
2. Tempel `events.sol` dan `schema.sol`, klik *generate code*.
3. Ganti `indexer.sol` hasil generate dengan isi `indexer.sol` di folder ini —
   pastikan konstanta `ESCROW` = alamat kontrak Anda; start block = blok deploy.
4. *Compile* → *Deploy*. Dashboard memberi **GraphQL endpoint** dan **API key**.
5. Di server, isi `GHOST_GRAPHQL_URL` dan `GHOST_API_KEY`, restart. Job berulang
   `evm.ghost-reconcile` mulai menarik event tiap menit dan memasukkan yang belum
   ada ke `webhook_events` — jalur pemrosesan yang sama dengan indexer RPC, jadi
   tidak ada duplikasi (kunci `txHash:logIndex`).

## Query contoh (GraphQL, gaya Ponder)

```graphql
query WalletActivity($wallet: String!) {
  escrowEvents(
    where: { OR: [{ creator: $wallet }, { winner: $wallet }, { account: $wallet }] }
    orderBy: "block", orderDirection: "desc", limit: 50
  ) { items { kind bountyId amount fee asset transactionHash block timestamp } }
}
```
