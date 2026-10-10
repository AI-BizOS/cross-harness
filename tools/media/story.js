// What the README recordings show: a small project with a real bug, and what each
// stand-in agent does when it receives a task, a question or a review. The stand-ins
// (standins/*.js) speak the real harness protocols and act this out for real: they
// edit files in their worktrees and run the project's tests.
//
// Actions:
//   ['think', ms]                      reasoning, shown as "Thinking"
//   ['plan', [[status, text], ...]]    a plan (ACP agents only); status: done, now, todo
//   ['read', file, ms]                 read a file
//   ['edit', file, change]             change: {write}, {append} or {replace: [old, new]}
//   ['run', command]                   run a shell command in the working directory
//   ['tool', name, args]               call one of Troupe's collaboration tools
//   ['say', text]                      the answer
//   ['usage', input, output]           tokens used by the turn
//   ['wait', ms]

const PARSER = `// Order lines: "sku,quantity,price".
export class ParseError extends Error {
  constructor(message, line, column) {
    super(\`\${message} (line \${line}, column \${column})\`);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

function parseRow(text, line) {
  const fields = text.split(',');
  if (fields.length !== 3) throw new ParseError(\`expected 3 fields, found \${fields.length}\`, line, 1);
  const [sku, quantity, price] = fields.map((field) => field.trim());
  if (!/^\\d+$/.test(quantity)) throw new ParseError('quantity must be a whole number', line, text.indexOf(',') + 2);
  if (!(Number(price) >= 0)) throw new ParseError('price must be zero or more', line, text.lastIndexOf(',') + 2);
  return { sku, quantity: Number(quantity), price: Number(price) };
}

export function parse(text) {
  const rows = [];
  let start = 0;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\\n') continue;
    const row = text.slice(start, i).replace(/\\r$/, '');
    if (row.trim()) rows.push(parseRow(row, line));
    start = i + 1;
    line++;
  }
  return rows;
}
`;

const PARSER_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.js';

test('parses order lines', () => {
  assert.deepEqual(parse('A-100,2,9.50\\nB-200,1,4\\n'), [
    { sku: 'A-100', quantity: 2, price: 9.5 },
    { sku: 'B-200', quantity: 1, price: 4 },
  ]);
});

test('skips blank lines', () => {
  assert.equal(parse('A-100,2,9.50\\n\\nB-200,1,4\\n').length, 2);
});

