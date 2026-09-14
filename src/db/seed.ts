import { shortId } from '../common/ids.ts'
import { db, sql } from './index.ts'
import { assets, categories, settings, tags, users } from './schema/index.ts'

const seedAssets = [
  {
    symbol: 'USDC',
    name: 'USD Coin',
    chain: 'solana' as const,
    mintAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    isStable: true,
    priceUsd: '1',
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    chain: 'solana' as const,
    mintAddress: 'So11111111111111111111111111111111111111112',
    decimals: 9,
  },
  {
    symbol: 'WORK',
    name: 'Work Token',
    chain: 'solana' as const,
    mintAddress: 'F7Hwf8ib5DVCoiuyGr618Y3gon429Rnd1r5F9R5upump',
    decimals: 6,
  },
]

const seedCategories = [
  { slug: 'development', name: 'Development', icon: 'code', sortOrder: 1 },
  { slug: 'design', name: 'Design', icon: 'palette', sortOrder: 2 },
  { slug: 'social-media', name: 'Social Media', icon: 'megaphone', sortOrder: 3 },
  { slug: 'content', name: 'Content Writing', icon: 'pen', sortOrder: 4 },
  { slug: 'research', name: 'Research', icon: 'search', sortOrder: 5 },
  { slug: 'community', name: 'Community', icon: 'users', sortOrder: 6 },
  { slug: 'other', name: 'Other', icon: 'dots', sortOrder: 99 },
]

const seedTags = [
  'solana',
  'typescript',
  'rust',
  'react',
  'ui-ux',
  'copywriting',
  'twitter',
  'video',
  'translation',
]

await db.insert(assets).values(seedAssets).onConflictDoNothing()
await db.insert(categories).values(seedCategories).onConflictDoNothing()
await db
  .insert(tags)
  .values(seedTags.map((slug) => ({ slug, name: slug.replace(/-/g, ' ') })))
  .onConflictDoNothing()

await db
  .insert(settings)
  .values([
    { key: 'platform_fee_bps', value: 500, description: 'Fee platform per task (basis poin)' },
    { key: 'referral_share_bps', value: 5000, description: 'Bagian referrer dari platform fee' },
    { key: 'min_task_reward_usd', value: 1, description: 'Nilai reward minimum' },
    { key: 'payout_manual_review_usd', value: 500, description: 'Ambang review manual penarikan' },
  ])
  .onConflictDoNothing()

// Admin hanya dibuat kalau ADMIN_PASSWORD diberikan — jangan pernah ada
// kredensial default yang bisa ditebak di lingkungan yang bisa diakses publik.
const adminPassword = process.env.ADMIN_PASSWORD
if (!adminPassword) {
  console.log('ADMIN_PASSWORD tidak diset — akun admin dilewati')
} else {
  await db
    .insert(users)
    .values({
      username: process.env.ADMIN_USERNAME ?? 'admin',
      email: process.env.ADMIN_EMAIL ?? 'admin@beework.local',
      displayName: 'Admin',
      passwordHash: await Bun.password.hash(adminPassword),
      role: 'admin',
      isVerified: true,
      verifiedAt: new Date(),
      referralCode: shortId(8),
    })
    .onConflictDoNothing()
  console.log('akun admin dibuat')
}

console.log('✅ seed selesai')
await sql.end()
