// SPDX-License-Identifier: AGPL-3.0-only
// What an account page may show about a passkey. Credential IDs and public keys stay on the server.
export interface PasskeySummary {
	id: string;
	name: string | null;
	createdAt: string | null;
	// True for a synced passkey that the provider backs up, false for one bound to a device.
	backedUp: boolean;
}

export interface PasskeyPage {
	passkeys: PasskeySummary[];
	// Adding or deleting a passkey needs a sign-in before this time; null when it has passed.
	freshUntil: string | null;
}

export const maxPasskeyNameLength = 64;

// Returns the trimmed name, or null when it is empty, too long, or holds control characters.
export function parsePasskeyName(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const name = value.trim();
	if (!name || name.length > maxPasskeyNameLength || /\p{Cc}/u.test(name)) return null;
	return name;
}
