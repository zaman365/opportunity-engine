import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreOpportunity, aggregateNeed, checkActionReadiness, contributionScenario } from './scoring.mjs';
const example = {fit:.9, need:.85, deliverability:.9, timing:.5, value:.7};

test('worked priority example is 80.5, not a close probability', () => {
  const result = scoreOpportunity(example);
  assert.equal(result.pointScore, 80.5);
  assert.equal(result.weightedCoverage, 1);
  assert.equal(result.rankable, true);
});
test('unknown timing yields interval and no point score', () => {
  const r = scoreOpportunity({...example, timing:null});
  assert.equal(r.pointScore, null);
  assert.equal(r.lowerBound, 73);
  assert.equal(r.upperBound, 88);
  assert.equal(r.weightedCoverage, .85);
  assert.equal(r.rankable, false);
});
test('all unknown inputs remain fully unknown', () => {
  const r = scoreOpportunity({fit:null,need:null,deliverability:null,timing:null,value:null});
  assert.equal(r.lowerBound,0); assert.equal(r.upperBound,100); assert.equal(r.pointScore,null);
});
test('missing inputs must be explicit nulls', () => assert.throws(() => scoreOpportunity({fit:1}), /Missing/));
test('reject unknown factor names', () => assert.throws(() => scoreOpportunity({...example, urgency:1}), /Unknown dimensions/));
for (const invalid of [-.1,1.1,NaN,Infinity,'0.5',undefined]) {
  test(`reject invalid dimension ${String(invalid)}`, () => assert.throws(() => scoreOpportunity({...example, fit:invalid})));
}
test('root cause deduplication prevents error-count inflation', () => {
  const repeated = Array.from({length:200}, () => ({rootCauseKey:'one-template',severity:.8}));
  const r = aggregateNeed(repeated);
  assert.equal(r.need,.8); assert.equal(r.rootCauseCount,1);
});
test('aggregate top three independent root causes with cap', () => {
  assert.equal(aggregateNeed([{rootCauseKey:'a',severity:.8},{rootCauseKey:'b',severity:.6},{rootCauseKey:'c',severity:.5}]).need,1);
});
test('max severity per root cause is used', () => {
  assert.equal(aggregateNeed([{rootCauseKey:'a',severity:.2},{rootCauseKey:'a',severity:.8}]).need,.8);
});
test('empty supplied findings have zero observed need, not a whole-site healthy verdict', () => assert.equal(aggregateNeed([]).need,0));
test('invalid finding root cause rejected', () => assert.throws(() => aggregateNeed([{rootCauseKey:'',severity:.8}])));
test('invalid severity rejected', () => assert.throws(() => aggregateNeed([{rootCauseKey:'a',severity:NaN}])));

const ready = {
  action:'publish_report', evidenceGrade:'A', evidenceFresh:true, humanApproved:true, budgetAvailable:true,
  now:'2026-09-21T12:00:00Z',
  policyRecord:{decision:'allow',action:'publish_report',version:'approved-policy-v1',expiresAt:'2026-09-22T12:00:00Z'}
};
test('fully approved reference action is ready', () => assert.equal(checkActionReadiness(ready).allowed,true));
test('unknown permission blocks even strong evidence', () => assert.equal(checkActionReadiness({...ready, policyRecord:null}).allowed,false));
test('report permission never implies contact permission', () => assert.ok(checkActionReadiness({...ready,action:'contact'}).blockers.includes('policy_action_mismatch')));
test('expired permission blocks action', () => assert.ok(checkActionReadiness({...ready, now:'2026-09-23T00:00:00Z'}).blockers.includes('policy_expired_or_invalid')));
test('grade B is review-only', () => assert.equal(checkActionReadiness({...ready,evidenceGrade:'B'}).allowed,false));
test('stale evidence blocks', () => assert.equal(checkActionReadiness({...ready,evidenceFresh:false}).allowed,false));
test('no approval blocks', () => assert.equal(checkActionReadiness({...ready,humanApproved:false}).allowed,false));
test('no budget blocks', () => assert.equal(checkActionReadiness({...ready,budgetAvailable:false}).allowed,false));
test('invalid date rejected', () => assert.throws(() => checkActionReadiness({...ready,now:'not a date'})));

const costs = {orders:5,netPrice:790,deliveryCostPerOrder:320,acquisitionCost:855};
test('five-order illustrative scenario matches blueprint', () => {
  const r = contributionScenario(costs);
  assert.equal(r.unitContribution,470); assert.equal(r.resultBeforeTax,1495); assert.equal(r.breakEvenOrders,2);
});
test('two-order scenario leaves only 85 before omitted costs', () => assert.equal(contributionScenario({...costs,orders:2}).resultBeforeTax,85));
test('amortized build cost changes break-even', () => assert.equal(contributionScenario({...costs,allocatedBuildCost:1000}).breakEvenOrders,4));
test('loss-making unit contribution has no positive break-even count', () => assert.equal(contributionScenario({...costs,deliveryCostPerOrder:800}).breakEvenOrders,null));
test('reject negative or non-finite costs', () => assert.throws(() => contributionScenario({...costs,acquisitionCost:Infinity})));
test('reject fractional orders', () => assert.throws(() => contributionScenario({...costs,orders:1.5})));
