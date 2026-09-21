#!/usr/bin/env python3
"""Optional JSON Schema check. Needs jsonschema (authoring check used 4.x).
This is not a full OpenAPI validator or a live authorization/database test.
"""
from pathlib import Path
import json, copy, sys
try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    raise SystemExit('Optional check requires Python package jsonschema; Node reference tests have no dependencies.')
ROOT = Path(__file__).resolve().parents[1]
domain = json.loads((ROOT/'contracts/domain.schema.json').read_text())
Draft202012Validator.check_schema(domain)
checks=[]
for name,schema in domain['$defs'].items():
    Draft202012Validator.check_schema(schema)
    checks.append({'check':'schema structure: '+name,'passed':True})
def check_instance(name, schema, value, expect_valid):
    wrapped={'$schema':domain['$schema'],'$defs':domain['$defs'],'$ref':'#/$defs/'+schema}
    errors=list(Draft202012Validator(wrapped,format_checker=FormatChecker()).iter_errors(value))
    passed=(not errors)==expect_valid
    checks.append({'check':name,'passed':passed})
    if not passed:
        raise AssertionError(name+': '+('; '.join(e.message for e in errors) or 'unexpectedly accepted'))
index=json.loads((ROOT/'contracts/examples/index.json').read_text())
examples={}
for e in index['examples']:
    value=json.loads((ROOT/'contracts/examples'/e['file']).read_text())
    examples[e['file']]=value
    check_instance('valid example: '+e['file'],e['schema'],value,True)
def negative(name,file,schema,mutate):
    value=copy.deepcopy(examples[file]);mutate(value);check_instance(name,schema,value,False)
negative('body tenant spoof rejected','create-scan.json','CreateScan',lambda x:x.update(tenant_id='untrusted'))
negative('more than five pages rejected','create-scan.json','CreateScan',lambda x:x.update(max_unique_pages=6))
negative('M1 unsupported detector rejected','create-scan.json','CreateScan',lambda x:x.update(detectors=['MF-DATA-01']))
negative('invalid UUID rejected','create-scan.json','CreateScan',lambda x:x.update(account_id='bad'))
negative('floating money rejected','create-scan.json','CreateScan',lambda x:x['max_cost'].update(amount_micro=0.1))
negative('negative money rejected','create-scan.json','CreateScan',lambda x:x['max_cost'].update(amount_micro='-1'))
negative('confirmed without proof rejected','confirmed-finding.json','Finding',lambda x:x.update(evidence_ids=[]))
negative('confirmed without reviewer rejected','confirmed-finding.json','Finding',lambda x:x.update(reviewer_id=None))
negative('confirmed without reviewed date rejected','confirmed-finding.json','Finding',lambda x:x.update(reviewed_at=None))
negative('confirmed weak grade rejected','confirmed-finding.json','Finding',lambda x:x.update(evidence_grade='C'))
negative('review without acknowledged limits rejected','review-finding.json','ReviewFinding',lambda x:x.update(acknowledged_limitations=False))
negative('review zero version rejected','review-finding.json','ReviewFinding',lambda x:x.update(expected_version=0))
negative('brief review reason rejected','review-finding.json','ReviewFinding',lambda x:x.update(reason='ok'))
negative('public audience rejected at M1','draft-report.json','Report',lambda x:x.update(audience='public'))
negative('invented scan state rejected','blocked-scan.json','Scan',lambda x:x.update(state='all-good'))
print(f'{len(checks)} JSON Schema structure/example checks passed.')
if '--write-report' in sys.argv:
    (ROOT/'verification/contract-checks.json').write_text(json.dumps({'scope':'JSON Schema structure plus positive/negative examples, NOT full OpenAPI compliance or semantic application authorization.','checks':checks},indent=2)+'\n')
