// dbus.freedesktop.org/doc/dbus-specification.html

import { EventEmitter } from 'node:events';
import * as net from 'node:net';

import { connectToAddress } from './lib/address.js';
import constants from './lib/constants.js';
import * as message from './lib/message.js';
import clientHandshake from './lib/handshake.js';
import serverHandshake from './lib/server-handshake.js';
import MessageBus from './lib/bus.js';
import * as server from './lib/server.js';
import * as values from './lib/values.js';
import * as errors from './lib/errors.js';
import * as names from './lib/names.js';
import { publishSend, publishReceive } from './lib/diagnostics.js';
import { defineInterface } from './lib/define-interface.js';
import { createBroker } from './lib/broker.js';

// macOS does not set DBUS_SESSION_BUS_ADDRESS -- dbus there advertises the
// session bus through launchd instead, which is what dbus's own client library
// falls back to. Without this, sessionBus() on a Mac fails with 'unknown bus
// address' even when a session bus is running perfectly well.
const DEFAULT_SESSION_ADDRESS =
  process.platform === 'darwin'
    ? 'launchd:env=DBUS_LAUNCHD_SESSION_BUS_SOCKET'
    : undefined;

function createStream(opts) {
  if (opts.stream) return opts.stream;
  const { host, port, socket } = opts;
  if (socket) return net.createConnection(socket);
  if (port) return net.createConnection(port, host);

  const busAddress =
    opts.busAddress ||
    process.env.DBUS_SESSION_BUS_ADDRESS ||
    DEFAULT_SESSION_ADDRESS;
  if (!busAddress) throw new Error('unknown bus address');

  const addresses = busAddress.split(';');
  for (let i = 0; i < addresses.length; ++i) {
    try {
      return connectToAddress(addresses[i]);
    } catch (e) {
      if (i === addresses.length - 1) throw e;
      console.warn(e.message);
    }
  }
}

/**
 * Reconnection settings, normalised.
 *
 * Off unless asked for. Reconnecting silently would change what a connection
 * means: the unique name is reassigned, so anyone holding the old one is
 * talking to nobody, and a service's owned names are gone until re-requested.
 * That is a decision for the program, not a default.
 */
function normaliseReconnect(reconnect, opts) {
  if (!reconnect) return null;
  const settings = reconnect === true ? {} : reconnect;
  // A caller-supplied stream cannot be redialled -- we did not open it and
  // have no idea how to open another. Refusing loudly beats reconnecting to
  // the same dead socket forever.
  if (opts.stream) {
    throw new Error(
      'reconnect cannot be used with opts.stream: a stream supplied by the ' +
        'caller cannot be reopened. Use busAddress, socket, host/port, or ' +
        'handle reconnection yourself.'
    );
  }
  const retries = settings.retries === undefined ? Infinity : settings.retries;
  const minDelay = settings.minDelay === undefined ? 100 : settings.minDelay;
  const maxDelay = settings.maxDelay === undefined ? 30000 : settings.maxDelay;
  const factor = settings.factor === undefined ? 2 : settings.factor;
  for (const [name, value] of Object.entries({ minDelay, maxDelay, factor })) {
    if (typeof value !== 'number' || !(value > 0)) {
      throw new TypeError(`reconnect.${name} must be a positive number`);
    }
  }
  if (retries !== Infinity && !(Number.isInteger(retries) && retries >= 0)) {
    throw new TypeError('reconnect.retries must be a non-negative integer');
  }
  return { retries, minDelay, maxDelay, factor };
}

