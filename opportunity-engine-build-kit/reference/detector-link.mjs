/** Narrow MF-LINK-01 observation rule. Does not fetch pages or approve findings. */
export function evaluateImportantLink(input){
  const unknown=reason=>({result:'unknown',reason,evidence_ids:[],proposed_grade:null,limitations:['This rule does not measure revenue impact or whole-store health.']});
  if(!input||input.linkKind!=='important_information'||input.navigationApproved!==true)return unknown('unsupported_or_unapproved_link');
  if(!Array.isArray(input.observations)||input.observations.length<2)return unknown('insufficient_independent_captures');
  const obs=input.observations;
  if(obs.some(o=>!o||typeof o.sessionId!=='string'||!o.sessionId.trim()||typeof o.evidenceId!=='string'||!o.evidenceId.trim()||!Number.isFinite(Date.parse(o.capturedAt))))return unknown('invalid_capture_record');
  if(new Set(obs.map(o=>o.sessionId)).size<2||new Set(obs.map(o=>o.evidenceId)).size<2)return unknown('insufficient_independent_captures');
  if(obs.some(o=>o.complete!==true||o.challenge!==false||o.loginWall!==false||o.soft404!==false))return unknown('incomplete_or_ambiguous_capture');
  if(obs.some(o=>o.target!==input.target||typeof o.contextKey!=='string'||!o.contextKey.trim())||new Set(obs.map(o=>o.contextKey)).size!==1)return unknown('noncomparable_context');
  const now=Date.parse(input.now),freshMs=input.maxAgeMs??86400000;
  if(!Number.isFinite(now)||!Number.isSafeInteger(freshMs)||freshMs<1)return unknown('invalid_freshness_policy');
  if(obs.some(o=>Date.parse(o.capturedAt)>now||now-Date.parse(o.capturedAt)>freshMs))return unknown('stale_or_future_capture');
  if(obs.every(o=>Number.isInteger(o.status)&&o.status>=200&&o.status<300))return {result:'no_finding',reason:'link_loaded_in_recorded_checks',evidence_ids:obs.map(o=>o.evidenceId),proposed_grade:null,limitations:['Only this link and its recorded conditions were tested.']};
  if(!obs.every(o=>[404,410].includes(o.status)))return unknown('inconsistent_or_unconfirmed_failure');
  if(new Set(obs.map(o=>o.status)).size!==1)return unknown('inconsistent_failure_status');
  return {result:'candidate',reason:'repeat_404_or_410',detector_id:'MF-LINK-01',detector_version:'2.0.0',claim:`The linked information page returned HTTP ${obs[0].status} in ${obs.length} recorded checks.`,evidence_ids:obs.map(o=>o.evidenceId),proposed_grade:'A',requires_human_review:true,limitations:['Only the recorded link and conditions were tested.','Store-wide scope and revenue impact are unknown.']};
}
