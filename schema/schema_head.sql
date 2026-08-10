-- ============================================================
-- BLITZ draft room — complete schema. Paste this WHOLE file into
-- Supabase SQL Editor and click RUN. Idempotent: safe to re-run.
-- ============================================================

-- ---------- tables ----------
create table if not exists players (
  id   text primary key,
  name text not null,
  team text,
  pos  text not null,
  bye  int,
  ppr  numeric,
  half numeric,
  std  numeric,
  adp  numeric
);

create table if not exists leagues (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  join_code        text not null unique,
  commissioner_uid uuid not null,
  num_teams        int  not null check (num_teams between 2 and 16),
  rounds           int  not null check (rounds between 4 and 25),
  scoring          text not null default 'ppr' check (scoring in ('ppr','half','std')),
  pick_seconds     int  not null default 90 check (pick_seconds between 15 and 600),
  created_at       timestamptz not null default now()
);

create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  league_id  uuid not null references leagues(id) on delete cascade,
  owner_uid  uuid not null,
  name       text not null,
  draft_slot int,
  created_at timestamptz not null default now(),
  unique (league_id, owner_uid),
  unique (league_id, draft_slot)
);

create table if not exists drafts (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null unique references leagues(id) on delete cascade,
  status        text not null default 'pending'
                check (status in ('pending','active','paused','complete')),
  current_pick  int  not null default 1,
  pick_deadline timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists picks (
  id        uuid primary key default gen_random_uuid(),
  draft_id  uuid not null references drafts(id) on delete cascade,
  pick_no   int  not null,
  team_id   uuid not null references teams(id),
  player_id text not null references players(id),
  auto      boolean not null default false,
  made_at   timestamptz not null default now(),
  unique (draft_id, pick_no),     -- two teams can never occupy one pick slot
  unique (draft_id, player_id)    -- a player can never be drafted twice
);

create table if not exists queues (
  team_id   uuid not null references teams(id) on delete cascade,
  player_id text not null references players(id),
  rank      int  not null,
  primary key (team_id, player_id)
);

create index if not exists idx_picks_draft on picks(draft_id, pick_no);
create index if not exists idx_teams_league on teams(league_id);

-- ---------- snake math ----------
create or replace function slot_for_pick(p_pick int, p_teams int)
returns int language sql immutable as $$
  select case when ((p_pick - 1) / p_teams) % 2 = 0
              then ((p_pick - 1) % p_teams) + 1
              else p_teams - ((p_pick - 1) % p_teams)
         end
$$;

-- ---------- RLS helpers (SECURITY DEFINER breaks policy recursion) ----------
create or replace function is_member(p_league uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from teams   where league_id = p_league and owner_uid = auth.uid())
      or exists (select 1 from leagues where id = p_league and commissioner_uid = auth.uid())
$$;

create or replace function owns_team(p_team uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from teams where id = p_team and owner_uid = auth.uid())
$$;

-- ---------- rpc: create a league (also creates your team + a pending draft) ----------
create or replace function create_league(
  p_name text, p_num_teams int, p_rounds int, p_scoring text,
  p_pick_seconds int, p_team_name text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_league leagues%rowtype;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(trim(p_name),'') = '' or coalesce(trim(p_team_name),'') = '' then
    raise exception 'league name and team name are required';
  end if;
  insert into leagues (name, join_code, commissioner_uid, num_teams, rounds, scoring, pick_seconds)
  values (trim(p_name), lower(substr(md5(random()::text || clock_timestamp()::text), 1, 8)),
          auth.uid(), p_num_teams, p_rounds, p_scoring, p_pick_seconds)
  returning * into v_league;
  insert into teams (league_id, owner_uid, name) values (v_league.id, auth.uid(), trim(p_team_name));
  insert into drafts (league_id) values (v_league.id);
  return jsonb_build_object('league_id', v_league.id, 'join_code', v_league.join_code);
end $$;

-- ---------- rpc: join via code (re-join safe at any time) ----------
create or replace function join_league(p_join_code text, p_team_name text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_league leagues%rowtype;
  v_status text;
  v_count  int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into v_league from leagues where join_code = lower(trim(p_join_code));
  if not found then raise exception 'no league with that code'; end if;

  -- already a member? just return (rejoin from any device state)
  if exists (select 1 from teams where league_id = v_league.id and owner_uid = auth.uid()) then
    return jsonb_build_object('league_id', v_league.id, 'rejoined', true);
  end if;

  select status into v_status from drafts where league_id = v_league.id;
  if v_status <> 'pending' then raise exception 'draft already started — new teams can''t join'; end if;
  select count(*) into v_count from teams where league_id = v_league.id;
  if v_count >= v_league.num_teams then raise exception 'league is full'; end if;
  if coalesce(trim(p_team_name),'') = '' then raise exception 'team name is required'; end if;

  insert into teams (league_id, owner_uid, name) values (v_league.id, auth.uid(), trim(p_team_name));
  return jsonb_build_object('league_id', v_league.id, 'rejoined', false);
end $$;

-- ---------- rpc: start the draft (commissioner only) ----------
create or replace function start_draft(p_league_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_league leagues%rowtype;
  v_draft  drafts%rowtype;
  v_count  int;
begin
  select * into v_league from leagues where id = p_league_id;
  if not found then raise exception 'league not found'; end if;
  if v_league.commissioner_uid <> auth.uid() then raise exception 'only the commissioner can start'; end if;

  select * into v_draft from drafts where league_id = p_league_id for update;
  if v_draft.status <> 'pending' then raise exception 'draft already started'; end if;

  select count(*) into v_count from teams where league_id = p_league_id;
  if v_count < 2 then raise exception 'need at least 2 teams'; end if;

  -- the league drafts with the teams that actually showed up
  update leagues set num_teams = v_count where id = p_league_id;

  -- random draft order
  with ordered as (
    select id, row_number() over (order by random()) as slot
    from teams where league_id = p_league_id
  )
  update teams t set draft_slot = o.slot from ordered o where t.id = o.id;

  update drafts
     set status = 'active', current_pick = 1,
         pick_deadline = now() + make_interval(secs => v_league.pick_seconds)
   where league_id = p_league_id;

  return jsonb_build_object('started', true, 'teams', v_count);
end $$;

-- ---------- rpc: THE pick function — every pick goes through here ----------
create or replace function make_pick(p_draft_id uuid, p_team_id uuid, p_player_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_draft  drafts%rowtype;
  v_league leagues%rowtype;
  v_team   teams%rowtype;
  v_slot   int;
  v_total  int;
begin
  -- serialize ALL concurrent pickers on this draft
  select * into v_draft from drafts where id = p_draft_id for update;
  if not found then raise exception 'draft not found'; end if;

  select * into v_league from leagues where id = v_draft.league_id;
  if v_draft.status <> 'active' then raise exception 'draft is %', v_draft.status; end if;

  v_total := v_league.num_teams * v_league.rounds;
  if v_draft.current_pick > v_total then raise exception 'draft is complete'; end if;

  select * into v_team from teams where id = p_team_id and league_id = v_league.id;
  if not found then raise exception 'team not in this league'; end if;
  if v_team.owner_uid <> auth.uid() and v_league.commissioner_uid <> auth.uid() then
    raise exception 'you do not own this team';
  end if;

  -- whose turn is it? computed server-side, never trusted from the client
  v_slot := slot_for_pick(v_draft.current_pick, v_league.num_teams);
  if v_team.draft_slot is distinct from v_slot then
    raise exception 'not your turn — pick % belongs to draft slot %', v_draft.current_pick, v_slot;
  end if;

  if exists (select 1 from picks where draft_id = p_draft_id and player_id = p_player_id) then
    raise exception 'player already drafted';
  end if;
  if not exists (select 1 from players where id = p_player_id) then
    raise exception 'unknown player';
  end if;

  insert into picks (draft_id, pick_no, team_id, player_id, auto)
  values (p_draft_id, v_draft.current_pick, p_team_id, p_player_id, false);

  update drafts set
    current_pick  = v_draft.current_pick + 1,
    status        = case when v_draft.current_pick + 1 > v_total then 'complete' else 'active' end,
    pick_deadline = case when v_draft.current_pick + 1 > v_total then null
                         else now() + make_interval(secs => v_league.pick_seconds) end
  where id = p_draft_id;

  return jsonb_build_object('ok', true, 'pick_no', v_draft.current_pick);
end $$;

-- ---------- rpc: server-clock autopick — every client calls this every 5s ----------
create or replace function autopick_if_expired(p_draft_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_draft  drafts%rowtype;
  v_league leagues%rowtype;
  v_team   teams%rowtype;
  v_slot   int;
  v_total  int;
  v_player text;
begin
  select * into v_draft from drafts where id = p_draft_id for update;
  if not found then return jsonb_build_object('fired', false); end if;
  if v_draft.status <> 'active' or v_draft.pick_deadline is null
     or now() < v_draft.pick_deadline then
    return jsonb_build_object('fired', false);
  end if;

  select * into v_league from leagues where id = v_draft.league_id;
  v_total := v_league.num_teams * v_league.rounds;
  if v_draft.current_pick > v_total then return jsonb_build_object('fired', false); end if;

  v_slot := slot_for_pick(v_draft.current_pick, v_league.num_teams);
  select * into v_team from teams where league_id = v_league.id and draft_slot = v_slot;

  -- queue first…
  select q.player_id into v_player
    from queues q
   where q.team_id = v_team.id
     and not exists (select 1 from picks p where p.draft_id = p_draft_id and p.player_id = q.player_id)
   order by q.rank asc limit 1;

  -- …then best available by ADP, tiebreak on projection for this league's scoring
  if v_player is null then
    select pl.id into v_player
      from players pl
     where not exists (select 1 from picks p where p.draft_id = p_draft_id and p.player_id = pl.id)
     order by pl.adp asc nulls last,
              coalesce(case v_league.scoring when 'ppr' then pl.ppr
                                             when 'half' then pl.half
                                             else pl.std end, 0) desc
     limit 1;
  end if;
  if v_player is null then raise exception 'no players left to autopick'; end if;

  insert into picks (draft_id, pick_no, team_id, player_id, auto)
  values (p_draft_id, v_draft.current_pick, v_team.id, v_player, true);

  update drafts set
    current_pick  = v_draft.current_pick + 1,
    status        = case when v_draft.current_pick + 1 > v_total then 'complete' else 'active' end,
    pick_deadline = case when v_draft.current_pick + 1 > v_total then null
                         else now() + make_interval(secs => v_league.pick_seconds) end
  where id = p_draft_id;

  return jsonb_build_object('fired', true, 'pick_no', v_draft.current_pick, 'player', v_player);
end $$;

-- ---------- rpc: commissioner controls ----------
create or replace function pause_draft(p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft drafts%rowtype; v_league leagues%rowtype;
begin
  select * into v_draft from drafts where id = p_draft_id for update;
  select * into v_league from leagues where id = v_draft.league_id;
  if v_league.commissioner_uid <> auth.uid() then raise exception 'commissioner only'; end if;
  if v_draft.status <> 'active' then raise exception 'draft is not active'; end if;
  update drafts set status = 'paused', pick_deadline = null where id = p_draft_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function resume_draft(p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft drafts%rowtype; v_league leagues%rowtype;
begin
  select * into v_draft from drafts where id = p_draft_id for update;
  select * into v_league from leagues where id = v_draft.league_id;
  if v_league.commissioner_uid <> auth.uid() then raise exception 'commissioner only'; end if;
  if v_draft.status <> 'paused' then raise exception 'draft is not paused'; end if;
  update drafts set status = 'active',
         pick_deadline = now() + make_interval(secs => v_league.pick_seconds)
   where id = p_draft_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function extend_clock(p_draft_id uuid, p_seconds int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft drafts%rowtype; v_league leagues%rowtype;
begin
  select * into v_draft from drafts where id = p_draft_id for update;
  select * into v_league from leagues where id = v_draft.league_id;
  if v_league.commissioner_uid <> auth.uid() then raise exception 'commissioner only'; end if;
  if v_draft.status <> 'active' or v_draft.pick_deadline is null then
    raise exception 'no clock to extend';
  end if;
  if p_seconds not between 5 and 600 then raise exception 'extension out of range'; end if;
  update drafts set pick_deadline = pick_deadline + make_interval(secs => p_seconds)
   where id = p_draft_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function undo_last_pick(p_draft_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_draft drafts%rowtype; v_league leagues%rowtype; v_last picks%rowtype;
begin
  select * into v_draft from drafts where id = p_draft_id for update;
  select * into v_league from leagues where id = v_draft.league_id;
  if v_league.commissioner_uid <> auth.uid() then raise exception 'commissioner only'; end if;

  select * into v_last from picks
   where draft_id = p_draft_id order by pick_no desc limit 1;
  if not found then raise exception 'no picks to undo'; end if;

  delete from picks where id = v_last.id;
  update drafts set
    current_pick  = v_last.pick_no,
    status        = 'active',
    pick_deadline = now() + make_interval(secs => v_league.pick_seconds)
  where id = p_draft_id;
  return jsonb_build_object('ok', true, 'undone_pick', v_last.pick_no);
end $$;

-- ---------- row level security ----------
alter table players enable row level security;
alter table leagues enable row level security;
alter table teams   enable row level security;
alter table drafts  enable row level security;
alter table picks   enable row level security;
alter table queues  enable row level security;

drop policy if exists sel_players on players;
create policy sel_players on players for select to authenticated using (true); -- read-only reference data; no write policies exist

drop policy if exists sel_leagues on leagues;
create policy sel_leagues on leagues for select to authenticated using (is_member(id));

drop policy if exists sel_teams on teams;
create policy sel_teams on teams for select to authenticated using (is_member(league_id));

drop policy if exists sel_drafts on drafts;
create policy sel_drafts on drafts for select to authenticated using (is_member(league_id));

drop policy if exists sel_picks on picks;
create policy sel_picks on picks for select to authenticated
  using (is_member((select league_id from drafts d where d.id = draft_id)));

drop policy if exists all_queues on queues;
create policy all_queues on queues for all to authenticated
  using (owns_team(team_id)) with check (owns_team(team_id));

-- no insert/update/delete policies on leagues/teams/drafts/picks:
-- every write goes through the SECURITY DEFINER functions above.

-- ---------- function execute grants ----------
revoke execute on all functions in schema public from public, anon;
grant execute on function slot_for_pick(int,int),
  is_member(uuid), owns_team(uuid),
  create_league(text,int,int,text,int,text),
  join_league(text,text), start_draft(uuid),
  make_pick(uuid,uuid,text), autopick_if_expired(uuid),
  pause_draft(uuid), resume_draft(uuid),
  extend_clock(uuid,int), undo_last_pick(uuid)
to authenticated;

-- ---------- realtime ----------
do $$ begin
  begin
    alter publication supabase_realtime add table drafts;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table picks;
  exception when duplicate_object then null; end;
  begin
    alter publication supabase_realtime add table teams;
  exception when duplicate_object then null; end;
end $$;

-- ---------- sanity checks (fail loud if snake math is wrong) ----------
do $$ begin
  if slot_for_pick(13, 12) <> 12 then raise exception 'snake math broken: pick 13 should be slot 12'; end if;
  if slot_for_pick(25, 12) <> 1  then raise exception 'snake math broken: pick 25 should be slot 1'; end if;
  if slot_for_pick(1, 10)  <> 1  then raise exception 'snake math broken: pick 1 should be slot 1'; end if;
  if slot_for_pick(20, 10) <> 1  then raise exception 'snake math broken: pick 20 should be slot 1'; end if;
  if slot_for_pick(21, 10) <> 1  then raise exception 'snake math broken: pick 21 should be slot 1'; end if;
  if slot_for_pick(11, 10) <> 10 then raise exception 'snake math broken: pick 11 should be slot 10'; end if;
end $$;

-- ---------- player seed (real Sleeper 2026 projections + ADP, byes from ESPN schedule) ----------
