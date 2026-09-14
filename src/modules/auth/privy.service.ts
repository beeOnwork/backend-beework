import { and, eq, isNull } from 'drizzle-orm'
import { Forbidden } from '../../common/errors.ts'
import { shortId, slugify } from '../../common/ids.ts'
import { db, type Executor } from '../../db/index.ts'
import { linkedAccounts, referrals, users, wallets } from '../../db/schema/index.ts'
import {
  fetchPrivyProfile,
  type PrivyProfile,
  verifyPrivyToken,
} from '../../services/privy.service.ts'

/** Cari username bebas dari email/DID; tambahkan sufiks acak kalau bentrok. */
const allocateUsername = async (tx: Executor, seed: string) => {
  const base = (slugify(seed).replace(/-/g, '_').slice(0, 24) || 'user').replace(/^_+|_+$/g, '')
  const candidate = base.length >= 3 ? base : `user_${base}`

  for (let attempt = 0; attempt < 5; attempt++) {
    const name = attempt === 0 ? candidate : `${candidate}_${shortId(4)}`
    const [taken] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, name))
      .limit(1)
    if (!taken) return name
  }
  return `user_${shortId(10)}`
}

/** Simpan wallet Privy sebagai wallet terverifikasi milik user. */
const syncWallets = async (tx: Executor, userId: string, profile: PrivyProfile | null) => {
  if (!profile?.solanaWallets.length) return

  const [existingPrimary] = await tx
    .select({ id: wallets.id })
    .from(wallets)
    .where(and(eq(wallets.userId, userId), eq(wallets.isPrimary, true)))
    .limit(1)

  let isFirst = !existingPrimary
  for (const wallet of profile.solanaWallets) {
    await tx
      .insert(wallets)
      .values({
        userId,
        chain: 'solana',
        address: wallet.address,
        label: wallet.embedded ? 'Privy embedded' : 'Privy linked',
        isPrimary: isFirst,
        // Privy yang menjamin kepemilikannya, jadi tidak perlu signMessage lagi.
        verifiedAt: new Date(),
      })
      .onConflictDoNothing()
    isFirst = false
  }
}

/**
 * Login/registrasi lewat Privy. Identitas hanya diambil dari token yang sudah
 * diverifikasi dan dari API Privy — tidak ada satu pun field dari body request
 * yang dipercaya sebagai identitas.
 */
export const loginWithPrivy = async (input: { token: string; referralCode?: string }) => {
  const claims = await verifyPrivyToken(input.token)
  const profile = await fetchPrivyProfile(claims.did)

  return db.transaction(async (tx) => {
    const [linked] = await tx
      .select()
      .from(linkedAccounts)
      .where(
        and(
          eq(linkedAccounts.provider, 'privy'),
          eq(linkedAccounts.providerAccountId, claims.did),
        ),
      )
      .limit(1)

    // --- user yang sudah pernah login lewat Privy ---
    if (linked) {
      const [user] = await tx
        .select()
        .from(users)
        .where(and(eq(users.id, linked.userId), isNull(users.deletedAt)))
        .limit(1)
      if (!user) throw Forbidden('Linked account points to a removed user')
      if (user.status !== 'active') throw Forbidden(`Account is ${user.status}`)

      await syncWallets(tx, user.id, profile)
      await tx
        .update(linkedAccounts)
        .set({
          username: profile?.email ?? linked.username,
          profile: { linkedAccounts: profile?.linkedAccounts ?? [] },
        })
        .where(eq(linkedAccounts.id, linked.id))

      // Backfill: akun yang dibuat saat PRIVY_APP_SECRET belum dikonfigurasi
      // tidak punya email. Isi begitu profilnya bisa dibaca.
      if (profile?.email && !user.email) {
        const [updated] = await tx
          .update(users)
          .set({
            email: profile.email,
            emailVerifiedAt: new Date(),
            isVerified: user.isVerified || profile.solanaWallets.length > 0,
            verifiedAt: user.verifiedAt ?? (profile.solanaWallets.length ? new Date() : null),
          })
          .where(eq(users.id, user.id))
          .returning()
        return { user: updated ?? user, isNew: false }
      }

      return { user, isNew: false }
    }

    // --- email Privy sudah dipakai akun lain: sambungkan, jangan duplikat ---
    let user =
      profile?.email
        ? (
            await tx
              .select()
              .from(users)
              .where(and(eq(users.email, profile.email), isNull(users.deletedAt)))
              .limit(1)
          )[0]
        : undefined

    const isNew = !user

    if (!user) {
      const referrer = input.referralCode
        ? (
            await tx
              .select({ id: users.id })
              .from(users)
              .where(eq(users.referralCode, input.referralCode))
              .limit(1)
          )[0]
        : undefined

      const username = await allocateUsername(
        tx,
        profile?.email?.split('@')[0] ?? claims.did.replace('did:privy:', ''),
      )

      const [created] = await tx
        .insert(users)
        .values({
          username,
          displayName: username,
          email: profile?.email ?? null,
          // Privy hanya menyertakan email setelah user memverifikasinya.
          emailVerifiedAt: profile?.email ? new Date() : null,
          referralCode: shortId(8),
          referredById: referrer?.id ?? null,
          // punya wallet + email terverifikasi lewat Privy sudah cukup
          isVerified: Boolean(profile?.email && profile.solanaWallets.length),
          verifiedAt: profile?.email && profile.solanaWallets.length ? new Date() : null,
        })
        .returning()

      user = created!

      if (referrer) {
        await tx.insert(referrals).values({
          referrerId: referrer.id,
          refereeId: user.id,
          code: input.referralCode!,
        })
      }
    } else if (user.status !== 'active') {
      throw Forbidden(`Account is ${user.status}`)
    }

    await tx.insert(linkedAccounts).values({
      userId: user.id,
      provider: 'privy',
      providerAccountId: claims.did,
      username: profile?.email ?? null,
      profile: { linkedAccounts: profile?.linkedAccounts ?? [] },
    })

    await syncWallets(tx, user.id, profile)

    return { user, isNew }
  })
}
