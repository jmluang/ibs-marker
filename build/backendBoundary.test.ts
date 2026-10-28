import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { assertBackendOnlyFrontend } from './backendBoundary';
describe('production frontend backend-only boundary',()=>{
 it('allows same-origin app modules and BFF protocol',()=>expect(()=>assertBackendOnlyFrontend(['/app/src/main.tsx'],['fetch("/api/auth/session")'])).not.toThrow());
 it('rejects any provider SDK runtime module',()=>expect(()=>assertBackendOnlyFrontend(['/app/node_modules/@supabase/auth-js/dist/main/index.js'],[])).toThrow('FRONTEND_PROVIDER_BOUNDARY'));
 it('rejects backend modules in browser graph',()=>expect(()=>assertBackendOnlyFrontend([resolve('server/sessionStore.ts')],[])).toThrow('FRONTEND_PROVIDER_BOUNDARY'));
 it('rejects provider endpoint literals',()=>expect(()=>assertBackendOnlyFrontend([],['https://fixture.supabase.co'])).toThrow('FRONTEND_PROVIDER_BOUNDARY'));
 it('rejects formerly public provider config variables',()=>expect(()=>assertBackendOnlyFrontend([],['env.VITE_SUPABASE_URL'])).toThrow('FRONTEND_PROVIDER_BOUNDARY'));
 it('rejects provider key literals',()=>{for(const prefix of ['sb_secret_','sb_publishable_'])expect(()=>assertBackendOnlyFrontend([],[prefix+'fixture'])).toThrow('FRONTEND_PROVIDER_BOUNDARY')});
});
