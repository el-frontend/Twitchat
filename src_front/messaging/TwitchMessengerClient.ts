import rewardImg from '@/assets/icons/reward_highlight.svg';
import StoreProxy from "@/store/StoreProxy";
import type { TwitchDataTypes } from "@/types/twitch/TwitchDataTypes";
import { TwitchatDataTypes } from "@/types/TwitchatDataTypes";
import ChatCypherPlugin from "@/utils/ChatCypherPlugin";
import BTTVUtils from "@/utils/emotes/BTTVUtils";
import FFZUtils from "@/utils/emotes/FFZUtils";
import SevenTVUtils from "@/utils/emotes/SevenTVUtils";
import { EventDispatcher } from "@/utils/EventDispatcher";
import TwitchUtils from "@/utils/twitch/TwitchUtils";
import Utils from "@/utils/Utils";
import * as tmi from "tmi.js";
import MessengerClientEvent from "./MessengerClientEvent";

/**
* Created : 25/09/2022 
*/
export default class TwitchMessengerClient extends EventDispatcher {

	private static _instance:TwitchMessengerClient;
	private _client!:tmi.Client;
	private _credentials:{token:string, username:string}|null = null;
	private _connectedAnonymously:boolean = false;
	private _connectTimeout:number = -1;
	private _connectedChannels:string[] = [];
	private _channelIdToLogin:{[key:string]:string} = {};
	private _channelLoginToId:{[key:string]:string} = {};
	private _queuedMessages:{message:string, tags:unknown, self:boolean, channel:string}[] = [];
	
	constructor() {
		super();
	}
	
	/********************
	* GETTER / SETTERS *
	********************/
	static get instance():TwitchMessengerClient {
		if(!TwitchMessengerClient._instance) {
			TwitchMessengerClient._instance = new TwitchMessengerClient();
		}
		return TwitchMessengerClient._instance;
	}

	/**
	 * Set authentication token
	 */
	public set credentials(value:{token:string, username:string}) {
		this._credentials = value;
		this.connectToChannel(value.username);
	}
	
	
	
	/******************
	* PUBLIC METHODS *
	******************/
	public loadMeta():void {
		TwitchUtils.loadGlobalBadges();
		StoreProxy.users.loadMyFollowings();
		StoreProxy.users.initBlockedUsers();

		const sParams = StoreProxy.params;
		if(sParams.appearance.bttvEmotes.value === true) {
			BTTVUtils.instance.enable();
		}else{
			BTTVUtils.instance.disable();
		}
		if(sParams.appearance.ffzEmotes.value === true) {
			FFZUtils.instance.enable();
		}else{
			FFZUtils.instance.disable();
		}
		if(sParams.appearance.sevenTVEmotes.value === true) {
			SevenTVUtils.instance.enable();
		}else{
			SevenTVUtils.instance.disable();
		}

		//Use an anonymous method to avoid blocking loading while
		//all twitch tags are loading
		try {
			if(StoreProxy.auth.twitch.user.is_affiliate || StoreProxy.auth.twitch.user.is_partner) {
				const channelId = StoreProxy.auth.twitch.user.id;
				TwitchUtils.getPolls(channelId);
				TwitchUtils.getPredictions(channelId);
			}
			TwitchUtils.searchTag("");//Preload tags to build local cache
		}catch(e) {
			//User is probably not an affiliate
		}
	}

	/**
	 * Connect to a channel
	 * @param channel 
	 * @param anonymous 
	 */
	public connectToChannel(channel:string):void {
		//Already connected to that channel ?
		if(this._connectedChannels.findIndex(v=>v === channel) > -1) return;
		
		this._connectedChannels.push(channel);
		
		//Debounce connection calls if calling it for multiple channels at once
		clearTimeout(this._connectTimeout);
		this._connectTimeout = setTimeout(async ()=>{
			const chans = await TwitchUtils.loadUserInfo(undefined, this._connectedChannels);
			if(chans.length === 0) {
				StoreProxy.main.alert("Unable to load user info: "+ this._connectedChannels);
				return;
			}
			chans.forEach(v=> {
				this._channelIdToLogin[v.id] = v.login;
				this._channelLoginToId[v.login] = v.id;
				const u = StoreProxy.users.getUserFrom("twitch", v.id, v.id, v.login, v.display_name);//Preload user to storage
				u.channelInfo[u.id].online = true;
				TwitchUtils.loadUserBadges(v.id);
				TwitchUtils.loadCheermoteList(v.id);
				BTTVUtils.instance.addChannel(v.id);
				FFZUtils.instance.addChannel(v.id);
				SevenTVUtils.instance.addChannel(v.id);
			});
			
			if(!this._client) {
				//Not yet connected to IRC, create client and connect to specified
				//channels with specified credentials
				let options:tmi.Options = {
					options: { debug: false, skipUpdatingEmotesets:true, },
					connection: { reconnect: true, maxReconnectInverval:2000 },
					channels:this._connectedChannels.concat(),
				};
				if(!this._credentials) {
					//not token given, anonymous authentication
					this._connectedAnonymously = true;
				}else{
					options.identity = {
						username: this._credentials.username,
						password: "oauth:"+this._credentials?.token,
					};
				}
				this._client = new tmi.Client(options);
				this._client.connect();
				this.initialize();
			}else{
				//Already connected to IRC, add channel to the list
				//and reconnect IRC client
				const params = this._client.getOptions();
				params.channels = this._connectedChannels;
				this.reconnect();
			}
		}, 100);
	}

