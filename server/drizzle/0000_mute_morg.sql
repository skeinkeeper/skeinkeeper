CREATE TABLE `consents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`purpose` text NOT NULL,
	`consent_text_version` text NOT NULL,
	`action` text NOT NULL,
	`timestamp` integer NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `consents_tenant_subject` ON `consents` (`tenant_id`,`subject_id`);--> statement-breakpoint
CREATE TABLE `deletion_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`scope` text NOT NULL,
	`subject_id_hash` text NOT NULL,
	`adapter_name` text NOT NULL,
	`records_deleted` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `deletion_log_tenant_time` ON `deletion_log` (`tenant_id`,`timestamp`);