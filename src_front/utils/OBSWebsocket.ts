import StoreProxy from '@/store/StoreProxy';
import { TriggerTypes } from '@/types/TriggerActionDataTypes';
import OBSWebSocket from 'obs-websocket-js';
import type { JsonArray, JsonObject } from 'type-fest';
import { reactive } from 'vue';
import { EventDispatcher } from '../events/EventDispatcher';
import type { TwitchatActionType, TwitchatEventType } from '../events/TwitchatEvent';
import TwitchatEvent from '../events/TwitchatEvent';
import Utils from './Utils';

/**
* Created : 29/03/2022 
*/
export default class OBSWebsocket extends EventDispatcher {

	private static _instance:OBSWebsocket;

	public connected:boolean = false;
	
	private obs!:OBSWebSocket;
	private reconnectTimeout!:number;
	private autoReconnect:boolean = false;
	private connectInfo:{port:string, ip:string, pass:string} = {port:"",ip:"",pass:""};
	
	private sceneCacheKeySplitter:string = "_-___-___-_";
	//Key : "sceneName" + sceneCacheKeySplitter + "sourceName"
	private sceneSourceCache:{[key:string]:{ts:number, value:{scene:string, source:OBSSourceItem}[]}} = {};
	private sceneDisplayRectsCache:{[key:string]:{ts:number, value:{canvas:{width:number, height:number}, sources:{sceneName:string, source:OBSSourceItem, transform:SourceTransform}[]}}} = {};
	private sceneToCaching:{[key:string]:boolean} = {};
	private cachedScreenshots:{[key:string]:{ts:number, screen:string}} = {};
	
	constructor() {
		super();
	}
	
	/********************
	* GETTER / SETTERS *
	********************/
	static get instance():OBSWebsocket {
		if(!OBSWebsocket._instance) {
			OBSWebsocket._instance = reactive(new OBSWebsocket()) as OBSWebsocket;
			OBSWebsocket._instance.initialize();
		}
		return OBSWebsocket._instance;
	}

	public get socket():OBSWebSocket { return this.obs; }
	
	
	
	/******************
	* PUBLIC METHODS *
	******************/
	/**
	 * Disconnect from OBS Websocket
	 */
	public async disconnect():Promise<void> {
		this.autoReconnect = false;
		if(this.connected) {
			this.obs.disconnect();
		}
		this.connected = false;
	}

	/**
	 * Connect to OBS websocket
	 * 
	 * @param port 
	 * @param pass 
	 * @param autoReconnect 
	 * @returns 
	 */
	public async connect(port:string, pass:string = "", autoReconnect = true, ip = "127.0.0.1", forceConnect:boolean = false):Promise<boolean> {
		if(this.connected) return true;
		
		clearTimeout(this.reconnectTimeout);
		this.autoReconnect = autoReconnect;
		if(!forceConnect && StoreProxy.obs.connectionEnabled !== true) return false;
		
		try {
			this.connectInfo.ip = ip;
			this.connectInfo.port = port;
			this.connectInfo.pass = pass;
			const protocol = (ip == "127.0.0.1" || ip == "localhost") ? "ws://" : "wss://";
			const portValue = port && port?.length > 0 && port != "0"? ":"+port : "";
			await this.obs.connect(protocol + ip + portValue, pass, {rpcVersion: 1});
			this.connected = true;
			this.dispatchEvent(new TwitchatEvent("OBS_WEBSOCKET_CONNECTED"));
		}catch(error) {
			console.log(error);
			if(this.autoReconnect) {
				clearTimeout(this.reconnectTimeout);
				this.reconnectTimeout = setTimeout(()=> {
					this.connect(port, pass, autoReconnect, ip);
				}, 5000);
			}
			return false;
		}

		StoreProxy.main.currentOBSScene = await this.getCurrentScene();

		// console.log(await this.obs.call("GetInputList"));

		/* LIST ALL INPUT KINDS
		const sources = await this.getSources();
		const inputKinds:{[key:string]:boolean} = {}
		const sourceKinds:{[key:string]:boolean} = {}
		for (let i = 0; i < sources.length; i++) {
			const e = sources[i];
			if(inputKinds[e.inputKind] !== true) {
				inputKinds[e.inputKind] = true;
			}
			if(sourceKinds[e.sourceType] !== true) {
				sourceKinds[e.sourceType] = true;
			}
		}
		console.log(inputKinds);
		console.log(sourceKinds);
		//*/

		/* GET A SOURCE SETTINGS
		const settings = await this.obs.call("GetInputSettings", {inputName: "TTBrowerSourceTest"});
		console.log(settings);
		//*/

		/* GET ALL SOURCES OF A SCENE
		const itemsCall = await this.obs.call("GetSceneItemList", {sceneName:"👦 Face (FS)"});
		const items = (itemsCall.sceneItems as unknown) as OBSSourceItem[];
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			console.log(item);
		}
		//*/

		// const res = await this.getSourceOnCurrentScene("TTImage");
		// console.log(res);

		return true;
	}

