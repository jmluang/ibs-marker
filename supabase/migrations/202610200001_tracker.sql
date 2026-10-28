-- Initial cloud schema. Apply only to an explicitly approved Supabase project.
BEGIN;
CREATE TABLE public.tracker_records (
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 id uuid NOT NULL, version bigint NOT NULL CHECK(version>0 AND version<=9007199254740991),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
 tombstone boolean NOT NULL, occurred_at timestamptz NOT NULL,
 meal_day date, meal_slot text,
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX tracker_records_occurred ON public.tracker_records(owner_id,occurred_at DESC);
CREATE UNIQUE INDEX tracker_one_meal ON public.tracker_records(owner_id,meal_day,meal_slot)
 WHERE NOT tombstone AND meal_slot IN ('breakfast','lunch','dinner');
CREATE TABLE public.tracker_settings (
 owner_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
 id text NOT NULL DEFAULT 'settings' CHECK(id='settings'),
 version bigint NOT NULL CHECK(version>0 AND version<=9007199254740991), snapshot jsonb NOT NULL
);
CREATE TABLE public.tracker_changes (
 seq bigserial PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 resource jsonb NOT NULL, change_id uuid NOT NULL
);
CREATE INDEX tracker_changes_owner_seq ON public.tracker_changes(owner_id,seq);
CREATE TABLE public.tracker_change_ledger (
 owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 change_id uuid NOT NULL, input jsonb NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(owner_id,change_id)
);
ALTER TABLE public.tracker_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracker_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracker_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracker_change_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_records ON public.tracker_records FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));
CREATE POLICY own_settings ON public.tracker_settings FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));
CREATE POLICY own_changes ON public.tracker_changes FOR SELECT TO authenticated USING(owner_id=(SELECT auth.uid()));
REVOKE ALL ON public.tracker_records,public.tracker_settings,public.tracker_changes,public.tracker_change_ledger FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.tracker_records,public.tracker_settings,public.tracker_changes TO authenticated;
REVOKE ALL ON SEQUENCE public.tracker_changes_seq_seq FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.tracker_valid_time(v jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 RETURN jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$' AND (v#>>'{}')::timestamptz IS NOT NULL;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE FUNCTION public.tracker_valid_payload(k text, s jsonb, dead boolean) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE d jsonb; v jsonb; slot text; pair record;
BEGIN
 IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR s ?| ARRAY['owner','owner_id'] OR dead IS NULL THEN RETURN false; END IF;
 IF k='settings' THEN
  IF dead OR NOT s ?& ARRAY['meals','foodTemplates','snoozes','remindersEnabled'] OR jsonb_typeof(s->'meals') IS DISTINCT FROM 'object' OR jsonb_typeof(s->'foodTemplates') IS DISTINCT FROM 'array' OR jsonb_typeof(s->'snoozes') IS DISTINCT FROM 'object' OR jsonb_typeof(s->'remindersEnabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  FOREACH slot IN ARRAY ARRAY['breakfast','lunch','dinner'] LOOP
   d:=s->'meals'->slot;
   IF d IS NULL OR NOT d ?& ARRAY['time','enabled'] OR jsonb_typeof(d->'time') IS DISTINCT FROM 'string' OR (d->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR jsonb_typeof(d->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
  END LOOP;
  FOR v IN SELECT value FROM jsonb_array_elements(s->'foodTemplates') LOOP IF jsonb_typeof(v)<>'string' THEN RETURN false; END IF; END LOOP;
  FOR pair IN SELECT * FROM jsonb_each(s->'snoozes') LOOP IF pair.key !~ '^\d{4}-\d{2}-\d{2}:(breakfast|lunch|dinner)$' OR NOT coalesce(public.tracker_valid_time(pair.value),false) THEN RETURN false; END IF; END LOOP;
  RETURN true;
 END IF;
 IF k<>'entry' OR NOT s ?& ARRAY['id','kind','occurredAt','createdAt','updatedAt','estimatedTime','deletedAt','note'] OR (s->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR jsonb_typeof(s->'estimatedTime') IS DISTINCT FROM 'boolean' OR jsonb_typeof(s->'note') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 FOREACH slot IN ARRAY ARRAY['id','kind','note'] LOOP IF jsonb_typeof(s->slot) IS DISTINCT FROM 'string' THEN RETURN false; END IF; END LOOP;
 IF s->>'kind'='meal' THEN
  FOREACH slot IN ARRAY ARRAY['status','slot','foods','portion'] LOOP IF jsonb_typeof(s->slot) IS DISTINCT FROM 'string' THEN RETURN false; END IF; END LOOP;
 ELSIF s->>'kind'='toilet' THEN
  FOREACH slot IN ARRAY ARRAY['result','durationSource','relief'] LOOP IF jsonb_typeof(s->slot) IS DISTINCT FROM 'string' THEN RETURN false; END IF; END LOOP;
 END IF;
 FOREACH slot IN ARRAY ARRAY['occurredAt','createdAt','updatedAt'] LOOP IF NOT coalesce(public.tracker_valid_time(s->slot),false) THEN RETURN false; END IF; END LOOP;
 IF dead IS DISTINCT FROM (s->'deletedAt'<>'null'::jsonb) OR (dead AND NOT coalesce(public.tracker_valid_time(s->'deletedAt'),false)) THEN RETURN false; END IF;
 IF (s->>'kind') IN ('toilet','symptom') THEN
  d:=s->'discomfort';
  IF d IS NULL OR jsonb_typeof(d->'status') IS DISTINCT FROM 'string' OR NOT d ?& ARRAY['status','symptoms'] OR (d->>'status') NOT IN ('reported','none','unknown') OR jsonb_typeof(d->'symptoms') IS DISTINCT FROM 'array' OR ((d->>'status'='reported') IS DISTINCT FROM (jsonb_array_length(d->'symptoms')>0)) THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(d->'symptoms') LOOP IF jsonb_typeof(v->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(v->'severity') IS DISTINCT FROM 'string' OR NOT v ?& ARRAY['name','severity'] OR (v->>'name') NOT IN ('pain','bloating','urgency','nausea','other') OR (v->>'severity') NOT IN ('mild','moderate','severe','unknown') THEN RETURN false; END IF; END LOOP;
 END IF;
 IF s->>'kind'='symptom' THEN RETURN jsonb_typeof(s->'context')='string'; END IF;
 IF s->>'kind'='meal' THEN
  IF NOT s ?& ARRAY['status','slot','foods','tags','portion'] OR (s->>'status') NOT IN ('eaten','skipped') OR (s->>'slot') NOT IN ('breakfast','lunch','dinner','snack') OR jsonb_typeof(s->'foods') IS DISTINCT FROM 'string' OR jsonb_typeof(s->'tags') IS DISTINCT FROM 'array' OR (s->>'portion') NOT IN ('small','medium','large','unknown') THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(s->'tags') LOOP IF jsonb_typeof(v)<>'string' THEN RETURN false; END IF; END LOOP;
  RETURN s->>'status'<>'skipped' OR (btrim(s->>'foods')='' AND jsonb_array_length(s->'tags')=0 AND s->>'portion'='unknown');
 END IF;
 IF s->>'kind'='toilet' THEN
  IF NOT s ?& ARRAY['result','stoolForms','startedAt','endedAt','durationSource','estimatedDurationMinutes','relief'] OR (s->>'result') NOT IN ('passed','none','unsure') OR jsonb_typeof(s->'stoolForms') IS DISTINCT FROM 'array' OR ((s->>'result'='passed') IS DISTINCT FROM (jsonb_array_length(s->'stoolForms')>0)) OR (s->>'relief') NOT IN ('yes','partial','no','unknown') OR (s->>'durationSource') NOT IN ('timer','estimated','unknown') THEN RETURN false; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(s->'stoolForms') LOOP IF v NOT IN ('1','2','3','4','5','6','7','"unknown"') THEN RETURN false; END IF; END LOOP;
  FOREACH slot IN ARRAY ARRAY['startedAt','endedAt'] LOOP IF s->slot<>'null'::jsonb AND NOT coalesce(public.tracker_valid_time(s->slot),false) THEN RETURN false; END IF; END LOOP;
  IF s->'endedAt'<>'null'::jsonb AND (s->'startedAt'='null'::jsonb OR (s->>'endedAt')::timestamptz<(s->>'startedAt')::timestamptz) THEN RETURN false; END IF;
  IF s->>'durationSource'='timer' THEN RETURN s->'startedAt'<>'null'::jsonb AND s->'endedAt'<>'null'::jsonb AND s->'estimatedDurationMinutes'='null'::jsonb; END IF;
  IF s->>'durationSource'='estimated' THEN RETURN jsonb_typeof(s->'estimatedDurationMinutes')='number' AND (s->>'estimatedDurationMinutes')::numeric>=0; END IF;
  RETURN s->'estimatedDurationMinutes'='null'::jsonb;
 END IF;
 RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.tracker_valid_time(jsonb),public.tracker_valid_payload(text,jsonb,boolean) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.tracker_apply_change(p_change_id uuid,p_kind text,p_resource_id text,p_base_version bigint,p_snapshot jsonb,p_tombstone boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u uuid:=auth.uid(); request jsonb; old_input jsonb; result jsonb; current_version bigint; current_snapshot jsonb; current_dead boolean; remote jsonb; rid uuid;
BEGIN
 IF u IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_change_id IS NULL OR p_kind IS NULL OR p_resource_id IS NULL OR p_base_version IS NULL OR p_base_version<0 OR p_base_version>=9007199254740991 OR NOT coalesce(public.tracker_valid_payload(p_kind,p_snapshot,p_tombstone),false) THEN RAISE EXCEPTION 'INVALID_CHANGE' USING ERRCODE='22023'; END IF;
 IF p_kind='entry' THEN
  IF p_resource_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR p_resource_id IS DISTINCT FROM p_snapshot->>'id' THEN RAISE EXCEPTION 'INVALID_RESOURCE' USING ERRCODE='22023'; END IF;
  rid:=p_resource_id::uuid;
 ELSIF p_kind<>'settings' OR p_resource_id<>'settings' THEN RAISE EXCEPTION 'INVALID_RESOURCE' USING ERRCODE='22023'; END IF;
 request:=jsonb_build_object('kind',p_kind,'resourceId',p_resource_id,'baseVersion',p_base_version,'snapshot',p_snapshot,'tombstone',p_tombstone);
 -- Per-owner transaction lock covers absent-row/baseVersion=0 races too.
 PERFORM pg_advisory_xact_lock(hashtextextended(u::text,0));
 SELECT l.input,l.result INTO old_input,result FROM public.tracker_change_ledger l WHERE l.owner_id=u AND l.change_id=p_change_id;
 IF FOUND THEN IF old_input<>request THEN RAISE EXCEPTION 'CHANGE_ID_REUSED' USING ERRCODE='22023'; END IF; RETURN result; END IF;
 IF p_kind='entry' THEN
  SELECT r.version,r.snapshot,r.tombstone INTO current_version,current_snapshot,current_dead FROM public.tracker_records r WHERE r.owner_id=u AND r.id=rid FOR UPDATE;
 ELSE
  SELECT s.version,s.snapshot,false INTO current_version,current_snapshot,current_dead FROM public.tracker_settings s WHERE s.owner_id=u FOR UPDATE;
 END IF;
 IF coalesce(current_version,0)<>p_base_version THEN
  IF current_version IS NULL THEN RAISE EXCEPTION 'RESOURCE_NOT_FOUND' USING ERRCODE='22023'; END IF;
  remote:=jsonb_build_object('kind',p_kind,'resourceId',p_resource_id,'version',current_version,'snapshot',current_snapshot,'tombstone',current_dead);
  result:=jsonb_build_object('status','conflict','remote',remote);
 ELSE
  current_version:=coalesce(current_version,0)+1;
  IF p_kind='entry' THEN
   INSERT INTO public.tracker_records(owner_id,id,version,snapshot,tombstone,occurred_at,meal_day,meal_slot)
   VALUES(u,rid,current_version,p_snapshot,p_tombstone,(p_snapshot->>'occurredAt')::timestamptz,CASE WHEN p_snapshot->>'kind'='meal' THEN ((p_snapshot->>'occurredAt')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date END,CASE WHEN p_snapshot->>'kind'='meal' THEN p_snapshot->>'slot' END)
   ON CONFLICT(owner_id,id) DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot,tombstone=EXCLUDED.tombstone,occurred_at=EXCLUDED.occurred_at,meal_day=EXCLUDED.meal_day,meal_slot=EXCLUDED.meal_slot;
  ELSE
   INSERT INTO public.tracker_settings(owner_id,id,version,snapshot) VALUES(u,'settings',current_version,p_snapshot)
   ON CONFLICT(owner_id) DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot;
  END IF;
  remote:=jsonb_build_object('kind',p_kind,'resourceId',p_resource_id,'version',current_version,'snapshot',p_snapshot,'tombstone',p_tombstone);
  result:=jsonb_build_object('status','applied','remote',remote);
  INSERT INTO public.tracker_changes(owner_id,resource,change_id) VALUES(u,remote,p_change_id);
 END IF;
 INSERT INTO public.tracker_change_ledger(owner_id,change_id,input,result) VALUES(u,p_change_id,request,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.tracker_apply_change(uuid,text,text,bigint,jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.tracker_apply_change(uuid,text,text,bigint,jsonb,boolean) TO authenticated;
COMMIT;
-- Do not prune logs/ledger/tombstones: first sync replays seq > 0.
