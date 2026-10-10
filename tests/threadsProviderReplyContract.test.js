'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createThreadsProvider } = require('../app/providers/threadsProvider');

const account = { key: 'astel.u:threads', brand: 'astel.u', platform: 'threads',
  userId: 'owner-test-only', username: 'astel.u', accessToken: 'test-only-token' };

function build({ creationFails = false } = {}) {
  const calls = [];
  const adapter = {
    tokenManager: { getToken: () => 'test-only-token' },
    parseWebhook: () => [],
    async createReply(parentId, text) {
      calls.push({ stage: 'create', parentId, text });
      return creationFails ? null : 'new-container';
    },
    async publishReply(creationId) {
      calls.push({ stage: 'publish', creationId });
      return creationId === 'new-container'
        ? { status: 'published', id: 'new-reply' }
        : { status: 'failed', code: 24 };
    },
    async reply(parentId, text) {
      const id = await adapter.createReply(parentId, text);
      return id ? adapter.publishReply(id) : { status: 'failed' };
    },
  };
  const provider = createThreadsProvider({ account, adapterFactory: () => adapter,
    postPublisherFactory: () => ({ publishPost: async () => ({ status: 'unused' }) }),
    insightsAdapterFactory: () => ({}) });
  return { provider, calls, adapter };
}

for (const method of ['reply', 'publishReply']) {
  test(`Threads provider ${method} uses create(parent,text) then publish(creationId)`, async () => {
    const { provider, calls, adapter } = build();
    assert.deepEqual(await provider[method]('incoming-comment', 'Approved reply text'),
      { status: 'published', id: 'new-reply' });
    assert.deepEqual(calls, [
      { stage: 'create', parentId: 'incoming-comment', text: 'Approved reply text' },
      { stage: 'publish', creationId: 'new-container' },
    ]);
    assert.notEqual(provider.publishReply, adapter.publishReply,
      'public reply(parent,text) must not be replaced by the internal publish(containerId)');
    assert.equal(provider.tokenManager, adapter.tokenManager);
  });
  test(`Threads provider ${method} never publishes a comment ID after failed container creation`, async () => {
    const { provider, calls } = build({ creationFails: true });
    assert.equal((await provider[method]('incoming-comment', 'Text')).status, 'failed');
    assert.deepEqual(calls, [{ stage: 'create', parentId: 'incoming-comment', text: 'Text' }]);
  });
}

test('real composed Threads adapter sends both HTTP stages and only the new creation ID', () => {
  // Isolated process: the production provider and adapter run unchanged. Replace
  // node-fetch before importing them; no request can reach Meta or Redis.
  const script = String.raw`
    const assert = require('node:assert/strict');
    const calls = [];
    const fetchPath = require.resolve('node-fetch');
    require(fetchPath);
    require.cache[fetchPath].exports = async (value, opts) => {
      const url = new URL(value);
      const body = new URLSearchParams(opts.body || '');
      const param = name => body.get(name) || url.searchParams.get(name);
      calls.push({path:url.pathname, method:opts.method,
        parentId:param('reply_to_id'), creationId:param('creation_id'), text:param('text')});
      if (url.pathname.endsWith('/threads')) {
        assert.equal(param('reply_to_id'), 'incoming-comment');
        assert.equal(param('text'), 'Test reply');
        return {ok:true,status:200,json:async()=>({id:'new-container'})};
      }
      if (url.pathname.endsWith('/threads_publish')) {
        return param('creation_id') === 'new-container'
          ? {ok:true,status:200,json:async()=>({id:'new-reply'})}
          : {ok:false,status:400,json:async()=>({error:{code:24,error_subcode:4279010}})};
      }
      return {ok:false,status:403,json:async()=>({error:{code:10}})};
    };
    const originalTimer = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => originalTimer(fn, Math.min(ms, 2), ...args);
    console.log = () => {};
    console.error = () => {};
    const {createThreadsProvider} = require('./app/providers/threadsProvider');
    const provider = createThreadsProvider({account:{key:'astel.u:threads',platform:'threads',
      brand:'astel.u',username:'astel.u',userId:'owner-test-only',accessToken:'test-only-token'}});
    (async()=>{
      for (const method of ['reply','publishReply']) {
        calls.length=0;
        const result=await provider[method]('incoming-comment','Test reply');
        assert.deepEqual(result,{status:'published',id:'new-reply'});
        assert.equal(calls.length,2);
        assert.equal(calls[0].parentId,'incoming-comment');
        assert.equal(calls[1].creationId,'new-container');
        assert.notEqual(calls[1].creationId,calls[0].parentId);
      }
      process.stdout.write('REAL_ADAPTER_CONTRACT_OK');
    })().catch(e=>{process.stderr.write(e.stack);process.exitCode=1;});
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error || 'child failed'));
  assert.equal(result.stdout, 'REAL_ADAPTER_CONTRACT_OK');
});