function createConnection(opts) {
  const self = new EventEmitter();
  if (!opts) opts = {};

  // Removed rather than ignored. Someone still passing this expects a Long
  // back, and would otherwise get a bigint and discover it at `value.toNumber
  // is not a function` -- somewhere else entirely, at whatever point the value
  // is first used. `ReturnLongjs: false` is not an error: it asked not to be
  // given Longs, and it is not being given any.
  if (opts.ReturnLongjs) {
    throw new TypeError(
      "The 'ReturnLongjs' option was removed: 64-bit values (x/t) are native " +
        'BigInt, which represents the full range exactly and without a ' +
        "dependency. Pass 'returnBigInt: false' for the lossy number 1.x " +
        'returned by default. See docs/deprecations.md#dbus_dep0001'
    );
  }

  const reconnect = normaliseReconnect(opts.reconnect, opts);

  // Rebindable, because a reconnect replaces the socket while `self` stays the
  // same object: callers hold `bus.connection`, and handing them a new one
  // would make every stored reference stale.
  let stream;
  // Set once we have reported a fatal protocol error and torn the stream down
  // ourselves, so the teardown does not surface as a second error.
  let fatal = false;
  let canCork = false;
  let corked = false;
  let canSendFds = false;
  // True once the caller has asked for the connection to go away, so an
  // ordinary close is not mistaken for one worth reconnecting after.
  let ending = false;
  let attempt = 0;
  let retryTimer = null;

  function writeMessage(msg) {
    publishSend(msg);
    const buffer = message.marshall(msg);

    if (msg.fds && msg.fds.length) {
      if (!canSendFds) throw new Error(constants.noFdTransport('sent'));
      // Deliberately outside the cork. Batching concatenates messages into one
      // write, and ancillary data attaches to a write rather than to a message
      // -- so a batched fd-carrying message would hand its descriptors to
      // whichever message the kernel happened to associate them with. Flushing
      // first costs a syscall on a rare message and keeps fds with their own.
      if (corked && !stream.destroyed) {
        corked = false;
        stream.uncork();
      }
      return stream.writeWithFds(buffer, msg.fds);
    }

    if (canCork && !corked) {
      corked = true;
      stream.cork();
      process.nextTick(() => {
        corked = false;
        // The stream may have been destroyed between cork and uncork.
        if (!stream.destroyed) stream.uncork();
      });
    }
    // Propagate the writable's backpressure signal: false means its buffer is
    // over the high water mark and the caller should wait for 'drain'.
    return stream.write(buffer);
  }

  // Buffers until the handshake completes; replaced by writeMessage on
  // 'connect'. Reports no backpressure, since nothing has reached a socket.
  function bufferMessage(msg) {
    self._messages.push(msg);
    return true;
  }

  function refuseMessage() {
    console.warn("Didn't write bytes to closed stream");
    return false;
  }

  /** Everything that belongs to one socket. Run again per reconnect. */
  function attachStream() {
    fatal = false;
    stream = self.stream = createStream(opts);
    stream.setNoDelay?.();

    canCork =
      typeof stream.cork === 'function' && typeof stream.uncork === 'function';
    corked = false;
    // A transport that can carry file descriptors declares itself by having
    // these. Nothing in this package provides one -- see ROADMAP 2.8 for why
    // -- so it comes from `opts.stream`, and everything above it works the day
    // one exists.
    canSendFds = typeof stream.writeWithFds === 'function';
    self.canPassFds = canSendFds;

    stream.on('error', err => {
      // Remembered rather than only forwarded, so that whatever fails the
      // pending calls on teardown can name what killed the connection. The bus
      // deliberately does not listen for 'error' itself -- doing so would stop
      // an unhandled connection error from crashing the process.
      self.lastError = err;
      // forward network and stream errors
      if (fatal) return;
      // A failed *re*dial is reported as a retry rather than as a connection
      // error: the connection has already told everyone it went away, and a
      // second 'error' with no listener would take the process down for
      // something we are about to try again.
      if (reconnect && !ending && self.state !== 'connected') {
        return scheduleRetry(err);
      }
      self.emit('error', err);
    });

    stream.on('end', () => {
      self.emit('end');
      self.message = refuseMessage;
    });

    // Emitted once the transport is fully torn down, however that happened.
    // The bus uses it to fail calls that can no longer get a reply.
    stream.on('close', () => {
      const wasConnected = self.state === 'connected';
      self.state = 'disconnected';
      self.message = refuseMessage;
      self.emit('close', self.lastError);
      if (reconnect && !ending && wasConnected) scheduleRetry(self.lastError);
    });

    // Forwarded so callers that stopped writing on a `false` from message()
    // know when it is safe to resume.
    stream.on('drain', () => self.emit('drain'));

    const handshake = opts.server ? serverHandshake : clientHandshake;
    handshake(stream, opts, (error, guid, identity, negotiated) => {
      if (error) {
        if (reconnect && !ending) return scheduleRetry(error);
        return self.emit('error', error);
      }
      self.guid = guid;
      // Whether the *peer* agreed to descriptors, which is not the same
      // question as whether our transport can carry them: both have to be true
      // before a message with fds will get anywhere.
      self.unixFdsAgreed = Boolean(negotiated && negotiated.unixFd);
      // What the server side learnt about the peer while authenticating: the
      // mechanism, and the uid it claimed. Undefined on a client connection,
      // where there is nothing to learn. lib/broker.js answers
      // GetConnectionUnixUser from it.
      if (identity) self.identity = identity;

      const reconnected = attempt > 0;
      attempt = 0;
      self.state = 'connected';
      for (const msg of self._messages) writeMessage(msg);
      self._messages.length = 0;
      self.message = writeMessage;

      // 'connect' fires once, for the first socket. A later one is a
      // 'reconnect', so a listener written for setup does not run twice.
      self.emit(reconnected ? 'reconnect' : 'connect');

      // Descriptors arrive alongside the bytes but on their own event, so they
      // are queued in arrival order and each message takes the number its
      // UNIX_FDS header claims. SCM_RIGHTS delivers them in the same order as
      // the bytes they accompany, which is what makes counting sufficient --
      // and is how libdbus does it too.
      const received = [];
      stream.on('fds', fds => {
        for (const fd of fds) received.push(fd);
      });
      const takeFds = count => {
        // One capability, both directions: a stream that cannot send
        // descriptors is not going to have received any either, and saying
        // *that* is more use than "claimed 1, got 0" -- which is true but
        // leaves the reader to work out that the transport was never able to.
        if (count > 0 && !canSendFds) {
          throw new message.ProtocolError(constants.noFdTransport('received'));
        }
        return received.splice(0, count);
      };

      message.unmarshalMessages(
        stream,
        msg => {
          publishReceive(msg);
          self.emit('message', msg);
        },
        opts,
        err => {
          // Framing is unrecoverable: we no longer know where the next message
          // starts, so surface the error and drop the connection rather than
          // resynchronising on garbage.
          self.lastError = err;
          self.emit('error', err);
          fatal = true;
          stream.destroy();
        },
        err => {
          // A throw from a 'message' listener is an application bug, not a
          // transport failure, so it does not go to 'error' -- a handler there
          // would reasonably assume the connection is gone.
          if (self.listenerCount('handlerError') > 0) {
            self.emit('handlerError', err);
            return;
          }
          // Nobody is listening. Preserve Node's default for an exception in
          // an event listener (crash the process) rather than swallowing an
          // application bug -- but do it asynchronously, so the read loop
          // still drains the messages it has already buffered.
          process.nextTick(() => {
            throw err;
          });
        },
        takeFds
      );
    });
  }

  /**
   * Wait, then dial again.
   *
   * Exponential with a ceiling, because the common reason a session bus is
   * unreachable is that it is restarting, and hammering it does not help.
   * Nothing in flight is retried -- see 'reconnect' in docs/api.md.
   */
  function scheduleRetry(cause) {
    if (retryTimer || ending) return;
    if (attempt >= reconnect.retries) {
      self.emit('reconnectFailed', cause);
      return;
    }
    const delay = Math.min(
      reconnect.maxDelay,
      reconnect.minDelay * Math.pow(reconnect.factor, attempt)
    );
    attempt++;
    self.emit('reconnecting', { attempt, delay, cause });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (ending) return;
      // Buffer again, so a message written between now and the handshake
      // completing goes out rather than warning to stderr.
      self.message = bufferMessage;
      attachStream();
    }, delay);
    // Deliberately *not* unref'd. A live socket holds the event loop open, so
    // a connection trying to get back to one should too -- otherwise a daemon
    // whose bus restarted exits during the gap, which is precisely the case
    // this exists for. `end()` and the disposer clear the timer, so a program
    // that wants to stop can.
  }

  self.end = () => {
    ending = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    stream.end();
    return self;
  };

  // Lets a raw connection be scoped the way a MessageBus can be. Resolves once
  // the transport is actually down rather than merely asked to close, so a
  // caller that awaits it knows the socket has gone.
  self[Symbol.asyncDispose] = () =>
    new Promise(resolve => {
      ending = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (stream.destroyed) return setImmediate(resolve);
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      self.once('close', done);
      self.once('end', done);
      stream.end();
    });

  // The shapes the parser hands back, changeable after the connection is up.
  //
  // This exists for `dbus-native/compat`, and it is the only faithful way to
  // build it: `plainValues` discards a variant's inner signature as it reads
  // it, so no amount of post-processing downstream can reconstruct
  // `[signatureTree, [value]]` -- it would have to invent the tree. Asking the
  // parser is the difference between the real signature and a guess.
  //
  // A fresh DBusBuffer is built per message from this same options object, so a
  // change takes effect on the next message in. Only the value-shape keys are
  // writable: `maxMessageSize` and the transport options are read once during
  // setup, and letting those be poked afterwards would do nothing visible
  // except confuse whoever tried.
  self.setValueShapes = shapes => {
    for (const key of ['plainValues', 'returnBigInt', 'ayBuffer', 'variants']) {
      if (Object.hasOwn(shapes, key)) opts[key] = shapes[key];
    }
    return self;
  };

  self._messages = [];
  self.message = bufferMessage;

  attachStream();

  return self;
}

