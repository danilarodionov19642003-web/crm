# Telegram bot patches

`profi-clients-topic.patch` routes the automated owner morning digest to a
Telegram forum topic while keeping manager digests and client polls unchanged.

Apply from the bot repository root with zero-context support:

```bash
git apply --unidiff-zero /path/to/profi-clients-topic.patch
```

The production bot reads `PROFI_CLIENTS_CHAT_ID` and
`PROFI_CLIENTS_THREAD_ID` from its server-side environment file. If either is
missing, the digest falls back to the owner's private chat.