	public async stopStreaming():Promise<void> {
		if(!this.connected) return;
		const status = await this.obs.call("GetStreamStatus");
		if(status.outputActive) {
			await this.obs.call("StopStream");
		}
	}

	/**
	 * Broadcast a message to all the connected clients
	 * @param data
	 */
	public async broadcast(type:TwitchatEventType|TwitchatActionType, data?:JsonObject, retryCount:number = 0):Promise<void> {
		if(!this.connected) {
			//Try again
			if(retryCount == 30) return;
			setTimeout(()=> this.broadcast(type, data, ++retryCount), 1000);
			return;
		}

		const eventData = { origin:"twitchat", type, data }
		this.obs.call("BroadcastCustomEvent", {eventData});
	}
	
	/**
	 * Get all the scenes references
	 * 
	 * @returns 
	 */
	public async getScenes():Promise<{
		currentProgramSceneName: string;
		currentPreviewSceneName: string;
		scenes: {sceneIndex:number, sceneName:string}[];
	}> {
		if(!this.connected) return {currentProgramSceneName:"", currentPreviewSceneName:"", scenes:[]};
		
		let res = await this.obs.call("GetSceneList");
		return res as {
			currentProgramSceneName: string;
			currentPreviewSceneName: string;
			scenes: {sceneIndex:number, sceneName:string}[];
		};
	}
	
	/**
	 * Get all the sources references
	 * 
	 * @returns 
	 */
	public async getSources(currentSceneOnly:boolean = false):Promise<OBSSourceItem[]> {
		if(!this.connected) return [];
		const scenesResult = await this.getScenes();
		let sceneList:OBSSceneItemParented[] = scenesResult.scenes;
		if(currentSceneOnly) {
			let currentScene  = await this.getCurrentScene();
			sceneList = sceneList.filter(v=>v.sceneName == currentScene);
		}
		let sources:OBSSourceItem[] = [];
		const sourceDone:{[key:string]:boolean} = {};
		const scenesDone:{[key:string]:boolean} = {};
		
		//Parse all scene items
		for (const scene of sceneList) {
			if(scenesDone[scene.sceneName] == true) continue;
			scenesDone[scene.sceneName] = true;

			let list = await this.obs.call("GetSceneItemList", {sceneName:scene.sceneName});
			let items = (list.sceneItems as unknown) as OBSSourceItem[];

			//Parse all scene sources
			for (const source of items) {
				if(sourceDone[source.sourceName] == true) continue;

				sourceDone[source.sourceName] = true;
				
				//Get group children
				if(source.isGroup) {
					const res = await this.obs.call("GetGroupSceneItemList", {sceneName:source.sourceName});
					const groupItems = (res.sceneItems as unknown) as OBSSourceItem[];
					items = items.concat( groupItems );
				}

				//Check recursively on child scene if we requested the sources only from the current scene
				if(source.sourceType == "OBS_SOURCE_TYPE_SCENE" && currentSceneOnly) {
					sceneList.push({sceneIndex:-1, sceneName:source.sourceName, parentScene:scene});
				}
			}
			sources = sources.concat(items);
		}

		//Dedupe results
		let itemsDone:{[key:string]:boolean} = {};
		for (let i = 0; i < sources.length; i++) {
			if(itemsDone[sources[i].sourceName] === true) {
				sources.splice(i, 1)!
				i--;
			}
			itemsDone[sources[i].sourceName] = true;
		}

		return sources;
	}
	
