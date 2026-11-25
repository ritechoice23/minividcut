import assert from 'node:assert/strict'
import test from 'node:test'
import { isPlaybackShortcut } from '../src/playback-shortcut.ts'

const event = (overrides = {}) => ({
  key: ' ', code: 'Space', isComposing: false,
  ctrlKey: false, metaKey: false, altKey: false, ...overrides,
})
const state = (overrides = {}) => ({ hasSource: true, settingsOpen: false, shortcutsOpen: false, ...overrides })
const noOverlays = () => null
const openPopover = query => query.includes('popover') ? {} : null
const openDialog = query => query.includes('[role="dialog"]') ? {} : null

// Minimal Element.closest stand-ins. A compound selector is split into its
// exact tokens, so reintroducing a guard such as closest('button, select, a')
// is still detected without matching unrelated substrings like "a" in
// "textarea".
const matched = (...selectors) => ({
  closest: query => query.split(',').some(token => selectors.includes(token.trim())) ? {} : null,
})
const inputWith = type => ({
  closest: query => query.includes('input') ? { type } : null,
})

const plays = (keyEvent, keyState = state(), focused = null, query = noOverlays) =>
  isPlaybackShortcut(keyEvent, keyState, focused, query)

test('Space toggles playback even when a button, tab, select or link has focus', () => {
  for (const focused of [null, matched('button'), matched('[role="tab"]'), matched('select'), matched('a')]) {
    assert.equal(plays(event(), state(), focused), true)
  }
})

test('non-text inputs such as sliders do not swallow Space', () => {
  for (const type of ['range', 'color', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file']) {
    assert.equal(plays(event(), state(), inputWith(type)), true)
  }
})

test('typing in text fields keeps its native spacebar', () => {
  assert.equal(plays(event(), state(), matched('textarea')), false)
  assert.equal(plays(event(), state(), matched('[contenteditable="true"]')), false)
  assert.equal(plays(event(), state(), inputWith('text')), false)
  assert.equal(plays(event(), state(), inputWith('number')), false)
  assert.equal(plays(event(), state(), inputWith('search')), false)
})

test('modifier keys, composition and non-space keys never trigger playback', () => {
  for (const keyEvent of [
    event({ ctrlKey: true }), event({ metaKey: true }), event({ altKey: true }),
    event({ isComposing: true }), event({ key: 'Enter', code: 'Enter' }), event({ key: 'i', code: 'KeyI' }),
  ]) assert.equal(plays(keyEvent), false)
  assert.equal(plays(event({ key: 'Spacebar', code: 'Space' })), true)
  assert.equal(plays(event({ key: ' ', code: 'KeyI' })), true)
})

test('playback is gated by a loaded source and by open settings, dialogs and popovers', () => {
  assert.equal(plays(event(), state({ hasSource: false })), false)
  assert.equal(plays(event(), state({ settingsOpen: true })), false)
  assert.equal(plays(event(), state({ shortcutsOpen: true })), false)
  assert.equal(plays(event(), state(), null, openPopover), false)
  assert.equal(plays(event(), state(), null, openDialog), false)
  // A focused control inside an open popover keeps its native Space action.
  assert.equal(plays(event(), state(), matched('button'), openPopover), false)
})

test('key repeat does not change the decision; the listener suppresses repeat toggles', () => {
  assert.equal(plays(event({ repeat: true })), plays(event()))
})
