import { resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

/** Fail the build if a browser entry ever regresses to a provider SDK/config. */
export function assertBackendOnlyFrontend(ids: Iterable<string>, sources: Iterable<string>) {
  const serverRoot = (resolve('server') + sep).replaceAll('\\', '/');
  for (const raw of ids) {
    const id = raw.replaceAll('\\', '/').replaceAll('\0', '');
    if (id.startsWith(serverRoot) || /\/(?:@supabase|supabase-js)\//i.test(id)) {
      throw new Error('FRONTEND_PROVIDER_BOUNDARY');
    }
  }
  for (const source of sources) {
    if (/\.supabase\.co\b|sb_(?:publishable|secret)_|VITE_SUPABASE_/i.test(source)) {
      throw new Error('FRONTEND_PROVIDER_BOUNDARY');
    }
  }
}
export function backendOnlyFrontend(): Plugin {
  return {
    name:'ibs-marker-backend-only-frontend',
    apply:'build',
    enforce:'post',
    generateBundle(_options,bundle) {
      const sources = Object.values(bundle).flatMap(file => file.type === 'chunk'
        ? [file.code] : typeof file.source === 'string' ? [file.source] : []);
      assertBackendOnlyFrontend(this.getModuleIds(), sources);
    },
  };
}
