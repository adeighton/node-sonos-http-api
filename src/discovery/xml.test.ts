import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';

import { fixturePath } from '../testing/fixtures.ts';
import {
  XML_ARRAYS,
  asArray,
  collectXmlTags,
  firstXmlTag,
  nodeAttrs,
  nodeText,
  nodeValue,
  parseXmlEvents,
} from './xml.ts';

describe('parseXmlEvents', () => {
  it('parses a NOTIFY fixture in two stages and lowercases tag and attribute names', async () => {
    // The ZoneGroupState property carries escaped XML, exactly like a real NOTIFY body.
    const property = await firstXmlTag(
      createReadStream(fixturePath('zonegroupstate.xml')),
      'zonegroupstate',
      { useArrays: XML_ARRAYS.NEVER },
    );
    const zoneGroups = await collectXmlTags(nodeText(property) ?? '', 'zonegroup', {
      preserveMarkup: XML_ARRAYS.NEVER,
      useArrays: XML_ARRAYS.SOMETIMES,
    });

    assert.ok(zoneGroups.length > 1);
    const first = zoneGroups[0];
    assert.equal(first?.$name, 'zonegroup');
    assert.ok(first?.$attrs?.coordinator?.startsWith('RINCON_'));
    assert.ok(first?.$attrs?.id);
  });

  it('accepts strings, collapses single children and expands repeated ones', async () => {
    const xml =
      '<root><one val="1"/><many val="a"/><many val="b"/><text>hello</text><mixed k="v">t</mixed></root>';
    const root = await firstXmlTag(xml, 'root');

    assert.deepEqual(root?.one, { val: '1' }, 'attribute-only element becomes its attributes');
    assert.deepEqual(root?.many, [{ val: 'a' }, { val: 'b' }]);
    assert.equal(root?.text, 'hello', 'text-only element becomes a string');
    assert.deepEqual(root?.mixed, { $attrs: { k: 'v' }, $text: 't' });
  });

  it('never uses arrays when asked not to', async () => {
    const xml = '<root><many val="a"/><many val="b"/></root>';
    const root = await firstXmlTag(xml, 'root', { useArrays: XML_ARRAYS.NEVER });

    assert.deepEqual(root?.many, { val: 'a' });
  });

  it('resolves without events for an empty document', async () => {
    const nodes = await collectXmlTags('', 'anything');
    assert.deepEqual(nodes, []);
  });

  it('rejects when the source stream fails instead of hanging', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });

    await assert.rejects(parseXmlEvents(failing, {}), /connection reset/);
  });

  it('tolerates malformed XML without crashing', async () => {
    const nodes = await collectXmlTags('<a><b></a>', 'a');
    assert.equal(nodes.length, 1);
  });

  it('decodes entities in text so nested XML can be re-parsed', async () => {
    const property = await firstXmlTag(
      createReadStream(fixturePath('renderingcontrollastchange.xml')),
      'lastchange',
    );
    const inner = nodeText(property) ?? '';
    assert.ok(inner.startsWith('<Event'));

    const instance = await firstXmlTag(inner, 'instanceid');
    assert.deepEqual(asArray(instance?.volume as object[]).length, 3);
  });
});

describe('node helpers', () => {
  it('nodeText handles strings, nodes with text and everything else', () => {
    assert.equal(nodeText('plain'), 'plain');
    assert.equal(nodeText({ $attrs: { a: '1' }, $text: 'inner' }), 'inner');
    assert.equal(nodeText({ val: '1' }), undefined);
    assert.equal(nodeText(undefined), undefined);
    assert.equal(nodeText(42), undefined);
  });

  it('nodeValue reads val from attribute objects and accepts bare strings', () => {
    assert.equal(nodeValue({ val: 'PLAYING' }), 'PLAYING');
    assert.equal(nodeValue({ channel: 'Master', val: '12' }), '12');
    assert.equal(nodeValue('PLAYING'), 'PLAYING');
    assert.equal(nodeValue({ $attrs: { val: '1' }, $text: 'x' }), '1');
    assert.equal(nodeValue(undefined), undefined);
  });

  it('nodeAttrs reads $attrs or the simplified attribute object', () => {
    assert.deepEqual(nodeAttrs({ $attrs: { duration: '0:03:00' }, $text: 'x' }), {
      duration: '0:03:00',
    });
    assert.deepEqual(nodeAttrs({ channel: 'Master', val: '12' }), { channel: 'Master', val: '12' });
    assert.deepEqual(nodeAttrs('text'), {});
    assert.deepEqual(nodeAttrs(null), {});
  });

  it('asArray wraps single values and passes arrays through', () => {
    assert.deepEqual(asArray(undefined), []);
    assert.deepEqual(asArray('a'), ['a']);
    assert.deepEqual(asArray(['a', 'b']), ['a', 'b']);
  });
});
