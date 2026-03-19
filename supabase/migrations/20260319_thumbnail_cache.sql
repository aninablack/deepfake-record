create table if not exists public.thumbnail_cache (
  article_url text primary key,
  resolved_url text,
  documented boolean not null default false,
  source text,
  quality_score integer not null default 0,
  status text not null default 'pending' check (status in ('accepted','rejected','fallback','pending')),
  note text,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists thumbnail_cache_checked_at_idx
  on public.thumbnail_cache (checked_at desc);

alter table public.thumbnail_cache enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='thumbnail_cache' and policyname='service_role_thumbnail_cache_all'
  ) then
    create policy service_role_thumbnail_cache_all
      on public.thumbnail_cache
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

grant select, insert, update, delete on public.thumbnail_cache to service_role;
