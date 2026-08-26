-- Tie each text approval to the exact account used for the CRM review.
-- Keep the five-argument function for cached CRM pages; new pages call the
-- six-argument overload and persist source_profile_id atomically.

begin;

alter table public.client_text_approval_requests
  add column if not exists source_profile_id text;

create index if not exists client_text_approvals_profile_idx
  on public.client_text_approval_requests (mentor_id, source_profile_id, created_at desc)
  where source_profile_id is not null;

create or replace function public.create_review_text_approval(
  p_portal_email text,
  p_mentor_id text,
  p_source_review_id text,
  p_title text,
  p_body text,
  p_source_profile_id text
)
returns public.client_text_approval_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id text := nullif(btrim(coalesce(p_source_profile_id, '')), '');
  v_request public.client_text_approval_requests;
begin
  if length(coalesce(v_profile_id, '')) > 200 then
    raise exception 'SOURCE_PROFILE_ID_TOO_LONG' using errcode = '22023';
  end if;

  select * into v_request
  from public.create_review_text_approval(
    p_portal_email,
    p_mentor_id,
    p_source_review_id,
    p_title,
    p_body
  );

  if v_request.id is not null
     and v_request.source_profile_id is distinct from v_profile_id then
    update public.client_text_approval_requests
    set source_profile_id = v_profile_id,
        updated_at = now()
    where id = v_request.id
    returning * into v_request;
  end if;

  return v_request;
end;
$$;

revoke all on function public.create_review_text_approval(text, text, text, text, text, text)
  from public, anon;
grant execute on function public.create_review_text_approval(text, text, text, text, text, text)
  to authenticated;

notify pgrst, 'reload schema';

commit;
