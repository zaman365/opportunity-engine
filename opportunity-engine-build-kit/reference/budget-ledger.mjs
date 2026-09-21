/**
 * IMMUTABLE IN-MEMORY REFERENCE ONLY. Does not provide persistent/concurrent enforcement.
 * Production: authoritative transaction locks, complete server-resolved scope hierarchy,
 * restricted database grants, provider reconciliation, owner policy and API authentication.
 */
import {micro,currency} from './money.mjs';
export class LedgerError extends Error {constructor(code,message){super(message);this.code=code;}}
function fail(code,message){throw new LedgerError(code,message);}
function id(v,name){if(typeof v!=='string'||!v.trim())fail('INVALID_INPUT',`${name} required`);return v;}
function scopes(ids){if(!Array.isArray(ids)||!ids.length||ids.some(v=>typeof v!=='string'||!v.trim())||new Set(ids).size!==ids.length)fail('INVALID_SCOPE','Unique budget IDs required.');return [...ids].sort();}
function stateCopy(ledger){if(!ledger||!Array.isArray(ledger.budgets)||!Array.isArray(ledger.reservations))fail('INVALID_LEDGER','Invalid reference ledger.');return structuredClone(ledger);}
function matching(a,b){return JSON.stringify(a)===JSON.stringify(b);}
export function reserve(ledger,{operationKey,requestHash,amount,currency:ccy,budgetIds,requiredBudgetIds}) {
  id(operationKey,'operationKey');id(requestHash,'requestHash');currency(ccy);const n=micro(amount);
  const ids=scopes(budgetIds),required=scopes(requiredBudgetIds);
  if(!matching(ids,required))fail('MISSING_BUDGET','Caller omitted or substituted an authoritative scope.');
  const copy=stateCopy(ledger);
  const prior=copy.reservations.find(x=>x.operationKey===operationKey);
  if(prior){
    if(!matching([prior.requestHash,prior.amount,prior.currency,prior.budgetIds],[requestHash,amount,ccy,ids]))fail('IDEMPOTENCY_CONFLICT','Operation key reused with different input.');
    return {ledger:copy,reservation:prior,replayed:true};
  }
  const chosen=ids.map(i=>copy.budgets.find(b=>b.id===i));
  if(chosen.some(b=>!b))fail('UNKNOWN_BUDGET','Missing required budget.');
  for(const b of chosen){
    if(currency(b.currency)!==ccy)fail('CURRENCY_MISMATCH','No implicit FX conversion.');
    if(b.paused)fail('BUDGET_PAUSED','Budget paused.');
    if(micro(b.settled)+micro(b.reserved)+n>micro(b.limit))fail('BUDGET_EXCEEDED','Reservation exceeds a scope cap.');
  }
  for(const b of chosen)b.reserved=(micro(b.reserved)+n).toString();
  const r={operationKey,requestHash,amount,currency:ccy,budgetIds:ids,state:'reserved',actual:null};
  copy.reservations.push(r);return {ledger:copy,reservation:r,replayed:false};
}
export function markUncertain(ledger,operationKey){
  const copy=stateCopy(ledger),r=copy.reservations.find(x=>x.operationKey===operationKey);
  if(!r)fail('UNKNOWN_RESERVATION','No reservation.');
  if(r.state==='uncertain')return copy;
  if(r.state!=='reserved')fail('INVALID_TRANSITION','Only reserved cost can become uncertain.');
  r.state='uncertain';return copy;
}
export function settle(ledger,{operationKey,actual}){
  const n=micro(actual),copy=stateCopy(ledger),r=copy.reservations.find(x=>x.operationKey===operationKey);
  if(!r)fail('UNKNOWN_RESERVATION','No reservation.');
  if(r.state==='settled'){
    if(r.actual!==actual)fail('IDEMPOTENCY_CONFLICT','Settlement amount changed.');
    return {ledger:copy,replayed:true,overrun:n>micro(r.amount)};
  }
  if(!['reserved','uncertain'].includes(r.state))fail('INVALID_TRANSITION','Cannot settle released cost.');
  const overrun=n>micro(r.amount);
  for(const bid of r.budgetIds){
    const b=copy.budgets.find(x=>x.id===bid);
    if(!b||micro(b.reserved)<micro(r.amount))fail('LEDGER_CORRUPT','Reservation allocation missing.');
    b.reserved=(micro(b.reserved)-micro(r.amount)).toString();
    b.settled=(micro(b.settled)+n).toString();
    if(overrun||micro(b.settled)+micro(b.reserved)>micro(b.limit))b.paused=true;
  }
  r.actual=actual;r.state='settled';return {ledger:copy,replayed:false,overrun};
}
export function release(ledger,{operationKey,confirmedNoCharge}){
  if(confirmedNoCharge!==true)fail('RECONCILIATION_REQUIRED','Cancellation does not prove zero provider charge.');
  const copy=stateCopy(ledger),r=copy.reservations.find(x=>x.operationKey===operationKey);
  if(!r)fail('UNKNOWN_RESERVATION','No reservation.');
  if(r.state==='released')return copy;
  if(!['reserved','uncertain'].includes(r.state))fail('INVALID_TRANSITION','Settled cost cannot be released.');
  for(const bid of r.budgetIds){
    const b=copy.budgets.find(x=>x.id===bid);
    if(!b||micro(b.reserved)<micro(r.amount))fail('LEDGER_CORRUPT','Reservation allocation missing.');
    b.reserved=(micro(b.reserved)-micro(r.amount)).toString();
  }
  r.state='released';return copy;
}
