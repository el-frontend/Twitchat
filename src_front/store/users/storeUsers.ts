import EventBus from '@/events/EventBus';
import GlobalEvent from '@/events/GlobalEvent';
import MessengerProxy from '@/messaging/MessengerProxy';
import { TwitchatDataTypes } from '@/types/TwitchatDataTypes';
import Config from '@/utils/Config';
import Utils from '@/utils/Utils';
import { TwitchScopes } from '@/utils/twitch/TwitchScopes';
import TwitchUtils from '@/utils/twitch/TwitchUtils';
import { defineStore, type PiniaCustomProperties, type _StoreWithGetters, type _StoreWithState } from 'pinia';
import { reactive, type UnwrapRef } from 'vue';
import DataStore from '../DataStore';
import type { IUsersActions, IUsersGetters, IUsersState } from '../StoreProxy';
import StoreProxy from '../StoreProxy';

interface BatchItem {
	channelId?:string;
	user:TwitchatDataTypes.TwitchatUser
	cb?:(user:TwitchatDataTypes.TwitchatUser) => void;
}

//Don't store this as a state prop.
//Having this list reactive kills performances while being
//unnecessary
const userList:TwitchatDataTypes.TwitchatUser[] = [];
//FIXME few duplicates happen in the userlist

const unbanFlagTimeouts:{[key:string]:number} = {};
const userMaps:Partial<{[key in TwitchatDataTypes.ChatPlatform]:{
	idToUser:{[key:string]:TwitchatDataTypes.TwitchatUser},
	loginToUser:{[key:string]:TwitchatDataTypes.TwitchatUser},
	displayNameToUser:{[key:string]:TwitchatDataTypes.TwitchatUser},
}}> = {};

const twitchUserBatchLoginToLoad:BatchItem[] = [];
const twitchUserBatchIdToLoad:{channelId?:string, user:TwitchatDataTypes.TwitchatUser, cb?:(user:TwitchatDataTypes.TwitchatUser) => void}[] = [];
const moderatorsCache:{[key:string]:{[key:string]:true}} = {};
let twitchUserBatchLoginTimeout = -1;
let twitchUserBatchIdTimeout = -1;

