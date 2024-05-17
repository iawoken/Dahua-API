'use strict';

//? MODULES
const events = require('events');
const util = require('util');
const request = require('request');
const progress = require('request-progress');
const NetKeepAlive = require('net-keepalive');
const setKeypath = require('keypather/set');
const fs = require('fs');
const path = require('path');
const moment = require('moment');

//? CONSTANTS
const RECONNECT_TIMEOUT_SECONDS = 10;

class Dahua extends events.EventEmitter {
  constructor(options) {
    super();

    this.TRACE = options.log || false;
    this.BASEURI = `http://${options.host}:${options.port}`;
    this.USER = options.user;
    this.PASS = options.pass;
    this.HOST = options.host;

    this.client = options.cameraAlarms ? this.connect(options) : null;

    this.on('error', (err) => {
      console.error(`Error: ${err}`);
    });
  }

  connect(options) {
    let connected = false;
    const eventNames = ['All'];

    const opts = {
      url: `${this.BASEURI}/cgi-bin/eventManager.cgi?action=attach&codes=[${eventNames.join(',')}]`,
      forever: true,
      headers: { 'Accept': 'multipart/x-mixed-replace' }
    };

    console.log("Connecting...");
    const client = request(opts).auth(this.USER, this.PASS, false);

    client.on('socket', (socket) => {
      socket.setKeepAlive(true, 1000);
      NetKeepAlive.setKeepAliveInterval(socket, 1000);
      if (this.TRACE) console.log('TCP_KEEPINTVL:', NetKeepAlive.getKeepAliveInterval(socket));

      NetKeepAlive.setKeepAliveProbes(socket, 1);
      if (this.TRACE) console.log('TCP_KEEPCNT:', NetKeepAlive.getKeepAliveProbes(socket));
    });

    client.on('response', () => {
      connected = true;
      console.log("Connected to the server.")
      this.handleDahuaEventConnection(options);
    });

    client.on('error', (err) => {
      if (!connected) {
        console.error(`Connection closed- reconnecting in ${RECONNECT_TIMEOUT_SECONDS} seconds...`);
        setTimeout(() => this.connect(options), RECONNECT_TIMEOUT_SECONDS * 1000);
      }
      this.handleDahuaEventError(err);
    });

    client.on('data', (data) => {
      this.handleDahuaEventData(data);
    });

    client.on('close', () => {
      connected = false;
      console.error(`Connection closed- reconnecting in ${RECONNECT_TIMEOUT_SECONDS} seconds...`);
      setTimeout(() => this.connect(options), RECONNECT_TIMEOUT_SECONDS * 1000);
      this.handleDahuaEventEnd();
    });

    return client;
  }

  handleDahuaEventData(data) {
    if (this.TRACE) console.log(`Data: ${data.toString()}`);
    const dataArray = data.toString().split('\r\n');
    dataArray.forEach((item) => {
      if (item.startsWith('Code=')) {
        const alarm = item.split(';');
        if (alarm.length >= 3) {
          const code = alarm[0].substr(5);
          const action = alarm[1].substr(7);
          const index = alarm[2].substr(6);
          let metadata = {};

          if (alarm.length >= 4 && alarm[3].startsWith('data={')) {
            const metadataArray = alarm[3].split('\n');
            metadataArray[0] = '{';

            metadata = metadataArray.join('');
            try {
              metadata = JSON.parse(metadata);
              if (this.TRACE) console.dir(metadata, 'Got JSON parsed metadata');
            } catch (e) {
              this.emit("error", "Error during JSON.parse of alarm extra data");
              console.error(e, 'Error during JSON.parse of alarm extra data');
            }
          }

          this.emit("alarm", code, action, index, metadata);
        }
      }
    });
  }

  handleDahuaEventConnection(options) {
    if (this.TRACE) console.log(`Connected to ${options.host}:${options.port}`);
    this.emit("connect", options);
  }

  handleDahuaEventEnd() {
    if (this.TRACE) console.log("Connection closed!");
    this.emit("end");
  }

  handleDahuaEventError(err) {
    if (this.TRACE) console.log(`Connection error: ${err}`);
    this.emit("error", err);
  }
}

module.exports = Dahua;