	/**
	 * Get all sources currently on screen with their coordinates.
	 * Returns original OBS transforms augmented with these global coordinate space values
	 * to make manipulation easier :
	 * 
	 *	globalCenterX
	 *	globalCenterY
	 *	globalScaleX
	 *	globalScaleY
	 *	globalRotation
	 *	globalTL
	 *	globalTR
	 *	globalBL
	 *	globalBR
	 * 
	 * @returns 
	 */
	public async getSourcesDisplayRects():Promise<{canvas:{width:number, height:number}, sources:{sceneName:string, source:OBSSourceItem, transform:SourceTransform}[]}> {
		if(!this.connected) return {canvas:{width:1920, height:1080}, sources:[]};
		const currentScene  = await this.getCurrentScene();
		
		//If current scene is cached, just send back cached data
		const cache = this.sceneDisplayRectsCache[currentScene];
		if(cache && Date.now()-cache.ts < 30000) return this.sceneDisplayRectsCache[currentScene].value;

		//If caching is in progress from a previous request, wait a little
		if(this.sceneToCaching[currentScene] === true) {
			if(cache) return cache.value;
			return {canvas:{width:1920, height:1080}, sources:[]};
		}

		//Flag scene as being cached
		this.sceneToCaching[currentScene] = true;
		const isOverlayInteraction = StoreProxy.chat.botMessages.heatSpotify.enabled || StoreProxy.chat.botMessages.heatUlule.enabled;

		const videoSettings = await this.obs.call("GetVideoSettings");
		let sceneList:{name:string, parentScene?:string, parentItemId?:number, parentTransform?:SourceTransform, isGroup?:boolean}[] = [{name:currentScene}];
		const transforms:{source:OBSSourceItem, sceneName:string, transform:SourceTransform}[] = [];
		const sourceDone:{[key:string]:boolean} = {};
		const scenesDone:{[key:string]:boolean} = {};
		const itemNameToTransform:{[key:string]:SourceTransform} = {};
		const canvasW:number = videoSettings.baseWidth;
		const canvasH:number = videoSettings.baseHeight;
		const sourcesToWatch:string[] = [];

		StoreProxy.triggers.triggerList.forEach(v=> {
			if(v.type == TriggerTypes.HEAT_CLICK && v.heatObsSource && v.enabled){
				sourcesToWatch.push(v.heatObsSource);
			}
		});

		if(sourcesToWatch.length === 0 && !isOverlayInteraction) {
			this.sceneToCaching[currentScene] = false;
			return {canvas:{width:1920, height:1080}, sources:[]};
		}

		//Parse all scene items
		for (let j = 0; j < sceneList.length; j++) {
			const scene = sceneList[j];
			
			if(scenesDone[scene.name] == true) continue;
			scenesDone[scene.name] = true;

			let list:{sceneItems: JsonObject[]} = {sceneItems:[]};
			if(scene.isGroup === true){
				list = await this.obs.call("GetGroupSceneItemList", {sceneName:scene.name});
			}else{
				list = await this.obs.call("GetSceneItemList", {sceneName:scene.name});
			}
			let items:{parent:string, item:OBSSourceItem}[] = ((list.sceneItems as unknown) as OBSSourceItem[]).map(v=> {return {parent:scene.name, item:v}});
			//Parse all scene sources
			for (let i=0; i < items.length; i++) {
				const source = items[i];
				sourceDone[source.item.sourceName] = true;
				
				//Ignore invisible items
				const visibleRes = await this.obs.call("GetSceneItemEnabled", {
					sceneName:source.parent,
					sceneItemId:source.item.sceneItemId,
				});
				if(!visibleRes.sceneItemEnabled) continue;

				//If no trigger request for this source's events and if it's not a browser source or a group or a scene, ignore it
				if(source.item.sourceType != "OBS_SOURCE_TYPE_SCENE"
				&& !source.item.isGroup
				&& source.item.inputKind != "browser_source"
				&& !sourcesToWatch.includes(source.item.sourceName)) {
					continue;
				}
				
				let sourceTransform = await this.getSceneItemTransform(source.parent, source.item.sceneItemId);
				if(!sourceTransform.globalScaleX) {
					sourceTransform.globalScaleX = sourceTransform.scaleX;
					sourceTransform.globalScaleY = sourceTransform.scaleY;
					sourceTransform.globalRotation = 0;
				}

				//Compute the center of the source on the local space
				let coords = this.getSourceCenterFromTransform(sourceTransform);
				sourceTransform.globalCenterX = coords.cx;
				sourceTransform.globalCenterY = coords.cy;

				if(scene.parentTransform) {
					//Apply parent rotation
					const pt = scene.parentTransform;
					const cW = scene.isGroup? pt.width/2 : canvasW/2;
					const cH = scene.isGroup? pt.height/2 : canvasH/2;
					let rotated = Utils.rotatePointAround(
													{
														x:sourceTransform.globalCenterX + pt.globalCenterX! - cW,
														y:sourceTransform.globalCenterY + pt.globalCenterY! - cH,
													},
													{x:pt.globalCenterX!, y:pt.globalCenterY!},
													pt.rotation
													);
					sourceTransform.globalCenterX = rotated.x;
					sourceTransform.globalCenterY = rotated.y;

					//Propagate scale and rotation to children
					sourceTransform.rotation += pt.rotation;
					sourceTransform.globalRotation = sourceTransform.rotation;
					sourceTransform.globalScaleX! *= pt.globalScaleX!;
					sourceTransform.globalScaleY! *= pt.globalScaleY!;

					//Apply parent scale
					const scaled = this.applyParentScale({x:sourceTransform.globalCenterX, y:sourceTransform.globalCenterY}, pt);
					sourceTransform.globalCenterX = scaled.x;
					sourceTransform.globalCenterY = scaled.y;
				}

				//Is it a source?
				if((source.item.sourceType == "OBS_SOURCE_TYPE_INPUT"
				|| source.item.sourceType == "OBS_SOURCE_TYPE_SCENE")
				|| source.item.isGroup) {
					itemNameToTransform[source.item.sourceName+"_"+source.item.sceneItemId] = sourceTransform;
					let px = sourceTransform.globalCenterX!;
					let py = sourceTransform.globalCenterY!;
					const hw = (sourceTransform.sourceWidth * sourceTransform.globalScaleX!) / 2
					const hh = (sourceTransform.sourceHeight * sourceTransform.globalScaleY!) / 2
					const angle_rad = sourceTransform.rotation * Math.PI / 180;
					const cos_angle = Math.cos(angle_rad);
					const sin_angle = Math.sin(angle_rad);
					sourceTransform.globalRotation = sourceTransform.rotation;
					sourceTransform.globalBL = {x:px - hw * cos_angle - hh * sin_angle, y:py - hw * sin_angle + hh * cos_angle};
					sourceTransform.globalBR = {x:px + hw * cos_angle - hh * sin_angle, y:py + hw * sin_angle + hh * cos_angle};
					sourceTransform.globalTL = {x:px - hw * cos_angle + hh * sin_angle, y:py - hw * sin_angle - hh * cos_angle};
					sourceTransform.globalTR = {x:px + hw * cos_angle + hh * sin_angle, y:py + hw * sin_angle - hh * cos_angle};
					if(!source.item.isGroup) {
						transforms.push({transform:sourceTransform, sceneName:source.parent, source:source.item});
					}
				}
				
				//If it's a scene item, add it to the scene list
				if(source.item.sourceType == "OBS_SOURCE_TYPE_SCENE" || source.item.isGroup) {
					itemNameToTransform[source.item.sourceName+"_"+source.item.sceneItemId] = sourceTransform;
					sceneList.push( {
									name:source.item.sourceName,
									parentScene:source.parent,
									parentItemId:source.item.sceneItemId,
									parentTransform:sourceTransform,
									isGroup:source.item.isGroup === true,
								} );
				}
			}
		}

		const res = {canvas:{width:canvasW, height:canvasH}, sources:transforms};
		this.sceneDisplayRectsCache[currentScene] = {ts:Date.now(), value:res};
		this.sceneToCaching[currentScene] = false;
		return res;
	}

