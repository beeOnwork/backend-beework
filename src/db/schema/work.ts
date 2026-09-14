import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { amount, createdAt, pk, timestamps } from "./_shared.ts";
import { assets, categories, tags } from "./catalog.ts";
import {
  applicationStatus,
  disputeStatus,
  submissionStatus,
  taskStatus,
  taskType,
  taskVisibility,
} from "./enums.ts";
import { users } from "./identity.ts";

export const tasks = pgTable(
  "tasks",
  {
    id: pk(),
    /** slug pendek untuk URL publik: /t/ab12cd34 */
    publicId: varchar({ length: 16 }).notNull(),

    type: taskType().notNull().default("task"),
    title: varchar({ length: 200 }).notNull(),
    description: text().notNull(),
    /** checklist / acceptance criteria terstruktur */
    requirements: jsonb().$type<{ label: string; required: boolean }[]>(),

    ownerId: uuid()
      .notNull()
      .references(() => users.id),
    categoryId: uuid().references(() => categories.id),

    visibility: taskVisibility().notNull().default("public"),
    /** token untuk private task yang dibagikan lewat link */
    privateToken: varchar({ length: 64 }),

    status: taskStatus().notNull().default("draft"),

    // --- reward ---
    rewardAssetId: uuid()
      .notNull()
      .references(() => assets.id),
    rewardAmount: amount().notNull(),
    /** nominal terkecil yang dijanjikan owner ke satu pemenang (base unit); null = tidak dijanjikan */
    minimumPayout: amount(),
    /** jumlah pemenang; quest bisa lebih dari satu slot */
    maxWinners: integer().notNull().default(1),
    winnersCount: integer().notNull().default(0),
    /** fee platform yang dikunci saat deposit (base unit) */
    platformFeeAmount: amount().notNull().default("0"),

    // --- gating ---
    requiresVerified: boolean().notNull().default(false),
    autoApprove: boolean().notNull().default(false),
    allowMultipleSubmissions: boolean().notNull().default(false),

    // --- eskrow on-chain (EVM) ---
    /** keccak256(bytes(uuid task)) — kunci pencarian saat event BountyFunded masuk */
    onchainTaskId: varchar({ length: 66 }),

    // --- integrasi GitHub (bounty open-source) ---
    githubRepo: varchar({ length: 200 }),
    githubIssueNumber: integer(),
    githubIssueUrl: text(),

    // --- jadwal ---
    deadlineAt: timestamp({ withTimezone: true }),
    publishedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),

    // --- metrik ---
    viewCount: integer().notNull().default(0),
    submissionCount: integer().notNull().default(0),
    applicationCount: integer().notNull().default(0),

    metadata: jsonb().$type<Record<string, unknown>>(),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tasks_public_id_key").on(t.publicId),
    index("tasks_owner_idx").on(t.ownerId),
    index("tasks_status_idx").on(t.status, t.visibility),
    index("tasks_category_idx").on(t.categoryId),
    index("tasks_deadline_idx").on(t.deadlineAt),
    index("tasks_feed_idx").on(t.status, t.publishedAt),
    uniqueIndex("tasks_onchain_task_id_key").on(t.onchainTaskId),
  ],
);

export const taskTags = pgTable(
  "task_tags",
  {
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.tagId] })],
);

/** Lamaran untuk task yang tidak open-submission */
export const taskApplications = pgTable(
  "task_applications",
  {
    id: pk(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    coverLetter: text(),
    status: applicationStatus().notNull().default("pending"),
    respondedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("task_applications_unique").on(t.taskId, t.userId),
    index("task_applications_user_idx").on(t.userId, t.status),
  ],
);

/** "Start Work" - klaim slot pengerjaan */
export const taskAssignments = pgTable(
  "task_assignments",
  {
    id: pk(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp({ withTimezone: true }),
    releasedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("task_assignments_unique").on(t.taskId, t.userId)],
);

export const submissions = pgTable(
  "submissions",
  {
    id: pk(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    content: text(),
    links: jsonb().$type<string[]>(),
    attachments: jsonb().$type<{ fileId: string; name: string }[]>(),
    githubPrUrl: text(),

    status: submissionStatus().notNull().default("pending"),
    reviewerId: uuid().references(() => users.id),
    reviewNote: text(),
    reviewedAt: timestamp({ withTimezone: true }),
    /** nominal yang benar-benar dibayarkan (bisa lebih kecil dari rewardAmount saat multi-winner) */
    payoutAmount: amount(),
    /** keccak256(bytes(uuid submission)) yang dikirim ke award() */
    onchainSubmissionId: varchar({ length: 66 }),
    /** alamat EVM penerima reward (dari wallets pemenang saat award) */
    winnerAddress: varchar({ length: 42 }),
    awardTxHash: varchar({ length: 66 }),
    rank: smallint(),
    revisionCount: integer().notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("submissions_task_idx").on(t.taskId, t.status),
    index("submissions_user_idx").on(t.userId, t.status),
  ],
);

/** Riwayat revisi supaya audit trail submission tidak hilang saat diedit */
export const submissionRevisions = pgTable(
  "submission_revisions",
  {
    id: pk(),
    submissionId: uuid()
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    content: text(),
    links: jsonb().$type<string[]>(),
    note: text(),
    createdAt: createdAt(),
  },
  (t) => [index("submission_revisions_submission_idx").on(t.submissionId)],
);

/** Diskusi publik/privat di halaman task */
export const taskComments = pgTable(
  "task_comments",
  {
    id: pk(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    parentId: uuid(),
    userId: uuid()
      .notNull()
      .references(() => users.id),
    body: text().notNull(),
    /** hanya terlihat oleh owner dan penulis */
    isPrivate: boolean().notNull().default(false),
    deletedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("task_comments_task_idx").on(t.taskId)],
);

export const disputes = pgTable(
  "disputes",
  {
    id: pk(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    submissionId: uuid().references(() => submissions.id, {
      onDelete: "set null",
    }),
    raisedById: uuid()
      .notNull()
      .references(() => users.id),
    reason: text().notNull(),
    evidence: jsonb().$type<Record<string, unknown>>(),
    status: disputeStatus().notNull().default("open"),
    resolution: text(),
    resolvedById: uuid().references(() => users.id),
    resolvedAt: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("disputes_status_idx").on(t.status)],
);

/** Rating dua arah setelah task selesai */
export const ratings = pgTable(
  "ratings",
  {
    id: pk(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fromUserId: uuid()
      .notNull()
      .references(() => users.id),
    toUserId: uuid()
      .notNull()
      .references(() => users.id),
    score: smallint().notNull(),
    comment: text(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("ratings_unique").on(t.taskId, t.fromUserId, t.toUserId),
    index("ratings_to_user_idx").on(t.toUserId),
  ],
);

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  owner: one(users, { fields: [tasks.ownerId], references: [users.id] }),
  category: one(categories, {
    fields: [tasks.categoryId],
    references: [categories.id],
  }),
  rewardAsset: one(assets, {
    fields: [tasks.rewardAssetId],
    references: [assets.id],
  }),
  submissions: many(submissions),
  applications: many(taskApplications),
  comments: many(taskComments),
}));

export const submissionsRelations = relations(submissions, ({ one, many }) => ({
  task: one(tasks, { fields: [submissions.taskId], references: [tasks.id] }),
  user: one(users, { fields: [submissions.userId], references: [users.id] }),
  reviewer: one(users, {
    fields: [submissions.reviewerId],
    references: [users.id],
  }),
  revisions: many(submissionRevisions),
}));
