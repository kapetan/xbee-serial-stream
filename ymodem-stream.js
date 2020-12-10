const { Duplex, Readable, Writable } = require('stream')
const crc16 = require('./crc16')

const NUL = 0x00
const SOH = 0x01
const STX = 0x02
const EOT = 0x04
const ACK = 0x06
const NAK = 0x15
const CAN = 0x18
const SUB = 0x1a
const CRC = 0x43

const SOH_DATA_LENGTH = 128
const STX_DATA_LENGTH = 1024

const RECEIVE_TIMEOUT = 5000
const PURGE_TIMEOUT = 2000
const RETRY_LIMIT = 5

function zeros (buffer, offset, length) {
  for (let i = offset; i < offset + length; i++) {
    if (buffer[i]) return false
  }

  return true
}

class TimeoutError extends Error {}

class Stream extends Duplex {
  constructor (options) {
    super()

    this._buffer = Buffer.alloc(0)
    this._cb = null
    this._onreadable = null
    this._onwritable = null
  }

  _read (n) {
    if (this._onwritable) this._onwritable()
  }

  _write (data, encoding, cb) {
    this._cb = cb
    this._buffer = Buffer.concat([this._buffer, data])
    if (this._onreadable) this._onreadable(this._buffer, cb)
  }

  _destroy (err, cb) {
    if (this._onreadable) this._onreadable(null, cb, err)
    else cb(err)
  }

  _send (b) {
    if (this.push(b)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this._onwritable = () => {
        this._onwritable = null
        resolve()
      }
    })
  }

  _receive (n, t) {
    return new Promise((resolve, reject) => {
      let timeout = null

      const onreadable = (buffer, cb, err) => {
        clearTimeout(timeout)

        if (buffer == null) {
          reject(err || new Error('unexpected end of stream'))
          cb()
        } else if (buffer.length < n) {
          timeout = setTimeout(() => {
            this._onreadable = null
            reject(new TimeoutError('receive timed out'))
          }, t)

          this._onreadable = onreadable
          if (cb) cb()
        } else {
          this._onreadable = null
          const data = buffer.slice(0, n)
          this._buffer = buffer.slice(n)
          resolve(data)
        }
      }

      onreadable(this._buffer, () => {
        if (this._cb) this._cb()
        this._cb = null
      })
    })
  }
}

class YModemSenderStream extends Stream {
  createWriteStream (options) {
    let sending = Promise.resolve()
    let buffer = Buffer.alloc(SOH_DATA_LENGTH)

    if (options && options.filename) {
      const n = buffer.write(options.filename, 0)
      if (options.length != null) buffer.write(options.length.toString(), n + 1)
    }

    let initial = true
    let mode = SOH
    let blockCount = 0
    let canCount = 0
    let tries = 0

    const send = async (b) => {
      await sending
      sending = this._send(b)
    }

    const initialize = async () => {
      for (let i = 0; i < RETRY_LIMIT; i++) {
        const [b] = await this._receive(1, RECEIVE_TIMEOUT)
        if (b === CRC) return
      }

      throw new Error('receive limit reached')
    }

    const write = async (data) => {
      if (initial) {
        initial = false
        await initialize()
      }

      buffer = Buffer.concat([buffer, data])

      while (true) {
        const length = (mode === SOH) ? SOH_DATA_LENGTH : STX_DATA_LENGTH

        if (buffer.length < length) break

        const payload = Buffer.alloc(length + 5)
        const checksum = crc16(buffer, 0, length)

        payload[0] = mode
        payload[1] = blockCount
        payload[2] = 0xff - blockCount
        buffer.copy(payload, 3, 0, length)
        payload.writeUInt16BE(checksum, payload.length - 2)

        await send(payload)

        let i

        for (i = 0; i < RETRY_LIMIT; i++) {
          const [b] = await this._receive(1, RECEIVE_TIMEOUT)

          if (b !== CAN) canCount = 0

          if (b === ACK) {
            buffer = buffer.slice(length)
            mode = STX
            blockCount = (blockCount + 1) % 256
            tries = 0
            break
          } else if (b === NAK) {
            tries++
            if (tries >= RETRY_LIMIT) throw new Error('nak limit reached')
            break
          } else if (b === CAN) {
            canCount++
            if (canCount > 1) throw new Error('transfer cancelled by remote')
          }
        }

        if (i === RETRY_LIMIT) throw new Error('receive limit reached')
      }
    }

    const final = async () => {
      if (buffer.length) {
        const fill = Buffer.allocUnsafe(STX_DATA_LENGTH - buffer.length)
        fill.fill(SUB)
        await write(fill)
      }

      if (options && options.filename) {
        for (let i = 0; i < RETRY_LIMIT; i++) {
          await send(Buffer.of(EOT))
          const [b] = await this._receive(1, RECEIVE_TIMEOUT)
          if (b === ACK) return
        }
      }
    }

    return new Writable({
      write: (data, encoding, cb) => write(data).then(cb, cb),
      final: cb => final().then(cb, cb)
    })
  }
}