	/**
	 * Clears cache for sources transforms
	 */
	public clearSourceTransformCache():void {
		this.sceneDisplayRectsCache = {};
	}

	/**
	 * Update the transform's props of a source
	 * @param sceneName 
	 * @param sceneItemId 
	 * @param transform 
	 */
	public async setSourceTransform(sceneName:string, sceneItemId:number, transform:Partial<SourceTransform>):Promise<void> {
		if(!this.connected) return;
		await this.obs.call("SetSceneItemTransform", {sceneName, sceneItemId, sceneItemTransform:transform});
	}
	
	/**
	 * Get all the available inputs
	 * 
	 * @returns 
	 */
	public async getInputs():Promise<OBSInputItem[]> {
		if(!this.connected) return [];
		return ((await this.obs.call("GetInputList")).inputs as unknown) as OBSInputItem[];
	}
	
	/**
	 * Get all the available audio sources
	 * 
	 * @returns 
	 */
	public async getAudioSources():Promise<{
		inputs: JsonArray;
	}> {
		if(!this.connected) return {inputs:[]};
		
		const kinds = await this.getInputKindList();
		const audioKind = kinds.inputKinds.find(kind=>kind.indexOf("input_capture") > -1);
		return await this.obs.call("GetInputList", {inputKind:audioKind});
	}
	
	/**
	 * Get all the available kinds of sources
	 * @returns 
	 */
	public async getInputKindList():Promise<{
		inputKinds: string[];
	}> {
		if(!this.connected) return {inputKinds:[]};
		
		return await this.obs.call("GetInputKindList");
	}

	/**
	 * Gets all the available filters of a specific source
	 * 
	 * @param sourceName 
	 * @returns 
	 */
	public async getSourceFilters(sourceName:string):Promise<OBSFilter[]> {
		if(!this.connected) return [];
		
		const res = await this.obs.call("GetSourceFilterList", {sourceName});
		return (res.filters as unknown) as OBSFilter[];
	}

	/**
	 * Set the current scene by its name
	 * 
	 * @param name 
	 * @returns 
	 */
	public async setCurrentScene(name:string):Promise<void> {
		if(!this.connected) return;
		
		await this.obs.call("SetCurrentProgramScene", {sceneName:name});
	}

	/**
	 * Get the current scene
	 * 
	 * @returns 
	 */
	public async getCurrentScene():Promise<string> {
		if(!this.connected) return "";
		let scene = "";
		try {
			const res = await this.obs.call("GetCurrentProgramScene");
			scene = res.currentProgramSceneName;
		}catch(error) {}
		return scene;
	}

