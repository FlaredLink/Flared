<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
	import Button from '@flared/ui/atoms/Button.svelte';
	import { utcDay } from '@flared/contracts/analytics';
	import Checkbox from '@flared/ui/atoms/Checkbox.svelte';
	import AuthFrame from '$lib/components/AuthFrame.svelte';
	import { postJson } from '$lib/auth-client';
	import { appRoutes } from '$lib/routes';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// form → wizard after setup. The wizard confirms the host, creates the first link, and waits
	// for its first click to count.
	let stage = $state<'form' | 'wizard'>('form');
	let secret = $state('');
	let username = $state('');
	let password = $state('');
	let repeat = $state('');
	let workspaceName = $state('');
	let pending = $state(false);
	let error = $state('');

	const setupMessages: Record<string, string> = {
		SETUP_SECRET_INVALID:
			'The setup secret is not correct. If you lost it, set a new SETUP_SECRET in the Cloudflare dashboard (steps above) and enter the new value.',
		RATE_LIMITED: 'Too many attempts. Wait 15 minutes and try again.',
		SETUP_CLAIMED:
			'Setup has already started with another username or password. Use the ones you entered first.',
		SETUP_CLOSED: 'This installation is already set up. Sign in instead.',
		SETUP_UNAVAILABLE:
			'Setup is not available. Check that SETUP_SECRET has at least 16 characters and differs from AUTH_SECRET, then try again. The Worker log names the problem.',
		INVALID_REQUEST:
			'Check the fields: a username of 3 to 30 letters, digits, dots, or underscores, a password of 12 to 128 characters, and a workspace name.',
		INVALID_ORIGIN: 'Open this page at the app address and try again.'
	};

	async function submit() {
		error = '';
		if (password !== repeat) {
			error = 'The passwords do not match.';
			return;
		}
		pending = true;
		const result = await postJson('/api/setup', {
			secret,
			username: username.trim(),
			password,
			workspaceName: workspaceName.trim()
		});
		pending = false;
		if (!result.ok) {
			error = setupMessages[result.code] ?? 'Setup did not finish. Try again with the same values.';
			return;
		}
		secret = '';
		password = '';
		repeat = '';
		stage = 'wizard';
	}

	// The wizard. It asks once about update checks; they stay off unless the owner turns them on.
	let checkUpdates = $state(false);
	let updatesPending = $state(false);
	let updatesError = $state('');

	async function changeUpdates() {
		const enabled = checkUpdates;
		updatesPending = true;
		updatesError = '';
		const result = await postJson('/api/settings/updates', { enabled });
		updatesPending = false;
		if (!result.ok) {
			checkUpdates = !enabled;
			updatesError = 'We could not save your choice. You can change it later in Settings.';
		}
	}

	let destination = $state('');
	let link = $state<{ id: string; shortUrl: string } | null>(null);
	let linkError = $state('');
	let counting = $state<'idle' | 'waiting' | 'counted' | 'timeout'>('idle');
	const idempotencyKey = crypto.randomUUID();

	async function createFirstLink() {
		linkError = '';
		pending = true;
		try {
			const response = await fetch('/api/v1/links', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
				body: JSON.stringify({ destination: destination.trim() })
			});
			const body: unknown = await response.json().catch(() => null);
			const created =
				typeof body === 'object' && body !== null && 'link' in body ? body.link : null;
			if (
				response.status === 201 &&
				typeof created === 'object' &&
				created !== null &&
				'id' in created &&
				typeof created.id === 'string' &&
				'shortUrl' in created &&
				typeof created.shortUrl === 'string'
			)
				link = { id: created.id, shortUrl: created.shortUrl };
			else linkError = 'We could not create the link. Check the address and try again.';
		} catch {
			linkError = 'We could not reach the app. Try again.';
		} finally {
			pending = false;
		}
	}

	async function clicks(id: string): Promise<number | null> {
		const day = utcDay(Date.now());
		const response = await fetch(
			`/api/v1/links/${encodeURIComponent(id)}/analytics?from=${day}&to=${day}`,
			{ credentials: 'same-origin' }
		).catch(() => null);
		if (!response?.ok) return null;
		const body: unknown = await response.json().catch(() => null);
		const analytics =
			typeof body === 'object' && body !== null && 'analytics' in body ? body.analytics : null;
		return typeof analytics === 'object' &&
			analytics !== null &&
			'total' in analytics &&
			typeof analytics.total === 'number'
			? analytics.total
			: null;
	}

	// The click goes through the Queue, so it counts a few seconds after the visit.
	async function waitForClick() {
		if (!link) return;
		counting = 'waiting';
		for (let attempt = 0; attempt < 40; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 3000));
			const total = await clicks(link.id);
			if (total !== null && total > 0) {
				counting = 'counted';
				return;
			}
		}
		counting = 'timeout';
	}
</script>

<svelte:head><title>Set up Flared</title></svelte:head>

