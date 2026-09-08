import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.js';

test('slash commands are exact single-line inputs with bounded arguments',()=>{
  assert.deepEqual(parseCommand(' /help '),{kind:'help'});
  assert.deepEqual(parseCommand('/new Trip planning'),{kind:'new',title:'Trip planning'});
  assert.deepEqual(parseCommand('/new'),{kind:'new',title:'New task'});
  assert.deepEqual(parseCommand('/switch 2'),{kind:'switch',number:2});
  for(const value of ['/help more','/switch -1','/switch 0','/switch 2e1','/switch','/new '+'x'.repeat(81),'/unknown'])assert.equal(parseCommand(value)?.kind,'invalid');
  for(const value of ['//help','/tmp/file.txt','Explain /new','```\n/help\n```','/new title\nrun something'])assert.equal(parseCommand(value),undefined);
});
