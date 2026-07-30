begin;

-- Server-side account lockout for email/password authentication.
-- GoTrue calls this hook after checking the password for an existing user.
create table if not exists auth.password_login_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  window_started_at timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  last_attempt_at timestamptz not null default clock_timestamp()
);

alter table auth.password_login_attempts owner to postgres;
revoke all on table auth.password_login_attempts from public;

create or replace function auth.password_verification_hook(input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  lock_duration constant interval := interval '15 minutes';
  max_failures constant integer := 5;
  attempt_user_id uuid := nullif(input ->> 'user_id', '')::uuid;
  password_is_valid boolean := coalesce((input ->> 'valid')::boolean, false);
  attempt auth.password_login_attempts%rowtype;
  has_attempt boolean := false;
  attempted_at timestamptz := clock_timestamp();
begin
  if attempt_user_id is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  -- Serialize attempts for one account so parallel requests cannot bypass the counter.
  perform pg_advisory_xact_lock(hashtextextended(attempt_user_id::text, 0));

  select *
    into attempt
    from auth.password_login_attempts
   where user_id = attempt_user_id
   for update;
  has_attempt := found;

  if has_attempt and attempt.locked_until > attempted_at then
    update auth.password_login_attempts
       set last_attempt_at = attempted_at
     where user_id = attempt_user_id;
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 429,
        'message', 'Слишком много попыток входа. Повторите через 15 минут.'
      )
    );
  end if;

  if password_is_valid then
    delete from auth.password_login_attempts where user_id = attempt_user_id;
    return jsonb_build_object('decision', 'continue');
  end if;

  if not has_attempt
     or attempt.locked_until is not null
     or attempt.window_started_at <= attempted_at - lock_duration then
    insert into auth.password_login_attempts (
      user_id, failed_attempts, window_started_at, locked_until, last_attempt_at
    ) values (
      attempt_user_id, 1, attempted_at, null, attempted_at
    )
    on conflict (user_id) do update
      set failed_attempts = 1,
          window_started_at = excluded.window_started_at,
          locked_until = null,
          last_attempt_at = excluded.last_attempt_at
    returning * into attempt;
  else
    update auth.password_login_attempts
       set failed_attempts = failed_attempts + 1,
           locked_until = case
             when failed_attempts + 1 >= max_failures then attempted_at + lock_duration
             else null
           end,
           last_attempt_at = attempted_at
     where user_id = attempt_user_id
    returning * into attempt;
  end if;

  if attempt.failed_attempts >= max_failures then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 429,
        'message', 'Слишком много попыток входа. Повторите через 15 минут.'
      )
    );
  end if;

  return jsonb_build_object('decision', 'continue');
end;
$$;

alter function auth.password_verification_hook(jsonb) owner to postgres;
revoke all on function auth.password_verification_hook(jsonb) from public;
grant execute on function auth.password_verification_hook(jsonb) to supabase_auth_admin;

commit;
