import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReply } from '../src/reply.js';

const options = { artifactsDir: '/safe/out', mediaSupported: true };

test('screenshot regression: generated image Markdown and Mac path disappear while file remains a delivery candidate', () => {
  const result = formatReply('## Your image\n\n**Here you go!**\n![Generated landscape](/safe/out/landscape.png)', options);
  assert.equal(result.text, 'Your image\n\nHere you go!\n');
  assert.deepEqual(result.files, ['/safe/out/landscape.png']);
  assert.equal(result.text.includes('/safe/out'), false);
  assert.equal(result.text.includes('!['), false);
  assert.equal(result.text.includes('**'), false);
});

test('local document links retain useful labels without claiming delivery or exposing local paths', () => {
  const result = formatReply('Here is [the report](/safe/out/report.pdf).\n[](/safe/out/data.csv)', options);
  assert.equal(result.text, 'Here is the report.\ndata.csv');
  assert.deepEqual(result.files, ['/safe/out/report.pdf', '/safe/out/data.csv']);
  assert.equal(/attached|delivered|sent/i.test(result.text), false);
});

test('space and balanced or escaped parentheses identify the same candidate and remove its entire link', () => {
  const result = formatReply('![A](/safe/out/My Image (final).png)\n[B](</safe/out/My Report (v2).pdf>)\n![C](/safe/out/escaped\\(name\\).png)', options);
  assert.equal(result.text, '\nB\n');
  assert.deepEqual(result.files, ['/safe/out/My Image (final).png', '/safe/out/My Report (v2).pdf', '/safe/out/escaped(name).png']);
  assert.equal(result.text.includes(').png'), false);
});

test('without media support local links become readable Mac references and do not disappear', () => {
  assert.deepEqual(formatReply('![Preview](/safe/out/photo.png) [Report](/safe/out/report.pdf)', { ...options, mediaSupported: false }), { text: 'Preview (on your Mac) Report (on your Mac)', files: [] });
  assert.deepEqual(formatReply('[Private](/elsewhere/report.pdf)', options), { text: 'Private (on your Mac)', files: [] });
  assert.deepEqual(formatReply('![Unsupported](/safe/out/program.sh)', options), { text: 'Unsupported (on your Mac)', files: [] });
});

test('HTTP links retain labels and usable URLs without duplicate URLs or altered snake_case', () => {
  const result = formatReply('[Official docs](https://example.com/my_api?q=one_two#some_anchor)\n[https://example.com](https://example.com)\nhttps://example.com/_raw_/__path__\n[API](https://example.com/a_(b))', options);
  assert.equal(result.text, 'Official docs (https://example.com/my_api?q=one_two#some_anchor)\nhttps://example.com\nhttps://example.com/_raw_/__path__\nAPI (https://example.com/a_(b))');
  assert.deepEqual(result.files, []);
});

test('code fences and inline code lose only delimiters while code, indentation and blank lines survive', () => {
  const code = '    def __init__(self):\n        return "**literal**", "[x](/safe/out/private.pdf)", snake_case\n\n\n# this is code\na * b\n';
  const result = formatReply('```python\n' + code + '```\nUse `snake_case` and ``a`b``.', options);
  assert.equal(result.text, code + 'Use snake_case and a`b.');
  assert.deepEqual(result.files, []);
  assert.equal(formatReply('    # indented **code**\n    x = "[file](/safe/out/test.pdf)"', options).text, '    # indented **code**\n    x = "[file](/safe/out/test.pdf)"');
});

test('emphasis markers are readable while snake_case, dunder names and ordinary paths survive', () => {
  const result = formatReply('**Bold** *italic* __Strong__ _emphasis_ ***both***\nconfig_file some__identifier__ snake_case __init__ __name__\nRead /Users/example/__cache__/file_name.txt and ~/Code/my_project.\na * b and 2 ** 3', options);
  assert.equal(result.text, 'Bold italic Strong emphasis both\nconfig_file some__identifier__ snake_case __init__ __name__\nRead /Users/example/__cache__/file_name.txt and ~/Code/my_project.\na * b and 2 ** 3');
});

test('emphasis can surround inline code and links without modifying their protected contents', () => {
  const result = formatReply('**Use `__init__` now** and **[API docs](https://example.com/_path_)**.\n`**literal**`\n\0' + '0\0 literal sentinel text', options);
  assert.equal(result.text, 'Use __init__ now and API docs (https://example.com/_path_).\n**literal**\n\0' + '0\0 literal sentinel text');
});

test('literal requested paths and link examples in code are never generalized into attachments', () => {
  const raw = 'The path is /safe/out/file.png.\n`![example](/safe/out/example.png)`\n```md\n![example](/safe/out/another.png)\n```';
  const result = formatReply(raw, options);
  assert.equal(result.text, 'The path is /safe/out/file.png.\n![example](/safe/out/example.png)\n![example](/safe/out/another.png)');
  assert.deepEqual(result.files, []);
});

test('root escapes and unknown schemes never become file candidates', () => {
  const result = formatReply('[escape](/safe/out/../secret.pdf) [wrong](/safe/outside/a.png) [relative](image.png) [scheme](file:///safe/out/a.png)', options);
  assert.deepEqual(result.files, []);
  assert.equal(result.text, 'escape (on your Mac) wrong (on your Mac) relative scheme');
});

