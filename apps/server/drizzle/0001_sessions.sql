CREATE TABLE "iam_session" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id_token" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "iam_session" ADD CONSTRAINT "iam_session_user_id_fk_iam_user_id" FOREIGN KEY ("user_id") REFERENCES "public"."iam_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "iam_session_user_id_idx" ON "iam_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "iam_session_expires_at_idx" ON "iam_session" USING btree ("expires_at");