import { Elysia, t } from "elysia";
import { paginationQuery, resolvePagination } from "../../common/http.ts";
import { authPlugin } from "../../plugins/auth.ts";
import { limits, rateLimitPlugin } from "../../plugins/rate-limit.ts";
import * as service from "./task.service.ts";

const amountSchema = t.String({
  pattern: "^[0-9]+$",
  description: "Nominal dalam base unit",
});

export const taskRoutes = new Elysia({ prefix: "/tasks", tags: ["Tasks"] })
  .use(authPlugin)
  .use(rateLimitPlugin)
  .get("/", ({ query }) => service.listTasks(query, resolvePagination(query)), {
    query: t.Composite([
      paginationQuery,
      t.Object({
        q: t.Optional(t.String({ maxLength: 120 })),
        type: t.Optional(
          t.Union([t.Literal("task"), t.Literal("bounty"), t.Literal("quest")]),
        ),
        status: t.Optional(t.String()),
        categorySlug: t.Optional(t.String()),
        ownerUsername: t.Optional(t.String()),
        minReward: t.Optional(amountSchema),
        verifiedOnly: t.Optional(t.Boolean()),
        sort: t.Optional(
          t.Union([
            t.Literal("newest"),
            t.Literal("reward"),
            t.Literal("deadline"),
          ]),
        ),
      }),
    ]),
    detail: { summary: "Feed task publik dengan filter & pagination" },
  })
  .get(
    "/mine",
    ({ user, query }) => service.listMyTasks(user, resolvePagination(query)),
    {
      auth: true,
      query: paginationQuery,
      detail: { summary: "Task yang saya buat" },
    },
  )
  .get(
    "/:id",
    ({ params, currentUser, query }) =>
      service.getTask(params.id, currentUser, query.token),
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ token: t.Optional(t.String()) }),
      detail: { summary: "Detail task (token diperlukan untuk task privat)" },
    },
  )
  .post(
    "/",
    async ({ user, body, set }) => {
      set.status = 201;
      return service.createTask(user, body);
    },
    {
      auth: true,
      rateLimit: limits.createTask,
      body: t.Object({
        type: t.Union([
          t.Literal("task"),
          t.Literal("bounty"),
          t.Literal("quest"),
        ]),
        title: t.String({ minLength: 5, maxLength: 200 }),
        description: t.String({ minLength: 20, maxLength: 20_000 }),
        categoryId: t.Optional(t.String({ format: "uuid" })),
        rewardAssetId: t.String({ format: "uuid" }),
        rewardAmount: amountSchema,
        minimumPayout: t.Optional(amountSchema),
        maxWinners: t.Optional(t.Integer({ minimum: 1, maximum: 1000 })),
        visibility: t.Optional(
          t.Union([
            t.Literal("public"),
            t.Literal("private"),
            t.Literal("unlisted"),
          ]),
        ),
        requiresVerified: t.Optional(t.Boolean()),
        autoApprove: t.Optional(t.Boolean()),
        allowMultipleSubmissions: t.Optional(t.Boolean()),
        deadlineAt: t.Optional(t.String({ format: "date-time" })),
        requirements: t.Optional(
          t.Array(t.Object({ label: t.String(), required: t.Boolean() }), {
            maxItems: 30,
          }),
        ),
        githubRepo: t.Optional(t.String({ maxLength: 200 })),
        githubIssueNumber: t.Optional(t.Integer()),
        githubIssueUrl: t.Optional(t.String({ format: "uri" })),
      }),
      detail: { summary: "Buat task (status pending_deposit, belum tayang)" },
    },
  )
  .post(
    "/:id/publish",
    ({ user, params, body }) =>
      service.publishTask(user, params.id, body ?? {}),
    {
      auth: true,
      params: t.Object({ id: t.String() }),
      body: t.Optional(
        t.Object({
          txHash: t.Optional(t.String({ pattern: "^0x[0-9a-fA-F]{64}$" })),
        }),
      ),
      detail: {
        summary: "Tayangkan task",
        description:
          "Aset ledger (Solana/off-chain): saldo owner dikunci ke escrow internal. " +
          "Aset EVM: owner memanggil fund() di kontrak lalu mengirim `txHash`-nya; " +
          "backend memverifikasi event BountyFunded sebelum task tayang.",
      },
    },
  )
  .post(
    "/:id/cancel",
    ({ user, params }) => service.cancelTask(user, params.id),
    {
      auth: true,
      params: t.Object({ id: t.String() }),
      detail: { summary: "Batalkan task dan refund escrow" },
    },
  );
