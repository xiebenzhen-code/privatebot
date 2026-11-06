// 028.1：打码别把普通英文词打成密钥，也别漏掉用户名和地址里的凭据。
// 起因：用户读的结果里出现 "The key *** include approvals" 这种句子。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { redactAll, redactText, redactPath, looksLikeToken } from '../src/services/redact.ts';

describe('028.1 普通词不该被打码', () => {
  const keep = [
    'The key features include approvals',
    'Password authentication uses scrypt',
    '核心功能：key management、secret scanning',
    'API key rotation reminders',
    'Authorization required … Bearer tokens only',
    'token 会在 24 小时后过期',
  ];
  for (const line of keep) {
    test(`原样：${line}`, () => {
      assert.equal(redactAll(line), line);
    });
  }
});

describe('028.1 真密钥照样打', () => {
  const cases: [string, string, string][] = [
    ['Bearer 前缀', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'Bearer ***'],
    ['明文密码', 'password: hunter2', 'password: ***'],
    ['JSON 里的 token', '{"token":"abcdef123"}', '{"token":"***"}'],
    ['sk- 前缀', 'key 是 sk-test-token-not-real-0000', 'sk-***'],
    ['环境变量', 'WB_TOKEN=test-token-not-real-0000', 'WB_TOKEN=***'],
    ['GitHub token', 'ghp_test-token-not-real-0000uvwxyz012345', '***'],
  ];
  for (const [name, input, expect] of cases) {
    test(name, () => {
      const out = redactText(input);
      assert.ok(out.includes(expect), `${name} 应包含 ${expect}，实际 ${out}`);
      assert.ok(!out.includes('hunter2') && !out.includes('abcdef123456'), `${name} 不该留下原文：${out}`);
    });
  }

  test('Bearer 后面的令牌必须像令牌才打', () => {
    assert.equal(redactText('Bearer abc'), 'Bearer abc');
    assert.equal(redactText('Bearer tokens only'), 'Bearer tokens only');
    assert.equal(redactText('Bearer test-token-not-real-0000'), 'Bearer ***');
    assert.equal(looksLikeToken('sk-abc'), true);
    assert.equal(looksLikeToken('short'), false);
  });
});

describe('028.1 用户名取到路径分隔符为止', () => {
  const cases: [string, string][] = [
    ['小写盘符和 Users', String.raw`c:\users\SomeOne\x`, String.raw`c:\users\~\x`],
    ['带空格的用户名', String.raw`C:\Users\Zhang San\Desktop`, String.raw`C:\Users\~\Desktop`],
    ['中文带空格', String.raw`C:\Users\张 三\proj`, String.raw`C:\Users\~\proj`],
    ['正斜杠', 'C:/Users/me/x', 'C:/Users/~/x'],
    ['长路径前缀', String.raw`\\?\C:\Users\me\x`, String.raw`\\?\C:\Users\~\x`],
    ['WSL 挂载', '/mnt/c/Users/me/x', '/mnt/c/Users/~/x'],
    ['Linux 家目录', '/home/someone/proj', '/home/~/proj'],
    ['macOS 家目录', '/Users/someone/proj', '/Users/~/proj'],
  ];
  for (const [name, input, expect] of cases) {
    test(name, () => {
      assert.equal(redactPath(input), expect);
      assert.ok(!/SomeOne|Zhang|someone|张三/.test(redactPath(input)));
    });
  }
});

describe('028.1 地址里的凭据', () => {
  const cases: [string, string][] = [
    ['用户名密码', 'https://user:secret@github.com/x/y.git', 'https://***@github.com/x/y.git'],
    ['只有用户名', 'https://user@github.com/x/y.git', 'https://***@github.com/x/y.git'],
    ['短密码也挡', 'https://u:p@git.example.com/a/b', 'https://***@git.example.com/a/b'],
  ];
  for (const [name, input, expect] of cases) {
    test(name, () => assert.equal(redactText(input), expect));
  }

  test('不带凭据的地址不被破坏', () => {
    const clean = 'https://github.com/you/example.git';
    assert.equal(redactText(clean), clean);
  });
});

