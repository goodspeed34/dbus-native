// Cross-runtime smoke check for the ESM fork.
//
// Run with any of:
//   node scripts/smoke.mjs
//   bun scripts/smoke.mjs
//   deno run -A scripts/smoke.mjs
//
// Exercises the parts of the library that do not need a real D-Bus daemon:
// marshalling round-trips (including 64-bit bigint) and an in-process broker
// serving org.freedesktop.DBus to a connected client.

import * as dbus from '../index.js';
import marshall from '../lib/marshall.js';
import unmarshall from '../lib/unmarshall.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failures += 1;
};

// 1. a{sv} round-trip: a plain object is accepted as a dict, and a variant
//    comes back readable through toPlain().
const [dict] = unmarshall(
  marshall('a{sv}', [{ name: 'test', count: 5 }]),
  'a{sv}'
);
const plain = dbus.toPlain(dict);
check('a{sv} round-trip', plain.name === 'test' && plain.count === 5);

// 2. 64-bit bigint round-trip, exact.
const VALUE = 1234567890123456789n;
const [big] = unmarshall(marshall('x', [VALUE]), 'x');
check('int64 bigint round-trip', big === VALUE);

// 3. Variant helper.
check('Variant helper', new dbus.Variant('s', 'hi').value === 'hi');

// 4. In-process broker + client, a real method call end to end.
await new Promise((resolve, reject) => {
  const broker = dbus.createBroker();
  const timer = setTimeout(() => {
    broker.close();
    reject(new Error('smoke: broker round-trip timed out'));
  }, 5000);

  broker.listen((err, addr) => {
    if (err) return reject(err);
    const client = dbus.createClient({ busAddress: addr });
    client.on('error', reject);
    client.invoke(
      {
        type: dbus.messageType.methodCall,
        destination: 'org.freedesktop.DBus',
        path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus',
        member: 'ListNames'
      },
      (err2, names) => {
        clearTimeout(timer);
        if (err2) return reject(err2);
        check(
          'broker ListNames',
          Array.isArray(names) && names.includes('org.freedesktop.DBus')
        );
        broker.close();
        resolve();
      }
    );
  });
});

if (failures) {
  console.error(`smoke: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('smoke: all checks passed');