	/**
	 * Change the content of a text source
	 * 
	 * @param sourceName 
	 * @param text 
	 */
	public async setTextSourceContent(sourceName:string, text:string):Promise<void> {
		if(!this.connected) return;
		
		await this.obs.call("SetInputSettings", {inputName:sourceName as string, inputSettings:{text}});
	}

	/**
	 * Change a filter's visibility
	 * 
	 * @param sourceName 
	 * @param filterName 
	 * @param visible 
	 */
	public async setFilterState(sourceName:string, filterName:string, visible:boolean):Promise<void> {
		if(!this.connected) return;
		
		await this.obs.call("SetSourceFilterEnabled", {sourceName, filterName, filterEnabled:visible});
		await Utils.promisedTimeout(50);
	}

	/**
	 * Set a sources's visibility on the current scene
	 * 
	 * @param sourceName 
	 * @param visible 
	 */
	public async setSourceState(sourceName:string, visible:boolean):Promise<void> {
		if(!this.connected) return;
		
		const items = await this.getSourceOnCurrentScene(sourceName);
		if(items.length > 0) {
			for (let i = 0; i < items.length; i++) {
				await this.obs.call("SetSceneItemEnabled", {
					sceneName:items[i].scene,
					sceneItemId:items[i].source.sceneItemId,
					sceneItemEnabled:visible
				});
			}
		}
	}

	/**
	 * Gets the ID of a scene item by its name
	 * @param sourceName 
	 * @param sceneName will search on current scene if not specified
	 * @returns 
	 */
	public async searchSceneItemId(sourceName:string, sceneName?:string):Promise<{scene:string, itemId:number}|null> {
		if(!sceneName) {
			const scene = await this.obs.call("GetCurrentProgramScene");
			sceneName = scene.currentProgramSceneName;
		}
		try {
			const result = await this.obs.call("GetSceneItemId", {sceneName, sourceName});
			return {scene:sceneName, itemId:result.sceneItemId};
		}catch(error){
			//If source isn't found, search for groups recursively to also check within them
			let sources = await this.getSources();
			for (let i = 0; i < sources.length; i++) {
				const s = sources[i];
				if(s.isGroup || s.sourceType == "OBS_SOURCE_TYPE_SCENE") {
					let res = await this.searchSceneItemId(sourceName, s.sourceName);
					if(res) return res;
				}
			}
		}
		return null;
	}