	/**
	 * Disconnect from a specific channel
	 * @param channel 
	 */
	public async disconnectFromChannel(channel:string):Promise<void> {
		const params = this._client.getOptions();
		const index = this._connectedChannels.findIndex(v=>v===channel);
		if(index > -1) {
			this._connectedChannels.splice(index, 1);
			params.channels = this._connectedChannels;
			await this.reconnect();
		}
	}

	/**
	 * Refresh IRC token
	 * Disconnects from all chans and connects back to it
	 * @param token 
	 */
	public async refreshToken(token:string):Promise<void> {
		const params = this._client.getOptions();
		if(!params.identity) {
			params.identity = {
				username: this.credentials.username,
				password: "oauth:"+this._credentials?.token,
			}
		}
		params.identity.password = token;
		await this.reconnect();
	}
	
	/**
	 * Disconnect from all channels and cut IRC connection
	 */
	public disconnect():void {
		if(this._client) {
			this._client.disconnect();
		}
	}
	
	/**
	 * Disconnect from all channels and cut IRC connection
	 */
	public async sendMessage(channelId:string, text:string):Promise<boolean> {
		//TMI.js doesn't send the message back to their sender if sending
		//it just after receiving a message (same frame).
		//If we didn't wait for a frame, the message would be sent properly
		//to viewers, but wouldn't appear on this chat.
		//To make sure this isn't a problem through the app we always wait
		//a frame before sending the message
		await Utils.promisedTimeout(0);

		//Workaround to a weird behavior of TMI.js.
		//If the message starts by a "\" it's properly sent on all
		//connected clients, but never sent back to the sender.
		//Removing all of them to avoid that...
		text = text.replace(/^\\+/gi, "");

		if(text.charAt(0) == "/") {
			const chunks = text.split(/\s/gi);
			let cmd = (chunks.shift() as string).toLowerCase();

			//If using /announce command, extract color
			if(cmd.indexOf("/announce") === 0) {
				let color = cmd.replace("/announce", "");
				if(color.length === 0) color = "primary";
				if(["blue","green","orange","purple","primary"].indexOf(color) === -1) {
					StoreProxy.main.alert("Invalid announcement color");
					return false;
				}
				cmd = "/announce";
				chunks.unshift(color);
			}

			async function getUserFromLogin(login:string):Promise<TwitchDataTypes.UserInfo|null>{
				let res:TwitchDataTypes.UserInfo[];
				try {
					res = await TwitchUtils.loadUserInfo(undefined, [login])
				}catch(error) {
					StoreProxy.main.alert("User @"+login+" not found on Twitch.");
					return null;
				}
				return res[0];
			}

			console.log(cmd);

			switch(cmd) {
				case "/announce": await TwitchUtils.sendAnnouncement(channelId, chunks[1], chunks[0] as "blue"|"green"|"orange"|"purple"|"primary"); return true;
				case "/ban":{
					const user = await getUserFromLogin(chunks[0]);
					if(user) await TwitchUtils.banUser(user.id, channelId, undefined, chunks.splice(1).join(" "));
					return true;
				}
				case "/unban": {
					const user = await getUserFromLogin(chunks[0]);
					if(user) await TwitchUtils.unbanUser(user.id, channelId);
					return true;
				}
				case "/block":{
					const user = await getUserFromLogin(chunks[0]);
					if(user) await TwitchUtils.blockUser(user.id, channelId);
					return true;
				}
				case "/unblock": {
					const user = await getUserFromLogin(chunks[0]);
					if(user) await TwitchUtils.unblockUser(user.id, channelId);
					return true;
				}
				case "/timeout":{
					const user = await getUserFromLogin(chunks[0]);
					if(user) await TwitchUtils.banUser(user.id, channelId, parseInt(chunks[1]), chunks[2]);
					return true;
				}
				case "/untimeout": {
					const user = await getUserFromLogin(chunks[0]);
					if(user) await TwitchUtils.unbanUser(user.id, channelId);
					return true;
				}
				case "/commercial": {
					let duration = parseInt(chunks[0]);
					StoreProxy.main.confirm("Start a commercial?", "The commercial break will last "+duration+"s. It's not guaranteed that a commercial actually starts.").then(async () => {
						try {
							const res = await TwitchUtils.startCommercial(duration, channelId);
							if(res.length > 0) {
								StoreProxy.stream.setCommercialEnd( Date.now() + res.length * 1000 );
							}
						}catch(error) {
							const e = (error as unknown) as {error:string, message:string, status:number}
							console.log(error);
							this.notice(TwitchatDataTypes.TwitchatNoticeType.COMMERCIAL_ERROR, StoreProxy.auth.twitch.user.id, e.message);
						}
					}).catch(()=>{/*ignore*/});
					return true;
				}
				case "/delete": await TwitchUtils.deleteMessages(channelId, chunks[0]); return true;
				case "/clear": await TwitchUtils.deleteMessages(channelId); return true;
				case "/color": await TwitchUtils.setColor(chunks[0]); return true;
				case "/emoteonly": await TwitchUtils.setRoomSettings(channelId, {emotesOnly:true}); return true;
				case "/emoteonlyoff": await TwitchUtils.setRoomSettings(channelId, {emotesOnly:false}); return true;
				case "/followers": await TwitchUtils.setRoomSettings(channelId, {followOnly:parseInt(chunks[0])}); return true;
				case "/followersoff": await TwitchUtils.setRoomSettings(channelId, {followOnly:0}); return true;
				case "/slow": await TwitchUtils.setRoomSettings(channelId, {slowMode:parseInt(chunks[0])}); return true;
				case "/slowoff": await TwitchUtils.setRoomSettings(channelId, {slowMode:0}); return true;
				case "/subscribers": await TwitchUtils.setRoomSettings(channelId, {subOnly:true}); return true;
				case "/subscribersoff": await TwitchUtils.setRoomSettings(channelId, {subOnly:false}); return true;
				case "/mod": await TwitchUtils.addRemoveModerator(false, channelId, undefined, chunks[0]); return true;
				case "/unmod": await TwitchUtils.addRemoveModerator(true, channelId, undefined, chunks[0]); return true;
				case "/raid": await TwitchUtils.raidChannel(chunks[0]); return true;
				case "/unraid": await TwitchUtils.raidCancel(); return true;
				case "/vip": await TwitchUtils.addRemoveVIP(false, undefined, chunks[0]); return true;
				case "/unvip": await TwitchUtils.addRemoveVIP(true, undefined, chunks[0]); return true;
				case "/whiser":
				case "/w": {
					const login = chunks[0];
					await TwitchUtils.whisper(chunks.splice(1).join(" "), login);
					return true;
				}

				//TOD falseO
				case "/uniquechat": return false;
				case "/uniquechatoff": return false;
				case "/marker": return false;
				case "/mods": return false;
				case "/vips": return false;
			}

		}
		
		this._client.say(this._channelIdToLogin[channelId], text);
		return true
	}

	
	
	
	/*******************
	* PRIVATE METHODS *
	*******************/
	private async initialize():Promise<void> {
		this._client.on('message', this.message.bind(this));
		this._client.on("join", this.onJoin.bind(this));
		this._client.on("part", this.onLeave.bind(this));
		this._client.on('cheer', this.onCheer.bind(this));
		this._client.on('resub', this.resub.bind(this));
		this._client.on('subscription', this.subscription.bind(this));
		this._client.on('subgift', this.subgift.bind(this));
		this._client.on('anonsubgift', this.anonsubgift.bind(this));
		this._client.on('giftpaidupgrade', this.giftpaidupgrade.bind(this));
		this._client.on('anongiftpaidupgrade', this.anongiftpaidupgrade.bind(this));
		// this._client.on("ban", this.ban.bind(this));
		// this._client.on("timeout", this.timeout.bind(this));
		this._client.on("raided", this.raided.bind(this));
		this._client.on("disconnected", this.disconnected.bind(this));
		this._client.on("clearchat", this.clearchat.bind(this));
		this._client.on('raw_message', this.raw_message.bind(this));

		let hashmap:{[key:string]:boolean} = {};
		try {
			//Load bots list
			const res = await fetch('https://api.twitchinsights.net/v1/bots/all');
			const json = await res.json();
			(json.bots as string[][]).forEach(b => hashmap[ b[0].toLowerCase() ] = true);
		}catch(error) {
			//Fallback in case twitchinsights dies someday
			["streamelements", "nightbot", "wizebot", "commanderroot", "anotherttvviewer", "streamlabs", "communityshowcase"]
			.forEach(b => hashmap[ b[0].toLowerCase() ] = true);
		}
		StoreProxy.users.setBotsMap("twitch", hashmap);
	}

