import assert from 'node:assert/strict'
import { parseAgentMessage } from './message-parsing'

const parsed = parseAgentMessage({
  role: 'user',
  id: 'user-1',
  timestamp: 123,
  content: [
    { type: 'text', text: 'can you see the image?' },
    { type: 'image', mimeType: 'image/png', data: 'abc123' },
  ],
})

assert.deepEqual(parsed?.attachments, [
  {
    kind: 'image',
    name: 'Image 1',
    mimeType: 'image/png',
    data: 'abc123',
  },
])
