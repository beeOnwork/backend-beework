import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  UnprocessableEntity,
} from "../../common/errors.ts";
import { type Pagination, paginated } from "../../common/http.ts";
import { secretToken, shortId } from "../../common/ids.ts";
import { gte as amountGte, isPositive } from "../../common/money.ts";
import { db } from "../../db/index.ts";
import {
  assets,
  categories,
  escrows,
  tasks,
  users,
} from "../../db/schema/index.ts";
import type { AuthUser } from "../../plugins/auth.ts";
import {
  calculateFee,
  fundEscrow,
  refundEscrow,
} from "../../services/escrow.service.ts";
import {
  getFundedEventFromTx,
  hashId,
  publicConfig,
  quoteFee,
} from "../../services/evm/escrow.contract.ts";
import {
  assertEvmEnabled,
  assetAddress,
  isEvmChain,
  recordFunded,
} from "../../services/onchain-escrow.service.ts";

export type CreateTaskInput = {
  type: "task" | "bounty" | "quest";
  title: string;
  description: string;
  categoryId?: string;
  rewardAssetId: string;
  rewardAmount: string;
  /** Smallest payout the owner is promising a single winner (base unit); shown to contributors up-front. */
  minimumPayout?: string;
  maxWinners?: number;
  visibility?: "public" | "private" | "unlisted";
  requiresVerified?: boolean;
  autoApprove?: boolean;
  allowMultipleSubmissions?: boolean;
  deadlineAt?: string;
  requirements?: { label: string; required: boolean }[];
  githubRepo?: string;
  githubIssueNumber?: number;
  githubIssueUrl?: string;
};

const taskListColumns = {
  id: tasks.id,
  publicId: tasks.publicId,
  type: tasks.type,
  title: tasks.title,
  status: tasks.status,
  visibility: tasks.visibility,
  rewardAmount: tasks.rewardAmount,
  minimumPayout: tasks.minimumPayout,
  maxWinners: tasks.maxWinners,
  winnersCount: tasks.winnersCount,
  requiresVerified: tasks.requiresVerified,
  deadlineAt: tasks.deadlineAt,
  publishedAt: tasks.publishedAt,
  submissionCount: tasks.submissionCount,
  viewCount: tasks.viewCount,
  createdAt: tasks.createdAt,
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URL publik memakai `publicId`, API internal memakai uuid - terima keduanya. */
const taskIdentity = (idOrPublicId: string) =>
  UUID_RE.test(idOrPublicId)
    ? eq(tasks.id, idOrPublicId)
    : eq(tasks.publicId, idOrPublicId);

export const resolveTaskId = async (idOrPublicId: string) => {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(taskIdentity(idOrPublicId))
    .limit(1);
  if (!task) throw NotFound("Task");
  return task.id;
};

export const createTask = async (owner: AuthUser, input: CreateTaskInput) => {
  if (!isPositive(input.rewardAmount))
    throw BadRequest("Reward amount must be greater than zero");
  if (input.minimumPayout !== undefined) {
    if (!isPositive(input.minimumPayout))
      throw BadRequest("Minimum payout must be greater than zero");
    if (!amountGte(input.rewardAmount, input.minimumPayout))
      throw BadRequest("Minimum payout cannot exceed the total reward");
  }

  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, input.rewardAssetId), eq(assets.isActive, true)))
    .limit(1);
  if (!asset) throw BadRequest("Unknown or inactive reward asset");

  if (input.deadlineAt && new Date(input.deadlineAt) <= new Date())
    throw BadRequest("Deadline must be in the future");

  const onchain = isEvmChain(asset.chain);
  if (onchain) {
    assertEvmEnabled();
    // Kontrak mewajibkan deadline, dan menolak lebih dari 365 hari
    if (!input.deadlineAt)
      throw BadRequest("On-chain tasks require a deadline");
    if (new Date(input.deadlineAt).getTime() > Date.now() + 365 * 864e5)
      throw BadRequest("Deadline must be within 365 days for on-chain tasks");
  }

  // Fee on-chain ditentukan kontrak (FEE_BPS konstan); fee ledger dari env.
  const { fee, total } = onchain
    ? (() => {
        const f = quoteFee(BigInt(input.rewardAmount));
        return {
          fee: f.toString(),
          total: (BigInt(input.rewardAmount) + f).toString(),
        };
      })()
    : calculateFee(input.rewardAmount);

  // id dibuat di sini supaya hash on-chain-nya bisa ditulis dalam insert yang sama
  const id = crypto.randomUUID();

  const [task] = await db
    .insert(tasks)
    .values({
      ...input,
      id,
      publicId: shortId(10),
      ownerId: owner.id,
      status: "pending_deposit",
      platformFeeAmount: fee,
      deadlineAt: input.deadlineAt ? new Date(input.deadlineAt) : null,
      privateToken: input.visibility === "private" ? secretToken(24) : null,
      onchainTaskId: onchain ? hashId(id) : null,
    })
    .returning();

  if (!task) throw new Error("Failed to create task");

  const cfg = onchain ? publicConfig() : null;
  return {
    task,
    fee,
    totalRequired: total,
    escrowMode: onchain ? ("onchain" as const) : ("ledger" as const),
    // Semua yang frontend butuhkan untuk memanggil fund(), persis seperti yang
    // nanti diverifikasi backend saat publish.
    onchain:
      onchain && cfg
        ? {
            ...cfg,
            fundArgs: {
              taskId: task.onchainTaskId,
              reviewer: cfg.reviewerAddress,
              asset: assetAddress(asset),
              budget: input.rewardAmount,
              deadline: Math.floor(
                new Date(input.deadlineAt!).getTime() / 1000,
              ),
              maxWinners: input.maxWinners ?? 1,
            },
            /** msg.value untuk native, atau nilai approve() untuk ERC-20 */
            deposit: total,
            nextStep:
              "Panggil fund() lalu POST /tasks/" +
              task.publicId +
              "/publish dengan { txHash }",
          }
        : null,
  };
};

