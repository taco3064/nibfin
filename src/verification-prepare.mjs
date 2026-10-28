// Adapted from Kairo d1b47d5e073cf15bdcdc1fbbec098401649878d9.
// Exact-copy/locked-install responsibility delegates to Nibfin's one preparation
// owner, retaining stronger cache identity and explicit nested-project checks.
import {prepareNodeVerification} from './node-verification.mjs';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
export {prepareNodeVerification};
export async function main(args=process.argv.slice(2)) {
  if(args.length>3)throw Error('verification preparation: source scratch [project]');
  const owner=JSON.parse(await readFile('/verification/commands/active.lock','utf8'));
  // The guarded subreaper is the parent of this process; the runner retains lock.
  let ancestor=process.ppid,guarded=false;
  for(let n=0;n<16&&ancestor>0;n++) {
    if(ancestor===owner.pid){guarded=true;break;}
    const stat=await readFile('/proc/'+ancestor+'/stat','utf8');ancestor=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
  }
  if(!guarded)throw Error('verification preparation: guarded lane required');
  const budget=JSON.parse(await readFile('/input/verification-budget.json','utf8'));
  const {runVerificationChild}=await import('./verification-child.mjs');
  const lane={budget:{require(){const left=budget.stopVerificationAt-Date.now();if(left<=0)throw Error('verification preparation: budget exhausted');return left;}},
    // The parent CLI owns the only lane for this whole preparation, including npm.
    command:async(input,{signal}={})=>runVerificationChild(input,{signal})};
  const receipt=await prepareNodeVerification({source:args[0]??'/work',scratch:args[1]??'/tmp',project:args[2]??'.',
    npm:'/usr/local/bin/npm',networkEnvironment:{HTTP_PROXY:'http://nibfin-egress:8080',HTTPS_PROXY:'http://nibfin-egress:8080'},lane});
  console.log(JSON.stringify({...receipt,assertCurrent:undefined,command:undefined}));
  if(receipt.status!=='prepared')process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('verification preparation: failed; inspect guarded receipt');process.exitCode=1;});
