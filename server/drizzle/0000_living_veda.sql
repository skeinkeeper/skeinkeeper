CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`ruleset_id` text NOT NULL,
	`behavior_spec_version` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `campaigns_tenant` ON `campaigns` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`behavior_spec_version` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`summary_json` text,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_campaign` ON `sessions` (`tenant_id`,`campaign_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text,
	`turn_id` text,
	`actor` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_tenant_time` ON `audit_log` (`tenant_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `audit_log_session` ON `audit_log` (`tenant_id`,`session_id`);--> statement-breakpoint
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
CREATE INDEX `deletion_log_tenant_time` ON `deletion_log` (`tenant_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `quest_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quest_flags_campaign_key` ON `quest_flags` (`tenant_id`,`campaign_id`,`key`);