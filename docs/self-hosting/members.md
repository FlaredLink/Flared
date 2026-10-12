# Members

The owner can add people to the workspace. Each member signs in with their own username and password. Flared sends no email: the owner gives each person a link.

## Roles

- **Owner:** manages the members, the own domains, the workspace name, and the limits, and can delete the workspace. There is one owner.
- **Member:** creates and edits links, sees analytics, and uses API tokens and connected apps. A member cannot add or remove domains (a token of a member cannot hold `domains:write`).

## Invite a member

1. In **Settings → Members**, select **Create invite link**.
2. Copy the link and send it to the person through any channel. Flared shows the link only once.
3. The person opens the link, chooses a username and a password, and is signed in.

A link works once, for 7 days. Anyone who has the link can use it, so send it only to that person. An open invite takes a place: the member limit counts the owner, the members, and the open invites (see [limits.md](limits.md)). If a link is lost, cancel the invite and create another.

## Reset a member's password

1. In **Settings → Members**, select **Reset link** on the member's row. This needs a sign-in from the last 10 minutes.
2. Send the link to the member. It works once, for 24 hours. A new link replaces the earlier one.

The new password signs the member out on every device. Their API tokens and passkeys keep working; remove the member to end those. For the owner's own password, see [recovery.md](recovery.md).

## Remove a member, leave, or change the owner

- The owner removes a member on the member's row. Their API tokens, connected apps, and reset link for this workspace end at once.
- A member leaves in **Settings → Members**.
- The owner can make a member the owner with **Make owner…**. The member accepts on the same page, and the previous owner stays as a member.
- The owner cannot delete their account while the workspace has members.

Each change is recorded with the user IDs, without passwords or tokens, for 90 days.
