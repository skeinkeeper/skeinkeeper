ALTER TABLE `deletion_log` ADD `partial_success` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_log` ADD `manual_remainders` text;