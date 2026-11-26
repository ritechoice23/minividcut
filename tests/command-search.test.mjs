import assert from 'node:assert/strict'
import test from 'node:test'
import { groupCommands, searchCommands } from '../src/command-search.ts'

const commands = [
  { id: 'find', label: 'Find clips with AI', group: 'Find', keywords: 'smart split moments' },
  { id: 'caption-all', label: 'Caption all clips', group: 'Captions' },
  { id: 'caption', label: 'Generate captions for this clip', group: 'Captions', keywords: 'subtitles' },
  { id: 'export', label: 'Export all clips', group: 'Output' },
]

test('an empty query lists every command in order', () => {
  assert.deepEqual(searchCommands(commands, '  ').map(command => command.id), ['find', 'caption-all', 'caption', 'export'])
})

test('every typed word must match the label, group or keywords', () => {
  assert.deepEqual(searchCommands(commands, 'cap all').map(command => command.id), ['caption-all'])
  assert.deepEqual(searchCommands(commands, 'SMART split').map(command => command.id), ['find'])
  assert.deepEqual(searchCommands(commands, 'subtitles').map(command => command.id), ['caption'])
  assert.deepEqual(searchCommands(commands, 'nothing here'), [])
})

test('labels starting with the query rank first', () => {
  assert.deepEqual(searchCommands(commands, 'gen').map(command => command.id), ['caption'])
  assert.deepEqual(searchCommands(commands, 'e').map(command => command.id), ['export', 'find', 'caption'])
})

test('groups keep their first-seen order', () => {
  assert.deepEqual(groupCommands(commands).map(item => item.group), ['Find', 'Captions', 'Output'])
  assert.equal(groupCommands(commands)[1].items.length, 2)
})
