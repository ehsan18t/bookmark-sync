/** Throws the message to show when a new passphrase and its repeat can't be used. */
export function checkNewPassphrase(pass: string, again: string): void {
  if (pass.length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  if (pass !== again) throw new Error('The passphrases don’t match.');
}
