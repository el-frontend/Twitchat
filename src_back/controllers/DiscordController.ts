import { Multipart } from "@fastify/multipart";
import { InteractionResponseType, InteractionType, verifyKey } from "discord-interactions";
import { ChannelType, Guild, GuildChannel, PermissionsBitField, REST, RawFile, Routes, SlashCommandBuilder } from "discord.js";
import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as fs from "fs";
import Config from "../utils/Config";
import I18n from "../utils/I18n";
import Logger from "../utils/Logger";
import TwitchUtils from "../utils/TwitchUtils";
import Utils from "../utils/Utils";
import AbstractController from "./AbstractController";
import SSEController, { SSECode } from "./SSEController";

/**
* Created : 23/02/2024 
*/
export default class DiscordController extends AbstractController {

	private static _guildId2TwitchId:{[key:string]:TwitchatGuild2Twitch} = {};
	private static _twitchId2GuildId:{[key:string]:TwitchatGuild2Twitch} = {};
	
	private _rest!:REST;
	private _pendingTokens:PendingToken[] = [];
	private _tokenValidityDuration = 60*1000;
	private _commandSay?:SlashCommandDefinition;
	private _commandAsk?:SlashCommandDefinition;
	private _commandLink?:SlashCommandDefinition;

	constructor(public server:FastifyInstance) {
		super();
	}
	
	/********************
	* GETTER / SETTERS *
	********************/
	
	
	
	/******************
	* PUBLIC METHODS *
	******************/
	public initialize():DiscordController {
		this.server.get('/api/discord/link', async (request, response) => await this.getLinkedState(request, response));
		this.server.get('/api/discord/code', async (request, response) => await this.registerCode(request, response));
		this.server.get('/api/discord/channels', async (request, response) => await this.getChannelList(request, response));
		this.server.post('/api/discord/image', async (request, response) => await this.postAnImageToDiscord(request, response));
		this.server.post('/api/discord/code', async (request, response) => await this.registerCode(request, response));
		this.server.post('/api/discord/answer', async (request, response) => await this.postAnswer(request, response));
		this.server.post('/api/discord/interaction', async (request, response) => await this.postInteraction(request, response));
		this.server.delete('/api/discord/link', async (request, response) => await this.deleteLinkState(request, response));
		
		this.initDatabase();
		this.createCommands();
		this.buildTwitchHashmap();

		//Cleanup expired tokens every 5s
		setInterval(()=> {
			const now = Date.now();
			for (let i = 0; i < this._pendingTokens.length; i++) {
				const token = this._pendingTokens[i];
				if(now > token.expires_at) {
					this._pendingTokens.splice(i, 1);
					i--;
				}
			}
		}, 5000);
		return this;
	}

	/**
	 * Check if given user has linked their Twitchat account to a Discord server
	 * @param twitchUid 
	 * @returns 
	 */
	public static isDiscordLinked(twitchUid:string):boolean {
		return DiscordController._twitchId2GuildId[twitchUid] != undefined;
	}

	/**
	 * Called when user data are updated.
	 * Extracts the discord related data
	 */
	public updateParams(uid:string, data:any):void {
		const guild = DiscordController._twitchId2GuildId[uid];
		guild.chatCols = data.chatCols;
		guild.logChanTarget = data.logChanTarget;
		DiscordController._twitchId2GuildId[guild.guildID] = guild;
		fs.writeFileSync(Config.discord2Twitch, JSON.stringify(DiscordController._guildId2TwitchId), "utf-8");
		this.buildTwitchHashmap();
	}
	
	
	
	/*******************
	* PRIVATE METHODS *
	*******************/
	private buildTwitchHashmap():void {
		DiscordController._twitchId2GuildId = {};
		for (const guild in DiscordController._guildId2TwitchId) {
			const entry = DiscordController._guildId2TwitchId[guild];
			DiscordController._twitchId2GuildId[entry.twitchUID] = entry;
		}
	}

