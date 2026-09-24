import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  applyVoiceGpuSwitches,
  readVoiceDeviceSync,
  voiceGpuRestartRequired,
} from './voice-gpu-switches'

async function settingsFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-voice-switches-'))
  const path = join(dir, 'settings.json')
  await writeFile(path, content)
  return path
}

function recordingCommandLine(): { switches: string[]; appendSwitch(name: string, value?: string): void } {
  const switches: string[] = []
  return {
    switches,
    appendSwitch(name, value) {
      switches.push(value === undefined ? name : `${name}=${value}`)
    },
  }
}

test('readVoiceDeviceSync reads a saved device', async () => {
  assert.equal(readVoiceDeviceSync(await settingsFile('{"voiceDevice":"cpu"}')), 'cpu')
})

test('readVoiceDeviceSync falls back to auto for a missing file, bad JSON or an unknown value', async () => {
  assert.equal(readVoiceDeviceSync(join(tmpdir(), 'no-such-dir', 'settings.json')), 'auto')
  assert.equal(readVoiceDeviceSync(await settingsFile('{not json')), 'auto')
  assert.equal(readVoiceDeviceSync(await settingsFile('{"voiceDevice":"npu"}')), 'auto')
})

test('Linux with auto gets the WebGPU and Vulkan switches', () => {
  const commandLine = recordingCommandLine()
  applyVoiceGpuSwitches(commandLine, 'linux', 'auto')
  assert.deepEqual(commandLine.switches, ['enable-unsafe-webgpu', 'enable-features=Vulkan'])
  assert.equal(voiceGpuRestartRequired('linux', 'gpu'), false)
  assert.equal(voiceGpuRestartRequired('linux', 'cpu'), true)
})

test('Linux with cpu gets no switches; picking the GPU then needs a restart', () => {
  const commandLine = recordingCommandLine()
  applyVoiceGpuSwitches(commandLine, 'linux', 'cpu')
  assert.deepEqual(commandLine.switches, [])
  assert.equal(voiceGpuRestartRequired('linux', 'gpu'), true)
})

test('Windows gets no switches and never needs a restart', () => {
  const commandLine = recordingCommandLine()
  applyVoiceGpuSwitches(commandLine, 'win32', 'gpu')
  assert.deepEqual(commandLine.switches, [])
  assert.equal(voiceGpuRestartRequired('win32', 'cpu'), false)
})
