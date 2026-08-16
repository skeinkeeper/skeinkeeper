ALTER TABLE `player_character_map` ADD `foundry_user_id` text;--> statement-breakpoint
ALTER TABLE `player_character_map` ADD `foundry_user_id_hash` text;--> statement-breakpoint
CREATE INDEX `idx_pcm_tenant_campaign_foundry_user` ON `player_character_map` (`tenant_id`,`campaign_id`,`foundry_user_id`);--> statement-breakpoint
CREATE INDEX `idx_pcm_tenant_campaign_foundry_user_hash` ON `player_character_map` (`tenant_id`,`campaign_id`,`foundry_user_id_hash`);