	/**
	 * Refresh IRC connection
	 * Called after updating the token or the channels list
	 */
	private async reconnect():Promise<void> {
		await this._client.disconnect();
		await this._client.connect();
	}

	/**
	 * Gets a user object from IRC tags
	 * @param tags 
	 * @returns 
	 */
	private getUserFromTags(tags:tmi.ChatUserstate|tmi.SubUserstate|tmi.SubGiftUpgradeUserstate|tmi.SubGiftUserstate|tmi.AnonSubGiftUserstate|tmi.AnonSubGiftUpgradeUserstate, channelId:string):TwitchatDataTypes.TwitchatUser {
		const login			= tags.username ?? tags["display-name"];
		const user			= StoreProxy.users.getUserFrom("twitch", channelId, tags["user-id"], login, tags["display-name"]);
		const isMod			= tags.badges?.moderator != undefined || tags.mod === true;
		const isVip			= tags.badges?.vip != undefined;
		const isSub			= tags.badges?.subscriber != undefined || tags.subscriber === true;
		const isSubGifter	= tags.badges && tags.badges["sub-gifter"] != undefined;
		const isBroadcaster	= tags.badges?.broadcaster != undefined;
		const isPartner		= tags.badges?.partner != undefined;

		user.channelInfo[channelId].online	= true;
		
		if(tags.color)		user.color = tags.color;
		if(isMod)			user.channelInfo[channelId].is_moderator = true;
		if(isVip)			user.channelInfo[channelId].is_vip = true;
		if(isSub)			user.channelInfo[channelId].is_subscriber = true;
		if(isSubGifter)		user.channelInfo[channelId].is_gifter = true;
		if(isBroadcaster)	user.channelInfo[channelId].is_broadcaster = true;
		if(isPartner) {
			user.is_partner		= true;
			user.is_affiliate	= true;
		}

		if(tags.badges && tags["room-id"]) {
			user.channelInfo[channelId].badges = TwitchUtils.getBadgesFromRawBadges(tags["room-id"], tags["badge-info"], tags.badges);
		}else{
			//Cleanup badges from the user
			user.channelInfo[channelId].badges = [];
		}
		return user;
	}