<AuthFrame>
	{#if stage === 'wizard'}
		<section class="card wizard" aria-labelledby="wizard-heading" aria-live="polite">
			<p class="eyebrow">Flared is ready</p>
			<h1 id="wizard-heading">Create your first link</h1>
			<ol>
				<li>
					<h2>Your address</h2>
					<p>
						The app and your short links use <strong>{data.host}</strong>. You can add your own
						domain later in Domains.
					</p>
				</li>
				<li>
					<h2>Updates</h2>
					<Checkbox
						bind:checked={checkUpdates}
						disabled={updatesPending}
						onchange={() => void changeUpdates()}
						hint="Once a day, the app asks flared.page for the latest release and tells you when a new one is out. The request sends no data about this installation. You can change this in Settings."
						>Check for updates</Checkbox
					>
					{#if updatesError}<p class="error" role="alert">{updatesError}</p>{/if}
				</li>
				<li>
					<h2>A first link</h2>
					{#if link}
						<p>Your link is <strong>{link.shortUrl}</strong>.</p>
					{:else}
						<form
							class="field"
							onsubmit={(event) => {
								event.preventDefault();
								void createFirstLink();
							}}
						>
							<label for="destination">Where the link goes</label>
							<input
								id="destination"
								type="url"
								bind:value={destination}
								required
								placeholder="https://example.com/page"
							/>
							<Button variant="primary" type="submit" disabled={pending}
								>{pending ? 'Creating…' : 'Create link'}</Button
							>
							{#if linkError}<p class="error" role="alert">{linkError}</p>{/if}
						</form>
					{/if}
				</li>
				{#if link}
					<li>
						<h2>A first click</h2>
						{#if counting === 'counted'}
							<p>Your click was counted. Redirects and analytics work.</p>
						{:else if counting === 'timeout'}
							<p>
								No click was counted yet. The scheduled jobs and the click Queue may still be
								starting; check the link's clicks in a few minutes.
							</p>
						{:else}
							<p>Open the link once. It counts as a real click.</p>
							<div class="open">
								<Button
									variant="secondary"
									href={link.shortUrl}
									target="_blank"
									rel="noopener"
									onclick={() => void waitForClick()}>Open {link.shortUrl}</Button
								>
							</div>
							{#if counting === 'waiting'}<p>Waiting for the click to count…</p>{/if}
						{/if}
					</li>
				{/if}
			</ol>
			<Button variant="primary" href={appRoutes.app}>Go to your links</Button>
		</section>
	{:else if data.state === 'active'}
		<section class="card" aria-labelledby="done-heading">
			<p class="eyebrow">Flared</p>
			<h1 id="done-heading">This installation is set up</h1>
			<p>Sign in with the owner’s username and password. Setup never opens again.</p>
			<Button variant="primary" href={appRoutes.login}>Sign in</Button>
		</section>
	{:else if data.state === 'misconfigured'}
		<section class="card" aria-labelledby="misconfigured-heading">
			<h1 id="misconfigured-heading">Setup is not available</h1>
			<p>The identity database of this Worker belongs to another kind of installation.</p>
		</section>
	{:else}
		<section class="card" aria-labelledby="setup-heading">
			<p class="eyebrow">Set up Flared</p>
			<h1 id="setup-heading">Create the owner</h1>
			<p>
				Enter the setup secret (<code>SETUP_SECRET</code>) you chose when you deployed. It proves
				this deployment is yours. This address becomes the app address.
				{#if data.state === 'initializing'}Setup started before; enter the same username and
					password to finish it.{/if}
			</p>
			<p>
				Lost it? Cloudflare never shows a secret again, so set a new one: in the Cloudflare
				dashboard, open <strong>Workers &amp; Pages</strong>, select this Flared Worker, then
				<strong>Settings → Variables and Secrets</strong>. Edit <code>SETUP_SECRET</code>, save and
				deploy, then enter the new value here.
			</p>
			<form
				onsubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div class="field">
					<label for="secret">Setup secret</label>
					<input id="secret" type="password" bind:value={secret} required autocomplete="off" />
				</div>
				<div class="field">
					<label for="username">Username</label>
					<input
						id="username"
						bind:value={username}
						required
						minlength="3"
						maxlength="30"
						pattern="[A-Za-z0-9_.]+"
						autocomplete="username"
						autocapitalize="none"
						spellcheck="false"
					/>
					<small>3 to 30 letters, digits, dots, or underscores.</small>
				</div>
				<div class="field">
					<label for="password">Password</label>
					<input
						id="password"
						type="password"
						bind:value={password}
						required
						minlength="12"
						maxlength="128"
						autocomplete="new-password"
					/>
					<small
						>At least 12 characters. Without email, only the Cloudflare account can reset it.</small
					>
				</div>
				<div class="field">
					<label for="repeat">Password again</label>
					<input
						id="repeat"
						type="password"
						bind:value={repeat}
						required
						autocomplete="new-password"
					/>
				</div>
				<div class="field">
					<label for="workspace">Workspace name</label>
					<input id="workspace" bind:value={workspaceName} required maxlength="64" />
				</div>
				{#if error}<p class="error" role="alert">{error}</p>{/if}
				<Button variant="primary" wide type="submit" disabled={pending}
					>{pending ? 'Setting up…' : 'Set up Flared'}</Button
				>
			</form>
		</section>
	{/if}
</AuthFrame>

<style>
	form {
		display: grid;
		gap: 1rem;
	}
	.wizard ol {
		display: grid;
		gap: 1.25rem;
		margin: 0;
		padding-left: 1.25rem;
	}
	.wizard h2 {
		font-size: 1rem;
		margin-bottom: 0.3rem;
	}
	.open {
		margin-top: 0.5rem;
	}
	code {
		font-family: var(--font-mono);
		font-size: 0.85em;
	}
</style>
