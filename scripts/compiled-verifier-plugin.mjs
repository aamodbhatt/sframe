import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// Workers consume a precompiled module. Node tests instantiate the same bytes;
// no application or publisher code receives this trusted verifier import.
export const compiledVerifierPlugin = ({worker = false} = {}) => {
  const artifact = resolve('target/server-verifier-wasm/smallframe_server_verifier_bg.wasm');
  const migrations = new Set(['0001-local-publisher.sql', '0002-local-package-versions.sql'].map((name) => resolve('infra/migrations', name)));
  const virtual = '\0smallframe-compiled-verifier';
  return {
    name: 'smallframe-compiled-verifier',
    enforce: 'pre',
    buildStart() {
      if (worker) this.emitFile({type: 'asset', fileName: 'smallframe-verifier.wasm', source: readFileSync(artifact)});
    },
    resolveId(source, importer) {
      if (!importer || !source.endsWith('smallframe_server_verifier_bg.wasm')
          || resolve(importer.slice(0, importer.lastIndexOf('/')), source) !== artifact) return null;
      return worker ? {id: './smallframe-verifier.wasm', external: true} : virtual;
    },
    load(id) {
      // Match only checked-in server migrations; Wrangler uses Text modules for
      // the same bytes, while local Vite/Node fixtures inline them.
      if (migrations.has(id)) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
      if (id !== virtual) return null;
      return `import {readFileSync} from 'node:fs'; export default new WebAssembly.Module(readFileSync(${JSON.stringify(artifact)}));`;
    },
  };
};
