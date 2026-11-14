import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audit} from './extensions/models/audit_core.ts';
const now = Date.parse('2026-11-14T12:00:00Z');
const config = {projectId:'prj_demo',repository:'demo/app',vercelToken:'fake',githubToken:'fake'};
const deployment = {uid:'d1',created:now-10*86400000,target:null,meta:{githubCommitOrg:'demo',githubCommitRepo:'app',githubPrId:'1'}};
function mock(ds, pr, next=null) {return async url => ({ok:true,json:async()=>String(url).includes('api.vercel.com')?{deployments:ds,pagination:{next}}:pr});}
const closed = {number:1,state:'closed',closed_at:'2026-11-01T00:00:00Z',base:{repo:{full_name:'demo/app'}}};
test('closed PR beyond grace is a candidate',async()=>assert.equal((await audit(config,mock([deployment],closed),now)).candidates,1));
test('production remains protected',async()=>assert.equal((await audit(config,mock([{...deployment,target:'production'}],closed),now)).deployments[0].decision,'keep'));
test('open PR remains protected',async()=>assert.equal((await audit(config,mock([deployment],{...closed,state:'open'}),now)).candidates,0));
test('recent closure stays in grace period',async()=>assert.equal((await audit(config,mock([deployment],{...closed,closed_at:new Date(now-3600000).toISOString()}),now)).candidates,0));
test('missing metadata needs review',async()=>assert.equal((await audit(config,mock([{...deployment,meta:{}}],closed),now)).deployments[0].decision,'review'));
test('wrong repository cannot qualify',async()=>assert.equal((await audit(config,mock([deployment],{...closed,base:{repo:{full_name:'other/app'}}}),now)).candidates,0));
test('page cap marks incomplete inventory',async()=>assert.equal((await audit({...config,maxPages:1},mock([deployment],closed,100),now)).complete,false));
test('API failure rejects report',async()=>assert.rejects(()=>audit(config,async()=>({ok:false,status:403}),now)));
