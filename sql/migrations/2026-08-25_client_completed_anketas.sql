-- Add the existing CRM client.closed flag to already-built client snapshots.
-- Future snapshots receive the same field from Store._buildAnketaSnapshot().

begin;

with state as (
  select data
  from public.crm_state
  where id = 'main'
), refreshed as (
  select
    snapshot.email,
    jsonb_set(
      snapshot.payload,
      '{anketas}',
      coalesce((
        select jsonb_agg(
          anketa || jsonb_build_object(
            'closed', coalesce((
              select (client_item ->> 'closed')::boolean
              from state,
                   jsonb_array_elements(coalesce(state.data -> 'clients', '[]'::jsonb)) client_item
              where replace(lower(client_item ->> 'code'), '-', '')
                    = replace(lower(anketa ->> 'code'), '-', '')
              limit 1
            ), false)
          )
        )
        from jsonb_array_elements(coalesce(snapshot.payload -> 'anketas', '[]'::jsonb)) anketa
      ), '[]'::jsonb),
      false
    ) as payload
  from public.client_snapshots snapshot
)
update public.client_snapshots snapshot
set payload = refreshed.payload,
    updated_at = clock_timestamp()
from refreshed
where lower(snapshot.email) = lower(refreshed.email);

commit;
