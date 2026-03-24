create extension if not exists pg_trgm;

create or replace function public.dedupe_similar_incidents()
returns integer
language plpgsql
security definer
as $$
declare
  deleted_count integer := 0;
begin
  with doomed as (
    select a.id
    from public.incidents a
    join public.incidents b
      on a.id > b.id
     and a.category = b.category
     and date_trunc('day', a.published_at) = date_trunc('day', b.published_at)
     and similarity(coalesce(a.title, ''), coalesce(b.title, '')) > 0.6
  ),
  deleted as (
    delete from public.incidents
    where id in (select id from doomed)
    returning id
  )
  select count(*) into deleted_count from deleted;

  return deleted_count;
end;
$$;

grant execute on function public.dedupe_similar_incidents() to anon, authenticated, service_role;