	private getChannelID(login:string):string {
		login = login.replace("#", "");
		return this._channelLoginToId[login];
	}

	/**
	 * Gets a user object from its login
	 * 
	 * @param login 
	 * @returns 
	 */
	private getUserFromLogin(login:string, channelId:string):TwitchatDataTypes.TwitchatUser {
		//Search if a user with this name and source exists on store
		//If no user exists a temporary user object will be returned and
		//populated asynchronously via an API call
		const user			= StoreProxy.users.getUserFrom("twitch", channelId, undefined, login, undefined, undefined);
		user.is_partner		= false;
		user.is_affiliate	= false;
		user.channelInfo[channelId].online = true;
		return user;
	}
	
	/**
	 * Gets a sub object from data
	 * 
	 * @param channel 
	 * @param tags 
	 * @param methods 
	 * @param message 
	 * @returns 
	 */
	private getCommonSubObject(channel:string, tags:tmi.ChatUserstate|tmi.SubUserstate|tmi.SubGiftUpgradeUserstate|tmi.SubGiftUserstate|tmi.AnonSubGiftUserstate|tmi.AnonSubGiftUpgradeUserstate, methods?:tmi.SubMethods, message?:string):TwitchatDataTypes.MessageSubscriptionData {
		const channel_id = this.getChannelID(channel);
		let res:TwitchatDataTypes.MessageSubscriptionData = {
			platform:"twitch",
			type:"subscription",
			id:tags.id ?? Utils.getUUID(),
			channel_id,
			date:parseInt(tags["tmi-sent-ts"] as string ?? Date.now().toString()),
			user:this.getUserFromTags(tags, channel_id),
			tier: 1,
			is_gift: false,
			is_giftUpgrade: false,
			is_resub: false,
			months:typeof tags["msg-param-multimonth-duration"] == "string"? parseInt(tags["msg-param-multimonth-duration"]) : -1,
			streakMonths:typeof tags["msg-param-streak-months"] == "string"? parseInt(tags["msg-param-streak-months"]) : -1,
			totalSubDuration:typeof tags["msg-param-cumulative-months"] == "string"? parseInt(tags["msg-param-cumulative-months"]) : -1,
		}
		if(methods) res.tier =  methods.prime? "prime" : (parseInt((methods.plan as string) ?? 1000)/1000) as (1|2|3);
		if(message) {
			res.message = message;
			res.message_html = TwitchUtils.parseEmotes(message, tags["emotes-raw"]);
		}
		return res;
	}

