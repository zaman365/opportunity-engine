import test from 'node:test';
import assert from 'node:assert/strict';
import {transition, MACHINES} from './state-machine.mjs';
for (const [kind, states] of Object.entries(MACHINES)) {
  test(`${kind}: all declared transitions are legal`,()=>{
    for(const [state,targets] of Object.entries(states)) for(const next of targets)
      assert.deepEqual(transition({kind,state,version:3,expectedVersion:3,next}),{kind,state:next,version:4});
  });
  test(`${kind}: undeclared transitions rejected`,()=>{
    for(const [state,targets] of Object.entries(states)) for(const next of Object.keys(states))
      if(!targets.includes(next)) assert.throws(()=>transition({kind,state,version:1,expectedVersion:1,next}),e=>e.code==='INVALID_TRANSITION');
  });
}
test('stale human review cannot overwrite newer decision',()=>assert.throws(()=>transition({kind:'finding',state:'candidate',version:4,expectedVersion:3,next:'confirmed'}),e=>e.code==='VERSION_CONFLICT'));
test('unknown machine rejected',()=>assert.throws(()=>transition({kind:'imaginary',state:'queued',next:'succeeded',version:1,expectedVersion:1})));
test('versions must be positive integers',()=>assert.throws(()=>transition({kind:'scan',state:'queued',next:'validating',version:0,expectedVersion:0})));
test('scan completion does not imply finding confirmation',()=>assert.equal(transition({kind:'scan',state:'analysing',next:'succeeded',version:3,expectedVersion:3}).kind,'scan'));