	/**
	 * Get a source by its name on the current scene.
	 * Searches recursively on sub scenes
	 * 
	 * @param sourceName 
	 * @param sceneName 
	 * @returns 
	 */
	public async getSourceOnCurrentScene(sourceName:string):Promise<{scene:string, source:OBSSourceItem}[]> {
		const scene = await this.obs.call("GetCurrentProgramScene");
		const sceneName = scene.currentProgramSceneName;

		const getSourceListOn = async (target:string, isGroup:boolean):Promise<{scene:string, source:OBSSourceItem}[]> => {

			const cacheKey = target + this.sceneCacheKeySplitter + sourceName;
			//Searching for a source in the scene tree may take quite much time depending on the number
			//of sources and nested scenes. If the resource has already been queried, send back cached data
			if(this.sceneSourceCache[cacheKey]) {
				return this.sceneSourceCache[cacheKey].value;
			}

			let result:{scene:string, source:OBSSourceItem}[] = [];
			let items:OBSSourceItem[] = [];
			if(isGroup) {
				//Search in grouped items
				const res = await this.obs.call("GetGroupSceneItemList", {sceneName:target});
				items = (res.sceneItems as unknown) as OBSSourceItem[];
			}else{
				//Search in scene items
				const res = await this.obs.call("GetSceneItemList", {sceneName:target});
				items = (res.sceneItems as unknown) as OBSSourceItem[];
			}

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if(item.sourceName == sourceName) {
					result.push( {scene:target, source:item} );
				}
			}

			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if(item.isGroup) {
					//Search on sub group
					const list = await getSourceListOn(item.sourceName, true);
					if(list.length > 0) result = result.concat(list);
				}else
				//Search on sub scene
				if(item.sourceType == "OBS_SOURCE_TYPE_SCENE") {
					const list = await getSourceListOn(item.sourceName, false);
					if(list.length > 0) result = result.concat(list);
				}
			}
			this.sceneSourceCache[cacheKey] = {ts:Date.now(), value:result};
			return result;
		}

		return getSourceListOn(sceneName, false);
	}

	/**
	 * Mute/unmute an audio source by its name
	 * 
	 * @param sourceName 
	 * @param mute 
	 * @returns 
	 */
	public async setMuteState(sourceName:string, mute:boolean):Promise<void> {
		if(!this.connected) return;
		
		await this.obs.call("SetInputMute", {inputName:sourceName, inputMuted:mute});
	}

	/**
	 * Change the URL of a browser source
	 * 
	 * @param sourceName 
	 * @param url 
	 */
	public async setBrowserSourceURL(sourceName:string, url:string):Promise<void> {
		if(!this.connected) return;
		
		// const settings = await this.obs.call("GetInputSettings", {inputName: sourceName});
		const newSettings:BrowserSourceSettings = {shutdown:true, is_local_file:false, url}
		if(!/https?:\/\.*/i?.test(url)) {
			//If using a local file, do not use "local_file" param is it does not
			//supports query parameters. 
			newSettings.url = "file:///"+url;
		}
		
		await this.obs.call("SetInputSettings", {inputName:sourceName as string, inputSettings:newSettings as JsonObject});
	}

	/**
	 * Gets the settings of a source
	 * 
	 * @param sourceName 
	 */
	public async getSourceSettings(sourceName:string):Promise<{
		inputSettings: JsonObject;
		inputKind: string;
	}> {
		if(!this.connected) return {
			inputSettings: {},
			inputKind: "",
		};

		const settings = await this.obs.call("GetInputSettings", {inputName: sourceName});
		return settings;
	}

	/**
	 * Gets the transforms of a source
	 * 
	 * @param sourceName 
	 */
	public async getSceneItemTransform(sceneName:string, sceneItemId:number):Promise<SourceTransform> {
		if(!this.connected) return {
			alignment: 0,
			boundsAlignment: 0,
			boundsHeight: 0,
			boundsType: "OBS_BOUNDS_NONE",
			boundsWidth: 0,
			cropBottom: 0,
			cropLeft: 0,
			cropRight: 0,
			cropTop: 0,
			height: 0,
			positionX: 0,
			positionY: 0,
			rotation: 0,
			scaleX: 0,
			scaleY: 0,
			sourceHeight: 0,
			sourceWidth: 0,
			width: 0,
		};

		const settings = await this.obs.call("GetSceneItemTransform", {sceneName, sceneItemId});
		return (settings.sceneItemTransform as unknown) as SourceTransform;
	}

	/**
	 * Change the URL of an media (ffmpeg) source
	 * 
	 * @param sourceName 
	 * @param url 
	 */
	public async setMediaSourceURL(sourceName:string, url:string):Promise<void> {
		if(!this.connected) return;
		
		await this.obs.call("SetInputSettings", {inputName:sourceName as string, inputSettings:{local_file:url, file:url}});
	}

	/**
	 * Restart playing of a media source
	 * 
	 * @param sourceName 
	 */
	public async replayMedia(sourceName:string):Promise<void> {
		if(!this.connected) return;
		await this.obs.call('TriggerMediaInputAction',{'inputName':sourceName,'mediaAction':'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART'});
	}

	/**
	 * Get a screenshot of a source.
	 * Takes a screenshot of the current scene if no sourceName is defined
	 * 
	 * @param sourceName 
	 */
	public async getScreenshot(sourceName?:string):Promise<string> {
		if(!this.connected) return "";
		if(!sourceName) sourceName = await this.getCurrentScene();
		//If there's an cached image recent enough, send it back
		if(Date.now() - this.cachedScreenshots[sourceName]?.ts < 100) return this.cachedScreenshots[sourceName].screen;

		//Request for a fresh new screenshot
		let res = await this.obs.call('GetSourceScreenshot',{'sourceName':sourceName, imageFormat:"jpeg"});
		//Cache it
		this.cachedScreenshots[sourceName] = {
			ts:Date.now(),
			screen:res.imageData,
		}
		return res.imageData;
	}
	
	
	
	/*******************
	* PRIVATE METHODS *
	*******************/
	private initialize():void {
		this.obs = new OBSWebSocket();

		this.obs.addListener("ConnectionClosed", ()=> {
			this.connected = false;
			if(this.autoReconnect) {
				clearTimeout(this.reconnectTimeout);
				this.reconnectTimeout = setTimeout(()=> {
					this.connect(this.connectInfo.port, this.connectInfo.pass, this.autoReconnect, this.connectInfo.ip);
				}, 5000);
			}
		});

		//@ts-ignore "CustomEvent" not yet defined on OBS-ws signatures
		this.obs.on("CustomEvent", (e:{origin:"twitchat", type:TwitchatActionType, data:JsonObject | JsonArray | JsonValue}) => {
			if(e.type == undefined) return;
			if(e.origin != "twitchat") return;
			this.dispatchEvent(new TwitchatEvent(e.type, e.data));
			this.dispatchEvent(new TwitchatEvent("CustomEvent", e));
		});

		this.obs.on("CurrentProgramSceneChanged", (e:{sceneName:string}) => {
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_SCENE_CHANGE, e));
		});

		this.obs.on("InputMuteStateChanged", (e:{inputName:string, inputMuted:boolean}) => {
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_MUTE_TOGGLE, e));
		});

		//This event is disabled as its very specific to media sources with playback control
		//which are probably not much used
		/*
		this.obs.on("MediaInputActionTriggered", (e:{inputName:string, mediaAction:string}) => {
			const action:OBSMediaAction = e.mediaAction as OBSMediaAction;
			let event:string = "";
			switch(action) {
				case "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NONE": return;//Ignore
				case "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY": event = TwitchatEvent.OBS_PLAYBACK_STARTED; break;
				case "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE": event = TwitchatEvent.OBS_PLAYBACK_PAUSED; break;
				case "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP": event = TwitchatEvent.OBS_PLAYBACK_ENDED; break;
				case "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART": event = TwitchatEvent.OBS_PLAYBACK_RESTARTED; break;
				case "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT": event = TwitchatEvent.OBS_PLAYBACK_NEXT; break;
				case "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS": event = TwitchatEvent.OBS_PLAYBACK_PREVIOUS; break;
			}
			this.dispatchEvent(new TwitchatEvent(event, e));
		});
		//*/

		this.obs.on("MediaInputPlaybackStarted", async (e:{inputName:string}) => {
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_PLAYBACK_STARTED, e));
		});
		
		this.obs.on("MediaInputPlaybackEnded", async (e:{inputName:string}) => {
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_PLAYBACK_ENDED, e));
		});

		this.obs.on("SceneItemEnableStateChanged", async (e:{sceneName:string, sceneItemId:number, sceneItemEnabled:boolean}) => {
			let res:{sceneItems: JsonObject[]} = {sceneItems:[]};
			try {
				res = await this.obs.call("GetSceneItemList", {sceneName:e.sceneName});
			}catch(error) {
				console.log("Failed loading scene item, try loading it as a group");
				//If reaching this point it's most probably because the scene is
				//actually a group.
				//Let's try to load its content as a group.
				try {
					res = await this.obs.call("GetGroupSceneItemList", {sceneName:e.sceneName});
				}catch(error){
					//dunno what could have failed :/
					console.log("Failed loading it a group as well :/");
					console.log(error);
				}
			}
			const items = (res.sceneItems as unknown) as OBSSourceItem[];
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if(item.sceneItemId == e.sceneItemId) {
					this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_SOURCE_TOGGLE, {item, event:e} as unknown as JsonObject));
					break;
				}
			}
		});
		
		this.obs.on("InputNameChanged", async (e:{oldInputName:string, inputName:string}) => {
			//Migrate all caches refering to the old source name to the new source name
			for (const key in this.sceneSourceCache) {
				const [scene, source] = key.split(this.sceneCacheKeySplitter);
				if(source == e.oldInputName) {
					this.sceneSourceCache[ scene + this.sceneCacheKeySplitter + e.inputName ] = this.sceneSourceCache[key];
					delete this.sceneSourceCache[key];
				}
			}
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_INPUT_NAME_CHANGED, e));
		});
		
		this.obs.on("SceneNameChanged", async (e:{oldSceneName:string, sceneName:string}) => {
			//Migrate all caches refering to the old scene name to the new scene name
			for (const key in this.sceneSourceCache) {
				const [scene, source] = key.split(this.sceneCacheKeySplitter);
				if(scene == e.oldSceneName) {
					this.sceneSourceCache[ e.sceneName + this.sceneCacheKeySplitter + source ] = this.sceneSourceCache[key];
					delete this.sceneSourceCache[key];
				}
			}
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_SCENE_NAME_CHANGED, e));
		});

		this.obs.on("SourceFilterNameChanged", async (e:{sourceName: string, oldFilterName: string, filterName: string}) => {
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_FILTER_NAME_CHANGED, e));
		});

		this.obs.on("SourceFilterEnableStateChanged", async (e:{sourceName: string, filterName: string, filterEnabled: boolean}) => {
			this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_FILTER_TOGGLE, e));
		});

		this.obs.on("StreamStateChanged", async (e:{outputActive: boolean, outputState: string}) => {
			if(e.outputState == "OBS_WEBSOCKET_OUTPUT_STARTED" || e.outputState == "OBS_WEBSOCKET_OUTPUT_STOPPED") {
				this.dispatchEvent(new TwitchatEvent(TwitchatEvent.OBS_STREAM_STATE, e));
			}
		});
	}

	/**
	 * Get the center of a rectangle depending on its pivot point placement
	 * 
	 * @param pivotType 
	 * @param pivotX 
	 * @param pivotY 
	 * @param width 
	 * @param height 
	 * @param rotation_deg 
	 */
	private getSourceCenterFromTransform(transform:SourceTransform) {
		let a = -transform.rotation * Math.PI / 180;
		let width = transform.width - transform.cropLeft - transform.cropRight;
		let height = transform.height - transform.cropTop - transform.cropBottom;
		let w = width / 2;
		let h = height / 2;

		//Define width and height offset depending on the pivot point type
		switch (transform.alignment) {
			//center
			case 0: break;
			//center left
			case 1:
				w = 0;
				break;
			//center right
			case 2:
				w *= 2;
				break;
			//top center
			case 4:
				h = 0;
				break;
			//top left
			case 5:
				w = 0;
				h = 0;
				break;
			//top right
			case 6:
				w *= 2;
				h = 0;
				break;
			//bottom center
			case 8:
				h *= 2;
				break;
			//bottom left
			case 9:
				w = 0;
				h *= 2;
				break;
			//bottom right
			case 10:
				w *= 2;
				h *= 2;
				break;
			default:
				break;
		}

		//Get top left corner coordinates
		let cosTheta = Math.cos(a);
		let sinTheta = Math.sin(a);
		let displacementX = w * cosTheta + h * sinTheta;
		let displacementY = h * cosTheta - w * sinTheta;
		let px = transform.positionX - displacementX;
		let py = transform.positionY - displacementY;

		//Get center point coordinates
		displacementX = (width / 2) * cosTheta + (height / 2) * sinTheta;
		displacementY = (height / 2) * cosTheta - (width / 2) * sinTheta;
		let cx = px + displacementX;
		let cy = py + displacementY;

		return { x: px, y: py, cx, cy };
	}

	/**
	 * Apply scale 
	 * @param point 
	 * @param origin 
	 * @param scale 
	 */
	private applyParentScale(point:{x:number, y:number}, parentTransform:SourceTransform) {
		const translatedX = point.x - parentTransform.globalCenterX!;
		const translatedY = point.y - parentTransform.globalCenterY!;
		const scaledX = translatedX * parentTransform.globalScaleX!;
		const scaledY = translatedY * parentTransform.globalScaleY!;
		const x = scaledX + parentTransform.globalCenterX!;
		const y = scaledY + parentTransform.globalCenterY!;
		return { x, y };
	}
}