test('reports the line of a bad quantity', () => {
  assert.throws(() => parse('A-100,2,9.50\\nB-200,two,4\\n'), (error) => error instanceof ParseError && error.line === 2);
});
`;

// Prints one line per test and a summary last, so the last line of output says it all.
const REPORTER = `export default async function* report(events) {
  let passed = 0;
  let failed = 0;
  for await (const event of events) {
    if (event.data?.details?.type === 'suite') continue;
    if (event.type === 'test:pass') {
      passed++;
      yield \`✔ \${event.data.name}\\n\`;
    } else if (event.type === 'test:fail') {
      failed++;
      yield \`✖ \${event.data.name}\\n\`;
    }
  }
  yield failed ? \`\${passed} passed, \${failed} failed\\n\` : \`\${passed} passed\\n\`;
}
`;

export const PROJECT = {
  name: 'shop-api',
  files: {
    'package.json': `${JSON.stringify({ name: 'shop-api', version: '1.4.0', private: true, type: 'module', scripts: { test: 'node --test --test-reporter=./scripts/report.js' } }, null, 2)}\n`,
    'README.md': '# shop-api\n\nOrder import and pricing for the shop.\n',
    'src/parser.js': PARSER,
    'test/parser.test.js': PARSER_TESTS,
    'scripts/report.js': REPORTER,
  },
};

const REGRESSION_TEST = `
test('keeps the last line without a trailing newline', () => {
  assert.equal(parse('A-100,2,9.50\\nB-200,1,4').length, 2);
});
`;

const ERROR_TESTS = `import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, ParseError } from '../src/parser.js';

function where(text) {
  try {
    parse(text);
  } catch (error) {
    if (error instanceof ParseError) return [error.line, error.column];
    throw error;
  }
  return null;
}

test('a bad quantity points at the quantity column', () => {
  assert.deepEqual(where('A-100,2,9.50\\nB-200,two,4\\n'), [2, 7]);
});

test('a negative price points at the price column', () => {
  assert.deepEqual(where('A-100,2,-1\\n'), [1, 9]);
});

test('a missing field is reported on its line', () => {
  assert.deepEqual(where('A-100,2,9.50\\nB-200,1\\n'), [2, 1]);
});

test('Windows line endings count lines the same way', () => {
  assert.deepEqual(where('A-100,2,9.50\\r\\nB-200,x,4\\r\\n'), [2, 7]);
});
`;

const FIX = [
  '    line++;\n  }\n  return rows;',
  "    line++;\n  }\n  const last = text.slice(start).replace(/\\r$/, '');\n  if (last.trim()) rows.push(parseRow(last, line));\n  return rows;",
];

const TEXT = {
  en: {
    message: [
      '@codex fix the parser dropping the last line without a trailing newline',
      '@claude add edge-case tests for parse errors',
      '@kimi document the import format in docs/import.md',
    ],
    codexFixed:
      'Fixed. `parse()` stopped at the last newline, so a file without a trailing newline lost its last order. It now parses the text after the last newline too, on the right line number.\n\nAdded a regression test; `npm test`: 4 passed.',
    question: 'Will parse() keep throwing ParseError with {line, column}? I am writing tests against both.',
    codexAnswer: 'Yes. The error shape does not change: ParseError keeps `line` and `column`, both counted from 1. I wrote the contract on the board under api.parse.',
    board: 'parse(text) returns [{sku, quantity, price}]. Throws ParseError with line and column, both from 1. The last line counts even without a trailing newline.',
    claudeCheck: 'Asking @codex first, since it is changing parse() right now.',
    claudeDone:
      'Added 4 edge-case tests in test/errors.test.js: a bad quantity, a negative price, a missing field and Windows line endings. Each checks `line` and `column`, which @codex confirmed stay as they are.\n\n`npm test`: 7 passed.',
    plan: ['Read the parser and its tests', 'Write docs/import.md', 'Link it from the README'],
    importDoc:
      '# Importing orders\n\nEach line is one order item: `sku,quantity,price`.\n\n| Field | Rule |\n| --- | --- |\n| sku | text without commas |\n| quantity | a whole number |\n| price | zero or more, with a dot for decimals |\n\nBlank lines are skipped, and Windows line endings work.\n\nA line that breaks a rule stops the import with `ParseError`. Its `line` and `column`, both counted from 1, point at the problem.\n',
    readmeLink: '\nThe import format is described in [docs/import.md](docs/import.md).\n',
    kimiDone: 'Documented the import format in docs/import.md: the three fields, their rules, blank lines and line endings, and how errors point at the line and column. Linked it from the README.',
    review:
      'The loop now also parses the text after the last newline, and `line` is already right for it because it was advanced at that newline. Blank trailing text is still skipped. The new test covers the case that was broken, and nothing else changes.\n\nVERDICT: PASS',
  },
  zh: {
    message: ['@codex 修复解析器：文件末尾没有换行时会丢掉最后一行', '@claude 给解析错误补充边界测试', '@kimi 在 docs/import.md 写清楚导入格式'],
    codexFixed: '已修复。`parse()` 只处理到最后一个换行符，所以文件末尾没有换行时最后一条订单会丢失。现在换行符之后的文本也会解析，行号也正确。\n\n补了一个回归测试；`npm test`：4 passed。',
    question: 'parse() 之后还会抛出带 {line, column} 的 ParseError 吗？我的测试会同时检查这两个字段。',
    codexAnswer: '会。错误格式不变：ParseError 保留 `line` 和 `column`，都从 1 开始计数。我把约定写在了看板的 api.parse 下。',
    board: 'parse(text) 返回 [{sku, quantity, price}]。出错时抛出 ParseError，带 line 和 column，都从 1 开始。没有结尾换行时最后一行同样计入。',
    claudeCheck: '先问一下 @codex，它正在改 parse()。',
    claudeDone: '在 test/errors.test.js 里补了 4 个边界测试：数量不合法、价格为负、缺少字段、Windows 换行。每个都检查 `line` 和 `column`，@codex 确认这两个字段保持不变。\n\n`npm test`：7 passed。',
    plan: ['阅读解析器和测试', '编写 docs/import.md', '在 README 中加入链接'],
    importDoc:
      '# 导入订单\n\n每行是一条订单明细：`sku,quantity,price`。\n\n| 字段 | 规则 |\n| --- | --- |\n| sku | 不含逗号的文本 |\n| quantity | 整数 |\n| price | 大于等于 0，小数用点号 |\n\n空行会被跳过，Windows 换行同样支持。\n\n某行不符合规则时，导入以 `ParseError` 停止，它的 `line` 和 `column`（都从 1 开始）指出问题所在。\n',
    readmeLink: '\n导入格式见 [docs/import.md](docs/import.md)。\n',
    kimiDone: '在 docs/import.md 写清楚了导入格式：三个字段及其规则、空行和换行处理，以及错误如何指出行和列。README 里加了链接。',
    review: '循环结束后，最后一个换行符之后的文本也会被解析，`line` 在遇到那个换行时已经加过，所以行号正确。末尾的空白仍会跳过。新测试覆盖了原来出错的情况，其余行为不变。\n\nVERDICT: PASS',
  },
};

export function text(lang = 'en') {
  return TEXT[lang] || TEXT.en;
}

/** The scenes each stand-in can act out, matched against the prompt it receives. */
export function scenes(lang = 'en') {
  const s = text(lang);
  return {
    codex: [
      {
        match: /^Question from @claude/,
        actions: [
          ['think', 700],
          ['tool', 'troupe_board_write', { key: 'api.parse', value: s.board }],
          ['say', s.codexAnswer],
          ['usage', 8200, 310],
        ],
      },
      {
        match: /codex|parser|解析器/,
        actions: [
          ['think', 900],
          ['run', 'grep -n "export function parse" src/parser.js'],
          ['wait', 500],
          ['edit', 'test/parser.test.js', { append: REGRESSION_TEST }],
          ['wait', 300],
          ['run', 'npm test'],
          ['think', 1100],
          ['edit', 'src/parser.js', { replace: FIX }],
          ['wait', 300],
          ['run', 'npm test'],
          ['say', s.codexFixed],
          ['usage', 23100, 1250],
        ],
      },
    ],
    claude: [
      {
        match: /^Review the changes/,
        actions: [
          ['think', 1200],
          ['say', s.review],
          ['usage', 9100, 260],
        ],
      },
      {
        match: /claude|tests|测试/,
        actions: [
          ['read', 'src/parser.js', 700],
          ['read', 'test/parser.test.js', 500],
          ['say', s.claudeCheck, { interim: true }],
          ['tool', 'troupe_ask_agent', { agent: 'codex', question: s.question }],
          ['think', 600],
          ['edit', 'test/errors.test.js', { write: ERROR_TESTS }],
          ['wait', 300],
          ['run', 'npm test'],
          ['say', s.claudeDone],
          ['usage', 18400, 990],
        ],
      },
    ],
    kimi: [
      {
        match: /kimi|docs|文档|格式/,
        actions: [
          ['plan', [['now', s.plan[0]], ['todo', s.plan[1]], ['todo', s.plan[2]]]],
          ['think', 600],
          ['read', 'src/parser.js', 800],
          ['read', 'test/parser.test.js', 600],
          ['plan', [['done', s.plan[0]], ['now', s.plan[1]], ['todo', s.plan[2]]]],
          ['think', 1600],
          ['edit', 'docs/import.md', { write: s.importDoc }],
          ['wait', 500],
          ['plan', [['done', s.plan[0]], ['done', s.plan[1]], ['now', s.plan[2]]]],
          ['edit', 'README.md', { append: s.readmeLink }],
          ['plan', [['done', s.plan[0]], ['done', s.plan[1]], ['done', s.plan[2]]]],
          ['say', s.kimiDone],
          ['usage', 12600, 840],
        ],
      },
    ],
  };
}
