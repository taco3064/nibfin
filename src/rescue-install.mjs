import {rescueNeed as need,rescueSame as same,validateRescuePolicy} from './rescue-policy.mjs';
/** Source handoff for the existing Owner-authorized host/CLI. Pure plans only;
 * no webhook/API/systemd mutation here. Endpoint updates preserve the hook ID.
 */
export function rescueInstallation({policy,permission,relay,hook,secret,notifier,previous=null,backfill}) {
  validateRescuePolicy(policy);
  need(permission?.repositoryId===policy.repositoryId&&permission.administration==='write'
    &&permission.workflows==='write'&&permission.ownerAuthorized===true,'install-permission');
  need(relay?.existing===true&&relay.single===true&&relay.perRunner===false&&relay.controller==='nibfin'
    &&relay.sharedModelLogin===false&&relay.sharedOwnerCredentials===false,'host-boundary');
  const u=new URL(hook?.url);need(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash,'endpoint');
  need(hook.events?.length===1&&hook.events[0]==='workflow_run'&&hook.repositoryId===policy.repositoryId,'hook');
  need(secret?.protected===true&&secret.minimumBytes>=32&&secret.outsideAgent===true&&secret.public===false,'secret');
  need(notifier?.durable===true&&notifier.owner==='existing-host'&&notifier.cron===false,'notifier');
  need(Number.isSafeInteger(backfill?.from)&&Number.isSafeInteger(backfill.to)&&backfill.to>=backfill.from
    &&backfill.to-backfill.from<=86400000&&Number.isSafeInteger(backfill.maxRuns)&&backfill.maxRuns>=1&&backfill.maxRuns<=100,'backfill');
  if(previous)need(previous.repositoryId===hook.repositoryId&&String(previous.id)===String(hook.id)&&previous.secretIdentity===secret.identity,'managed-hook');
  return {version:1,hook:{...hook,operation:previous?'update':'create'},secretIdentity:secret.identity,
    notifier:'existing-host',backfill:structuredClone(backfill),changed:!previous||!same(previous.url,hook.url)};
}
