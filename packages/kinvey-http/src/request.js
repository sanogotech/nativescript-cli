import isNumber from 'lodash/isNumber';
import { KinveyError, InvalidCredentialsError } from 'kinvey-errors';
import { getConfig } from 'kinvey-app';
import { get as getSession, set as setSession, remove as removeSession } from 'kinvey-session';
import { clear } from 'kinvey-cache';
import PQueue from 'promise-queue';
import { Base64 } from 'js-base64';
import { Headers, KinveyHeaders } from './headers';
import { serialize, formatKinveyUrl } from './utils';
import { Response } from './response';
import { app, master, session as sessionAuth, basic, defaultAuth, all, Auth } from './auth';

const REQUEST_QUEUE = new PQueue();
let refreshTokenRequestInProgress = false;

const AUTHORIZATION_HEADER = 'Authorization';
export const RequestMethod = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE'
};

let http = async () => {
  throw new Error('You must override the default http function.');
};

const KINVEY_DEVICE_INFORMATION_HEADER = 'X-Kinvey-Device-Information';
let deviceInformation;
const KINVEY_DEVICE_INFO_HEADER = 'X-Kinvey-Device-Info';
let deviceInfo;

export function register(httpAdapter, sdkDeviceInformation, sdkDeviceInfo) {
  http = httpAdapter;
  deviceInformation = sdkDeviceInformation;
  deviceInfo = sdkDeviceInfo;
}

export class Request {
  constructor(request = {}) {
    const {
      headers,
      method,
      url,
      body,
      timeout
    } = request;

    this.headers = headers;
    this.method = method;
    this.url = url;
    this.body = body;
    this.timeout = timeout;
  }

  get headers() {
    return this._headers;
  }

  set headers(headers) {
    this._headers = new Headers(headers);
  }

  get timeout() {
    return this._timeout;
  }

  set timeout(timeout) {
    const { defaultTimeout } = getConfig();
    const requestTimeout = typeof timeout === 'undefined' || timeout === null ? defaultTimeout : timeout;

    if (!isNumber(requestTimeout) || isNaN(requestTimeout)) {
      throw new KinveyError('Invalid timeout. Timeout must be a number.');
    }

    this._timeout = requestTimeout;
  }

  async execute() {
    // Make http request
    const responseObject = await http({
      headers: this.headers.toObject(),
      method: this.method,
      url: this.url,
      body: serialize(this.headers.contentType, this.body),
      timeout: this.timeout
    });

    // Create a response
    const response = new Response({
      statusCode: responseObject.statusCode,
      headers: responseObject.headers,
      data: responseObject.data
    });

    // Return the response if it was successful
    if (response.isSuccess()) {
      return response;
    }

    // Else throw the error
    throw response.error;
  }
}

function isRefreshTokenRequestInProgress() {
  return refreshTokenRequestInProgress === true;
}

export class KinveyRequest extends Request {
  constructor(request) {
    super(request);
    this.headers = request.headers;
    this.auth = request.auth;
  }

  get headers() {
    return this._headers;
  }

  set headers(headers) {
    this._headers = new KinveyHeaders(headers);
  }

  get authorizationHeader() {
    const { appKey, appSecret, masterSecret } = getConfig();
    const session = getSession();

    if (this.auth === Auth.App) {
      return app(appKey, appSecret);
    } else if (this.auth === Auth.Master) {
      return master(appKey, masterSecret);
    } else if (this.auth === Auth.Session) {
      return sessionAuth(session);
    } else if (this.auth === Auth.Basic) {
      return basic(appKey, appSecret, masterSecret);
    } else if (this.auth === Auth.Default) {
      return defaultAuth(session, appKey, masterSecret);
    } else if (this.auth === Auth.All) {
      return all(session, appKey, appSecret, masterSecret);
    }

    return null;
  }

