import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactLogEntry, redactSecrets, secretValuesFromEnv } from './log-redaction'

test('redacts url credentials, bearer tokens, key=value pairs and known token prefixes', () => {
  assert.equal(
    redactSecrets("fatal: unable to access 'https://me:ghp_abcdefghijklmnopqrstuvwx@github.com/o/r.git/'", []),
    "fatal: unable to access 'https://[redacted]@github.com/o/r.git/'",
  )
  assert.equal(redactSecrets('Authorization: Bearer abc.def-ghi', []), 'Authorization: [redacted]')
  assert.equal(redactSecrets('request failed api_key=12345678 retry', []), 'request failed api_key=[redacted] retry')
  assert.equal(redactSecrets('{"token":"zzzzzzzz"}', []), '{"token":"[redacted]"}')
  assert.equal(redactSecrets('key sk-ant-0123456789abcdefghij used', []), 'key [redacted] used')
  assert.equal(redactSecrets('pat github_pat_0123456789abcdefghijkl', []), 'pat [redacted]')
  assert.equal(redactSecrets('aws AKIAABCDEFGHIJKLMNOP', []), 'aws [redacted]')
})

test('redacts exact secret values from the environment', () => {
  const secrets = secretValuesFromEnv({ OPENAI_API_KEY: 'plain-secret-value', HOME: '/home/me', SHORT_TOKEN: 'abc' })
  assert.deepEqual(secrets, ['plain-secret-value'])
  assert.equal(redactSecrets('echo plain-secret-value', secrets), 'echo [redacted]')
})

test('secret values come longest first without duplicates', () => {
  const secrets = secretValuesFromEnv({ A_TOKEN: 'abcdefgh', B_SECRET: 'abcdefgh-longer', C_KEY: 'abcdefgh' })
  assert.deepEqual(secrets, ['abcdefgh-longer', 'abcdefgh'])
  assert.equal(redactSecrets('x abcdefgh-longer y', secrets), 'x [redacted] y')
})

test('keeps the escapes of a JSON-encoded detail around a redacted value', () => {
  const detail = JSON.stringify({ stack: 'Error: token=abcdefgh\n    at x' })
  assert.equal(redactSecrets(detail, []), '{"stack":"Error: token=[redacted]\\n    at x"}')
})

test('leaves ordinary log text unchanged', () => {
  const text = 'Failed to save workspaces.json (/home/me/project) at https://example.com/path'
  assert.equal(redactSecrets(text, []), text)
})

test('redactLogEntry redacts message and detail only', () => {
  const entry = { ts: 1, level: 'warn' as const, scope: 'git', message: 'x token=abcdefgh', detail: 'Bearer qqq' }
  assert.deepEqual(redactLogEntry(entry, []), { ts: 1, level: 'warn', scope: 'git', message: 'x token=[redacted]', detail: '[redacted]' })
  assert.equal('detail' in redactLogEntry({ ts: 1, level: 'info', scope: 's', message: 'm' }, []), false)
})

test('a quoted value is redacted up to its closing quote', () => {
  assert.equal(redactSecrets('{"password": "two words here", "ok": 1}', []), '{"password": "[redacted]", "ok": 1}')
  assert.equal(redactSecrets("secret='a b c' next", []), "secret='[redacted]' next")
  assert.equal(redactSecrets('{"token":"a\\"b c"}', []), '{"token":"[redacted]"}')
})

test('url credentials are redacted up to the last @ before the host', () => {
  assert.equal(redactSecrets('https://me:p@ss@w0rd@github.com/o/r.git', []), 'https://[redacted]@github.com/o/r.git')
  assert.equal(redactSecrets('see https://example.com/a@b', []), 'see https://example.com/a@b')
})

test('numeric token counters stay readable', () => {
  const text = '{"inputTokens":1200,"maxTokens": 4096,"max_tokens=8192","tokenCount":12}'
  assert.equal(redactSecrets(text, []), text)
  assert.equal(redactSecrets('maxTokens=abcdefgh', []), 'maxTokens=[redacted]')
  assert.equal(redactSecrets('token=12345678', []), 'token=[redacted]')
})
