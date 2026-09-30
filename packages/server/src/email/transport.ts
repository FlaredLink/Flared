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
export function createEmailTransport(binding: EmailSender, from: string): EmailTransport {
	if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from))
		throw new Error('Invalid email sender configuration');
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