test('only five unique files are selected; repeated selected images disappear and overflow stays readable', () => {
  const links = Array.from({ length: 6 }, (_, i) => `![Image ${i}](/safe/out/${i}.png)`).join('\n') + '\n![again](/safe/out/0.png)';
  const result = formatReply(links, options);
  assert.deepEqual(result.files, Array.from({ length: 5 }, (_, i) => `/safe/out/${i}.png`));
  assert.ok(result.text.includes('Image 5 (on your Mac)'));
  assert.equal(result.text.includes('again'), false);
});

test('text truncation retains artifact candidates from original reply and does not split Unicode surrogate pairs', () => {
  const result = formatReply('Hello world!\n![image](/safe/out/generated.png)', { ...options, maxTextChars: 5 });
  assert.deepEqual(result, { text: 'Hello', files: ['/safe/out/generated.png'] });
  assert.equal(formatReply('A😀B', { ...options, maxTextChars: 2 }).text, 'A');
  assert.equal(formatReply('A😀B', { ...options, maxTextChars: 3 }).text, 'A😀');
  assert.deepEqual(formatReply('![image](/safe/out/image.png)', { ...options, maxTextChars: 0 }), { text: '', files: ['/safe/out/image.png'] });
  for (const maxTextChars of [-1, 1.5, Number.NaN, 1048577]) assert.throws(() => formatReply('text', { ...options, maxTextChars }), /limit/);
});

test('bounded parser tolerates malformed links, long backtick runs, deeply nested labels and large input', { timeout: 3000 }, () => {
  const malformed = 'prefix ' + '`'.repeat(50000) + '\n' + '['.repeat(50000) + ' no closing\n![incomplete](/safe/out/a.png';
  const result = formatReply(malformed, options);
  assert.deepEqual(result.files, []);
  assert.ok(result.text.startsWith('prefix '));
  assert.equal(formatReply('a'.repeat(1048600), options).text.length, 1048576);
});

test('valid angle artifact links consume optional quoted or parenthesized titles without exposing Mac paths', () => {
  for (const title of ['"Download\treport"', '"Download report"', "'Download report'", '(Download report)', '"Download \\"final\\" report"', '(Download \\(final\\) report)']) {
    const result = formatReply(`[Report](</safe/out/My Report (final).pdf> ${title})\n![Preview](</safe/out/My Image.png> ${title})`, options);
    assert.equal(result.text, 'Report\n');
    assert.deepEqual(result.files, ['/safe/out/My Report (final).pdf', '/safe/out/My Image.png']);
    assert.equal(result.text.includes('/safe/out'), false);
    assert.equal(result.text.includes('Download'), false);
  }
});

test('angle and bare destinations decode CommonMark punctuation escapes into the exact artifact candidate', () => {
  assert.deepEqual(formatReply(String.raw`[Image](/safe/out/my\_image.png)`, options), { text: 'Image', files: ['/safe/out/my_image.png'] });
  const result = formatReply(String.raw`[Report](</safe/out/My Report \(final\).pdf>)
![Image](</safe/out/image\_\[final\].png> "Preview")
[Backslash](</safe/out/literal\\name.pdf>)`, options);
  assert.deepEqual(result.files, ['/safe/out/My Report (final).pdf', '/safe/out/image_[final].png', '/safe/out/literal\\name.pdf']);
  assert.equal(result.text, 'Report\n\nBackslash');
  assert.equal(result.text.includes('/safe/out'), false);
  assert.deepEqual(formatReply(String.raw`[Escape](</safe/out/\.\./secret.pdf> "No")`, options), { text: 'Escape (on your Mac)', files: [] });
  assert.deepEqual(formatReply(String.raw`[Relative](<safe/out/file.pdf> "No")`, options), { text: 'Relative', files: [] });
  assert.deepEqual(formatReply(String.raw`[Literal](</safe/out/\name.pdf>)`, options).files, ['/safe/out/\\name.pdf']);
});

test('malformed and over-budget angle titles remain text and never produce a partial file candidate', { timeout: 3000 }, () => {
  for (const suffix of ['"unterminated)', '(nested (title)))', '"title" extra)', '"bad\x00title")', '"' + 'x'.repeat(13000) + '")']) {
    const raw = `[Report](</safe/out/report.pdf> ${suffix}`;
    const result = formatReply(raw, options);
    assert.deepEqual(result.files, []);
    assert.ok(result.text.startsWith('[Report]('));
  }
  const code = '`[Report](</safe/out/report.pdf> "Download")`';
  assert.deepEqual(formatReply(code, options), { text: code.slice(1, -1), files: [] });
});

test('bare destination titles select artifacts while existing spaces and balanced filename parentheses survive', () => {
  for (const title of ['"Download report"', "'Download report'", '(Download report)', '"Download\treport"']) {
    for (const path of ['/safe/out/report.pdf', '/safe/out/My Report (final).pdf', '/safe/out/My Report \\(final\\).pdf']) {
      const result = formatReply(`[Report](${path} ${title})\n![Preview](/safe/out/preview.png ${title})`, options);
      assert.deepEqual(result.files, [path.replaceAll('\\(', '(').replaceAll('\\)', ')'), '/safe/out/preview.png']);
      assert.equal(result.text, 'Report\n');
      assert.equal(result.text.includes('/safe/out'), false);
    }
  }
  assert.deepEqual(formatReply('[Report](/safe/out/My Report (final).pdf)', options), { text: 'Report', files: ['/safe/out/My Report (final).pdf'] });
  assert.deepEqual(formatReply('[Report](/safe/out/../secret.pdf "Download")', options), { text: 'Report (on your Mac)', files: [] });
  assert.deepEqual(formatReply('[Docs](https://example.com/report.pdf "Download")', options), { text: 'Docs (https://example.com/report.pdf)', files: [] });
});