	/**
	 * Gets to which discord our twitchat account is linked
	 */
	private async getLinkedState(request:FastifyRequest, response:FastifyReply):Promise<void> {
		const user = await TwitchUtils.getUserFromToken(request.headers.authorization);

		//Check if token is oAuth valid
		if(!user) {
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({message:"Invalid access token", success:false}));
			return;
		}

		let entry:TwitchatGuild2Twitch|undefined;
		for (const guild in DiscordController._guildId2TwitchId) {
			if(DiscordController._guildId2TwitchId[guild].twitchUID == user.user_id){
				entry = DiscordController._guildId2TwitchId[guild];
				break;
			}
		}

		if(entry) {
			response.header('Content-Type', 'application/json')
			.status(200)
			.send(JSON.stringify({success:true, linked:true, guildName:entry.guildName}));
		}else{
			response.header('Content-Type', 'application/json')
			.status(200)
			.send(JSON.stringify({success:true,  linked:false}));
		}
	}

	/**
	 * Unlinks a discord guild
	 */
	private async deleteLinkState(request:FastifyRequest, response:FastifyReply):Promise<void> {
		const user = await TwitchUtils.getUserFromToken(request.headers.authorization);

		//Check if token is oAuth valid
		if(!user) {
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({message:"Invalid access token", success:false}));
			return;
		}

		for (const guild in DiscordController._guildId2TwitchId) {
			if(DiscordController._guildId2TwitchId[guild].twitchUID == user.user_id){
				delete DiscordController._guildId2TwitchId[guild];
				fs.writeFileSync(Config.discord2Twitch, JSON.stringify(DiscordController._guildId2TwitchId), "utf-8");
				this.buildTwitchHashmap();
				break;
			}
		}

		response.header('Content-Type', 'application/json')
		.status(200)
		.send(JSON.stringify({success:true,  linked:false}));
	}

	/**
	 * List discord chanels
	 */
	private async getChannelList(request:FastifyRequest, response:FastifyReply):Promise<void> {
		const user = await TwitchUtils.getUserFromToken(request.headers.authorization);
		const guild = DiscordController._twitchId2GuildId[user? user.user_id:""];
		//Check if token is oAuth valid
		if(!user || !guild) {
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({message:"Invalid access token", success:false}));
			return;
		}

		const res:GuildChannel[] = await this._rest.get(Routes.guildChannels(guild.guildID)) as GuildChannel[];
		const channelList = res.filter(chan => chan.type == ChannelType.GuildText)
								.sort((a,b) => a.position - b.position )
								.map(chan => {
									return {
										id:chan.id,
										name:chan.name,
									}
								});
		response.header('Content-Type', 'application/json')
		.status(200)
		.send(JSON.stringify({success:true, channelList, test:res}));
		
	}

	/**
	 * Called when a user request to post a chat message data to discord
	 */
	private async postAnImageToDiscord(request:FastifyRequest, response:FastifyReply):Promise<void> {
		const user = await TwitchUtils.getUserFromToken(request.headers.authorization);
		const guild = DiscordController._twitchId2GuildId[user? user.user_id:""];
		//Check if token is oAuth valid
		if(!user || !guild) {
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({message:"Invalid access token", success:false}));
			return;
		}

		try {
			const parts: AsyncIterableIterator<Multipart> = request.parts();
			const body:any = {content:""};
			let upload!:RawFile;
			for await (const part of parts) {
				if(part.type == "file") {
					upload = {
						data: await part.toBuffer(),
						name: part.filename,
						contentType: part.mimetype,
					}
				}else 
				if(part.type == "field") {
					const json:{
						userName:string,
						userId:string,
						date:string,
						messageId:string,
						messageType:string,
						messagePlatform:string,
						message:string,
					} = JSON.parse(part.value as string);
					body.content = `
* **__User ID__**: ${json.userId}
* **__User name__**: ${json.userName}
* **__Message ID__**: ${json.messageId}
* **__Message Type__**: ${json.messageType}
* **__Platform__**: ${json.messagePlatform}`;
					if(json.message){
						body.content += "\n**__Message__**:";
						body.content += "```"+json.message.replace('`', '\`')+"```";
					}
				}
			}
			//Send to discord
			await this._rest.post(Routes.channelMessages(guild.logChanTarget), {body,files:[upload]});
		}catch(error) {
			Logger.error(error)
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({message:"Invalid file", success:false}));
			return;
		}

		response.header('Content-Type', 'application/json')
		.status(200)
		.send(JSON.stringify({success:true}));
	}

	/**
	 * Called when a user request if a validation is pending or confirms a link
	 */
	private async registerCode(request:FastifyRequest, response:FastifyReply):Promise<void> {
		const user = await TwitchUtils.getUserFromToken(request.headers.authorization);

		//Check if token is oAuth valid
		if(!user) {
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({message:"Invalid access token", success:false}));
			return;
		}

		const params = request.method === "POST"? request.body as any : request.query as any;
		const code = params.code as string;
		const token = this._pendingTokens.find(v => v.code.toUpperCase() === code.toUpperCase());
		
		//Check if code and user match the expected ones
		if(!token || !code || token.channelId != user.user_id) {
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({error:"Invalid token", errorCode:"INVALID_TOKEN", success:false}));
			return;
		}
		
		//Associate twitch to given discord guild
		if(request.method == "POST") {
			DiscordController._guildId2TwitchId[token.guildId] = {
				locale:token.locale,
				twitchUID:user.user_id,
				guildID:token.guildId,
				guildName:token.guildName,
				guildChannelId:token.guildChannelID,
				logChanTarget:"",
				chatCols:[],
			};
			fs.writeFileSync(Config.discord2Twitch, JSON.stringify(DiscordController._guildId2TwitchId), "utf-8");
			this.buildTwitchHashmap();
			const message = I18n.instance.get(token.locale, "server.discord.link_success", {
								LOGIN:user.login,
								CMD_SAY:this._commandSay?.name || "say",
								CMD_SAY_ID:this._commandSay?.id || "",
								CMD_ASK:this._commandAsk?.name || "ask",
								CMD_ASK_ID:this._commandAsk?.id || "",
							});
			await this._rest.post(Routes.channelMessages(token.guildChannelID), {body:{content:message}});
		}else{
			//Add 1 minute to the expiration date
			token.expires_at += this._tokenValidityDuration;
		}

		response.header('Content-Type', 'application/json')
		.status(200)
		.send(JSON.stringify({success:true, guildName:token.guildName}));
	}

	/**
	 * Called when stream answers to a custom message by clicking one of the available CTAs
	 * 
	 * @param request 
	 * @param response 
	 * @returns 
	 */
	private async postAnswer(request:FastifyRequest, response:FastifyReply):Promise<void> {
		const user = await TwitchUtils.getUserFromToken(request.headers.authorization);
		const guild = DiscordController._twitchId2GuildId[user? user.user_id:""];
		//Check if token is oAuth valid
		if(!user || !guild) {
			response.header('Content-Type', 'application/json')
			.status(401)
			.send(JSON.stringify({message:"Invalid access token", success:false}));
			return;
		}
		
		const params = request.body as any;
		const data:ActionPayload = params.data;
		const body:any = {content:params.message};
		if(data && data.messageId) {
			body.message_reference = {
				channel_id: data.channelId,
				message_id: data.messageId,
				fail_if_not_exists:false,
			}
		}
		if(data.reaction) {
			await this._rest.put(Routes.channelMessageOwnReaction(data.channelId, data.messageId, encodeURIComponent(data.reaction)));
		}else{
			await this._rest.post(Routes.channelMessages(data.channelId), {body});
		}

		response.header('Content-Type', 'application/json')
		.status(200)
		.send(JSON.stringify({success:true}));
	}

	/**
	 * Init an SSE connection
	 * 
	 * @param request 
	 * @param response 
	 * @returns 
	 */
	private async postInteraction(request:FastifyRequest, response:FastifyReply):Promise<void> {
		const json = request.body as DiscordBotInstallPayload | SlashCommandPayload;

		const signature = request.headers["x-signature-ed25519"] as string;
		const timestamp = request.headers["x-signature-timestamp"] as string;
		//@ts-ignore no typings for "rowBody" that is added by fastify-raw-body
		const body = request.rawBody as string;
		
		const verified = verifyKey(body, signature, timestamp, Config.credentials.discord_public_key);
		if (!verified) {
			return response.status(401).send('Bad request signature');
		}

		switch(json.type) {
			case InteractionType.PING: {
				response.status(200);
				response.send({type:InteractionResponseType.PONG});
				break;
			}
			case InteractionType.APPLICATION_COMMAND: {
				let command = json as SlashCommandPayload;
				// Logger.info(command.member.user.username+" executes command "+command.data.name);
				switch(command.data.name) {
					case "link":{
						await this.configureTwitchChannel(request, response, command);
						break;
					}
					case "ask":
					case "say":{
						await this.sendMessageToTwitchat(request, response, command);
						break;
					}
				}
				break;
			}
		}
	}

	/**
	 * initializes database
	 */
	private initDatabase():void {
		let json = {};
		if(!fs.existsSync(Config.discord2Twitch)) {
			fs.writeFileSync(Config.discord2Twitch, JSON.stringify(json), "utf-8");
			this.buildTwitchHashmap();
		}else{
			try {
				json = JSON.parse(fs.readFileSync(Config.discord2Twitch, "utf-8"));
			}catch(error) {
				//File content is broken. make a backup, drop it and restart init
				const d = new Date();
				const suffix = "_"+d.getFullYear()+"-"+d.getMonth()+"-"+d.getDate()+"_backup";
				fs.copyFileSync(Config.discord2Twitch, Config.discord2Twitch.replace(".json", suffix+".json"));
				fs.unlinkSync(Config.discord2Twitch);
				this.initDatabase();
				return;
			}
		}

		DiscordController._guildId2TwitchId = json;
	}

	/**
	 * Creates bot commands
	 */
	private async createCommands():Promise<void> {
		const debugGuildID:string = "960695714483167252";

		const perms = PermissionsBitField.Flags.Administrator
		& PermissionsBitField.Flags.ManageGuild
		& PermissionsBitField.Flags.ModerateMembers;

		const languages = I18n.instance.discordLanguages;

		let cmd:COMMAND_NAME = "link";
		const LINK_CMD = new SlashCommandBuilder()
		.setName(cmd)
		.setDescription(I18n.instance.get("en", "server.discord.commands.link.description"))
		.addStringOption(option => {
			option.setName("channel")
			option.setDescription(I18n.instance.get("en", "server.discord.commands.link.option_channel"))
			.setRequired(true);
			
			languages.forEach(lang=> {
				option.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.link.option_channel"));
			})
			return option;
		}
		).setDefaultMemberPermissions(perms);
		languages.forEach(lang=> {
			LINK_CMD.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.link.description"));
		})
		
		
		cmd = "say";
		const SAY_CMD = new SlashCommandBuilder()
		.setName(cmd)
		.setDescription(I18n.instance.get("en", "server.discord.commands.say.description"))
		.addStringOption(option =>{
			option.setName("message")
			.setDescription(I18n.instance.get("en", "server.discord.commands.say.option_message"))
			.setRequired(true);
			
			languages.forEach(lang=> {
				option.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.say.option_message"));
			})
			return option;
		})
		.addStringOption(option =>{
			option.setName("style")
			.setDescription(I18n.instance.get("en", "server.discord.commands.say.option_style"))
			.addChoices({name:"important", value:"error"})
			.addChoices({name:"highlight", value:"highlight"})
			.addChoices({name:"normal", value:"message"})
			.setRequired(false);
			
			languages.forEach(lang=> {
				option.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.say.option_style"));
			})
			return option;
		})
		.setDefaultMemberPermissions(perms);
		languages.forEach(lang=> {
			SAY_CMD.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.say.description"));
		})
		
		
		cmd = "ask";
		const ASK_CMD = new SlashCommandBuilder()
		.setName(cmd)
		.setDescription(I18n.instance.get("en", "server.discord.commands.ask.description"))
		.addStringOption(option => {
			option.setName("message")
			.setDescription(I18n.instance.get("en", "server.discord.commands.say.option_message"))
			.setRequired(true);
			
			languages.forEach(lang=> {
				option.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.say.option_message"));
			})
			return option
		})
		.addStringOption(option =>{
			option.setName("style")
			.setDescription(I18n.instance.get("en", "server.discord.commands.say.option_style"))
			.addChoices({name:"important", value:"error"})
			.addChoices({name:"highlight", value:"highlight"})
			.addChoices({name:"normal", value:"message"})
			.setRequired(false);
			
			languages.forEach(lang=> {
				option.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.say.option_style"));
			})
			return option;
		}
		).setDefaultMemberPermissions(perms);
		languages.forEach(lang=> {
			ASK_CMD.setDescriptionLocalization(lang.discord, I18n.instance.get(lang.labels, "server.discord.commands.ask.description"));
		})

		const commandList:SlashCommandBuilder[] = [LINK_CMD, SAY_CMD, ASK_CMD];

		this._rest = new REST().setToken(Config.credentials.discord_bot_token);
		// const existingCmds:SlashCommandDefinition[] = await this._rest.get(Routes.applicationGuildCommands(Config.credentials.discord_client_id, debugGuildID)) as SlashCommandDefinition[];
		const existingCmds:SlashCommandDefinition[] = await this._rest.get(Routes.applicationCommands(Config.credentials.discord_client_id)) as SlashCommandDefinition[];
		const missingCmds:SlashCommandBuilder[] = [];
		const removedCmds:SlashCommandDefinition[] = [];
		//Check which commands should be removed
		for (let i = 0; i < existingCmds.length; i++) {
			const cmd = existingCmds[i];
			if(commandList.findIndex(v => v.name == cmd.name && v.options.length == cmd.options.length) == -1) {
				removedCmds.push(cmd);
			}
		}
		//Define which commands are missing
		for (let i = 0; i < commandList.length; i++) {
			const cmd = commandList[i];
			if(existingCmds.findIndex(v => v.name == cmd.name && v.options.length == cmd.options.length) == -1) {
				missingCmds.push(cmd);
			}
		}
		//Define which commands should be removed
		if(removedCmds.length > 0) {
			Logger.warn("Removing commands "+removedCmds.map(v=>v.name).join(", "));
			for (let i = 0; i < removedCmds.length; i++) {
				const cmd = removedCmds[i];
				// await this._rest.delete(Routes.applicationGuildCommand(Config.credentials.discord_client_id, debugGuildID, cmd.id));
				await this._rest.delete(Routes.applicationCommand(Config.credentials.discord_client_id, cmd.id));
			}
		}

		//Create missing commands
		if(missingCmds.length > 0) {
			Logger.warn("Creating commands "+missingCmds.map(v=>v.name).join(", "));
			// await this._rest.put(Routes.applicationGuildCommands(Config.credentials.discord_client_id, debugGuildID), {body:commandList});
			await this._rest.put(Routes.applicationCommands(Config.credentials.discord_client_id), {body:commandList});
		}

		//Reload a fresh command list to get the ID of the register command
		const freshCommandList:SlashCommandDefinition[] = await this._rest.get(Routes.applicationCommands(Config.credentials.discord_client_id)) as SlashCommandDefinition[];
		this._commandSay = freshCommandList.find(v=>v.name == SAY_CMD.name);
		this._commandAsk = freshCommandList.find(v=>v.name == ASK_CMD.name);
		this._commandLink = freshCommandList.find(v=>v.name == LINK_CMD.name);
	}

	/**
	 * Called when someone uses the /twitch command on discord to associate a discord to a twitch channel
	 * @param request 
	 * @param response 
	 * @param command 
	 */
	private async configureTwitchChannel(request:FastifyRequest, response:FastifyReply, command:SlashCommandPayload):Promise<void> {
		const channel = (command.data.options.find(v=>v.name == "channel")?.value || "").trim();
		const users = await TwitchUtils.loadUsers([channel]);
		if(users == false) {
			response.status(200).send({
				type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
				data: {
					content: I18n.instance.get(command.locale, "server.discord.twitch_user_not_found", {CHANNEL:channel}),
				},
			});
		}else{
			let guildDetails:GuildPreview;
			try {
				guildDetails = await this._rest.get(Routes.guildPreview(command.guild_id)) as GuildPreview;
			}catch(error) {
				response.status(200)
				.send({
					type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
					data: {
						content: I18n.instance.get(command.locale, "server.discord.guild_loading_failed", {GUILD:command.guild_id}),
					},
				});
				return;
			}

			let code = Utils.generateCode(4);
			this._pendingTokens.push({
										locale:command.locale,
										expires_at:Date.now() + this._tokenValidityDuration,
										guildName:guildDetails.name,
										code,
										channelId:users[0].id,
										guildId:command.guild_id,
										guildChannelID:command.channel_id,
									});
			response.status(200).send({
				type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
				data: {
					content: I18n.instance.get(command.locale, "server.discord.code", {CODE:code}),
				},
			});
		}
	}

	/**
	 * Send a message to the configured twitch user
	 * @param request 
	 * @param response 
	 * @param command 
	 */
	private async sendMessageToTwitchat(request:FastifyRequest, response:FastifyReply, command:SlashCommandPayload):Promise<void> {
		const uid = DiscordController._guildId2TwitchId[command.guild_id]?.twitchUID;
		if(!uid) {
			response.status(200).send({
				type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
				data: {
					content: I18n.instance.get(command.locale, "server.discord.install_instructions",
					{
						CMD:this._commandLink?.name || "link",
						CMD_ID:this._commandLink?.id || ""}
					),
				},
			});
		}else{
			const message = command.data.options.find(v=>v.name == "message")!.value;
			response.status(200).send({
				type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
				data: {
					// content: I18n.instance.get(command.locale, "server.discord.message_sent", {MESSAGE:message}),
					content: "> "+message,
				},
			});

			let attempts = 0;
			do {
				try {
					//There must be a cleaner way to get the message initiating the interaction
					//than polling the message list until we get a message containing the 
					//interaction ID, but I couldn't find a any :/
					const params = new URLSearchParams();
					params.set("limit", "10");
					let messages = await this._rest.get(Routes.channelMessages(command.channel_id), {query:params}) as any[];
					const originalMessage = messages.find(mess => mess.interaction && mess.interaction.id == command.id);
					if(originalMessage) {

						const style = command.data.options.find(v=>v.name == "style")?.value || "message";
						const confirm = command.data.name == "ask"
						const guild = DiscordController._twitchId2GuildId[uid];
						let highlightColor = "";
						if(style == "highlight") {
							highlightColor = "#5865f2"
						}
						const actions:{icon?:string,label:string,actionType?:"discord",data?:ActionPayload,quote?:string,message?:string, theme?:"default"|"primary"|"secondary"|"alert"}[] = [];
						if(confirm) {
							actions.push({
								actionType:"discord",
								label:I18n.instance.get(guild.locale, "global.yes"),
								message:":white_check_mark: "+I18n.instance.get(guild.locale, "global.yes"),
								icon:"checkmark",
								theme:"primary",
								data:{messageId:originalMessage.id, channelId:command.channel_id},
							})
							actions.push({
								actionType:"discord",
								label:I18n.instance.get(guild.locale, "global.no"),
								message:":no_entry: "+I18n.instance.get(guild.locale, "global.no"),
								icon:"cross",
								theme:"alert",
								data:{messageId:originalMessage.id, channelId:command.channel_id},
							})
						}else{
							["👌","❤️","😂","😟","⛔"].forEach(reaction => {
								actions.push({
									actionType:"discord",
									label:reaction,
									message:reaction,
									data:{messageId:originalMessage.id, channelId:command.channel_id, reaction},
								})
							})
						}

						let cols:number[] = [];
						if(guild.chatCols.length > 0) cols = guild.chatCols;

						SSEController.sendToUser(uid, SSECode.MESSAGE, {messageId:originalMessage.id, col:cols, message, highlightColor, style, username:command.member.user.username, actions});
						break;
					}
				}catch(error) {
					console.error(error);
				}
				await Utils.promisedTimeout(250);
			}while(++attempts < 10)
		}
	}
}
type COMMAND_NAME = "link" | "say" | "ask";


