// SPDX-License-Identifier: AGPL-3.0-only
// Passkeys are an extra way into an existing account. Every edition composes this plugin with
// its configured app origin, never a request header.
import { passkey } from '@better-auth/passkey';
import { APIError } from 'better-auth';

function notVerified(): never {
	throw APIError.fromStatus('BAD_REQUEST', {
		code: 'USER_NOT_VERIFIED',
		message: 'The authenticator did not verify the user'
	});
}

// 1.7.6 verifies both ceremonies with requireUserVerification: false. The hooks run before the
// passkey, counter, or session is written, so a credential without user verification is
// refused there.
export function createPasskeyPlugin(origin: string, rpName: string) {
	return passkey({
		rpID: new URL(origin).hostname,
		rpName,
		origin,
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
		registration: {
			requireSession: true,
			afterVerification({ verification }) {
				if (!verification.registrationInfo?.userVerified) notVerified();
			}
		},
		authentication: {
			afterVerification({ verification }) {
				if (!verification.authenticationInfo.userVerified) notVerified();
			}
		}
	});
}
