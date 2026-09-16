// CLI 冒烟测试：离线运行，使用临时配置目录，不触网、不需要凭据
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'asy.js');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'asy-cli-test-'));

function run(args, opts = {}) {
  const env = Object.assign({}, process.env, { ASY_CONFIG_DIR: SANDBOX }, opts.env || {});
  return execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('asy help: 输出命令帮助', () => {
  const out = run(['help']);
  assert.match(out, /AnyShare/);
  assert.match(out, /asy login/);
});

test('asy config show: 显示配置路径与字段（只读，不写文件）', () => {
  const out = run(['config', 'show']);
  assert.match(out, /clientId/);
  assert.match(out, /baseUrl/);
  assert.match(out, /config\.json/); // 打印配置文件路径
});

test('asy config set: 写入配置文件且未知键报错', () => {
  const out = run(['config', 'set', 'baseUrl', 'https://example.edu.cn']);
  assert.match(out, /baseUrl/);
  assert.ok(fs.existsSync(path.join(SANDBOX, 'config.json')), 'config set 后应生成 config.json');
  const saved = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'config.json'), 'utf8'));
  assert.strictEqual(saved.baseUrl, 'https://example.edu.cn');
  assert.throws(() => run(['config', 'set', 'nonexistentKey', 'x']), /未知配置键|Error/);
});

test('未登录时 asy ls 给出明确提示并非零退出', () => {
  // 清掉凭据
  run(['logout']);
  assert.throws(() => run(['ls']), (err) => {
    const msg = String(err.stdout || '') + String(err.stderr || '');
    assert.match(msg, /未登录|asy login/);
    assert.notStrictEqual(err.status, 0);
    return true;
  });
});

test('未知命令返回用法提示', () => {
  assert.throws(() => run(['definitely-not-a-command']), (err) => {
    const msg = String(err.stdout || '') + String(err.stderr || '');
    assert.match(msg, /未知命令/);
    return true;
  });
});

test('cleanup: 删除临时配置目录', () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  assert.ok(!fs.existsSync(SANDBOX));
});