type InteractionTypeValues  = keyof typeof InteractionType;
type AllInteractionTypes = {
	[K in InteractionTypeValues]: InteractionType;
}[InteractionTypeValues];
interface DiscordBotInstallPayload {
	app_permissions: string;
	application_id: string;
	entitlements: any[];
	id: string;
	token: string;
	type: AllInteractionTypes;
	user: DiscordUser;
	version: number;
}

interface DiscordUser {
	avatar: string;
	avatar_decoration_data?: any;
	bot: boolean;
	discriminator: string;
	global_name: string;
	id: string;
	public_flags: number;
	system: boolean;
	username: string;
}

interface DiscordMember {
	user: {
		id: string;
		username: string;
		avatar: string;
		discriminator: string;
		public_flags: number;
	};
	roles: string[];
	premium_since?: any;
	permissions: string;
	pending: boolean;
	nick?: any;
	mute: boolean;
	joined_at: string;
	is_pending: boolean;
	deaf: boolean;
}


interface SlashCommandPayload {
	type: number;
	token: string;
	member: DiscordMember;
	id: string;
	channel_id: string;
	guild_id: string;
	app_permissions: string;
	guild_locale: string;
	locale: string;
	data: {
		options: {
			type: number;
			name: string;
			value: string;
		}[];
		type: number;
		name: COMMAND_NAME;
		id: string;
	};
	application_id: string;
	channel: {
		flags: number;
		guild_id: string;
		icon_emoji: {
			id?: any;
			name: string;
		};
		id: string;
		last_message_id: string;
		name: string;
		nsfw: boolean;
		parent_id?: any;
		permissions: string;
		position: number;
		rate_limit_per_user: number;
		theme_color?: any;
		topic?: any;
		type: number;
	};
	entitlement_sku_ids: any[];
	entitlements: any[];
	guild: Guild;
	version: number;
}

interface SlashCommandDefinition {
	id: string;
	application_id: string;
	version: string;
	default_member_permissions: number;
	type: number;
	name: string;
	description: string;
	dm_permission: true;
	contexts: unknown;
	integration_types: number[];
	options: any[];
	nsfw: boolean;
}

interface GuildPreview {
	id: string;
	name: string;
	icon: string;
	splash?: any;
	discovery_splash?: any;
	emojis: any[];
	features: string[];
	approximate_member_count: number;
	approximate_presence_count: number;
	description: string;
	stickers: any[];
}

interface TwitchatGuild2Twitch {
	locale: string;
	twitchUID: string;
	guildID: string;
	guildName: string;
	guildChannelId: string;
	logChanTarget: string;
	chatCols: number[];
}

interface PendingToken {
	code: string;
	locale: string;
	guildName: string;
	expires_at: number;
	channelId: string;
	guildId: string;
	guildChannelID: string;
}

interface ActionPayload {
	messageId:string;
	channelId:string;
	reaction?:string;
}