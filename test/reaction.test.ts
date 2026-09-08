import test from 'node:test';
import assert from 'node:assert/strict';
import { extractReaction } from '../src/reaction.js';

test('only a single trailing native reaction directive nominates a tapback',()=>{
  for(const reaction of ['like','love','laugh','emphasize','question','dislike']) {
    assert.deepEqual(extractReaction(`Great news!\r\n[[imessage-reaction:${reaction}]]\r\n`),{text:'Great news!\n',reaction,hadDirective:true});
  }
  assert.deepEqual(extractReaction('Plain answer.'),{text:'Plain answer.',hadDirective:false});
  for(const raw of [
    'Answer\n[[imessage-reaction:custom]]',
    'Answer\n[[imessage-reaction:Like]]',
    '[[imessage-reaction:like]]\nMore prose',
    'Answer\n[[imessage-reaction:like]]\n[[imessage-reaction:love]]',
  ]) {
    const result=extractReaction(raw);
    assert.equal(result.reaction,undefined);assert.equal(result.hadDirective,true);
    assert.equal(result.text.includes('[[imessage-reaction:'),false);
  }
});

test('quoted, escaped, inline, indented and fenced examples stay literal',()=>{
  const directive='[[imessage-reaction:like]]';
  for(const raw of [
    `Example: ${directive}`,`> ${directive}`,`\\${directive}`,`    ${directive}`,
    `\`\`\`text\n${directive}\n\`\`\``,`~~~text\n${directive}\n~~~`,
    `\`\`\`\`text\n\`\`\`\n${directive}\n\`\`\`\``,
    `~~~\n${directive}`,
  ])assert.deepEqual(extractReaction(raw),{text:raw,hadDirective:false});
});

test('a real directive after a fenced example is distinct from the example',()=>{
  const text='```text\n[[imessage-reaction:like]]\n```\nDone.';
  assert.deepEqual(extractReaction(`${text}\n[[imessage-reaction:laugh]]`),{text,reaction:'laugh',hadDirective:true});
});
