# Integrasi Frontend — Beework API

Base URL produksi: `https://api.eac01.xyz/api/v1`
Swagger interaktif: `https://api.eac01.xyz/docs` · OpenAPI JSON: `/docs/json`

Semua request/response JSON. Nominal uang **selalu string base-unit** (USDC 6
desimal → `"1000000"` = 1 USDC; MON 18 desimal → `"10000000000000000"` = 0.01 MON).
Jangan pernah pakai `Number` untuk nominal — pakai `BigInt`, atau `parseUnits`/
`formatUnits` dari viem.

## 1. Bentuk respons & error

Sukses: body langsung objek/array. Daftar berpaginasi:

```json
{ "data": [...], "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3, "hasNext": true } }
```

Error selalu:

```json
{ "error": { "code": "FORBIDDEN", "message": "Only the task owner can approve", "details": {...} } }
```

| HTTP | code | Artinya |
|---|---|---|
| 400 | `BAD_REQUEST`, `CAPTCHA_REQUIRED` | input salah / captcha wajib |
| 401 | `UNAUTHORIZED` | token tidak ada/kedaluwarsa → refresh, lalu ulangi |
| 403 | `FORBIDDEN`, `CAPTCHA_FAILED` | tidak berhak / akun belum verified |
| 404 | `NOT_FOUND` | |
| 409 | `CONFLICT` | status tidak memungkinkan (sudah approve, sudah open, dsb.) |
| 422 | `VALIDATION_ERROR`, `UNPROCESSABLE_ENTITY`, `INSUFFICIENT_FUNDS` | `details` berisi rincian |
| 429 | `TOO_MANY_REQUESTS` | lihat header `Retry-After` (detik) |

Rate limit: tiap respons membawa `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset`. Tampilkan hitung mundur dari `Retry-After` saat 429.

## 2. Klien minimal

```ts
const BASE = 'https://api.eac01.xyz/api/v1'
let accessToken = ''   // umur 15 menit
let refreshToken = ''  // umur 30 hari, berotasi tiap dipakai

async function api<T>(path: string, init: RequestInit & { retry?: boolean } = {}): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  })
  if (res.status === 401 && init.retry !== false && refreshToken) {
    const r = await fetch(BASE + '/auth/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (r.ok) {
      ;({ accessToken, refreshToken } = await r.json())   // simpan keduanya — yang lama sudah dicabut
      return api(path, { ...init, retry: false })
    }
    accessToken = refreshToken = ''; throw new Error('SESSION_EXPIRED')
  }
  const json = await res.json().catch(() => null)
  if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? res.statusText), { status: res.status, code: json?.error?.code, details: json?.error?.details })
  return json as T
}
```

Simpan `refreshToken` di tempat yang tidak bisa dibaca skrip pihak ketiga (di
mobile: secure storage; di web: memori + `httpOnly` cookie lewat BFF kalau ada).
Refresh token **sekali pakai**: setelah `/auth/refresh` sukses, yang lama mati.

## 3. Masuk

### Username/password

```ts
// GET /auth/captcha → { enabled, provider, siteKey }; kalau enabled, render widget dan kirim tokennya
const { user, accessToken, refreshToken } = await api('/auth/register', {
  method: 'POST',
  body: JSON.stringify({ username, email, password, referralCode, captchaToken }),
})
// login: { identifier: username|email, password }
```

### Privy (email + embedded wallet)

```ts
import { usePrivy } from '@privy-io/react-auth'
const { getAccessToken } = usePrivy()
const token = await getAccessToken()               // aud = app id kita; BUKAN privy_access_token
const r = await api('/auth/privy', { method: 'POST', body: JSON.stringify({ token, referralCode }) })
// r.isNewUser, r.user (email & wallet Solana sudah tertaut & terverifikasi), r.accessToken, r.refreshToken
```

Token Privy hanya dipakai sekali di pintu masuk. Setelah itu semua request memakai
`accessToken` **Beework**.

