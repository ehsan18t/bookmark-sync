/** Go-live values from .env, so they can all be changed in one place. */
const env = import.meta.env as Record<string, string | undefined>;
const value = (name: string) => env[name]?.trim() ?? '';

export const APP_NAME = value('WXT_APP_NAME');
export const SERVER_FOLDER = value('WXT_SERVER_FOLDER');
export const HOMEPAGE_URL = value('WXT_HOMEPAGE_URL');
export const PRIVACY_URL = value('WXT_PRIVACY_URL');
export const SUPPORT_EMAIL = value('WXT_SUPPORT_EMAIL');
