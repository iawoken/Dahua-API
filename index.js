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

  //? PTZ (Pan-Tilt-Zoom)
  ptzCommand(cmd, arg1, arg2, arg3, arg4) {
    var self = this;
    if ((!cmd) || (isNaN(arg1)) || (isNaN(arg2)) || (isNaN(arg3)) || (isNaN(arg4))) {
      self.emit("error", 'INVALID PTZ COMMAND');
      return 0;
    }
    request(self.BASEURI + '/cgi-bin/ptz.cgi?action=start&channel=0&code=' + ptzcommand + '&arg1=' + arg1 + '&arg2=' + arg2 + '&arg3=' + arg3 + '&arg4=' + arg4, function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ COMMAND');
      }
    }).auth(self.USER, self.PASS, false);
  }

  ptzPreset(preset) {
    var self = this;
    if (isNaN(preset)) self.emit("error", 'INVALID PTZ PRESET');
    request(self.BASEURI + '/cgi-bin/ptz.cgi?action=start&channel=0&code=GotoPreset&arg1=0&arg2=' + preset + '&arg3=0', function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ PRESET');
      }
    }).auth(self.USER, self.PASS, false);
  }

  ptzZoom(multiple) {
    var self = this;
    if (isNaN(multiple)) self.emit("error", 'INVALID PTZ ZOOM');
    if (multiple > 0) cmd = 'ZoomTele';
    if (multiple < 0) cmd = 'ZoomWide';
    if (multiple === 0) return 0;

    request(self.BASEURI + '/cgi-bin/ptz.cgi?action=start&channel=0&code=' + cmd + '&arg1=0&arg2=' + multiple + '&arg3=0', function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ ZOOM');
      }
    }).auth(self.USER, self.PASS, false);
  }

  ptzMove(direction, action, speed) {
    var self = this;
    if (isNaN(speed)) self.emit("error", 'INVALID PTZ SPEED');
    if ((action !== 'start') || (action !== 'stop')) {
      self.emit("error", 'INVALID PTZ COMMAND');
      return 0;
    }
    if ((direction !== 'Up') || (direction !== 'Down') || (direction !== 'Left') || (direction !== 'Right') ||
      (direction !== 'LeftUp') || (direction !== 'RightUp') || (direction !== 'LeftDown') || (direction !== 'RightDown')) {
      self.emit("error", 'INVALID PTZ DIRECTION');
      return 0;
    }
    request(self.BASEURI + '/cgi-bin/ptz.cgi?action=' + action + '&channel=0&code=' + direction + '&arg1=' + speed + '&arg2=' + speed + '&arg3=0', function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'FAILED TO ISSUE PTZ UP COMMAND');
      }
    }).auth(self.USER, self.PASS, false);
  }

  ptzStatus() {
    var self = this;
    request(self.BASEURI + '/cgi-bin/ptz.cgi?action=getStatus', function (error, response, body) {
      if ((!error) && (response.statusCode === 200)) {
        body = body.toString().split('\r\n');
        self.emit("ptzStatus", body);
      } else {
        self.emit("error", 'FAILED TO QUERY STATUS');
      }
    }).auth(self.USER, self.PASS, false);
  }

  //? PROFILES
  dayProfile() {
    var self = this;
    request(self.BASEURI + '/cgi-bin/configManager.cgi?action=setConfig&VideoInMode[0].Config[0]=1', function (error, response, body) {
      if ((!error) && (response.statusCode === 200)) {
        if (body === 'Error') { //! Didnt work, lets try another method for older cameras
          request(self.BASEURI + '/cgi-bin/configManager.cgi?action=setConfig&VideoInOptions[0].NightOptions.SwitchMode=0', function (error, response, body) {
            if ((error) || (response.statusCode !== 200)) {
              self.emit("error", 'FAILED TO CHANGE TO DAY PROFILE');
            }
          }).auth(self.USER, self.PASS, false);
        }
      } else {
        self.emit("error", 'FAILED TO CHANGE TO DAY PROFILE');
      }
    }).auth(self.USER, self.PASS, false);
  }

  nightProfile() {
    var self = this;
    request(self.BASEURI + '/cgi-bin/configManager.cgi?action=setConfig&VideoInMode[0].Config[0]=2', function (error, response, body) {
      if ((!error) && (response.statusCode === 200)) {
        if (body === 'Error') { //! Didnt work, lets try another method for older cameras
          request(self.BASEURI + '/cgi-bin/configManager.cgi?action=setConfig&VideoInOptions[0].NightOptions.SwitchMode=3', function (error, response, body) {
            if ((error) || (response.statusCode !== 200)) {
              self.emit("error", 'FAILED TO CHANGE TO NIGHT PROFILE');
            }
          }).auth(self.USER, self.PASS, false);
        }
      } else {
        self.emit("error", 'FAILED TO CHANGE TO NIGHT PROFILE');
      }
    }).auth(self.USER, self.PASS, false);
  }

  //? FILE FINDING
  findFiles = function (query) {
    var self = this;

    if ((!query.channel) || (!query.startTime) || (!query.endTime)) {
      self.emit("error", 'FILE FIND MISSING ARGUMENTS');
      return 0;
    }

    this.createFileFind();
    this.on('fileFinderCreated', function (objectId) {
      if (self.TRACE) console.log('fileFinderId:', objectId);
      self.startFileFind(objectId, query.channel, query.startTime, query.endTime, query.types);
    });

    this.on('startFileFindDone', function (objectId, body) {
      if (self.TRACE) console.log('startFileFindDone:', objectId, body);
      self.nextFileFind(objectId, query.count);
    });

    this.on('nextFileFindDone', function (objectId, items) {
      if (self.TRACE) console.log('nextFileFindDone:', objectId);
      items.query = query;
      self.emit('filesFound', items);
      self.closeFileFind(objectId);
    });

    this.on('closeFileFindDone', function (objectId, body) {
      if (self.TRACE) console.log('closeFileFindDone:', objectId, body);
      self.destroyFileFind(objectId);
    });

    this.on('destroyFileFindDone', function (objectId, body) {
      if (self.TRACE) console.log('destroyFileFindDone:', objectId, body);
    });
  }

  //! http://<ip>/cgi-bin/mediaFileFind.cgi?action=factory.create
  createFileFind() {
    var self = this;
    request(self.BASEURI + '/cgi-bin/mediaFileFind.cgi?action=factory.create', function (error, response, body) {
      if ((error)) {
        self.emit("error", 'ERROR ON CREATE FILE FIND COMMAND');
      }

      var oid = body.trim().substr(7);
      self.emit("fileFinderCreated", oid);
    }).auth(self.USER, self.PASS, false);
  }

  //! http://<ip>/cgi-bin/mediaFileFind.cgi?action=findFile&object=<objectId>&condition.Channel=<channel>&condition.StartTime= <start>&condition.EndT ime=<end>&condition.Dirs[0]=<dir>&condition.Types[0]=<type>&condition.Flag[0]=<flag>&condition.E vents[0]=<event>

  //? Comment
  //? Start to find file wth the above condition. If start successfully, return true, else return false.
  //? object : The object Id is got from interface in 10.1.1 Create
  //? condition.Channel: in which channel you want to find the file.
  //? condition.StartTime/condition.EndTime: the start/end time when recording.
  //? condition.Dirs: in which directories you want to find the file. It is an array. The index starts from 0. The range of dir is {“/mnt/dvr/sda0”, “/mnt/dvr/sda1”}. This condition can be omitted. If omitted, find files in all the directories.
  //? condition.Types: which types of the file you want to find. It is an array. The index starts from 0. The range of type is {“dav”,
  //? “jpg”, “mp4”}. If omitted, find files with all the types.
  //? condition.Flags: which flags of the file you want to find. It is an array. The index starts from 0. The range of flag is {“Timing”, “Manual”, “Marker”, “Event”, “Mosaic”, “Cutout”}. If omitted, find files with all the flags.
  //? condition.Event: by which event the record file is triggered. It is an array. The index starts from 0. The range of event is {“AlarmLocal”, “VideoMotion”, “VideoLoss”, “VideoBlind”, “Traffic*”}. This condition can be omitted. If omitted, find files of all the events.

  //? Example:
  //? Find file in channel 1, in directory “/mnt/dvr/sda0",event type is "AlarmLocal" or "VideoMotion", file type is “dav”, and time between 2011-1-1 12:00:00 and 2011-1-10 12:00:00 , URL is: http://<ip>/cgi-bin/mediaFileFind.cgi?action=findFile&object=08137&condition.Channel=1&conditon.Dir[0]=”/mnt/dvr/sda0”& conditon.Event[0]=AlarmLocal&conditon.Event[1]=V ideoMotion&condition.StartT ime=2011-1-1%2012:00:00&condition.EndT i me=2011-1-10%2012:00:00

  //! To be Done: Implement Dirs, Types, Flags, Event Args
  startFileFind = function (objectId, channel, startTime, endTime, types) {
    var self = this;
    if ((!objectId) || (!channel) || (!startTime) || (!endTime)) {
      self.emit("error", 'INVALID FINDFILE COMMAND - MISSING ARGS');
      return 0;
    }

    types = types || [];
    var typesQueryString = "";

    types.forEach(function (el, idx) {
      typesQueryString += '&condition.Types[' + idx + ']=' + el;
    });

    var url = self.BASEURI + '/cgi-bin/mediaFileFind.cgi?action=findFile&object=' + objectId + '&condition.Channel=' + channel + '&condition.StartTime=' + startTime + '&condition.EndTime=' + endTime + typesQueryString;
    request(url, function (error, response, body) {
      if ((error)) {
        if (self.TRACE) console.log('startFileFind Error:', error);
        self.emit("error", 'FAILED TO ISSUE FIND FILE COMMAND');
      } else {
        if (self.TRACE) console.log('startFileFind Response:', body.trim());

        // no results = http code 400 ?
        //if(response.statusCode == 400 ) {
        //  self.emit("error", 'FAILED TO ISSUE FIND FILE COMMAND - NO RESULTS ?');
        //} else {
        //
        self.emit('startFileFindDone', objectId, body.trim());
        //}
      }
    }).auth(self.USER, self.PASS, false);
  }

  //? 10.1.3 FindNextFile
  //! http://<ip>/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=<objectId>&count=<fileCount>

  //? Comment
  //? Find the next fileCount files.
  //? The maximum value of fileCount is 100.

  //? Response
  //? found=1
  //? items[0]. Channel =1
  //? items[0]. StartTime =2024-1-1 12:00:00
  //? items[0]. EndTime =2024-1-1 13:00:00
  //? items[0]. Type =dav
  //? items[0]. Events[0]=AlarmLocal
  //? items[0]. FilePath =/mnt/dvr/sda0/2024/4/9/dav/15:40:50.jpg items[0]. Length =790
  //? items[0]. Duration = 3600
  //? items[0].SummaryOffset=2354
  //? tems[0].Repeat=0
  //? items[0].WorkDir=”/mnt/dvr/sda0”
  //? items[0]. Overwrites=5
  //? items[0]. WorkDirSN=0

  nextFileFind(objectId, count) {

    var self = this;
    count = count || 100;

    if ((!objectId)) {
      self.emit("error", 'INVALID NEXT FILE COMMAND');
      return 0;
    }

    request(self.BASEURI + '/cgi-bin/mediaFileFind.cgi?action=findNextFile&object=' + objectId + '&count=' + count, function (error, response, body) {
      if ((error) || (response.statusCode !== 200)) {
        if (self.TRACE) console.log('nextFileFind Error:', error);
        self.emit("error", 'FAILED NEXT FILE COMMAND');
      }

      // if (self.TRACE) console.log('nextFileFind Response:',body.trim());

      var items = {};
      var data = body.split('\r\n');

      items.found = data[0].split("=")[1];

      data.forEach(function (item) {
        if (item.startsWith('items[')) {
          var propertyAndValue = item.split("=");
          setKeypath(items, propertyAndValue[0], propertyAndValue[1]);
        }
      });

      self.emit('nextFileFindDone', objectId, items);
    }).auth(self.USER, self.PASS, false);
  }

  //? 10.1.4 Close
  //! http://<ip>/cgi-bin/mediaFileFind.cgi?action=close&object=<objectId>

  closeFileFind(objectId) {
    var self = this;
    if ((!objectId)) {
      self.emit("error", 'OBJECT ID MISSING');
      return 0;
    }
    request(self.BASEURI + '/cgi-bin/mediaFileFind.cgi?action=close&object=' + objectId, function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'ERROR ON CLOSE FILE FIND COMMAND');
      }

      self.emit('closeFileFindDone', objectId, body.trim());
    }).auth(self.USER, self.PASS, false);
  }

  //? 10.1.5 Destroy
  //! http://<ip>/cgi-bin/mediaFileFind.cgi?action=destroy&object=<objectId>

  destroyFileFind(objectId) {
    var self = this;
    if ((!objectId)) {
      self.emit("error", 'OBJECT ID MISSING');
      return 0;
    }
    request(self.BASEURI + '/cgi-bin/mediaFileFind.cgi?action=destroy&object=' + objectId, function (error, response, body) {
      if ((error) || (response.statusCode !== 200) || (body.trim() !== "OK")) {
        self.emit("error", 'ERROR ON DESTROY FILE FIND COMMAND');
      }

      self.emit('destroyFileFindDone', objectId, body.trim());
    }).auth(self.USER, self.PASS, false);
  }

  //? LOAD FILE(S)
  //! http://<ip>/cgi-bin/RPC_Loadfile/<filename>

  //? Response
  //* HTTP Code: 200 OK
  //* Content-Type: Application/octet-stream
  //* Content-Length:<fileLength>
  //* Body:
  //* <data>
  //* <data>

  //! For example: http://10.61.5.117/cgi-bin/RPC_Loadfile/mnt/sd/2012-07-13/001/dav/09/09.30.37-09.30.47[R][0@0][0].dav

  saveFile = function (file, filename) {
    var self = this;

    if ((!file)) {
      self.emit("error", 'FILE OBJECT MISSING');
      return 0;
    }

    if ((!file.FilePath)) {
      self.emit("error", 'FILEPATH in FILE OBJECT MISSING');
      return 0;
    }

    if (!filename) {

      if (!file.Channel || !file.StartTime || !file.EndTime || !file.Type) {
        self.emit("error", 'FILE OBJECT ATTRIBUTES MISSING');
        return 0;
      }

      //? the fileFind response obejct
      //* { Channel: '0',
      //* Cluster: '0',
      //* Compressed: 'false',
      //* CutLength: '634359892',
      //* Disk: '0',
      //* Duration: '495',
      //* EndTime: '2018-05-19 10:45:00',
      //* FilePath: '/mnt/sd/2018-05-19/001/dav/10/10.36.45-10.45.00[R][0@0][0].dav',
      //* Flags: [Object],
      //* Length: '634359892',
      //* Overwrites: '0',
      //* Partition: '0',
      //* Redundant: 'false',
      //* Repeat: '0',
      //* StartTime: '2018-05-19 10:36:45',
      //* Summary: [Object],
      //* SummaryOffset: '0',
      //* Type: 'dav',
      //* WorkDir: '/mnt/sd',
      //* WorkDirSN: '0' };

      filename = this.generateFilename(self.HOST, file.Channel, file.StartTime, file.EndTime, file.Type);
    }

    progress(request(self.BASEURI + '/cgi-bin/RPC_Loadfile/' + file.FilePath))
      .auth(self.USER, self.PASS, false)
      .on('progress', function (state) {
        if (self.TRACE) {
          console.log('Downloaded', Math.floor(state.percent * 100) + '%', '@ ' + Math.floor(state.speed / 1000), 'KByte/s');
        }
      })
      .on('response', function (response) {
        if (response.statusCode !== 200) {
          self.emit("error", 'ERROR ON LOAD FILE COMMAND');
        }
      })
      .on('error', function (error) {
        if (error.code == "ECONNRESET") {
          self.emit("error", 'ERROR ON LOAD FILE COMMAND - FILE NOT FOUND?');
        } else {
          self.emit("error", 'ERROR ON LOAD FILE COMMAND');
        }
      })
      .on('end', function () {
        self.emit("saveFile", {
          'status': 'DONE',
        });
      })
      .pipe(fs.createWriteStream(filename));
  }

  //? GET SNAPSHOT
  //! http://<ip>/cgi-bin/snapshot.cgi? [channel=<channelNo>]

  //? Response
  //* A picture encoded by jpg

  //? Comment
  //* The channel number is default 0 if the request is not carried the param.

  getSnapshot = function (options) {
    var self = this;
    options = options || {};

    if ((!options.channel)) options.channel = 0;
    if ((!options.path)) options.path = ''

    if (!options.filename) {
      options.filename = this.generateFilename(self.HOST, options.channel, moment(), '', 'jpg');
    }

    request(self.BASEURI + '/cgi-bin/snapshot.cgi?' + options.channel, function (error, response, body) {
      if ((error) || (response.statusCode !== 200)) {
        self.emit("error", 'ERROR ON SNAPSHOT');
      }
    })
      .on('end', function () {
        if (self.TRACE) console.log('SNAPSHOT SAVED');
        self.emit("getSnapshot", {
          'status': 'DONE',
        });
      })
      .auth(self.USER, self.PASS, false).pipe(fs.createWriteStream(path.join(options.path, options.filename)));
  }

  generateFilename(device, channel, start, end, filetype) {
    filename = device + '_ch' + channel + '_';

    // to be done: LOCALIZATION ?
    startDate = moment(start);

    filename += startDate.format('YYYYMMDDhhmmss');
    if (end) {
      endDate = moment(end);
      filename += '_' + endDate.format('YYYYMMDDhhmmss');
    }

    filename += '.' + filetype;
    return filename;
  };
}

module.exports = Dahua;