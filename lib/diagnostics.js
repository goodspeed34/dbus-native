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
// Imported statically: `node:diagnostics_channel` is provided by Node, Bun and
// Deno alike, and this keeps the module graph synchronous (a top-level await
// would break `require()` of the package from CommonJS). Feature-detecting it
// via `createRequire` is not an option either: a Deno consumer loads this file
// from a remote jsr.io URL, where `createRequire` accepts no path.

import * as diagnostics_channel from 'node:diagnostics_channel';

const channels = {
  /** A message handed to the connection for writing. */
  send: diagnostics_channel.channel('dbus:message:send'),
  /** A message decoded off the wire. */
  receive: diagnostics_channel.channel('dbus:message:receive'),
  /** A method call starting, ending, or failing. */
  call: diagnostics_channel.tracingChannel('dbus:call')
};

function publishSend(message) {
  if (channels.send.hasSubscribers) channels.send.publish({ message });
}

function publishReceive(message) {
  if (channels.receive.hasSubscribers) channels.receive.publish({ message });
}

export { channels, publishSend, publishReceive };
