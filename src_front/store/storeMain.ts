import GoXLRSocketEvent from '@/events/GoXLRSocketEvent';
import HeatEvent from '@/events/HeatEvent';
import TwitchatEvent, { type TwitchatEventType } from '@/events/TwitchatEvent';
import router from '@/router';
import { TriggerTypes, rebuildPlaceholdersCache, type SocketParams, type TriggerActionChatData, type TriggerData } from '@/types/TriggerActionDataTypes';
import { TwitchatDataTypes } from '@/types/TwitchatDataTypes';
import ApiHelper from '@/utils/ApiHelper';
import ChatCypherPlugin from '@/utils/ChatCypherPlugin';
import Config, { type ServerConfig } from '@/utils/Config';
import OBSWebsocket, { type OBSSourceItem } from '@/utils/OBSWebsocket';
import PublicAPI from '@/utils/PublicAPI';
import SSEHelper from '@/utils/SSEHelper';
import SchedulerHelper from '@/utils/SchedulerHelper';
import Utils from '@/utils/Utils';
import WebsocketTrigger from '@/utils/WebsocketTrigger';
import BTTVUtils from '@/utils/emotes/BTTVUtils';
import FFZUtils from '@/utils/emotes/FFZUtils';
import SevenTVUtils from '@/utils/emotes/SevenTVUtils';
import GoXLRSocket from '@/utils/goxlr/GoXLRSocket';
import SpotifyHelper from '@/utils/music/SpotifyHelper';
import TriggerActionHandler from '@/utils/triggers/TriggerActionHandler';
import HeatSocket from '@/utils/twitch/HeatSocket';
import { TwitchScopes } from '@/utils/twitch/TwitchScopes';
import TwitchUtils from '@/utils/twitch/TwitchUtils';
import VoicemodEvent from '@/utils/voice/VoicemodEvent';
import VoicemodWebSocket from '@/utils/voice/VoicemodWebSocket';
import YoutubeHelper from '@/utils/youtube/YoutubeHelper';
import { defineStore, type PiniaCustomProperties, type _StoreWithGetters, type _StoreWithState } from 'pinia';
import type { JsonObject } from 'type-fest';
import type { UnwrapRef } from 'vue';
import DataStore from './DataStore';
import Database from './Database';
import StoreProxy, { type IMainActions, type IMainGetters, type IMainState } from './StoreProxy';