class YModemReceiverStream extends Stream {
  createReadStream () {
    const self = this
    let headerBlock = true
    let blockCount = 0
    let eotCount = 0
    let canCount = 0
    let tries = 0
    let fileLength = 0

    const send = (b) => {
      this.push(Buffer.of(b))
    }

    const nak = async () => {
      tries++
      if (tries >= RETRY_LIMIT) throw new Error('nak limit reached')
      await this._purge()
      send(NAK)
    }

    const ack = () => {
      tries = 0
      send(ACK)
    }

    const receiver = async function * () {
      send(CRC)

      while (true) {
        let b
        let length = 0

        try {
          [b] = await self._receive(1, RECEIVE_TIMEOUT)
        } catch (err) {
          if (err instanceof TimeoutError) {
            await nak()
            continue
          }

          throw err
        }

        if (b !== EOT) eotCount = 0
        if (b !== CAN) canCount = 0

        switch (b) {
          case SOH:
            length = SOH_DATA_LENGTH
            break
          case STX:
            length = STX_DATA_LENGTH
            break
          case EOT:
            if (eotCount === 0) {
              eotCount++
              await nak()
              continue
            } else {
              ack()
              return
            }
          case CAN:
            canCount++
            ack()
            if (canCount === 1) continue
            else throw new Error('transfer cancelled by remote')
          default:
            await nak()
            continue
        }

        let block

        try {
          block = await self._receive(length + 4, RECEIVE_TIMEOUT)
        } catch (err) {
          if (err instanceof TimeoutError) {
            await nak()
            continue
          }

          throw err
        }

        const [n, m] = block

        if (n + m !== 0xff || n !== blockCount) {
          await nak()
          continue
        }

        const checksum = block.readUInt16BE(block.length - 2)

        if (checksum !== crc16(block, 2, block.length - 4)) {
          await nak()
          continue
        }

        if (headerBlock && zeros(block, 2, block.length - 4)) {
          stream.emit('file', { length: 0 })
          self.emit('file', { length: 0 }, stream)
          ack()
          return
        } else if (headerBlock) {
          const i = block.indexOf(NUL, 2)
          const name = block.toString('utf8', 2, i)
          const j = block.indexOf(NUL, i + 1)
          fileLength = block.toString('utf8', i + 1, j)
          fileLength = parseInt(fileLength, 10)

          stream.emit('file', { name, length: fileLength })
          self.emit('file', { name, length: fileLength }, stream)

          ack()
          send(CRC)
        } else {
          const available = Math.min(block.length - 4, fileLength)
          const data = block.slice(2, available + 2)
          if (data.length) yield data
          fileLength -= data.length
          ack()
        }

        headerBlock = false
        blockCount = (blockCount + 1) % 256
      }
    }

    const stream = Readable.from(receiver())
    return stream
  }

  async _purge () {
    try {
      while (true) {
        this._buffer = Buffer.alloc(0)
        await this._receive(1, PURGE_TIMEOUT)
      }
    } catch (err) {
      if (err instanceof TimeoutError) return
      throw err
    }
  }
}

exports.YModemSenderStream = YModemSenderStream
exports.YModemReceiverStream = YModemReceiverStream