	private async message(channel:string, tags:tmi.ChatUserstate, message:string, self:boolean, fromQueue:boolean = false):Promise<void> {
		if(!tags.id && tags["message-type"] == "chat") {
			//When sending a message from the current client, IRC never send it back to us.
			//TMI tries to make this transparent by firing the "message" event but
			//it won't populate the data with the actual ID of the message.
			//To workaround this issue, we just store the message on a queue, and
			//wait for a NOTICE event that gives us the message ID in which case
			//we pop the message from the queue
			this._queuedMessages.push({message, tags, self, channel});
			return;
		}
		
		
		//This line avoids an edge case issue.
		//If the current TMI client sends messages super fast (some ms between each message),
		//the tags property is not updated for the later messages that will receive
		//the exact same tags instance (not only the same values).
		//This makes multiple messages sharing the same ID which can cause
		//issues with VueJS keyed items (ex: on v-for loops) that would share
		//the same value which is not allowed
		tags = JSON.parse(JSON.stringify(tags));

		//Ignore anything that's not a message or a /me
		if(tags["message-type"] != "chat" && tags["message-type"] != "action" && (tags["message-type"] as string) != "announcement") return;

		//Ignore rewards with text, they are also sent to PubSub with more info
		if(tags["custom-reward-id"]) return;

		const channel_id = this.getChannelID(channel);
		const user = this.getUserFromTags(tags, channel_id);

		const data:TwitchatDataTypes.MessageChatData = {
			id:tags.id!,
			type:"message",
			platform:"twitch",
			channel_id,
			date:Date.now(),

			user,
			message,
			answers:[],
			message_html:"",
			todayFirst:user.greeted===false,
		};

		//TODO reload greeted state from cache on load
		user.greeted = true;
		data.message_html = TwitchUtils.parseEmotes(message, tags["emotes-raw"], false, fromQueue);
				
		// If message is an answer, set original message's ref to the answer
		// Called when using the "answer feature" on twitch chat
		if(tags["reply-parent-msg-id"]) {
			const messages = StoreProxy.chat.messages;
			//Search for original message the user answered to
			for (let i = 0; i < messages.length; i++) {
				let m = messages[i];
				if(m.type != TwitchatDataTypes.TwitchatMessageType.MESSAGE) continue;
				if(m.id === tags["reply-parent-msg-id"]) {
					if(m.answersTo) m = m.answersTo;
					if(!m.answers) m.answers = [];
					m.answers.push( data );
					data.answersTo = m;
					break;
				}
			}
		}else{
			//If there's a mention, search for last messages within
			//a max timeframe to find if the message may be a reply to
			//a message that was sent by the mentionned user
			if(/@\w/gi.test(message)) {
				// console.log("Mention found");
				const ts = Date.now();
				const messages = StoreProxy.chat.messages;
				const timeframe = 5*60*1000;//Check if a massage answers another within this timeframe
				const matches = message.match(/@\w+/gi) as RegExpMatchArray;
				for (let i = 0; i < matches.length; i++) {
					const match = matches[i].replace("@", "").toLowerCase();
					// console.log("Search for message from ", match);
					const candidates = messages.filter(m => {
						if(m.type != TwitchatDataTypes.TwitchatMessageType.MESSAGE) return false;
						return m.user.login == match
					}) as TwitchatDataTypes.MessageChatData[];
					//Search for oldest matching candidate
					for (let j = 0; j < candidates.length; j++) {
						const c = candidates[j];
						// console.log("Found candidate", c);
						if(ts - c.date < timeframe) {
							// console.log("Timeframe is OK !");
							if(c.answers) {
								//If it's the root message of a conversation
								c.answers.push( data );
								data.answersTo = c;
							}else if(c.answersTo && c.answersTo.answers) {
								//If the messages answers to a message itself answering to another message
								c.answersTo.answers.push( data );
								data.answersTo = c.answersTo;
							}else{
								//If message answers to a message not from a conversation
								data.answersTo = c;
								if(!c.answers) c.answers = [];
								c.answers.push( data );
							}
							break;
						}
					}
				}
			}
		}
				
		//Custom secret feature hehehe ( ͡~ ͜ʖ ͡°)
		if(ChatCypherPlugin.instance.isCyperCandidate(message)) {
			const original = message;
			message = await ChatCypherPlugin.instance.decrypt(original);
			data.cyphered = message != original;
		}

		//Check if the message contains a mention
		if(message && StoreProxy.params.appearance.highlightMentions.value === true) {
			const login = StoreProxy.auth.twitch.user.login;
			data.hasMention = login != null && 
							new RegExp("(^| |@)("+login+")($|\\s)", "gim").test(message);
			if(data.hasMention) {
				data.highlightWord = login;
			}
		}
		
		data.twitch_isSlashMe		= tags["message-type"] === "action";
		data.twitch_isReturning		= tags["returning-chatter"] === true;
		data.twitch_isFirstMessage	= tags['first-msg'] === true && tags["msg-id"] != "user-intro";
		data.twitch_isPresentation	= tags["msg-id"] == "user-intro";
		data.twitch_isHighlighted	= tags["msg-id"] === "highlighted-message";
		if(tags["msg-param-color"]) data.twitch_announcementColor= tags["msg-param-color"].toLowerCase();
		let pinAmount:number|undefined = tags["pinned-chat-paid-canonical-amount"];
		if(pinAmount) {
			data.elevatedInfo	= {amount:pinAmount, duration_s:{"5":30, "10":60, "25":90, "50":120, "100":150}[pinAmount] ?? 30};
		}

		//Send reward redeem message if the message comes from an "highlight my message" reward
		if(data.twitch_isHighlighted) {
			const reward:TwitchatDataTypes.MessageRewardRedeemData = {
				channel_id: data.channel_id,
				date: data.date,
				id:Utils.getUUID(),
				platform:"twitch",
				type:"reward",
				user: data.user,
				reward: {
					id:"highlighted-message",
					title:"Highlight my message",
					cost:-1,
					description:"",
					icon:{
						sd:rewardImg,
					}
				},
				message:data.message,
				message_html:data.message_html,
			}
			this.dispatchEvent(new MessengerClientEvent("REWARD", reward));
		}

		this.dispatchEvent(new MessengerClientEvent("MESSAGE", data));
	}

