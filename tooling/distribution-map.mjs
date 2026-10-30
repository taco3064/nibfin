import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {distributionAPI,distributionOwners} from '../src/distribution-contract.mjs';
import {createHash} from 'node:crypto';
const releaseHash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function distributionMap(){
  const donor=JSON.parse(readFileSync('controller/origin.json'));
  return {version:1,api:distributionAPI,owners:distributionOwners,
    origin:{historicalDonor:{repository:donor.repository,commit:donor.commit,manifestSha256:releaseHash(readFileSync('controller/origin.json'))},
      reviewedNibfinBaseline:{repository:'taco3064/nibfin',commit:'36bfe080e375da2a7beb6d2b9bc87bebc8c06f2d',path:'controller',pullRequests:[239,240]},
      jobAdmission:{repository:'taco3064/nibfin',commit:'6d8c3016923e0895dcecc6f462f47f33b035be4a',pullRequest:243,
        evidence:'https://github.com/taco3064/nibfin/pull/243',evidenceKind:'upstream-only'},
      details:'docs/nibfin-reuse.md',
      inputs:distributionOwners.filter(o=>o.input).map(o=>({responsibility:o.responsibility,path:o.input.startsWith('docs/')?o.input:'controller/'+o.input,
        sha256:releaseHash(readFileSync(o.input.startsWith('docs/')?o.input:'controller/'+o.input)),historicalSha256:donor.files.find(f=>f.path===o.input)?.sha256??null}))},
    files:[...new Set(['package.json','README.md',...JSON.parse(readFileSync('package.json')).files])].sort().filter(path=>path!=='src/distribution-map.json').map(path=>({path,sha256:releaseHash(readFileSync(path))}))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const bytes=JSON.stringify(distributionMap(),null,2)+'\n';
  if(process.argv[2]==='--write')writeFileSync('src/distribution-map.json',bytes);
  else if(process.argv.length!==2||readFileSync('src/distribution-map.json','utf8')!==bytes)throw Error('distribution:stale-map');
}
