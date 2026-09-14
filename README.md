# Beework

Backend marketplace task & bounty — kloning internal dari [gib.work](https://gib.work).
Bun + ElysiaJS + PostgreSQL + Drizzle ORM.

Analisis produk dan peta kebutuhan backend ada di
[`docs/BACKEND-ANALYSIS.md`](docs/BACKEND-ANALYSIS.md); panduan integrasi frontend di
[`docs/FRONTEND-INTEGRATION.md`](docs/FRONTEND-INTEGRATION.md).

## Stack

| Bagian | Pilihan | Alasan |
|---|---|---|
| Runtime | Bun 1.2 | diminta |
| HTTP | ElysiaJS 1.4 | diminta; validasi TypeBox + Swagger otomatis |
| Database | PostgreSQL 17 | butuh transaksi & `numeric` untuk ledger |
| ORM | Drizzle | SQL-first, migrasi ter-generate, ringan di Bun |
| Auth | JWT access + refresh token berotasi | mobile app hidup lama |

## Menjalankan

```bash
bun install
```

```bash
cp .env.example .env
```

Isi password PostgreSQL lokal di `DATABASE_URL` pada `.env`, lalu buat databasenya:

```bash
createdb -U postgres beework
```

```bash
bun run db:migrate && bun run db:seed
```

```bash
bun run dev
```

- API: <http://localhost:3000/api/v1>
- Swagger: <http://localhost:3000/docs>
- Health: <http://localhost:3000/health>

Seed mengisi 3 token (USDC, SOL, WORK), 7 kategori, dan tag. Akun admin hanya
dibuat kalau `ADMIN_PASSWORD` diisi — tidak ada kredensial default:

```bash
ADMIN_PASSWORD='passwordAnda' bun run db:seed
```

Aplikasi hanya mendengarkan `127.0.0.1` secara default. Untuk diakses dari luar,
taruh reverse proxy di depannya, jangan ubah `HOST` ke `0.0.0.0`.

## Perintah

| Perintah | Fungsi |
|---|---|
| `bun run dev` | server dengan hot reload |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:generate` | buat file migrasi dari perubahan skema |
| `bun run db:migrate` | jalankan migrasi |
| `bun run db:push` | dorong skema langsung (khusus development) |
| `bun run db:studio` | Drizzle Studio |
| `bun run db:seed` | data awal |

## Struktur

```
src/
├── app.ts                 rakit semua plugin & route
├── index.ts               entry point + graceful shutdown
├── config/env.ts          env tervalidasi
├── common/                errors, money (BigInt), ids, pagination
├── db/
│   ├── schema/            42 tabel: identity, catalog, work, ledger, growth, system
│   ├── migrate.ts
│   └── seed.ts
├── plugins/               auth (JWT + RBAC macro), error handler, rate limit
├── jobs/                  runner (FOR UPDATE SKIP LOCKED) + handler: expire task, cleanup
├── contracts/             ABI + bytecode hasil kompilasi (jangan diedit manual)
├── services/
│   ├── ledger.service.ts  double-entry: postTransaction, transfer, deposit, hold
│   ├── escrow.service.ts  eskrow ledger: fund / release / refund + komisi referral
│   ├── onchain-escrow.service.ts  cermin DB untuk event kontrak
│   └── evm/               client viem, helper kontrak, indexer event
└── modules/               auth, users, catalog, tasks, submissions, wallet,
                           referrals, notifications, onchain, admin
contracts/
├── src/BeeworkEscrow.sol  kontrak eskrow (Solidity 0.8.28, OpenZeppelin 5)
├── compile.ts             solc-js → src/contracts/
└── deploy.ts              deploy + allowlist token
```

## Aturan uang

Salah di sini artinya kehilangan uang orang, jadi ini tidak bisa ditawar:

1. **Nominal selalu base unit** (integer, mengikuti `assets.decimals`).
   1 USDC = `"1000000"`. API menerima dan mengembalikan string, bukan number.
2. **Aritmetika pakai BigInt** — lihat `src/common/money.ts`. Tidak ada float.
3. **Semua perpindahan dana lewat `postTransaction`**, yang menolak transaksi
   tidak seimbang dan menulis `ledger_entries` + `accounts` dalam satu transaksi DB.
4. **Idempotency key wajib** pada setiap perpindahan dana.
5. Akun dan escrow **dikunci** (`FOR UPDATE`) sebelum saldonya dibaca.
6. `accounts.balance` hanya berubah lewat `postTransaction`, sehingga selalu sama
   dengan hasil replay `ledger_entries`. Dana yang ditahan tidak "dibekukan" di
   kolom terpisah — dana itu benar-benar pindah ke akun `escrow` atau `hold`.

Ada empat jenis pemilik akun: `user`, `escrow`, `hold` (penahanan per payout),
`platform` (pendapatan fee), dan `external` — cermin dana di luar platform,
satu-satunya yang boleh bersaldo negatif.

## Alur utama

```
POST /tasks                      → status pending_deposit, balikkan fee & total
POST /tasks/:id/publish          → saldo owner dikunci ke escrow, status open
POST /tasks/:id/submissions      → worker kirim hasil
POST /submissions/:id/approve    → escrow → worker, fee → platform,
                                   50% fee → referrer, task completed
POST /wallet/payouts             → saldo pindah ke akun hold,
                                   menunggu worker on-chain
```

`:id` pada route task menerima uuid maupun `publicId` yang pendek.

## Eskrow on-chain (kontrak `BeeworkEscrow`, EVM)

Untuk aset yang `chain`-nya EVM (`monad`, `ethereum`, `base`), dana **tidak pernah
menyentuh ledger internal**. Kontrak di `contracts/src/BeeworkEscrow.sol` yang
memegangnya; backend hanya bertindak sebagai `reviewer` dan cermin pembukuan.

```
POST /tasks  (aset EVM)        → pending_deposit + `onchain.fundArgs`
owner: fund(...fundArgs)       → dari wallet-nya sendiri, msg.value = deposit
POST /tasks/:id/publish        → { txHash }; backend verifikasi event BountyFunded
POST /submissions/:id/approve  → backend memanggil award() sebagai reviewer
pekerja: withdraw(asset, to)   → menarik sendiri dari kontrak
owner: refund(bountyId)        → sisa dana, hanya setelah deadline + 7 hari
```

Indexer (`src/services/evm/indexer.ts`) mem-polling event kontrak dan mencatatnya
ke `webhook_events` (idempoten per `txHash:logIndex`), jadi kalau frontend gagal
mengirim `txHash` atau proses mati di tengah `approve`, DB tetap tersinkron.
`GET /onchain/tasks/:id` menampilkan keadaan DB dan kontrak berdampingan.

Yang berbeda dari jalur ledger dan perlu diketahui frontend:

- Task EVM **wajib** punya `deadlineAt` (maks 365 hari) — kontrak yang mensyaratkan.
- Pemenang harus punya wallet **terverifikasi** di chain yang sama sebelum di-approve
  (lihat *Wallet* di bawah). `award()` ke alamat salah tidak bisa ditarik siapa pun.
- **Tidak ada pembatalan dini.** `cancel` hanya menutup task di DB; dana baru bisa
  ditarik owner lewat `refund()` setelah `refundAt`.
- Fee 5% dipotong kontrak ke `feeRecipient`; **komisi referral tidak berjalan** untuk
  task EVM karena tidak ada dana platform yang lewat ledger.
- `reviewer` terkunci per bounty saat `fund()`. Mengganti `EVM_REVIEWER_PRIVATE_KEY`
  membuat bounty lama tidak bisa di-award lagi — rotasi kunci butuh migrasi.

Kompilasi & deploy:

```bash
bun run contracts:compile
```

```bash
EVM_RPC_URL=https://testnet-rpc.monad.xyz EVM_CHAIN_ID=10143 DEPLOYER_PRIVATE_KEY=0x... bun run contracts:deploy
```

Lalu isi `EVM_ESCROW_ADDRESS`, `EVM_INDEXER_START_BLOCK`, dan `EVM_REVIEWER_PRIVATE_KEY`
di `.env`. Saat startup backend memeriksa `FEE_BPS` kontrak; salah alamat → gagal start.
Tambahkan aset native/ERC-20 ke tabel `assets` dengan `chain` EVM dan `mintAddress`
= alamat token (kosong untuk native).

Diuji end-to-end di anvil: `contracts/` + `src/services/evm/` — fund, award, withdraw,
refund, balapan indexer vs publish, dan double-count guard.

### Sumber event kedua: GhostGraph (opsional)

`contracts/ghost/` berisi definisi indexer hosted [GhostGraph](https://docs.monad.xyz/guides/indexers/ghost)
(`events.sol`, `schema.sol`, `indexer.sol`) untuk kontrak yang sama. Setelah di-deploy
di dashboard Ghost, isi `GHOST_GRAPHQL_URL` + `GHOST_API_KEY`; job berulang
`evm.ghost-reconcile` menarik `escrowEvents` tiap menit dan memasukkannya ke jalur
`processLog` yang sama dengan indexer RPC — kunci `txHash:logIndex` mencegah duplikasi.
Dengan `EVM_INDEXER_ENABLED=false` backend bisa hidup sepenuhnya dari Ghost (diuji
end-to-end dengan Ghost tiruan). `GET /onchain/indexer-status` (admin) menampilkan
kursor RPC & Ghost vs head chain.

## Wallet

Menautkan wallet butuh bukti kepemilikan — dua langkah:

```
POST /users/me/wallets/challenge  { chain, address }
  → { message, nonce, expiresAt }          nonce berlaku 10 menit, sekali pakai
tanda tangani `message` dengan wallet itu
POST /users/me/wallets            { chain, address, nonce, signature }
  → wallet tersimpan dengan verifiedAt
```

| Chain | Tanda tangan | Format `signature` |
|---|---|---|
| EVM (`monad`, `ethereum`, `base`) | EIP-191 `personal_sign` / `signMessage` | hex `0x…` |
| `solana` | `signMessage(bytes)` ed25519 | base58 (atau base64) |

Pesan terikat ke user id, domain, chain, dan alamat, jadi tanda tangan tidak bisa
dipakai ulang untuk akun lain. Saat kontrak EVM aktif, verifikasi lewat RPC sehingga
smart-contract wallet (ERC-1271) ikut didukung; tanpa RPC hanya EOA. Salah tanda
tangan 5 kali mematikan challenge-nya. Wallet dari login Privy sudah terverifikasi
oleh Privy dan tidak perlu langkah ini.

## Autentikasi

Dua cara masuk, keduanya menghasilkan token yang sama:

| Endpoint | Untuk |
|---|---|
| `POST /auth/register` & `/auth/login` | username/email + password |
| `POST /auth/privy` | Privy (email + embedded Solana wallet) |

Untuk Privy, kirim field **`token`** dari respons login Privy — bukan
`privy_access_token`, yang audience-nya `auth.privy.io` dan akan ditolak:

```json
{ "token": "<privy token>", "referralCode": "opsional" }
```

Token diverifikasi ES256 terhadap JWKS publik Privy (`iss=privy.io`, `aud=PRIVY_APP_ID`).
Email dan alamat wallet **tidak** diambil dari body, melainkan dari API Privy memakai
`PRIVY_APP_SECRET` — kalau secret itu kosong, login tetap jalan tapi akun dibuat tanpa
email dan wallet (dan diisi belakangan saat login berikutnya begitu secret dipasang).
Wallet dari Privy langsung berstatus terverifikasi, jadi tidak perlu `signMessage` lagi.
Balasan `201` untuk akun baru, `200` untuk akun lama.

`Authorization: Bearer <accessToken>`. Access token 15 menit, refresh token 30 hari
dan berotasi setiap dipakai (token lama langsung dicabut).

Level akses per route ditentukan macro `auth`:
`{ auth: true }`, `{ auth: 'verified' }`, `{ auth: 'moderator' }`, `{ auth: 'admin' }`.

## Job runner

Antrean job di tabel `jobs`, diklaim dengan `SELECT … FOR UPDATE SKIP LOCKED` —
aman dijalankan lebih dari satu proses. Job `processing` yang terkunci > 10 menit
dianggap yatim dan diklaim ulang. Job sekali-jalan gagal → retry dengan backoff
eksponensial sampai `maxAttempts`, lalu `dead`. Job berulang tidak pernah mati:
satu baris per type (`dedupeKey: recurring:<type>`) yang dijadwalkan ulang setelah
selesai. Daftarkan di `src/jobs/index.ts`.

| Job | Interval | Tugas |
|---|---|---|
| `tasks.expire` | 1 mnt | task aktif yang lewat **deadline + `TASK_REVIEW_PERIOD_DAYS`** (7 hari, sama dengan `REVIEW_PERIOD` kontrak) atau `refundAt` escrow on-chain |
| `maintenance.cleanup` | 1 jam | hapus challenge & sesi yang sudah lama kedaluwarsa |

Apa yang terjadi saat task kedaluwarsa: submission yang belum diputuskan → `rejected`
dengan catatan; escrow ledger → sisa dana (termasuk fee yang belum terpakai)
dikembalikan ke owner; escrow on-chain → tidak disentuh, owner dapat notifikasi untuk
memanggil `refund()`; status → `completed` kalau sudah ada pemenang, `expired` kalau
belum. Semuanya satu transaksi DB dengan task dikunci, jadi idempoten.

Admin: `GET /admin/jobs` melihat antrean, `POST /admin/jobs/:type/run` menjalankan job
berulang sekarang juga.

## Captcha pendaftaran

`POST /auth/register` memverifikasi `captchaToken` server-side sebelum hash password
dan insert — pekerjaan mahal hanya dikerjakan untuk manusia. Default **Cloudflare
Turnstile**; `CAPTCHA_PROVIDER` bisa `hcaptcha` atau `recaptcha` (kontrak siteverify
sama), atau `none`. Frontend membaca `GET /auth/captcha` → `{ enabled, provider,
siteKey }` untuk tahu widget mana yang dirender.

| Kondisi | Respons |
|---|---|
| captcha aktif, token tidak dikirim | `400 CAPTCHA_REQUIRED` (details berisi config) |
| siteverify menjawab gagal / hostname atau action tidak cocok / skor rendah | `403 CAPTCHA_FAILED` + `codes` |
| siteverify tidak terjangkau | `503 CAPTCHA_UNAVAILABLE` — gagal tertutup, bukan lolos |

`CAPTCHA_SECRET` kosong = nonaktif; di produksi ini memunculkan peringatan saat start.
Untuk dev, Cloudflare menyediakan kunci uji resmi (lihat `.env.example`).

## Rate limit

Fixed-window, in-memory (satu instance). Batas global 300 request/menit per IP di
`onRequest`, plus batas per route lewat macro `rateLimit` (`src/plugins/rate-limit.ts`):

| Route | Batas | Kunci |
|---|---|---|
| `POST /auth/register` | 5 / 15 mnt | IP |
| `POST /auth/login` | 20 / 15 mnt **dan** 10 / 15 mnt | IP **dan** akun target |
| `POST /auth/refresh` | 30 / mnt | IP |
| `POST /auth/privy` | 10 / mnt | IP |
| `POST /users/me/wallets/challenge` | 10 / 10 mnt | user |
| `POST /users/me/wallets` | 20 / 10 mnt | user |
| `POST /tasks` | 30 / jam | user |
| `POST /tasks/:id/submissions` | 60 / jam | user |
| `POST /wallet/payouts` | 10 / jam | user |

Respons membawa `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; saat
ditolak `429` + `Retry-After`. `X-Forwarded-For` hanya dipercaya kalau koneksi datang
dari loopback (`TRUST_PROXY=true`, topologi nginx di mesin yang sama) — dari mana pun
selain itu, IP soket yang dipakai, jadi header tidak bisa dipalsukan untuk lolos.
Untuk dev lokal set `RATE_LIMIT_ENABLED=false`. Kalau nanti multi-instance, ganti
`MemoryStore` dengan Redis — antarmukanya satu fungsi `hit(key, windowMs)`.

## Deploy

Live di **<https://api.eac01.xyz>** (Swagger: `/docs`).

Berjalan sebagai systemd service `beework` dengan user sistem `beework`,
kode di `/opt/beework/app`, mendengarkan `127.0.0.1:3000`, dihadapkan ke publik
lewat nginx + sertifikat Let's Encrypt yang diperbarui otomatis.

```bash
tar czf - --exclude=node_modules --exclude=.env . | ssh <host> 'sudo -u beework tar xzf - -C /opt/beework/app'
```

```bash
ssh <host> "sudo -u beework bash -c 'cd /opt/beework/app && bun install --frozen-lockfile && bun run db:migrate' && sudo systemctl restart beework"
```

`.env` produksi ada di server dan tidak ikut terkirim. Unit systemd memakai
`ProtectSystem=strict` + `MemoryMax=512M`; sesuaikan kalau servernya lebih lega.

## Belum dikerjakan

Escrow masih berjalan di ledger internal (`chain = 'offchain'`); integrasi Solana,
OAuth GitHub/X, GitHub bounty bot, tipping, dispute, dan job runner belum ada.

Belum ada endpoint deposit — dana masuk dicatat lewat `creditDeposit()` di
`ledger.service.ts`, yang nantinya dipanggil worker pendengar transfer on-chain.
Payout berhenti di status `pending`; `settlePayout()` dan `releaseHold()` sudah
siap dipakai worker tersebut.

Urutan pengerjaan yang disarankan ada di bagian 4 `docs/BACKEND-ANALYSIS.md`.