	private onJoin(channel:string, user:string):void {
		const channel_id = this.getChannelID(channel);
		this.dispatchEvent(new MessengerClientEvent("JOIN", {
			platform:"twitch",
			type:"join",
			id:Utils.getUUID(),
			channel_id,
			date:Date.now(),
			users:[this.getUserFromLogin(user, channel_id)],
		}));
	}

	private onLeave(channel:string, user:string):void {
		const channel_id = this.getChannelID(channel);
		this.dispatchEvent(new MessengerClientEvent("LEAVE", {
			platform:"twitch",
			type:"leave",
			id:Utils.getUUID(),
			channel_id,
			date:Date.now(),
			users:[this.getUserFromLogin(user, channel_id)],
		}));
	}

	private async onCheer(channel:string, tags:tmi.ChatUserstate, message:string):Promise<void> {
		let message_html = TwitchUtils.parseEmotes(message, tags["emotes-raw"]);
		message_html = await TwitchUtils.parseCheermotes(message_html, StoreProxy.auth.twitch.user.id);
		const channel_id = this.getChannelID(channel);
		this.dispatchEvent(new MessengerClientEvent("CHEER", {
			platform:"twitch",
			type:"cheer",
			id:tags.id ?? Utils.getUUID(),
			channel_id,
			date:parseInt(tags["tmi-sent-ts"] as string ?? Date.now().toString()),
			user:this.getUserFromTags(tags, channel_id),
			bits:parseFloat(tags.bits as string) ?? -1,
			message,
			message_html,
		}));
	}

	private resub(channel: string, username: string, months: number, message: string, tags: tmi.SubUserstate, methods: tmi.SubMethods):void {
		const data = this.getCommonSubObject(channel, tags, methods, message);
		data.is_resub = true;
		data.months = months;
		this.dispatchEvent(new MessengerClientEvent("SUB", data));
	}

