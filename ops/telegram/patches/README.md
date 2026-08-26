# Telegram bot patches

`profi-clients-topic.patch` routes the automated owner morning digest to a
Telegram forum topic while keeping manager digests and client polls unchanged.

`client-publication-approval.patch` adds inline Telegram buttons for approving
or rejecting a publication date selected in a client cabinet. It calls the
atomic CRM RPC and never writes the CRM blob directly.

`bot-notification-only.patch` removes the mailing-software dashboard buttons,
commands, Telegram Business auto-replies, and the periodic campaign report from
this bot. Apply it after `client-publication-approval.patch`. Client requests,
channel post delivery, the CRM schedule, payment actions, and system
notifications remain enabled.

`client-telegram-team.patch` adds secure one-time cabinet linking for multiple
Telegram contacts, status/schedule fan-out and the review-text approval dialog.
The bot resolves contacts through dedicated RPCs and remains read-only for
`crm_state`.

`client-referrals.patch` handles personal `ref_` links, records the first
Telegram attribution, and credits one separate zero-value review only after the
invitee's first paid order is confirmed. Apply it after
`client-telegram-team.patch`.

`client-notification-upgrades.patch` changes new text-approval messages to the
two direct actions approve or cancel, and adds a short-lived Telegram Mini App
calendar button to client notifications. Apply it after
`client-telegram-team.patch`.

`client-calendar-menu.patch` makes that Mini App discoverable without waiting
for a notification: linked clients get a persistent reply-keyboard button, a
fresh calendar button after `/start`, and the `/calendar` command. Every open
still issues a new short-lived token. Apply it after
`client-notification-upgrades.patch`.

`client-visual-cabinet.patch` turns the calendar into the entry point for the
compact visual cabinet, keeps `/calendar` focused on the calendar tab, and adds
branded welcome photos plus real anketa avatars to the bot dialog. Apply it
after `client-calendar-menu.patch`.

`client-direct-menu-app.patch` replaces the per-client Telegram command menu
button with a direct `Кабинет` Mini App button. Existing linked clients are
backfilled on bot start, and newly linked clients get it immediately. It uses a
separate revocable menu credential whose raw value stays in the URL fragment.
Apply it after `client-visual-cabinet.patch`.

`client-miniapp-only-subscription.patch` removes client cabinet, anketa,
schedule and approval actions from the bot chat. The reply keyboard keeps only
`Написать менеджеру`; future notifications are informational. Mini App access
is reconciled against the live `@Mento_ri` membership on start and on channel
join/leave events. Apply it after `client-direct-menu-app.patch` and the
`2026-08-27_client_telegram_channel_gate.sql` migration.

`client-text-approval-actions.patch` restores only the two direct actions under
a review-text notification: confirm or reject. It also reformats the message
into clearly separated anketa, account, review and action sections. Other bot
navigation stays disabled. Apply it after `client-miniapp-only-subscription.patch`.

`client-passwordless-login-settings.patch` adds a secure one-time full-cabinet
login button and four per-contact notification switches to the client bot
keyboard. It generates a Supabase magic link only after an exact linked
Telegram user/chat and channel-membership check; no password is read or sent.
For self-hosted GoTrue v2.158 it also restores the public `/auth/v1/verify`
prefix that `admin/generate_link` can drop behind a path-stripping proxy.
Apply it after `client-text-approval-actions.patch` and the
`2026-08-27_client_telegram_passwordless_login_and_bot_settings.sql` migration.

Apply from the bot repository root with zero-context support:

```bash
git apply --unidiff-zero /path/to/profi-clients-topic.patch
```

The production bot reads `PROFI_CLIENTS_CHAT_ID` and
`PROFI_CLIENTS_THREAD_ID` from its server-side environment file. If either is
missing, the digest falls back to the owner's private chat.
