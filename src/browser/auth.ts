import { browser } from 'wxt/browser';
import { APP_NAME } from '../config.js';
import { UserError } from '../core/errors.js';
import { base32, toBase64 } from '../core/ids.js';
import type { Account } from '../engine/app.js';
import { GoogleAuthError, type DriveAuth } from '../storage/gdrive.js';
import type { Engine } from './bookmarksPort.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

interface ClientConfig {
  clientId: string;
  /** Google requires it for web and desktop clients; it ships in the package and is not secret. */
  clientSecret: string;
}

function builtInClient(engine: Engine): ClientConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const clientId = engine === 'firefox' ? env.WXT_GOOGLE_CLIENT_ID_FIREFOX : env.WXT_GOOGLE_CLIENT_ID_CHROMIUM;
  const clientSecret = engine === 'firefox' ? env.WXT_GOOGLE_CLIENT_SECRET_FIREFOX : env.WXT_GOOGLE_CLIENT_SECRET_CHROMIUM;
  return clientId ? { clientId, clientSecret: clientSecret ?? '' } : null;
}

function client(engine: Engine): ClientConfig {
  const c = builtInClient(engine);
  if (!c) throw new UserError('Google Drive isn’t available in this version of the extension.');
  if (!c.clientSecret) throw new UserError('This version of the extension has a Google client ID but no client secret, so Google sign-in can’t work. See docs/google-setup.md.');
  return c;
}

export function googleAvailable(engine: Engine): boolean {
  return builtInClient(engine) !== null;
}

/** Chromium uses https://<id>.chromiumapp.org/; Firefox uses its loopback form, which Google accepts for desktop clients. */
function redirectUri(engine: Engine): string {
  const url = new URL(browser.identity.getRedirectURL());
  if (engine === 'firefox') return `http://127.0.0.1/mozoauth2/${url.hostname.split('.')[0]}`;
  return url.href;
}

function base64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  if (!res.ok) {
    const text = await res.text();
    throw new GoogleAuthError(`Google sign-in failed: ${res.status} ${text}`, oauthErrorCode(text));
  }
  return (await res.json()) as TokenResponse;
}

function oauthErrorCode(body: string): string | undefined {
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === 'string' ? error : undefined;
  } catch {
    return undefined;
  }
}

export function identityAvailable(): boolean {
  return typeof browser.identity?.launchWebAuthFlow === 'function';
}

export async function signInWithGoogle(engine: Engine): Promise<{ refreshToken: string; accessToken: string; expiresAt: number }> {
  if (!identityAvailable()) throw new UserError('This browser doesn’t let extensions sign in to Google. In Brave, turn on “Allow Google login for extensions” in Settings, Extensions, then try again.');
  const { clientId, clientSecret } = client(engine);
  const verifier = base32(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const redirect = redirectUri(engine);
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  }).toString();
  let result: string | undefined;
  try {
    result = await browser.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch {
    throw new UserError('The Google sign-in window was closed before it finished. Try again.');
  }
  const code = result ? new URL(result).searchParams.get('code') : null;
  if (!code) throw new UserError('Google didn’t give access to Drive. Try again, and choose Allow when Google asks.');
  const tokens = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier });
  if (!tokens.refresh_token) throw new UserError(`Google didn’t finish connecting. In your Google account, open Security, Third-party connections, remove ${APP_NAME}, then sign in again.`);
  return { refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
}

export function driveAuth(engine: Engine, account: Extract<Account, { type: 'gdrive' }>, onTokens: (a: Account) => Promise<void>): DriveAuth {
  let current = account;
  const refresh = async () => {
    const { clientId, clientSecret } = client(engine);
    const t = await tokenRequest({ refresh_token: current.refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' });
    current = { ...current, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    await onTokens(current);
    return t.access_token;
  };
  return {
    token: async () => (current.accessToken && (current.expiresAt ?? 0) > Date.now() + 60_000 ? current.accessToken : refresh()),
    refresh,
  };
}
