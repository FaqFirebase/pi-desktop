import assert from 'node:assert/strict'
import { buildNewFileDiff } from './file-service'

const diff = buildNewFileDiff('TEST.md', '# Test\n\nHello\n')

assert.equal(
  diff,
  [
    'diff --git a/TEST.md b/TEST.md',
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    '+++ b/TEST.md',
    '@@ -0,0 +1,3 @@',
    '+# Test',
    '+',
    '+Hello',
    '',
  ].join('\n')
)