`GET /auth/me` → profil lengkap; `POST /auth/logout { refreshToken }`.

## 4. Katalog & feed

```
GET /assets            token reward: { id, symbol, chain, decimals, mintAddress }
GET /categories        GET /tags
GET /tasks?q=&type=task|bounty|quest&categorySlug=&sort=newest|reward|deadline&page=&limit=
GET /tasks/:id         :id = publicId (pendek) atau uuid; task privat butuh ?token=
GET /users/:username   GET /users/leaderboard
```

Tampilkan reward dengan `formatUnits(BigInt(task.rewardAmount), task.asset.decimals)`.
`task.status`: `pending_deposit` (belum didanai, hanya owner yang lihat) → `open` →
`in_review` → `completed` | `cancelled` | `expired`.

## 5. Alur owner — aset ledger (USDC/SOL)

```ts
const created = await api('/tasks', { method: 'POST', body: JSON.stringify({
  type: 'task', title, description, categoryId,
  rewardAssetId: usdc.id, rewardAmount: parseUnits('25', 6).toString(),
  deadlineAt: iso, maxWinners: 1, requiresVerified: false,
}) })
// created.escrowMode === 'ledger', created.fee, created.totalRequired
await api(`/tasks/${created.task.publicId}/publish`, { method: 'POST' })
// → saldo owner dipotong totalRequired ke escrow; 422 INSUFFICIENT_FUNDS kalau kurang
```

Saldo: `GET /wallet/balances` → `[{ asset, balance, locked, balanceFormatted }]`.
Mutasi: `GET /wallet/transactions`. Penarikan: `POST /wallet/payouts { assetId, amount, destinationAddress }`
(butuh akun verified; status `pending` sampai worker on-chain memproses).

## 6. Alur owner — aset on-chain (MON / EVM)

Prasyarat: `GET /onchain/config` → `enabled: true`. Kalau `false`, sembunyikan aset EVM.

```ts
import { createWalletClient, custom, parseEther } from 'viem'

const cfg = await api('/onchain/config')          // chainId, contractAddress, reviewerAddress, nativeAsset
const abi = await api('/onchain/abi')

// 1. buat task — WAJIB deadlineAt, maks 365 hari
const created = await api('/tasks', { method: 'POST', body: JSON.stringify({
  type: 'task', title, description,
  rewardAssetId: mon.id, rewardAmount: parseEther('0.5').toString(), deadlineAt: iso,
}) })
// created.escrowMode === 'onchain'; created.onchain.fundArgs & created.onchain.deposit

// 2. owner memanggil fund() dari wallet-nya (MetaMask / Privy EVM)
const fa = created.onchain.fundArgs
const txHash = await walletClient.writeContract({
  address: cfg.contractAddress, abi, functionName: 'fund',
  args: [fa.taskId, fa.reviewer, fa.asset, BigInt(fa.budget), BigInt(fa.deadline), fa.maxWinners],
  value: BigInt(created.onchain.deposit),          // native: msg.value = budget + fee 5%
})
await publicClient.waitForTransactionReceipt({ hash: txHash })

// 3. serahkan txHash — backend memverifikasi event BountyFunded lalu menayangkan
await api(`/tasks/${created.task.publicId}/publish`, { method: 'POST', body: JSON.stringify({ txHash }) })
```

`publish` idempoten: kalau indexer sudah lebih dulu mencatat tx yang sama, tetap `200`.
Untuk ERC-20 (bukan native): `approve(contractAddress, deposit)` dulu, lalu `fund()`
dengan `value: 0n`.

Pantau: `GET /onchain/tasks/:id` → `{ db, onchain }` (DB vs kontrak berdampingan).

## 7. Alur worker

```
POST /tasks/:id/submissions   { content, links[], githubPrUrl }   → 201 (409 setelah deadline)
PATCH /submissions/:id        revisi
GET  /submissions/mine
```