/**
 * Publikasikan task. Ledger: dana owner dikunci ke escrow internal.
 * On-chain: owner sudah memanggil fund(); backend memverifikasi tx-nya.
 */
export const publishTask = async (
  owner: AuthUser,
  taskId: string,
  opts: { txHash?: string } = {},
) => {
  const task = await requireOwnedTask(owner, taskId);

  if (task.onchainTaskId) {
    assertEvmEnabled();
    if (!opts.txHash)
      throw BadRequest("txHash of the fund() transaction is required");
    const txHash = opts.txHash.toLowerCase();

    // Indexer bisa lebih dulu mencatat BountyFunded dari tx yang sama. Itu bukan
    // konflik — jawab sukses supaya frontend tidak perlu membedakan siapa yang menang.
    if (task.status !== "draft" && task.status !== "pending_deposit") {
      const [escrow] = await db
        .select()
        .from(escrows)
        .where(eq(escrows.taskId, task.id))
        .limit(1);
      if (escrow?.fundingTxHash?.toLowerCase() === txHash) return task;
      throw Conflict(`Task is already ${task.status}`);
    }

    const event = await getFundedEventFromTx(txHash as `0x${string}`);
    if (!event)
      throw UnprocessableEntity(
        "Transaction has no BountyFunded event from the escrow contract",
      );
    if (event.taskId !== task.onchainTaskId)
      throw UnprocessableEntity("Transaction funded a different task");

    return db.transaction(async (tx) => (await recordFunded(tx, event)).task);
  }

  if (task.status !== "draft" && task.status !== "pending_deposit")
    throw Conflict(`Task is already ${task.status}`);

  return db.transaction(async (tx) => {
    await fundEscrow(tx, task.id);
    await tx
      .update(users)
      .set({ tasksCreatedCount: sql`${users.tasksCreatedCount} + 1` })
      .where(eq(users.id, owner.id));
    const [updated] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .limit(1);
    return updated!;
  });
};

export const cancelTask = async (actor: AuthUser, taskId: string) => {
  const task = await requireOwnedTask(actor, taskId);
  if (task.status === "completed" || task.status === "cancelled")
    throw Conflict(`Task is already ${task.status}`);
  if (task.winnersCount > 0)
    throw Conflict(
      "Task already has approved submissions; open a dispute instead",
    );

  return db.transaction(async (tx) => {
    const funded =
      task.status === "open" ||
      task.status === "in_progress" ||
      task.status === "in_review";

    if (funded && task.onchainTaskId) {
      // Kontrak tidak punya pembatalan dini: dana hanya bisa ditarik owner lewat
      // refund() setelah refundAt. Di sini cukup tutup task agar submission berhenti.
      const [escrow] = await tx
        .select()
        .from(escrows)
        .where(eq(escrows.taskId, task.id))
        .limit(1);
      const [updated] = await tx
        .update(tasks)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          metadata: {
            ...(task.metadata ?? {}),
            refundHint:
              "Panggil refund(" +
              escrow?.onchainBountyId +
              ") di kontrak setelah " +
              escrow?.refundAt?.toISOString(),
          },
        })
        .where(eq(tasks.id, task.id))
        .returning();
      return updated!;
    }

    if (funded) {
      await refundEscrow(tx, task.id, actor.id);
    }
    const [updated] = await tx
      .update(tasks)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(tasks.id, task.id))
      .returning();
    return updated!;
  });
};

