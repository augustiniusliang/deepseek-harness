/** Label mapping: the chip text for each world-reference shape. */

import { describe, expect, it } from 'vitest'
import { worldLabel } from '@deepseek-ai/dsh-client-ui-session-world/client'
import { en, zh } from '../src/client/locales.ts'

const tEn = (key: keyof typeof en): string => en[key]
const tZh = (key: keyof typeof zh): string => zh[key]

describe('worldLabel', () => {
  it('translates the local world', () => {
    expect(worldLabel('local', tEn)).toBe('Local')
    expect(worldLabel('local', tZh)).toBe('本机')
  })

  it('names the distribution of a WSL reference, dropping the optional user', () => {
    expect(worldLabel('wsl:Ubuntu', tEn)).toBe('WSL · Ubuntu')
    expect(worldLabel('wsl:Ubuntu:ramos', tEn)).toBe('WSL · Ubuntu')
  })

  it('names the profile of an SSH reference', () => {
    expect(worldLabel('ssh:gpu-box', tEn)).toBe('SSH · gpu-box')
    expect(worldLabel('ssh:loopback', tZh)).toBe('SSH · loopback')
  })

  it('passes an unknown reference shape through verbatim', () => {
    expect(worldLabel('wsl:', tEn)).toBe('wsl:')
    expect(worldLabel('ssh:', tEn)).toBe('ssh:')
    expect(worldLabel('future-kind', tEn)).toBe('future-kind')
  })
})
