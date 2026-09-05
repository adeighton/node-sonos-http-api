import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { describe, it } from 'node:test';

import { fixturePath } from '../testing/fixtures.ts';
import { parseServices } from './parse-services.ts';
import { firstXmlTag, nodeText } from './xml.ts';

describe('parseServices', () => {
  it('maps every service in the fixture to id, capabilities and type', async () => {
    const node = await firstXmlTag(
      createReadStream(fixturePath('listavailableservices.xml')),
      'availableservicedescriptorlist',
    );
    const services = await parseServices(nodeText(node) ?? '');

    assert.deepEqual(services['Spotify'], { id: 9, capabilities: 68115, type: 2311 });
    assert.deepEqual(services['Apple Music'], { id: 204, capabilities: 1020481, type: 52231 });
    assert.deepEqual(services['Deezer'], { id: 2, capabilities: 6739, type: 519 });
    assert.equal(Object.keys(services).length, 39);
  });

  it('ignores services without a name and returns an empty map for empty input', async () => {
    assert.deepEqual(await parseServices('<Services><Service Id="1"/></Services>'), {});
    assert.deepEqual(await parseServices(''), {});
  });
});
