import StoreProxy from "@/store/StoreProxy";
import { TwitchatDataTypes } from "@/types/TwitchatDataTypes";
import { TwitchEventSubDataTypes } from "@/types/twitch/TwitchEventSubDataTypes";
import { LoremIpsum } from "lorem-ipsum";
import Config from "../Config";
import Logger from "../Logger";
import Utils from "../Utils";
import { TwitchScopes } from "./TwitchScopes";
import TwitchUtils from "./TwitchUtils";

/**
* Created : 02/12/2022
*/
export default class EventSub {

	private static _instance:EventSub;
	private socket!:WebSocket;
	private oldSocket!:WebSocket;
	private reconnectTimeout!:number;
	private keepalive_timeout_seconds!:number;
	private lastRecentFollowers:TwitchatDataTypes.MessageFollowingData[] = [];
	private debounceAutomodTermsUpdate:number = -1;
	private debouncedAutomodTerms:TwitchEventSubDataTypes.AutomodTermsUpdateEvent[] = [];
	private sessionID:string = "";
	private connectURL:string = "";
	private remoteChanSubscriptions:{[chanId:string]:string[]} = {};

	constructor() {
		this.connectURL = Config.instance.TWITCH_EVENTSUB_PATH;
	}

	/********************
	* GETTER / SETTERS *
	********************/
	static get instance():EventSub {
		if(!EventSub._instance) {
			EventSub._instance = new EventSub();
		}
		return EventSub._instance;
	}



	/******************
	* PUBLIC METHODS *
	******************/
	/**
	 * Connect to Eventsub
	 */
	public async connect(disconnectPrevious:boolean = true):Promise<void> {

		clearTimeout(this.reconnectTimeout);

		if(disconnectPrevious && this.socket) {
			this.cleanupSocket(this.socket);
		}

		//Delete all previous event sub subscriptions
		/*
		try {
			const subscriptions = await TwitchUtils.eventsubGetSubscriptions();
			await Utils.promisedTimeout(5000);
			for (let i = 0; i < subscriptions.length; i++) {
				const v = subscriptions[i];
				//Delete by batch of 10
				if(i%10 === 9) {
					await TwitchUtils.eventsubDeleteSubscriptions(v.id);
				}else{
					TwitchUtils.eventsubDeleteSubscriptions(v.id);
				}
			}
		}catch(error) {
			//It's not a big deal if this crashes, it's safe to ignore
		}
		//*/

		this.socket = new WebSocket(this.connectURL);

		this.socket.onopen = async () => { };

		this.socket.onmessage = (event:unknown) => {
			const e = event as {data:string};
			const message = JSON.parse(e.data);
			switch(message.metadata.message_type) {
				case "session_welcome": {
					this.keepalive_timeout_seconds = message.payload.session.keepalive_timeout_seconds;
					if(this.oldSocket) {
						this.cleanupSocket(this.oldSocket);
					}
					if(disconnectPrevious) {
						this.sessionID = message.payload.session.id;
						this.createSubscriptions();
					}
				}

				case "session_keepalive": {
					this.scheduleReconnect();
					break;
				}

				case "session_reconnect": {
					this.reconnect(message.payload.session.reconnect_url);
					break;
				}

				case "notification": {
					this.scheduleReconnect();
					this.parseEvent(message.metadata.subscription_type, message.payload);
					break;
				}

				default: {
					console.warn(`Unknown eventsub message type: ${message.metadata.message_type}`);
				}
			}
		};

		this.socket.onclose = (event) => {
			console.log("EVENTSUB : OnClose");
			//Twitch asked us to reconnect socket at a new URL, which we did
			//but disconnection of the old socket (current one) wasn't done.
			if(event.code == 4004) return;

			//Connection was created but we subscribed to no topic, twitch
			//closed the connection
			if(event.code == 4003) return;

			this.connectURL = Config.instance.TWITCH_EVENTSUB_PATH;

			// console.log("EVENTSUB : Closed");
			clearTimeout(this.reconnectTimeout)
			this.reconnectTimeout = setTimeout(()=>{
				this.connect();
			}, 1000);
		};

		this.socket.onerror = (error) => {
			console.log(error);
		};
	}

	/**
	 * Simulates a followbot raids.
	 * Sends lots of fake follow events in a short amount of time
	 */
	public async simulateFollowbotRaid():Promise<void> {
		const lorem = new LoremIpsum({ wordsPerSentence: { max: 40, min: 40 } });
		const me = StoreProxy.auth.twitch.user;
		for (let i = 0; i < 200; i++) {
			const id = i;//Math.round(Math.random()*1000000);
			const login = lorem.generateWords(Math.round(Math.random()*2)+1).split(" ").join("_");
			this.followEvent(TwitchEventSubDataTypes.SubscriptionTypes.FOLLOW, {
				user_id: id.toString(),
				user_login: login,
				user_name: login,
				broadcaster_user_id: me.id,
				broadcaster_user_login: me.login,
				broadcaster_user_name: me.displayName,
				followed_at: new Date().toString(),
			} as TwitchEventSubDataTypes.FollowEvent);
			if(Math.random() > .5) {
				await Utils.promisedTimeout(Math.random()*40);
			}
		}
	}

	/**
	 * Connect to remote chan.
	 * Will connect to appropriate topics depending on wether we're a mod
	 * of the given channel or not (make sure user.channelInfo[uid] is properly populated)
	 * @param user 
	 */
	public async connectRemoteChan(user:TwitchatDataTypes.TwitchatUser):Promise<void> {
		const me	= StoreProxy.auth.twitch.user;
		const uid	= user.id;
		const myUID	= me.id;
		const isBroadcaster	= me.id == user.id;
		const isMod	= me.channelInfo[uid]?.is_moderator === true || isBroadcaster;
		this.remoteChanSubscriptions[uid] = [];

		if(isBroadcaster){
			TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.CHANNEL_UPDATE, "2");

			//Don't need to listen for this event for anyone else but the broadcaster
			TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.RAID, "1", {from_broadcaster_user_id:uid});
			