export type TaskFilters = {
  q?: string;
  type?: "task" | "bounty" | "quest";
  status?: string;
  categorySlug?: string;
  ownerUsername?: string;
  minReward?: string;
  verifiedOnly?: boolean;
  sort?: "newest" | "reward" | "deadline";
};

export const listTasks = async (filters: TaskFilters, page: Pagination) => {
  // task private/unlisted tidak pernah muncul di feed publik
  const where = () =>
    and(
      isNull(tasks.deletedAt),
      eq(tasks.visibility, "public" as const),
      filters.status
        ? eq(tasks.status, filters.status as "open")
        : inArray(tasks.status, ["open", "in_progress", "in_review"]),
      filters.type ? eq(tasks.type, filters.type) : undefined,
      filters.verifiedOnly ? eq(tasks.requiresVerified, true) : undefined,
      filters.minReward
        ? gte(tasks.rewardAmount, filters.minReward)
        : undefined,
      filters.q
        ? or(
            ilike(tasks.title, `%${filters.q}%`),
            ilike(tasks.description, `%${filters.q}%`),
          )
        : undefined,
      filters.categorySlug
        ? eq(categories.slug, filters.categorySlug)
        : undefined,
      filters.ownerUsername
        ? eq(users.username, filters.ownerUsername)
        : undefined,
    );

  const orderBy =
    filters.sort === "reward"
      ? desc(sql`${tasks.rewardAmount}::numeric`)
      : filters.sort === "deadline"
        ? sql`${tasks.deadlineAt} asc nulls last`
        : desc(tasks.publishedAt);

  const rows = await db
    .select({
      ...taskListColumns,
      owner: {
        id: users.id,
        username: users.username,
        avatarUrl: users.avatarUrl,
      },
      category: { slug: categories.slug, name: categories.name },
      asset: {
        symbol: assets.symbol,
        decimals: assets.decimals,
        logoUrl: assets.logoUrl,
      },
    })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.ownerId))
    .innerJoin(assets, eq(assets.id, tasks.rewardAssetId))
    .leftJoin(categories, eq(categories.id, tasks.categoryId))
    .where(where())
    .orderBy(orderBy)
    .limit(page.limit)
    .offset(page.offset);

  const [totalRow] = await db
    .select({ value: count() })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.ownerId))
    .leftJoin(categories, eq(categories.id, tasks.categoryId))
    .where(where());

  return paginated(rows, totalRow?.value ?? 0, page);
};

export const getTask = async (
  idOrPublicId: string,
  viewer?: AuthUser | null,
  privateToken?: string,
) => {
  const [row] = await db
    .select({
      task: tasks,
      owner: {
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        isVerified: users.isVerified,
      },
      asset: {
        id: assets.id,
        symbol: assets.symbol,
        decimals: assets.decimals,
      },
      category: { slug: categories.slug, name: categories.name },
    })
    .from(tasks)
    .innerJoin(users, eq(users.id, tasks.ownerId))
    .innerJoin(assets, eq(assets.id, tasks.rewardAssetId))
    .leftJoin(categories, eq(categories.id, tasks.categoryId))
    .where(and(taskIdentity(idOrPublicId), isNull(tasks.deletedAt)))
    .limit(1);

  if (!row) throw NotFound("Task");

  const isOwner = viewer?.id === row.task.ownerId;
  const isStaff = viewer?.role === "admin" || viewer?.role === "moderator";
  if (
    row.task.visibility === "private" &&
    !isOwner &&
    !isStaff &&
    row.task.privateToken !== privateToken
  )
    throw Forbidden("This task is private");

  await db
    .update(tasks)
    .set({ viewCount: sql`${tasks.viewCount} + 1` })
    .where(eq(tasks.id, row.task.id));

  const { privateToken: token, ...task } = row.task;
  return { ...row, task: isOwner ? { ...task, privateToken: token } : task };
};

export const requireOwnedTask = async (actor: AuthUser, taskId: string) => {
  const [task] = await db
    .select()
    .from(tasks)
    .where(taskIdentity(taskId))
    .limit(1);
  if (!task) throw NotFound("Task");
  if (task.ownerId !== actor.id && actor.role === "user")
    throw Forbidden("Only the task owner can do this");
  return task;
};

export const listMyTasks = async (actor: AuthUser, page: Pagination) => {
  const rows = await db
    .select(taskListColumns)
    .from(tasks)
    .where(and(eq(tasks.ownerId, actor.id), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.createdAt))
    .limit(page.limit)
    .offset(page.offset);

  const [totalRow] = await db
    .select({ value: count() })
    .from(tasks)
    .where(and(eq(tasks.ownerId, actor.id), isNull(tasks.deletedAt)));

  return paginated(rows, totalRow?.value ?? 0, page);
};
