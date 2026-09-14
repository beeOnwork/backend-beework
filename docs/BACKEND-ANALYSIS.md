# Analisis Backend — Kloning Internal gib.work

Dokumen ini merangkum hasil analisis platform [gib.work](https://gib.work) dan
menerjemahkannya jadi kebutuhan backend konkret. Sumber: halaman utama gib.work
dan dokumentasi resmi `docs.gib.work` (llms-full.txt), diakses 5 September 2026.

---

## 1. Apa itu gib.work

Marketplace kerja "onchain": siapa pun bisa memasang pekerjaan berhadiah token
Solana (SPL), dan siapa pun bisa mengerjakannya untuk dapat bayaran. Lahir dari
Solana Hyperdrive hackathon 2023.

**Tiga bentuk pekerjaan** yang terlihat di produk:

| Bentuk | Karakter | Contoh nyata di beranda |
|---|---|---|
| **Task** | Pekerjaan tertutup, 1 pemenang, deadline | "Axzra outreach Agent's Bounty" |
| **Quest / social task** | Banyak pemenang, syarat mudah, kuota | "Attend 3 X Spaces and Collect 3 Reward Codes" |
| **Bounty open-source** | Terikat GitHub issue, dibayar saat PR di-merge | Bounty repo publik |

**Fakta produk lain yang memengaruhi desain backend:**

- Kategori terlihat: Social Media, Development, Design (+ Content, Research, Community sebagai perluasan wajar).
- Badge **"Verified Only"** — task bisa dibatasi hanya untuk akun terverifikasi (verifikasi = nomor HP atau akun X).
- Countdown **"Ends in N days"** → deadline adalah atribut inti, bukan opsional.
- **Private task**: hanya bisa diakses lewat link berisi token.
- **Referral**: link `?ref=username`, referrer dapat **50% dari platform fee**, dibayar instan dalam USDC.
- **Tipping**: maintainer men-tip kontributor lewat GitHub bot (`@gibworkbot tip @user`); penerima bisa belum punya akun → butuh alur klaim.
- **Token $WORK**: staking + revenue share per "Season" 12 minggu (80% peserta / 20% growth; 52% base stake, 48% partisipasi; loyalty mulai 5% dan naik 15,83%/minggu sampai 100%; poin: 2 poin per 1 USDC dibayarkan, 1 poin per 1 USDC didapat).
- **Decaf**: integrasi wallet non-kustodial untuk off-ramp ke fiat.
- Mobile app iOS/Android → butuh push notification & device registry.

---

## 2. Peta kebutuhan backend

### 2.1 Identitas & akses — **wajib**

| Kebutuhan | Alasan | Tabel |
|---|---|---|
| Akun + username unik | username jadi handle publik (`@gibwork`) & kode referral | `users` |
| Login sosial (GitHub, X, Discord, Google) | bounty GitHub & verifikasi X | `linked_accounts` |
| Wallet on-chain + bukti kepemilikan | tujuan pembayaran | `wallets` |
| Refresh-token session yang bisa dicabut | mobile app hidup lama | `sessions` |
| OTP / nonce sekali pakai | verifikasi HP, magic link, signMessage | `auth_challenges` |
| Alur verifikasi + review | badge "Verified Only" & syarat participation reward | `verification_requests` |
| RBAC user/moderator/admin | review dispute, moderasi | `users.role` |
| API key | GitHub bot & job internal | `api_keys` |

### 2.2 Katalog — **wajib**

`assets` (token SPL + `decimals`), `categories`, `tags`. Semua nominal disimpan
sebagai **base unit** mengikuti `decimals`, bukan desimal float.

### 2.3 Siklus kerja — **inti produk**

```
draft → pending_deposit → open → in_review → completed
                            ↘ cancelled / expired / disputed
```

- `tasks` — satu tabel untuk task/bounty/quest, dibedakan `type` + `maxWinners`.
- `task_applications` — untuk task yang butuh seleksi.
- `task_assignments` — tombol "Start Work" (klaim slot).
- `submissions` + `submission_revisions` — hasil kerja & jejak revisinya.
- `task_comments` — tanya jawab di halaman task.
- `disputes` — jalur eskalasi kalau owner menolak sepihak.
- `ratings` — reputasi dua arah.

### 2.4 Uang — **bagian paling kritis**

Ini yang paling gampang salah. Keputusan desain:

1. **Double-entry ledger**, bukan kolom `balance` tunggal.
   Pemilik akun: `user`, `escrow`, `hold` (penahanan payout), `platform`
   (pendapatan fee), dan `external` — cermin dana di luar platform dan
   satu-satunya akun yang boleh bersaldo negatif.
   `transactions` (1 peristiwa) + `ledger_entries` (≥2 baris debit/kredit yang
   harus seimbang) + `accounts` (saldo tercache, di-update dalam transaksi DB yang sama).
   Setiap saat bisa dibuktikan: `SUM(credit) - SUM(debit) = 0`.
2. **Escrow eksplisit** (`escrows`) sebagai pemilik akun ledger tersendiri.
   Dana pindah owner → escrow saat publish, escrow → pekerja saat approve.
3. **Idempotency key wajib** di setiap perpindahan dana. Retry jaringan tidak boleh
   membayar dua kali.
4. **Row lock** (`SELECT ... FOR UPDATE`) pada akun & escrow untuk mencegah
   double-release saat approve paralel.
5. **BigInt**, bukan Number. Tidak ada aritmetika float untuk uang.

Tabel: `accounts`, `transactions`, `ledger_entries`, `escrows`, `deposits`,
`payouts`, `tips`.

Fee: `PLATFORM_FEE_BPS` (default 5%) ditarik dari escrow proporsional dengan
porsi reward yang dilepas — penting untuk quest multi-pemenang.

### 2.5 Growth

- `referrals` + `referral_payouts` — komisi 50% platform fee, dibayar dalam transaksi yang sama dengan pelepasan escrow.
- `notifications`, `notification_preferences`, `devices` — in-app + push.

### 2.6 Token & revenue share

`seasons`, `stakes` (dengan `loyaltyBps`), `participation_points`,
`reward_distributions`. Perhitungan payday jalan sebagai job terjadwal, bukan
di request path.

### 2.7 Infrastruktur pendukung — **sering terlupakan**

| Kebutuhan | Kenapa | Tabel |
|---|---|---|
| Job queue | payout on-chain, hitung poin season, expire task, kirim email | `jobs` |
| Inbox webhook idempoten | GitHub PR merged, konfirmasi tx Solana, Decaf | `webhook_events` |
| Outbox event | integrasi & analytics tanpa dual-write | `outbox_events` |
| Audit log | siapa melepas dana, siapa mengubah role | `audit_logs` |
| File & antivirus scan | lampiran submission | `files` |
| Setting runtime | ubah fee tanpa deploy | `settings` |
| Laporan penyalahgunaan | task spam / scam | `reports` |

---

## 3. Yang **sudah** ada di repo ini

- Skema Postgres lengkap (42 tabel) + migrasi ter-generate.
- Ledger double-entry + escrow (fund / release / refund) + komisi referral.
- Auth: register, login, refresh token berotasi, logout, `/me`.
- Task: create → publish (kunci escrow) → feed berfilter → detail → cancel (refund).
- Submission: submit → review/revisi → approve (lepas dana + fee + referral).
- Wallet: saldo per token, mutasi, ajukan penarikan (dana pindah ke akun `hold`).
- Referral, notifikasi, katalog, leaderboard, profil publik.
- Login Privy; eskrow on-chain lewat kontrak `BeeworkEscrow` (EVM) + indexer event.
- Verifikasi kepemilikan wallet (challenge + signature) untuk EVM dan Solana.
- Swagger di `/docs`, error handler terpusat, RBAC lewat macro `auth`.

## 4. Yang **belum** — urutan pengerjaan yang saya sarankan

**Tahap 1 — bikin uangnya nyata**
1. Worker deposit: dengar transfer SPL masuk (Helius webhook) → kredit `deposits` → ledger.
2. Worker payout: ambil `payouts` pending → kirim transaksi Solana → konfirmasi → `settlePayout()`; kalau gagal, `releaseHold()`.
3. ~~Verifikasi wallet lewat `signMessage`~~ — selesai (EVM EIP-191 + Solana ed25519).

**Tahap 2 — kelengkapan produk**
4. OAuth GitHub & X (login + verifikasi badge), OTP nomor HP.
5. GitHub App: webhook `pull_request.closed` → auto-approve submission bounty.
6. Tipping bot + alur klaim untuk penerima yang belum punya akun.
7. Dispute & moderasi (endpoint + panel admin).
8. Upload file ke S3 (presigned URL) + pemindaian.

**Tahap 3 — skala & tata kelola**
9. ~~Job runner untuk expire task & refund otomatis~~ — selesai. Digest email masih terbuka.
10. ~~Rate limit per IP & per user, captcha di register~~ — selesai (Turnstile/hCaptcha/reCAPTCHA).
11. Season/staking/revenue share.
12. Full-text search (`tsvector`) menggantikan `ILIKE`.
13. Observability: request id, structured log, metric, Sentry.

---

## 5. Catatan risiko

- **Escrow off-chain vs on-chain.** Repo ini menjalankan escrow di ledger internal
  (`chain = 'offchain'`). gib.work aslinya memakai program escrow Solana. Kolom
  `escrows.onchainAddress` & `transactions.txSignature` sudah disiapkan; kalau nanti
  escrow dipindah on-chain, ledger internal tetap jadi cermin pembukuan, bukan
  sumber kebenaran dana.
- **Approve = pembayaran.** Perlu audit log dan idempotency ketat; sudah dipasang,
  jangan dilepas saat refactor.
- **Quest multi-pemenang** membagi reward per slot. Kalau slot tidak terisi penuh
  sampai deadline, sisa escrow harus di-refund lewat job terjadwal (belum ada).
- **Fee & referral** dihitung dari basis poin di env. Untuk audit, pindahkan ke
  tabel `settings` dan simpan nilai yang berlaku saat itu di `tasks`.
