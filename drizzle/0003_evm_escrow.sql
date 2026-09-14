ALTER TYPE "public"."chain" ADD VALUE 'monad' BEFORE 'offchain';--> statement-breakpoint
CREATE TABLE "chain_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"contract_address" varchar(42) NOT NULL,
	"last_block" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "onchain_submission_id" varchar(66);--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "winner_address" varchar(42);--> statement-breakpoint
ALTER TABLE "submissions" ADD COLUMN "award_tx_hash" varchar(66);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "onchain_task_id" varchar(66);--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "chain_id" integer;--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "contract_address" varchar(42);--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "onchain_bounty_id" varchar(66);--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "creator_address" varchar(42);--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "reviewer_address" varchar(42);--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "funding_tx_hash" varchar(66);--> statement-breakpoint
ALTER TABLE "escrows" ADD COLUMN "refund_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "chain_cursors_key" ON "chain_cursors" USING btree ("chain_id","contract_address");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_onchain_task_id_key" ON "tasks" USING btree ("onchain_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "escrows_onchain_bounty_key" ON "escrows" USING btree ("chain_id","onchain_bounty_id");