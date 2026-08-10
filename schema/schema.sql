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
insert into players (id,name,team,pos,bye,ppr,half,std,adp) values
('4984','Josh Allen','BUF','QB',7,361.5,361.5,361.5,28.2),
('9221','Jahmyr Gibbs','DET','RB',6,331.4,299.9,268.4,1.6),
('4881','Lamar Jackson','BAL','QB',13,326.0,326.0,326.0,37.9),
('9509','Bijan Robinson','ATL','RB',11,324.9,292.9,260.9,1.8),
('11564','Drake Maye','NE','QB',11,320.8,320.8,320.8,51.2),
('11566','Jayden Daniels','WAS','QB',7,314.5,314.5,314.5,62.1),
('9493','Puka Nacua','LAR','WR',11,312.5,259.0,205.5,4.9),
('7564','Ja''Marr Chase','CIN','WR',6,311.1,256.6,202.1,3.4),
('6904','Jalen Hurts','PHI','QB',10,310.5,310.5,310.5,67.2),
('6770','Joe Burrow','CIN','QB',6,306.1,306.1,306.1,57.1),
('3294','Dak Prescott','DAL','QB',14,303.9,303.9,303.9,90.3),
('7523','Trevor Lawrence','JAX','QB',7,303.4,303.4,303.4,92.3),
('8183','Brock Purdy','SF','QB',8,303.2,303.2,303.2,103.5),
('11560','Caleb Williams','CHI','QB',10,299.3,299.3,299.3,82.9),
('12508','Jaxson Dart','NYG','QB',8,296.5,296.5,296.5,80.6),
('11563','Bo Nix','DEN','QB',10,295.7,295.7,295.7,118.7),
('6797','Justin Herbert','LAC','QB',7,295.5,295.5,295.5,83.7),
('4034','Christian McCaffrey','SF','RB',8,291.0,256.0,221.0,5.0),
('4046','Patrick Mahomes','KC','QB',5,286.7,286.7,286.7,100.1),
('9488','Jaxon Smith-Njigba','SEA','WR',11,284.6,235.1,185.6,5.4),
('3163','Jared Goff','DET','QB',6,283.5,283.5,283.5,122.0),
('7547','Amon-Ra St. Brown','DET','WR',6,280.5,227.5,174.5,8.1),
('421','Matthew Stafford','LAR','QB',11,280.2,280.2,280.2,115.2),
('6804','Jordan Love','GB','QB',11,278.5,278.5,278.5,124.8),
('4892','Baker Mayfield','TB','QB',10,274.9,274.9,274.9,140.9),
('6813','Jonathan Taylor','IND','RB',13,272.3,254.3,236.3,7.7),
('12545','Tyler Shough','NO','QB',8,270.9,270.9,270.9,144.4),
('6786','CeeDee Lamb','DAL','WR',14,270.5,222.5,174.5,10.6),
('8161','Malik Willis','MIA','QB',6,270.1,270.1,270.1,137.8),
('5849','Kyler Murray','MIN','QB',6,265.2,265.2,265.2,142.2),
('4943','Sam Darnold','SEA','QB',11,262.7,262.7,262.7,165.3),
('8138','James Cook','BUF','RB',7,260.8,245.3,229.8,12.7),
('12527','Ashton Jeanty','LV','RB',13,259.5,234.5,209.5,15.4),
('9224','Chase Brown','CIN','RB',6,255.2,226.7,198.2,19.0),
('11604','Brock Bowers','LV','TE',13,253.5,202.5,151.5,20.2),
('7569','Nico Collins','HOU','WR',8,251.5,210.5,169.5,25.2),
('6794','Justin Jefferson','MIN','WR',6,250.4,205.4,160.4,12.4),
('8112','Drake London','ATL','WR',11,250.2,205.2,160.2,14.1),
('5859','A.J. Brown','NE','WR',11,247.2,207.7,168.2,19.4),
('3198','Derrick Henry','BAL','RB',13,246.9,238.4,229.9,24.6),
('4866','Saquon Barkley','PHI','RB',10,246.7,228.2,209.7,16.6),
('8137','George Pickens','DAL','WR',14,245.7,205.7,165.7,23.1),
('9226','De''Von Achane','MIA','RB',6,245.4,217.9,190.4,12.5),
('8151','Kenneth Walker','KC','RB',5,244.0,225.5,207.0,22.9),
('12507','Omarion Hampton','LAC','RB',7,242.9,218.9,194.9,18.8),
('13287','Jeremiyah Love','ARI','RB',14,238.5,212.0,185.5,19.7),
('9758','C.J. Stroud','HOU','QB',8,238.2,238.2,238.2,163.4),
('9228','Bryce Young','CAR','QB',5,235.6,235.6,235.6,194.2),
('8130','Trey McBride','ARI','TE',14,234.9,186.9,138.9,18.7),
('8144','Chris Olave','NO','WR',8,231.8,191.8,151.8,26.4),
('10229','Rashee Rice','KC','WR',5,229.3,185.3,141.3,22.7),
('7525','DeVonta Smith','PHI','WR',10,229.2,189.2,149.2,44.9),
('9997','Zay Flowers','BAL','WR',13,228.2,187.7,147.2,43.8),
('11635','Ladd McConkey','LAC','WR',7,228.2,187.7,147.2,41.9),
('12522','Cam Ward','TEN','QB',9,227.8,227.8,227.8,165.9),
('11632','Malik Nabers','NYG','WR',8,227.3,186.3,145.3,27.3),
('8146','Garrett Wilson','NYJ','WR',13,224.9,183.4,141.9,40.9),
('6801','Tee Higgins','CIN','WR',6,224.4,186.9,149.4,35.5),
('12514','Emeka Egbuka','TB','WR',10,224.0,185.5,147.0,45.8),
('5870','Daniel Jones','IND','QB',13,223.5,223.5,223.5,195.1),
('12526','Tetairoa McMillan','CAR','WR',5,223.0,184.5,146.0,37.3),
('1373','Geno Smith','NYJ','QB',13,222.5,222.5,222.5,null),
('2216','Mike Evans','SF','WR',8,222.2,187.2,152.2,57.8),
('7526','Jaylen Waddle','DEN','WR',10,221.0,182.5,144.0,46.2),
('5927','Terry McLaurin','WAS','WR',7,216.2,178.7,141.2,56.6),
('12517','Colston Loveland','CHI','TE',10,215.4,173.4,131.4,41.2),
('8155','Breece Hall','NYJ','RB',13,214.6,195.6,176.6,32.3),
('9487','Parker Washington','JAX','WR',7,212.4,176.4,140.4,83.2),
('13269','Fernando Mendoza','LV','QB',13,212.2,212.2,212.2,169.5),
('12481','Cam Skattebo','NYG','RB',8,209.5,187.5,165.5,48.7),
('12519','Luther Burden','CHI','WR',10,209.0,173.0,137.0,41.1),
('8150','Kyren Williams','LAR','RB',11,208.0,192.0,176.0,32.2),
('11620','Rome Odunze','CHI','WR',10,207.9,173.9,139.9,64.2),
('7543','Travis Etienne','NO','RB',8,207.7,189.7,171.7,36.7),
('8167','Christian Watson','GB','WR',11,207.6,176.1,144.6,68.4),
('7588','Javonte Williams','DAL','RB',14,207.3,188.8,170.3,38.3),
('8148','Jameson Williams','DET','WR',6,206.2,176.2,146.2,51.6),
('6790','D''Andre Swift','CHI','RB',10,205.7,187.2,168.7,65.1),
('5850','Josh Jacobs','GB','RB',11,202.6,186.1,169.6,27.6),
('5892','David Montgomery','HOU','RB',8,202.1,185.6,169.1,56.3),
('12518','Tyler Warren','IND','TE',13,201.1,159.6,118.1,50.1),
('10222','Jayden Reed','GB','WR',11,197.6,162.6,127.6,116.0),
('11584','Bucky Irving','TB','RB',10,197.3,179.3,161.3,34.4),
('10859','Sam LaPorta','DET','TE',6,196.5,158.5,120.5,76.4),
('12512','Quinshon Judkins','CLE','RB',11,196.0,180.0,164.0,55.0),
('11631','Brian Thomas','JAX','WR',7,195.4,164.4,133.4,69.6),
('2133','Davante Adams','LAR','WR',11,192.5,161.0,129.5,46.9),
('13279','Carnell Tate','TEN','WR',9,190.3,154.8,119.3,62.9),
('11628','Marvin Harrison','ARI','WR',14,186.2,155.2,124.2,75.8),
('5846','DK Metcalf','PIT','WR',9,183.3,152.3,121.3,74.4),
('9500','Josh Downs','IND','WR',13,180.4,143.4,106.4,125.1),
('12506','Harold Fannin','CLE','TE',11,180.4,143.4,106.4,62.6),
('12529','TreVeyon Henderson','NE','RB',11,179.5,162.0,144.5,47.8),
('4983','DJ Moore','BUF','WR',7,179.0,147.5,116.0,59.3),
('13281','Jordyn Tyson','NO','WR',8,178.6,145.6,112.6,69.0),
('8142','Alec Pierce','IND','WR',13,177.9,150.9,123.9,83.6),
('96','Aaron Rodgers','PIT','QB',9,177.0,177.0,177.0,null),
('12490','Bhayshul Tuten','JAX','RB',7,174.8,158.8,142.8,60.4),
('9484','Tucker Kraft','GB','TE',11,174.4,140.9,107.4,67.3),
('5045','Courtland Sutton','DEN','WR',10,174.3,144.8,115.3,77.9),
('4037','Chris Godwin','TB','WR',10,173.6,139.6,105.6,92.6),
('9756','Jordan Addison','MIN','WR',6,171.7,141.7,111.7,100.7),
('7553','Kyle Pitts','ATL','TE',11,171.6,138.6,105.6,71.3),
('1466','Travis Kelce','KC','TE',5,171.4,136.4,101.4,107.1),
('6819','Michael Pittman','PIT','WR',9,170.9,136.4,101.9,102.9),
('8228','Jaylen Warren','PIT','RB',9,170.6,152.6,134.6,74.8),
('12501','Matthew Golden','GB','WR',11,170.1,141.1,112.1,134.1),
('13286','Jadarian Price','SEA','RB',11,170.0,160.5,151.0,80.3),
('5947','Jakobi Meyers','JAX','WR',7,169.3,137.3,105.3,87.6),
('4217','George Kittle','SF','TE',8,169.3,138.3,107.3,97.4),
('13294','Makai Lemon','PHI','WR',10,168.5,138.5,108.5,76.6),
('8134','Khalil Shakir','BUF','WR',7,166.5,132.0,97.5,133.8),
('7611','Rhamondre Stevenson','NE','RB',11,166.3,151.8,137.3,82.7),
('10232','Michael Wilson','ARI','WR',14,166.0,136.5,107.0,80.2),
('11646','Jalen Coker','CAR','WR',5,165.9,135.9,105.9,136.3),
('12484','Jayden Higgins','HOU','WR',8,165.4,136.9,108.4,131.1),
('8126','Wan''Dale Robinson','TEN','WR',9,164.1,130.1,96.1,103.0),
('9754','Quentin Johnston','LAC','WR',7,163.9,134.9,105.9,102.6),
('10236','Dalton Kincaid','BUF','TE',7,163.6,130.6,97.6,97.1),
('2449','Stefon Diggs','WAS','WR',7,163.0,132.0,101.0,125.9),
('7594','Chuba Hubbard','CAR','RB',5,162.9,148.4,133.9,74.9),
('5012','Mark Andrews','BAL','TE',13,162.5,132.5,102.5,110.7),
('11624','Xavier Worthy','KC','WR',5,161.5,134.0,106.5,134.9),
('8121','Romeo Doubs','NE','WR',11,161.2,132.7,104.2,115.3),
('7021','Rico Dowdle','PIT','RB',9,161.1,142.1,123.1,88.1),
('9480','Brenton Strange','JAX','TE',7,161.0,129.5,98.0,128.8),
('6806','J.K. Dobbins','DEN','RB',10,160.2,147.2,134.2,92.5),
('5967','Tony Pollard','TEN','RB',9,160.1,146.1,132.1,85.6),
('3257','Jacoby Brissett','ARI','QB',14,160.0,160.0,160.0,200.9),
('8110','Jake Ferguson','DAL','TE',14,159.8,124.8,89.8,104.0),
('8131','Isaiah Likely','NYG','TE',8,157.3,126.3,95.3,117.3),
('13298','KC Concepcion','CLE','WR',11,156.4,127.4,98.4,143.2),
('5872','Deebo Samuel','SF','WR',8,155.7,127.7,99.7,164.3),
('5844','T.J. Hockenson','MIN','TE',6,155.0,122.0,89.0,141.2),
('12534','Kyle Monangai','CHI','RB',10,154.6,143.1,131.6,89.5),
('8408','Jordan Mason','MIN','RB',6,153.7,143.7,133.7,130.5),
('3214','Hunter Henry','NE','TE',11,153.5,124.5,95.5,106.2),
('7567','Kenny Gainwell','TB','RB',10,152.3,128.8,105.3,106.9),
('8210','Chig Okonkwo','WAS','TE',7,144.1,113.6,83.1,146.2),
('12489','RJ Harvey','DEN','RB',10,144.1,125.6,107.1,68.4),
('11603','AJ Barner','SEA','TE',11,142.4,113.4,84.4,150.1),
('12493','Oronde Gadsden','LAC','TE',7,141.8,113.8,85.8,94.7),
('8676','Rashid Shaheed','SEA','WR',11,138.1,115.6,93.1,152.2),
('6768','Tua Tagovailoa','ATL','QB',11,137.9,137.9,137.9,236.5),
('4199','Aaron Jones','MIN','RB',6,137.1,120.1,103.1,108.8),
('7002','Juwan Johnson','NO','TE',8,136.6,109.6,82.6,135.3),
('5022','Dallas Goedert','PHI','TE',10,136.0,109.5,83.0,109.1),
('11586','Blake Corum','LAR','RB',11,135.3,127.8,120.3,98.3),
('5001','Dalton Schultz','HOU','TE',8,133.5,106.0,78.5,137.0),
('10219','Chris Rodriguez','JAX','RB',7,132.5,125.0,117.5,141.6),
('13330','Kenyon Sadiq','NYJ','TE',13,131.1,105.1,79.1,118.2),
('8180','Jalen Nailor','LV','WR',13,130.6,107.6,84.6,166.5),
('12502','Gunnar Helm','TEN','TE',9,130.3,101.8,73.3,200.8),
('7600','Pat Freiermuth','PIT','TE',9,128.4,102.9,77.4,null),
('13417','De''Zhaun Stribling','SF','WR',8,128.4,105.4,82.4,202.4),
('8136','Rachaad White','WAS','RB',7,128.1,111.1,94.1,127.2),
('8111','Cade Otton','TB','TE',10,128.0,100.0,72.0,162.7),
('12533','Jacory Croskey-Merritt','WAS','RB',7,127.9,118.4,108.9,114.9),
('11618','Jalen McMillan','TB','WR',10,127.4,105.4,83.4,163.7),
('13276','Omar Cooper','NYJ','WR',13,127.1,104.6,82.1,149.3),
('13346','Denzel Boston','CLE','WR',11,123.9,99.9,75.9,147.5),
('11783','Ryan Flournoy','DAL','WR',14,121.2,97.7,74.2,227.6),
('11583','Jonathon Brooks','CAR','RB',5,120.0,108.5,97.0,138.0),
('6783','Jerry Jeudy','CLE','WR',11,119.6,98.1,76.6,173.5),
('11533','Brandon Aubrey','DAL','K',14,116.0,116.0,116.0,171.1),
('9508','Tyjae Spears','TEN','RB',9,114.6,97.1,79.6,151.9),
('3451','Ka''imi Fairbairn','HOU','K',8,113.0,113.0,113.0,192.0),
('12509','Tre'' Harris','LAC','WR',7,112.9,93.4,73.9,194.5),
('11786','Cam Little','JAX','K',7,112.0,112.0,112.0,201.0),
('10213','Tre Tucker','LV','WR',13,111.8,91.8,71.8,207.2),
('11655','Tyrone Tracy','NYG','RB',8,111.3,100.8,90.3,145.3),
('2747','Jason Myers','SEA','K',11,111.0,111.0,111.0,175.5),
('8172','Greg Dulcich','MIA','TE',6,110.9,87.4,63.9,null),
('11792','Will Reichard','MIN','K',6,109.0,109.0,109.0,204.4),
('11559','Michael Penix','ATL','QB',11,108.4,108.4,108.4,227.9),
('1945','Chris Boswell','PIT','K',9,107.0,107.0,107.0,239.4),
('LAR','Rams','LAR','DEF',11,106.0,106.0,106.0,115.5),
('8259','Cameron Dicker','LAC','K',7,106.0,106.0,106.0,172.2),
('7839','Evan McPherson','CIN','K',6,106.0,106.0,106.0,224.2),
('12711','Tyler Loop','BAL','K',13,106.0,106.0,106.0,238.4),
('12015','Harrison Mevis','LAR','K',11,106.0,106.0,106.0,181.0),
('7049','Jauan Jennings','MIN','WR',6,105.7,86.2,66.7,146.3),
('12535','Isaac TeSlaa','DET','WR',6,105.4,88.9,72.4,198.6),
('6650','Chase McLaughlin','TB','K',10,105.0,105.0,105.0,240.2),
('11539','Jake Bates','DET','K',6,105.0,105.0,105.0,233.0),
('4993','Mike Gesicki','CIN','TE',6,104.9,83.9,62.9,null),
('HOU','Texans','HOU','DEF',8,104.0,104.0,104.0,119.0),
('SEA','Seahawks','SEA','DEF',11,103.0,103.0,103.0,124.2),
('7042','Tyler Bass','BUF','K',7,103.0,103.0,103.0,299.0),
('4017','Deshaun Watson','CLE','QB',11,102.1,102.1,102.1,null),
('5189','Eddy Pineiro','SF','K',8,101.0,101.0,101.0,204.0),
('11610','Malik Washington','MIA','WR',6,100.7,82.2,63.7,null),
('13320','Zachariah Branch','ATL','WR',11,100.6,82.1,63.6,180.4),
('12530','Travis Hunter','JAX','WR',7,100.6,83.1,65.6,160.2),
('4227','Harrison Butker','KC','K',5,100.0,100.0,100.0,224.0),
('3678','Wil Lutz','DEN','K',10,100.0,100.0,100.0,253.3),
('2020','Cairo Santos','CHI','K',10,100.0,100.0,100.0,222.2),
('11058','Blake Grupe','IND','K',13,99.0,99.0,99.0,null),
('13274','Germie Bernard','PIT','WR',9,98.9,80.9,62.9,220.8),
('11625','Adonai Mitchell','NYJ','WR',13,98.3,80.8,63.3,177.9),
('PHI','Eagles','PHI','DEF',10,98.0,98.0,98.0,129.0),
('13317','Ted Hurst','TB','WR',10,97.9,79.9,61.9,223.5),
('12524','Shedeur Sanders','CLE','QB',11,97.1,97.1,97.1,225.8),
('9511','Keaton Mitchell','LAC','RB',7,96.9,87.9,78.9,164.9),
('12492','Pat Bryant','DEN','WR',10,96.4,78.9,61.4,222.5),
('DEN','Broncos','DEN','DEF',10,96.0,96.0,96.0,132.8),
('12713','Andy Borregales','NE','K',11,96.0,96.0,96.0,184.0),
('BAL','Ravens','BAL','DEF',13,95.0,95.0,95.0,142.2),
('650','Nick Folk','ATL','K',11,95.0,95.0,95.0,285.5),
('1479','Keenan Allen',null,'WR',null,95.0,76.0,57.0,233.2),
('9504','Kayshon Boutte','NE','WR',11,94.6,79.1,63.6,178.7),
('3321','Tyreek Hill',null,'WR',null,93.7,77.2,60.7,174.0),
('11653','Charlie Smyth','NO','K',8,93.0,93.0,93.0,269.0),
('13402','Skyler Bell','BUF','WR',7,92.2,76.2,60.2,null),
('NE','Patriots','NE','DEF',11,92.0,92.0,92.0,149.4),
('MIN','Vikings','MIN','DEF',6,92.0,92.0,92.0,160.0),
('DET','Lions','DET','DEF',6,92.0,92.0,92.0,162.2),
('12961','Ryan Fitzgerald','CAR','K',5,92.0,92.0,92.0,347.0),
('12497','Tory Horton','SEA','WR',11,92.0,76.5,61.0,228.7),
('10226','Andrei Iosivas','CIN','WR',6,91.3,75.3,59.3,null),
('13311','Chris Bell','MIA','WR',6,91.2,74.7,58.2,231.4),
('JAX','Jaguars','JAX','DEF',7,91.0,91.0,91.0,177.2),
('5119','Jason Sanders','NYJ','K',13,91.0,91.0,91.0,null),
('11834','Devaughn Vele','NO','WR',8,91.0,74.5,58.0,239.8),
('10937','Jake Moody','WAS','K',7,91.0,91.0,91.0,333.0),
('13293','Ja''Kobi Lane','BAL','WR',13,90.1,74.1,58.1,197.8),
('4195','Jake Elliott','PHI','K',10,90.0,90.0,90.0,240.9),
('12540','Chimere Dike','TEN','WR',9,89.4,70.4,51.4,229.4),
('12483','Jack Bech','LV','WR',13,89.2,71.7,54.2,238.2),
('13268','Elijah Sarratt','BAL','WR',13,89.1,73.1,57.1,229.2),
('10955','Chad Ryland','ARI','K',14,89.0,89.0,89.0,350.0),
('9479','Darnell Washington','PIT','TE',9,88.9,71.4,53.9,null),
('12469','Dylan Sampson','CLE','RB',11,88.7,77.2,65.7,166.4),
('PIT','Steelers','PIT','DEF',9,88.0,88.0,88.0,181.2),
('12487','Terrance Ferguson','LAR','TE',11,87.5,71.5,55.5,158.7),
('KC','Chiefs','KC','DEF',5,87.0,87.0,87.0,189.2),
('6149','Darius Slayton','NYG','WR',8,86.6,72.6,58.6,null),
('4039','Cooper Kupp','SEA','WR',11,86.4,70.4,54.4,235.2),
('NYG','Giants','NYG','DEF',8,86.0,86.0,86.0,192.5),
('LAC','Chargers','LAC','DEF',7,86.0,86.0,86.0,197.6),
('GB','Packers','GB','DEF',11,86.0,86.0,86.0,203.4),
('DAL','Cowboys','DAL','DEF',14,86.0,86.0,86.0,205.5),
('2505','Darren Waller',null,'TE',null,85.6,69.6,53.6,null),
('11627','Troy Franklin','DEN','WR',10,85.6,70.6,55.6,184.7),
('CHI','Bears','CHI','DEF',10,85.0,85.0,85.0,209.2),
('7571','Rashod Bateman','BAL','WR',13,84.1,70.1,56.1,232.7),
('SF','49ers','SF','DEF',8,84.0,84.0,84.0,214.0),
('IND','Colts','IND','DEF',13,84.0,84.0,84.0,219.0),
('BUF','Bills','BUF','DEF',7,84.0,84.0,84.0,225.2),
('6528','Joey Slye','TEN','K',9,84.0,84.0,84.0,351.0),
('11261','Andre Szmyt','CLE','K',11,84.0,84.0,84.0,342.0),
('12474','Woody Marks','HOU','RB',8,83.8,74.3,64.8,141.2),
('ATL','Falcons','ATL','DEF',11,83.0,83.0,83.0,228.4),
('12536','Jaylin Noel','HOU','WR',8,82.9,67.4,51.9,213.7),
('13285','Malachi Fields','NYG','WR',8,81.6,67.6,53.6,242.4),
('13349','Eli Stowers','PHI','TE',10,81.4,65.9,50.4,173.9),
('TB','Buccaneers','TB','DEF',10,81.0,81.0,81.0,232.4),
('CAR','Panthers','CAR','DEF',5,81.0,81.0,81.0,238.4),
('9482','Michael Mayer','LV','TE',13,80.8,63.8,46.8,null),
('6826','Cole Kmet','CHI','TE',10,79.7,62.7,45.7,null),
('4033','David Njoku','LAC','TE',7,79.7,64.2,48.7,172.4),
('CIN','Bengals','CIN','DEF',6,79.0,79.0,79.0,241.2),
('6865','Colby Parkinson','LAR','TE',11,78.8,63.8,48.8,200.2),
('4981','Calvin Ridley','TEN','WR',9,77.3,63.8,50.3,227.7),
('12498','Mason Taylor','NYJ','TE',13,77.3,60.8,44.3,224.3),
('NO','Saints','NO','DEF',8,77.0,77.0,77.0,244.6),
('11597','Theo Johnson','NYG','TE',8,77.0,61.5,46.0,232.2),
('5906','Dawson Knox','BUF','TE',7,76.4,62.4,48.4,null),
('6271','Olamide Zaccheaus','ATL','WR',11,75.8,60.8,45.8,null),
('13301','Antonio Williams','WAS','WR',7,75.2,61.2,47.2,168.1),
('WAS','Commanders','WAS','DEF',7,75.0,75.0,75.0,null),
('6083','Matt Gay','LV','K',13,75.0,75.0,75.0,263.3),
('CLE','Browns','CLE','DEF',11,74.0,74.0,74.0,266.6),
('12521','Elijah Arroyo','SEA','TE',11,72.2,57.7,43.2,null),
('12503','Isaiah Bond','CLE','WR',11,71.8,58.8,45.8,null),
('8917','KaVontae Turpin','DAL','WR',14,71.5,61.0,50.5,null),
('4454','Kendrick Bourne','ARI','WR',14,71.3,57.3,43.3,null),
('8698','Jake Tonges','SF','TE',8,70.8,55.8,40.8,191.4),
('4066','Evan Engram','DEN','TE',10,70.7,55.2,39.7,null),
('9486','Dontayvion Wicks','PHI','WR',10,70.4,57.4,44.4,null),
('13545','Trey Smack','GB','K',11,70.0,70.0,70.0,353.2),
('9494','Marvin Mims','DEN','WR',10,69.9,56.4,42.9,219.5),
('8154','Brian Robinson','ATL','RB',11,69.9,63.4,56.9,123.8),
('9502','Tank Dell','HOU','WR',8,69.4,57.4,45.4,206.7),
('8132','Tyler Allgeier','ARI','RB',14,69.4,65.4,61.4,132.5),
('5995','Justice Hill','BAL','RB',13,67.7,55.7,43.7,null),
('12860','Theo Wease','MIA','WR',6,67.6,55.1,42.6,null),
('5848','Marquise Brown','PHI','WR',10,67.5,55.0,42.5,null),
('9753','Zach Charbonnet','SEA','RB',11,67.2,61.7,56.2,125.8),
('TEN','Titans','TEN','DEF',9,67.0,67.0,67.0,270.2),
('ARI','Cardinals','ARI','DEF',14,66.0,66.0,66.0,273.0),
('11626','Xavier Legette','CAR','WR',5,66.0,54.0,42.0,null),
('9225','Tank Bigsby','PHI','RB',10,65.2,61.2,57.2,187.7),
('13337','Emmett Johnson','KC','RB',5,65.2,59.2,53.2,149.7),
('11575','Ray Davis','BUF','RB',7,65.1,60.6,56.1,208.6),
('LV','Raiders','LV','DEF',13,65.0,65.0,65.0,279.3),
('NYJ','Jets','NYJ','DEF',13,64.0,64.0,64.0,282.2),
('8119','Jahan Dotson','ATL','WR',11,63.9,52.4,40.9,null),
('13345','Jonah Coleman','DEN','RB',10,63.9,58.9,53.9,145.0),
('13288','Nicholas Singleton','TEN','RB',9,63.7,57.7,51.7,176.4),
('4035','Alvin Kamara','NO','RB',8,63.0,53.0,43.0,157.7),
('8188','Tyquan Thornton','KC','WR',5,62.6,52.6,42.6,null),
('MIA','Dolphins','MIA','DEF',6,62.0,62.0,62.0,299.0),
('13305','Mike Washington','LV','RB',13,62.0,57.5,53.0,179.1),
('13434','Will Kacmarek','MIA','TE',6,61.6,49.1,36.6,null),
('11571','Isaiah Davis','NYJ','RB',13,60.5,54.0,47.5,null),
('4233','Zane Gonzalez','MIA','K',6,60.0,60.0,60.0,null),
('11647','Kimani Vidal','LAC','RB',7,60.0,53.0,46.0,181.1),
('4177','Mack Hollins','NE','WR',11,59.9,49.4,38.9,null),
('12467','Jordan James','SF','RB',8,59.7,54.2,48.7,null),
('13394','Josh Cameron','JAX','WR',7,59.6,49.1,38.6,null),
('9501','DeMario Douglas','NE','WR',11,59.3,49.3,39.3,null),
('7828','Noah Gray','KC','TE',5,59.1,47.1,35.1,null),
('7090','Darnell Mooney','NYG','WR',8,58.6,49.1,39.6,221.1),
('13400','Justin Joly','DEN','TE',10,58.0,46.5,35.0,null),
('13435','Joe Royer','CLE','TE',11,57.8,46.3,34.8,null),
('4147','Samaje Perine','CIN','RB',6,57.6,51.6,45.6,null),
('4137','James Conner','ARI','RB',14,57.2,51.7,46.2,152.2),
('13411','Zavion Thomas','CHI','WR',10,57.2,47.2,37.2,null),
('12499','Elic Ayomanor','TEN','WR',9,56.7,46.7,36.7,199.8),
('11435','Emanuel Wilson','SEA','RB',11,56.5,51.0,45.5,203.3),
('11370','Chris Brooks','GB','RB',11,56.3,49.3,42.3,null),
('12544','LeQuint Allen','JAX','RB',7,56.2,47.2,38.2,null),
('13278','Max Klare','LAR','TE',11,56.1,45.1,34.1,248.8),
('13833','Dominic Zvada','NYG','K',8,56.0,56.0,56.0,355.3),
('6039','Ty Johnson','BUF','RB',7,55.8,47.3,38.8,null),
('13272','Carson Beck','ARI','QB',14,54.9,54.9,54.9,null),
('8205','Isiah Pacheco','DET','RB',6,53.6,48.6,43.6,167.2),
('13282','Jack Endries','CIN','TE',6,53.3,42.8,32.3,null),
('9506','Sean Tucker','TB','RB',10,52.5,48.5,44.5,192.8),
('11576','Braelon Allen','NYJ','RB',13,52.2,47.2,42.2,174.1),
('5095','Daniel Carlson',null,'K',null,52.0,52.0,52.0,null),
('11581','MarShawn Lloyd','GB','RB',11,51.8,48.3,44.8,null),
('6803','Brandon Aiyuk','SF','WR',8,49.6,41.6,33.6,190.2),
('8147','John Metchie','CAR','WR',5,48.8,38.8,28.8,null),
('4950','Christian Kirk','SF','WR',8,46.4,36.9,27.4,241.7),
('1433','Brandon McManus',null,'K',null,46.0,46.0,46.0,null),
('13405','Kaytron Allen','WAS','RB',7,45.9,41.9,37.9,181.2),
('12457','Jaydon Blue','DAL','RB',14,44.9,41.4,37.9,236.6),
('11643','Jaylen Wright','MIA','RB',6,44.1,41.1,38.1,215.1),
('8125','Calvin Austin','NYG','WR',8,43.4,35.4,27.4,null),
('13414','Kaelon Black','SF','RB',8,42.3,39.3,36.3,null),
('10231','Elijah Higgins','ARI','TE',14,41.9,32.9,23.9,null),
('12718','Konata Mumpfield','LAR','WR',11,41.7,33.7,25.7,null),
('13066','Ben Sauls','NYG','K',8,41.0,41.0,41.0,369.0),
('12505','Jalen Royals','KC','WR',5,40.7,32.7,24.7,null),
('9481','Luke Musgrave','GB','TE',11,40.6,32.1,23.6,null),
('13342','John Michael Gyllenborg','KC','TE',5,40.4,34.9,29.4,null),
('8225','Daniel Bellinger','TEN','TE',9,40.1,31.6,23.1,null),
('13319','Oscar Delp','NO','TE',8,39.4,30.9,22.4,null),
('13270','CJ Daniels','LAR','WR',11,39.3,31.8,24.3,null),
('1166','Kirk Cousins','LV','QB',13,39.2,39.2,39.2,null),
('13380','Brenen Thompson','LAC','WR',7,39.0,32.0,25.0,null),
('11637','Keon Coleman','BUF','WR',7,38.8,31.8,24.8,234.8),
('13420','Bryce Lance','NO','WR',8,38.7,31.2,23.7,null),
('11570','Rasheen Ali','BAL','RB',13,38.7,32.7,26.7,null),
('8127','Charlie Kolar','LAC','TE',7,38.4,30.4,22.4,null),
('12485','Tez Johnson','TB','WR',10,38.4,31.4,24.4,null),
('11199','Emari Demercado','KC','RB',5,38.3,32.3,26.3,null),
('3286','Demarcus Robinson','SF','WR',8,38.1,31.1,24.1,null),
('11600','Ja''Tavion Sanders','CAR','TE',5,37.8,29.3,20.8,null),
('12641','Jaylin Lane','WAS','WR',7,37.7,30.7,23.7,null),
('13413','Cyrus Allen','KC','WR',5,37.2,30.2,23.2,null),
('7922','Riley Patterson','MIA','K',6,37.0,37.0,37.0,267.0),
('1339','Zach Ertz',null,'TE',null,36.7,28.7,20.7,null),
('5857','Noah Fant','NO','TE',8,36.6,29.1,21.6,null),
('13424','Seth McGowan','IND','RB',13,36.3,32.8,29.3,null),
('4144','Jonnu Smith',null,'TE',null,35.9,28.4,20.9,null),
('12670','KeAndre Lambert-Smith','LAC','WR',7,35.5,29.0,22.5,null),
('8135','Treylon Burks','WAS','WR',7,34.8,28.8,22.8,null),
('7591','Justin Fields','KC','QB',5,34.7,34.7,34.7,null),
('8117','Jalen Tolbert','MIA','WR',6,34.2,27.7,21.2,null),
('13401','Michael Trigg','DAL','TE',14,33.8,26.8,19.8,249.7),
('11577','Will Shipley','PHI','RB',10,33.8,28.8,23.8,null),
('8800','Malik Davis','DAL','RB',14,33.7,30.7,27.7,null),
('7562','Tutu Atwell','MIA','WR',6,33.7,28.2,22.7,null),
('13347','Demond Claiborne','MIN','RB',6,33.5,29.0,24.5,218.3),
('13322','Sam Roush','CHI','TE',10,33.5,26.5,19.5,null),
('3202','Austin Hooper','ATL','TE',11,33.2,26.2,19.2,null),
('11599','Cade Stover','HOU','TE',8,33.2,26.2,19.2,null),
('4663','Austin Ekeler',null,'RB',null,33.1,28.6,24.1,null),
('13421','Eli Raridon','NE','TE',11,33.0,26.0,19.0,null),
('3271','Tyler Higbee','LAR','TE',11,32.9,25.9,18.9,null),
('13408','Tanner Koziol','JAX','TE',7,32.8,25.8,18.8,null),
('7670','Joshua Palmer','BUF','WR',7,32.6,26.6,20.6,null),
('13296','Caleb Douglas','MIA','WR',6,32.5,26.5,20.5,null),
('10218','Xavier Hutchinson','HOU','WR',8,32.5,26.5,20.5,null),
('13338','Kevin Coleman','MIA','WR',6,32.4,26.4,20.4,null),
('12504','Kaleb Johnson','PIT','RB',9,32.0,29.5,27.0,217.5),
('12482','Savion Williams','GB','WR',11,32.0,27.0,22.0,null),
('12658','Jackson Hawes','BUF','TE',7,31.9,25.4,18.9,null),
('12476','Devin Neal','NO','RB',8,31.9,28.4,24.9,211.9),
('12473','Mitchell Evans','CAR','TE',5,31.9,25.4,18.9,null),
('7716','John Bates','WAS','TE',7,31.8,25.3,18.8,null),
('7694','Tommy Tremble','CAR','TE',5,31.8,25.3,18.8,null),
('13324','Matt Hibner','BAL','TE',13,31.8,25.3,18.8,null),
('6001','Drew Sample','CIN','TE',6,31.6,25.1,18.6,null),
('4040','JuJu Smith-Schuster','NYG','WR',8,31.6,25.6,19.6,null),
('13431','Miles Kitselman','DET','TE',6,31.6,25.1,18.6,null),
('13422','Jaren Kanak','TEN','TE',9,31.6,25.1,18.6,null)
on conflict (id) do update set
  name=excluded.name, team=excluded.team, pos=excluded.pos, bye=excluded.bye,
  ppr=excluded.ppr, half=excluded.half, std=excluded.std, adp=excluded.adp;

-- final check: every player with a team must have a bye (catches WAS/WSH-type gaps)
do $$ declare v int; begin
  select count(*) into v from players where team is not null and bye is null;
  if v > 0 then raise exception '% players missing a bye week', v; end if;
end $$;
