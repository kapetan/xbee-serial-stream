# xbee-stream

XBee serial protocol implementation.

    npm install xbee-stream

## Usage

This library is transport agnostic. It implements the XBee serial protocol for sending AT commands. The following example shows how to use it with the [serialport](https://serialport.io) module.

```javascript
const DeviceStream = require('xbee-stream')
const SerialPort = require('serialport')

const stream = new DeviceStream()
const port = new SerialPort('/dev/tty.usbserial-1420', {
  baudRate: 9600
})

stream.pipe(port).pipe(stream)

// Get value for SH (serial number high)
const sh = await stream.command('SH')
```

The `FS PUT` command is supported using `createWriteStream` method. It initiates an YMODEM file transfer session and returns a writable stream which can be written to.

```javascript
const writeStream = stream.createWriteStream('/flash/test.txt', {
  length: 11
})

writeStream.write('hello')
writeStream.write(' ')
writeStream.write('world')
writeStream.end()
```

Similarly `FS GET` is supported with the `createReadStream` method.

```javascript
const readStream = stream.createReadStream('/flash/test.txt')

// The file event is emitted before any data events
readStream.on('file', ({ name, length }) => {})
readStream.on('data', data => {})
```

## API

#### Class: `DeviceStream()`

Create new instance of the protocol stream. The class implements the `Duplex` stream interface, everything written to an instance is treated as incoming data from the remote endpoint and everything read is outgoing to data to the endpoint.

##### `async command(cmd, [value], [terminator])`

- `cmd` AT command to execute. Usually two characters long, but may be longer, for example `FS LS`.
- `value` (optional) Set setting identified by the AT command to specified value.
- `terminator` (optional) The terminator condition for the command response. By default all text before the first carriage return is returned as the response. In some cases an empty string should be used as a the terminator, e.g. `FS LS` returns multiple lines (separated by carriage return) with an empty terminator line.
- Returns: `Array` of strings. Each entry is a line received from the device.

Execute an AT command on the device and await the response.

##### `createWriteStream(filename, [options])`

- `filename` Name of the file on the device.
- `options`
  - `length` (optional) The length of the file.
- Returns: `Writable` stream

##### `createReadStream(filename)`

- `filename` Name of the file on the device.
- Returns: `Readable` stream. The readable stream emits a `file` event, when name and length of the file has been read from the YMODEM header.
