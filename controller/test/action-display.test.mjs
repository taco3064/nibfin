import test from 'node:test';
import assert from 'node:assert/strict';
import {eventIssueReference,issueReference,requestIssueReference} from '../src/action-display.mjs';

test('display references require the exact enrolled Issue identity',()=>{
 const issue={id:'I_app',repository:'owner/gh-nibfin',number:55};
 assert.equal(issueReference(issue),'gh-nibfin#55');
 assert.equal(issueReference({...issue,number:0}),undefined);
 assert.equal(requestIssueReference({issueId:'I_app',repository:'other/gh-nibfin'},[issue]),undefined);
 assert.equal(requestIssueReference({issueId:'I_app',repository:issue.repository},[issue]),'gh-nibfin#55');
});

test('authenticated Issue events label directly without additional reads',async()=>{
 assert.equal(await eventIssueReference({issueById(){throw Error('Unexpected read');}},{repository:'owner/nibfin',issueNumber:229}),'nibfin#229');
});

test('fanout node lookup checks both repository and immutable Issue identity',async()=>{
 const payload={repository:'owner/nibfin',issueId:'I_app',issueNumber:null,eventName:'workflow_dispatch'};
 const issue={id:'I_app',number:229,repository:{nameWithOwner:payload.repository}};
 assert.equal(await eventIssueReference({issueById:async id=>{assert.equal(id,'I_app');return issue;}},payload),'nibfin#229');
 for(const invalid of [{...issue,id:'I_other'},{...issue,repository:{nameWithOwner:'foreign/nibfin'}}])
  assert.equal(await eventIssueReference({issueById:async()=>invalid},payload),'nibfin');
});

test('CI notifications label only resolved same-project targets and deduplicate them',async()=>{
 const payload={repository:'owner/nibfin',eventName:'workflow_run'};
 const resolve=async observed=>{assert.equal(observed,payload);return[
  {repository:'owner/nibfin',number:232},{repository:'owner/nibfin',number:229},
  {repository:'owner/nibfin',number:232},{repository:'foreign/nibfin',number:999},
 ];};
 assert.equal(await eventIssueReference({},payload,resolve),'nibfin#229+232');
 assert.equal(await eventIssueReference({},payload,async()=>[{repository:payload.repository,number:229}]),'nibfin#229');
});

test('optional display reads never prevent verified event delivery',async()=>{
 const payload={repository:'owner/nibfin',issueId:'I_app',eventName:'workflow_run'};
 assert.equal(await eventIssueReference({issueById:async()=>{throw Error('Unavailable');}},payload),'nibfin');
 assert.equal(await eventIssueReference({},payload,async()=>{throw Error('Unavailable');}),'nibfin');
 assert.equal(await eventIssueReference({},payload,async()=>[]),'nibfin');
});