export function createClient(params) {
  const connection = createConnection(params || {});
  return new MessageBus(connection, params || {});
}

export function systemBus() {
  return createClient({
    busAddress:
      process.env.DBUS_SYSTEM_BUS_ADDRESS ||
      'unix:path=/var/run/dbus/system_bus_socket'
  });
}

export function sessionBus(opts) {
  return createClient(opts);
}

export const messageType = constants.messageType;

// The error classes, so `err instanceof DBusError` works. index.d.ts has
// declared these since 0.6 but index.js never exported them, which made the
// documented way of handling errors impossible at runtime.
export const DBusError = errors.DBusError;
export const TimeoutError = errors.TimeoutError;
export const AbortError = errors.AbortError;
export const ConnectionClosedError = errors.ConnectionClosedError;
export const UnknownInterfaceError = errors.UnknownInterfaceError;

// Forward-compatible value helpers. Code written against these behaves the
// same before and after the 2.0 type-system change -- see docs/deprecations.md
// and RELEASE_PLAN.md.
export const Variant = values.Variant;
export const variantValue = values.variantValue;
export const variantSignature = values.variantSignature;
export const toPlain = values.toPlain;

// The D-Bus naming rules, exported because anything building names at runtime
// -- from a config file, a device id, a user-supplied string -- wants to check
// before it exports rather than catch the throw afterwards.
export const isValidObjectPath = names.isValidObjectPath;
export const isValidInterfaceName = names.isValidInterfaceName;
export const isValidErrorName = names.isValidErrorName;
export const isValidMemberName = names.isValidMemberName;
export const isValidPropertyName = names.isValidPropertyName;
export const isValidBusName = names.isValidBusName;

export { createConnection };

// Declaring a service interface without the positional arrays. Compiles to the
// classic descriptor, so it exports through the same path. See
// lib/define-interface.js.
export { defineInterface };

export const createServer = server.createServer;

// An in-process message bus. Not a replacement for dbus-daemon -- no security
// policy, no service activation -- but enough of one to route between clients,
// which is what `createServer` on its own never did. See lib/broker.js.
export { createBroker };
