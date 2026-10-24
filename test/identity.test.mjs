import test from 'node:test';
import assert from 'node:assert/strict';
import {githubId, repositoryCoordinates, memberRunnerLabel} from '@nibfin/core';

test('stable repository, user and runner IDs remain exact canonical strings', () => {
  for (const id of ['1', '1427838662', '90071992547409931234567890']) assert.equal(githubId(id), id);
  for (const id of ['', '0', '-1', '1.5', ' 1', '1 ', '1\n', '1e3', '0x10', '01', '００１', 1, null, undefined]) {
    assert.throws(() => githubId(id), TypeError);
  }
});

test('personal and organization coordinates share deterministic rules', () => {
  assert.deepEqual(repositoryCoordinates('Taco3064', 'Nibfin'), {owner: 'taco3064', repository: 'nibfin', key: 'taco3064/nibfin'});
  assert.deepEqual(repositoryCoordinates('Example-Org', 'Core.v1'), {owner: 'example-org', repository: 'core.v1', key: 'example-org/core.v1'});
  for (const pair of [['', 'repo'], ['owner', ''], ['owner'], ['a/b', 'c'], ['a', 'b/c'],
    ['https://github.com/a', 'b'], ['a', '../b'], ['..', 'b'], ['a', '..'], ['a\n', 'b'],
    ['a', 'b\0'], ['a', 'b\\c'], ['a--b', 'c'], ['-a', 'b'], [null, 'b']]) {
    assert.throws(() => repositoryCoordinates(...pair), TypeError);
  }
});

test('coordinates, database IDs and routing labels are distinct and confer no authority', () => {
  assert.equal(memberRunnerLabel('42'), 'nibfin-user-42');
  assert.throws(() => githubId('nibfin-user-42'), TypeError);
  assert.throws(() => githubId('owner/repo'), TypeError);
  assert.throws(() => memberRunnerLabel('owner/repo'), TypeError);
  assert.equal(typeof githubId('42'), 'string');
  assert.deepEqual(Object.keys(repositoryCoordinates('owner', 'repo')), ['owner', 'repository', 'key']);
});