	private subscription(channel: string, username: string, methods: tmi.SubMethods, message: string, tags: tmi.SubUserstate):void {
		const data = this.getCommonSubObject(channel, tags, methods, message);
		this.dispatchEvent(new MessengerClientEvent("SUB", data));
	}

	private subgift(channel: string, username: string, streakMonths: number, recipient: string, methods: tmi.SubMethods, tags: tmi.SubGiftUserstate):void {
		const data = this.getCommonSubObject(channel, tags, methods);
		data.is_gift = true;
		data.gift_recipients = [this.getUserFromLogin(recipient, data.channel_id)];
		this.dispatchEvent(new MessengerClientEvent("SUB", data));
	}
	
	private anonsubgift(channel: string, streakMonths: number, recipient: string, methods: tmi.SubMethods, tags: tmi.AnonSubGiftUserstate):void {
		const data = this.getCommonSubObject(channel, tags, methods);
		data.is_gift = true;
		data.streakMonths = streakMonths
		data.gift_recipients = [this.getUserFromLogin(recipient, data.channel_id)];
		this.dispatchEvent(new MessengerClientEvent("SUB", data));
	}
	
	private giftpaidupgrade(channel: string, username: string, sender: string, tags: tmi.SubGiftUpgradeUserstate):void {
		const data = this.getCommonSubObject(channel, tags);
		data.is_giftUpgrade = true;
		data.gift_upgradeSender = this.getUserFromLogin(username, data.channel_id);
		this.dispatchEvent(new MessengerClientEvent("SUB", data));
	}
	
	private anongiftpaidupgrade(channel: string, username: string, tags: tmi.AnonSubGiftUpgradeUserstate):void {
		const data = this.getCommonSubObject(channel, tags);
		data.is_giftUpgrade = true;
		this.dispatchEvent(new MessengerClientEvent("SUB", data));
	}

	private ban(channel: string, username: string, reason: string):void {
		const channel_id = this.getChannelID(channel);
		this.dispatchEvent(new MessengerClientEvent("NOTICE", {
			platform:"twitch",
			type:"notice",
			noticeId:TwitchatDataTypes.TwitchatNoticeType.BAN,
			id:Utils.getUUID(),
			channel_id,
			date:Date.now(),
			user:this.getUserFromLogin(username, channel_id),
			reason,
			message:"User "+username+" has been banned",
		}));
	}

	private timeout(channel: string, username: string, reason: string, duration: number):void {
		const channel_id = this.getChannelID(channel);
		this.dispatchEvent(new MessengerClientEvent("NOTICE", {
			platform:"twitch",
			type:"notice",
			noticeId:TwitchatDataTypes.TwitchatNoticeType.TIMEOUT,
			id:Utils.getUUID(),
			channel_id,
			date:Date.now(),
			user:this.getUserFromLogin(username, channel_id),
			duration_s:duration,
			reason,
			message:username+" has been temporary banned for "+duration+" seconds",
		}));
	}

	private raided(channel: string, username: string, viewers: number):void {
		const channel_id = this.getChannelID(channel);
		this.dispatchEvent(new MessengerClientEvent("RAID", {
			platform:"twitch",
			type:"raid",
			id:Utils.getUUID(),
			channel_id,
			date:Date.now(),
			user:this.getUserFromLogin(username, channel_id),
			viewers
		}));
	}
	
	private disconnected(reason:string):void {
		console.log("Disconnected :: ", reason);
		const eventData:TwitchatDataTypes.MessageNoticeData = {
			channel_id: "twitchat",
			id:Utils.getUUID(),
			type:"notice",
			date:Date.now(),
			platform:"twitch",
			message:"You have been disconnected from the chat :(",
			noticeId:TwitchatDataTypes.TwitchatNoticeType.OFFLINE,
		};
		this.dispatchEvent(new MessengerClientEvent("NOTICE", eventData));
	}

	private clearchat(channel:string):void {
		this.dispatchEvent(new MessengerClientEvent("CLEAR_CHAT", {
			platform:"twitch",
			type:"clear_chat",
			id:Utils.getUUID(),
			channel_id:this.getChannelID(channel),
			date:Date.now(),
		}));
	}

