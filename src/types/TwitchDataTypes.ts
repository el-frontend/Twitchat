export namespace TwitchDataTypes {
	export interface ModeratorUser {
		user_id: string;
		user_login: string;
		user_name: string;
	}

	export interface Token {
		client_id: string;
		login: string;
		scopes: string[];
		user_id: string;
		expires_in: number;
	}

	export interface Error {
		status: number;
		message: string;
	}

	export interface StreamInfo {
		id: string;
		user_id: string;
		user_login: string;
		user_name: string;
		game_id: string;
		game_name: string;
		type: string;
		title: string;
		viewer_count: number;
		started_at: string;
		language: string;
		thumbnail_url: string;
		tag_ids: string[];
		//Custom tag
		user_info: UserInfo;
	}

	export interface ChannelInfo {
		broadcaster_id: string;
		broadcaster_login: string;
		broadcaster_name: string;
		broadcaster_language: string;
		game_id: string;
		game_name: string;
		title: string;
		delay: number;
	}

	export interface UserInfo {
		id: string;
		login: string;
		display_name: string;
		type: string;
		broadcaster_type: string;
		description: string;
		profile_image_url: string;
		offline_image_url: string;
		view_count: number;
		created_at: string;
	}

	export interface BadgesSet {
		versions: { [key: string]: Badge };
	}

	export interface Badge {
		id: string;
		title: string;
		click_action: string;
		click_url: string;
		description: string;
		image_url_1x: string;
		image_url_2x: string;
		image_url_4x: string;
	}

	export interface AuthTokenResult {
		access_token: string;
		expires_in: number;
		refresh_token: string;
		scope: string[];
		token_type: string;
		//Custom injected data
		expires_at: number;
	}

	export interface CheermoteSet {
		prefix: string;
		tiers: CheermoteTier[];
		type: string;
		order: number;
		last_updated: Date;
		is_charitable: boolean;
	}
	export interface CheermoteTier {
		min_bits: number;
		id: string;
		color: string;
		images: {
			dark: CheermoteImageSet;
			light: CheermoteImageSet;
		};
		can_cheer: boolean;
		show_in_bits_card: boolean;
	}

	export interface CheermoteImageSet {
		animated: CheermoteImage;
		static: CheermoteImage;
	}

	export interface CheermoteImage {
		"1": string;
		"2": string;
		"3": string;
		"4": string;
		"1.5": string;
	}

	export interface Poll {
		id: string;
		broadcaster_id: string;
		broadcaster_name: string;
		broadcaster_login: string;
		title: string;
		choices: PollChoice[];
		channel_points_voting_enabled: boolean;
		channel_points_per_vote: number;
		status: "ACTIVE" | "COMPLETED" | "TERMINATED" | "ARCHIVED" | "MODERATED" | "INVALID";
		duration: number;
		started_at: string;
		ended_at?: string;
	}

	export interface PollChoice {
		id: string;
		title: string;
		votes: number;
		channel_points_votes: number;
	}

	export interface HypeTrain {
		id: string;
		event_type: string;
		event_timestamp: Date;
		version: string;
		event_data: {
			broadcaster_id: string;
			cooldown_end_time: string;
			expires_at: string;
			goal: number;
			id: string;
			last_contribution: {
				total: number;
				type: string;
				user: string;
			};
			level: number;
			started_at: string;
			top_contributions: {
				total: number;
				type: string;
				user: string;
			};
			total: number;
		};
	}

	export interface Prediction {
		id: string;
		broadcaster_id: string;
		broadcaster_name: string;
		broadcaster_login: string;
		title: string;
		winning_outcome_id?: string;
		outcomes: PredictionOutcome[];
		prediction_window: number;
		status: "ACTIVE" | "RESOLVED" | "CANCELED" | "LOCKED";
		created_at: string;
		ended_at?: string;
		locked_at?: string;
	}

	export interface PredictionOutcome {
		id: string;
		title: string;
		users: number;
		channel_points: number;
		top_predictors?: PredictionPredictor[];
		color: string;
	}

	export interface PredictionPredictor {
		id: string;
		name: string;
		login: string;
		channel_points_used: number;
		channel_points_won: number;
	}

	export interface Emote {
		id: string;
		name: string;
		images: {
			url_1x: string;
			url_2x: string;
			url_4x: string;
		};
		emote_type: string;
		emote_set_id: string;
		owner_id: string;
		format: "static" | "animated";
		scale: "1.0" | "2.0" | "3.0";
		theme_mode: "light" | "dark";
	}
	export interface ParseMessageChunk {
		type: "text" | "emote";
		emote?: string;
		label?: string;
		value: string;
	}

	export interface Reward {
		broadcaster_name: string;
		broadcaster_login: string;
		broadcaster_id: string;
		id: string;
		image?: {
			url_1x: string;
			url_2x: string;
			url_4x: string;
		};
		background_color: string;
		is_enabled: boolean;
		cost: number;
		title: string;
		prompt: string;
		is_user_input_required: boolean;
		max_per_stream_setting: {
			is_enabled: boolean;
			max_per_stream: number;
		};
		max_per_user_per_stream_setting: {
			is_enabled: boolean;
			max_per_user_per_stream: number;
		};
		global_cooldown_setting: {
			is_enabled: boolean;
			global_cooldown_seconds: number;
		};
		is_paused: boolean;
		is_in_stock: boolean;
		default_image: {
			url_1x: string;
			url_2x: string;
			url_4x: string;
		};
		should_redemptions_skip_request_queue: boolean;
		redemptions_redeemed_current_stream?: number;
		cooldown_expires_at?: string;
	}

	export interface RewardRedemption {
		broadcaster_name: string;
		broadcaster_login: string;
		broadcaster_id: string;
		id: string;
		user_login: string;
		user_id: string;
		user_name: string;
		user_input: string;
		status: string;
		redeemed_at: string;
		reward: {
			id: string;
			title: string;
			prompt: string;
			cost: number;
		};
	}

	export interface Following {
		from_id: string;
		from_login: string;
		from_name: string;
		to_id: string;
		to_name: string;
		to_login: string;
		followed_at: string;
	}

	export interface Commercial {
		length: number;
		message: string;
		retry_after: number;
	}

	export interface Subscriber {
		broadcaster_id: string;
		broadcaster_login: string;
		broadcaster_name: string;
		gifter_id: string;
		gifter_login: string;
		gifter_name: string;
		is_gift: boolean;
		tier: string;
		plan_name: string;
		user_id: string;
		user_name: string;
		user_login: string;
	}

	export interface StreamCategory {
		id: string;
		name: string;
		box_art_url: string;
	}

	export interface StreamTag {
		tag_id: string;
		is_auto: boolean;
		localization_names: { [key: string]: string };
		localization_descriptions: { [key: string]: string };
	}

	export interface ClipInfo {
		broadcaster_id: string;
		broadcaster_name: string;
		created_at: string;
		creator_id: string;
		creator_name: string;
		duration: number;
		embed_url: string;
		game_id: string;
		id: string;
		language: string;
		thumbnail_url: string;
		title: string;
		url: string;
		video_id: string;
		view_count: number;
	}

	export interface BlockedUser {
		user_id:string;
		user_login:string;
		display_name:string;
	}

	export interface RoomSettingsUpdate {
		subOnly?:boolean;
		emotesOnly?:boolean;
		followOnly?:number|false;
		chatDelay?:number;
		slowMode?:number;
	}

	export interface RoomState {
		type: "notice";
		raw: string;
		prefix: string;
		command: string;
		params: string[];
		msgid:"followers_on"|"followers_off"|"subs_on"|"subs_off"|"emote_only_on"|"emote_only_off"|"slow_on"|"slow_off"
		tags: {
			"emote-only": boolean;
			"followers-only": string;
			r9k: boolean;
			rituals: boolean;
			"room-id": string;
			slow: boolean;
			"subs-only": boolean;
			channel: string;
		};
		markedAsRead?:boolean;
	}
}