  async execute(retry = true) {
    try {
      // Add the X-Kinvey-Device-Information header
      if (deviceInformation) {
        this.headers.set(KINVEY_DEVICE_INFORMATION_HEADER, deviceInformation);
      }

      // Add the X-Kinvey-Device-Info header
      if (deviceInfo) {
        this.headers.set(KINVEY_DEVICE_INFO_HEADER, JSON.stringify(deviceInfo));
      }

      // Set the authorization header
      if (this.auth) {
        this.headers.set(AUTHORIZATION_HEADER, this.authorizationHeader);
      }

      // Execute the request
      const response = await super.execute();
      return response;
    } catch (error) {
      if (retry) {
        // Received an InvalidCredentialsError
        if (error instanceof InvalidCredentialsError) {
          // Queue the request if a refresh token request is in progress
          if (isRefreshTokenRequestInProgress()) {
            return REQUEST_QUEUE.add(() => this.execute(false).catch(() => Promise.reject(error)));
          }

          const { appKey, appSecret, auth, api } = getConfig();
          const activeSession = getSession();
          const socialIdentity = (activeSession && activeSession._socialIdentity) || {};
          const micIdentityKey = Object.keys(socialIdentity)
            .find(sessionKey => socialIdentity[sessionKey].identity === 'kinveyAuth');
          const micIdentity = socialIdentity[micIdentityKey];

          if (micIdentity && micIdentity.refresh_token && micIdentity.redirect_uri) {
            try {
              // Pause the request queue
              REQUEST_QUEUE.pause();
              refreshTokenRequestInProgress = true;

              // Refresh the session
              const refreshRequest = new KinveyRequest({
                method: RequestMethod.POST,
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: () => {
                    const credentials = Base64.encode(`${micIdentity.client_id}:${appSecret}`);
                    return `Basic ${credentials}`;
                  }
                },
                url: formatKinveyUrl(auth.protocol, auth.host, '/oauth/token'),
                body: {
                  grant_type: 'refresh_token',
                  client_id: micIdentity.client_id,
                  redirect_uri: micIdentity.redirect_uri,
                  refresh_token: micIdentity.refresh_token
                }
              });
              const refreshResponse = await refreshRequest.execute();

              // Create a new session
              const newMicIdentity = Object.assign({}, refreshResponse.data, {
                client_id: micIdentity.client_id,
                redirect_uri: micIdentity.redirect_uri,
                protocol: auth.protocol,
                host: auth.host
              });

              // Login the new MIC identity
              const loginRequest = new KinveyRequest({
                method: RequestMethod.POST,
                auth: Auth.App,
                url: formatKinveyUrl(api.protocol, api.host, `/user/${appKey}/login`),
                properties: this.properties,
                body: {
                  _socialIdentity: {
                    [micIdentityKey]: newMicIdentity
                  }
                }
              });
              const loginResponse = await loginRequest.execute();
              const newSession = loginResponse.data;
              newSession._socialIdentity[micIdentityKey] = Object.assign({}, newSession._socialIdentity[micIdentityKey], newMicIdentity);

              // Set the new session
              setSession(newSession);

              // Redo the original request
              const response = await this.execute(false);

              // Start the request queue
              refreshTokenRequestInProgress = false;
              REQUEST_QUEUE.start();

              // Return the response
              return response;
            } catch (error) {
              // TODO: Log error
            }
          }

          try {
            // TODO: Unregister from live service

            // Logout
            const url = formatKinveyUrl(api.protocol, api.host, `/user/${appKey}/_logout`);
            const request = new KinveyRequest({
              method: RequestMethod.POST,
              auth: Auth.Session,
              url
            });
            await request.execute(false);

            // Remove the session
            removeSession();

            // Clear data
            clear(appKey);
          } catch (error) {
            // TODO: Log error
          }
        }

        // Start the request queue
        refreshTokenRequestInProgress = false;
        REQUEST_QUEUE.start();
      }

      // Throw the error
      throw error;
    }
  }
}
