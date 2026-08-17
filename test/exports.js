// The public export surface.
//
// index.d.ts declares these, but a declaration file cannot notice that
// index.js never actually exported the value -- tsc type-checks against the
// .d.ts regardless. That gap shipped in 0.6: DBusError was documented, typed,
// and undefined at runtime. This asserts the runtime side.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as dbus from '../index.js';
import { withClassicTypes, toClassicError } from '../lib/compat.js';
import marshall from '../lib/marshall.js';
import unmarshall from '../lib/unmarshall.js';

describe('public exports', () => {
  it('exports the error classes so instanceof works', () => {
    for (const name of [
      'DBusError',
      'TimeoutError',
      'AbortError',
      'ConnectionClosedError',
      'UnknownInterfaceError'
    ]) {
      assert.strictEqual(typeof dbus[name], 'function', `${name} is exported`);
    }
    assert.ok(new dbus.TimeoutError(1, {}) instanceof dbus.DBusError);
    assert.ok(new dbus.ConnectionClosedError({}) instanceof dbus.DBusError);
    assert.ok(new dbus.DBusError('x') instanceof Error);
  });

  it('exports the value helpers', () => {
    for (const name of [
      'Variant',
      'variantValue',
      'variantSignature',
      'toPlain'
    ]) {
      assert.strictEqual(typeof dbus[name], 'function', `${name} is exported`);
    }
  });

  it('exports the name validators', () => {
    for (const name of [
      'isValidObjectPath',
      'isValidInterfaceName',
      'isValidErrorName',
      'isValidMemberName',
      'isValidBusName'
    ]) {
      assert.strictEqual(typeof dbus[name], 'function', `${name} is exported`);
    }
    assert.strictEqual(dbus.isValidInterfaceName('org.example.Iface'), true);
    assert.strictEqual(dbus.isValidObjectPath('/org/example'), true);
  });

  it('exports the entry points', () => {
    for (const name of [
      'createClient',
      'sessionBus',
      'systemBus',
      'createConnection',
      'createServer'
    ]) {
      assert.strictEqual(typeof dbus[name], 'function', `${name} is exported`);
    }
    assert.strictEqual(typeof dbus.messageType, 'object');
  });
});

// The package is ESM now, so every runtime export is a named import by
// construction. These checks keep the surface honest anyway -- a refactor that
// drops an export would fail here.
describe('ESM surface', () => {
  it('exposes the full runtime surface', () => {
    const expected = [
      'AbortError',
      'ConnectionClosedError',
      'DBusError',
      'TimeoutError',
      'UnknownInterfaceError',
      'Variant',
      'createBroker',
      'createClient',
      'createConnection',
      'createServer',
      'defineInterface',
      'isValidBusName',
      'isValidErrorName',
      'isValidInterfaceName',
      'isValidMemberName',
      'isValidObjectPath',
      'isValidPropertyName',
      'messageType',
      'sessionBus',
      'systemBus',
      'toPlain',
      'variantSignature',
      'variantValue'
    ];
    const missing = expected.filter(k => !(k in dbus));
    assert.deepStrictEqual(missing, [], `not exported: ${missing.join(', ')}`);
  });

  it('resolves the compat subpath', () => {
    assert.strictEqual(typeof withClassicTypes, 'function');
    assert.strictEqual(typeof toClassicError, 'function');
  });

  it('resolves deep lib/ subpaths', () => {
    assert.strictEqual(typeof marshall, 'function');
    assert.strictEqual(typeof unmarshall, 'function');
  });

  it('round-trips a value through the imported functions', () => {
    const [dict] = unmarshall(marshall('a{sv}', [{ n: 7n }]), 'a{sv}');
    assert.deepStrictEqual(dbus.toPlain(dict), { n: 7n });
  });
});
