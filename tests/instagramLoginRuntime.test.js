const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createInstagramProvider } = require('../app/providers/instagramProvider');
const { loadSocialAccounts } = require('../app/accounts/accountConfig');

test('RU Instagram Login keeps account-scoped host and validates returned identity with bearer auth', async () => {
  const env = { THREADS_USERNAME:'astel.u', INSTAGRAM_USERNAME:'astel.u',
    INSTAGRAM_USER_ID:'ig-ru', INSTAGRAM_ACCESS_TOKEN:'fixture-only', INSTAGRAM_AUTH_MODE:'instagram_login', INSTAGRAM_ENABLED:'true' };
  const account = loadSocialAccounts(env).find(a=>a.platform==='instagram');
  const calls=[];
  const provider=createInstagramProvider({account,fetchImpl:async(url,opts)=>{
    calls.push({url,opts});
    return {ok:true,status:200,json:async()=>({id:'scoped-id',user_id:'ig-ru',username:'astel.u',account_type:'BUSINESS',media_count:2})};
  }});
  assert.equal(provider.health().authMode,'instagram_login');
  assert.deepEqual((await provider.getAccountIdentity()).identity,{
    id:'scoped-id',userId:'ig-ru',username:'astel.u',accountType:'BUSINESS',mediaCount:2,
  });
  assert.match(calls[0].url,/^https:\/\/graph\.instagram\.com\/v26\.0\/me\?/);
  assert.doesNotMatch(calls[0].url,/fixture-only/);
  assert.equal(calls[0].opts.headers.Authorization,'Bearer fixture-only');
});

test('RU runtime wraps the original full Meta/Threads startup and exports its handlers unchanged', () => {
  const result=spawnSync(process.execPath,['-e',`
    const assert=require('node:assert/strict');
    let starts=0;const routes=[];
    const base={app:{get:(path,fn)=>routes.push([path,fn])},start:async()=>{starts++},
      handleThreadsWebhook:()=>{},handleSecondaryWebhook:()=>{},durable:{marker:true}};
    require.cache[require.resolve('./server-meta')]={id:require.resolve('./server-meta'),filename:require.resolve('./server-meta'),loaded:true,exports:base};
    require.cache[require.resolve('./server')]={id:require.resolve('./server'),filename:require.resolve('./server'),loaded:true,exports:{socialContext:{providers:{list:()=>[{platform:'threads'}]}}}};
    const runtime=require('./server-instagram-runtime');
    assert.equal(runtime.handleThreadsWebhook,base.handleThreadsWebhook);
    assert.equal(runtime.durable,base.durable);
    assert.equal(runtime.instagramPollers.length,0);
    assert.equal(routes[0][0],'/health/instagram-polling');
    runtime.start().then(()=>{assert.equal(starts,1)}).catch(()=>process.exit(1));
  `],{cwd:require('node:path').resolve(__dirname,'..'),env:{PATH:process.env.PATH,NODE_ENV:'test'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('Instagram Login flat webhook entries preserve owner filtering and comment identity', () => {
  const {createInstagramAdapter}=require('../adapters/instagramAdapter');
  const adapter=createInstagramAdapter({userId:'ig-ru',accountKey:'astel.u:instagram',authMode:'instagram_login'});
  const event={field:'comments',value:{id:'comment-1',text:'Hello',from:{id:'visitor'},media:{id:'media-1'}}};
  const events=adapter.parseWebhook({object:'instagram',entry:[{id:'wrong-owner',...event},{id:'ig-ru',...event}]});
  assert.equal(events.length,1);assert.equal(events[0].sourceId,'comment-1');
  assert.equal(events[0].accountKey,'astel.u:instagram');assert.equal(events[0].rootId,'media-1');
});