export type OBSInputKind = "window_capture" | "streamfx-source-mirror" | "browser_source" | "color_source_v3" | "dshow_input" | "image_source" | "null" | "monitor_capture" | "ffmpeg_source" | "wasapi_input_capture" | "text_gdiplus_v2" | "vlc_source";
export type OBSSourceType = "OBS_SOURCE_TYPE_INPUT" | "OBS_SOURCE_TYPE_SCENE";

export interface OBSAudioSource {inputKind:OBSInputKind, inputName:string, unversionedInputKind:string}
export interface OBSSourceItem {
	inputKind:OBSInputKind;
	isGroup:boolean|null;
	sceneItemId:number;
	sceneItemIndex:number;
	sourceName:string;
	sourceType:OBSSourceType;
}

export interface OBSSceneItem {
	sceneIndex:number;
	sceneName:string;
}

export interface OBSSceneItemParented {
	sceneIndex:number;
	sceneName:string;
	parentScene?:OBSSceneItem;
}

export interface OBSInputItem {
	inputKind:OBSInputKind;
	inputName:string;
	unversionedInputKind:string;
}

export interface OBSFilter {
	filterEnabled: boolean;
	filterIndex: number;
	filterKind: string;
	filterName: string;
	filterSettings: unknown;
}

export interface BrowserSourceSettings {
	fps?: number;
	fps_custom?: boolean;
	height?: number;
	is_local_file?: boolean;
	local_file?: string;
	shutdown?: boolean;
	url?: string;
	width?: number;
}

