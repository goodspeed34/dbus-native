import { describe, it } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { unmarshall } from '../lib/message.js';
import { marshall } from '../lib/message.js';

const dir = fileURLToPath(new URL('./fixtures/messages/', import.meta.url));

describe('given base-64 encoded files with complete messages', () => {
  it('should be able to read them all', () => {
    const messages = fs.readdirSync(dir);
    messages.forEach(name => {
      const msg = fs.readFileSync(dir + name, 'ascii');
      const msgBin = Buffer.from(msg, 'base64');
      const unmarshalledMsg = unmarshall(msgBin);
      const marshalled = marshall(unmarshalledMsg);
      assert.deepStrictEqual(unmarshalledMsg, unmarshall(marshalled));
    });
  });
});
