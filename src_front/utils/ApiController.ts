import StoreProxy from "@/store/StoreProxy";
import type { UluleTypes } from "@/types/UluleTypes";
import type { TwitchDataTypes } from "@/types/twitch/TwitchDataTypes";
import type { ServerConfig } from "./Config";
import Config from "./Config";
import type { PatreonData } from "./patreon/PatreonDataTypes";
import type { TenorGif } from "@/types/TenorDataTypes";
import Utils from "./Utils";
import type { YoutubeAuthToken } from "@/types/youtube/YoutubeDataTypes";

/**
* Created : 13/07/2023 
*/
export default class ApiController {
	
	constructor() {
	}
	
	/********************
	* GETTER / SETTERS *
	********************/
	
	
	
	/******************
	* PUBLIC METHODS *
	******************/
	/**
	 * Calle a twitchat api endpoint
	 * @param endpoint 
	 * @param data 
	 * @param method 
	 */
	public static async call<U extends keyof ApiEndpoints, M extends HttpMethod = "GET">(endpoint:U, method?:M, data?:any, retryOnFail:boolean = true, attemptIndex:number = 0):Promise<{status:number, json:ApiResponse<ApiEndpoints, U, M>}> {
		const url = new URL(Config.instance.API_PATH+"/"+endpoint);
		const headers:{[key:string]:string} = {
			"Content-Type": "application/json",
			'App-Version': import.meta.env.PACKAGE_VERSION,
		};
		if(StoreProxy.auth.twitch.access_token) {
			headers.Authorization = "Bearer "+StoreProxy.auth.twitch.access_token;
		}
		const options:RequestInit = {
			method: method || "GET",
			headers,
		}
		if(data) {
			if(method === "POST") {
				options.body = JSON.stringify(data);
			}else{
				for (const key in data) {
					url.searchParams.append(key, data[key]);
				}
			}
		}
		const res = await fetch(url, options);
		let json:any = {};
		try {
			json = await res.json();
		}catch(error) {}
		if(res.status == 429) {
			if(json.errorCode == "RATE_LIMIT_BAN") {
				StoreProxy.main.alert( StoreProxy.i18n.t("error.rate_limit_ban", {MAIL:Config.instance.CONTACT_MAIL}), true );
			}else{
				StoreProxy.main.alert( StoreProxy.i18n.t("error.rate_limit") );
			}
		}else
		if(retryOnFail && res.status != 200 && res.status != 204 && attemptIndex < 5 && res.status != 401) {
			await Utils.promisedTimeout(1000);
			return this.call(endpoint, method, data, retryOnFail, attemptIndex+1);
		}
		return {status:res.status, json};
	}
	
	
	
	/*******************
	* PRIVATE METHODS *
	*******************/
}


type ApiResponse<Endpoints, U extends keyof Endpoints, M extends HttpMethod> =
  U extends keyof Endpoints
    ? M extends keyof Endpoints[U]
      ? Endpoints[U][M]
      : never
    : never;

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

type ApiEndpoints =  {
	"auth/twitch": {
		GET: {
			access_token: string;
			expires_in: number;
			refresh_token: string;
			scope: string[];
			token_type: string;
			expires_at: number;
		},
	},
	"auth/CSRFToken": {
		GET: {
			token:string,
		},
		POST: {
			success:boolean,
			message?:string,
		},
	},
	"auth/twitch/refreshtoken": {
		GET: {
			access_token: string;
			expires_in: number;
			refresh_token: string;
			scope: string[];
			token_type: string;
			expires_at: number;
		},
	},
	"beta/user": {
		GET: {
			success:true,
			data:{beta:boolean},
		},
	},
	"beta/user/hasData": {
		GET: {
			success:boolean,
			message?:string,
			data?:{
				betaDate?: number;
				prodDate?: number;
				betaVersion?: number;
				prodVersion?: number;
			}
		}
	},
	"beta/user/migrateToProduction": {
		POST: { success:boolean },
	},
	"admin/beta/user": {
		POST: {
			success:true,
			userList:string[],
		},
		DELETE: {
			success:true,
			userList:string[],
		},
	},
	"admin/beta/user/migrateToProduction": {
		POST: { success:boolean },
	},
	"admin/beta/user/all": {
		DELETE: {
			success:true,
			userList:string[],
		},
	},
	"user/donor/all": {
		GET: {
			success:true,
			data:{
				list:{
					uid: string;
					v: number;
				}[]
			},
		},
	},
	"user/donor/anon": {
		GET: {
			success:true,
			data:{
				public:boolean
			},
		},
		POST: {
			success:true,
			message?:string,
		},
	},
	"script": {
		GET: string,
	},
	"configs": {
		GET: ServerConfig,
	},
	"spotify/auth": {
		GET: {},
	},
	"spotify/refresh_token": {
		GET: {},
	},
	"ulule/project" : {
		GET: UluleTypes.Project,
	},
	"user": {
		GET: {
			success:boolean,
			data:{
				isAdmin:boolean,
				isDonor:boolean,
				isEarlyDonor:boolean,
				isPremiumDonor:boolean,
				level:number,
			}
		},
		POST: {},
	},
	"user/all": {
		GET: {
			success:boolean, 
			message:string, 
			users:{
				id:string, 
				date:number, 
				user:TwitchDataTypes.UserInfo
			}[],
		},
	},
	"user/data": {
		GET: {
			success:boolean,
			data:any,
		},
		POST: {
			success:boolean,
			message?:string,
		},
		DELETE: {
			success:boolean,
		},
	},
	"patreon/authenticate": {
		POST: {
			success:boolean,
			message?:string,
			data: {
				access_token: string,
				expires_in: number,
				token_type: string,
				scope: string,
				refresh_token: string,
				version: string,
				expires_at: number,
			}
		}
	},
	"patreon/refresh_token": {
		POST: {
			success:boolean,
			message?:string,
			data: {
				access_token: string,
				refresh_token: string,
				expires_in: number,
				scope: string,
				token_type: string,
				expires_at: number,
			}
		}
	},
	"patreon/isMember": {
		GET: {
			success:boolean,
			message?:string,
			data: {isMember:boolean},
		}
	},
	"patreon/isApiDown": {
		GET: {
			success:boolean,
			message?:string,
			data: {isDown:boolean},
		}
	},
	"tenor/search": {
		GET: {
			success:boolean,
			message?:string,
			data: TenorGif[],
		}
	},
	"paypal/create_order": {
		POST: {
			success:boolean,
			error?:string;
			data: {orderId:string},
		}
	},
	"paypal/complete_order": {
		POST: {
			success:boolean,
			error?:string;
			errorCode?:string;
			data: {orderId:string},
		}
	},
	"google/translate": {
		GET: {
			success:boolean,
			error?:string;
			errorCode?:string;
			data:{translation?:string},
		}
	},
	"youtube/oauthURL": {
		GET: {
			success:boolean,
			error?:string;
			errorCode?:string;
			data:{url?:string},
		}
	},
	"youtube/authenticate": {
		POST: {
			success:boolean,
			error?:string;
			errorCode?:string;
			data:{token?:YoutubeAuthToken},
		}
	},
	"youtube/refreshtoken": {
		POST: {
			success:boolean,
			error?:string;
			errorCode?:string;
			data:{token?:YoutubeAuthToken},
		}
	},
}