			//Used by online/offline triggers
			TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.STREAM_ON, "1");
			TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.STREAM_OFF, "1");

			if(TwitchUtils.hasScopes([TwitchScopes.ADS_READ])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.AD_BREAK_BEGIN, "1");
			}

			if(TwitchUtils.hasScopes([TwitchScopes.LIST_REWARDS])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.AUTOMATIC_REWARD_REDEEM, "1");
				// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.REWARD_REDEEM, "1");
				// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.REWARD_REDEEM_UPDATE, "1");
			}
			/*
			if(TwitchUtils.hasScopes([TwitchScopes.MANAGE_POLLS])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.POLL_START, "1");
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.POLL_PROGRESS, "1");
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.POLL_END, "1");
			}
			if(TwitchUtils.hasScopes([TwitchScopes.MANAGE_PREDICTIONS])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.PREDICTION_START, "1");
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.PREDICTION_PROGRESS, "1");
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.PREDICTION_LOCK, "1");
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.PREDICTION_END, "1");
			}
			if(TwitchUtils.hasScopes([TwitchScopes.READ_HYPE_TRAIN])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.HYPE_TRAIN_START, "1");
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.HYPE_TRAIN_PROGRESS, "1");
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.HYPE_TRAIN_END, "1");
			}
			//*/

			//Not using those as IRC does it better
			// if(TwitchUtils.hasScope(TwitchScopes.LIST_SUBS)) {
				// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SUB, "1");
				// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SUB_END, "1");
				// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SUBGIFT, "1");
				// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.RESUB, "1");
			// }

			//Not using this as IRC does it better
			// if(TwitchUtils.hasScope(TwitchScopes.READ_CHEER)) {
				// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.BITS, "1");
			// }

			//Don't need it
			// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.REWARD_CREATE, "1");
			// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.REWARD_UPDATE, "1");
			// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.REWARD_DELETE, "1");
			// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.GOAL_START, "1");
			// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.GOAL_PROGRESS, "1");
			// TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.GOAL_END, "1");
		}

		if(isMod) {

			if(TwitchUtils.hasScopes([TwitchScopes.LIST_FOLLOWERS])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.FOLLOW, "2");
			}
			
			if(TwitchUtils.hasScopes([TwitchScopes.BLOCKED_TERMS,
			TwitchScopes.SET_ROOM_SETTINGS,
			TwitchScopes.UNBAN_REQUESTS,
			TwitchScopes.EDIT_BANNED,
			TwitchScopes.DELETE_MESSAGES,
			TwitchScopes.CHAT_WARNING,
			TwitchScopes.READ_MODERATORS,
			TwitchScopes.READ_VIPS])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.CHANNEL_MODERATE, "2")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
			}else{
				if(TwitchUtils.hasScopes([TwitchScopes.MODERATION_EVENTS])) {
					TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.BAN, "1")
					.then(res => {
						if(res !== false) this.remoteChanSubscriptions[uid].push(res)
					});
					TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.UNBAN, "1")
					.then(res => {
						if(res !== false) this.remoteChanSubscriptions[uid].push(res)
					});
				}
				if(TwitchUtils.hasScopes([TwitchScopes.UNBAN_REQUESTS])) {
					TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.UNBAN_REQUEST_NEW, "1");
					TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.UNBAN_REQUEST_RESOLVED, "1");
				}
				if(TwitchUtils.hasScopes([TwitchScopes.CHAT_WARNING])) {
					TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.CHAT_WARN_SENT, "1")
					.then(res => {
						if(res !== false) this.remoteChanSubscriptions[uid].push(res)
					});
				}
			}
			if(TwitchUtils.hasScopes([TwitchScopes.CHAT_WARNING])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.CHAT_WARN_ACKNOWLEDGE, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
			}

			if(TwitchUtils.hasScopes([TwitchScopes.SHIELD_MODE])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SHIELD_MODE_STOP, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SHIELD_MODE_START, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
			}

			if(TwitchUtils.hasScopes([TwitchScopes.SHOUTOUT])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SHOUTOUT_IN, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SHOUTOUT_OUT, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
			}

			if(TwitchUtils.hasScopes([TwitchScopes.CHAT_READ_EVENTSUB])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.CHAT_MESSAGES, "1", {user_id:uid})
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
			}

			if(TwitchUtils.hasScopes([TwitchScopes.AUTOMOD])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.AUTOMOD_TERMS_UPDATE, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.AUTOMOD_MESSAGE_UPDATE, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});

				if(!isBroadcaster) {
					//Only subbing to this as a moderator.
					//Broadcaster ues PubSub alternative that, to dates, gives more details.
					//Eventsub doesn't tell which part of the message triggered the automod.
					TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.AUTOMOD_MESSAGE_HELD, "1")
					.then(res => {
						if(res !== false) this.remoteChanSubscriptions[uid].push(res)
					});
				}
			}

			if(TwitchUtils.hasScopes([TwitchScopes.CHAT_WARNING])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.CHAT_WARN_ACKNOWLEDGE, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
			}

			if(TwitchUtils.hasScopes([TwitchScopes.SUSPICIOUS_USERS])) {
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SUSPICIOUS_USER_MESSAGE, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
				TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.SUSPICIOUS_USER_UPDATE, "1")
				.then(res => {
					if(res !== false) this.remoteChanSubscriptions[uid].push(res)
				});
			}
		}
			
		if(TwitchUtils.hasScopes([TwitchScopes.CHAT_READ_EVENTSUB])) {
			TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.CHAT_MESSAGES, "1", {user_id:uid});
		}

		TwitchUtils.eventsubSubscribe(uid, myUID, this.sessionID, TwitchEventSubDataTypes.SubscriptionTypes.RAID, "1", {to_broadcaster_user_id:uid})
		.then(res => {
			if(res !== false) this.remoteChanSubscriptions[uid].push(res)
		});
	}

	/**
	 * Disconnect from remote chan.
	 * Deletes all eventsub subscriptions related to given chan
	 * @param user 
	 */
	public async disconnectRemoteChan(user:TwitchatDataTypes.TwitchatUser):Promise<void> {
		console.log(user.displayName)
		console.log(this.remoteChanSubscriptions[user.id])
		if(!this.remoteChanSubscriptions[user.id]) return;
		this.remoteChanSubscriptions[user.id].forEach(id => {
			TwitchUtils.eventsubDeleteSubscriptions(id);
		})
		delete this.remoteChanSubscriptions[user.id];
	}



	/*******************
	* PRIVATE METHODS *
	*******************/
	/**
	 * Reconnects the socket without recreating all subscriptions
	 * when twitch sends a "session_reconnect" frame
	 * @param url
	 */
	private reconnect(url:string):void {
		this.oldSocket = this.socket;
		this.connectURL = url;
		this.connect(false);
	}

	/**
	 * Cleanups a socket connection
	 *
	 * @param socket
	 */
	private cleanupSocket(socket:WebSocket):void {
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		socket.onopen = null;
		socket.close();
	}

	/**
	 * Schedules a reconnect after requested duration of inactivity
	 */
	private scheduleReconnect():void {
		clearTimeout(this.reconnectTimeout);
		this.reconnectTimeout = setTimeout(()=>{
			console.log("EVENTSUB : Session keep alive not received within the expected timeframe");
			this.connect();
		}, (this.keepalive_timeout_seconds + 5) * 1000);
	}

	/**
	 * Create all eventsub subscriptions
	 */
	private async createSubscriptions():Promise<void> {
		console.log("EVENTSUB : Create subscriptions");
		this.connectRemoteChan( StoreProxy.auth.twitch.user );
	}

	/**
	 * Parse an event received from eventsub
	 */
	private parseEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, payload:TwitchEventSubDataTypes.Payload):void {

		switch(topic) {
			case TwitchEventSubDataTypes.SubscriptionTypes.CHANNEL_UPDATE: {
				this.updateStreamInfosEvent(topic, payload.event as TwitchEventSubDataTypes.ChannelUpdateEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.FOLLOW: {
				this.followEvent(topic, payload.event as TwitchEventSubDataTypes.FollowEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.SUB:
			case TwitchEventSubDataTypes.SubscriptionTypes.RESUB: {
				this.subscriptionEvent(topic, payload.event as TwitchEventSubDataTypes.SubEvent | TwitchEventSubDataTypes.SubRenewEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.BITS: {
				this.bitsEvent(topic, payload.event as TwitchEventSubDataTypes.BitsEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.RAID: {
				this.raidEvent(topic, payload.event as TwitchEventSubDataTypes.RaidEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.BAN: {
				this.banEvent(topic, payload.event as TwitchEventSubDataTypes.BanEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.UNBAN: {
				this.unbanEvent(topic, payload.event as TwitchEventSubDataTypes.UnbanEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.MODERATOR_ADD: {
				this.modAddEvent(topic, payload.event as TwitchEventSubDataTypes.ModeratorAddEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.MODERATOR_REMOVE: {
				this.modRemoveEvent(topic, payload.event as TwitchEventSubDataTypes.ModeratorRemoveEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.AUTOMATIC_REWARD_REDEEM: {
				this.automaticRewardRedeem(topic, payload.event as TwitchEventSubDataTypes.AutomaticRewardRedeemEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.AUTOMOD_TERMS_UPDATE: {
				this.automodTermsUpdate(topic, payload.event as TwitchEventSubDataTypes.AutomodTermsUpdateEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.AUTOMOD_MESSAGE_HELD: {
				this.automodMessageHeld(topic, payload.event as TwitchEventSubDataTypes.AutomodMessageHeldEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.AUTOMOD_MESSAGE_UPDATE: {
				this.automodMessageUpdate(topic, payload.event as TwitchEventSubDataTypes.AutomodMessageUpdateEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.SUSPICIOUS_USER_MESSAGE: {
				this.suspiciousUserMessage(topic, payload.event as TwitchEventSubDataTypes.SuspiciousUserMessage);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.SUSPICIOUS_USER_UPDATE: {
				this.suspiciousUserStateUpdate(topic, payload.event as TwitchEventSubDataTypes.SuspiciousUserStateUpdate);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.STREAM_ON:
			case TwitchEventSubDataTypes.SubscriptionTypes.STREAM_OFF: {
				this.streamStartStopEvent(topic, payload.event as TwitchEventSubDataTypes.StreamOnlineEvent | TwitchEventSubDataTypes.StreamOfflineEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.SHIELD_MODE_STOP:
			case TwitchEventSubDataTypes.SubscriptionTypes.SHIELD_MODE_START: {
				this.shieldModeEvent(topic, payload.event as TwitchEventSubDataTypes.ShieldModeStartEvent | TwitchEventSubDataTypes.ShieldModeStopEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.SHOUTOUT_IN:
			case TwitchEventSubDataTypes.SubscriptionTypes.SHOUTOUT_OUT: {
				this.shoutoutEvent(topic, payload.event as TwitchEventSubDataTypes.ShoutoutInEvent | TwitchEventSubDataTypes.ShoutoutOutEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.AD_BREAK_BEGIN: {
				this.adBreakEvent(topic, payload.event as TwitchEventSubDataTypes.AdBreakEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.UNBAN_REQUEST_NEW:
			case TwitchEventSubDataTypes.SubscriptionTypes.UNBAN_REQUEST_RESOLVED: {
				this.unbanRequestEvent(topic, payload.event as TwitchEventSubDataTypes.UnbanRequestEvent | TwitchEventSubDataTypes.UnbanRequestResolveEvent);
				break;
			}
			
			case TwitchEventSubDataTypes.SubscriptionTypes.CHANNEL_MODERATE: {
				this.moderationEvent(topic, payload.event as TwitchEventSubDataTypes.ModerationEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.CHAT_WARN_ACKNOWLEDGE: {
				this.warningAcknowledgeEvent(topic, payload.event as TwitchEventSubDataTypes.WarningAcknowledgeEvent);
				break;
			}

			case TwitchEventSubDataTypes.SubscriptionTypes.CHAT_WARN_SENT: {
				this.warningSendEvent(topic, payload.event as TwitchEventSubDataTypes.WarningSentEvent);
				break;
			}
		}
	}

	/**
	 * Called when enabling or disabling shield mode
	 * @param topic
	 * @param payload
	 */
	private shieldModeEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.ShieldModeStartEvent | TwitchEventSubDataTypes.ShieldModeStopEvent):void {
		const enabled	= topic === TwitchEventSubDataTypes.SubscriptionTypes.SHIELD_MODE_START;

		if(StoreProxy.stream.shieldModeEnabled == enabled) return;

		const message = StoreProxy.i18n.t("global.moderation_action.shield_"+(enabled?"on":"off"), {MODERATOR:event.moderator_user_name});

		const m:TwitchatDataTypes.MessageShieldMode = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
			user:StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.moderator_user_id, event.moderator_user_login, event.moderator_user_name),
			noticeId:TwitchatDataTypes.TwitchatNoticeType.SHIELD_MODE,
			message,
			enabled,
		};
		StoreProxy.chat.addMessage(m);
		StoreProxy.stream.shieldModeEnabled = enabled;

		//Sync emergency mod if requested
		if(StoreProxy.emergency.params.autoEnableOnShieldmode
		&& event.broadcaster_user_id == StoreProxy.auth.twitch.user.id) {
			StoreProxy.emergency.setEmergencyMode( enabled );
		}
	}

	/**
	 * Called when updating stream infos
	 * @param topic
	 * @param payload
	 */
	private async updateStreamInfosEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.ChannelUpdateEvent):Promise<void> {
		const title:string = event.title;
		const category:string = event.category_name;
		let tags:string[] = [];
		let started_at:number = 0;
		let viewers:number = 0;
		let live:boolean = false;
		//Loading data from channel as they're more complete than what EventSub gives us.
		//tags and viewer count are missing from EventSub data
		const [streamInfos] = await TwitchUtils.getCurrentStreamInfo([event.broadcaster_user_id]);
		if(streamInfos) {
			live = true;
			tags = streamInfos.tags;
			started_at = new Date(streamInfos.started_at).getTime();
			viewers = streamInfos.viewer_count;
		}else{
			const [chanInfo] = await TwitchUtils.getChannelInfo([event.broadcaster_user_id])
			tags = chanInfo.tags;
		}

		let infos = StoreProxy.stream.currentStreamInfo[event.broadcaster_user_id];
		
		if(!infos) {
			infos = StoreProxy.stream.currentStreamInfo[event.broadcaster_user_id] = {
				title,
				category,
				tags,
				started_at,
				viewers,
				live,
				user: StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.broadcaster_user_id, event.broadcaster_user_login, event.broadcaster_user_name),
				lastSoDoneDate:0,
			}
		}
		infos.title = title;
		infos.category = category;
		infos.tags = tags;
		infos.viewers = viewers;
		infos.live = live;

		if(event.broadcaster_user_id == StoreProxy.auth.twitch.user.id) {
			const categoryData = await TwitchUtils.getCategoryByID(event.category_id);
			StoreProxy.labels.updateLabelValue("STREAM_TITLE", title);
			StoreProxy.labels.updateLabelValue("STREAM_CATEGORY_NAME", category);
			StoreProxy.labels.updateLabelValue("STREAM_CATEGORY_COVER", categoryData.box_art_url);
			StoreProxy.labels.updateLabelValue("VIEWER_COUNT", viewers);
		}

		const message:TwitchatDataTypes.MessageStreamInfoUpdate = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
			message:StoreProxy.i18n.t("stream.notification", {TITLE:event.title, CATEGORY:event.category_name}),
			noticeId:TwitchatDataTypes.TwitchatNoticeType.STREAM_INFO_UPDATE,
			title:infos.title,
			category:infos.category
		}

		StoreProxy.chat.addMessage(message);
	}

	/**
	 * Called when someone follows
	 * @param topic
	 * @param payload
	 */
	private followEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.FollowEvent):void {
		if(StoreProxy.users.isAFollower("twitch", event.user_id)) return;

		const channelId = StoreProxy.auth.twitch.user.id;

		const message:TwitchatDataTypes.MessageFollowingData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id: channelId,
			type:TwitchatDataTypes.TwitchatMessageType.FOLLOWING,
			user: StoreProxy.users.getUserFrom("twitch", channelId, event.user_id, event.user_login, event.user_name, undefined, true),
			followed_at: Date.now(),
		};
		// message.user.channelInfo[channelId].online = true;

		this.lastRecentFollowers.push( message );
		if(this.lastRecentFollowers.length > 1) {
			//duration between 2 follow events to consider them as a follow streak
			const minDuration = 500;
			let dateOffset:number = this.lastRecentFollowers[0].followed_at;
			for (let i = 1; i < this.lastRecentFollowers.length; i++) {
				const f = this.lastRecentFollowers[i];
				//more than the minDuration has past, reset the streak
				if(f.followed_at - dateOffset > minDuration) {
					this.lastRecentFollowers = [];
					break;
				}
				dateOffset = f.followed_at;
			}
		}

		if(this.lastRecentFollowers.length > 20
		&& StoreProxy.emergency.params.enabled === true
		&& StoreProxy.emergency.emergencyStarted !== true
		&& StoreProxy.emergency.params.autoEnableOnFollowbot === true) {
			//Start emergency mode
			StoreProxy.emergency.setEmergencyMode(true);
		}


		//If emergency mode is enabled and we asked to automatically block
		//any new followser during that time, do it
		if(StoreProxy.emergency.emergencyStarted === true) {
			for (let i = 0; i < this.lastRecentFollowers.length; i++) {
				const followData = this.lastRecentFollowers[i];
				StoreProxy.emergency.addEmergencyFollower(followData);
			}
			this.lastRecentFollowers = [];
		}

		StoreProxy.chat.addMessage(message);
	}

	/**
	 * Called when subscribing to the channel.
	 * A subgift will appear as a normal gift with "is_gift" flag set to true but there's apparently no way
	 * to know who subgifted the user.
	 *
	 * @param topic
	 * @param event
	 */
	private subscriptionEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.SubEvent | TwitchEventSubDataTypes.SubRenewEvent):void {
		const sub = event as TwitchEventSubDataTypes.SubEvent;
		const renew = event as TwitchEventSubDataTypes.SubRenewEvent;

		//THIS IS AN UNTESTED DRAFT THAT IS NOT USED AT THE MOMENT BECAUSE IRC DOES IT BETTER

		const channel_id = event.broadcaster_user_id;
		const tier_n = parseInt(event.tier);
		const message:TwitchatDataTypes.MessageSubscriptionData = {
			platform:"twitch",
			type:TwitchatDataTypes.TwitchatMessageType.SUBSCRIPTION,
			id:Utils.getUUID(),
			channel_id,
			date:Date.now(),
			user:StoreProxy.users.getUserFrom("twitch", channel_id, event.user_id, event.user_login, event.user_name),
			tier: isNaN(tier_n)? "prime" : tier_n/1000 as 1|2|3,
			is_gift: sub.is_gift,
			is_giftUpgrade: false,
			is_resub: false,
			is_primeUpgrade: false,
			months:1,
			streakMonths:-1,
			totalSubDuration:-1,
			message_size:0,
		}

		if(renew.message) {
			const chunks			= TwitchUtils.parseMessageToChunks(renew.message.text, renew.message.emotes, true);
			message.message			= renew.message.text;
			message.message_chunks	= chunks;
			message.message_html	= TwitchUtils.messageChunksToHTML(chunks);
			message.message_size	= TwitchUtils.computeMessageSize(message.message_chunks);
		}
		StoreProxy.chat.addMessage(message);
	}

	/**
	 * Called when receiving bits
	 *
	 * @param topic
	 * @param event
	 */
	private async bitsEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.BitsEvent):Promise<void> {

		//THIS IS AN UNTESTED DRAFT THAT IS NOT USED AT THE MOMENT

		const channel_id = event.broadcaster_user_id;
		const chunks = TwitchUtils.parseMessageToChunks(event.message, undefined, true);
		await TwitchUtils.parseCheermotes(chunks, channel_id);
		const user = StoreProxy.users.getUserFrom("twitch", channel_id, event.user_id, event.user_login, event.user_name);
		const message:TwitchatDataTypes.MessageCheerData = {
			platform:"twitch",
			type:TwitchatDataTypes.TwitchatMessageType.CHEER,
			id:Utils.getUUID(),
			channel_id,
			date:Date.now(),
			user,
			bits:event.bits ?? -1,
			message:event.message,
			message_chunks:chunks,
			message_html: TwitchUtils.messageChunksToHTML(chunks),
			message_size:TwitchUtils.computeMessageSize(chunks),
			pinned:false,//TODO
			pinDuration_ms:0,//TODO
			pinLevel:0,//TODO
		}
		StoreProxy.chat.addMessage(message);
	}

	/**
	 * Called when receiving or doing a raid
	 *
	 * @param topic
	 * @param event
	 */
	private async raidEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.RaidEvent):Promise<void> {
		const me = StoreProxy.auth.twitch.user;
		console.log("RAIDING");
		if(event.from_broadcaster_user_id == me.id) {
			//Raid complete
			StoreProxy.stream.onRaidComplete();
		}else{
			//Raided by someone
			const user = StoreProxy.users.getUserFrom("twitch", event.to_broadcaster_user_id, event.from_broadcaster_user_id, event.from_broadcaster_user_login, event.from_broadcaster_user_name);
			user.channelInfo[event.to_broadcaster_user_id].is_raider = true;

			//Check current live info
			const [currentStream] = await TwitchUtils.getCurrentStreamInfo([event.from_broadcaster_user_id]);
			let isLive:boolean = false, title = "", category = "", duration = 0;
			if(currentStream) {
				isLive = true;
				title = currentStream.title;
				category = currentStream.game_name;
				duration = Date.now() - new Date(currentStream.started_at).getTime();
			}else{
				//No current live found, load channel info
				const [chanInfo] = await TwitchUtils.getChannelInfo([event.from_broadcaster_user_id]);
				if(chanInfo) {
					title = chanInfo.title;
					category = chanInfo.game_name;
				}
			}

			const message:TwitchatDataTypes.MessageRaidData = {
				platform:"twitch",
				type:TwitchatDataTypes.TwitchatMessageType.RAID,
				id:Utils.getUUID(),
				channel_id: event.to_broadcaster_user_id,
				date:Date.now(),
				user,
				viewers:event.viewers,
				stream:{
					wasLive:isLive,
					title,
					category,
					duration,
				}
			};
			StoreProxy.chat.addMessage(message);
		}
	}

	/**
	 * Called when banning a user either permanently or temporarilly
	 * @param topic
	 * @param event
	 */
	private async banEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.BanEvent):Promise<void> {
		const bannedUser	= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name)
		const moderator		= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.moderator_user_id, event.moderator_user_login, event.moderator_user_name);
		const m:TwitchatDataTypes.MessageBanData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.BAN,
			user:bannedUser,
			moderator,
			reason: event.reason ?? bannedUser.channelInfo[event.broadcaster_user_id].banReason,
		};

		if(!event.is_permanent) {
			m.duration_s = Math.round((new Date(event.ends_at).getTime() - new Date(event.banned_at).getTime()) / 1000);
		}

		await StoreProxy.users.flagBanned("twitch", event.broadcaster_user_id, event.user_id, m.duration_s);
		StoreProxy.chat.addMessage(m);
	}

	private unbanEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.UnbanEvent):void {
		const unbannedUser	= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name);
		const moderator		= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.moderator_user_id, event.moderator_user_login, event.moderator_user_name);
		const m:TwitchatDataTypes.MessageUnbanData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.UNBAN,
			user:unbannedUser,
			moderator,
		};

		StoreProxy.users.flagUnbanned("twitch", event.broadcaster_user_id, event.user_id);
		StoreProxy.chat.addMessage(m);
	}

	private modAddEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.ModeratorAddEvent):void {
		const modedUser	= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name);
		const moderator		= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.broadcaster_user_id, event.broadcaster_user_login, event.broadcaster_user_name);
		const m:TwitchatDataTypes.MessageModerationAction = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
			noticeId:TwitchatDataTypes.TwitchatNoticeType.MOD,
			user:modedUser,
			message: StoreProxy.i18n.t("global.moderation_action.modded_by", {USER:modedUser.displayName, MODERATOR:moderator.displayName}),
		};
		StoreProxy.users.flagMod("twitch", event.broadcaster_user_id, modedUser.id);
		StoreProxy.chat.addMessage(m);
	}

	/**
	 * Called when a moderator is removed
	 * @param topic 
	 * @param event 
	 */
	private modRemoveEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.ModeratorRemoveEvent):void {
		const modedUser		= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name);
		const moderator		= StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.broadcaster_user_id, event.broadcaster_user_login, event.broadcaster_user_name);
		const m:TwitchatDataTypes.MessageModerationAction = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
			noticeId:TwitchatDataTypes.TwitchatNoticeType.MOD,
			user:modedUser,
			message: StoreProxy.i18n.t("global.moderation_action.unmodded_by", {USER:modedUser.displayName, MODERATOR:moderator.displayName}),
		};
		StoreProxy.users.flagUnmod("twitch", event.broadcaster_user_id, modedUser.id);
		StoreProxy.chat.addMessage(m);
	}
	
	/**
	 * Called when redeeming an automatic reward (used only for "celebration" for now)
	 * @param topic 
	 * @param payload 
	 */
	private automaticRewardRedeem(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.AutomaticRewardRedeemEvent):void {
		if(event.reward.type != "celebration") return;

		const user = StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name);
		const m:TwitchatDataTypes.MessageTwitchCelebrationData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.TWITCH_CELEBRATION,
			user,
			cost:event.reward.cost!,
			emoteID:event.reward.unlocked_emote?.id
		};
		StoreProxy.chat.addMessage(m);
	}

	/**
	 * Called when stream starts or stops
	 * @param topic
	 * @param event
	 */
	private async streamStartStopEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.StreamOnlineEvent | TwitchEventSubDataTypes.StreamOfflineEvent):Promise<void> {
		const streamInfo = StoreProxy.stream.currentStreamInfo[event.broadcaster_user_id]!;
		streamInfo.live = topic === TwitchEventSubDataTypes.SubscriptionTypes.STREAM_ON;
		const message:TwitchatDataTypes.MessageStreamOnlineData | TwitchatDataTypes.MessageStreamOfflineData = {
			date:Date.now(),
			id:Utils.getUUID(),
			platform:"twitch",
			type:TwitchatDataTypes.TwitchatMessageType.STREAM_ONLINE,
			info: streamInfo,
			channel_id:event.broadcaster_user_id,
		}

		//Stream offline
		if(topic === TwitchEventSubDataTypes.SubscriptionTypes.STREAM_OFF) {
			StoreProxy.stream.setPlaybackState(event.broadcaster_user_id, undefined);
			StoreProxy.stream.setStreamStop(event.broadcaster_user_id);
			((message as unknown) as TwitchatDataTypes.MessageStreamOfflineData).type = TwitchatDataTypes.TwitchatMessageType.STREAM_OFFLINE;

		//Stream online
		}else if(topic === TwitchEventSubDataTypes.SubscriptionTypes.STREAM_ON) {
			//Load stream info
			const [streamInfo] = await TwitchUtils.getCurrentStreamInfo([event.broadcaster_user_id]);
			if(streamInfo) {
				message.info.started_at = new Date(streamInfo.started_at).getTime();
				message.info.live = true;
				message.info.title = streamInfo.title;
				message.info.category = streamInfo.game_name;
			}else{
				//Fallback to channel info if API isn't synchronized yet
				const [chanInfo] = await TwitchUtils.getChannelInfo([event.broadcaster_user_id]);
				message.info.started_at = Date.now();
				message.info.live = true;
				message.info.title = chanInfo.title;
				message.info.category = chanInfo.game_name;
			}
			StoreProxy.stream.setStreamStart(event.broadcaster_user_id, message.info.started_at);
		}
		StoreProxy.chat.addMessage(message);
		StoreProxy.stream.currentStreamInfo[event.broadcaster_user_id] = streamInfo;
	}

	/**
	 * Called when stream starts or stops
	 * @param topic
	 * @param event
	 */
	private async shoutoutEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.ShoutoutInEvent | TwitchEventSubDataTypes.ShoutoutOutEvent):Promise<void> {
		const so_in		= event as TwitchEventSubDataTypes.ShoutoutInEvent;
		const so_out	= event as TwitchEventSubDataTypes.ShoutoutOutEvent;

		const received = topic == TwitchEventSubDataTypes.SubscriptionTypes.SHOUTOUT_IN;
		let user!:TwitchatDataTypes.TwitchatUser;
		let moderator = user;
		if(received) {
			user		= StoreProxy.users.getUserFrom("twitch", so_in.broadcaster_user_id, so_in.from_broadcaster_user_id, so_in.from_broadcaster_user_login, so_in.from_broadcaster_user_name);
		}else{
			user		= StoreProxy.users.getUserFrom("twitch", so_out.broadcaster_user_id, so_out.to_broadcaster_user_id, so_out.to_broadcaster_user_login, so_out.to_broadcaster_user_name);
			moderator	= StoreProxy.users.getUserFrom("twitch", so_out.broadcaster_user_id, so_out.moderator_user_id, so_out.moderator_user_login, so_out.moderator_user_name);
		}

		let title:string = "";
		let category:string = "";
		const [stream] = await TwitchUtils.getCurrentStreamInfo([user.id]);
		if(!stream) {
			const [channel] = await TwitchUtils.getChannelInfo([user.id]);
			title = channel.title;
			category = channel.game_name;
		}else{
			title = stream.title;
			category = stream.game_name;
		}

		const channel_id = event.broadcaster_user_id;
		const message:TwitchatDataTypes.MessageShoutoutData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id,
			type:TwitchatDataTypes.TwitchatMessageType.SHOUTOUT,
			user,
			viewerCount:event.viewer_count,
			stream: {
				category,
				title,
			},
			moderator,
			received,
		};
		StoreProxy.chat.addMessage(message);

		//If it's a sent shoutout, cleanup first pending SO found for this user
		if(!received) {
			StoreProxy.stream.currentStreamInfo[channel_id]!.lastSoDoneDate = Date.now();

			console.log("ES : Shoutout sent");
			let list = StoreProxy.users.pendingShoutouts[channel_id];
			if(!list) list = [];
			const index = list.findIndex(v=>v.user.id === user.id);
			//Set the last SO date of the user
			user.channelInfo[channel_id].lastShoutout = Date.now();
			if(index > -1) {
				console.log("ES : Remove item", list[index]);
				//Update existing item
				list.splice(index, 1);
			}
			StoreProxy.users.pendingShoutouts[channel_id] = list;
		}
	}

	/**
	 * Called when an Ad break is started.
	 * Either manually or automatically.
	 */
	private adBreakEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.AdBreakEvent):void {
		const infos = StoreProxy.stream.getCommercialInfo(event.broadcaster_user_id);
		//Thank you twitch for writing a completely wrong documentation...
		//don't know if they'll change the doc or the service, so i handle both cases
		infos.nextAdStart_at = new Date(typeof event.started_at == "number"? event.started_at * 1000 : event.started_at).getTime(),
		infos.currentAdDuration_ms = event.duration_seconds * 1000;
		let starter:TwitchatDataTypes.TwitchatUser | undefined = undefined;
		//Don't show notification if ad started by ourself or automatically
		if(!event.is_automatic && event.broadcaster_user_id != event.requester_user_id) {
			starter = StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.requester_user_id, event.requester_user_login);
		}
		Logger.instance.log("ads", {
			es:event,
			internal:infos,
		})
		StoreProxy.stream.setCommercialInfo(event.broadcaster_user_id, infos, starter, true);

		setTimeout(() => {
			TwitchUtils.getAdSchedule()
		}, infos.currentAdDuration_ms + 60000);
	}

	/**
	 * Called when receiving a new unban request or when resolving an existing one
	 * @param topic
	 * @param event
	 */
	private async unbanRequestEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.UnbanRequestEvent | TwitchEventSubDataTypes.UnbanRequestResolveEvent):Promise<void> {
		let message:TwitchatDataTypes.MessageUnbanRequestData = {
			channel_id:event.broadcaster_user_id,
			date:Date.now(),
			id:Utils.getUUID(),
			platform:"twitch",
			type:TwitchatDataTypes.TwitchatMessageType.UNBAN_REQUEST,
			user:await StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name),
			isResolve:false,
			message:"",
		}
		if(topic == TwitchEventSubDataTypes.SubscriptionTypes.UNBAN_REQUEST_NEW) {
			event = event as TwitchEventSubDataTypes.UnbanRequestEvent;
			message.message = event.text;

		}else if(topic == TwitchEventSubDataTypes.SubscriptionTypes.UNBAN_REQUEST_RESOLVED) {
			event = event as TwitchEventSubDataTypes.UnbanRequestResolveEvent;
			message.isResolve	= true;
			message.moderator	= await StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id,
																		//Falling back to broadcaster info if moderator info are missing
																		//(Until Twitch fixes it, "accept" event is broken for now and misses moderator info.)
																		event.moderator_user_id || event.broadcaster_user_id,
																		event.moderator_user_login || event.broadcaster_user_login,
																		event.moderator_user_name || event.broadcaster_user_name),
			message.message		= event.resolution_text;
			message.accepted	= event.status != "denied";
		}
		StoreProxy.chat.addMessage(message);
	}
	
	/**
	 * Called when automod terms are updated
	 * @param topic 
	 * @param event 
	 */
	private async automodTermsUpdate(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.AutomodTermsUpdateEvent):Promise<void> {
		//Debounce events and merge them
		this.debouncedAutomodTerms.push(event);
		clearTimeout(this.debounceAutomodTermsUpdate);
		this.debounceAutomodTermsUpdate = setTimeout(async () => {
			//Sort events by moderators
			const grouped:{[channelModAction:string]:TwitchEventSubDataTypes.AutomodTermsUpdateEvent[]} = {};
			this.debouncedAutomodTerms.forEach((t)=> {
				const key = t.broadcaster_user_id+"_"+t.moderator_user_id+"_"+t.action;
				if(!grouped[key]) grouped[key] = [];
				grouped[key].push(t);
			});

			this.debouncedAutomodTerms = [];

			for (const key in grouped) {
				const group = grouped[key];
				const ref = group[0];
				const message:TwitchatDataTypes.MessageBlockedTermsData = {
					channel_id:ref.broadcaster_user_id,
					date:Date.now(),
					id:Utils.getUUID(),
					platform:"twitch",
					type:TwitchatDataTypes.TwitchatMessageType.BLOCKED_TERMS,
					user:await StoreProxy.users.getUserFrom("twitch", ref.broadcaster_user_id, ref.moderator_user_id, ref.moderator_user_login, ref.moderator_user_name),
					action:ref.action,
					terms:group.map(v=>v.terms).flat(),
					temporary: event.from_automod === true,
				}
				StoreProxy.chat.addMessage(message);
			}
		}, 1000);
	}
	
	/**
	 * Called when a message is held by automod
	 * @param topic 
	 * @param event 
	 */
	private async automodMessageHeld(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.AutomodMessageHeldEvent):Promise<void> {
		console.log("MESSAGE HELD", event)
		// const reasons:string[] = [];
		// for (let i = 0; i < event.fragments.length; i++) {
		// 	const f = event.fragments[i];
		// 	if(!f.automod) continue;
		// 	for (const key in f.automod.topics) {
		// 		if(reasons.indexOf(key) == -1) reasons.push(key);
		// 	}
		// }

		//Build usable emotes set
		const chunks:TwitchatDataTypes.ParseMessageChunk[] = [];
		const words:string[] = [];
		for (let i = 0; i < event.message.fragments.length; i++) {
			const el = event.message.fragments[i];
			if(el.type == "emote") {
				chunks.push({
					type:"emote",
					value:el.text,
					emote:"https://static-cdn.jtvnw.net/emoticons/v2/"+el.emote.id+"/default/light/2.0",
					emoteHD:"https://static-cdn.jtvnw.net/emoticons/v2/"+el.emote.id+"/default/light/4.0",
				});
			//Not supported by eventsub :(
			// }else if(el.automod) {
			// 	chunks.push({
			// 		type:"highlight",
			// 		value:el.text,
			// 	});
			// 	words.push(el.text);
			}else if(el.text) {
				chunks.push({
					type:"text",
					value:el.text,
				});
			}
		}

		const userData = StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.broadcaster_user_name);
		const messageHtml = TwitchUtils.messageChunksToHTML(chunks);
		const m:TwitchatDataTypes.MessageChatData = {
			id:event.message_id,
			channel_id:event.broadcaster_user_id,
			date:Date.now(),
			type:TwitchatDataTypes.TwitchatMessageType.MESSAGE,
			platform:"twitch",
			user:userData,
			answers:[],
			message:event.message_id,
			message_chunks:chunks,
			message_html:messageHtml,
			message_size:0,
			twitch_automod:{ reasons:[event.category], words },
			is_short:false,
		};
		m.message_size = TwitchUtils.computeMessageSize(m.message_chunks);
		StoreProxy.chat.addMessage(m);
	}
	
	/**
	 * Called when the status of a message held by automod is updated
	 * @param topic 
	 * @param event 
	 */
	private async automodMessageUpdate(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.AutomodMessageUpdateEvent):Promise<void> {
		//Delete it even if allowed as it's actually sent back via IRC
		StoreProxy.chat.deleteMessageByID(event.message_id, undefined, false);
	}

	/**
	 * Called when a moderation event happens
	 * @param topic 
	 * @param event 
	 */
	private async moderationEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.ModerationEvent):Promise<void> {
		const user = StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.broadcaster_user_id, event.broadcaster_user_login, event.broadcaster_user_name);
		const moderator = StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.moderator_user_id, event.moderator_user_login, event.moderator_user_name);
		switch(event.action) {
			case "raid":{
				const raidedUSer = StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.raid.user_id, event.raid.user_login, event.raid.user_login)

				//Load user's avatar if not already available
				if(!raidedUSer.avatarPath) {
					const res = (await TwitchUtils.getUserInfo([raidedUSer.id]))[0];
					raidedUSer.avatarPath = res.profile_image_url;
				}

				const m:TwitchatDataTypes.RaidInfo = {
					channel_id: event.broadcaster_user_id,
					user: StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.raid.user_id, event.raid.user_login, event.raid.user_login),
					viewerCount: event.raid.viewer_count,
					startedAt: Date.now(),
					timerDuration_s: 90,
				};
				StoreProxy.stream.setRaiding(m);
				break;
			}
			case "unraid":{
				StoreProxy.stream.setRaiding();
				break;
			}

			case "followers":
			case "followersoff": {
				const settings:TwitchatDataTypes.IRoomSettings = {}
				settings.followOnly = event.action == "followers"? event.followers.follow_duration_minutes : false;
				StoreProxy.stream.setRoomSettings(event.broadcaster_user_id, settings);
				break;
			}

			case "emoteonly":
			case "emoteonlyoff": {
				const settings:TwitchatDataTypes.IRoomSettings = {}
				settings.emotesOnly = event.action == "emoteonly";
				StoreProxy.stream.setRoomSettings(event.broadcaster_user_id, settings);
				break;
			}

			case "slow":
			case "slowoff": {
				const settings:TwitchatDataTypes.IRoomSettings = {}
				settings.slowMode = event.action == "slow"? event.slow.wait_time_seconds : 0;
				StoreProxy.stream.setRoomSettings(event.broadcaster_user_id, settings);
				break;
			}

			case "subscribers":
			case "subscribersoff": {
				const settings:TwitchatDataTypes.IRoomSettings = {}
				settings.subOnly = event.action == "subscribers";
				StoreProxy.stream.setRoomSettings(event.broadcaster_user_id, settings);
				break;
			}

			case "warn":{
				this.warningSendEvent(topic, {
					broadcaster_user_id: event.broadcaster_user_id,
					broadcaster_user_login: event.broadcaster_user_login,
					broadcaster_user_name: event.broadcaster_user_name,
					user_id: event.warn.user_id,
					user_login: event.warn.user_login,
					user_name: event.warn.user_name,
					moderator_user_id: event.moderator_user_id,
					moderator_user_login: event.moderator_user_login,
					moderator_user_name: event.moderator_user_name,
					reason: event.warn.reason,
					chat_rules_cited:event.warn.chat_rules_cited,
				});
				break;
			}

			case "vip":
			case "unvip":{
				let user:TwitchatDataTypes.TwitchatUser;
				if(event.action == "vip") {
					user = StoreProxy.users.getUserFrom("twitch", event.vip.user_id, event.vip.user_id, event.vip.user_login);
				}else{
					user = StoreProxy.users.getUserFrom("twitch", event.unvip.user_id, event.unvip.user_id, event.unvip.user_login);
				}
				const m:TwitchatDataTypes.MessageModerationAction = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitch",
					channel_id:event.broadcaster_user_id,
					type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
					user,
					noticeId:TwitchatDataTypes.TwitchatNoticeType.VIP,
					message: StoreProxy.i18n.t(event.action == "vip"? "chat.vip.add" : "chat.vip.remove", {USER:user.displayName, MODERATOR:moderator.displayName}),
				};
				StoreProxy.chat.addMessage(m);
				break;
			}

			case "mod":
			case "unmod":{
				let user:TwitchatDataTypes.TwitchatUser;
				if(event.action == "mod") {
					user = StoreProxy.users.getUserFrom("twitch", event.mod.user_id, event.mod.user_id, event.mod.user_login);
				}else{
					user = StoreProxy.users.getUserFrom("twitch", event.unmod.user_id, event.unmod.user_id, event.unmod.user_login);
				}
				const m:TwitchatDataTypes.MessageModerationAction = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitch",
					channel_id:event.broadcaster_user_id,
					type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
					user,
					noticeId:TwitchatDataTypes.TwitchatNoticeType.VIP,
					message: StoreProxy.i18n.t(event.action == "mod"? "chat.mod.add" : "chat.mod.remove", {USER:user.displayName, MODERATOR:moderator.displayName}),
				};
				StoreProxy.chat.addMessage(m);
				break;
			}

			case "ban":{
				this.banEvent(topic, {
					banned_at:new Date().toString(),
					broadcaster_user_id:event.broadcaster_user_id,
					broadcaster_user_login:event.broadcaster_user_login,
					broadcaster_user_name:event.broadcaster_user_name,
					moderator_user_id:event.moderator_user_id,
					moderator_user_login:event.moderator_user_login,
					moderator_user_name:event.moderator_user_name,
					is_permanent:true,
					ends_at:"",
					reason:event.ban.reason,
					user_id:event.ban.user_id,
					user_login:event.ban.user_login,
					user_name:event.ban.user_name,
				});
				break;
			}

			case "unban":{
				this.unbanEvent(topic, {
					broadcaster_user_id:event.broadcaster_user_id,
					broadcaster_user_login:event.broadcaster_user_login,
					broadcaster_user_name:event.broadcaster_user_name,
					moderator_user_id:event.moderator_user_id,
					moderator_user_login:event.moderator_user_login,
					moderator_user_name:event.moderator_user_name,
					user_id:event.unban.user_id,
					user_login:event.unban.user_login,
					user_name:event.unban.user_name,
				});
				break;
			}

			case "timeout":{
				this.banEvent(topic, {
					banned_at:new Date().toString(),
					broadcaster_user_id:event.broadcaster_user_id,
					broadcaster_user_login:event.broadcaster_user_login,
					broadcaster_user_name:event.broadcaster_user_name,
					moderator_user_id:event.moderator_user_id,
					moderator_user_login:event.moderator_user_login,
					moderator_user_name:event.moderator_user_name,
					is_permanent:false,
					ends_at:event.timeout.expires_at,
					reason:event.timeout.reason,
					user_id:event.timeout.user_id,
					user_login:event.timeout.user_login,
					user_name:event.timeout.user_name,
				});
				break;
			}

			case "untimeout":{
				this.unbanEvent(topic, {
					broadcaster_user_id:event.broadcaster_user_id,
					broadcaster_user_login:event.broadcaster_user_login,
					broadcaster_user_name:event.broadcaster_user_name,
					moderator_user_id:event.moderator_user_id,
					moderator_user_login:event.moderator_user_login,
					moderator_user_name:event.moderator_user_name,
					user_id:event.untimeout.user_id,
					user_login:event.untimeout.user_login,
					user_name:event.untimeout.user_name,
				});
				break;
			}
			
			default: {
				console.log(event);
			}
		}
	}

	/**
	 * Called when a user acknowledged a warning
	 * @param topic 
	 * @param event 
	 */
	private async warningAcknowledgeEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.WarningAcknowledgeEvent):Promise<void> {
		const message:TwitchatDataTypes.MessageWarnAcknowledgementData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			type:TwitchatDataTypes.TwitchatMessageType.WARN_ACKNOWLEDGE,
			channel_id:event.broadcaster_user_id,
			user:StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name),
		}
		StoreProxy.chat.addMessage(message);
	}

	/**
	 * Called when a user is sent a warning a warning
	 * @param topic 
	 * @param event 
	 */
	private async warningSendEvent(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.WarningSentEvent):Promise<void> {
		const moderator = StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.moderator_user_id, event.moderator_user_login, event.moderator_user_name)
		const message:TwitchatDataTypes.MessageWarnUserData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			type:TwitchatDataTypes.TwitchatMessageType.WARN_CHATTER,
			channel_id:event.broadcaster_user_id,
			user:StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name),
			moderator,
			rules:event.chat_rules_cited,
			customReason:event.reason? event.reason : undefined,
			abstractedReason:event.reason? event.reason : event.chat_rules_cited.join(" - "),
		}
		StoreProxy.chat.addMessage(message);
	}

	/**
	 * Called when a user suspicious/restricted user sends a message
	 * @param topic 
	 * @param event 
	 */
	private async suspiciousUserMessage(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.SuspiciousUserMessage):Promise<void> {
		if(event.low_trust_status == "restricted") {
			const channelId = event.broadcaster_user_id;
			const userData = StoreProxy.users.getUserFrom("twitch", channelId, event.user_id, event.user_login, event.user_name);
			const chunks = TwitchUtils.parseMessageToChunks(event.message.text);
			const m:TwitchatDataTypes.MessageChatData = {
				id:event.message.message_id,
				channel_id:channelId,
				date:Date.now(),
				type:TwitchatDataTypes.TwitchatMessageType.MESSAGE,
				platform:"twitch",
				user:userData,
				answers:[],
				message:event.message.text,
				message_chunks:chunks,
				message_html:TwitchUtils.messageChunksToHTML(chunks),
				message_size: TwitchUtils.computeMessageSize(chunks),
				twitch_isRestricted:true,
				is_short:false,
			};

			const users = await TwitchUtils.getUserInfo(event.shared_ban_channel_ids);
			m.twitch_sharedBanChannels = users?.map(v=> { return {id:v.id, login:v.login}}) ?? [];
			StoreProxy.chat.addMessage(m);
		}else{
			StoreProxy.chat.flagSuspiciousMessage(event.message.message_id, event.shared_ban_channel_ids);
		}
	}

	/**
	 * Called when a user suspicious/restricted user sends a message
	 * @param topic 
	 * @param event 
	 */
	private async suspiciousUserStateUpdate(topic:TwitchEventSubDataTypes.SubscriptionStringTypes, event:TwitchEventSubDataTypes.SuspiciousUserStateUpdate):Promise<void> {
		const m:TwitchatDataTypes.MessageLowtrustTreatmentData = {
			id:Utils.getUUID(),
			date:Date.now(),
			platform:"twitch",
			channel_id:event.broadcaster_user_id,
			type:TwitchatDataTypes.TwitchatMessageType.LOW_TRUST_TREATMENT,
			user:StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.user_id, event.user_login, event.user_name),
			moderator:StoreProxy.users.getUserFrom("twitch", event.broadcaster_user_id, event.moderator_user_id, event.moderator_user_login, event.moderator_user_name),
			restricted:event.low_trust_status == "restricted",
			monitored:event.low_trust_status == "active_monitoring",
		};
		StoreProxy.chat.addMessage(m);
	}

}
