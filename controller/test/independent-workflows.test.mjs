import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
const read=async name=>(await readFile(new URL('../../.github/workflows/'+name,import.meta.url),'utf8')).replaceAll('\r\n','\n');
test('public execution is explicitly activated, fixed-source, no-checkout and typed-input only',async()=>{
 const text=await read('nibfin-controller.yml');
 assert.match(text,/if: vars\.NIBFIN_CONTROLLER_ACTIVE == 'true'/);
 assert.match(text,/GITHUB_REPOSITORY !== 'taco3064\/nibfin'/);
 assert.match(text,/\/opt\/nibfin\/controller\/bin\/nibfin\.mjs action-run \/etc\/nibfin\/development\/actions-runtime\.json/);
 assert.doesNotMatch(text,/actions\/checkout|taco3064\/kairo|pull_request_target|\$\{\{\s*inputs\.[^}]+\}\}.*\n.*run:/);
 assert.match(text,/Exactly one typed reconciliation source is required/);
 for(const block of text.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/g))new vm.Script(block[1]);
});
test('Rescue can cancel only its own Nibfin reporting Run and cannot checkout participant code',async()=>{
 const text=await read('nibfin-rescue.yml');assert.match(text,/github\.repository == 'taco3064\/nibfin'/);assert.match(text,/repository!=='taco3064\/nibfin'/);assert.match(text,/NIBFIN_CONTROLLER_ACTIVE/);assert.doesNotMatch(text,/actions\/checkout|taco3064\/kairo/);
 for(const block of text.matchAll(/node <<'NODE'\n([\s\S]*?)\n\s+NODE/g))new vm.Script(block[1]);
});