describe('028.1 幂等', () => {
  const samples = [
    String.raw`C:\Users\Zhang San\Desktop\a.txt`,
    'https://user:secret@github.com/x/y.git',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    '{"token":"abcdef123"} 记在 c:\\users\\SomeOne\\x',
    'The key features include approvals',
  ];
  for (const s of samples) {
    test(`两次等于一次：${s.slice(0, 28)}`, () => {
      const once = redactAll(s);
      assert.equal(redactAll(once), once);
    });
  }
});

// 028.2：审查在 028.1 里找到的三个漏口。都是一行里出现多次 / 没有后续路径 / 短令牌的边界。
describe('028.2 Windows 用户名：一行多个只打第一个', () => {
  test('一行两个路径都要打码', () => {
    const out = redactAll(String.raw`see C:\Users\bob\a.txt and C:\Users\bob\b.txt`);
    assert.ok(!out.includes('bob'), `第二个路径的用户名漏了：${out}`);
    assert.equal(out, String.raw`see C:\Users\~\a.txt and C:\Users\~\b.txt`);
  });

  test('一行三个路径也要全打', () => {
    const out = redactAll(String.raw`C:\Users\amy\1 C:\Users\bob\2 C:\Users\cy\3`);
    for (const name of ['amy', 'bob', 'cy']) assert.ok(!out.includes(name), `${name} 漏了：${out}`);
  });

  test('Windows 路径和 /home/ 混在一行', () => {
    const out = redactAll(String.raw`C:\Users\bob\x plus /home/alice/y and c:\users\Carol\z`);
    for (const name of ['bob', 'alice', 'Carol']) assert.ok(!out.toLowerCase().includes(name.toLowerCase()), `${name} 漏了：${out}`);
  });

  test('不同用户名各打各的，后面的路径不动', () => {
    const out = redactPath(String.raw`C:\Users\bob\Desktop\proj and C:\Users\alice\Desktop`);
    assert.equal(out, String.raw`C:\Users\~\Desktop\proj and C:\Users\~\Desktop`);
  });
});

describe('028.2 用户名带空格、后面没有路径', () => {
  test('行尾的 C:\\Users\\Zhang San 不留姓氏', () => {
    const out = redactAll(String.raw`家目录是 C:\Users\Zhang San`);
    assert.ok(!out.includes('San'), `姓氏漏出来了：${out}`);
    assert.equal(out, String.raw`家目录是 C:\Users\~`);
  });

  test('后面是标点也停住', () => {
    const out = redactPath(String.raw`（C:\Users\Zhang San），然后是别的`);
    assert.ok(!out.includes('San'));
    assert.ok(out.includes('然后是别的'), '标点之后的正文不能被吃掉');
  });

  test('带空格的用户名后面还有路径时，只打用户名', () => {
    assert.equal(
      redactPath(String.raw`C:\Users\Zhang San\Desktop\a.txt`),
      String.raw`C:\Users\~\Desktop\a.txt`,
    );
  });

  test('中文正文紧跟在路径后面时，不吃掉中文', () => {
    const out = redactPath(String.raw`C:\Users\bob 下的文件`);
    assert.ok(!out.includes('bob'));
    assert.ok(out.includes('下的文件'), `中文被吃掉了：${out}`);
  });
});

describe('028.2 Authorization 头里的 Bearer 一律打码', () => {
  test('短令牌也打', () => {
    assert.equal(redactText('Authorization: Bearer abc123def'), 'Authorization: Bearer ***');
  });

  test('20 位纯字母也打', () => {
    assert.equal(redactText('Authorization: Bearer test-token-not-real-0000'), 'Authorization: Bearer ***');
  });

  test('等号写法、带引号也打', () => {
    assert.equal(redactText('authorization="Bearer xyz789"'), 'authorization="Bearer ***"');
    assert.equal(redactText("AUTHORIZATION: bearer q1"), 'AUTHORIZATION: bearer ***');
  });

  test('普通句子里的 Bearer 不动', () => {
    const s = 'Bearer tokens are passed in the header';
    assert.equal(redactText(s), s);
  });
});