export const storeUsers = defineStore('users', {
	state: () => ({
		tmpDisplayName:"...loading...",
		pendingShoutouts: {},
		userCard: null,
		customUsernames: {},
		customUserBadges: {},
		customBadgeList:[],
		blockedUsers: {
			twitchat:{},
			twitch:{},
			instagram:{},
			youtube:{},
			tiktok:{},
			facebook:{},
		},
		myFollowings:{
			twitchat:{},
			twitch:{},
			instagram:{},
			youtube:{},
			tiktok:{},
			facebook:{},
		},
		myFollowers:{
			twitchat:{},
			twitch:{},
			instagram:{},
			youtube:{},
			tiktok:{},
			facebook:{},
		},
		knownBots: {
			twitchat:{},
			twitch:{},
			instagram:{},
			youtube:{},
			tiktok:{},
			facebook:{},
		}
	} as IUsersState),



	getters: {
		users():TwitchatDataTypes.TwitchatUser[] { return userList; },
	},



	actions: {
		/**
		 * Registers the bots hashmap of a platform
		 * Maps a lowercased login to a boolean (true)
		 */
		setBotsMap(platform:TwitchatDataTypes.ChatPlatform, hashmap:{[key:string]:boolean}):void {
			this.knownBots[platform] = hashmap;
		},

		/**
		 * Registers the bots hashmap of a platform
		 */
		isAFollower(platform:TwitchatDataTypes.ChatPlatform, id:string):boolean {
			return  this.myFollowers[platform][id] != undefined;
		},

		/**
		 * Preloads twitch moderators
		 */
		async preloadTwitchModerators(channelId:string):Promise<void> {
			const users = await TwitchUtils.getModerators(channelId);
			moderatorsCache[channelId] = {};
			users.forEach(v => {
				moderatorsCache[channelId][v.user_id] = true;
			});
		},

		/**
		 * Preloads latest ban states
		 */
		async preloadUserBanStates(channelId:string):Promise<void> {
			const users = await TwitchUtils.getBannedUsers(channelId, userList.filter(v=>v.platform == "twitch").map(v=>v.id));
			for (let i = 0; i < users.length; i++) {
				const u = users[i];
				const user = this.getUserFrom("twitch", channelId, u.user_id, u.user_login, u.user_name);
				user.channelInfo[channelId].is_banned = true;
				if(u.expires_at) {
					user.channelInfo[channelId].banEndDate = new Date(u.expires_at).getTime();
				}
			}
		},

		/**
		 * Gets a user by their source from their ID nor login.
		 * It registers the user on the local DB to get them back later.
		 * If only the login is given, the user's data are loaded asynchronously from
		 * remote API then added to the local DB while returning a temporary user object.
		 * 
		 * @param platform 
		 * @param id 
		 * @param login 
		 * @param displayName 
		 * @returns 
		 */
		getUserFrom(platform:TwitchatDataTypes.ChatPlatform, channelId?:string, id?:string, login?:string, displayName?:string, loadCallback?:(user:TwitchatDataTypes.TwitchatUser)=>void, forcedFollowState:boolean = false, getPronouns:boolean = false):TwitchatDataTypes.TwitchatUser {
			const s = Date.now();
			let user:TwitchatDataTypes.TwitchatUser|undefined;
			//Search for the requested user via hashmaps for fast accesses
			let hashmaps = userMaps[platform];
			if(!hashmaps){
				hashmaps = {
					idToUser:{},
					loginToUser:{},
					displayNameToUser:{},
				};
				userMaps[platform] = hashmaps;
			}

			//Cleanup any "@" here so we don't have to do that for every commands
			if(login && login != this.tmpDisplayName)				login = login.replace("@", "").toLowerCase().trim();
			if(displayName && displayName != this.tmpDisplayName)	displayName = displayName.replace("@", "").trim();
			
			//Search user on hashmaps
			if(id && hashmaps.idToUser[id])									user = hashmaps.idToUser[id];
			else if(login && hashmaps.loginToUser[login])					user = hashmaps.loginToUser[login];
			else if(displayName && hashmaps.displayNameToUser[displayName])	user = hashmaps.displayNameToUser[displayName];
			
			const userExisted = user != undefined;

			if(!user) {
				//Create user if enough given info
				if(id && login) {
					const userData:TwitchatDataTypes.TwitchatUser = {
						platform,
						id:id ?? "",
						login:login ?? "",
						displayName: displayName ?? login ?? "",
						displayNameOriginal:displayName ?? "",
						pronouns:null,
						pronounsLabel:false,
						pronounsTooltip:false,
						is_partner:false,
						is_affiliate:false,
						is_tracked:false,
						is_blocked:false,
						is_bot:this.knownBots[platform][login ?? ""] === true,
						channelInfo:{},
					};
					user = reactive(userData);
				}else
				//If we don't have enough info, create a temp user object and load
				//its details from the API then register it if found.
				if(!login || !id || !displayName) {
					if(!login && displayName) login = displayName.toLowerCase();
					const userData:TwitchatDataTypes.TwitchatUser = {
						platform:platform,
						id:id??Utils.getUUID(),
						login:login??"",
						displayName:displayName??login??"",
						displayNameOriginal:displayName??login??"",
						temporary:true,
						pronouns:null,
						pronounsLabel:false,
						pronounsTooltip:false,
						is_partner:false,
						is_affiliate:false,
						is_tracked:false,
						is_blocked:false,
						is_bot:this.knownBots[platform][login ?? ""] === true,
						channelInfo:{},
					};
					
					user = reactive(userData);
				}

				// user = reactive(user!);
			}

			//Override "displayName" property by a getter that returns either the 
			//"displayNameOriginal" value or the "customUsername" if any is defined
			//This is to avoid updating "displayName" accessors everywhere on the app.
			Object.defineProperty(user, 'displayName', {
				set: function(name) {
					(this as TwitchatDataTypes.TwitchatUser).displayNameOriginal = name;
				},
				get: function() {
					const ref = (this as TwitchatDataTypes.TwitchatUser);
					return StoreProxy.users.customUsernames[ref.id]?.name || ref.displayNameOriginal || ref.login
				}}
			);
			
			//This just makes the rest of the code know that the user
			//actually exists as it cannot be undefined anymore once
			//we're here.
			user = user!;

			if(channelId) {
				//Init channel data for this user if not already existing
				if(!user.channelInfo[channelId]) {
					let following_date_ms = 0;
					let is_following:boolean|null = channelId == user.id || forcedFollowState===true;
					if(!is_following) {
						if(this.myFollowers[platform][user.id] !== undefined) {
							is_following = true;
							following_date_ms = this.myFollowers[platform][user.id];
						}else{
							is_following = null;
						}
					}
					user.channelInfo[channelId] = {
						online:false,
						is_new:false,
						following_date_ms,
						is_following,
						is_raider:false,
						is_banned:false,
						is_vip:false,
						is_moderator:moderatorsCache[channelId] && moderatorsCache[channelId][user.id] === true || channelId == user.id,
						is_broadcaster:channelId == user.id,
						is_subscriber:false,
						is_gifter:false,
						badges:[],
					};
				}
	
				if(this.blockedUsers[platform][user.id] === true) {
					user.is_blocked = true;
				}
			}
			
			if(!user.temporary) {
				if(getPronouns && user.id && user.login && user.pronouns == null) this.loadUserPronouns(user);
				if(channelId && user.id && user.channelInfo[channelId].is_following == null) this.checkFollowerState(user, channelId);
			}
				
			if(!user.displayName) user.displayName = this.tmpDisplayName;
			if(!user.login) user.login = this.tmpDisplayName;

			//User was already existing, consider stop there
			if(userExisted){
				if(loadCallback) loadCallback(user);
				const e = Date.now();
				// console.log("Duration 1 :", user.login, user.id, e-s);
				return user;
			}

			const needCreationDate = user.created_at_ms == undefined;// && StoreProxy.params.appearance.recentAccountUserBadge.value === true;
			if(platform == "twitch" && (user.temporary || needCreationDate)) {
				//Wait half a second to let time to external code to populate the
				//object with more details like in TwitchMessengerClient that calls
				//this method, then populates the is_partner and is_affiliate and
				//other fields from IRC tags which avoids the need to get the users
				//details via an API call.
				const to = setTimeout((batchType:"id"|"login")=> {
					
					const batch:BatchItem[] = batchType == "login"? twitchUserBatchLoginToLoad.splice(0) : twitchUserBatchIdToLoad.splice(0);
					
					//Remove items that might have been fullfilled externally
					for (let i = 0; i < batch.length; i++) {
						const item = batch[i];
						if(!item.user.temporary && !needCreationDate) {
							if(item.cb) item.cb(item.user);
							batch.splice(i,1);
							i--;
						}
					}

					const logins:string[]|undefined	= batchType == "login"? batch.map(v=>v.user.login) : undefined;
					const ids:string[]|undefined	= batchType == "login"? undefined : batch.map(v=>v.user.id);

					if((ids?.length == 0 || ids == undefined) && (logins?.length == 0 || logins == undefined)) return;

					// console.log("LOAD BATCH", batchType, batchType=="id"? ids : logins);
					
					TwitchUtils.loadUserInfo(ids, logins)
					.then(async (res) => {
						// console.log("Batch loaded", batchType);
						// console.log(res);
						// console.log(JSON.parse(JSON.stringify(batch)));

						do {
							const batchItem:BatchItem = batch.splice(0, 1)[0];
							if(!batchItem) continue;
							const userLocal = batchItem.user;
							delete userLocal.temporary;
							// console.log("Search user", batchType=="id"? userLocal.id : userLocal.login);
							type UserKeys = keyof TwitchatDataTypes.TwitchatUser;
							const key:UserKeys = batchType;
							const apiUser = res.find(v => v[key].toLowerCase() == userLocal[key].toLowerCase());
							if(!apiUser) {
								// console.log("User not found.... ", userLocal.login, userLocal.id);
								//User not sent back by twitch API.
								//Most probably because login is wrong or user is banned
								userLocal.displayName = " error(#"+(user!.displayName || user!.login || user!.id)+")";
								userLocal.login = " error(#"+(user!.login || user!.displayName || user!.id)+")";
								userLocal.errored = true;
								
							}else{
								
								//User sent back by API
								//Update user info with the API data
								// console.log("User found", apiUser.login, apiUser.id);
								userLocal.id				= apiUser.id;
								userLocal.login				= apiUser.login;
								userLocal.displayName		= userLocal.displayNameOriginal = apiUser.display_name;
								userLocal.is_partner		= apiUser.broadcaster_type == "partner";
								userLocal.is_affiliate		= userLocal.is_partner || apiUser.broadcaster_type == "affiliate";
								userLocal.created_at_ms		= new Date(apiUser.created_at).getTime();
								if(!userLocal.avatarPath)	userLocal.avatarPath = apiUser.profile_image_url;
								if(userLocal.id)			hashmaps!.idToUser[userLocal.id] = userLocal;
								if(userLocal.login)			hashmaps!.loginToUser[userLocal.login] = userLocal;
								if(userLocal.displayNameOriginal)	hashmaps!.displayNameToUser[userLocal.displayNameOriginal] = userLocal;
								
								//Load pronouns if requested
								if(getPronouns && userLocal.id && userLocal.login) this.loadUserPronouns(userLocal);

								//Set moderator state for all connected channels
								for (const chan in moderatorsCache) {
									if(!userLocal.channelInfo[chan]) continue;

									const cache = moderatorsCache[chan];
									userLocal.channelInfo[chan].is_moderator = cache && cache[userLocal.id] === true;
								}
								//Check follower state
								if(batchItem.channelId && userLocal.id && userLocal.channelInfo[batchItem.channelId].is_following == null) {
									this.checkFollowerState(userLocal, batchItem.channelId);
								}
							}
							if(batchItem.cb) batchItem.cb(userLocal);
						}while(batch.length > 0);
					});
				}, 500, login? "login": "id");

				//Batch requests by types.
				//All items loaded by their IDs on one batch, by logins on another batch.
				if(id) {
					twitchUserBatchIdToLoad.push({user, channelId, cb:loadCallback});
					if(twitchUserBatchIdToLoad.length < 100) {
						if(twitchUserBatchIdTimeout > -1) clearTimeout(twitchUserBatchIdTimeout);
						twitchUserBatchIdTimeout = to;
					}
				} else if(login) {
					twitchUserBatchLoginToLoad.push({user, channelId, cb:loadCallback});
					if(twitchUserBatchLoginToLoad.length < 100) {
						if(twitchUserBatchLoginTimeout > -1) clearTimeout(twitchUserBatchLoginTimeout);
						twitchUserBatchLoginTimeout = to;
					}
				}
			}else 
			if(platform != "twitch" && user.temporary) {
				user.temporary = false;//Avoid blocking promise execution on caller
			}
			
			//Attribute a random color to the user (overwrite that externally if necessary)
			user.color = Utils.pickRand(["#ff0000","#0000ff","#008000","#b22222","#ff7f50","#9acd32","#ff4500","#2e8b57","#daa520","#d2691e","#5f9ea0","#1e90ff","#ff69b4","#8a2be2","#00ff7f"]);

			if(user.id)						hashmaps.idToUser[user.id] = user;
			if(user.login)					hashmaps.loginToUser[user.login] = user;
			if(user.displayNameOriginal)	hashmaps.displayNameToUser[user.displayNameOriginal] = user;

			userList.push(user);

			if(user.temporary != true) {
				if(loadCallback) loadCallback(user);
			}
			const e = Date.now();
			// console.log("Duration 2 :", user.login, user.id, e-s);
			return user;
		},

		async initBlockedUsers():Promise<void> {
			if(!TwitchUtils.hasScopes([TwitchScopes.LIST_BLOCKED])) return;

			//Get list of all blocked users and build a hashmap out of it
			try {
				const blockedUsers = await TwitchUtils.getBlockedUsers();
				for (let i = 0; i < blockedUsers.length; i++) {
					this.blockedUsers["twitch"][ blockedUsers[i].user_id ] = true;
				}
			}catch(error) {/*ignore*/}
		},

		flagMod(platform:TwitchatDataTypes.ChatPlatform, channelId:string, uid:string):void {
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform && userList[i].channelInfo[channelId]) {
					userList[i].channelInfo[channelId].is_moderator = true;
					break;
				}
			}
		},
		
		flagUnmod(platform:TwitchatDataTypes.ChatPlatform, channelId:string, uid:string):void {
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform && userList[i].channelInfo[channelId]) {
					userList[i].channelInfo[channelId].is_moderator = false;
					break;
				}
			}
		},

		flagVip(platform:TwitchatDataTypes.ChatPlatform, channelId:string, uid:string):void {
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform && userList[i].channelInfo[channelId]) {
					userList[i].channelInfo[channelId].is_vip = true;
					break;
				}
			}
		},
		
		flagUnvip(platform:TwitchatDataTypes.ChatPlatform, channelId:string, uid:string):void {
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform && userList[i].channelInfo[channelId]) {
					userList[i].channelInfo[channelId].is_vip = false;
					break;
				}
			}
		},

		flagBlocked(platform:TwitchatDataTypes.ChatPlatform, uid:string):void {
			let user!:TwitchatDataTypes.TwitchatUser;
			this.blockedUsers[platform][uid] = true;
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform) {
					user = userList[i];
					user.is_blocked = true;
					break;
				}
			}

			if(!user) return;

			let m:TwitchatDataTypes.MessageNoticeData = {
				date:Date.now(),
				id:Utils.getUUID(),
				message: StoreProxy.i18n.t("global.moderation_action.blocked", {USER:user.displayName}),
				noticeId: TwitchatDataTypes.TwitchatNoticeType.BLOCKED,
				platform,
				type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
			}
			StoreProxy.chat.addMessage(m);
		},
		
		flagUnblocked(platform:TwitchatDataTypes.ChatPlatform, uid:string):void {
			let user!:TwitchatDataTypes.TwitchatUser;
			this.blockedUsers[platform][uid] = true;
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform) {
					user = userList[i];
					user.is_blocked = false;
					break;
				}
			}

			if(!user) return;

			let m:TwitchatDataTypes.MessageNoticeData = {
				date:Date.now(),
				id:Utils.getUUID(),
				message: StoreProxy.i18n.t("global.moderation_action.unblocked", {USER:user.displayName}),
				noticeId: TwitchatDataTypes.TwitchatNoticeType.UNBLOCKED,
				platform,
				type:TwitchatDataTypes.TwitchatMessageType.NOTICE,
			}
			StoreProxy.chat.addMessage(m);
		},

		flagBanned(platform:TwitchatDataTypes.ChatPlatform, channelId:string, uid:string, duration_s?:number):void {
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform && u.channelInfo[channelId]) {
					u.channelInfo[channelId].is_banned = true;
					if(u.channelInfo[channelId].is_moderator === true
					&& StoreProxy.params.features.autoRemod.value == true) {
						//When banned or timed out twitch removes the mod role
						//This flag reminds us to flag them back as mod when timeout completes
						u.channelInfo[channelId].autoRemod = true;
					}
					u.channelInfo[channelId].is_moderator = false;
					if(duration_s) {
						u.channelInfo[channelId].banEndDate = Date.now() + duration_s * 1000;
					}else{
						delete u.channelInfo[channelId].banEndDate;
					}
					break;
				}
			}
			if(unbanFlagTimeouts[uid]) {
				clearTimeout(unbanFlagTimeouts[uid]);
			}
			if(duration_s != undefined) {
				//Auto unflag the user once timeout expires
				unbanFlagTimeouts[uid] = setTimeout(()=> {
					StoreProxy.users.flagUnbanned("twitch", channelId, uid);
					//If requested to re grant mod role after a moderator timeout completes, do it
					if(StoreProxy.params.features.autoRemod.value == true) {
						for (let i = 0; i < userList.length; i++) {
							const u = userList[i];
							if(u.id === uid
							&& platform == u.platform
							&& platform == "twitch"
							&& u.channelInfo[channelId].autoRemod === true) {
								u.channelInfo[channelId].autoRemod = false;
								TwitchUtils.addRemoveModerator(false, channelId, u);
								break;
							}
						}
					}
				}, duration_s*1000)
			}
			StoreProxy.chat.delUserMessages(uid, channelId);
		},
		
		flagUnbanned(platform:TwitchatDataTypes.ChatPlatform, channelId:string, uid:string):void {
			for (let i = 0; i < userList.length; i++) {
				const u = userList[i];
				if(u.id === uid && platform == u.platform && userList[i].channelInfo[channelId]) {
					userList[i].channelInfo[channelId].is_banned = false;
					delete userList[i].channelInfo[channelId].banEndDate;
					break;
				}
			}
			if(unbanFlagTimeouts[uid]) {
				clearTimeout(unbanFlagTimeouts[uid]);
			}
		},

		flagOnlineUsers(users:TwitchatDataTypes.TwitchatUser[], channelId:string):void{
			for (let i = 0; i < users.length; i++) {
				users[i].channelInfo[channelId].online = true;
			}
		},

		flagOfflineUsers(users:TwitchatDataTypes.TwitchatUser[], channelId:string):void{
			for (let i = 0; i < users.length; i++) {
				users[i].channelInfo[channelId].online = false;
			}
		},

		//Check if user is following
		async checkFollowerState(user:Pick<TwitchatDataTypes.TwitchatUser, "channelInfo" | "id">, channelId:string):Promise<boolean> {
			if(channelId != StoreProxy.auth.twitch.user.id) {
				//Only get follower state for our own chan, ignore others as it won't be possible in the future
				user.channelInfo[channelId].is_following = true;
				return true;
			}
			//If that's us, flag as a follower;
			if(user.channelInfo[channelId]?.is_broadcaster) {
				user.channelInfo[channelId].is_following = true;
				return true;
			}
			if(user.id && StoreProxy.params.appearance.highlightNonFollowers.value === true) {
				if(user.channelInfo[channelId].is_following == null) {
					try {
						// console.log("Check if ", user.displayName, "follows", channelId, "or", StoreProxy.auth.twitch.user.id);
						const res = await TwitchUtils.getFollowerState(user.id);
						if(res != null) {
							user.channelInfo[channelId].is_following = true;
							user.channelInfo[channelId].following_date_ms = new Date(res.followed_at).getTime();
						}else{
							user.channelInfo[channelId].is_following = false;
						}
						return true;
					}catch(error){}
				}
			}
			return false;
		},

		//load user's pronouns
		loadUserPronouns(user:TwitchatDataTypes.TwitchatUser):Promise<void> {
			// console.log("Check pronouns?", user.login, user.id, user.pronouns, !user.id, !user.login, user.pronouns != undefined);
			if(!user.id || !user.login || user.pronouns != undefined || StoreProxy.params.features.showUserPronouns.value === false) return Promise.resolve();
			// console.log("Load pronouns !", user.login);
			return new Promise((resolve, reject)=> {
				TwitchUtils.getPronouns(user.id, user.login).then((res: TwitchatDataTypes.Pronoun | null) => {
					if (res !== null) {
						user.pronouns = res.pronoun_id;
						user.pronounsLabel = StoreProxy.i18n.tm("pronouns")[user.pronouns] ?? user.pronouns;
						const tt = StoreProxy.i18n.tm("pronouns")["tooltip_"+user.pronouns];
						if(tt) user.pronounsTooltip = tt;
					}else{
						user.pronouns = false;
					}
					resolve();
				}).catch(()=>{
					/*ignore*/
					resolve();
				});
			});
			
		},

		flagAsFollower(user:TwitchatDataTypes.TwitchatUser, channelId:string):void {
			user.channelInfo[channelId].is_following = true;
			this.myFollowers[user.platform][user.id] = Date.now();
		},

		openUserCard(user:TwitchatDataTypes.TwitchatUser, channelId?:string) {
			if(user) {
				this.userCard = {user, channelId};
			}else{
				this.userCard = null;
			}
		},

		async loadMyFollowings():Promise<void> {
			if(!TwitchUtils.hasScopes([TwitchScopes.LIST_FOLLOWINGS])) return;
			
			const followings = await TwitchUtils.getFollowings(StoreProxy.auth.twitch.user.id);
			const hashmap:{[key:string]:boolean} = {};
			followings.forEach(v => { hashmap[v.broadcaster_id] = true; });
			this.myFollowings["twitch"] = hashmap;
		},

		async loadMyFollowers():Promise<void> {
			if(!TwitchUtils.hasScopes([TwitchScopes.LIST_FOLLOWERS])) return;

			let parseOffset = 0;
			const hashmap:{[key:string]:number} = {};
			await TwitchUtils.getFollowers(null, -1, async(list)=> {
				for (let i = parseOffset; i < list.length; i++) {
					hashmap[list[i].user_id] = new Date(list[i].followed_at).getTime();
				}
				parseOffset = list.length;
				this.myFollowers["twitch"] = hashmap;
			});
		},

		trackUser(user:TwitchatDataTypes.TwitchatUser):void {
			user.is_tracked = true;
			EventBus.instance.dispatchEvent(new GlobalEvent(GlobalEvent.TRACK_USER, user));
		},

		untrackUser(user:TwitchatDataTypes.TwitchatUser):void {
			user.is_tracked = false;
			EventBus.instance.dispatchEvent(new GlobalEvent(GlobalEvent.UNTRACK_USER, user));
		},

		async shoutout(channelId:string, user:TwitchatDataTypes.TwitchatUser, fromQueue:boolean = false):Promise<boolean> {
			let streamTitle = "";
			let streamCategory = "";
			let executed = false;
			let canExecute = true;
			let sendChatSO = true;

			//Init queue if necessary
			if(!this.pendingShoutouts[channelId]) this.pendingShoutouts[channelId] = [];

			//If user is in an error state, stop there
			if(user.errored) {
				StoreProxy.main.alert(StoreProxy.i18n.t("error.user_not_found"));
				canExecute = false;
				sendChatSO = false;
			}
			
			//Check if we're live
			if(!StoreProxy.stream.currentStreamInfo[channelId]
			|| !StoreProxy.stream.currentStreamInfo[channelId]?.live) {
				StoreProxy.main.alert(StoreProxy.i18n.t("error.shoutout_offline"));
				canExecute = false;
				sendChatSO = false;
			}
			
			if(user.platform == "twitch" && canExecute) {
				//Has necessary authorization been granted?
				if(!TwitchUtils.hasScopes([TwitchScopes.SHOUTOUT])) {
					StoreProxy.auth.requestTwitchScopes([TwitchScopes.SHOUTOUT]);
				}else{
					//Check if user already has a pending shoutout (if current SO isn't executed by a pending one)
					if(!fromQueue && this.pendingShoutouts[channelId]!.filter(v=>v.user.id == user.id).length > 0) {
						StoreProxy.main.alert(StoreProxy.i18n.t("error.shoutout_pending"));

					}else{

						//Check if there are pending SO or if last SO was done earlier than the minimum cooldown
						let addToQueue = this.pendingShoutouts[channelId]!.length > 0
									  || Date.now() - StoreProxy.stream.currentStreamInfo[channelId]!.lastSoDoneDate < Config.instance.TWITCH_SHOUTOUT_COOLDOWN;
						if(!addToQueue || fromQueue) {
							//If no pending SO or if SO executed from pending list, try to execute it
							let res = await TwitchUtils.sendShoutout(channelId, user);
							//If API call failed, add the SO to queue.
							//It fails if an SO has been made before and Twitchat
							//didn't know about (because not yet started)
							if(res === false) {
								addToQueue = !fromQueue;
							}else {
								executed = true;
								sendChatSO = true;
								addToQueue = false;
							}
							//Set the last SO date offset for this user to now
							let soDate = Date.now();
							if(!fromQueue) {
								//If not executed from queue that means twitchat didn't know about
								//a previously made SO. In this case we offset the virtual SO date
								//of the current user in such a way it will have to wait the minimum
								//cooldown duration. After that if it fails again it will switch
								//to the maximum one because this line won't be executed
								soDate -= Config.instance.TWITCH_SHOUTOUT_COOLDOWN_SAME_USER - Config.instance.TWITCH_SHOUTOUT_COOLDOWN;
							}
							user.channelInfo[channelId].lastShoutout = soDate;
							//Set the last SO date offset for this channel to now
							StoreProxy.stream.currentStreamInfo[channelId]!.lastSoDoneDate = Date.now();
						}
	
						//Shoutout not executed, add it to the pending queue
						if(addToQueue) {
							//Add pending SO
							this.pendingShoutouts[channelId]!.push({
								id:Utils.getUUID(),
								executeIn:0,
								user,
							});
						}
						if(!executed) {
							//Force timers refresh
							this.executePendingShoutouts();
						}
					}
				}
			}

			if(sendChatSO && StoreProxy.params.features.chatShoutout.value === true){
				if(user.platform == "twitch") {
					const userInfos = await TwitchUtils.loadUserInfo(user.id? [user.id] : undefined, user.login? [user.login] : undefined);
					if(userInfos?.length > 0) {
						const userLoc = userInfos[0];
						const channelInfo = await TwitchUtils.loadChannelInfo([userLoc.id]);
						let message = StoreProxy.chat.botMessages.shoutout.message;
						streamTitle = channelInfo[0].title;
						streamCategory = channelInfo[0].game_name;
						if(!streamTitle) streamTitle = StoreProxy.i18n.t("error.no_stream");
						if(!streamCategory) streamCategory = StoreProxy.i18n.t("error.no_stream");
						message = message.replace(/\{USER\}/gi, userLoc.display_name);
						message = message.replace(/\{URL\}/gi, "twitch.tv/"+userLoc.login);
						message = message.replace(/\{TITLE\}/gi, streamTitle);
						message = message.replace(/\{CATEGORY\}/gi, streamCategory);
						user.avatarPath = userLoc.profile_image_url;
						await MessengerProxy.instance.sendMessage(message);
					}else{
						//Warn user doesn't exist
						StoreProxy.main.alert(StoreProxy.i18n.t("error.user_param_not_found", {USER:user}));
					}
				}
			}
			return executed;
		},

		executePendingShoutouts():void {
			//Parse all channels
			for (const channelId in this.pendingShoutouts) {
				const list = this.pendingShoutouts[channelId];
				if(!list || list.length == 0) continue;
				
				let elapsed = Date.now() - StoreProxy.stream.currentStreamInfo[channelId]!.lastSoDoneDate;
				let cooldown = -elapsed;
				//Compute cooldowns for every pending shoutouts
				for (let i = 0; i < list.length; i++) {
					const so = list[i];
					const userLastSoDate = so.user.channelInfo[channelId].lastShoutout || 0;
					const virtualElapsed = Date.now() - userLastSoDate + cooldown;

					//Compute minimum cooldown to wait for this SO
					cooldown += Math.max(Config.instance.TWITCH_SHOUTOUT_COOLDOWN_SAME_USER - virtualElapsed, Config.instance.TWITCH_SHOUTOUT_COOLDOWN);
					
					so.executeIn = cooldown;
					
					//If cooldown has fully elapsed, execute SO
					if(so.executeIn <= 0) {
						//Remove it from list
						list.splice(i,1);
						i--
						//Execute SO
						this.shoutout(channelId, so.user, true).then(result => {
							//SO failed
							if(!result) {
								//Update last SO date for this user to update its cooldown
								so.user.channelInfo[channelId].lastShoutout = Date.now();
								//Bring it back to bottom
								list.push(so);
								//Force timers refresh
								so.executeIn = 0;
								this.executePendingShoutouts();
							}
						})
					}
				}

			}
		},

		removeCustomUsername(uid:string):void {
			delete this.customUsernames[uid];
			this.saveCustomUsername();
		},

		setCustomUsername(user:TwitchatDataTypes.TwitchatUser, name:string, channelId:string):boolean {
			name = name.trim().substring(0, 25);
			if(name.length == 0 || name === user.displayNameOriginal) {
				delete this.customUsernames[user.id];
			}else{
				//User can give up to 10 custom user names if not premium
				if(!this.customUsernames[user.id]
				&& !StoreProxy.auth.isPremium
				&& Object.keys(this.customUsernames).length >= Config.instance.MAX_CUSTOM_USERNAMES) {
					StoreProxy.main.alert(StoreProxy.i18n.t("error.max_custom_usernames", {COUNT:Config.instance.MAX_CUSTOM_USERNAMES}));
					return false;
				}
				this.customUsernames[user.id] = {name, platform:user.platform, channel:channelId};
			}
			
			this.saveCustomUsername();
			return true;
		},

		createCustomBadge(img:string):boolean|string {
			let id = "";
			//add badge to global list if necessary
			const existingIndex = this.customBadgeList.findIndex(v=>v.img == img);
			if(existingIndex == -1) {
				//User can create up to 3 custom badges if not premium
				if(!StoreProxy.auth.isPremium && this.customBadgeList.length >= Config.instance.MAX_CUSTOM_BADGES) {
					StoreProxy.main.alert(StoreProxy.i18n.t("error.max_custom_badges", {COUNT:Config.instance.MAX_CUSTOM_BADGES}));
					return false;
				}
				id = Utils.getUUID();
				this.customBadgeList.push({id, img});
			}else{
				id = this.customBadgeList[existingIndex].id;
			}

			this.saveCustomBadges();
			return id;
		},

		updateCustomBadgeImage(badgeId:string, img:string):void {
			const index = this.customBadgeList.findIndex(v=>v.id == badgeId);
			if(index > -1) {
				this.customBadgeList[index].img = img;
			}
			this.saveCustomBadges();
		},

		updateCustomBadgeName(badgeId:string, name:string):void {
			const index = this.customBadgeList.findIndex(v=>v.id == badgeId);
			if(index > -1) {
				this.customBadgeList[index].name = name;
				if(name.length === 0) {
					delete this.customBadgeList[index].name;
				}
			}
			this.saveCustomBadges();
		},

		deleteCustomBadge(badgeId:string):void {
			//Remove any reference of the badge from the users
			const userBadges = this.customUserBadges;
			for (const uid in userBadges) {
				const index = userBadges[uid].findIndex(v=> v.id == badgeId);
				if(index > -1) {
					userBadges[uid].splice(index, 1);
					if(userBadges[uid].length == 0) {
						delete userBadges[uid];
					}
				}
			}

			const index = this.customBadgeList.findIndex(v=>v.id == badgeId);
			if(index > -1) {
				this.customBadgeList.splice(index, 1);
			}

			this.saveCustomBadges();
		},

		giveCustomBadge(user:TwitchatDataTypes.TwitchatUser, badgeId:string, channelId:string):boolean {
			if(!this.customUserBadges[user.id]) this.customUserBadges[user.id] = [];
			//Add badge to the user if necessary
			if(this.customUserBadges[user.id].findIndex(v => v.id == badgeId) == -1) {
				//User can give badges to 30 users max if not premium
				if(!StoreProxy.auth.isPremium && Object.keys(this.customUserBadges).length >= Config.instance.MAX_CUSTOM_BADGES_ATTRIBUTION) {
					StoreProxy.main.alert(StoreProxy.i18n.t("error.max_custom_badges_given", {COUNT:Config.instance.MAX_CUSTOM_BADGES_ATTRIBUTION}));
					return false;
				}
				this.customUserBadges[user.id].push({id:badgeId, platform:user.platform, channel:channelId!});
			}
			this.saveCustomBadges();
			return true;
		},

		removeCustomBadge(user:TwitchatDataTypes.TwitchatUser, badgeId:string, channelId:string):void {
			if(!this.customUserBadges[user.id]) return;

			const index = this.customUserBadges[user.id].findIndex(v => v.id == badgeId);
			if(index > -1) this.customUserBadges[user.id].splice(index, 1);
			if(this.customUserBadges[user.id].length === 0) {
				delete this.customUserBadges[user.id];
			}

			this.saveCustomBadges();
		},
		
		saveCustomBadges():void {
			DataStore.set(DataStore.CUSTOM_BADGE_LIST, this.customBadgeList);
			DataStore.set(DataStore.CUSTOM_USER_BADGES, this.customUserBadges);
		},
		
		saveCustomUsername():void {
			DataStore.set(DataStore.CUSTOM_USERNAMES, this.customUsernames);
		}

	} as IUsersActions
	& ThisType<IUsersActions
		& UnwrapRef<IUsersState>
		& _StoreWithState<"users", IUsersState, IUsersGetters, IUsersActions>
		& _StoreWithGetters<IUsersGetters>
		& PiniaCustomProperties
	>,
})