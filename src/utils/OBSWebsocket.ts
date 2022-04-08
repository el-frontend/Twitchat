import OBSWebSocket from 'obs-websocket-js';
import { JsonArray } from 'type-fest';
import { reactive } from 'vue';

/**
* Created : 29/03/2022 
*/
export default class OBSWebsocket {

	private static _instance:OBSWebsocket;

	public connected:boolean = false;
	
	private obs!:OBSWebSocket;
	private reconnectTimeout!:number;
	private connectAttempsCount:number = 0;
	private autoReconnect:boolean = false;
	
	constructor() {
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
	
	
	
	/******************
	* PUBLIC METHODS *
	******************/
	public async disconnect():Promise<void> {
		this.autoReconnect = false;
		this.obs.disconnect();
	}

	public async connect(port:string, pass:string, autoReconnect:boolean = true):Promise<boolean> {
		clearTimeout(this.reconnectTimeout);
		this.autoReconnect = autoReconnect;
		this.obs = new OBSWebSocket();
		try {
			console.log("ws://127.0.0.1:"+port, pass);
			await this.obs.connect("ws://127.0.0.1:"+port, pass, {rpcVersion:1});
		}catch(error) {
			console.log(error);
			if(this.autoReconnect) {
				this.connectAttempsCount ++;
				this.reconnectTimeout = setTimeout(()=> {
					this.connect(port, pass);
				}, Math.pow(this.connectAttempsCount, 3)*1000);
			}
			return false;
		}
		this.connected = true;
		this.obs.addListener("ConnectionClosed", ()=> {
			this.connected = false;
			console.log("Disconnect");
			if(this.autoReconnect) {
				this.connect(port, pass);
			}
		})
		return true;
	}

	public async setScene(name:string):Promise<void> {
		return await this.obs.call("SetCurrentProgramScene", {sceneName:name});
	}
	
	public async getScenes():Promise<{
		currentProgramSceneName: string;
		currentPreviewSceneName: string;
		scenes: JsonArray;
	}> {
		return await this.obs.call("GetSceneList");
	}
	
	public async getAudioSources():Promise<{
		inputs: JsonArray;
	}> {
		const kinds = await this.getInputKindList();
		const audioKind = kinds.inputKinds.find(kind=>kind.indexOf("input_capture") > -1);
		return await this.obs.call("GetInputList", {inputKind:audioKind});
	}
	
	public async getInputKindList():Promise<{
		inputKinds: string[];
	}> {
		return await this.obs.call("GetInputKindList");
	}

	public async setMuteState(sourceName:string, mute:boolean):Promise<void> {
		return await this.obs.call("SetInputMute", {inputName:sourceName, inputMuted:mute});
	}
	
	
	
	/*******************
	* PRIVATE METHODS *
	*******************/
	private initialize():void {
		
	}
}

export interface OBSAudioSource {inputKind:string, inputName:string, unversionedInputKind:string}