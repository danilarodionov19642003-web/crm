# Supabase Auth passwordless verification route

Production GoTrue must use the canonical public Auth base:

```yaml
API_EXTERNAL_URL: https://api.mentori.tech/auth/v1
```

GoTrue v2.158 can still return `/verify` from `admin/generate_link` when nginx
strips `/auth/v1` before proxying the request. The Telegram bot normalizes all
new action links to `/auth/v1/verify`. Keep this exact nginx compatibility
route until the Auth image is upgraded and verified, so already issued links
remain usable:

```nginx
location = /verify {
    limit_req zone=mentori_password_login_v2 burst=9 nodelay;
    limit_req_status 429;
    error_page 429 = @mentori_auth_rate_limited;

    proxy_pass http://127.0.0.1:9999/verify;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 30s;
}
```

Always run `nginx -t` before reloading nginx. A valid verification request
returns `302` or `303` to the allow-listed client login URL with session tokens
in the URL fragment; nginx must not return its catch-all `404`.