export const storeMain = defineStore("main", {
	state: () => ({
		latestUpdateIndex: 16,
		theme:"dark",
		initComplete: false,
		devmode: false,
		messageExportState: null,
		ahsInstaller: null,
		tooltip: "",
		cypherKey: "",
		cypherEnabled: false,
		tempStoreValue: null,
		confirmData:null,
		accessibility:{
			ariaPolite:"",
		},
		chatAlertParams: {
			chatCmd:"!alert",
			message:true,
			shake:true,
			sound:true,
			blink:false,
			vibrate:true,
			permissions:{
				broadcaster:true,
				mods:true,
				vips:false,
				subs:false,
				all:false,
				follower:false,
				follower_duration_ms:0,
				usersAllowed:[],
				usersRefused:[],
			},
		},
		chatAlert:null,
	} as IMainState),


	getters: {
		nonPremiumLimitExceeded: ()=> {
			if(StoreProxy.auth.isPremium) return false;

			const triggersLength = StoreProxy.triggers.triggerList
			.filter(v=>v.enabled !== false && StoreProxy.triggers.triggerIdToFolderEnabled[v.id] !== false).length;

			return StoreProxy.counters.counterList.filter(v=>v.enabled != false).length > Config.instance.MAX_COUNTERS
				|| StoreProxy.values.valueList.filter(v=>v.enabled != false).length > Config.instance.MAX_VALUES
				|| triggersLength > Config.instance.MAX_TRIGGERS
				|| StoreProxy.heat.screenList.filter(v=>v.enabled != false).length > Config.instance.MAX_CUSTOM_HEAT_SCREENS
				|| StoreProxy.users.customBadgeList.filter(v=>v.enabled != false).length > Config.instance.MAX_CUSTOM_BADGES
				|| Object.keys(StoreProxy.users.customUserBadges).length > Config.instance.MAX_CUSTOM_BADGES_ATTRIBUTION
				|| Object.keys(StoreProxy.users.customUsernames).length > Config.instance.MAX_CUSTOM_USERNAMES
				|| StoreProxy.heat.distortionList.filter(v=>v.enabled).length > Config.instance.MAX_DISTORTION_OVERLAYS
				|| StoreProxy.bingoGrid.gridList.filter(v=>v.enabled).length > Config.instance.MAX_BINGO_GRIDS;
		}
	},


	actions: {

		/**
		 * Called with do argument when doing CTRL+Shift+K to to
		 * switch between dark and light mode.
		 * Also called when user requests a specific theme
		 */
		toggleTheme(theme?:"light"|"dark"):void {
			const list = document.body.classList;
			if(theme == "light") {
				list.remove("dark");
				list.add("light");
			}else
			if(theme == "dark") {
				list.remove("light");
				list.add("dark");
			}else
			if(list.contains("dark")) {
				list.remove("dark");
				list.add("light");
				theme = "light";
			}else
			if(list.contains("light")) {
				list.remove("light");
				list.add("dark");
				theme = "dark";
			}
			StoreProxy.common.theme = theme!;
			DataStore.set(DataStore.THEME, theme);
		},

		/**
		 * Here for debug purpose.
		 * Called when doing CTRL+Shift+L to reload the app labels
		 * this makes a little easier testing labels updates to
		 * avoid refreshing the full app
		 */
		async reloadLabels(bypassCache:boolean = false):Promise<void> {
			let url = "/labels.json";
			if(bypassCache) url += "?ck="+Utils.getUUID();
			const labelsRes = await fetch(url);
			const labelsJSON = await labelsRes.json();
			for (const lang in labelsJSON) {
				StoreProxy.i18n.setLocaleMessage(lang, labelsJSON[lang]);
			}
		},

		async startApp(authenticate:boolean, callback:(value:unknown)=>void) {
			let jsonConfigs:ServerConfig;
			const sAuth = StoreProxy.auth;
			const sVoice = StoreProxy.voice;
			const sParams = StoreProxy.params;

			//Load app configs (cliend ID, scopes, ...)
			window.setInitMessage("loading configs");
			try {
				const res = await ApiHelper.call("configs", "GET");
				jsonConfigs = res.json;
			}catch(error) {
				StoreProxy.common.alert("Unable to contact server :(", true, true);
				console.log(error);
				this.initComplete = true;
				return;
			}
			Config.instance.populateServerConfigs(jsonConfigs);

			//Makes sure all parameters have a unique ID !
			let uniqueIdsCheck:{[key:number]:boolean} = {};
			const pointers = [sParams.features, sParams.appearance];
			for (let i = 0; i < pointers.length; i++) {
				const values = pointers[i];
				for (const key in values) {
					const p = values[key] as TwitchatDataTypes.ParameterData<unknown>;
					if(uniqueIdsCheck[p.id as number] === true) {
						StoreProxy.common.alert("Duplicate parameter id (" + p.id + ") found for parameter \"" + key + "\"");
						break;
					}
					uniqueIdsCheck[p.id as number] = true;
				}
			}

			//Make sure all triggers have a unique ID !
			uniqueIdsCheck = {};
			for (const key in TriggerTypes) {
				//@ts-ignore
				const v = TriggerTypes[key];
				if(uniqueIdsCheck[v] === true) {
					StoreProxy.common.alert("Duplicate trigger type id (" + v + ") found for trigger \"" + key + "\"");
					break;
				}
				uniqueIdsCheck[v] = true;
			}

			//Authenticate user
			const token = DataStore.get(DataStore.TWITCH_AUTH_TOKEN);
			if(token && authenticate) {
				try {
					await new Promise((resolve,reject)=> {
						sAuth.twitch_autenticate(undefined, (success:boolean, betaRefused?:boolean)=>{
							if(betaRefused == true) {
								this.initComplete = true;
								router.push({name:"login", params:{betaReason:"true"}});
								return;
							}
							if(success) {
								resolve(null);
							}else{
								reject();
							}
						});
					});

				}catch(error) {
					console.log(error);
					sAuth.authenticated = false;
					DataStore.remove("oAuthToken");
					this.initComplete = true;
					callback(null);
					return;
				}
			}

			this.initComplete = true;

			window.setInitMessage("");

			/**
			 * Called when labels editor updated labels
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.LABELS_UPDATE, (e:TwitchatEvent)=> {
				this.reloadLabels(true);
			});

			//Listen for twitchat API event

			PublicAPI.instance.addEventListener(TwitchatEvent.TEXT_UPDATE, (e:TwitchatEvent<{text:string}>)=> {
				sVoice.voiceText.tempText = e.data!.text;
				sVoice.voiceText.finalText = "";
			});

			PublicAPI.instance.addEventListener(TwitchatEvent.RAW_TEXT_UPDATE, (e:TwitchatEvent<{text:string}>)=> {
				sVoice.voiceText.rawTempText = e.data!.text;
			});

			PublicAPI.instance.addEventListener(TwitchatEvent.SPEECH_END, (e:TwitchatEvent<{text:string}>)=> {
				sVoice.voiceText.finalText = e.data!.text;
			});

			StoreProxy.common.initialize(authenticate);

			callback(null);
		},

		onAuthenticated():void {
			//Only listen for these events if authenticated.
			//This avoids them from being listened from the overlay or homepage where it's useless

			const sAuth = StoreProxy.auth;
			const sChat = StoreProxy.chat;
			const sUsers = StoreProxy.users;
			const sVoice = StoreProxy.voice;
			const sTimer = StoreProxy.timer;
			const sStream = StoreProxy.stream;
			const sEmergency = StoreProxy.emergency;
			StoreProxy.discord.initialize();
			SSEHelper.instance.initialize();

			//Warn the user about the automatic "ad" message sent every 2h
			if(DataStore.get(DataStore.TWITCHAT_AD_WARNED) !== "true" && !sAuth.isDonor) {
				setTimeout(()=>{
					sChat.sendTwitchatAd(TwitchatDataTypes.TwitchatAdTypes.TWITCHAT_AD_WARNING);
				}, 5000);
			}else
			//Warn the user about the new ad break capabilities
			if(DataStore.get(DataStore.AD_BREAK_SCOPES_REQUEST) !== "true" && !TwitchUtils.hasScopes([TwitchScopes.ADS_READ, TwitchScopes.ADS_SNOOZE])) {
				setTimeout(()=>{
					sChat.sendTwitchatAd(TwitchatDataTypes.TwitchatAdTypes.AD_BREAK_SCOPE_REQUEST);
				}, 5000);
			}else
			//Ask the user if they want to make their donation public
			if(!DataStore.get(DataStore.TWITCHAT_SPONSOR_PUBLIC_PROMPT) && sAuth.twitch.user.donor.state) {
				setTimeout(()=>{
					sChat.sendTwitchatAd(TwitchatDataTypes.TwitchatAdTypes.TWITCHAT_SPONSOR_PUBLIC_PROMPT);
				}, 5000);
			}else
			//Show "right click message" hint
			if(!DataStore.get(DataStore.TWITCHAT_RIGHT_CLICK_HINT_PROMPT)) {
				setTimeout(()=>{
					sChat.sendRightClickHint();
				}, 5000);
			}else{
				//Hot fix to make sure new changelog highlights are displayed properly
				setTimeout(()=> { sChat.sendTwitchatAd(); }, 1000);
			}

			const lastUpdateRead = parseInt(DataStore.get(DataStore.UPDATE_INDEX));
			if(isNaN(lastUpdateRead) || lastUpdateRead < StoreProxy.main.latestUpdateIndex) {
				//Force last updates if any not read
				// possibleAds = [TwitchatDataTypes.TwitchatAdTypes.UPDATES];
				StoreProxy.params.openModal("updates");
			}

			const sParams = StoreProxy.params;
			if(sParams.appearance.bttvEmotes.value === true && sParams.appearance.showEmotes.value === true) {
				BTTVUtils.instance.enable();
			}else{
				BTTVUtils.instance.disable();
			}
			if(sParams.appearance.ffzEmotes.value === true && sParams.appearance.showEmotes.value === true) {
				FFZUtils.instance.enable();
			}else{
				FFZUtils.instance.disable();
			}
			if(sParams.appearance.sevenTVEmotes.value === true && sParams.appearance.showEmotes.value === true) {
				SevenTVUtils.instance.enable();
			}else{
				SevenTVUtils.instance.disable();
			}

			/**
			 * Connect to Spotify (won't do anything if no credentials are available)
			 */
			SpotifyHelper.instance.connect();

			/**
			 * Init cypher secret feature
			 */
			const cypherKey = DataStore.get(DataStore.CYPHER_KEY);
			if(cypherKey) {
				this.cypherKey = cypherKey;
				ChatCypherPlugin.instance.initialize(cypherKey);
			}

			/**
			 * Init voicemod voice change event handler
			 */
			VoicemodWebSocket.instance.addEventListener(VoicemodEvent.VOICE_CHANGE, async (e:VoicemodEvent)=> {
				//Execute trigger
				const trigger:TwitchatDataTypes.MessageVoicemodData = {
					id:Utils.getUUID(),
					date:Date.now(),
					type:TwitchatDataTypes.TwitchatMessageType.VOICEMOD,
					platform:"twitchat",
					voiceID:e.voiceID,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(trigger);

				for (let i = 0; i < VoicemodWebSocket.instance.voices.length; i++) {
					const v = VoicemodWebSocket.instance.voices[i];
					if(v.id == e.voiceID) {
						try {
							const img = await VoicemodWebSocket.instance.getBitmapForVoice(v.id);
							v.image = img;
							sVoice.voicemodCurrentVoice = v;
						}catch(error){}
					}
				}
			});

			/**
			 * Called when a raffle animation (the wheel) completes
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.RAFFLE_RESULT, (e:TwitchatEvent<{winner:TwitchatDataTypes.RaffleEntry}>)=> {
				StoreProxy.raffle.onRaffleComplete(e.data!.winner);
			});

			/**
			 * Called when doing a shoutout to the latest raider
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.SHOUTOUT, (e:TwitchatEvent)=> {
				const raider = sStream.lastRaider;
				if(raider) {
					const me = StoreProxy.auth.twitch.user;
					sUsers.shoutout(me.id, raider);
				}else{
					StoreProxy.common.alert(StoreProxy.i18n.t("error.auto_shoutout"));
				}
			});

			/**
			 * Called when emergency mode is started or stoped
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.SET_EMERGENCY_MODE, (e:TwitchatEvent<{enabled:boolean}>)=> {
				let enabled = e.data!.enabled;
				//If no JSON is specified, just toggle the state
				if(!e.data || enabled === undefined) enabled = !sEmergency.emergencyStarted;
				sEmergency.setEmergencyMode(enabled)
			});

			/**
			 * Called when asking to pick a raffle winner
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.RAFFLE_PICK_WINNER, (e:TwitchatEvent)=> {
				StoreProxy.raffle.pickWinner();
			});

			/**
			 * Called when requesting ad break overlay parameters
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_AD_BREAK_OVERLAY_PARAMETERS, (e:TwitchatEvent)=> {
				const data = DataStore.get(DataStore.AD_BREAK_OVERLAY_PARAMS);
				if(!data) return;
				const ad = StoreProxy.stream.getCommercialInfo(StoreProxy.auth.twitch.user.id);
				PublicAPI.instance.broadcast(TwitchatEvent.AD_BREAK_OVERLAY_PARAMETERS, JSON.parse(data));
				PublicAPI.instance.broadcast(TwitchatEvent.AD_BREAK_DATA, (ad as unknown) as JsonObject);
			});

			/**
			 * Called when requesting bits wall overlay parameters
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_BITS_WALL_OVERLAY_PARAMETERS, (e:TwitchatEvent)=> {
				const data = DataStore.get(DataStore.BITS_WALL_PARAMS);
				if(!data) return;
				const json = JSON.parse(data) as TwitchatDataTypes.BitsWallOverlayData;
				if(!sAuth.isPremium) {
					json.break_durations = {1:10, 100:20, 1000:30, 5000:40, 10000:50};
				}
				PublicAPI.instance.broadcast(TwitchatEvent.BITSWALL_OVERLAY_PARAMETERS, (json as unknown) as JsonObject);
			});

			/**
			 * Called when asking to toggle message merging
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.MERGE_TOGGLE, (e:TwitchatEvent)=> {
				StoreProxy.params.features.mergeConsecutive.value = !StoreProxy.params.features.mergeConsecutive.value;
			});

			/**
			 * Called when asking to toggle message merging
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.ENDING_CREDITS_COMPLETE, (e:TwitchatEvent)=> {
				const message:TwitchatDataTypes.MessageCreditsCompleteData = {
					channel_id:StoreProxy.auth.twitch.user.id,
					date:Date.now(),
					id:Utils.getUUID(),
					platform:"twitchat",
					type:TwitchatDataTypes.TwitchatMessageType.CREDITS_COMPLETE,
				}
				TriggerActionHandler.instance.execute(message);
			});

			/**
			 * Called when requesting stream summary data
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_SUMMARY_DATA, async (e:TwitchatEvent<{offset:number, includeParams:boolean}>)=> {
				try {
					const d = e.data!;
					const summary = await StoreProxy.stream.getSummary(d.offset, d.includeParams === true);
					PublicAPI.instance.broadcast(TwitchatEvent.SUMMARY_DATA, (summary as unknown) as JsonObject)
				}catch(error) {
					console.error("An error occured when computing summary data");
					console.error(error);
				}
			});

			/**
			 * Called when requesting a distortion overlay's data
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_DISTORT_OVERLAY_PARAMETERS, async (e:TwitchatEvent<{distortionID:string}>)=> {
				const distortionID = e.data!.distortionID;
				const params = StoreProxy.heat.distortionList.find(v=>v.id == distortionID);

				const json = {
					params:(params as unknown) as JsonObject
				}
				PublicAPI.instance.broadcast(TwitchatEvent.DISTORT_OVERLAY_PARAMETERS, json);
			});

			/**
			 * Called when music player is clicked on the unified overlay
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.MUSIC_PLAYER_HEAT_CLICK, async (e:TwitchatEvent<TwitchatDataTypes.HeatClickData>)=> {
				const data = e.data!;
				//Init trigger data
				const action: TriggerActionChatData = {
					id: Utils.getUUID(),
					text: StoreProxy.chat.botMessages.heatSpotify.message,
					type: 'chat',
				};
				const trigger: TriggerData = {
					id: "heat_spotify_click",
					type: TriggerTypes.TWITCHAT_MESSAGE,
					enabled: true,
					actions: [action],
					cooldown: {
						user: 0,
						global: StoreProxy.chat.botMessages.heatSpotify.cooldown!,
						alert: false,
					}
				};
				let user!: Pick<TwitchatDataTypes.TwitchatUser, "id" | "login" | "channelInfo" | "anonymous">;
				const channelId = StoreProxy.auth.twitch.user.id;
				if (!data.anonymous) {
					//Load user data
					user = await new Promise((resolve) => {
						StoreProxy.users.getUserFrom("twitch", channelId, data.uid, undefined, undefined, (user) => {
							resolve(user);
						});
					});
				} else {
					//Create a fake partial user with only ID set so the trigger's cooldowns
					//can properly be applied later.
					const channelInfo: { [key: string]: TwitchatDataTypes.UserChannelInfo; } = {};
					channelInfo[channelId] = {
						badges: [],
						following_date_ms: -1,
						is_banned: false,
						is_broadcaster: false,
						is_following: false,
						is_gifter: false,
						is_moderator: false,
						is_new: false,
						is_raider: false,
						is_subscriber: false,
						is_vip: false,
						online: true,
					};
					user = { id: data.uid || "anon", login: "anon", channelInfo, anonymous: true };
				}
				const message: TwitchatDataTypes.MessageHeatClickData = {
					date: Date.now(),
					id: Utils.getUUID(),
					platform: "twitch",
					type: TwitchatDataTypes.TwitchatMessageType.HEAT_CLICK,
					user,
					anonymous: data.anonymous,
					channel_id: channelId,
					alt: data.alt === true,
					ctrl: data.ctrl === true,
					shift: data.shift === true,
					coords: {
						x: data.x * 100,
						y: data.y * 100,
					}
				};

				TriggerActionHandler.instance.executeTrigger(trigger, message, data.testMode == true);
			});

			/**
			 * Called when pushing custom messages on Twitchat
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.CUSTOM_CHAT_MESSAGE, (e:TwitchatEvent<TwitchatDataTypes.MessageCustomDataAPI>)=> {
				const data = e.data!;
				const chunksMessage = TwitchUtils.parseMessageToChunks(data.message || "", undefined, true);
				const chunksQuote = !data.quote? [] : TwitchUtils.parseMessageToChunks(data.quote, undefined, true);
				const message:TwitchatDataTypes.MessageCustomData = {
					id: Utils.getUUID(),
					date: Date.now(),
					platform: "twitchat",
					type: TwitchatDataTypes.TwitchatMessageType.CUSTOM,
					actions: data.actions,
					message: data.message,
					message_chunks: chunksMessage,
					message_html: TwitchUtils.messageChunksToHTML(chunksMessage),
					quote: data.quote,
					quote_chunks: chunksQuote,
					quote_html: TwitchUtils.messageChunksToHTML(chunksQuote),
					highlightColor: data.highlightColor,
					col: data.col,
					style: data.style,
					icon: data.icon,
					user: data.user,
					channel_id:StoreProxy.auth.twitch.user.id,
				};
				StoreProxy.chat.addMessage(message);
			});

			/**
			 * Called when prediction overlay request for its configs
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_PREDICTIONS_OVERLAY_PARAMETERS, (e:TwitchatEvent)=> {
				StoreProxy.prediction.broadcastState();
			});

			/**
			 * Called when poll overlay request for its configs
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_POLLS_OVERLAY_PARAMETERS, (e:TwitchatEvent)=> {
				StoreProxy.poll.broadcastState();
			});

			/**
			 * Called when timer overlay requests for current timers
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_CURRENT_TIMERS, ()=> {
				sTimer.broadcastStates();
			});

			/**
			 * Listen for highlighted message to show up the "close highlighted message" button
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.SET_CHAT_HIGHLIGHT_OVERLAY_MESSAGE, (e:TwitchatEvent<{message:string}|undefined>)=> {
				sChat.isChatMessageHighlighted = e.data != undefined && e.data.message != undefined;
			});

			/**
			 * Called when bingo grid overlay request for its configs
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.GET_BINGO_GRID_PARAMETERS, (e:TwitchatEvent<{bid:string}>)=> {
				const bingo = StoreProxy.bingoGrid.gridList.find(v=>v.id == e.data!.bid);
				if(bingo) {
					if(!bingo.enabled) return;
					PublicAPI.instance.broadcast(TwitchatEvent.BINGO_GRID_PARAMETERS, {id:e.data!.bid, bingo:bingo as unknown as JsonObject, newVerticalBingos:[], newHorizontalBingos:[],  newDiagonalBingos:[]});
				}else{
					//Tell the overlay requested bingo couldn't be found
					PublicAPI.instance.broadcast(TwitchatEvent.BINGO_GRID_PARAMETERS, {id:e.data!.bid, bingo:null});
				}
			});

			/**
			 * Called when switching to another scene
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_SCENE_CHANGE, async (event:TwitchatEvent):Promise<void> => {
				//If no scene whas stored, get the current one to use it as the "previousSceneName" on the trigge rmessage
				if(!StoreProxy.common.currentOBSScene) {
					StoreProxy.common.currentOBSScene = await OBSWebsocket.instance.getCurrentScene();
				}
				const e = event.data as {sceneName:string};
				const m:TwitchatDataTypes.MessageOBSSceneChangedData = {
					id: Utils.getUUID(),
					date: Date.now(),
					platform: "twitchat",
					type: TwitchatDataTypes.TwitchatMessageType.OBS_SCENE_CHANGE,
					sceneName: e.sceneName,
					previousSceneName: StoreProxy.common.currentOBSScene,
					channel_id:StoreProxy.auth.twitch.user.id,
				};
				StoreProxy.common.currentOBSScene = e.sceneName;
				TriggerActionHandler.instance.execute(m);
				rebuildPlaceholdersCache();
			});

			/**
			 * Called when a source visibility is toggled
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_SOURCE_TOGGLE, (event:TwitchatEvent):void => {
				const data = (event.data as unknown) as {item:OBSSourceItem, event:{sceneItemId:number, sceneItemEnabled:boolean, sceneName:string}};
				const m:TwitchatDataTypes.MessageOBSSourceToggleData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					type:TwitchatDataTypes.TwitchatMessageType.OBS_SOURCE_TOGGLE,
					sourceName:data.item.sourceName,
					sourceItemId:data.event.sceneItemId,
					visible:data.event.sceneItemEnabled,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(m);
			});

			/**
			 * Called when a source is muted or unmuted
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_MUTE_TOGGLE, (event:TwitchatEvent):void => {
				const data = (event.data as unknown) as {inputName:string, inputMuted:boolean};
				const m:TwitchatDataTypes.MessageOBSInputMuteToggleData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					type:TwitchatDataTypes.TwitchatMessageType.OBS_INPUT_MUTE_TOGGLE,
					inputName:data.inputName,
					muted:data.inputMuted,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(m);
			});

			/**
			 * Called when a filter visibility is toggled
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_FILTER_TOGGLE, (event:TwitchatEvent):void => {
				const data = (event.data as unknown) as {sourceName: string, filterName: string, filterEnabled: boolean};
				const m:TwitchatDataTypes.MessageOBSFilterToggleData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					type:TwitchatDataTypes.TwitchatMessageType.OBS_FILTER_TOGGLE,
					sourceName:data.sourceName,
					filterName:data.filterName,
					enabled:data.filterEnabled,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(m);
			});

			/**
			 * Called when streaming is started/stoped on OBS
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_STREAM_STATE, (event:TwitchatEvent):void => {
				const data = (event.data as unknown) as {outputActive: boolean, outputState: string};
				let m:TwitchatDataTypes.MessageOBSStartStreamData | TwitchatDataTypes.MessageOBSStopStreamData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					type: TwitchatDataTypes.TwitchatMessageType.OBS_START_STREAM,
					channel_id:StoreProxy.auth.twitch.user.id,
				};
				if(!data.outputActive){
					m = {...m,
						type: TwitchatDataTypes.TwitchatMessageType.OBS_STOP_STREAM,
					};
				}
				TriggerActionHandler.instance.execute(m);
			});

			/**
			 * Called when a playback event occurs on a media source
			 * @param event
			 */
			function onPlayBackStateChanged(event:TwitchatEvent):void {
				const data = (event.data as unknown) as {inputName:string};
				const typeToState:Partial<{[key in TwitchatEventType]:TwitchatDataTypes.MessageOBSPlaybackStateValue}> = {};
				typeToState[TwitchatEvent.OBS_PLAYBACK_ENDED]		= "complete";
				typeToState[TwitchatEvent.OBS_PLAYBACK_STARTED]		= "start";
				typeToState[TwitchatEvent.OBS_PLAYBACK_PAUSED]		= "pause";
				typeToState[TwitchatEvent.OBS_PLAYBACK_NEXT]		= "next";
				typeToState[TwitchatEvent.OBS_PLAYBACK_PREVIOUS]	= "prev";
				typeToState[TwitchatEvent.OBS_PLAYBACK_RESTARTED]	= "restart";
				const m:TwitchatDataTypes.MessageOBSPlaybackStateUpdateData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					type:TwitchatDataTypes.TwitchatMessageType.OBS_PLAYBACK_STATE_UPDATE,
					inputName:data.inputName,
					state:typeToState[event.type as TwitchatEventType]!,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(m);
			}

			/**
			 * Called when an OBS source is renamed.
			 * Rename it on all triggers
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_INPUT_NAME_CHANGED, (event:TwitchatEvent):void => {
				const data = event.data as {oldInputName:string, inputName:string};
				StoreProxy.triggers.renameOBSSource(data.oldInputName, data.inputName);
			});

			/**
			 * Called when an OBS scene is renamed.
			 * Rename it on all triggers
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_SCENE_NAME_CHANGED, (event:TwitchatEvent):void => {
				const data = event.data as {oldSceneName:string, sceneName:string};
				StoreProxy.triggers.renameOBSScene(data.oldSceneName, data.sceneName);
			});

			/**
			 * Called when an OBS Filter is renamed.
			 * Rename it on all triggers
			 */
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_FILTER_NAME_CHANGED, (event:TwitchatEvent):void => {
				const data = event.data as {sourceName: string; oldFilterName: string; filterName: string};
				StoreProxy.triggers.renameOBSFilter(data.sourceName, data.oldFilterName, data.filterName);
			});

			OBSWebsocket.instance.heatClickTriggerType = TriggerTypes.HEAT_CLICK;//Read "heatClickTriggerType" to understand this line
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_PLAYBACK_ENDED, (e) => onPlayBackStateChanged(e));
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_PLAYBACK_STARTED, (e) => onPlayBackStateChanged(e));
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_PLAYBACK_PAUSED, (e) => onPlayBackStateChanged(e));
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_PLAYBACK_NEXT, (e) => onPlayBackStateChanged(e));
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_PLAYBACK_PREVIOUS, (e) => onPlayBackStateChanged(e));
			OBSWebsocket.instance.addEventListener(TwitchatEvent.OBS_PLAYBACK_RESTARTED, (e) => onPlayBackStateChanged(e));

			/**
			 * Called when a user clicks on the stream
			 * Detects for a few twitch overlay being clicked as well as all the custom areas
			 */
			HeatSocket.instance.addEventListener(HeatEvent.CLICK, async (event:HeatEvent):Promise<void> => {
				StoreProxy.heat.handleClickEvent(event);
			});

			/**
			 * Handle GoXLR button events (press/release)
			 */
			function onGoXLRButton(event:GoXLRSocketEvent):void {
				const message:TwitchatDataTypes.MessageGoXLRButtonData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					pressed:event.type == GoXLRSocketEvent.BUTTON_PRESSED,
					button:event.buttonId!,
					type:TwitchatDataTypes.TwitchatMessageType.GOXLR_BUTTON,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(message);
			}
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.BUTTON_PRESSED, onGoXLRButton);
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.BUTTON_RELEASED, onGoXLRButton);

			/**
			 * Handle GoXLR FX state
			 */
			function onGoXLRFx(event:GoXLRSocketEvent):void {
				const message:TwitchatDataTypes.MessageGoXLRFXEnableChangeData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					fxIndex:event.fxIndex!,
					enabled:event.type == GoXLRSocketEvent.FX_ENABLED,
					type:TwitchatDataTypes.TwitchatMessageType.GOXLR_FX_STATE,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(message);
			}
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.FX_ENABLED, onGoXLRFx);
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.FX_DISABLED, onGoXLRFx);

			/**
			 * Handle GoXLR mute state
			 */
			function onGoXLRMute(event:GoXLRSocketEvent):void {
				const message:TwitchatDataTypes.MessageGoXLRSoundInputData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					mute:event.type == GoXLRSocketEvent.FADER_MUTE,
					faderIndex: event.faderIndex!,
					type:TwitchatDataTypes.TwitchatMessageType.GOXLR_SOUND_INPUT,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(message);
			}
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.FADER_MUTE, onGoXLRMute);
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.FADER_UNMUTE, onGoXLRMute);

			/**
			 * Handle GoXLR sampler complete
			 */
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.SAMPLE_PLAYBACK_COMPLETE, (e:GoXLRSocketEvent)=>{
				const message:TwitchatDataTypes.MessageGoXLRSampleCompleteData = {
					id:Utils.getUUID(),
					date:Date.now(),
					platform:"twitchat",
					type:TwitchatDataTypes.TwitchatMessageType.GOXLR_SAMPLE_COMPLETE,
					bank:e.bankId!,
					buttonId:e.samplerButtonId!,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				TriggerActionHandler.instance.execute(message);
			});

			/**
			 * Handle GoXLR encoder value change
			 */
			GoXLRSocket.instance.addEventListener(GoXLRSocketEvent.ENCODER, (e:GoXLRSocketEvent)=>{
				const configs = [StoreProxy.params.goxlrConfig.chatScrollSources, StoreProxy.params.goxlrConfig.chatReadMarkSources];
				for (let j = 0; j < configs.length; j++) {
					const config = configs[j];
					const indexToButtonId = ["EffectSelect1", "EffectSelect2", "EffectSelect3", "EffectSelect4", "EffectSelect5", "EffectSelect6"];
					for (let i = 0; i < config.length; i++) {
						const column = config[i];
						if(column[0] == indexToButtonId[e.fxIndex!]
						&& column[1] == e.encoderId!) {
							const key = e.fxIndex+"_"+e.encoderId+"_"+e.encoderValue;
							const id = e.encoderId!;
							const value = e.encoderValue!;
							const encoderParams = GoXLRSocket.instance.getEncoderPossibleValues(id);
							const resetValue = encoderParams.values[Math.round(encoderParams.values.length/2)]
							if(value !== resetValue) {
								const prevValue = e.prevEncoderValue!;
								const index1 = encoderParams.values.indexOf(prevValue);
								const index2 = encoderParams.values.indexOf(value);
								const delta = Math.round((index2 - index1)/encoderParams.step);
								//Scroll chat column
								if(j == 0) {
									PublicAPI.instance.broadcast(TwitchatEvent.CHAT_FEED_SCROLL, { col:i, scrollBy:delta }, true);
								}else{
									PublicAPI.instance.broadcast(TwitchatEvent.CHAT_FEED_READ, { col:i, count:delta }, true);
								}
								// let resetValue = prevValue;
								// let resetValue = encoderParams.values[Math.round(encoderParams.values.length/2)];
								// if(prevValue == encoderParams.values[0]) resetValue = encoderParams.values[1];
								// if(prevValue == encoderParams.values[encoderParams.values.length-1]) resetValue = encoderParams.values[encoderParams.values.length-2];
								//Reset encoder value
								GoXLRSocket.instance.setEncoderValue(id, resetValue);
							}
						}
				}
				}
			});

			if(DataStore.get(DataStore.HEAT_ENABLED) === "true" && StoreProxy.auth.twitch.user) {
				HeatSocket.instance.connect( StoreProxy.auth.twitch.user.id );
			}
		},

		loadDataFromStorage() {
			window.setInitMessage("load user data to memory");
			/**
			 * CAREFUL THIS METHOD CAN BE CALLED MULTIPLE TIMES
			 * Don't do anything that could break if called multiple times!
			 */

			StoreProxy.obs.populateData();
			StoreProxy.tts.populateData();
			StoreProxy.poll.populateData();
			StoreProxy.chat.populateData();
			StoreProxy.heat.populateData();
			StoreProxy.kofi.populateData();
			StoreProxy.voice.populateData();
			StoreProxy.music.populateData();
			StoreProxy.lumia.populateData();
			StoreProxy.users.populateData();
			StoreProxy.stream.populateData();
			StoreProxy.params.populateData();
			StoreProxy.values.populateData();
			StoreProxy.tipeee.populateData();
			StoreProxy.discord.populateData();
			StoreProxy.automod.populateData();
			StoreProxy.triggers.populateData();
			StoreProxy.counters.populateData();
			StoreProxy.bingoGrid.populateData();
			StoreProxy.emergency.populateData();
			StoreProxy.streamlabs.populateData();
			StoreProxy.prediction.populateData();
			StoreProxy.streamelements.populateData();

			const theme = DataStore.get(DataStore.THEME);
			if(theme) {
				StoreProxy.common.theme = theme as "light" | "dark";
			}

			//Init alert actions
			const alert = DataStore.get(DataStore.ALERT_PARAMS);
			if(alert) {
				Utils.mergeRemoteObject(JSON.parse(alert), (this.chatAlertParams as unknown) as JsonObject);
			}

			//Init trigger websocket
			const triggerSocketParams = DataStore.get(DataStore.WEBSOCKET_TRIGGER);
			if(triggerSocketParams) {
				const params = JSON.parse(triggerSocketParams) as SocketParams;
				let url = params.secured === true? "wss://" : "ws://";
				url += params.ip;
				if(params.port) url += ":"+params.port;

				WebsocketTrigger.instance.connect(url).then(()=>{}).catch(()=> {});
			}

			Database.instance.connect().then(async ()=> {
				await StoreProxy.chat.preloadMessageHistory();

				//Reload devmode state
				this.toggleDevMode( DataStore.get(DataStore.DEVMODE) === "true" );
			});

			SchedulerHelper.instance.start();

			/**
			 * Connect to Youtube (won't do anything if no credentials are available)
			 */
			YoutubeHelper.instance.connect();
		},

		confirm<T>(title: string, description?: string, data?: T, yesLabel?:string, noLabel?:string, STTOrigin?:boolean): Promise<T|undefined> {
			return <Promise<T|undefined>>new Promise((resolve, reject) => {
				this.confirmData = {
					title,
					description,
					yesLabel,
					noLabel,
					STTOrigin,
					confirmCallback : () => {
						resolve(data);
					},
					cancelCallback : () => {
						reject(data);
					}
				}
			});
		},

		closeConfirm():void { this.confirmData = null; },

		openTooltip(payload:string) { this.tooltip = payload; },

		closeTooltip() { this.tooltip = ""; },

		setCypherKey(payload:string) {
			this.cypherKey = payload;
			ChatCypherPlugin.instance.cypherKey = payload;
			DataStore.set(DataStore.CYPHER_KEY, payload);
		},

		setCypherEnabled(payload:boolean) { this.cypherEnabled = payload; },

		toggleDevMode(forcedState?:boolean) {
			if(forcedState == this.devmode) return;

			let notify = true;
			if(forcedState !== undefined) {
				this.devmode = forcedState;
				notify = forcedState
			}else{
				this.devmode = !this.devmode;
			}
			if(this.devmode != JSON.parse(DataStore.get(DataStore.DEVMODE))) {
				DataStore.set(DataStore.DEVMODE, this.devmode);
			}
			if(notify) {
				let str = StoreProxy.i18n.t("global.dev_mode.enabled");
				if(!this.devmode) {
					str = StoreProxy.i18n.t("global.dev_mode.disabled");
				}
				const message:TwitchatDataTypes.MessageNoticeData = {
					id: Utils.getUUID(),
					date: Date.now(),
					platform: "twitchat",
					type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
					noticeId:TwitchatDataTypes.TwitchatNoticeType.DEVMODE,
					message:str,
					channel_id:StoreProxy.auth.twitch.user.id,
				}
				StoreProxy.chat.addMessage(message);
			}
		},

		setAhsInstaller(value:TwitchatDataTypes.InstallHandler) { this.$state.ahsInstaller = value; },

		setChatAlertParams(params:TwitchatDataTypes.AlertParamsData) {
			this.chatAlertParams = params;
			DataStore.set(DataStore.ALERT_PARAMS, params);
		},

		async executeChatAlert(message:TwitchatDataTypes.MessageChatData|TwitchatDataTypes.MessageWhisperData|null) {
			this.chatAlert = message;
			await Utils.promisedTimeout(50);
			this.chatAlert = null;
		},
	} as IMainActions & ThisType<IMainActions & UnwrapRef<IMainState> & _StoreWithState<"main", IMainState, IMainGetters, IMainActions> & _StoreWithGetters<IMainGetters> & PiniaCustomProperties>
})
