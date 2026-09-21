/** Dependency-free handoff consistency checks; NOT application E2E or a full OpenAPI validator. */
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import {resolve,relative,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const read=p=>readFileSync(resolve(root,p),'utf8');
const json=p=>JSON.parse(read(p));
let checks=0;function check(label,test){assert.ok(test,label);checks++;}
const required=['README.md','START_HERE.md','AGENTS.md','CLAUDE.md','BUILD_SPEC.md','IMPLEMENTATION_PLAN.md','PROGRESS.md','VERIFICATION.md','HANDBOOK.html','design/DESIGN_BRIEF.md','design/UI_SPEC.md','design/preview.html','contracts/openapi.json','contracts/domain.schema.json','db/001_core.sql','tasks/M1_ONE_REAL_JOURNEY.md','scripts/preview-server.mjs'];
for(const p of required)check('required file: '+p,existsSync(resolve(root,p)));
function walk(dir){return readdirSync(dir).flatMap(n=>{const p=resolve(dir,n);return statSync(p).isDirectory()?walk(p):[p]});}
for(const p of walk(root)){
 const rel=relative(root,p);check('no font file: '+rel,!['.woff','.woff2','.ttf','.otf'].includes(extname(p).toLowerCase()));
 check('no dependency/secrets folder: '+rel,!rel.split(/[\\/]/).some(v=>v==='node_modules'||v==='.env'||v==='.git'));
 if(p.endsWith('.json')){JSON.parse(readFileSync(p,'utf8'));checks++;}
}
const spec=json('contracts/openapi.json');check('OpenAPI version',spec.openapi==='3.1.1');
function resolvePointer(doc,ref){check('local reference only',ref.startsWith('#/'));let cur=doc;for(const token of ref.slice(2).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~')))cur=cur?.[token];check('resolved '+ref,cur!==undefined);}
function refs(x,doc){if(!x||typeof x!=='object')return;if(x.$ref)resolvePointer(doc,x.$ref);for(const v of Object.values(x))refs(v,doc);}
refs(spec,spec);const domain=json('contracts/domain.schema.json');refs(domain,domain);
const ids=new Set();let operations=0;
for(const [path,item] of Object.entries(spec.paths))for(const [method,op] of Object.entries(item)){
 if(!['get','post','put','patch','delete','head','options'].includes(method))continue;operations++;
 check('unique operationId '+op.operationId,op.operationId&&!ids.has(op.operationId));ids.add(op.operationId);
 check('responses exist '+path,Object.keys(op.responses??{}).length>0);
 const params=[...(item.parameters??[]),...(op.parameters??[])].map(p=>p.$ref?spec.components.parameters[p.$ref.split('/').at(-1)]:p);
 for(const m of path.matchAll(/\{([^}]+)\}/g))check('path parameter '+m[1],params.some(p=>p.name===m[1]&&p.in==='path'&&p.required===true));
}
const machines=json('contracts/state-machines.json').machines;
for(const [name,m]of Object.entries(machines))for(const [state,targets]of Object.entries(m))for(const t of targets)check('state edge '+name+':'+state+'→'+t,Object.hasOwn(m,t));
const cfg=json('config/ventures.json');for(const key of ['automatic_outreach','automatic_production_writes','automatic_topups','live_capture_enabled','public_intake_enabled'])check('safe default '+key,cfg.defaults[key]===false);
check('zero default live budget',cfg.defaults.live_spend_limit_micro==='0');
for(const v of cfg.ventures)check('no live venture '+v.id,v.live_enabled===false);
for(const o of json('config/offer-catalog.json').offers)check('no approved invented price '+o.sku,o.enabled===false&&o.price_minor===null);
check('Claude imports common rules',read('CLAUDE.md').includes('@AGENTS.md'));
check('prototype labelled synthetic',read('design/preview.html').includes('SYNTHETIC FIXTURES'));
check('SQL candidate labelled',read('db/001_core.sql').includes('INITIAL SCHEMA CANDIDATE'));
console.log(`${checks} handoff structural checks passed; ${operations} API operations checked. Not an app readiness claim.`);
