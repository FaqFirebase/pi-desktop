import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  isVoiceDevice,
  needsLinuxGpuSwitches,
  precisionForRuntime,
  resolveVoiceRuntime,
  runtimeForPrecision,
} from './voice-device'

test('auto and gpu run on the GPU when a hardware GPU is available', () => {
  assert.equal(resolveVoiceRuntime('auto', true), 'gpu')
  assert.equal(resolveVoiceRuntime('gpu', true), 'gpu')
})

test('auto and gpu fall back to the CPU when no hardware GPU is available', () => {
  assert.equal(resolveVoiceRuntime('auto', false), 'cpu')
  assert.equal(resolveVoiceRuntime('gpu', false), 'cpu')
})

test('cpu always runs on the CPU', () => {
  assert.equal(resolveVoiceRuntime('cpu', true), 'cpu')
})

test('the GPU gets fp16 and the CPU gets int8, and back', () => {
  assert.equal(precisionForRuntime('gpu'), 'fp16')
  assert.equal(precisionForRuntime('cpu'), 'int8')
  assert.equal(runtimeForPrecision('fp16'), 'gpu')
  assert.equal(runtimeForPrecision('int8'), 'cpu')
})

test('Linux needs the GPU switches unless the user picked the CPU', () => {
  assert.equal(needsLinuxGpuSwitches('linux', 'auto'), true)
  assert.equal(needsLinuxGpuSwitches('linux', 'gpu'), true)
  assert.equal(needsLinuxGpuSwitches('linux', 'cpu'), false)
})

test('Windows and macOS never need the switches', () => {
  assert.equal(needsLinuxGpuSwitches('win32', 'gpu'), false)
  assert.equal(needsLinuxGpuSwitches('darwin', 'auto'), false)
})

test('isVoiceDevice accepts only the three settings', () => {
  assert.equal(isVoiceDevice('auto'), true)
  assert.equal(isVoiceDevice('cpu'), true)
  assert.equal(isVoiceDevice('gpu'), true)
  assert.equal(isVoiceDevice('npu'), false)
  assert.equal(isVoiceDevice(undefined), false)
})
