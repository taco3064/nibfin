#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub } from '../src/github.mjs';
import { createRevisionHost } from '../src/requirement-revision-host.mjs';
import { migrateRequirements } from '../src/requirement-revision.mjs';
// No implicit apply, key generation, grant signing, reinstall or dispatch.
const [mode,configPath,recordPath,...extra]=process.argv.slice(2);
try{
  if(mode!=='--apply-approved' || !configPath || !recordPath || extra.length)throw Error('REQUIRES_APPLY_APPROVED_CONFIG_AND_SIGNED_RECORD');
  const config=JSON.parse(await readFile(configPath,'utf8')),bundle=JSON.parse(await readFile(recordPath,'utf8'));
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const {host,record}=await createRevisionHost(config,root,await GitHub.connect(),bundle);
  await host.authorize(record);
  console.log(JSON.stringify(await migrateRequirements(record,host)));
}catch(error){console.error(JSON.stringify({status:'BLOCKED',code:/^[A-Z_]+$/.test(error.code||error.message)?error.code||error.message:'REVISION_OPERATOR_FAILURE'}));process.exitCode=1;}
