CREATE TABLE `session_intake_finding` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`session_id` text NOT NULL,
	`finding_code` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	`dm_only` integer NOT NULL,
	`resolution_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sif_tenant_session` ON `session_intake_finding` (`tenant_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `sif_tenant_campaign` ON `session_intake_finding` (`tenant_id`,`campaign_id`);