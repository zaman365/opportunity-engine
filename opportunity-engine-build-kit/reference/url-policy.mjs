/**
 * Syntax + exact-host allowlist PREFLIGHT ONLY, NOT complete SSRF protection.
 * Production must enforce destination IP, redirect/subrequest and DNS/egress checks.
 * No network requests are made here. Fixtures need separate local-only transport.
 */
import {isIP} from 'node:net';
export function preflightTarget(raw,allowedHosts=[]){
  if(typeof raw!=='string'||raw.length>4096||/[\u0000-\u0020\u007f]/.test(raw))return {allowed:false,reason:'invalid_url'};
  let u;try{u=new URL(raw);}catch{return {allowed:false,reason:'invalid_url'};}
  if(u.protocol!=='https:')return {allowed:false,reason:'https_required'};
  if(u.username||u.password)return {allowed:false,reason:'embedded_credentials'};
  if(u.port&&u.port!=='443')return {allowed:false,reason:'unsupported_port'};
  const host=u.hostname.toLowerCase().replace(/\.$/,'');
  const bare=host.replace(/^\[|\]$/g,'');
  if(isIP(bare)||host.includes(':'))return {allowed:false,reason:'ip_literal_denied'};
  if(!host.includes('.')||/(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host))return {allowed:false,reason:'nonpublic_hostname'};
  if(!/^[a-z0-9.-]+$/.test(host)||host.split('.').some(s=>!s||s.length>63||s.startsWith('-')||s.endsWith('-')))return {allowed:false,reason:'invalid_hostname'};
  if(!Array.isArray(allowedHosts)||!allowedHosts.map(h=>String(h).toLowerCase().replace(/\.$/,'')).includes(host))return {allowed:false,reason:'host_not_approved'};
  if([...u.searchParams.keys()].some(k=>/^(token|access_token|auth|authorization|password|secret|api_key|key|session|code)$/i.test(k)))return {allowed:false,reason:'sensitive_query'};
  if(/(?:^|[\/_.-])(cart|checkout|logout|delete|remove|add-to-cart|action|account)(?:$|[\/_.-])/i.test(decodeURIComponentSafe(u.pathname)))return {allowed:false,reason:'potential_state_change'};
  u.hostname=host;u.hash='';return {allowed:true,url:u.href,host,networkValidationRequired:true};
}
function decodeURIComponentSafe(v){try{return decodeURIComponent(v);}catch{return v;}}
