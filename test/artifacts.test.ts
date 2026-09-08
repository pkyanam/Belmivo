import test from 'node:test';
import assert from 'node:assert/strict';
import { linkedArtifacts } from '../src/artifacts.js';
test('only explicit final Markdown links beneath configured output directory are candidates',()=>{
  const text='![a](/safe/out/image.png) [doc](</safe/out/My Report.pdf>) [secret](/safe/out/../secret) [wrong](/safe/outside/a.png) [web](https://example.com/a.png) /safe/out/plain.txt';
  assert.deepEqual(linkedArtifacts(text,'/safe/out'),['/safe/out/image.png','/safe/out/My Report.pdf']);
  assert.deepEqual(linkedArtifacts(text),[]);
});
