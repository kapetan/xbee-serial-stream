const { Duplex, finished } = require('stream')
const { promisify } = require('util')
const Duplexify = require('duplexify')
const mutexify = require('mutexify/promise')
const { YModemReceiverStream, YModemSenderStream } = require('./ymodem-stream')

const DELIMETER = Buffer.from('\r')

function pendingBuffer (stream) {
  return Buffer.concat([...stream.writableBuffer.map(buf => buf.chunk), stream.receiveBuffer])
}

function matcher (terminator) {
  if (typeof terminator === 'function') return terminator
  if (typeof terminator === 'string') return line => line === terminator
  if (terminator instanceof RegExp) return line => terminator.test(line)
  if (terminator == null) {
    return (line, lines) => {
      lines.push(line)
      return true
    }
  }
}

class CommandStream extends Duplex {
  constructor () {
    super()

    this.receiveBuffer = Buffer.alloc(0)
    this._receiveContinue = null
    this._onreceive = null
  }

  command (cmd, value, terminator) {
    const error = cmd === 'FS' ? 'E' : 'ERROR'
    value = value ? (' ' + value) : ''
    return this.request('AT' + cmd + value + '\r', error, terminator)
  }

  async request (data, error, terminator) {
    this.push(data)
    terminator = matcher(terminator)
    const lines = []

    while (true) {
      const line = await this._receive()

      if (line.startsWith(error)) {
        throw new Error('error response: ' + line)
      } else if (terminator(line, lines)) {
        break
      } else {
        lines.push(line)
      }
    }

    return lines
  }

  _receive () {
    return new Promise((resolve, reject) => {
      const onreceive = (buffer, cb, err) => {
        let position

        if (buffer == null) {
          reject(err || new Error('unexpected end of stream'))
          cb()
        } else if ((position = buffer.indexOf(DELIMETER)) !== -1) {
          this._onreceive = null
          const line = buffer.slice(0, position)
          this.receiveBuffer = buffer.slice(position + DELIMETER.length)
          resolve(line.toString('utf8'))
        } else {
          this._onreceive = onreceive
          if (cb) cb()
        }
      }

      onreceive(this.receiveBuffer, () => {
        const cb = this._receiveContinue
        this._receiveContinue = null
        if (cb) cb()
      })
    })
  }

  _read (n) {}

  _write (data, encoding, cb) {
    this._receiveContinue = cb
    this.receiveBuffer = Buffer.concat([this.receiveBuffer, data])
    if (this._onreceive) this._onreceive(this.receiveBuffer, cb)
  }

  _destroy (err, cb) {
    if (this._onreceive) this._onreceive(null, cb, err)
    else cb(err)
  }
}

class DeviceStream extends Duplexify {
  constructor () {
    super()

    this._lock = mutexify()
    this._commandStream = new CommandStream()
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

  createReadStream (name) {
    const receiver = new YModemReceiverStream()
    const read = receiver.createReadStream({ end: true })

    const command = async () => {
      await this._request
      const release = await this._lock()

      try {
        const [result] = await this._commandStream.command('FS GET ' + name)
        if (result !== 'Sending file with YMODEM...') throw new Error('unexpected response: ' + result)
      } catch (err) {
        release()
        throw err
      }

      receiver.write(pendingBuffer(this._commandStream))
      this._setStream(receiver)

      try {
        await promisify(finished)(read)
      } catch (err) {
        // Ignore, already handled by the stream
      } finally {
        this._commandStream = new CommandStream()
        this._commandStream.write(pendingBuffer(receiver))
        this._setStream(this._commandStream)
        await this._waitForResponse('OK')
        release()
      }
    }

    command()
      .catch(err => read.destroy(err))

    return read
  }

  createWriteStream (name, length) {
    const sender = new YModemSenderStream()
    const write = sender.createWriteStream({ name, length, end: true })

    const command = async () => {
      await this._request
      const release = await this._lock()

      try {
        const [result] = await this._commandStream.command('FS PUT ' + name)
        if (result !== 'Receiving file with YMODEM...') throw new Error('unexpected response: ' + result)
      } catch (err) {
        release()
        throw err
      }

      sender.write(pendingBuffer(this._commandStream))
      this._setStream(sender)

      try {
        await promisify(finished)(write)
      } catch (err) {
        // Ignore, already handled by the stream
      } finally {
        this._commandStream = new CommandStream()
        this._commandStream.write(pendingBuffer(sender))
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
    this.setWritable(stream)
    this.setReadable(stream)
  }

  async _requestCommandMode () {
    await this._commandStream.request('+++', null, /OK$/)
  }

  async _waitForResponse (value) {
    let response
    while (response !== value) response = await this._commandStream._receive()
  }
}

module.exports = DeviceStream