	private async raw_message(messageCloned: { [property: string]: unknown }, data: { [property: string]: unknown }):Promise<void> {
		//TMI parses the "badges" and "badge-info" props right AFTER dispatching
		//the "raw_message" event.
		//Let's wait a frame so the props are parsed
		await Utils.promisedTimeout(0);
		switch(data.command) {
			case "USERNOTICE": {
				//Handle announcement messages
				if(((data.tags as tmi.ChatUserstate)["msg-id"] as unknown) === "announcement") {
					const params = data.params as string[];
					const tags = data.tags as tmi.ChatUserstate;
					tags.username = tags.login;
					this.message(params[0], tags, params[1], false);
				}
				break;
			}

			case "WHISPER": {
				//Not using the client.on("whisper") helper as it does not provides
				//the receiver. Here we get everything.
				const [toLogin, message] = (data as {params:string[]}).params;
				const tags = data.tags as tmi.ChatUserstate;
				//Extract channel ID. It's in the form "sendID_recipientID" or "recipientID_sendID"
				const channelId = tags["thread-id"].replace(tags["user-id"], "").replace("_", "");
				const eventData:TwitchatDataTypes.MessageWhisperData = {
					id:Utils.getUUID(),
					type:"whisper",
					date:Date.now(),
					channel_id:channelId,
					platform:"twitch",
					user: this.getUserFromTags(tags, channelId),
					to: this.getUserFromLogin(toLogin, channelId),
					message:message,
					message_html:TwitchUtils.parseEmotes(message, tags["emotes-raw"]),
				};
		
				this.dispatchEvent(new MessengerClientEvent("WHISPER", eventData));
				break;
			}

			case "USERSTATE": {
				TwitchUtils.loadEmoteSets((data as tmi.UserNoticeState).tags["emote-sets"].split(","));

				//Check if it contains a message ID
				const d = data as tmi.UserNoticeState;
				let id = (d.raw as string).split(";").find(v=>v.indexOf("id=") === 0);
				if(id) id = id.split("=")[1];
				
				//If there are messages pending for their ID, give the oldest one the received ID
				if(id && this._queuedMessages.length > 0) {
					const m = this._queuedMessages.shift();
					if(m) {
						(m.tags as tmi.ChatUserstate).id = id;
						(m.tags as tmi.ChatUserstate)["tmi-sent-ts"] = Date.now().toString();
						this.message(m.channel, m.tags as tmi.ChatUserstate, m.message, m.self, true);
					}
				}
				break;
			}

			case "ROOMSTATE": {
				const roomstate = (data as unknown) as TwitchDataTypes.RoomState;
				//TODO check if this still works
				if(roomstate.params[0].replace("#", "") == StoreProxy.auth.twitch.user.login) {
					const sStream = StoreProxy.stream;
					const params = sStream.roomStatusParams.twitch;
					if(!params) return;
					if(roomstate.tags['emote-only'] != undefined) params.emotesOnly.value = roomstate.tags['emote-only'] != false;
					if(roomstate.tags['subs-only'] != undefined) params.subsOnly.value = roomstate.tags['subs-only'] != false;
					if(roomstate.tags['followers-only'] != undefined) params.followersOnly.value = parseInt(roomstate.tags['followers-only']) > -1;
					if(roomstate.tags.slow != undefined) params.slowMode.value = roomstate.tags.slow != false;
				}
				break;
			}

			//Using this instead of the "notice" event from TMI as it's not
			//fired for many notices whereas here we get them all
			case "NOTICE": {
				let [msgid, url, cmd, channel, message] = (data.raw as string).replace(/@msg-id=(.*) :(.*) (.*) (#.*) :(.*)/gi, "$1::$2::$3::$4::$5").split("::");
				let noticeId:TwitchatDataTypes.TwitchatNoticeStringType = TwitchatDataTypes.TwitchatNoticeType.GENERIC;
				if(!message) {
					if(msgid.indexOf("bad_delete_message_error") > -1) {
						message = "You cannot delete this message.";
						noticeId = TwitchatDataTypes.TwitchatNoticeType.ERROR;
					}
					if(msgid.indexOf("authentication failed") > -1) {
						message = "Authentication failed. Refreshing token and trying again...";
						this.dispatchEvent(new MessengerClientEvent("REFRESH_TOKEN"));
						noticeId = TwitchatDataTypes.TwitchatNoticeType.ERROR;
					}
				}
				if(message) {
					this.notice(noticeId, channel, message);
				}
				break;
			}
			default: break;
		}
	}

	private notice(id:TwitchatDataTypes.TwitchatNoticeStringType, channel:string, message:string):void {
		const eventData:TwitchatDataTypes.MessageNoticeData = {
			channel_id: this.getChannelID(channel),
			id:Utils.getUUID(),
			type:"notice",
			date:Date.now(),
			platform:"twitch",
			message:message,
			noticeId:id,
		};
		this.dispatchEvent(new MessengerClientEvent("NOTICE", eventData));
	}

}