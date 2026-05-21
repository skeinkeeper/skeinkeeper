ALTER TABLE `dialogue` ADD `audience` text DEFAULT 'table' NOT NULL;--> statement-breakpoint
ALTER TABLE `dialogue` ADD `conversation_id` text DEFAULT 'table' NOT NULL;--> statement-breakpoint
CREATE INDEX `dialogue_conversation` ON `dialogue` (`tenant_id`,`session_id`,`conversation_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `dialogue_audience` ON `dialogue` (`tenant_id`,`audience`);