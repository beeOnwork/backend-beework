ALTER TYPE "public"."account_owner_type" ADD VALUE 'external';--> statement-breakpoint
ALTER TYPE "public"."account_owner_type" ADD VALUE 'hold';--> statement-breakpoint
ALTER TABLE "accounts" DROP COLUMN "locked";