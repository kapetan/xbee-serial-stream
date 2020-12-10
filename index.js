const { Duplex, finished } = require('stream')
const { promisify } = require('util')
const Duplexify = require('duplexify')
const mutexify = require('mutexify/promise')
const { YModemReceiverStream, YModemSenderStream } = require('./ymodem-stream')

const DELIMETER = Buffer.from('\r')

class CommandStream extends Duplex {
  constructor () {
    super()
    this._buffer = Buffer.alloc(0)
  }

  command (cmd, value, terminator) {
    const error = cmd === 'FS' ? 'E' : 'ERROR'
    value = value ? (' ' + value) : ''
    return this.request('AT' + cmd + value + '\r', error, terminator)
  }

  request (data, error, terminator) {
    return new Promise((resolve, reject) => {
      this.push(data)

      const lines = []
      const onresponse = data => {
        if (terminator == null) {
          lines.push(data)
          this.removeListener('response', onresponse)
          resolve(lines)
        } else if (data === terminator) {
          this.removeListener('response', onresponse)
          resolve(lines)
        } else if (data.startsWith(error)) {
          this.removeListener('response', onresponse)
          reject(new Error('error response: ' + data))
        } else {
          lines.push(data)
        }
      }

      this.on('response', onresponse)
    })
  }

  _read (n) {}

  _write (data, encoding, cb) {
    let buffer = Buffer.concat([this._buffer, data])
    let position = 0

    while ((position = buffer.indexOf(DELIMETER)) !== -1) {
      const line = buffer.slice(0, position)
      this.emit('response', line.toString('utf8'))
      buffer = buffer.slice(position + DELIMETER.length)
    }

    this._buffer = buffer
    cb()
  }
}

class DeviceStream extends Duplexify {
  constructor () {
    super()

    this._lock = mutexify()
    this._commandStream = new CommandStream()
    this._ymodemStream = null
    this._request = this._requestCommandMode()

    this._setStream(this._commandStream)
  }

  async command (cmd, value, terminator) {
    await this._request
    const release = await this._lock()

    try {
      return await this._commandStream.command(cmd, value, terminator)
    } finally {
      release()
    }
  }

  createReadStream (filename) {
    const receiver = new YModemReceiverStream()
    const read = receiver.createReadStream()

    const command = async () => {
      await this._request
      const release = await this._lock()

      try {
        const [result] = await this._commandStream.command('FS GET ' + filename)
        if (result !== 'Sending file with YMODEM...') throw new Error('unexpected response: ' + result)
      } catch (err) {
        release()
        throw err
      }

      this._setStream(receiver)

      try {
        await promisify(finished)(read)
        // Followed by an empty file header
        const empty = receiver.createReadStream()
        empty.resume()
        await promisify(finished)(empty)
      } catch (err) {
        // Ignore, already handled by the stream
      } finally {
        this._setStream(this._commandStream)
        await this._waitForResponse('OK')
        release()
      }
    }

    command()
      .catch(err => read.destroy(err))

    return read
  }

  createWriteStream (filename, options) {
    const sender = new YModemSenderStream()
    const write = sender.createWriteStream({ filename: filename, ...options })

    const command = async () => {
      await this._request
      const release = await this._lock()

      try {
        const [result] = await this._commandStream.command('FS PUT ' + filename)
        if (result !== 'Receiving file with YMODEM...') throw new Error('unexpected response: ' + result)
      } catch (err) {
        release()
        throw err
      }

      this._setStream(sender)

      try {
        await promisify(finished)(write)
        const empty = sender.createWriteStream()
        empty.end()
        await promisify(finished)(empty)
      } catch (err) {
        // Ignore, already handled by the stream
      } finally {
        this._setStream(this._commandStream)
        await this._waitForResponse('OK')
        release()
      }
    }

    command()
      .catch(err => write.destroy(err))

    return write
  }

  _setStream (stream) {
    this.setReadable(stream)
    this.setWritable(stream)
  }

  async _requestCommandMode () {
    const [result] = await this._commandStream.request('+++')
    if (result !== 'OK') throw new Error('unexpected response: ' + result)
  }

  async _waitForResponse (value) {
    return new Promise((resolve, reject) => {
      const onresponse = data => {
        if (data === value) {
          this._commandStream.removeListener('response', onresponse)
          resolve()
        }
      }

      this._commandStream.on('response', onresponse)
    })
  }
}

const main = async function () {
  const { Transform } = require('stream')
  const SerialPort = require('serialport')

  const port = new SerialPort('/dev/tty.usbserial-1420', {
    baudRate: 9600
  })

  const device = new DeviceStream()

  device
    .pipe(new Transform({
      transform: (d, e, c) => {
        console.log('send', d)
        c(null, d)
      }
    }))
    .pipe(port)
    .pipe(new Transform({
      transform: (d, e, c) => {
        console.log('receive', d)
        c(null, d)
      }
    }))
    .pipe(device)

  console.log('FS RM', await device.command('FS RM /flash/text.txt'))

  const write = device.createWriteStream('/flash/text.txt', { length: 1800 })

  write
    .on('error', err => console.error(err))
    .on('finish', () => console.log('----------------'))

  write.write(Buffer.alloc(1500).fill('hello'))
  write.write(Buffer.alloc(300).fill('world'))
  write.end()

  // const read = device.createReadStream('/flash/main.mpy')

  // read
  //   .on('error', err => console.error(err))
  //   .on('file', o => console.log('>', o))
  //   .on('data', d => console.log('>', d.length))
  //   .on('end', () => console.log('----------------'))

  await promisify(finished)(write)

  console.log('SH', await device.command('SH'))

  // console.log(await device.command('FS GET /flash/main.mpy'))

  // console.log('+++', await device.request('+++'))
  // console.log('NI', await device.command('NI'))
  // console.log('SH', await device.command('SH'))
  // console.log('FS LS', await device.command('FS LS', null, ''))
  // console.log('FS PWD', await device.command('FS PWD'))
  // console.log('FS HASH /flash/main.mpy', await device.command('FS HASH /flash/main.mpy'))
  // console.log('FS INFO', await device.command('FS INFO', null, ''))
  // console.log('FS INFO FULL', await device.command('FS INFO FULL', null, ''))
}

main().catch(err => console.error(err))
