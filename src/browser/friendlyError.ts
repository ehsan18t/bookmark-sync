import { WrongPassphraseError } from '../core/crypto.js';
import { LockedError } from '../core/codec.js';
import { UserError } from '../core/errors.js';
import { PermissionMissingError } from '../engine/ports.js';
import { ProviderAuthError, ProviderError } from '../storage/webdav.js';

/** Turns any error into one sentence a person can act on; the raw error goes to the console for diagnostics. */
export function friendlyError(e: unknown): string {
  if (e instanceof UserError) return e.message;
  console.error(e);
  if (e instanceof WrongPassphraseError) return 'That passphrase isn’t right. Check it and try again.';
  if (e instanceof LockedError) return 'This sync is encrypted. Enter its passphrase first.';
  if (e instanceof ProviderAuthError) return 'The storage didn’t accept the sign-in. Check the username and password, or sign in again.';
  if (e instanceof PermissionMissingError) return 'The extension needs permission to reach this storage. Allow access when the browser asks.';
  if (e instanceof ProviderError) {
    if (e.status === 404 || e.status === 409) return 'That folder wasn’t found on the server. Check the address, including the folder path.';
    if (e.status === 405 || e.status === 501) return 'That address doesn’t accept WebDAV. Check that it points to the WebDAV folder, not the website.';
    if (e.status === 507) return 'The storage is full. Free up space, then try again.';
    if (e.status === 429) return 'The storage is busy. Try again in a minute.';
    if (e.status >= 500) return 'The storage had a problem on its side. Try again in a few minutes.';
    return 'The storage refused the request. Check the address and your access, then try again.';
  }
  if (e instanceof TypeError && /fetch|network/i.test(e.message)) return 'Couldn’t reach the storage. Check the address and your internet connection.';
  return 'Something went wrong. Try again, and if it keeps happening, export diagnostics from Settings.';
}
