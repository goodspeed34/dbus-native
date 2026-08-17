import * as dbus from '../index.js';
import * as net from 'node:net';

export function createServer(handler) {
  function Server() {
    let id = 123;
    this.server = net.createServer(socket => {
      socket.idd = id;
      id++;

      const dbusConn = dbus.createConnection({ stream: socket, server: true });
      if (handler) handler(dbusConn);
      // TODO: inherit from EE this.emit('connect', dbusConn);
    });
    this.listen = this.server.listen.bind(this.server);
  }
  return new Server();
}
