import TwitchatEvent from '@/events/TwitchatEvent';
import MessengerProxy from '@/messaging/MessengerProxy';
import { TwitchatDataTypes } from '@/types/TwitchatDataTypes';
import PublicAPI from '@/utils/PublicAPI';
import Utils from '@/utils/Utils';
import TriggerActionHandler from '@/utils/triggers/TriggerActionHandler';
import TwitchUtils from '@/utils/twitch/TwitchUtils';
import { acceptHMRUpdate, defineStore, type PiniaCustomProperties, type _GettersTree, type _StoreWithGetters, type _StoreWithState } from 'pinia';
import type { JsonObject } from 'type-fest';
import type { UnwrapRef } from 'vue';
import StoreProxy, { type IRaffleActions, type IRaffleGetters, type IRaffleState } from '../StoreProxy';

let currentRaffleData:TwitchatDataTypes.RaffleData | null = null;
let confirmSpool:TwitchatDataTypes.TwitchatUser[] = [];
let debounceConfirm:number = -1;

export const storeRaffle = defineStore('raffle', {
	state: () => ({
		data: null,
	} as IRaffleState),



	getters: {
	} as IRaffleGetters
	& ThisType<UnwrapRef<IRaffleState> & _StoreWithGetters<IRaffleGetters> & PiniaCustomProperties>
	& _GettersTree<IRaffleState>,



	actions: {

		populateData() {
			/**
			 * Called when a raffle animation (the wheel) completes
			 */
			PublicAPI.instance.addEventListener(TwitchatEvent.RAFFLE_RESULT, (e:TwitchatEvent<{winner:TwitchatDataTypes.RaffleEntry, delay?:number}>)=> {
				this.onRaffleComplete(e.data!.winner, false, e.data!.delay);
			});
		},

		async startRaffle(payload:TwitchatDataTypes.RaffleData) {
			this.data = payload;

			payload.created_at = Date.now();

			switch(payload.mode) {
				case "chat": {
					//Start countdown if requested
					if(payload.showCountdownOverlay) {
						StoreProxy.timer.countdownStart(payload.duration_s * 1000);
					}
					//Announce start on chat
					if(StoreProxy.chat.botMessages.raffleStart.enabled && payload.command) {
						let message = StoreProxy.chat.botMessages.raffleStart.message;
						message = message.replace(/\{CMD\}/gi, payload.command);
						MessengerProxy.instance.sendMessage(message);
					}
					break;
				}

				case "sub": {
					this.pickWinner(payload);
					break;
				}

				case "manual": {
					this.pickWinner(payload);
					break;
				}

				case "values": {
					this.pickWinner(payload);
					break;
				}
			}
		},

		stopRaffle() { this.data = null; },

		onRaffleComplete(winner:TwitchatDataTypes.RaffleEntry, publish = false, chatMessageDelay:number = 0) {
			// this.raffle = null;
			let data:TwitchatDataTypes.RaffleData|null = currentRaffleData || this.data;
			if(data) {
				const winnerLoc = data.entries.find(v=> v.id == winner.id);
				if(winnerLoc) {
					winner = winnerLoc;

					if(!data.winners) data.winners = [];
					data.winners.push(winnerLoc);

					if(winnerLoc.user) {
						if(StoreProxy.params.features.raffleHighlightUser.value) {
							const user = StoreProxy.users.getUserFrom(winnerLoc.user.platform, winnerLoc.user.channel_id, winnerLoc.user.id);
							StoreProxy.users.trackUser(user);
							setTimeout(()=> {
								StoreProxy.users.untrackUser(user);
							}, (StoreProxy.params.features.raffleHighlightUserDuration.value as number ?? 0) * 1000 * 60);
						}
					}
				}

			}else{
				data = {
					command:"",
					created_at:Date.now(),
					entries:[winner],
					winners:[winner],
					customEntries:"",
					multipleJoin:false,
					duration_s:0,
					followRatio:1,
					subgiftRatio:1,
					subRatio:1,
					subT2Ratio:1,
					subT3Ratio:1,
					vipRatio:1,
					subMode_excludeGifted:false,
					subMode_includeGifters:false,
					maxEntries:0,
					mode:"chat",
					showCountdownOverlay:false,
				};
			}

			//Execute triggers
			const message:TwitchatDataTypes.MessageRaffleData = {
				type:TwitchatDataTypes.TwitchatMessageType.RAFFLE,
				platform:"twitchat",
				id:Utils.getUUID(),
				date:Date.now(),
				raffleData:data,
				winner,
				channel_id:StoreProxy.auth.twitch.user.id,
			}
			StoreProxy.chat.addMessage(message);

			//Post result on chat
			if(StoreProxy.chat.botMessages.raffle.enabled) {
				setTimeout(() => {
					let message = StoreProxy.chat.botMessages.raffle.message;
					message = message.replace(/\{USER\}/gi, winner.label);
					MessengerProxy.instance.sendMessage(message);
				}, chatMessageDelay || 0);
			}

			//Publish the result on the public API
			if(publish !== false) {
				PublicAPI.instance.broadcast(TwitchatEvent.RAFFLE_RESULT, (winner as unknown) as JsonObject);
			}

			if(data.resultCallback) data.resultCallback();

			currentRaffleData = null;
		},

		checkRaffleJoin(message:TwitchatDataTypes.TranslatableMessage):boolean {
			if(!this.data || this.data.mode != "chat") return false;

			const messageCast = message as TwitchatDataTypes.GreetableMessage;

			const sChat = StoreProxy.chat;
			const raffle = this.data;
			const elapsed = Date.now() - new Date(raffle.created_at).getTime();

			//Check if within time frame and max users count isn't reached
			if(elapsed <= raffle.duration_s * 1000
			&& (raffle.maxEntries <= 0 || raffle.entries.length < raffle.maxEntries)) {
				const user = messageCast.user;
				const existingEntry = raffle.entries.find(v=>v.id == user.id);
				if(existingEntry) {
					//User already entered, increment their score or stop there
					//depending on the raffle's param
					if(this.data.multipleJoin !== true) return false;
					existingEntry.joinCount ++;
				}else{
					//User is not already on the list, create it
					raffle.entries.push( {
						score:0,
						joinCount:1,
						label:user.displayNameOriginal,
						id:user.id,
						user:{
							id:messageCast.user.id,
							platform:messageCast.platform,
							channel_id:messageCast.channel_id,
						}
					} );
				}

				if(sChat.botMessages.raffleJoin.enabled) {
					clearTimeout(debounceConfirm);
					confirmSpool.push(user);
					let message = "";
					let userCount = 0;
					while(message.length < 500 && userCount < confirmSpool.length) {
						userCount ++;
						message = sChat.botMessages.raffleJoin.message;
						message = message.replace(/\{USER\}/gi, confirmSpool.concat().splice(0, userCount).map(v=> v.displayNameOriginal).join(", @"));
					}

					if(message.length >= 500) {
						message = sChat.botMessages.raffleJoin.message;
						message = message.replace(/\{USER\}/gi, confirmSpool.splice(0, userCount-1).map(v=> v.displayNameOriginal).join(", @"));
						MessengerProxy.instance.sendMessage(message, [user.platform]);
					}else if(message) {
						debounceConfirm = setTimeout(() => {
							confirmSpool = [];
							MessengerProxy.instance.sendMessage(message, [user.platform]);
						}, 500);
					}
				}
				return true;
			}
			return false;
		},

		async pickWinner(forcedData?:TwitchatDataTypes.RaffleData, forcedWinner?:TwitchatDataTypes.RaffleEntry):Promise<void> {
			const data = forcedData ?? this.data;
			currentRaffleData = data;
			if(!data) {
				StoreProxy.common.alert(StoreProxy.i18n.t("error.raffle.pick_winner_no_raffle"));
				return;
			}
			
			//Executes raffle pick winner related triggers
			const message:TwitchatDataTypes.MessageRafflePickWinnerData = {
				id:Utils.getUUID(),
				channel_id:StoreProxy.auth.twitch.user.id,
				date:Date.now(),
				platform:"twitchat",
				type:TwitchatDataTypes.TwitchatMessageType.RAFFLE_PICK_WINNER,
			}
			TriggerActionHandler.instance.execute(message);

			const sUsers = StoreProxy.users;
			//Compute entries scores for ponderation
			const userList:{channel_id:string, user:TwitchatDataTypes.TwitchatUser, entry:TwitchatDataTypes.RaffleEntry}[] = [];
			data.entries.forEach(v=> {
				//Skip if it's not a user or if the score has already been computed
				if(!v.user || v.score > 0) return;
				const user = sUsers.getUserFrom(v.user.platform, v.user.channel_id, v.user.id);
				userList.push({user, channel_id:v.user.channel_id, entry:v});
			});

			//Compute weighted scores if necessary
			if(!forcedWinner && userList.length > 0) {

				//Requesting weigted values for T2 or T3 subscribers if necessary
				if((data.subT2Ratio || data.subT3Ratio) && userList.length > 0) {
					//load all subscribers states
					const res = await TwitchUtils.getSubscriptionState(userList.map(v=>v.user.id));
					res.forEach(v=> {
						const userListEntry = userList.find(w => w.user.id == v.user_id);

						//User not found on the API results, user is not subscribed
						if(!userListEntry) return;

						const user = userListEntry.user;
						const entry = userListEntry.entry;
						const channel_id = userListEntry.channel_id;
						user.channelInfo[channel_id].is_subscriber = true;
						//Sub tier 3
						if(data.subT3Ratio > 0
							&& v.tier == "3000")	entry.score += data.subT3Ratio ?? 0;
						//Sub tier 2
						else if(data.subT2Ratio > 0
							&& v.tier == "2000")	entry.score += data.subT2Ratio ?? 0;
						//Sub tier 1 & prime
						else if(data.subRatio > 0)	entry.score += data.subRatio;

						//If user has been gifted, update the state of the gifter.
						//IRC should already have sent this info if the user wrote on chat.
						//This is just a bonus step just in case.
						if(v.gifter_id) {
							//Check if gifter is part of the raffle entries
							const gifter = userList.find(w=>w.user.id == v.gifter_id);
							if(gifter) {
								const user = sUsers.getUserFrom(gifter.user.platform, channel_id, v.gifter_id, v.gifter_login, v.gifter_name);
								if(user) user.channelInfo[channel_id].is_gifter = true;
							}
						}
					})
				}

				//Apply other ratios
				for (const v of userList) {
					const channel_id	= v.channel_id;
					const user			= sUsers.getUserFrom(v.user.platform, channel_id, v.user.id);
					//Apply VIP ratio
					if(data.vipRatio > 0 && user.channelInfo[channel_id].is_vip)		v.entry.score += data.vipRatio;
					//Apply sub gifter ratio
					if(data.subgiftRatio > 0 && user.channelInfo[channel_id].is_gifter)	v.entry.score += data.subgiftRatio;
					//Apply follower ratio
					if(data.followRatio > 0) {
						//If user follow state isn't loaded yet, get it
						if(user.channelInfo[channel_id].is_following === null) await sUsers.checkFollowerState(user, channel_id);
						if(user.channelInfo[channel_id].is_following === true) v.entry.score += data.followRatio;
					}
					//Apply sub T1 ratio (value comes from IRC).
					//If there's a T2 or T3 ratio, don't apply the T1 ratio here, we already got it before
					//by checking the actual subscription states of all users from the API.
					//IRC doesn't say if the user is subscribed at tier 2 or 3, only tier 1 and prime.
					if(data.subRatio > 0
					&& (!data.subT2Ratio || data.subT2Ratio == 0)
					&& (!data.subT3Ratio || data.subT3Ratio == 0)
					&& user.channelInfo[channel_id].is_subscriber)	v.entry.score += data.subRatio;
				}
			}

			let winner:TwitchatDataTypes.RaffleEntry;

			if(forcedWinner) {
				winner = forcedWinner;
			}else{

				//Pick from a custom list
				if(data.mode == "manual") {
					let id = 0;
					let customEntries:string[] = [];
					const customEntriesStr = data.customEntries;
					if(customEntriesStr?.length > 0) {
						const splitter = customEntriesStr.split(/\r|\n/).length > 1? "\r|\n" : ",";
						customEntries = customEntriesStr.split(new RegExp(splitter, ""));
						customEntries = customEntries.map(v=> v.trim());
					}else{
						StoreProxy.common.alert(StoreProxy.i18n.t("error.raffle.pick_winner_no_entry"));
						return;
					}
					const items:TwitchatDataTypes.RaffleEntry[] = customEntries.map(v=> {
						return {
							id:Utils.getUUID(),
							label:v,
							score:1,
							joinCount:1,
						}
					});
					data.entries = items;

				//Pick from subs
				}else if(data.mode == "sub") {
					const idToExists:{[key:string]:boolean} = {};
					let subs = await TwitchUtils.getSubsList(false);
					subs = subs.filter(v => {
						//Avoid duplicates
						if(idToExists[v.user_id] == true) return false;
						if(idToExists[v.gifter_id] == true && v.gifter_id) return false;
						idToExists[v.user_id] = true;
						idToExists[v.gifter_id] = true;
						//Filter based on params
						if(data.subMode_includeGifters == true && subs.find(v2=> v2.gifter_id == v.user_id)) return true;
						if(data.subMode_excludeGifted == true && v.is_gift) return false;
						if(v.user_id == v.broadcaster_id) return false;//Exclude self
						return true;
					});
					if(subs.length === 0) {
						StoreProxy.common.alert(StoreProxy.i18n.t("error.raffle.pick_winner_no_subs"));
						return;
					}

					const items:TwitchatDataTypes.RaffleEntry[] = subs.map(v=>{
						return {
							id:v.user_id,
							label:v.user_name,
							score:1,
							joinCount:1,
						}
					});
					data.entries = items;

				//Pick from Value
				}else if(data.mode == "values") {
					const val = StoreProxy.values.valueList.find(v=>v.id == data.value_id);
					if(!val) return;
					if(val.perUser) {
						const entries:TwitchatDataTypes.RaffleEntry[] = [];
						const users = val.users || {};
						const channel_id = StoreProxy.auth.twitch.user.id;
						const userList = await TwitchUtils.getUserInfo(Object.keys(users));
						for (const key in users) {
							const userData = userList.find(v=>v.id == key);
							if(!userData) continue;
							entries.push({
								id:Utils.getUUID(),
								joinCount:1,
								label:userData.display_name,
								score:parseInt(users[key]) || 1,
								//FIXME Following won't work if joining from youtube chat.
								//Sadly, for now I'm not storing the platform source of a per-user value (same for counters)
								//so I can't track back the proper platform, hence, this hardcoded value 😬
								user:{
									id:userData.id,
									platform:"twitch",
									channel_id,
								}
							})
						}
						data.entries = entries;
					}else{
						const splitter = data.value_splitter || new RegExp(val.value.split(/\r|\n/).length > 1? "\r|\n" : ",");//Fallback to line break or coma if new value_splitter option is empty
						data.entries = val.value.split(splitter)
										.filter((v)=>v.length > 0).map(v=> {
											return {
												id:Utils.getUUID(),
												joinCount:1,
												label:v,
												score:1,
											}
										});
					}
				}

				if(!data.winners) {
					data.winners = [];
				}

				let list = [];
				//Ponderate votes by adding one user many times if their
				//score is greater than 1
				for (let i = 0; i < data.entries.length; i++) {
					const u = data.entries[i];

					//Remove entries that already won
					if(data.winners?.findIndex(v => v.id === u.id) > -1) continue;

					const joinCount = Math.max(1, u.score) * Math.max(1, u.joinCount);
					if(joinCount==1) list.push(u);
					else {
						for (let j = 0; j < joinCount; j++) {
							list.push(u);
						}
					}
				}

				if(list.length === 0) {
					StoreProxy.common.alert(StoreProxy.i18n.t("error.raffle.pick_winner_no_entry"));
					return;
				}

				winner = Utils.pickRand(list);
			}

			//Ask if a wheel overlay exists
			let wheelOverlayExists = false;

			const wheelOverlayPresenceHandler = ()=> { wheelOverlayExists = true; };
			PublicAPI.instance.addEventListener(TwitchatEvent.WHEEL_OVERLAY_PRESENCE, wheelOverlayPresenceHandler);

			PublicAPI.instance.broadcast(TwitchatEvent.GET_WHEEL_OVERLAY_PRESENCE);
			await Utils.promisedTimeout(500);//Give the overlay some time to answer
			PublicAPI.instance.removeEventListener(TwitchatEvent.WHEEL_OVERLAY_PRESENCE, wheelOverlayPresenceHandler);

			//A wheel overlay exists, send it data and wait for it to complete
			if(wheelOverlayExists){
				const list:TwitchatDataTypes.EntryItem[] = data.entries.map((v:TwitchatDataTypes.RaffleEntry):TwitchatDataTypes.EntryItem=>{
											return {
												id:v.id,
												label:v.label,
											}
										});
				const apiData:TwitchatDataTypes.WheelData = {
					items:list,
					winner:winner.id,
				}
				PublicAPI.instance.broadcast(TwitchatEvent.WHEEL_OVERLAY_START, (apiData as unknown) as JsonObject);

			}else{

				//no wheel overlay found, just announce the winner
				this.onRaffleComplete(winner);
			}

			//If requesting to automatically remove winning entry from source
			if(data.removeWinningEntry === true) {
				if(data.mode == "values") {
					const val = StoreProxy.values.valueList.find(v=>v.id == data.value_id);
					if(!val) return;
					if(val.perUser) {
						delete val.users![winner.user!.id];
					}else{
						const fallbackSplitter = val.value.split(/\r|\n/).length > 1? "\r|\n" : ",";
						const splitterRaplacement = fallbackSplitter == ","? "," : "\n";
						const splitter = data.value_splitter || new RegExp(fallbackSplitter);//Fallback to line break or coma if new value_splitter option is empty
						val.value = val.value.split(splitter).filter((v)=> v !=  winner.label).join(data.value_splitter || splitterRaplacement);
					}
				}else if(data.mode == "manual") {
						//Too complicated to do for triggers as it involves handling placeholders case.
						//If the custom list contains placeholders they are replaced before starting the raffle
						//wich makes it a nightmare to define which value should be removed from the original list.
						//Also, we have no reference here to the original data so removing an entry from
						//the list wouldn't remove it from the original trigger data

						let customEntries:string[] = [];
						const customEntriesStr = data.customEntries;
						if(customEntriesStr?.length > 0) {
							const splitter = customEntriesStr.split(/\r|\n/).length > 1? "\r|\n" : ",";
							customEntries = customEntriesStr.split(new RegExp(splitter, ""));
							customEntries = customEntries.filter(v=> v.trim() !== winner.label);
							const splitterRaplacement = splitter == ","? "," : "\n";
							data.customEntries = customEntries.join(splitterRaplacement);
							console.log(data.customEntries);
						}
				}
			}

		}
	} as IRaffleActions
	& ThisType<IRaffleActions
		& UnwrapRef<IRaffleState>
		& _StoreWithState<"raffle", IRaffleState, IRaffleGetters, IRaffleActions>
		& _StoreWithGetters<IRaffleGetters>
		& PiniaCustomProperties
	>,
})


if(import.meta.hot) {
	import.meta.hot.accept(acceptHMRUpdate(storeRaffle, import.meta.hot))
}