// Reviewed executable deployment composition, never imported from event input.
// This file exports an inert factory; all capabilities below are explicit.
export function custodyDeployment({core,options,capabilities,provider,archive,
  expectations,publication,authorizeNew,identity}) {
  // expectations reads independently authenticated original Run/Attempt and
  // current requirements. authorizeNew positively attests a first attempt from
  // durable Core history under native Actions concurrency, never an empty list.
  return {options,capabilities,...(identity?{identity}:{}),custody:{provider,archive,
    expect:expectations,publication,authorizeNew,maxBytes:1048576,maxFiles:8,
    timeoutMs:30000,retentionDays:7}};
}
