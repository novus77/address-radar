import { createRequire } from "node:module";
import { readFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
const root=resolve(import.meta.dirname,".."), require=createRequire(import.meta.url);
const esbuild=createRequire(require.resolve("tsx/package.json"))("esbuild");
const pg=createRequire(resolve(root,"packages/database/package.json"));
await esbuild.build({entryPoints:[resolve(root,"scripts/execute-postgres-preservation-fixture.mjs")],outfile:"/private/tmp/radar-private-preservation-runner.mjs",
  bundle:true,platform:"node",format:"esm",target:"node24",alias:{pg:pg.resolve("pg")},external:["pg-native"],
  plugins:[{name:"library-only-preservation",setup(build){build.onLoad({filter:/rehearse-postgres-full-preservation\.ts$/},args=>({
    contents:readFileSync(args.path,"utf8").split("\nif (process.argv[1]")[0],loader:"ts"}));}}],
  banner:{js:"import {createRequire as __radarRequire} from 'node:module';const require=__radarRequire(import.meta.url);"}});
await esbuild.build({stdin:{contents:"import {createHash} from 'node:crypto';import {createFullDataPreservationSchemaSql} from './packages/database/src/postgres-full-data-import.ts';process.stdout.write(createHash('sha256').update(createFullDataPreservationSchemaSql(process.argv[2]).join('\\n')).digest('hex'));",resolveDir:root,sourcefile:"private-fingerprint.ts"},
  outfile:"/private/tmp/radar-preservation-fingerprint.mjs",bundle:true,platform:"node",format:"esm",target:"node24"});
for(const path of ["/private/tmp/radar-private-preservation-runner.mjs","/private/tmp/radar-preservation-fingerprint.mjs"])chmodSync(path,0o600);
