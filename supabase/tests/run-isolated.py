#!/usr/bin/env python3
"""Only creates/executes/destroys its own network-isolated disposable PG16 container."""
import pathlib, subprocess, time, uuid, sys, re, os
root=pathlib.Path(__file__).resolve().parents[2]
evidence=pathlib.Path(os.environ.get('IBS_CLOUD_EVIDENCE_DIR', str(root.parent / (root.name + '-verification') / 'cloud'))); evidence.mkdir(parents=True,exist_ok=True)
name='ibs-cloud-test-'+uuid.uuid4().hex[:12]
def run(args,**kw):return subprocess.run(args,text=True,capture_output=True,**kw)
created=run(['docker','run','--rm','-d','--network','none','--name',name,'--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_PASSWORD=isolated-synthetic-testpass','postgres:16'])
if created.returncode:sys.exit(created.stderr)
cid=created.stdout.strip(); chunks=['Container '+name+'\nNetwork none; tmpfs PGDATA; no port mappings; synthetic test password.\nFixture auth.uid uses GUC, NOT vendor Auth.\n']
try:
 for _ in range(60):
  # The initdb helper only listens on a Unix socket and is stopped before final startup.
  # TCP readiness avoids racing that temporary server's shutdown.
  ready=run(['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U','postgres'])
  if ready.returncode==0:break
  time.sleep(.25)
 else:raise RuntimeError('Postgres not ready')
 for file in [root/'supabase/tests/fixture.sql',root/'supabase/migrations/202610200001_tracker.sql',root/'supabase/tests/rls-rpc.sql']:
  p=run(['docker','exec','-i',cid,'psql','-X','-U','postgres','-v','ON_ERROR_STOP=1'],input=file.read_text())
  chunks.append('\n### '+file.name+'\n'+p.stdout+p.stderr)
  if p.returncode:raise RuntimeError(file.name+' failed')
 # Two real psql sessions race on the same previously absent owner/resource.
 import concurrent.futures,json
 rid='33333333-3333-4333-8333-333333333333'
 payload=json.dumps({'id':rid,'kind':'symptom','occurredAt':'2026-10-19T00:00:00.000Z','createdAt':'2026-10-20T00:00:00.000Z','updatedAt':'2026-10-20T00:00:00.000Z','estimatedTime':True,'deletedAt':None,'note':'synthetic race','discomfort':{'status':'unknown','symptoms':[]},'context':''})
 def racer(change):
  sql=f"SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false); SELECT pg_sleep(0.1); SELECT public.tracker_apply_change('{change}','entry','{rid}',0,'{payload}'::jsonb,false)->>'status';"
  return run(['docker','exec','-i',cid,'psql','-X','-At','-U','postgres','-v','ON_ERROR_STOP=1'],input=sql)
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  results=list(pool.map(racer,['44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555']))
 statuses=[]
 for p in results:
  chunks.append('\n### authenticated concurrent session\n'+p.stdout+p.stderr)
  if p.returncode:raise RuntimeError('Concurrent RPC failed')
  statuses.extend(re.findall(r'^(applied|conflict)$',p.stdout,re.M))
 if sorted(statuses)!=['applied','conflict']:raise RuntimeError('Concurrent insert did not serialize: '+str(statuses))
 chunks.append('\nNOTICE:  PASS: two actual concurrent authenticated baseVersion=0 inserts serialize\n')
 log=''.join(chunks);count=len(re.findall(r'NOTICE:  PASS:',log));chunks.append(f'\nSQL assertion count: {count}\n')
 print(f'PG16 migration and {count} role-scoped SQL assertions passed')
except Exception as e:
 chunks.append('\nFAIL: '+str(e)+'\n');raise
finally:
 removed=run(['docker','rm','-f',cid]);chunks.append('\nContainer cleanup exit='+str(removed.returncode)+'\n')
 (evidence/'postgres-validation.log').write_text(''.join(chunks))
 print('Evidence:',evidence/'postgres-validation.log')
