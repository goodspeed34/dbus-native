// Observability via node:diagnostics_channel.
//
// A protocol library is a natural place for this: a great many of the issues
// on this tracker are some form of "I sent something and nothing happened",
// and being able to see the traffic answers those without a debug-logging API
// of our own.
//
// Publishing to a channel nobody has subscribed to is a boolean check, so this
// costs effectively nothing when unused -- `hasSubscribers` is checked before
// building any payload.
//
// `node:diagnostics_channel` is supported on Node, Bun and Deno. The import is
// still feature-detected so a runtime with only a partial implementation
// degrades to inert channels rather than failing to load the whole library.
//
// This must stay free of top-level await: it would make the whole package an
// async module graph, which breaks `require()` of it from CommonJS consumers.
// `createRequire` gives a synchronous, catchable way to probe for the channel.
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

let channel = () => null;
let tracingChannel = () => null;

try {
  const dc = nodeRequire('node:diagnostics_channel');
  channel = dc.channel;
  tracingChannel = dc.tracingChannel;
} catch {
  // No diagnostics_channel: everything below is a no-op.
}

// A channel may expose `hasSubscribers` as a getter or a method; read either.
const safeHasSubscribers = c =>
  typeof c?.hasSubscribers === 'function'
    ? c.hasSubscribers()
    : typeof c?.hasSubscribers === 'boolean'
      ? c.hasSubscribers
      : false;

const inert = () => ({
  hasSubscribers: false,
  publish() {}
});

const inertTrace = () => ({
  hasSubscribers: false,
  start: inert(),
  end: inert(),
  error: inert(),
  asyncStart: inert(),
  asyncEnd: inert()
});

const channels = {
  /** A message handed to the connection for writing. */
  send: channel('dbus:message:send') ?? inert(),
  /** A message decoded off the wire. */
  receive: channel('dbus:message:receive') ?? inert(),
  /** A method call starting, ending, or failing. */
  call: tracingChannel('dbus:call') ?? inertTrace()
};

function publishSend(message) {
  if (safeHasSubscribers(channels.send)) channels.send.publish({ message });
}

function publishReceive(message) {
  if (safeHasSubscribers(channels.receive))
    channels.receive.publish({ message });
}

export { channels, publishSend, publishReceive };