**Sebelum bisa menang task on-chain**, worker harus menautkan wallet EVM
terverifikasi (bagian 9). Tanpa itu owner mendapat `422` saat approve.

## 8. Review oleh owner

```
GET  /tasks/:id/submissions
POST /submissions/:id/review   { status: 'needs_revision' | 'rejected', note }
POST /submissions/:id/approve  { payoutAmount? }   ← memindahkan uang
```

Ledger: saldo worker langsung bertambah. On-chain: respons berisi
`onchain.txHash` — backend memanggil `award()`; worker menariknya lewat bagian 10.

## 9. Menautkan wallet (bukti kepemilikan)

```ts
// EVM
const ch = await api('/users/me/wallets/challenge', { method: 'POST', body: JSON.stringify({ chain: 'monad', address }) })
const signature = await walletClient.signMessage({ account: address, message: ch.message })   // EIP-191
await api('/users/me/wallets', { method: 'POST', body: JSON.stringify({ chain: 'monad', address, nonce: ch.nonce, signature, isPrimary: true }) })

// Solana (wallet-adapter)
const ch = await api('/users/me/wallets/challenge', { method: 'POST', body: JSON.stringify({ chain: 'solana', address: publicKey.toBase58() }) })
const sig = await signMessage(new TextEncoder().encode(ch.message))
await api('/users/me/wallets', { method: 'POST', body: JSON.stringify({ chain: 'solana', address: publicKey.toBase58(), nonce: ch.nonce, signature: bs58.encode(sig) }) })
```

Nonce berlaku 10 menit, sekali pakai. Wallet dari login Privy sudah otomatis
terverifikasi. `GET /users/me/wallets`, `DELETE /users/me/wallets/:id`.

## 10. Menarik dana on-chain (worker / owner refund)

```ts
const claim = await api('/onchain/claimable')       // per wallet & aset milik user
await walletClient.writeContract({ address: cfg.contractAddress, abi, functionName: 'withdraw', args: [asset, recipient] })
```

Owner yang task-nya kedaluwarsa: `refund(bountyId)` setelah `refundAt`
(`GET /onchain/tasks/:id` → `db.bountyId`, `db.refundAt`), lalu `withdraw()`.

## 10b. Riwayat on-chain di halaman wallet

```
GET /wallet/onchain-activity?page=&limit=   → { data: [...], meta }
GET /wallet/onchain-summary                 → [{ asset, lockedIntoEscrow, withdrawnToWallet }]
GET /wallet/addresses                       → [..., explorerAddressUrl]
```

Tiap baris `data`:

```json
{ "type": "fund|award|refund|withdraw", "direction": "in|out", "wallet": "0x…",
  "amount": "1050000000000000000", "amountFormatted": "1.05", "asset": { "symbol": "MON", "decimals": 18 },
  "txHash": "0x…", "explorerUrl": "https://testnet.monadexplorer.com/tx/0x…",
  "blockNumber": 61710000, "at": "2026-09-12T…", "task": { "publicId": "…", "title": "…" } | null, "note": "…" }
```

Sumbernya event kontrak yang diindeks — muncul beberapa detik setelah tx terkonfirmasi.
`withdraw` tidak punya `task` (penarikan per aset). Transfer MON biasa di luar kontrak
tidak tercakup; tautkan `explorerAddressUrl` untuk itu.

## 11. Lain-lain

```
GET  /notifications?unreadOnly=true   GET /notifications/unread-count   POST /notifications/read { ids? }
GET  /referrals/me  → { code, link, sharePercent, stats }
GET  /health
```

## 12. Ringkas: yang harus FE simpan

| Apa | Dari mana | Umur |
|---|---|---|
| `accessToken` | login / privy / refresh | 15 menit |
| `refreshToken` | login / privy / refresh | 30 hari, sekali pakai |
| `onchain.fundArgs` + `deposit` | `POST /tasks` | sampai `fund()` dipanggil |
| `txHash` dari `fund()` | wallet | sampai `publish` dipanggil |