export interface SourceTransform {
	alignment: number;
	boundsAlignment: number;
	boundsHeight: number;
	boundsType: string;
	boundsWidth: number;
	cropBottom: number;
	cropLeft: number;
	cropRight: number;
	cropTop: number;
	height: number;
	positionX: number;
	positionY: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	sourceHeight: number;
	sourceWidth: number;
	width: number;
	/**
	 * Center X of the source on the global space
	 */
	globalCenterX? :number;
	/**
	 * Center Y of the source on the global space
	 */
	globalCenterY? :number;
	/**
	 * Scale X of the source on the global space
	 */
	globalScaleX? :number;
	/**
	 * Scale Y of the source on the global space
	 */
	globalScaleY? :number;
	/**
	 * Rotation of the source on the global space
	 */
	globalRotation? :number;
	/**
	 * Top Left corner coordinates on the global space
	 */
	globalTL? :{x:number, y:number};
	/**
	 * Top Right corner coordinates on the global space
	 */
	globalTR? :{x:number, y:number};
	/**
	 * Bottom Left corner coordinates on the global space
	 */
	globalBL? :{x:number, y:number};
	/**
	 * Bottom Left corner coordinates on the global space
	 */
	globalBR? :{x:number, y:number};
}


export type OBSMediaAction = "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NONE" |
							"OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY" |
							"OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE" |
							"OBS_WEBSOCKET_MEDIA_INPUT_ACTION_STOP" |
							"OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART" |
							"OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT" |
							"OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS";