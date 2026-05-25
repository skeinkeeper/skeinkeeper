ALTER TABLE `dialogue` ADD `speaker_hash` text;--> statement-breakpoint
CREATE INDEX `dialogue_speaker_hash` ON `dialogue` (`tenant_id`,`speaker_hash`);--> statement-breakpoint
ALTER TABLE `player_character_map` ADD `discord_user_id_hash` text;--> statement-breakpoint
CREATE INDEX `pcmap_tenant_campaign_player_hash` ON `player_character_map` (`tenant_id`,`campaign_id`,`discord_user_id_hash`);--> statement-breakpoint
CREATE INDEX `pcmap_tenant_player_hash` ON `player_character_map` (`tenant_id`,`discord_user_id_hash`);--> statement-breakpoint
ALTER TABLE `consents` ADD `subject_id_hash` text;--> statement-breakpoint
CREATE INDEX `consents_tenant_subject_hash` ON `consents` (`tenant_id`,`subject_id_hash`);