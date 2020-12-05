const { Duplex } = require('stream')
const mutexify = require('mutexify/promise')
const { YModemSenderStream, YModemReceiverStream } = require('./ymodem-stream')

const DELIMETER = Buffer.from('\r')

class DeviceStream extends Duplex {
  constructor () {
    super()

    const lock = mutexify()
    const future = lock()

    const oninitialize = data => {
      if (data !== 'OK') {
        return this.destroy(new Error('unexpected initialization response'))
      }

      future
        .then(release => {
          this.emit('initialize')
          this._onresponse = onresponse
          release()
        })
        .catch(err => this.destroy(err))

    }

    const onresponse = data => {
      this.emit('response', data)
    }

    this._lock = lock
    this._onresponse = oninitialize
    this._buffer = Buffer.alloc(0)

    this.push('+++')
  }

  async command (cmd, value, terminator) {
    const release = await this._lock()

    try {
      return await this._command(cmd, value, terminator)
    } finally {
      release()
    }
  }

  _read (n) {}

  _write (data, encoding, cb) {
    let buffer = Buffer.concat([this._buffer, data])
    let position = 0

    while ((position = buffer.indexOf(DELIMETER)) !== -1) {
      const line = buffer.slice(0, position)
      this._onresponse(line.toString('utf8'))
      buffer = buffer.slice(position + DELIMETER.length)
    }

    this._buffer = buffer
    cb()
  }

  _command (cmd, value, terminator) {
    const error = cmd === 'FS' ? 'E' : 'ERROR'
    value = value ? (' ' + value) : ''

    return new Promise((resolve, reject) => {
      this.push('AT' + cmd + value + '\r')

      const lines = []
      const onresponse = data => {
        if (terminator == null) {
          lines.push(data)
          resolve(lines)
          this.removeListener('response', onresponse)
        } else if (data === terminator) {
          resolve(lines)
          this.removeListener('response', onresponse)
        } else if (data.startsWith(error)) {
          reject(new Error('error response: ' + data))
        } else {
          lines.push(data)
        }
      }

      this.on('response', onresponse)
    })
  }
}

const main = async function () {
  const SerialPort = require('serialport')

  const port = new SerialPort('/dev/tty.usbserial-1410', {
    baudRate: 9600
  })

  const device = new DeviceStream()

  device.pipe(port).pipe(device)

  // console.log(await device.command('FS GET /flash/main.mpy'))

  console.log('NI', await device.command('NI'))
  console.log('SH', await device.command('SH'))
  console.log('FS LS', await device.command('FS LS', null, ''))
  console.log('FS PWD', await device.command('FS PWD'))
  console.log('FS HASH /flash/main.mpy', await device.command('FS HASH /flash/main.mpy'))
  console.log('FS INFO', await device.command('FS INFO', null, ''))
  console.log('FS INFO FULL', await device.command('FS INFO FULL', null, ''))
}

main().catch(err => console.error(err))
