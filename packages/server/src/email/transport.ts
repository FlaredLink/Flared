// SPDX-License-Identifier: AGPL-3.0-only
export interface EmailContent {
	to: string;
	subject: string;
	text: string;
	html: string;
}
export interface EmailTransport {
	send(message: EmailContent): Promise<void>;
}
export interface EmailSender {
	send(message: EmailMessageBuilder): Promise<unknown>;
}
export class EmailDeliveryError extends Error {
	constructor() {
		super('Email delivery unavailable');
		this.name = 'EmailDeliveryError';
	}
}
export function createEmailTransport(
	binding: EmailSender,
	address: string,
	name?: string
): EmailTransport {
	if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address))
		throw new Error('Invalid email sender configuration');
	// The display name becomes a mail header, so reject anything that could break it.
	if (name !== undefined && !/^[\p{L}\p{N} .'-]{1,64}$/u.test(name))
		throw new Error('Invalid email sender name');
	const from = name === undefined ? address : { name, email: address };
	return {
		async send(message) {
			try {
				await binding.send({
					from,
					to: message.to,
					subject: message.subject,
					text: message.text,
					html: message.html
				});
			} catch {
				throw new EmailDeliveryError();
			}
		}
	};
}
