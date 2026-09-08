import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseConfig, validateConfig } from '../src/config.js';
import { matchesExternalHandoff, validateExternalHandoff } from '../src/external-handoff.js';
import type { InboundMessage } from '../src/types.js';

const text = '/cancel';
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const scope = {provider: 'photon' as const, allowedSenders: ['+15555550101'], serviceNumber: 'shared'};
const selector = () => ({provider: 'photon', sender: scope.allowedSenders[0]!, recipient: 'shared', conversationId: 'fixture-conversation', textSha256: hash(text)});
const input = () => ({version: 1, selectors: [selector()]});
const message = (): InboundMessage => ({provider: 'photon', eventId: 'event', messageId: 'message', conversationId: 'fixture-conversation', sender: scope.allowedSenders[0]!, recipient: 'shared', text, isGroup: false, attachments: []});
const checkInvalid = (value: unknown) => assert.throws(() => validateExternalHandoff(value, scope), error => error instanceof Error && error.message === 'Invalid external handoff configuration.');
const configInput = () => ({provider: 'photon', allowedSenders: [...scope.allowedSenders], serviceNumber: 'shared', allowSharedSandbox: true,
  providerApiKey: 'synthetic-project', providerApiSecret: 'synthetic-secret', webhookSecret: 'synthetic-webhook-secret', cwd: '/tmp', dataDir: '/tmp', fullAccess: true});

test('handoff requires all exact route fields, direct chat and no attachment', () => {
  const config = validateExternalHandoff(input(), scope);
  assert.equal(matchesExternalHandoff(config, message()), true);
  for (const patch of [{provider: 'linq'}, {sender: '+15555550102'}, {recipient: '+15555550103'}, {conversationId: 'fixture-conversation '},
    {isGroup: true}, {isGroup: undefined}, {attachments: [{url: 'https://example.test/a'}]}, {attachments: undefined}]) {
    assert.equal(matchesExternalHandoff(config, {...message(), ...patch} as InboundMessage), false);
  }
});

test('hash covers exact parser text without trimming, case or Unicode normalization', () => {
  const body = 'é\n'; const config = validateExternalHandoff({version: 1, selectors: [{...selector(), textSha256: hash(body)}]}, scope);
  assert.equal(matchesExternalHandoff(config, {...message(), text: body}), true);
  for (const near of ['e\u0301\n', 'é', 'é\r\n', 'É\n', ' é\n', 'é\n ']) assert.equal(matchesExternalHandoff(config, {...message(), text: near}), false);
});

test('matching every identical-text event is independent of event and message IDs', () => {
  const config = validateExternalHandoff(input(), scope);
  for (let n = 0; n < 3; n++) assert.equal(matchesExternalHandoff(config, {...message(), eventId: `event-${n}`, messageId: `message-${n}`}), true);
});

test('absence and explicit empty selectors preserve normal admission', () => {
  assert.equal(matchesExternalHandoff(undefined, message()), false);
  assert.equal(matchesExternalHandoff(validateExternalHandoff({version: 1, selectors: []}, scope), message()), false);
  assert.equal(parseConfig(configInput()).externalHandoff, undefined);
});

test('two distinct selectors match independently but duplicates and a third are rejected', () => {
  const first = selector(), second = {...first, textSha256: hash('second')};
  const config = validateExternalHandoff({version: 1, selectors: [first, second]}, scope);
  assert.equal(matchesExternalHandoff(config, {...message(), text: 'second'}), true);
  checkInvalid({version: 1, selectors: [first, {...first}]});
  checkInvalid({version: 1, selectors: [first, second, {...first, conversationId: 'third'}]});
});

test('strict outer shape rejects coerced values, unknown fields and non-records', () => {
  for (const bad of [undefined, null, [], 1, 'private-marker', {version: '1', selectors: []}, {version: 1, selectors: {}},
    {...input(), rawText: 'private-marker'}, {selectors: []}, Object.assign(new Date(), input())]) checkInvalid(bad);
});

test('strict selector shape and configured scope reject broadened routes and raw matching rules', () => {
  for (const patch of [{provider: ['photon']}, {provider: 'linq'}, {sender: ['+15555550101']}, {sender: '*'}, {sender: '+15555550102'},
    {recipient: '*'}, {recipient: '+15555550103'}, {conversationId: []}, {textSha256: hash(text).toUpperCase()}, {textSha256: '0'.repeat(63)},
    {rawText: text}, {pattern: '.*'}, {expiresAt: 100}]) checkInvalid({version: 1, selectors: [{...selector(), ...patch}]});
  assert.throws(() => validateExternalHandoff(input(), {...scope, provider: 'linq'}));
  const missing = {...selector()} as Partial<ReturnType<typeof selector>>; delete missing.textSha256;
  checkInvalid({version: 1, selectors: [missing]});
});

test('conversation boundaries accept 512 characters and reject empty or control-bearing IDs', () => {
  validateExternalHandoff({version: 1, selectors: [{...selector(), conversationId: 'x'.repeat(512)}]}, scope);
  for (const conversationId of ['', 'x'.repeat(513), 'x\n', 'x\0', 'x\u007f', 'x\u0085']) checkInvalid({version: 1, selectors: [{...selector(), conversationId}]});
});

test('dedicated recipient is accepted only when identical to the configured service', () => {
  const recipient = '+15555550103';
  const config = validateExternalHandoff({version: 1, selectors: [{...selector(), recipient}]}, {...scope, serviceNumber: recipient});
  assert.equal(matchesExternalHandoff(config, {...message(), recipient}), true);
  assert.equal(matchesExternalHandoff(config, message()), false);
});

test('validation copies and freezes every selector boundary', () => {
  const original = input(); const normalized = validateExternalHandoff(original, scope);
  original.selectors[0]!.textSha256 = hash('changed'); original.selectors.push({...selector(), conversationId: 'other'});
  assert.equal(normalized.selectors.length, 1); assert.equal(matchesExternalHandoff(normalized, message()), true);
  assert.equal(Object.isFrozen(normalized), true); assert.equal(Object.isFrozen(normalized.selectors), true); assert.equal(Object.isFrozen(normalized.selectors[0]), true);
  assert.throws(() => { (normalized.selectors[0] as {sender: string}).sender = '+15555550102'; }, TypeError);
});

test('private JSON validation never evaluates object accessors or symbol extras', () => {
  let called = false; const accessor = {...input()}; Object.defineProperty(accessor, 'selectors', {get() { called = true; return []; }});
  checkInvalid(accessor); assert.equal(called, false);
  checkInvalid({...input(), [Symbol('extra')]: 'private-marker'});
});

test('startup rejects malformed handoff and retains only frozen normalized config', () => {
  const original = input(); const parsed = parseConfig({...configInput(), externalHandoff: original});
  assert.notEqual(parsed.externalHandoff, original); assert.equal(Object.isFrozen(parsed.externalHandoff), true);
  original.selectors[0]!.sender = '+15555550102';
  assert.equal(matchesExternalHandoff(parsed.externalHandoff, message()), true);
  assert.throws(() => parseConfig({...configInput(), externalHandoff: {...input(), version: '1'}}), /Invalid external handoff configuration/);
  assert.throws(() => parseConfig({...configInput(), allowSharedSandbox: false, externalHandoff: input()}), /serviceNumber/);
  const direct = parseConfig(configInput()); direct.externalHandoff = input() as unknown as typeof direct.externalHandoff; validateConfig(direct);
  assert.equal(Object.isFrozen(direct.externalHandoff), true);
});
