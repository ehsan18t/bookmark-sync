/** An error whose message is written for the person using the extension and can be shown as is. */
export class UserError extends Error {}

/** Another browser already links two syncs through a shared folder; the request can be repeated as a takeover. */
export class BridgeTakenError extends UserError {
  readonly code = 'bridge-taken';
}
