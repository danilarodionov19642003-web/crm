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

Apply from the bot repository root with zero-context support:

```bash
git apply --unidiff-zero /path/to/profi-clients-topic.patch
```

The production bot reads `PROFI_CLIENTS_CHAT_ID` and
`PROFI_CLIENTS_THREAD_ID` from its server-side environment file. If either is
missing, the digest falls back to the owner's private chat.
