// Synthetic REST fixtures for #121/#122, not live observations or authority.
import {generateKeyPairSync} from 'node:crypto';
import {bodyDigest, signGrant, createAuthorizationBoundary, createGithubProvider, createAssigneeSelector} from '../src/index.mjs';
import {grantFixture, grantContext} from './grant-fixture.mjs';
export function selectionFixture() {
  const payload = grantFixture(bodyDigest), keys = generateKeyPairSync('ed25519');
  const context = grantContext(payload,keys.publicKey.export({type:'spki',format:'pem'}));
  const grant = signGrant(payload,{keyId:'owner-1',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'})});
  const target = {owner:'example-org',repository:'core',id:context.request.repository.id,ownerId:'7',ownerType:'Organization'};
  const registration = {level:'repository',id:target.id};
  const members = [{id:'9007199254740999',login:'zed'},{id:'42',login:'amy'}];
  const prefix = '/repos/example-org/core', issuePath = prefix+'/issues/101';
  const runner = (id,member,patch={}) => ({id,name:'runner-'+id,os:'linux',status:'online',busy:true,
    labels:['self-hosted','linux','x64','nibfin-user-'+member].map(name=>({name,type:'custom'})),...patch});
  const record = (id,member,patch={}) => ({runnerId:id,memberId:member,instanceId:'local-'+id,
    repositoryId:target.id,registration,platform:'linux',...patch});
  const routes = {
    '/user':{id:'7',login:'operator'},
    [prefix]:{id:target.id,full_name:'example-org/core',private:false,visibility:'public',owner:{id:'7',login:'example-org',type:'Organization'}},
    [issuePath]:{id:'123',node_id:'I_101',number:101,repository_url:'https://api.github.com'+prefix,assignees:members,labels:[{name:'scope'}]},
    [prefix+'/actions/runners?per_page=100']:{total_count:2,runners:[runner('21',members[0].id),runner('22','42',{busy:false})]},
  };
  for (const m of members) {
    routes['/users/'+m.login]=m;
    routes[prefix+'/collaborators/'+m.login+'/permission']={permission:'write',user:m};
  }
  const calls = []; let clock = 1100;
  const transport = async r => {
    calls.push(r); if(r.method!=='GET' || !Object.hasOwn(routes,r.endpoint)) throw Error('unexpected request');
    const value=routes[r.endpoint];
    return typeof value === 'function' ? value(r) : {status:200,body:JSON.stringify(value)};
  };
  const provider=createGithubProvider({transport,now:()=>clock,attempts:1});
  const selector=createAssigneeSelector({provider,now:()=>clock,maxCheckpointMs:50,
    authorizationFor:member=>createAuthorizationBoundary({transport,now:()=>clock,maxCheckpointMs:50,attempts:1,
      getCheckpoint:()=>({request:context.request,grant,grantContext:context,member,operator:{id:'7',login:'operator'}})})});
  const input={target,registration,issueId:'I_101',number:'101',operation:'deliver',
    conditions:{platform:'linux',labels:['x64']},records:[record('21',members[0].id),record('22','42')],
    execution:{repositoryId:target.id,issueId:'I_101',operation:'deliver',observedAt:1100,state:'new'}};
  return {selector,input,routes,calls,context,grant,payload,runner,record,members,prefix,issuePath,setClock:v=>{clock=v;},
    select:()=>selector.select(input),expected:{outcome:'selected',memberId:members[0].id}};
}
